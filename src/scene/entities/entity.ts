import { type Rgb, rgb } from "../../math/color";
import { type Vec3, vec3 } from "../../math/vec3";
import { TEXTURE, TEXTURES, type SurfaceTexture } from "../../render/ramp";
import type { SurfacePen } from "../../render/shading";
import type { Material } from "../../light/types";
import type { LightWorld } from "../../light/world";
import type { RenderContext } from "../scene";

export const ENTITY = {
  /** Esfera emissiva: é a luz colorida, e o que se vê dela. */
  ORB: "orb",
  /** Caixa em wireframe. Recebe luz e projeta sombra. */
  MONOLITH: "monolith",
  /** Placa refletiva. É onde o raio de espelho tem o que mostrar. */
  PANEL: "panel",
  /** Cone de luz configurável: alcance, cor e abertura do feixe. */
  SPOTLIGHT: "spotlight",
} as const;

export type EntityKind = (typeof ENTITY)[keyof typeof ENTITY];

/**
 * Um objeto da cena, como dado puro.
 *
 * Um só formato para todos os tipos, e não uma hierarquia de classes, por três
 * razões práticas: serializa para `localStorage` sem tradução, o editor mexe em
 * qualquer campo sem saber de que tipo é o objeto, e criar um tipo novo não
 * obriga a inventar um construtor. O que varia por tipo é comportamento, e
 * comportamento mora no registro abaixo.
 *
 * Ângulos ficam em radianos aqui e viram graus só na tela: converter na
 * fronteira é mais barato que lembrar em qual unidade cada campo está.
 */
export interface EntityState {
  id: number;
  kind: EntityKind;
  name: string;
  visible: boolean;

  /** Onde o objeto foi posto. É isto que o editor move e o que é salvo. */
  position: Vec3;
  /**
   * Onde ele está neste quadro: `position` mais a órbita.
   *
   * Separado porque a animação não pode escrever em cima do que o editor
   * edita — um orbe em órbita teria a posição sobrescrita sessenta vezes por
   * segundo e o slider não seguraria valor nenhum. Derivado, não serializado.
   */
  current: Vec3;
  yaw: number;
  pitch: number;
  /** Meias-extensões da caixa. O orbe usa só `x`, como raio. */
  size: Vec3;

  color: Rgb;
  /** Orbe: força da luz. Demais: brilho próprio das arestas. */
  intensity: number;
  /** Alcance da luz do orbe/holofote, em unidades de mundo. */
  range: number;
  /** Abertura do feixe do holofote, em radianos, borda a borda. Demais tipos ignoram. */
  coneAngle: number;

  reflectivity: number;
  gloss: number;
  /**
   * De que alfabeto de glifos as superfícies deste objeto saem.
   *
   * Mora no objeto e não em `settings` porque é o que ele *é*: dois monólitos
   * lado a lado, um liso e um áspero, sob a mesma luz e a mesma rampa.
   */
  texture: SurfaceTexture;
  /** Dispara raio de reflexão contra os corpos, e não só contra o céu. */
  mirror: boolean;
  castsShadow: boolean;
  /**
   * As faces são preenchidas, e o objeto passa a tapar o que está atrás.
   *
   * Um corpo em wireframe já bloqueava luz — ele projeta sombra e aparece no
   * espelho — mas se deixava atravessar pelo olhar, e um objeto que bloqueia
   * luz e não bloqueia vista é uma contradição que o olho percebe antes de
   * saber nomear. Continua sendo opção porque o wireframe puro também é uma
   * imagem que esta engine sabe fazer.
   */
  solid: boolean;

  /** Animação: raio, altura e velocidade da órbita. Zero deixa parado. */
  orbitRadius: number;
  orbitSpeed: number;

  /**
   * O que um raio de espelho vê deste corpo, de verdade — não serializa
   * (como `current`), recriado em `createEntity()`. Precisa ser um objeto
   * por instância, e não um rascunho de módulo por tipo: `shadeOccluders`
   * lê o ponteiro guardado em `Occluder.material` depois que *todo*
   * `contribute()` do quadro já rodou, e um rascunho compartilhado entre,
   * digamos, dois monólitos teria o segundo sobrescrevendo o material do
   * primeiro antes dessa leitura.
   */
  mirrorMaterial: Material;
}

/**
 * Um campo editável, com o intervalo que faz sentido para ele.
 *
 * Acessor e não nome de propriedade porque metade dos campos mora dentro de um
 * `Vec3` ou de um `Rgb`, e um caminho em string custaria uma busca por
 * fragmento de interface e perderia a checagem de tipo.
 */
export interface EntityNumberField {
  kind: "number";
  label: string;
  min: number;
  max: number;
  step: number;
  digits?: number;
  suffix?: string;
  get(entity: EntityState): number;
  set(entity: EntityState, value: number): void;
}

/**
 * Um campo com um punhado de valores nomeados.
 *
 * Existe porque textura não é uma escala: entre lisa e áspera não há meio
 * termo, e um slider de 0 a 2 com o rótulo "1" seria pedir para quem edita
 * decorar a tabela.
 */
export interface EntityChoiceField {
  kind: "choice";
  label: string;
  options: readonly { value: string; label: string }[];
  get(entity: EntityState): string;
  set(entity: EntityState, value: string): void;
}

export type EntityField = EntityNumberField | EntityChoiceField;

