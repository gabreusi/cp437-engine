import type { Rgb } from "../math/color";

/**
 * Grade de células em dois planos, no formato que a GPU consome direto.
 *
 * Nenhum dos dois precisa de passo de empacotamento: cada um vai para a sua
 * data texture com um `texSubImage2D` do array inteiro.
 *
 *   cells    R = índice do glifo no atlas
 *            G = alpha da célula (é por onde a névoa entra)
 *            B = brilho emissivo, o que passa de 1.0 e estoura no bloom
 *            A = 255, reservado
 *
 *   colors   R, G, B = cor da célula
 *            A = não usado
 *
 * São dois planos e não um porque a célula precisa de cinco bytes: quatro para
 * glifo, alpha e emissivo, mais três de cor. A versão anterior cabia em um só
 * guardando um índice de paleta no lugar da cor, e foi exatamente isso que
 * impediu luz colorida. ~172 KB por quadro a 180x120, contra 86 KB antes.
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

/**
 * Teto do canal emissivo.
 *
 * O byte guarda 0..1 do intervalo; o shader multiplica de volta. Quatro é o
 * bastante para o núcleo do sol dominar o bloom sem que a quantização apareça
 * como degrau nas bordas.
 */
export const EMISSIVE_RANGE = 4;

const toByte = (value: number): number =>
  value <= 0 ? 0 : value >= 1 ? 255 : (value * 255 + 0.5) | 0;

export class Framebuffer {
  readonly cells: Uint8Array;
  readonly colors: Uint8Array;
  private readonly depth: Float32Array;

  constructor(
    readonly colCount: number,
    readonly rowCount: number,
  ) {
    const cells = colCount * rowCount;
    this.cells = new Uint8Array(cells * 4);
    this.colors = new Uint8Array(cells * 4);
    this.depth = new Float32Array(cells);
    this.clear();
  }

  /** Zerar já significa "célula vazia": alpha zero é descartado no shader. */
  clear(): void {
    this.cells.fill(0);
    this.colors.fill(0);
    this.depth.fill(Infinity);
  }

  /**
   * Nada foi escrito nesta célula neste quadro.
   *
   * Lê o alpha, e não a profundidade: o buffer nasce com profundidade
   * infinita, mas o céu também escreve com profundidade infinita — só o alpha
   * separa "vazio" de "longe". É o que deixa o preenchimento do chão trabalhar
   * apenas nos vãos entre as linhas, em vez de apagá-las.
   */
  isEmpty(col: number, row: number): boolean {
    if (col < 0 || col >= this.colCount || row < 0 || row >= this.rowCount)
      return false;
    return this.cells[(row * this.colCount + col) * 4 + 1] === 0;
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
    color: Rgb,
    depth: number,
    alpha = 1,
    emissive = 0,
  ): void {
    if (col < 0 || col >= this.colCount || row < 0 || row >= this.rowCount)
      return;

    const index = row * this.colCount + col;
    const current = this.depth[index]!;
    if (depth > current + Math.abs(current) * DEPTH_TOLERANCE) return;

    this.depth[index] = depth;

    const offset = index * 4;
    this.cells[offset] = glyph;
    this.cells[offset + 1] = toByte(alpha);
    this.cells[offset + 2] = toByte(emissive / EMISSIVE_RANGE);
    this.cells[offset + 3] = 255;

    this.colors[offset] = toByte(color.r);
    this.colors[offset + 1] = toByte(color.g);
    this.colors[offset + 2] = toByte(color.b);
    this.colors[offset + 3] = 255;
  }
}
