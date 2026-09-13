import { copyRgb, type Rgb, rgb, scaleRgb, setRgb } from "../../math/color";
import { copy, cross, normalize, set, type Vec3, vec3 } from "../../math/vec3";
import { LIGHT, OCCLUDER } from "../../light/types";
import type { LightWorld } from "../../light/world";
import { GLYPH } from "../../render/palette";
import { createProjected, type SurfaceStyle } from "../../render/rasterizer";
import type { SurfacePen } from "../../render/shading";
import type { RenderContext } from "../scene";
import {
  colorFields,
  COMMON_FIELDS,
  type EntityKindDef,
  type EntityState,
  ROTATION_FIELDS,
} from "./entity";

/**
 * Holofote: cone de luz configurável em alcance (`range`), cor e abertura
 * (`coneAngle`). Como o orbe, é fonte de luz — desenha a si mesma direto no
 * rasterizador, sem passar por `shadeSurface`; o recorte do feixe em si
 * (quem recebe luz e quem fica de fora do cone) já é feito por
 * `light/shade.ts` via `coneCos`/`coneSoftness`, não por nada aqui.
 *
 * O feixe em si vive em `renderGlow`, não em `render`: ele não é superfície,
 * é incidência (`Fragment.fuse`) sobre o que já estiver na frente da câmera
 * — uma parede, o chão, nada. Rodar depois que `render` de toda a cena
 * terminou é o que garante que essa superfície já está na grade para o feixe
 * tingir, sem depender da ordem em que os objetos foram criados. A carcaça
 * continua em `render`: é corpo de verdade, do mesmo jeito que o orbe.
 */

const DEGREES = 180 / Math.PI;

/** Fixa: não foi pedida como ajuste, calibrada uma vez para a escala da cena. */
const CONE_SOFTNESS = 0.12;

/** O cone real vai até `range`, mas desenhar arestas do tamanho da sala
 * inteira polui a leitura mais do que ajuda — é só indicação de mira. */
const MAX_BEAM_DRAW_LENGTH = 12;

const casingProjected = createProjected();
const direction: Vec3 = vec3();
const right: Vec3 = vec3();
const up: Vec3 = vec3();
const beamEnd: Vec3 = vec3();
const edgeEnd: Vec3 = vec3();
const beamTint: Rgb = rgb();

const beamStyle: SurfaceStyle = (sample, out) => {
  out.glyph = GLYPH.DOT;
  copyRgb(out.color, beamTint);
  out.alpha = 0.8;
  out.emissive = 0.5;
  // Explícito: `out` é reaproveitado entre estilos do quadro — sem isto o
  // feixe herdaria `opaque=true` de uma parede hachurada desenhada antes
  // dele e passaria a bloquear o que está atrás, o oposto do efeito.
  out.opaque = false;
  // O feixe não tem corpo: onde já houver parede ou chão desenhado, tinge
  // por cima (ver `Fragment.fuse`) em vez de trocar o glifo e abrir buraco
  // nela. Onde não houver nada ainda, desenha o ponto normalmente.
  out.fuse = true;
  // Resolvida, não adiada: sem isto herdaria `isDeferred=true` de uma parede
  // ou linha de chão desenhada antes no mesmo quadro (o fragmento é
  // reaproveitado entre todos os estilos) e o feixe seria sombreado com o
  // material de outro objeto na posição errada, em vez de tingir com a
  // própria cor — exatamente o "caractere sem cor, pisca aleatório" que essa
  // omissão produz.
  out.isDeferred = false;
  return sample.depth > 0;
};