export interface EntityKindDef {
  label: string;
  /** O que o tipo muda em relação ao objeto padrão. */
  defaults: () => Partial<EntityState>;
  /** Registra luz e corpo. Nunca desenha. */
  contribute: (entity: EntityState, world: LightWorld) => void;
  render: (
    entity: EntityState,
    context: RenderContext,
    pen: SurfacePen,
  ) => void;
  /**
   * Incidência sobre o que `render` de todo mundo já desenhou neste quadro —
   * ver `Renderable.renderGlow`. Só o holofote usa hoje, para o feixe: a
   * carcaça continua em `render`, porque é corpo de verdade, não luz.
   */
  renderGlow?: (
    entity: EntityState,
    context: RenderContext,
    pen: SurfacePen,
  ) => void;
  /** Só os campos que significam alguma coisa para este tipo. */
  fields: readonly EntityField[];
  /**
   * O tamanho é um número só, e não três.
   *
   * O orbe é uma esfera: esticar uma face dele tem que esticar as outras
   * cinco, senão a caixa que o editor mostra deixa de descrever o corpo que o
   * raio testa. É o tipo quem sabe disso, não o editor.
   */
  uniformSize?: boolean;
}

let nextId = 1;

export const createEntity = (
  kind: EntityKind,
  overrides: Partial<EntityState> = {},
): EntityState => ({
  id: nextId++,
  kind,
  name: kind,
  visible: true,
  position: vec3(0, 3, -20),
  current: vec3(0, 3, -20),
  yaw: 0,
  pitch: 0,
  size: vec3(1.5, 1.5, 1.5),
  color: rgb(1, 1, 1),
  intensity: 1,
  range: 26,
  coneAngle: (35 * Math.PI) / 180,
  reflectivity: 0,
  gloss: 40,
  texture: TEXTURE.SMOOTH,
  mirror: false,
  castsShadow: true,
  solid: false,
  orbitRadius: 0,
  orbitSpeed: 0,
  mirrorMaterial: {
    albedo: rgb(1, 1, 1),
    emissive: rgb(),
    emissiveStrength: 0,
    reflectivity: 0,
    gloss: 24,
    mirror: false,
  },
  ...overrides,
});

/** Depois de carregar uma cena salva, os ids novos não podem colidir. */
export const reserveIds = (entities: readonly EntityState[]): void => {
  for (const entity of entities) nextId = Math.max(nextId, entity.id + 1);
};

/** Os campos que todo objeto tem, na ordem em que o menu os mostra. */
export const COMMON_FIELDS: readonly EntityField[] = [
  {
    kind: "number",
    label: "X",
    min: -120,
    max: 120,
    step: 0.5,
    digits: 1,
    get: (e) => e.position.x,
    set: (e, v) => {
      e.position.x = v;
    },
  },
  {
    kind: "number",
    label: "Y",
    min: -20,
    max: 60,
    step: 0.5,
    digits: 1,
    get: (e) => e.position.y,
    set: (e, v) => {
      e.position.y = v;
    },
  },
  {
    kind: "number",
    label: "Z",
    min: -200,
    max: 120,
    step: 0.5,
    digits: 1,
    get: (e) => e.position.z,
    set: (e, v) => {
      e.position.z = v;
    },
  },
];

const DEGREES = 180 / Math.PI;

export const ROTATION_FIELDS: readonly EntityField[] = [
  {
    kind: "number",
    label: "Yaw",
    min: -180,
    max: 180,
    step: 1,
    suffix: "°",
    get: (e) => e.yaw * DEGREES,
    set: (e, v) => {
      e.yaw = v / DEGREES;
    },
  },
  {
    kind: "number",
    label: "Pitch",
    min: -90,
    max: 90,
    step: 1,
    suffix: "°",
    get: (e) => e.pitch * DEGREES,
    set: (e, v) => {
      e.pitch = v / DEGREES;
    },
  },
];

export const colorFields = (): readonly EntityField[] => [
  {
    kind: "number",
    label: "Red",
    min: 0,
    max: 1,
    step: 0.02,
    digits: 2,
    get: (e) => e.color.r,
    set: (e, v) => {
      e.color.r = v;
    },
  },
  {
    kind: "number",
    label: "Green",
    min: 0,
    max: 1,
    step: 0.02,
    digits: 2,
    get: (e) => e.color.g,
    set: (e, v) => {
      e.color.g = v;
    },
  },
  {
    kind: "number",
    label: "Blue",
    min: 0,
    max: 1,
    step: 0.02,
    digits: 2,
    get: (e) => e.color.b,
    set: (e, v) => {
      e.color.b = v;
    },
  },
];

const TEXTURE_LABELS: Record<SurfaceTexture, string> = {
  [TEXTURE.SMOOTH]: "Smooth",
  [TEXTURE.ROUGH]: "Rough",
  [TEXTURE.IRREGULAR]: "Irregular",
};

/** O alfabeto de glifos da superfície. Vale para todo tipo que desenha linha. */
export const TEXTURE_FIELD: EntityField = {
  kind: "choice",
  label: "Texture",
  options: TEXTURES.map((texture) => ({
    value: texture,
    label: TEXTURE_LABELS[texture],
  })),
  get: (e) => e.texture,
  set: (e, v) => {
    e.texture = v as SurfaceTexture;
  },
};

export const sizeFields = (
  labels: readonly [string, string, string],
): readonly EntityField[] => [
  {
    kind: "number",
    label: labels[0],
    min: 0.2,
    max: 30,
    step: 0.2,
    digits: 1,
    get: (e) => e.size.x,
    set: (e, v) => {
      e.size.x = v;
    },
  },
  {
    kind: "number",
    label: labels[1],
    min: 0.2,
    max: 30,
    step: 0.2,
    digits: 1,
    get: (e) => e.size.y,
    set: (e, v) => {
      e.size.y = v;
    },
  },
  {
    kind: "number",
    label: labels[2],
    min: 0.2,
    max: 30,
    step: 0.2,
    digits: 1,
    get: (e) => e.size.z,
    set: (e, v) => {
      e.size.z = v;
    },
  },
];
