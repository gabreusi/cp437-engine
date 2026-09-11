import { hashNoise } from "../math/noise";
import type { GlyphAtlas } from "./gl/atlas";
import {
  buildShapeEntries,
  enhanceContrast,
  nearestGlyph,
  sampleDiscCoverage,
  sampleLineCoverage,
  SAMPLE_COUNT,
  TOTAL_SAMPLE_COUNT,
  type GlyphShapeEntry,
} from "./glyph-shape";
import { GLYPH, glyphForChar } from "./palette";

/**
 * Da luminância para o caractere.
 *
 * É onde a luz deixa de ser cor e vira desenho. Uma engine que renderiza para
 * caracteres tem um canal que nenhuma outra tem — a forma do glifo — e ignorá-lo
 * seria desenhar em ASCII sem usar o ASCII.
 *
 * Três modos porque o mesmo efeito tem custos estéticos diferentes, e a escolha
 * é de quem olha:
 *
 *   classic  a rampa tradicional de arte ASCII, dez níveis por célula. Mais
 *            expressiva, e a que dá a sensação mais forte de superfície
 *            iluminada. Em troca, uma linha da grade sob luz forte deixa de ser
 *            `/` e vira `#`: onde a luz manda, a leitura de wireframe cede.
 *
 *   family   a linha continua sendo linha e só ganha peso. Preserva a silhueta
 *            da grade em qualquer iluminação, ao custo de quatro níveis em vez
 *            de dez.
 *
 *   off      o glifo é só geometria, como antes de existir luz. É a referência
 *            para comparar, e o que o modo sem iluminação usa.
 */
export const RAMP = {
  CLASSIC: "classic",
  FAMILY: "family",
  OFF: "off",
} as const;

export type RampMode = (typeof RAMP)[keyof typeof RAMP];

export const RAMP_MODES: readonly RampMode[] = [
  RAMP.CLASSIC,
  RAMP.FAMILY,
  RAMP.OFF,
];

/**
 * A textura da superfície, no único canal que uma engine de caracteres tem de
 * sobra.
 *
 * O modo da rampa é preferência de quem olha — quanto a luz manda no glifo. A
 * textura é propriedade do objeto: de que alfabeto o glifo sai. São eixos
 * separados de propósito, e é a combinação dos dois que faz o mesmo monólito
 * sob a mesma luz ler como pedra polida ou como concreto bruto sem trocar uma
 * linha de iluminação.
 *
 *   smooth     o alfabeto de sempre, ` .:-=+*#%@`. Gradiente contínuo, é o que
 *              lê como superfície lisa e o que a grade usa.
 *
 *   rough      os blocos de sombreamento da CP437, `░▒▓█`. O degrau entre dois
 *              níveis é grosso e visível, e é justamente o degrau que o olho lê
 *              como aspereza — o mesmo motivo pelo qual eles existiam na code
 *              page para simular meio-tom em telas de dois bits.
 *
 *   irregular  o mesmo tipo de alfabeto, com o nível deslocado por ruído
 *              ancorado na posição de mundo. A superfície fica manchada em vez
 *              de uniforme, e as manchas ficam grudadas nela: andar em volta do
 *              objeto não as faz nadar, que é o defeito de sortear por célula
 *              de tela.
 */
export const TEXTURE = {
  SMOOTH: "smooth",
  ROUGH: "rough",
  IRREGULAR: "irregular",
} as const;

export type SurfaceTexture = (typeof TEXTURE)[keyof typeof TEXTURE];

export const TEXTURES: readonly SurfaceTexture[] = [
  TEXTURE.SMOOTH,
  TEXTURE.ROUGH,
  TEXTURE.IRREGULAR,
];

/** Escrita como texto e traduzida uma vez: a rampa é para ser lida, não contada. */
const levels = (glyphs: string): readonly number[] =>
  [...glyphs].map(glyphForChar);

interface TextureRamp {
  /** Do vazio ao cheio, no modo clássico — e o alfabeto que o preenchimento usa. */
  levels: readonly number[];
  /**
   * Os três glifos de peso, no modo por família: fraco, pesado, cheio.
   *
   * Não varia mais por direção — a direção quem decide agora é o casamento de
   * forma (`glyphForLineShape`, em `shading.ts`), que já resolve o `geometric`
   * do meio da rampa. Estes três são pura textura: quanto ela pesa sob pouca
   * ou muita luz, não para onde ela aponta.
   */
  family: readonly [number, number, number];
  /**
   * Quanto o nível de um fragmento se desloca por ruído, em unidades de
   * nível. Zero é uma superfície uniforme.
   */
  jitter: number;
}

