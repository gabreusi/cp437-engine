import type { Input, UiEvents } from "../../core/input";
import type { LightWorld } from "../../light/world";
import type { Camera } from "../../render/camera";
import type { Framebuffer } from "../../render/framebuffer";
import type { Rasterizer } from "../../render/rasterizer";
import type { Viewport } from "../../render/viewport";
import type { World } from "../../scene/world";
import type { Cursor } from "../cursor";
import type { Manipulator } from "../manipulator";
import { type MenuLayout, computeLayout, drawMenu } from "./draw";
import { ItemList } from "./item-list";
import type { MenuGroup } from "./model";

/**
 * O menu de pausa da engine.
 *
 * Substitui o painel em DOM, e a troca não é estética. O painel vivia fora da
 * cena: tinha folha de estilo própria, era um segundo lugar onde a paleta
 * morava, e ficava sobre o canvas sem pertencer a ele. Este é desenhado na
 * mesma grade de caracteres, passa pelo mesmo bloom e pelas mesmas scanlines, e
 * some da existência quando fechado.
 *
 * `Esc` abre, porque `Esc` já era o que devolvia o ponteiro — o navegador impõe
 * isso, e é exatamente o gesto de pausar.
 *
 * Quem aponta é o cursor da engine, o mesmo do modo de edição, e não a seta do
 * sistema: o menu é desenhado na grade, e um ponteiro que não é da grade cai
 * entre duas células e não diz em qual delas vai clicar. O ponteiro do sistema
 * fica escondido enquanto o menu estiver aberto, porque dois cursores na tela é
 * pior do que nenhum.
 */

/** Nome do grupo que liga o modo de edição. Ligar por nome mantém o resto burro. */
const EDIT_GROUP = "Objects";

export class Menu {
  open = false;

  private groupIndex = 0;
  private onGroups = true;

  private readonly itemList = new ItemList();
  private layout: MenuLayout | null = null;

  /** Onde o ponteiro estava, em células, para as setas saberem quem realçar. */
  private hoverCol = -1;
  private hoverRow = -1;

  constructor(
    private readonly groups: readonly MenuGroup[],
    private readonly world: World,
    private readonly input: Input,
    private readonly manipulator: Manipulator,
    private readonly cursor: Cursor,
  ) {}

  /**
   * O menu está na página de objetos.
   *
   * Público porque quem decide se a cena mostra realce de seleção é a engine,
   * e ela tem dois candidatos: este grupo e o modo de edição do editor.
   */
  get editing(): boolean {
    return this.open && this.groups[this.groupIndex]?.label === EDIT_GROUP;
  }

  update(
    events: UiEvents,
    viewport: Viewport,
    camera: Camera,
    rasterizer: Rasterizer,
    lights: LightWorld,
  ): void {
    // Sair da captura do ponteiro abre o menu: é o mesmo gesto de pausa, e
    // ficar com o mouse solto e sem menu não serve para nada. Vem por aqui
    // e não pela tecla porque o navegador consome o `Esc` do Pointer Lock.
    if (events.unlocked) this.setOpen(true);

    for (const code of events.keys) {
      if (code === "Escape") this.setOpen(!this.open);
    }

    if (!this.open) {
      this.itemList.release();
      // O manipulador é compartilhado com o editor, que continua
      // trabalhando com o menu fechado: soltá-lo aqui, todo quadro,
      // cancelaria o arrasto de quem está com o objeto na mão. Quem abre
      // o menu já solta em `setOpen`, que é onde a posse muda de fato.
      return;
    }

    this.itemList.setItems(this.groups[this.groupIndex]?.items() ?? []);
    this.layout = computeLayout(viewport);
    this.manipulator.update(
      this.editing ? this.world.selected : null,
      camera,
      rasterizer,
    );

    this.handlePointer(events, viewport, camera, rasterizer, lights);
    this.handleKeys(events);
    this.itemList.clampFocus(this.layout.visibleRows);
  }

  private setOpen(open: boolean): void {
    this.open = open;
    // Com o menu aberto, clicar opera o menu; sem isto o primeiro clique
    // capturaria o ponteiro e o menu ficaria inalcançável.
    this.input.captureOnClick = !open;
    this.input.hideSystemPointer(open);
    if (open) {
      this.input.release();
      this.itemList.ensureFocusable(1);
    } else {
      this.itemList.release();
      this.manipulator.release();
    }
  }

  // ---------------------------------------------------------------- teclado

  private handleKeys(events: UiEvents): void {
    for (const code of events.keys) {
      if (code === "Escape") continue;

      if (this.onGroups) {
        this.handleGroupKey(code);
        continue;
      }

      if (!this.itemList.handleKeyCode(code, events.shift, () => this.refreshItems())) {
        this.onGroups = true;
        continue;
      }

      if (
        (code === "Delete" || code === "Backspace") &&
        this.editing &&
        this.world.selectedId !== null
      ) {
        this.world.remove(this.world.selectedId);
      }
    }
  }

