/**
 * Parâmetros que o painel ajusta em tempo real.
 *
 * São os controles da engine, não mais medidas de tela: a versão anterior tinha
 * "posição do horizonte" e "altura do sol em fileiras", que só faziam sentido
 * quando não existia câmera. Horizonte agora é para onde a câmera olha, e o sol
 * tem elevação e azimute como qualquer corpo celeste.
 */
export interface Settings {
    fovDegrees: number;
    moveSpeed: number;
    /** Radianos de giro por pixel de mouse. */
    lookSensitivity: number;

    /** Unidades de mundo entre duas linhas da grade. */
    gridSize: number;
    /** Até onde a grade é emitida, em unidades de mundo. */
    viewDistance: number;

    fogDensity: number;
    fogEnabled: boolean;
    /**
     * Bruma rasteira abaixo do horizonte, onde a névoa já apagou a grade.
     * É o que impede o vão entre a última linha e o horizonte de ler como céu.
     */
    groundHaze: number;

    /** Graus acima do horizonte. Negativo afunda o sol. */
    sunElevation: number;
    sunAzimuth: number;
    /** Raio angular do disco, em graus. */
    sunAngularSize: number;
    sunSlices: number;

    starCount: number;

    bloomIntensity: number;
    bloomRadius: number;
    scanlineStrength: number;
    vignetteStrength: number;
}

export const settings: Settings = {
    fovDegrees: 70,
    moveSpeed: 12,
    lookSensitivity: 0.0022,

    gridSize: 4,
    viewDistance: 220,

    fogDensity: 1,
    fogEnabled: true,
    groundHaze: 0.45,

    sunElevation: 4,
    sunAzimuth: 0,
    sunAngularSize: 13,
    sunSlices: 1.1,

    starCount: 1400,

    bloomIntensity: 0.55,
    bloomRadius: 1.6,
    scanlineStrength: 0.2,
    vignetteStrength: 0.55,
};

export const CANVAS_BACKGROUND = '#05000e';

export const degreesToRadians = (degrees: number): number => (degrees * Math.PI) / 180;
