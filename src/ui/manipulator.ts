import type { LightWorld } from "../light/world";
import { type Vec3, set, sub, vec3 } from "../math/vec3";
import type { Camera } from "../render/camera";
import type { Framebuffer } from "../render/framebuffer";
import { GLYPH } from "../render/palette";
import {
  type Projected,
  type Rasterizer,
  createProjected,
} from "../render/rasterizer";
import { OVERLAY_DEPTH } from "../render/text";
import { CELL_ASPECT } from "../render/viewport";
import { BoxShape } from "../scene/entities/box";
import type { EntityState } from "../scene/entities/entity";
import { ENTITY_KINDS, type World } from "../scene/world";
import { MENU_COLORS } from "./menu/draw";

/**
 * Mexer nos objetos com o ponteiro: escolher, arrastar, girar e esticar.
 *
 * Vive fora do menu porque tem dois donos. O menu opera a cena com o ponteiro
 * do sistema, solto, quando a página de objetos está aberta; o editor opera com
 * o cursor próprio da engine, com o mouse ainda capturado. É o mesmo gesto nos
 * dois, e duas implementações divergiriam no primeiro ajuste — uma passaria a
 * esticar pela face e a outra continuaria só arrastando.
 *
 * O que muda entre os dois é só de onde vêm a célula e o deslocamento; por isso
 * tudo aqui é escrito em células de tela, e quem chama converte.
 *
 * `col`/`row` chegam fracionários, não a célula arredondada: é o que faz a
 * mira e o arrasto seguirem o mouse em vez de saltar de célula em célula.
 */

/** Passo de giro por clique de roda, em radianos. */
const WHEEL_YAW = Math.PI / 24;

/** Unidades de mundo por fileira arrastada, com `Shift`. */
const VERTICAL_DRAG = 1;

/** Menor meia-extensão que uma face pode alcançar. Igual ao piso do slider. */
const MIN_HALF = 0.2;

/** Folga entre a face e a sua seta, em unidades de mundo. */
const HANDLE_GAP = 0.95;

/**
 * Distância de mundo usada para medir o passo da seta em tela.
 *
 * Uma unidade projetada de dentro do próprio quadro: é assim que o arrasto sabe
 * quantas células uma unidade de mundo vale *naquele eixo, naquela distância,
 * naquele campo de visão*. Uma sensibilidade fixa erraria por um fator de dez
 * entre um objeto colado na câmera e um no fim da cena.
 */
const PROBE = 1;

/** Quanto o cursor pode estar longe da seta e ainda pegá-la. */
const GRAB_COLS = 2;
const GRAB_ROWS = 1;

/**
 * Cosseno máximo entre a face e o olhar para a seta dela existir.
 *
 * Uma face que encara a câmera não tem para onde ser puxada: ela projeta para
 * quase nenhum deslocamento de tela, então um pixel de arrasto viraria metros
 * de mundo. Pior, a seta dela cai bem no meio do objeto e rouba o clique que
 * era para movê-lo. Some das duas pontas — de frente e de costas —, e quem quer
 * esticar aquele eixo faz o que se faz em qualquer editor: anda para o lado.
 */
const MAX_FACING = 0.8;

/** A seta de uma face: onde ela caiu na tela e o que ela estica. */
interface Handle {
  col: number;
  row: number;
  /** A seta que aponta para fora da face, escolhida em espaço de tela. */
  glyph: number;
  /** 0, 1 ou 2 — qual meia-extensão ela mexe. */
  axis: number;
  /** Direção da face em mundo, unitária. Já carrega para que lado ela olha. */
  dir: Vec3;
  /** Células que uma unidade de mundo naquela direção vale na tela. */
  stepCol: number;
  stepRow: number;
}

const MODE = {
  NONE: "none",
  MOVE: "move",
  RESIZE: "resize",
} as const;

type Mode = (typeof MODE)[keyof typeof MODE];

