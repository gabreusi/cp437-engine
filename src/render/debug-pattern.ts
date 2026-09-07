import type { Framebuffer } from './framebuffer';
import { CHARSET, PALETTE } from './palette';

/**
 * Desenha o charset inteiro em cada cor da paleta.
 *
 * É o alvo verificável da camada de GPU: se o atlas, a data texture, a paleta e
 * o mapeamento de célula estiverem certos, isto aparece como uma tabela legível.
 * Qualquer erro de índice ou de orientação salta aos olhos aqui, antes de a cena
 * existir para confundir o diagnóstico.
 */
export const drawDebugPattern = (framebuffer: Framebuffer): void => {
    framebuffer.clear();

    // Cor 0 é "vazio" e renderiza preto; a tabela começa na primeira cor real.
    for (let color = 1; color < PALETTE.length; color += 1) {
        const row = color - 1;
        if (row >= framebuffer.rowCount) break;

        for (let index = 0; index < CHARSET.length; index += 1) {
            const col = index * 2;
            if (col >= framebuffer.colCount) break;
            framebuffer.plot(col, row, index, color, 1);
        }
    }
};
