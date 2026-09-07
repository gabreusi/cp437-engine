import { settings } from '../config';
import { COLOR, GLYPH } from './palette';
import { SLOPE, type Fragment, type LineStyle, type Slope } from './rasterizer';

/** Onde as linhas horizontais deixam de ser `_` rente ao chão e viram `-`. */
const UNDERSCORE_RANGE = 0.12;

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

const glyphForSlope = (slope: Slope, depth: number): number => {
    switch (slope) {
        case SLOPE.VERTICAL:
            return GLYPH.PIPE;
        case SLOPE.UP:
            return GLYPH.SLASH;
        case SLOPE.DOWN:
            return GLYPH.BACKSLASH;
        default:
            // Perto, `_` assenta no chão; longe, `-` pesa menos. Mesma regra da
            // versão anterior, agora por profundidade real e não por fileira.
            return depth < settings.viewDistance * UNDERSCORE_RANGE
                ? GLYPH.UNDERSCORE
                : GLYPH.DASH;
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
