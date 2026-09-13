import { type Rgb, rgb, setRgb } from "../math/color";
import * as mat4 from "../math/mat4";
import { set, vec3 } from "../math/vec3";
import {
  LIGHT,
  type Light,
  type Material,
  OCCLUDER,
  type Occluder,
  type SkyModel,
} from "./types";

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
  apertureOwnerId: -1,
});

const createOccluder = (): Occluder => ({
  kind: OCCLUDER.SPHERE,
  center: vec3(),
  radius: 1,
  half: vec3(1, 1, 1),
  toLocal: mat4.identity(mat4.create()),
  boundRadius: 0,
  tint: rgb(),
  material: null,
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
    sunLightColor: rgb(1, 1, 1),
    sunRadius: 0.1,
    sunIntensity: 1,
    intensity: 1,
    sunGlow: 1,
    horizonGlow: 1,
    sunSpread: 1,
    stars: [],
  };

  /**
   * Material de verdade do chão, para o raio de espelho ver a cor certa —
   * publicado por `Ground.contribute()`. `null` sem chão na cena.
   */
  groundMaterial: Material | null = null;

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
    this.groundMaterial = null;
  }

  /** Devolve uma luz zerada do pool. Quem chamou preenche os campos. */
  addLight(): Light {
    if (this.lights === this.lightPool.length)
      this.lightPool.push(createLight());

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
    light.apertureOwnerId = -1;
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
    occluder.boundRadius = 0;
    setRgb(occluder.tint, 0, 0, 0);
    occluder.material = null;
    occluder.castsShadow = true;
    occluder.ownerId = ownerId;
    return occluder;
  }

  /**
   * Pré-calcula o raio da esfera que envolve cada caixa — escala do bias de
   * autossombra em `trace.ts` (`SELF_SHADOW_FRACTION`). Uma vez aqui evita
   * recalcular a mesma raiz quadrada em cada um dos milhares de raios que
   * testam a mesma parede no mesmo quadro.
   *
   * Chamado depois que todo `contribute()` do quadro terminou: só então
   * `half` de toda caixa está definitivo.
   */
  finalize(): void {
    for (let index = 0; index < this.occluders; index += 1) {
      const occluder = this.occluderPool[index]!;
      if (occluder.kind !== OCCLUDER.BOX) continue;

      const { half } = occluder;
      occluder.boundRadius = Math.sqrt(
        half.x * half.x + half.y * half.y + half.z * half.z,
      );
    }
  }
}
