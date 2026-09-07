import { GLYPH } from './palette';
import { SLOPE, type Slope } from './rasterizer';

/**
 * Da luminância para o caractere.
 *
 * É onde a luz deixa de ser cor e vira desenho. Uma engine que renderiza para
 * caracteres tem um canal que nenhuma outra tem — a forma do glifo — e ignorá-lo
 * seria desenhar em ASCII sem usar o ASCII.
 *
 * Três modos porque o mesmo efeito tem custos estéticos diferentes, e a escolha
 * é de quem olha:
 *
 *   classic  a rampa tradicional de arte ASCII, dez níveis por célula. Mais
 *            expressiva, e a que dá a sensação mais forte de superfície
 *            iluminada. Em troca, uma linha da grade sob luz forte deixa de ser
 *            `/` e vira `#`: onde a luz manda, a leitura de wireframe cede.
 *
 *   family   a linha continua sendo linha e só ganha peso. Preserva a silhueta
 *            da grade em qualquer iluminação, ao custo de quatro níveis em vez
 *            de dez.
 *
 *   off      o glifo é só geometria, como antes de existir luz. É a referência
 *            para comparar, e o que o modo sem iluminação usa.
 */
export const RAMP = {
    CLASSIC: 'classic',
    FAMILY: 'family',
    OFF: 'off',
} as const;

export type RampMode = (typeof RAMP)[keyof typeof RAMP];

export const RAMP_MODES: readonly RampMode[] = [RAMP.CLASSIC, RAMP.FAMILY, RAMP.OFF];

/** A rampa de sempre, do vazio ao cheio. Índice de glifo é o código ASCII. */
const CLASSIC_RAMP: readonly number[] = [...' .:-=+*#%@'].map((char) => char.charCodeAt(0));

/**
 * Os quatro pesos de cada família de inclinação.
 *
 * O nível 1 é a própria geometria e entra por fora, porque a horizontal escolhe
 * entre `_` e `-` conforme a distância, e essa decisão é do chão, não daqui.
 */
const FAMILY_RAMPS: Record<Slope, readonly [number, number, number]> = {
    [SLOPE.HORIZONTAL]: [GLYPH.PERIOD, '='.charCodeAt(0), GLYPH.BLOCK_FULL],
    [SLOPE.VERTICAL]: [':'.charCodeAt(0), '#'.charCodeAt(0), GLYPH.BLOCK_FULL],
    [SLOPE.UP]: [GLYPH.PERIOD, '='.charCodeAt(0), GLYPH.BLOCK_FULL],
    [SLOPE.DOWN]: [GLYPH.PERIOD, '='.charCodeAt(0), GLYPH.BLOCK_FULL],
};

/**
 * Luminância comprimida para 0..1.
 *
 * A luminância que sai do sombreamento é HDR e não tem teto: um fragmento
 * dentro do lóbulo do sol passa fácil de 3. Cortar em 1 deixaria metade da cena
 * chapada no `@`, então a curva é a exponencial que satura devagar — a mesma
 * família do tone map do composite, pela mesma razão.
 */
const compress = (luminance: number, exposure: number): number =>
    luminance <= 0 ? 0 : 1 - Math.exp(-luminance * exposure);

export const glyphForLuminance = (
    luminance: number,
    slope: Slope,
    geometric: number,
    mode: RampMode,
    exposure: number,
): number => {
    if (mode === RAMP.OFF) return geometric;

    const level = compress(luminance, exposure);

    if (mode === RAMP.FAMILY) {
        const ramp = FAMILY_RAMPS[slope];
        if (level < 0.16) return ramp[0];
        if (level < 0.62) return geometric;
        if (level < 0.88) return ramp[1];
        return ramp[2];
    }

    const index = Math.min(CLASSIC_RAMP.length - 1, (level * CLASSIC_RAMP.length) | 0);
    return CLASSIC_RAMP[index]!;
};
