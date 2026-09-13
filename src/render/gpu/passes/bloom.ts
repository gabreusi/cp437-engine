import { FULLSCREEN_VERTEX_WGSL, drawFullscreen } from "../fullscreen";
import { RenderTarget } from "../target";

/** Cópia simples. Renderizada num alvo menor, vira downsample. */
const blitSource = (): string => `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var srcSampler: sampler;

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return textureSample(src, srcSampler, uv);
}
`;

/** Gaussiana separável de nove taps. */
const blurSource = (): string => `
struct Params {
  direction: vec2f,
  _pad: vec2f,
};

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var srcSampler: sampler;
@group(0) @binding(2) var<uniform> p: Params;

const WEIGHTS = array<f32, 5>(0.227027, 0.194595, 0.121622, 0.054054, 0.016216);

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  var sum = textureSample(src, srcSampler, uv).rgb * WEIGHTS[0];
  for (var i = 1; i < 5; i++) {
    let offset = p.direction * f32(i);
    sum += textureSample(src, srcSampler, uv + offset).rgb * WEIGHTS[i];
    sum += textureSample(src, srcSampler, uv - offset).rgb * WEIGHTS[i];
  }
  return vec4f(sum, 1.0);
}
`;

/**
 * Um uniform buffer de direção por (escala, sentido) usado no quadro —
 * `writeBuffer` aplica a escrita na fila da GPU imediatamente, antes de
 * qualquer `submit()`; como as quatro passadas de borrão do quadro (meia
 * escala horizontal/vertical, um quarto horizontal/vertical) só são
 * *executadas* depois, num `submit()` só no fim do quadro, reaproveitar um
 * buffer entre elas faria todas lerem a última direção escrita. Um buffer
 * fixo por combinação evita a colisão sem recriar nada por quadro.
 */
class DirectionUniform {
  readonly buffer: GPUBuffer;
  private readonly data = new Float32Array(4);

  constructor(device: GPUDevice, label: string) {
    this.buffer = device.createBuffer({
      label,
      size: this.data.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  write(device: GPUDevice, x: number, y: number): void {
    this.data[0] = x;
    this.data[1] = y;
    device.queue.writeBuffer(this.buffer, 0, this.data);
  }

  dispose(): void {
    this.buffer.destroy();
  }
}

/** Bloom em duas escalas: meia e um quarto de resolução, borradas e somadas no composite. */
export class BloomPass {
  private readonly blitPipeline: GPURenderPipeline;
  private readonly blurPipeline: GPURenderPipeline;
  private readonly linearSampler: GPUSampler;

  private readonly halfH: DirectionUniform;
  private readonly halfV: DirectionUniform;
  private readonly quarterH: DirectionUniform;
  private readonly quarterV: DirectionUniform;

  private readonly half: RenderTarget;
  private readonly halfPing: RenderTarget;
  private readonly quarter: RenderTarget;
  private readonly quarterPing: RenderTarget;

  constructor(
    private readonly device: GPUDevice,
    width: number,
    height: number,
    format: GPUTextureFormat,
  ) {
    const blitModule = device.createShaderModule({
      label: "bloom-blit",
      code: FULLSCREEN_VERTEX_WGSL + blitSource(),
    });
    const blurModule = device.createShaderModule({
      label: "bloom-blur",
      code: FULLSCREEN_VERTEX_WGSL + blurSource(),
    });

    this.blitPipeline = device.createRenderPipeline({
      label: "bloom-blit-pipeline",
      layout: "auto",
      vertex: { module: blitModule, entryPoint: "vs_main" },
      fragment: { module: blitModule, entryPoint: "fs_main", targets: [{ format }] },
      primitive: { topology: "triangle-list" },
    });
    this.blurPipeline = device.createRenderPipeline({
      label: "bloom-blur-pipeline",
      layout: "auto",
      vertex: { module: blurModule, entryPoint: "vs_main" },
      fragment: { module: blurModule, entryPoint: "fs_main", targets: [{ format }] },
      primitive: { topology: "triangle-list" },
    });

    this.linearSampler = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });

    this.halfH = new DirectionUniform(device, "bloom-half-h");
    this.halfV = new DirectionUniform(device, "bloom-half-v");
    this.quarterH = new DirectionUniform(device, "bloom-quarter-h");
    this.quarterV = new DirectionUniform(device, "bloom-quarter-v");

    this.half = new RenderTarget(device, width / 2, height / 2, format);
    this.halfPing = new RenderTarget(device, width / 2, height / 2, format);
    this.quarter = new RenderTarget(device, width / 4, height / 4, format);
    this.quarterPing = new RenderTarget(device, width / 4, height / 4, format);
  }

  get halfView(): GPUTextureView {
    return this.half.view;
  }

  get quarterView(): GPUTextureView {
    return this.quarter.view;
  }

  resize(width: number, height: number): void {
    this.half.resize(width / 2, height / 2);
    this.halfPing.resize(width / 2, height / 2);
    this.quarter.resize(width / 4, height / 4);
    this.quarterPing.resize(width / 4, height / 4);
  }

  render(encoder: GPUCommandEncoder, sceneView: GPUTextureView, radius: number): void {
    this.downsample(encoder, sceneView, this.half);
    this.blurTarget(encoder, this.half, this.halfPing, radius, this.halfH, this.halfV);

    this.downsample(encoder, this.half.view, this.quarter);
    this.blurTarget(encoder, this.quarter, this.quarterPing, radius, this.quarterH, this.quarterV);
  }

  private drawFullscreenPass(
    encoder: GPUCommandEncoder,
    target: RenderTarget,
    pipeline: GPURenderPipeline,
    bindGroup: GPUBindGroup,
  ): void {
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: target.view, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    drawFullscreen(pass);
    pass.end();
  }

  private downsample(encoder: GPUCommandEncoder, source: GPUTextureView, target: RenderTarget): void {
    const bindGroup = this.device.createBindGroup({
      layout: this.blitPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: source },
        { binding: 1, resource: this.linearSampler },
      ],
    });
    this.drawFullscreenPass(encoder, target, this.blitPipeline, bindGroup);
  }

  /** Horizontal para o ping, vertical de volta para o alvo. */
  private blurTarget(
    encoder: GPUCommandEncoder,
    target: RenderTarget,
    ping: RenderTarget,
    radius: number,
    horizontal: DirectionUniform,
    vertical: DirectionUniform,
  ): void {
    const stepX = radius / target.width;
    const stepY = radius / target.height;

    horizontal.write(this.device, stepX, 0);
    const horizontalGroup = this.device.createBindGroup({
      layout: this.blurPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: target.view },
        { binding: 1, resource: this.linearSampler },
        { binding: 2, resource: { buffer: horizontal.buffer } },
      ],
    });
    this.drawFullscreenPass(encoder, ping, this.blurPipeline, horizontalGroup);

    vertical.write(this.device, 0, stepY);
    const verticalGroup = this.device.createBindGroup({
      layout: this.blurPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: ping.view },
        { binding: 1, resource: this.linearSampler },
        { binding: 2, resource: { buffer: vertical.buffer } },
      ],
    });
    this.drawFullscreenPass(encoder, target, this.blurPipeline, verticalGroup);
  }

  dispose(): void {
    this.halfH.dispose();
    this.halfV.dispose();
    this.quarterH.dispose();
    this.quarterV.dispose();
    this.half.dispose();
    this.halfPing.dispose();
    this.quarter.dispose();
    this.quarterPing.dispose();
  }
}
