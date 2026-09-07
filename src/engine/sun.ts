import { settings, SUN_SHADES } from '../config';
import type { Cell, Layout } from '../types';

/**
 * As fatias horizontais do sol — a assinatura visual do estilo outrun.
 *
 * Só a metade de baixo é fatiada, e a última faixa fica inteira para o sol
 * assentar no horizonte em vez de terminar picotado.
 */
const isSunSliceGap = (localRow: number, sunRowCount: number): boolean => {
    const sliceStartRow = sunRowCount * 0.5;
    if (localRow < sliceStartRow) return false;

    const baseStripeRows = Math.max(2, Math.round(sunRowCount * 0.08));
    if (localRow >= sunRowCount - baseStripeRows) return false;

    const sliceSpan = sunRowCount - sliceStartRow;
    const sliceDepth = (localRow - sliceStartRow) / sliceSpan;

    const bandCount = Math.max(2, Math.round((sliceSpan / 3) * settings.sunSlicesMultiplier));
    const bandPhase = (sliceDepth * bandCount) % 1;

    // Os cortes engrossam conforme descem, o que sugere o sol afundando.
    const gapShare =
        (0.3 + sliceDepth * 0.12) /
        Math.min(2, Math.max(0.5, settings.sunSlicesMultiplier * 0.7));

    return bandPhase < gapShare;
};

/** Blocos progressivamente mais vazados: o sol clareia de cima para baixo. */
const pickSunChar = (localRow: number, sunRowCount: number): string => {
    const progress = Math.max(0, Math.min(1, localRow / sunRowCount));
    if (progress < 0.3) return '█';
    if (progress < 0.6) return '▓';
    if (progress < 0.85) return '▒';
    return '░';
};

/**
 * Resolve uma célula do sol, ou `null` se a coordenada cai fora do disco —
 * é isso que deixa o céu livre para as estrelas.
 */
export const buildSunCell = (col: number, row: number, layout: Layout): Cell | null => {
    const normalizedX = (col - layout.centerCol) / layout.sunRadiusCols;
    const normalizedY = (row - layout.sunCenterRow) / layout.sunRadiusRows;
    if (Math.hypot(normalizedX, normalizedY) > 1.01) return null;

    const localRow = row - (layout.sunCenterRow - layout.sunRadiusRows);
    if (isSunSliceGap(localRow, layout.sunRowCount)) return { char: ' ', className: '' };

    const shadeProgress = localRow / layout.sunRowCount;
    const shadeIndex = Math.min(SUN_SHADES.length - 1, Math.floor(shadeProgress * SUN_SHADES.length));

    return {
        char: pickSunChar(localRow, layout.sunRowCount),
        className: SUN_SHADES[shadeIndex] ?? SUN_SHADES[0],
    };
};
