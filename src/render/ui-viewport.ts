import { clamp } from "../math/clamp";
import { atlasCellWidthFor } from "./atlas-canvas";
import { CELL_ASPECT, type Viewport } from "./viewport";

/**
 * A grade da interface: menu, painel do editor e retículo.
 *
 * Existe separada da grade da cena porque as duas querem coisas opostas. A cena
 * quer o número de células sob controle (custo de CPU, ver README, "Custo") e
 * deixa a célula ficar do tamanho que sobrar; a interface quer o **tamanho da
 * célula** sob controle, porque é ele que decide se o texto lê. Num iframe de
 * 624×500 a cena tem células de ~6 px, e um menu escrito nelas não se lê.
 *
 * O tamanho não sai de `renderScale`: a interface não é o que se está
 * renderizando, e mexer no custo da cena não pode encolher o menu.
 */

/** Limites da largura da célula de UI em pixels CSS, antes de `uiScale`. */
const MIN_UI_CELL = 8;
const MAX_UI_CELL = 14;

/**
 * Colunas que a interface "gostaria" de ter numa janela grande. É a mesma
 * conta de `MAX_COLS` da cena, e é o que mantém o menu do desktop do tamanho
 * físico que sempre teve — só uma janela pequena cai no piso.
 */
const TARGET_COLS = 180;

export interface UiViewport {
  colCount: number;
  rowCount: number;
  /** Tamanho da célula em pixels CSS — o que o ponteiro enxerga. */
  cellWidth: number;
  cellHeight: number;
  /** Tamanho da célula em pixels do backing store, sempre inteiro. */
  pixelCellWidth: number;
  pixelCellHeight: number;
  /** Onde a grade começa dentro do canvas. A sobra fica dos dois lados. */
  offsetX: number;
  offsetY: number;
  pixelOffsetX: number;
  pixelOffsetY: number;
  /** Extensão da grade em pixels do backing store. */
  pixelWidth: number;
  pixelHeight: number;
}

export const createUiViewport = (): UiViewport => ({
  colCount: 1,
  rowCount: 1,
  cellWidth: MIN_UI_CELL,
  cellHeight: MIN_UI_CELL * CELL_ASPECT,
  pixelCellWidth: MIN_UI_CELL,
  pixelCellHeight: MIN_UI_CELL * CELL_ASPECT,
  offsetX: 0,
  offsetY: 0,
  pixelOffsetX: 0,
  pixelOffsetY: 0,
  pixelWidth: MIN_UI_CELL,
  pixelHeight: MIN_UI_CELL * CELL_ASPECT,
});

/**
 * A célula é inteira em pixels de dispositivo — e é a do atlas, sem
 * reamostragem: o glifo cai 1:1 nos pixels, que é o que o mantém nítido.
 */
export const computeUiViewport = (
  scene: Viewport,
  uiScale: number,
): UiViewport => {
  const cssCell = clamp(scene.cssWidth / TARGET_COLS, MIN_UI_CELL, MAX_UI_CELL);
  const pixelCellWidth = atlasCellWidthFor(cssCell * uiScale * scene.dpr);
  const pixelCellHeight = pixelCellWidth * CELL_ASPECT;

  const colCount = Math.max(1, Math.floor(scene.pixelWidth / pixelCellWidth));
  const rowCount = Math.max(1, Math.floor(scene.pixelHeight / pixelCellHeight));
  const pixelWidth = colCount * pixelCellWidth;
  const pixelHeight = rowCount * pixelCellHeight;
  const pixelOffsetX = Math.floor((scene.pixelWidth - pixelWidth) / 2);
  const pixelOffsetY = Math.floor((scene.pixelHeight - pixelHeight) / 2);

  return {
    colCount,
    rowCount,
    cellWidth: pixelCellWidth / scene.dpr,
    cellHeight: pixelCellHeight / scene.dpr,
    pixelCellWidth,
    pixelCellHeight,
    offsetX: pixelOffsetX / scene.dpr,
    offsetY: pixelOffsetY / scene.dpr,
    pixelOffsetX,
    pixelOffsetY,
    pixelWidth,
    pixelHeight,
  };
};

export const uiViewportEquals = (a: UiViewport, b: UiViewport): boolean =>
  a.colCount === b.colCount &&
  a.rowCount === b.rowCount &&
  a.pixelCellWidth === b.pixelCellWidth &&
  a.pixelOffsetX === b.pixelOffsetX &&
  a.pixelOffsetY === b.pixelOffsetY;
