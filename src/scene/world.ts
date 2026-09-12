import { copyRgb, rgb } from "../math/color";
import { copy, vec3 } from "../math/vec3";
import { traceNearest } from "../light/trace";
import type { LightWorld } from "../light/world";
import { GLYPH } from "../render/palette";
import type { SurfaceStyle } from "../render/rasterizer";
import { SurfacePen } from "../render/shading";
import { BoxShape } from "./entities/box";
import {
  createEntity,
  ENTITY,
  type EntityKind,
  type EntityKindDef,
  type EntityState,
  reserveIds,
} from "./entities/entity";
import { monolithKind } from "./entities/monolith";
import { orbKind } from "./entities/orb";
import { panelKind } from "./entities/panel";
import { spotlightKind } from "./entities/spotlight";
import type { Renderable, RenderContext } from "./scene";

export const ENTITY_KINDS: Record<EntityKind, EntityKindDef> = {
  [ENTITY.ORB]: orbKind,
  [ENTITY.MONOLITH]: monolithKind,
  [ENTITY.PANEL]: panelKind,
  [ENTITY.SPOTLIGHT]: spotlightKind,
};

export const ENTITY_ORDER: readonly EntityKind[] = [
  ENTITY.ORB,
  ENTITY.MONOLITH,
  ENTITY.PANEL,
  ENTITY.SPOTLIGHT,
];

const STORAGE_KEY = "cp437-engine/scene";

/** Folga da caixa de seleção, para ela não pousar em cima do wireframe. */
const SELECTION_MARGIN = 0.35;

/**
 * Os objetos da cena e quem manda neles.
 *
 * É o corte que o README previa quando dizia que a hora de separar `settings` de
 * um `gameState` chegaria: `settings` é o que a pessoa configura na engine, isto
 * é o que existe no mundo. A diferença fica clara na persistência — os ajustes
 * são preferência de quem olha, a cena é conteúdo, e só a cena é salva.
 *
 * O `World` é um `Renderable` como qualquer outro: entra na cena pela mesma
 * porta que céu, sol e chão, e ninguém acima dele sabe que ele é diferente.
 */
export class World implements Renderable {
  readonly entities: EntityState[] = [];
  selectedId: number | null = null;

  /**
   * O realce de seleção só aparece no modo de edição.
   *
   * Doze arestas acesas em volta de um objeto é muita tinta para uma cena que
   * está sendo olhada, e não editada — cobre justamente o que se quer ver.
   */
  editing = false;

  /**
   * Uma caneta para todos os objetos.
   *
   * Cada um sobrescreve material e normal antes de desenhar, e nenhum deles
   * guarda estado entre quadros — então uma instância basta, e o custo de
   * cinquenta objetos deixa de incluir cinquenta materiais.
   */
  private readonly pen = new SurfacePen();

  private readonly selectionShape = new BoxShape();

  // Rascunhos do realce de seleção: ele roda por quadro, com doze arestas.
  private readonly selectionTint = rgb(1, 1, 1);
  private readonly edgeStart = vec3();
  private readonly edgeEnd = vec3();
  private selectionPulse = 1;

  /**
   * Estilo do realce: sem iluminação, de propósito.
   *
   * É interface, não cenário, e tem que aparecer igual dentro de uma sombra.
   * A cor é copiada e não apontada — trocar a referência de `out.color` faria
   * o próximo fragmento da cena, que escreve dentro do objeto apontado,
   * sobrescrever esta cor.
   */
  private readonly selectionStyle: SurfaceStyle = (sample, out) => {
    out.glyph = GLYPH.PLUS;
    copyRgb(out.color, this.selectionTint);
    out.alpha = 1;
    out.emissive = this.selectionPulse;
    // Interface, não incidência: sem isto herdaria `fuse` de um feixe
    // desenhado antes no mesmo quadro (o fragmento é reaproveitado) e a
    // caixa de seleção passaria a tingir o que está atrás em vez de riscar
    // por cima, do jeito que sempre desenhou.
    out.fuse = false;
    return sample.depth > 0;
  };

  add(kind: EntityKind): EntityState {
    const entity = createEntity(kind, ENTITY_KINDS[kind].defaults());
    copy(entity.current, entity.position);
    this.entities.push(entity);
    this.selectedId = entity.id;
    return entity;
  }

  remove(id: number): void {
    const index = this.entities.findIndex((entity) => entity.id === id);
    if (index < 0) return;

    this.entities.splice(index, 1);
    if (this.selectedId === id) {
      this.selectedId =
        this.entities[Math.min(index, this.entities.length - 1)]?.id ?? null;
    }
  }

  find(id: number | null): EntityState | null {
    if (id === null) return null;
    return this.entities.find((entity) => entity.id === id) ?? null;
  }

