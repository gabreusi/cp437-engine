import type { Camera } from "../render/camera";

const DEFAULT_RADIUS = 8;

/**
 * Câmera que gira sozinha em volta de um ponto, olhando para ele.
 *
 * Substitui a `FreeCam` (não roda junto com ela) quando a engine é embarcada
 * como vitrine: ninguém precisa capturar o mouse para ela se mexer. Raio,
 * altura e ângulo de partida vêm da pose que a câmera já tem — é por isso que
 * `cam=` na URL vale também para a órbita, sem parâmetro extra.
 */
export class OrbitCam {
  private angle = 0;
  private radius = DEFAULT_RADIUS;
  private height = 0;
  private pitch = 0;

  constructor(
    private readonly camera: Camera,
    private readonly speed: number,
    private readonly target: { x: number; y: number; z: number },
  ) {}

  /**
   * Lê a pose atual da câmera. Chamar depois de ela ser posicionada (`cam=`),
   * e antes do primeiro `update`.
   */
  start(): void {
    const { position } = this.camera;
    const dx = position.x - this.target.x;
    const dz = position.z - this.target.z;

    const distance = Math.hypot(dx, dz);
    this.radius = distance < 0.5 ? DEFAULT_RADIUS : distance;
    this.angle = distance < 0.5 ? 0 : Math.atan2(dx, dz);
    this.height = position.y;
    // Positivo olha para cima: o alvo acima da câmera pede pitch positivo.
    this.pitch = Math.atan2(this.target.y - this.height, this.radius);
  }

  update(deltaSeconds: number): void {
    const { camera, target } = this;
    this.angle += this.speed * deltaSeconds;

    camera.position.x = target.x + this.radius * Math.sin(this.angle);
    camera.position.z = target.z + this.radius * Math.cos(this.angle);
    camera.position.y = this.height;
    // Com a câmera em `target + R(sin a, cos a)`, olhar para o alvo é `yaw = a`.
    camera.yaw = this.angle;
    camera.pitch = this.pitch;
    camera.update();
  }
}
