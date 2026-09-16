import type { GlyphAtlasCanvas } from "./atlas-canvas";
import { CELL_ASPECT } from "./viewport";

/**
 * Escolha de glifo por forma, e não só por luminância.
 *
 * Inspirado em alexharri.com/blog/ascii-rendering: cada glifo tem uma forma
 * real, e o vizinho mais próximo entre a forma que se quer desenhar e a
 * forma medida dos candidatos lê melhor que um único nível de luminância
 * mapeado num índice de rampa. A diferença para o artigo é a origem dos
 * dados — lá é uma imagem já renderizada, aqui é a primitiva analítica
 * (reta ou círculo) que o rasterizador está desenhando —, e é por isso que
 * dá pra amostrar pontos fora da célula sem precisar de imagem nenhuma: a
 * função de cobertura responde em qualquer ponto da tela, não só dentro da
 * célula atual.
 */

/** Um ponto de amostra, em fração de célula (0,0 é o canto superior esquerdo). */
interface SamplePoint {
  readonly x: number;
  readonly y: number;
}

/**
 * Seis amostras internas, em grade 3 colunas × 2 fileiras escalonada.
 *
 * A coluna da esquerda desce, a da direita sobe: sem o escalão as seis
 * amostras cairiam em só duas fileiras retas, e duas formas bem diferentes
 * (um `/` e um `|` grosso, por exemplo) sorteariam o mesmo vetor.
 */
const STAGGER = 0.125;

export const INTERNAL_SAMPLES: readonly SamplePoint[] = [
  { x: 1 / 6, y: 1 / 3 + STAGGER }, // 0: coluna esquerda, alta
  { x: 1 / 6, y: 2 / 3 + STAGGER }, // 1: coluna esquerda, baixa
  { x: 3 / 6, y: 1 / 3 }, // 2: coluna do meio, alta
  { x: 3 / 6, y: 2 / 3 }, // 3: coluna do meio, baixa
  { x: 5 / 6, y: 1 / 3 - STAGGER }, // 4: coluna direita, alta
  { x: 5 / 6, y: 2 / 3 - STAGGER }, // 5: coluna direita, baixa
];

export const SAMPLE_COUNT = INTERNAL_SAMPLES.length;

/** Distância além da borda da célula onde as amostras externas caem. */
const EXTERNAL_MARGIN = 0.15;

/**
 * Doze amostras fora da célula, três por borda — a matéria-prima do realce
 * de contraste direcional (§3b do plano): saber se a forma continua na
 * célula vizinha, sem precisar olhar pixel nenhum dela, porque a mesma
 * função analítica que cobre a célula atual também responde aqui fora.
 */
export const EXTERNAL_SAMPLES: readonly SamplePoint[] = [
  { x: 1 / 6, y: -EXTERNAL_MARGIN }, // 6: topo
  { x: 3 / 6, y: -EXTERNAL_MARGIN }, // 7
  { x: 5 / 6, y: -EXTERNAL_MARGIN }, // 8
  { x: 1 / 6, y: 1 + EXTERNAL_MARGIN }, // 9: base
  { x: 3 / 6, y: 1 + EXTERNAL_MARGIN }, // 10
  { x: 5 / 6, y: 1 + EXTERNAL_MARGIN }, // 11
  { x: -EXTERNAL_MARGIN, y: 1 / 3 }, // 12: esquerda
  { x: -EXTERNAL_MARGIN, y: 1 / 2 }, // 13
  { x: -EXTERNAL_MARGIN, y: 2 / 3 }, // 14
  { x: 1 + EXTERNAL_MARGIN, y: 1 / 3 }, // 15: direita
  { x: 1 + EXTERNAL_MARGIN, y: 1 / 2 }, // 16
  { x: 1 + EXTERNAL_MARGIN, y: 2 / 3 }, // 17
];

export const EXTERNAL_COUNT = EXTERNAL_SAMPLES.length;
export const TOTAL_SAMPLE_COUNT = SAMPLE_COUNT + EXTERNAL_COUNT;

/**
 * Quais amostras externas informam o realce de cada amostra interna.
 *
 * Vizinhança geométrica: a amostra interna mais perto de uma borda escuta as
 * externas daquela borda, e as duas amostras de canto (colunas laterais)
 * escutam também a externa lateral mais próxima.
 */
