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
import {
  type MenuGroup,
  type MenuItem,
  adjustItem,
  choiceArrowDirection,
  isFocusable,
  sliderRatioValue,
} from "./model";

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
  private itemIndex = 0;
  private scroll = 0;
  private onGroups = true;
  private hoverItem = -1;

  private items: MenuItem[] = [];
  private layout: MenuLayout | null = null;

  /** Índice do slider sendo arrastado, ou -1. */
  private draggingSlider = -1;

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
      this.draggingSlider = -1;
      // O manipulador é compartilhado com o editor, que continua
      // trabalhando com o menu fechado: soltá-lo aqui, todo quadro,
      // cancelaria o arrasto de quem está com o objeto na mão. Quem abre
      // o menu já solta em `setOpen`, que é onde a posse muda de fato.
      return;
    }

    this.items = this.groups[this.groupIndex]?.items() ?? [];
    this.layout = computeLayout(viewport);
    this.manipulator.update(
      this.editing ? this.world.selected : null,
      camera,
      rasterizer,
    );

    this.handlePointer(events, viewport, camera, rasterizer, lights);
    this.handleKeys(events);
    this.clampFocus();
  }

  private setOpen(open: boolean): void {
    this.open = open;
    // Com o menu aberto, clicar opera o menu; sem isto o primeiro clique
    // capturaria o ponteiro e o menu ficaria inalcançável.
    this.input.captureOnClick = !open;
    this.input.hideSystemPointer(open);
    if (open) {
      this.input.release();
      this.ensureFocusable(1);
    } else {
      this.draggingSlider = -1;
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
      this.handleItemKey(code, events.shift);
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
        this.ensureFocusable(1);
        break;
    }
  }

  private handleItemKey(code: string, shift: boolean): void {
    const item = this.items[this.itemIndex];

    switch (code) {
      case "ArrowUp":
        this.moveFocus(-1);
        return;
      case "ArrowDown":
        this.moveFocus(1);
        return;
      case "Tab":
        this.onGroups = true;
        return;
      case "ArrowLeft":
        if (item === undefined || !adjustItem(item, -1, shift))
          this.onGroups = true;
        return;
      case "ArrowRight":
        if (item !== undefined) adjustItem(item, 1, shift);
        return;
      case "Enter":
      case "Space":
        if (item !== undefined) this.activate(item);
        return;
      case "Delete":
      case "Backspace":
        if (this.editing && this.world.selectedId !== null) {
          this.world.remove(this.world.selectedId);
        }
        return;
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
        // A ação pode ter criado ou apagado um objeto: a lista mudou.
        this.items = this.groups[this.groupIndex]?.items() ?? [];
        this.clampFocus();
        return;
      case "entity":
        item.select();
        return;
    }
  }

  private moveFocus(direction: number): void {
    this.itemIndex += direction;
    this.ensureFocusable(direction);
  }

  /** Anda até cair num item que aceita foco. Títulos são pulados. */
  private ensureFocusable(direction: number): void {
    const step = direction >= 0 ? 1 : -1;
    for (let guard = 0; guard <= this.items.length; guard += 1) {
      if (this.itemIndex < 0) {
        this.itemIndex = 0;
        if (this.items.every((item) => !isFocusable(item))) return;
      }
      if (this.itemIndex >= this.items.length) {
        this.itemIndex = this.items.length - 1;
      }

      const item = this.items[this.itemIndex];
      if (item === undefined || isFocusable(item)) return;
      this.itemIndex += step;
    }
  }

  private resetItems(): void {
    this.items = this.groups[this.groupIndex]?.items() ?? [];
    this.itemIndex = 0;
    this.scroll = 0;
    this.ensureFocusable(1);
  }

  /** Mantém o foco dentro da lista e visível na janela de rolagem. */
  private clampFocus(): void {
    if (this.items.length === 0) {
      this.itemIndex = 0;
      this.scroll = 0;
      return;
    }
    this.itemIndex = Math.max(
      0,
      Math.min(this.items.length - 1, this.itemIndex),
    );

    const rows = this.layout?.visibleRows ?? this.items.length;
    if (this.itemIndex < this.scroll) this.scroll = this.itemIndex;
    if (this.itemIndex >= this.scroll + rows)
      this.scroll = this.itemIndex - rows + 1;
    this.scroll = Math.max(
      0,
      Math.min(this.scroll, Math.max(0, this.items.length - rows)),
    );
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
      this.draggingSlider = -1;
      this.manipulator.release();
    }

    // Um slider agarrado continua respondendo à coluna do cursor sozinha,
    // não importa a linha: exigir a linha certa é o que fazia o arrasto
    // lateral "travar" ao menor tremor vertical do mouse.
    if (this.draggingSlider >= 0 && events.down) {
      const item = this.items[this.draggingSlider];
      if (item !== undefined && item.kind === "slider") {
        item.set(
          sliderRatioValue(
            item,
            this.cursor.exactCol,
            layout.trackCol,
            layout.trackWidth,
          ),
        );
      }
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

    this.hoverItem = -1;
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
      this.hoverItem = -1;
      if (events.pressed && index >= 0 && index < this.groups.length) {
        this.groupIndex = index;
        this.onGroups = true;
        this.resetItems();
      }
      return;
    }

    const index = this.scroll + (row - layout.itemFirstRow);
    const item = this.items[index];
    this.hoverItem = item !== undefined && isFocusable(item) ? index : -1;

    if (events.wheel !== 0) {
      this.scroll += events.wheel;
      this.scroll = Math.max(
        0,
        Math.min(
          this.scroll,
          Math.max(0, this.items.length - layout.visibleRows),
        ),
      );
      return;
    }

    if (item === undefined || !isFocusable(item)) return;

    const onTrack = item.kind === "slider" && col >= layout.trackCol - 1;

    if (events.pressed) {
      this.itemIndex = index;
      this.onGroups = false;

      const choiceDir = choiceArrowDirection(
        item,
        col,
        layout.trackCol,
        layout.trackWidth,
      );

      if (choiceDir !== 0) {
        adjustItem(item, choiceDir);
      } else if (onTrack) {
        this.draggingSlider = index;
        // Escrever já no clique, e não só ao arrastar: numa trilha, clicar em
        // um ponto significa "vá para cá". Exigir arrasto faria um clique
        // simples não fazer nada, que é o defeito mais chato de slider. A
        // continuação do arrasto, coluna a coluna, é tratada em
        // `handlePointer` — sem depender de `item`/`index` desta linha.
        item.set(
          sliderRatioValue(
            item,
            this.cursor.exactCol,
            layout.trackCol,
            layout.trackWidth,
          ),
        );
      } else if (item.kind !== "slider") {
        this.activate(item);
      }
    }
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
      items: this.items,
      groupIndex: this.groupIndex,
      itemIndex: this.itemIndex,
      scroll: this.scroll,
      onGroups: this.onGroups,
      hoverItem: this.hoverItem,
    });
  }
}