  get selected(): EntityState | null {
    return this.find(this.selectedId);
  }

  contribute(context: RenderContext): void {
    this.animate(context.time);

    for (const entity of this.entities) {
      if (!entity.visible) continue;
      ENTITY_KINDS[entity.kind].contribute(entity, context.lights);
    }
  }

  render(context: RenderContext): void {
    this.pen.begin(context);

    for (const entity of this.entities) {
      if (!entity.visible) continue;
      ENTITY_KINDS[entity.kind].render(entity, context, this.pen);
    }

    const selected = this.editing ? this.selected : null;
    if (selected !== null) this.drawSelection(selected, context);
  }

  /** Segunda passada: feixes e outros efeitos que tingem em vez de desenhar. */
  renderGlow(context: RenderContext): void {
    for (const entity of this.entities) {
      if (!entity.visible) continue;
      ENTITY_KINDS[entity.kind].renderGlow?.(entity, context, this.pen);
    }
  }

  /** A órbita escreve em `current`, nunca em `position`. */
  private animate(timeMs: number): void {
    for (const entity of this.entities) {
      if (entity.orbitRadius <= 0 || entity.orbitSpeed === 0) {
        copy(entity.current, entity.position);
        continue;
      }

      const angle = (timeMs / 1000) * entity.orbitSpeed;
      entity.current.x =
        entity.position.x + Math.cos(angle) * entity.orbitRadius;
      entity.current.y = entity.position.y;
      entity.current.z =
        entity.position.z + Math.sin(angle) * entity.orbitRadius;
    }
  }

  /**
   * Caixa de seleção em volta do objeto escolhido.
   *
   * Sem realce, mover um objeto que está fora de vista é adivinhação: os
   * sliders mudam números e nada acontece na tela. A caixa é desenhada sem
   * iluminação de propósito — ela é interface, não cenário, e tem que
   * aparecer igual dentro de uma sombra.
   */
  private drawSelection(entity: EntityState, context: RenderContext): void {
    const { rasterizer } = context;
    const shape = this.selectionShape;
    const { size } = entity;

    // Uma folga em volta, para a caixa não coincidir com as arestas do
    // próprio objeto e virar ruído em cima delas.
    shape.update(
      entity.current,
      entity.yaw,
      entity.pitch,
      size.x + SELECTION_MARGIN,
      size.y + SELECTION_MARGIN,
      size.z + SELECTION_MARGIN,
    );

    this.selectionPulse = 0.55 + 0.45 * Math.sin(context.time / 180);

    for (const edge of shape.edges) {
      shape.corner(edge.a, this.edgeStart);
      shape.corner(edge.b, this.edgeEnd);
      rasterizer.line(
        this.edgeStart.x,
        this.edgeStart.y,
        this.edgeStart.z,
        this.edgeEnd.x,
        this.edgeEnd.y,
        this.edgeEnd.z,
        this.selectionStyle,
      );
    }
  }

  /**
   * Qual objeto está sob um raio.
   *
   * Reaproveita o mesmo traçado que faz sombra e reflexo, contra os mesmos
   * corpos: o que o clique acerta é, por construção, o que projeta sombra e
   * aparece no espelho. Um código de seleção próprio poderia discordar dos
   * outros dois, e discordaria justo quando alguém girasse um objeto.
   */
  pick(
    lights: LightWorld,
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
  ): EntityState | null {
    const hit = traceNearest(lights, ox, oy, oz, dx, dy, dz, 1000, Number.NaN);
    return hit === null ? null : this.find(hit.ownerId);
  }