export const spotlightKind: EntityKindDef = {
  label: "Spotlight",
  uniformSize: true, // a carcaça é uma esfera pequena, como o orbe

  defaults: () => ({
    name: "spotlight",
    size: { x: 0.5, y: 0.5, z: 0.5 },
    color: { r: 1, g: 0.92, b: 0.78 },
    intensity: 12,
    range: 20,
    coneAngle: (35 * Math.PI) / 180,
    castsShadow: false,
    pitch: -1.2, // ~ -69°, mira de teto por padrão
    position: { x: 0, y: 8, z: -20 },
  }),

  contribute: (entity: EntityState, world: LightWorld): void => {
    const light = world.addLight();
    light.kind = LIGHT.SPOT;
    copy(light.position, entity.current);
    copyRgb(light.color, entity.color);
    light.intensity = entity.intensity;
    light.range = entity.range;
    light.castsShadow = true;

    const cy = Math.cos(entity.yaw);
    const sy = Math.sin(entity.yaw);
    const cp = Math.cos(entity.pitch);
    const sp = Math.sin(entity.pitch);
    set(light.direction, -cp * sy, sp, -cp * cy);

    light.coneCos = Math.cos(entity.coneAngle / 2);
    light.coneSoftness = CONE_SOFTNESS;

    // Carcaça: mesmo papel do corpo do orbe — o que o clique acerta, e o
    // que um espelho vê. Não projeta sombra por padrão pela mesma razão.
    const occluder = world.addOccluder(entity.id);
    occluder.kind = OCCLUDER.SPHERE;
    copy(occluder.center, entity.current);
    occluder.radius = entity.size.x;
    occluder.castsShadow = entity.castsShadow;

    // Emissor puro, mesmo tratamento do orbe: sem albedo, brilho todo no
    // emissivo, mesmo fator hand-tuned de antes.
    const { mirrorMaterial } = entity;
    setRgb(mirrorMaterial.albedo, 0, 0, 0);
    copyRgb(mirrorMaterial.emissive, entity.color);
    mirrorMaterial.emissiveStrength = Math.min(2, entity.intensity * 0.15);
    occluder.material = mirrorMaterial;
  },

  render: (entity: EntityState, context: RenderContext, _pen: SurfacePen): void => {
    const { rasterizer } = context;
    const { current } = entity;

    if (!rasterizer.project(current.x, current.y, current.z, casingProjected)) {
      return;
    }

    // --- Carcaça: disco pequeno, mesma técnica do orbe (`orb.ts`). Corpo
    // sólido, não traço — ver o comentário equivalente em `orb.ts`. ---
    const depth = casingProjected.depth;
    const radiusRows = rasterizer.radiusRowsAt(entity.size.x, depth);
    if (radiusRows < 0.7) {
      rasterizer.plot(casingProjected, GLYPH.BULLET, entity.color, 1, 0.5, true);
    } else {
      rasterizer.disc(casingProjected, radiusRows, rasterizer.lastRow, (col, row, nx, ny) => {
        const falloff = Math.max(0, 1 - (nx * nx + ny * ny) * 0.6);
        rasterizer.plotCell(col, row, GLYPH.BULLET, entity.color, depth, 1, 1.2 * falloff, true);
      });
    }
  },

  renderGlow: (entity: EntityState, context: RenderContext, _pen: SurfacePen): void => {
    const { rasterizer } = context;
    const { current, yaw, pitch } = entity;

    // --- Eixo + silhueta do cone: só o que a engine sabe desenhar, linha. ---
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    const cp = Math.cos(pitch);
    const sp = Math.sin(pitch);
    set(direction, -cp * sy, sp, -cp * cy);

    // `right` só depende do yaw (mesma base do `Camera.right`): nunca
    // degenera mesmo mirando reto para baixo, onde `up-mundo × direction`
    // daria vetor nulo.
    set(right, cy, 0, -sy);
    cross(up, right, direction);
    normalize(up, up);

    const length = Math.min(entity.range, MAX_BEAM_DRAW_LENGTH);
    const spread = length * Math.tan(entity.coneAngle / 2);

    scaleRgb(beamTint, entity.color, 0.85);
    set(
      beamEnd,
      current.x + direction.x * length,
      current.y + direction.y * length,
      current.z + direction.z * length,
    );
    rasterizer.line(current.x, current.y, current.z, beamEnd.x, beamEnd.y, beamEnd.z, beamStyle);

    scaleRgb(beamTint, entity.color, 0.55);
    const spokes: readonly [number, number][] = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ];
    for (const [rs, us] of spokes) {
      set(
        edgeEnd,
        beamEnd.x + right.x * spread * rs + up.x * spread * us,
        beamEnd.y + right.y * spread * rs + up.y * spread * us,
        beamEnd.z + right.z * spread * rs + up.z * spread * us,
      );
      rasterizer.line(current.x, current.y, current.z, edgeEnd.x, edgeEnd.y, edgeEnd.z, beamStyle);
    }
  },

  fields: [
    ...COMMON_FIELDS,
    ...ROTATION_FIELDS,
    {
      kind: "number",
      label: "Radius",
      min: 0.2,
      max: 2,
      step: 0.05,
      digits: 2,
      get: (e) => e.size.x,
      set: (e, v) => {
        e.size.x = v;
        e.size.y = v;
        e.size.z = v;
      },
    },
    {
      kind: "number",
      label: "Beam angle",
      min: 5,
      max: 120,
      step: 1,
      suffix: "°",
      get: (e) => e.coneAngle * DEGREES,
      set: (e, v) => {
        e.coneAngle = v / DEGREES;
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
      max: 80,
      step: 1,
      get: (e) => e.range,
      set: (e, v) => {
        e.range = v;
      },
    },
    ...colorFields(),
  ],
};
