/**
 * Textura com framebuffer, para renderizar fora da tela.
 *
 * Sem profundidade nem stencil: a cena já vem resolvida da CPU, e todos os
 * passes daqui para frente são fullscreen.
 */
export class RenderTarget {
  readonly framebuffer: WebGLFramebuffer;
  readonly texture: WebGLTexture;

  private currentWidth = 0;
  private currentHeight = 0;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    width: number,
    height: number,
    /** Meia precisão, para o que passa de 1 sobreviver até o bloom. */
    private readonly hdr = false,
  ) {
    const texture = gl.createTexture();
    const framebuffer = gl.createFramebuffer();
    if (texture === null || framebuffer === null) {
      throw new Error("Não foi possível criar o alvo de renderização.");
    }
    this.texture = texture;
    this.framebuffer = framebuffer;

    gl.bindTexture(gl.TEXTURE_2D, texture);
    // LINEAR é o que faz o downsample virar média de 4 texels de graça.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      texture,
      0,
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    this.resize(width, height);
  }

  get width(): number {
    return this.currentWidth;
  }

  get height(): number {
    return this.currentHeight;
  }

  resize(width: number, height: number): void {
    const nextWidth = Math.max(1, Math.floor(width));
    const nextHeight = Math.max(1, Math.floor(height));
    if (nextWidth === this.currentWidth && nextHeight === this.currentHeight)
      return;

    this.currentWidth = nextWidth;
    this.currentHeight = nextHeight;

    // texImage2D e não texStorage2D: o alvo é redimensionado a cada resize
    // da janela, e texStorage2D deixaria a textura imutável.
    //
    // RGBA16F é filtrável por padrão no WebGL2, então o LINEAR que faz o
    // downsample do bloom continua valendo sem extensão nenhuma.
    const { gl } = this;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      this.hdr ? gl.RGBA16F : gl.RGBA8,
      nextWidth,
      nextHeight,
      0,
      gl.RGBA,
      this.hdr ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE,
      null,
    );
  }

  bind(): void {
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.framebuffer);
    this.gl.viewport(0, 0, this.currentWidth, this.currentHeight);
  }

  dispose(): void {
    this.gl.deleteFramebuffer(this.framebuffer);
    this.gl.deleteTexture(this.texture);
  }
}
