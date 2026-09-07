import { type Rgb, rgb, setRgb } from '../math/color';
import * as mat4 from '../math/mat4';
import { set, vec3 } from '../math/vec3';
import { LIGHT, type Light, OCCLUDER, type Occluder, type SkyModel } from './types';

const createLight = (): Light => ({
    kind: LIGHT.POINT,
    position: vec3(),
    direction: vec3(0, 1, 0),
    color: rgb(1, 1, 1),
    intensity: 1,
    range: 1,
    castsShadow: true,
    coneCos: -1,
    coneSoftness: 0.05,
});

const createOccluder = (): Occluder => ({
    kind: OCCLUDER.SPHERE,
    center: vec3(),
    radius: 1,
    half: vec3(1, 1, 1),
    toLocal: mat4.identity(mat4.create()),
    tint: rgb(),
    castsShadow: true,
    ownerId: -1,
});

/**
 * Tudo que o sombreamento precisa saber sobre a cena, por quadro.
 *
 * Reconstruído do zero a cada quadro, mas nunca realocado: as luzes e os corpos
 * vêm de um pool que só cresce. Sem isso, uma cena com trinta objetos entregaria
 * setenta objetos ao coletor de lixo sessenta vezes por segundo, e o soluço
 * apareceria como engasgo na câmera.
 *
 * É também a fronteira que mantém `light/` sem saber o que é uma entidade: os
 * objetos se descrevem como luzes e corpos, e o sombreamento só vê isso.
 */
export class LightWorld {
    /** Luz que chega de todo lado. Sem ela, o que está na sombra some. */
    readonly ambient: Rgb = rgb();

    readonly sky: SkyModel = {
        sunDirection: vec3(0, 1, 0),
        sunColor: rgb(1, 1, 1),
        sunRadius: 0.1,
        sunIntensity: 1,
        intensity: 1,
    };

    private readonly lightPool: Light[] = [];
    private readonly occluderPool: Occluder[] = [];

    private lights = 0;
    private occluders = 0;

    get lightCount(): number {
        return this.lights;
    }

    get occluderCount(): number {
        return this.occluders;
    }

    light(index: number): Light {
        return this.lightPool[index]!;
    }

    occluder(index: number): Occluder {
        return this.occluderPool[index]!;
    }

    begin(): void {
        this.lights = 0;
        this.occluders = 0;
        setRgb(this.ambient, 0, 0, 0);
    }

    /** Devolve uma luz zerada do pool. Quem chamou preenche os campos. */
    addLight(): Light {
        if (this.lights === this.lightPool.length) this.lightPool.push(createLight());

        const light = this.lightPool[this.lights]!;
        this.lights += 1;

        light.kind = LIGHT.POINT;
        set(light.position, 0, 0, 0);
        set(light.direction, 0, 1, 0);
        setRgb(light.color, 1, 1, 1);
        light.intensity = 1;
        light.range = 1;
        light.castsShadow = true;
        light.coneCos = -1;
        light.coneSoftness = 0.05;
        return light;
    }

    /**
     * Devolve um corpo zerado do pool.
     *
     * `ownerId` é obrigatório e não tem valor padrão de propósito: é ele que
     * deixa uma superfície não se sombrear com o próprio corpo, e um corpo que
     * esquecesse de se identificar ficaria invisível para quem passasse o
     * mesmo padrão — uma sombra que some sem erro nenhum.
     */
    addOccluder(ownerId: number): Occluder {
        if (this.occluders === this.occluderPool.length) {
            this.occluderPool.push(createOccluder());
        }

        const occluder = this.occluderPool[this.occluders]!;
        this.occluders += 1;

        occluder.kind = OCCLUDER.SPHERE;
        set(occluder.center, 0, 0, 0);
        occluder.radius = 1;
        set(occluder.half, 1, 1, 1);
        mat4.identity(occluder.toLocal);
        setRgb(occluder.tint, 0, 0, 0);
        occluder.castsShadow = true;
        occluder.ownerId = ownerId;
        return occluder;
    }
}