export const AFFECTING_EXTERNAL: readonly (readonly number[])[] = [
  [6, 12], // 0: esquerda-alta — topo + esquerda
  [9, 14], // 1: esquerda-baixa — base + esquerda
  [7], // 2: meio-alta — topo
  [10], // 3: meio-baixa — base
  [8, 15], // 4: direita-alta — topo + direita
  [11, 17], // 5: direita-baixa — base + direita
];

export interface GlyphShapeEntry {
  readonly glyph: number;
  /** Densidade nas seis amostras internas, 0..1. */
  readonly vector: Float32Array;
  /** Densidade média do glifo inteiro — a cobertura que o preenchimento usa. */
  readonly coverage: number;
  /**
   * Variância das seis amostras em torno de `coverage`.
   *
   * Um glifo "de bloco" preenche a célula de modo uniforme — as seis amostras
   * concordam entre si, variância baixa, para qualquer cobertura. Uma letra
   * fina discorda mais para a mesma cobertura média. É o que separa "áspero"
   * de "liso" por medição em vez de lista (`buildChunkyPool`, `ramp.ts`).
   */
  readonly variance: number;
}

/** Raio de amostragem em pixels do atlas, em torno de cada ponto. */
const SAMPLE_RADIUS_FRACTION = 0.09;

const averageAlpha = (
  data: Uint8ClampedArray,
  imageWidth: number,
  imageHeight: number,
  px: number,
  py: number,
  radius: number,
): number => {
  const x0 = Math.max(0, Math.round(px - radius));
  const x1 = Math.min(imageWidth - 1, Math.round(px + radius));
  const y0 = Math.max(0, Math.round(py - radius));
  const y1 = Math.min(imageHeight - 1, Math.round(py + radius));

  let sum = 0;
  let count = 0;
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      sum += data[(y * imageWidth + x) * 4 + 3]!;
      count += 1;
    }
  }
  return count === 0 ? 0 : sum / count / 255;
};

/**
 * Mede a forma real de um conjunto de glifos, lendo o próprio canvas do
 * atlas — o mesmo bitmap que a GPU usa para desenhar, fonte do sistema e
 * glifos à mão inclusos. Só roda quando o atlas é (re)construído.
 */
export const buildShapeEntries = (
  atlas: GlyphAtlasCanvas,
  glyphs: readonly number[],
): GlyphShapeEntry[] => {
  const ctx = atlas.canvas.getContext("2d");
  if (ctx === null) throw new Error("Canvas 2D indisponível para medir glifos.");

  const cellWidth = atlas.cellWidth;
  const cellHeight = cellWidth * CELL_ASPECT;
  const radius = cellWidth * SAMPLE_RADIUS_FRACTION;
  const strideX = cellWidth + atlas.pad * 2;
  const strideY = cellHeight + atlas.pad * 2;

  return glyphs.map((glyph) => {
    const col = glyph % atlas.cols;
    const row = Math.floor(glyph / atlas.cols);
    const boxX = col * strideX + atlas.pad;
    const boxY = row * strideY + atlas.pad;

    const image = ctx.getImageData(boxX, boxY, cellWidth, cellHeight);
    const data = image.data;

    const vector = new Float32Array(SAMPLE_COUNT);
    let coverageSum = 0;
    for (let i = 0; i < SAMPLE_COUNT; i += 1) {
      const sample = INTERNAL_SAMPLES[i]!;
      const density = averageAlpha(
        data,
        cellWidth,
        cellHeight,
        sample.x * cellWidth,
        sample.y * cellHeight,
        radius,
      );
      vector[i] = density;
      coverageSum += density;
    }

    const coverage = coverageSum / SAMPLE_COUNT;
    let varianceSum = 0;
    for (let i = 0; i < SAMPLE_COUNT; i += 1) {
      const delta = vector[i]! - coverage;
      varianceSum += delta * delta;
    }

    return { glyph, vector, coverage, variance: varianceSum / SAMPLE_COUNT };
  });
};

/** `entries`, ordenado por `coverage` ascendente — pré-requisito das buscas abaixo. */
export const sortByCoverage = (
  entries: readonly GlyphShapeEntry[],
): GlyphShapeEntry[] => [...entries].sort((a, b) => a.coverage - b.coverage);

