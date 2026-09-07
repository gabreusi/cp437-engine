import { settings } from '../config';
import type { SceneElements } from '../dom';
import type { Layout, Star } from '../types';
import { CharBuffer } from './buffer';
import { drawFloor } from './floor';
import { buildStageGradient, computeLayout } from './layout';
import { buildStarData, getTwinkleChar } from './stars';
import { buildSunCell } from './sun';

const RESIZE_DEBOUNCE_MS = 120;

/** Segundos por quadro no pior caso: evita um salto após a aba ficar oculta. */
const MAX_FRAME_SECONDS = 0.05;

/**
 * Dono do laço de animação e de todo o estado mutável da cena.
 *
 * A cena é dividida em duas camadas porque elas mudam em ritmos diferentes: o
 * céu (sol e estrelas) é caro e quase estático, e só é reserializado quando
 * alguma estrela pisca; o chão é redesenhado a cada quadro.
 */
export class SceneRenderer {
    private layout: Layout;
    private skyBuffer: CharBuffer;
    private floorBuffer: CharBuffer;
    private stars: Star[] = [];

    private travelDistance = 0;
    private lastTimestamp = 0;
    private resizeHandle = 0;

    constructor(private readonly elements: SceneElements) {
        this.layout = computeLayout(elements.probe);
        this.skyBuffer = new CharBuffer(this.layout.horizonRow, this.layout.colCount);
        this.floorBuffer = new CharBuffer(this.layout.floorRowCount, this.layout.colCount);
    }

    /**
     * Recalcula o layout e repinta o céu. Chamado no boot, ao redimensionar e a
     * cada ajuste do painel que não seja a velocidade.
     */
    rebuild = (): void => {
        this.layout = computeLayout(this.elements.probe);
        this.elements.stage.style.background = buildStageGradient();

        this.skyBuffer = new CharBuffer(this.layout.horizonRow, this.layout.colCount);
        this.floorBuffer = new CharBuffer(this.layout.floorRowCount, this.layout.colCount);
        this.stars = [];

        this.paintSky();
        this.flushSky();
    };

    start(): void {
        window.addEventListener('resize', this.handleResize);
        this.rebuild();
        requestAnimationFrame(this.renderFrame);
    }

    /** O sol tem prioridade sobre as estrelas em cada célula do céu. */
    private paintSky(): void {
        for (let row = 0; row < this.layout.horizonRow; row += 1) {
            for (let col = 0; col < this.layout.colCount; col += 1) {
                const sunCell = buildSunCell(col, row, this.layout);
                if (sunCell !== null) {
                    this.skyBuffer.plot(row, col, sunCell.char, sunCell.className);
                    continue;
                }

                const star = buildStarData(col, row, this.layout);
                if (star === null) continue;

                let char = star.char;
                if (star.twinkles) {
                    char = getTwinkleChar(0, star.phaseOffset, star.speed);
                    this.stars.push({ row, col, phaseOffset: star.phaseOffset, speed: star.speed });
                }
                this.skyBuffer.plot(row, col, char, star.className);
            }
        }
    }

    // A quebra de linha final separa o céu do chão, que vivem no mesmo <pre>.
    private flushSky(): void {
        this.elements.sky.innerHTML = `${this.skyBuffer.toHtml()}\n`;
    }

    private renderFrame = (timestamp: number): void => {
        const elapsedSeconds = Math.min((timestamp - this.lastTimestamp) / 1000, MAX_FRAME_SECONDS);
        this.lastTimestamp = timestamp;
        this.travelDistance += elapsedSeconds * settings.travelSpeed;

        if (this.advanceTwinkle(timestamp)) {
            this.flushSky();
        }

        drawFloor(this.floorBuffer, this.layout, this.travelDistance);
        this.elements.floor.innerHTML = this.floorBuffer.toHtml();

        requestAnimationFrame(this.renderFrame);
    };

    /** Retorna se alguma estrela trocou de caractere neste quadro. */
    private advanceTwinkle(timestamp: number): boolean {
        let changed = false;
        for (const star of this.stars) {
            const nextChar = getTwinkleChar(timestamp, star.phaseOffset, star.speed);
            if (this.skyBuffer.charAt(star.row, star.col) === nextChar) continue;
            this.skyBuffer.setChar(star.row, star.col, nextChar);
            changed = true;
        }
        return changed;
    }


    private handleResize = (): void => {
        window.clearTimeout(this.resizeHandle);
        this.resizeHandle = window.setTimeout(this.rebuild, RESIZE_DEBOUNCE_MS);
    };
}
