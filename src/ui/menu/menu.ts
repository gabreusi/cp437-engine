import type { Input, UiEvents } from '../../core/input';
import type { LightWorld } from '../../light/world';
import { type Vec3, vec3 } from '../../math/vec3';
import type { Camera } from '../../render/camera';
import type { Framebuffer } from '../../render/framebuffer';
import type { Rasterizer } from '../../render/rasterizer';
import type { Viewport } from '../../render/viewport';
import type { World } from '../../scene/world';
import { type MenuLayout, computeLayout, drawMenu } from './draw';
import {
    FAST_STEP,
    type MenuGroup,
    type MenuItem,
    clampToRange,
    isFocusable,
} from './model';

/**
 * O menu de pausa da engine.
 *
 * Substitui o painel em DOM, e a troca não é estética. O painel vivia fora da
 * cena: tinha folha de estilo própria, era um segundo lugar onde a paleta
 * morava, e ficava sobre o canvas sem pertencer a ele. Este é desenhado na
 * mesma grade de caracteres, passa pelo mesmo bloom e pelas mesmas scanlines, e
 * some da existência quando fechado.
 *
 * `Esc` abre, porque `Esc` já era o que devolvia o ponteiro — o navegador impõe
 * isso, e é exatamente o gesto de pausar.
 */

/** Nome do grupo que liga o modo de edição. Ligar por nome mantém o resto burro. */
const EDIT_GROUP = 'Objects';

/** Passo de giro por clique de roda, em radianos. */
const WHEEL_YAW = Math.PI / 24;

/** Sensibilidade do arrasto vertical, em unidades de mundo por pixel. */
const VERTICAL_DRAG = 0.05;

export class Menu {
    open = false;

    private groupIndex = 0;
    private itemIndex = 0;
    private scroll = 0;
    private onGroups = true;
    private hoverItem = -1;

    private items: MenuItem[] = [];
    private layout: MenuLayout | null = null;

    /** Índice do slider sendo arrastado, ou -1. */
    private draggingSlider = -1;
    private draggingEntity = false;

    private readonly point = { x: 0, y: 0 };
    private readonly ray: Vec3 = vec3();

    constructor(
        private readonly groups: readonly MenuGroup[],
        private readonly world: World,
        private readonly input: Input,
    ) {}

    private get editing(): boolean {
        return this.open && this.groups[this.groupIndex]?.label === EDIT_GROUP;
    }

    update(
        events: UiEvents,
        viewport: Viewport,
        camera: Camera,
        rasterizer: Rasterizer,
        lights: LightWorld,
    ): void {
        // Sair da captura do ponteiro abre o menu: é o mesmo gesto de pausa, e
        // ficar com o mouse solto e sem menu não serve para nada. Vem por aqui
        // e não pela tecla porque o navegador consome o `Esc` do Pointer Lock.
        if (events.unlocked) this.setOpen(true);

        for (const code of events.keys) {
            if (code === 'Escape') this.setOpen(!this.open);
        }

        this.world.editing = this.editing;

        if (!this.open) {
            this.draggingSlider = -1;
            this.draggingEntity = false;
            return;
        }

        this.items = this.groups[this.groupIndex]?.items() ?? [];
        this.layout = computeLayout(viewport);

        this.handlePointer(events, viewport, camera, rasterizer, lights);
        this.handleKeys(events);
        this.clampFocus();
    }

    private setOpen(open: boolean): void {
        this.open = open;
        // Com o menu aberto, clicar opera o menu; sem isto o primeiro clique
        // capturaria o ponteiro e o menu ficaria inalcançável.
        this.input.captureOnClick = !open;
        if (open) {
            this.input.release();
            this.ensureFocusable(1);
        } else {
            this.draggingSlider = -1;
            this.draggingEntity = false;
        }
    }

    // ---------------------------------------------------------------- teclado

    private handleKeys(events: UiEvents): void {
        for (const code of events.keys) {
            if (code === 'Escape') continue;

            if (this.onGroups) {
                this.handleGroupKey(code);
                continue;
            }
            this.handleItemKey(code, events.shift);
        }
    }

    private handleGroupKey(code: string): void {
        switch (code) {
            case 'ArrowUp':
                this.groupIndex = (this.groupIndex + this.groups.length - 1) % this.groups.length;
                this.resetItems();
                break;
            case 'ArrowDown':
                this.groupIndex = (this.groupIndex + 1) % this.groups.length;
                this.resetItems();
                break;
            case 'ArrowRight':
            case 'Enter':
            case 'Tab':
                this.onGroups = false;
                this.ensureFocusable(1);
                break;
        }
    }

