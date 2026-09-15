import {showFatalError} from "../../ui/fatal-error";
import type {Viewport} from "../viewport";

/**
 * Dono do dispositivo WebGPU e do ciclo de vida dele.
 *
 * `device.lost` é o equivalente WebGPU de `webglcontextlost`: acontece em
 * suspensão de aba, troca de GPU em máquina híbrida e crash de driver, não só
 * em erro de programação. Sem tratar, a tela fica preta para sempre. Quem cria
 * recurso de GPU se registra em `onRestore` e é chamado de volta depois que um
 * dispositivo novo é pedido.
 */
export class GpuContext {
  device!: GPUDevice;
  private context!: GPUCanvasContext;
  format!: GPUTextureFormat;

  private lost = false;
  private deviceReady = false;
  private readonly initPromise: Promise<void>;

  private readonly restoreHandlers: (() => void)[] = [];

  constructor(readonly canvas: HTMLCanvasElement) {
    this.initPromise = this.init();
  }

  private async init(): Promise<void> {
    if (!navigator.gpu) {
      showFatalError("WEBGPU NOT AVAILABLE", [
        "This browser does not expose the WebGPU API.",
        "Try a recent version of Chrome or Edge.",
      ]);
      throw new Error("WebGPU não disponível neste navegador.");
    }

    const adapter = await navigator.gpu.requestAdapter();
    if (adapter === null) {
      showFatalError("WEBGPU ADAPTER NOT FOUND", [
        "No WebGPU adapter was found on this machine.",
        "Update your graphics driver or try a different browser.",
      ]);
      throw new Error("Nenhum adaptador WebGPU disponível.");
    }

    await this.acquireDevice(adapter);

    const context = this.canvas.getContext("webgpu");
    if (context === null) {
      throw new Error("Contexto WebGPU indisponível para o canvas.");
    }
    this.context = context;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.configure();
    this.deviceReady = true;
  }

  private async acquireDevice(adapter: GPUAdapter): Promise<void> {
    const device = await adapter.requestDevice();
    this.device = device;
    this.lost = false;

    // Perda de dispositivo: pede um adaptador novo e recria tudo. Não dá para
    // reusar `adapter` — um `GPUAdapter` só gera um `GPUDevice`; depois do
    // primeiro `requestDevice()` ele fica consumido e uma segunda chamada
    // lança `OperationError`. `info.reason === "destroyed"` é o
    // `device.destroy()` de propósito (ex.: troca de resolução que descarta e
    // recria por decisão nossa) e não deve reentrar em `onRestore` — só perda
    // de verdade (driver, GPU) deve.
    void device.lost.then((info) => {
      this.lost = true;
      if (info.reason === "destroyed") return;
      void navigator.gpu.requestAdapter().then((nextAdapter) => {
        if (nextAdapter === null) return;
        void this.acquireDevice(nextAdapter).then(() => {
          this.configure();
          for (const handler of this.restoreHandlers) handler();
        });
      });
    });
  }

  private configure(): void {
    if (this.context === undefined) return;
    this.context.configure({
      device: this.device,
      format: this.format,
      alphaMode: "opaque",
    });
  }

  /** Resolve quando o dispositivo e o contexto do canvas estão prontos. */
  whenReady(): Promise<void> {
    return this.initPromise;
  }

  /**
   * Pronto para desenhar agora, sem esperar promise nenhuma — é o que o laço
   * de quadro chama every frame. `requestAdapter`/`requestDevice` são
   * assíncronos, então o primeiro punhado de quadros depois de criar o
   * presenter cai aqui como `false`, do mesmo jeito que `isLost` cobre a
   * perda no meio da sessão.
   */
  get isReady(): boolean {
    return this.deviceReady && !this.lost;
  }

  get isLost(): boolean {
    return this.lost;
  }

  get canvasTexture(): GPUTexture {
    return this.context.getCurrentTexture();
  }

  onRestore(handler: () => void): void {
    this.restoreHandlers.push(handler);
  }

  resize(viewport: Viewport): void {
    this.canvas.width = viewport.pixelWidth;
    this.canvas.height = viewport.pixelHeight;
    this.canvas.style.width = `${viewport.cssWidth}px`;
    this.canvas.style.height = `${viewport.cssHeight}px`;
  }
}
