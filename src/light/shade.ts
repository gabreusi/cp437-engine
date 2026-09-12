import { luminance, type Rgb, rgb, setRgb } from "../math/color";
import { copy, set, type Vec3, vec3 } from "../math/vec3";
import { skyRadiance } from "./sky";
import { occluded, SHADOW_BIAS, traceNearest } from "./trace";
import { LIGHT, type Light, type Material } from "./types";
import type { LightWorld } from "./world";

/**
 * O kernel de sombreamento: uma superfície, todas as luzes, uma cor.
 *
 * Roda uma vez por célula de tela ocupada — dezenas de milhares de vezes por
 * quadro. Isso dita a forma do código: nada de alocar, nada de fechar sobre
 * variável, e cada luz sai o mais cedo possível. A resolução é o que torna isto
 * viável: a grade tem 180 colunas, não 1920, então o orçamento por fragmento é
 * cem vezes o de um shader de pixel.
 *
 * A ordem das saídas antecipadas não é arbitrária. Distância antes de ângulo,
 * ângulo antes de raio de sombra: a conta cara é a última, e quase nenhum
 * fragmento chega até ela.
 */

/** Quem não é um corpo da cena. O chão, por exemplo. */
export const NO_OWNER = -1;

/** Até onde um raio de espelho procura antes de desistir e ver o céu. */
const MIRROR_RANGE = 400;

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
 * Direção unitária da superfície até a luz, e a distância até ela.
 *
 * `-1` quando a luz está fora do alcance — o corte mais barato que existe, e
 * o que quase todo fragmento usa; extraído para ser reaproveitado também por
 * `shadeOccluders`, que não tem uma normal para o `ndotl` mas ainda precisa
 * da mesma queda por distância.
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

const reflected: Rgb = rgb();

/**
 * Opções da chamada aninhada de `reflectGround`: sem sombra (custaria um
 * raio extra por reflexo), sem reflexo (trava a recursão em um bounce só,
 * igual ao resto do espelho) e com ambiente ligado — diferente do
 * preenchimento do próprio chão (`Ground`), que desliga ambiente de
 * propósito para não afogar o contraste da grade; aqui não há grade para
 * afogar, só um reflexo que não pode ficar preto longe de luz direta.
 */
const GROUND_REFLECT_OPTIONS: ShadeOptions = {
  shadows: false,
  reflections: false,
  shadowThreshold: 0.004,
  maxShadowLights: 0,
  ambient: true,
};

/**
 * O que um raio de espelho vê ao acertar o plano do chão (`y = 0`) — a
 * mesma conta de luz de qualquer superfície, num bounce só. `false` se o
 * raio não cruza o chão dentro do alcance do espelho, ou não há chão na
 * cena (`world.groundMaterial` nulo).
 */
const reflectGround = (
  world: LightWorld,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  out: Rgb,
): boolean => {
  const material = world.groundMaterial;
  if (material === null || dy >= 0) return false;

  const t = -oy / dy;
  if (!(t > SHADOW_BIAS) || t >= MIRROR_RANGE) return false;

  shadeSurface(
    world,
    material,
    ox + dx * t,
    0,
    oz + dz * t,
    0,
    1,
    0,
    -dx,
    -dy,
    -dz,
    NO_OWNER,
    GROUND_REFLECT_OPTIONS,
    out,
  );
  return true;
};

