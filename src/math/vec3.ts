/**
 * Vetores como objetos mutáveis com destino explícito.
 *
 * As funções escrevem em `out` em vez de devolver um objeto novo porque isso
 * roda por vértice, dentro do laço de render. Alocar aqui seria entregar
 * trabalho ao coletor de lixo 60 vezes por segundo.
 */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const vec3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });

export const set = (out: Vec3, x: number, y: number, z: number): Vec3 => {
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
};

export const copy = (out: Vec3, a: Vec3): Vec3 => set(out, a.x, a.y, a.z);

export const add = (out: Vec3, a: Vec3, b: Vec3): Vec3 =>
  set(out, a.x + b.x, a.y + b.y, a.z + b.z);

export const sub = (out: Vec3, a: Vec3, b: Vec3): Vec3 =>
  set(out, a.x - b.x, a.y - b.y, a.z - b.z);

export const scale = (out: Vec3, a: Vec3, s: number): Vec3 =>
  set(out, a.x * s, a.y * s, a.z * s);

/** `out = a + b * s`. O passo de integração mais comum, em uma chamada só. */
export const addScaled = (out: Vec3, a: Vec3, b: Vec3, s: number): Vec3 =>
  set(out, a.x + b.x * s, a.y + b.y * s, a.z + b.z * s);

/** Interpola entre `a` e `b`. Usado pelo clipping no near plane. */
export const lerp = (out: Vec3, a: Vec3, b: Vec3, t: number): Vec3 =>
  set(out, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);

export const dot = (a: Vec3, b: Vec3): number =>
  a.x * b.x + a.y * b.y + a.z * b.z;

export const length = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);

export const normalize = (out: Vec3, a: Vec3): Vec3 => {
  const len = length(a);
  return len === 0 ? set(out, 0, 0, 0) : scale(out, a, 1 / len);
};

export const cross = (out: Vec3, a: Vec3, b: Vec3): Vec3 =>
  set(out, a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
