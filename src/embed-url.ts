import { DEFAULT_SETTINGS, type Settings, settings } from "./config";
import type { Camera } from "./render/camera";
import { encodeScene } from "./scene/scene-codec";
import type { World } from "./scene/world";

/**
 * O lado que escreve do que `url-config.ts` lê: a URL que reproduz o que está
 * na tela agora — ajustes, cena e enquadramento da câmera.
 *
 * Só entram os ajustes que **diferem do padrão**: o resto já é o que a engine
 * faz sozinha, e cada parâmetro a mais é comprimento de URL e uma chance de o
 * iframe do portfólio ficar preso a um valor que mudou de padrão depois.
 */

const RADIANS_TO_DEGREES = 180 / Math.PI;
const STATUS_HOLD_MS = 2500;

/** A URL que a engine gera passa de ~8 mil caracteres: alguns servidores recusam. */
const LONG_URL = 8000;

const round = (value: number, digits = 4): string =>
  String(Number(value.toFixed(digits)));

const formatSetting = (value: number | boolean | string): string =>
  typeof value === "number"
    ? String(Number(value.toPrecision(6)))
    : typeof value === "boolean"
      ? value
        ? "1"
        : "0"
      : value;

/** Vírgula não precisa de escape dentro de um valor, e sem ela `cam=` se lê. */
const encodeValue = (value: string): string =>
  encodeURIComponent(value).replace(/%2C/g, ",");

export const buildEmbedUrl = async (
  world: World,
  camera: Camera,
): Promise<string> => {
  const parts: string[] = [];

  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    if (settings[key] === DEFAULT_SETTINGS[key]) continue;
    parts.push(`${key}=${encodeValue(formatSetting(settings[key]))}`);
  }

  parts.push(`scene=${await encodeScene(world.serialize())}`);

  const { x, y, z } = camera.position;
  const pose = [
    round(x),
    round(y),
    round(z),
    round(camera.yaw * RADIANS_TO_DEGREES, 2),
    round(camera.pitch * RADIANS_TO_DEGREES, 2),
  ];
  parts.push(`cam=${pose.join(",")}`);

  return `${location.origin}${location.pathname}?${parts.join("&")}`;
};

let status: string | null = null;
let statusTimer: number | undefined;

const setStatus = (message: string): void => {
  status = message;
  window.clearTimeout(statusTimer);
  statusTimer = window.setTimeout(() => {
    status = null;
  }, STATUS_HOLD_MS);
};

/**
 * O rótulo do item do menu. O menu reconstrói a lista todo quadro, então o
 * texto pode mudar sozinho para dar o retorno do clique — a ação é assíncrona
 * (compressão) e sem isso não haveria como saber se funcionou.
 */
export const embedUrlLabel = (): string => status ?? "Copy embed URL";

export const copyEmbedUrl = async (
  world: World,
  camera: Camera,
): Promise<void> => {
  setStatus("Building URL...");
  try {
    const url = await buildEmbedUrl(world, camera);
    try {
      await navigator.clipboard.writeText(url);
      setStatus(
        url.length > LONG_URL
          ? `Copied (${url.length} chars, long!)`
          : `Copied! (${url.length} chars)`,
      );
    } catch {
      // Sem permissão de área de transferência (iframe, http): a barra de
      // endereço vira o meio de copiar, e o console guarda a URL inteira.
      history.replaceState(null, "", url);
      console.info(`[embed-url] ${url}`);
      setStatus("Clipboard blocked: URL is in the address bar");
    }
  } catch (error) {
    console.error("[embed-url]", error);
    setStatus("Failed to build URL");
  }
};
