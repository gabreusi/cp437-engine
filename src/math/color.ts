/**
 * Cor como objeto mutável com destino explícito, na mesma convenção de `vec3`.
 *
 * Os componentes vivem em 0..1 e não em 0..255 porque é onde a matemática de
 * luz acontece: somar duas luzes, atenuar por distância e aplicar um lóbulo
 * especular são multiplicações e somas que só fazem sentido em ponto flutuante.
 * A conversão para byte acontece uma vez, na escrita da célula.
 *
 * Passar do byte antes da hora custaria a faixa acima de 1.0, que é justamente
 * o que faz o sol e os orbes estourarem no bloom.
 */
export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export const rgb = (r = 0, g = 0, b = 0): Rgb => ({ r, g, b });

export const setRgb = (out: Rgb, r: number, g: number, b: number): Rgb => {
  out.r = r;
  out.g = g;
  out.b = b;
  return out;
};

export const copyRgb = (out: Rgb, a: Rgb): Rgb => setRgb(out, a.r, a.g, a.b);

export const addRgb = (out: Rgb, a: Rgb, b: Rgb): Rgb =>
  setRgb(out, a.r + b.r, a.g + b.g, a.b + b.b);

/** `out = a + b * s`. A soma de uma contribuição de luz, em uma chamada só. */
export const addScaledRgb = (out: Rgb, a: Rgb, b: Rgb, s: number): Rgb =>
  setRgb(out, a.r + b.r * s, a.g + b.g * s, a.b + b.b * s);

export const scaleRgb = (out: Rgb, a: Rgb, s: number): Rgb =>
  setRgb(out, a.r * s, a.g * s, a.b * s);

/** Produto componente a componente: é como albedo filtra a cor da luz. */
export const mulRgb = (out: Rgb, a: Rgb, b: Rgb): Rgb =>
  setRgb(out, a.r * b.r, a.g * b.g, a.b * b.b);

export const lerpRgb = (out: Rgb, a: Rgb, b: Rgb, t: number): Rgb =>
  setRgb(
    out,
    a.r + (b.r - a.r) * t,
    a.g + (b.g - a.g) * t,
    a.b + (b.b - a.b) * t,
  );

/**
 * Luminância perceptual (Rec. 601).
 *
 * É o escalar que a rampa de glifos consome: `#` e `@` têm que aparecer onde o
 * olho vê brilho, e o olho pesa verde muito acima de azul. Usar a média dos
 * três canais deixaria um azul saturado tão "claro" quanto um amarelo, e a
 * rampa mentiria.
 */
export const luminance = (c: Rgb): number =>
  c.r * 0.299 + c.g * 0.587 + c.b * 0.114;

/**
 * `#rrggbb` para 0..1.
 *
 * As cores do cenário continuam sendo escritas em hex porque foi assim que
 * foram escolhidas, primeiro em CSS e depois na paleta indexada. Manter o
 * literal é o que deixa conferível, por diff, que a troca para RGB não mexeu
 * na arte.
 */
export const fromHex = (hex: string): Rgb => {
  const value = Number.parseInt(hex.slice(1), 16);
  return rgb(
    ((value >> 16) & 0xff) / 255,
    ((value >> 8) & 0xff) / 255,
    (value & 0xff) / 255,
  );
};

const toByte = (channel: number): number =>
  Math.max(0, Math.min(255, Math.round(channel * 255)));

/** Volta para `#rrggbb`, para diagnóstico legível no console. */
export const toHex = (c: Rgb): string =>
  `#${((toByte(c.r) << 16) | (toByte(c.g) << 8) | toByte(c.b)).toString(16).padStart(6, "0")}`;
