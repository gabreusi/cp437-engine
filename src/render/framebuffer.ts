import { mergeLineGlyphs } from './palette';

/**
 * Grade de células no formato que a GPU consome direto.
 *
 * `data` já está no layout RGBA8 da data texture, então o quadro vai para a GPU
 * sem passo de empacotamento: um `texSubImage2D` do array inteiro.
 *
 *   R = índice do glifo no atlas
 *   G = índice da cor na paleta
 *   B = alpha da célula (é por onde a névoa entra)
 *   A = 255, reservado
 *
 * O `!` nos acessos aos arrays é seguro: todo caminho até eles passa pela
 * checagem de limites de `plot`.
 */
/**
 * Folga relativa do teste de profundidade.
 *
 * As duas famílias de linhas do chão são coplanares, e a fileira na tela é
 * função apenas da profundidade — então numa mesma fileira as duas têm
 * profundidade matematicamente igual. Sem folga, o ruído de ponto flutuante
 * rejeita cerca de metade das células e a grade sai picotada. A tolerância é
 * relativa para acompanhar a perda de precisão com a distância, e fica muito
 * abaixo do espaçamento entre linhas vizinhas, que é o que precisa ser
 * distinguido de verdade.
 */
const DEPTH_TOLERANCE = 1e-3;

export class Framebuffer {
    readonly data: Uint8Array;
    private readonly depth: Float32Array;

    constructor(
        readonly colCount: number,
        readonly rowCount: number,
    ) {
        const cells = colCount * rowCount;
        this.data = new Uint8Array(cells * 4);
        this.depth = new Float32Array(cells);
        this.clear();
    }

    /** Zerar já significa "célula vazia": o glifo 0 é o espaço em branco. */
    clear(): void {
        this.data.fill(0);
        this.depth.fill(Infinity);
    }

    /**
     * Escreve uma célula se ela estiver mais perto do que o que já está lá.
     *
     * O teste rejeita só o que está mais longe além da tolerância; com o buffer
     * inicializado em infinito, isso também deixa o céu — que tem profundidade
     * infinita — escrever numa célula ainda vazia.
     */
    plot(
        col: number,
        row: number,
        glyph: number,
        color: number,
        depth: number,
        alpha = 255,
    ): void {
        if (col < 0 || col >= this.colCount || row < 0 || row >= this.rowCount) return;

        const index = row * this.colCount + col;
        const current = this.depth[index]!;
        if (depth > current + Math.abs(current) * DEPTH_TOLERANCE) return;

        this.write(index, glyph, color, depth, alpha);
    }

    /**
     * Como `plot`, mas combina glifos de linha que dividem a mesma célula à
     * mesma distância — é o que transforma um cruzamento em `┼` em vez de uma
     * linha apagando a outra.
     */
    plotLine(
        col: number,
        row: number,
        glyph: number,
        color: number,
        depth: number,
        alpha = 255,
    ): void {
        if (col < 0 || col >= this.colCount || row < 0 || row >= this.rowCount) return;

        const index = row * this.colCount + col;
        const current = this.depth[index]!;
        const slack = Math.abs(current) * DEPTH_TOLERANCE;
        if (depth > current + slack) return;

        // `current - slack` é NaN numa célula vazia (infinito menos infinito), o
        // que reprova a comparação e cai no caminho de escrita simples. É o
        // comportamento certo: não há nada com que combinar.
        const merged =
            depth >= current - slack ? mergeLineGlyphs(this.data[index * 4]!, glyph) : glyph;

        this.write(index, merged, color, depth, alpha);
    }

    private write(index: number, glyph: number, color: number, depth: number, alpha: number): void {
        this.depth[index] = depth;
        const offset = index * 4;
        this.data[offset] = glyph;
        this.data[offset + 1] = color;
        this.data[offset + 2] = alpha;
        this.data[offset + 3] = 255;
    }
}