  private handleGroupKey(code: string): void {
    switch (code) {
      case "ArrowUp":
        this.groupIndex =
          (this.groupIndex + this.groups.length - 1) % this.groups.length;
        this.resetItems();
        break;
      case "ArrowDown":
        this.groupIndex = (this.groupIndex + 1) % this.groups.length;
        this.resetItems();
        break;
      case "ArrowRight":
      case "Enter":
      case "Tab":
        this.onGroups = false;
        this.itemList.ensureFocusable(1);
        break;
    }
  }

  private resetItems(): void {
    this.itemList.setItems(this.groups[this.groupIndex]?.items() ?? []);
    this.itemList.resetFocus(1);
  }

  /** A ação pode ter criado ou apagado um objeto: a lista do grupo mudou. */
  private refreshItems(): void {
    this.itemList.setItems(this.groups[this.groupIndex]?.items() ?? []);
    this.itemList.clampFocus(this.layout?.visibleRows ?? 0);
  }

  // ------------------------------------------------------------------ mouse

  private handlePointer(
    events: UiEvents,
    viewport: Viewport,
    camera: Camera,
    rasterizer: Rasterizer,
    lights: LightWorld,
  ): void {
    const layout = this.layout;
    if (layout === null) return;

    const col = this.cursor.col;
    const rowIndex = this.cursor.row;

    if (!events.down) {
      this.itemList.release();
      this.manipulator.release();
    }

    // Um slider agarrado continua respondendo à coluna do cursor sozinha,
    // não importa a linha: exigir a linha certa é o que fazia o arrasto
    // lateral "travar" ao menor tremor vertical do mouse.
    if (events.down && this.itemList.continueDrag(this.cursor.exactCol, layout)) {
      return;
    }

    const insideBox =
      col >= layout.col &&
      col < layout.col + layout.width &&
      rowIndex >= layout.row &&
      rowIndex < layout.row + layout.height;

    if (insideBox) {
      this.handleMenuPointer(events, layout, col, rowIndex);
      return;
    }

    this.itemList.hoverItem = -1;
    this.hoverCol = -1;
    this.hoverRow = -1;
    if (this.editing) {
      this.handleScenePointer(
        events,
        viewport,
        col,
        rowIndex,
        camera,
        rasterizer,
        lights,
      );
    }
  }

  private handleMenuPointer(
    events: UiEvents,
    layout: MenuLayout,
    col: number,
    row: number,
  ): void {
    // Coluna dos grupos.
    if (col <= layout.col + layout.width - layout.itemWidth - 3) {
      const index = row - layout.groupFirstRow;
      this.itemList.hoverItem = -1;
      if (events.pressed && index >= 0 && index < this.groups.length) {
        this.groupIndex = index;
        this.onGroups = true;
        this.resetItems();
      }
      return;
    }

    const focused = this.itemList.handlePointer(
      events,
      layout,
      col,
      this.cursor.exactCol,
      row,
      () => this.refreshItems(),
    );
    if (focused) this.onGroups = false;
  }

  /**
   * Clique e arrasto na cena, com o menu de objetos aberto.
   *
   * Só traduz o ponteiro do sistema para células e entrega ao manipulador: o
   * gesto é o mesmo do editor, e é lá que ele mora inteiro.
   */
  private handleScenePointer(
    events: UiEvents,
    viewport: Viewport,
    col: number,
    row: number,
    camera: Camera,
    rasterizer: Rasterizer,
    lights: LightWorld,
  ): void {
    this.hoverCol = col;
    this.hoverRow = row;

    // A célula inteira serve para saber onde desenhar a alça (`hoverCol`
    // acima); mirar e arrastar usam a posição exata, ou o objeto andaria
    // aos saltos de uma célula toda vez que o mouse cruzasse a borda dela.
    const exactCol = this.cursor.exactCol;
    const exactRow = this.cursor.exactRow;

    if (events.pressed) {
      this.manipulator.press(
        this.world,
        lights,
        camera,
        rasterizer,
        exactCol,
        exactRow,
      );
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
      exactCol,
      exactRow,
      events.deltaX / viewport.cellWidth,
      events.deltaY / viewport.cellHeight,
      events.shift,
    );
  }

  draw(framebuffer: Framebuffer, rasterizer: Rasterizer): void {
    const layout = this.layout;
    if (!this.open || layout === null) return;

    // As setas de face saem antes do painel: se o objeto estiver atrás do
    // menu, quem manda é o menu.
    if (this.editing)
      this.manipulator.draw(
        framebuffer,
        rasterizer,
        this.hoverCol,
        this.hoverRow,
      );

    drawMenu(framebuffer, layout, {
      groups: this.groups,
      items: this.itemList.current,
      groupIndex: this.groupIndex,
      itemIndex: this.itemList.itemIndex,
      scroll: this.itemList.scroll,
      onGroups: this.onGroups,
      hoverItem: this.itemList.hoverItem,
    });
  }
}
