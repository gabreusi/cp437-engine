/**
 * Cores e glifos da engine.
 *
 * Isto era CSS: as classes `.c0`, `.y0`, `.hz` de `styles/scene.css`. Virou
 * paleta indexada quando a GPU entrou — a célula guardava um byte apontando
 * para uma tabela de dezessete cores — e agora é RGB direto.
 *
 * O índice caiu porque não sobrevive a luz colorida: a cor de uma célula da
 * grade iluminada por um orbe ciano e outro magenta não está em tabela
 * nenhuma. As cores do cenário são exatamente as mesmas de antes, escritas nos
 * mesmos literais hex, agora desempacotadas em 0..1 para a matemática de luz.
 */
import { type Rgb, fromHex } from '../math/color';

/**
 * Glifos próprios, nos índices 0 a 31.
 *
 * Ocupam o buraco que a tabela ASCII deixa antes do espaço: assim os
 * imprimíveis podem ficar no índice igual ao seu código, e escrever texto na
 * grade vira `text.charCodeAt(i)`, sem tabela de tradução no meio.
 *
 * Todos vêm da CP437, a code page do IBM PC original — é dela que a arte ANSI
 * dos anos oitenta tirava blocos, moldura e setas, e é dela que o projeto tira
 * o nome. A exceção é o `▁`, e ela prova a regra: a CP437 não tem um traço
 * rente à base da célula, e é exatamente por isso que ele precisou ser
 * desenhado à mão.
 *
 * Blocos e pontos vêm da fonte; moldura, setas e o bloco cheio são desenhados
 * no atlas, porque precisam encostar na borda da célula para emendar entre
 * células vizinhas — o que a métrica da fonte não entrega.
 */
const CUSTOM_GLYPHS: readonly string[] = [
    ' ', '·', '•', '░', '▒', '▓', '█', '▁', '▀', '▄',
    '─', '│', '┌', '┐', '└', '┘', '├', '┤', '┬', '┴', '┼',
    '◄', '►', '▲', '▼',
    '○', '■', '♦',
];

/** Faixa imprimível da tabela ASCII: espaço (32) a til (126). */
const ASCII_FIRST = 32;
const ASCII_LAST = 126;

/** Latin-1 imprimível: é onde moram os acentos do português. */
const LATIN_FIRST = 160;
const LATIN_LAST = 255;

/**
 * Os 256 glifos do atlas, na ordem em que a data texture os indexa.
 *
 * A versão anterior tinha quinze caracteres escolhidos a dedo, o bastante para
 * grade, estrelas e sol. A tabela inteira entra por três razões: a rampa de
 * luminância ` .:-=+*#%@` é ASCII puro, o menu desenhado dentro da engine
 * precisa de letras, e ele é escrito em português — "Iluminação" sem o til é
 * uma limitação técnica vazando para a interface.
 *
 * O índice de um caractere é o próprio código, então escrever texto na grade é
 * `charCodeAt`, sem tabela de tradução no meio. Os glifos próprios ocupam o
 * buraco que a tabela deixa antes do espaço.
 */
export const CHARSET: string = (() => {
    const slots: string[] = new Array(256).fill(' ');
    CUSTOM_GLYPHS.forEach((char, index) => { slots[index] = char; });
    for (let code = ASCII_FIRST; code <= LATIN_LAST; code += 1) {
        if (code > ASCII_LAST && code < LATIN_FIRST) continue;
        slots[code] = String.fromCharCode(code);
    }
    return slots.join('');
})();

/**
 * Do caractere para o índice de glifo.
 *
 * Um mapa e não uma faixa numérica porque o charset tem três regiões: os glifos
 * próprios, que não têm código Unicode contíguo, e as duas faixas imprimíveis.
 * Com o mapa, `drawText` aceita `┌`, `►` e `ç` pelo mesmo caminho das letras.
 */
const CHAR_TO_GLYPH: ReadonlyMap<string, number> = (() => {
    const map = new Map<string, number>();
    // Os slots vazios do charset também são espaço; mapear a partir da string
    // faria o último deles ganhar, e o espaço deixaria de ser o código 32.
    CUSTOM_GLYPHS.forEach((char, index) => {
        if (char !== ' ') map.set(char, index);
    });
    for (let code = ASCII_FIRST; code <= LATIN_LAST; code += 1) {
        if (code > ASCII_LAST && code < LATIN_FIRST) continue;
        map.set(String.fromCharCode(code), code);
    }
    return map;
})();

export const glyphForChar = (char: string): number => CHAR_TO_GLYPH.get(char) ?? GLYPH.BLANK;

export const GLYPH = {
    BLANK: 0,

    DOT: 1,
    BULLET: 2,
    BLOCK_LIGHT: 3,
    BLOCK_MEDIUM: 4,
    BLOCK_DARK: 5,
    BLOCK_FULL: 6,

    /**
     * Traço rente à base da célula, para a linha do horizonte.
     *
     * Existe porque o `_` da fonte desenha acima da base, e a bruma rasteira
     * precisa começar exatamente onde a linha termina. Com um glifo desenhado
     * por nós, a posição é conhecida em vez de herdada da métrica da fonte.
     */
    GROUND_LINE: 7,
    HALF_UP: 8,
    HALF_DOWN: 9,

    BOX_H: 10,
    BOX_V: 11,
    BOX_TL: 12,
    BOX_TR: 13,
    BOX_BL: 14,
    BOX_BR: 15,
    BOX_VR: 16,
    BOX_VL: 17,
    BOX_HD: 18,
    BOX_HU: 19,
    BOX_CROSS: 20,

    ARROW_LEFT: 21,
    ARROW_RIGHT: 22,
    ARROW_UP: 23,
    ARROW_DOWN: 24,

    RING: 25,
    SQUARE: 26,
    DIAMOND: 27,

    // Da tabela ASCII, nomeados para o código não escrever o número solto.
    SPACE: 32,
    STAR: 42,
    PLUS: 43,
    DASH: 45,
    PERIOD: 46,
    SLASH: 47,
    BACKSLASH: 92,
    UNDERSCORE: 95,
    PIPE: 124,
} as const;

/** Cores nomeadas do cenário. Os hex são os mesmos desde a versão em CSS. */
export const COLOR = {
    HORIZON: fromHex('#a6f7ff'),
    GRID_NEAR: fromHex('#2ef2ff'),
    GRID_MID: fromHex('#109fbe'),
    GRID_FAR: fromHex('#0a5a72'),
} as const;

/** As oito faixas do sol, do topo para a base. */
export const SUN_SHADES: readonly Rgb[] = [
    '#ffd54a',
    '#ffb93c',
    '#ff9a41',
    '#ff7c55',
    '#ff6379',
    '#ff5199',
    '#fb46bd',
    '#f24ad6',
].map(fromHex);

/** Repetições enviesam o sorteio para o branco-azulado, como no original. */
export const STAR_TINTS: readonly Rgb[] = [
    '#cfe0ff',
    '#cfe0ff',
    '#cfe0ff',
    '#cfe0ff',
    '#cfe0ff',
    '#cfe0ff',
    '#7df3ff',
    '#ff9ad5',
    '#a6ff9c',
].map(fromHex);
