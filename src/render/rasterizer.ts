import * as mat4 from '../math/mat4';
import { type Rgb, rgb } from '../math/color';
import { type Vec3, lerp, set, vec3 } from '../math/vec3';
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
    /**
     * Escreva *dentro* dela; não troque a referência.
     *
     * O fragmento é reaproveitado entre todos os estilos do quadro. Apontar
     * `color` para uma cor nomeada faria o próximo estilo, que escreve nos
     * componentes, sobrescrever essa constante — e a paleta mudaria de cor no
     * meio da cena.
     */
    color: Rgb;
    /** Cobertura da célula, de 0 a 1. É por onde a névoa dissolve a grade. */
    alpha: number;
    /** Brilho acima de 1. Só ele passa do tone map e vira halo no bloom. */
    emissive: number;
}

/**
 * O fragmento de superfície entregue ao estilo.
 *
 * A posição em mundo entrou porque sem ela não há iluminação: sombra e reflexo
 * são perguntas sobre *onde* o fragmento está, não sobre quão longe ele está da
 * câmera. O rasterizador é quem sabe responder, porque é ele que interpola.
 */
export interface SurfaceSample {
    x: number;
    y: number;
    z: number;
    depth: number;
    slope: Slope;
}

/**
 * Decide a aparência de um fragmento. A geometria é do rasterizador, a estética
 * é da cena — é isto que mantém a escolha de glifo e a névoa fora daqui.
 *
 * Devolver `false` descarta o fragmento; é assim que a névoa dissolve a grade
 * ao longe sem o rasterizador saber o que é névoa.
 */
