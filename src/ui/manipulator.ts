import type { LightWorld } from "../light/world";
import { type Rgb, copyRgb, fromHex, rgb } from "../math/color";
import {
  type Vec3,
  copy,
  cross,
  dot,
  normalize,
  set,
  sub,
  vec3,
} from "../math/vec3";
import type { Camera } from "../render/camera";
import type { Framebuffer } from "../render/framebuffer";
import { GLYPH } from "../render/palette";
import {
  type Projected,
  type Rasterizer,
  type SurfaceStyle,
  createProjected,
} from "../render/rasterizer";
import { OVERLAY_DEPTH } from "../render/text";
import { CELL_ASPECT } from "../render/viewport";
import { BoxShape } from "../scene/entities/box";
import type { EntityState } from "../scene/entities/entity";
import { ENTITY_KINDS, type World } from "../scene/world";

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

/**
 * Comprimento da seta desenhada, em colunas equivalentes (fileira × `CELL_ASPECT`).
 *
 * Antes a seta era um glifo só, de uma célula — pequena demais para acertar
 * com conforto, e a caixa de clique (bem maior que o glifo) é que sustentava
 * a pontaria. Desenhando de fato uma haste até essa distância, a área
 * clicável (`GRAB_RADIUS_COLS` abaixo) pode enfim coincidir com o que se vê.
 */
const ARROW_SHAFT_COLS = 3;

/** Quanto o cursor pode estar longe do traço da seta e ainda pegá-la. */
const GRAB_RADIUS_COLS = 0.85;

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

/** Direção de "para cima" do mundo. Só leitura — nunca usar como `out`. */
const WORLD_UP: Vec3 = vec3(0, 1, 0);

/**
 * Menor módulo aceito para o denominador de raio×plano, preservando o sinal.
 *
 * O limiar antigo (`1e-4`) só rejeitava o quadro quando já era tarde demais:
 * bem antes de chegar lá, `distance` já tinha explodido para milhares de
 * unidades. Grampear o denominador em vez de só testá-lo evita a divisão por
 * quase-zero sem crescer o bastante para, por si só, resolver o salto — daí o
 * teto de `distance` logo abaixo.
 */
const MIN_PLANE_DENOM = 0.05;

/** Fração do alcance da câmera que o arrasto pode empurrar um objeto. */
const DRAG_DISTANCE_FRACTION = 0.75;

/** Segmentos de cada aro de rotação — desenho e teste de clique usam a mesma malha. */
const RING_SEGMENTS = 40;

/** Multiplicador sobre a diagonal da caixa: o aro sempre contorna o objeto girado, mesmo de lado. */
const RING_RADIUS_SCALE = 1.35;

/** Raio mínimo do aro — sem isto um objeto bem pequeno teria um aro colado nele. */
const RING_RADIUS_MIN = 1.5;

/**
 * Cor por eixo, à la Unity/Blender: X, Y, Z.
 *
 * O aro de yaw gira em torno de Y (verde); o de pitch, em torno do X local
 * (vermelho) — ver o comentário de `updateRings` sobre por que esses eixos
 * são esses e não os "intuitivos" eixo-Y-do-objeto/eixo-de-tela.
 */
const AXIS_COLOR: readonly Rgb[] = [
  fromHex("#ff4d4d"),
  fromHex("#4dff88"),
  fromHex("#4d9dff"),
];

/** Raio do aro: a diagonal da caixa, não a maior meia-extensão — contorna o objeto girado. */
const ringRadiusFor = (size: Vec3): number =>
  Math.max(
    RING_RADIUS_MIN,
    Math.hypot(size.x, size.y, size.z) * RING_RADIUS_SCALE,
  );

/** Folga entre o aro de yaw e a alça de altura, em unidades de mundo. */
const HEIGHT_GAP = 0.6;

/**
 * Cor da alça de altura — deliberadamente fora da trinca de eixo (`AXIS_COLOR`),
 * para não se confundir com a seta verde de redimensionar em Y, que fica
 * bem perto dela.
 */
const HEIGHT_COLOR: Rgb = fromHex("#ffffff");

/** Referências para montar a base do plano de um aro — nunca usadas como `out`. */
const REF_X: Vec3 = vec3(1, 0, 0);
const REF_Y: Vec3 = vec3(0, 1, 0);

