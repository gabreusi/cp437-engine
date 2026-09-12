import { settings } from "../config";
import { type Rgb, copyRgb, rgb, setRgb } from "../math/color";
import { NO_OWNER, type ShadeOptions, shadeSurface } from "../light/shade";
import type { Material } from "../light/types";
import { LightWorld } from "../light/world";
import type { RenderContext } from "../scene/scene";
import { COLOR, GLYPH } from "./palette";
import {
  MIN_FILL_COVERAGE,
  TEXTURE,
  type SurfaceTexture,
  glyphForLineEdge,
  glyphForLineShape,
  glyphForPatch,
} from "./ramp";
import type { Fragment, SurfaceSample, SurfaceStyle } from "./rasterizer";

/** Onde as linhas horizontais deixam de ser `_` rente ao chão e viram `-`. */
const UNDERSCORE_RANGE = 0.12;

const BAND_NEAR = 0.35;
const BAND_MID = 0.7;

/**
 * A cor da grade naquela distância.
 *
 * Exportada porque tem dois leitores: a linha, que a usa como albedo e como
 * brilho próprio do neon, e o chão entre as linhas, que a usa só como albedo —
 * ele recebe luz, não emite. Duas tabelas se separariam na primeira mudança e o
 * vão entre duas linhas deixaria de ser da cor delas.
 */
export const groundBand = (depth: number): Rgb => {
  const fog = fogAmount(depth);
  return fog < BAND_NEAR
    ? COLOR.GRID_NEAR
    : fog < BAND_MID
      ? COLOR.GRID_MID
      : COLOR.GRID_FAR;
};

/**
 * Quanto do fragmento a distância já comeu, de 0 (colado) a 1 (sumiu).
 *
 * Substitui as faixas por fileira de tela da versão anterior, que só
 * funcionavam porque o horizonte ficava sempre na mesma altura.
 */
export const fogAmount = (depth: number): number => {
  if (!settings.fogEnabled) return 0;
  return Math.min(
    1,
    (depth / settings.viewDistance) * settings.fogDensity * 1.6,
  );
};

/**
 * O glifo que a geometria pediria, antes de a luz opinar.
 *
 * Casamento de forma (`glyphForLineShape`, `ramp.ts`) substitui os quatro
 * baldes de inclinação de antes: a direção do segmento e onde exatamente ele
 * cruza a célula (`offsetCol`/`offsetRow`, subcélula) resolvem entre
 * diagonais, `|`, cantos de moldura e meios-bloco — resolução muito maior do
 * que `VERTICAL/HORIZONTAL/UP/DOWN`. A única decisão que continua sendo de
 * distância e não de forma é `_` contra `-`: perto, `_` assenta no chão;
 * longe, `-` pesa menos — por isso o "near" que filtra o conjunto de
 * candidatos, não a busca em si.
 */
export const geometricGlyph = (sample: SurfaceSample): number =>
  glyphForLineShape(
    sample.offsetCol,
    sample.offsetRow,
    sample.dirCol,
    sample.dirRow,
    sample.depth < settings.viewDistance * UNDERSCORE_RANGE,
  );

export const createMaterial = (
  overrides: Partial<Material> = {},
): Material => ({
  albedo: rgb(1, 1, 1),
  emissive: rgb(),
  emissiveStrength: 0,
  reflectivity: 0,
  gloss: 24,
  mirror: false,
  ...overrides,
});

/**
 * O que o sombreamento precisa e não muda dentro de um quadro.
 *
 * Existe para a posição da câmera e as opções não serem relidas de `settings`
 * uma vez por fragmento: são dezenas de milhares de leituras por quadro para
 * responder sempre a mesma coisa.
 */
export interface LitContext {
  world: LightWorld;
  options: ShadeOptions;
  cameraX: number;
  cameraY: number;
  cameraZ: number;
  /** Quanto a luz pode vencer a forma na escolha do glifo de aresta. Zero é só geometria. */
  rampWeight: number;
  rampExposure: number;
  lit: boolean;
}

/**
 * O mundo vazio inicial não é um `null` disfarçado: sombrear contra ele dá
 * ambiente puro, que é exatamente o certo para um objeto que ainda não viu um
 * quadro. `beginLit` troca pelo mundo de verdade antes do primeiro fragmento.
 */
export const createLitContext = (): LitContext => ({
  world: new LightWorld(),
  options: {
    shadows: true,
    reflections: true,
    shadowThreshold: 0.004,
    maxShadowLights: 3,
    ambient: true,
  },
  cameraX: 0,
  cameraY: 0,
  cameraZ: 0,
  rampWeight: 0,
  rampExposure: 1.5,
  lit: true,
});

