/**
 * Dimensionamento do grid de caracteres.
 *
 * Diferente da versão em DOM, aqui a métrica da fonte do sistema não manda em
 * nada: o atlas é nosso, então escolhemos a proporção da célula. O grid mira
 * MAX_COLS colunas e a célula cresce em telas grandes, em vez de o número de
 * células explodir — o pixelado grosso é mais fiel ao retrô. `cellScale`
 * (`settings.renderScale`) multiplica os dois tetos: é o que decide quantos
 * caracteres cabem na tela, então mexe direto no custo de CPU por quadro (ver
 * README, "Custo") — não é um multiplicador de pixel do backing store, esse
 * é só `dpr`.
 *
 * Os tetos de colunas/fileiras só seguram telas grandes; numa janela pequena
 * (um iframe de 624×500) 180 colunas dão células de ~3,5 px, ilegíveis como
 * caractere. `minCellWidth` (`settings.minCellWidth`, em px CSS) é o piso: corta
 * a contagem de células em vez de encolhê-las — a cena fica mais ASCII e mais
 * barata, e em tela grande não muda nada.
 */

export const MAX_COLS = 180;
export const MAX_ROWS = 90;

/** Altura dividida pela largura da célula. 2 é a proporção clássica de terminal. */
export const CELL_ASPECT = 2;

export interface Viewport {
  colCount: number;
  rowCount: number;
  /** Tamanho da célula em pixels CSS. */
  cellWidth: number;
  cellHeight: number;
  /** Tamanho do canvas em pixels CSS: múltiplo exato da célula, sem sobra. */
  cssWidth: number;
  cssHeight: number;
  /** Tamanho do backing store, já multiplicado pelo devicePixelRatio. */
  pixelWidth: number;
  pixelHeight: number;
  dpr: number;
  /**
   * Proporção para a projeção. Uma fórmula só, no lugar do `cellAspect`
   * espalhado que a versão anterior tinha: errar aqui deixa o sol ovalado.
   */
  aspect: number;
}

export const computeViewport = (
  availableWidth: number,
  availableHeight: number,
  dpr: number,
  cellScale: number,
  minCellWidth: number,
): Viewport => {
  // A célula é grande o bastante para respeitar os dois tetos e o piso.
  const cellWidth = Math.max(
    availableWidth / (MAX_COLS * cellScale),
    availableHeight / (MAX_ROWS * cellScale * CELL_ASPECT),
    minCellWidth,
  );
  const cellHeight = cellWidth * CELL_ASPECT;

  const colCount = Math.max(1, Math.floor(availableWidth / cellWidth));
  const rowCount = Math.max(1, Math.floor(availableHeight / cellHeight));

  // O canvas fica com o tamanho exato do grid e é centralizado pelo CSS. Sem
  // isso a última fileira ficaria esticada para cobrir a sobra da divisão.
  const cssWidth = colCount * cellWidth;
  const cssHeight = rowCount * cellHeight;

  return {
    colCount,
    rowCount,
    cellWidth,
    cellHeight,
    cssWidth,
    cssHeight,
    pixelWidth: Math.round(cssWidth * dpr),
    pixelHeight: Math.round(cssHeight * dpr),
    dpr,
    aspect: colCount / rowCount / CELL_ASPECT,
  };
};

export const viewportEquals = (a: Viewport, b: Viewport): boolean =>
  a.colCount === b.colCount &&
  a.rowCount === b.rowCount &&
  a.pixelWidth === b.pixelWidth &&
  a.pixelHeight === b.pixelHeight;