export class Manipulator {
  private readonly shape = new BoxShape();
  private readonly handles: Handle[] = Array.from({ length: 6 }, () => ({
    col: 0,
    row: 0,
    glyph: GLYPH.ARROW_UP,
    axis: 0,
    dir: vec3(),
    stepCol: 0,
    stepRow: 0,
  }));
  private handleCount = 0;

  private mode: Mode = MODE.NONE;
  private grabbed = -1;

  private readonly ray: Vec3 = vec3();

  /**
   * Onde o objeto está em relação ao ponto que o raio furou.
   *
   * Guardado no clique e somado de volta a cada quadro do arrasto. Sem ele o
   * objeto salta no instante da seleção: o arrasto põe o *centro* dele sob o
   * cursor, e quase nunca se clica exatamente no centro de um monólito de seis
   * metros. Com a diferença guardada, clicar sem mexer o mouse não move nada,
   * que é o que "selecionar" tem que significar.
   */
  private readonly grabOffset: Vec3 = vec3();
  private readonly planeHit: Vec3 = vec3();
  private readonly origin: Projected = createProjected();
  private readonly probe: Projected = createProjected();

  /** Se o arrasto atual está esticando uma face. Trava o giro pela roda. */
  get resizing(): boolean {
    return this.mode === MODE.RESIZE;
  }

  /**
   * Recalcula as setas do objeto escolhido. Uma vez por quadro, antes do
   * clique: quem desenha e quem testa o clique leem a mesma tabela, então
   * pegar a seta e ver a seta não podem discordar.
   */
  update(
    entity: EntityState | null,
    camera: Camera,
    rasterizer: Rasterizer,
  ): void {
    this.handleCount = 0;
    if (entity === null) return;

    const { current, size } = entity;
    this.shape.update(
      current,
      entity.yaw,
      entity.pitch,
      size.x,
      size.y,
      size.z,
    );

    const half = [size.x, size.y, size.z];

    for (let axis = 0; axis < 3; axis += 1) {
      for (const sign of [-1, 1]) {
        const handle = this.handles[this.handleCount]!;

        this.shape.toWorldDirection(
          axis === 0 ? sign : 0,
          axis === 1 ? sign : 0,
          axis === 2 ? sign : 0,
          handle.dir,
        );

        const reach = half[axis]! + HANDLE_GAP;
        const px = current.x + handle.dir.x * reach;
        const py = current.y + handle.dir.y * reach;
        const pz = current.z + handle.dir.z * reach;

        if (facing(camera, px, py, pz, handle.dir) > MAX_FACING) continue;
        if (!rasterizer.project(px, py, pz, this.origin)) continue;
        if (
          !rasterizer.project(
            px + handle.dir.x * PROBE,
            py + handle.dir.y * PROBE,
            pz + handle.dir.z * PROBE,
            this.probe,
          )
        ) {
          continue;
        }

        handle.col = Math.round(this.origin.col);
        handle.row = Math.round(this.origin.row);
        handle.axis = axis;
        handle.stepCol = (this.probe.col - this.origin.col) / PROBE;
        handle.stepRow = (this.probe.row - this.origin.row) / PROBE;
        handle.glyph = arrowFor(handle.stepCol, handle.stepRow);

        this.handleCount += 1;
      }
    }
  }

  /**
   * Um botão pressionado sobre a cena.
   *
   * A seta tem prioridade sobre o corpo: ela fica encostada no objeto, e sem
   * essa ordem o clique na seta selecionaria de novo o que já está
   * selecionado e o arrasto viraria um deslocamento.
   */
  press(
    world: World,
    lights: LightWorld,
    camera: Camera,
    rasterizer: Rasterizer,
    col: number,
    row: number,
  ): void {
    this.grabbed = this.handleAt(col, row);
    if (this.grabbed >= 0) {
      this.mode = MODE.RESIZE;
      return;
    }

    const { position } = camera;
    rasterizer.rayThrough(col, row, this.ray);
    const hit = world.pick(
      lights,
      position.x,
      position.y,
      position.z,
      this.ray.x,
      this.ray.y,
      this.ray.z,
    );

    world.selectedId = hit?.id ?? null;
    this.mode = hit === null ? MODE.NONE : MODE.MOVE;
    if (hit !== null) this.anchor(hit, camera, rasterizer, col, row);
  }

