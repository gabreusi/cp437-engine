import { settings } from '../config';
import { type Rgb, copyRgb, rgb, setRgb } from '../math/color';
import { NO_OWNER, type ShadeOptions, shadeSurface } from '../light/shade';
import type { Material } from '../light/types';
import { LightWorld } from '../light/world';
import type { RenderContext } from '../scene/scene';
import { COLOR, GLYPH } from './palette';
import { RAMP, glyphForLuminance } from './ramp';
import { SLOPE, type Fragment, type Slope, type SurfaceSample, type SurfaceStyle } from './rasterizer';

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
export const fogAmount = (depth: number): number => {
    if (!settings.fogEnabled) return 0;
    return Math.min(1, (depth / settings.viewDistance) * settings.fogDensity * 1.6);
};

/** O glifo que a geometria pediria, antes de a luz opinar. */
export const glyphForSlope = (slope: Slope, depth: number): number => {
    switch (slope) {
        case SLOPE.VERTICAL:
            return GLYPH.PIPE;
        case SLOPE.UP:
            return GLYPH.SLASH;
        case SLOPE.DOWN:
            return GLYPH.BACKSLASH;
        default:
            // Perto, `_` assenta no chão; longe, `-` pesa menos.
            return depth < settings.viewDistance * UNDERSCORE_RANGE
                ? GLYPH.UNDERSCORE
                : GLYPH.DASH;
    }
};

export const createMaterial = (overrides: Partial<Material> = {}): Material => ({
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
    rampMode: typeof RAMP.CLASSIC | typeof RAMP.FAMILY | typeof RAMP.OFF;
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
    options: { shadows: true, reflections: true, shadowThreshold: 0.004, maxShadowLights: 3 },
    cameraX: 0,
    cameraY: 0,
    cameraZ: 0,
    rampMode: RAMP.OFF,
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

    // Sem iluminação a rampa some junto: o glifo volta a ser só geometria, e a
    // cena inteira volta a ser o que era antes de existir luz. É a referência
    // com que qualquer efeito daqui para frente é comparado.
    lit.rampMode = settings.lightingEnabled ? settings.glyphRamp : RAMP.OFF;
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
    geometric: number,
    out: Fragment,
): void => {
    if (!lit.lit) {
        copyRgb(out.color, material.albedo);
        out.emissive = material.emissiveStrength;
        out.glyph = geometric;
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
        sample.x, sample.y, sample.z,
        normalX, normalY, normalZ,
        viewX, viewY, viewZ,
        ownerId,
        lit.options,
        shaded,
    );

    writeHdrColor(out, shaded);
    out.glyph = glyphForLuminance(
        luminance,
        sample.slope,
        geometric,
        lit.rampMode,
        lit.rampExposure,
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
     * Último ajuste antes de sombrear, por fragmento.
     *
     * É por onde o chão troca o albedo pela faixa de distância certa. Fica como
     * gancho e não como caso especial dentro do estilo porque é a única coisa
     * que o chão faz diferente de qualquer outra superfície.
     */
    beforeShade: ((sample: SurfaceSample, material: Material) => void) | null = null;

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
            this.normalX, this.normalY, this.normalZ,
            this.ownerId,
            glyphForSlope(sample.slope, sample.depth),
            out,
        );

        out.alpha = (1 - fog) ** 1.2;

        // O nível mais baixo da rampa clássica é o espaço: a célula não some,
        // ela fica vazia. Descartar aqui poupa a escrita e o teste de
        // profundidade de algo que o shader descartaria por cobertura zero.
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
        const fog = fogAmount(sample.depth);
        const band =
            fog < BAND_NEAR ? COLOR.GRID_NEAR : fog < BAND_MID ? COLOR.GRID_MID : COLOR.GRID_FAR;

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
