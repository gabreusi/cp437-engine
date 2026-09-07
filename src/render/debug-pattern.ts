import type { Framebuffer } from './framebuffer';
import { COLOR, CHARSET, STAR_TINTS, SUN_SHADES } from './palette';
import { OVERLAY_DEPTH } from './text';

/**
 * As cores nomeadas do cenário, sem repetir.
 *
 * `STAR_TINTS` repete o branco-azulado seis vezes para enviesar o sorteio das
 * estrelas; aqui isso viraria seis fileiras idênticas, então cai fora.
 */
const SWATCHES = [...new Set([...SUN_SHADES, ...STAR_TINTS, ...Object.values(COLOR)])];

/** Colunas por fileira da tabela. Bate com a largura do atlas. */
const STRIDE = 16;

/**
 * Desenha os 128 glifos do atlas, ciclando as cores do cenário.
 *
 * É o alvo verificável da camada de GPU: se o atlas, as data textures e o
 * mapeamento de célula estiverem certos, isto aparece como uma tabela legível,
 * com a mesma disposição do atlas — a fileira `n` da tela é a fileira `n` da
 * textura. Qualquer erro de índice ou de orientação salta aos olhos aqui, antes
 * de a cena existir para confundir o diagnóstico.
 *
 * As células ficam espaçadas de duas em duas porque a célula é 1:2: colada, a
 * tabela sai deformada e um glifo cortado parece um glifo errado.
 */
export const drawDebugPattern = (framebuffer: Framebuffer): void => {
    framebuffer.clear();

    for (let index = 0; index < CHARSET.length; index += 1) {
        const row = Math.floor(index / STRIDE);
        const col = (index % STRIDE) * 2;
        if (row >= framebuffer.rowCount || col >= framebuffer.colCount) continue;

        const color = SWATCHES[row % SWATCHES.length]!;
        framebuffer.plot(col, row, index, color, OVERLAY_DEPTH);
    }
};
