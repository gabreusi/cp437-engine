import * as mat4 from "../../math/mat4";
import { type Vec3, vec3 } from "../../math/vec3";

/**
 * A caixa orientada que monólito e painel compartilham.
 *
 * Uma classe e não uma função porque a mesma matriz serve para três coisas que
 * precisam concordar: posicionar os vértices que são desenhados, orientar o
 * corpo que o raio testa, e girar as normais que a luz usa. Derivar as três da
 * mesma `toLocal` é o que impede a sombra de sair de baixo do objeto quando ele
 * gira.
 */

const INV_SQRT2 = Math.SQRT1_2;

interface BoxEdge {
  a: number;
  b: number;
  /**
   * Normal da aresta em espaço local.
   *
   * Uma aresta é a costura de duas faces e não tem normal própria; a bissetriz
   * das duas é o que faz o wireframe reagir à luz como o sólido reagiria. Sem
   * isso as doze arestas receberiam a mesma luz e a caixa sairia chapada.
   */
  nx: number;
  ny: number;
  nz: number;
}

/**
 * As doze arestas, geradas em vez de escritas.
 *
 * Um vértice é um índice de três bits, um por eixo; uma aresta liga dois
 * vértices que diferem em um bit só. Escrever a tabela à mão seriam doze
 * chances de trocar um sinal, e um sinal trocado é uma face iluminada pelo lado
 * errado — o tipo de erro que se vê e não se acha.
 */
const EDGES: readonly BoxEdge[] = (() => {
  const edges: BoxEdge[] = [];
  for (let axis = 0; axis < 3; axis += 1) {
    const bit = 1 << axis;
    for (let corner = 0; corner < 8; corner += 1) {
      if ((corner & bit) !== 0) continue;

      const sx = (corner & 1) !== 0 ? 1 : -1;
      const sy = (corner & 2) !== 0 ? 1 : -1;
      const sz = (corner & 4) !== 0 ? 1 : -1;

      edges.push({
        a: corner,
        b: corner | bit,
        nx: axis === 0 ? 0 : sx * INV_SQRT2,
        ny: axis === 1 ? 0 : sy * INV_SQRT2,
        nz: axis === 2 ? 0 : sz * INV_SQRT2,
      });
    }
  }
  return edges;
})();

export class BoxShape {
  /** Mundo para o espaço local. É a mesma que o occluder guarda. */
  readonly toLocal = mat4.identity(mat4.create());

  /** Os oito vértices em mundo, achatados. */
  private readonly corners = new Float64Array(24);
  private readonly scratch: Vec3 = vec3();
  private readonly center: Vec3 = vec3();

  /**
   * Componentes soltos e não a entidade inteira: o realce de seleção precisa
   * da mesma caixa com uma folga em volta, e passar a entidade obrigaria a
   * fabricar uma cópia dela por quadro só para inflar as extensões.
   */
  update(
    center: Vec3,
    yaw: number,
    pitch: number,
    halfX: number,
    halfY: number,
    halfZ: number,
  ): void {
    mat4.setView(this.toLocal, center, yaw, pitch);
    this.center.x = center.x;
    this.center.y = center.y;
    this.center.z = center.z;

    for (let corner = 0; corner < 8; corner += 1) {
      const sx = (corner & 1) !== 0 ? halfX : -halfX;
      const sy = (corner & 2) !== 0 ? halfY : -halfY;
      const sz = (corner & 4) !== 0 ? halfZ : -halfZ;

      mat4.transformDirectionTransposed(this.scratch, this.toLocal, sx, sy, sz);

      const offset = corner * 3;
      this.corners[offset] = center.x + this.scratch.x;
      this.corners[offset + 1] = center.y + this.scratch.y;
      this.corners[offset + 2] = center.z + this.scratch.z;
    }
  }

  corner(index: number, out: Vec3): Vec3 {
    const offset = index * 3;
    out.x = this.corners[offset]!;
    out.y = this.corners[offset + 1]!;
    out.z = this.corners[offset + 2]!;
    return out;
  }

  /** Direção local levada para o mundo. Serve normais e eixos de face. */
  toWorldDirection(x: number, y: number, z: number, out: Vec3): Vec3 {
    return mat4.transformDirectionTransposed(out, this.toLocal, x, y, z);
  }

  /** Ponto local levado para o mundo. É como a face do painel é hachurada. */
  toWorldPoint(x: number, y: number, z: number, out: Vec3): Vec3 {
    mat4.transformDirectionTransposed(out, this.toLocal, x, y, z);
    out.x += this.center.x;
    out.y += this.center.y;
    out.z += this.center.z;
    return out;
  }

  get edges(): readonly BoxEdge[] {
    return EDGES;
  }
}
