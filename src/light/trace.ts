import * as mat4 from '../math/mat4';
import { type Vec3, vec3 } from '../math/vec3';
import { OCCLUDER, type Occluder } from './types';
import type { LightWorld } from './world';

/**
 * Traçado de raio contra as formas analíticas da cena.
 *
 * Analítico e não contra malha: o que a engine desenha é wireframe, e um raio
 * não acerta aresta. Cada objeto declara a esfera ou a caixa que o representa,
 * e o custo do teste passa a ser constante — que é o que torna possível fazer
 * isto uma vez por célula da tela, sessenta vezes por segundo, sem estrutura de
 * aceleração nenhuma. Com uma dúzia de corpos, uma BVH custaria mais para
 * manter do que economiza.
 */

/** Rascunhos de módulo: este código roda por fragmento, por luz. */
const localOrigin: Vec3 = vec3();
const localDir: Vec3 = vec3();

/** Abaixo disto o raio é paralelo ao slab e o teste vira divisão por zero. */
const PARALLEL_EPSILON = 1e-9;

/**
 * Deslocamento da origem do raio de sombra ao longo da normal.
 *
 * Sem ele a superfície acerta a si mesma no primeiro passo e a cena inteira sai
 * em sombra — o acne clássico. A alternativa é ignorar o próprio corpo, e as
 * duas são necessárias: ignorar resolve a face que emitiu o raio, o desvio
 * resolve a face vizinha do mesmo corpo.
 */
export const SHADOW_BIAS = 2e-3;

/** Distância até a esfera, ou -1. O raio precisa ter direção unitária. */
export const raySphere = (
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    center: Vec3, radius: number,
): number => {
    const cx = ox - center.x;
    const cy = oy - center.y;
    const cz = oz - center.z;

    const b = cx * dx + cy * dy + cz * dz;
    const c = cx * cx + cy * cy + cz * cz - radius * radius;

    // Discriminante negativo: a linha passa ao lado da esfera.
    const discriminant = b * b - c;
    if (discriminant < 0) return -1;

    const root = Math.sqrt(discriminant);
    const near = -b - root;
    if (near >= 0) return near;

    // Origem dentro da esfera: a saída é o primeiro cruzamento à frente.
    const far = -b + root;
    return far >= 0 ? far : -1;
};

/**
 * Distância até a caixa orientada, ou -1.
 *
 * O teste é o de slabs alinhado aos eixos de sempre; o que orienta a caixa é
 * levar o raio para o espaço local dela primeiro. Como a parte rotacional é
 * ortonormal, a distância medida lá é a mesma que aqui, e não precisa voltar.
 */
export const rayBox = (
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    occluder: Occluder,
): number => {
    mat4.transformPoint(localOrigin, occluder.toLocal, ox, oy, oz);
    mat4.transformDirection(localDir, occluder.toLocal, dx, dy, dz);

    const { half } = occluder;
    let entry = -Infinity;
    let exit = Infinity;

    // Três slabs, escritos abertos: um laço sobre eixos custaria indexação de
    // objeto em código que roda milhões de vezes por segundo.
    let o = localOrigin.x, d = localDir.x, h = half.x;
    if (Math.abs(d) < PARALLEL_EPSILON) {
        if (o < -h || o > h) return -1;
    } else {
        const inverse = 1 / d;
        let t0 = (-h - o) * inverse;
        let t1 = (h - o) * inverse;
        if (t0 > t1) { const swap = t0; t0 = t1; t1 = swap; }
        if (t0 > entry) entry = t0;
        if (t1 < exit) exit = t1;
        if (entry > exit) return -1;
    }

    o = localOrigin.y; d = localDir.y; h = half.y;
    if (Math.abs(d) < PARALLEL_EPSILON) {
        if (o < -h || o > h) return -1;
    } else {
        const inverse = 1 / d;
        let t0 = (-h - o) * inverse;
        let t1 = (h - o) * inverse;
        if (t0 > t1) { const swap = t0; t0 = t1; t1 = swap; }
        if (t0 > entry) entry = t0;
        if (t1 < exit) exit = t1;
        if (entry > exit) return -1;
    }

    o = localOrigin.z; d = localDir.z; h = half.z;
    if (Math.abs(d) < PARALLEL_EPSILON) {
        if (o < -h || o > h) return -1;
    } else {
        const inverse = 1 / d;
        let t0 = (-h - o) * inverse;
        let t1 = (h - o) * inverse;
        if (t0 > t1) { const swap = t0; t0 = t1; t1 = swap; }
        if (t0 > entry) entry = t0;
        if (t1 < exit) exit = t1;
        if (entry > exit) return -1;
    }

    if (exit < 0) return -1;
    return entry >= 0 ? entry : exit;
};

/** Distância até um corpo qualquer, ou -1. */
export const rayOccluder = (
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    occluder: Occluder,
): number =>
    occluder.kind === OCCLUDER.SPHERE
        ? raySphere(ox, oy, oz, dx, dy, dz, occluder.center, occluder.radius)
        : rayBox(ox, oy, oz, dx, dy, dz, occluder);

/**
 * Existe corpo entre o ponto e a luz?
 *
 * Sai no primeiro acerto: para sombra a pergunta é binária, e continuar
 * procurando o mais próximo seria trabalho jogado fora. `ignoreId` deixa a
 * superfície não se sombrear com o próprio corpo.
 */
export const occluded = (
    world: LightWorld,
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    maxDistance: number,
    ignoreId: number,
): boolean => {
    for (let index = 0; index < world.occluderCount; index += 1) {
        const occluder = world.occluder(index);
        if (!occluder.castsShadow || occluder.ownerId === ignoreId) continue;

        const hit = rayOccluder(ox, oy, oz, dx, dy, dz, occluder);
        if (hit > SHADOW_BIAS && hit < maxDistance) return true;
    }
    return false;
};

/**
 * O corpo mais próximo no caminho do raio, ou `null`.
 *
 * Aqui, ao contrário da sombra, o mais próximo importa: é o que o espelho
 * mostra.
 */
export const traceNearest = (
    world: LightWorld,
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    maxDistance: number,
    ignoreId: number,
): Occluder | null => {
    let best: Occluder | null = null;
    let bestDistance = maxDistance;

    for (let index = 0; index < world.occluderCount; index += 1) {
        const occluder = world.occluder(index);
        if (occluder.ownerId === ignoreId) continue;

        const hit = rayOccluder(ox, oy, oz, dx, dy, dz, occluder);
        if (hit > SHADOW_BIAS && hit < bestDistance) {
            bestDistance = hit;
            best = occluder;
        }
    }
    return best;
};
