import { settings } from '../config';
import { addScaled } from '../math/vec3';
import type { Camera } from '../render/camera';
import type { Input } from './input';

const TURBO_MULTIPLIER = 4;

/**
 * Traduz teclado e mouse em movimento de câmera.
 *
 * Fica separado da `Camera` de propósito: a câmera sabe onde está e para onde
 * olha, não quem manda nela. Quando o jogo tiver um carro, o controlador dele
 * entra aqui no lugar sem a engine saber da diferença.
 */
export class FreeCam {
    private readonly look = { yaw: 0, pitch: 0 };

    constructor(
        private readonly camera: Camera,
        private readonly input: Input,
    ) {}

    update(deltaSeconds: number): void {
        const { camera, input } = this;

        this.input.consumeLook(this.look);
        camera.look(
            this.look.yaw * settings.lookSensitivity,
            this.look.pitch * settings.lookSensitivity,
        );

        const turbo = input.isDown('ShiftLeft') || input.isDown('ShiftRight');
        const speed = settings.moveSpeed * (turbo ? TURBO_MULTIPLIER : 1) * deltaSeconds;

        const forward = input.axis('KeyS', 'KeyW');
        const strafe = input.axis('KeyA', 'KeyD');
        const vertical = input.axis('KeyQ', 'KeyE');

        if (forward !== 0) addScaled(camera.position, camera.position, camera.forward, forward * speed);
        if (strafe !== 0) addScaled(camera.position, camera.position, camera.right, strafe * speed);
        camera.position.y += vertical * speed;

        camera.update();
    }
}