/** Uma vez por quadro, antes de o objeto emitir qualquer primitiva. */
export const beginLit = (lit: LitContext, context: RenderContext): void => {
  const { position } = context.camera;
  lit.world = context.lights;
  lit.options = context.shading;
  lit.cameraX = position.x;
  lit.cameraY = position.y;
  lit.cameraZ = position.z;
  lit.lit = settings.lightingEnabled;
  lit.rampExposure = settings.rampExposure;

  // Sem iluminação o peso some junto: o glifo volta a ser só geometria, e a
  // cena inteira volta a ser o que era antes de existir luz. É a referência
  // com que qualquer efeito daqui para frente é comparado.
  lit.rampWeight = settings.lightingEnabled ? settings.rampWeight : 0;
};

const shaded: Rgb = rgb();

/**
 * Escreve uma cor HDR num fragmento, separando o que passa de 1.
 *
 * A célula guarda oito bits por canal, mas o sombreamento produz valores acima
 * de 1 — é justamente esse excesso que vira halo no bloom. A cor normalizada
 * pelo pico guarda o matiz, e o pico vai para o canal emissivo; o shader
 * remultiplica e recupera o valor original sem perder a cor. Cortar em 1 em vez
 * disso deixaria todo núcleo brilhante branco e sem estouro.
 */
export const writeHdrColor = (out: Fragment, color: Rgb): void => {
  const peak = Math.max(1, color.r, color.g, color.b);
  const inverse = 1 / peak;
  setRgb(out.color, color.r * inverse, color.g * inverse, color.b * inverse);
  out.emissive = peak - 1;
};

/**
 * Ilumina um fragmento e escolhe o caractere que o representa.
 *
 * A ponte entre `light/`, que não sabe o que é um glifo, e o rasterizador, que
 * não sabe o que é uma luz.
 */
export const shadeFragment = (
  lit: LitContext,
  material: Material,
  sample: SurfaceSample,
  normalX: number,
  normalY: number,
  normalZ: number,
  ownerId: number,
  texture: SurfaceTexture,
  /**
   * A linha está preenchendo uma área, e não desenhando uma aresta.
   *
   * Muda a busca: uma aresta tem silhueta a preservar, e o interior de uma
   * face não tem. Ali o traço é meio e não fim, e a cobertura medida do pool
   * inteiro da textura é o que descreve superfície.
   */
  area: boolean,
  out: Fragment,
): void => {
  if (!lit.lit) {
    copyRgb(out.color, material.albedo);
    out.emissive = material.emissiveStrength;
    out.glyph = geometricGlyph(sample);
    return;
  }

  // Do fragmento para a câmera. O sombreamento quer esta direção, e não a do
  // olhar: é ela que entra no meio-vetor e no espelhamento.
  let viewX = lit.cameraX - sample.x;
  let viewY = lit.cameraY - sample.y;
  let viewZ = lit.cameraZ - sample.z;
  const distance = Math.sqrt(viewX * viewX + viewY * viewY + viewZ * viewZ);
  if (distance > 0) {
    viewX /= distance;
    viewY /= distance;
    viewZ /= distance;
  }

  const luminance = shadeSurface(
    lit.world,
    material,
    sample.x,
    sample.y,
    sample.z,
    normalX,
    normalY,
    normalZ,
    viewX,
    viewY,
    viewZ,
    ownerId,
    lit.options,
    shaded,
  );

  writeHdrColor(out, shaded);
  out.glyph = area
    ? glyphForPatch(
        luminance,
        lit.rampExposure,
        texture,
        sample.x,
        sample.y,
        sample.z,
        MIN_FILL_COVERAGE,
      )
    : glyphForLineEdge(
        luminance,
        sample.offsetCol,
        sample.offsetRow,
        sample.dirCol,
        sample.dirRow,
        sample.depth < settings.viewDistance * UNDERSCORE_RANGE,
        lit.rampWeight,
        lit.rampExposure,
        texture,
        sample.x,
        sample.y,
        sample.z,
      );
};

/**
 * Uma superfície iluminada que desenha em linhas.
 *
 * A ferramenta que o chão e todo objeto usam: guarda o material, a normal da
 * face que está sendo desenhada e quem é o dono, e entrega um `SurfaceStyle`
 * pronto para o rasterizador. A normal fica aqui e não no material porque muda
 * a cada aresta de uma caixa, enquanto o material é o mesmo para o objeto
 * inteiro — e nenhum dos dois pode ser alocado por fragmento.
 */
export class SurfacePen {
  readonly lit = createLitContext();
  readonly material = createMaterial();