/** Primeira posição em `entries[lo,hi)` (ordenado por cobertura) com `coverage >= value`. */
const lowerBound = (
  entries: readonly GlyphShapeEntry[],
  value: number,
  lo: number,
  hi: number,
): number => {
  let low = lo;
  let high = hi;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (entries[mid]!.coverage < value) low = mid + 1;
    else high = mid;
  }
  return low;
};

/**
 * O glifo de `entries` (ordenado por cobertura) cuja cobertura está mais
 * perto de `target`, nunca abaixo de `minCoverage`.
 *
 * Busca binária: a posição de inserção mais a comparação dos dois vizinhos.
 * Substitui o scan linear de antes — com o pool crescendo de dezenas para os
 * ~256 glifos da CP437 inteira e a hachura de face gerando milhares de
 * fragmentos por quadro, O(N) por fragmento deixaria de caber no orçamento;
 * O(log N) faz o tamanho do pool parar de importar.
 */
export const nearestByCoverage = (
  entries: readonly GlyphShapeEntry[],
  target: number,
  minCoverage: number,
): number => {
  const from = lowerBound(entries, minCoverage, 0, entries.length);
  const start = Math.min(from, entries.length - 1);
  const pos = lowerBound(entries, target, start, entries.length);

  let bestGlyph = entries[start]!.glyph;
  let bestDistance = Infinity;
  if (pos > start) {
    const below = entries[pos - 1]!;
    const distance = Math.abs(below.coverage - target);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestGlyph = below.glyph;
    }
  }
  if (pos < entries.length) {
    const above = entries[pos]!;
    const distance = Math.abs(above.coverage - target);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestGlyph = above.glyph;
    }
  }
  return bestGlyph;
};

/**
 * O glifo de `entries` (ordenado por cobertura) que melhor concilia a forma
 * de `targetVector` com a cobertura-alvo `targetLevel`, ponderada por
 * `weight` contra as seis dimensões de forma — `weight = 0` reduz ao
 * casamento de forma puro, sem a luz opinar.
 *
 * Busca por janela, não pelo pool inteiro: o centro é a posição, no array
 * ordenado por cobertura, da média ponderada entre a cobertura que a própria
 * forma já sugere e o nível que a luz pede — é onde o mínimo da métrica
 * combinada tende a estar. Só os `window` candidatos ao redor desse centro
 * entram na distância de verdade, então o custo por fragmento não cresce com
 * o tamanho do pool (crucial para aresta/disco: poucos fragmentos por
 * quadro, mas cada um já pagava essa busca mesmo quando o resultado era
 * descartado depois — ver `ramp.ts`).
 */
export const nearestWeightedGlyph = (
  entries: readonly GlyphShapeEntry[],
  targetVector: Float32Array,
  targetLevel: number,
  weight: number,
  window: number,
): number => {
  if (entries.length === 0) {
    throw new Error("nearestWeightedGlyph chamado sem candidatos.");
  }

  let shapeCoverage = 0;
  for (let i = 0; i < SAMPLE_COUNT; i += 1) shapeCoverage += targetVector[i]!;
  shapeCoverage /= SAMPLE_COUNT;

  const center = (shapeCoverage + weight * targetLevel) / (1 + weight);

  const half = window >> 1;
  const maxStart = Math.max(0, entries.length - window);
  const start = Math.max(
    0,
    Math.min(lowerBound(entries, center, 0, entries.length) - half, maxStart),
  );
  const end = Math.min(entries.length, start + window);

  let bestGlyph = entries[start]!.glyph;
  let bestDistance = Infinity;
  for (let i = start; i < end; i += 1) {
    const entry = entries[i]!;
    let distance = 0;
    for (let k = 0; k < SAMPLE_COUNT; k += 1) {
      const delta = targetVector[k]! - entry.vector[k]!;
      distance += delta * delta;
    }
    const levelDelta = targetLevel - entry.coverage;
    distance += weight * levelDelta * levelDelta;
    if (distance < bestDistance) {
      bestDistance = distance;
      bestGlyph = entry.glyph;
    }
  }
  return bestGlyph;
};

