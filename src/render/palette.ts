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
import { fromHex, type Rgb } from "../math/color";

/**
 * Os 256 glifos do atlas: a code page 437 original do IBM PC, índice a
 * índice, sem reordenar nada — é dela que a arte ANSI dos anos oitenta
 * tirava blocos, moldura e setas, e é dela que o projeto tira o nome (ver "O
 * nome" no README). A escolha de glifo por forma (`glyph-shape.ts`) precisa
 * do alfabeto inteiro para ter o que escolher: moldura simples e dupla,
 * blocos, meios-blocos dos quatro lados, tudo já mora no endereço certo.
 *
 * Uma única exceção, e ela prova a regra: o índice 255 é `NBSP` na CP437
 * real — vazio, como o espaço — e cede lugar para `▁`, desenhado à mão
 * (`gl/atlas.ts`) porque a CP437 não tem um traço rente à base da célula, e é
 * exatamente por isso que ele precisou ser inventado.
 */
export const CHARSET: string =
  " ☺☻♥♦♣♠•◘○◙♂♀♪♫☼►◄↕‼¶§▬↨↑↓→←∟↔▲▼" +
  " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~⌂" +
  "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»" +
  "░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀" +
  "αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■▁";

export const GLYPH = {
  /** NUL da CP437 — imprime vazio, como o espaço. */
  BLANK: 0,

  BULLET: 7,
  RING: 9,
  DIAMOND: 4,

  ARROW_RIGHT: 16,
  ARROW_LEFT: 17,
  ARROW_VERTICAL: 18,
  ARROW_UP: 30,
  ARROW_DOWN: 31,

  BLOCK_LIGHT: 176,
  BLOCK_MEDIUM: 177,
  BLOCK_DARK: 178,
  BOX_V: 179,
  BOX_VL: 180,
  BOX_HU: 193,
  BOX_HD: 194,
  BOX_VR: 195,
  BOX_H: 196,
  BOX_CROSS: 197,
  BOX_TR: 191,
  BOX_BL: 192,
  BOX_BR: 217,
  BOX_TL: 218,
  BLOCK_FULL: 219,
  HALF_DOWN: 220,
  HALF_LEFT: 221,
  HALF_RIGHT: 222,
  HALF_UP: 223,

  DOT: 250,
  SQUARE: 254,

  /**
   * Traço rente à base da célula, para a linha do horizonte.
   *
   * A CP437 real tem NBSP no 255 — vazio, como o espaço — e cede o lugar
   * para este glifo desenhado à mão: o `_` da fonte para acima da base, e a
   * bruma rasteira precisa começar exatamente onde a linha termina.
   */
  GROUND_LINE: 255,

  // Da tabela ASCII, idêntica na CP437 e nomeada para o código não escrever
  // o número solto.
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

/**
 * Do caractere para o índice de glifo.
 *
 * Mapa e não conta aritmética: a CP437 não é contígua com o código Unicode
 * do caractere. Construído a partir do próprio `CHARSET`, então nunca
 * discorda dele.
 */
const CHAR_TO_GLYPH: ReadonlyMap<string, number> = (() => {
  const map = new Map<string, number>();
  for (let index = 0; index < CHARSET.length; index += 1) {
    const char = CHARSET[index]!;
    if (!map.has(char)) map.set(char, index);
  }
  // NUL (0) também imprime espaço, e o primeiro a registrar um caractere
  // vence — sem isto o espaço "de verdade" (32) perderia para o índice 0, e
  // `drawText` deixaria de reconhecer um espaço como espaço.
  map.set(" ", GLYPH.SPACE);
  return map;
})();

/** Remove marca de acento combinante, deixando só a letra base. */
const stripDiacritics = (char: string): string =>
  char.normalize("NFD").replace(/\p{M}/gu, "");

/**
 * Um caractere fora da CP437 cai para a letra sem acento antes de desistir.
 *
 * A CP437 não tem todo acento do português — falta `ã`, `õ`, entre outros —
 * e um nome de objeto digitado por quem usa a engine pode ter qualquer um.
 * Perder o acento e continuar legível é melhor do que a célula sumir.
 */
export const glyphForChar = (char: string): number =>
  CHAR_TO_GLYPH.get(char) ??
  CHAR_TO_GLYPH.get(stripDiacritics(char)) ??
  GLYPH.BLANK;

/** Cores nomeadas do cenário. Os hex são os mesmos desde a versão em CSS. */
export const COLOR = {
  HORIZON: fromHex("#a6f7ff"),
  GRID_NEAR: fromHex("#2ef2ff"),
  GRID_MID: fromHex("#109fbe"),
  GRID_FAR: fromHex("#0a5a72"),
} as const;

/** As oito faixas do sol, do topo para a base. */
export const SUN_SHADES: readonly Rgb[] = [
  "#ffd54a",
  "#ffb93c",
  "#ff9a41",
  "#ff7c55",
  "#ff6379",
  "#ff5199",
  "#fb46bd",
  "#f24ad6",
].map(fromHex);

/** Repetições enviesam o sorteio para o branco-azulado, como no original. */
export const STAR_TINTS: readonly Rgb[] = [
  "#cfe0ff",
  "#cfe0ff",
  "#cfe0ff",
  "#cfe0ff",
  "#cfe0ff",
  "#cfe0ff",
  "#7df3ff",
  "#ff9ad5",
  "#a6ff9c",
].map(fromHex);
