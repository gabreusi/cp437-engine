import type { Framebuffer } from "../../framebuffer";
import type { LightWorld } from "../../../light/world";
import { FULLSCREEN_VERTEX, drawFullscreen } from "../fullscreen";
import { Program } from "../program";
import { LightUpload } from "../light-upload";

/**
 * O kernel de luz da CPU (`light/shade.ts`, `light/trace.ts`, `light/sky.ts`)
 * e a escolha de glifo (`render/ramp.ts`, `render/glyph-shape.ts`), portados
 * para GLSL e rodando em paralelo, uma vez por célula — não uma vez por
 * célula *por luz* somado sequencialmente numa só thread, que é o que
 * `sceneMs` media antes.
 *
 * Roda em resolução de grade (colCount × rowCount), não de pixel: um
 * invocation por célula. A CPU (`Framebuffer.plotDeferred`, `SurfacePen`,
 * `Ground`) só decide *quem* vence cada célula — geometria, não luz — e
 * entrega um G-buffer cru; este passo decide a cor.
 *
 * Saída: as duas mesmas data textures que `GridPass` já sabia ler
 * (`cells`/`colors`), agora geradas aqui em vez de vir direto da CPU — o
 * fragment shader de `grid.ts` não muda uma linha.
 */

const FRAGMENT_SOURCE = `#version 300 es
precision highp float;

layout(location = 0) out vec4 outCells;
layout(location = 1) out vec4 outColors;

uniform sampler2D uCellsIn;
uniform sampler2D uColorsIn;
uniform sampler2D uFuseIn;

uniform sampler2D uGPos;
uniform sampler2D uGNormal;
uniform sampler2D uGAlbedo;
uniform sampler2D uGEmissive;
uniform sampler2D uGShape;
uniform sampler2D uGGloss;

uniform sampler2D uLights;
uniform int uLightCount;
uniform sampler2D uOccluders;
uniform int uOccluderCount;
uniform sampler2D uStars;
uniform int uStarCount;

uniform sampler2D uAreaLut;
uniform sampler2D uEdgeNear;
uniform int uEdgeNearCount;
uniform sampler2D uEdgeFar;
uniform int uEdgeFarCount;

uniform vec3 uAmbient;
uniform vec3 uCameraPos;
uniform float uNoiseSeed;

uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform float uSkyIntensity;
uniform float uSunGlow;
uniform float uHorizonGlow;
uniform float uSunSpread;

uniform float uHasGround;
uniform vec3 uGroundAlbedo;
uniform vec3 uGroundEmissive;
uniform float uGroundEmissiveStrength;
uniform float uGroundReflectivity;
uniform float uGroundGloss;
uniform float uGroundMirror;

uniform float uShadowsEnabled;
uniform float uShadowThreshold;
uniform int uMaxShadowLights;
uniform float uGroundFillLight;

uniform float uRampWeight;
uniform float uRampExposure;
uniform float uEmissiveRange;

// -- Constantes que espelham light/shade.ts, light/trace.ts, render/ramp.ts --
const int LIGHT_DIRECTIONAL = 0;
const int OCCLUDER_SPHERE = 0;
const int OCCLUDER_BOX = 1;

const float HALF_POWER_SQ = 64.0; // HALF_POWER_DISTANCE = 8
const float SHADOW_BIAS = 2e-3;
const float SELF_SHADOW_FRACTION = 0.02;
const float MIRROR_RANGE = 400.0;
const float PARALLEL_EPSILON = 1e-9;

const float WASH_WIDTH = 0.32;
const float BAND_WIDTH = 0.06;
const float GLOW_FALLOFF = 7.0;
const float MIN_LOBE = 1.0;
const float STAR_REFLECT_COS_THRESHOLD = 0.9997;
const float STAR_REFLECT_STRENGTH = 0.6;

const float CONTRAST_EXPONENT = 1.6;
const float JITTER_CELL = 0.5;
const float IRREGULAR_JITTER = 0.34;
const float DEFAULT_LINE_HALF_THICKNESS = 0.1;
const int EDGE_SHAPE_WINDOW = 56;
const float AREA_LUT_LEVELS = 256.0;

const vec3 SKY_VOID = vec3(0.02, 0.0, 0.055);
const vec3 SKY_PINK = vec3(1.0, 0.235, 0.745);
const vec3 SKY_CYAN = vec3(0.0, 0.886, 1.0);
const vec3 SKY_PURPLE = vec3(0.29, 0.024, 0.408);
const vec3 SKY_HAZE = vec3(0.1, 0.28, 0.36);
const float SKY_WASH_WEIGHT = 0.3;
const float SKY_GLOW_WEIGHT = 0.22;
const float SKY_BAND_WEIGHT = 0.1;

// ---------------------------------------------------------------------------
// Ruído (math/noise.ts) — só usado pela textura "irregular".
// ---------------------------------------------------------------------------
float hashNoise(float x, float y) {
    float wave = sin((x + uNoiseSeed) * 12.9898 + (y + uNoiseSeed) * 78.233) * 43758.5453;
    return wave - floor(wave);
}

float jitterAt(vec3 p) {
    return hashNoise(
        floor(p.x / JITTER_CELL) * 3.71 + floor(p.z / JITTER_CELL) * 11.13,
        floor(p.y / JITTER_CELL)
    ) - 0.5;
}

// ---------------------------------------------------------------------------
// Céu (light/sky.ts).
// ---------------------------------------------------------------------------
vec3 skyRadiance(vec3 dir, float gloss) {
    float cosSun = dot(dir, uSunDir);
    float horizon = uSunGlow * uHorizonGlow;
    float wash = exp(-(dir.y * dir.y) / (WASH_WIDTH * WASH_WIDTH)) * horizon;
    float band = exp(-(dir.y * dir.y) / (BAND_WIDTH * BAND_WIDTH)) * horizon;
    float glow = exp(-(1.0 - cosSun) * (GLOW_FALLOFF / uSunSpread)) * uSunGlow;
    float lobe = cosSun <= 0.0 ? 0.0 : pow(cosSun, max(MIN_LOBE, gloss));
    float disc = lobe * uSunIntensity;

    vec3 c = SKY_VOID + SKY_PURPLE * wash * SKY_WASH_WEIGHT;
    c += SKY_CYAN * band * SKY_BAND_WEIGHT + SKY_PINK * glow * SKY_GLOW_WEIGHT;
    c += uSunColor * disc;

    if (dir.y >= 0.0) {
        for (int i = 0; i < uStarCount; i++) {
            vec4 pos = texelFetch(uStars, ivec2(i, 0), 0);
            vec4 col = texelFetch(uStars, ivec2(i, 1), 0);
            float cosStar = dot(dir, pos.xyz);
            if (cosStar < STAR_REFLECT_COS_THRESHOLD) continue;
            float edge = (cosStar - STAR_REFLECT_COS_THRESHOLD) / (1.0 - STAR_REFLECT_COS_THRESHOLD);
            c += col.rgb * (edge * STAR_REFLECT_STRENGTH);
        }
    } else {
        float ground = min(1.0, -dir.y * 4.0);
        c += (SKY_HAZE * 0.25 - c) * ground;
    }

    return c * uSkyIntensity;
}

// ---------------------------------------------------------------------------
// Traçado de raio (light/trace.ts).
// ---------------------------------------------------------------------------
float raySphere(vec3 o, vec3 d, vec3 center, float radius) {
    vec3 c = o - center;
    float b = dot(c, d);
    float cc = dot(c, c) - radius * radius;
    float discriminant = b * b - cc;
    if (discriminant < 0.0) return -1.0;
    float root = sqrt(discriminant);
    float near = -b - root;
    if (near >= 0.0) return near;
    float far = -b + root;
    return far >= 0.0 ? far : -1.0;
}

float raySlab(float o, float d, float h, inout float entry, inout float exit) {
    if (abs(d) < PARALLEL_EPSILON) {
        if (o < -h || o > h) return -1.0;
        return 0.0;
    }
    float inverse = 1.0 / d;
    float t0 = (-h - o) * inverse;
    float t1 = (h - o) * inverse;
    if (t0 > t1) { float swap = t0; t0 = t1; t1 = swap; }
    if (t0 > entry) entry = t0;
    if (t1 < exit) exit = t1;
    return entry > exit ? -1.0 : 0.0;
}

// Colunas de toLocal nas fileiras 2..5 do occluder idx — ver light-upload.ts.
mat4 occluderToLocal(int idx) {
    return mat4(
        texelFetch(uOccluders, ivec2(idx, 2), 0),
        texelFetch(uOccluders, ivec2(idx, 3), 0),
        texelFetch(uOccluders, ivec2(idx, 4), 0),
        texelFetch(uOccluders, ivec2(idx, 5), 0)
    );
}

float rayBox(vec3 o, vec3 d, int idx, vec3 half_) {
    mat4 toLocal = occluderToLocal(idx);
    vec3 lo = (toLocal * vec4(o, 1.0)).xyz;
    vec3 ld = (toLocal * vec4(d, 0.0)).xyz;

    float entry = -1e30;
    float exit = 1e30;
    if (raySlab(lo.x, ld.x, half_.x, entry, exit) < 0.0) return -1.0;
    if (raySlab(lo.y, ld.y, half_.y, entry, exit) < 0.0) return -1.0;
    if (raySlab(lo.z, ld.z, half_.z, entry, exit) < 0.0) return -1.0;
    if (exit < 0.0) return -1.0;
    return entry >= 0.0 ? entry : exit;
}

float rayOccluder(vec3 o, vec3 d, int idx) {
    vec4 row0 = texelFetch(uOccluders, ivec2(idx, 0), 0);
    vec4 row1 = texelFetch(uOccluders, ivec2(idx, 1), 0);
    int kind = int(row0.x + 0.5);
    if (kind == OCCLUDER_SPHERE) {
        return raySphere(o, d, row0.yzw, row1.x);
    }
    return rayBox(o, d, idx, row1.yzw);
}

bool occludedBy(vec3 origin, vec3 dir, float maxDistance, float ignoreId) {
    for (int i = 0; i < uOccluderCount; i++) {
        vec4 row0 = texelFetch(uOccluders, ivec2(i, 0), 0);
        vec4 row9 = texelFetch(uOccluders, ivec2(i, 9), 0);
        vec4 row10 = texelFetch(uOccluders, ivec2(i, 10), 0);
        bool castsShadow = row9.w > 0.5;
        if (!castsShadow) continue;

        int kind = int(row0.x + 0.5);
        float ownerId = row10.x;
        bool isSelf = ownerId == ignoreId;
        // Esfera não distingue acne de sombra própria de verdade (ver
        // SELF_SHADOW_FRACTION em trace.ts) — ignora o próprio corpo
        // inteiro. Caixa usa o bias maior abaixo em vez de pular o teste.
        if (isSelf && kind != OCCLUDER_BOX) continue;

        float hit = rayOccluder(origin, dir, i);
        float boundRadius = texelFetch(uOccluders, ivec2(i, 6), 0).x;
        float bias = isSelf ? max(SHADOW_BIAS, boundRadius * SELF_SHADOW_FRACTION) : SHADOW_BIAS;
        if (hit > bias && hit < maxDistance) return true;
    }
    return false;
}

int traceNearestIndex(vec3 origin, vec3 dir, float maxDistance, float ignoreId) {
    int best = -1;
    float bestDistance = maxDistance;
    for (int i = 0; i < uOccluderCount; i++) {
        vec4 row0 = texelFetch(uOccluders, ivec2(i, 0), 0);
        vec4 row10 = texelFetch(uOccluders, ivec2(i, 10), 0);
        int kind = int(row0.x + 0.5);
        float ownerId = row10.x;
        bool isSelf = ownerId == ignoreId;
        if (isSelf && kind == OCCLUDER_SPHERE) continue;

        float hit = rayOccluder(origin, dir, i);
        float boundRadius = texelFetch(uOccluders, ivec2(i, 6), 0).x;
        float bias = isSelf ? max(SHADOW_BIAS, boundRadius * SELF_SHADOW_FRACTION) : SHADOW_BIAS;
        if (hit > bias && hit < bestDistance) {
            bestDistance = hit;
            best = i;
        }
    }
    return best;
}

// ---------------------------------------------------------------------------
// Kernel de sombreamento (light/shade.ts).
// ---------------------------------------------------------------------------
vec3 faceNormal(vec3 n, vec3 viewDir) {
    return dot(n, viewDir) < 0.0 ? -n : n;
}

/**
 * Ambiente + N luzes + sombra + especular — sem reflexo, que é sempre uma
 * decisão de quem chama (ver shadeSurface abaixo: o bloco de espelho vem
 * depois deste e nunca recursa). Serve tanto o fragmento de verdade quanto o
 * bounce de um raio de espelho no chão (reflectGround).
 */
vec3 shadeCore(
    vec3 pos, vec3 nIn, vec3 viewDir,
    vec3 albedo, vec3 emissive, float emissiveStrength,
    float reflectivity, float gloss,
    bool ambientOn, bool shadowsAllowed, float ownerId
) {
    vec3 n = faceNormal(nIn, viewDir);
    vec3 color = ambientOn ? uAmbient * albedo : vec3(0.0);
    vec3 origin = pos + n * SHADOW_BIAS;

    int shadowRays = 0;
    for (int i = 0; i < uLightCount; i++) {
        vec4 l0 = texelFetch(uLights, ivec2(i, 0), 0);
        vec4 l1 = texelFetch(uLights, ivec2(i, 1), 0);
        vec4 l2 = texelFetch(uLights, ivec2(i, 2), 0);
        vec4 l3 = texelFetch(uLights, ivec2(i, 3), 0);

        int kind = int(l0.x + 0.5);
        vec3 lightPos = l0.yzw;
        vec3 lightAxis = l1.xyz;
        vec3 lightColor = vec3(l1.w, l2.x, l2.y);
        float intensity = l2.z;
        float range = l2.w;
        bool castsShadow = l3.x > 0.5;
        float coneCos = l3.y;
        float coneSoftness = l3.z;

        vec3 lDir;
        float distance;
        if (kind == LIGHT_DIRECTIONAL) {
            lDir = lightAxis;
            distance = 1.0e29;
        } else {
            vec3 delta = lightPos - pos;
            float distSq = dot(delta, delta);
            if (distSq > range * range) continue;
            distance = sqrt(distSq);
            lDir = distance > 0.0 ? delta / distance : vec3(0.0);
        }

        float attenuation;
        if (kind == LIGHT_DIRECTIONAL) {
            attenuation = 1.0;
        } else {
            float distSq = distance * distance;
            float ratio = distSq / (range * range);
            float window = max(0.0, 1.0 - ratio * ratio);
            attenuation = (window * window * HALF_POWER_SQ) / (distSq + HALF_POWER_SQ);
            if (coneCos > -1.0) {
                float cosAxis = -dot(lDir, lightAxis);
                if (cosAxis < coneCos) {
                    attenuation = 0.0;
                } else {
                    float edge = min(1.0, (cosAxis - coneCos) / coneSoftness);
                    attenuation *= edge;
                }
            }
        }
        if (attenuation <= 0.0) continue;

        float ndotl = dot(n, lDir);
        if (ndotl <= 0.0) continue;

        float contribution = ndotl * attenuation * intensity;
        if (contribution < uShadowThreshold) continue;

        if (shadowsAllowed && uShadowsEnabled > 0.5 && castsShadow && shadowRays < uMaxShadowLights) {
            shadowRays += 1;
            if (occludedBy(origin, lDir, distance, ownerId)) continue;
        }

        color += albedo * lightColor * contribution;

        if (reflectivity > 0.0) {
            vec3 h = lDir + viewDir;
            float hLen = length(h);
            if (hLen > 0.0) {
                h /= hLen;
                float ndoth = dot(n, h);
                if (ndoth > 0.0) {
                    float specular = pow(ndoth, gloss) * reflectivity * attenuation * intensity;
                    color += lightColor * specular;
                }
            }
        }
    }

    color += emissive * emissiveStrength;
    return color;
}

bool reflectGround(vec3 origin, vec3 dir, out vec3 result) {
    if (uHasGround < 0.5 || dir.y >= 0.0) return false;
    float t = -origin.y / dir.y;
    if (!(t > SHADOW_BIAS) || t >= MIRROR_RANGE) return false;

    vec3 hitPos = vec3(origin.x + dir.x * t, 0.0, origin.z + dir.z * t);
    vec3 view = -dir;
    result = shadeCore(
        hitPos, vec3(0.0, 1.0, 0.0), view,
        uGroundAlbedo, uGroundEmissive, uGroundEmissiveStrength,
        0.0, uGroundGloss,
        true, false, -1.0
    );
    return true;
}

// shadeSurface completo: shadeCore mais o bloco de espelho.
vec3 shadeSurface(
    vec3 pos, vec3 nIn, vec3 viewDir,
    vec3 albedo, vec3 emissive, float emissiveStrength,
    float reflectivity, float gloss, bool mirror,
    bool ambientOn, bool reflectionsOn, bool shadowsAllowed, float ownerId
) {
    vec3 n = faceNormal(nIn, viewDir);
    vec3 color = shadeCore(
        pos, nIn, viewDir, albedo, emissive, emissiveStrength,
        reflectivity, gloss, ambientOn, shadowsAllowed, ownerId
    );

    if (reflectionsOn && reflectivity > 0.0) {
        float ndotv = dot(n, viewDir);
        vec3 r = n * (2.0 * ndotv) - viewDir;
        vec3 origin = pos + n * SHADOW_BIAS;

        vec3 reflected;
        bool hit = false;
        if (mirror) {
            int idx = traceNearestIndex(origin, r, MIRROR_RANGE, ownerId);
            if (idx >= 0) {
                reflected = texelFetch(uOccluders, ivec2(idx, 6), 0).yzw;
                hit = true;
            }
        }
        if (!hit) {
            vec3 groundColor;
            if (mirror && reflectGround(origin, r, groundColor)) {
                reflected = groundColor;
            } else {
                reflected = skyRadiance(r, gloss);
            }
        }
        color += reflected * reflectivity;
    }

    return color;
}

// ---------------------------------------------------------------------------
// Rampa (render/ramp.ts, render/glyph-shape.ts) — LUT para preenchimento,
// busca portada para aresta.
// ---------------------------------------------------------------------------
float compressLuminance(float luminance, float exposure) {
    return luminance <= 0.0 ? 0.0 : 1.0 - exp(-luminance * exposure);
}

float sampleAreaGlyph(float luminance, int textureId, bool raw, vec3 worldPos) {
    float level = compressLuminance(luminance, uRampExposure);
    if (textureId == 2) {
        level = clamp(level + jitterAt(worldPos) * IRREGULAR_JITTER, 0.0, 1.0);
    }
    int row = textureId * 2 + (raw ? 0 : 1);
    int levelIndex = int(clamp(level, 0.0, 1.0) * (AREA_LUT_LEVELS - 1.0) + 0.5);
    return texelFetch(uAreaLut, ivec2(levelIndex, row), 0).r * 255.0;
}

const vec2 INTERNAL_SAMPLES[6] = vec2[](
    vec2(1.0 / 6.0, 1.0 / 3.0 + 0.125),
    vec2(1.0 / 6.0, 2.0 / 3.0 + 0.125),
    vec2(3.0 / 6.0, 1.0 / 3.0),
    vec2(3.0 / 6.0, 2.0 / 3.0),
    vec2(5.0 / 6.0, 1.0 / 3.0 - 0.125),
    vec2(5.0 / 6.0, 2.0 / 3.0 - 0.125)
);
const vec2 EXTERNAL_SAMPLES[12] = vec2[](
    vec2(1.0 / 6.0, -0.15),
    vec2(3.0 / 6.0, -0.15),
    vec2(5.0 / 6.0, -0.15),
    vec2(1.0 / 6.0, 1.15),
    vec2(3.0 / 6.0, 1.15),
    vec2(5.0 / 6.0, 1.15),
    vec2(-0.15, 1.0 / 3.0),
    vec2(-0.15, 0.5),
    vec2(-0.15, 2.0 / 3.0),
    vec2(1.15, 1.0 / 3.0),
    vec2(1.15, 0.5),
    vec2(1.15, 2.0 / 3.0)
);
const int AFFECTING_A[6] = int[](6, 9, 7, 10, 8, 11);
const int AFFECTING_B[6] = int[](12, 14, -1, -1, 15, 17);

void sampleLineCoverage(out float samples[18], float offsetCol, float offsetRow, float dirCol, float dirRow) {
    float lineX = 0.5 + offsetCol;
    float lineY = 0.5 + offsetRow;
    for (int i = 0; i < 6; i++) {
        vec2 s = INTERNAL_SAMPLES[i];
        float d = abs((s.x - lineX) * dirRow - (s.y - lineY) * dirCol);
        samples[i] = max(0.0, 1.0 - d / DEFAULT_LINE_HALF_THICKNESS);
    }
    for (int i = 0; i < 12; i++) {
        vec2 s = EXTERNAL_SAMPLES[i];
        float d = abs((s.x - lineX) * dirRow - (s.y - lineY) * dirCol);
        samples[6 + i] = max(0.0, 1.0 - d / DEFAULT_LINE_HALF_THICKNESS);
    }
}

float boost(float value, float referenceMax) {
    if (referenceMax <= 1e-4) return value;
    float normalized = min(1.0, value / referenceMax);
    return pow(normalized, CONTRAST_EXPONENT) * referenceMax;
}

void enhanceContrast(out float shape[6], float samples[18]) {
    for (int i = 0; i < 6; i++) {
        float refMax = samples[AFFECTING_A[i]];
        if (AFFECTING_B[i] >= 0) refMax = max(refMax, samples[AFFECTING_B[i]]);
        shape[i] = boost(samples[i], refMax);
    }
}

int lowerBoundCoverage(sampler2D pool, int count, float value) {
    int lo = 0;
    int hi = count;
    for (int iter = 0; iter < 9; iter++) {
        if (lo >= hi) break;
        int mid = (lo + hi) / 2;
        float coverage = texelFetch(pool, ivec2(mid, 1), 0).b;
        if (coverage < value) lo = mid + 1; else hi = mid;
    }
    return lo;
}

float nearestWeightedGlyphGPU(sampler2D pool, int count, float shape[6], float targetLevel, float weight) {
    float shapeCoverage = 0.0;
    for (int k = 0; k < 6; k++) shapeCoverage += shape[k];
    shapeCoverage /= 6.0;

    float center = (shapeCoverage + weight * targetLevel) / (1.0 + weight);
    int half_ = EDGE_SHAPE_WINDOW / 2;
    int maxStart = max(0, count - EDGE_SHAPE_WINDOW);
    int start = clamp(lowerBoundCoverage(pool, count, center) - half_, 0, maxStart);
    int end = min(count, start + EDGE_SHAPE_WINDOW);

    float bestGlyph = 0.0;
    float bestDistance = 1.0e29;
    for (int i = 0; i < EDGE_SHAPE_WINDOW; i++) {
        int idx = start + i;
        if (idx >= end) break;
        vec4 row0 = texelFetch(pool, ivec2(idx, 0), 0);
        vec4 row1 = texelFetch(pool, ivec2(idx, 1), 0);
        float dist = 0.0;
        float d0 = shape[0] - row0.x; dist += d0 * d0;
        float d1 = shape[1] - row0.y; dist += d1 * d1;
        float d2 = shape[2] - row0.z; dist += d2 * d2;
        float d3 = shape[3] - row0.w; dist += d3 * d3;
        float d4 = shape[4] - row1.x; dist += d4 * d4;
        float d5 = shape[5] - row1.y; dist += d5 * d5;
        float levelDelta = targetLevel - row1.z;
        dist += weight * levelDelta * levelDelta;
        if (dist < bestDistance) {
            bestDistance = dist;
            bestGlyph = row1.w;
        }
    }
    return bestGlyph;
}

float sampleEdgeGlyph(float luminance, float offsetCol, float offsetRow, float dirCol, float dirRow, bool near, int textureId, vec3 worldPos) {
    float samples[18];
    sampleLineCoverage(samples, offsetCol, offsetRow, dirCol, dirRow);
    float shape[6];
    enhanceContrast(shape, samples);

    float level = compressLuminance(luminance, uRampExposure);
    if (textureId == 2) {
        level = clamp(level + jitterAt(worldPos) * IRREGULAR_JITTER, 0.0, 1.0);
    }

    if (near) {
        return nearestWeightedGlyphGPU(uEdgeNear, uEdgeNearCount, shape, level, uRampWeight);
    }
    return nearestWeightedGlyphGPU(uEdgeFar, uEdgeFarCount, shape, level, uRampWeight);
}

// ---------------------------------------------------------------------------

void main() {
    ivec2 cell = ivec2(gl_FragCoord.xy);

    vec4 cellsData = texelFetch(uCellsIn, cell, 0);
    float alpha = cellsData.g;
    if (alpha <= 0.0) discard;

    vec4 colorsData = texelFetch(uColorsIn, cell, 0);
    bool opaque = colorsData.a > 0.5;
    bool resolved = cellsData.a > 0.5;

    vec3 baseColor;
    float baseEmissive;
    float glyphIndex;

    if (resolved) {
        baseColor = colorsData.rgb;
        baseEmissive = cellsData.b * uEmissiveRange;
        glyphIndex = cellsData.r * 255.0;
    } else {
        vec4 gpos = texelFetch(uGPos, cell, 0);
        vec4 gnorm = texelFetch(uGNormal, cell, 0);
        vec4 galbedo = texelFetch(uGAlbedo, cell, 0);
        vec4 gemis = texelFetch(uGEmissive, cell, 0);
        vec4 gshape = texelFetch(uGShape, cell, 0);
        float gloss = texelFetch(uGGloss, cell, 0).x;

        vec3 worldPos = gpos.xyz;
        float ownerId = gpos.w;
        vec3 normal = gnorm.xyz;
        int flags = int(gnorm.w + 0.5);
        bool isArea = (flags & 1) != 0;
        bool variantBit = (flags & 2) != 0;
        int textureId = (flags >> 2) & 3;
        bool mirror = (flags & 16) != 0;
        bool ambientOn = (flags & 32) != 0;
        bool reflectionsOn = (flags & 64) != 0;

        vec3 viewDir = normalize(uCameraPos - worldPos);
        vec3 shaded = shadeSurface(
            worldPos, normal, viewDir,
            galbedo.rgb, gemis.rgb, gemis.a,
            galbedo.a, gloss, mirror,
            ambientOn, reflectionsOn, true, ownerId
        );
        float luminance = dot(shaded, vec3(0.299, 0.587, 0.114));

        if (isArea && variantBit && luminance < uGroundFillLight) discard;

        float glyph = isArea
            ? sampleAreaGlyph(luminance, textureId, variantBit, worldPos)
            : sampleEdgeGlyph(luminance, gshape.x, gshape.y, gshape.z, gshape.w, variantBit, textureId, worldPos);

        float peak = max(1.0, max(shaded.r, max(shaded.g, shaded.b)));
        baseColor = shaded / peak;
        baseEmissive = peak - 1.0;
        glyphIndex = glyph;
    }

    vec4 fuseData = texelFetch(uFuseIn, cell, 0);
    vec3 finalColor = clamp(baseColor + fuseData.rgb, 0.0, 1.0);
    float finalEmissive = baseEmissive + fuseData.a * uEmissiveRange;

    outCells = vec4(glyphIndex / 255.0, alpha, clamp(finalEmissive / uEmissiveRange, 0.0, 1.0), 1.0);
    outColors = vec4(finalColor, opaque ? 1.0 : 0.0);
}
`;

