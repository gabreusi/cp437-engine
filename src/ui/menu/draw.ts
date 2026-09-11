import { type Rgb, fromHex } from "../../math/color";
import type { Framebuffer } from "../../render/framebuffer";
import { COLOR, GLYPH } from "../../render/palette";
import { OVERLAY_DEPTH, drawBox, drawFill, drawText } from "../../render/text";
import type { Viewport } from "../../render/viewport";
import { type MenuGroup, type MenuItem, formatValue } from "./model";

/**
 * O menu desenhado na própria grade de caracteres.
 *
 * Escrever no framebuffer, e não em HTML por cima dele, é o que faz o menu
 * receber bloom, scanline e vinheta junto com a cena: o visual de terminal CRT
 * não é imitado, é o mesmo caminho de render. O painel em DOM que isto substitui
 * tinha o problema oposto — flutuava sobre a cena sem pertencer a ela, e a folha
 * de estilo dele era um segundo lugar onde a paleta morava.
 */

export const MENU_COLORS = {
  BACKDROP: fromHex("#0a0618"),
  BORDER: COLOR.GRID_NEAR,
  TITLE: COLOR.HORIZON,
  LABEL: fromHex("#8fb8cc"),
  VALUE: COLOR.GRID_NEAR,
  /** O item com foco. Amarelo do sol: destaca sem sair da paleta. */
  FOCUS: fromHex("#ffd54a"),
  HEADING: fromHex("#f24ad6"),
  DANGER: fromHex("#ff6379"),
  DIM: fromHex("#3a5a6b"),
} as const;

/** Escurece a cena atrás sem apagar: o fundo continua sendo lido. */
const BACKDROP_ALPHA = 0.9;

/**
 * Largura do painel lateral do editor, em colunas.
 *
 * Não é um número redondo: é a soma do que uma linha de item precisa — rótulo,
 * trilha, valor e as duas bordas. Menos do que isto faz o valor de um slider
 * bater na moldura.
 */
export const PANEL_WIDTH = 36;

const MAX_WIDTH = 76;
const MAX_HEIGHT = 34;
const GROUP_WIDTH = 16;
const LABEL_WIDTH = 17;
const VALUE_WIDTH = 8;

export interface MenuLayout {
  col: number;
  row: number;
  width: number;
  height: number;
  groupCol: number;
  groupFirstRow: number;
  itemCol: number;
  itemWidth: number;
  itemFirstRow: number;
  visibleRows: number;
  /** Onde a barra do slider começa e quanto ela mede, em colunas. */
  trackCol: number;
  trackWidth: number;
}

/**
 * O layout é calculado uma vez e usado pelo desenho e pelo mouse.
 *
 * Duas contas separadas para "onde a linha está" e "onde o clique caiu"
 * divergiriam no primeiro ajuste de largura, e o menu passaria a responder uma
 * linha acima do que mostra.
 */
export const computeLayout = (viewport: Viewport): MenuLayout => {
  const width = Math.min(MAX_WIDTH, Math.max(30, viewport.colCount - 4));
  const height = Math.min(MAX_HEIGHT, Math.max(12, viewport.rowCount - 2));
  const col = Math.floor((viewport.colCount - width) / 2);
  const row = Math.floor((viewport.rowCount - height) / 2);

  const itemCol = col + GROUP_WIDTH + 3;
  const itemWidth = width - (GROUP_WIDTH + 3) - 2;
  const trackCol = itemCol + LABEL_WIDTH + 1;

  return {
    col,
    row,
    width,
    height,
    groupCol: col + 2,
    groupFirstRow: row + 3,
    itemCol,
    itemWidth,
    itemFirstRow: row + 3,
    // Título, duas bordas e o rodapé de ajuda saem da área útil.
    visibleRows: height - 5,
    trackCol,
    trackWidth: Math.max(6, itemWidth - LABEL_WIDTH - VALUE_WIDTH - 4),
  };
};

/**
 * O painel lateral: os controles do objeto escolhido, e nada mais.
 *
 * Usa o mesmo `MenuLayout` do menu de pausa porque desenha os mesmos widgets —
 * é o que faz um slider ter a mesma aparência e o mesmo ponto de clique nos
 * dois lugares. O que muda é a moldura em volta: encostada na direita, alta só
 * o quanto a lista pede, e sem coluna de grupos, porque não há para onde
 * navegar a partir dela.
 */
export const computePanelLayout = (
  viewport: Viewport,
  itemCount: number,
): MenuLayout => {
  const width = Math.min(PANEL_WIDTH, Math.max(24, viewport.colCount - 2));
  // Título, moldura e uma linha de folga; o resto é lista.
  const height = Math.min(viewport.rowCount - 2, itemCount + 4);
  const col = viewport.colCount - width - 1;
  const row = 1;

  const itemCol = col + 2;
  const itemWidth = width - 3;

  return {
    col,
    row,
    width,
    height,
    groupCol: col,
    groupFirstRow: row,
    itemCol,
    itemWidth,
    itemFirstRow: row + 2,
    visibleRows: Math.max(1, height - 3),
    trackCol: itemCol + LABEL_WIDTH + 1,
    trackWidth: Math.max(6, itemWidth - LABEL_WIDTH - VALUE_WIDTH - 4),
  };
};

