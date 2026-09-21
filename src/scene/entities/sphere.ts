import { copyRgb } from "../../math/color";
import { copy, type Vec3, vec3 } from "../../math/vec3";
import { OCCLUDER } from "../../light/types";
import { raySphere } from "../../light/trace";
import type { LightWorld } from "../../light/world";
import { TEXTURE, TEXTURE_ID } from "../../render/ramp";
import { createDeferredSurface } from "../../render/framebuffer";
import { createProjected } from "../../render/rasterizer";
import type { RenderContext } from "../scene";
import {
  colorFields,
  COMMON_FIELDS,
  type EntityKindDef,
  type EntityState,
  TEXTURE_FIELD,
} from "./entity";

/**
 * Esfera sólida, sem luz própria: o análogo redondo do monólito.
 *
 * Ao contrário do orbe (que é sempre luz e desenha um disco resolvido, sem
 * G-buffer — ver `orb.ts`), esta gera fragmentos deferidos de verdade: por
 * célula do disco em tela, um raio contra a própria esfera (`raySphere`,
 * `light/trace.ts`) dá a posição de mundo e a normal exatas do ponto de
 * acerto — a mesma fórmula que `traceNearestHit` usa para sombra e reflexo.
 * É isso que permite receber luz, projetar sombra e espelhar de verdade, e é
 * o que falta ao orbe fazer o mesmo.
 *
 * Luz secundária de espelho funciona aqui também, mas não pelo mesmo
 * caminho da caixa (`light/mirror-bounce.ts`): como a esfera não tem uma
 * normal única, o ponto de contato certo depende de quem está *recebendo*
 * a luz, não só de quem a emite — por isso é resolvido por fragmento, na
 * GPU (`sphereMirrorBounce`, `render/gpu/passes/shading.ts`), por iteração,
 * em vez de pré-calculado uma vez por quadro na CPU como a caixa. O reflexo
 * *visual* (a esfera aparecer refletida, e mostrar reflexo nela) é
 * independente disso: já funciona por ser uma superfície deferida comum.
 */

const projected = createProjected();
const ray: Vec3 = vec3();
const deferred = createDeferredSurface();

/**
 * Folga sobre `radiusRowsAt` para o teste de raio por célula, que é exato,
 * não perder um pixel da borda que a aproximação de disco plano (comentário
 * de `radiusRowsAt`) erra para dentro quando a esfera está grande na tela.
 */
const RADIUS_MARGIN = 1.08;

export const sphereKind: EntityKindDef = {
  label: "Sphere",
  uniformSize: true,

  defaults: () => ({
    name: "sphere",
    size: { x: 2, y: 2, z: 2 },
    color: { r: 0.8, g: 0.85, b: 0.9 },
    reflectivity: 0.3,
    gloss: 60,
    castsShadow: true,
    solid: true,
    mirror: false,
    texture: TEXTURE.SMOOTH,
    position: { x: -10, y: 3, z: -25 },
  }),

  contribute: (entity: EntityState, world: LightWorld): void => {
    const occluder = world.addOccluder(entity.id);
    occluder.kind = OCCLUDER.SPHERE;
    copy(occluder.center, entity.current);
    occluder.radius = entity.size.x;
    occluder.castsShadow = entity.castsShadow;

    // Mesma leitura do material que `render` monta para a superfície — é o
    // que `shadeOccluders` usa para a cor de verdade que um espelho mostra
    // deste corpo. Ao contrário do orbe, alimenta albedo de verdade: esta
    // esfera recebe luz, não emite.
    const { mirrorMaterial } = entity;
    copyRgb(mirrorMaterial.albedo, entity.color);
    copyRgb(mirrorMaterial.emissive, entity.color);
    mirrorMaterial.emissiveStrength = 0;
    mirrorMaterial.reflectivity = entity.reflectivity;
    mirrorMaterial.gloss = entity.gloss;
    mirrorMaterial.mirror = entity.mirror;
    occluder.material = mirrorMaterial;
  },

  render: (entity: EntityState, context: RenderContext): void => {
    const { rasterizer, camera } = context;
    const { current } = entity;

    if (!rasterizer.project(current.x, current.y, current.z, projected)) return;

    const depth = projected.depth;
    const radiusRows =
      rasterizer.radiusRowsAt(entity.size.x, depth) * RADIUS_MARGIN;

    const surface = deferred;
    surface.ownerId = entity.id;
    surface.albedoR = entity.color.r;
    surface.albedoG = entity.color.g;
    surface.albedoB = entity.color.b;
    surface.emissiveR = 0;
    surface.emissiveG = 0;
    surface.emissiveB = 0;
    surface.emissiveStrength = 0;
    surface.reflectivity = entity.reflectivity;
    surface.gloss = entity.gloss;
    surface.mirror = entity.mirror;
    surface.textureId = TEXTURE_ID[entity.texture];
    surface.area = true;

    const { forward, position } = camera;

    rasterizer.disc(projected, radiusRows, rasterizer.lastRow, (col, row) => {
      rasterizer.rayThrough(col + 0.5, row + 0.5, ray);
      const t = raySphere(
        position.x,
        position.y,
        position.z,
        ray.x,
        ray.y,
        ray.z,
        current,
        entity.size.x,
      );
      if (t < 0) return;

      const hitX = position.x + ray.x * t;
      const hitY = position.y + ray.y * t;
      const hitZ = position.z + ray.z * t;
      // O raio é unitário: a distância ao longo dele não é a profundidade de
      // view que o z-buffer compara. A projeção sobre o eixo da câmera
      // converte uma na outra — mesma conta de `Ground.fillLitFloor`.
      const cellDepth =
        t * (ray.x * forward.x + ray.y * forward.y + ray.z * forward.z);
      if (cellDepth <= 0) return;

      surface.worldX = hitX;
      surface.worldY = hitY;
      surface.worldZ = hitZ;
      surface.normalX = (hitX - current.x) / entity.size.x;
      surface.normalY = (hitY - current.y) / entity.size.x;
      surface.normalZ = (hitZ - current.z) / entity.size.x;

      // `solid` decide se ela bloqueia o que está atrás, como qualquer outro
      // corpo — sem hachura por baixo, `opaque` não tem de onde herdar.
      rasterizer.plotCellDeferred(col, row, cellDepth, 1, entity.solid, surface);
    });
  },

  fields: [
    ...COMMON_FIELDS,
    {
      kind: "number",
      label: "Radius",
      min: 0.2,
      max: 12,
      step: 0.1,
      digits: 1,
      get: (e) => e.size.x,
      set: (e, v) => {
        e.size.x = v;
        e.size.y = v;
        e.size.z = v;
      },
    },
    ...colorFields(),
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
    TEXTURE_FIELD,
  ],
};
