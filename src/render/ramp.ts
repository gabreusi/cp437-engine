import { hashNoise } from "../math/noise";
import type { GlyphAtlas } from "./gl/atlas";
import {
  buildShapeEntries,
  enhanceContrast,
  nearestByCoverage,
  nearestWeightedGlyph,
  sampleDiscCoverage,
  sampleLineCoverage,
  sortByCoverage,
  SAMPLE_COUNT,
  TOTAL_SAMPLE_COUNT,
  type GlyphShapeEntry,
} from "./glyph-shape";
import { CHARSET, GLYPH } from "./palette";

/**
 * Da luminância para o caractere.
 *
 * É onde a luz deixa de ser cor e vira desenho. Uma engine que renderiza para
 * caracteres tem um canal que nenhuma outra tem — a forma do glifo — e ignorá-lo
 * seria desenhar em ASCII sem usar o ASCII.
 *
 * Quanto a luz pode vencer a forma é um peso contínuo (`rampWeight`,
 * `settings.ts`), não um switch de modos: zero é geometria pura, como antes
 * de existir luz — a referência para comparar; subindo, os fragmentos mais
 * iluminados de uma aresta ganham glifos mais pesados sem que a direção da
 * linha pare de opinar. Ver `nearestWeightedGlyph` (`glyph-shape.ts`) e
 * `glyphForLineEdge`/`glyphForDiscEdge` abaixo.
 */

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
 *   smooth     o pool inteiro, sem filtro — o gradiente mais fino possível, e
 *              o que mais expõe letras e símbolos fora dos blocos de sempre.
 *              É o que a grade usa.
 *
 *   rough      um subconjunto medido do mesmo pool: só glifos "de bloco"
 *              (preenchimento uniforme dentro da célula — variância baixa,
 *              `buildChunkyPool` abaixo), espaçados por um degrau mínimo de
 *              cobertura. O degrau grosso entre dois níveis é o que o olho lê
 *              como aspereza — o mesmo motivo pelo qual os blocos de
 *              sombreamento da CP437 existiam, para simular meio-tom em telas
 *              de dois bits — só que agora o critério é medido, não uma
 *              lista de glifos hand-typed.
 *
 *   irregular  o mesmo pool de `rough`, com o nível deslocado por ruído
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

/**
 * Índice numérico de `SurfaceTexture`, para caber num canal do G-buffer
 * (`Framebuffer.plotDeferred`) e servir de linha na LUT de `ShadingPass`.
 */
export const TEXTURE_ID: Record<SurfaceTexture, number> = {
  [TEXTURE.SMOOTH]: 0,
  [TEXTURE.ROUGH]: 1,
  [TEXTURE.IRREGULAR]: 2,
};

/**
 * Quanto o nível de um fragmento se desloca por ruído, em unidades de
 * cobertura (0..1). Zero é uma superfície uniforme.
 */
const TEXTURE_JITTER: Record<SurfaceTexture, number> = {
  [TEXTURE.SMOOTH]: 0,
  [TEXTURE.ROUGH]: 0,
  // Um terço de nível: o bastante para dois níveis vizinhos se misturarem na
  // mesma face, e pouco para não atravessar a rampa inteira e apagar a
  // informação de luz que ela carrega.
  [TEXTURE.IRREGULAR]: 0.34,
};

/** Abaixo disto o glifo lê como vazio — nunca serve pra aresta, disco ou face. */
const MIN_VISIBLE_COVERAGE = 0.02;

/**
 * Piso de cobertura da hachura de face: uma face preenchida nunca pode
 * devolver o glifo vazio, senão um pedaço escuro do corpo vira buraco.
 */
export const MIN_FILL_COVERAGE = 0.02;

/** Acima disto um glifo já lê como textura fina, não bloco — calibrado a olho. */
const ROUGH_MAX_VARIANCE = 0.03;
/** Degrau mínimo de cobertura entre dois níveis consecutivos do pool áspero. */
const ROUGH_MIN_COVERAGE_GAP = 0.08;

