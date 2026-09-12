import type { Vec3 } from "./vec3";

/**
 * Matriz 4x4 column-major, na mesma convenção do WebGL.
 *
 * O `!` no acesso aos elementos é seguro e proposital: os índices são literais
 * de 0 a 15 sobre um `Float32Array(16)`, então estão provadamente dentro dos
 * limites. Sem ele, `noUncheckedIndexedAccess` transformaria cada leitura em
 * `number | undefined` e encheria a aritmética de `?? 0`.
 *
 * Elemento (linha r, coluna c) vive em `m[c * 4 + r]`.
 */
export type Mat4 = Float32Array;

export const create = (): Mat4 => new Float32Array(16);

export const identity = (out: Mat4): Mat4 => {
  out.fill(0);
  out[0] = 1;
  out[5] = 1;
  out[10] = 1;
  out[15] = 1;
  return out;
};

export const multiply = (out: Mat4, a: Mat4, b: Mat4): Mat4 => {
  for (let col = 0; col < 4; col += 1) {
    const b0 = b[col * 4]!;
    const b1 = b[col * 4 + 1]!;
    const b2 = b[col * 4 + 2]!;
    const b3 = b[col * 4 + 3]!;
    for (let row = 0; row < 4; row += 1) {
      out[col * 4 + row] =
        a[row]! * b0 + a[4 + row]! * b1 + a[8 + row]! * b2 + a[12 + row]! * b3;
    }
  }
  return out;
};

/**
 * Matriz de view a partir de posição, yaw e pitch — ou seja
 * `RotX(-pitch) · RotY(-yaw) · Translate(-pos)`, já multiplicada em forma fechada.
 *
 * Convenção destra: a câmera olha para -Z, yaw positivo gira para a esquerda
 * (visto de cima) e pitch positivo olha para cima.
 */
export const setView = (
  out: Mat4,
  pos: Vec3,
  yaw: number,
  pitch: number,
): Mat4 => {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);

  // Parte rotacional, por linha.
  const r00 = cy,
    r01 = 0,
    r02 = -sy;
  const r10 = sp * sy,
    r11 = cp,
    r12 = sp * cy;
  const r20 = cp * sy,
    r21 = -sp,
    r22 = cp * cy;

  out[0] = r00;
  out[4] = r01;
  out[8] = r02;
  out[1] = r10;
  out[5] = r11;
  out[9] = r12;
  out[2] = r20;
  out[6] = r21;
  out[10] = r22;
  out[3] = 0;
  out[7] = 0;
  out[11] = 0;
  out[15] = 1;

  // Translação = -R * pos, para a rotação acontecer em torno da câmera.
  out[12] = -(r00 * pos.x + r01 * pos.y + r02 * pos.z);
  out[13] = -(r10 * pos.x + r11 * pos.y + r12 * pos.z);
  out[14] = -(r20 * pos.x + r21 * pos.y + r22 * pos.z);

  return out;
};

/** Transforma um ponto afim (w implícito = 1). */
export const transformPoint = (
  out: Vec3,
  m: Mat4,
  x: number,
  y: number,
  z: number,
): Vec3 => {
  out.x = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
  out.y = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
  out.z = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
  return out;
};

/** Transforma uma direção: ignora a translação. É o que o céu usa. */
export const transformDirection = (
  out: Vec3,
  m: Mat4,
  x: number,
  y: number,
  z: number,
): Vec3 => {
  out.x = m[0]! * x + m[4]! * y + m[8]! * z;
  out.y = m[1]! * x + m[5]! * y + m[9]! * z;
  out.z = m[2]! * x + m[6]! * y + m[10]! * z;
  return out;
};

/**
 * Transforma uma direção pela transposta da parte rotacional.
 *
 * Para uma matriz de rotação a transposta é a inversa, então isto desfaz a
 * rotação sem inverter matriz nenhuma. É o que leva um ponto do espaço local de
 * um objeto de volta para o mundo, dada a mesma matriz que o traçado de raio usa
 * para ir na direção contrária — e usar a mesma matriz nos dois sentidos é o que
 * garante que a caixa desenhada e a caixa testada sejam a mesma caixa.
 */
export const transformDirectionTransposed = (
  out: Vec3,
  m: Mat4,
  x: number,
  y: number,
  z: number,
): Vec3 => {
  out.x = m[0]! * x + m[1]! * y + m[2]! * z;
  out.y = m[4]! * x + m[5]! * y + m[6]! * z;
  out.z = m[8]! * x + m[9]! * y + m[10]! * z;
  return out;
};