export class ShadingPass {
  private readonly program: Program;
  private readonly lights: LightUpload;

  private fbo: WebGLFramebuffer | null = null;
  private cellsOut: WebGLTexture | null = null;
  private colorsOut: WebGLTexture | null = null;
  private colCount = 0;
  private rowCount = 0;

  // Entrada: uploads da CPU, um por quadro.
  private readonly cellsIn: WebGLTexture;
  private readonly colorsIn: WebGLTexture;
  private readonly fuseIn: WebGLTexture;
  private readonly gPos: WebGLTexture;
  private readonly gNormal: WebGLTexture;
  private readonly gAlbedo: WebGLTexture;
  private readonly gEmissive: WebGLTexture;
  private readonly gShape: WebGLTexture;
  private readonly gGloss: WebGLTexture;

  private areaLut: WebGLTexture | null = null;
  private edgeNear: WebGLTexture | null = null;
  private edgeNearCount = 0;
  private edgeFar: WebGLTexture | null = null;
  private edgeFarCount = 0;

  private readonly noiseSeed = Math.random() * 10000;

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.program = new Program(gl, FULLSCREEN_VERTEX, FRAGMENT_SOURCE);
    this.lights = new LightUpload(gl);

    this.cellsIn = createU8Texture(gl);
    this.colorsIn = createU8Texture(gl);
    this.fuseIn = createU8Texture(gl);
    this.gPos = createF32Texture(gl);
    this.gNormal = createF32Texture(gl);
    this.gAlbedo = createF32Texture(gl);
    this.gEmissive = createF32Texture(gl);
    this.gShape = createF32Texture(gl);
    this.gGloss = createF32Texture(gl);

