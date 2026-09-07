import {copyRgb, rgb} from '../math/color';
import {copy, vec3} from '../math/vec3';
import {traceNearest} from '../light/trace';
import type {LightWorld} from '../light/world';
import {GLYPH} from '../render/palette';
import type {SurfaceStyle} from '../render/rasterizer';
import {SurfacePen} from '../render/shading';
import {BoxShape} from './entities/box';
import {
    ENTITY,
    type EntityKind,
    type EntityKindDef,
    type EntityState,
    createEntity,
    reserveIds,
} from './entities/entity';
import {monolithKind} from './entities/monolith';
import {orbKind} from './entities/orb';
import {panelKind} from './entities/panel';
import type {RenderContext, Renderable} from './scene';

export const ENTITY_KINDS: Record<EntityKind, EntityKindDef> = {
    [ENTITY.ORB]: orbKind,
    [ENTITY.MONOLITH]: monolithKind,
    [ENTITY.PANEL]: panelKind,
};

export const ENTITY_ORDER: readonly EntityKind[] = [ENTITY.ORB, ENTITY.MONOLITH, ENTITY.PANEL];

const STORAGE_KEY = 'cp437-engine/scene';

/** Folga da caixa de seleção, para ela não pousar em cima do wireframe. */
const SELECTION_MARGIN = 0.35;

/**
 * Os objetos da cena e quem manda neles.
 *
 * É o corte que o README previa quando dizia que a hora de separar `settings` de
 * um `gameState` chegaria: `settings` é o que a pessoa configura na engine, isto
 * é o que existe no mundo. A diferença fica clara na persistência — os ajustes
 * são preferência de quem olha, a cena é conteúdo, e só a cena é salva.
 *
 * O `World` é um `Renderable` como qualquer outro: entra na cena pela mesma
 * porta que céu, sol e chão, e ninguém acima dele sabe que ele é diferente.
 */
export class World implements Renderable {
    readonly entities: EntityState[] = [];
    selectedId: number | null = null;

    /**
     * O realce de seleção só aparece no modo de edição.
     *
     * Doze arestas acesas em volta de um objeto é muita tinta para uma cena que
     * está sendo olhada, e não editada — cobre justamente o que se quer ver.
     */
    editing = false;

    /**
     * Uma caneta para todos os objetos.
     *
     * Cada um sobrescreve material e normal antes de desenhar, e nenhum deles
     * guarda estado entre quadros — então uma instância basta, e o custo de
     * cinquenta objetos deixa de incluir cinquenta materiais.
     */
    private readonly pen = new SurfacePen();

    private readonly selectionShape = new BoxShape();

    // Rascunhos do realce de seleção: ele roda por quadro, com doze arestas.
    private readonly selectionTint = rgb(1, 1, 1);
    private readonly edgeStart = vec3();
    private readonly edgeEnd = vec3();
    private selectionPulse = 1;

    /**
     * Estilo do realce: sem iluminação, de propósito.
     *
     * É interface, não cenário, e tem que aparecer igual dentro de uma sombra.
     * A cor é copiada e não apontada — trocar a referência de `out.color` faria
     * o próximo fragmento da cena, que escreve dentro do objeto apontado,
     * sobrescrever esta cor.
     */
    private readonly selectionStyle: SurfaceStyle = (sample, out) => {
        out.glyph = GLYPH.PLUS;
        copyRgb(out.color, this.selectionTint);
        out.alpha = 1;
        out.emissive = this.selectionPulse;
        return sample.depth > 0;
    };

    add(kind: EntityKind): EntityState {
        const entity = createEntity(kind, ENTITY_KINDS[kind].defaults());
        copy(entity.current, entity.position);
        this.entities.push(entity);
        this.selectedId = entity.id;
        return entity;
    }

    remove(id: number): void {
        const index = this.entities.findIndex((entity) => entity.id === id);
        if (index < 0) return;

        this.entities.splice(index, 1);
        if (this.selectedId === id) {
            this.selectedId = this.entities[Math.min(index, this.entities.length - 1)]?.id ?? null;
        }
    }

    find(id: number | null): EntityState | null {
        if (id === null) return null;
        return this.entities.find((entity) => entity.id === id) ?? null;
    }

    get selected(): EntityState | null {
        return this.find(this.selectedId);
    }

    contribute(context: RenderContext): void {
        this.animate(context.time);

        for (const entity of this.entities) {
            if (!entity.visible) continue;
            ENTITY_KINDS[entity.kind].contribute(entity, context.lights);
        }
    }

    render(context: RenderContext): void {
        this.pen.begin(context);

        for (const entity of this.entities) {
            if (!entity.visible) continue;
            ENTITY_KINDS[entity.kind].render(entity, context, this.pen);
        }

        const selected = this.editing ? this.selected : null;
        if (selected !== null) this.drawSelection(selected, context);
    }

    /** A órbita escreve em `current`, nunca em `position`. */
    private animate(timeMs: number): void {
        for (const entity of this.entities) {
            if (entity.orbitRadius <= 0 || entity.orbitSpeed === 0) {
                copy(entity.current, entity.position);
                continue;
            }

            const angle = (timeMs / 1000) * entity.orbitSpeed;
            entity.current.x = entity.position.x + Math.cos(angle) * entity.orbitRadius;
            entity.current.y = entity.position.y;
            entity.current.z = entity.position.z + Math.sin(angle) * entity.orbitRadius;
        }
    }

