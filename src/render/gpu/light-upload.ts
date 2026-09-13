import type { LightWorld } from "../../light/world";

/**
 * `LightWorld` para o compute shader: um `storage buffer` por pool, array de
 * structs — não a textura row-major que o backend WebGL2 precisava (ver
 * `render/gl/light-upload.ts`). Cada struct WGSL é só `vec4f`s, para nunca
 * discutir regra de alinhamento: um campo de três componentes ocupa a mesma
 * fileira de um de quatro, e o quarto vira folga ou carrega o próximo escalar
 * solto — o mesmo truque que o array `Float32Array` já usava, só que agora
 * `array[i]` é literalmente o item `i`, sem transpor linha/coluna.
 */

export const MAX_LIGHTS = 64;
export const MAX_OCCLUDERS = 64;
export const MAX_REFLECTED_STARS = 200;

/** Quatro `vec4f` por luz — ver `LIGHT_STRUCT_WGSL`. */
const LIGHT_STRIDE = 16;
/** Onze `vec4f` por occluder — ver `OCCLUDER_STRUCT_WGSL`. */
const OCCLUDER_STRIDE = 44;
/** Dois `vec4f` por estrela. */
const STAR_STRIDE = 8;

/** As mesmas structs, para o WGSL do compute shader importar por template. */
export const LIGHT_STRUCT_WGSL = `
struct Light {
  row0: vec4f, // kind, pos.x, pos.y, pos.z
  row1: vec4f, // dir.x, dir.y, dir.z, color.r
  row2: vec4f, // color.g, color.b, intensity, range
  row3: vec4f, // castsShadow, coneCos, coneSoftness, _
};`;

export const OCCLUDER_STRUCT_WGSL = `
struct Occluder {
  row0: vec4f,  // kind, center.x, center.y, center.z
  row1: vec4f,  // radius, half.x, half.y, half.z
  col0: vec4f,  // toLocal, coluna 0
  col1: vec4f,  // toLocal, coluna 1
  col2: vec4f,  // toLocal, coluna 2
  col3: vec4f,  // toLocal, coluna 3
  row6: vec4f,  // boundRadius, tint.r, tint.g, tint.b
  row7: vec4f,  // hasMaterial, albedo.r, albedo.g, albedo.b
  row8: vec4f,  // emissive.r, emissive.g, emissive.b, emissiveStrength
  row9: vec4f,  // reflectivity, gloss, mirror, castsShadow
  row10: vec4f, // ownerId, _, _, _
};`;

export const STAR_STRUCT_WGSL = `
struct Star {
  pos: vec4f,   // x, y, z, _
  color: vec4f, // r, g, b, _
};`;

export interface SkyUniformValues {
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
  readonly lightsBuffer: GPUBuffer;
  readonly occludersBuffer: GPUBuffer;
  readonly starsBuffer: GPUBuffer;

  private readonly lightData = new Float32Array(MAX_LIGHTS * LIGHT_STRIDE);
  private readonly occluderData = new Float32Array(
    MAX_OCCLUDERS * OCCLUDER_STRIDE,
  );
  private readonly starData = new Float32Array(MAX_REFLECTED_STARS * STAR_STRIDE);

  lightCount = 0;
  occluderCount = 0;
  readonly sky: SkyUniformValues = {
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

  constructor(private readonly device: GPUDevice) {
    this.lightsBuffer = device.createBuffer({
      label: "lights",
      size: this.lightData.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.occludersBuffer = device.createBuffer({
      label: "occluders",
      size: this.occluderData.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.starsBuffer = device.createBuffer({
      label: "stars",
      size: this.starData.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
  }

  /** Achata `world` nos arrays da CPU e sobe os três buffers para a GPU. */
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
      const base = i * LIGHT_STRIDE;
      d[base + 0] = light.kind;
      d[base + 1] = light.position.x;
      d[base + 2] = light.position.y;
      d[base + 3] = light.position.z;
      d[base + 4] = light.direction.x;
      d[base + 5] = light.direction.y;
      d[base + 6] = light.direction.z;
      d[base + 7] = light.color.r;
      d[base + 8] = light.color.g;
      d[base + 9] = light.color.b;
      d[base + 10] = light.intensity;
      d[base + 11] = light.range;
      d[base + 12] = light.castsShadow ? 1 : 0;
      d[base + 13] = light.coneCos;
      d[base + 14] = light.coneSoftness;
      d[base + 15] = 0;
    }

    this.occluderCount = Math.min(MAX_OCCLUDERS, world.occluderCount);
    for (let i = 0; i < this.occluderCount; i += 1) {
      const occluder = world.occluder(i);
      const d = this.occluderData;
      const base = i * OCCLUDER_STRIDE;
      d[base + 0] = occluder.kind;
      d[base + 1] = occluder.center.x;
      d[base + 2] = occluder.center.y;
      d[base + 3] = occluder.center.z;
      d[base + 4] = occluder.radius;
      d[base + 5] = occluder.half.x;
      d[base + 6] = occluder.half.y;
      d[base + 7] = occluder.half.z;
      // toLocal: quatro colunas de mat4, na mesma ordem column-major de
      // `math/mat4.ts` — o shader remonta com `mat4x4f(col0, col1, col2, col3)`.
      d.set(occluder.toLocal.subarray(0, 4), base + 8);
      d.set(occluder.toLocal.subarray(4, 8), base + 12);
      d.set(occluder.toLocal.subarray(8, 12), base + 16);
      d.set(occluder.toLocal.subarray(12, 16), base + 20);
      d[base + 24] = occluder.boundRadius;
      d[base + 25] = occluder.tint.r;
      d[base + 26] = occluder.tint.g;
      d[base + 27] = occluder.tint.b;
      const material = occluder.material;
      d[base + 28] = material !== null ? 1 : 0;
      d[base + 29] = material?.albedo.r ?? 0;
      d[base + 30] = material?.albedo.g ?? 0;
      d[base + 31] = material?.albedo.b ?? 0;
      d[base + 32] = material?.emissive.r ?? 0;
      d[base + 33] = material?.emissive.g ?? 0;
      d[base + 34] = material?.emissive.b ?? 0;
      d[base + 35] = material?.emissiveStrength ?? 0;
      d[base + 36] = material?.reflectivity ?? 0;
      d[base + 37] = material?.gloss ?? 24;
      d[base + 38] = material?.mirror ? 1 : 0;
      d[base + 39] = occluder.castsShadow ? 1 : 0;
      d[base + 40] = occluder.ownerId;
      d[base + 41] = 0;
      d[base + 42] = 0;
      d[base + 43] = 0;
    }

    this.sky.starCount = Math.min(MAX_REFLECTED_STARS, sky.stars.length);
    for (let i = 0; i < this.sky.starCount; i += 1) {
      const star = sky.stars[i]!;
      const d = this.starData;
      const base = i * STAR_STRIDE;
      d[base + 0] = star.x;
      d[base + 1] = star.y;
      d[base + 2] = star.z;
      d[base + 3] = 0;
      d[base + 4] = star.color.r;
      d[base + 5] = star.color.g;
      d[base + 6] = star.color.b;
      d[base + 7] = 0;
    }

    const { device } = this;
    device.queue.writeBuffer(this.lightsBuffer, 0, this.lightData);
    device.queue.writeBuffer(this.occludersBuffer, 0, this.occluderData);
    device.queue.writeBuffer(this.starsBuffer, 0, this.starData);
  }

  dispose(): void {
    this.lightsBuffer.destroy();
    this.occludersBuffer.destroy();
    this.starsBuffer.destroy();
  }
}
