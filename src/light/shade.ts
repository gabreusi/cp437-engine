import { luminance, type Rgb, rgb, setRgb } from "../math/color";
import { skyRadiance } from "./sky";
import { occluded, SHADOW_BIAS, traceNearest } from "./trace";
import { LIGHT, type Material } from "./types";
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

const reflected: Rgb = rgb();

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

    let lx: number;
    let ly: number;
    let lz: number;
    let distance: number;
    let attenuation: number;

    if (light.kind === LIGHT.DIRECTIONAL) {
      lx = light.direction.x;
      ly = light.direction.y;
      lz = light.direction.z;
      distance = Infinity;
      attenuation = 1;
    } else {
      const dx = light.position.x - px;
      const dy = light.position.y - py;
      const dz = light.position.z - pz;
      const distanceSq = dx * dx + dy * dy + dz * dz;

      // O corte mais barato que existe, e o que quase todo fragmento usa.
      const range = light.range;
      if (distanceSq > range * range) continue;

      distance = Math.sqrt(distanceSq);
      const inverse = distance > 0 ? 1 / distance : 0;
      lx = dx * inverse;
      ly = dy * inverse;
      lz = dz * inverse;

      // Queda quadrática ancorada na distância de meia-força, vezes uma
      // janela que chega a zero no alcance. Sem a janela, cortar a luz no
      // raio deixaria um degrau visível de brilho no chão.
      const ratio = distanceSq / (range * range);
      const window = Math.max(0, 1 - ratio * ratio);
      attenuation =
        (window * window * HALF_POWER_SQ) / (distanceSq + HALF_POWER_SQ);

      if (light.coneCos > -1) {
        // Quanto o fragmento está para dentro do cone. O eixo aponta
        // para onde a luz ilumina, então compara com `-l`.
        const cosAxis = -(
          lx * light.direction.x +
          ly * light.direction.y +
          lz * light.direction.z
        );
        if (cosAxis < light.coneCos) continue;

        const edge = Math.min(
          1,
          (cosAxis - light.coneCos) / light.coneSoftness,
        );
        attenuation *= edge;
      }
    }

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
      // Um bounce: o que o espelho mostra do corpo é a cor dele, não uma
      // segunda rodada de iluminação. Recursão aqui multiplicaria o custo
      // por fragmento e o ganho seria espelho dentro de espelho.
      setRgb(reflected, hit.tint.r, hit.tint.g, hit.tint.b);
    } else {
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