/**
 * Base ortonormal de um plano, dada só a normal — sem depender da câmera.
 *
 * A tentação seria orientar a base pela direção de visão, para o "ângulo
 * zero" do aro ficar sempre "para cima" na tela; mas isso degenera bem no
 * ângulo mais comum de uso (olhar quase de frente para o próprio eixo do
 * aro — ex.: de cima para o aro de yaw). Como o arrasto sempre mede um
 * *delta* de ângulo em relação ao ponto do clique (ver `angleOnRing`), a
 * orientação absoluta da base não importa — só precisa ser contínua, o que a
 * troca de referência abaixo garante para qualquer normal unitária.
 */
const buildRingBasis = (normal: Vec3, outU: Vec3, outV: Vec3): void => {
  const ref = Math.abs(normal.y) > 0.99 ? REF_X : REF_Y;
  cross(outU, ref, normal);
  normalize(outU, outU);
  cross(outV, normal, outU);
};

/** Ângulo trazido para `(-π, π]` — o menor caminho entre dois ângulos. */
const wrapAngle = (angle: number): number =>
  ((((angle + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) -
  Math.PI;

/**
 * A seta de uma face: onde ela caiu na tela e o que ela estica.
 *
 * `id` é `axis*2 + (sign===1 ? 1 : 0)` — a própria posição do handle no
 * array `Manipulator.handles`, nunca reatribuída. Antes o array era
 * compactado (só os handles visíveis, na ordem em que passavam o teste de
 * `facing`), e o índice de quem estava agarrado apontava para essa lista
 * instável: uma face que cruzava o limiar de visibilidade *durante o próprio
 * arrasto* — coisa que redimensionar causa, ao mover o ponto de alcance da
 * face — reordenava a lista embaixo do dedo, e o arrasto passava a mexer
 * numa seta diferente da que foi agarrada. Indexar pela identidade em vez de
 * pela posição elimina essa reordenação por construção.
 */
interface Handle {
  readonly id: number;
  /** `false` quando a face está de frente/costas demais — ver `MAX_FACING`. */
  visible: boolean;
  /** Base da seta, encostada na face. */
  col: number;
  row: number;
  /** Ponta da seta, a `ARROW_SHAFT_COLS` de distância da base. */
  tipCol: number;
  tipRow: number;
  /** A seta que aponta para fora da face, escolhida em espaço de tela. */
  glyph: number;
  /** O traço da haste, na mesma escolha horizontal/vertical da seta. */
  shaftGlyph: number;
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
  ROTATE_YAW: "rotate-yaw",
  ROTATE_PITCH: "rotate-pitch",
  HEIGHT: "height",
} as const;

type Mode = (typeof MODE)[keyof typeof MODE];

export class Manipulator {
  private readonly shape = new BoxShape();
  private readonly handles: Handle[] = Array.from(
    { length: 6 },
    (_, id): Handle => ({
      id,
      visible: false,
      col: 0,
      row: 0,
      tipCol: 0,
      tipRow: 0,
      glyph: GLYPH.ARROW_UP,
      shaftGlyph: GLYPH.BOX_H,
      axis: 0,
      dir: vec3(),
      stepCol: 0,
      stepRow: 0,
    }),
  );

  private mode: Mode = MODE.NONE;
  private grabbedId = -1;

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
  private readonly planeOrigin: Vec3 = vec3();
  private readonly planeVec: Vec3 = vec3();
  private readonly origin: Projected = createProjected();
  private readonly probe: Projected = createProjected();

  // --- Aros de rotação ---------------------------------------------------
  private ringsVisible = false;
  private ringRadius = 0;
  private readonly ringCenter: Vec3 = vec3();
  private readonly yawU: Vec3 = vec3();
  private readonly yawV: Vec3 = vec3();
  private readonly pitchU: Vec3 = vec3();
  private readonly pitchV: Vec3 = vec3();
  /** Normal do plano de pitch — a direção local X levada a mundo. */
  private readonly pitchNormal: Vec3 = vec3();
  private readonly yawWorld: Vec3[] = Array.from(
    { length: RING_SEGMENTS },
    () => vec3(),
  );
  private readonly pitchWorld: Vec3[] = Array.from(
    { length: RING_SEGMENTS },
    () => vec3(),
  );
  private readonly yawScreen: Projected[] = Array.from(
    { length: RING_SEGMENTS },
    () => createProjected(),
  );
  private readonly pitchScreen: Projected[] = Array.from(
    { length: RING_SEGMENTS },
    () => createProjected(),
  );
  private ringLastAngle = 0;
  private readonly ringVec: Vec3 = vec3();
  private readonly ringColor: Rgb = rgb();
  private ringEmissive = 0;
  private readonly ringStyle: SurfaceStyle = (sample, out) => {
    out.glyph = GLYPH.BULLET;
    copyRgb(out.color, this.ringColor);
    out.alpha = 0.85;
    out.emissive = this.ringEmissive;
    // Interface, não incidência — mesmo motivo do contorno de seleção em
    // `World["selectionStyle"]`: sem isto herdaria `fuse` de um fragmento
    // reaproveitado e passaria a tingir o que está atrás em vez de riscar
    // por cima.
    out.fuse = false;
    // Resolvida, não adiada — mesmo motivo do contorno de seleção em
    // `World["selectionStyle"]`.
    out.isDeferred = false;
    return sample.depth > 0;
  };

  // --- Alça de altura ------------------------------------------------------
  private heightVisible = false;
  private heightCol = 0;
  private heightRow = 0;
  private heightStepCol = 0;
  private heightStepRow = 0;

  /** Algum arrasto de face, aro ou alça está em andamento. Trava a roda. */
  get manipulating(): boolean {
    return this.mode !== MODE.NONE;
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
    if (entity === null) {
      for (const handle of this.handles) handle.visible = false;
      this.ringsVisible = false;
      this.heightVisible = false;
      return;
    }

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
      for (const sign of [-1, 1] as const) {
        const id = axis * 2 + (sign === 1 ? 1 : 0);
        const handle = this.handles[id]!;
        // Um handle agarrado nunca some nem perde os dados do quadro
        // anterior: é exatamente essa troca de visibilidade, no meio do
        // próprio arrasto, que fazia o índice antigo apontar para a seta
        // errada (ver o comentário de `Handle`).
        const isGrabbed = this.mode === MODE.RESIZE && this.grabbedId === id;

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

        if (facing(camera, px, py, pz, handle.dir) > MAX_FACING && !isGrabbed) {
          handle.visible = false;
          continue;
        }
        if (!rasterizer.project(px, py, pz, this.origin)) {
          if (!isGrabbed) handle.visible = false;
          continue;
        }
        if (
          !rasterizer.project(
            px + handle.dir.x * PROBE,
            py + handle.dir.y * PROBE,
            pz + handle.dir.z * PROBE,
            this.probe,
          )
        ) {
          if (!isGrabbed) handle.visible = false;
          continue;
        }

        handle.visible = true;
        handle.col = Math.round(this.origin.col);
        handle.row = Math.round(this.origin.row);
        handle.axis = axis;
        handle.stepCol = (this.probe.col - this.origin.col) / PROBE;
        handle.stepRow = (this.probe.row - this.origin.row) / PROBE;
        handle.glyph = arrowFor(handle.stepCol, handle.stepRow);

        // A haste some na mesma comparação da cabeça: horizontal quando o
        // passo de coluna domina, vertical quando é o de fileira.
        const horizontal =
          Math.abs(handle.stepCol) >= Math.abs(handle.stepRow) * CELL_ASPECT;
        handle.shaftGlyph = horizontal ? GLYPH.BOX_H : GLYPH.BOX_V;

        const dirCol = handle.stepCol;
        const dirRow = handle.stepRow * CELL_ASPECT;
        const dirLen = Math.hypot(dirCol, dirRow);
        if (dirLen > 1e-6) {
          handle.tipCol = handle.col + (dirCol / dirLen) * ARROW_SHAFT_COLS;
          handle.tipRow =
            handle.row + (dirRow / dirLen / CELL_ASPECT) * ARROW_SHAFT_COLS;
        } else {
          handle.tipCol = handle.col;
          handle.tipRow = handle.row;
        }
      }
    }

    this.updateRings(entity, rasterizer);
    this.updateHeightHandle(entity, rasterizer);
  }

  /**
   * Recalcula a alça de altura: sempre visível, sem o corte de `MAX_FACING`
   * — ela não é seta de face, é uma alça independente, acima do objeto.
   */
  private updateHeightHandle(entity: EntityState, rasterizer: Rasterizer): void {
    const { current } = entity;
    const reach = this.ringRadius + HEIGHT_GAP;

    const ok1 = rasterizer.project(
      current.x,
      current.y + reach,
      current.z,
      this.origin,
    );
    const ok2 = rasterizer.project(
      current.x,
      current.y + reach + PROBE,
      current.z,
      this.probe,
    );

    this.heightVisible = ok1 && ok2;
    if (!this.heightVisible) return;

    this.heightCol = Math.round(this.origin.col);
    this.heightRow = Math.round(this.origin.row);
    this.heightStepCol = (this.probe.col - this.origin.col) / PROBE;
    this.heightStepRow = (this.probe.row - this.origin.row) / PROBE;
  }

  /**
   * Recalcula os dois aros de rotação: geometria e projeção, uma vez por
   * quadro, junto das setas — mesma razão de sempre, quem desenha e quem
   * testa o clique não podem discordar.
   *
   * Eixos verificados em `math/mat4.ts::setView` e `BoxShape`: yaw é a
   * rotação mais externa no caminho local→mundo, então seu eixo em mundo é
   * sempre `WORLD_UP` fixo — nunca `shape.toWorldDirection(0,1,0,…)`, que
   * tangeria com o pitch atual. O eixo de pitch é a direção local X levada a
   * mundo (`toWorldDirection(1,0,0,…)`): rotação em torno de X não move o
   * próprio eixo X, então essa direção depende só do yaw, e fica estável
   * durante o próprio arrasto de pitch — exatamente o que se quer de um
   * gizmo (o eixo não "fugir" enquanto se gira em torno dele).
   */
  private updateRings(entity: EntityState, rasterizer: Rasterizer): void {
    copy(this.ringCenter, entity.current);
    this.ringRadius = ringRadiusFor(entity.size);

    buildRingBasis(WORLD_UP, this.yawU, this.yawV);
    this.shape.toWorldDirection(1, 0, 0, this.pitchNormal);
    buildRingBasis(this.pitchNormal, this.pitchU, this.pitchV);

    this.sampleRing(rasterizer, this.yawU, this.yawV, this.yawWorld, this.yawScreen);
    this.sampleRing(
      rasterizer,
      this.pitchU,
      this.pitchV,
      this.pitchWorld,
      this.pitchScreen,
    );
    this.ringsVisible = true;
  }

  private sampleRing(
    rasterizer: Rasterizer,
    u: Vec3,
    v: Vec3,
    world: Vec3[],
    screen: Projected[],
  ): void {
    for (let i = 0; i < RING_SEGMENTS; i += 1) {
      const angle = (i / RING_SEGMENTS) * Math.PI * 2;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const point = world[i]!;
      point.x = this.ringCenter.x + (u.x * cos + v.x * sin) * this.ringRadius;
      point.y = this.ringCenter.y + (u.y * cos + v.y * sin) * this.ringRadius;
      point.z = this.ringCenter.z + (u.z * cos + v.z * sin) * this.ringRadius;
      // Falha de projeção (ponto atrás do near plane) mantém a amostra do
      // quadro anterior — aceitável, o pior caso é uma resposta de clique
      // ligeiramente atrasada num aro já quase de perfil.
      rasterizer.project(point.x, point.y, point.z, screen[i]!);
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
    this.grabbedId = this.handleAt(col, row);
    if (this.grabbedId >= 0) {
      this.mode = MODE.RESIZE;
      return;
    }

    const selected = world.selected;
    if (selected !== null) {
      const ring = this.ringHitTest(col, row);
      if (ring !== null) {
        this.mode = ring === "yaw" ? MODE.ROTATE_YAW : MODE.ROTATE_PITCH;
        this.ringLastAngle =
          this.angleOnRing(ring, selected, camera, rasterizer, col, row) ?? 0;
        return;
      }

      if (this.heightHandleAt(col, row)) {
        this.mode = MODE.HEIGHT;
        return;
      }
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

  /** Atalho para o plano horizontal na altura do objeto — o caso de sempre. */
  private planePoint(
    camera: Camera,
    rasterizer: Rasterizer,
    col: number,
    row: number,
    planeY: number,
    out: Vec3,
  ): boolean {
    set(this.planeOrigin, 0, planeY, 0);
    return this.planePointGeneric(
      camera,
      rasterizer,
      col,
      row,
      this.planeOrigin,
      WORLD_UP,
      out,
    );
  }

  /**
   * Onde o raio que atravessa uma célula fura um plano qualquer.
   *
   * `false` só quando o plano fica atrás da câmera — quase paralelo ao raio
   * não é mais motivo de recusa: o denominador é grampeado (preservando o
   * sinal) e a distância resultante tem um teto, então o pior caso é o ponto
   * parar no fim do alcance de arrasto, na direção do cursor, em vez de
   * disparar para uma coordenada absurda. É o que faz arrastar perto do
   * horizonte da câmera continuar previsível em vez de arremessar o objeto.
   */
  private planePointGeneric(
    camera: Camera,
    rasterizer: Rasterizer,
    col: number,
    row: number,
    planeOrigin: Vec3,
    planeNormal: Vec3,
    out: Vec3,
  ): boolean {
    rasterizer.rayThrough(col, row, this.ray);
    const denom = dot(this.ray, planeNormal);
    const safeDenom =
      Math.abs(denom) < MIN_PLANE_DENOM
        ? denom < 0
          ? -MIN_PLANE_DENOM
          : MIN_PLANE_DENOM
        : denom;

    const { position } = camera;
    sub(this.planeVec, planeOrigin, position);
    const toPlane = dot(this.planeVec, planeNormal);

    let distance = toPlane / safeDenom;
    if (distance <= 0) return false;
    distance = Math.min(distance, camera.far * DRAG_DISTANCE_FRACTION);

    set(
      out,
      position.x + this.ray.x * distance,
      position.y + this.ray.y * distance,
      position.z + this.ray.z * distance,
    );
    return true;
  }

  /** Qual aro está sob a célula, ou `null`. Mesmo teste de segmento das setas. */
  private ringHitTest(col: number, row: number): "yaw" | "pitch" | null {
    if (!this.ringsVisible) return null;

    let best = GRAB_RADIUS_COLS;
    let hit: "yaw" | "pitch" | null = null;

    for (let i = 0; i < RING_SEGMENTS; i += 1) {
      const a = this.yawScreen[i]!;
      const b = this.yawScreen[(i + 1) % RING_SEGMENTS]!;
      const distance = distanceToSegmentCols(col, row, a.col, a.row, b.col, b.row);
      if (distance <= best) {
        best = distance;
        hit = "yaw";
      }
    }
    for (let i = 0; i < RING_SEGMENTS; i += 1) {
      const a = this.pitchScreen[i]!;
      const b = this.pitchScreen[(i + 1) % RING_SEGMENTS]!;
      const distance = distanceToSegmentCols(col, row, a.col, a.row, b.col, b.row);
      if (distance <= best) {
        best = distance;
        hit = "pitch";
      }
    }
    return hit;
  }

  /** A alça de altura está sob a célula. Mesmo teste de segmento das setas. */
  private heightHandleAt(col: number, row: number): boolean {
    if (!this.heightVisible) return false;
    return (
      distanceToSegmentCols(
        col,
        row,
        this.heightCol,
        this.heightRow - 1,
        this.heightCol,
        this.heightRow + 1,
      ) <= GRAB_RADIUS_COLS
    );
  }

  /**
   * Ângulo do ponto sob a célula, em torno do eixo do aro escolhido.
   *
   * O plano é o do próprio aro (normal = eixo de yaw ou de pitch, origem no
   * centro do objeto); o ângulo é medido na base ortonormal desse plano, a
   * mesma que posicionou os pontos amostrados. `null` quando o plano cai
   * atrás da câmera — mesmo caso de `planePointGeneric`.
   */
  private angleOnRing(
    which: "yaw" | "pitch",
    entity: EntityState,
    camera: Camera,
    rasterizer: Rasterizer,
    col: number,
    row: number,
  ): number | null {
    const normal = which === "yaw" ? WORLD_UP : this.pitchNormal;
    const u = which === "yaw" ? this.yawU : this.pitchU;
    const v = which === "yaw" ? this.yawV : this.pitchV;

    if (
      !this.planePointGeneric(
        camera,
        rasterizer,
        col,
        row,
        entity.current,
        normal,
        this.planeHit,
      )
    ) {
      return null;
    }

    sub(this.ringVec, this.planeHit, entity.current);
    return Math.atan2(dot(this.ringVec, v), dot(this.ringVec, u));
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

    if (this.mode === MODE.ROTATE_YAW || this.mode === MODE.ROTATE_PITCH) {
      const which = this.mode === MODE.ROTATE_YAW ? "yaw" : "pitch";
      const angle = this.angleOnRing(which, entity, camera, rasterizer, col, row);
      if (angle === null) return;

      // Delta acumulado quadro a quadro, não "ângulo atual − ângulo do
      // clique": é o que permite girar mais de 180° num arrasto só sem
      // saltar quando `atan2` cruza de π para -π.
      const delta = wrapAngle(angle - this.ringLastAngle);
      if (which === "yaw") entity.yaw += delta;
      else entity.pitch += delta;
      this.ringLastAngle = angle;
      return;
    }

    if (this.mode === MODE.HEIGHT) {
      this.dragHeight(entity, deltaCol, deltaRow);
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
    this.grabbedId = -1;
  }

  rotate(entity: EntityState, steps: number): void {
    entity.yaw += steps * WHEEL_YAW;
  }

  /**
   * `id` da seta sob a célula, ou -1.
   *
   * Testa a distância ao traço de fato desenhado — base até ponta — em vez
   * de uma caixa fixa em volta da base: a área clicável passa a coincidir
   * com a área visível, então setas vizinhas não se sobrepõem no meio do
   * arrasto e o clique não "acerta" um espaço vazio que só existia na antiga
   * caixa de tolerância.
   */
  private handleAt(col: number, row: number): number {
    for (const handle of this.handles) {
      if (!handle.visible) continue;
      const distance = distanceToSegmentCols(
        col,
        row,
        handle.col,
        handle.row,
        handle.tipCol,
        handle.tipRow,
      );
      if (distance <= GRAB_RADIUS_COLS) return handle.id;
    }
    return -1;
  }

  /**
   * As setas, por cima de tudo, e os dois aros de rotação.
   *
   * As setas ficam em `OVERLAY_DEPTH` porque são interface: uma seta
   * escondida atrás do próprio objeto que ela redimensiona não serviria para
   * nada. Os aros não podem seguir o mesmo caminho — `rasterizer.line()` usa
   * a profundidade real do segmento, não há como forçar overlay nela — mas
   * isso é aceitável: é o mesmo padrão do contorno de seleção
   * (`World["drawSelection"]`), que também nunca foi overlay.
   */
  draw(
    framebuffer: Framebuffer,
    rasterizer: Rasterizer,
    hoverCol: number,
    hoverRow: number,
  ): void {
    const hoveredId =
      this.mode === MODE.RESIZE
        ? this.grabbedId
        : this.handleAt(hoverCol, hoverRow);

    for (const handle of this.handles) {
      if (!handle.visible) continue;
      const active = handle.id === hoveredId;
      const color = AXIS_COLOR[handle.axis]!;
      const emissive = active ? 0.9 : 0.25;

      // A haste, célula a célula, até a ponta — é isso que faz a seta ocupar
      // mais que um caractere e a área de clique acima poder seguir o mesmo
      // traço.
      for (let step = 1; step < ARROW_SHAFT_COLS; step += 1) {
        const t = step / ARROW_SHAFT_COLS;
        const col = Math.round(handle.col + (handle.tipCol - handle.col) * t);
        const row = Math.round(handle.row + (handle.tipRow - handle.row) * t);
        framebuffer.plot(
          col,
          row,
          handle.shaftGlyph,
          color,
          OVERLAY_DEPTH,
          1,
          emissive,
        );
      }

      framebuffer.plot(
        Math.round(handle.tipCol),
        Math.round(handle.tipRow),
        handle.glyph,
        color,
        OVERLAY_DEPTH,
        1,
        emissive,
      );
    }

    const hoveredRing =
      this.mode === MODE.ROTATE_YAW
        ? "yaw"
        : this.mode === MODE.ROTATE_PITCH
          ? "pitch"
          : this.ringHitTest(hoverCol, hoverRow);

    this.drawRing(rasterizer, this.yawWorld, AXIS_COLOR[1]!, hoveredRing === "yaw");
    this.drawRing(
      rasterizer,
      this.pitchWorld,
      AXIS_COLOR[0]!,
      hoveredRing === "pitch",
    );

    if (this.heightVisible) {
      const activeHeight =
        this.mode === MODE.HEIGHT || this.heightHandleAt(hoverCol, hoverRow);
      const emissive = activeHeight ? 0.9 : 0.25;

      framebuffer.plot(
        this.heightCol,
        this.heightRow - 1,
        GLYPH.ARROW_UP,
        HEIGHT_COLOR,
        OVERLAY_DEPTH,
        1,
        emissive,
      );
      framebuffer.plot(
        this.heightCol,
        this.heightRow,
        GLYPH.ARROW_VERTICAL,
        HEIGHT_COLOR,
        OVERLAY_DEPTH,
        1,
        emissive,
      );
      framebuffer.plot(
        this.heightCol,
        this.heightRow + 1,
        GLYPH.ARROW_DOWN,
        HEIGHT_COLOR,
        OVERLAY_DEPTH,
        1,
        emissive,
      );
    }
  }

  private drawRing(
    rasterizer: Rasterizer,
    world: readonly Vec3[],
    color: Rgb,
    active: boolean,
  ): void {
    if (!this.ringsVisible) return;
    copyRgb(this.ringColor, color);
    this.ringEmissive = active ? 0.9 : 0.25;

    for (let i = 0; i < RING_SEGMENTS; i += 1) {
      const a = world[i]!;
      const b = world[(i + 1) % RING_SEGMENTS]!;
      rasterizer.line(a.x, a.y, a.z, b.x, b.y, b.z, this.ringStyle);
    }
  }

  /**
   * Sobe ou desce o objeto pela alça de altura.
   *
   * Mesma projeção escalar do `resize()` — o deslocamento do mouse contra o
   * passo de tela do eixo Y naquele quadro —, escalada por profundidade e
   * campo de visão em vez do `VERTICAL_DRAG` fixo do Shift+arrastar. Os dois
   * caminhos nunca competem no mesmo quadro: são modos exclusivos.
   */
  private dragHeight(
    entity: EntityState,
    deltaCol: number,
    deltaRow: number,
  ): void {
    const stepX = this.heightStepCol;
    const stepY = this.heightStepRow * CELL_ASPECT;
    const lengthSq = stepX * stepX + stepY * stepY;
    if (lengthSq < 1e-6) return;

    const moved =
      (deltaCol * stepX + deltaRow * CELL_ASPECT * stepY) / lengthSq;
    entity.position.y += moved;
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
    const handle = this.handles[this.grabbedId];
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
 * Distância de uma célula a um segmento de tela, em colunas equivalentes.
 *
 * Reaproveitada pelo hit-test das setas e, mais tarde, dos aros de rotação:
 * os dois são traços poligonais em tela, e "está perto o bastante de um
 * traço" é a mesma pergunta para ambos. Pesa a fileira por `CELL_ASPECT`
 * pelo mesmo motivo de sempre — a célula não é quadrada.
 */
const distanceToSegmentCols = (
  col: number,
  row: number,
  aCol: number,
  aRow: number,
  bCol: number,
  bRow: number,
): number => {
  const ax = aCol;
  const ay = aRow * CELL_ASPECT;
  const bx = bCol;
  const by = bRow * CELL_ASPECT;
  const px = col;
  const py = row * CELL_ASPECT;

  const abx = bx - ax;
  const aby = by - ay;
  const lenSq = abx * abx + aby * aby;
  const t =
    lenSq < 1e-9
      ? 0
      : Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / lenSq));

  const cx = ax + abx * t;
  const cy = ay + aby * t;
  return Math.hypot(px - cx, py - cy);
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
