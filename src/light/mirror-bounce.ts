import { mulRgb, scaleRgb } from "../math/color";
import * as mat4 from "../math/mat4";
import { dot, length, normalize, reflect, scale, set, sub, type Vec3, vec3 } from "../math/vec3";
import { LIGHT, OCCLUDER, type Light, type Material, type Occluder } from "./types";
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
 * Caixa e esfera, cada uma com sua normal.
 *
 * A caixa tem uma normal fixa por espelho (o eixo mais fino, calculado uma
 * vez fora do laço de luzes) porque o espelho *é* aquela face — refletir por
 * qualquer outro plano mostraria uma imagem errada. A esfera não tem uma
 * normal única: aqui a normal (e o ponto de contato) são recalculados para
 * cada luz, no ponto da superfície mais próximo dela — o plano tangente ali
 * é uma aproximação de espelho plano *local*, válida perto do ponto de
 * contato e cada vez pior longe dele, porque a curvatura espalha o reflexo
 * em vez de mantê-lo focado como o de uma superfície plana. É por isso que
 * `SPHERE_BOUNCE_RANGE_FACTOR` encurta o alcance da luz-imagem da esfera bem
 * abaixo do `range` original da luz: a distância em linha reta até ela deixa
 * de ser a distância física exata do caminho refletido assim que o ponto de
 * contato muda com quem está olhando, e um alcance grande vazaria luz onde a
 * aproximação já não vale.
 *
 * Um bounce só: itera a contagem de luzes de antes deste passo, então uma
 * luz-imagem nunca gera outra.
 */

const mirrorNormal: Vec3 = vec3();
const signedNormal: Vec3 = vec3();
const towardSource: Vec3 = vec3();
const spherePoint: Vec3 = vec3();
const probeOrigin: Vec3 = vec3();
const toLight: Vec3 = vec3();
const virtualDirection: Vec3 = vec3();

/** Abaixo disto a luz é rasante ao plano do espelho — sem lado definido. */
const APERTURE_EPSILON = 1e-4;

/** Alcance do sondão de visibilidade sol→espelho: não tem `range` de verdade. */
const DIRECTIONAL_PROBE_DISTANCE = 1e6;

/**
 * Múltiplo do raio que limita o alcance da luz-imagem de uma esfera — ver o
 * parágrafo sobre a aproximação de plano tangente acima. Calibrado a olho:
 * perto o bastante para a mancha de luz ficar perto da esfera (o que se vê),
 * longe o bastante para não parecer cortada de repente.
 */
const SPHERE_BOUNCE_RANGE_FACTOR = 6;

/**
 * A sonda de visibilidade, a reflexão de posição/direção pelo plano tangente
 * em `(planeAnchor, normal)` e a luz-imagem em si — o que caixa e esfera
 * fazem igual, uma vez que cada uma já achou seu próprio ponto de contato e
 * normal. `planeAnchor` é o ponto do plano de reflexo (o centro da caixa,
 * que a aproxima de um espelho fino centrado ali; o ponto de contato de
 * verdade na esfera, que tem curvatura de sobra para a diferença importar).
 * `rangeLimit` deixa a esfera encurtar o alcance da luz-imagem (ver o
 * comentário de `SPHERE_BOUNCE_RANGE_FACTOR`); a caixa passa `Infinity`, sem
 * teto além do `range` da luz original.
 */
