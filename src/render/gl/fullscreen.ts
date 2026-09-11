/**
 * Triângulo que cobre a tela, gerado a partir do `gl_VertexID`.
 *
 * Todo pass de pós-processamento usa este mesmo vertex shader: sem buffer de
 * vértices, sem atributos, sem VAO próprio. Um triângulo maior que a tela em
 * vez de dois triângulos de um quad, porque assim não há a costura diagonal no
 * meio onde as derivadas de textura se comportam mal.
 */
export const FULLSCREEN_VERTEX = `#version 300 es
out vec2 vUv;

void main() {
    vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    vUv = corner;
    gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}`;

export const drawFullscreen = (gl: WebGL2RenderingContext): void => {
  gl.drawArrays(gl.TRIANGLES, 0, 3);
};
