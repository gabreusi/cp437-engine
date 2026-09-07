import { CHARSET } from '../palette';
import { CELL_ASPECT } from '../viewport';

/** Colunas no atlas. Sobra espaço para dígitos e letras quando o HUD precisar. */
export const ATLAS_COLS = 16;

const FONT_STACK = '"Courier New", Consolas, "DejaVu Sans Mono", monospace';

/** Largura de célula onde a fonte é medida; a escala final é proporcional. */
const MEASURE_SIZE = 100;

const MIN_CELL = 6;
const MAX_CELL = 128;

/**
 * Largura de célula do atlas para um dado tamanho de célula em pixels de tela.
 *
 * O atlas acompanha o tamanho real da célula, sem arredondar para potência de
 * dois: WebGL2 aceita textura NPOT com NEAREST e CLAMP, e o rigor custaria
 * nitidez. Com o atlas maior que a célula, NEAREST minifica descartando texels
 * e os traços finos saem irregulares — 1:1 é o que mantém o glifo inteiro.
 */
export const atlasCellWidthFor = (cellWidthDevicePx: number): number =>
    Math.min(MAX_CELL, Math.max(MIN_CELL, Math.round(cellWidthDevicePx)));

export interface GlyphAtlas {
    texture: WebGLTexture;
    cols: number;
    rows: number;
    cellWidth: number;
    /**
     * O canvas de origem, guardado para inspeção.
     *
     * O atlas é a única parte da engine que não dá para conferir pelo
     * framebuffer: quando um glifo sai errado na tela mas certo no buffer, a
     * resposta está aqui.
     */
    canvas: HTMLCanvasElement;
}

interface CellBox {
    x: number;
    y: number;
    w: number;
    h: number;
}

type GlyphPainter = (ctx: CanvasRenderingContext2D, box: CellBox) => void;

/** Matriz de Bayer 4x4, para os sombreados saírem regulares e emendáveis. */
const BAYER_4X4 = [
    0, 8, 2, 10,
    12, 4, 14, 6,
    3, 11, 1, 9,
    15, 7, 13, 5,
];

/**
 * Retângulo em coordenadas fracionárias da célula.
 *
 * As duas bordas são arredondadas, em vez de arredondar o tamanho: com célula
 * de largura ímpar, `ceil` de meia largura estoura meio pixel para dentro da
 * célula vizinha, e o vazamento aparece como um traço fantasma no glifo do
 * lado. Arredondando as bordas, sub-retângulos adjacentes continuam emendando
 * — a borda direita de um é o mesmo número da borda esquerda do outro — e nada
 * ultrapassa a célula.
 */
const spanRect = (
    ctx: CanvasRenderingContext2D,
    box: CellBox,
    fx: number,
    fy: number,
    fw: number,
    fh: number,
): void => {
    const x0 = Math.round(box.x + fx * box.w);
    const y0 = Math.round(box.y + fy * box.h);
    const x1 = Math.round(box.x + (fx + fw) * box.w);
    const y1 = Math.round(box.y + (fy + fh) * box.h);
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
};

/** Preenche sub-blocos conforme a densidade, num padrão que casa entre células. */
const dither = (density: number): GlyphPainter => (ctx, box) => {
    const threshold = density * 16;

    for (let index = 0; index < 16; index += 1) {
        if ((BAYER_4X4[index] ?? 16) >= threshold) continue;
        spanRect(ctx, box, (index % 4) / 4, Math.floor(index / 4) / 4, 1 / 4, 1 / 4);
    }
};

const rect = (fx: number, fy: number, fw: number, fh: number): GlyphPainter => (ctx, box) => {
    spanRect(ctx, box, fx, fy, fw, fh);
};

const compose = (...painters: GlyphPainter[]): GlyphPainter => (ctx, box) => {
    for (const painter of painters) painter(ctx, box);
};

