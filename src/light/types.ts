import type { Rgb } from "../math/color";
import type { Mat4 } from "../math/mat4";
import type { Vec3 } from "../math/vec3";

export const LIGHT = {
  /** Sol e lua: sem posição, sem atenuação, sombra paralela. */
  DIRECTIONAL: 0,
  POINT: 1,
  /** Cone. É o holofote, e o farol quando o jogo tiver um carro. */
  SPOT: 2,
} as const;

export type LightKind = (typeof LIGHT)[keyof typeof LIGHT];

export interface Light {
  kind: LightKind;
  /** Posição em mundo. Ignorada na direcional. */
  position: Vec3;
  /**
   * Direcional: para onde fica a fonte, saindo da superfície.
   * Spot: o eixo do cone, apontando para onde ele ilumina.
   */
  direction: Vec3;
  color: Rgb;
  intensity: number;
  /**
   * Alcance em unidades de mundo.
   *
   * Não é só estética: é o que deixa cortar a luz por distância antes de
   * qualquer conta, e é o que torna dezenas de luzes viáveis numa CPU.
   */
  range: number;
  castsShadow: boolean;
  /** Cosseno do meio-ângulo do cone. `-1` significa sem cone. */
  coneCos: number;
  /** Largura da borda macia do cone, em cosseno. */
  coneSoftness: number;
  /**
   * `ownerId` do espelho que gerou esta luz por reflexo, ou `-1` para uma
   * luz de verdade.
   *
   * Só quem enxerga esse espelho exatamente nesta direção recebe a luz —
   * é o que contém o reflexo dentro da superfície real, em vez de vazar
   * como um segundo sol espalhado pela cena. Ver `light/mirror-bounce.ts`
   * e o ramo de abertura em `render/gpu/passes/shading.ts::shadeCore`.
   */
  apertureOwnerId: number;
}

export const OCCLUDER = {
  SPHERE: 0,
  BOX: 1,
} as const;

export type OccluderKind = (typeof OCCLUDER)[keyof typeof OCCLUDER];

/**
 * Um corpo que o raio pode acertar.
 *
 * Deliberadamente separado da malha que o objeto desenha: o traçado precisa de
 * uma forma analítica, e a malha é wireframe — um raio não acerta aresta. Uma
 * caixa e uma esfera cobrem tudo que a cena vai ter, e o custo por teste é
 * constante, o que é o que permite fazer isto por célula.
 */
export interface Occluder {
  kind: OccluderKind;
  center: Vec3;
  /** Esfera. */
  radius: number;
  /** Caixa: meias-extensões no espaço local do objeto. */
  half: Vec3;
  /**
   * Mundo para o espaço local da caixa.
   *
   * Guardar a matriz em vez de ângulos deixa o teste de caixa ser o teste
   * alinhado aos eixos de sempre, e reaproveita `mat4.setView`, que já é
   * exatamente "rotaciona por yaw e pitch e translada" em forma fechada.
   */
  toLocal: Mat4;
  /**
   * Raio da esfera que envolve a caixa inteira, recalculado uma vez por
   * quadro em `LightWorld.finalize()`. Dá escala ao bias de autossombra da
   * caixa (`SELF_SHADOW_FRACTION` em `trace.ts`) sem um valor mágico fixo.
   * Ignorado por esferas.
   */
  boundRadius: number;
  /** O que um raio de reflexão enxerga ao acertar este corpo. */
  tint: Rgb;
  /**
   * Material de verdade do dono, para `shadeOccluders` calcular `tint` a
   * partir da luz que bate aqui — e não de uma fração fixa da cor crua.
   * `null` para um corpo sem material próprio (nenhum hoje).
   */
  material: Material | null;
  castsShadow: boolean;
  /** Quem pediu o occluder. É por aqui que o clique seleciona um objeto. */
  ownerId: number;
}

/**
 * Como uma superfície responde à luz.
 *
 * O objeto é dono do material; a superfície muda de normal a cada aresta, então
 * a normal fica fora daqui e viaja por argumento — é o que evita alocar um
 * material por fragmento.
 */
export interface Material {
  albedo: Rgb;
  /** Brilho próprio, somado no fim e independente de qualquer luz. */
  emissive: Rgb;
  emissiveStrength: number;
  /** Quanto do reflexo entra na cor final, de 0 a 1. */
  reflectivity: number;
  /**
   * Expoente do lóbulo especular.
   *
   * Baixo espalha o reflexo por meio céu — é a grade, que reflete sem ser
   * espelho. Alto o aperta até virar imagem, que é o painel.
   */
  gloss: number;
  /** Dispara raio de reflexão contra os occluders, além do céu. */
  mirror: boolean;
}

/**
 * O céu como fonte de luz, e não como pintura.
 *
 * O sol vira duas coisas ao mesmo tempo: uma luz direcional na lista, que
 * produz difuso e sombra, e este disco, que é o que um raio de reflexão vê.
 * São a mesma direção, preenchida do mesmo lugar, para o reflexo não apontar
 * para onde o sol não está.
 */
export interface SkyModel {
  /** Direção unitária apontando para o sol. */
  sunDirection: Vec3;
  sunColor: Rgb;
  /** Raio angular do disco, em radianos. */
  sunRadius: number;
  sunIntensity: number;
  /** Multiplicador geral do céu no reflexo. */
  intensity: number;

  /**
   * Quanto o sol acende as camadas do céu — o roxo, o ciano e o rosa.
   *
   * Elas são luz do sol espalhada pela atmosfera, e antes eram constantes:
   * o céu ficava igual com o sol a quatro graus ou a quarenta, com um disco
   * pequeno ou enorme, e continuava rosa depois de o sol se pôr. Zero apaga
   * as três, que é o que o interruptor do sol e a noite precisam.
   */
  sunGlow: number;
  /**
   * Quanto a faixa colada no horizonte está acesa.
   *
   * Separada de `sunGlow` porque não responde à mesma coisa: o halo em volta
   * do disco acompanha o sol para onde ele for, e a faixa do horizonte é um
   * poente — ela é do sol *rasante*, e esmaece conforme ele sobe. Não chega a
   * zero: sem nenhuma atmosfera o vão entre a grade e o céu vira degrau.
   */
  horizonGlow: number;
  /**
   * Largura do halo em volta do disco, relativa ao sol padrão.
   *
   * O halo é do disco, então cresce com ele. Sem isto, um sol de trinta graus
   * ficava com a mesma auréola de um de três, e o disco vazava para fora dela.
   */
  sunSpread: number;

  /**
   * Estrelas visíveis, para o reflexo mostrar as mesmas que o céu pinta —
   * não um ruído independente, que divergiria do fundo. Publicado por
   * `Sky.contribute()`; `skyRadiance` só lê.
   */
  stars: ReadonlyArray<{ x: number; y: number; z: number; color: Rgb }>;
}
