import type { Rgb } from "../math/color";

/**
 * Grade de células, dividida entre o que a CPU já resolveu e o que a GPU
 * ainda vai sombrear.
 *
 * Toda célula passa pelo mesmo teste de profundidade de sempre — a CPU
 * continua sendo a única autoridade sobre "quem vence a célula", porque isso
 * depende da ordem de desenho e da geometria, não de luz. O que mudou é o
 * que ela escreve depois de decidir a vencedora:
 *
 *   resolvida   glifo e cor já são finais (disco de orbe/sol/estrela, HUD,
 *               menu, cursor, modo sem luz) — a célula não precisa de
 *               nenhuma conta de luz, só de ser copiada.
 *   adiada      a superfície precisa do kernel de luz (`ShadingPass`, GLSL)
 *               para saber a cor — o que vai para `cells`/`colors` aqui é
 *               placeholder; o que importa é o G-buffer (posição, normal,
 *               material, forma) que só o shader consome.
 *
 * `cells.a` é o bit que separa as duas: 255 para resolvida, 0 para adiada —
 * reaproveita um byte que antes era só "255, reservado".
 *
 *   cells    R = índice do glifo no atlas (resolvida) / 0 (adiada)
 *            G = alpha da célula — sempre CPU, não depende de luz
 *            B = brilho emissivo (resolvida) / 0 (adiada)
 *            A = 255 resolvida, 0 adiada
 *
 *   colors   R, G, B = cor da célula (resolvida) / 0 (adiada)
 *            A = opaca — sempre CPU, não depende de luz (ver `plot`)
 *
 *   fuse     Incidência acumulada (feixe de holofote, ver `Fragment.fuse`),
 *            somada por cima do resultado final — resolvido ou sombreado —
 *            no último passo do `ShadingPass`. Separada das duas de cima
 *            porque, ao contrário delas, nunca é "a" cor da célula: é sempre
 *            um extra por cima de outra coisa.
 *            R,G,B = cor acumulada; A = emissivo acumulado (/EMISSIVE_RANGE)
 *
 *            Pertence à superfície que a recebeu, não à célula: quando uma
 *            profundidade genuinamente diferente vence a célula depois (uma
 *            parede mais perto, o menu com `OVERLAY_DEPTH`), o acumulado é da
 *            superfície antiga e não pode vazar para a nova — `plot`/
 *            `plotDeferred` zeram `fuse` sempre que a vitória não é
 *            coincidente com a profundidade anterior. Sem isso um feixe de
 *            holofote que passasse por uma célula antes do menu ser desenhado
 *            por cima continuaria acendendo o fundo do menu.
 *
 * O G-buffer (posição, normal, material, forma) mora em arrays `Float32Array`
 * separados, um por campo, no leiaute que `render/gl/passes/shading.ts` sobe
 * como textura `RGBA32F` — ver `GBUFFER_FIELDS` abaixo. Só tem conteúdo onde
 * `cells.a === 0`.
 */
const DEPTH_TOLERANCE = 1e-3;

export const EMISSIVE_RANGE = 4;

const toByte = (value: number): number =>
  value <= 0 ? 0 : value >= 1 ? 255 : (value * 255 + 0.5) | 0;

/**
 * O que uma superfície adiada precisa entregar ao G-buffer — os mesmos campos
 * que `shadeSurface`/`glyphForLineEdge`/`glyphForPatch` consumiam na hora,
 * agora crus, para o `ShadingPass` consumir em paralelo.
 *
 * Reaproveitado: quem escreve (`SurfacePen`, `Ground`) mantém uma instância
 * própria e sobrescreve os campos por fragmento, nunca aloca uma nova.
 */
export interface DeferredSurface {
  worldX: number;
  worldY: number;
  worldZ: number;
  normalX: number;
  normalY: number;
  normalZ: number;
  /** Dono da superfície, para não se autossombrear — ver `NO_OWNER`. */
  ownerId: number;
  albedoR: number;
  albedoG: number;
  albedoB: number;
  emissiveR: number;
  emissiveG: number;
  emissiveB: number;
  emissiveStrength: number;
  reflectivity: number;
  gloss: number;
  mirror: boolean;
  /** 0 smooth, 1 rough, 2 irregular — ver `TEXTURE` em `ramp.ts`. */
  textureId: number;
  /** Preenchimento de área, não aresta — ver `Fragment.area`/`SurfacePen.area`. */
  area: boolean;
  /**
   * Um bit com dois significados, por contexto — economiza um canal do
   * G-buffer que de outro jeito seria quase sempre zero:
   *
   *   aresta (`area=false`)  perto da câmera: `_` disputa com `-`.
   *   área (`area=true`)     piso "cru" da LUT de preenchimento — pode
   *                          devolver `GLYPH.SPACE` e a célula some, o que
   *                          só o chão (`Ground.fillLitFloor`) quer.
   *                          `false` é o piso "floored" que toda hachura de
   *                          face usa (`MIN_FILL_COVERAGE`, nunca vazio).
   */
  variant: boolean;
  /** Deslocamento subcélula e direção do segmento — só usados por aresta. */
  offsetCol: number;
  offsetRow: number;
  dirCol: number;
  dirRow: number;
  /**
   * Soma luz de todo lado. `SurfacePen` sempre liga (`ShadeOptions.ambient`
   * do quadro); só o chão desliga, para o vazio entre linhas continuar vazio
   * — ver o comentário de `ShadeOptions.ambient` em `light/shade.ts`.
   */
  ambient: boolean;
  /**
   * Dispara o raio de espelho (`skyRadiance`/`reflectGround`/occluders),
   * além do especular. O chão desliga sempre — a lavagem do céu na
   * superfície horizontal inteira não paga o custo — mesmo com o ajuste
   * global ligado; `SurfacePen` segue `ShadeOptions.reflections` do quadro.
   */
  reflections: boolean;
}

