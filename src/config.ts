/** Ajustes que o painel de controle altera em tempo real. */
export interface Settings {
    travelSpeed: number;
    starDensity: number;
    horizonRatio: number;
    sunOffsetRows: number;
    sunSizeMultiplier: number;
    sunSlicesMultiplier: number;
    /** Espaçamento entre as linhas horizontais do chão, em unidades de mundo. */
    lineSpacingWorld: number;
    /** Espaçamento entre os trilhos que fogem para o horizonte. */
    railSpacingWorld: number;
    enableHaze: boolean;
}

/**
 * Estado vivo do gerador. É a única fonte da verdade: o HTML não guarda valor
 * inicial nenhum, o painel se inicializa a partir daqui.
 */
export const settings: Settings = {
    travelSpeed: 1,
    starDensity: 0.03,
    horizonRatio: 0.5,
    sunOffsetRows: 0,
    sunSizeMultiplier: 1,
    sunSlicesMultiplier: 1.1,
    lineSpacingWorld: 0.4,
    railSpacingWorld: 1,
    enableHaze: true,
};

export const CANVAS_BACKGROUND = '#05000e';

export const BLANK_CHAR = ' ';
export const STAR_CHARS = ['·', '•', '+', '*'] as const;
export const SUN_SHADES = ['y0', 'y1', 'y2', 'y3', 'y4', 'y5', 'y6', 'y7'] as const;

/** Repetições enviesam o sorteio para o branco-azulado `k0`. */
export const STAR_TINTS = ['k0', 'k0', 'k0', 'k0', 'k0', 'k0', 'k1', 'k2', 'k3'] as const;