    this.program.use();
    this.program.setTextureUnit("uCellsIn", 0);
    this.program.setTextureUnit("uColorsIn", 1);
    this.program.setTextureUnit("uFuseIn", 2);
    this.program.setTextureUnit("uGPos", 3);
    this.program.setTextureUnit("uGNormal", 4);
    this.program.setTextureUnit("uGAlbedo", 5);
    this.program.setTextureUnit("uGEmissive", 6);
    this.program.setTextureUnit("uGShape", 7);
    this.program.setTextureUnit("uGGloss", 8);
    this.program.setTextureUnit("uLights", 9);
    this.program.setTextureUnit("uOccluders", 10);
    this.program.setTextureUnit("uStars", 11);
    this.program.setTextureUnit("uAreaLut", 12);
    this.program.setTextureUnit("uEdgeNear", 13);
    this.program.setTextureUnit("uEdgeFar", 14);
  }

  get cellsTexture(): WebGLTexture | null {
    return this.cellsOut;
  }

  get colorsTexture(): WebGLTexture | null {
    return this.colorsOut;
  }

  /**
   * Lê os dois planos de volta para a CPU — só para ferramenta de depuração
   * (`dumpGlyphs`/`countByColor` em `main.ts`): depois que o glifo e a cor
   * final passaram a nascer aqui, `Framebuffer.cells`/`colors` não têm mais
   * a resposta para uma célula sombreada, só para uma resolvida.
   */
  readPlanes(): { cells: Uint8Array; colors: Uint8Array } | null {
    const { gl, fbo, cellsOut, colorsOut, colCount, rowCount } = this;
    if (fbo === null || cellsOut === null || colorsOut === null) return null;

    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    const cells = new Uint8Array(colCount * rowCount * 4);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.readPixels(0, 0, colCount, rowCount, gl.RGBA, gl.UNSIGNED_BYTE, cells);

    const colors = new Uint8Array(colCount * rowCount * 4);
    gl.readBuffer(gl.COLOR_ATTACHMENT1);
    gl.readPixels(0, 0, colCount, rowCount, gl.RGBA, gl.UNSIGNED_BYTE, colors);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { cells, colors };
  }

  resize(colCount: number, rowCount: number): void {
    if (this.colCount === colCount && this.rowCount === rowCount && this.fbo !== null) {
      return;
    }
    const { gl } = this;
    this.disposeTargets();

    this.colCount = colCount;
    this.rowCount = rowCount;

    for (const tex of [this.cellsIn, this.colorsIn, this.fuseIn]) {
      resizeU8Texture(gl, tex, colCount, rowCount);
    }
    for (const tex of [this.gPos, this.gNormal, this.gAlbedo, this.gEmissive, this.gShape, this.gGloss]) {
      resizeF32Texture(gl, tex, colCount, rowCount);
    }

    this.cellsOut = createU8Texture(gl);
    resizeU8Texture(gl, this.cellsOut, colCount, rowCount);
    this.colorsOut = createU8Texture(gl);
    resizeU8Texture(gl, this.colorsOut, colCount, rowCount);

    const fbo = gl.createFramebuffer();
    if (fbo === null) throw new Error("Não foi possível criar o FBO de sombreamento.");
    this.fbo = fbo;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.cellsOut, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, this.colorsOut, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** Chamado quando o atlas é (re)construído — mesma hora de `updateGlyphShapeTable`. */
  setGlyphLuts(
    areaLutData: Uint8Array,
    areaLutRows: number,
    areaLutLevels: number,
    edgeNearData: Float32Array,
    edgeNearCount: number,
    edgeFarData: Float32Array,
    edgeFarCount: number,
  ): void {
    const { gl } = this;

    if (this.areaLut !== null) gl.deleteTexture(this.areaLut);
    const areaLut = gl.createTexture();
    if (areaLut === null) throw new Error("Não foi possível criar a LUT de preenchimento.");
    gl.bindTexture(gl.TEXTURE_2D, areaLut);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8, areaLutLevels, areaLutRows);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texSubImage2D(
      gl.TEXTURE_2D, 0, 0, 0, areaLutLevels, areaLutRows, gl.RED, gl.UNSIGNED_BYTE, areaLutData,
    );
    this.areaLut = areaLut;

    this.edgeNear = uploadEdgePool(gl, this.edgeNear, edgeNearData, edgeNearCount);
    this.edgeNearCount = edgeNearCount;
    this.edgeFar = uploadEdgePool(gl, this.edgeFar, edgeFarData, edgeFarCount);
    this.edgeFarCount = edgeFarCount;
  }

  draw(
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
    const { gl } = this;
    if (this.fbo === null || this.areaLut === null || this.edgeNear === null || this.edgeFar === null) {
      return;
    }

    uploadU8(gl, this.cellsIn, this.colCount, this.rowCount, framebuffer.cells);
    uploadU8(gl, this.colorsIn, this.colCount, this.rowCount, framebuffer.colors);
    uploadU8(gl, this.fuseIn, this.colCount, this.rowCount, framebuffer.fuse);
    uploadF32(gl, this.gPos, this.colCount, this.rowCount, framebuffer.gPos);
    uploadF32(gl, this.gNormal, this.colCount, this.rowCount, framebuffer.gNormal);
    uploadF32(gl, this.gAlbedo, this.colCount, this.rowCount, framebuffer.gAlbedo);
    uploadF32(gl, this.gEmissive, this.colCount, this.rowCount, framebuffer.gEmissive);
    uploadF32(gl, this.gShape, this.colCount, this.rowCount, framebuffer.gShape);
    uploadF32(gl, this.gGloss, this.colCount, this.rowCount, framebuffer.gGloss);

    this.lights.upload(world);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.colCount, this.rowCount);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    this.program.use();
    bindUnit(gl, 0, this.cellsIn);
    bindUnit(gl, 1, this.colorsIn);
    bindUnit(gl, 2, this.fuseIn);
    bindUnit(gl, 3, this.gPos);
    bindUnit(gl, 4, this.gNormal);
    bindUnit(gl, 5, this.gAlbedo);
    bindUnit(gl, 6, this.gEmissive);
    bindUnit(gl, 7, this.gShape);
    bindUnit(gl, 8, this.gGloss);
    bindUnit(gl, 9, this.lights.lightsTexture);
    bindUnit(gl, 10, this.lights.occludersTexture);
    bindUnit(gl, 11, this.lights.starsTexture);
    bindUnit(gl, 12, this.areaLut);
    bindUnit(gl, 13, this.edgeNear);
    bindUnit(gl, 14, this.edgeFar);

    const { program } = this;
    gl.uniform1i(program.uniform("uLightCount"), this.lights.lightCount);
    gl.uniform1i(program.uniform("uOccluderCount"), this.lights.occluderCount);
    gl.uniform1i(program.uniform("uStarCount"), this.lights.sky.starCount);
    gl.uniform1i(program.uniform("uEdgeNearCount"), this.edgeNearCount);
    gl.uniform1i(program.uniform("uEdgeFarCount"), this.edgeFarCount);

    gl.uniform3f(program.uniform("uAmbient"), this.lights.ambientR, this.lights.ambientG, this.lights.ambientB);
    gl.uniform3f(program.uniform("uCameraPos"), cameraX, cameraY, cameraZ);
    gl.uniform1f(program.uniform("uNoiseSeed"), this.noiseSeed);

    const { sky } = this.lights;
    gl.uniform3f(program.uniform("uSunDir"), sky.sunDirX, sky.sunDirY, sky.sunDirZ);
    gl.uniform3f(program.uniform("uSunColor"), sky.sunColorR, sky.sunColorG, sky.sunColorB);
    gl.uniform1f(program.uniform("uSunIntensity"), sky.sunIntensity);
    gl.uniform1f(program.uniform("uSkyIntensity"), sky.intensity);
    gl.uniform1f(program.uniform("uSunGlow"), sky.sunGlow);
    gl.uniform1f(program.uniform("uHorizonGlow"), sky.horizonGlow);
    gl.uniform1f(program.uniform("uSunSpread"), sky.sunSpread);

    gl.uniform1f(program.uniform("uHasGround"), sky.hasGround ? 1 : 0);
    gl.uniform3f(program.uniform("uGroundAlbedo"), sky.groundAlbedoR, sky.groundAlbedoG, sky.groundAlbedoB);
    gl.uniform3f(program.uniform("uGroundEmissive"), sky.groundEmissiveR, sky.groundEmissiveG, sky.groundEmissiveB);
    gl.uniform1f(program.uniform("uGroundEmissiveStrength"), sky.groundEmissiveStrength);
    gl.uniform1f(program.uniform("uGroundReflectivity"), sky.groundReflectivity);
    gl.uniform1f(program.uniform("uGroundGloss"), sky.groundGloss);
    gl.uniform1f(program.uniform("uGroundMirror"), sky.groundMirror ? 1 : 0);

    gl.uniform1f(program.uniform("uShadowsEnabled"), options.shadowsEnabled ? 1 : 0);
    gl.uniform1f(program.uniform("uShadowThreshold"), options.shadowThreshold);
    gl.uniform1i(program.uniform("uMaxShadowLights"), options.maxShadowLights);
    gl.uniform1f(program.uniform("uGroundFillLight"), options.groundFillLight);
    gl.uniform1f(program.uniform("uRampWeight"), options.rampWeight);
    gl.uniform1f(program.uniform("uRampExposure"), options.rampExposure);
    gl.uniform1f(program.uniform("uEmissiveRange"), options.emissiveRange);

    drawFullscreen(gl);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  private disposeTargets(): void {
    const { gl } = this;
    if (this.fbo !== null) gl.deleteFramebuffer(this.fbo);
    if (this.cellsOut !== null) gl.deleteTexture(this.cellsOut);
    if (this.colorsOut !== null) gl.deleteTexture(this.colorsOut);
    this.fbo = null;
    this.cellsOut = null;
    this.colorsOut = null;
  }

  dispose(): void {
    const { gl } = this;
    this.disposeTargets();
    this.program.dispose();
    this.lights.dispose();
    for (const tex of [this.cellsIn, this.colorsIn, this.fuseIn, this.gPos, this.gNormal, this.gAlbedo, this.gEmissive, this.gShape, this.gGloss]) {
      gl.deleteTexture(tex);
    }
    if (this.areaLut !== null) gl.deleteTexture(this.areaLut);
    if (this.edgeNear !== null) gl.deleteTexture(this.edgeNear);
    if (this.edgeFar !== null) gl.deleteTexture(this.edgeFar);
  }
}