/**
 * O subconjunto "de bloco" do pool inteiro: preenchimento uniforme dentro da
 * célula (variância baixa), espaçado para não empilhar vários glifos quase
 * idênticos na mesma faixa de cobertura. `sorted` já vem por cobertura
 * ascendente — o corte por variância só filtra, não precisa reordenar.
 */
const buildChunkyPool = (
  sorted: readonly GlyphShapeEntry[],
): GlyphShapeEntry[] => {
  const blockLike = sorted.filter((e) => e.variance <= ROUGH_MAX_VARIANCE);
  const chunky: GlyphShapeEntry[] = [];
  let lastCoverage = -Infinity;
  for (const entry of blockLike) {
    if (entry.coverage - lastCoverage < ROUGH_MIN_COVERAGE_GAP) continue;
    chunky.push(entry);
    lastCoverage = entry.coverage;
  }
  return chunky;
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
 * wireframe para preservar ali. Um pedaço iluminado usa a cobertura medida
 * do pool inteiro da textura (`fillPools`, abaixo) — nunca a busca por
 * forma, que é cara demais para os milhares de fragmentos que uma hachura de
 * face gera por quadro (ver `shading.ts`).
 */
export const glyphForPatch = (
  luminance: number,
  exposure: number,
  texture: SurfaceTexture,
  worldX: number,
  worldY: number,
  worldZ: number,
  /**
   * Menor cobertura que pode voltar.
   *
   * Zero deixa o nível mais baixo ser o espaço, e a célula fica vazia — é o
   * que o chão quer, porque é assim que a poça de luz tem borda em vez de
   * retângulo. `MIN_FILL_COVERAGE` é o que uma face preenchida precisa:
   * escura ela continua sendo superfície, e um buraco no meio de um corpo
   * sólido seria pior do que qualquer escolha de glifo.
   */
  minCoverage = 0,
): number => {
  const jitter = TEXTURE_JITTER[texture];

  let level = compress(luminance, exposure);
  if (jitter > 0) {
    level = Math.max(
      0,
      Math.min(1, level + jitterAt(worldX, worldY, worldZ) * jitter),
    );
  }

  return nearestByCoverage(fillPools[texture], level, minCoverage);
};

// ---------------------------------------------------------------------------
// Casamento de forma (glyph-shape.ts) — pools e estado do atlas.
// ---------------------------------------------------------------------------

/** Todo glifo da CP437, na ordem do atlas — a fonte única dos pools abaixo. */
const ALL_GLYPHS: readonly number[] = Array.from(
  { length: CHARSET.length },
  (_, i) => i,
);

let canonicalGlyphs: GlyphShapeEntry[] = [];
let fillPools: Record<SurfaceTexture, GlyphShapeEntry[]> = {
  [TEXTURE.SMOOTH]: [],
  [TEXTURE.ROUGH]: [],
  [TEXTURE.IRREGULAR]: [],
};
let edgeShapeNear: GlyphShapeEntry[] = [];
let edgeShapeFar: GlyphShapeEntry[] = [];
let discShape: GlyphShapeEntry[] = [];

/**
 * Mede a forma dos 256 glifos de novo, a partir do atlas atual, e recorta os
 * pools de aresta/disco/preenchimento a partir dessa única medição.
 *
 * Chamado só quando o atlas é (re)construído (`gl/presenter.ts`) — resize,
 * troca de DPI, `webglcontextlost`. Nunca no laço por fragmento.
 */
export const updateGlyphShapeTable = (atlas: GlyphAtlas): void => {
  canonicalGlyphs = sortByCoverage(buildShapeEntries(atlas, ALL_GLYPHS));

  const visible = canonicalGlyphs.filter(
    (e) => e.coverage >= MIN_VISIBLE_COVERAGE,
  );
  // `_`/`-` continuam sendo a única exclusão manual: a horizontal escolhe
  // entre os dois pela distância até a câmera (`shadeFragment`, em
  // `shading.ts`), não pela forma — que não distingue os dois. É decisão de
  // estilo, então o casamento de forma só escolhe dentro do conjunto já
  // filtrado pela distância.
  edgeShapeNear = visible.filter((e) => e.glyph !== GLYPH.DASH);
  edgeShapeFar = visible.filter((e) => e.glyph !== GLYPH.UNDERSCORE);
  discShape = visible;

  const chunky = buildChunkyPool(canonicalGlyphs);
  fillPools = {
    [TEXTURE.SMOOTH]: canonicalGlyphs,
    [TEXTURE.ROUGH]: chunky,
    [TEXTURE.IRREGULAR]: chunky, // mesmo pool do rough; a diferença é só o jitter
  };
};

/** O conjunto de candidatos de aresta certo para a distância do fragmento. */
export const edgeCandidates = (near: boolean): readonly GlyphShapeEntry[] =>
  near ? edgeShapeNear : edgeShapeFar;

export const discCandidates = (): readonly GlyphShapeEntry[] => discShape;

// Rascunhos reaproveitados entre chamadas: o casamento de forma roda por
// fragmento de aresta e por amostra de disco, e nada aqui pode alocar.
const lineSamples = new Float32Array(TOTAL_SAMPLE_COUNT);
const lineShape = new Float32Array(SAMPLE_COUNT);

/** Calibrado a olho: fino o bastante para não engordar um `.` até virar `#`. */
export const DEFAULT_LINE_HALF_THICKNESS = 0.1;
export const DEFAULT_DISC_EDGE_THICKNESS = 0.14;

/**
 * Candidatos de aresta/disco por fragmento são só uma janela em torno do
 * ponto certo, não o pool inteiro — ver `nearestWeightedGlyph`. Calibrado a
 * olho: grande o bastante para não perder o melhor candidato perto dos
 * extremos de brilho, pequeno o bastante para o custo por fragmento não se
 * importar com o pool ter crescido de dezenas para os ~256 da CP437 inteira.
 */
const EDGE_SHAPE_WINDOW = 56;

/**
 * O glifo de aresta que o casamento de forma escolhe para uma reta que cruza
 * a célula em `(offsetCol, offsetRow)` (deslocamento subcélula, como o DDA
 * já calcula) apontando para `(dirCol, dirRow)` — sem luz opinando.
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
  return nearestWeightedGlyph(
    edgeCandidates(near),
    lineShape,
    0,
    0,
    EDGE_SHAPE_WINDOW,
  );
};

/**
 * O mesmo casamento de forma, com a luz opinando: `weight` pondera a
 * cobertura-alvo (luminância comprimida) contra a forma da reta. `weight=0`
 * reproduz `glyphForLineShape`.
 */
export const glyphForLineEdge = (
  luminance: number,
  offsetCol: number,
  offsetRow: number,
  dirCol: number,
  dirRow: number,
  near: boolean,
  weight: number,
  exposure: number,
  texture: SurfaceTexture = TEXTURE.SMOOTH,
  worldX = 0,
  worldY = 0,
  worldZ = 0,
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

  const jitter = TEXTURE_JITTER[texture];
  let level = compress(luminance, exposure);
  if (jitter > 0) {
    level = Math.max(
      0,
      Math.min(1, level + jitterAt(worldX, worldY, worldZ) * jitter),
    );
  }

  return nearestWeightedGlyph(
    edgeCandidates(near),
    lineShape,
    level,
    weight,
    EDGE_SHAPE_WINDOW,
  );
};

/**
 * O mesmo casamento de forma+cobertura, para a borda de um disco (orbe,
 * sol). O disco é ele mesmo a fonte de luz — não existe uma versão "sem luz".
 */
export const glyphForDiscEdge = (
  luminance: number,
  nx: number,
  ny: number,
  radiusCols: number,
  radiusRows: number,
  weight: number,
  exposure: number,
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
  const level = compress(luminance, exposure);
  return nearestWeightedGlyph(
    discCandidates(),
    lineShape,
    level,
    weight,
    EDGE_SHAPE_WINDOW,
  );
};

// ---------------------------------------------------------------------------
// Bake para a GPU — mesma tabela de sempre, empacotada para `ShadingPass`
// (`render/gl/passes/shading.ts`) amostrar em vez de buscar.
//
// Roda só quando `updateGlyphShapeTable` roda (atlas novo), nunca por quadro:
// é exatamente por isso que dá para portar `nearestByCoverage` para uma LUT
// e `nearestWeightedGlyph` para um pool pequeno em vez do algoritmo inteiro.
// ---------------------------------------------------------------------------

/** Níveis de luminância comprimida amostrados na LUT de preenchimento. */
export const AREA_LUT_LEVELS = 256;
/**
 * Uma linha por textura, em dois pisos de cobertura: `RAW` é o que o
 * preenchimento do chão usa (pode chegar a `GLYPH.SPACE`, célula vazia);
 * `FLOORED` é o que toda face hachurada usa (`MIN_FILL_COVERAGE`, nunca
 * vazio — ver o comentário de `glyphForPatch`). As duas existem porque as
 * duas chamadas de `glyphForPatch` de hoje discordam desse piso.
 */
export const AREA_LUT_VARIANTS = 2;
export const AREA_LUT_ROWS = TEXTURES.length * AREA_LUT_VARIANTS;

/** Linha da LUT de preenchimento para uma textura e um piso de cobertura. */
export const areaLutRow = (
  texture: SurfaceTexture,
  floored: boolean,
): number => TEXTURE_ID[texture] * AREA_LUT_VARIANTS + (floored ? 1 : 0);

/**
 * `AREA_LUT_ROWS × AREA_LUT_LEVELS` glifos (um byte cada): para cada textura
 * e piso, o glifo que `nearestByCoverage` devolveria em cada nível
 * quantizado de 0 a 1. `ShadingPass` amostra por `texelFetch`, já com o
 * jitter de `irregular` aplicado ao nível antes de indexar — ver `jitterAt`.
 */
export const buildAreaGlyphLut = (): Uint8Array => {
  const lut = new Uint8Array(AREA_LUT_ROWS * AREA_LUT_LEVELS);
  for (const texture of TEXTURES) {
    const pool = fillPools[texture];
    for (let variant = 0; variant < AREA_LUT_VARIANTS; variant += 1) {
      const minCoverage = variant === 0 ? 0 : MIN_FILL_COVERAGE;
      const row = TEXTURE_ID[texture] * AREA_LUT_VARIANTS + variant;
      for (let level = 0; level < AREA_LUT_LEVELS; level += 1) {
        const target = level / (AREA_LUT_LEVELS - 1);
        lut[row * AREA_LUT_LEVELS + level] = nearestByCoverage(
          pool,
          target,
          minCoverage,
        );
      }
    }
  }
  return lut;
};

/** Campos de `GlyphShapeEntry` achatados: 6 de forma, 1 de cobertura, 1 de glifo. */
const EDGE_POOL_STRIDE = SAMPLE_COUNT + 2;

/**
 * O pool de candidatos de aresta (`edgeCandidates`), achatado para uma
 * textura `RGBA32F` de `entries.length` colunas × 2 fileiras: `ShadingPass`
 * porta `nearestWeightedGlyph` (busca binária + janela) sobre este mesmo
 * array, em vez de rodar a busca na CPU por fragmento.
 */
export const buildEdgeShapePool = (near: boolean): Float32Array => {
  const entries = edgeCandidates(near);
  const data = new Float32Array(entries.length * EDGE_POOL_STRIDE);
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]!;
    const base = i * EDGE_POOL_STRIDE;
    for (let k = 0; k < SAMPLE_COUNT; k += 1) data[base + k] = entry.vector[k]!;
    data[base + SAMPLE_COUNT] = entry.coverage;
    data[base + SAMPLE_COUNT + 1] = entry.glyph;
  }
  return data;
};
