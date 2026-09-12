import type { Input, UiEvents } from "../core/input";
import type { LightWorld } from "../light/world";
import type { Camera } from "../render/camera";
import type { Framebuffer } from "../render/framebuffer";
import type { Rasterizer } from "../render/rasterizer";
import { drawText } from "../render/text";
import type { Viewport } from "../render/viewport";
import type { World } from "../scene/world";
import type { Cursor } from "./cursor";
import type { Manipulator } from "./manipulator";
import {
  type MenuLayout,
  MENU_COLORS,
  computePanelLayout,
  drawPanel,
} from "./menu/draw";
import {
  type MenuItem,
  adjustItem,
  clampToRange,
  isFocusable,
} from "./menu/model";
import { buildEntityItems } from "./menu/schema";

/**
 * O modo de edição, com o mouse ainda capturado.
 *
 * O menu de pausa resolvia a edição pelo caminho do navegador: `Esc` solta o
 * ponteiro, o menu abre, e a cena é operada com o cursor do sistema por cima
 * dela. Funciona, e cobra caro — para mover um objeto é preciso sair do voo,
 * atravessar um menu de oito grupos e voltar, e o painel tapa justamente o que
 * se está editando.
 *
 * Aqui a captura nunca é solta. O mouse deixa de girar a câmera e passa a mover
 * um cursor desenhado na grade de caracteres, que seleciona, arrasta e estica; o
 * teclado continua voando. As propriedades do objeto escolhido abrem num painel
 * encostado na lateral, longe do meio da tela, e somem com a seleção.
 *
 * Segurar o botão direito devolve o olhar ao mouse sem sair do modo: mirar a
 * câmera é metade de posicionar um objeto, e obrigar a trocar de modo para cada
 * olhada seria reconstruir, por dentro, o vaivém que o modo veio eliminar.
 */

/** Tecla que entra e sai do modo de edição. */
const TOGGLE_KEY = "Tab";

export class Editor {
  /** O modo de edição está ligado. Quem desenha a seleção consulta isto. */
  active = false;

  private items: MenuItem[] = [];
  private layout: MenuLayout | null = null;
  private scroll = 0;
  private hoverItem = -1;
  private draggingSlider = -1;

  constructor(
    private readonly world: World,
    private readonly input: Input,
    private readonly manipulator: Manipulator,
    private readonly cursor: Cursor,
  ) {}

  private get col(): number {
    return this.cursor.col;
  }

  private get row(): number {
    return this.cursor.row;
  }

  /** Posição exata do cursor, para mira e slider — ver `Cursor.exactCol`. */
  private get exactCol(): number {
    return this.cursor.exactCol;
  }

  private get exactRow(): number {
    return this.cursor.exactRow;
  }

  update(
    events: UiEvents,
    viewport: Viewport,
    camera: Camera,
    rasterizer: Rasterizer,
    lights: LightWorld,
    menuOpen: boolean,
  ): void {
    // O menu de pausa e o editor disputam o mesmo clique e o mesmo objeto
    // selecionado. Abrir o menu — ou perder a captura por qualquer via —
    // desliga o editor, em vez de deixar os dois respondendo.
    if (menuOpen || !this.input.isLocked) {
      this.setActive(false);
      return;
    }

    for (const code of events.keys) {
      if (code === TOGGLE_KEY) this.setActive(!this.active, viewport);
      if (!this.active) continue;
      if (
        (code === "Delete" || code === "Backspace") &&
        this.world.selectedId !== null
      ) {
        this.world.remove(this.world.selectedId);
      }
    }

    if (!this.active) return;

    const selected = this.world.selected;
    this.items =
      selected === null ? [] : buildEntityItems(this.world, selected);
    this.layout =
      this.items.length === 0
        ? null
        : computePanelLayout(viewport, this.items.length);
    this.manipulator.update(selected, camera, rasterizer);

    if (!events.down) {
      this.draggingSlider = -1;
      this.manipulator.release();
    }

    const layout = this.layout;
    const insidePanel =
      layout !== null &&
      this.col >= layout.col &&
      this.col < layout.col + layout.width &&
      this.row >= layout.row &&
      this.row < layout.row + layout.height;

    if (insidePanel) {
      this.handlePanel(events, layout);
      this.handlePanelKeys(events);
      return;
    }

    this.hoverItem = -1;
    this.handleScene(events, viewport, camera, rasterizer, lights);
  }

