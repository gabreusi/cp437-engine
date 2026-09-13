import { degreesToRadians, settings } from "../config";
import { copyRgb, rgb, scaleRgb, type Rgb } from "../math/color";
import { copy } from "../math/vec3";
import { LIGHT } from "../light/types";
import { SUN_SHADES } from "../render/palette";
import { glyphForDiscEdge } from "../render/ramp";
import { createProjected } from "../render/rasterizer";
import { CELL_ASPECT } from "../render/viewport";
import type { RenderContext, Renderable } from "./scene";

/**
 * Abaixo de que elevação o sol para de iluminar, e em quanto tempo.
 *
 * O disco continua visível recortado no horizonte depois disso — é a estética
 * outrun — mas um sol enterrado que ainda projetasse sombras longas denunciaria
 * que o disco e a luz são a mesma coisa só por coincidência.
 */
const SET_BELOW = -0.05;
const SET_SPAN = 0.28;

/**
 * Onde o céu para de espalhar luz do sol, e em quanto tempo.
 *
 * Mais fundo e mais largo que a queda da luz direta, e não por descuido: a luz
 * direcional já vale pouco com o disco encostado no horizonte — é rasante e não
 * ilumina quase nada — mas o poente continua aceso, porque o que brilha ali é a
 * atmosfera iluminada por baixo. Usar a mesma curva apagaria o rosa com o sol
 * ainda em vista, que é justamente a hora em que ele deveria estar mais forte.
 */
const GLOW_BELOW = -0.2;
const GLOW_SPAN = 0.22;

/** Quanto o topo do disco passa de 1. É o que o bloom transforma em halo. */
const SUN_EMISSIVE = 0.85;
const SUN_TOP_BRIGHTNESS = 1 + SUN_EMISSIVE;

/**
 * Base do disco: baixo o bastante para `glyphForDiscEdge` escolher um glifo
 * quase vazio, sem chegar a zero — o vazio de verdade fica por conta do
 * recorte do horizonte, não desta rampa.
 */
const SUN_BOTTOM_BRIGHTNESS = 0.15;

/** Rascunho de módulo: cor final de uma célula do disco, já com o brilho aplicado. */
const tint: Rgb = rgb();

/**
 * O sol com que os pesos do céu foram escolhidos.
 *
 * As camadas de `sky-colors.ts` foram afinadas à mão, olhando para a cena
 * padrão. Normalizar por este sol de referência é o que faz os sliders
 * significarem alguma coisa sem repintar o céu: no valor padrão o fator é 1 e a
 * arte é exatamente a que sempre foi.
 */
const REFERENCE_INTENSITY = 0.9;
const REFERENCE_SIZE_DEGREES = 13;

/** Teto do fator de brilho: um sol três vezes mais forte não lava a tela. */
const MAX_GLOW = 2;

/** Faixa de larguras do halo, para o sol mínimo e o máximo não exagerarem. */
const MIN_SPREAD = 0.35;
const MAX_SPREAD = 2.5;

/**
 * Altura em que o céu deixa de ser um poente.
 *
 * Medida em `y` da direção, que é o seno da elevação: 0.42 é o seno de vinte e
 * cinco graus. Acima disso a faixa do horizonte já esmaeceu até o piso.
 */
const HORIZON_GLOW_SPAN = 0.42;

/** Piso da faixa: ela esmaece, não some. Sem nada ali o vão vira degrau. */
const HORIZON_GLOW_FLOOR = 0.15;

/**
 * As fatias horizontais do sol — a assinatura visual do estilo outrun.
 *
 * Só a metade de baixo é fatiada, e a última faixa fica inteira para o sol
 * assentar no horizonte em vez de terminar picotado.
 *
 * Duas configurações diretas, cada uma controlando uma coisa só: `sunSliceRows`
 * é quantas fileiras de tela cada fatia ocupa — maior é fatia mais grossa, ou
 * seja, menos fatias — e `sunSliceGap` é quanto de cada fatia vira vão. Antes
 * disso um único slider (`sunSlices`) tentava fazer as duas coisas ao mesmo
 * tempo — mais fatias também apertava o vão — e as duas pontas do range
 * colapsavam em quase nada visível: fatias finas demais para a resolução de
 * tela de um lado, vão grande demais engolindo o disco do outro.
 *
 * O retorno não é um `bool` de "tem vão ou não": é um multiplicador de brilho,
 * suave só bem perto das bordas do vão e achatado no mínimo (nunca zero) por
 * todo o resto dele — quem decide o glifo ali é o casamento de forma/cobertura
 * de `glyphForDiscEdge`, a mesma ferramenta que qualquer disco da engine usa,
 * não mais um corte binário que pulava a célula inteira. O achatamento importa
 * mais do que parece: a assinatura outrun depende do vão ler como um corte
 * decidido, e um vão de meia-senoide (mínimo só num instante) se perdia fácil
 * quando cabiam poucas fileiras de tela nele — quase sempre o caso, já que só
 * a metade de baixo do disco é fatiada.
 */