export type SurfaceStyle = (sample: SurfaceSample, out: Fragment) => boolean;

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
    private readonly worldA: Vec3 = vec3();
    private readonly worldB: Vec3 = vec3();
    private readonly fragment: Fragment = { glyph: 0, color: rgb(), alpha: 1, emissive: 0 };
    private readonly sample: SurfaceSample = { x: 0, y: 0, z: 0, depth: 0, slope: SLOPE.HORIZONTAL };
    private readonly spanA = createProjected();
    private readonly spanB = createProjected();

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
    line(
        ax: number, ay: number, az: number,
        bx: number, by: number, bz: number,
        style: SurfaceStyle,
    ): void {
        mat4.transformPoint(this.viewA, this.camera.view, ax, ay, az);
        mat4.transformPoint(this.viewB, this.camera.view, bx, by, bz);
        set(this.worldA, ax, ay, az);
        set(this.worldB, bx, by, bz);
        this.lineFromView(this.viewA, this.viewB, style);
    }

    /**
     * Recorta no near plane e desenha.
     *
     * O clipping tem que acontecer aqui, em espaço de view, antes da divisão
     * perspectiva: um ponto atrás da câmera projeta para coordenadas sem
     * sentido, e a linha atravessa a tela inteira em vez de sumir.
     */
    private lineFromView(a: Vec3, b: Vec3, style: SurfaceStyle): void {
        let wa = -a.z;
        let wb = -b.z;

        if (wa <= this.near && wb <= this.near) return;

        let ax = a.x, ay = a.y;
        let bx = b.x, by = b.y;

        // A posição de mundo acompanha o mesmo `t` do corte: a transformação de
        // view é afim, então o parâmetro do segmento é o mesmo nos dois espaços.
        if (wa <= this.near) {
            const t = (this.near - wa) / (wb - wa);
            lerp(this.clipped, a, b, t);
            ax = this.clipped.x;
            ay = this.clipped.y;
            wa = this.near;
            lerp(this.worldA, this.worldA, this.worldB, t);
        } else if (wb <= this.near) {
            const t = (this.near - wb) / (wa - wb);
            lerp(this.clipped, b, a, t);
            bx = this.clipped.x;
            by = this.clipped.y;
            wb = this.near;
            lerp(this.worldB, this.worldB, this.worldA, t);
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
     *
     * A posição de mundo segue a mesma regra, e pelo mesmo motivo: o que é
     * linear em tela é `mundo / w`, não `mundo`. Interpolado direto, a sombra
     * projetada numa linha da grade escorregaria ao longo dela quando a câmera
     * girasse — o mesmo defeito da névoa, agora visível como a sombra saindo
     * de debaixo do objeto.
     */
    private drawScreenLine(
        col0: number, row0: number, invW0: number,
        col1: number, row1: number, invW1: number,
        style: SurfaceStyle,
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

        // Mundo dividido por w nas duas pontas, já estreitado pelo clip de tela.
        const wa0 = this.worldA.x * invW0, wa1 = this.worldB.x * invW1;
        const wb0 = this.worldA.y * invW0, wb1 = this.worldB.y * invW1;
        const wc0 = this.worldA.z * invW0, wc1 = this.worldB.z * invW1;

        const startWx = wa0 + (wa1 - wa0) * this.t0;
        const spanWx = (wa1 - wa0) * (this.t1 - this.t0);
        const startWy = wb0 + (wb1 - wb0) * this.t0;
        const spanWy = (wb1 - wb0) * (this.t1 - this.t0);
        const startWz = wc0 + (wc1 - wc0) * this.t0;
        const spanWz = (wc1 - wc0) * (this.t1 - this.t0);

        const slope = classifySlope(spanCol, spanRow);
        const steps = Math.max(1, Math.ceil(Math.max(Math.abs(spanCol), Math.abs(spanRow))));

        const sample = this.sample;
        sample.slope = slope;

        for (let step = 0; step <= steps; step += 1) {
            const s = step / steps;
            const invW = startInvW + spanInvW * s;
            if (invW <= 0) continue;

            const depth = 1 / invW;
            sample.depth = depth;
            sample.x = (startWx + spanWx * s) * depth;
            sample.y = (startWy + spanWy * s) * depth;
            sample.z = (startWz + spanWz * s) * depth;

            if (!style(sample, this.fragment)) continue;

            this.framebuffer.plot(
                Math.round(startCol + spanCol * s),
                Math.round(startRow + spanRow * s),
                this.fragment.glyph,
                this.fragment.color,
                depth,
                this.fragment.alpha,
                this.fragment.emissive,
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
     * A quantas células, na tela, dois pontos de mundo caem um do outro.
     *
     * É o que permite a uma superfície decidir sozinha o quanto se subdividir:
     * a resposta certa não é "que distância eu estou", é "a que distância na
     * tela as minhas linhas estão caindo". A diferença aparece quando a placa
     * está inclinada — de esguelha ela precisa de menos linhas, não de mais — e
     * quando o campo de visão muda, que um critério de distância ignoraria.
     *
     * A métrica é Chebyshev, e não euclidiana, porque a pergunta é sobre
     * células e não sobre pixels: duas linhas sem gap são duas linhas que não
     * pulam nenhuma coluna nem nenhuma fileira.
     *
     * `Infinity` quando um dos extremos está atrás do near plane — está colado
     * na câmera, e densidade máxima é a resposta certa.
     */
    screenSpan(
        ax: number, ay: number, az: number,
        bx: number, by: number, bz: number,
    ): number {
        if (!this.project(ax, ay, az, this.spanA)) return Infinity;
        if (!this.project(bx, by, bz, this.spanB)) return Infinity;

        return Math.max(
            Math.abs(this.spanB.col - this.spanA.col),
            Math.abs(this.spanB.row - this.spanA.row),
        );
    }

    /**
     * Raio em fileiras de tela de uma esfera de raio conhecido, a uma distância.
     *
     * A contraparte de `angularRadiusRows` para o que está perto: o sol não tem
     * tamanho em unidades de mundo, um orbe tem. A aproximação de tratar a
     * esfera como um disco perpendicular ao olhar erra pouco enquanto ela for
     * pequena na tela, que é o caso de tudo que não está colado na câmera.
     */
    radiusRowsAt(worldRadius: number, depth: number): number {
        return (worldRadius * this.focalY / depth) * 0.5 * this.rowCount;
    }

    /**
     * Percorre as células de um disco em espaço de tela.
     *
     * Em espaço de tela e não em mundo porque um corpo redondo sempre encara a
     * câmera: é o mesmo argumento que faz o sol ser preenchido assim. O laço já
     * sai recortado na janela — um disco fora de vista não deve custar o disco
     * inteiro — e `lastRow` é o recorte extra que o sol usa para assentar no
     * horizonte.
     *
     * `nx` e `ny` chegam normalizados de -1 a 1, com a proporção da célula já
     * compensada: é isso que faz o círculo sair redondo e não ovalado.
     */
    disc(
        center: Projected,
        radiusRows: number,
        lastRow: number,
        visit: (col: number, row: number, nx: number, ny: number) => void,
    ): void {
        const radiusCols = radiusRows * CELL_ASPECT;
        const centerCol = Math.round(center.col);
        const centerRow = Math.round(center.row);

        const minRow = Math.max(-Math.ceil(radiusRows), -centerRow);
        const maxRow = Math.min(Math.ceil(radiusRows), lastRow - centerRow);
        const minCol = Math.max(-Math.ceil(radiusCols), -centerCol);
        const maxCol = Math.min(Math.ceil(radiusCols), this.colCount - 1 - centerCol);

        for (let deltaRow = minRow; deltaRow <= maxRow; deltaRow += 1) {
            const ny = deltaRow / radiusRows;
            for (let deltaCol = minCol; deltaCol <= maxCol; deltaCol += 1) {
                const nx = deltaCol / radiusCols;
                if (nx * nx + ny * ny > 1.0201) continue;
                visit(centerCol + deltaCol, centerRow + deltaRow, nx, ny);
            }
        }
    }

    /**
     * A direção de mundo que atravessa uma célula da tela.
     *
     * O caminho inverso da projeção, e é o que transforma um clique num raio:
     * seleção, arrasto no plano do chão e qualquer futura mira usam este mesmo
     * raio contra os mesmos corpos que fazem sombra e reflexo. Derivar do mesmo
     * `focal` que projetou é o que garante que o objeto atingido seja o objeto
     * sob o cursor.
     *
     * A direção não sai normalizada de graça, então normaliza aqui: o traçado
     * mede distância em unidades do parâmetro e conta com raio unitário.
     */
    rayThrough(col: number, row: number, out: Vec3): Vec3 {
        const ndcX = (col / this.colCount) * 2 - 1;
        const ndcY = 1 - (row / this.rowCount) * 2;

        mat4.transformDirectionTransposed(
            out,
            this.camera.view,
            ndcX / this.focalX,
            ndcY / this.focalY,
            -1,
        );

        const length = Math.hypot(out.x, out.y, out.z);
        if (length > 0) {
            out.x /= length;
            out.y /= length;
            out.z /= length;
        }
        return out;
    }

    /** Última fileira da janela. O recorte padrão de `disc`. */
    get lastRow(): number {
        return this.rowCount - 1;
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
    plotCell(
        col: number,
        row: number,
        glyph: number,
        color: Rgb,
        depth: number,
        alpha = 1,
        emissive = 0,
    ): void {
        this.framebuffer.plot(col, row, glyph, color, depth, alpha, emissive);
    }

    /** Escreve uma célula já projetada. Estrelas e o sol usam este caminho. */
    plot(projected: Projected, glyph: number, color: Rgb, alpha = 1, emissive = 0): void {
        this.framebuffer.plot(
            Math.round(projected.col),
            Math.round(projected.row),
            glyph,
            color,
            projected.depth,
            alpha,
            emissive,
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
