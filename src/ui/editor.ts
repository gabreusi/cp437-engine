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
import { ItemList } from "./menu/item-list";
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

  private readonly itemList = new ItemList();
  private layout: MenuLayout | null = null;
  /** Foco reinicia quando a seleção muda — não faz sentido herdar o índice
   * de um objeto para outro com campos diferentes. */
  private lastSelectedId: number | null = null;

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
    const items = selected === null ? [] : buildEntityItems(this.world, selected);
    this.itemList.setItems(items);
    if ((selected?.id ?? null) !== this.lastSelectedId) {
      this.lastSelectedId = selected?.id ?? null;
      this.itemList.resetFocus();
    }
    this.layout =
      items.length === 0 ? null : computePanelLayout(viewport, items.length);
    this.manipulator.update(selected, camera, rasterizer);

    if (!events.down) {
      this.itemList.release();
      this.manipulator.release();
    }

    const layout = this.layout;
    if (layout !== null) this.itemList.clampFocus(layout.visibleRows);

    // Um slider agarrado continua respondendo à coluna do cursor sozinha,
    // não importa a linha — mesma correção do menu de pausa, mesmo widget.
    if (events.down && layout !== null && this.itemList.continueDrag(this.exactCol, layout)) {
      return;
    }

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

    this.itemList.hoverItem = -1;
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
      this.itemList.release();
      this.itemList.hoverItem = -1;
      this.manipulator.release();
    }
  }

  /** Cursor sobre o painel lateral: os mesmos widgets do menu, no clique. */
  private handlePanel(events: UiEvents, layout: MenuLayout): void {
    this.itemList.handlePointer(events, layout, this.col, this.exactCol, this.row);
  }

  /**
   * Teclado com o painel aberto: seta cima/baixo move o foco, esquerda/direita
   * ajusta, Enter/Espaço ativa — o mesmo `ItemList` do menu de pausa, sem
   * grupo nenhum para devolver o foco.
   */
  private handlePanelKeys(events: UiEvents): void {
    for (const code of events.keys) {
      this.itemList.handleKeyCode(code, events.shift);
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
      // A troca de seleção reinicia o foco/rolagem sozinha, no próximo
      // `update()`, ao notar que `lastSelectedId` mudou.
      return;
    }

    const selected = this.world.selected;
    if (selected === null) return;

    if (events.wheel !== 0 && !this.manipulator.manipulating) {
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

  draw(
    framebuffer: Framebuffer,
    viewport: Viewport,
    rasterizer: Rasterizer,
  ): void {
    if (!this.active) return;

    // Setas primeiro, painel por cima: um objeto encostado na lateral não
    // pode furar o painel com as próprias alças.
    this.manipulator.draw(framebuffer, rasterizer, this.col, this.row);

    if (this.layout !== null) {
      drawPanel(
        framebuffer,
        this.layout,
        this.itemList.current,
        this.itemList.itemIndex,
        this.itemList.scroll,
        this.itemList.hoverItem,
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
