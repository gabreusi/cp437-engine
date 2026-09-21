import type { Rgb } from "../../math/color";
import type { Framebuffer } from "../framebuffer";
import type { UiViewport } from "../ui-viewport";
import { type GlyphAtlas, buildGlyphAtlas } from "./atlas";
import { GridPass } from "./passes/grid";

/**
 * A grade de interface na GPU: atlas próprio, texturas próprias, um draw call.
 *
 * Reaproveita o `GridPass` da cena inteiro — ele já sabe transformar dois
 * planos de células em pixels — e só o aponta para outro atlas (o da célula de
 * UI) e para um retângulo do alvo (`setViewport`). Não passa pelo
 * `ShadingPass`: toda célula de interface é resolvida na CPU, glifo e cor já
 * finais, então os planos do `Framebuffer` sobem como estão.
 *
 * Desenha antes do bloom, no mesmo alvo HDR da cena, para o menu receber o
 * mesmo brilho, scanline e vinheta do resto.
 */
export class UiLayer {
  private readonly grid: GridPass;
  private atlas: GlyphAtlas | null = null;
  private cells: GPUTexture | null = null;
  private colors: GPUTexture | null = null;
  private viewport: UiViewport | null = null;

  constructor(
    private readonly device: GPUDevice,
    targetFormat: GPUTextureFormat,
  ) {
    this.grid = new GridPass(device, targetFormat);
  }

  /** Fundo dos painéis: o que preenche o vão de toda célula opaca da interface. */
  setBackdrop(color: Rgb): void {
    this.grid.setOpaqueFill(color, true);
  }

  resize(viewport: UiViewport): void {
    const previous = this.viewport;
    this.viewport = viewport;

    if (
      previous === null ||
      previous.colCount !== viewport.colCount ||
      previous.rowCount !== viewport.rowCount
    ) {
      this.cells?.destroy();
      this.colors?.destroy();
      this.cells = this.createPlane("ui-cells", viewport);
      this.colors = this.createPlane("ui-colors", viewport);
      this.grid.resize(viewport.colCount, viewport.rowCount);
    }

    if (this.atlas === null || this.atlas.cellWidth !== viewport.pixelCellWidth) {
      this.rebuildAtlas();
    }
  }

  /** Fonte trocada no menu, ou dispositivo recriado: o desenho dos glifos mudou. */
  rebuildAtlas(): void {
    const viewport = this.viewport;
    if (viewport === null) return;

    this.atlas?.texture.destroy();
    this.atlas = buildGlyphAtlas(this.device, viewport.pixelCellWidth);
    this.grid.setAtlas(this.atlas);
  }

  private createPlane(label: string, viewport: UiViewport): GPUTexture {
    return this.device.createTexture({
      label,
      size: { width: viewport.colCount, height: viewport.rowCount },
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
  }

  upload(framebuffer: Framebuffer): void {
    const { cells, colors, viewport } = this;
    if (cells === null || colors === null || viewport === null) return;
    // O framebuffer é recriado no mesmo quadro em que a grade muda de tamanho;
    // subir um do tamanho antigo escreveria fora da textura.
    if (
      framebuffer.colCount !== viewport.colCount ||
      framebuffer.rowCount !== viewport.rowCount
    ) {
      return;
    }

    const size = { width: viewport.colCount, height: viewport.rowCount };
    const layout = { bytesPerRow: viewport.colCount * 4 };
    this.device.queue.writeTexture({ texture: cells }, framebuffer.cells, layout, size);
    this.device.queue.writeTexture({ texture: colors }, framebuffer.colors, layout, size);
  }

  draw(
    pass: GPURenderPassEncoder,
    targetWidth: number,
    targetHeight: number,
  ): void {
    const { cells, colors, viewport } = this;
    if (cells === null || colors === null || viewport === null) return;

    pass.setViewport(
      viewport.pixelOffsetX,
      viewport.pixelOffsetY,
      viewport.pixelWidth,
      viewport.pixelHeight,
      0,
      1,
    );
    this.grid.draw(pass, cells, colors);
    // O pass é do chamador: devolve o viewport como encontrou.
    pass.setViewport(0, 0, targetWidth, targetHeight, 0, 1);
  }

  dispose(): void {
    this.grid.dispose();
    this.cells?.destroy();
    this.colors?.destroy();
    this.atlas?.texture.destroy();
  }
}
