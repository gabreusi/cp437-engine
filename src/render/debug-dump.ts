import type { Framebuffer } from './framebuffer';
import { CHARSET, PALETTE } from './palette';

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
        let line = '';
        for (let col = 0; col < framebuffer.colCount; col += 1) {
            const glyph = framebuffer.data[(row * framebuffer.colCount + col) * 4] ?? 0;
            line += CHARSET[glyph] ?? '?';
        }
        lines.push(line);
    }
    return lines.join('\n');
};

/** Quantas células cada cor da paleta ocupa. Útil para achar camada sumida. */
export const countByColor = (framebuffer: Framebuffer): Record<string, number> => {
    const counts: Record<string, number> = {};

    for (let index = 1; index < framebuffer.data.length; index += 4) {
        const color = framebuffer.data[index] ?? 0;
        if (color === 0) continue;
        const key = `${color} ${PALETTE[color] ?? '?'}`;
        counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
};
