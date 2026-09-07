import { settings } from '../../config';
import type { Framebuffer } from '../framebuffer';
import type { Viewport } from '../viewport';
import { type GlyphAtlas, atlasCellWidthFor, buildGlyphAtlas } from './atlas';
import { GlContext } from './context';
import { type Atmosphere, BackgroundPass } from './passes/background';
import { BloomPass } from './passes/bloom';
import { CompositePass } from './passes/composite';
import { GridPass } from './passes/grid';
import { RenderTarget } from './target';

export type { Atmosphere };

/**
 * Onde o framebuffer da CPU vira pixels.
 *
 * A interface existe para o presenter de debug em DOM poder entrar no lugar
 * deste sem que nada acima saiba a diferença.
 */
export interface Presenter {
    resize(viewport: Viewport): void;
    present(framebuffer: Framebuffer, atmosphere: Atmosphere): void;
    dispose(): void;
}

/** Lê um framebuffer de GPU para um canvas, desvirando as linhas. */
const readTargetToCanvas = (
    gl: WebGL2RenderingContext,
    width: number,
    height: number,
): HTMLCanvasElement => {
    const pixels = new Uint8ClampedArray(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext('2d');
    if (ctx === null) throw new Error('Canvas 2D indisponível para o export.');

    // readPixels devolve de baixo para cima; o canvas espera de cima para baixo.
    const image = ctx.createImageData(width, height);
    const rowBytes = width * 4;
    for (let row = 0; row < height; row += 1) {
        const source = (height - 1 - row) * rowBytes;
        image.data.set(pixels.subarray(source, source + rowBytes), row * rowBytes);
    }
    ctx.putImageData(image, 0, 0);
    return canvas;
};

/** Período das scanlines em pixels CSS, o mesmo do CSS que elas substituem. */
const SCANLINE_PERIOD_CSS = 5;

interface Resources {
    grid: GridPass;
    background: BackgroundPass;
    bloom: BloomPass;
    composite: CompositePass;
    scene: RenderTarget;
    atlas: GlyphAtlas | null;
    atlasCellWidth: number;
}

export class GlPresenter implements Presenter {
    private readonly context: GlContext;
    private resources: Resources | null = null;
    private viewport: Viewport | null = null;

    constructor(canvas: HTMLCanvasElement) {
        this.context = new GlContext(canvas);
        // Depois de uma perda de contexto todo recurso de GPU sumiu; recriar é a
        // diferença entre a cena voltar sozinha e a tela ficar preta para sempre.
        this.context.onRestore(() => this.createResources());
        this.createResources();
    }

    private createResources(): void {
        const { gl } = this.context;
        const width = Math.max(1, this.viewport?.pixelWidth ?? 1);
        const height = Math.max(1, this.viewport?.pixelHeight ?? 1);

        this.resources = {
            grid: new GridPass(gl),
            background: new BackgroundPass(gl),
            bloom: new BloomPass(gl, width, height),
            composite: new CompositePass(gl),
            scene: new RenderTarget(gl, width, height),
            atlas: null,
            atlasCellWidth: 0,
        };

        if (this.viewport !== null) this.resize(this.viewport);
    }

    resize(viewport: Viewport): void {
        this.viewport = viewport;
        const resources = this.resources;
        if (this.context.isLost || resources === null) return;

        const { gl } = this.context;
        this.context.resize(viewport);

        resources.grid.resize(viewport.colCount, viewport.rowCount);
        resources.scene.resize(viewport.pixelWidth, viewport.pixelHeight);
        resources.bloom.resize(viewport.pixelWidth, viewport.pixelHeight);

        const cellWidth = atlasCellWidthFor(viewport.cellWidth * viewport.dpr);
        if (resources.atlas === null || cellWidth !== resources.atlasCellWidth) {
            if (resources.atlas !== null) gl.deleteTexture(resources.atlas.texture);
            resources.atlas = buildGlyphAtlas(gl, cellWidth);
            resources.atlasCellWidth = cellWidth;
        }
        resources.grid.setAtlas(resources.atlas);
    }

    present(framebuffer: Framebuffer, atmosphere: Atmosphere): void {
        const resources = this.resources;
        const viewport = this.viewport;
        if (this.context.isLost || resources === null || viewport === null) return;

        const { gl } = this.context;

        // 1. Céu e grid, fora da tela, para o bloom ter o que amostrar.
        resources.scene.bind();
        gl.disable(gl.BLEND);
        resources.background.draw(
            atmosphere, viewport.pixelWidth, viewport.pixelHeight, settings.groundHaze,
        );

        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        resources.grid.draw(framebuffer);

        // 2. Bloom em duas escalas.
        resources.bloom.render(resources.scene.texture, settings.bloomRadius);

        // 3. Composição na tela.
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, viewport.pixelWidth, viewport.pixelHeight);
        resources.composite.draw(
            resources.scene.texture,
            resources.bloom.halfTexture,
            resources.bloom.quarterTexture,
            {
                bloomIntensity: settings.bloomIntensity,
                scanlinePeriod: SCANLINE_PERIOD_CSS * viewport.dpr,
                scanlineStrength: settings.scanlineStrength,
                vignetteStrength: settings.vignetteStrength,
            },
        );
    }

    /**
     * Renderiza um quadro extra fora da tela, em resolução ampliada, e lê de volta.
     *
     * É por isso que o contexto não pede `preserveDrawingBuffer`: manter o
     * buffer da tela legível custaria performance em todo quadro para servir a
     * uma captura ocasional. Renderizar sob demanda ainda permite exportar acima
     * da resolução do monitor.
     */
    capture(framebuffer: Framebuffer, atmosphere: Atmosphere, scale: number): HTMLCanvasElement {
        const resources = this.resources;
        const viewport = this.viewport;
        if (this.context.isLost || resources === null || viewport === null) {
            throw new Error('Contexto WebGL indisponível para a captura.');
        }

        const { gl } = this.context;
        const width = Math.round(viewport.pixelWidth * scale);
        const height = Math.round(viewport.pixelHeight * scale);

        resources.scene.resize(width, height);
        resources.bloom.resize(width, height);
        const target = new RenderTarget(gl, width, height);

        try {
            resources.scene.bind();
            gl.disable(gl.BLEND);
            resources.background.draw(atmosphere, width, height, settings.groundHaze);

            gl.enable(gl.BLEND);
            gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
            resources.grid.draw(framebuffer);

            // Raio e período acompanham a escala, senão o CRT muda de aparência
            // justamente na imagem que vai virar wallpaper.
            resources.bloom.render(resources.scene.texture, settings.bloomRadius * scale);

            target.bind();
            resources.composite.draw(
                resources.scene.texture,
                resources.bloom.halfTexture,
                resources.bloom.quarterTexture,
                {
                    bloomIntensity: settings.bloomIntensity,
                    scanlinePeriod: SCANLINE_PERIOD_CSS * viewport.dpr * scale,
                    scanlineStrength: settings.scanlineStrength,
                    vignetteStrength: settings.vignetteStrength,
                },
            );

            return readTargetToCanvas(gl, width, height);
        } finally {
            target.dispose();
            resources.scene.resize(viewport.pixelWidth, viewport.pixelHeight);
            resources.bloom.resize(viewport.pixelWidth, viewport.pixelHeight);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        }
    }

    dispose(): void {
        const resources = this.resources;
        if (resources === null) return;

        resources.grid.dispose();
        resources.background.dispose();
        resources.bloom.dispose();
        resources.composite.dispose();
        resources.scene.dispose();
        if (resources.atlas !== null) this.context.gl.deleteTexture(resources.atlas.texture);
        this.resources = null;
    }
}
