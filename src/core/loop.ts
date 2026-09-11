/** Passo fixo da simulação, em segundos. */
const FIXED_STEP = 1 / 120;

/**
 * Teto de passos por quadro.
 *
 * Sem ele, uma pausa longa (aba em segundo plano, breakpoint) acumularia
 * segundos de atraso e o loop tentaria alcançar o tempo real rodando milhares
 * de passos, travando de vez em vez de perder um pouco de simulação.
 */
const MAX_STEPS_PER_FRAME = 5;

export type UpdateFn = (deltaSeconds: number) => void;
export type RenderFn = (timeMs: number) => void;

/**
 * Desacopla a simulação da taxa de quadros.
 *
 * Uma freecam não precisa disso, mas é a costura onde a física do jogo entra
 * depois sem ficar amarrada ao monitor de quem está jogando.
 */
export class GameLoop {
  private accumulator = 0;
  private lastTime = 0;
  private running = false;

  constructor(
    private readonly update: UpdateFn,
    private readonly render: RenderFn,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    requestAnimationFrame(this.frame);
  }

  private readonly frame = (time: number): void => {
    if (!this.running) return;

    this.accumulator += (time - this.lastTime) / 1000;
    this.lastTime = time;

    let steps = 0;
    while (this.accumulator >= FIXED_STEP && steps < MAX_STEPS_PER_FRAME) {
      this.update(FIXED_STEP);
      this.accumulator -= FIXED_STEP;
      steps += 1;
    }
    if (steps === MAX_STEPS_PER_FRAME) this.accumulator = 0;

    this.render(time);
    requestAnimationFrame(this.frame);
  };
}