    private handleItemKey(code: string, shift: boolean): void {
        const item = this.items[this.itemIndex];

        switch (code) {
            case 'ArrowUp':
                this.moveFocus(-1);
                return;
            case 'ArrowDown':
                this.moveFocus(1);
                return;
            case 'Tab':
                this.onGroups = true;
                return;
            case 'ArrowLeft':
                if (item === undefined || !this.adjust(item, -1, shift)) this.onGroups = true;
                return;
            case 'ArrowRight':
                if (item !== undefined) this.adjust(item, 1, shift);
                return;
            case 'Enter':
            case 'Space':
                if (item !== undefined) this.activate(item);
                return;
            case 'Delete':
            case 'Backspace':
                if (this.editing && this.world.selectedId !== null) {
                    this.world.remove(this.world.selectedId);
                }
                return;
        }
    }

    /** Devolve `false` quando o item não tem valor para ajustar. */
    private adjust(item: MenuItem, direction: number, fast: boolean): boolean {
        if (item.kind === 'slider') {
            const step = item.step * (fast ? FAST_STEP : 1) * direction;
            item.set(clampToRange(item.get() + step, item));
            return true;
        }
        if (item.kind === 'choice') {
            const index = item.options.findIndex((option) => option.value === item.get());
            const next = (index + direction + item.options.length) % item.options.length;
            item.set(item.options[next]!.value);
            return true;
        }
        if (item.kind === 'toggle') {
            item.set(direction > 0);
            return true;
        }
        return false;
    }

    private activate(item: MenuItem): void {
        switch (item.kind) {
            case 'toggle':
                item.set(!item.get());
                return;
            case 'action':
                item.run();
                // A ação pode ter criado ou apagado um objeto: a lista mudou.
                this.items = this.groups[this.groupIndex]?.items() ?? [];
                this.clampFocus();
                return;
            case 'entity':
                item.select();
                return;
        }
    }

    private moveFocus(direction: number): void {
        this.itemIndex += direction;
        this.ensureFocusable(direction);
    }

    /** Anda até cair num item que aceita foco. Títulos são pulados. */
    private ensureFocusable(direction: number): void {
        const step = direction >= 0 ? 1 : -1;
        for (let guard = 0; guard <= this.items.length; guard += 1) {
            if (this.itemIndex < 0) {
                this.itemIndex = 0;
                if (this.items.every((item) => !isFocusable(item))) return;
            }
            if (this.itemIndex >= this.items.length) {
                this.itemIndex = this.items.length - 1;
            }

            const item = this.items[this.itemIndex];
            if (item === undefined || isFocusable(item)) return;
            this.itemIndex += step;
        }
    }

    private resetItems(): void {
        this.items = this.groups[this.groupIndex]?.items() ?? [];
        this.itemIndex = 0;
        this.scroll = 0;
        this.ensureFocusable(1);
    }

