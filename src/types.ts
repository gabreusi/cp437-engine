/** Uma célula desenhada na grade: o caractere e a classe CSS que o colore. */
export interface Cell {
    char: string;
    className: string;
}

/**
 * Todas as medidas derivadas do tamanho da janela e dos ajustes do usuário.
 * É recalculado inteiro sempre que algo muda; nunca sofre mutação parcial.
 */
export interface Layout {
    colCount: number;
    rowCount: number;
    /** Linha onde o céu termina e o chão começa. */
    horizonRow: number;
    floorRowCount: number;
    centerCol: number;
    /** Altura/largura de uma célula monoespaçada — corrige a distorção do texto. */
    cellAspect: number;

    sunRadiusRows: number;
    sunRadiusCols: number;
    sunCenterRow: number;
    sunRowCount: number;

    /** Distância focal da projeção em perspectiva do chão. */
    focalLength: number;
    firstLineRow: number;
    hazeRowLimit: number;
    compressedRowLimit: number;
    midRowLimit: number;

    colStepPerRow: number;
    railCount: number;
    railStartRow: number;
}

/** Uma estrela que pisca, memorizada para ser reanimada a cada quadro. */
export interface Star {
    row: number;
    col: number;
    phaseOffset: number;
    speed: number;
}

export interface StarSeed extends Omit<Star, 'row' | 'col'> {
    char: string;
    className: string;
    twinkles: boolean;
}
