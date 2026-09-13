/**
 * Parâmetros que o painel ajusta em tempo real.
 *
 * São os controles da engine, não mais medidas de tela: a versão anterior tinha
 * "posição do horizonte" e "altura do sol em fileiras", que só faziam sentido
 * quando não existia câmera. Horizonte agora é para onde a câmera olha, e o sol
 * tem elevação e azimute como qualquer corpo celeste.
 */
import {type SurfaceTexture, TEXTURE} from "./render/ramp";

/** De onde o atlas tira o desenho dos glifos que não são pintados à mão. */
export const FONT = {
  SYSTEM: "system",
  OLDSCHOOL: "oldschool",
} as const;
export type FontChoice = (typeof FONT)[keyof typeof FONT];

export interface Settings {
  fovDegrees: number;
  moveSpeed: number;
  /** Radianos de giro por pixel de mouse. */
  lookSensitivity: number;
  /**
   * Multiplicador do teto de colunas/fileiras (`MAX_COLS`/`MAX_ROWS`,
   * `render/viewport.ts`), não do backing store — a nitidez de cada célula
   * continua só com `devicePixelRatio`. Mais colunas/fileiras é mais
   * caractere por tela, então isto paga CPU de verdade (ver README, "Custo");
   * não é o multiplicador "de graça" que era antes de virar teto de grade.
   */
  renderScale: number;
  /** Fonte do atlas para os glifos que vêm de texto, não de `PAINTERS`. */
  fontFamily: FontChoice;

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
  /** Fileiras de tela por fatia — maior é fatia mais grossa, ou seja, menos fatias. */
  sunSliceRows: number;
  /** Fração de cada fatia que vira vão. */
  sunSliceGap: number;
  /**
   * O roxo lavando a faixa do horizonte, em volta do sol — desliga só essa
   * camada; o disco, a luz e o resto do céu (banda ciano, glow rosa) continuam.
   */
  sunWashEnabled: boolean;
  /** Alcance do roxo em volta do sol, relativo ao padrão. */
  sunWashSize: number;
  sunWashIntensity: number;

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
  /** Quanto a luz pode vencer a forma na escolha do glifo de aresta/disco. Zero é só geometria. */
  rampWeight: number;
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
  renderScale: 1,
  fontFamily: FONT.OLDSCHOOL,

  gridSize: 16,
  gridTexture: TEXTURE.SMOOTH,
  viewDistance: 300,

  fogDensity: 0.6,
  fogEnabled: true,
  groundHaze: 0.35,

  sunEnabled: false,
  sunElevation: 20,
  sunAzimuth: 0,
  sunAngularSize: 13,
  sunSliceRows: 2.5,
  sunSliceGap: 0.5,
  sunWashEnabled: true,
  sunWashSize: 1,
  sunWashIntensity: 2,

  starCount: 500,

  lightingEnabled: true,
  shadowsEnabled: true,
  reflectionsEnabled: true,
  ambientLevel: 0.05,
  gridGlow: 0.1,
  sunLightIntensity: 0.7,
  skyReflectionIntensity: 1,
  groundReflectivity: 1,
  groundFillLight: 1,
  groundGloss: 2,
  rampWeight: 10,
  rampExposure: 0.5,
  maxShadowLights: 8,

  bloomIntensity: 0.1,
  bloomRadius: 1.2,
  scanlineStrength: 0.05,
  vignetteStrength: 0.15,
};

const SETTINGS_STORAGE_KEY = "cp437-engine/settings";

/**
 * Cópia congelada dos defaults, feita antes de qualquer `loadSettings()`.
 *
 * `settings` acima já É os defaults, mutados no lugar — para "aplicar o
 * salvo por cima dos defaults" sem depender da ordem de chamada, precisa de
 * uma segunda cópia que ninguém mais toca. Mesmo problema que `World.load()`
 * resolve com `createEntity(kind, defaults())` (`scene/world.ts`).
 */
const DEFAULT_SETTINGS: Settings = { ...settings };

/**
 * Grava `settings` inteiro em `localStorage`.
 *
 * Chamado a cada mudança de um controle no menu (`slider`/`toggle`,
 * `ui/menu/schema.ts`) — salvamento automático, sem botão. Falha silenciosa,
 * mesmo padrão de `World.save()`: um `localStorage` bloqueado não pode
 * travar a engine, só deixá-la sem memória entre sessões.
 */
export const saveSettings = (): void => {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Sem storage, sem salvar — a engine segue com o que está em memória.
  }
};

/**
 * Aplica o que foi salvo por cima de uma cópia limpa dos defaults.
 *
 * `Object.assign(settings, DEFAULT_SETTINGS, saved)` primeiro repõe todo
 * campo no default, depois só sobrescreve os que `saved` de fato tem: um
 * campo novo (de uma versão mais nova da engine) nasce com o default em vez
 * de `undefined`, e um campo removido não deixa lixo — ele nunca é copiado.
 * Chamar uma vez, no início (`main.ts`), antes de qualquer leitura de
 * `settings`.
 */
export const loadSettings = (): void => {
  let raw: string | null;
  try {
    raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
  } catch {
    return;
  }
  if (raw === null) return;

  try {
    const saved = JSON.parse(raw) as Partial<Settings>;
    Object.assign(settings, DEFAULT_SETTINGS, saved);
  } catch {
    // Salvo corrompido: fica no default.
  }
};

export const CANVAS_BACKGROUND = "#05000e";

export const degreesToRadians = (degrees: number): number =>
  (degrees * Math.PI) / 180;
