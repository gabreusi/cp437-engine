import { FULLSCREEN_VERTEX_WGSL, drawFullscreen } from "../fullscreen";

/**
 * Junta cena e bloom e aplica o tratamento de CRT — a contraparte WGSL de
 * `render/gl/passes/composite.ts`.
 */
const fragmentSource = (): string => `
struct Params {
  bloomIntensity: f32,
  scanlinePeriod: f32,
  scanlineStrength: f32,
  vignetteStrength: f32,
};

@group(0) @binding(0) var scene: texture_2d<f32>;
@group(0) @binding(1) var bloomHalf: texture_2d<f32>;
@group(0) @binding(2) var bloomQuarter: texture_2d<f32>;
@group(0) @binding(3) var linearSampler: sampler;
@group(0) @binding(4) var<uniform> p: Params;

@fragment
fn fs_main(@builtin(position) fragCoord: vec4f, @location(0) uv: vec2f) -> @location(0) vec4f {
  // scene só passou por UMA amostragem desde que foi rasterizada (esta
  // aqui); bloomHalf/bloomQuarter já passaram por várias no próprio
  // pipeline de bloom (downsample + dois borrões). Cada textureSample de
  // uma textura populada por rasterização (não por upload da CPU) inverte o
  // V — um número par de amostragens cancela sozinho, ímpar não. bloomHalf
  // sai de 3 passes (downsample + 2 borrões) e esta é a 4ª: par, sem
  // correção. bloomQuarter nasce de bloomHalf — mais um downsample e mais
  // dois borrões, 6 passes — e esta é a 7ª: ímpar, precisa da mesma
  // correção de scene. Só bloomHalf chega com paridade par de verdade.
  let base = textureSample(scene, linearSampler, vec2f(uv.x, 1.0 - uv.y)).rgb;

  let bloom = textureSample(bloomHalf, linearSampler, uv).rgb * 0.65
            + textureSample(bloomQuarter, linearSampler, vec2f(uv.x, 1.0 - uv.y)).rgb * 0.55;

  var color = base + bloom * p.bloomIntensity;

  let phase = fract(fragCoord.y / p.scanlinePeriod);
  let scanline = select(1.0 - p.scanlineStrength, 1.0, phase < 0.4);

  let centered = (uv - 0.5) * 2.0;
  let vignette = 1.0 - p.vignetteStrength
      * smoothstep(0.35, 1.15, length(centered / vec2f(1.2, 1.0)));

  color *= scanline * vignette;
  color = vec3f(1.0) - exp(-color * 1.4);

  return vec4f(color, 1.0);
}
`;

export interface CompositeOptions {
  bloomIntensity: number;
  scanlinePeriod: number;
  scanlineStrength: number;
  vignetteStrength: number;
}

export class CompositePass {
  private readonly pipeline: GPURenderPipeline;
  private readonly sampler: GPUSampler;
  private readonly paramsBuffer: GPUBuffer;
  private readonly paramsData = new Float32Array(4);

  constructor(
    private readonly device: GPUDevice,
    targetFormat: GPUTextureFormat,
  ) {
    const module = device.createShaderModule({
      label: "composite",
      code: FULLSCREEN_VERTEX_WGSL + fragmentSource(),
    });

    this.pipeline = device.createRenderPipeline({
      label: "composite-pipeline",
      layout: "auto",
      vertex: { module, entryPoint: "vs_main" },
      fragment: { module, entryPoint: "fs_main", targets: [{ format: targetFormat }] },
      primitive: { topology: "triangle-list" },
    });

    this.sampler = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });

    this.paramsBuffer = device.createBuffer({
      label: "composite-params",
      size: this.paramsData.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  draw(
    pass: GPURenderPassEncoder,
    scene: GPUTextureView,
    bloomHalf: GPUTextureView,
    bloomQuarter: GPUTextureView,
    options: CompositeOptions,
  ): void {
    const d = this.paramsData;
    d[0] = options.bloomIntensity;
    d[1] = options.scanlinePeriod;
    d[2] = options.scanlineStrength;
    d[3] = options.vignetteStrength;
    this.device.queue.writeBuffer(this.paramsBuffer, 0, d);

    const bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: scene },
        { binding: 1, resource: bloomHalf },
        { binding: 2, resource: bloomQuarter },
        { binding: 3, resource: this.sampler },
        { binding: 4, resource: { buffer: this.paramsBuffer } },
      ],
    });

    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);
    drawFullscreen(pass);
  }

  dispose(): void {
    this.paramsBuffer.destroy();
  }
}
