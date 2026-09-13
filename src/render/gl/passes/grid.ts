import { EMISSIVE_RANGE } from "../../framebuffer";
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

export class GridPass {
  private readonly program: Program;

  private colCount = 0;
  private rowCount = 0;

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

  /** Só guarda a dimensão para o uniform — as texturas são do `ShadingPass`. */
  resize(colCount: number, rowCount: number): void {
    this.colCount = colCount;
    this.rowCount = rowCount;
  }

  /**
   * `data`/`color` são a saída do `ShadingPass` — o mesmo leiaute que a CPU
   * subia direto até este passo existir (`EMISSIVE_RANGE` incluso), então o
   * shader acima não mudou uma linha.
   */
  draw(data: WebGLTexture, color: WebGLTexture): void {
    const { gl, atlas } = this;
    if (atlas === null) return;

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, data);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, color);

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, atlas.texture);

    this.program.use();
    gl.uniform2f(this.program.uniform("uGridSize"), this.colCount, this.rowCount);
    gl.uniform2f(this.program.uniform("uAtlasGrid"), atlas.cols, atlas.rows);
    gl.uniform1f(this.program.uniform("uEmissiveRange"), EMISSIVE_RANGE);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  dispose(): void {
    this.program.dispose();
  }
}
