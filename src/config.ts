/**
 * Parâmetros que o painel ajusta em tempo real.
 *
 * São os controles da engine, não mais medidas de tela: a versão anterior tinha
 * "posição do horizonte" e "altura do sol em fileiras", que só faziam sentido
 * quando não existia câmera. Horizonte agora é para onde a câmera olha, e o sol
 * tem elevação e azimute como qualquer corpo celeste.
 */
import { type RampMode, type SurfaceTexture, TEXTURE } from "./render/ramp";

export interface Settings {
  fovDegrees: number;
  moveSpeed: number;
  /** Radianos de giro por pixel de mouse. */
  lookSensitivity: number;

  /** Unidades de mundo entre duas linhas da grade. */
  gridSize: number;
  /** De que alfabeto de glifos o chão sai: lisa, áspera ou irregular. */
  gridTexture: SurfaceTexture;
  /** Até onde a grade é emitida, em unidades de mundo. */
  viewDistance: number;

  fogDensity: number;
  fogEnabled: boolean;
  /**
   * Bruma rasteira abaixo do horizonte, onde a névoa já apagou a grade.
   * É o que impede o vão entre a última linha e o horizonte de ler como céu.
   */
  groundHaze: number;

  /**
   * O sol existe.
   *
   * Desligado, somem o disco, a luz direcional e o que o céu espalhava dela:
   * sobram as estrelas, o neon da grade e as luzes da cena. Não é o mesmo que
   * afundar o sol abaixo do horizonte — ali ele ainda ilumina de raspão e o
   * poente continua aceso.
   */
  sunEnabled: boolean;
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
  /**
   * Luz direta mínima para o chão entre as linhas aparecer.
   *
   * A grade é neon sobre o vazio, e o vazio é metade do estilo — encher o chão
   * inteiro apagaria a leitura de grade. Este é o corte: abaixo dele a célula
   * fica preta como sempre foi, acima dela o chão aparece com a textura da
   * grade. Alto deixa só o núcleo das poças de luz e a coluna do sol; baixo
   * vai revelando o resto do chão, e cobra por isso — cada célula revelada é
   * um sombreamento a mais por quadro.
   */
  groundFillLight: number;
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

  gridSize: 8,
  gridTexture: TEXTURE.SMOOTH,
  viewDistance: 300,

  fogDensity: 0.6,
  fogEnabled: true,
  groundHaze: 0.45,

  sunEnabled: true,
  sunElevation: 4,
  sunAzimuth: 0,
  sunAngularSize: 13,
  sunSlices: 1.1,

  starCount: 1600,

  lightingEnabled: true,
  shadowsEnabled: true,
  reflectionsEnabled: true,
  ambientLevel: 0.10,
  gridGlow: 0.5,
  sunLightIntensity: 1,
  skyReflectionIntensity: 1,
  groundReflectivity: 0.55,
  groundFillLight: 0.22,
  groundGloss: 26,
  glyphRamp: "classic",
  rampExposure: 0.75,
  maxShadowLights: 3,

  bloomIntensity: 0.1,
  bloomRadius: 1.2,
  scanlineStrength: 0.05,
  vignetteStrength: 0.15,
};

export const CANVAS_BACKGROUND = "#05000e";

export const degreesToRadians = (degrees: number): number =>
  (degrees * Math.PI) / 180;
