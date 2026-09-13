import {
  atlasCellWidthFor,
  drawGlyphAtlasCanvas,
  ensureFontLoaded,
} from "../atlas-canvas";

export { atlasCellWidthFor, ensureFontLoaded };

export interface GlyphAtlas {
  texture: WebGLTexture;
  cols: number;
  rows: number;
  cellWidth: number;
  /**
   * O canvas de origem, guardado para inspeção.
   *
   * O atlas é a única parte da engine que não dá para conferir pelo
   * framebuffer: quando um glifo sai errado na tela mas certo no buffer, a
   * resposta está aqui.
   */
  canvas: HTMLCanvasElement;
}

/**
 * Desenha o charset (`render/atlas-canvas.ts`, comum aos dois backends) e
 * sobe como textura WebGL2.
 *
 * Filtragem NEAREST de propósito: além de ser a estética certa para arte
 * ASCII, evita o glifo vizinho sangrar na borda da célula sem precisar de
 * padding — e padding faria os blocos pararem antes da borda, abrindo
 * frestas na silhueta do sol e nas emendas da grade.
 */
export const buildGlyphAtlas = (
  gl: WebGL2RenderingContext,
  cellWidth: number,
): GlyphAtlas => {
  const { canvas, cols, rows } = drawGlyphAtlasCanvas(cellWidth);

  const texture = gl.createTexture();
  if (texture === null)
    throw new Error("Não foi possível criar a textura do atlas.");

  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  return { texture, cols, rows, cellWidth, canvas };
};
