import { copyRgb, luminance, type Rgb, rgb, scaleRgb } from "../../math/color";
import { copy } from "../../math/vec3";
import { LIGHT, OCCLUDER } from "../../light/types";
import type { LightWorld } from "../../light/world";
import { glyphForDiscShape, glyphForLuminance } from "../../render/ramp";
import { CELL_ASPECT } from "../../render/viewport";
import { createProjected } from "../../render/rasterizer";
import type { SurfacePen } from "../../render/shading";
import type { RenderContext } from "../scene";
import { colorFields, COMMON_FIELDS, type EntityKindDef, type EntityState } from "./entity";

/**
 * Esfera emissiva: a luz colorida e o que se vê dela.
 *
 * É desenhada como disco em espaço de tela, do mesmo jeito que o sol, porque um
 * corpo redondo sempre encara a câmera — mas a distância é finita, então o raio
 * na tela vem do tamanho em mundo dividido pela profundidade, e não de um
 * ângulo fixo. Andar em volta dele o vê crescer, que é o que separa um objeto
 * de um corpo celeste.
 *
 * Ele não projeta sombra, e não é descuido: o raio de sombra que sai do chão em
 * direção à luz terminaria dentro da própria esfera que a representa, e o orbe
 * apagaria a si mesmo.
 */

const projected = createProjected();
const tint: Rgb = rgb();

/** Queda do brilho do centro para a borda. Dá volume ao disco chapado. */
const EDGE_FALLOFF = 0.62;

export const orbKind: EntityKindDef = {
  label: "Orb",
  uniformSize: true,

  defaults: () => ({
    name: "orb",
    size: { x: 2.2, y: 2.2, z: 2.2 },
    intensity: 5,
    range: 10,
    castsShadow: false,
    position: { x: 0, y: 4, z: -22 },
  }),

  contribute: (entity: EntityState, world: LightWorld): void => {
    const light = world.addLight();
    light.kind = LIGHT.POINT;
    copy(light.position, entity.current);
    copyRgb(light.color, entity.color);
    light.intensity = entity.intensity;
    light.range = entity.range;
    light.castsShadow = true;

    // O corpo entra mesmo sem projetar sombra: é ele que o clique acerta
    // para selecionar, e o que um espelho mostra.
    const occluder = world.addOccluder(entity.id);
    occluder.kind = OCCLUDER.SPHERE;
    copy(occluder.center, entity.current);
    occluder.radius = entity.size.x;
    occluder.castsShadow = entity.castsShadow;
    scaleRgb(occluder.tint, entity.color, Math.min(2, entity.intensity * 0.3));
  },

  render: (
    entity: EntityState,
    context: RenderContext,
    pen: SurfacePen,
  ): void => {
    const { rasterizer } = context;
    const { current } = entity;

    if (!rasterizer.project(current.x, current.y, current.z, projected)) return;

    const depth = projected.depth;
    const radiusRows = rasterizer.radiusRowsAt(entity.size.x, depth);
    const base =
      luminance(entity.color) * Math.max(0.4, entity.intensity * 0.28);

    if (radiusRows < 0.7) {
      // Longe demais para ter área: uma célula acesa ainda lê como ponto
      // de luz, e sumir seria pior do que isso.
      rasterizer.plot(projected, "*".charCodeAt(0), entity.color, 1, base);
      return;
    }

    const { rampMode, rampExposure } = pen.lit;
    const radiusCols = radiusRows * CELL_ASPECT;

    rasterizer.disc(
      projected,
      radiusRows,
      rasterizer.lastRow,
      (col, row, nx, ny) => {
        const falloff = Math.max(0, 1 - (nx * nx + ny * ny) * EDGE_FALLOFF);
        const brightness = base * falloff;

        // O disco é fonte de luz, não superfície: não passa pelo kernel de
        // sombreamento porque não há nada para iluminá-lo.
        const peak = Math.max(1, brightness);
        scaleRgb(tint, entity.color, Math.min(1, brightness));

        rasterizer.plotCell(
          col,
          row,
          glyphForLuminance(
            brightness,
            glyphForDiscShape(nx, ny, radiusCols, radiusRows),
            rampMode,
            rampExposure,
          ),
          tint,
          depth,
          1,
          peak - 1,
        );
      },
    );
  },

  fields: [
    ...COMMON_FIELDS,
    {
      kind: "number",
      label: "Radius",
      min: 0.2,
      max: 8,
      step: 0.1,
      digits: 1,
      get: (e) => e.size.x,
      set: (e, v) => {
        e.size.x = v;
        e.size.y = v;
        e.size.z = v;
      },
    },
    {
      kind: "number",
      label: "Glow intensity",
      min: 0,
      max: 40,
      step: 0.5,
      digits: 1,
      get: (e) => e.intensity,
      set: (e, v) => {
        e.intensity = v;
      },
    },
    {
      kind: "number",
      label: "Range",
      min: 2,
      max: 160,
      step: 2,
      get: (e) => e.range,
      set: (e, v) => {
        e.range = v;
      },
    },
    ...colorFields(),
    {
      kind: "number",
      label: "Orbit Radius",
      min: 0,
      max: 60,
      step: 0.5,
      digits: 1,
      get: (e) => e.orbitRadius,
      set: (e, v) => {
        e.orbitRadius = v;
      },
    },
    {
      kind: "number",
      label: "speed",
      min: -2,
      max: 2,
      step: 0.05,
      digits: 2,
      get: (e) => e.orbitSpeed,
      set: (e, v) => {
        e.orbitSpeed = v;
      },
    },
  ],
};
