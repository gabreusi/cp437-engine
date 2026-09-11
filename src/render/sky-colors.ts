import { rgb } from "../math/color";

/**
 * As cores do céu, em um lugar só.
 *
 * Viviam dentro do GLSL do pass de fundo, o que bastava enquanto o céu era só
 * pintura. Deixou de bastar quando o reflexo apareceu: um raio que sobe da
 * grade tem que enxergar o mesmo céu que está pintado atrás dele, e duas
 * cópias da paleta se separariam na primeira mudança — exatamente o que o
 * comentário de `sunDirection` já registra sobre halo e disco.
 *
 * O shader recebe estas constantes por template; a CPU lê o mesmo objeto.
 */
export const SKY = {
  VOID: rgb(0.02, 0.0, 0.055),
  PINK: rgb(1.0, 0.235, 0.745),
  CYAN: rgb(0.0, 0.886, 1.0),
  PURPLE: rgb(0.29, 0.024, 0.408),
  HAZE: rgb(0.1, 0.28, 0.36),
} as const;

/**
 * Quanto cada camada contribui, com o sol de referência. O fundo é cenário: o
 * neon é que brilha.
 *
 * São pesos de arte, e não o valor final: o que o sol acende de cada uma chega
 * por `SkyModel` — `sunGlow`, `horizonGlow` e `sunSpread` —, calculado num lugar
 * só e lido igual pelo gradiente pintado e pelo raio de reflexo.
 */
export const SKY_WEIGHT = {
  /** Halo grande e frio acima do horizonte, que dá volume ao céu. */
  WASH: 0.3,
  /** Brilho quente atrás do sol. */
  GLOW: 0.22,
  /** Faixa fina de atmosfera colada no horizonte. */
  BAND: 0.1,
} as const;

const glsl = (name: string, c: { r: number; g: number; b: number }): string =>
  `const vec3 ${name} = vec3(${c.r.toFixed(3)}, ${c.g.toFixed(3)}, ${c.b.toFixed(3)});`;

/** As mesmas constantes como declarações GLSL, para injetar no shader. */
export const SKY_GLSL: string = [
  glsl("VOID_COLOR", SKY.VOID),
  glsl("PINK", SKY.PINK),
  glsl("CYAN", SKY.CYAN),
  glsl("PURPLE", SKY.PURPLE),
  glsl("HAZE", SKY.HAZE),
  `const float WASH_WEIGHT = ${SKY_WEIGHT.WASH.toFixed(3)};`,
  `const float GLOW_WEIGHT = ${SKY_WEIGHT.GLOW.toFixed(3)};`,
  `const float BAND_WEIGHT = ${SKY_WEIGHT.BAND.toFixed(3)};`,
].join("\n");
