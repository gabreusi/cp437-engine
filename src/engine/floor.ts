import { settings } from '../config';
import type { Layout } from '../types';
import type { CharBuffer } from './buffer';
import { hashNoise } from './noise';

/** Ciano mais apagado perto do horizonte: é o que dá sensação de distância. */
const depthClassFor = (rowOffset: number, layout: Layout): string => {
    if (rowOffset < layout.compressedRowLimit) return 'c2';
    if (rowOffset < layout.midRowLimit) return 'c1';
    return 'c0';
};

const drawHorizonBand = (buffer: CharBuffer, layout: Layout): void => {
    for (let col = 0; col < layout.colCount; col += 1) {
        buffer.plot(0, col, '_', 'hz');
    }
};

/**
 * Neblina logo abaixo do horizonte, onde as linhas de grade ainda não cabem.
 * A cobertura cresce ao quadrado para a névoa dissolver no horizonte em vez de
 * terminar numa borda reta.
 */
const drawHazeBand = (buffer: CharBuffer, layout: Layout): void => {
    if (!settings.enableHaze) return;

    for (let row = 1; row < layout.hazeRowLimit; row += 1) {
        const closeness = row / layout.hazeRowLimit;
        const coverage = 0.15 + 0.65 * closeness * closeness;
        for (let col = 0; col < layout.colCount; col += 1) {
            if (hashNoise(col + 11.3, row + 3.1) > coverage) continue;
            buffer.plot(row, col, '-', 'c2');
        }
    }
};

const drawRailSegment = (
    buffer: CharBuffer,
    row: number,
    colStart: number,
    colEnd: number,
    className: string,
): void => {
    const startCol = Math.round(colStart);
    const endCol = Math.round(colEnd);
    const segmentWidth = Math.abs(endCol - startCol);

    if (segmentWidth === 0) {
        buffer.plot(row, startCol, '|', className);
        return;
    }

    const direction = Math.sign(endCol - startCol);
    const slantChar = direction > 0 ? '\\' : '/';

    for (let offset = 0; offset < segmentWidth; offset += 1) {
        buffer.plot(row, startCol + direction * offset, slantChar, className);
    }
};

/** Trilhos que convergem no ponto de fuga, no centro do horizonte. */
const drawRails = (buffer: CharBuffer, layout: Layout): void => {
    for (let railIndex = -layout.railCount; railIndex <= layout.railCount; railIndex += 1) {
        const colDrift = railIndex * layout.colStepPerRow;
        for (let rowOffset = layout.railStartRow; rowOffset < layout.floorRowCount; rowOffset += 1) {
            const colAtRow = layout.centerCol + colDrift * rowOffset;
            const colAtNextRow = layout.centerCol + colDrift * (rowOffset + 1);
            drawRailSegment(buffer, rowOffset, colAtRow, colAtNextRow, depthClassFor(rowOffset, layout));
        }
    }
};

/**
 * Linhas horizontais correndo em direção ao observador — a única parte animada
 * do chão. `distance` só importa pelo resto da divisão pelo espaçamento, então
 * a cena roda para sempre sem acumular erro de ponto flutuante.
 */
const drawDepthLines = (buffer: CharBuffer, layout: Layout, distance: number): void => {
    const spacing = settings.lineSpacingWorld;
    const travelPhase = distance % spacing;
    const visibleLineCount = Math.floor((layout.focalLength + travelPhase) / spacing);
    let lastDrawnRow = -1;

    for (let lineIndex = 0; lineIndex < visibleLineCount; lineIndex += 1) {
        const depth = (lineIndex + 1) * spacing - travelPhase;
        const rowOffset = Math.round(layout.focalLength / depth);

        // Longe demais, ou caindo na mesma linha que a anterior já ocupou.
        if (rowOffset >= layout.floorRowCount || rowOffset === lastDrawnRow) continue;
        if (rowOffset < layout.firstLineRow) continue;
        lastDrawnRow = rowOffset;

        const lineChar = rowOffset < layout.midRowLimit ? '-' : '_';
        const className = depthClassFor(rowOffset, layout);
        for (let col = 0; col < layout.colCount; col += 1) {
            buffer.plot(rowOffset, col, lineChar, className);
        }
    }
};

export const drawFloor = (buffer: CharBuffer, layout: Layout, distance: number): void => {
    buffer.clear();
    drawHorizonBand(buffer, layout);
    drawHazeBand(buffer, layout);
    drawRails(buffer, layout);
    drawDepthLines(buffer, layout, distance);
};
