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
 * Caixa em wireframe que recebe luz e projeta sombra.
 *
 * É o objeto de prova do sistema: as doze arestas são sombreadas cada uma com a
 * normal da sua própria costura, então a face voltada para um orbe ciano fica
 * ciano e a oposta fica no ambiente; e o corpo dele apaga as linhas da grade
 * que estão atrás, na direção oposta a cada luz.
 */

const shape = new BoxShape();
const start: Vec3 = vec3();
const end: Vec3 = vec3();
const normal: Vec3 = vec3();

/** Quanto de si a caixa devolve num espelho. Escuro: é volume, não lâmpada. */
const MIRROR_TINT = 0.35;

export const monolithKind: EntityKindDef = {
    label: 'Monolith',

    defaults: () => ({
        name: 'monolith',
        size: { x: 2, y: 6, z: 2 },
        color: { r: 0.36, g: 0.85, b: 1 },
        intensity: 0.5,
        reflectivity: 0.22,
        gloss: 30,
        castsShadow: true,
        position: { x: 10, y: 6, z: -30 },
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

        // A mesma matriz do corpo registrado: `contribute` já rodou neste
        // quadro, mas recalcular é barato e não amarra o desenho àquela ordem.
        shape.update(entity.current, entity.yaw, entity.pitch, entity.size.x, entity.size.y, entity.size.z);

        pen.ownerId = entity.id;
        copyRgb(pen.material.albedo, entity.color);
        copyRgb(pen.material.emissive, entity.color);
        pen.material.emissiveStrength = entity.intensity;
        pen.material.reflectivity = entity.reflectivity;
        pen.material.gloss = entity.gloss;
        pen.material.mirror = entity.mirror;

        for (const edge of shape.edges) {
            shape.corner(edge.a, start);
            shape.corner(edge.b, end);
            shape.toWorldDirection(edge.nx, edge.ny, edge.nz, normal);

            pen.normal(normal.x, normal.y, normal.z);
            rasterizer.line(start.x, start.y, start.z, end.x, end.y, end.z, pen.style);
        }
    },

    fields: [
        ...COMMON_FIELDS,
        ...ROTATION_FIELDS,
        ...sizeFields(['Width', 'Height', 'Depth']),
        ...colorFields(),
        {
            label: 'Glow intensity', min: 0, max: 3, step: 0.05, digits: 2,
            get: (e) => e.intensity,
            set: (e, v) => { e.intensity = v; },
        },
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
    ],
};
