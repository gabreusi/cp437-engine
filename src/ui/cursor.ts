import type { Input, UiEvents } from "../core/input";
import type { Framebuffer } from "../render/framebuffer";
import { GLYPH } from "../render/palette";
import { OVERLAY_DEPTH } from "../render/text";
import type { Viewport } from "../render/viewport";
import { MENU_COLORS } from "./menu/draw";
import { clamp } from "../math/clamp";

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
  // Fracionário: o mouse anda em pixels, e arredondar a cada quadro perderia
  // o movimento lento.
  private exactCol = 0;
  private exactRow = 0;

  private readonly point = { x: 0, y: 0 };

  /** A célula sob o cursor. */
  get col(): number {
    return Math.floor(this.exactCol);
  }

  get row(): number {
    return Math.floor(this.exactRow);
  }

  /** Onde quem estava voando estava olhando. É onde o modo de edição começa. */
  center(viewport: Viewport): void {
    this.exactCol = viewport.colCount / 2;
    this.exactRow = viewport.rowCount / 2;
  }

  /**
   * Uma vez por quadro, antes de qualquer um que leia a posição.
   *
   * Sob captura, um pixel de mouse move um pixel de cursor: dividir pelo
   * tamanho da célula é o que mantém o ganho igual ao de um ponteiro de
   * sistema, em vez de o cursor ficar lento em tela grande — onde a célula é
   * maior — e nervoso em tela pequena.
   */
  update(input: Input, events: UiEvents, viewport: Viewport): void {
    if (input.isLocked) {
      this.exactCol += events.deltaX / viewport.cellWidth;
      this.exactRow += events.deltaY / viewport.cellHeight;
    } else {
      input.canvasPoint(this.point);
      this.exactCol = this.point.x / viewport.cellWidth;
      this.exactRow = this.point.y / viewport.cellHeight;
    }

    this.exactCol = clamp(this.exactCol, 0, viewport.colCount - 1);
    this.exactRow = clamp(this.exactRow, 0, viewport.rowCount - 1);
  }

  /**
   * O retículo.
   *
   * Um `┼` sozinho some numa grade que já é feita de linhas, então os braços
   * ficam afastados: o vão em volta do centro é o que o olho encontra. As
   * distâncias são diferentes nos dois eixos porque a célula é 1:2 e um
   * retículo simétrico em células sairia achatado na tela.
   */
  draw(framebuffer: Framebuffer): void {
    const { col, row } = this;
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

    plot(col, row, GLYPH.BOX_CROSS, 0.9);
    plot(col - ARM_COLS, row, GLYPH.BOX_H, 0.3);
    plot(col + ARM_COLS, row, GLYPH.BOX_H, 0.3);
  }
}