export const drawPanel = (
  framebuffer: Framebuffer,
  layout: MenuLayout,
  items: readonly MenuItem[],
  scroll: number,
  hoverItem: number,
): void => {
  const { col, row, width, height } = layout;

  drawFill(
    framebuffer,
    col,
    row,
    width,
    height,
    GLYPH.BLOCK_FULL,
    MENU_COLORS.BACKDROP,
    BACKDROP_ALPHA,
  );
  drawBox(framebuffer, col, row, width, height, MENU_COLORS.BORDER);

  const end = Math.min(items.length, scroll + layout.visibleRows);
  for (let index = scroll; index < end; index += 1) {
    drawItem(
      framebuffer,
      layout,
      items[index]!,
      layout.itemFirstRow + (index - scroll),
      false,
      index === hoverItem,
    );
  }

  if (scroll > 0) {
    plot(
      framebuffer,
      col + width - 2,
      layout.itemFirstRow,
      GLYPH.ARROW_UP,
      MENU_COLORS.DIM,
    );
  }
  if (end < items.length) {
    plot(
      framebuffer,
      col + width - 2,
      layout.itemFirstRow + layout.visibleRows - 1,
      GLYPH.ARROW_DOWN,
      MENU_COLORS.DIM,
    );
  }
};

const plot = (
  framebuffer: Framebuffer,
  col: number,
  row: number,
  glyph: number,
  color: Rgb,
  emissive = 0,
): void => framebuffer.plot(col, row, glyph, color, OVERLAY_DEPTH, 1, emissive);

export interface DrawState {
  groups: readonly MenuGroup[];
  items: readonly MenuItem[];
  groupIndex: number;
  itemIndex: number;
  scroll: number;
  /** A coluna que responde ao teclado. */
  onGroups: boolean;
  hoverItem: number;
}

export const drawMenu = (
  framebuffer: Framebuffer,
  layout: MenuLayout,
  state: DrawState,
): void => {
  const { col, row, width, height } = layout;

  drawFill(
    framebuffer,
    col,
    row,
    width,
    height,
    GLYPH.BLOCK_FULL,
    MENU_COLORS.BACKDROP,
    BACKDROP_ALPHA,
  );
  drawBox(framebuffer, col, row, width, height, MENU_COLORS.BORDER);

  drawText(
    framebuffer,
    col + 2,
    row,
    " CP437 ENGINE",
    MENU_COLORS.TITLE,
    1,
    0.4,
  );

  // Régua vertical separando grupos de itens, emendando na moldura.
  const dividerCol = col + GROUP_WIDTH + 1;
  plot(framebuffer, dividerCol, row, GLYPH.BOX_HD, MENU_COLORS.BORDER);
  for (let y = row + 1; y < row + height - 1; y += 1) {
    plot(framebuffer, dividerCol, y, GLYPH.BOX_V, MENU_COLORS.BORDER);
  }
  plot(
    framebuffer,
    dividerCol,
    row + height - 1,
    GLYPH.BOX_HU,
    MENU_COLORS.BORDER,
  );

  drawGroups(framebuffer, layout, state);
  drawItems(framebuffer, layout, state);

  const hint = state.onGroups
    ? "▲▼ group   ► select   Esc close"
    : "▲▼ item   ◄► adjust   Enter apply   Tab go back   Esc close";
  drawText(framebuffer, col + 2, row + height - 2, hint, MENU_COLORS.DIM);
};

const drawGroups = (
  framebuffer: Framebuffer,
  layout: MenuLayout,
  state: DrawState,
): void => {
  for (let index = 0; index < state.groups.length; index += 1) {
    const y = layout.groupFirstRow + index;
    if (y >= layout.row + layout.height - 3) break;

    const active = index === state.groupIndex;
    const color = active
      ? state.onGroups
        ? MENU_COLORS.FOCUS
        : MENU_COLORS.VALUE
      : MENU_COLORS.LABEL;

    if (active)
      plot(framebuffer, layout.groupCol - 1, y, GLYPH.ARROW_RIGHT, color, 0.3);
    drawText(
      framebuffer,
      layout.groupCol + 1,
      y,
      state.groups[index]!.label,
      color,
      1,
      active ? 0.3 : 0,
    );
  }
};

