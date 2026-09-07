import { settings } from '../config';
import { COLOR, GLYPH } from './palette';
import { SLOPE, type Fragment, type LineStyle, type Slope } from './rasterizer';

/** Fração do alcance dentro da qual as linhas são desenhadas em traço pesado. */
const HEAVY_RANGE = 0.12;

const BAND_NEAR = 0.35;
const BAND_MID = 0.7;

/**
 * Quanto do fragmento a distância já comeu, de 0 (colado) a 1 (sumiu).
 *
 * Substitui as faixas por fileira de tela da versão anterior, que só
 * funcionavam porque o horizonte ficava sempre na mesma altura.
 */
const fogAmount = (depth: number): number => {
    if (!settings.fogEnabled) return 0;
    return Math.min(1, (depth / settings.viewDistance) * settings.fogDensity * 1.6);
};

/**
 * Glifos de box-drawing, não os caracteres de texto.
 *
 * `-` e `|` vinham da fonte e não encostavam nas células vizinhas, então a
 * grade saía tracejada. `─` e `│` são desenhados para preencher a célula
 * inteira e emendam. O peso do traço substitui o antigo par `_`/`-` como pista
 * de profundidade: perto é grosso, longe é fino.
 */
const glyphForSlope = (slope: Slope, depth: number): number => {
    const heavy = depth < settings.viewDistance * HEAVY_RANGE;

    switch (slope) {
        case SLOPE.VERTICAL:
            return heavy ? GLYPH.HEAVY_V : GLYPH.LINE_V;
        case SLOPE.UP:
            return GLYPH.LINE_UP;
        case SLOPE.DOWN:
            return GLYPH.LINE_DOWN;
        default:
            return heavy ? GLYPH.HEAVY_H : GLYPH.LINE_H;
    }
};

/**
 * Estilo das linhas do chão.
 *
 * A dissolução ao longe é alpha de verdade, no canal B da data texture, em vez
 * do dithering que a versão em DOM precisava usar — lá a célula só podia ter
 * caractere ou não ter. Como bônus, alpha não cintila quando a câmera anda,
 * e ruído em espaço de tela cintilaria.
 */
export const groundStyle: LineStyle = (depth: number, slope: Slope, out: Fragment): boolean => {
    const fog = fogAmount(depth);
    if (fog >= 1) return false;

    out.glyph = glyphForSlope(slope, depth);
    out.color = fog < BAND_NEAR ? COLOR.GRID_NEAR : fog < BAND_MID ? COLOR.GRID_MID : COLOR.GRID_FAR;
    out.alpha = Math.round(255 * (1 - fog) ** 1.2);
    return true;
};