  private setActive(active: boolean, viewport?: Viewport): void {
    if (active === this.active) return;

    this.active = active;
    // A partir daqui o movimento do mouse é do cursor, não da câmera.
    this.input.cursorMode = active;

    // Sob captura não há posição de ponteiro para herdar: o retículo nasce
    // no centro da tela, que é para onde quem estava voando estava olhando.
    if (active && viewport !== undefined) this.cursor.center(viewport);

    if (!active) {
      this.draggingSlider = -1;
      this.hoverItem = -1;
      this.manipulator.release();
    }
  }

  /** Cursor sobre o painel lateral: os mesmos widgets do menu, no clique. */
  private handlePanel(events: UiEvents, layout: MenuLayout): void {
    const index = this.scroll + (this.row - layout.itemFirstRow);
    const item = this.items[index];
    this.hoverItem = item !== undefined && isFocusable(item) ? index : -1;

    if (events.wheel !== 0) {
      const maxScroll = Math.max(0, this.items.length - layout.visibleRows);
      this.scroll = clamp(this.scroll + events.wheel, 0, maxScroll);
      return;
    }

    if (item === undefined || !isFocusable(item)) return;

    const onTrack = item.kind === "slider" && this.col >= layout.trackCol - 1;

    if (events.pressed) {
      if (onTrack) {
        this.draggingSlider = index;
      } else if (item.kind !== "slider") {
        this.activate(item);
      }
    }

    // Clicar num ponto da trilha significa "vá para cá", sem exigir arrasto:
    // é a mesma regra do menu, e vale porque é o mesmo widget.
    if (
      item.kind === "slider" &&
      onTrack &&
      (events.pressed || this.draggingSlider === index)
    ) {
      const ratio =
        (this.exactCol - layout.trackCol) / Math.max(1, layout.trackWidth - 1);
      item.set(
        clampToRange(
          item.min + clamp(ratio, 0, 1) * (item.max - item.min),
          item,
        ),
      );
    }
  }

  /**
   * As setas ajustam o item sob o cursor, sem exigir arrasto — a mesma
   * `adjustItem` que o menu de pausa usa nas suas, ver `model.ts`. Faltava
   * aqui: o painel do editor só respondia ao clique na trilha, e ela é larga
   * demais em cliques (poucas colunas) para posicionar um objeto com cuidado.
   */
  private handlePanelKeys(events: UiEvents): void {
    const item = this.items[this.hoverItem];
    if (item === undefined) return;

    for (const code of events.keys) {
      if (code === "ArrowLeft") adjustItem(item, -1, events.shift);
      if (code === "ArrowRight") adjustItem(item, 1, events.shift);
    }
  }

  private activate(item: MenuItem): void {
    switch (item.kind) {
      case "toggle":
        item.set(!item.get());
        return;
      case "choice":
        adjustItem(item, 1);
        return;
      case "action":
        item.run();
        return;
      case "entity":
        item.select();
        return;
    }
  }

  /** Cursor sobre a cena: é o manipulador que responde, como no menu. */
  private handleScene(
    events: UiEvents,
    viewport: Viewport,
    camera: Camera,
    rasterizer: Rasterizer,
    lights: LightWorld,
  ): void {
    if (events.pressed) {
      this.manipulator.press(
        this.world,
        lights,
        camera,
        rasterizer,
        this.exactCol,
        this.exactRow,
      );
      this.scroll = 0;
      return;
    }

    const selected = this.world.selected;
    if (selected === null) return;

    if (events.wheel !== 0 && !this.manipulator.resizing) {
      this.manipulator.rotate(selected, events.wheel);
      return;
    }

    if (!events.down) return;

    this.manipulator.drag(
      this.world,
      camera,
      rasterizer,
      this.exactCol,
      this.exactRow,
      events.deltaX / viewport.cellWidth,
      events.deltaY / viewport.cellHeight,
      events.shift,
    );
  }

  draw(framebuffer: Framebuffer, viewport: Viewport): void {
    if (!this.active) return;

    // Setas primeiro, painel por cima: um objeto encostado na lateral não
    // pode furar o painel com as próprias alças.
    this.manipulator.draw(framebuffer, this.col, this.row);

    if (this.layout !== null) {
      drawPanel(
        framebuffer,
        this.layout,
        this.items,
        this.scroll,
        this.hoverItem,
      );
    }

    drawText(
      framebuffer,
      2,
      viewport.rowCount - 2,
      "Tab fly   right button look   click select   wheel turn   panel ◄► adjust   drag arrows to resize   Del remove",
      MENU_COLORS.DIM,
    );
  }
}

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));
