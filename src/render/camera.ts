import * as mat4 from "../math/mat4";
import { set, type Vec3, vec3 } from "../math/vec3";

const HALF_PI = Math.PI / 2;

/** Um pelo de folga: em pitch exatamente vertical o yaw perde a referência. */
const PITCH_LIMIT = HALF_PI - 0.001;

/**
 * Teto do campo de visão horizontal.
 *
 * Numa janela muito larga o FOV vertical fixo estica as bordas até virar olho
 * de peixe; acima disto o vertical é que cede.
 */
const MAX_HORIZONTAL_FOV = (120 * Math.PI) / 180;

/**
 * FOV vertical, em radianos, para a proporção real da tela.
 *
 * O ajuste `fovDegrees` vale para o eixo **menor**: em paisagem é o vertical
 * de sempre (o desktop não muda), em retrato é o horizontal — senão uma janela
 * estreita enxergaria uma fatia fina do mundo. Uma conta só, aqui, porque
 * `Rasterizer` e a névoa do fundo leem o mesmo `camera.fov` e não podem
 * discordar. `aspect` é o de `Viewport` (já com `CELL_ASPECT` compensado).
 */
export const verticalFovFor = (fov: number, aspect: number): number => {
  const tanHalf = Math.tan(fov / 2);
  const tanVertical = aspect >= 1 ? tanHalf : tanHalf / aspect;
  const tanCap = Math.tan(MAX_HORIZONTAL_FOV / 2) / aspect;
  return 2 * Math.atan(Math.min(tanVertical, tanCap));
};

export class Camera {
  readonly position: Vec3 = vec3(0, 1.6, 8);

  yaw = 0;
  pitch = 0;

  fov = (60 * Math.PI) / 180;
  near = 0.1;
  far = 260;

  /** Matriz de view, reconstruída por `update()`. */
  readonly view: mat4.Mat4 = mat4.create();

  /** Base da câmera em espaço de mundo, para o movimento da freecam. */
  readonly forward: Vec3 = vec3(0, 0, -1);
  readonly right: Vec3 = vec3(1, 0, 0);

  constructor() {
    this.update();
  }

  /** Aplica um delta de olhar já em radianos, prendendo o pitch na vertical. */
  look(deltaYaw: number, deltaPitch: number): void {
    this.yaw += deltaYaw;
    this.pitch = Math.max(
      -PITCH_LIMIT,
      Math.min(PITCH_LIMIT, this.pitch + deltaPitch),
    );
  }

  update(): void {
    mat4.setView(this.view, this.position, this.yaw, this.pitch);

    const cy = Math.cos(this.yaw);
    const sy = Math.sin(this.yaw);
    const cp = Math.cos(this.pitch);
    const sp = Math.sin(this.pitch);

    // Linhas da parte rotacional da view, transpostas de volta para o mundo.
    set(this.forward, -cp * sy, sp, -cp * cy);
    set(this.right, cy, 0, -sy);
  }
}
