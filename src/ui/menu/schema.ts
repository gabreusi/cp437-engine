import { type Settings, settings } from "../../config";
import type { EntityField, EntityState } from "../../scene/entities/entity";
import { TEXTURES } from "../../render/ramp";
import { ENTITY_KINDS, ENTITY_ORDER, type World } from "../../scene/world";
import type { MenuGroup, MenuItem } from "./model";

/**
 * Os grupos do menu, declarados.
 *
 * É a evolução direta da tabela `SLIDERS` que gerava o painel em DOM: a lição
 * de lá continua valendo — com quarenta controles, escrever cada um à mão faria
 * a faixa e o valor divergirem — e o que mudou foi só o destino, que agora é a
 * grade de caracteres em vez do documento.
 *
 * O que os grupos acrescentam é navegação: quarenta controles numa lista só é
 * uma barra de rolagem, sete grupos de seis é um menu.
 */

type NumericKey = {
  [K in keyof Settings]: Settings[K] extends number ? K : never;
}[keyof Settings];

type BooleanKey = {
  [K in keyof Settings]: Settings[K] extends boolean ? K : never;
}[keyof Settings];

interface SliderSpec {
  key: NumericKey;
  label: string;
  min: number;
  max: number;
  step: number;
  digits?: number;
  suffix?: string;
}

const slider = (spec: SliderSpec): MenuItem => ({
  kind: "slider",
  label: spec.label,
  min: spec.min,
  max: spec.max,
  step: spec.step,
  digits: spec.digits,
  suffix: spec.suffix,
  get: () => settings[spec.key],
  set: (value) => {
    settings[spec.key] = value;
  },
});

const toggle = (key: BooleanKey, label: string): MenuItem => ({
  kind: "toggle",
  label,
  get: () => settings[key],
  set: (value) => {
    settings[key] = value;
  },
});

const TEXTURE_LABELS: Record<string, string> = {
  smooth: "Smooth",
  rough: "Rough",
  irregular: "Irregular",
};

export const buildGroups = (world: World): MenuGroup[] => [
  {
    label: "Camera",
    items: () => [
      slider({
        key: "fovDegrees",
        label: "FOV",
        min: 40,
        max: 110,
        step: 1,
        suffix: "°",
      }),
      slider({ key: "moveSpeed", label: "Speed", min: 2, max: 60, step: 1 }),
      slider({
        key: "lookSensitivity",
        label: "Sensibility",
        min: 0.0005,
        max: 0.006,
        step: 0.0001,
        digits: 4,
      }),
    ],
  },
  {
    label: "Grid",
    items: () => [
      slider({
        key: "gridSize",
        label: "Size",
        min: 1,
        max: 16,
        step: 0.5,
        digits: 1,
      }),
      slider({
        key: "viewDistance",
        label: "View Distance",
        min: 60,
        max: 400,
        step: 10,
      }),
      slider({
        key: "gridGlow",
        label: "Neon Glow",
        min: 0,
        max: 2,
        step: 0.02,
        digits: 2,
      }),
      slider({
        key: "groundReflectivity",
        label: "Reflections",
        min: 0,
        max: 1,
        step: 0.02,
        digits: 2,
      }),
      slider({ key: "groundGloss", label: "Gloss", min: 2, max: 200, step: 2 }),
      {
        kind: "choice",
        label: "Texture",
        options: TEXTURES.map((texture) => ({
          value: texture,
          label: TEXTURE_LABELS[texture] ?? texture,
        })),
        get: () => settings.gridTexture,
        set: (value) => {
          settings.gridTexture = value as Settings["gridTexture"];
        },
      },
      slider({
        key: "groundFillLight",
        label: "Lit Floor",
        min: 0,
        max: 2,
        step: 0.02,
        digits: 2,
      }),
    ],
  },
  {
    label: "Fog",
    items: () => [
      toggle("fogEnabled", "Enabled"),
      slider({
        key: "fogDensity",
        label: "Density",
        min: 0,
        max: 2.5,
        step: 0.05,
        digits: 2,
      }),
      slider({
        key: "groundHaze",
        label: "Ground Haze",
        min: 0,
        max: 1.5,
        step: 0.05,
        digits: 2,
      }),
    ],
  },
  {
    label: "Sun",
    items: () => [
      toggle("sunEnabled", "Enabled"),
      slider({
        key: "sunElevation",
        label: "Elevation",
        min: -20,
        max: 180,
        step: 0.5,
        digits: 1,
        suffix: "°",
      }),
      slider({
        key: "sunAzimuth",
        label: "Azimuth",
        min: -180,
        max: 180,
        step: 1,
        suffix: "°",
      }),
      slider({
        key: "sunAngularSize",
        label: "Size",
        min: 3,
        max: 30,
        step: 0.5,
        digits: 1,
        suffix: "°",
      }),
      slider({
        key: "sunSlices",
        label: "Slices",
        min: 0.2,
        max: 3,
        step: 0.1,
        digits: 1,
      }),
      slider({
        key: "sunLightIntensity",
        label: "Light Intensity",
        min: 0,
        max: 3,
        step: 0.05,
        digits: 2,
      }),
    ],
  },
  {
    label: "Sky",
    items: () => [
      slider({ key: "starCount", label: "Stars", min: 0, max: 4000, step: 50 }),
      slider({
        key: "skyReflectionIntensity",
        label: "Sky Reflection",
        min: 0,
        max: 3,
        step: 0.05,
        digits: 2,
      }),
    ],
  },
  {
    label: "Graphics",
    items: () => [
      toggle("lightingEnabled", "Lighting"),
      toggle("shadowsEnabled", "Shadows"),
      toggle("reflectionsEnabled", "Reflections"),
      slider({
        key: "ambientLevel",
        label: "Ambient",
        min: 0,
        max: 1,
        step: 0.02,
        digits: 2,
      }),
      slider({
        key: "maxShadowLights",
        label: "Max Shadow Lights",
        min: 0,
        max: 8,
        step: 1,
      }),
      { kind: "heading", label: "Character Set" },
      slider({
        key: "rampWeight",
        label: "Ramp weight",
        min: 0,
        max: 10,
        step: 0.2,
        digits: 1,
      }),
      slider({
        key: "rampExposure",
        label: "Exposure",
        min: 0.1,
        max: 3,
        step: 0.05,
        digits: 2,
      }),
    ],
  },
  {
    label: "Objects",
    items: () => buildObjectItems(world),
  },
  {
    label: "VFX",
    items: () => [
      slider({
        key: "bloomIntensity",
        label: "Bloom",
        min: 0,
        max: 2,
        step: 0.05,
        digits: 2,
      }),
      slider({
        key: "bloomRadius",
        label: "Bloom Radius",
        min: 0.5,
        max: 6,
        step: 0.1,
        digits: 1,
      }),
      slider({
        key: "scanlineStrength",
        label: "Scanlines",
        min: 0,
        max: 0.6,
        step: 0.02,
        digits: 2,
      }),
      slider({
        key: "vignetteStrength",
        label: "Vignette",
        min: 0,
        max: 1,
        step: 0.05,
        digits: 2,
      }),
    ],
  },
];

