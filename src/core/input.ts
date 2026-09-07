/**
 * Teclado e mouse, nos dois modos que a engine tem.
 *
 * Com o ponteiro capturado (Pointer Lock) o mouse dirige a câmera: sem isso ele
 * esbarra na borda da janela e o olhar trava. Solto, ele opera o menu e o
 * editor. `Esc` devolve o ponteiro — é o que o navegador impõe, e virou também
 * o gesto que abre o menu, porque é exatamente o mesmo movimento de um menu de
 * pausa.
 *
 * Os eventos são acumulados e consumidos uma vez por quadro, e não tratados na
 * hora, pelo mesmo motivo que o movimento do mouse já era: entre dois quadros
 * chegam vários, e quem reage tem que ver a soma, uma vez só.
 */

/** O que aconteceu na interface entre dois quadros. */
export interface UiEvents {
    /** Códigos de tecla pressionados, na ordem, incluindo repetição. */
    keys: string[];
    /** O botão foi pressionado neste intervalo. */
    pressed: boolean;
    released: boolean;
    /** Passos de roda acumulados. */
    wheel: number;
    /**
     * A captura do ponteiro acabou de ser solta.
     *
     * É o sinal que abre o menu, e não a tecla: o Chrome consome o `Esc` que
     * sai do Pointer Lock antes de ele virar um `keydown` na página. Escutar a
     * saída da captura pega o gesto por qualquer via — a tecla, o navegador
     * decidindo sozinho, ou a aba perdendo o foco.
     */
    unlocked: boolean;
    /** Posição do ponteiro em pixels de janela. */
    clientX: number;
    clientY: number;
    /** Quanto ele andou, para arrastar. */
    deltaX: number;
    deltaY: number;
    down: boolean;
    shift: boolean;
}

export const createUiEvents = (): UiEvents => ({
    keys: [],
    pressed: false,
    released: false,
    wheel: 0,
    unlocked: false,
    clientX: 0,
    clientY: 0,
    deltaX: 0,
    deltaY: 0,
    down: false,
    shift: false,
});

export class Input {
    private readonly pressed = new Set<string>();

    private pendingYaw = 0;
    private pendingPitch = 0;
    private locked = false;

    private readonly pendingKeys: string[] = [];
    private pendingPressed = false;
    private pendingReleased = false;
    private pendingWheel = 0;
    private pendingUnlocked = false;
    private pendingDeltaX = 0;
    private pendingDeltaY = 0;
    private clientX = 0;
    private clientY = 0;
    private buttonDown = false;
    private shift = false;

    /**
     * Impede que o clique capture o ponteiro.
     *
     * Com o menu aberto, clicar tem que operar o menu e selecionar objetos; sem
     * esta trava o primeiro clique capturaria o mouse e o menu ficaria
     * inalcançável, que é justamente o defeito do painel antigo ao contrário.
     */
    captureOnClick = true;

    constructor(private readonly target: HTMLElement) {
        target.addEventListener('mousedown', (event) => {
            if (event.button !== 0) return;
            this.buttonDown = true;
            this.pendingPressed = true;
        });

        window.addEventListener('mouseup', (event) => {
            if (event.button !== 0) return;
            this.buttonDown = false;
            this.pendingReleased = true;
        });

        target.addEventListener('click', () => {
            if (!this.locked && this.captureOnClick) void target.requestPointerLock();
        });

        target.addEventListener('wheel', (event) => {
            if (this.locked) return;
            event.preventDefault();
            this.pendingWheel += Math.sign(event.deltaY);
        }, { passive: false });

        document.addEventListener('pointerlockchange', () => {
            const wasLocked = this.locked;
            this.locked = document.pointerLockElement === target;
            // Sair da captura no meio de um movimento deixaria a tecla presa.
            if (!this.locked) {
                this.pressed.clear();
                if (wasLocked) this.pendingUnlocked = true;
            }
        });

        document.addEventListener('mousemove', (event) => {
            this.shift = event.shiftKey;
            if (this.locked) {
                this.pendingYaw -= event.movementX;
                this.pendingPitch -= event.movementY;
                return;
            }
            this.clientX = event.clientX;
            this.clientY = event.clientY;
            this.pendingDeltaX += event.movementX;
            this.pendingDeltaY += event.movementY;
        });

        window.addEventListener('keydown', (event) => {
            this.shift = event.shiftKey;

            if (this.locked) {
                this.pressed.add(event.code);
                // Espaço e setas rolariam a página por baixo da captura.
                event.preventDefault();
                return;
            }

            // Solto, a tecla é comando de menu: entra na fila e é consumida uma
            // vez, com repetição, porque segurar a seta tem que andar no slider.
            //
            // O teto existe porque uma aba em segundo plano não desenha quadro
            // nenhum e ninguém consome a fila: sem ele, quem digitar com a aba
            // escondida volta e vê o menu executar tudo de uma vez.
            if (this.pendingKeys.length < MAX_PENDING_KEYS) this.pendingKeys.push(event.code);
            if (MENU_KEYS.has(event.code)) event.preventDefault();
        });

        window.addEventListener('keyup', (event) => {
            this.pressed.delete(event.code);
            this.shift = event.shiftKey;
        });

        // Trocar de aba com uma tecla apertada deixaria a câmera andando sozinha.
        window.addEventListener('blur', () => {
            this.pressed.clear();
            this.buttonDown = false;
        });
    }

    get isLocked(): boolean {
        return this.locked;
    }

    release(): void {
        if (this.locked) document.exitPointerLock();
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

    /** O mesmo para a interface. O array é reaproveitado. */
    consumeUi(out: UiEvents): void {
        out.keys.length = 0;
        for (const code of this.pendingKeys) out.keys.push(code);
        this.pendingKeys.length = 0;

        out.pressed = this.pendingPressed;
        out.released = this.pendingReleased;
        out.wheel = this.pendingWheel;
        out.unlocked = this.pendingUnlocked;
        out.deltaX = this.pendingDeltaX;
        out.deltaY = this.pendingDeltaY;
        out.clientX = this.clientX;
        out.clientY = this.clientY;
        out.down = this.buttonDown;
        out.shift = this.shift;

        this.pendingPressed = false;
        this.pendingReleased = false;
        this.pendingWheel = 0;
        this.pendingUnlocked = false;
        this.pendingDeltaX = 0;
        this.pendingDeltaY = 0;
    }

    /** Onde o ponteiro está, em coordenadas do canvas. */
    canvasPoint(out: { x: number; y: number }): void {
        const rect = this.target.getBoundingClientRect();
        out.x = this.clientX - rect.left;
        out.y = this.clientY - rect.top;
    }
}

/** Teto da fila de teclas, para uma aba em segundo plano não acumular comandos. */
const MAX_PENDING_KEYS = 32;

/** Teclas cujo comportamento padrão do navegador atrapalha o menu. */
const MENU_KEYS = new Set([
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
    'Enter', 'Space', 'Tab', 'Home', 'End', 'PageUp', 'PageDown',
]);
