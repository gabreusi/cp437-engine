import { copyRgb, scaleRgb } from '../../math/color';
import { type Vec3, copy, vec3 } from '../../math/vec3';
import { OCCLUDER } from '../../light/types';
import type { LightWorld } from '../../light/world';
import type { SurfacePen } from '../../render/shading';
import type { RenderContext } from '../scene';
import { BoxShape } from './box';
import {
    COMMON_FIELDS,
    type EntityKindDef,
    type EntityState,
    ROTATION_FIELDS,
    colorFields,
    sizeFields,
} from './entity';

/**
 * Placa refletiva: onde o raio de espelho tem o que mostrar.
 *
 * A face é preenchida com hachura — linhas paralelas próximas — e não com um
 * rasterizador de polígono novo. Duas razões: reaproveita inteiro o caminho de
 * clipping, DDA e profundidade que já existe, e mantém a identidade da engine,
 * onde tudo é linha. O custo é o mesmo de desenhar as linhas, e cada fragmento
 * ganha posição de mundo de graça, que é o que o reflexo precisa.
 */

const shape = new BoxShape();
const start: Vec3 = vec3();
const end: Vec3 = vec3();
const normal: Vec3 = vec3();

/**
 * Folga entre linhas da hachura, em células de tela.
 *
 * Um significa "linhas vizinhas em células vizinhas", que é a condição exata
 * para não sobrar buraco. Abaixo de um seria desenhar duas vezes na mesma
 * célula; acima, a placa deixa de ser opaca e se enxerga através dela.
 */
const HATCH_SPACING_CELLS = 1;

/**
 * Teto de linhas, como múltiplo da altura da janela em fileiras.
 *
 * O limite real é a tela: uma placa não pode precisar de muito mais linhas do
 * que a janela tem fileiras. A folga de três existe porque a hachura é
 * distribuída pela face inteira, e uma placa maior que a tela gasta boa parte
 * das linhas fora dela — a folga é o que mantém a parte visível fechada.
 * Amarrar o teto ao
 * viewport, e não a um número fixo, é o que impede o custo de acompanhar o
 * tamanho da placa em unidades de mundo — que era o defeito da versão anterior
 * na direção oposta.
 */
const MAX_HATCH_SCREENS = 3;

const MIRROR_TINT = 0.3;

export const panelKind: EntityKindDef = {
    label: 'Panel',

    defaults: () => ({
        name: 'panel',
        size: { x: 6, y: 4, z: 0.25 },
        color: { r: 0.72, g: 0.86, b: 1 },
        intensity: 0.18,
        reflectivity: 0.92,
        gloss: 220,
        mirror: true,
        castsShadow: true,
        position: { x: -12, y: 5, z: -26 },
        yaw: 0.5,
    }),

    contribute: (entity: EntityState, world: LightWorld): void => {
        shape.update(entity.current, entity.yaw, entity.pitch, entity.size.x, entity.size.y, entity.size.z);

        const occluder = world.addOccluder(entity.id);
        occluder.kind = OCCLUDER.BOX;
        copy(occluder.center, entity.current);
        copy(occluder.half, entity.size);
        occluder.toLocal.set(shape.toLocal);
        occluder.castsShadow = entity.castsShadow;
        scaleRgb(occluder.tint, entity.color, MIRROR_TINT);
    },

    render: (entity: EntityState, context: RenderContext, pen: SurfacePen): void => {
        const { rasterizer } = context;
        shape.update(entity.current, entity.yaw, entity.pitch, entity.size.x, entity.size.y, entity.size.z);

        pen.ownerId = entity.id;
        copyRgb(pen.material.albedo, entity.color);
        copyRgb(pen.material.emissive, entity.color);
        pen.material.emissiveStrength = entity.intensity;
        pen.material.reflectivity = entity.reflectivity;
        pen.material.gloss = entity.gloss;
        pen.material.mirror = entity.mirror;

        // A face é o plano local z = +meia-espessura. Uma normal só para tudo
        // que é desenhado nela: é uma placa plana, não uma caixa.
        const { x: halfX, y: halfY, z: halfZ } = entity.size;
        shape.toWorldDirection(0, 0, 1, normal);
        pen.normal(normal.x, normal.y, normal.z);

        const face = (
            x0: number, y0: number, x1: number, y1: number,
        ): void => {
            shape.toWorldPoint(x0, y0, halfZ, start);
            shape.toWorldPoint(x1, y1, halfZ, end);
            rasterizer.line(start.x, start.y, start.z, end.x, end.y, end.z, pen.style);
        };

        // Moldura.
        face(-halfX, -halfY, halfX, -halfY);
        face(-halfX, halfY, halfX, halfY);
        face(-halfX, -halfY, -halfX, halfY);
        face(halfX, -halfY, halfX, halfY);

        // Hachura com densidade decidida na tela, não no mundo.
        //
        // A versão anterior contava linhas por unidade de mundo, o que erra nas
        // duas pontas: de longe desenhava vinte linhas que caíam nas mesmas
        // três fileiras, e de perto deixava uma fileira vazia entre cada duas —
        // e um espelho que se enxerga através não é um espelho.
        //
        // A medida é feita nas duas arestas verticais e vale a maior: com a
        // placa inclinada, a aresta próxima é a que abre buraco primeiro.
        shape.toWorldPoint(-halfX, -halfY, halfZ, start);
        shape.toWorldPoint(-halfX, halfY, halfZ, end);
        const leftSpan = rasterizer.screenSpan(
            start.x, start.y, start.z, end.x, end.y, end.z,
        );

        shape.toWorldPoint(halfX, -halfY, halfZ, start);
        shape.toWorldPoint(halfX, halfY, halfZ, end);
        const rightSpan = rasterizer.screenSpan(
            start.x, start.y, start.z, end.x, end.y, end.z,
        );

        const maxRows = context.viewport.rowCount * MAX_HATCH_SCREENS;
        const span = Math.max(leftSpan, rightSpan);
        const rows = Number.isFinite(span)
            ? Math.min(maxRows, Math.max(1, Math.ceil(span / HATCH_SPACING_CELLS)))
            : maxRows;

        for (let index = 1; index < rows; index += 1) {
            const y = -halfY + (index / rows) * halfY * 2;
            face(-halfX, y, halfX, y);
        }
    },

    fields: [
        ...COMMON_FIELDS,
        ...ROTATION_FIELDS,
        ...sizeFields(['Width', 'Height', 'Depth']),
        ...colorFields(),
        {
            label: 'Reflectivity', min: 0, max: 1, step: 0.02, digits: 2,
            get: (e) => e.reflectivity,
            set: (e, v) => { e.reflectivity = v; },
        },
        {
            label: 'Gloss', min: 2, max: 400, step: 2,
            get: (e) => e.gloss,
            set: (e, v) => { e.gloss = v; },
        },
        {
            label: 'Glow intensity', min: 0, max: 2, step: 0.02, digits: 2,
            get: (e) => e.intensity,
            set: (e, v) => { e.intensity = v; },
        },
    ],
};