export const createDeferredSurface = (): DeferredSurface => ({
  worldX: 0,
  worldY: 0,
  worldZ: 0,
  normalX: 0,
  normalY: 1,
  normalZ: 0,
  ownerId: -1,
  albedoR: 1,
  albedoG: 1,
  albedoB: 1,
  emissiveR: 0,
  emissiveG: 0,
  emissiveB: 0,
  emissiveStrength: 0,
  reflectivity: 0,
  gloss: 24,
  mirror: false,
  textureId: 0,
  area: false,
  variant: false,
  offsetCol: 0,
  offsetRow: 0,
  dirCol: 1,
  dirRow: 0,
  ambient: true,
  reflections: true,
});

/**
 * bit0 area, bit1 variant, bits2-3 textureId (0..2), bit4 mirror, bit5
 * ambient, bit6 reflections — cabe em 7 bits, longe da precisão de um
 * `float` de textura.
 */
const packFlags = (surface: DeferredSurface): number =>
  (surface.area ? 1 : 0) |
  (surface.variant ? 2 : 0) |
  ((surface.textureId & 3) << 2) |
  (surface.mirror ? 16 : 0) |
  (surface.ambient ? 32 : 0) |
  (surface.reflections ? 64 : 0);

export class Framebuffer {
  readonly cells: Uint8Array<ArrayBuffer>;
  readonly colors: Uint8Array<ArrayBuffer>;
  readonly fuse: Uint8Array<ArrayBuffer>;
  private readonly depth: Float32Array;

  // G-buffer: um Float32Array por textura RGBA32F que `ShadingPass` sobe.
  // Só têm valor definido onde `cells.a === 0` (célula adiada).
  readonly gPos: Float32Array<ArrayBuffer>;
  readonly gNormal: Float32Array<ArrayBuffer>;
  readonly gAlbedo: Float32Array<ArrayBuffer>;
  readonly gEmissive: Float32Array<ArrayBuffer>;
  readonly gShape: Float32Array<ArrayBuffer>;
  readonly gGloss: Float32Array<ArrayBuffer>;

  constructor(
    readonly colCount: number,
    readonly rowCount: number,
  ) {
    const cells = colCount * rowCount;
    this.cells = new Uint8Array(cells * 4);
    this.colors = new Uint8Array(cells * 4);
    this.fuse = new Uint8Array(cells * 4);
    this.depth = new Float32Array(cells);
    this.gPos = new Float32Array(cells * 4);
    this.gNormal = new Float32Array(cells * 4);
    this.gAlbedo = new Float32Array(cells * 4);
    this.gEmissive = new Float32Array(cells * 4);
    this.gShape = new Float32Array(cells * 4);
    this.gGloss = new Float32Array(cells * 4);
    this.clear();
  }

  clear(): void {
    this.cells.fill(0);
    this.colors.fill(0);
    this.fuse.fill(0);
    this.depth.fill(Infinity);
    // O G-buffer não precisa zerar: toda célula adiada é escrita antes de o
    // shader ler, e toda célula resolvida/vazia nunca é amostrada por ele.
  }

  isEmpty(col: number, row: number): boolean {
    if (col < 0 || col >= this.colCount || row < 0 || row >= this.rowCount)
      return false;
    return this.cells[(row * this.colCount + col) * 4 + 1] === 0;
  }

  /** Profundidade atual da célula, para quem precisa decidir fora de `plot` (nenhum caso hoje, mas evita duplicar o array). */
  private wins(index: number, depth: number): boolean {
    const current = this.depth[index]!;
    // `Math.abs(current) * DEPTH_TOLERANCE` vira `NaN` quando `current` é
    // infinito (`Infinity` da célula nunca tocada, `-Infinity` de
    // `OVERLAY_DEPTH`), e qualquer comparação com `NaN` é falsa — o que
    // destravaria a célula de menu/HUD para a próxima geometria que passasse
    // por ela, quebrando exatamente a garantia que `OVERLAY_DEPTH` promete.
    if (!Number.isFinite(current)) return depth <= current;
    return !(depth > current + Math.abs(current) * DEPTH_TOLERANCE);
  }

  /** Ver o comentário de `fuse` no topo do arquivo: pertence à superfície antiga, não à célula. */
  private clearFuse(offset: number): void {
    this.fuse[offset] = 0;
    this.fuse[offset + 1] = 0;
    this.fuse[offset + 2] = 0;
    this.fuse[offset + 3] = 0;
  }

