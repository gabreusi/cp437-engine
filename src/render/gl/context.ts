import type { Viewport } from '../viewport';

/**
 * Dono do contexto WebGL2 e do ciclo de vida dele.
 *
 * Perda de contexto não é caso exótico: acontece em suspensão de aba, troca de
 * GPU em máquina híbrida e soluço de driver. Sem tratar, a tela fica preta para
 * sempre. Quem cria recurso de GPU se registra em `onRestore` e é chamado de
 * volta para recriar tudo — é barato agora e caro de retrofitar depois.
 */
export class GlContext {
    readonly gl: WebGL2RenderingContext;

    private lost = false;
    private readonly restoreHandlers: (() => void)[] = [];

    constructor(readonly canvas: HTMLCanvasElement) {
        const gl = canvas.getContext('webgl2', {
            alpha: false,
            antialias: false,
            depth: false,
            stencil: false,
            // Ler o canvas depois do quadro custa performance em todo quadro; o
            // export renderiza sob demanda num FBO e lê de lá.
            preserveDrawingBuffer: false,
            powerPreference: 'high-performance',
        });

        if (gl === null) {
            throw new Error('WebGL2 não disponível neste navegador.');
        }
        this.gl = gl;

        canvas.addEventListener('webglcontextlost', (event) => {
            event.preventDefault();
            this.lost = true;
        });

        canvas.addEventListener('webglcontextrestored', () => {
            this.lost = false;
            for (const handler of this.restoreHandlers) handler();
        });
    }

    get isLost(): boolean {
        return this.lost || this.gl.isContextLost();
    }

    onRestore(handler: () => void): void {
        this.restoreHandlers.push(handler);
    }

    resize(viewport: Viewport): void {
        const { canvas } = this;
        canvas.width = viewport.pixelWidth;
        canvas.height = viewport.pixelHeight;
        canvas.style.width = `${viewport.cssWidth}px`;
        canvas.style.height = `${viewport.cssHeight}px`;
        this.gl.viewport(0, 0, viewport.pixelWidth, viewport.pixelHeight);
    }
}
