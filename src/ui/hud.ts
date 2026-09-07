import type { Camera } from '../render/camera';

/** Constante de suavização do contador de quadros. */
const FPS_SMOOTHING = 0.9;

const toDegrees = (radians: number): number => Math.round((radians * 180) / Math.PI);

/**
 * Leitura de estado da câmera e custo por quadro.
 *
 * Fica em DOM, não no grid: é texto de diagnóstico, não parte da cena, e
 * misturá-lo ao framebuffer atrapalharia justamente quando a cena está errada.
 */
export class Hud {
    private fps = 60;
    private lastTime = 0;

    constructor(private readonly element: HTMLElement) {}

    update(camera: Camera, time: number, locked: boolean): void {
        if (this.lastTime !== 0) {
            const delta = time - this.lastTime;
            if (delta > 0) {
                this.fps = this.fps * FPS_SMOOTHING + (1000 / delta) * (1 - FPS_SMOOTHING);
            }
        }
        this.lastTime = time;

        const { x, y, z } = camera.position;
        this.element.textContent =
            `${this.fps.toFixed(0)} fps` +
            ` | x ${x.toFixed(1)} y ${y.toFixed(1)} z ${z.toFixed(1)}` +
            ` | yaw ${toDegrees(camera.yaw)}° pitch ${toDegrees(camera.pitch)}°` +
            ` | ${locked ? 'WASD / Q E / Shift — Esc solta' : 'clique para capturar o mouse'}`;
    }
}