const TEXTURE_RAMPS: Record<SurfaceTexture, TextureRamp> = {
  [TEXTURE.SMOOTH]: {
    levels: levels(" .:-=+*#%@$"),
    family: [GLYPH.PERIOD, glyphForChar("#"), GLYPH.BLOCK_FULL],
    jitter: 0,
  },
  [TEXTURE.ROUGH]: {
    levels: levels(" ·:░▒▓█"),
    family: [GLYPH.BLOCK_LIGHT, GLYPH.BLOCK_DARK, GLYPH.BLOCK_FULL],
    jitter: 0,
  },
  [TEXTURE.IRREGULAR]: {
    levels: levels(" .·:*%#█"),
    family: [GLYPH.DOT, glyphForChar("*"), GLYPH.BLOCK_DARK],
    // Um terço de nível: o bastante para dois níveis vizinhos se misturarem
    // na mesma face, e pouco para não atravessar a rampa inteira e apagar a
    // informação de luz que ela carrega.
    jitter: 0.34,
  },
};

/**
 * Tamanho da mancha do ruído, em unidades de mundo.
 *
 * Quantizar a posição antes de sortear é o que dá área à mancha: sem isso cada
 * fragmento tira um número próprio e a superfície vira chuvisco. Meia unidade
 * cai perto do que uma célula cobre a uma distância de trabalho, então a mancha
 * tem alguns caracteres de largura de perto e some ao longe, junto com o resto
 * do detalhe.
 */
const JITTER_CELL = 0.5;

/**
 * Ruído de -0.5 a 0.5, ancorado na posição de mundo.
 *
 * Em mundo e não em tela porque a mancha pertence à superfície: sorteada por
 * célula de tela, ela nadaria sobre o objeto a cada passo da câmera, que é
 * exatamente o oposto de textura.
 */
const jitterAt = (x: number, y: number, z: number): number =>
  hashNoise(
    Math.floor(x / JITTER_CELL) * 3.71 + Math.floor(z / JITTER_CELL) * 11.13,
    Math.floor(y / JITTER_CELL),
  ) - 0.5;

/**
 * Luminância comprimida para 0..1.
 *
 * A luminância que sai do sombreamento é HDR e não tem teto: um fragmento
 * dentro do lóbulo do sol passa fácil de 3. Cortar em 1 deixaria metade da cena
 * chapada no `@`, então a curva é a exponencial que satura devagar — a mesma
 * família do tone map do composite, pela mesma razão.
 */
const compress = (luminance: number, exposure: number): number =>
  luminance <= 0 ? 0 : 1 - Math.exp(-luminance * exposure);

/**
 * O glifo de um pedaço de superfície que não tem traço próprio.
 *
 * O chão entre duas linhas da grade é área, não linha: não há silhueta de
 * wireframe para preservar ali, e por isso o modo `por família` não tem o que
 * dizer — as quatro famílias existem para uma linha continuar sendo linha. Um
 * pedaço iluminado usa a rampa inteira da textura, que é o que descreve
 * superfície.
 *
 * O índice não é mais `nível × tamanho da tabela`: é o glifo, dentro da
 * rampa, cuja cobertura *medida* no atlas (`fillShapeEntries`, abaixo) está
 * mais perto do nível-alvo — a ordem de `" .:-=+*#%@$"` deixa de ser
 * suposição e passa a ser medição.
 */
export const glyphForPatch = (
  luminance: number,
  exposure: number,
  texture: SurfaceTexture,
  worldX: number,
  worldY: number,
  worldZ: number,
  /**
   * Menor posição da rampa que pode voltar (não confundir com cobertura).
   *
   * Zero deixa o nível mais baixo ser o espaço, e a célula fica vazia — é o
   * que o chão quer, porque é assim que a poça de luz tem borda em vez de
   * retângulo. Um é o que uma face preenchida precisa: escura ela continua
   * sendo superfície, e um buraco no meio de um corpo sólido seria pior do
   * que qualquer escolha de glifo.
   */
  minLevel = 0,
): number => {
  const ramp = TEXTURE_RAMPS[texture];

  let level = compress(luminance, exposure);
  if (ramp.jitter > 0) {
    level = Math.max(
      0,
      Math.min(1, level + jitterAt(worldX, worldY, worldZ) * ramp.jitter),
    );
  }

  return nearestByCoverage(fillShapeEntries[texture], level, minLevel);
};

