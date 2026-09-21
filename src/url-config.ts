import { DEFAULT_SETTINGS, FONT, type Settings } from "./config";
import { TEXTURES } from "./render/ramp";

/**
 * A configuração que a URL carrega, para quem embarca a engine num iframe.
 *
 * O caminho de trabalho é: acertar tudo na engine cheia, usar "Copy embed URL"
 * no menu e colar o resultado no `src` do iframe — `embed-url.ts` é o lado que
 * escreve, este é o que lê. Cada parâmetro é opcional e independente; sem
 * nenhum, a engine abre exatamente como sempre abriu.
 *
 *   qualquer campo de `Settings`   ?bloomIntensity=0.3&sunEnabled=1
 *   ui                             apelido de `uiScale`
 *   scene                          demo | empty | <cena codificada>
 *   cam                            x,y,z,yaw,pitch — ângulos em graus
 *   hud, menu                      0 esconde/desliga
 *   orbit, orbitSpeed, orbitTarget câmera girando sozinha (graus/s; x,y,z)
 *   lock                           0 nunca captura o mouse (padrão: 0 com orbit)
 *   persist                        1/0 força ler e gravar o localStorage
 *
 * Ângulos em graus aqui e não em radianos: a URL é fronteira, e é onde a
 * convenção do projeto manda usar graus.
 */

export type SceneSource =
  | { kind: "demo" }
  | { kind: "empty" }
  | { kind: "encoded"; data: string };

export interface CameraPose {
  x: number;
  y: number;
  z: number;
  yawDegrees: number;
  pitchDegrees: number;
}

export interface OrbitConfig {
  /** Graus por segundo. */
  speedDegrees: number;
  /** `null`: o ponto à frente da câmera de partida, na altura dela. */
  target: { x: number; y: number; z: number } | null;
}

export interface UrlConfig {
  settings: Partial<Settings>;
  scene: SceneSource | null;
  camera: CameraPose | null;
  hud: boolean;
  menu: boolean;
  lock: boolean;
  orbit: OrbitConfig | null;
  /** Ler e gravar `localStorage`. Desligado sempre que a URL traz configuração. */
  persist: boolean;
}

const ALIASES: Record<string, keyof Settings> = { ui: "uiScale" };

const RESERVED = new Set([
  "scene",
  "cam",
  "hud",
  "menu",
  "lock",
  "persist",
  "orbit",
  "orbitSpeed",
  "orbitTarget",
]);

/** Campos de texto só aceitam o que o menu também aceita. */
const STRING_CHOICES: Partial<Record<keyof Settings, readonly string[]>> = {
  fontFamily: Object.values(FONT),
  gridTexture: TEXTURES,
};

const DEFAULT_ORBIT_SPEED = 6;

export const parseBoolean = (raw: string | null): boolean | undefined => {
  if (raw === null) return undefined;
  switch (raw.toLowerCase()) {
    case "1":
    case "true":
    case "on":
    case "yes":
      return true;
    case "0":
    case "false":
    case "off":
    case "no":
      return false;
    default:
      return undefined;
  }
};

const parseNumber = (raw: string | null): number | undefined => {
  if (raw === null || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
};

/** `a,b,c[,…]` com `count` números finitos, ou `null`. */
const parseNumberList = (raw: string | null, count: number): number[] | null => {
  if (raw === null) return null;
  const values = raw.split(",").map((part) => Number(part));
  if (values.length !== count || values.some((value) => !Number.isFinite(value))) {
    return null;
  }
  return values;
};

const warn = (message: string): void => {
  if (import.meta.env.DEV) console.warn(`[url-config] ${message}`);
};

const parseSettings = (params: URLSearchParams): Partial<Settings> => {
  const settings: Partial<Settings> = {};
  const assign = <K extends keyof Settings>(key: K, value: Settings[K]): void => {
    settings[key] = value;
  };

  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    const alias = Object.keys(ALIASES).find((name) => ALIASES[name] === key);
    const raw = params.get(key) ?? (alias === undefined ? null : params.get(alias));
    if (raw === null) continue;

    const template = DEFAULT_SETTINGS[key];
    if (typeof template === "number") {
      const value = parseNumber(raw);
      if (value === undefined) warn(`${key}: número inválido "${raw}"`);
      else assign(key, value as Settings[typeof key]);
    } else if (typeof template === "boolean") {
      const value = parseBoolean(raw);
      if (value === undefined) warn(`${key}: booleano inválido "${raw}"`);
      else assign(key, value as Settings[typeof key]);
    } else if (STRING_CHOICES[key]?.includes(raw)) {
      assign(key, raw as Settings[typeof key]);
    } else {
      warn(`${key}: valor desconhecido "${raw}"`);
    }
  }
  return settings;
};

const parseScene = (raw: string | null): SceneSource | null => {
  if (raw === null || raw === "") return null;
  if (raw === "demo") return { kind: "demo" };
  if (raw === "empty") return { kind: "empty" };
  return { kind: "encoded", data: raw };
};

const parseCamera = (raw: string | null): CameraPose | null => {
  const values = parseNumberList(raw, 5);
  if (values === null) {
    if (raw !== null) warn(`cam: esperava x,y,z,yaw,pitch — recebi "${raw}"`);
    return null;
  }
  const [x, y, z, yawDegrees, pitchDegrees] = values as [
    number,
    number,
    number,
    number,
    number,
  ];
  return { x, y, z, yawDegrees, pitchDegrees };
};

const parseOrbit = (params: URLSearchParams): OrbitConfig | null => {
  if (parseBoolean(params.get("orbit")) !== true) return null;

  const target = parseNumberList(params.get("orbitTarget"), 3);
  return {
    speedDegrees: parseNumber(params.get("orbitSpeed")) ?? DEFAULT_ORBIT_SPEED,
    target: target === null ? null : { x: target[0]!, y: target[1]!, z: target[2]! },
  };
};

export const parseUrlConfig = (search: string): UrlConfig => {
  const params = new URLSearchParams(search);

  if (import.meta.env.DEV) {
    for (const name of params.keys()) {
      const known =
        RESERVED.has(name) || name in ALIASES || name in DEFAULT_SETTINGS;
      if (!known) warn(`parâmetro desconhecido "${name}"`);
    }
  }

  const settings = parseSettings(params);
  const scene = parseScene(params.get("scene"));
  const orbit = parseOrbit(params);

  // Configuração na URL é a fonte da verdade: ler o que ficou salvo mudaria o
  // primeiro quadro conforme o histórico de quem abriu, e gravar por cima
  // transformaria a URL em preferência daquele navegador.
  const carriesConfig = Object.keys(settings).length > 0 || scene !== null;

  return {
    settings,
    scene,
    camera: parseCamera(params.get("cam")),
    hud: parseBoolean(params.get("hud")) ?? true,
    menu: parseBoolean(params.get("menu")) ?? true,
    // Câmera automática não quer o mouse capturado por um clique qualquer.
    lock: parseBoolean(params.get("lock")) ?? orbit === null,
    orbit,
    persist: parseBoolean(params.get("persist")) ?? !carriesConfig,
  };
};
