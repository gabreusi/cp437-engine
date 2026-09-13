import type {Framebuffer} from "../../framebuffer";
import type {LightWorld} from "../../../light/world";
import {LIGHT_STRUCT_WGSL, LightUpload, OCCLUDER_STRUCT_WGSL, STAR_STRUCT_WGSL,} from "../light-upload";

/**
 * O kernel de luz (`light/shade.ts`, `light/trace.ts`, `light/sky.ts`) e a
 * escolha de glifo (`render/ramp.ts`), em WGSL — compute shader de verdade,
 * não um fragment shader disfarçado (ver `render/gl/passes/shading.ts`, a
 * versão WebGL2). Luzes e occluders chegam como `storage buffer` de structs
 * — `array[i]` é o item `i`, sem o empacotamento em texel que o backend
 * WebGL2 precisa.
 *
 * Um invocation por célula da grade (`@workgroup_size(8, 8)`), lendo o
 * mesmo G-buffer que `Framebuffer.plotDeferred` grava, e escrevendo nos
 * mesmos dois planos que `GridPass` (WebGPU) consome — o contrato entre CPU
 * e apresentação não mudou, só quem faz a conta do meio.
 */

const WORKGROUP_SIZE = 8;

const computeShaderSource = (): string => `
${LIGHT_STRUCT_WGSL}
${OCCLUDER_STRUCT_WGSL}
${STAR_STRUCT_WGSL}

struct Uniforms {
  ambient: vec4f,         // r,g,b,_
  cameraPos: vec4f,       // x,y,z,_
  sunDir: vec4f,          // x,y,z,_
  sunColor: vec4f,        // r,g,b,_
  skyParams: vec4f,       // sunIntensity, skyIntensity, sunGlow, horizonGlow
  skyParams2: vec4f,      // sunSpread, noiseSeed, hasGround, groundMirror
  groundAlbedo: vec4f,    // r,g,b, groundReflectivity
  groundEmissive: vec4f,  // r,g,b, groundEmissiveStrength
  groundGloss: vec4f,     // gloss, _, _, _
  shadowParams: vec4f,    // shadowsEnabled, shadowThreshold, maxShadowLights, groundFillLight
  rampParams: vec4f,      // rampWeight, rampExposure, emissiveRange, _
  counts: vec4f,          // lightCount, occluderCount, starCount, edgeNearCount
  counts2: vec4f,         // edgeFarCount, colCount, rowCount, _
};

@group(0) @binding(0) var<uniform> u: Uniforms;

@group(0) @binding(1) var cellsIn: texture_2d<f32>;
@group(0) @binding(2) var colorsIn: texture_2d<f32>;
@group(0) @binding(3) var fuseIn: texture_2d<f32>;

@group(0) @binding(4) var gPos: texture_2d<f32>;
@group(0) @binding(5) var gNormal: texture_2d<f32>;
@group(0) @binding(6) var gAlbedo: texture_2d<f32>;
@group(0) @binding(7) var gEmissive: texture_2d<f32>;
@group(0) @binding(8) var gShape: texture_2d<f32>;
@group(0) @binding(9) var gGloss: texture_2d<f32>;

@group(0) @binding(10) var<storage, read> lights: array<Light>;
@group(0) @binding(11) var<storage, read> occluders: array<Occluder>;
@group(0) @binding(12) var<storage, read> stars: array<Star>;

@group(0) @binding(13) var areaLut: texture_2d<f32>;
@group(0) @binding(14) var edgeNear: texture_2d<f32>;
@group(0) @binding(15) var edgeFar: texture_2d<f32>;

@group(0) @binding(16) var outCells: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(17) var outColors: texture_storage_2d<rgba8unorm, write>;

// ---------------------------------------------------------------------------
// Constantes que espelham light/shade.ts, light/trace.ts, render/ramp.ts.
// ---------------------------------------------------------------------------
const LIGHT_DIRECTIONAL = 0;
const OCCLUDER_SPHERE = 0;
const OCCLUDER_BOX = 1;

const HALF_POWER_SQ = 64.0;
const SHADOW_BIAS = 2e-3;
const SELF_SHADOW_FRACTION = 0.02;
const MIRROR_RANGE = 400.0;
const PARALLEL_EPSILON = 1e-9;

const WASH_WIDTH = 0.32;
const BAND_WIDTH = 0.06;
const GLOW_FALLOFF = 7.0;
const MIN_LOBE = 1.0;
const STAR_REFLECT_COS_THRESHOLD = 0.9997;
const STAR_REFLECT_STRENGTH = 0.6;

const CONTRAST_EXPONENT = 1.6;
const JITTER_CELL = 0.5;
const IRREGULAR_JITTER = 0.34;
const DEFAULT_LINE_HALF_THICKNESS = 0.1;
const EDGE_SHAPE_WINDOW = 56;
const AREA_LUT_LEVELS = 256.0;

const SKY_VOID = vec3f(0.02, 0.0, 0.055);
const SKY_PINK = vec3f(1.0, 0.235, 0.745);
const SKY_CYAN = vec3f(0.0, 0.886, 1.0);
const SKY_PURPLE = vec3f(0.29, 0.024, 0.408);
const SKY_HAZE = vec3f(0.1, 0.28, 0.36);
const SKY_WASH_WEIGHT = 0.3;
const SKY_GLOW_WEIGHT = 0.22;
const SKY_BAND_WEIGHT = 0.1;

// ---------------------------------------------------------------------------
// Ruído (math/noise.ts).
// ---------------------------------------------------------------------------
fn hashNoise(x: f32, y: f32) -> f32 {
  let wave = sin((x + u.skyParams2.y) * 12.9898 + (y + u.skyParams2.y) * 78.233) * 43758.5453;
  return wave - floor(wave);
}

fn jitterAt(p: vec3f) -> f32 {
  return hashNoise(
    floor(p.x / JITTER_CELL) * 3.71 + floor(p.z / JITTER_CELL) * 11.13,
    floor(p.y / JITTER_CELL)
  ) - 0.5;
}

// ---------------------------------------------------------------------------
// Céu (light/sky.ts).
// ---------------------------------------------------------------------------
fn skyRadiance(dir: vec3f, gloss: f32) -> vec3f {
  let sunDir = u.sunDir.xyz;
  let sunGlow = u.skyParams.z;
  let horizonGlow = u.skyParams.w;
  let sunSpread = u.skyParams2.x;
  let sunIntensity = u.skyParams.x;
  let skyIntensity = u.skyParams.y;

  let cosSun = dot(dir, sunDir);
  let horizon = sunGlow * horizonGlow;
  let wash = exp(-(dir.y * dir.y) / (WASH_WIDTH * WASH_WIDTH)) * horizon;
  let band = exp(-(dir.y * dir.y) / (BAND_WIDTH * BAND_WIDTH)) * horizon;
  let glow = exp(-(1.0 - cosSun) * (GLOW_FALLOFF / sunSpread)) * sunGlow;
  let lobe = select(pow(cosSun, max(MIN_LOBE, gloss)), 0.0, cosSun <= 0.0);
  let disc = lobe * sunIntensity;

  var c = SKY_VOID + SKY_PURPLE * wash * SKY_WASH_WEIGHT;
  c += SKY_CYAN * band * SKY_BAND_WEIGHT + SKY_PINK * glow * SKY_GLOW_WEIGHT;
  c += u.sunColor.xyz * disc;

  let starCount = i32(u.counts.z);
  if (dir.y >= 0.0) {
    for (var i = 0; i < starCount; i++) {
      let pos = stars[i].pos.xyz;
      let col = stars[i].color.xyz;
      let cosStar = dot(dir, pos);
      if (cosStar < STAR_REFLECT_COS_THRESHOLD) { continue; }
      let edge = (cosStar - STAR_REFLECT_COS_THRESHOLD) / (1.0 - STAR_REFLECT_COS_THRESHOLD);
      c += col * (edge * STAR_REFLECT_STRENGTH);
    }
  } else {
    let ground = min(1.0, -dir.y * 4.0);
    c += (SKY_HAZE * 0.25 - c) * ground;
  }

  return c * skyIntensity;
}

// ---------------------------------------------------------------------------
// Traçado de raio (light/trace.ts).
// ---------------------------------------------------------------------------
fn raySphere(o: vec3f, d: vec3f, center: vec3f, radius: f32) -> f32 {
  let c = o - center;
  let b = dot(c, d);
  let cc = dot(c, c) - radius * radius;
  let discriminant = b * b - cc;
  if (discriminant < 0.0) { return -1.0; }
  let root = sqrt(discriminant);
  let near = -b - root;
  if (near >= 0.0) { return near; }
  let far = -b + root;
  return select(-1.0, far, far >= 0.0);
}

struct SlabResult {
  ok: bool,
  entry: f32,
  exit: f32,
};

fn raySlab(o: f32, d: f32, h: f32, entryIn: f32, exitIn: f32) -> SlabResult {
  var entry = entryIn;
  var exit = exitIn;
  if (abs(d) < PARALLEL_EPSILON) {
    if (o < -h || o > h) {
      return SlabResult(false, entry, exit);
    }
    return SlabResult(true, entry, exit);
  }
  let inverse = 1.0 / d;
  var t0 = (-h - o) * inverse;
  var t1 = (h - o) * inverse;
  if (t0 > t1) {
    let swap = t0;
    t0 = t1;
    t1 = swap;
  }
  entry = max(entry, t0);
  exit = min(exit, t1);
  return SlabResult(entry <= exit, entry, exit);
}

fn occluderToLocal(idx: i32) -> mat4x4f {
  let occ = occluders[idx];
  return mat4x4f(occ.col0, occ.col1, occ.col2, occ.col3);
}

fn rayBox(o: vec3f, d: vec3f, idx: i32, half_: vec3f) -> f32 {
  let toLocal = occluderToLocal(idx);
  let lo = (toLocal * vec4f(o, 1.0)).xyz;
  let ld = (toLocal * vec4f(d, 0.0)).xyz;

  var slab = SlabResult(true, -1e30, 1e30);
  slab = raySlab(lo.x, ld.x, half_.x, slab.entry, slab.exit);
  if (!slab.ok) { return -1.0; }
  slab = raySlab(lo.y, ld.y, half_.y, slab.entry, slab.exit);
  if (!slab.ok) { return -1.0; }
  slab = raySlab(lo.z, ld.z, half_.z, slab.entry, slab.exit);
  if (!slab.ok) { return -1.0; }
  if (slab.exit < 0.0) { return -1.0; }
  return select(slab.exit, slab.entry, slab.entry >= 0.0);
}

fn rayOccluder(o: vec3f, d: vec3f, idx: i32) -> f32 {
  let occ = occluders[idx];
  let kind = i32(occ.row0.x + 0.5);
  if (kind == OCCLUDER_SPHERE) {
    return raySphere(o, d, occ.row0.yzw, occ.row1.x);
  }
  return rayBox(o, d, idx, occ.row1.yzw);
}

fn occludedBy(origin: vec3f, dir: vec3f, maxDistance: f32, ignoreId: f32) -> bool {
  let count = i32(u.counts.y);
  for (var i = 0; i < count; i++) {
    let occ = occluders[i];
    let castsShadow = occ.row9.w > 0.5;
    if (!castsShadow) { continue; }

    let kind = i32(occ.row0.x + 0.5);
    let ownerId = occ.row10.x;
    let isSelf = ownerId == ignoreId;
    if (isSelf && kind != OCCLUDER_BOX) { continue; }

    let hit = rayOccluder(origin, dir, i);
    let boundRadius = occ.row6.x;
    let bias = select(SHADOW_BIAS, max(SHADOW_BIAS, boundRadius * SELF_SHADOW_FRACTION), isSelf);
    if (hit > bias && hit < maxDistance) { return true; }
  }
  return false;
}

fn traceNearestIndex(origin: vec3f, dir: vec3f, maxDistance: f32, ignoreId: f32) -> i32 {
  var best = -1;
  var bestDistance = maxDistance;
  let count = i32(u.counts.y);
  for (var i = 0; i < count; i++) {
    let occ = occluders[i];
    let kind = i32(occ.row0.x + 0.5);
    let ownerId = occ.row10.x;
    let isSelf = ownerId == ignoreId;
    if (isSelf && kind == OCCLUDER_SPHERE) { continue; }

    let hit = rayOccluder(origin, dir, i);
    let boundRadius = occ.row6.x;
    let bias = select(SHADOW_BIAS, max(SHADOW_BIAS, boundRadius * SELF_SHADOW_FRACTION), isSelf);
    if (hit > bias && hit < bestDistance) {
      bestDistance = hit;
      best = i;
    }
  }
  return best;
}

fn boxNormal(idx: i32, localHit: vec3f, half_: vec3f) -> vec3f {
  let ax = abs(abs(localHit.x) - half_.x);
  let ay = abs(abs(localHit.y) - half_.y);
  let az = abs(abs(localHit.z) - half_.z);
  var localNormal: vec3f;
  if (ax <= ay && ax <= az) {
    localNormal = vec3f(sign(localHit.x), 0.0, 0.0);
  } else if (ay <= az) {
    localNormal = vec3f(0.0, sign(localHit.y), 0.0);
  } else {
    localNormal = vec3f(0.0, 0.0, sign(localHit.z));
  }
  // Local -> mundo pela transposta da parte rotacional de toLocal — mesma
  // técnica de math/mat4.ts::transformDirectionTransposed do lado CPU.
  let occ = occluders[idx];
  let r0 = vec3f(occ.col0.x, occ.col1.x, occ.col2.x);
  let r1 = vec3f(occ.col0.y, occ.col1.y, occ.col2.y);
  let r2 = vec3f(occ.col0.z, occ.col1.z, occ.col2.z);
  return normalize(vec3f(dot(localNormal, r0), dot(localNormal, r1), dot(localNormal, r2)));
}

struct MirrorHit {
  idx: i32,
  distance: f32,
  normal: vec3f,
};

/**
 * Como traceNearestIndex, mas também devolve o ponto e a normal do
 * acerto — o que o reflexo de corpo precisa para sombrear o ponto de
 * verdade em vez de usar uma cor média do corpo inteiro (Occluder.tint).
 * Recalcula a distância só para o vencedor (uma chamada extra), não por
 * candidato testado.
 */
fn traceNearestHit(origin: vec3f, dir: vec3f, maxDistance: f32, ignoreId: f32) -> MirrorHit {
  let idx = traceNearestIndex(origin, dir, maxDistance, ignoreId);
  if (idx < 0) {
    return MirrorHit(-1, 0.0, vec3f(0.0));
  }
  let occ = occluders[idx];
  let kind = i32(occ.row0.x + 0.5);
  let hitDistance = rayOccluder(origin, dir, idx);
  let hitPos = origin + dir * hitDistance;
  var normal: vec3f;
  if (kind == OCCLUDER_SPHERE) {
    normal = normalize(hitPos - occ.row0.yzw);
  } else {
    let toLocal = occluderToLocal(idx);
    let localHit = (toLocal * vec4f(hitPos, 1.0)).xyz;
    normal = boxNormal(idx, localHit, occ.row1.yzw);
  }
  return MirrorHit(idx, hitDistance, normal);
}

// ---------------------------------------------------------------------------
// Kernel de sombreamento (light/shade.ts).
// ---------------------------------------------------------------------------
fn faceNormal(n: vec3f, viewDir: vec3f) -> vec3f {
  return select(n, -n, dot(n, viewDir) < 0.0);
}

fn shadeCore(
  pos: vec3f, nIn: vec3f, viewDir: vec3f,
  albedo: vec3f, emissive: vec3f, emissiveStrength: f32,
  reflectivity: f32, gloss: f32,
  ambientOn: bool, shadowsAllowed: bool, ownerId: f32
) -> vec3f {
  let n = faceNormal(nIn, viewDir);
  var color = select(vec3f(0.0), u.ambient.xyz * albedo, ambientOn);
  let origin = pos + n * SHADOW_BIAS;

  let shadowsEnabled = u.shadowParams.x > 0.5;
  let shadowThreshold = u.shadowParams.y;
  let maxShadowLights = i32(u.shadowParams.z);
  let lightCount = i32(u.counts.x);

  var shadowRays = 0;
  for (var i = 0; i < lightCount; i++) {
    let light = lights[i];
    let kind = i32(light.row0.x + 0.5);
    let lightPos = light.row0.yzw;
    let lightAxis = light.row1.xyz;
    let lightColor = vec3f(light.row1.w, light.row2.x, light.row2.y);
    let intensity = light.row2.z;
    let range = light.row2.w;
    let castsShadow = light.row3.x > 0.5;
    let coneCos = light.row3.y;
    let coneSoftness = light.row3.z;
    let apertureOwnerId = light.row3.w;

    var lDir: vec3f;
    var distance: f32;
    if (kind == LIGHT_DIRECTIONAL) {
      lDir = lightAxis;
      distance = 1.0e29;
    } else {
      let delta = lightPos - pos;
      let distSq = dot(delta, delta);
      if (distSq > range * range) { continue; }
      distance = sqrt(distSq);
      lDir = select(vec3f(0.0), delta / distance, distance > 0.0);
    }

    var attenuation: f32;
    if (kind == LIGHT_DIRECTIONAL) {
      attenuation = 1.0;
    } else {
      let distSq = distance * distance;
      let ratio = distSq / (range * range);
      let window = max(0.0, 1.0 - ratio * ratio);
      attenuation = (window * window * HALF_POWER_SQ) / (distSq + HALF_POWER_SQ);
      if (coneCos > -1.0) {
        let cosAxis = -dot(lDir, lightAxis);
        if (cosAxis < coneCos) {
          attenuation = 0.0;
        } else {
          let edge = min(1.0, (cosAxis - coneCos) / coneSoftness);
          attenuation *= edge;
        }
      }
    }
    if (attenuation <= 0.0) { continue; }

    let ndotl = dot(n, lDir);
    if (ndotl <= 0.0) { continue; }

    let contribution = ndotl * attenuation * intensity;
    if (contribution < shadowThreshold) { continue; }

    if (apertureOwnerId >= 0.0) {
      // Luz de bounce (ver light/mirror-bounce.ts): o teste de abertura
      // substitui a sombra comum — o espelho que a gerou É a abertura por
      // onde ela passa, não um bloqueio. Sem isto ela vazaria por fora da
      // superfície real do espelho, como um segundo sol.
      let apIdx = traceNearestIndex(origin, lDir, distance, ownerId);
      if (apIdx < 0 || occluders[apIdx].row10.x != apertureOwnerId) { continue; }
    } else if (shadowsAllowed && shadowsEnabled && castsShadow && shadowRays < maxShadowLights) {
      shadowRays += 1;
      if (occludedBy(origin, lDir, distance, ownerId)) { continue; }
    }

    color += albedo * lightColor * contribution;

    if (reflectivity > 0.0) {
      let h = lDir + viewDir;
      let hLen = length(h);
      if (hLen > 0.0) {
        let hn = h / hLen;
        let ndoth = dot(n, hn);
        if (ndoth > 0.0) {
          let specular = pow(ndoth, gloss) * reflectivity * attenuation * intensity;
          color += lightColor * specular;
        }
      }
    }
  }

  color += emissive * emissiveStrength;
  return color;
}

fn reflectGround(origin: vec3f, dir: vec3f) -> vec4f {
  // .a > 0.5 sinaliza acerto — WGSL não tem saída "out bool" barata aqui.
  if (u.skyParams2.z < 0.5 || dir.y >= 0.0) { return vec4f(0.0); }
  let t = -origin.y / dir.y;
  if (!(t > SHADOW_BIAS) || t >= MIRROR_RANGE) { return vec4f(0.0); }

  let hitPos = vec3f(origin.x + dir.x * t, 0.0, origin.z + dir.z * t);
  let view = -dir;
  let shaded = shadeCore(
    hitPos, vec3f(0.0, 1.0, 0.0), view,
    u.groundAlbedo.xyz, u.groundEmissive.xyz, u.groundEmissive.w,
    0.0, u.groundGloss.x,
    true, false, -1.0
  );
  return vec4f(shaded, 1.0);
}

fn shadeSurface(
  pos: vec3f, nIn: vec3f, viewDir: vec3f,
  albedo: vec3f, emissive: vec3f, emissiveStrength: f32,
  reflectivity: f32, gloss: f32, mirror: bool,
  ambientOn: bool, reflectionsOn: bool, shadowsAllowed: bool, ownerId: f32
) -> vec3f {
  let n = faceNormal(nIn, viewDir);
  var color = shadeCore(
    pos, nIn, viewDir, albedo, emissive, emissiveStrength,
    reflectivity, gloss, ambientOn, shadowsAllowed, ownerId
  );

  if (reflectionsOn && reflectivity > 0.0) {
    let ndotv = dot(n, viewDir);
    let r = n * (2.0 * ndotv) - viewDir;
    let origin = pos + n * SHADOW_BIAS;

    var reflected = vec3f(0.0);
    var hit = false;
    if (mirror) {
      let mirrorHit = traceNearestHit(origin, r, MIRROR_RANGE, ownerId);
      if (mirrorHit.idx >= 0) {
        let occ = occluders[mirrorHit.idx];
        let hitPos = origin + r * mirrorHit.distance;
        // Um bounce: sombreia o ponto de verdade que o espelho vê, com a
        // luz (e a sombra) de quem bate nele — não uma cor média isotrópica
        // do corpo inteiro. shadeCore não faz reflexo, então não existe
        // recursão: sem espelho dentro de espelho.
        reflected = shadeCore(
          hitPos, mirrorHit.normal, -r,
          occ.row7.yzw, occ.row8.xyz, occ.row8.w,
          occ.row9.x, occ.row9.y,
          true, true, occ.row10.x
        );
        hit = true;
      }
    }
    if (!hit) {
      let ground = select(vec4f(0.0), reflectGround(origin, r), mirror);
      if (ground.w > 0.5) {
        reflected = ground.xyz;
      } else {
        reflected = skyRadiance(r, gloss);
      }
    }
    color += reflected * reflectivity;
  }

  return color;
}

// ---------------------------------------------------------------------------
// Rampa (render/ramp.ts, render/glyph-shape.ts).
// ---------------------------------------------------------------------------
fn compressLuminance(luminance: f32, exposure: f32) -> f32 {
  return select(1.0 - exp(-luminance * exposure), 0.0, luminance <= 0.0);
}

fn sampleAreaGlyph(luminance: f32, textureId: i32, raw: bool, worldPos: vec3f) -> f32 {
  var level = compressLuminance(luminance, u.rampParams.y);
  if (textureId == 2) {
    level = clamp(level + jitterAt(worldPos) * IRREGULAR_JITTER, 0.0, 1.0);
  }
  let row = textureId * 2 + select(1, 0, raw);
  let levelIndex = i32(clamp(level, 0.0, 1.0) * (AREA_LUT_LEVELS - 1.0) + 0.5);
  return textureLoad(areaLut, vec2i(levelIndex, row), 0).r * 255.0;
}

const INTERNAL_SAMPLES = array<vec2f, 6>(
  vec2f(1.0 / 6.0, 1.0 / 3.0 + 0.125),
  vec2f(1.0 / 6.0, 2.0 / 3.0 + 0.125),
  vec2f(3.0 / 6.0, 1.0 / 3.0),
  vec2f(3.0 / 6.0, 2.0 / 3.0),
  vec2f(5.0 / 6.0, 1.0 / 3.0 - 0.125),
  vec2f(5.0 / 6.0, 2.0 / 3.0 - 0.125),
);
const EXTERNAL_SAMPLES = array<vec2f, 12>(
  vec2f(1.0 / 6.0, -0.15),
  vec2f(3.0 / 6.0, -0.15),
  vec2f(5.0 / 6.0, -0.15),
  vec2f(1.0 / 6.0, 1.15),
  vec2f(3.0 / 6.0, 1.15),
  vec2f(5.0 / 6.0, 1.15),
  vec2f(-0.15, 1.0 / 3.0),
  vec2f(-0.15, 0.5),
  vec2f(-0.15, 2.0 / 3.0),
  vec2f(1.15, 1.0 / 3.0),
  vec2f(1.15, 0.5),
  vec2f(1.15, 2.0 / 3.0),
);
const AFFECTING_A = array<i32, 6>(6, 9, 7, 10, 8, 11);
const AFFECTING_B = array<i32, 6>(12, 14, -1, -1, 15, 17);

fn sampleLineCoverage(offsetCol: f32, offsetRow: f32, dirCol: f32, dirRow: f32) -> array<f32, 18> {
  let lineX = 0.5 + offsetCol;
  let lineY = 0.5 + offsetRow;
  var samples: array<f32, 18>;
  for (var i = 0; i < 6; i++) {
    let s = INTERNAL_SAMPLES[i];
    let d = abs((s.x - lineX) * dirRow - (s.y - lineY) * dirCol);
    samples[i] = max(0.0, 1.0 - d / DEFAULT_LINE_HALF_THICKNESS);
  }
  for (var i = 0; i < 12; i++) {
    let s = EXTERNAL_SAMPLES[i];
    let d = abs((s.x - lineX) * dirRow - (s.y - lineY) * dirCol);
    samples[6 + i] = max(0.0, 1.0 - d / DEFAULT_LINE_HALF_THICKNESS);
  }
  return samples;
}

fn boost(value: f32, referenceMax: f32) -> f32 {
  if (referenceMax <= 1e-4) { return value; }
  let normalized = min(1.0, value / referenceMax);
  return pow(normalized, CONTRAST_EXPONENT) * referenceMax;
}

fn enhanceContrast(samples: array<f32, 18>) -> array<f32, 6> {
  var shape: array<f32, 6>;
  for (var i = 0; i < 6; i++) {
    var refMax = samples[AFFECTING_A[i]];
    if (AFFECTING_B[i] >= 0) {
      refMax = max(refMax, samples[AFFECTING_B[i]]);
    }
    shape[i] = boost(samples[i], refMax);
  }
  return shape;
}

fn lowerBoundCoverage(pool: texture_2d<f32>, count: i32, value: f32) -> i32 {
  var lo = 0;
  var hi = count;
  for (var iter = 0; iter < 9; iter++) {
    if (lo >= hi) { break; }
    let mid = (lo + hi) / 2;
    let coverage = textureLoad(pool, vec2i(mid, 1), 0).b;
    if (coverage < value) { lo = mid + 1; } else { hi = mid; }
  }
  return lo;
}

fn nearestWeightedGlyphGPU(pool: texture_2d<f32>, count: i32, shape: array<f32, 6>, targetLevel: f32, weight: f32) -> f32 {
  var shapeCoverage = 0.0;
  for (var k = 0; k < 6; k++) { shapeCoverage += shape[k]; }
  shapeCoverage /= 6.0;

  let center = (shapeCoverage + weight * targetLevel) / (1.0 + weight);
  let half_ = EDGE_SHAPE_WINDOW / 2;
  let maxStart = max(0, count - EDGE_SHAPE_WINDOW);
  let start = clamp(lowerBoundCoverage(pool, count, center) - half_, 0, maxStart);
  let end = min(count, start + EDGE_SHAPE_WINDOW);

  var bestGlyph = 0.0;
  var bestDistance = 1.0e29;
  for (var i = 0; i < EDGE_SHAPE_WINDOW; i++) {
    let idx = start + i;
    if (idx >= end) { break; }
    let row0 = textureLoad(pool, vec2i(idx, 0), 0);
    let row1 = textureLoad(pool, vec2i(idx, 1), 0);
    var dist = 0.0;
    let d0 = shape[0] - row0.x; dist += d0 * d0;
    let d1 = shape[1] - row0.y; dist += d1 * d1;
    let d2 = shape[2] - row0.z; dist += d2 * d2;
    let d3 = shape[3] - row0.w; dist += d3 * d3;
    let d4 = shape[4] - row1.x; dist += d4 * d4;
    let d5 = shape[5] - row1.y; dist += d5 * d5;
    let levelDelta = targetLevel - row1.z;
    dist += weight * levelDelta * levelDelta;
    if (dist < bestDistance) {
      bestDistance = dist;
      bestGlyph = row1.w;
    }
  }
  return bestGlyph;
}

fn sampleEdgeGlyph(luminance: f32, offsetCol: f32, offsetRow: f32, dirCol: f32, dirRow: f32, near: bool, textureId: i32, worldPos: vec3f) -> f32 {
  let samples = sampleLineCoverage(offsetCol, offsetRow, dirCol, dirRow);
  let shape = enhanceContrast(samples);

  var level = compressLuminance(luminance, u.rampParams.y);
  if (textureId == 2) {
    level = clamp(level + jitterAt(worldPos) * IRREGULAR_JITTER, 0.0, 1.0);
  }

  let weight = u.rampParams.x;
  if (near) {
    return nearestWeightedGlyphGPU(edgeNear, i32(u.counts.w), shape, level, weight);
  }
  return nearestWeightedGlyphGPU(edgeFar, i32(u.counts2.x), shape, level, weight);
}

// ---------------------------------------------------------------------------

@compute @workgroup_size(${WORKGROUP_SIZE}, ${WORKGROUP_SIZE}, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let colCount = i32(u.counts2.y);
  let rowCount = i32(u.counts2.z);
  let cell = vec2i(i32(id.x), i32(id.y));
  if (cell.x >= colCount || cell.y >= rowCount) { return; }

  let cellsData = textureLoad(cellsIn, cell, 0);
  let alpha = cellsData.g;
  if (alpha <= 0.0) {
    textureStore(outCells, cell, vec4f(0.0));
    textureStore(outColors, cell, vec4f(0.0));
    return;
  }

  let colorsData = textureLoad(colorsIn, cell, 0);
  let opaque = colorsData.a > 0.5;
  let resolved = cellsData.a > 0.5;
  let emissiveRange = u.rampParams.z;

  var baseColor: vec3f;
  var baseEmissive: f32;
  var glyphIndex: f32;

  if (resolved) {
    baseColor = colorsData.rgb;
    baseEmissive = cellsData.b * emissiveRange;
    glyphIndex = cellsData.r * 255.0;
  } else {
    let posSample = textureLoad(gPos, cell, 0);
    let normSample = textureLoad(gNormal, cell, 0);
    let albedoSample = textureLoad(gAlbedo, cell, 0);
    let emisSample = textureLoad(gEmissive, cell, 0);
    let shapeSample = textureLoad(gShape, cell, 0);
    let gloss = textureLoad(gGloss, cell, 0).x;

    let worldPos = posSample.xyz;
    let ownerId = posSample.w;
    let normal = normSample.xyz;
    let flags = i32(normSample.w + 0.5);
    let isArea = (flags & 1) != 0;
    let variantBit = (flags & 2) != 0;
    let textureId = (flags >> 2) & 3;
    let mirror = (flags & 16) != 0;
    let ambientOn = (flags & 32) != 0;
    let reflectionsOn = (flags & 64) != 0;

    let viewDir = normalize(u.cameraPos.xyz - worldPos);
    let shaded = shadeSurface(
      worldPos, normal, viewDir,
      albedoSample.xyz, emisSample.xyz, emisSample.w,
      albedoSample.w, gloss, mirror,
      ambientOn, reflectionsOn, true, ownerId
    );
    let luminance = dot(shaded, vec3f(0.299, 0.587, 0.114));

    if (isArea && variantBit && luminance < u.shadowParams.w) {
      textureStore(outCells, cell, vec4f(0.0));
      textureStore(outColors, cell, vec4f(0.0));
      return;
    }

    let glyph = select(
      sampleEdgeGlyph(luminance, shapeSample.x, shapeSample.y, shapeSample.z, shapeSample.w, variantBit, textureId, worldPos),
      sampleAreaGlyph(luminance, textureId, variantBit, worldPos),
      isArea
    );

    let peak = max(1.0, max(shaded.r, max(shaded.g, shaded.b)));
    baseColor = shaded / peak;
    baseEmissive = peak - 1.0;
    glyphIndex = glyph;
  }

  let fuseData = textureLoad(fuseIn, cell, 0);
  let finalColor = clamp(baseColor + fuseData.rgb, vec3f(0.0), vec3f(1.0));
  let finalEmissive = baseEmissive + fuseData.a * emissiveRange;

  textureStore(outCells, cell, vec4f(glyphIndex / 255.0, alpha, clamp(finalEmissive / emissiveRange, 0.0, 1.0), 1.0));
  textureStore(outColors, cell, vec4f(finalColor, select(0.0, 1.0, opaque)));
}
`;

