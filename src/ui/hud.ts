import type { Camera } from '../render/camera';

/** Constante de suavização do contador de quadros. */
const FPS_SMOOTHING = 0.9;

/** O mesmo alisamento no custo da cena: sem ele o número é ilegível. */
const COST_SMOOTHING = 0.9;

const toDegrees = (radians: number): number => Math.round((radians * 180) / Math.PI);

/**
 * O que a cena custou neste quadro.
 *
 * Iluminação por célula na CPU é a única parte da engine cujo preço depende do
 * que está na cena, e não do tamanho da janela. Sem número, "está rápido" vira
 * opinião — e a queda aparece só quando já está tarde, num objeto a mais.
 */
export interface FrameStats {
    /** Milissegundos gastos coletando luzes e sombreando a cena na CPU. */
    sceneMs: number;
    lights: number;
    occluders: number;
}

/**
 * Leitura de estado da câmera e custo por quadro.
 *
 * Fica em DOM, não no grid: é texto de diagnóstico, não parte da cena, e
 * misturá-lo ao framebuffer atrapalharia justamente quando a cena está errada.
 * É também o que sobra em DOM depois de o painel de ajustes virar menu ASCII.
 */
export class Hud {
    private fps = 60;
    private cost = 0;
    private lastTime = 0;

    constructor(private readonly element: HTMLElement) {}

    update(camera: Camera, time: number, locked: boolean, stats: FrameStats): void {
        if (this.lastTime !== 0) {
            const delta = time - this.lastTime;
            if (delta > 0) {
                this.fps = this.fps * FPS_SMOOTHING + (1000 / delta) * (1 - FPS_SMOOTHING);
            }
        }
        this.lastTime = time;
        this.cost = this.cost * COST_SMOOTHING + stats.sceneMs * (1 - COST_SMOOTHING);

        const { x, y, z } = camera.position;
        this.element.textContent =
            `${this.fps.toFixed(0)} fps` +
            ` | cena ${this.cost.toFixed(1)} ms` +
            ` | ${stats.lights} luz ${stats.occluders} corpo` +
            ` | x ${x.toFixed(1)} y ${y.toFixed(1)} z ${z.toFixed(1)}` +
            ` | yaw ${toDegrees(camera.yaw)}° pitch ${toDegrees(camera.pitch)}°` +
            ` | ${locked ? 'WASD / Q E / Shift — Esc solta' : 'clique para capturar o mouse'}`;
    }
}
