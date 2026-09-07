/**
 * Cores e glifos da engine.
 *
 * Isto era CSS: as classes `.c0`, `.y0`, `.hz` de `styles/scene.css`. A GPU não
 * lê classe CSS, então a paleta virou dado, carregado numa textura 1D e indexado
 * por célula. Os valores são os mesmos de antes.
 */

/**
 * Índice no charset é o que vai para a data texture; a ordem importa.
 *
 * Duas famílias: os caracteres de texto, que vêm da fonte, e os blocos, que
 * cobrem os 16 padrões possíveis de uma amostragem 2x2 e são desenhados
 * proceduralmente no atlas — ver `atlas.ts` para o porquê.
 */
export const CHARSET = ' ·•+*█▓▒░-_|/\\' + '▘▝▖▗▀▄▌▐▚▞▛▜▙▟';

export const GLYPH = {
    BLANK: 0,
    DOT: 1,
    BULLET: 2,
    PLUS: 3,
    STAR: 4,
    BLOCK_FULL: 5,
    BLOCK_DARK: 6,
    BLOCK_MEDIUM: 7,
    BLOCK_LIGHT: 8,
    DASH: 9,
    UNDERSCORE: 10,
    PIPE: 11,
    SLASH: 12,
    BACKSLASH: 13,

    QUAD_TL: 14,
    QUAD_TR: 15,
    QUAD_BL: 16,
    QUAD_BR: 17,
    HALF_TOP: 18,
    HALF_BOTTOM: 19,
    HALF_LEFT: 20,
    HALF_RIGHT: 21,
    QUAD_TL_BR: 22,
    QUAD_TR_BL: 23,
    QUAD_NO_BR: 24,
    QUAD_NO_BL: 25,
    QUAD_NO_TR: 26,
    QUAD_NO_TL: 27,
} as const;

/**
 * Padrão de cobertura 2x2 para glifo, indexado por máscara de bits:
 * 1 = superior esquerdo, 2 = superior direito, 4 = inferior esquerdo,
 * 8 = inferior direito. Os 16 casos existem, então a borda de qualquer forma
 * pode ser representada exatamente no dobro da resolução da célula.
 */
export const QUADRANT_BY_MASK: readonly number[] = [
    GLYPH.BLANK,        // 0000
    GLYPH.QUAD_TL,      // 0001
    GLYPH.QUAD_TR,      // 0010
    GLYPH.HALF_TOP,     // 0011
    GLYPH.QUAD_BL,      // 0100
    GLYPH.HALF_LEFT,    // 0101
    GLYPH.QUAD_TR_BL,   // 0110
    GLYPH.QUAD_NO_BR,   // 0111
    GLYPH.QUAD_BR,      // 1000
    GLYPH.QUAD_TL_BR,   // 1001
    GLYPH.HALF_RIGHT,   // 1010
    GLYPH.QUAD_NO_BL,   // 1011
    GLYPH.HALF_BOTTOM,  // 1100
    GLYPH.QUAD_NO_TR,   // 1101
    GLYPH.QUAD_NO_TL,   // 1110
    GLYPH.BLOCK_FULL,   // 1111
];

/**
 * Índice 0 é reservado para "célula vazia", então limpar o buffer com zeros já
 * significa transparente. A textura tem 32 colunas para sobrar espaço.
 */
export const PALETTE_SIZE = 32;

export const PALETTE: readonly string[] = [
    '#000000', // 0  vazio
    '#ffd54a', // 1  sol, topo
    '#ffb93c', // 2
    '#ff9a41', // 3
    '#ff7c55', // 4
    '#ff6379', // 5
    '#ff5199', // 6
    '#fb46bd', // 7
    '#f24ad6', // 8  sol, base
    '#cfe0ff', // 9  estrela branca
    '#7df3ff', // 10 estrela ciano
    '#ff9ad5', // 11 estrela rosa
    '#a6ff9c', // 12 estrela verde
    '#a6f7ff', // 13 horizonte
    '#2ef2ff', // 14 grade, perto
    '#109fbe', // 15 grade, média
    '#0a5a72', // 16 grade, longe
];

export const COLOR = {
    EMPTY: 0,
    HORIZON: 13,
    GRID_NEAR: 14,
    GRID_MID: 15,
    GRID_FAR: 16,
} as const;

/** As oito faixas do sol, do topo para a base. */
export const SUN_SHADES: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8];

/** Repetições enviesam o sorteio para o branco-azulado, como no original. */
export const STAR_TINTS: readonly number[] = [9, 9, 9, 9, 9, 9, 10, 11, 12];

/** Expande a paleta hex para RGBA8 pronto para virar textura. */
export const buildPaletteTexels = (): Uint8Array => {
    const texels = new Uint8Array(PALETTE_SIZE * 4);
    PALETTE.forEach((hex, index) => {
        const value = Number.parseInt(hex.slice(1), 16);
        const offset = index * 4;
        texels[offset] = (value >> 16) & 0xff;
        texels[offset + 1] = (value >> 8) & 0xff;
        texels[offset + 2] = value & 0xff;
        texels[offset + 3] = 255;
    });
    return texels;
};
