import { setRgb } from "../math/color";
import { copy, set, type Vec3, vec3 } from "../math/vec3";
import { LIGHT, type Light } from "./types";
import type { LightWorld } from "./world";

/**
 * Helpers de queda de luz, e o tingimento de occluders para reflexo.
 *
 * O kernel de sombreamento por fragmento (uma superfície, todas as luzes,
 * sombra e espelho) não vive mais aqui — rodou na CPU só até a cena passar a
 * desenhar em `render/gpu/passes/shading.ts` (WGSL), que hoje é a única
 * implementação. O que sobra neste arquivo é o que ainda roda na CPU: as
 * contas de direção/queda de luz que `shadeOccluders` usa (uma vez por
 * quadro, por occluder — não por fragmento) e `ShadeOptions`, o contrato que
 * `render/shading.ts` e o uniform da GPU compartilham.
 */

/** Quem não é um corpo da cena. O chão, por exemplo. */
export const NO_OWNER = -1;

/**
 * Distância em que uma luz vale metade da sua força.
 *
 * O inverso do quadrado puro é fisicamente certo e praticamente inútil aqui: a
 * cena tem dezenas de unidades de lado, então a luz cairia por um fator de
 * mil entre a lâmpada e o chão, e "força 6" não significaria nada para quem
 * está mexendo no slider. Ancorar a queda numa distância de referência mantém
 * a forma da curva — quadrática, sem singularidade na origem — e faz a força
 * ser lida na escala da cena.
 */
const HALF_POWER_DISTANCE = 8;
const HALF_POWER_SQ = HALF_POWER_DISTANCE * HALF_POWER_DISTANCE;

export interface ShadeOptions {
  shadows: boolean;
  reflections: boolean;
  /**
   * Contribuição abaixo da qual não vale disparar raio de sombra.
   *
   * Uma luz que acrescenta um milésimo à célula não muda o glifo nem a cor,
   * mas custaria o teste contra todos os corpos. É o corte que faz o preço da
   * cena acompanhar quantas luzes *importam*, não quantas existem.
   */
  shadowThreshold: number;
  /** Teto de luzes que projetam sombra num mesmo fragmento. */
  maxShadowLights: number;
  /**
   * Soma a luz que chega de todo lado.
   *
   * Desligada só pelo preenchimento do chão, que existe para mostrar onde bate
   * luz *direta*: com o ambiente somado, todo fragmento passaria do limiar e o
   * vazio entre as linhas da grade — que é metade do estilo — sumiria.
   */
  ambient: boolean;
}

/** Rascunho de módulo: direção unitária até a luz, reaproveitado por luz. */
const lightDir: Vec3 = vec3();

/**
 * Direção unitária de um ponto até a luz, e a distância até ela.
 *
 * `-1` quando a luz está fora do alcance — o corte mais barato que existe.
 * Usada por `shadeOccluders`, que não tem uma normal para o `ndotl` mas ainda
 * precisa da mesma queda por distância.
 */
const lightDirection = (
  light: Light,
  px: number,
  py: number,
  pz: number,
  outDir: Vec3,
): number => {
  if (light.kind === LIGHT.DIRECTIONAL) {
    copy(outDir, light.direction);
    return Infinity;
  }

  const dx = light.position.x - px;
  const dy = light.position.y - py;
  const dz = light.position.z - pz;
  const distanceSq = dx * dx + dy * dy + dz * dz;

  const range = light.range;
  if (distanceSq > range * range) return -1;

  const distance = Math.sqrt(distanceSq);
  const inverse = distance > 0 ? 1 / distance : 0;
  set(outDir, dx * inverse, dy * inverse, dz * inverse);
  return distance;
};

/**
 * Queda de intensidade nessa direção e distância: quadrática ancorada mais
 * borda de cone. `0` fora do cone — quem chamar deve tratar como "sem luz".
 */
const lightFalloff = (
  light: Light,
  distance: number,
  lx: number,
  ly: number,
  lz: number,
): number => {
  if (light.kind === LIGHT.DIRECTIONAL) return 1;

  const range = light.range;
  const distanceSq = distance * distance;

  // Queda quadrática ancorada na distância de meia-força, vezes uma janela
  // que chega a zero no alcance. Sem a janela, cortar a luz no raio deixaria
  // um degrau visível de brilho no chão.
  const ratio = distanceSq / (range * range);
  const window = Math.max(0, 1 - ratio * ratio);
  let attenuation =
    (window * window * HALF_POWER_SQ) / (distanceSq + HALF_POWER_SQ);

  if (light.coneCos > -1) {
    // Quanto o fragmento está para dentro do cone. O eixo aponta para onde a
    // luz ilumina, então compara com `-l`.
    const cosAxis = -(
      lx * light.direction.x +
      ly * light.direction.y +
      lz * light.direction.z
    );
    if (cosAxis < light.coneCos) return 0;

    const edge = Math.min(1, (cosAxis - light.coneCos) / light.coneSoftness);
    attenuation *= edge;
  }

  return attenuation;
};

/**
 * Contribuição abaixo da qual não vale disparar raio de sombra — o mesmo
 * valor em todo lugar que monta um `ShadeOptions` ou o uniform equivalente
 * (`main.ts`, `render/shading.ts`, `render/gpu/presenter.ts`), para as três
 * cópias nunca discordarem.
 */
export const SHADOW_THRESHOLD = 0.004;

/**
 * Preenche `Occluder.tint` de todo corpo com material, a partir da luz que
 * bate nele — o que faz um espelho mostrar a cor certa (holofote vermelho
 * bate num monólito branco, o reflexo desse monólito fica vermelho) em vez
 * da fração fixa da cor crua de antes.
 *
 * Isotrópico, de propósito: um corpo inteiro (esfera ou caixa) não tem uma
 * normal só, então não há `ndotl` aqui, só irradiância chegando no centro do
 * corpo. Sem raio de sombra também — mantém o custo em
 * O(occluders × luzes), irrelevante perto do laço por fragmento (na cena de
 * referência, ~16×13 iterações por quadro). Chamado uma vez por quadro, de
 * `Scene.contribute()`, depois que `LightWorld.finalize()` já rodou — só aí
 * todo occluder e toda luz do quadro estão definitivos.
 */
export const shadeOccluders = (world: LightWorld): void => {
  for (let index = 0; index < world.occluderCount; index += 1) {
    const occluder = world.occluder(index);
    const material = occluder.material;
    if (material === null) continue;

    const { albedo } = material;
    const { x: px, y: py, z: pz } = occluder.center;

    let r = world.ambient.r * albedo.r;
    let g = world.ambient.g * albedo.g;
    let b = world.ambient.b * albedo.b;

    for (let lightIndex = 0; lightIndex < world.lightCount; lightIndex += 1) {
      const light = world.light(lightIndex);

      const distance = lightDirection(light, px, py, pz, lightDir);
      if (distance < 0) continue;

      const attenuation = lightFalloff(
        light,
        distance,
        lightDir.x,
        lightDir.y,
        lightDir.z,
      );
      if (attenuation <= 0) continue;

      const contribution = attenuation * light.intensity;
      r += albedo.r * light.color.r * contribution;
      g += albedo.g * light.color.g * contribution;
      b += albedo.b * light.color.b * contribution;
    }

    const emission = material.emissiveStrength;
    if (emission > 0) {
      r += material.emissive.r * emission;
      g += material.emissive.g * emission;
      b += material.emissive.b * emission;
    }

    setRgb(occluder.tint, r, g, b);
  }
};
