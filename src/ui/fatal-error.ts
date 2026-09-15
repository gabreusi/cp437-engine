/**
 * Caixa de erro fatal, fora do grid de caracteres.
 *
 * Existe só para o caso em que a engine não consegue nem começar a desenhar
 * (sem adapter WebGPU não há dispositivo, sem dispositivo não há framebuffer
 * nem atlas) — o grid CP437 não é uma opção porque ele mesmo depende do que
 * falhou. A moldura usa os glifos de caixa da CP437 direto em texto DOM, e
 * não os `GLYPH.BOX_*` do atlas, pelo mesmo motivo.
 */

const BOX_WIDTH = 56;
const TITLE_COLOR = "#ff6379";

const BOX = {
  H: "─",
  V: "│",
  TL: "┌",
  TR: "┐",
  BL: "└",
  BR: "┘",
  ML: "├",
  MR: "┤",
} as const;

const wrapLine = (text: string, width: number): string[] => {
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current === "" ? word : `${current} ${word}`;
    if (candidate.length > width) {
      if (current !== "") lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current !== "") lines.push(current);
  return lines;
};

const center = (text: string, width: number): string => {
  const left = Math.max(0, Math.floor((width - text.length) / 2));
  return text.padStart(left + text.length).padEnd(width);
};

/** Adiciona uma linha de texto simples (uma cor só) ao container. */
const appendLine = (container: HTMLElement, text: string): void => {
  container.appendChild(document.createTextNode(`${text}\n`));
};

/** Mostra uma caixa de erro estilo BIOS, centralizada, e trava a tela nela. */
export const showFatalError = (title: string, body: string[]): void => {
  const innerWidth = BOX_WIDTH - 4;
  const contentLines = body.flatMap((line) => wrapLine(line, innerWidth));

  const overlay = document.createElement("pre");
  overlay.style.position = "fixed";
  overlay.style.inset = "0";
  overlay.style.margin = "auto";
  overlay.style.width = "fit-content";
  overlay.style.height = "fit-content";
  overlay.style.padding = "0";
  overlay.style.background = "var(--void)";
  overlay.style.color = "var(--neon-cyan)";
  overlay.style.fontFamily = "var(--mono)";
  overlay.style.fontSize = "16px";
  overlay.style.whiteSpace = "pre";
  overlay.style.zIndex = "1000";

  appendLine(overlay, `${BOX.TL}${BOX.H.repeat(BOX_WIDTH - 2)}${BOX.TR}`);
  appendLine(overlay, `${BOX.V} ${" ".repeat(innerWidth)} ${BOX.V}`);

  overlay.appendChild(document.createTextNode(`${BOX.V} `));
  const titleSpan = document.createElement("span");
  titleSpan.style.color = TITLE_COLOR;
  titleSpan.textContent = center(title, innerWidth);
  overlay.appendChild(titleSpan);
  overlay.appendChild(document.createTextNode(` ${BOX.V}\n`));

  appendLine(overlay, `${BOX.V} ${" ".repeat(innerWidth)} ${BOX.V}`);
  appendLine(overlay, `${BOX.ML}${BOX.H.repeat(BOX_WIDTH - 2)}${BOX.MR}`);
  appendLine(overlay, `${BOX.V} ${" ".repeat(innerWidth)} ${BOX.V}`);
  appendLine(overlay, `${BOX.V} ${" ".repeat(innerWidth)} ${BOX.V}`);
  for (const line of contentLines) {
    appendLine(overlay, `${BOX.V} ${line.padEnd(innerWidth)} ${BOX.V}`);
  }
  appendLine(overlay, `${BOX.V} ${" ".repeat(innerWidth)} ${BOX.V}`);
  appendLine(overlay, `${BOX.V} ${" ".repeat(innerWidth)} ${BOX.V}`);
  appendLine(overlay, `${BOX.BL}${BOX.H.repeat(BOX_WIDTH - 2)}${BOX.BR}`);

  document.body.appendChild(overlay);
};