const applyBounce = (
  world: LightWorld,
  mirror: Occluder,
  light: Light,
  material: Material,
  planeAnchor: Vec3,
  normal: Vec3,
  probeOrigin: Vec3,
  rangeLimit: number,
): void => {
  // Cone do holofote: `towardSource`/`normal` só descrevem POSIÇÃO relativa
  // a `planeAnchor`, nunca para onde o feixe aponta — sem isto, um holofote
  // apontado para o lado oposto do espelho ainda "acertava" ele, porque nada
  // além da posição era checado. Mesma fórmula de `shadeCore`
  // (`render/gpu/passes/shading.ts`): `cosAxis` é o quanto a direção
  // luz→ponto concorda com o eixo do cone; abaixo de `coneCos` está fora.
  //
  // Mas `planeAnchor` é só UM ponto do espelho (o centro da caixa, o ponto
  // de contato da esfera) — testar só esse ponto rejeitava o bounce inteiro
  // sempre que o holofote mirava uma borda do espelho em vez do centro,
  // mesmo com o cone claramente varrendo parte da superfície (o sintoma era
  // reflexo "só no centro"). `mirror.boundRadius` dá o raio angular que o
  // espelho ocupa visto da luz; folgamos o corte por esse ângulo em vez de
  // testar um ponto só. É uma pré-checagem grosseira mesmo — o teste exato
  // por pixel é o `traceNearestIndex` em `shadeCore`.
  if (light.kind !== LIGHT.DIRECTIONAL && light.coneCos > -1) {
    const dx = light.position.x - planeAnchor.x;
    const dy = light.position.y - planeAnchor.y;
    const dz = light.position.z - planeAnchor.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist > 1e-6) {
      const cosAxis =
        -((dx / dist) * light.direction.x +
          (dy / dist) * light.direction.y +
          (dz / dist) * light.direction.z);
      const angleToAxis = Math.acos(Math.min(1, Math.max(-1, cosAxis)));
      const angularRadius = Math.asin(Math.min(1, mirror.boundRadius / dist));
      const coneHalfAngle = Math.acos(Math.min(1, Math.max(-1, light.coneCos)));
      if (angleToAxis - angularRadius > coneHalfAngle) return;
    }
  }

  // O espelho só reflete o que recebe: se outra coisa bloqueia a luz de
  // verdade antes de chegar nele, não há bounce este quadro. Uma sonda por
  // (espelho, luz) por quadro — desprezível perto do orçamento de sombra
  // por fragmento.
  let lightVisible: boolean;
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
    const distanceToLight = length(toLight);
    if (distanceToLight > light.range) return;
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
  if (!lightVisible) return;

  // Posição/direção da luz-imagem: o próprio ponto e a própria direção da
  // luz real, refletidos através do plano de contato.
  let vx = 0;
  let vy = 0;
  let vz = 0;
  if (light.kind !== LIGHT.DIRECTIONAL) {
    const dx = light.position.x - planeAnchor.x;
    const dy = light.position.y - planeAnchor.y;
    const dz = light.position.z - planeAnchor.z;
    const d = dx * normal.x + dy * normal.y + dz * normal.z;
    vx = light.position.x - normal.x * (2 * d);
    vy = light.position.y - normal.y * (2 * d);
    vz = light.position.z - normal.z * (2 * d);
  }
  reflect(virtualDirection, light.direction, normal);

  const bounce = world.addLight();
  bounce.kind = light.kind;
  set(bounce.position, vx, vy, vz);
  set(bounce.direction, virtualDirection.x, virtualDirection.y, virtualDirection.z);
  mulRgb(bounce.color, light.color, material.albedo);
  scaleRgb(bounce.color, bounce.color, material.reflectivity);
  bounce.intensity = light.intensity;
  bounce.range = Math.min(light.range, rangeLimit);
  bounce.castsShadow = light.castsShadow;
  bounce.coneCos = light.coneCos;
  bounce.coneSoftness = light.coneSoftness;
  bounce.apertureOwnerId = mirror.ownerId;
};

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

      // A distância em linha reta até a luz-imagem já é a distância física
      // do caminho todo (receptor → espelho → luz) — o `range` original
      // continua a medida certa, sem escalar (`Infinity` não encurta nada
      // no `Math.min` de `applyBounce`).
      applyBounce(
        world,
        mirror,
        light,
        material,
        mirror.center,
        signedNormal,
        probeOrigin,
        Infinity,
      );
    }
  }

  // Esfera: sem uma normal fixa por espelho — recalculada por luz, no ponto
  // de contato de verdade na superfície (ver o comentário no topo do
  // arquivo). Um segundo laço, e não um branch dentro do de cima, porque a
  // preparação por espelho diverge cedo: a caixa monta `mirrorNormal` uma
  // vez fora do laço de luzes, a esfera não tem o que pré-computar ali.
  for (let oi = 0; oi < originalOccluderCount; oi += 1) {
    const mirror = world.occluder(oi);
    if (mirror.kind !== OCCLUDER.SPHERE) continue;

    const { material } = mirror;
    if (material === null || !material.mirror || material.reflectivity <= 0) {
      continue;
    }

    for (let li = 0; li < originalLightCount; li += 1) {
      const light = world.light(li);

      if (light.kind === LIGHT.DIRECTIONAL) {
        set(towardSource, light.direction.x, light.direction.y, light.direction.z);
      } else {
        sub(towardSource, light.position, mirror.center);
        normalize(towardSource, towardSource);
      }

      // Ponto da esfera mais próximo da luz — onde um brilho bateria — e a
      // normal ali, que é o próprio `towardSource`: ao contrário da caixa,
      // não há lado a escolher, a normal da esfera nesse ponto já aponta
      // para quem a ilumina.
      set(
        spherePoint,
        mirror.center.x + towardSource.x * mirror.radius,
        mirror.center.y + towardSource.y * mirror.radius,
        mirror.center.z + towardSource.z * mirror.radius,
      );
      set(
        probeOrigin,
        spherePoint.x + towardSource.x * SHADOW_BIAS,
        spherePoint.y + towardSource.y * SHADOW_BIAS,
        spherePoint.z + towardSource.z * SHADOW_BIAS,
      );

      applyBounce(
        world,
        mirror,
        light,
        material,
        spherePoint,
        towardSource,
        probeOrigin,
        mirror.radius * SPHERE_BOUNCE_RANGE_FACTOR,
      );
    }
  }
};