    /** Mantém o foco dentro da lista e visível na janela de rolagem. */
    private clampFocus(): void {
        if (this.items.length === 0) {
            this.itemIndex = 0;
            this.scroll = 0;
            return;
        }
        this.itemIndex = Math.max(0, Math.min(this.items.length - 1, this.itemIndex));

        const rows = this.layout?.visibleRows ?? this.items.length;
        if (this.itemIndex < this.scroll) this.scroll = this.itemIndex;
        if (this.itemIndex >= this.scroll + rows) this.scroll = this.itemIndex - rows + 1;
        this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, this.items.length - rows)));
    }

    // ------------------------------------------------------------------ mouse

    private handlePointer(
        events: UiEvents,
        viewport: Viewport,
        camera: Camera,
        rasterizer: Rasterizer,
        lights: LightWorld,
    ): void {
        const layout = this.layout;
        if (layout === null) return;

        this.input.canvasPoint(this.point);
        const col = Math.floor(this.point.x / viewport.cellWidth);
        const rowIndex = Math.floor(this.point.y / viewport.cellHeight);

        const insideBox =
            col >= layout.col && col < layout.col + layout.width &&
            rowIndex >= layout.row && rowIndex < layout.row + layout.height;

        if (!events.down) {
            this.draggingSlider = -1;
            this.draggingEntity = false;
        }

        if (insideBox) {
            this.handleMenuPointer(events, layout, col, rowIndex);
            return;
        }

        this.hoverItem = -1;
        if (this.editing) this.handleScenePointer(events, col, rowIndex, camera, rasterizer, lights);
    }

    private handleMenuPointer(
        events: UiEvents,
        layout: MenuLayout,
        col: number,
        row: number,
    ): void {
        // Coluna dos grupos.
        if (col <= layout.col + layout.width - layout.itemWidth - 3) {
            const index = row - layout.groupFirstRow;
            this.hoverItem = -1;
            if (events.pressed && index >= 0 && index < this.groups.length) {
                this.groupIndex = index;
                this.onGroups = true;
                this.resetItems();
            }
            return;
        }

        const index = this.scroll + (row - layout.itemFirstRow);
        const item = this.items[index];
        this.hoverItem = item !== undefined && isFocusable(item) ? index : -1;

        if (events.wheel !== 0) {
            this.scroll += events.wheel;
            this.scroll = Math.max(0, Math.min(this.scroll,
                Math.max(0, this.items.length - layout.visibleRows)));
            return;
        }

        if (item === undefined || !isFocusable(item)) return;

        const onTrack = item.kind === 'slider' && col >= layout.trackCol - 1;

        if (events.pressed) {
            this.itemIndex = index;
            this.onGroups = false;

            if (onTrack) {
                this.draggingSlider = index;
            } else if (item.kind !== 'slider') {
                this.activate(item);
            }
        }

        // Escrever já no clique, e não só ao arrastar: numa trilha, clicar em
        // um ponto significa "vá para cá". Exigir arrasto faria um clique
        // simples não fazer nada, que é o defeito mais chato de slider.
        if (item.kind === 'slider' && onTrack && (events.pressed || this.draggingSlider === index)) {
            const ratio = (col - layout.trackCol) / Math.max(1, layout.trackWidth - 1);
            const value = item.min + Math.max(0, Math.min(1, ratio)) * (item.max - item.min);
            item.set(clampToRange(value, item));
        }
    }

    /**
     * Clique e arrasto na cena, com o menu de objetos aberto.
     *
     * Selecionar é lançar um raio pelo cursor contra os mesmos corpos que fazem
     * sombra e reflexo — então o que o clique acerta é, por construção, o que
     * projeta sombra e aparece no espelho.
     */
    private handleScenePointer(
        events: UiEvents,
        col: number,
        row: number,
        camera: Camera,
        rasterizer: Rasterizer,
        lights: LightWorld,
    ): void {
        const origin = camera.position;

        if (events.pressed) {
            rasterizer.rayThrough(col + 0.5, row + 0.5, this.ray);
            const hit = this.world.pick(
                lights, origin.x, origin.y, origin.z, this.ray.x, this.ray.y, this.ray.z,
            );
            this.world.selectedId = hit?.id ?? null;
            this.draggingEntity = hit !== null;
            return;
        }

        const selected = this.world.selected;
        if (selected === null) return;

        if (events.wheel !== 0) {
            selected.yaw += events.wheel * WHEEL_YAW;
            return;
        }

        if (!this.draggingEntity || !events.down) return;

        if (events.shift) {
            // Arrastar para cima sobe: a fileira cresce para baixo na tela.
            selected.position.y -= events.deltaY * VERTICAL_DRAG;
            return;
        }

        // Sem Shift, o objeto desliza no plano horizontal da própria altura —
        // o plano em que ele já está, para arrastar não mudar dois eixos de uma
        // vez sem que ninguém tenha pedido.
        rasterizer.rayThrough(col + 0.5, row + 0.5, this.ray);
        if (Math.abs(this.ray.y) < 1e-4) return;

        const distance = (selected.position.y - origin.y) / this.ray.y;
        if (distance <= 0) return;

        selected.position.x = origin.x + this.ray.x * distance;
        selected.position.z = origin.z + this.ray.z * distance;
    }

    draw(framebuffer: Framebuffer): void {
        const layout = this.layout;
        if (!this.open || layout === null) return;

        drawMenu(framebuffer, layout, {
            groups: this.groups,
            items: this.items,
            groupIndex: this.groupIndex,
            itemIndex: this.itemIndex,
            scroll: this.scroll,
            onGroups: this.onGroups,
            hoverItem: this.hoverItem,
        });
    }
}
