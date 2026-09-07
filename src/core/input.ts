/**
 * Teclado e mouse da freecam.
 *
 * O olhar só responde com o ponteiro capturado (Pointer Lock): sem isso o mouse
 * esbarra na borda da janela e a câmera trava. Esc devolve o ponteiro, que é o
 * comportamento que o próprio navegador impõe e o único jeito de o painel de
 * ajustes voltar a ser clicável.
 */
export class Input {
    private readonly pressed = new Set<string>();

    private pendingYaw = 0;
    private pendingPitch = 0;
    private locked = false;

    constructor(target: HTMLElement) {
        target.addEventListener('click', () => {
            if (!this.locked) void target.requestPointerLock();
        });

        document.addEventListener('pointerlockchange', () => {
            this.locked = document.pointerLockElement === target;
            // Sair da captura no meio de um movimento deixaria a tecla presa.
            if (!this.locked) this.pressed.clear();
        });

        document.addEventListener('mousemove', (event) => {
            if (!this.locked) return;
            this.pendingYaw -= event.movementX;
            this.pendingPitch -= event.movementY;
        });

        window.addEventListener('keydown', (event) => {
            if (!this.locked) return;
            this.pressed.add(event.code);
            // Espaço e setas rolariam a página por baixo da captura.
            event.preventDefault();
        });

        window.addEventListener('keyup', (event) => {
            this.pressed.delete(event.code);
        });

        // Trocar de aba com uma tecla apertada deixaria a câmera andando sozinha.
        window.addEventListener('blur', () => this.pressed.clear());
    }

    get isLocked(): boolean {
        return this.locked;
    }

    isDown(code: string): boolean {
        return this.pressed.has(code);
    }

    /** Eixo de -1 a 1 a partir de duas teclas opostas. */
    axis(negative: string, positive: string): number {
        return (this.isDown(positive) ? 1 : 0) - (this.isDown(negative) ? 1 : 0);
    }

    /**
     * Devolve o movimento de mouse acumulado e zera.
     *
     * O acumulador existe porque o mouse dispara vários eventos entre dois
     * quadros; somar e consumir uma vez evita perder movimento e evita aplicar
     * a mesma amostra duas vezes se o update rodar em passo fixo.
     */
    consumeLook(out: { yaw: number; pitch: number }): void {
        out.yaw = this.pendingYaw;
        out.pitch = this.pendingPitch;
        this.pendingYaw = 0;
        this.pendingPitch = 0;
    }
}