/**
 * A página de objetos: criar, escolher, editar, apagar.
 *
 * Reconstruída a cada quadro porque a cena muda enquanto se mexe nela. Os
 * campos do objeto escolhido vêm do próprio tipo dele, em `ENTITY_KINDS`, então
 * um tipo novo aparece aqui com os controles certos sem tocar no menu.
 */
const buildObjectItems = (world: World): MenuItem[] => {
  const items: MenuItem[] = [{ kind: "heading", label: "CRIAR" }];

  for (const kind of ENTITY_ORDER) {
    items.push({
      kind: "action",
      label: `+ ${ENTITY_KINDS[kind].label}`,
      run: () => {
        world.add(kind);
      },
    });
  }

  items.push({ kind: "heading", label: `CENA (${world.entities.length})` });

  for (const entity of world.entities) {
    items.push({
      kind: "entity",
      label: entity.name,
      entityId: entity.id,
      selected: world.selectedId === entity.id,
      visible: entity.visible,
      toggle: () => {
        entity.visible = !entity.visible;
      },
      select: () => {
        world.selectedId = entity.id;
      },
    });
  }

  const selected = world.selected;
  if (selected !== null) items.push(...buildEntityItems(world, selected));

  items.push({ kind: "heading", label: "SCENE" });
  items.push({ kind: "action", label: "Save", run: () => world.save() });
  items.push({
    kind: "action",
    label: "Restore default scene",
    danger: true,
    run: () => world.loadDemo(),
  });

  return items;
};

/**
 * Os controles de um objeto só: os campos do tipo dele, mais o que todo objeto
 * tem.
 *
 * Separado de `buildObjectItems` porque tem dois destinos — a página de objetos
 * do menu e o painel lateral do editor, que mostra exatamente estes controles
 * sem a lista da cena em volta. Construir a mesma lista em dois lugares faria o
 * campo novo de um tipo aparecer em um e faltar no outro.
 */
export const buildEntityItems = (
  world: World,
  entity: EntityState,
): MenuItem[] => {
  const items: MenuItem[] = [
    { kind: "heading", label: entity.name.toUpperCase() },
  ];

  for (const field of ENTITY_KINDS[entity.kind].fields) {
    items.push(entityItem(field, entity));
  }

  items.push({
    kind: "toggle",
    label: "Solid",
    get: () => entity.solid,
    set: (value) => {
      entity.solid = value;
    },
  });
  items.push({
    kind: "toggle",
    label: "Cast shadows",
    get: () => entity.castsShadow,
    set: (value) => {
      entity.castsShadow = value;
    },
  });
  items.push({
    kind: "toggle",
    label: "Mirror",
    get: () => entity.mirror,
    set: (value) => {
      entity.mirror = value;
    },
  });
  items.push({
    kind: "action",
    label: "Delete",
    danger: true,
    run: () => {
      world.remove(entity.id);
    },
  });

  return items;
};

/**
 * Um campo do objeto vira o widget correspondente.
 *
 * O `switch` é sobre uma união fechada: um tipo de campo novo quebra aqui, em
 * vez de virar um controle mudo no meio do painel.
 */
const entityItem = (field: EntityField, entity: EntityState): MenuItem => {
  switch (field.kind) {
    case "choice":
      return {
        kind: "choice",
        label: field.label,
        options: field.options,
        get: () => field.get(entity),
        set: (value) => field.set(entity, value),
      };
    case "number":
      return {
        kind: "slider",
        label: field.label,
        min: field.min,
        max: field.max,
        step: field.step,
        digits: field.digits,
        suffix: field.suffix,
        get: () => field.get(entity),
        set: (value) => field.set(entity, value),
      };
  }
};