  /**
   * Fixa a diferença entre o objeto e o ponto sob o cursor.
   *
   * Refeito também quando o arrasto vertical muda a altura: o plano em que o
   * objeto desliza é o da própria altura dele, e mudar de plano sem
   * reancorar faria o objeto pular no primeiro movimento horizontal seguinte.
   */
  private anchor(
    entity: EntityState,
    camera: Camera,
    rasterizer: Rasterizer,
    col: number,
    row: number,
  ): void {
    if (
      !this.planePoint(
        camera,
        rasterizer,
        col,
        row,
        entity.position.y,
        this.planeHit,
      )
    ) {
      set(this.grabOffset, 0, 0, 0);
      return;
    }
    sub(this.grabOffset, entity.position, this.planeHit);
  }

  /**
   * Onde o raio que atravessa uma célula fura um plano horizontal.
   *
   * `false` quando ele é paralelo ao plano ou o encontra atrás da câmera —
   * nos dois casos não existe ponto para arrastar até.
   */
  private planePoint(
    camera: Camera,
    rasterizer: Rasterizer,
    col: number,
    row: number,
    planeY: number,
    out: Vec3,
  ): boolean {
    rasterizer.rayThrough(col, row, this.ray);
    if (Math.abs(this.ray.y) < 1e-4) return false;

    const { position } = camera;
    const distance = (planeY - position.y) / this.ray.y;
    if (distance <= 0) return false;

    set(
      out,
      position.x + this.ray.x * distance,
      planeY,
      position.z + this.ray.z * distance,
    );
    return true;
  }

  /** O botão continua pressionado. Deslocamentos em células de tela. */
  drag(
    world: World,
    camera: Camera,
    rasterizer: Rasterizer,
    col: number,
    row: number,
    deltaCol: number,
    deltaRow: number,
    shift: boolean,
  ): void {
    const entity = world.selected;
    if (entity === null || this.mode === MODE.NONE) return;

    if (this.mode === MODE.RESIZE) {
      this.resize(entity, deltaCol, deltaRow);
      return;
    }

    if (shift) {
      // Arrastar para cima sobe: a fileira cresce para baixo na tela.
      entity.position.y -= deltaRow * VERTICAL_DRAG;
      this.anchor(entity, camera, rasterizer, col, row);
      return;
    }

    // Sem Shift, o objeto desliza no plano horizontal da própria altura —
    // o plano em que ele já está, para arrastar não mudar dois eixos de uma
    // vez sem que ninguém tenha pedido.
    if (
      !this.planePoint(
        camera,
        rasterizer,
        col,
        row,
        entity.position.y,
        this.planeHit,
      )
    ) {
      return;
    }

    entity.position.x = this.planeHit.x + this.grabOffset.x;
    entity.position.z = this.planeHit.z + this.grabOffset.z;
  }

  release(): void {
    this.mode = MODE.NONE;
    this.grabbed = -1;
  }

  rotate(entity: EntityState, steps: number): void {
    entity.yaw += steps * WHEEL_YAW;
  }

  /** Índice da seta sob a célula, ou -1. */
  private handleAt(col: number, row: number): number {
    for (let index = 0; index < this.handleCount; index += 1) {
      const handle = this.handles[index]!;
      if (
        Math.abs(handle.col - col) <= GRAB_COLS &&
        Math.abs(handle.row - row) <= GRAB_ROWS
      ) {
        return index;
      }
    }
    return -1;
  }

