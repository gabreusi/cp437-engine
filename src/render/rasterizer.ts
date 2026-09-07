import * as mat4 from '../math/mat4';
import { type Vec3, lerp, vec3 } from '../math/vec3';
import type { Camera } from './camera';
import type { Framebuffer } from './framebuffer';
import { CELL_ASPECT, type Viewport } from './viewport';

/** Classe de inclinação do segmento já em espaço de tela. */
export const SLOPE = {
    VERTICAL: 0,
    HORIZONTAL: 1,
    /** Sobe para a direita: `/` */
    UP: 2,
    /** Desce para a direita: `\` */
    DOWN: 3,
} as const;

export type Slope = (typeof SLOPE)[keyof typeof SLOPE];

export interface Fragment {
    glyph: number;
    color: number;
    alpha: number;
}

/**
 * Decide a aparência de um fragmento. A geometria é do rasterizador, a estética
 * é da cena — é isto que mantém a escolha de glifo e a névoa fora daqui.
 *
 * Devolver `false` descarta o fragmento; é assim que o dithering da névoa
 * dissolve a grade ao longe.
 */
export type LineStyle = (depth: number, slope: Slope, out: Fragment) => boolean;

export interface Projected {
    col: number;
    row: number;
    depth: number;
}

/** Abaixo disto o segmento é um ponto e a inclinação não significa nada. */
const SLOPE_EPSILON = 1e-6;

/**
 * Fronteiras entre `|`, as diagonais e `-`, em inclinação visual.
 *
 * A comparação tem que ser feita em pixels, não em células: a célula é 1:2, e
 * um segmento que anda duas colunas por fileira é uma diagonal de 45 graus na
 * tela, não algo "predominantemente horizontal".
 */
const VERTICAL_ABOVE = 2.4;
const HORIZONTAL_BELOW = 0.41;

export class Rasterizer {
    private camera!: Camera;
    private framebuffer!: Framebuffer;

    private focalX = 1;
    private focalY = 1;
    private colCount = 0;
    private rowCount = 0;
    private near = 0.1;

    // Rascunhos reaproveitados: este código roda por segmento, por quadro.
    private readonly viewA: Vec3 = vec3();
    private readonly viewB: Vec3 = vec3();
    private readonly clipped: Vec3 = vec3();
    private readonly fragment: Fragment = { glyph: 0, color: 0, alpha: 255 };

    private t0 = 0;
    private t1 = 1;

    begin(camera: Camera, viewport: Viewport, framebuffer: Framebuffer): void {
        this.camera = camera;
        this.framebuffer = framebuffer;
        this.colCount = viewport.colCount;
        this.rowCount = viewport.rowCount;
        this.near = camera.near;

        // A proporção da célula entra aqui, uma vez só. Errar deixa o sol oval.
        this.focalY = 1 / Math.tan(camera.fov / 2);
        this.focalX = this.focalY / viewport.aspect;
    }

    /**
     * Projeta um ponto de mundo. Devolve `false` se estiver atrás do near plane
     * — projetar com `w <= 0` produziria coordenadas espalhadas pela tela.
     */
    project(x: number, y: number, z: number, out: Projected): boolean {
        mat4.transformPoint(this.viewA, this.camera.view, x, y, z);
        const w = -this.viewA.z;
        if (w <= this.near) return false;

        this.toScreen(this.viewA, w, out);
        out.depth = w;
        return true;
    }

    /**
     * Projeta uma direção, ignorando a translação da câmera.
     *
     * É o que o céu usa: sem translação não há paralaxe, então andar não move o
     * sol nem as estrelas, e só girar move — que é o correto para o infinito.
     */
    projectDirection(x: number, y: number, z: number, out: Projected): boolean {
        mat4.transformDirection(this.viewA, this.camera.view, x, y, z);
        const w = -this.viewA.z;
        if (w <= 1e-6) return false;

        this.toScreen(this.viewA, w, out);
        out.depth = Infinity;
        return true;
    }

    private toScreen(view: Vec3, w: number, out: Projected): void {
        const ndcX = (view.x * this.focalX) / w;
        const ndcY = (view.y * this.focalY) / w;
        out.col = (ndcX * 0.5 + 0.5) * this.colCount;
        out.row = (0.5 - ndcY * 0.5) * this.rowCount;
    }

    /** Segmento em coordenadas de mundo. */
    line(ax: number, ay: number, az: number, bx: number, by: number, bz: number, style: LineStyle): void {
        mat4.transformPoint(this.viewA, this.camera.view, ax, ay, az);
        mat4.transformPoint(this.viewB, this.camera.view, bx, by, bz);
        this.lineFromView(this.viewA, this.viewB, style);
    }

    /**
     * Recorta no near plane e desenha.
     *
     * O clipping tem que acontecer aqui, em espaço de view, antes da divisão
     * perspectiva: um ponto atrás da câmera projeta para coordenadas sem
     * sentido, e a linha atravessa a tela inteira em vez de sumir.
     */
    private lineFromView(a: Vec3, b: Vec3, style: LineStyle): void {
        let wa = -a.z;
        let wb = -b.z;

        if (wa <= this.near && wb <= this.near) return;

        let ax = a.x, ay = a.y;
        let bx = b.x, by = b.y;

        if (wa <= this.near) {
            const t = (this.near - wa) / (wb - wa);
            lerp(this.clipped, a, b, t);
            ax = this.clipped.x;
            ay = this.clipped.y;
            wa = this.near;
        } else if (wb <= this.near) {
            const t = (this.near - wb) / (wa - wb);
            lerp(this.clipped, b, a, t);
            bx = this.clipped.x;
            by = this.clipped.y;
            wb = this.near;
        }

        const col0 = ((ax * this.focalX) / wa * 0.5 + 0.5) * this.colCount;
        const row0 = (0.5 - (ay * this.focalY) / wa * 0.5) * this.rowCount;
        const col1 = ((bx * this.focalX) / wb * 0.5 + 0.5) * this.colCount;
        const row1 = (0.5 - (by * this.focalY) / wb * 0.5) * this.rowCount;

        this.drawScreenLine(col0, row0, 1 / wa, col1, row1, 1 / wb, style);
    }

