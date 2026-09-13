import { mulRgb, scaleRgb } from "../math/color";
import * as mat4 from "../math/mat4";
import { dot, length, normalize, reflect, scale, set, sub, type Vec3, vec3 } from "../math/vec3";
import { LIGHT, OCCLUDER } from "./types";
import { occluded, SHADOW_BIAS } from "./trace";
import type { LightWorld } from "./world";

/**
 * Espelho vira fonte: para cada luz de verdade que bate numa caixa com
 * `material.mirror`, registra uma luz-imagem atrás dela — o truque óptico
 * clássico de refletir a própria luz através do plano do espelho, em vez de
 * refletir o resultado já sombreado. A distância em linha reta de um ponto
 * qualquer da cena até a luz-imagem é, por construção geométrica, igual à
 * distância física do caminho refletido (receptor → espelho → luz), então
 * `shadeCore` (`render/gpu/passes/shading.ts`) calcula atenuação, `NdotL` e
 * cone sem nenhum caso especial — só precisa saber que a luz existe.
 *
 * `apertureOwnerId` (ver `light/types.ts`) é o que contém essa luz dentro da
 * superfície real do espelho: `shadeCore` só aceita a contribuição se o raio
 * até a luz-imagem acertar primeiro o espelho de origem, não vazando por
 * fora dele como um segundo sol.
 *
 * Só caixas: uma esfera não tem uma normal única — refletir nela pediria uma
 * luz-imagem por ponto da curvatura, não uma por luz da cena (o reflexo
 * *visual* de uma esfera espelhada já é correto via `shadeSurface`, só a
 * iluminação secundária fica de fora). Um bounce só: itera a contagem de
 * luzes de antes deste passo, então uma luz-imagem nunca gera outra.
 */

const mirrorNormal: Vec3 = vec3();
const signedNormal: Vec3 = vec3();
const towardSource: Vec3 = vec3();
const probeOrigin: Vec3 = vec3();
const toLight: Vec3 = vec3();
const virtualDirection: Vec3 = vec3();

/** Abaixo disto a luz é rasante ao plano do espelho — sem lado definido. */
const APERTURE_EPSILON = 1e-4;

/** Alcance do sondão de visibilidade sol→espelho: não tem `range` de verdade. */
const DIRECTIONAL_PROBE_DISTANCE = 1e6;

export const addMirrorBounceLights = (world: LightWorld): void => {
  const originalLightCount = world.lightCount;
  const originalOccluderCount = world.occluderCount;

  for (let oi = 0; oi < originalOccluderCount; oi += 1) {
    const mirror = world.occluder(oi);
    if (mirror.kind !== OCCLUDER.BOX) continue;

    const { material } = mirror;
    if (material === null || !material.mirror || material.reflectivity <= 0) {
      continue;
    }

    // Eixo local de menor meia-extensão = o lado fino da caixa, a face que
    // reflete. Levado para o mundo pela transposta da parte rotacional de
    // `toLocal` — mesma técnica usada pelo reflexo de corpo e pelo bounce
    // do feixe do holofote.
    const { half } = mirror;
    let ax = 0;
    let ay = 0;
    let az = 0;
    let thickness: number;
    if (half.x <= half.y && half.x <= half.z) {
      ax = 1;
      thickness = half.x;
    } else if (half.y <= half.z) {
      ay = 1;
      thickness = half.y;
    } else {
      az = 1;
      thickness = half.z;
    }
    mat4.transformDirectionTransposed(mirrorNormal, mirror.toLocal, ax, ay, az);
    normalize(mirrorNormal, mirrorNormal);
    // A sonda de visibilidade abaixo parte da superfície de verdade, não do
    // centro: `occluded()` sombreia a própria caixa com um bias grande de
    // propósito (`SELF_SHADOW_FRACTION`, para ela bloquear a parede oposta
    // vista de dentro) — partindo do centro, a sonda nunca escapava da
    // própria espessura e via toda luz como bloqueada.
    const probeOffset = thickness + SHADOW_BIAS;

    for (let li = 0; li < originalLightCount; li += 1) {
      const light = world.light(li);

      if (light.kind === LIGHT.DIRECTIONAL) {
        set(towardSource, light.direction.x, light.direction.y, light.direction.z);
      } else {
        sub(towardSource, light.position, mirror.center);
        normalize(towardSource, towardSource);
      }

      // Qual dos dois lados da caixa está voltado para a luz.
      const facing = dot(towardSource, mirrorNormal);
      if (Math.abs(facing) < APERTURE_EPSILON) continue;
      scale(signedNormal, mirrorNormal, facing < 0 ? -1 : 1);

      set(
        probeOrigin,
        mirror.center.x + signedNormal.x * probeOffset,
        mirror.center.y + signedNormal.y * probeOffset,
        mirror.center.z + signedNormal.z * probeOffset,
      );

      // O espelho só reflete o que recebe: se outra coisa bloqueia a luz de
      // verdade antes de chegar nele, não há bounce este quadro. Uma sonda
      // por (espelho, luz) por quadro — desprezível perto do orçamento de
      // sombra por fragmento.
      let lightVisible: boolean;
      let distanceToLight = DIRECTIONAL_PROBE_DISTANCE;
      if (light.kind === LIGHT.DIRECTIONAL) {
        lightVisible = !occluded(
          world,
          probeOrigin.x,
          probeOrigin.y,
          probeOrigin.z,
          light.direction.x,
          light.direction.y,
          light.direction.z,
          DIRECTIONAL_PROBE_DISTANCE,
          mirror.ownerId,
        );
      } else {
        sub(toLight, light.position, probeOrigin);
        distanceToLight = length(toLight);
        if (distanceToLight > light.range) continue;
        const inverse = 1 / Math.max(distanceToLight, 1e-6);
        scale(toLight, toLight, inverse);
        lightVisible = !occluded(
          world,
          probeOrigin.x,
          probeOrigin.y,
          probeOrigin.z,
          toLight.x,
          toLight.y,
          toLight.z,
          distanceToLight,
          mirror.ownerId,
        );
      }
      if (!lightVisible) continue;

      // Posição/direção da luz-imagem: o próprio ponto e a própria direção
      // da luz real, refletidos através do plano do espelho.
      let vx = 0;
      let vy = 0;
      let vz = 0;
      if (light.kind !== LIGHT.DIRECTIONAL) {
        const dx = light.position.x - mirror.center.x;
        const dy = light.position.y - mirror.center.y;
        const dz = light.position.z - mirror.center.z;
        const d = dx * signedNormal.x + dy * signedNormal.y + dz * signedNormal.z;
        vx = light.position.x - signedNormal.x * (2 * d);
        vy = light.position.y - signedNormal.y * (2 * d);
        vz = light.position.z - signedNormal.z * (2 * d);
      }
      reflect(virtualDirection, light.direction, signedNormal);

      const bounce = world.addLight();
      bounce.kind = light.kind;
      set(bounce.position, vx, vy, vz);
      set(bounce.direction, virtualDirection.x, virtualDirection.y, virtualDirection.z);
      mulRgb(bounce.color, light.color, material.albedo);
      scaleRgb(bounce.color, bounce.color, material.reflectivity);
      bounce.intensity = light.intensity;
      // A distância em linha reta até a luz-imagem já é a distância física
      // do caminho todo (receptor → espelho → luz) — o `range` original
      // continua a medida certa, sem escalar.
      bounce.range = light.range;
      bounce.castsShadow = light.castsShadow;
      bounce.coneCos = light.coneCos;
      bounce.coneSoftness = light.coneSoftness;
      bounce.apertureOwnerId = mirror.ownerId;
    }
  }
};
