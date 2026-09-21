import type {Input, UiEvents} from "../core/input";
import type {Framebuffer} from "../render/framebuffer";
import {GLYPH} from "../render/palette";
import {OVERLAY_DEPTH} from "../render/text";
import type {UiViewport} from "../render/ui-viewport";
import type {Viewport} from "../render/viewport";
import {MENU_COLORS} from "./menu/draw";
import {clamp} from "../math/clamp";

/**
 * O ponteiro da engine, desenhado na própria grade de caracteres.
 *
 * Existe pelo mesmo motivo que o menu deixou de ser DOM: o retículo é escrito
 * no framebuffer, então passa pelo bloom e pelas scanlines como o resto da cena,
 * em vez de flutuar por cima dela sem pertencer a ela. É o único ponteiro que a
 * engine mostra — o do sistema fica escondido enquanto ele estiver em uso.
 *
 * Ele se alimenta de duas fontes, e a escolha entre elas não é preferência: é o
 * que o navegador permite. Com o ponteiro capturado não existe posição
 * absoluta, só movimento relativo, e o cursor integra esse movimento. Solto, a
 * posição absoluta existe e é ela que manda — integrar deltas nesse caso
 * deixaria o retículo escorregar em relação ao ponteiro de verdade, e um clique
 * cairia num lugar diferente do que a tela mostra.
 */

const ARM_COLS = 1;

export class Cursor {
  // Em pixels CSS dentro do canvas, e fracionário: o mouse anda em pixels, e
  // arredondar a cada quadro perderia o movimento lento. Pixel é a unidade
  // comum porque o cursor vive em duas grades — a da cena (mira em objetos) e
  // a da interface (widgets), com células de tamanhos bem diferentes — e a
  // posição do ponteiro não pode depender de qual delas está olhando.
  private x = 0;
  private y = 0;

  private sceneX = 0;
  private sceneY = 0;
  private uiX = 0;
  private uiY = 0;

  private readonly point = { x: 0, y: 0 };

  /** A célula da **cena** sob o cursor. */
  get sceneCol(): number {
    return Math.floor(this.sceneX);
  }

  get sceneRow(): number {
    return Math.floor(this.sceneY);
  }

  /**
   * A posição exata, fracionária, em células da cena.
   *
   * Quem só precisa saber qual célula está sob o cursor usa `sceneCol`; quem
   * mira ou arrasta um objeto usa esta — arredondar antes de mirar é o que
   * fazia o objeto andar aos saltos de uma célula inteira em vez de seguir o
   * mouse.
   */
  get sceneExactCol(): number {
    return this.sceneX;
  }

  get sceneExactRow(): number {
    return this.sceneY;
  }

  /** A célula da **interface** sob o cursor: menu, painel, sliders. */
  get uiCol(): number {
    return Math.floor(this.uiX);
  }

  get uiRow(): number {
    return Math.floor(this.uiY);
  }

  /** Exata, para puxar um slider — mesmo motivo de `sceneExactCol`. */
  get uiExactCol(): number {
    return this.uiX;
  }

  get uiExactRow(): number {
    return this.uiY;
  }

  /** Onde quem estava voando estava olhando. É onde o modo de edição começa. */
  center(viewport: Viewport): void {
    this.x = viewport.cssWidth / 2;
    this.y = viewport.cssHeight / 2;
  }

  /**
   * Uma vez por quadro, antes de qualquer um que leia a posição.
   *
   * Sob captura, um pixel de mouse move um pixel de cursor, seja qual for o
   * tamanho da célula: é o que mantém o ganho igual ao de um ponteiro de
   * sistema, em vez de o cursor ficar lento em tela grande — onde a célula é
   * maior — e nervoso em tela pequena.
   */
  update(
    input: Input,
    events: UiEvents,
    viewport: Viewport,
    ui: UiViewport,
  ): void {
    if (input.isLocked) {
      this.x += events.deltaX;
      this.y += events.deltaY;
    } else {
      input.canvasPoint(this.point);
      this.x = this.point.x;
      this.y = this.point.y;
    }

    this.x = clamp(this.x, 0, viewport.cssWidth);
    this.y = clamp(this.y, 0, viewport.cssHeight);

    this.sceneX = clamp(this.x / viewport.cellWidth, 0, viewport.colCount - 1);
    this.sceneY = clamp(this.y / viewport.cellHeight, 0, viewport.rowCount - 1);
    this.uiX = clamp((this.x - ui.offsetX) / ui.cellWidth, 0, ui.colCount - 1);
    this.uiY = clamp((this.y - ui.offsetY) / ui.cellHeight, 0, ui.rowCount - 1);
  }

  /**
   * O retículo.
   *
   * Um `┼` sozinho some numa grade que já é feita de linhas, então os braços
   * ficam afastados: o vão em volta do centro é o que o olho encontra. As
   * distâncias são diferentes nos dois eixos porque a célula é 1:2 e um
   * retículo simétrico em células sairia achatado na tela.
   *
   * O centro mora na célula mais próxima da posição exata, não na célula
   * arredondada para baixo. Desenhado na grade da interface: o retículo é
   * parte dela, e numa célula de cena de 6 px ele seria um risco ilegível.
   */
  draw(framebuffer: Framebuffer): void {
    const nearCol = Math.round(this.uiX);
    const nearRow = Math.round(this.uiY);

    const plot = (
      x: number,
      y: number,
      glyph: number,
      emissive: number,
    ): void =>
      framebuffer.plot(
        x,
        y,
        glyph,
        MENU_COLORS.FOCUS,
        OVERLAY_DEPTH,
        1,
        emissive,
      );

    plot(nearCol, nearRow, GLYPH.BOX_CROSS, 0.9);
    plot(nearCol - ARM_COLS, nearRow, GLYPH.BRACKET_LEFT, 0.3);
    plot(nearCol + ARM_COLS, nearRow, GLYPH.BRACKET_RIGHT, 0.3);
  }
}
