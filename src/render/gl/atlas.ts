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

interface CellBox {
    x: number;
    y: number;
    w: number;
    h: number;
}

type GlyphPainter = (ctx: CanvasRenderingContext2D, box: CellBox, thin: number, thick: number) => void;

/** Matriz de Bayer 4x4, para os sombreados saírem regulares e emendáveis. */
const BAYER_4X4 = [
    0, 8, 2, 10,
    12, 4, 14, 6,
    3, 11, 1, 9,
    15, 7, 13, 5,
];

/** Preenche sub-blocos conforme a densidade, num padrão que casa entre células. */
const dither = (density: number): GlyphPainter => (ctx, box) => {
    const stepX = box.w / 4;
    const stepY = box.h / 4;
    const threshold = density * 16;

    for (let index = 0; index < 16; index += 1) {
        if ((BAYER_4X4[index] ?? 16) >= threshold) continue;
        const col = index % 4;
        const row = Math.floor(index / 4);
        // Ceil para não deixar fresta de subpixel entre os blocos.
        ctx.fillRect(
            box.x + col * stepX,
            box.y + row * stepY,
            Math.ceil(stepX),
            Math.ceil(stepY),
        );
    }
};

/** Retângulo em coordenadas fracionárias da célula. */
const rect = (fx: number, fy: number, fw: number, fh: number): GlyphPainter => (ctx, box) => {
    ctx.fillRect(
        box.x + fx * box.w,
        box.y + fy * box.h,
        Math.ceil(fw * box.w),
        Math.ceil(fh * box.h),
    );
};

const compose = (...painters: GlyphPainter[]): GlyphPainter => (ctx, box, thin, thick) => {
    for (const painter of painters) painter(ctx, box, thin, thick);
};

const horizontal = (heavy: boolean): GlyphPainter => (ctx, box, thin, thick) => {
    const width = heavy ? thick : thin;
    ctx.fillRect(box.x, box.y + (box.h - width) / 2, box.w, width);
};

const vertical = (heavy: boolean): GlyphPainter => (ctx, box, thin, thick) => {
    const width = heavy ? thick : thin;
    ctx.fillRect(box.x + (box.w - width) / 2, box.y, width, box.h);
};

/**
 * Diagonal de canto a canto.
 *
 * Vai um pouco além dos cantos e é recortada na célula, senão as pontas não
 * encostam nas células vizinhas e a linha volta a parecer tracejada — que é
 * exatamente o defeito que motivou desenhar isto à mão.
 */
const diagonal = (rising: boolean): GlyphPainter => (ctx, box, thin) => {
    ctx.save();
    ctx.beginPath();
    ctx.rect(box.x, box.y, box.w, box.h);
    ctx.clip();

    ctx.beginPath();
    ctx.lineWidth = thin;
    ctx.lineCap = 'butt';
    const overshoot = thin;
    if (rising) {
        ctx.moveTo(box.x - overshoot, box.y + box.h + overshoot);
        ctx.lineTo(box.x + box.w + overshoot, box.y - overshoot);
    } else {
        ctx.moveTo(box.x - overshoot, box.y - overshoot);
        ctx.lineTo(box.x + box.w + overshoot, box.y + box.h + overshoot);
    }
    ctx.stroke();
    ctx.restore();
};

/** Meio braço horizontal e meio vertical, encontrando-se no centro da célula. */
const corner = (right: boolean, down: boolean): GlyphPainter => (ctx, box, thin) => {
    const cx = box.x + Math.round((box.w - thin) / 2);
    const cy = box.y + Math.round((box.h - thin) / 2);

    if (right) ctx.fillRect(cx, cy, box.x + box.w - cx, thin);
    else ctx.fillRect(box.x, cy, cx - box.x + thin, thin);

    if (down) ctx.fillRect(cx, cy, thin, box.y + box.h - cy);
    else ctx.fillRect(cx, box.y, thin, cy - box.y + thin);
};

/**
 * Glifos desenhados à mão, não tirados da fonte.
 *
 * A fonte desenha numa caixa de proporção própria (~1:1,67) enquanto a célula é
 * 1:2, então um `│` da fonte não encostaria no `│` de cima e a grade sairia
 * tracejada. Desenhar em retângulos garante que preencham a célula exata, faz
 * as linhas emendarem, e ainda tira a dependência de a fonte ter box-drawing.
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
    '▚': compose(rect(0, 0, 0.5, 0.5), rect(0.5, 0.5, 0.5, 0.5)),
    '▞': compose(rect(0.5, 0, 0.5, 0.5), rect(0, 0.5, 0.5, 0.5)),
    '▛': compose(rect(0, 0, 1, 0.5), rect(0, 0.5, 0.5, 0.5)),
    '▜': compose(rect(0, 0, 1, 0.5), rect(0.5, 0.5, 0.5, 0.5)),
    '▙': compose(rect(0, 0, 0.5, 0.5), rect(0, 0.5, 1, 0.5)),
    '▟': compose(rect(0.5, 0, 0.5, 0.5), rect(0, 0.5, 1, 0.5)),

    '─': horizontal(false),
    '│': vertical(false),
    '┼': compose(horizontal(false), vertical(false)),
    '╱': diagonal(true),
    '╲': diagonal(false),
    '╳': compose(diagonal(true), diagonal(false)),

    '┌': corner(true, true),
    '┐': corner(false, true),
    '└': corner(true, false),
    '┘': corner(false, false),

    '▁': rect(0, 7 / 8, 1, 1 / 8),
    '▂': rect(0, 6 / 8, 1, 2 / 8),
    '▃': rect(0, 5 / 8, 1, 3 / 8),
    '▅': rect(0, 3 / 8, 1, 5 / 8),
    '▆': rect(0, 2 / 8, 1, 6 / 8),
    '▇': rect(0, 1 / 8, 1, 7 / 8),

    '━': horizontal(true),
    '┃': vertical(true),
    '╋': compose(horizontal(true), vertical(true)),
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
    ctx.strokeStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const thin = Math.max(1, Math.round(cellWidth * 0.14));
    const thick = Math.max(2, Math.round(cellWidth * 0.3));

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
            painter(ctx, box, thin, thick);
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

    return { texture, cols, rows, cellWidth };
};