/**
 * Cobertura de uma reta infinita nas dezoito amostras (seis internas, doze
 * externas), a partir de onde ela cruza a célula e para onde aponta.
 *
 * `offsetCol`/`offsetRow` são o deslocamento subcélula que o DDA já calcula
 * (fração entre -0.5 e 0.5 até o centro da célula), e `dirCol`/`dirRow` a
 * direção do segmento em unidades de coluna/fileira — sem correção de
 * `CELL_ASPECT`: tanto essas unidades quanto as amostras do atlas (§ acima)
 * vivem na mesma caixa 1:2 da célula, então já concordam sem reescalar.
 */
export const sampleLineCoverage = (
  out: Float32Array,
  offsetCol: number,
  offsetRow: number,
  dirCol: number,
  dirRow: number,
  halfThickness: number,
): void => {
  const lineX = 0.5 + offsetCol;
  const lineY = 0.5 + offsetRow;

  for (let i = 0; i < SAMPLE_COUNT; i += 1) {
    const sample = INTERNAL_SAMPLES[i]!;
    const distance = Math.abs(
      (sample.x - lineX) * dirRow - (sample.y - lineY) * dirCol,
    );
    out[i] = Math.max(0, 1 - distance / halfThickness);
  }
  for (let i = 0; i < EXTERNAL_COUNT; i += 1) {
    const sample = EXTERNAL_SAMPLES[i]!;
    const distance = Math.abs(
      (sample.x - lineX) * dirRow - (sample.y - lineY) * dirCol,
    );
    out[SAMPLE_COUNT + i] = Math.max(0, 1 - distance / halfThickness);
  }
};

/**
 * Cobertura da borda de um círculo nas dezoito amostras, para a silhueta de
 * um corpo redondo (orbe, sol). `nx`/`ny` são o offset da célula ao centro
 * já normalizado pelo raio, como `disc()` entrega; `radiusCols`/`radiusRows`
 * convertem o offset de cada amostra (em fração de célula) para essas
 * mesmas unidades antes de medir a distância até a borda (`|distância−1|`).
 */
export const sampleDiscCoverage = (
  out: Float32Array,
  nx: number,
  ny: number,
  radiusCols: number,
  radiusRows: number,
  edgeThickness: number,
): void => {
  const project = (sample: SamplePoint, index: number): void => {
    const sx = nx + (sample.x - 0.5) / radiusCols;
    const sy = ny + (sample.y - 0.5) / radiusRows;
    const distanceFromEdge = Math.abs(Math.sqrt(sx * sx + sy * sy) - 1);
    out[index] = Math.max(0, 1 - distanceFromEdge / edgeThickness);
  };

  for (let i = 0; i < SAMPLE_COUNT; i += 1) project(INTERNAL_SAMPLES[i]!, i);
  for (let i = 0; i < EXTERNAL_COUNT; i += 1)
    project(EXTERNAL_SAMPLES[i]!, SAMPLE_COUNT + i);
};

/**
 * Quanto o expoente esmaga valores fracos e preserva o pico — mesma família
 * do realce de contraste do artigo.
 */
const CONTRAST_EXPONENT = 1.6;

const boost = (value: number, referenceMax: number): number => {
  if (referenceMax <= 1e-4) return value;
  const normalized = Math.min(1, value / referenceMax);
  return normalized ** CONTRAST_EXPONENT * referenceMax;
};

/**
 * Realce de contraste direcional (§3b): puxa cada amostra interna para
 * concordar com o que as externas mais próximas dizem sobre a continuação
 * da forma além da borda — é o que evita o vizinho-mais-próximo pular de
 * glifo por um triz entre duas células vizinhas da mesma aresta.
 *
 * `samples` tem `TOTAL_SAMPLE_COUNT` posições (interno + externo, na ordem
 * de `sampleLineCoverage`); `out` recebe só as seis internas, realçadas.
 */
export const enhanceContrast = (
  out: Float32Array,
  samples: Float32Array,
): void => {
  for (let i = 0; i < SAMPLE_COUNT; i += 1) {
    const affecting = AFFECTING_EXTERNAL[i]!;
    let referenceMax = 0;
    for (const externalIndex of affecting) {
      // `externalIndex` já é a posição no vetor combinado (6..17, como
      // `EXTERNAL_SAMPLES` numera nos comentários) — não soma `SAMPLE_COUNT`
      // de novo, senão lê fora do array e todo realce vira `NaN`.
      referenceMax = Math.max(referenceMax, samples[externalIndex]!);
    }
    out[i] = boost(samples[i]!, referenceMax);
  }
};
