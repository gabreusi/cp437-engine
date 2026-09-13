import { copyRgb } from "../../math/color";
import { copy, set, type Vec3, vec3 } from "../../math/vec3";
import { OCCLUDER } from "../../light/types";
import type { LightWorld } from "../../light/world";
import type { SurfacePen } from "../../render/shading";
import type { RenderContext } from "../scene";
import { BoxShape } from "./box";
import { TEXTURE } from "../../render/ramp";
import {
  colorFields,
  COMMON_FIELDS,
  type EntityKindDef,
  type EntityState,
  ROTATION_FIELDS,
  sizeFields,
  TEXTURE_FIELD
} from "./entity";
import { hatchFace } from "./hatch";

/**
 * Placa refletiva: onde o raio de espelho tem o que mostrar.
 *
 * A face é preenchida com hachura — linhas paralelas próximas — e não com um
 * rasterizador de polígono novo. Duas razões: reaproveita inteiro o caminho de
 * clipping, DDA e profundidade que já existe, e mantém a identidade da engine,
 * onde tudo é linha. O custo é o mesmo de desenhar as linhas, e cada fragmento
 * ganha posição de mundo de graça, que é o que o reflexo precisa.
 */

const shape = new BoxShape();
const start: Vec3 = vec3();
const end: Vec3 = vec3();

export const panelKind: EntityKindDef = {
  label: "Panel",

  defaults: () => ({
    name: "panel",
    size: { x: 6, y: 4, z: 0.25 },
    color: { r: 0.72, g: 0.86, b: 1 },
    intensity: 0.18,
    reflectivity: 0.92,
    gloss: 220,
    mirror: true,
    castsShadow: true,
    texture: TEXTURE.SMOOTH,
    position: { x: -12, y: 5, z: -26 },
    yaw: 0.5,
  }),

  contribute: (entity: EntityState, world: LightWorld): void => {
    shape.update(
      entity.current,
      entity.yaw,
      entity.pitch,
      entity.size.x,
      entity.size.y,
      entity.size.z,
    );

    const occluder = world.addOccluder(entity.id);
    occluder.kind = OCCLUDER.BOX;
    copy(occluder.center, entity.current);
    copy(occluder.half, entity.size);
    occluder.toLocal.set(shape.toLocal);
    occluder.castsShadow = entity.castsShadow;
    // Só a face z=+halfZ é desenhada como espelho (hatchFace(..., 2, 1, ...)
    // em render(), abaixo) — a traseira não tem superfície própria nenhuma,
    // só existe geometricamente para o traçado. Declarar o eixo local
    // impede um segundo bounce de tratá-la como espelho também.
    set(occluder.mirrorFaceAxis, 0, 0, 1);

    // Mesma leitura do material que `render` monta para `pen` — é o que
    // `shadeOccluders` usa para calcular a cor de verdade que um espelho vê
    // deste corpo, com a luz que bate nele.
    const { mirrorMaterial } = entity;
    copyRgb(mirrorMaterial.albedo, entity.color);
    copyRgb(mirrorMaterial.emissive, entity.color);
    mirrorMaterial.emissiveStrength = entity.intensity;
    mirrorMaterial.reflectivity = entity.reflectivity;
    mirrorMaterial.gloss = entity.gloss;
    mirrorMaterial.mirror = entity.mirror;
    occluder.material = mirrorMaterial;
  },

  render: (
    entity: EntityState,
    context: RenderContext,
    pen: SurfacePen,
  ): void => {
    const { rasterizer } = context;
    shape.update(
      entity.current,
      entity.yaw,
      entity.pitch,
      entity.size.x,
      entity.size.y,
      entity.size.z,
    );

    pen.ownerId = entity.id;
    copyRgb(pen.material.albedo, entity.color);
    copyRgb(pen.material.emissive, entity.color);
    pen.material.emissiveStrength = entity.intensity;
    pen.material.reflectivity = entity.reflectivity;
    pen.material.gloss = entity.gloss;
    pen.material.mirror = entity.mirror;
    pen.texture = entity.texture;

    // A face é o plano local z = +meia-espessura: é uma placa plana, não uma
    // caixa, então só ela é preenchida — e a hachura é a mesma que enche as
    // faces do monólito, com a mesma decisão de densidade.
    const { x: halfX, y: halfY, z: halfZ } = entity.size;
    hatchFace(shape, context, entity.size, 2, 1, pen);

    // Moldura, por cima da hachura: ela é a borda da placa, e na aresta as
    // duas caem na mesma profundidade.
    const edge = (x0: number, y0: number, x1: number, y1: number): void => {
      shape.toWorldPoint(x0, y0, halfZ, start);
      shape.toWorldPoint(x1, y1, halfZ, end);
      rasterizer.line(
        start.x,
        start.y,
        start.z,
        end.x,
        end.y,
        end.z,
        pen.style,
      );
    };

    edge(-halfX, -halfY, halfX, -halfY);
    edge(-halfX, halfY, halfX, halfY);
    edge(-halfX, -halfY, -halfX, halfY);
    edge(halfX, -halfY, halfX, halfY);
  },

  fields: [
    ...COMMON_FIELDS,
    ...ROTATION_FIELDS,
    ...sizeFields(["Width", "Height", "Depth"]),
    ...colorFields(),
    TEXTURE_FIELD,
    {
      kind: "number",
      label: "Reflectivity",
      min: 0,
      max: 1,
      step: 0.02,
      digits: 2,
      get: (e) => e.reflectivity,
      set: (e, v) => {
        e.reflectivity = v;
      },
    },
    {
      kind: "number",
      label: "Gloss",
      min: 2,
      max: 400,
      step: 2,
      get: (e) => e.gloss,
      set: (e, v) => {
        e.gloss = v;
      },
    },
    {
      kind: "number",
      label: "Glow intensity",
      min: 0,
      max: 2,
      step: 0.02,
      digits: 2,
      get: (e) => e.intensity,
      set: (e, v) => {
        e.intensity = v;
      },
    },
  ],
};
