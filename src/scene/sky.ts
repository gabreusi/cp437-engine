import { settings } from '../config';
import type { Rgb } from '../math/color';
import { hashNoise } from '../math/noise';
import { COLOR, GLYPH, STAR_TINTS } from '../render/palette';
import { createProjected } from '../render/rasterizer';
import type { RenderContext, Renderable } from './scene';

/**
 * Ciclo de brilho: apagada, cresce até `*`, encolhe de volta.
 * Os mesmos caracteres da versão original, agora como índices de glifo.
 */
const TWINKLE_GLYPHS: readonly number[] = [
    GLYPH.BLANK,
    GLYPH.DOT, GLYPH.BULLET, GLYPH.PLUS, GLYPH.STAR,
    GLYPH.STAR, GLYPH.PLUS, GLYPH.BULLET, GLYPH.DOT,
];

/** Enviesado para o ponto pequeno: pouquíssimas estrelas viram `*`. */
const pickStarGlyph = (roll: number): number => {
    if (roll <= 0.55) return GLYPH.DOT;
    if (roll <= 0.65) return GLYPH.BULLET;
    if (roll <= 0.75) return GLYPH.PLUS;
    return GLYPH.STAR;
};

const twinkleGlyph = (timeMs: number, phaseOffset: number, speed: number): number => {
    const phase = (((timeMs + phaseOffset) * speed) / 4) % 1;
    return TWINKLE_GLYPHS[Math.floor(phase * TWINKLE_GLYPHS.length)] ?? GLYPH.BLANK;
};

/** Expoente que rarefaz as estrelas perto do horizonte, para o sol respirar. */
const ELEVATION_BIAS = 0.7;

interface Star {
    /** Direção unitária no mundo. */
    x: number;
    y: number;
    z: number;
    glyph: number;
    color: Rgb;
    twinkles: boolean;
    phaseOffset: number;
    speed: number;
}

/**
 * Estrelas e linha do horizonte.
 *
 * A mudança de fundo em relação à versão anterior: as estrelas eram ruído
 * indexado pela célula de tela, então "existiam" na tela e não no mundo. Agora
 * são direções unitárias sorteadas uma vez e transformadas apenas pela rotação
 * da câmera — sem translação, logo sem paralaxe, que é o correto para o
 * infinito. Andar não as move; girar move.
 */
export class Sky implements Renderable {
    private stars: Star[] = [];
    private builtCount = -1;

    private readonly projected = createProjected();

    private rebuild(count: number): void {
        this.stars = [];
        this.builtCount = count;

        for (let index = 0; index < count; index += 1) {
            // Cada atributo vem de um hash com deslocamento próprio; compartilhar
            // o sorteio correlacionaria cor, forma e fase, e o céu sairia em faixas.
            const heightRoll = hashNoise(index * 1.13, 3.7);
            const azimuthRoll = hashNoise(7.3, index * 0.91);

            const y = heightRoll ** ELEVATION_BIAS;
            const radius = Math.sqrt(Math.max(0, 1 - y * y));
            const azimuth = azimuthRoll * Math.PI * 2;

            const tintIndex = Math.floor(hashNoise(index + 57.3, 19.7) * STAR_TINTS.length);

            this.stars.push({
                x: radius * Math.cos(azimuth),
                y,
                z: radius * Math.sin(azimuth),
                glyph: pickStarGlyph(hashNoise(index + 5.1, 41.9)),
                color: STAR_TINTS[tintIndex] ?? STAR_TINTS[0]!,
                twinkles: hashNoise(index + 89.1, 42.5) > 0.3,
                phaseOffset: hashNoise(index + 12.3, 76.5) * 10000,
                speed: 0.0002 + hashNoise(index + 34.5, 67.8) * 0.0006,
            });
        }
    }

    render({ rasterizer, viewport, time }: RenderContext): void {
        if (this.builtCount !== settings.starCount) this.rebuild(settings.starCount);

        this.drawHorizon(rasterizer.horizonRow(), viewport.colCount, rasterizer);

        for (const star of this.stars) {
            if (!rasterizer.projectDirection(star.x, star.y, star.z, this.projected)) continue;

            const glyph = star.twinkles
                ? twinkleGlyph(time, star.phaseOffset, star.speed)
                : star.glyph;
            if (glyph === GLYPH.BLANK) continue;

            rasterizer.plot(this.projected, glyph, star.color);
        }
    }

    private drawHorizon(
        row: number,
        colCount: number,
        rasterizer: RenderContext['rasterizer'],
    ): void {
        // `GROUND_LINE` e não `_`: a bruma rasteira começa na base desta célula,
        // e o underscore da fonte para antes dela, deixando uma fresta de céu
        // entre a linha e a bruma.
        const target = Math.round(row);
        for (let col = 0; col < colCount; col += 1) {
            rasterizer.plotCell(col, target, GLYPH.GROUND_LINE, COLOR.HORIZON, Infinity);
        }
    }
}
