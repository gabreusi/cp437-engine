/**
 * Parâmetros que o painel ajusta em tempo real.
 *
 * São os controles da engine, não mais medidas de tela: a versão anterior tinha
 * "posição do horizonte" e "altura do sol em fileiras", que só faziam sentido
 * quando não existia câmera. Horizonte agora é para onde a câmera olha, e o sol
 * tem elevação e azimute como qualquer corpo celeste.
 */
import type { RampMode } from './render/ramp';

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

    lightingEnabled: boolean;
    shadowsEnabled: boolean;
    reflectionsEnabled: boolean;
    /** Luz que chega de todo lado. Sem ela, o que está na sombra some. */
    ambientLevel: number;
    /** Força do sol como luz direcional, separada do brilho do disco. */
    sunLightIntensity: number;
    /** Quanto o céu vale quando é refletido por uma superfície. */
    skyReflectionIntensity: number;
    /**
     * Brilho próprio das linhas da grade.
     *
     * A grade é neon, não asfalto: ela emite. Sem isto ela seria uma superfície
     * horizontal iluminada por um sol a quatro graus, ou seja, praticamente
     * preta — fisicamente correto e completamente errado para o estilo. Este é
     * o valor que reproduz o brilho que ela sempre teve, e a luz entra por cima.
     */
    gridGlow: number;
    /** Quanto do reflexo a grade devolve. Ela reflete, mas não é espelho. */
    groundReflectivity: number;
    /** Expoente do lóbulo da grade. Baixo espalha o sol numa coluna larga. */
    groundGloss: number;
    /** Como a luz escolhe o caractere: rampa clássica, por família, ou nunca. */
    glyphRamp: RampMode;
    /** Exposição da rampa: onde a luminância vira caractere cheio. */
    rampExposure: number;
    /** Teto de luzes que projetam sombra num mesmo fragmento. */
    maxShadowLights: number;

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

    lightingEnabled: true,
    shadowsEnabled: true,
    reflectionsEnabled: true,
    ambientLevel: 0.16,
    gridGlow: 0.62,
    sunLightIntensity: 0.9,
    skyReflectionIntensity: 1,
    groundReflectivity: 0.55,
    groundGloss: 26,
    glyphRamp: 'family',
    rampExposure: 0.75,
    maxShadowLights: 3,

    bloomIntensity: 0.55,
    bloomRadius: 1.6,
    scanlineStrength: 0.2,
    vignetteStrength: 0.55,
};

export const CANVAS_BACKGROUND = '#05000e';

export const degreesToRadians = (degrees: number): number => (degrees * Math.PI) / 180;