  /**
   * Cena de demonstração.
   *
   * Terreno aberto, sem sala nenhuma: o custo de sombra escala com o número de
   * oclusores, e uma dúzia de paredes finas testadas por raio a cada quadro
   * pesava mais do que qualquer coisa que elas escondiam. Um trio de
   * monólitos basta para a mesma prova — cada um com seu orbe em órbita,
   * o do meio também sob três holofotes RGB convergindo (mistura aditiva de
   * cor), e um painel espelhado do lado para mostrar o reflexo de verdade.
   */
  loadDemo(): void {
    this.entities.length = 0;

    const orb = (
      x: number,
      y: number,
      z: number,
      color: [number, number, number],
      orbitRadius: number,
      speed: number,
      name: string,
    ): void => {
      const entity = this.add(ENTITY.ORB);
      entity.name = name;
      entity.position.x = x;
      entity.position.y = y;
      entity.position.z = z;
      entity.color.r = color[0];
      entity.color.g = color[1];
      entity.color.b = color[2];
      entity.orbitRadius = orbitRadius;
      entity.orbitSpeed = speed;
      entity.size["x"] = 1;
      entity.range = 50;
    };

    const monolith = (
      x: number,
      z: number,
      halfHeight: number,
      name: string,
    ): EntityState => {
      const entity = this.add(ENTITY.MONOLITH);
      entity.name = name;
      entity.position.x = x;
      entity.position.y = halfHeight;
      entity.position.z = z;
      entity.size.x = 1;
      entity.size.y = halfHeight;
      entity.size.z = 1;
      return entity;
    };

    const spot = (
      x: number,
      y: number,
      z: number,
      yawDeg: number,
      pitchDeg: number,
      color: [number, number, number],
      intensity: number,
      range: number,
      coneAngleDeg: number,
      name: string,
    ): void => {
      const entity = this.add(ENTITY.SPOTLIGHT);
      entity.name = name;
      entity.position.x = x;
      entity.position.y = y;
      entity.position.z = z;
      entity.yaw = (yawDeg * Math.PI) / 180;
      entity.pitch = (pitchDeg * Math.PI) / 180;
      entity.color.r = color[0];
      entity.color.g = color[1];
      entity.color.b = color[2];
      entity.intensity = intensity;
      entity.range = range;
      entity.coneAngle = (coneAngleDeg * Math.PI) / 180;
    };

    // --- Trio de monólitos: o do meio é o palco da mistura de cor, os dois
    // de lado só vivem da própria luz orbitando. ---
    const hero = monolith(0, -5, 1.5, "Hero monolith");
    const west = monolith(-16, -34, 5, "West monolith");
    const east = monolith(16, -34, 5, "East monolith");

    hero.texture = "smooth";
    hero.reflectivity = 1;
    hero.gloss = 200;
    hero.color.r = 1;
    hero.color.g = 1;
    hero.color.b = 1;

    orb(
      west.position.x,
      7,
      west.position.z,
      [0.65, 0.35, 1],
      3.5,
      -0.3,
      "West orb",
    );
    orb(
      east.position.x,
      7,
      east.position.z,
      [0.2, 1, 0.85],
      3.5,
      0.3,
      "East orb",
    );

    // --- Três holofotes RGB convergindo no monólito central. ---
    spot(
      -5,
      8.3,
      hero.position.z + 6,
      -35,
      -55,
      [1, 0, 0],
      15,
      80,
      45,
      "Red spotlight",
    );
    spot(
      5,
      8.3,
      hero.position.z + 6,
      35,
      -55,
      [0, 1, 0],
      15,
      80,
      45,
      "Green spotlight",
    );
    spot(
      0,
      8.3,
      hero.position.z - 6,
      180,
      -55,
      [0, 0, 1],
      15,
      80,
      45,
      "Blue spotlight",
    );

    // --- Painel espelhado, de lado: reflete a mistura de cor e os orbes. ---
    const panel = this.add(ENTITY.PANEL);
    panel.name = "Reflective panel";
    panel.position.x = 9;
    panel.position.y = 4.5;
    panel.position.z = -2;
    panel.size.x = 4;
    panel.size.y = 3;
    panel.size.z = 0.2;
    panel.yaw = (-50 * Math.PI) / 85;
    panel.color.r = 0.75;
    panel.color.g = 0.85;
    panel.color.b = 1;
    panel.reflectivity = 0.9;
    panel.gloss = 220;
    panel.mirror = true;

    this.selectedId = null;
  }

  /** A cena montada sobrevive ao reload; os ajustes da engine não. */
  save(): void {
    const plain = this.entities.map(
      ({ current: _current, mirrorMaterial: _mirrorMaterial, ...rest }) =>
        rest,
    );
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(plain));
    } catch {
      //perder a cena salva não pode derrubar
    }
  }

  /** Devolve `false` quando não há nada salvo, e a demo entra no lugar. */
  load(): boolean {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch {
      return false;
    }
    if (raw === null) return false;

    try {
      const parsed = JSON.parse(raw) as EntityState[];
      if (!Array.isArray(parsed) || parsed.length === 0) return false;

      this.entities.length = 0;
      for (const saved of parsed) {
        const definition = ENTITY_KINDS[saved.kind];
        if (definition === undefined) continue;

        // O que está salvo manda; o que não está vem do padrão do tipo.
        // É o que deixa um campo novo — textura foi o primeiro — nascer
        // com valor sensato numa cena montada antes de ele existir, em
        // vez de chegar `undefined` no meio do render.
        const entity = {
          ...createEntity(saved.kind, definition.defaults()),
          ...saved,
          current: vec3(),
        };
        copy(entity.current, entity.position);
        this.entities.push(entity);
      }
      reserveIds(this.entities);
      this.selectedId = null;
      return this.entities.length > 0;
    } catch {
      return false;
    }
  }
}
