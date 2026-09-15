import type {Input, UiEvents} from "../core/input";
import type {Framebuffer} from "../render/framebuffer";
import {GLYPH} from "../render/palette";
import {OVERLAY_DEPTH} from "../render/text";
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
  // Fracionário: o mouse anda em pixels, e arredondar a cada quadro perderia
  // o movimento lento.
  private preciseCol = 0;
  private preciseRow = 0;

  private readonly point = { x: 0, y: 0 };

  /** A célula sob o cursor. */
  get col(): number {
    return Math.floor(this.preciseCol);
  }

  get row(): number {
    return Math.floor(this.preciseRow);
  }

  /**
   * A posição exata, fracionária, em células de tela.
   *
   * Quem só precisa saber qual célula está sob o cursor usa `col`/`row`; quem
   * mira, arrasta ou puxa um slider usa esta — arredondar antes de mirar é o
   * que fazia o objeto andar aos saltos de uma célula inteira em vez de seguir
   * o mouse.
   */
  get exactCol(): number {
    return this.preciseCol;
  }

  get exactRow(): number {
    return this.preciseRow;
  }

  /** Onde quem estava voando estava olhando. É onde o modo de edição começa. */
  center(viewport: Viewport): void {
    this.preciseCol = viewport.colCount / 2;
    this.preciseRow = viewport.rowCount / 2;
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
      this.preciseCol += events.deltaX / viewport.cellWidth;
      this.preciseRow += events.deltaY / viewport.cellHeight;
    } else {
      input.canvasPoint(this.point);
      this.preciseCol = this.point.x / viewport.cellWidth;
      this.preciseRow = this.point.y / viewport.cellHeight;
    }

    this.preciseCol = clamp(this.preciseCol, 0, viewport.colCount - 1);
    this.preciseRow = clamp(this.preciseRow, 0, viewport.rowCount - 1);
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
   * arredondada para baixo — e o quanto ele sobra dali vira o glifo: perto do
   * meio da célula é a cruz de sempre, perto de uma borda é o meio-bloco que
   * pende para o lado (ou para cima/baixo) de onde a posição de verdade está.
   * Sem isso o retículo pulava célula inteira a cada quadro e escondia o
   * movimento fracionário que `update` já integra.
   */
  draw(framebuffer: Framebuffer): void {
    const nearCol = Math.round(this.preciseCol);
    const nearRow = Math.round(this.preciseRow);

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