export const glyphForLuminance = (
  luminance: number,
  /** O glifo que a geometria pediria antes de a luz opinar — já resolvido
   * por `glyphForLineShape`/`sampleDiscCoverage` em quem chama. */
  geometric: number,
  mode: RampMode,
  exposure: number,
  texture: SurfaceTexture = TEXTURE.SMOOTH,
  worldX = 0,
  worldY = 0,
  worldZ = 0,
): number => {
  // A textura não vale no modo desligado, e não é omissão: `off` é a
  // referência em que o glifo é só geometria, e uma textura ali seria a luz
  // opinando de novo por outra porta.
  if (mode === RAMP.OFF) return geometric;

  const ramp = TEXTURE_RAMPS[texture];

  let level = compress(luminance, exposure);
  if (ramp.jitter > 0) {
    level = Math.max(
      0,
      Math.min(1, level + jitterAt(worldX, worldY, worldZ) * ramp.jitter),
    );
  }

  if (mode === RAMP.FAMILY) {
    const [dim, heavy, full] = ramp.family;
    if (level < 0.16) return dim;
    if (level < 0.62) return geometric;
    if (level < 0.88) return heavy;
    return full;
  }

  const table = ramp.levels;
  const index = Math.min(table.length - 1, (level * table.length) | 0);
  return table[index]!;
};

// ---------------------------------------------------------------------------
// Casamento de forma (glyph-shape.ts) — candidatos e estado do atlas.
// ---------------------------------------------------------------------------

/**
 * Glifos direcionais de aresta: as diagonais e o `|` de sempre, a moldura
 * simples da CP437 (hoje sem uso nenhum) e os meios-blocos laterais — é isso
 * que permite um canto de verdade onde duas arestas de uma caixa se cruzam
 * na mesma célula, coisa que a classificação de 4 baldes nunca fez.
 *
 * Duas variantes porque a horizontal escolhe entre `_` e `-` pela distância
 * até a câmera (`glyphForLineShape`, em `shading.ts`) — perto, `_` assenta no
 * chão; longe, `-` pesa menos — e essa é uma decisão de estilo, não de forma,
 * então o casamento de forma só escolhe dentro do conjunto já filtrado.
 */
const EDGE_SHAPE_BASE: readonly number[] = [
  GLYPH.SLASH,
  GLYPH.BACKSLASH,
  GLYPH.PIPE,
  GLYPH.PLUS,
  GLYPH.PERIOD,
  GLYPH.DOT,
  GLYPH.BOX_H,
  GLYPH.BOX_V,
  GLYPH.BOX_TL,
  GLYPH.BOX_TR,
  GLYPH.BOX_BL,
  GLYPH.BOX_BR,
  GLYPH.BOX_VR,
  GLYPH.BOX_VL,
  GLYPH.BOX_HD,
  GLYPH.BOX_HU,
  GLYPH.BOX_CROSS,
  GLYPH.HALF_LEFT,
  GLYPH.HALF_RIGHT,
];

const EDGE_CANDIDATES_NEAR: readonly number[] = [
  ...EDGE_SHAPE_BASE,
  GLYPH.UNDERSCORE,
];
const EDGE_CANDIDATES_FAR: readonly number[] = [
  ...EDGE_SHAPE_BASE,
  GLYPH.DASH,
];

/** Candidatos para a borda de um disco (orbe, sol) — sem moldura ortogonal. */
const DISC_CANDIDATES: readonly number[] = [
  GLYPH.DOT,
  GLYPH.BULLET,
  GLYPH.RING,
  GLYPH.HALF_UP,
  GLYPH.HALF_DOWN,
  GLYPH.HALF_LEFT,
  GLYPH.HALF_RIGHT,
  GLYPH.BLOCK_LIGHT,
  GLYPH.BLOCK_MEDIUM,
  GLYPH.BLOCK_DARK,
  GLYPH.BLOCK_FULL,
  GLYPH.SQUARE,
];

