/**
 * Dimensionamento do grid de caracteres.
 *
 * Diferente da versão em DOM, aqui a métrica da fonte do sistema não manda em
 * nada: o atlas é nosso, então escolhemos a proporção da célula. O grid mira
 * MAX_COLS colunas e a célula cresce em telas grandes, em vez de o número de
 * células explodir — o custo por quadro fica previsível e o pixelado grosso é
 * mais fiel ao retrô.
 */

export const MAX_COLS = 180;
export const MAX_ROWS = 120;

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
): Viewport => {
    // A célula é grande o bastante para respeitar os dois tetos ao mesmo tempo.
    const cellWidth = Math.max(
        availableWidth / MAX_COLS,
        availableHeight / (MAX_ROWS * CELL_ASPECT),
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
