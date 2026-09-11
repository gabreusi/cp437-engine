import { EMISSIVE_RANGE, type Framebuffer } from "../../framebuffer";
import type { GlyphAtlas } from "../atlas";
import { Program } from "../program";

/**
 * Triângulo que cobre a tela inteira, gerado a partir do `gl_VertexID`.
 * Sem buffer de vértices, sem atributos: o WebGL2 deixa desenhar assim.
 */
const VERTEX_SOURCE = `#version 300 es
out vec2 vUv;

void main() {
    vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    vUv = corner;
    gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}`;

/**
 * O grid inteiro em um draw call.
 *
 * O fragmento descobre em que célula caiu, lê glifo e cor nas duas data
 * textures, e amostra o atlas na sub-região correspondente. É isso que
 * substitui montar milhares de <span> por quadro.
 *
 * A cor vem de uma textura própria em vez de um índice de paleta: com luz
 * colorida a cor de uma célula é resultado de conta, não escolha numa tabela.
 */
const FRAGMENT_SOURCE = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uGridData;
uniform sampler2D uGridColor;
uniform sampler2D uAtlas;
uniform vec2 uGridSize;
uniform vec2 uAtlasGrid;
uniform float uEmissiveRange;

void main() {
    // vUv.y cresce para cima, mas a fileira 0 do grid é a de cima.
    vec2 gridPos = vec2(vUv.x, 1.0 - vUv.y) * uGridSize;
    ivec2 cell = clamp(ivec2(gridPos), ivec2(0), ivec2(uGridSize) - 1);

    vec4 data = texelFetch(uGridData, cell, 0);
    float alpha = data.g;
    if (alpha <= 0.0) discard;

    vec4 colorData = texelFetch(uGridColor, cell, 0);
    // Marca de Framebuffer.plot: corpo sólido (hachura de face), não
    // traço. Ver o comentário lá — sem ela o vão entre a tinta de um glifo
    // escuro deixaria passar o que está atrás de um corpo opaco.
    bool opaque = colorData.a > 0.5;

    int glyph = int(data.r * 255.0 + 0.5);
    int atlasCols = int(uAtlasGrid.x);
    vec2 glyphCell = vec2(float(glyph % atlasCols), float(glyph / atlasCols));
    vec2 atlasUv = (glyphCell + fract(gridPos)) / uAtlasGrid;

    float coverage = texture(uAtlas, atlasUv).a;
    if (coverage <= 0.0 && !opaque) discard;

    // O emissivo é o que deixa a célula passar de 1.0 e virar halo no bloom,
    // que não tem bright-pass: quem estoura é quem brilha.
    vec3 rgb = colorData.rgb * (1.0 + data.b * uEmissiveRange);

    // Traço (linha de grade, estrela, aresta) continua sendo tinta sobre o
    // vazio: o vão entre os traços do glifo deixa passar o que está atrás,
    // de propósito. Corpo sólido bloqueia sempre — coberto pela tinta ou
    // não —, senão a face escura de um objeto vira janela para o céu.
    float finalAlpha = opaque ? alpha : coverage * alpha;
    vec3 finalRgb = (opaque && coverage <= 0.0) ? vec3(0.0) : rgb;

    fragColor = vec4(finalRgb, finalAlpha);
}`;

const createDataTexture = (
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
): WebGLTexture => {
  const texture = gl.createTexture();
  if (texture === null)
    throw new Error("Não foi possível criar a textura de dados.");

  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
};

export class GridPass {
  private readonly program: Program;

  private data: WebGLTexture | null = null;
  private color: WebGLTexture | null = null;
  private dataWidth = 0;
  private dataHeight = 0;

  private atlas: GlyphAtlas | null = null;

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.program = new Program(gl, VERTEX_SOURCE, FRAGMENT_SOURCE);

    this.program.use();
    this.program.setTextureUnit("uGridData", 0);
    this.program.setTextureUnit("uGridColor", 1);
    this.program.setTextureUnit("uAtlas", 2);
  }

  setAtlas(atlas: GlyphAtlas): void {
    this.atlas = atlas;
  }

  /** As data textures têm o tamanho exato do grid, então seguem o viewport. */
  resize(colCount: number, rowCount: number): void {
    if (
      this.dataWidth === colCount &&
      this.dataHeight === rowCount &&
      this.data !== null &&
      this.color !== null
    ) {
      return;
    }
    if (this.data !== null) this.gl.deleteTexture(this.data);
    if (this.color !== null) this.gl.deleteTexture(this.color);

    this.data = createDataTexture(this.gl, colCount, rowCount);
    this.color = createDataTexture(this.gl, colCount, rowCount);
    this.dataWidth = colCount;
    this.dataHeight = rowCount;
  }

  draw(framebuffer: Framebuffer): void {
    const { gl, atlas, data, color } = this;
    if (atlas === null || data === null || color === null) return;

    // A única transferência CPU→GPU do quadro: dois planos, ~172 KB.
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, data);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      this.dataWidth,
      this.dataHeight,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      framebuffer.cells,
    );

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, color);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      this.dataWidth,
      this.dataHeight,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      framebuffer.colors,
    );

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, atlas.texture);

    this.program.use();
    gl.uniform2f(
      this.program.uniform("uGridSize"),
      this.dataWidth,
      this.dataHeight,
    );
    gl.uniform2f(this.program.uniform("uAtlasGrid"), atlas.cols, atlas.rows);
    gl.uniform1f(this.program.uniform("uEmissiveRange"), EMISSIVE_RANGE);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  dispose(): void {
    this.program.dispose();
    if (this.data !== null) this.gl.deleteTexture(this.data);
    if (this.color !== null) this.gl.deleteTexture(this.color);
    this.data = null;
    this.color = null;
  }
}
