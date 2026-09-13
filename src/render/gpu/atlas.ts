import {
  atlasCellWidthFor,
  drawGlyphAtlasCanvas,
  ensureFontLoaded,
} from "../atlas-canvas";

export { atlasCellWidthFor, ensureFontLoaded };

export interface GlyphAtlas {
  texture: GPUTexture;
  view: GPUTextureView;
  cols: number;
  rows: number;
  cellWidth: number;
  canvas: HTMLCanvasElement;
}

/**
 * Desenha o charset (`render/atlas-canvas.ts`, comum aos dois backends) e
 * sobe como textura WebGPU — `copyExternalImageToTexture` lê o canvas 2D
 * direto, sem passar por `ImageData`/`ArrayBuffer` no meio.
 */
export const buildGlyphAtlas = (
  device: GPUDevice,
  cellWidth: number,
): GlyphAtlas => {
  const { canvas, cols, rows } = drawGlyphAtlasCanvas(cellWidth);

  const texture = device.createTexture({
    label: "glyph-atlas",
    size: { width: canvas.width, height: canvas.height },
    format: "rgba8unorm",
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.RENDER_ATTACHMENT,
  });

  device.queue.copyExternalImageToTexture(
    { source: canvas },
    { texture },
    { width: canvas.width, height: canvas.height },
  );

  return { texture, view: texture.createView(), cols, rows, cellWidth, canvas };
};
