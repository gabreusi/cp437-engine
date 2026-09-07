import { BLANK_CHAR, settings, STAR_CHARS, STAR_TINTS } from '../config';
import type { Layout, StarSeed } from '../types';
import { hashNoise } from './noise';

/**
 * Ciclo de brilho: apagada, cresce até `*`, encolhe de volta.
 *
 * Montado uma única vez. Construir isso dentro da função significaria inverter
 * `STAR_CHARS` no lugar a cada quadro, e o array é lido por `pickStarChar`.
 */
const TWINKLE_SEQUENCE: readonly string[] = [
    BLANK_CHAR,
    ...STAR_CHARS,
    ...[...STAR_CHARS].reverse(),
];

/** Enviesado para o ponto pequeno: pouquíssimas estrelas viram `*`. */
const pickStarChar = (shapeRoll: number): string => {
    if (shapeRoll <= 0.55) return STAR_CHARS[0];
    if (shapeRoll <= 0.65) return STAR_CHARS[1];
    if (shapeRoll <= 0.75) return STAR_CHARS[2];
    return STAR_CHARS[3];
};

export const getTwinkleChar = (timestamp: number, phaseOffset: number, speed: number): string => {
    const phase = ((timestamp + phaseOffset) * speed / 4) % 1;
    const index = Math.floor(phase * TWINKLE_SEQUENCE.length);
    return TWINKLE_SEQUENCE[index] ?? BLANK_CHAR;
};

/**
 * Decide se nasce uma estrela nesta coordenada e com que aparência.
 *
 * A densidade cai perto do horizonte para o céu não competir com o sol.
 * Cada atributo vem de um `hashNoise` com deslocamento próprio, senão cor,
 * forma e fase ficariam correlacionadas e o céu apareceria em faixas.
 */
export const buildStarData = (col: number, row: number, layout: Layout): StarSeed | null => {
    const skyHeightRatio = 1 - row / Math.max(1, layout.horizonRow);
    const localDensity = settings.starDensity * (0.35 + 0.65 * skyHeightRatio);

    const roll = hashNoise(col, row);
    if (roll > localDensity) return null;

    const tintIndex = Math.floor(hashNoise(col + 57.3, row + 19.7) * STAR_TINTS.length);

    return {
        char: pickStarChar(roll / localDensity),
        className: STAR_TINTS[tintIndex] ?? STAR_TINTS[0],
        twinkles: hashNoise(col + 89.1, row + 42.5) > 0.3,
        phaseOffset: hashNoise(col + 12.3, row + 76.5) * 10000,
        speed: 0.0002 + hashNoise(col + 34.5, row + 67.8) * 0.0006,
    };
};