    /**
     * Caixa de seleção em volta do objeto escolhido.
     *
     * Sem realce, mover um objeto que está fora de vista é adivinhação: os
     * sliders mudam números e nada acontece na tela. A caixa é desenhada sem
     * iluminação de propósito — ela é interface, não cenário, e tem que
     * aparecer igual dentro de uma sombra.
     */
    private drawSelection(entity: EntityState, context: RenderContext): void {
        const {rasterizer} = context;
        const shape = this.selectionShape;
        const {size} = entity;

        // Uma folga em volta, para a caixa não coincidir com as arestas do
        // próprio objeto e virar ruído em cima delas.
        shape.update(
            entity.current, entity.yaw, entity.pitch,
            size.x + SELECTION_MARGIN, size.y + SELECTION_MARGIN, size.z + SELECTION_MARGIN,
        );

        this.selectionPulse = 0.55 + 0.45 * Math.sin(context.time / 180);

        for (const edge of shape.edges) {
            shape.corner(edge.a, this.edgeStart);
            shape.corner(edge.b, this.edgeEnd);
            rasterizer.line(
                this.edgeStart.x, this.edgeStart.y, this.edgeStart.z,
                this.edgeEnd.x, this.edgeEnd.y, this.edgeEnd.z,
                this.selectionStyle,
            );
        }
    }

    /**
     * Qual objeto está sob um raio.
     *
     * Reaproveita o mesmo traçado que faz sombra e reflexo, contra os mesmos
     * corpos: o que o clique acerta é, por construção, o que projeta sombra e
     * aparece no espelho. Um código de seleção próprio poderia discordar dos
     * outros dois, e discordaria justo quando alguém girasse um objeto.
     */
    pick(
        lights: LightWorld,
        ox: number, oy: number, oz: number,
        dx: number, dy: number, dz: number,
    ): EntityState | null {
        const hit = traceNearest(lights, ox, oy, oz, dx, dy, dz, 1000, Number.NaN);
        return hit === null ? null : this.find(hit.ownerId);
    }

    /**
     * Cena de demonstração.
     *
     * Três orbes coloridos em órbitas diferentes, três monólitos entre eles e o
     * chão, e um painel virado para o sol. Cada peça existe para provar uma
     * parte: os orbes são a luz colorida, os monólitos são a sombra, o painel é
     * o reflexo com raio de verdade.
     */
    loadDemo(): void {
        this.entities.length = 0;

        const orb = (x: number, y: number, z: number, color: [number, number, number],
                     orbitRadius: number, speed: number, name: string): void => {
            const entity = this.add(ENTITY.ORB);
            entity.name = name;
            entity.position.x = x;
            entity.position.y = y;
            entity.position.z = z;
            entity.color.r = color[0];
            entity.color.g = color[1];
            entity.color.b = color[2];
            entity.orbitRadius = orbitRadius;
            entity.orbitSpeed = speed;
        };

        orb(0, 7, -34, [0.15, 0.95, 1], 16, 0.35, 'Cyan Orb');
        orb(0, 5.5, -46, [1, 0.25, 0.75], 24, -0.22, 'Magenta Orb');
        orb(-8, 9, -24, [0.5, 1, 0.55], 11, 0.5, 'Green Orb');

        const monolith = (x: number, z: number, height: number, name: string): void => {
            const entity = this.add(ENTITY.MONOLITH);
            entity.name = name;
            entity.position.x = x;
            entity.position.y = height;
            entity.position.z = z;
            entity.size.y = height;
            entity.yaw = (x + z) * 0.03;
        };

        monolith(12, -32, 7, 'Monolith east');
        monolith(-16, -44, 10, 'Monolith west');
        monolith(4, -58, 5, 'Monolith north');

        // O painel fica de lado e virado para dentro: é a orientação em que o
        // olhar do jogador, espelhado nele, sai na direção do sol e dos
        // monólitos. De frente ele refletiria o céu vazio atrás da câmera.
        const panel = this.add(ENTITY.PANEL);
        panel.name = 'Reflective panel';
        panel.position.x = -16;
        panel.position.y = 7;
        panel.position.z = -30;
        panel.size.x = 8;
        panel.size.y = 6;
        panel.yaw = 1.15;

        this.selectedId = null;
    }

    /** A cena montada sobrevive ao reload; os ajustes da engine não. */
    save(): void {
        const plain = this.entities.map(({current: _current, ...rest}) => rest);
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(plain));
        } catch {
            //perder a cena salva não pode derrubar

        }
    }

    /** Devolve `false` quando não há nada salvo, e a demo entra no lugar. */
    load(): boolean {
        let raw: string | null = null;
        try {
            raw = localStorage.getItem(STORAGE_KEY);
        } catch {
            return false;
        }
        if (raw === null) return false;

        try {
            const parsed = JSON.parse(raw) as EntityState[];
            if (!Array.isArray(parsed) || parsed.length === 0) return false;

            this.entities.length = 0;
            for (const entity of parsed) {
                if (ENTITY_KINDS[entity.kind] === undefined) continue;
                entity.current = vec3();
                copy(entity.current, entity.position);
                this.entities.push(entity);
            }
            reserveIds(this.entities);
            this.selectedId = null;
            return this.entities.length > 0;
        } catch {
            return false;
        }
    }
}
