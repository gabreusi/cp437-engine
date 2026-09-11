import { type Rgb, setRgb } from "../math/color";
import { SKY, SKY_WEIGHT } from "../render/sky-colors";
import type { SkyModel } from "./types";

/**
 * O que um raio vê ao sair da cena e olhar para o céu.
 *
 * É a contraparte em direção do gradiente que o pass de fundo pinta em tela.
 * Não é a mesma fórmula, e não pode ser: aquele é um arranjo de elipses em UV,
 * afinado para ficar bonito na moldura da janela, e não tem sentido para uma
 * direção arbitrária. O que as duas compartilham são as cores e os pesos, que
 * moram em `sky-colors.ts` justamente para não se separarem — o reflexo tem que
 * concordar com o céu pintado atrás dele.
 *
 * As camadas, de baixo para cima:
 *
 *   void      a cor do vazio, presente em toda direção
 *   wash      roxo lavando a faixa em torno do horizonte
 *   band      ciano fino colado no horizonte
 *   glow      rosa quente em volta do sol
 *   disco     o sol propriamente, alargado pelo brilho da superfície
 *   chão      abaixo do horizonte não há céu, há bruma
 *
 * As três camadas do meio são luz do sol espalhada, e é o sol quem diz o quanto:
 * `sunGlow`, `horizonGlow` e `sunSpread` chegam prontos no modelo de céu. Só o
 * vazio é constante — ele não é luz de ninguém.
 */

/** Largura da faixa de horizonte, em seno de elevação. */
const WASH_WIDTH = 0.32;
const BAND_WIDTH = 0.06;

/** Queda do brilho quente em volta do sol, em `1 - cos`. */
const GLOW_FALLOFF = 7;

/**
 * Alargamento mínimo do disco solar no reflexo.
 *
 * Um disco duro deixaria o reflexo do sol na grade do tamanho de uma célula.
 * Amarrar a largura ao `gloss` da superfície é o que faz a mesma conta servir
 * para a grade, que espalha o sol numa coluna quente, e para o painel, que o
 * devolve quase do tamanho certo.
 */
const MIN_LOBE = 1;

export const skyRadiance = (
  sky: SkyModel,
  dx: number,
  dy: number,
  dz: number,
  gloss: number,
  out: Rgb,
): void => {
  const { sunDirection: sun } = sky;
  const cosSun = dx * sun.x + dy * sun.y + dz * sun.z;

  // `dy` já é o seno da elevação: a direção é unitária.
  const horizon = sky.sunGlow * sky.horizonGlow;
  const wash = Math.exp(-(dy * dy) / (WASH_WIDTH * WASH_WIDTH)) * horizon;
  const band = Math.exp(-(dy * dy) / (BAND_WIDTH * BAND_WIDTH)) * horizon;
  // Um disco maior espalha mais longe: a queda afrouxa na mesma proporção.
  const glow =
    Math.exp(-(1 - cosSun) * (GLOW_FALLOFF / sky.sunSpread)) * sky.sunGlow;

  // O expoente vem do material: fosco espalha o sol, espelho o aperta.
  const lobe = cosSun <= 0 ? 0 : Math.pow(cosSun, Math.max(MIN_LOBE, gloss));
  const disc = lobe * sky.sunIntensity;

  let r = SKY.VOID.r + SKY.PURPLE.r * wash * SKY_WEIGHT.WASH;
  let g = SKY.VOID.g + SKY.PURPLE.g * wash * SKY_WEIGHT.WASH;
  let b = SKY.VOID.b + SKY.PURPLE.b * wash * SKY_WEIGHT.WASH;

  r +=
    SKY.CYAN.r * band * SKY_WEIGHT.BAND + SKY.PINK.r * glow * SKY_WEIGHT.GLOW;
  g +=
    SKY.CYAN.g * band * SKY_WEIGHT.BAND + SKY.PINK.g * glow * SKY_WEIGHT.GLOW;
  b +=
    SKY.CYAN.b * band * SKY_WEIGHT.BAND + SKY.PINK.b * glow * SKY_WEIGHT.GLOW;

  r += sky.sunColor.r * disc;
  g += sky.sunColor.g * disc;
  b += sky.sunColor.b * disc;

  // Abaixo do horizonte o raio não sai para o céu: encontra chão e bruma.
  // Sem isto, uma superfície virada para baixo refletiria estrelas.
  if (dy < 0) {
    const ground = Math.min(1, -dy * 4);
    r += (SKY.HAZE.r * 0.25 - r) * ground;
    g += (SKY.HAZE.g * 0.25 - g) * ground;
    b += (SKY.HAZE.b * 0.25 - b) * ground;
  }

  const scale = sky.intensity;
  setRgb(out, r * scale, g * scale, b * scale);
};
