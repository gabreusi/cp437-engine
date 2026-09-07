import './styles/index.css';

import {degreesToRadians, settings} from './config';
import {requireElement} from './dom';
import {FreeCam} from './core/freecam';
import {GameLoop} from './core/loop';
import {type UiEvents, Input, createUiEvents} from './core/input';
import type {ShadeOptions} from './light/shade';
import {LightWorld} from './light/world';
import {setRgb} from './math/color';
import {Camera} from './render/camera';
import {drawDebugPattern} from './render/debug-pattern';
import {countByColor, dumpGlyphs} from './render/debug-dump';
import {Framebuffer} from './render/framebuffer';
import {GlPresenter} from './render/gl/presenter';
import {Rasterizer, createProjected} from './render/rasterizer';
import {type Viewport, computeViewport, viewportEquals} from './render/viewport';
import {Ground} from './scene/ground';
import {Scene} from './scene/scene';
import {Sky} from './scene/sky';
import {Sun, sunDirection} from './scene/sun';
import {World} from './scene/world';
import {type FrameStats, Hud} from './ui/hud';
import {Menu} from './ui/menu/menu';
import {buildGroups} from './ui/menu/schema';

const canvas = requireElement<HTMLCanvasElement>('canvas');
const presenter = new GlPresenter(canvas);

const camera = new Camera();
const rasterizer = new Rasterizer();
const input = new Input(canvas);
const freecam = new FreeCam(camera, input);
const hud = new Hud(requireElement('hud'));


const world = new World();
if (!world.load()) world.loadDemo();

const scene = new Scene();
scene.add(new Sky());
scene.add(new Sun());
scene.add(new Ground());
scene.add(world);

/**
 * O mundo de luz, reconstruído a cada quadro e nunca realocado.
 *
 * Vive aqui e não dentro da cena porque quem o preenche são os objetos e quem o
 * consome é o sombreamento: nenhum dos dois é dono.
 */
const lights = new LightWorld();
const stats: FrameStats = {sceneMs: 0, lights: 0, occluders: 0};
const shadeOptions: ShadeOptions = {
    shadows: true,
    reflections: true,
    // Contribuição abaixo disto não muda glifo nem cor, e não paga um raio.
    shadowThreshold: 0.004,
    maxShadowLights: 3,
};

/**
 * Ambiente frio, na cor do céu.
 *
 * Branco puro achataria a cena: o que preenche a sombra num crepúsculo é a
 * abóbada inteira, que aqui é roxa e ciano. É pouca luz, mas é ela que impede
 * o que está atrás de um monólito de virar buraco preto.
 */
const AMBIENT_TINT = {r: 0.42, g: 0.55, b: 1};

const menu = new Menu(buildGroups(world), world, input);
const uiEvents: UiEvents = createUiEvents();

const renderContext = {
    camera,
    viewport: null as unknown as Viewport,
    rasterizer,
    time: 0,
    lights,
    shading: shadeOptions,
};

// Reaproveitados a cada quadro; o gradiente de fundo segue o sol de verdade.
const atmosphere = {sunU: 0.5, sunV: 0.5, horizonV: 0.5, groundV: 0.5, hazeScale: 0};
const sunDir = {x: 0, y: 0, z: -1};
const sunScreen = createProjected();

let viewport: Viewport | null = null;
let framebuffer: Framebuffer | null = null;

/**
 * Camada de diagnóstico desenhada por cima da cena, quando ligada.
 *
 * Um toggle e não uma chamada avulsa: desenhar uma vez e devolver o controle ao
 * loop pinta a tabela por um quadro e o quadro seguinte já a apagou, o que
 * torna impossível olhar para ela. Como sobreposição, ela fica.
 */
let debugOverlay: ((target: Framebuffer) => void) | null = null;

const syncViewport = (): Viewport => {
    const next = computeViewport(window.innerWidth, window.innerHeight, window.devicePixelRatio);
    if (viewport === null || !viewportEquals(viewport, next)) {
        viewport = next;
        framebuffer = new Framebuffer(next.colCount, next.rowCount);
        presenter.resize(next);
    }
    return viewport;
};

const update = (deltaSeconds: number): void => {
    camera.fov = degreesToRadians(settings.fovDegrees);
    freecam.update(deltaSeconds);
};

