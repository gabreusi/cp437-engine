import { SKY_GLSL } from "../../sky-colors";
import { FULLSCREEN_VERTEX_WGSL, drawFullscreen } from "../fullscreen";

/**
 * Gradientes do céu — a contraparte WGSL de `render/gl/passes/background.ts`.
 * `SKY_GLSL` é reaproveitado mesmo o nome dizendo GLSL: são só declarações
 * `const vec3 NOME = vec3(...)`, sintaxe que WGSL também aceita (`vec3f` no
 * lugar de `vec3` é a única diferença, tratada abaixo).
 */

/**
 * `const vec3 NOME = vec3(...)` (GLSL) vira `const NOME = vec3f(...)`
 * (WGSL): o tipo entra depois do nome em WGSL (`nome: tipo`), não antes
 * como em GLSL/C, então a troca certa é *remover* a palavra-chave de tipo
 * da declaração — o inicializador já entrega o tipo, WGSL infere sozinho —
 * e só trocar o nome do construtor (`vec3(` → `vec3f(`).
 */
const toWgslConstants = (glsl: string): string =>
  glsl
    .replace(/const (?:vec3|float) (\w+) = /g, "const $1 = ")
    .replace(/\bvec3\(/g, "vec3f(");

export interface Atmosphere {
  sunU: number;
  sunV: number;
  horizonV: number;
  groundV: number;
  hazeScale: number;
  sunGlow: number;
  horizonGlow: number;
  sunSpread: number;
}

const fragmentSource = (): string => `
${toWgslConstants(SKY_GLSL)}

struct Params {
  sun: vec2f,
  horizon: f32,
  ground: f32,
  aspect: vec2f,
  groundHaze: f32,
  hazeScale: f32,
  sunGlow: f32,
  horizonGlow: f32,
  sunSpread: f32,
  _pad: f32,
};

@group(0) @binding(0) var<uniform> p: Params;

fn halo(uv: vec2f, center: vec2f, radius: vec2f) -> f32 {
  let d = length((uv - center) / radius);
  return exp(-d * d * 2.2);
}

@fragment
fn fs_main(@location(0) uvIn: vec2f) -> @location(0) vec4f {
  let uv = uvIn * p.aspect;

  let horizonLit = p.sunGlow * p.horizonGlow;

  let wash = halo(uv, vec2f(p.sun.x, p.horizon) * p.aspect, vec2f(1.30, 0.85)) * horizonLit;
  let glow = halo(uv, p.sun * p.aspect, vec2f(0.50, 0.34) * p.sunSpread) * p.sunGlow;
  let band = halo(uv, vec2f(p.sun.x, p.horizon) * p.aspect, vec2f(0.95, 0.10)) * horizonLit;

  let below = p.ground - uvIn.y;
  let ground = smoothstep(0.0, 0.004, below) * min(1.0, p.hazeScale / max(below, 1e-4));

  var color = VOID_COLOR;
  color += PURPLE * wash * WASH_WEIGHT;
  color += PINK * glow * GLOW_WEIGHT;
  color += CYAN * band * BAND_WEIGHT;
  color += HAZE * ground * p.groundHaze;

  return vec4f(color, 1.0);
}
`;

export class BackgroundPass {
  private readonly pipeline: GPURenderPipeline;
  private readonly paramsBuffer: GPUBuffer;
  private readonly bindGroup: GPUBindGroup;
  private readonly paramsData = new Float32Array(12);

  constructor(
    private readonly device: GPUDevice,
    targetFormat: GPUTextureFormat,
  ) {
    const module = device.createShaderModule({
      label: "background",
      code: FULLSCREEN_VERTEX_WGSL + fragmentSource(),
    });

    this.pipeline = device.createRenderPipeline({
      label: "background-pipeline",
      layout: "auto",
      vertex: { module, entryPoint: "vs_main" },
      fragment: { module, entryPoint: "fs_main", targets: [{ format: targetFormat }] },
      primitive: { topology: "triangle-list" },
    });

    this.paramsBuffer = device.createBuffer({
      label: "background-params",
      size: this.paramsData.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.bindGroup = device.createBindGroup({
      label: "background-bind-group",
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.paramsBuffer } }],
    });
  }

  draw(
    pass: GPURenderPassEncoder,
    atmosphere: Atmosphere,
    width: number,
    height: number,
    groundHaze: number,
  ): void {
    const aspect = width / Math.max(1, height);
    const d = this.paramsData;
    d[0] = atmosphere.sunU;
    d[1] = atmosphere.sunV;
    d[2] = atmosphere.horizonV;
    d[3] = atmosphere.groundV;
    d[4] = Math.max(1, aspect);
    d[5] = Math.max(1, 1 / aspect);
    d[6] = groundHaze;
    d[7] = atmosphere.hazeScale;
    d[8] = atmosphere.sunGlow;
    d[9] = atmosphere.horizonGlow;
    d[10] = atmosphere.sunSpread;
    d[11] = 0;
    this.device.queue.writeBuffer(this.paramsBuffer, 0, d);

    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    drawFullscreen(pass);
  }

  dispose(): void {
    this.paramsBuffer.destroy();
  }
}