export const shadeSurface = (
  world: LightWorld,
  material: Material,
  px: number,
  py: number,
  pz: number,
  normalX: number,
  normalY: number,
  normalZ: number,
  viewX: number,
  viewY: number,
  viewZ: number,
  ownerId: number,
  options: ShadeOptions,
  out: Rgb,
): number => {
  let nx = normalX;
  let ny = normalY;
  let nz = normalZ;
  let ndotv = nx * viewX + ny * viewY + nz * viewZ;

  // A normal encara quem olha. Uma aresta de wireframe não tem lado de dentro
  // e de fora, e uma placa vista por trás ficaria preta sem isto.
  if (ndotv < 0) {
    nx = -nx;
    ny = -ny;
    nz = -nz;
    ndotv = -ndotv;
  }

  const { albedo } = material;
  let r = 0;
  let g = 0;
  let b = 0;
  if (options.ambient) {
    r = world.ambient.r * albedo.r;
    g = world.ambient.g * albedo.g;
    b = world.ambient.b * albedo.b;
  }

  // O raio de sombra parte um pouco acima da superfície: começar nela mesma
  // acerta a si próprio no primeiro passo e a cena inteira sai escura.
  const originX = px + nx * SHADOW_BIAS;
  const originY = py + ny * SHADOW_BIAS;
  const originZ = pz + nz * SHADOW_BIAS;

  let shadowRays = 0;

  for (let index = 0; index < world.lightCount; index += 1) {
    const light = world.light(index);

    const distance = lightDirection(light, px, py, pz, lightDir);
    if (distance < 0) continue;
    const lx = lightDir.x;
    const ly = lightDir.y;
    const lz = lightDir.z;

    const attenuation = lightFalloff(light, distance, lx, ly, lz);
    if (attenuation <= 0) continue;

    const ndotl = nx * lx + ny * ly + nz * lz;
    if (ndotl <= 0) continue;

    const contribution = ndotl * attenuation * light.intensity;
    if (contribution < options.shadowThreshold) continue;

    if (
      options.shadows &&
      light.castsShadow &&
      shadowRays < options.maxShadowLights
    ) {
      shadowRays += 1;
      if (
        occluded(
          world,
          originX,
          originY,
          originZ,
          lx,
          ly,
          lz,
          distance,
          ownerId,
        )
      ) {
        continue;
      }
    }

    r += albedo.r * light.color.r * contribution;
    g += albedo.g * light.color.g * contribution;
    b += albedo.b * light.color.b * contribution;

    // Especular de Blinn-Phong: o meio-vetor entre luz e olho. Barato, e é
    // a aproximação de "a luz é pequena o bastante para ser um ponto" — que
    // é verdade para os orbes e mentira só para o sol, que tem o seu
    // próprio disco no reflexo do céu.
    if (material.reflectivity > 0) {
      let hx = lx + viewX;
      let hy = ly + viewY;
      let hz = lz + viewZ;
      const length = Math.sqrt(hx * hx + hy * hy + hz * hz);
      if (length > 0) {
        hx /= length;
        hy /= length;
        hz /= length;

        const ndoth = nx * hx + ny * hy + nz * hz;
        if (ndoth > 0) {
          const specular =
            Math.pow(ndoth, material.gloss) *
            material.reflectivity *
            attenuation *
            light.intensity;
          r += light.color.r * specular;
          g += light.color.g * specular;
          b += light.color.b * specular;
        }
      }
    }
  }

  if (options.reflections && material.reflectivity > 0) {
    // Espelhamento do olhar em torno da normal.
    const twice = 2 * ndotv;
    const rx = nx * twice - viewX;
    const ry = ny * twice - viewY;
    const rz = nz * twice - viewZ;

    const hit = material.mirror
      ? traceNearest(
          world,
          originX,
          originY,
          originZ,
          rx,
          ry,
          rz,
          MIRROR_RANGE,
          ownerId,
        )
      : null;

    if (hit !== null) {
      // Um bounce: o que o espelho mostra do corpo é a cor dele, já
      // considerando a luz que bate nele (`shadeOccluders`) — não uma
      // segunda rodada de iluminação aqui. Recursão aqui multiplicaria o
      // custo por fragmento e o ganho seria espelho dentro de espelho.
      setRgb(reflected, hit.tint.r, hit.tint.g, hit.tint.b);
    } else if (
      !(
        material.mirror &&
        reflectGround(world, originX, originY, originZ, rx, ry, rz, reflected)
      )
    ) {
      skyRadiance(world.sky, rx, ry, rz, material.gloss, reflected);
    }

    const amount = material.reflectivity;
    r += reflected.r * amount;
    g += reflected.g * amount;
    b += reflected.b * amount;
  }

  const emission = material.emissiveStrength;
  if (emission > 0) {
    r += material.emissive.r * emission;
    g += material.emissive.g * emission;
    b += material.emissive.b * emission;
  }

  setRgb(out, r, g, b);
  return luminance(out);
};

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
