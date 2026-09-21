import {fromHex, type Rgb} from "../../math/color";
import type {Framebuffer} from "../../render/framebuffer";
import {COLOR, GLYPH} from "../../render/palette";
import {drawBox, drawFill, drawText, OVERLAY_DEPTH} from "../../render/text";
import type {UiViewport} from "../../render/ui-viewport";
import {formatValue, type MenuGroup, type MenuItem} from "./model";

/**
 * O menu desenhado em caracteres, na grade da interface.
 *
 * Escrever num framebuffer, e não em HTML por cima do canvas, é o que faz o menu
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

/**
 * Quase sólido: a cena ainda se adivinha por trás, sem atrapalhar a leitura.
 * As células com texto são opacas de propósito (`Framebuffer.opaqueOverlay`),
 * senão o ASCII da cena apareceria nos vãos do glifo. Por isso o valor tem que
 * ficar perto de 1: quanto mais baixo, mais o fundo dos vãos (opaco) destoa do
 * das células vazias (translúcido) e vira um xadrez sob o que se quer ler.
 */
const BACKDROP_ALPHA = 0.95;

/**
 * Largura do painel lateral do editor, em colunas.
 *
 * Não é um número redondo: é a soma do que uma linha de item precisa — rótulo,
 * trilha, valor e as duas bordas. Menos do que isto faz o valor de um slider
 * bater na moldura.
 */
export const PANEL_WIDTH = 36;

/**
 * Abaixo destas colunas de UI a coluna de grupos não cabe ao lado de uma
 * lista legível (grupos + rótulo + trilha + valor somam ~54), e o menu troca
 * para o layout compacto: um seletor de grupo numa linha só, lista embaixo.
 */
export const COMPACT_BELOW_COLS = 58;

const MAX_COMPACT_WIDTH = 54;
const MAX_WIDTH = 76;
const MAX_HEIGHT = 34;
const MIN_WIDTH = 30;
const MIN_HEIGHT = 12;
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
  /**
   * Grupos num seletor de uma linha (`◄ Grupo ►`) em vez de coluna lateral.
   * Só o menu de pausa em grade estreita; o painel do editor nunca tem grupos.
   */
  compact: boolean;
}

/**
 * O layout é calculado uma vez e usado pelo desenho e pelo mouse.
 *
 * Duas contas separadas para "onde a linha está" e "onde o clique caiu"
 * divergiriam no primeiro ajuste de largura, e o menu passaria a responder uma
 * linha acima do que mostra.
 */
export const computeLayout = (viewport: UiViewport): MenuLayout => {
  if (viewport.colCount < COMPACT_BELOW_COLS) return computeCompactLayout(viewport);

  // A grade de UI tem célula de tamanho fixo, então os tetos em células já são
  // tamanho físico constante — não há mais o que compensar do Render Scale.
  const width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, viewport.colCount - 4));
  const height = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, viewport.rowCount - 2));
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
    compact: false,
  };
};

/**
 * A mesma caixa com os grupos numa linha só, no topo, e a lista ocupando a
 * largura inteira. A trilha do slider aceita ficar mais curta que no layout
 * largo — é o que deixa um iframe de celular usar o menu, mesmo apertado.
 */
const computeCompactLayout = (viewport: UiViewport): MenuLayout => {
  const width = Math.min(MAX_COMPACT_WIDTH, Math.max(2, viewport.colCount - 2));
  const height = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, viewport.rowCount - 2));
  const col = Math.floor((viewport.colCount - width) / 2);
  const row = Math.floor((viewport.rowCount - height) / 2);

  const itemCol = col + 2;
  const itemWidth = width - 4;

  return {
    col,
    row,
    width,
    height,
    groupCol: col,
    groupFirstRow: row + 1,
    itemCol,
    itemWidth,
    itemFirstRow: row + 3,
    // Título, borda, seletor, régua, ajuda e a borda de baixo saem da área útil.
    visibleRows: Math.max(1, height - 5),
    trackCol: itemCol + LABEL_WIDTH + 1,
    trackWidth: Math.max(4, itemWidth - LABEL_WIDTH - VALUE_WIDTH - 4),
    compact: true,
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
  viewport: UiViewport,
  itemCount: number,
): MenuLayout => {
  const width = Math.min(PANEL_WIDTH, Math.max(24, viewport.colCount - 2));
  // Título, moldura e uma linha de folga; o resto é lista.
  const height = Math.min(viewport.rowCount - 2, itemCount + 4);
  const col = viewport.colCount - width - 1;
  const row = 1;

  const itemCol = col + 2;
  // -4 e não -3: a mesma folga de uma coluna antes da borda que o menu de
  // pausa usa, para a seta de rolagem (`drawItems`, `itemCol + itemWidth`)
  // não cair em cima do próprio traço da moldura.
  const itemWidth = width - 4;

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
    compact: false,
  };
};

/**
 * O painel lateral: mesma lista de itens do menu de pausa, com foco por
 * teclado sempre visível — não há coluna de grupos disputando o teclado, ao
 * contrário do menu, então o item focado é sempre o realce certo.
 */
