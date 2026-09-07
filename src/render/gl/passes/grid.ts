import type { Framebuffer } from '../../framebuffer';
import { PALETTE_SIZE, buildPaletteTexels } from '../../palette';
import type { GlyphAtlas } from '../atlas';
import { Program } from '../program';

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
 * O fragmento descobre em que célula caiu, lê o índice do glifo e o da cor na
 * data texture, e amostra o atlas na sub-região correspondente. É isso que
 * substitui montar milhares de <span> por quadro.
 */
const FRAGMENT_SOURCE = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uGridData;
uniform sampler2D uAtlas;
uniform sampler2D uPalette;
uniform vec2 uGridSize;
uniform vec2 uAtlasGrid;

void main() {
    // vUv.y cresce para cima, mas a fileira 0 do grid é a de cima.
    vec2 gridPos = vec2(vUv.x, 1.0 - vUv.y) * uGridSize;
    ivec2 cell = clamp(ivec2(gridPos), ivec2(0), ivec2(uGridSize) - 1);

    vec4 data = texelFetch(uGridData, cell, 0);
    float alpha = data.b;
    if (alpha <= 0.0) discard;

    int glyph = int(data.r * 255.0 + 0.5);
    int atlasCols = int(uAtlasGrid.x);
    vec2 glyphCell = vec2(float(glyph % atlasCols), float(glyph / atlasCols));
    vec2 atlasUv = (glyphCell + fract(gridPos)) / uAtlasGrid;

    float coverage = texture(uAtlas, atlasUv).a;
    if (coverage <= 0.0) discard;

    int color = int(data.g * 255.0 + 0.5);
    vec3 rgb = texelFetch(uPalette, ivec2(color, 0), 0).rgb;

    fragColor = vec4(rgb, coverage * alpha);
}`;

const createDataTexture = (
    gl: WebGL2RenderingContext,
    width: number,
    height: number,
): WebGLTexture => {
    const texture = gl.createTexture();
    if (texture === null) throw new Error('Não foi possível criar a textura de dados.');

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
    private readonly palette: WebGLTexture;

    private data: WebGLTexture | null = null;
    private dataWidth = 0;
    private dataHeight = 0;

    private atlas: GlyphAtlas | null = null;

    constructor(private readonly gl: WebGL2RenderingContext) {
        this.program = new Program(gl, VERTEX_SOURCE, FRAGMENT_SOURCE);

        const palette = gl.createTexture();
        if (palette === null) throw new Error('Não foi possível criar a textura da paleta.');
        this.palette = palette;

        gl.bindTexture(gl.TEXTURE_2D, palette);
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, PALETTE_SIZE, 1);
        gl.texSubImage2D(
            gl.TEXTURE_2D, 0, 0, 0, PALETTE_SIZE, 1,
            gl.RGBA, gl.UNSIGNED_BYTE, buildPaletteTexels(),
        );
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

        this.program.use();
        this.program.setTextureUnit('uGridData', 0);
        this.program.setTextureUnit('uAtlas', 1);
        this.program.setTextureUnit('uPalette', 2);
    }

    setAtlas(atlas: GlyphAtlas): void {
        this.atlas = atlas;
    }

    /** A data texture tem o tamanho exato do grid, então segue o viewport. */
    resize(colCount: number, rowCount: number): void {
        if (this.dataWidth === colCount && this.dataHeight === rowCount && this.data !== null) {
            return;
        }
        if (this.data !== null) this.gl.deleteTexture(this.data);

        this.data = createDataTexture(this.gl, colCount, rowCount);
        this.dataWidth = colCount;
        this.dataHeight = rowCount;
    }

    draw(framebuffer: Framebuffer): void {
        const { gl, atlas, data } = this;
        if (atlas === null || data === null) return;

        // A única transferência CPU→GPU do quadro: ~40 KB.
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, data);
        gl.texSubImage2D(
            gl.TEXTURE_2D, 0, 0, 0, this.dataWidth, this.dataHeight,
            gl.RGBA, gl.UNSIGNED_BYTE, framebuffer.data,
        );

        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, atlas.texture);
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, this.palette);

        this.program.use();
        gl.uniform2f(this.program.uniform('uGridSize'), this.dataWidth, this.dataHeight);
        gl.uniform2f(this.program.uniform('uAtlasGrid'), atlas.cols, atlas.rows);

        gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    dispose(): void {
        this.program.dispose();
        this.gl.deleteTexture(this.palette);
        if (this.data !== null) this.gl.deleteTexture(this.data);
        this.data = null;
    }
}