const createU8Texture = (gl: WebGL2RenderingContext): WebGLTexture => {
  const texture = gl.createTexture();
  if (texture === null) throw new Error("Não foi possível criar textura.");
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
};

const resizeU8Texture = (
  gl: WebGL2RenderingContext,
  texture: WebGLTexture,
  width: number,
  height: number,
): void => {
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
};

const createF32Texture = (gl: WebGL2RenderingContext): WebGLTexture => {
  const texture = gl.createTexture();
  if (texture === null) throw new Error("Não foi possível criar textura.");
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
};

const resizeF32Texture = (
  gl: WebGL2RenderingContext,
  texture: WebGLTexture,
  width: number,
  height: number,
): void => {
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, null);
};

const uploadU8 = (
  gl: WebGL2RenderingContext,
  texture: WebGLTexture,
  width: number,
  height: number,
  data: Uint8Array,
): void => {
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
};

const uploadF32 = (
  gl: WebGL2RenderingContext,
  texture: WebGLTexture,
  width: number,
  height: number,
  data: Float32Array,
): void => {
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.FLOAT, data);
};

const bindUnit = (gl: WebGL2RenderingContext, unit: number, texture: WebGLTexture): void => {
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, texture);
};

const uploadEdgePool = (
  gl: WebGL2RenderingContext,
  previous: WebGLTexture | null,
  data: Float32Array,
  count: number,
): WebGLTexture => {
  if (previous !== null) gl.deleteTexture(previous);
  const texture = gl.createTexture();
  if (texture === null) throw new Error("Não foi possível criar o pool de aresta.");
  const width = Math.max(1, count);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, width, 2);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  if (count > 0) {
    // `data` é `[row0 x count, row1 x count]` — ver `buildEdgeShapePool`, que
    // gera uma entrada de 8 floats por candidato; reempacotado aqui em duas
    // fileiras de `count` texels para casar com o `texelFetch(pool, (i,0/1))`
    // do shader.
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
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, 1, gl.RGBA, gl.FLOAT, row0);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 1, width, 1, gl.RGBA, gl.FLOAT, row1);
  }
  return texture;
};
