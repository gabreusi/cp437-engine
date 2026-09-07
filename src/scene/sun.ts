import { degreesToRadians, settings } from '../config';
import { copyRgb } from '../math/color';
import { copy } from '../math/vec3';
import { LIGHT } from '../light/types';
import { GLYPH, SUN_SHADES } from '../render/palette';
import { createProjected } from '../render/rasterizer';
import type { RenderContext, Renderable } from './scene';

/**
 * Abaixo de que elevação o sol para de iluminar, e em quanto tempo.
 *
 * O disco continua visível recortado no horizonte depois disso — é a estética
 * outrun — mas um sol enterrado que ainda projetasse sombras longas denunciaria
 * que o disco e a luz são a mesma coisa só por coincidência.
 */
const SET_BELOW = -0.05;
const SET_SPAN = 0.28;

/** Quanto o topo do disco passa de 1. É o que o bloom transforma em halo. */
const SUN_EMISSIVE = 0.85;

/**
 * As fatias horizontais do sol — a assinatura visual do estilo outrun.
 *
 * Só a metade de baixo é fatiada, e a última faixa fica inteira para o sol
 * assentar no horizonte em vez de terminar picotado.
 */
const isSunSliceGap = (localRow: number, sunRowCount: number): boolean => {
    const sliceStartRow = sunRowCount * 0.5;
    if (localRow < sliceStartRow) return false;

    const baseStripeRows = Math.max(2, Math.round(sunRowCount * 0.08));
    if (localRow >= sunRowCount - baseStripeRows) return false;

    const sliceSpan = sunRowCount - sliceStartRow;
    const sliceDepth = (localRow - sliceStartRow) / sliceSpan;

    const bandCount = Math.max(2, Math.round((sliceSpan / 3) * settings.sunSlices));
    const bandPhase = (sliceDepth * bandCount) % 1;

    // Os cortes engrossam conforme descem, o que sugere o sol afundando.
    const gapShare =
        (0.3 + sliceDepth * 0.12) / Math.min(2, Math.max(0.5, settings.sunSlices * 0.7));

    return bandPhase < gapShare;
};

/** Blocos progressivamente mais vazados: o sol clareia de cima para baixo. */
const pickSunGlyph = (localRow: number, sunRowCount: number): number => {
    const progress = Math.max(0, Math.min(1, localRow / sunRowCount));
    if (progress < 0.3) return GLYPH.BLOCK_FULL;
    if (progress < 0.6) return GLYPH.BLOCK_DARK;
    if (progress < 0.85) return GLYPH.BLOCK_MEDIUM;
    return GLYPH.BLOCK_LIGHT;
};

/**
 * Direção do sol em coordenadas de mundo.
 *
 * Azimute 0 aponta para -Z, que é para onde a câmera olha com yaw zero.
 * Exportada porque o gradiente de fundo precisa da mesma direção, e duplicar a
 * fórmula deixaria o halo e o disco se separarem na primeira mudança.
 */
export const sunDirection = (out: { x: number; y: number; z: number }): void => {
    const azimuth = degreesToRadians(settings.sunAzimuth);
    const elevation = degreesToRadians(settings.sunElevation);
    const cosElevation = Math.cos(elevation);

    out.x = Math.sin(azimuth) * cosElevation;
    out.y = Math.sin(elevation);
    out.z = -Math.cos(azimuth) * cosElevation;
};

/**
 * O sol como corpo celeste, não mais como círculo em coordenadas de tela.
 *
 * Posição vem de azimute e elevação, e é projetada como direção: sem
 * translação, então andar não o move e girar move. O disco em si continua sendo
 * preenchido em espaço de tela, o que é correto para algo no infinito — ele
 * sempre encara a câmera.
 */
export class Sun implements Renderable {
    private readonly center = createProjected();
    private readonly direction = { x: 0, y: 0, z: -1 };

    /**
     * O sol se declara duas vezes, e de propósito.
     *
     * Como luz direcional ele produz difuso e sombra; como disco no modelo de
     * céu ele é o que um raio de reflexão encontra. São a mesma direção,
     * preenchida aqui, no mesmo lugar — separá-las deixaria o reflexo do sol na
     * grade apontando para onde o sol não está.
     */
    contribute({ lights }: RenderContext): void {
        sunDirection(this.direction);

        // `direction.y` é o seno da elevação: a direção é unitária.
        const above = Math.max(0, Math.min(1, (this.direction.y - SET_BELOW) / SET_SPAN));
        const tone = SUN_SHADES[0]!;

        const light = lights.addLight();
        light.kind = LIGHT.DIRECTIONAL;
        copy(light.direction, this.direction);
        copyRgb(light.color, tone);
        light.intensity = settings.sunLightIntensity * above;
        light.range = Infinity;
        light.castsShadow = true;

        const { sky } = lights;
        copy(sky.sunDirection, this.direction);
        copyRgb(sky.sunColor, tone);
        sky.sunRadius = degreesToRadians(settings.sunAngularSize);
        sky.sunIntensity = above;
        sky.intensity = settings.skyReflectionIntensity;
    }

    render({ camera, rasterizer }: RenderContext): void {
        sunDirection(this.direction);
        const { x: dirX, y: dirY, z: dirZ } = this.direction;

        if (!rasterizer.projectDirection(dirX, dirY, dirZ, this.center)) return;

        const radiusRows = rasterizer.angularRadiusRows(degreesToRadians(settings.sunAngularSize));
        if (radiusRows < 1) return;

        const sunRowCount = radiusRows * 2 + 1.5;

        // O sol está no infinito e o chão é opaco: nada dele aparece abaixo do
        // horizonte. Como o chão é desenhado só em linhas, sem este recorte ele
        // vaza pelos vãos. Só vale com a câmera acima do plano — abaixo dele o
        // chão fica por cima e é o céu que ocupa a parte de baixo da tela.
        const lastVisibleRow =
            camera.position.y > 0
                ? Math.round(rasterizer.horizonRow()) - 1
                : rasterizer.lastRow;

        rasterizer.disc(this.center, radiusRows, lastVisibleRow, (col, row, _nx, ny) => {
            const localRow = ny * radiusRows + radiusRows;
            if (isSunSliceGap(localRow, sunRowCount)) return;

            const progress = localRow / sunRowCount;
            const shadeIndex = Math.min(
                SUN_SHADES.length - 1,
                Math.floor(progress * SUN_SHADES.length),
            );

            // O topo estoura mais que a base: é o que dá ao disco o núcleo
            // branco de sol contra o céu, sem clarear a paleta inteira.
            rasterizer.plotCell(
                col, row,
                pickSunGlyph(localRow, sunRowCount),
                SUN_SHADES[shadeIndex] ?? SUN_SHADES[0]!,
                Infinity,
                1,
                SUN_EMISSIVE * (1 - progress),
            );
        });
    }

}
