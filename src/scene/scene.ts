import type { Camera } from '../render/camera';
import type { Rasterizer } from '../render/rasterizer';
import type { Viewport } from '../render/viewport';

/** Tudo que um objeto precisa para se desenhar. */
export interface RenderContext {
    camera: Camera;
    viewport: Viewport;
    rasterizer: Rasterizer;
    /** Milissegundos desde o início, para animação. */
    time: number;
}

/**
 * Qualquer coisa que emite primitivas em coordenadas de mundo.
 *
 * É a costura para o jogo: hoje são chão, céu e sol; amanhã um carro e
 * obstáculos entram pela mesma porta, sem a engine saber o que são.
 */
export interface Renderable {
    render(context: RenderContext): void;
}

export class Scene {
    readonly renderables: Renderable[] = [];

    add(renderable: Renderable): void {
        this.renderables.push(renderable);
    }

    render(context: RenderContext): void {
        for (const renderable of this.renderables) {
            renderable.render(context);
        }
    }
}