const SLICE_START_FRACTION = 0.5;
const BASE_STRIPE_FRACTION = 0.08;
/** Nunca some de vez: um vão apagado ainda deixa `glyphForDiscEdge` escolher algo esparso. */
const SLICE_GAP_MIN_BRIGHTNESS = 0.04;
/** Fração de cada vão gasta suavizando cada borda; o meio fica no mínimo. */
const SLICE_GAP_EDGE_SOFTNESS = 0.25;
/** Os vãos engrossam conforme descem, o que sugere o sol afundando. */
const SLICE_GAP_GROWTH = 0.4;

const sunSliceBrightness = (localRow: number, sunRowCount: number): number => {
  const sliceStartRow = sunRowCount * SLICE_START_FRACTION;
  if (localRow < sliceStartRow) return 1;

  const baseStripeRows = Math.max(2, Math.round(sunRowCount * BASE_STRIPE_FRACTION));
  if (localRow >= sunRowCount - baseStripeRows) return 1;

  const sliceSpan = sunRowCount - sliceStartRow;
  const sliceDepth = (localRow - sliceStartRow) / sliceSpan;

  const bandCount = Math.max(2, Math.round(sliceSpan / settings.sunSliceRows));
  const bandPhase = (sliceDepth * bandCount) % 1;

  const gapShare = Math.min(
    0.85,
    settings.sunSliceGap * (1 + sliceDepth * SLICE_GAP_GROWTH),
  );
  if (bandPhase >= gapShare) return 1;

  // Trapézio, não senoide: achatado no mínimo por boa parte do vão, suaviza
  // só nas pontas — para o vão ler como corte mesmo cabendo só 1-2 fileiras.
  const gapDepth = bandPhase / gapShare;
  const dip =
    gapDepth < SLICE_GAP_EDGE_SOFTNESS
      ? gapDepth / SLICE_GAP_EDGE_SOFTNESS
      : gapDepth > 1 - SLICE_GAP_EDGE_SOFTNESS
        ? (1 - gapDepth) / SLICE_GAP_EDGE_SOFTNESS
        : 1;
  return 1 - dip * (1 - SLICE_GAP_MIN_BRIGHTNESS);
};

/**
 * Direção do sol em coordenadas de mundo.
 *
 * Azimute 0 aponta para -Z, que é para onde a câmera olha com yaw zero.
 * Exportada porque o gradiente de fundo precisa da mesma direção, e duplicar a
 * fórmula deixaria o halo e o disco se separarem na primeira mudança.
 */
export const sunDirection = (out: {
  x: number;
  y: number;
  z: number;
}): void => {
  const azimuth = degreesToRadians(settings.sunAzimuth);
  const elevation = degreesToRadians(settings.sunElevation);
  const cosElevation = Math.cos(elevation);

  out.x = Math.sin(azimuth) * cosElevation;
  out.y = Math.sin(elevation);
  out.z = -Math.cos(azimuth) * cosElevation;
};

/**
 * O sol como corpo celeste, não mais como círculo em coordenadas de tela.
 *
 * Posição vem de azimute e elevação, e é projetada como direção: sem
 * translação, então andar não o move e girar move. O disco em si continua sendo
 * preenchido em espaço de tela, o que é correto para algo no infinito — ele
 * sempre encara a câmera.
 */
export class Sun implements Renderable {
  private readonly center = createProjected();
  private readonly direction = { x: 0, y: 0, z: -1 };

