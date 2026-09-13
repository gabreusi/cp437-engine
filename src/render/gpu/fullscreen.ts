/**
 * Triângulo que cobre a tela, gerado a partir do `vertex_index` — a
 * contraparte WGSL de `render/gl/fullscreen.ts`. Todo pass de
 * pós-processamento usa este mesmo vertex shader: sem buffer de vértices,
 * sem atributos.
 */
export const FULLSCREEN_VERTEX_WGSL = `
struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOut {
  let corner = vec2f(f32((vertexIndex << 1u) & 2u), f32(vertexIndex & 2u));
  var out: VertexOut;
  out.uv = corner;
  out.position = vec4f(corner * 2.0 - 1.0, 0.0, 1.0);
  return out;
}
`;

export const drawFullscreen = (pass: GPURenderPassEncoder): void => {
  pass.draw(3);
};
