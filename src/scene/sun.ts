import { degreesToRadians, settings } from '../config';
import { GLYPH, SUN_SHADES } from '../render/palette';
import { createProjected } from '../render/rasterizer';
import { CELL_ASPECT } from '../render/viewport';
import type { RenderContext, Renderable } from './scene';

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

    render({ camera, rasterizer, viewport }: RenderContext): void {
        sunDirection(this.direction);
        const { x: dirX, y: dirY, z: dirZ } = this.direction;

        if (!rasterizer.projectDirection(dirX, dirY, dirZ, this.center)) return;

        const radiusRows = rasterizer.angularRadiusRows(degreesToRadians(settings.sunAngularSize));
        if (radiusRows < 1) return;

        // A célula é 1:2, então o raio em colunas é o dobro — é isso que faz o
        // disco sair redondo em vez de ovalado.
        const radiusCols = radiusRows * CELL_ASPECT;
        const sunRowCount = radiusRows * 2 + 1.5;

        const centerCol = Math.round(this.center.col);
        const centerRow = Math.round(this.center.row);

        // O sol está no infinito e o chão é opaco: nada dele aparece abaixo do
        // horizonte. Como o chão é desenhado só em linhas, sem este recorte ele
        // vaza pelos vãos. Só vale com a câmera acima do plano — abaixo dele o
        // chão fica por cima e é o céu que ocupa a parte de baixo da tela.
        const lastVisibleRow =
            camera.position.y > 0
                ? Math.round(rasterizer.horizonRow()) - 1
                : viewport.rowCount - 1;

        // Recorta o laço na tela: um sol fora de vista não deve custar o disco inteiro.
        const minRow = Math.max(-Math.ceil(radiusRows), -centerRow);
        const maxRow = Math.min(Math.ceil(radiusRows), lastVisibleRow - centerRow);
        const minCol = Math.max(-Math.ceil(radiusCols), -centerCol);
        const maxCol = Math.min(Math.ceil(radiusCols), viewport.colCount - 1 - centerCol);

        for (let deltaRow = minRow; deltaRow <= maxRow; deltaRow += 1) {
            const localRow = deltaRow + radiusRows;

            if (isSunSliceGap(localRow, sunRowCount)) continue;

            const shadeIndex = Math.min(
                SUN_SHADES.length - 1,
                Math.floor((localRow / sunRowCount) * SUN_SHADES.length),
            );
            const color = SUN_SHADES[shadeIndex] ?? SUN_SHADES[0]!;
            const glyph = pickSunGlyph(localRow, sunRowCount);
            const normalizedY = deltaRow / radiusRows;

            for (let deltaCol = minCol; deltaCol <= maxCol; deltaCol += 1) {
                const normalizedX = deltaCol / radiusCols;
                if (Math.hypot(normalizedX, normalizedY) > 1.01) continue;

                rasterizer.plotCell(centerCol + deltaCol, centerRow + deltaRow, glyph, color, Infinity);
            }
        }
    }
}
