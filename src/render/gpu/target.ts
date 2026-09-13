/**
 * Textura com vista, para renderizar fora da tela — a contraparte WebGPU de
 * `render/gl/target.ts`. `rgba16float`: meia precisão, para o que o
 * sombreamento passa de 1.0 sobreviver até o bloom (é o mesmo motivo do
 * `hdr` do backend WebGL2, só que aqui não há alternativa de 8 bits — todo
 * dispositivo WebGPU renderiza em `rgba16float` sem extensão).
 */
export class RenderTarget {
  texture: GPUTexture;
  view: GPUTextureView;

  private currentWidth = 0;
  private currentHeight = 0;

  constructor(
    private readonly device: GPUDevice,
    width: number,
    height: number,
    private readonly format: GPUTextureFormat = "rgba16float",
  ) {
    this.texture = this.create(width, height);
    this.view = this.texture.createView();
    this.currentWidth = Math.max(1, Math.floor(width));
    this.currentHeight = Math.max(1, Math.floor(height));
  }

  get width(): number {
    return this.currentWidth;
  }

  get height(): number {
    return this.currentHeight;
  }

  private create(width: number, height: number): GPUTexture {
    return this.device.createTexture({
      label: "render-target",
      size: { width: Math.max(1, Math.floor(width)), height: Math.max(1, Math.floor(height)) },
      format: this.format,
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });
  }

  resize(width: number, height: number): void {
    const nextWidth = Math.max(1, Math.floor(width));
    const nextHeight = Math.max(1, Math.floor(height));
    if (nextWidth === this.currentWidth && nextHeight === this.currentHeight) {
      return;
    }
    this.texture.destroy();
    this.texture = this.create(nextWidth, nextHeight);
    this.view = this.texture.createView();
    this.currentWidth = nextWidth;
    this.currentHeight = nextHeight;
  }

  dispose(): void {
    this.texture.destroy();
  }
}