/**
 * Glifos desenhados à mão, não tirados da fonte.
 *
 * A fonte desenha numa caixa de proporção própria (~1:1,67) enquanto a célula é
 * 1:2, então um bloco da fonte deixaria fresta entre células vizinhas. Desenhar
 * em retângulos garante que preencham a célula exata, o que é o que faz os
 * quadrantes emendarem com o bloco cheio na silhueta do sol.
 */
const PAINTERS: Record<string, GlyphPainter> = {
    '█': rect(0, 0, 1, 1),
    '▓': dither(0.75),
    '▒': dither(0.5),
    '░': dither(0.25),

    '▘': rect(0, 0, 0.5, 0.5),
    '▝': rect(0.5, 0, 0.5, 0.5),
    '▖': rect(0, 0.5, 0.5, 0.5),
    '▗': rect(0.5, 0.5, 0.5, 0.5),
    '▀': rect(0, 0, 1, 0.5),
    '▄': rect(0, 0.5, 1, 0.5),
    '▌': rect(0, 0, 0.5, 1),
    '▐': rect(0.5, 0, 0.5, 1),
    // Espessura semelhante à do `_` da fonte, mas colado na base da célula.
    '▁': (ctx, box) => {
        const thickness = Math.max(1, Math.round(box.w * 0.14));
        spanRect(ctx, box, 0, 1 - thickness / box.h, 1, thickness / box.h);
    },

    '▚': compose(rect(0, 0, 0.5, 0.5), rect(0.5, 0.5, 0.5, 0.5)),
    '▞': compose(rect(0.5, 0, 0.5, 0.5), rect(0, 0.5, 0.5, 0.5)),
    '▛': compose(rect(0, 0, 1, 0.5), rect(0, 0.5, 0.5, 0.5)),
    '▜': compose(rect(0, 0, 1, 0.5), rect(0.5, 0.5, 0.5, 0.5)),
    '▙': compose(rect(0, 0, 0.5, 0.5), rect(0, 0.5, 1, 0.5)),
    '▟': compose(rect(0.5, 0, 0.5, 0.5), rect(0, 0.5, 1, 0.5)),

};

/**
 * Desenha o charset num canvas 2D e sobe como textura.
 *
 * Filtragem NEAREST de propósito: além de ser a estética certa para arte ASCII,
 * evita o glifo vizinho sangrar na borda da célula sem precisar de padding — e
 * padding faria os blocos pararem antes da borda, abrindo frestas na silhueta
 * do sol e nas emendas da grade.
 */
export const buildGlyphAtlas = (gl: WebGL2RenderingContext, cellWidth: number): GlyphAtlas => {
    const cellHeight = cellWidth * CELL_ASPECT;
    const cols = ATLAS_COLS;
    const rows = Math.ceil(CHARSET.length / cols);

    const canvas = document.createElement('canvas');
    canvas.width = cols * cellWidth;
    canvas.height = rows * cellHeight;

    const ctx = canvas.getContext('2d');
    if (ctx === null) throw new Error('Canvas 2D indisponível para montar o atlas.');

    // A largura do avanço da fonte cresce linear com o tamanho, então uma
    // medição basta para achar o tamanho que preenche a célula exatamente.
    ctx.font = `${MEASURE_SIZE}px ${FONT_STACK}`;
    const advanceAtMeasureSize = ctx.measureText('0').width;

    ctx.font = `${MEASURE_SIZE * (cellWidth / advanceAtMeasureSize)}px ${FONT_STACK}`;
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (let index = 0; index < CHARSET.length; index += 1) {
        const char = CHARSET[index] ?? ' ';
        const box: CellBox = {
            x: (index % cols) * cellWidth,
            y: Math.floor(index / cols) * cellHeight,
            w: cellWidth,
            h: cellHeight,
        };

        const painter = PAINTERS[char];
        if (painter !== undefined) {
            painter(ctx, box);
        } else {
            ctx.fillText(char, box.x + box.w / 2, box.y + box.h / 2);
        }
    }

    const texture = gl.createTexture();
    if (texture === null) throw new Error('Não foi possível criar a textura do atlas.');

    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    return { texture, cols, rows, cellWidth, canvas };
};
