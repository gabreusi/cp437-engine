import type { Rgb } from "../math/color";
import type { Framebuffer } from "./framebuffer";
import { GLYPH, glyphForChar } from "./palette";

/**
 * Texto e molduras escritos direto na grade de caracteres.
 *
 * Existe porque o painel de ajustes saiu do DOM e virou menu dentro da engine.
 * Escrever no framebuffer, e não sobre ele em HTML, é o que faz o menu receber
 * bloom, scanline e vinheta junto com a cena — o visual de CRT sai de graça,
 * porque é literalmente o mesmo caminho de render.
 *
 * Só é possível porque o charset agora tem a tabela ASCII com o índice igual ao
 * código do caractere: escrever uma letra é `charCodeAt`, sem tradução.
 */

/**
 * Profundidade da camada de interface.
 *
 * `-Infinity` vence qualquer célula da cena no teste de profundidade, então o
 * menu nunca é comido por uma linha da grade que passe por cima. Não é um
 * número mágico escolhido grande o bastante: é o único valor que não pode ser
 * ultrapassado por geometria nenhuma.
 */
export const OVERLAY_DEPTH = -Infinity;

/** Escreve uma linha de texto e devolve a coluna logo depois do fim. */
export const drawText = (
  framebuffer: Framebuffer,
  col: number,
  row: number,
  text: string,
  color: Rgb,
  alpha = 1,
  emissive = 0,
): number => {
  for (let index = 0; index < text.length; index += 1) {
    const glyph = glyphForChar(text[index]!);
    // Espaço não apaga o que está atrás: é assim que um rótulo curto não
    // abre um buraco retangular na moldura ou na barra do slider.
    if (glyph !== GLYPH.SPACE) {
      framebuffer.plot(
        col + index,
        row,
        glyph,
        color,
        OVERLAY_DEPTH,
        alpha,
        emissive,
      );
    }
  }
  return col + text.length;
};

/** Preenche um retângulo com um glifo só. Fundo do menu e barras cheias. */
export const drawFill = (
  framebuffer: Framebuffer,
  col: number,
  row: number,
  width: number,
  height: number,
  glyph: number,
  color: Rgb,
  alpha = 1,
  emissive = 0,
): void => {
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      framebuffer.plot(
        col + x,
        row + y,
        glyph,
        color,
        OVERLAY_DEPTH,
        alpha,
        emissive,
      );
    }
  }
};

/**
 * Moldura de uma célula de espessura, com os cantos certos.
 *
 * Os glifos de moldura são desenhados no atlas encostando na borda da célula,
 * então as arestas emendam sem fresta — o que a fonte não daria.
 */
export const drawBox = (
  framebuffer: Framebuffer,
  col: number,
  row: number,
  width: number,
  height: number,
  color: Rgb,
  alpha = 1,
  emissive = 0,
): void => {
  if (width < 2 || height < 2) return;

  const right = col + width - 1;
  const bottom = row + height - 1;
  const put = (x: number, y: number, glyph: number): void =>
    framebuffer.plot(x, y, glyph, color, OVERLAY_DEPTH, alpha, emissive);

  for (let x = col + 1; x < right; x += 1) {
    put(x, row, GLYPH.BOX_H);
    put(x, bottom, GLYPH.BOX_H);
  }
  for (let y = row + 1; y < bottom; y += 1) {
    put(col, y, GLYPH.BOX_V);
    put(right, y, GLYPH.BOX_V);
  }

  put(col, row, GLYPH.BOX_TL);
  put(right, row, GLYPH.BOX_TR);
  put(col, bottom, GLYPH.BOX_BL);
  put(right, bottom, GLYPH.BOX_BR);
};
