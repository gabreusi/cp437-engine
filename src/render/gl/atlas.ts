import { CHARSET } from '../palette';
import { CELL_ASPECT } from '../viewport';

/** Colunas no atlas. Com 128 glifos, o atlas fecha em oito fileiras exatas. */
export const ATLAS_COLS = 16;

const FONT_STACK = '"Courier New", Consolas, "DejaVu Sans Mono", monospace';

/** Largura de célula onde a fonte é medida; a escala final é proporcional. */
const MEASURE_SIZE = 100;

const MIN_CELL = 6;

/**
 * Teto do tamanho de célula no atlas.
 *
 * Com 256 glifos o atlas tem dezesseis fileiras, então a célula multiplica por
 * 32 na altura da textura. Sessenta e quatro dá 1024x2048, dentro do limite de
 * qualquer GPU que rode WebGL2, e a célula só chegaria perto disso numa janela
 * de doze mil pixels de largura.
 */
const MAX_CELL = 64;

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

/**
 * Retângulo em coordenadas fracionárias da célula.
 *
 * As duas bordas são arredondadas, em vez de arredondar o tamanho: com célula
 * de largura ímpar, `ceil` de meia largura estoura meio pixel para dentro da
 * célula vizinha, e o vazamento aparece como traço fantasma no glifo do lado.
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

/** Fração da largura da célula que um traço da moldura ocupa. */
const STROKE = 0.14;

/**
 * Traço centrado, em fração da célula.
 *
 * A moldura tem que emendar entre células vizinhas, então o traço vai de borda
 * a borda e o miolo é o cruzamento. Centralizar pela espessura, e não pela
 * metade exata, é o que faz `┌` e `└` alinharem a mesma coluna vertical.
 */
const strokeSpans = (box: CellBox) => {
    const thickness = Math.max(1, Math.round(box.w * STROKE));
    const tx = thickness / box.w;
    const ty = thickness / box.h;
    return { tx, ty, cx: 0.5 - tx / 2, cy: 0.5 - ty / 2 };
};

/**
 * Metades de traço que cada glifo de moldura acende.
 *
 * Descrever por direção em vez de desenhar cada um à mão: onze glifos são a
 * mesma cruz com braços diferentes ligados, e escrever onze funções separadas
 * seria onze chances de desalinhar o centro.
 */
const boxPainter =
    (left: boolean, right: boolean, up: boolean, down: boolean): GlyphPainter =>
    (ctx, box) => {
        const { tx, ty, cx, cy } = strokeSpans(box);
        if (left) spanRect(ctx, box, 0, cy, cx + tx, ty);
        if (right) spanRect(ctx, box, cx, cy, 1 - cx, ty);
        if (up) spanRect(ctx, box, cx, 0, tx, cy + ty);
        if (down) spanRect(ctx, box, cx, cy, tx, 1 - cy);
    };

/** Triângulo cheio apontando para um lado. As setas dos sliders do menu. */
const arrowPainter =
    (dx: number, dy: number): GlyphPainter =>
    (ctx, box) => {
        // Recuado da borda: encostado, a seta lê como bloco e some do slider.
        const inset = 0.2;
        const half = 0.5 - inset;
        const cx = box.x + box.w / 2;
        const cy = box.y + box.h / 2;

        ctx.beginPath();
        ctx.moveTo(cx + dx * half * box.w, cy + dy * half * box.h);
        ctx.lineTo(cx - (dx * half + dy * half) * box.w, cy - (dy * half + dx * half) * box.h);
        ctx.lineTo(cx - (dx * half - dy * half) * box.w, cy - (dy * half - dx * half) * box.h);
        ctx.closePath();
        ctx.fill();
    };

/**
 * Glifos desenhados à mão, não tirados da fonte.
 *
 * A fonte desenha numa caixa de proporção própria (~1:1,67) enquanto a célula é
 * 1:2, e nada que precise encostar na borda sobrevive a isso: o `_` para antes
 * da base, e uma moldura de menu sairia com fresta em cada emenda.
 */
const PAINTERS: Record<string, GlyphPainter> = {
    /**
     * O bloco cheio, encostando nas quatro bordas.
     *
     * O `█` da fonte para antes da base — a mesma métrica de 1:1,67 numa célula
     * 1:2 — e o resultado é uma fresta horizontal entre fileiras. Numa silhueta
     * de sol isso é um detalhe; num fundo de menu é a cena inteira aparecendo
     * através de listras.
     */
    '█': (ctx, box) => spanRect(ctx, box, 0, 0, 1, 1),
    '▀': (ctx, box) => spanRect(ctx, box, 0, 0, 1, 0.5),
    '▄': (ctx, box) => spanRect(ctx, box, 0, 0.5, 1, 0.5),

    // Espessura semelhante à do `_` da fonte, mas colado na base da célula.
    '▁': (ctx, box) => {
        const thickness = Math.max(1, Math.round(box.w * STROKE));
        spanRect(ctx, box, 0, 1 - thickness / box.h, 1, thickness / box.h);
    },

    '─': boxPainter(true, true, false, false),
    '│': boxPainter(false, false, true, true),
    '┌': boxPainter(false, true, false, true),
    '┐': boxPainter(true, false, false, true),
    '└': boxPainter(false, true, true, false),
    '┘': boxPainter(true, false, true, false),
    '├': boxPainter(false, true, true, true),
    '┤': boxPainter(true, false, true, true),
    '┬': boxPainter(true, true, false, true),
    '┴': boxPainter(true, true, true, false),
    '┼': boxPainter(true, true, true, true),

    '◄': arrowPainter(-1, 0),
    '►': arrowPainter(1, 0),
    '▲': arrowPainter(0, -1),
    '▼': arrowPainter(0, 1),
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
