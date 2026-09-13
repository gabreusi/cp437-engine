import { shadeOccluders, type ShadeOptions } from "../light/shade";
import { addMirrorBounceLights } from "../light/mirror-bounce";
import type { LightWorld } from "../light/world";
import type { Camera } from "../render/camera";
import type { Rasterizer } from "../render/rasterizer";
import type { Viewport } from "../render/viewport";

/** Tudo que um objeto precisa para se desenhar. */
export interface RenderContext {
  camera: Camera;
  viewport: Viewport;
  rasterizer: Rasterizer;
  /** Milissegundos desde o início, para animação. */
  time: number;
  /** As luzes e os corpos do quadro, já coletados. */
  lights: LightWorld;
  shading: ShadeOptions;
}

/**
 * Qualquer coisa que emite primitivas em coordenadas de mundo.
 *
 * É a costura para o jogo: hoje são chão, céu, sol e os objetos da cena;
 * amanhã um carro e obstáculos entram pela mesma porta, sem a engine saber o
 * que são.
 */
export interface Renderable {
  render(context: RenderContext): void;

  /**
   * Registra luzes e corpos, antes de qualquer desenho.
   *
   * Existe como fase separada porque iluminação não respeita ordem de
   * desenho: o chão precisa saber do orbe que ainda não foi desenhado, e do
   * monólito atrás da câmera que projeta sombra na frente dela. Fazer isso
   * durante o render amarraria a luz à ordem da lista, e a sombra apareceria
   * ou sumiria conforme alguém reordenasse a cena.
   */
  contribute?(context: RenderContext): void;

  /**
   * Incidência de luz sobre o que já foi desenhado — feixe de holofote,
   * poeira, qualquer coisa que não tenha superfície própria (ver
   * `Fragment.fuse`).
   *
   * Fase separada de `render` pelo mesmo motivo que `contribute` é separada
   * dele: um fragmento com `fuse` só tinge corretamente quem já está na
   * célula, e a ordem de `renderables`/`entities` é a ordem em que o objeto
   * foi criado, não uma ordem "sólido antes de luz". Rodar depois que todo
   * `render` do quadro terminou garante isso sem depender de ordem nenhuma.
   */
  renderGlow?(context: RenderContext): void;
}

export class Scene {
  readonly renderables: Renderable[] = [];

  add(renderable: Renderable): void {
    this.renderables.push(renderable);
  }

  /** Primeira passada: quem ilumina e quem bloqueia luz se anuncia. */
  contribute(context: RenderContext): void {
    for (const renderable of this.renderables) {
      renderable.contribute?.(context);
    }
    // Só agora todo occluder do quadro tem `half`/`center` definitivos —
    // é a hora de pré-calcular o que `trace.ts` usa para descartar barato.
    context.lights.finalize();
    // E só agora toda luz e todo occluder do quadro estão completos — é a
    // hora de calcular o que um raio de espelho vê de cada corpo.
    shadeOccluders(context.lights);
    // E só agora existe uma lista de luzes "de verdade" para espelhar — o
    // espelho vira fonte secundária depois, nunca antes (ver
    // `light/mirror-bounce.ts`).
    addMirrorBounceLights(context.lights);
  }

  render(context: RenderContext): void {
    for (const renderable of this.renderables) {
      renderable.render(context);
    }
    // Só agora toda superfície do quadro está na grade — é a hora de tingir
    // por cima, não de desenhar corpo (ver `Renderable.renderGlow`).
    for (const renderable of this.renderables) {
      renderable.renderGlow?.(context);
    }
  }
}
