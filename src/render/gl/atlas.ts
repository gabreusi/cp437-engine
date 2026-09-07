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
}

/**
 * Desenha o charset num canvas 2D e sobe como textura.
 *
 * Filtragem NEAREST de propósito: além de ser a estética certa para arte ASCII,
 * evita o glifo vizinho sangrar na borda da célula sem precisar de padding — e
 * padding faria os caracteres de bloco pararem antes da borda, abrindo frestas
 * no meio do sol.
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
    const fontSize = MEASURE_SIZE * (cellWidth / advanceAtMeasureSize);

    ctx.font = `${fontSize}px ${FONT_STACK}`;
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (let index = 0; index < CHARSET.length; index += 1) {
        const col = index % cols;
        const row = Math.floor(index / cols);
        ctx.fillText(
            CHARSET[index] ?? ' ',
            col * cellWidth + cellWidth / 2,
            row * cellHeight + cellHeight / 2,
        );
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

    return { texture, cols, rows, cellWidth };
};
