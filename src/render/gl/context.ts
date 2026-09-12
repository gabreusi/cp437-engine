import type { Viewport } from "../viewport";

/**
 * Dono do contexto WebGL2 e do ciclo de vida dele.
 *
 * Perda de contexto não é caso exótico: acontece em suspensão de aba, troca de
 * GPU em máquina híbrida e soluço de driver. Sem tratar, a tela fica preta para
 * sempre. Quem cria recurso de GPU se registra em `onRestore` e é chamado de
 * volta para recriar tudo — é barato agora e caro de retrofitar depois.
 */
export class GlContext {
  readonly gl: WebGL2RenderingContext;

  /**
   * Dá para renderizar em ponto flutuante?
   *
   * O sombreamento produz valores acima de 1 e é justamente o excesso que
   * vira halo no bloom. Num alvo de oito bits ele é cortado antes de o bloom
   * ver, e todo núcleo brilhante fica branco e do mesmo tamanho. Onde a
   * extensão não existe a cena ainda funciona — só perde o estouro.
   */
  readonly hdr: boolean;

  private lost = false;
  private readonly restoreHandlers: (() => void)[] = [];

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      // Ler o canvas depois do quadro custa performance em todo quadro; o
      // export renderiza sob demanda num FBO e lê de lá.
      preserveDrawingBuffer: false,
      powerPreference: "high-performance",
    });

    if (gl === null) {
      throw new Error("WebGL2 não disponível neste navegador.");
    }
    this.gl = gl;

    // Basta meia precisão: a faixa vai de 0 a uns poucos, não a milhares.
    this.hdr =
      gl.getExtension("EXT_color_buffer_half_float") !== null ||
      gl.getExtension("EXT_color_buffer_float") !== null;

    canvas.addEventListener("webglcontextlost", (event) => {
      event.preventDefault();
      this.lost = true;
    });

    canvas.addEventListener("webglcontextrestored", () => {
      this.lost = false;
      for (const handler of this.restoreHandlers) handler();
    });
  }

  get isLost(): boolean {
    return this.lost || this.gl.isContextLost();
  }

  onRestore(handler: () => void): void {
    this.restoreHandlers.push(handler);
  }

  resize(viewport: Viewport): void {
    const { canvas } = this;
    canvas.width = viewport.pixelWidth;
    canvas.height = viewport.pixelHeight;
    canvas.style.width = `${viewport.cssWidth}px`;
    canvas.style.height = `${viewport.cssHeight}px`;
    this.gl.viewport(0, 0, viewport.pixelWidth, viewport.pixelHeight);
  }
}
