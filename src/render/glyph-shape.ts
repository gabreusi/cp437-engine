import type { GlyphAtlas } from "./gl/atlas";
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
  atlas: GlyphAtlas,
  glyphs: readonly number[],
): GlyphShapeEntry[] => {
  const ctx = atlas.canvas.getContext("2d");
  if (ctx === null) throw new Error("Canvas 2D indisponível para medir glifos.");

  const cellWidth = atlas.cellWidth;
  const cellHeight = cellWidth * CELL_ASPECT;
  const radius = cellWidth * SAMPLE_RADIUS_FRACTION;

  return glyphs.map((glyph) => {
    const col = glyph % atlas.cols;
    const row = Math.floor(glyph / atlas.cols);
    const boxX = col * cellWidth;
    const boxY = row * cellHeight;

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

    return { glyph, vector, coverage: coverageSum / SAMPLE_COUNT };
  });
};

/**
 * O glifo candidato cujo vetor de seis dimensões mais se parece com o alvo.
 *
 * Força bruta: os conjuntos de candidatos são dezenas de glifos, não a CP437
 * inteira, e o artigo mede a mesma busca em menos de 0,15ms por 1000
 * consultas — não vale a complexidade de uma k-d tree para isto.
 */
export const nearestGlyph = (
  target: Float32Array,
  entries: readonly GlyphShapeEntry[],
): number => {
  if (entries.length === 0) {
    throw new Error("nearestGlyph chamado sem candidatos.");
  }

  let bestGlyph = entries[0]!.glyph;
  let bestDistance = Infinity;

  for (const entry of entries) {
    const vector = entry.vector;
    let distance = 0;
    for (let i = 0; i < SAMPLE_COUNT; i += 1) {
      const delta = target[i]! - vector[i]!;
      distance += delta * delta;
    }
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