  /** Qual corpo emitiu esta superfície, para ela não se sombrear sozinha. */
  ownerId = NO_OWNER;

  /** A névoa dissolve esta superfície com a distância, como a grade. */
  fogged = true;

  /**
   * De que alfabeto de glifos as próximas linhas saem.
   *
   * Fica aqui e não no material pelo mesmo motivo que a normal: o material é
   * transporte de luz, e `light/` não sabe o que é um glifo. Textura é a
   * ponta de cá da ponte — luz virando caractere — e é exatamente o que esta
   * caneta faz.
   */
  texture: SurfaceTexture = TEXTURE.SMOOTH;

  /**
   * As próximas linhas preenchem uma área, e não desenham uma aresta.
   *
   * Uma face sólida é feita de linhas — é a única primitiva que a engine tem —
   * mas o que elas representam ali não é traço nenhum: é superfície. Com isto
   * ligado, a busca por cobertura no pool inteiro da textura entra no lugar
   * da busca por forma, e o nível mais baixo deixa de ser o espaço
   * (`MIN_FILL_COVERAGE`), senão um pedaço escuro da face viraria buraco.
   */
  area = false;

  /**
   * Último ajuste antes de sombrear, por fragmento.
   *
   * É por onde o chão troca o albedo pela faixa de distância certa. Fica como
   * gancho e não como caso especial dentro do estilo porque é a única coisa
   * que o chão faz diferente de qualquer outra superfície.
   */
  beforeShade: ((sample: SurfaceSample, material: Material) => void) | null =
    null;

  private normalX = 0;
  private normalY = 1;
  private normalZ = 0;

  /** Uma vez por quadro, antes de emitir qualquer primitiva. */
  begin(context: RenderContext): void {
    beginLit(this.lit, context);
  }

  /** A normal da face que as próximas linhas representam. */
  normal(x: number, y: number, z: number): void {
    this.normalX = x;
    this.normalY = y;
    this.normalZ = z;
  }

  readonly style: SurfaceStyle = (sample, out) => {
    const fog = this.fogged ? fogAmount(sample.depth) : 0;
    if (fog >= 1) return false;

    this.beforeShade?.(sample, this.material);

    shadeFragment(
      this.lit,
      this.material,
      sample,
      this.normalX,
      this.normalY,
      this.normalZ,
      this.ownerId,
      this.texture,
      this.area,
      out,
    );

    out.alpha = (1 - fog) ** 1.2;

    // Área preenchida é corpo, não traço: bloqueia o que está atrás mesmo
    // onde o glifo escolhido — escuro de propósito — não tem tinta. Ver
    // `Fragment.opaque`.
    out.opaque = this.area;
    // Superfície de verdade, nunca incidência: sem isto, o `fuse` de um
    // feixe desenhado antes no mesmo quadro vazaria para cá (o fragmento é
    // reaproveitado) e uma parede comum passaria a se fundir com quem
    // estivesse atrás dela em vez de bloquear.
    out.fuse = false;

    // O nível mais baixo da cobertura é o espaço: a célula não some, ela
    // fica vazia (é o que o chão usa; a hachura de face nunca chega lá,
    // protegida por `MIN_FILL_COVERAGE`). Descartar aqui poupa a escrita e o
    // teste de profundidade de algo que o shader descartaria por cobertura
    // zero.
    return out.glyph !== GLYPH.SPACE && out.glyph !== GLYPH.BLANK;
  };
}

/**
 * O chão como superfície iluminada.
 *
 * A grade continua com as três faixas de cor por distância — elas são o albedo
 * e o brilho próprio do neon, não o resultado final. A luz entra por cima: o
 * reflexo do sol pinta de amarelo a coluna de linhas sob ele, um orbe ciano abre
 * uma poça da sua cor no chão, e um corpo entre a luz e o chão apaga as linhas
 * que ficam atrás dele.
 *
 * A dissolução ao longe continua sendo alpha de verdade, no canal da data
 * texture, e não o dithering que a versão em DOM precisava usar.
 */
export const createGroundPen = (): SurfacePen => {
  const pen = new SurfacePen();
  pen.normal(0, 1, 0);
  pen.beforeShade = (sample, material) => {
    const band = groundBand(sample.depth);

    copyRgb(material.albedo, band);

    // A linha brilha na própria cor: é neon, não asfalto. A luz das outras
    // fontes soma por cima, e é a soma que a rampa lê para escolher o
    // caractere.
    copyRgb(material.emissive, band);
    material.emissiveStrength = settings.gridGlow;
    material.reflectivity = settings.groundReflectivity;
    material.gloss = settings.groundGloss;
  };
  return pen;
};