  /**
   * As setas, por cima de tudo.
   *
   * Em `OVERLAY_DEPTH` porque são interface: uma seta escondida atrás do
   * próprio objeto que ela redimensiona não serviria para nada.
   */
  draw(framebuffer: Framebuffer, hoverCol: number, hoverRow: number): void {
    const hovered =
      this.mode === MODE.RESIZE
        ? this.grabbed
        : this.handleAt(hoverCol, hoverRow);

    for (let index = 0; index < this.handleCount; index += 1) {
      const handle = this.handles[index]!;
      const active = index === hovered;
      framebuffer.plot(
        handle.col,
        handle.row,
        handle.glyph,
        active ? MENU_COLORS.FOCUS : MENU_COLORS.VALUE,
        OVERLAY_DEPTH,
        1,
        active ? 0.9 : 0.25,
      );
    }
  }

  /**
   * Estica o objeto pela face agarrada.
   *
   * O deslocamento do mouse é projetado sobre a direção em que aquela face
   * anda na tela: puxar na diagonal estica pelo tanto que a diagonal tem
   * daquele eixo, e um movimento perpendicular não faz nada. A conta é feita
   * em pixels e não em células — daí o `CELL_ASPECT` — porque quem arrasta
   * mira no que vê, e a célula é 1:2.
   *
   * A face oposta fica onde está: o centro anda metade do que a extensão
   * cresceu. Sem isso, esticar pela face de trás empurraria a de frente, e o
   * objeto pareceria fugir do cursor.
   */
  private resize(
    entity: EntityState,
    deltaCol: number,
    deltaRow: number,
  ): void {
    const handle = this.handles[this.grabbed];
    if (handle === undefined) return;

    const stepX = handle.stepCol;
    const stepY = handle.stepRow * CELL_ASPECT;
    const lengthSq = stepX * stepX + stepY * stepY;
    // A face aponta para a câmera: não há direção na tela para arrastar.
    if (lengthSq < 1e-6) return;

    const moved =
      (deltaCol * stepX + deltaRow * CELL_ASPECT * stepY) / lengthSq;
    if (moved === 0) return;

    const uniform = ENTITY_KINDS[entity.kind].uniformSize === true;
    const axis = handle.axis;
    const half =
      axis === 0 ? entity.size.x : axis === 1 ? entity.size.y : entity.size.z;

    const next = Math.max(MIN_HALF, half + moved / 2);
    const applied = (next - half) * 2;

    if (uniform) {
      entity.size.x = next;
      entity.size.y = next;
      entity.size.z = next;
    } else if (axis === 0) {
      entity.size.x = next;
    } else if (axis === 1) {
      entity.size.y = next;
    } else {
      entity.size.z = next;
    }

    entity.position.x += handle.dir.x * applied * 0.5;
    entity.position.y += handle.dir.y * applied * 0.5;
    entity.position.z += handle.dir.z * applied * 0.5;
  }
}

/** O quanto a face encara a câmera, de 0 (de perfil) a 1 (de frente ou de costas). */
const facing = (
  camera: Camera,
  x: number,
  y: number,
  z: number,
  dir: Vec3,
): number => {
  const dx = x - camera.position.x;
  const dy = y - camera.position.y;
  const dz = z - camera.position.z;
  const length = Math.hypot(dx, dy, dz);
  if (length === 0) return 1;
  return Math.abs((dx * dir.x + dy * dir.y + dz * dir.z) / length);
};

/**
 * A seta que representa "para fora" desta face, na tela.
 *
 * Escolhida pela projeção e não pelo eixo: girar o objeto ou andar em volta
 * dele muda para que lado da tela a face aponta, e uma seta fixa por eixo
 * apontaria para dentro do objeto na metade das voltas. A comparação pesa a
 * fileira pela proporção da célula, senão a diagonal cai sempre no lado
 * horizontal.
 */
const arrowFor = (stepCol: number, stepRow: number): number => {
  if (Math.abs(stepCol) >= Math.abs(stepRow) * CELL_ASPECT) {
    return stepCol >= 0 ? GLYPH.ARROW_RIGHT : GLYPH.ARROW_LEFT;
  }
  // A fileira cresce para baixo na tela.
  return stepRow >= 0 ? GLYPH.ARROW_DOWN : GLYPH.ARROW_UP;
};
