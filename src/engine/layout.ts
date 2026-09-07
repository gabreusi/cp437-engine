import { settings } from '../config';
import type { Layout } from '../types';

interface CellSize {
    width: number;
    height: number;
}

/**
 * Mede uma célula da fonte monoespaçada a partir de um `<pre>` invisível.
 *
 * Não dá para assumir a proporção: ela muda com a fonte que o sistema acabou
 * escolhendo e com o `clamp()` do tamanho no CSS. Toda a perspectiva depende
 * desse número, então ele é medido, não estimado.
 */
const measureCellSize = (probe: HTMLElement): CellSize => {
    const rect = probe.getBoundingClientRect();
    const sampleLength = probe.textContent?.length ?? 1;
    return { width: rect.width / sampleLength, height: rect.height };
};

export const computeLayout = (probe: HTMLElement): Layout => {
    const cellSize = measureCellSize(probe);
    const cellAspect = cellSize.height / cellSize.width;
    const colCount = Math.floor(window.innerWidth / cellSize.width);
    const rowCount = Math.floor(window.innerHeight / cellSize.height);
    const horizonRow = Math.round(rowCount * settings.horizonRatio);
    const floorRowCount = rowCount - horizonRow;
    const centerCol = (colCount - 1) / 2;

    // O sol é limitado pela dimensão mais apertada, para nunca vazar da tela.
    const radiusRowsByHeight = Math.round(rowCount * 0.21);
    const radiusRowsByWidth = Math.floor((colCount * 0.33) / cellAspect);
    const baseSunRadiusRows = Math.max(3, Math.min(radiusRowsByHeight, radiusRowsByWidth));

    const sunRadiusRows = Math.max(2, Math.round(baseSunRadiusRows * settings.sunSizeMultiplier));
    const sunRadiusCols = Math.max(3, Math.round(sunRadiusRows * cellAspect));
    const sunCenterRow = horizonRow - 1 - sunRadiusRows + settings.sunOffsetRows;
    const sunRowCount = sunRadiusRows * 2 + 1.5;

    const focalLength = Math.max(2, floorRowCount * 0.6);

    // Quantas linhas abaixo do horizonte duas linhas de grade separadas por
    // `rows` unidades de mundo ficam distinguíveis. Perto do horizonte elas
    // colapsariam numa mancha, então cada faixa de profundidade tem um limite.
    const rowOffsetForSeparation = (rows: number): number =>
        Math.sqrt((rows * focalLength) / settings.lineSpacingWorld);

    const firstLineRow = Math.max(2, Math.ceil(rowOffsetForSeparation(1)));
    const hazeRowLimit = firstLineRow;
    const compressedRowLimit = Math.max(firstLineRow + 1, Math.ceil(rowOffsetForSeparation(2)));
    const midRowLimit = Math.max(compressedRowLimit + 1, Math.ceil(rowOffsetForSeparation(4)));

    const colStepPerRow = settings.railSpacingWorld * cellAspect;
    const railStartRow = Math.max(2, Math.ceil(3 / colStepPerRow));
    const railReachAtTop = colStepPerRow * railStartRow;
    const railCount = Math.ceil(colCount / 2 / Math.max(0.1, railReachAtTop)) + 1;

    return {
        colCount, rowCount, horizonRow, floorRowCount, centerCol, cellAspect,
        sunRadiusRows, sunRadiusCols, sunCenterRow, sunRowCount,
        focalLength, firstLineRow, hazeRowLimit, compressedRowLimit, midRowLimit,
        colStepPerRow, railCount, railStartRow,
    };
};

const BASE_HORIZON_RATIO = 0.5;
const BASE_GRADIENT_POSITION = 30;

/**
 * Gradientes do fundo acompanhando o sol e o horizonte, para o brilho ficar
 * atrás do sol em vez de solto no meio da tela.
 */
export const buildStageGradient = (): string => {
    const horizonShiftPixels = (settings.horizonRatio - BASE_HORIZON_RATIO) * window.innerHeight;
    const gradientShift = settings.sunOffsetRows * 1.5 + horizonShiftPixels / 15;

    return `
        radial-gradient(90% 60% at 50% ${BASE_GRADIENT_POSITION + gradientShift}%, rgba(255, 60, 190, .34), rgba(255, 60, 190, 0) 72%),
        radial-gradient(95% 18% at 50% ${settings.horizonRatio * 100}%, rgba(0, 226, 255, .20), rgba(0, 226, 255, 0) 78%),
        radial-gradient(130% 85% at 50% ${26 + gradientShift}%, rgba(74, 6, 104, .60), rgba(5, 0, 14, 0) 68%)`;
};