const drawItems = (
  framebuffer: Framebuffer,
  layout: MenuLayout,
  state: DrawState,
): void => {
  const end = Math.min(state.items.length, state.scroll + layout.visibleRows);

  for (let index = state.scroll; index < end; index += 1) {
    const item = state.items[index]!;
    const y = layout.itemFirstRow + (index - state.scroll);
    const focused = index === state.itemIndex && !state.onGroups;
    const hovered = index === state.hoverItem;

    drawItem(framebuffer, layout, item, y, focused, hovered);
  }

  // Marcas de que a lista continua. Sem elas, um grupo longo parece truncado.
  if (state.scroll > 0) {
    plot(
      framebuffer,
      layout.itemCol + layout.itemWidth,
      layout.itemFirstRow,
      GLYPH.ARROW_UP,
      MENU_COLORS.DIM,
    );
  }
  if (end < state.items.length) {
    plot(
      framebuffer,
      layout.itemCol + layout.itemWidth,
      layout.itemFirstRow + layout.visibleRows - 1,
      GLYPH.ARROW_DOWN,
      MENU_COLORS.DIM,
    );
  }
};

export const drawItem = (
  framebuffer: Framebuffer,
  layout: MenuLayout,
  item: MenuItem,
  y: number,
  focused: boolean,
  hovered: boolean,
): void => {
  const { itemCol, trackCol, trackWidth } = layout;
  const emissive = focused ? 0.45 : 0;

  if (item.kind === "heading") {
    drawText(framebuffer, itemCol, y, item.label, MENU_COLORS.HEADING, 0.85);
    return;
  }

  const labelColor = focused
    ? MENU_COLORS.FOCUS
    : hovered
      ? MENU_COLORS.VALUE
      : MENU_COLORS.LABEL;

  if (focused)
    plot(
      framebuffer,
      itemCol - 1,
      y,
      GLYPH.ARROW_RIGHT,
      MENU_COLORS.FOCUS,
      emissive,
    );

  switch (item.kind) {
    case "slider": {
      drawText(
        framebuffer,
        itemCol,
        y,
        item.label.slice(0, LABEL_WIDTH),
        labelColor,
        1,
        emissive,
      );

      const span = item.max - item.min;
      const ratio = span <= 0 ? 0 : (item.get() - item.min) / span;
      const handle = Math.round(ratio * (trackWidth - 1));

      plot(framebuffer, trackCol - 1, y, GLYPH.ARROW_LEFT, MENU_COLORS.DIM);
      for (let step = 0; step < trackWidth; step += 1) {
        const isHandle = step === handle;
        plot(
          framebuffer,
          trackCol + step,
          y,
          isHandle ? GLYPH.BLOCK_FULL : GLYPH.BOX_H,
          isHandle ? labelColor : MENU_COLORS.DIM,
          isHandle ? emissive : 0,
        );
      }
      plot(
        framebuffer,
        trackCol + trackWidth,
        y,
        GLYPH.ARROW_RIGHT,
        MENU_COLORS.DIM,
      );

      const text = formatValue(item);
      drawText(
        framebuffer,
        trackCol + trackWidth + 2 + (VALUE_WIDTH - 2 - text.length),
        y,
        text,
        MENU_COLORS.VALUE,
        1,
        emissive,
      );
      return;
    }

    case "toggle": {
      const on = item.get();
      drawText(
        framebuffer,
        itemCol,
        y,
        on ? "[x]" : "[ ]",
        on ? MENU_COLORS.VALUE : MENU_COLORS.DIM,
        1,
        emissive,
      );
      drawText(
        framebuffer,
        itemCol + 4,
        y,
        item.label,
        labelColor,
        1,
        emissive,
      );
      return;
    }

    case "choice": {
      drawText(
        framebuffer,
        itemCol,
        y,
        item.label.slice(0, LABEL_WIDTH),
        labelColor,
        1,
        emissive,
      );
      plot(framebuffer, trackCol - 1, y, GLYPH.ARROW_LEFT, MENU_COLORS.DIM);
      const current = item.options.find(
        (option) => option.value === item.get(),
      );
      drawText(
        framebuffer,
        trackCol + 1,
        y,
        current?.label ?? "?",
        MENU_COLORS.VALUE,
        1,
        emissive,
      );
      plot(
        framebuffer,
        trackCol + trackWidth,
        y,
        GLYPH.ARROW_RIGHT,
        MENU_COLORS.DIM,
      );
      return;
    }

    case "action": {
      const color = item.danger
        ? focused
          ? MENU_COLORS.DANGER
          : MENU_COLORS.DANGER
        : labelColor;
      drawText(
        framebuffer,
        itemCol,
        y,
        `» ${item.label}`,
        color,
        item.danger && !focused ? 0.7 : 1,
        emissive,
      );
      return;
    }

    case "entity": {
      drawText(
        framebuffer,
        itemCol,
        y,
        item.visible ? "[x]" : "[ ]",
        item.visible ? MENU_COLORS.VALUE : MENU_COLORS.DIM,
        1,
        emissive,
      );

      const color = item.selected ? MENU_COLORS.VALUE : labelColor;
      drawText(
        framebuffer,
        itemCol + 4,
        y,
        item.label,
        color,
        1,
        item.selected ? Math.max(emissive, 0.3) : emissive,
      );

      if (item.selected) {
        plot(
          framebuffer,
          itemCol + layout.itemWidth - 1,
          y,
          GLYPH.DIAMOND,
          MENU_COLORS.FOCUS,
          0.3,
        );
      }
      return;
    }
  }
};