export const drawPanel = (
  framebuffer: Framebuffer,
  layout: MenuLayout,
  items: readonly MenuItem[],
  itemIndex: number,
  scroll: number,
  hoverItem: number,
): void => {
  const { col, row, width, height } = layout;

  // Tudo o que o painel escreve sai opaco: ver `Framebuffer.opaqueOverlay`.
  framebuffer.opaqueOverlay = true;
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

  drawItems(framebuffer, layout, {
    items,
    itemIndex,
    scroll,
    hoverItem,
    focusRing: true,
  });
  framebuffer.opaqueOverlay = false;
};

const plot = (
  framebuffer: Framebuffer,
  col: number,
  row: number,
  glyph: number,
  color: Rgb,
  emissive = 0,
): void => framebuffer.plot(col, row, glyph, color, OVERLAY_DEPTH, 1, emissive);

/**
 * O que `drawItems` precisa para desenhar a lista de itens sozinha — o mesmo
 * formato usado pelo menu de pausa (dentro de `DrawState`) e pelo painel
 * lateral do editor (`drawPanel`), para os dois desenharem a lista com a
 * mesma função, e não duas quase iguais.
 */
export interface ItemsState {
  items: readonly MenuItem[];
  itemIndex: number;
  scroll: number;
  hoverItem: number;
  /** Mostra o item focado com seta e realce. Falso quando o teclado está
   * atendendo outra coisa (grupos do menu de pausa). */
  focusRing: boolean;
}

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

  // Tudo o que o menu escreve sai opaco: ver `Framebuffer.opaqueOverlay`.
  framebuffer.opaqueOverlay = true;
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

  if (layout.compact) {
    drawGroupSwitcher(framebuffer, layout, state);
  } else {
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
  }

  drawItems(framebuffer, layout, {
    items: state.items,
    itemIndex: state.itemIndex,
    scroll: state.scroll,
    hoverItem: state.hoverItem,
    focusRing: !state.onGroups,
  });

  const hint = layout.compact
    ? state.onGroups
      ? "◄► group   ▼ select   Esc close"
      : "▲▼ item  ◄► adjust  Tab back  Esc close"
    : state.onGroups
      ? "▲▼ group   ► select   Esc close"
      : "▲▼ item   ◄► adjust   Enter apply   Tab go back   Esc close";
  drawText(
    framebuffer,
    col + 2,
    row + height - 2,
    hint.slice(0, width - 4),
    MENU_COLORS.DIM,
  );
  framebuffer.opaqueOverlay = false;
};

/**
 * O seletor de grupo do layout compacto: `◄ Nome ►`, centrado, com a régua
 * horizontal embaixo emendando nas duas bordas.
 */
const drawGroupSwitcher = (
  framebuffer: Framebuffer,
  layout: MenuLayout,
  state: DrawState,
): void => {
  const { col, row, width } = layout;
  const y = layout.groupFirstRow;
  const color = state.onGroups ? MENU_COLORS.FOCUS : MENU_COLORS.VALUE;
  const label = state.groups[state.groupIndex]?.label ?? "";

  plot(framebuffer, col + 2, y, GLYPH.ARROW_LEFT, color, state.onGroups ? 0.3 : 0);
  plot(framebuffer, col + width - 3, y, GLYPH.ARROW_RIGHT, color, state.onGroups ? 0.3 : 0);
  drawText(
    framebuffer,
    col + Math.floor((width - label.length) / 2),
    y,
    label,
    color,
    1,
    state.onGroups ? 0.3 : 0,
  );

  plot(framebuffer, col, row + 2, GLYPH.BOX_VR, MENU_COLORS.BORDER);
  for (let x = col + 1; x < col + width - 1; x += 1) {
    plot(framebuffer, x, row + 2, GLYPH.BOX_H, MENU_COLORS.BORDER);
  }
  plot(framebuffer, col + width - 1, row + 2, GLYPH.BOX_VL, MENU_COLORS.BORDER);
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

export const drawItems = (
  framebuffer: Framebuffer,
  layout: MenuLayout,
  state: ItemsState,
): void => {
  const end = Math.min(state.items.length, state.scroll + layout.visibleRows);

  for (let index = state.scroll; index < end; index += 1) {
    const item = state.items[index]!;
    const y = layout.itemFirstRow + (index - state.scroll);
    const focused = index === state.itemIndex && state.focusRing;
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
  const { itemCol, itemWidth, trackCol, trackWidth } = layout;
  const emissive = focused ? 0.45 : 0;

  if (item.kind === "heading") {
    drawText(
      framebuffer,
      itemCol,
      y,
      item.label.slice(0, itemWidth),
      MENU_COLORS.HEADING,
      0.85,
    );
    return;
  }

  if (item.kind === "spacer") return;

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
        item.label.slice(0, Math.max(0, itemWidth - 4)),
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
        `» ${item.label}`.slice(0, itemWidth),
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
        item.label.slice(0, Math.max(0, itemWidth - 4)),
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
