import type { ShadeOptions } from '../light/shade';
import type { LightWorld } from '../light/world';
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
    }

    render(context: RenderContext): void {
        for (const renderable of this.renderables) {
            renderable.render(context);
        }
    }
}