  /**
   * O sol se declara duas vezes, e de propósito.
   *
   * Como luz direcional ele produz difuso e sombra; como disco no modelo de
   * céu ele é o que um raio de reflexão encontra. São a mesma direção,
   * preenchida aqui, no mesmo lugar — separá-las deixaria o reflexo do sol na
   * grade apontando para onde o sol não está.
   */
  contribute({ lights }: RenderContext): void {
    sunDirection(this.direction);

    // `direction.y` é o seno da elevação: a direção é unitária.
    const above = settings.sunEnabled
      ? Math.max(0, Math.min(1, (this.direction.y - SET_BELOW) / SET_SPAN))
      : 0;
    const tone = SUN_SHADES[0]!;
    // Cor da luz em si, separada do topo do disco de propósito: o topo é
    // amarelo (SUN_SHADES[0]), e amarelo tem o canal verde alto — igual o
    // ciano da grade. Luz amarela em superfície ciano soma verde nos dois
    // e sobra verde puro, sem querer. Um tom mais magenta da mesma rampa
    // reprime o verde e deixa azul+vermelho, que é roxo/rosa contra o ciano
    // — ainda "a cor do sol", só que uma fatia mais baixa do gradiente.
    const lightTone = SUN_SHADES[6]!;

    // Desligado, o sol não entra na lista: uma luz de intensidade zero
    // custaria o mesmo teste por fragmento para não fazer nada, e ainda
    // apareceria na contagem do HUD como se estivesse iluminando.
    if (above > 0) {
      const light = lights.addLight();
      light.kind = LIGHT.DIRECTIONAL;
      copy(light.direction, this.direction);
      copyRgb(light.color, lightTone);
      light.intensity = settings.sunLightIntensity * above;
      light.range = Infinity;
      light.castsShadow = true;
    }

    const { sky } = lights;
    copy(sky.sunDirection, this.direction);
    copyRgb(sky.sunColor, tone);
    copyRgb(sky.sunLightColor, lightTone);
    sky.sunRadius = degreesToRadians(settings.sunAngularSize);
    sky.sunIntensity = above;
    sky.intensity = settings.skyReflectionIntensity;

    // O que o céu espalha do sol. É o mesmo número para o gradiente pintado
    // atrás da cena e para o raio de reflexo que sai da grade: separá-los
    // deixaria a grade refletindo um poente que não está mais pintado.
    const lit = settings.sunEnabled
      ? Math.max(0, Math.min(1, (this.direction.y - GLOW_BELOW) / GLOW_SPAN))
      : 0;
    sky.sunGlow =
      lit *
      Math.min(MAX_GLOW, settings.sunLightIntensity / REFERENCE_INTENSITY);
    sky.horizonGlow =
      HORIZON_GLOW_FLOOR +
      (1 - HORIZON_GLOW_FLOOR) *
        (1 - Math.min(1, Math.max(0, this.direction.y / HORIZON_GLOW_SPAN)));
    sky.sunSpread = Math.min(
      MAX_SPREAD,
      Math.max(MIN_SPREAD, settings.sunAngularSize / REFERENCE_SIZE_DEGREES),
    );
  }

  render({ camera, rasterizer }: RenderContext): void {
    if (!settings.sunEnabled) return;

    sunDirection(this.direction);
    const { x: dirX, y: dirY, z: dirZ } = this.direction;

    if (!rasterizer.projectDirection(dirX, dirY, dirZ, this.center)) return;

    const radiusRows = rasterizer.angularRadiusRows(
      degreesToRadians(settings.sunAngularSize),
    );
    if (radiusRows < 1) return;

    const sunRowCount = radiusRows * 2 + 1.5;

    // O sol está no infinito e o chão é opaco: nada dele aparece abaixo do
    // horizonte. Como o chão é desenhado só em linhas, sem este recorte ele
    // vaza pelos vãos. Só vale com a câmera acima do plano — abaixo dele o
    // chão fica por cima e é o céu que ocupa a parte de baixo da tela.
    const lastVisibleRow =
      camera.position.y > 0
        ? Math.round(rasterizer.horizonRow()) - 1
        : rasterizer.lastRow;

    // Zero com a luz desligada, como todo mundo que usa `glyphForDiscEdge` —
    // a rampa some junto e o glifo volta a ser só a forma medida do disco.
    const rampWeight = settings.lightingEnabled ? settings.rampWeight : 0;
    const { rampExposure } = settings;
    const radiusCols = radiusRows * CELL_ASPECT;

    rasterizer.disc(
      this.center,
      radiusRows,
      lastVisibleRow,
      (col, row, nx, ny) => {
        const localRow = ny * radiusRows + radiusRows;
        const progress = Math.max(0, Math.min(1, localRow / sunRowCount));

        // O topo estoura mais que a base, e é essa mesma queda — não mais uma
        // tabela de quatro blocos escolhida a dedo — que `glyphForDiscEdge`
        // lê como cobertura-alvo: cheio perto do núcleo, esparso na borda.
        const vertical =
          SUN_TOP_BRIGHTNESS +
          (SUN_BOTTOM_BRIGHTNESS - SUN_TOP_BRIGHTNESS) * progress;
        const brightness = vertical * sunSliceBrightness(localRow, sunRowCount);

        const shadeIndex = Math.min(
          SUN_SHADES.length - 1,
          Math.floor(progress * SUN_SHADES.length),
        );
        const shade = SUN_SHADES[shadeIndex] ?? SUN_SHADES[0]!;

        const peak = Math.max(1, brightness);
        scaleRgb(tint, shade, Math.min(1, brightness));

        rasterizer.plotCell(
          col,
          row,
          glyphForDiscEdge(
            brightness,
            nx,
            ny,
            radiusCols,
            radiusRows,
            rampWeight,
            rampExposure,
          ),
          tint,
          Infinity,
          1,
          peak - 1,
        );
      },
    );
  }
}
