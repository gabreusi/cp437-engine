import { toHex } from "../math/color";
import type { Framebuffer } from "./framebuffer";
import { CHARSET } from "./palette";

/**
 * Despeja o framebuffer como texto.
 *
 * O plano previa um presenter alternativo em DOM para responder "qual caractere
 * está realmente naquela célula" quando a GPU mostrasse algo estranho. Um
 * segundo caminho de render inteiro é caro de manter e teria que reintroduzir a
 * paleta em CSS, que acabou de sair de lá. Isto responde a mesma pergunta em
 * vinte linhas e sem caminho paralelo para divergir.
 */
export const dumpGlyphs = (framebuffer: Framebuffer): string => {
  const lines: string[] = [];

  for (let row = 0; row < framebuffer.rowCount; row += 1) {
    let line = "";
    for (let col = 0; col < framebuffer.colCount; col += 1) {
      const glyph =
        framebuffer.cells[(row * framebuffer.colCount + col) * 4] ?? 0;
      line += CHARSET[glyph] ?? "?";
    }
    lines.push(line);
  }
  return lines.join("\n");
};

/**
 * Quantas células cada cor ocupa. Útil para achar camada sumida.
 *
 * Agrupa por hex e não por índice porque a paleta indexada não existe mais.
 * Com luz colorida a contagem vira uma cauda longa de tons parecidos, então o
 * resultado sai ordenado: as poucas cores que dominam a tela são as camadas do
 * cenário, e é sobre elas que a pergunta costuma ser.
 */
export const countByColor = (
  framebuffer: Framebuffer,
): Record<string, number> => {
  const counts = new Map<string, number>();
  const { cells, colors } = framebuffer;

  for (let offset = 0; offset < cells.length; offset += 4) {
    // Alpha zero é célula vazia; contar isso afogaria o resto.
    if ((cells[offset + 1] ?? 0) === 0) continue;

    const key = toHex({
      r: (colors[offset] ?? 0) / 255,
      g: (colors[offset + 1] ?? 0) / 255,
      b: (colors[offset + 2] ?? 0) / 255,
    });
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return Object.fromEntries([...counts].sort((a, b) => b[1] - a[1]));
};