    /**
     * Recorta no retângulo da tela e percorre.
     *
     * Sem este segundo recorte, uma linha da grade perto do horizonte projeta
     * para um segmento de comprimento absurdo e o laço anda milhões de células
     * fora da tela.
     *
     * A profundidade é interpolada em `1/w`, não em `w`: só o inverso é linear
     * em espaço de tela. Interpolar `w` faria a névoa escorregar ao longo das
     * linhas conforme a câmera gira.
     */
    private drawScreenLine(
        col0: number, row0: number, invW0: number,
        col1: number, row1: number, invW1: number,
        style: LineStyle,
    ): void {
        const deltaCol = col1 - col0;
        const deltaRow = row1 - row0;

        this.t0 = 0;
        this.t1 = 1;
        if (!this.clipEdge(-deltaCol, col0)) return;
        if (!this.clipEdge(deltaCol, this.colCount - col0)) return;
        if (!this.clipEdge(-deltaRow, row0)) return;
        if (!this.clipEdge(deltaRow, this.rowCount - row0)) return;

        const startCol = col0 + deltaCol * this.t0;
        const startRow = row0 + deltaRow * this.t0;
        const spanCol = deltaCol * (this.t1 - this.t0);
        const spanRow = deltaRow * (this.t1 - this.t0);

        const startInvW = invW0 + (invW1 - invW0) * this.t0;
        const spanInvW = (invW1 - invW0) * (this.t1 - this.t0);

        const slope = classifySlope(spanCol, spanRow);
        const steps = Math.max(1, Math.ceil(Math.max(Math.abs(spanCol), Math.abs(spanRow))));

        for (let step = 0; step <= steps; step += 1) {
            const s = step / steps;
            const invW = startInvW + spanInvW * s;
            if (invW <= 0) continue;

            if (!style(1 / invW, slope, this.fragment)) continue;

            this.framebuffer.plot(
                Math.round(startCol + spanCol * s),
                Math.round(startRow + spanRow * s),
                this.fragment.glyph,
                this.fragment.color,
                1 / invW,
                this.fragment.alpha,
            );
        }
    }

    /** Um lado do Liang–Barsky. Estreita `t0`/`t1` ou rejeita o segmento. */
    private clipEdge(p: number, q: number): boolean {
        if (p === 0) return q >= 0;

        const r = q / p;
        if (p < 0) {
            if (r > this.t1) return false;
            if (r > this.t0) this.t0 = r;
        } else {
            if (r < this.t0) return false;
            if (r < this.t1) this.t1 = r;
        }
        return true;
    }

    /**
     * Converte um raio angular no raio equivalente em fileiras de tela.
     *
     * É o que dá tamanho ao sol: ele está no infinito, então não tem tamanho em
     * unidades de mundo, só o ângulo que ocupa no campo de visão.
     */
    angularRadiusRows(angle: number): number {
        return Math.tan(angle) * this.focalY * 0.5 * this.rowCount;
    }

    /**
     * Fileira onde o horizonte cruza a tela.
     *
     * O horizonte é exatamente horizontal e não depende do azimute: rotacionar
     * um ponto `(x, 0, z)` por pitch dá `ndcY = -tan(pitch) * focalY`, constante.
     * Sem roll na câmera, uma fileira inteira basta.
     */
    horizonRow(): number {
        return (0.5 + Math.tan(this.camera.pitch) * this.focalY * 0.5) * this.rowCount;
    }

    /** Escreve uma célula por coordenada direta, para formas em espaço de tela. */
    plotCell(col: number, row: number, glyph: number, color: number, depth: number, alpha = 255): void {
        this.framebuffer.plot(col, row, glyph, color, depth, alpha);
    }

    /** Escreve uma célula já projetada. Estrelas e o sol usam este caminho. */
    plot(projected: Projected, glyph: number, color: number, alpha = 255): void {
        this.framebuffer.plot(
            Math.round(projected.col),
            Math.round(projected.row),
            glyph,
            color,
            projected.depth,
            alpha,
        );
    }
}

const classifySlope = (deltaCol: number, deltaRow: number): Slope => {
    const absCol = Math.abs(deltaCol);
    const absRow = Math.abs(deltaRow);

    if (absCol < SLOPE_EPSILON) return absRow < SLOPE_EPSILON ? SLOPE.HORIZONTAL : SLOPE.VERTICAL;

    const visualSlope = (absRow * CELL_ASPECT) / absCol;
    if (visualSlope > VERTICAL_ABOVE) return SLOPE.VERTICAL;
    if (visualSlope < HORIZONTAL_BELOW) return SLOPE.HORIZONTAL;

    // A fileira cresce para baixo na tela, então sinais iguais são descida.
    return deltaCol * deltaRow > 0 ? SLOPE.DOWN : SLOPE.UP;
};

export const createProjected = (): Projected => ({ col: 0, row: 0, depth: 0 });