/** Converte sol e horizonte para UV, com y para cima, como o shader espera. */
const updateAtmosphere = (currentViewport: Viewport): void => {
    const horizonRow = rasterizer.horizonRow();
    atmosphere.horizonV = 1 - horizonRow / currentViewport.rowCount;

    // A bruma começa na base da célula do horizonte, que é onde o `_` desenha.
    // `Math.round` tem que casar com o arredondamento de `Sky.drawHorizon`,
    // senão a bruma escorrega uma célula em relação à linha.
    atmosphere.groundV =
        1 - (Math.round(horizonRow) + 1) / currentViewport.rowCount;

    // Mesma névoa que apaga a grade, resolvida para a distância do chão em cada
    // fileira: `distância ≈ altura * focal / (2 * abaixoDoHorizonte)`. Tudo o
    // que não depende da fileira cabe nesta constante.
    const focalY = 1 / Math.tan(camera.fov / 2);
    const height = Math.max(0, camera.position.y);
    atmosphere.hazeScale = settings.fogEnabled
        ? (height * focalY * settings.fogDensity * 1.6) / (2 * settings.viewDistance)
        : 0;

    sunDirection(sunDir);
    if (rasterizer.projectDirection(sunDir.x, sunDir.y, sunDir.z, sunScreen)) {
        atmosphere.sunU = sunScreen.col / currentViewport.colCount;
        atmosphere.sunV = 1 - sunScreen.row / currentViewport.rowCount;
    } else {
        // Sol atrás da câmera: joga o halo para longe em vez de espelhá-lo.
        atmosphere.sunV = -5;
    }
};

const render = (time: number): void => {
    const currentViewport = syncViewport();
    if (framebuffer === null) return;

    framebuffer.clear();
    rasterizer.begin(camera, currentViewport, framebuffer);

    lights.begin();
    setRgb(
        lights.ambient,
        AMBIENT_TINT.r * settings.ambientLevel,
        AMBIENT_TINT.g * settings.ambientLevel,
        AMBIENT_TINT.b * settings.ambientLevel,
    );
    shadeOptions.shadows = settings.shadowsEnabled;
    shadeOptions.reflections = settings.reflectionsEnabled;
    shadeOptions.maxShadowLights = Math.round(settings.maxShadowLights);

    renderContext.viewport = currentViewport;
    renderContext.time = time;

    // Duas passadas: primeiro quem ilumina e quem bloqueia luz se anuncia,
    // depois todo mundo desenha. Sem isso a sombra de um objeto dependeria da
    // posição dele na lista da cena.
    const sceneStart = performance.now();
    scene.contribute(renderContext);
    scene.render(renderContext);
    // O menu é desenhado depois da cena e por cima dela, mas fora da medição:
    // é interface, e misturá-la ao custo da cena esconderia justamente o que o
    // número serve para vigiar.
    stats.sceneMs = performance.now() - sceneStart;
    stats.lights = lights.lightCount;
    stats.occluders = lights.occluderCount;

    input.consumeUi(uiEvents);
    menu.update(uiEvents, currentViewport, camera, rasterizer, lights);
    menu.draw(framebuffer);

    debugOverlay?.(framebuffer);

    updateAtmosphere(currentViewport);
    presenter.present(framebuffer, atmosphere);
    hud.update(camera, time, input.isLocked, stats);
};

new GameLoop(update, render).start();

// Alça de diagnóstico: dirigir a câmera pelo console é o único jeito prático de
// checar near plane, horizonte e paralaxe de forma repetível. Só em dev.
if (import.meta.env.DEV) {
    Object.assign(window, {
        engine: {
            camera, settings, scene, world, lights, menu, presenter, input, freecam, rasterizer,
            getFramebuffer: () => framebuffer,
            dumpGlyphs: () => (framebuffer === null ? '' : dumpGlyphs(framebuffer)),
            countByColor: () => (framebuffer === null ? {} : countByColor(framebuffer)),
            // Cobre a cena com o charset inteiro: confere atlas e data textures.
            // Chamar de novo desliga.
            showCharset: () => {
                debugOverlay = debugOverlay === null ? drawDebugPattern : null;
                return debugOverlay !== null ? 'ligado' : 'desligado';
            },
            // Qualquer desenho por cima da cena, para experimentar do console.
            setOverlay: (draw: ((target: Framebuffer) => void) | null) => {
                debugOverlay = draw;
            },
            /**
             * Um quadro sob demanda, sem esperar o navegador.
             *
             * Numa aba em segundo plano o `requestAnimationFrame` não dispara, e
             * a engine fica parada com o último quadro na tela — o que faz
             * qualquer verificação de "mudei o ajuste, o que aconteceu?" medir o
             * quadro anterior e concluir que nada mudou.
             */
            step: (deltaSeconds = 1 / 60) => {
                update(deltaSeconds);
                render(performance.now());
            },
            capture: (scale: number) => presenter.capture(framebuffer!, atmosphere, scale),
        },
    });
}
