import { EMISSIVE_RANGE } from "../../framebuffer";
import { FULLSCREEN_VERTEX_WGSL, drawFullscreen } from "../fullscreen";
import type { GlyphAtlas } from "../atlas";

/**
 * O grid inteiro num draw call. Lê os dois planos que `ShadingPass` escreveu
 * (`textureLoad`, célula exata, sem sampler) e o atlas (`textureSample`,
 * fracionário dentro da célula).
 */
const fragmentSource = (): string => `
struct Params {
  gridSize: vec2f,
  atlasGrid: vec2f,
  emissiveRange: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
};

@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var cellsData: texture_2d<f32>;
@group(0) @binding(2) var colorsData: texture_2d<f32>;
@group(0) @binding(3) var atlas: texture_2d<f32>;
@group(0) @binding(4) var atlasSampler: sampler;

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  // uv.y cresce para cima, mas a fileira 0 do grid é a de cima.
  let gridPos = vec2f(uv.x, 1.0 - uv.y) * p.gridSize;
  let cell = clamp(vec2i(gridPos), vec2i(0, 0), vec2i(p.gridSize) - vec2i(1, 1));

  let data = textureLoad(cellsData, cell, 0);
  let alpha = data.g;

  let colorData = textureLoad(colorsData, cell, 0);
  let opaque = colorData.a > 0.5;

  let glyph = i32(data.r * 255.0 + 0.5);
  let atlasCols = i32(p.atlasGrid.x);
  let glyphCell = vec2f(f32(glyph % atlasCols), f32(glyph / atlasCols));
  // Margem contra a borda da célula: perto de 0.0/1.0 exatos, o
  // arredondamento do filtro nearest diverge entre backends (Vulkan no
  // Linux, D3D12 no Windows) e pode amostrar um texel da célula vizinha,
  // aparecendo como risco vertical na lateral do glifo.
  let cellFrac = clamp(fract(gridPos), vec2f(0.091), vec2f(0.9));
  let atlasUv = (glyphCell + cellFrac) / p.atlasGrid;

  let coverage = textureSample(atlas, atlasSampler, atlasUv).a;

  let rgb = colorData.rgb * (1.0 + data.b * p.emissiveRange);

  let finalAlpha = select(coverage * alpha, alpha, opaque);
  let finalRgb = select(rgb, vec3f(0.0), opaque && coverage <= 0.0);

  if (finalAlpha <= 0.0) { discard; }
  return vec4f(finalRgb, finalAlpha);
}
`;

export class GridPass {
  private readonly pipeline: GPURenderPipeline;
  private readonly sampler: GPUSampler;
  private readonly paramsBuffer: GPUBuffer;
  private readonly paramsData = new Float32Array(8);

  private atlas: GlyphAtlas | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private colCount = 0;
  private rowCount = 0;

  constructor(
    private readonly device: GPUDevice,
    targetFormat: GPUTextureFormat,
  ) {
    const module = device.createShaderModule({
      label: "grid",
      code: FULLSCREEN_VERTEX_WGSL + fragmentSource(),
    });

    this.pipeline = device.createRenderPipeline({
      label: "grid-pipeline",
      layout: "auto",
      vertex: { module, entryPoint: "vs_main" },
      fragment: {
        module,
        entryPoint: "fs_main",
        targets: [
          {
            format: targetFormat,
            blend: {
              color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
              alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
            },
          },
        ],
      },
      primitive: { topology: "triangle-list" },
    });

    this.sampler = device.createSampler({
      magFilter: "nearest",
      minFilter: "nearest",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });

    this.paramsBuffer = device.createBuffer({
      label: "grid-params",
      size: this.paramsData.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  setAtlas(atlas: GlyphAtlas): void {
    this.atlas = atlas;
    this.bindGroup = null;
  }

  resize(colCount: number, rowCount: number): void {
    this.colCount = colCount;
    this.rowCount = rowCount;
    this.bindGroup = null;
  }

  private rebuildBindGroup(cellsTexture: GPUTexture, colorsTexture: GPUTexture): void {
    if (this.atlas === null) return;
    this.bindGroup = this.device.createBindGroup({
      label: "grid-bind-group",
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.paramsBuffer } },
        { binding: 1, resource: cellsTexture.createView() },
        { binding: 2, resource: colorsTexture.createView() },
        { binding: 3, resource: this.atlas.view },
        { binding: 4, resource: this.sampler },
      ],
    });
  }

  draw(pass: GPURenderPassEncoder, cellsTexture: GPUTexture, colorsTexture: GPUTexture): void {
    if (this.atlas === null) return;
    if (this.bindGroup === null) this.rebuildBindGroup(cellsTexture, colorsTexture);
    if (this.bindGroup === null) return;

    const { atlas } = this;
    const d = this.paramsData;
    d[0] = this.colCount;
    d[1] = this.rowCount;
    d[2] = atlas.cols;
    d[3] = atlas.rows;
    d[4] = EMISSIVE_RANGE;
    d[5] = 0;
    d[6] = 0;
    d[7] = 0;
    this.device.queue.writeBuffer(this.paramsBuffer, 0, d);

    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    drawFullscreen(pass);
  }

  dispose(): void {
    this.paramsBuffer.destroy();
  }
}