export class ShadingPass {
  private readonly lights: LightUpload;
  private readonly module: GPUShaderModule;
  private pipeline: GPUComputePipeline | null = null;
  private uniformBuffer: GPUBuffer;

  private colCount = 0;
  private rowCount = 0;

  private cellsIn: GPUTexture | null = null;
  private colorsIn: GPUTexture | null = null;
  private fuseIn: GPUTexture | null = null;
  private gPos: GPUTexture | null = null;
  private gNormal: GPUTexture | null = null;
  private gAlbedo: GPUTexture | null = null;
  private gEmissive: GPUTexture | null = null;
  private gShape: GPUTexture | null = null;
  private gGloss: GPUTexture | null = null;
  private cellsOut: GPUTexture | null = null;
  private colorsOut: GPUTexture | null = null;

  private areaLut: GPUTexture | null = null;
  private edgeNear: GPUTexture | null = null;
  private edgeNearCount = 0;
  private edgeFar: GPUTexture | null = null;
  private edgeFarCount = 0;

  private bindGroup: GPUBindGroup | null = null;
  private readonly uniformData = new Float32Array(16 * 4);
  private readonly noiseSeed = Math.random() * 10000;

  constructor(private readonly device: GPUDevice) {
    this.lights = new LightUpload(device);
    this.module = device.createShaderModule({
      label: "shading-compute",
      code: computeShaderSource(),
    });
    this.uniformBuffer = device.createBuffer({
      label: "shading-uniforms",
      size: this.uniformData.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.pipeline = device.createComputePipeline({
      label: "shading-pipeline",
      layout: "auto",
      compute: { module: this.module, entryPoint: "main" },
    });
  }

  get cellsTexture(): GPUTexture | null {
    return this.cellsOut;
  }

  get colorsTexture(): GPUTexture | null {
    return this.colorsOut;
  }

  resize(colCount: number, rowCount: number): void {
    if (this.colCount === colCount && this.rowCount === rowCount && this.cellsOut !== null) {
      return;
    }
    this.colCount = colCount;
    this.rowCount = rowCount;
    this.disposeTargets();

    const { device } = this;
    this.cellsIn = createSampledU8(device, colCount, rowCount, "cellsIn");
    this.colorsIn = createSampledU8(device, colCount, rowCount, "colorsIn");
    this.fuseIn = createSampledU8(device, colCount, rowCount, "fuseIn");
    this.gPos = createSampledF32(device, colCount, rowCount, "gPos");
    this.gNormal = createSampledF32(device, colCount, rowCount, "gNormal");
    this.gAlbedo = createSampledF32(device, colCount, rowCount, "gAlbedo");
    this.gEmissive = createSampledF32(device, colCount, rowCount, "gEmissive");
    this.gShape = createSampledF32(device, colCount, rowCount, "gShape");
    this.gGloss = createSampledF32(device, colCount, rowCount, "gGloss");
    this.cellsOut = createStorageU8(device, colCount, rowCount, "cellsOut");
    this.colorsOut = createStorageU8(device, colCount, rowCount, "colorsOut");

    this.rebuildBindGroup();
  }

  /** Chamado quando o atlas é (re)construído — mesma hora de `updateGlyphShapeTable`. */
  setGlyphLuts(
    areaLutData: Uint8Array<ArrayBuffer>,
    areaLutRows: number,
    areaLutLevels: number,
    edgeNearData: Float32Array<ArrayBuffer>,
    edgeNearCount: number,
    edgeFarData: Float32Array<ArrayBuffer>,
    edgeFarCount: number,
  ): void {
    const { device } = this;

    this.areaLut?.destroy();
    this.areaLut = device.createTexture({
      label: "area-lut",
      size: { width: areaLutLevels, height: areaLutRows },
      format: "r8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      { texture: this.areaLut },
      areaLutData,
      { bytesPerRow: areaLutLevels },
      { width: areaLutLevels, height: areaLutRows },
    );

    this.edgeNear?.destroy();
    this.edgeNear = uploadEdgePool(device, edgeNearData, edgeNearCount);
    this.edgeNearCount = edgeNearCount;

    this.edgeFar?.destroy();
    this.edgeFar = uploadEdgePool(device, edgeFarData, edgeFarCount);
    this.edgeFarCount = edgeFarCount;

    this.rebuildBindGroup();
  }

  private rebuildBindGroup(): void {
    if (
      this.pipeline === null ||
      this.cellsIn === null ||
      this.colorsIn === null ||
      this.fuseIn === null ||
      this.gPos === null ||
      this.gNormal === null ||
      this.gAlbedo === null ||
      this.gEmissive === null ||
      this.gShape === null ||
      this.gGloss === null ||
      this.cellsOut === null ||
      this.colorsOut === null ||
      this.areaLut === null ||
      this.edgeNear === null ||
      this.edgeFar === null
    ) {
      return;
    }

    this.bindGroup = this.device.createBindGroup({
      label: "shading-bind-group",
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: this.cellsIn.createView() },
        { binding: 2, resource: this.colorsIn.createView() },
        { binding: 3, resource: this.fuseIn.createView() },
        { binding: 4, resource: this.gPos.createView() },
        { binding: 5, resource: this.gNormal.createView() },
        { binding: 6, resource: this.gAlbedo.createView() },
        { binding: 7, resource: this.gEmissive.createView() },
        { binding: 8, resource: this.gShape.createView() },
        { binding: 9, resource: this.gGloss.createView() },
        { binding: 10, resource: { buffer: this.lights.lightsBuffer } },
        { binding: 11, resource: { buffer: this.lights.occludersBuffer } },
        { binding: 12, resource: { buffer: this.lights.starsBuffer } },
        { binding: 13, resource: this.areaLut.createView() },
        { binding: 14, resource: this.edgeNear.createView() },
        { binding: 15, resource: this.edgeFar.createView() },
        { binding: 16, resource: this.cellsOut.createView() },
        { binding: 17, resource: this.colorsOut.createView() },
      ],
    });
  }

  dispatch(
    encoder: GPUCommandEncoder,
    framebuffer: Framebuffer,
    world: LightWorld,
    cameraX: number,
    cameraY: number,
    cameraZ: number,
    options: {
      shadowsEnabled: boolean;
      shadowThreshold: number;
      maxShadowLights: number;
      groundFillLight: number;
      rampWeight: number;
      rampExposure: number;
      emissiveRange: number;
    },
  ): void {
    if (this.pipeline === null || this.bindGroup === null) return;
    if (this.cellsIn === null || this.colorsIn === null || this.fuseIn === null) return;
    if (
      this.gPos === null || this.gNormal === null || this.gAlbedo === null ||
      this.gEmissive === null || this.gShape === null || this.gGloss === null
    ) {
      return;
    }

    const { device } = this;
    writeU8Texture(device, this.cellsIn, this.colCount, this.rowCount, framebuffer.cells);
    writeU8Texture(device, this.colorsIn, this.colCount, this.rowCount, framebuffer.colors);
    writeU8Texture(device, this.fuseIn, this.colCount, this.rowCount, framebuffer.fuse);
    writeF32Texture(device, this.gPos, this.colCount, this.rowCount, framebuffer.gPos);
    writeF32Texture(device, this.gNormal, this.colCount, this.rowCount, framebuffer.gNormal);
    writeF32Texture(device, this.gAlbedo, this.colCount, this.rowCount, framebuffer.gAlbedo);
    writeF32Texture(device, this.gEmissive, this.colCount, this.rowCount, framebuffer.gEmissive);
    writeF32Texture(device, this.gShape, this.colCount, this.rowCount, framebuffer.gShape);
    writeF32Texture(device, this.gGloss, this.colCount, this.rowCount, framebuffer.gGloss);

    this.lights.upload(world);
    this.writeUniforms(cameraX, cameraY, cameraZ, options);

    const pass = encoder.beginComputePass({ label: "shading-pass" });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.dispatchWorkgroups(
      Math.ceil(this.colCount / WORKGROUP_SIZE),
      Math.ceil(this.rowCount / WORKGROUP_SIZE),
    );
    pass.end();
  }

  private writeUniforms(
    cameraX: number,
    cameraY: number,
    cameraZ: number,
    options: {
      shadowsEnabled: boolean;
      shadowThreshold: number;
      maxShadowLights: number;
      groundFillLight: number;
      rampWeight: number;
      rampExposure: number;
      emissiveRange: number;
    },
  ): void {
    const d = this.uniformData;
    const { sky } = this.lights;
    let o = 0;
    d[o++] = this.lights.ambientR; d[o++] = this.lights.ambientG; d[o++] = this.lights.ambientB; d[o++] = 0;
    d[o++] = cameraX; d[o++] = cameraY; d[o++] = cameraZ; d[o++] = 0;
    d[o++] = sky.sunDirX; d[o++] = sky.sunDirY; d[o++] = sky.sunDirZ; d[o++] = 0;
    d[o++] = sky.sunColorR; d[o++] = sky.sunColorG; d[o++] = sky.sunColorB; d[o++] = 0;
    d[o++] = sky.sunIntensity; d[o++] = sky.intensity; d[o++] = sky.sunGlow; d[o++] = sky.horizonGlow;
    d[o++] = sky.sunSpread; d[o++] = this.noiseSeed; d[o++] = sky.hasGround ? 1 : 0; d[o++] = sky.groundMirror ? 1 : 0;
    d[o++] = sky.groundAlbedoR; d[o++] = sky.groundAlbedoG; d[o++] = sky.groundAlbedoB; d[o++] = sky.groundReflectivity;
    d[o++] = sky.groundEmissiveR; d[o++] = sky.groundEmissiveG; d[o++] = sky.groundEmissiveB; d[o++] = sky.groundEmissiveStrength;
    d[o++] = sky.groundGloss; d[o++] = 0; d[o++] = 0; d[o++] = 0;
    d[o++] = options.shadowsEnabled ? 1 : 0; d[o++] = options.shadowThreshold; d[o++] = options.maxShadowLights; d[o++] = options.groundFillLight;
    d[o++] = options.rampWeight; d[o++] = options.rampExposure; d[o++] = options.emissiveRange; d[o++] = 0;
    d[o++] = this.lights.lightCount; d[o++] = this.lights.occluderCount; d[o++] = sky.starCount; d[o++] = this.edgeNearCount;
    d[o++] = this.edgeFarCount; d[o++] = this.colCount; d[o++] = this.rowCount; d[o++] = 0;

    this.device.queue.writeBuffer(this.uniformBuffer, 0, d);
  }

  private disposeTargets(): void {
    for (const tex of [
      this.cellsIn, this.colorsIn, this.fuseIn,
      this.gPos, this.gNormal, this.gAlbedo, this.gEmissive, this.gShape, this.gGloss,
      this.cellsOut, this.colorsOut,
    ]) {
      tex?.destroy();
    }
    this.cellsIn = null;
    this.colorsIn = null;
    this.fuseIn = null;
    this.gPos = null;
    this.gNormal = null;
    this.gAlbedo = null;
    this.gEmissive = null;
    this.gShape = null;
    this.gGloss = null;
    this.cellsOut = null;
    this.colorsOut = null;
  }

  dispose(): void {
    this.disposeTargets();
    this.areaLut?.destroy();
    this.edgeNear?.destroy();
    this.edgeFar?.destroy();
    this.uniformBuffer.destroy();
    this.lights.dispose();
  }
}

const createSampledU8 = (
  device: GPUDevice,
  width: number,
  height: number,
  label: string,
): GPUTexture =>
  device.createTexture({
    label,
    size: { width, height },
    format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });

const createSampledF32 = (
  device: GPUDevice,
  width: number,
  height: number,
  label: string,
): GPUTexture =>
  device.createTexture({
    label,
    size: { width, height },
    format: "rgba32float",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });

const createStorageU8 = (
  device: GPUDevice,
  width: number,
  height: number,
  label: string,
): GPUTexture =>
  device.createTexture({
    label,
    size: { width, height },
    format: "rgba8unorm",
    // COPY_SRC não é usado pelo GridPass (que só faz textureLoad), mas é o
    // que permite `GpuPresenter.readShadedPlanes` copiar de volta para a
    // CPU — a contraparte de `gl.readPixels` para `dumpGlyphs`/`countByColor`.
    usage:
      GPUTextureUsage.STORAGE_BINDING |
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_SRC,
  });

const writeU8Texture = (
  device: GPUDevice,
  texture: GPUTexture,
  width: number,
  height: number,
  data: Uint8Array<ArrayBuffer>,
): void => {
  device.queue.writeTexture(
    { texture },
    data,
    { bytesPerRow: width * 4 },
    { width, height },
  );
};

const writeF32Texture = (
  device: GPUDevice,
  texture: GPUTexture,
  width: number,
  height: number,
  data: Float32Array<ArrayBuffer>,
): void => {
  device.queue.writeTexture(
    { texture },
    data,
    { bytesPerRow: width * 16 },
    { width, height },
  );
};

/**
 * Reempacota o pool achatado (`buildEdgeShapePool`, 8 floats por candidato)
 * em duas fileiras de `count` texels — o mesmo leiaute que o backend WebGL2
 * usa (ver `render/gl/passes/shading.ts::uploadEdgePool`), só que a textura
 * de destino aqui já nasce no tamanho exato.
 */
const uploadEdgePool = (
  device: GPUDevice,
  data: Float32Array<ArrayBuffer>,
  count: number,
): GPUTexture => {
  const width = Math.max(1, count);
  const texture = device.createTexture({
    label: "edge-pool",
    size: { width, height: 2 },
    format: "rgba32float",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });

  if (count > 0) {
    const row0 = new Float32Array(count * 4);
    const row1 = new Float32Array(count * 4);
    for (let i = 0; i < count; i += 1) {
      const base = i * 8;
      row0[i * 4] = data[base]!;
      row0[i * 4 + 1] = data[base + 1]!;
      row0[i * 4 + 2] = data[base + 2]!;
      row0[i * 4 + 3] = data[base + 3]!;
      row1[i * 4] = data[base + 4]!;
      row1[i * 4 + 1] = data[base + 5]!;
      row1[i * 4 + 2] = data[base + 6]!;
      row1[i * 4 + 3] = data[base + 7]!;
    }
    device.queue.writeTexture(
      { texture, origin: { x: 0, y: 0 } },
      row0,
      { bytesPerRow: width * 16 },
      { width, height: 1 },
    );
    device.queue.writeTexture(
      { texture, origin: { x: 0, y: 1 } },
      row1,
      { bytesPerRow: width * 16 },
      { width, height: 1 },
    );
  }

  return texture;
};
