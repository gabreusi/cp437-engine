/**
 * Cena ⇄ texto de URL: JSON, deflate, base64url.
 *
 * `CompressionStream` é nativo, então nada entra em `dependencies`. O deflate é
 * o que faz uma cena de uma dúzia de objetos caber num parâmetro de URL sem
 * estourar o limite de comprimento: o JSON é muito repetitivo (as mesmas chaves
 * em todo objeto), que é exatamente o que ele comprime bem.
 */

const bytesToBase64Url = (bytes: Uint8Array): string => {
  // Em pedaços: `String.fromCharCode(...bytes)` estoura a pilha em cenas grandes.
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const base64UrlToBytes = (text: string): Uint8Array<ArrayBuffer> => {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

const through = async (
  bytes: Uint8Array<ArrayBuffer>,
  stream: CompressionStream | DecompressionStream,
): Promise<Uint8Array> =>
  new Uint8Array(
    await new Response(
      new Blob([bytes]).stream().pipeThrough(stream),
    ).arrayBuffer(),
  );

/**
 * Seis algarismos significativos bastam para posição, cor e ângulo, e cortam
 * o ruído de ponto flutuante (`0.30000000000000004`) que incharia a URL.
 */
const roundNumbers = (_key: string, value: unknown): unknown =>
  typeof value === "number" && Number.isFinite(value)
    ? Number(value.toPrecision(6))
    : value;

export const encodeScene = async (scene: unknown): Promise<string> => {
  const json = new TextEncoder().encode(JSON.stringify(scene, roundNumbers));
  return bytesToBase64Url(
    await through(json, new CompressionStream("deflate-raw")),
  );
};

/** `null` para qualquer texto que não seja uma cena — a URL é entrada de fora. */
export const decodeScene = async (text: string): Promise<unknown | null> => {
  try {
    const bytes = await through(
      base64UrlToBytes(text),
      new DecompressionStream("deflate-raw"),
    );
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
};
