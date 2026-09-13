import { LIGHT, OCCLUDER } from "../../light/types";
import type { LightWorld } from "../../light/world";

/**
 * `LightWorld` para a GPU: o mesmo pool que `light/shade.ts` e `light/trace.ts`
 * já leem na CPU, achatado em texturas pequenas — luzes e occluders não mudam
 * de forma de um quadro para o outro, só de conteúdo, então a textura é
 * alocada uma vez e só o `texSubImage2D` roda por quadro.
 *
 * Chamado depois de `Scene.contribute()` (`scene.ts`): só aí `finalize()` e
 * `shadeOccluders()` já rodaram, e todo `Light`/`Occluder` do quadro está
 * definitivo — a mesma hora em que `light/shade.ts` os lê hoje.
 */

export const MAX_LIGHTS = 64;
export const MAX_OCCLUDERS = 64;
export const MAX_REFLECTED_STARS = 200;

const LIGHT_ROWS = 4;
const OCCLUDER_ROWS = 11;

/**
 * Escreve um texel em `data`, um `Float32Array` row-major do jeito que
 * `texSubImage2D` espera: a fileira `row` inteira (todo `item` de 0 a
 * `width-1`) vem contígua antes da próxima fileira — não o contrário
 * (`item` por fora, fileira por dentro), que é o engano fácil de cometer
 * pensando "um item, todos os seus campos" em vez de "uma fileira da
 * textura, todos os itens dela".
 */
const setTexel = (
  data: Float32Array,
  width: number,
  item: number,
  row: number,
  a: number,
  b: number,
  c: number,
  d: number,
): void => {
  const offset = (row * width + item) * 4;
  data[offset] = a;
  data[offset + 1] = b;
  data[offset + 2] = c;
  data[offset + 3] = d;
};

const createFloatTexture = (
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
): WebGLTexture => {
  const texture = gl.createTexture();
  if (texture === null) throw new Error("Não foi possível criar textura de luz.");
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, width, height);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
};

export interface SkyUniforms {
  sunDirX: number;
  sunDirY: number;
  sunDirZ: number;
  sunColorR: number;
  sunColorG: number;
  sunColorB: number;
  sunIntensity: number;
  intensity: number;
  sunGlow: number;
  horizonGlow: number;
  sunSpread: number;
  hasGround: boolean;
  groundAlbedoR: number;
  groundAlbedoG: number;
  groundAlbedoB: number;
  groundEmissiveR: number;
  groundEmissiveG: number;
  groundEmissiveB: number;
  groundEmissiveStrength: number;
  groundReflectivity: number;
  groundGloss: number;
  groundMirror: boolean;
  starCount: number;
}

export class LightUpload {
  readonly lightsTexture: WebGLTexture;
  readonly occludersTexture: WebGLTexture;
  readonly starsTexture: WebGLTexture;

  private readonly lightData = new Float32Array(MAX_LIGHTS * LIGHT_ROWS * 4);
  private readonly occluderData = new Float32Array(
    MAX_OCCLUDERS * OCCLUDER_ROWS * 4,
  );
  private readonly starData = new Float32Array(MAX_REFLECTED_STARS * 2 * 4);