  /**
   * Escreve uma célula resolvida — glifo e cor já finais. O caminho de
   * sempre: disco de orbe/sol/estrela, HUD, menu, cursor, e qualquer
   * primitiva desenhada com `settings.lightingEnabled === false`.
   */
  plot(
    col: number,
    row: number,
    glyph: number,
    color: Rgb,
    depth: number,
    alpha = 1,
    emissive = 0,
    opaque = false,
    fuse = false,
  ): void {
    if (col < 0 || col >= this.colCount || row < 0 || row >= this.rowCount)
      return;

    const index = row * this.colCount + col;
    if (!this.wins(index, depth)) return;

    const offset = index * 4;
    const hadContent = this.cells[offset + 1] !== 0;

    if (fuse && hadContent) {
      this.depth[index] = depth;
      const inv = 1 / 255;
      this.fuse[offset] = toByte(this.fuse[offset]! * inv + color.r * alpha);
      this.fuse[offset + 1] = toByte(
        this.fuse[offset + 1]! * inv + color.g * alpha,
      );
      this.fuse[offset + 2] = toByte(
        this.fuse[offset + 2]! * inv + color.b * alpha,
      );
      this.fuse[offset + 3] = toByte(
        this.fuse[offset + 3]! * inv + emissive / EMISSIVE_RANGE,
      );
      return;
    }

    const current = this.depth[index]!;
    const coincident =
      hadContent &&
      Math.abs(depth - current) <= Math.abs(current) * DEPTH_TOLERANCE;
    const staysOpaque = coincident && this.colors[offset + 3] !== 0;
    if (!coincident) this.clearFuse(offset);

    this.depth[index] = depth;

    this.cells[offset] = glyph;
    this.cells[offset + 1] = toByte(alpha);
    this.cells[offset + 2] = toByte(emissive / EMISSIVE_RANGE);
    this.cells[offset + 3] = 255; // resolvida

    this.colors[offset] = toByte(color.r);
    this.colors[offset + 1] = toByte(color.g);
    this.colors[offset + 2] = toByte(color.b);
    this.colors[offset + 3] = opaque || staysOpaque ? 255 : 0;
  }

  /**
   * Escreve uma célula adiada — a cor depende de luz, então só o G-buffer é
   * preenchido; `ShadingPass` decide glifo e cor no quadro seguinte da
   * pipeline (mesmo quadro de tela, passo seguinte da GPU).
   *
   * O teste de profundidade e o "mesma superfície gruda opaco" são
   * exatamente os de `plot`: quem vence a célula é decisão de geometria, não
   * de luz, e as duas famílias de escrita disputam o mesmo `depth[]`.
   */
  plotDeferred(
    col: number,
    row: number,
    depth: number,
    alpha: number,
    opaque: boolean,
    surface: DeferredSurface,
  ): void {
    if (col < 0 || col >= this.colCount || row < 0 || row >= this.rowCount)
      return;

    const index = row * this.colCount + col;
    if (!this.wins(index, depth)) return;

    const offset = index * 4;
    const hadContent = this.cells[offset + 1] !== 0;
    const current = this.depth[index]!;
    const coincident =
      hadContent &&
      Math.abs(depth - current) <= Math.abs(current) * DEPTH_TOLERANCE;
    const staysOpaque = coincident && this.colors[offset + 3] !== 0;
    if (!coincident) this.clearFuse(offset);

    this.depth[index] = depth;

    this.cells[offset] = 0;
    this.cells[offset + 1] = toByte(alpha);
    this.cells[offset + 2] = 0;
    this.cells[offset + 3] = 0; // adiada

    this.colors[offset] = 0;
    this.colors[offset + 1] = 0;
    this.colors[offset + 2] = 0;
    this.colors[offset + 3] = opaque || staysOpaque ? 255 : 0;

    this.gPos[offset] = surface.worldX;
    this.gPos[offset + 1] = surface.worldY;
    this.gPos[offset + 2] = surface.worldZ;
    this.gPos[offset + 3] = surface.ownerId;

    this.gNormal[offset] = surface.normalX;
    this.gNormal[offset + 1] = surface.normalY;
    this.gNormal[offset + 2] = surface.normalZ;
    this.gNormal[offset + 3] = packFlags(surface);

    this.gAlbedo[offset] = surface.albedoR;
    this.gAlbedo[offset + 1] = surface.albedoG;
    this.gAlbedo[offset + 2] = surface.albedoB;
    this.gAlbedo[offset + 3] = surface.reflectivity;

    this.gEmissive[offset] = surface.emissiveR;
    this.gEmissive[offset + 1] = surface.emissiveG;
    this.gEmissive[offset + 2] = surface.emissiveB;
    this.gEmissive[offset + 3] = surface.emissiveStrength;

    this.gShape[offset] = surface.offsetCol;
    this.gShape[offset + 1] = surface.offsetRow;
    this.gShape[offset + 2] = surface.dirCol;
    this.gShape[offset + 3] = surface.dirRow;

    this.gGloss[offset] = surface.gloss;
  }
}