let edgeShapeNear: GlyphShapeEntry[] = [];
let edgeShapeFar: GlyphShapeEntry[] = [];
let discShape: GlyphShapeEntry[] = [];
let fillShapeEntries: Record<SurfaceTexture, GlyphShapeEntry[]> = {
  [TEXTURE.SMOOTH]: [],
  [TEXTURE.ROUGH]: [],
  [TEXTURE.IRREGULAR]: [],
};

/**
 * Mede a forma dos candidatos de novo, a partir do atlas atual.
 *
 * Chamado só quando o atlas é (re)construído (`gl/presenter.ts`) — resize,
 * troca de DPI, `webglcontextlost`. Nunca no laço por fragmento.
 */
export const updateGlyphShapeTable = (atlas: GlyphAtlas): void => {
  edgeShapeNear = buildShapeEntries(atlas, EDGE_CANDIDATES_NEAR);
  edgeShapeFar = buildShapeEntries(atlas, EDGE_CANDIDATES_FAR);
  discShape = buildShapeEntries(atlas, DISC_CANDIDATES);
  fillShapeEntries = {
    [TEXTURE.SMOOTH]: buildShapeEntries(atlas, TEXTURE_RAMPS[TEXTURE.SMOOTH].levels),
    [TEXTURE.ROUGH]: buildShapeEntries(atlas, TEXTURE_RAMPS[TEXTURE.ROUGH].levels),
    [TEXTURE.IRREGULAR]: buildShapeEntries(
      atlas,
      TEXTURE_RAMPS[TEXTURE.IRREGULAR].levels,
    ),
  };
};

/** O conjunto de candidatos de aresta certo para a distância do fragmento. */
export const edgeCandidates = (near: boolean): readonly GlyphShapeEntry[] =>
  near ? edgeShapeNear : edgeShapeFar;

export const discCandidates = (): readonly GlyphShapeEntry[] => discShape;

/** O glifo, dentro de `entries` a partir de `minIndex`, de cobertura mais perto de `target`. */
const nearestByCoverage = (
  entries: readonly GlyphShapeEntry[],
  target: number,
  minIndex: number,
): number => {
  const start = Math.min(minIndex, entries.length - 1);
  let bestGlyph = entries[start]!.glyph;
  let bestDistance = Infinity;
  for (let i = start; i < entries.length; i += 1) {
    const entry = entries[i]!;
    const distance = Math.abs(entry.coverage - target);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestGlyph = entry.glyph;
    }
  }
  return bestGlyph;
};

// Rascunhos reaproveitados entre chamadas: o casamento de forma roda por
// fragmento de aresta e por amostra de disco, e nada aqui pode alocar.
const lineSamples = new Float32Array(TOTAL_SAMPLE_COUNT);
const lineShape = new Float32Array(SAMPLE_COUNT);

/** Calibrado a olho: fino o bastante para não engordar um `.` até virar `#`. */
export const DEFAULT_LINE_HALF_THICKNESS = 0.1;
export const DEFAULT_DISC_EDGE_THICKNESS = 0.14;

/**
 * O glifo de aresta que o casamento de forma escolhe para uma reta que
 * cruza a célula em `(offsetCol, offsetRow)` (deslocamento subcélula, como o
 * DDA já calcula) apontando para `(dirCol, dirRow)`.
 */
export const glyphForLineShape = (
  offsetCol: number,
  offsetRow: number,
  dirCol: number,
  dirRow: number,
  near: boolean,
): number => {
  sampleLineCoverage(
    lineSamples,
    offsetCol,
    offsetRow,
    dirCol,
    dirRow,
    DEFAULT_LINE_HALF_THICKNESS,
  );
  enhanceContrast(lineShape, lineSamples);
  return nearestGlyph(lineShape, edgeCandidates(near));
};

/** O mesmo casamento de forma, para a borda de um disco (§3, extensão). */
export const glyphForDiscShape = (
  nx: number,
  ny: number,
  radiusCols: number,
  radiusRows: number,
): number => {
  sampleDiscCoverage(
    lineSamples,
    nx,
    ny,
    radiusCols,
    radiusRows,
    DEFAULT_DISC_EDGE_THICKNESS,
  );
  enhanceContrast(lineShape, lineSamples);
  return nearestGlyph(lineShape, discCandidates());
};