  lightCount = 0;
  occluderCount = 0;
  readonly sky: SkyUniforms = {
    sunDirX: 0,
    sunDirY: 1,
    sunDirZ: 0,
    sunColorR: 1,
    sunColorG: 1,
    sunColorB: 1,
    sunIntensity: 1,
    intensity: 1,
    sunGlow: 1,
    horizonGlow: 1,
    sunSpread: 1,
    hasGround: false,
    groundAlbedoR: 0,
    groundAlbedoG: 0,
    groundAlbedoB: 0,
    groundEmissiveR: 0,
    groundEmissiveG: 0,
    groundEmissiveB: 0,
    groundEmissiveStrength: 0,
    groundReflectivity: 0,
    groundGloss: 24,
    groundMirror: false,
    starCount: 0,
  };
  ambientR = 0;
  ambientG = 0;
  ambientB = 0;

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.lightsTexture = createFloatTexture(gl, MAX_LIGHTS, LIGHT_ROWS);
    this.occludersTexture = createFloatTexture(gl, MAX_OCCLUDERS, OCCLUDER_ROWS);
    this.starsTexture = createFloatTexture(gl, MAX_REFLECTED_STARS, 2);
  }

  /** Achata `world` nos arrays da CPU e sobe as três texturas para a GPU. */
  upload(world: LightWorld): void {
    this.ambientR = world.ambient.r;
    this.ambientG = world.ambient.g;
    this.ambientB = world.ambient.b;

    const { sky } = world;
    Object.assign(this.sky, {
      sunDirX: sky.sunDirection.x,
      sunDirY: sky.sunDirection.y,
      sunDirZ: sky.sunDirection.z,
      sunColorR: sky.sunColor.r,
      sunColorG: sky.sunColor.g,
      sunColorB: sky.sunColor.b,
      sunIntensity: sky.sunIntensity,
      intensity: sky.intensity,
      sunGlow: sky.sunGlow,
      horizonGlow: sky.horizonGlow,
      sunSpread: sky.sunSpread,
    });

    const ground = world.groundMaterial;
    this.sky.hasGround = ground !== null;
    if (ground !== null) {
      this.sky.groundAlbedoR = ground.albedo.r;
      this.sky.groundAlbedoG = ground.albedo.g;
      this.sky.groundAlbedoB = ground.albedo.b;
      this.sky.groundEmissiveR = ground.emissive.r;
      this.sky.groundEmissiveG = ground.emissive.g;
      this.sky.groundEmissiveB = ground.emissive.b;
      this.sky.groundEmissiveStrength = ground.emissiveStrength;
      this.sky.groundReflectivity = ground.reflectivity;
      this.sky.groundGloss = ground.gloss;
      this.sky.groundMirror = ground.mirror;
    }

    this.lightCount = Math.min(MAX_LIGHTS, world.lightCount);
    for (let i = 0; i < this.lightCount; i += 1) {
      const light = world.light(i);
      const d = this.lightData;
      setTexel(d, MAX_LIGHTS, i, 0, light.kind, light.position.x, light.position.y, light.position.z);
      setTexel(d, MAX_LIGHTS, i, 1, light.direction.x, light.direction.y, light.direction.z, light.color.r);
      setTexel(d, MAX_LIGHTS, i, 2, light.color.g, light.color.b, light.intensity, light.range);
      setTexel(d, MAX_LIGHTS, i, 3, light.castsShadow ? 1 : 0, light.coneCos, light.coneSoftness, 0);
    }

    this.occluderCount = Math.min(MAX_OCCLUDERS, world.occluderCount);
    for (let i = 0; i < this.occluderCount; i += 1) {
      const occluder = world.occluder(i);
      const d = this.occluderData;
      setTexel(d, MAX_OCCLUDERS, i, 0, occluder.kind, occluder.center.x, occluder.center.y, occluder.center.z);
      setTexel(d, MAX_OCCLUDERS, i, 1, occluder.radius, occluder.half.x, occluder.half.y, occluder.half.z);
      // toLocal: quatro colunas de mat4, na mesma ordem column-major que
      // `math/mat4.ts` usa — o shader remonta com `mat4(c0, c1, c2, c3)`.
      const { toLocal } = occluder;
      setTexel(d, MAX_OCCLUDERS, i, 2, toLocal[0]!, toLocal[1]!, toLocal[2]!, toLocal[3]!);
      setTexel(d, MAX_OCCLUDERS, i, 3, toLocal[4]!, toLocal[5]!, toLocal[6]!, toLocal[7]!);
      setTexel(d, MAX_OCCLUDERS, i, 4, toLocal[8]!, toLocal[9]!, toLocal[10]!, toLocal[11]!);
      setTexel(d, MAX_OCCLUDERS, i, 5, toLocal[12]!, toLocal[13]!, toLocal[14]!, toLocal[15]!);
      setTexel(d, MAX_OCCLUDERS, i, 6, occluder.boundRadius, occluder.tint.r, occluder.tint.g, occluder.tint.b);
      const material = occluder.material;
      setTexel(
        d, MAX_OCCLUDERS, i, 7,
        material !== null ? 1 : 0,
        material?.albedo.r ?? 0,
        material?.albedo.g ?? 0,
        material?.albedo.b ?? 0,
      );
      setTexel(
        d, MAX_OCCLUDERS, i, 8,
        material?.emissive.r ?? 0,
        material?.emissive.g ?? 0,
        material?.emissive.b ?? 0,
        material?.emissiveStrength ?? 0,
      );
      setTexel(
        d, MAX_OCCLUDERS, i, 9,
        material?.reflectivity ?? 0,
        material?.gloss ?? 24,
        material?.mirror ? 1 : 0,
        occluder.castsShadow ? 1 : 0,
      );
      setTexel(d, MAX_OCCLUDERS, i, 10, occluder.ownerId, 0, 0, 0);
    }

    this.sky.starCount = Math.min(MAX_REFLECTED_STARS, sky.stars.length);
    for (let i = 0; i < this.sky.starCount; i += 1) {
      const star = sky.stars[i]!;
      const d = this.starData;
      setTexel(d, MAX_REFLECTED_STARS, i, 0, star.x, star.y, star.z, 0);
      setTexel(d, MAX_REFLECTED_STARS, i, 1, star.color.r, star.color.g, star.color.b, 0);
    }

    const { gl } = this;
    gl.bindTexture(gl.TEXTURE_2D, this.lightsTexture);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      MAX_LIGHTS,
      LIGHT_ROWS,
      gl.RGBA,
      gl.FLOAT,
      this.lightData,
    );
    gl.bindTexture(gl.TEXTURE_2D, this.occludersTexture);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      MAX_OCCLUDERS,
      OCCLUDER_ROWS,
      gl.RGBA,
      gl.FLOAT,
      this.occluderData,
    );
    gl.bindTexture(gl.TEXTURE_2D, this.starsTexture);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      MAX_REFLECTED_STARS,
      2,
      gl.RGBA,
      gl.FLOAT,
      this.starData,
    );
  }

  dispose(): void {
    this.gl.deleteTexture(this.lightsTexture);
    this.gl.deleteTexture(this.occludersTexture);
    this.gl.deleteTexture(this.starsTexture);
  }
}

// Reexportados para o shader não precisar de outro import para os números
// de `LIGHT`/`OCCLUDER` — o kernel GLSL compara contra os mesmos valores.
export { LIGHT, OCCLUDER };
