import type { UiEvents } from "../../core/input";
import type { MenuLayout } from "./draw";
import {
  type MenuItem,
  adjustItem,
  choiceArrowDirection,
  isFocusable,
  sliderRatioValue,
} from "./model";

/**
 * A lista de itens: navegação, arrasto e ativação, compartilhados pelo menu
 * de pausa (que soma uma coluna de grupos por cima) e pelo painel lateral do
 * editor (que não tem grupo nenhum). Antes desta classe, os dois reimplementavam
 * a mesma lógica lado a lado — um clique em slider, uma seta de `choice`, o
 * arrasto que continua pela coluna exata do cursor — e cada correção precisava
 * ser feita duas vezes. Aqui é uma só.
 *
 * Quem tem grupos (o menu) trata o retorno de `handleKeyCode` para saber
 * quando devolver o foco a eles; quem não tem (o painel) ignora.
 */
export class ItemList {
  itemIndex = 0;
  scroll = 0;
  hoverItem = -1;
  private draggingSlider = -1;
  private items: readonly MenuItem[] = [];

  get length(): number {
    return this.items.length;
  }

  get current(): readonly MenuItem[] {
    return this.items;
  }

  setItems(items: readonly MenuItem[]): void {
    this.items = items;
  }

  itemAt(index: number): MenuItem | undefined {
    return this.items[index];
  }

  /** Solta o slider arrastado, se houver. Chamar ao ver o botão solto. */
  release(): void {
    this.draggingSlider = -1;
  }

  /**
   * Continuação do arrasto de slider, pela coluna exata do cursor — não
   * importa a linha, para um tremor vertical não travar o arrasto lateral.
   * Devolve `true` quando havia um arrasto em curso (e portanto o chamador
   * deve considerar o ponteiro "consumido" e não seguir para outra coisa).
   */
  continueDrag(exactCol: number, layout: MenuLayout): boolean {
    if (this.draggingSlider < 0) return false;
    const item = this.items[this.draggingSlider];
    if (item !== undefined && item.kind === "slider") {
      item.set(
        sliderRatioValue(item, exactCol, layout.trackCol, layout.trackWidth),
      );
    }
    return true;
  }

  resetFocus(direction = 1): void {
    this.itemIndex = 0;
    this.scroll = 0;
    this.ensureFocusable(direction);
  }

  /** Anda até cair num item que aceita foco. Títulos são pulados. */
  ensureFocusable(direction: number): void {
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

  private moveFocus(direction: number): void {
    this.itemIndex += direction;
    this.ensureFocusable(direction);
  }

  /** Mantém o foco dentro da lista e visível na janela de rolagem. */
  clampFocus(visibleRows: number): void {
    if (this.items.length === 0) {
      this.itemIndex = 0;
      this.scroll = 0;
      return;
    }
    this.itemIndex = Math.max(
      0,
      Math.min(this.items.length - 1, this.itemIndex),
    );

    if (this.itemIndex < this.scroll) this.scroll = this.itemIndex;
    if (this.itemIndex >= this.scroll + visibleRows) {
      this.scroll = this.itemIndex - visibleRows + 1;
    }
    this.scroll = Math.max(
      0,
      Math.min(this.scroll, Math.max(0, this.items.length - visibleRows)),
    );
  }

  activate(item: MenuItem, onAction?: () => void): void {
    switch (item.kind) {
      case "toggle":
        item.set(!item.get());
        return;
      case "choice":
        adjustItem(item, 1);
        return;
      case "action":
        item.run();
        onAction?.();
        return;
      case "entity":
        item.select();
        return;
    }
  }

  /**
   * Uma tecla, uma vez — chamado por código dentro do laço de `events.keys`
   * de quem usa, e não com o array inteiro de uma vez: `Tab`/seta-esquerda
   * sem ajuste devolvem `false` no meio do laço, e o restante dos códigos
   * daquele quadro já precisa ver o novo estado (ex.: o menu de pausa volta
   * a responder pelos grupos a partir do próximo código).
   */
  handleKeyCode(code: string, shift: boolean, onAction?: () => void): boolean {
    const item = this.itemAt(this.itemIndex);

    switch (code) {
      case "ArrowUp":
        this.moveFocus(-1);
        return true;
      case "ArrowDown":
        this.moveFocus(1);
        return true;
      case "Tab":
        return false;
      case "ArrowLeft":
        if (item === undefined || !adjustItem(item, -1, shift)) return false;
        return true;
      case "ArrowRight":
        if (item !== undefined) adjustItem(item, 1, shift);
        return true;
      case "Enter":
      case "Space":
        if (item !== undefined) this.activate(item, onAction);
        return true;
      default:
        return true;
    }
  }

  /**
   * Ponteiro dentro da área de itens: hover, rolagem, clique em seta de
   * `choice`, início de arrasto de slider (já escrevendo no clique, sem
   * exigir arrasto) e ativação de qualquer outro item. Devolve `true` quando
   * um clique focou um item de verdade — o menu de pausa usa isso para saber
   * que deve parar de responder pelos grupos.
   */
  handlePointer(
    events: UiEvents,
    layout: MenuLayout,
    col: number,
    exactCol: number,
    row: number,
    onAction?: () => void,
  ): boolean {
    const index = this.scroll + (row - layout.itemFirstRow);
    const item = this.itemAt(index);
    this.hoverItem = item !== undefined && isFocusable(item) ? index : -1;

    if (events.wheel !== 0) {
      this.scroll = Math.max(
        0,
        Math.min(
          this.scroll + events.wheel,
          Math.max(0, this.items.length - layout.visibleRows),
        ),
      );
      return false;
    }

    if (item === undefined || !isFocusable(item) || !events.pressed) {
      return false;
    }

    this.itemIndex = index;

    const onTrack = item.kind === "slider" && col >= layout.trackCol - 1;
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
      // Clicar num ponto da trilha significa "vá para cá": exigir arrasto
      // faria um clique simples não fazer nada, o defeito mais chato de
      // slider. A continuação do arrasto é `continueDrag`, coluna a coluna.
      item.set(
        sliderRatioValue(item, exactCol, layout.trackCol, layout.trackWidth),
      );
    } else if (item.kind !== "slider") {
      this.activate(item, onAction);
    }
    return true;
  }
}
