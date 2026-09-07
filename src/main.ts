import './styles/index.css';

import { degreesToRadians, settings } from './config';
import { requireElement } from './dom';
import { FreeCam } from './core/freecam';
import { GameLoop } from './core/loop';
import { Input } from './core/input';
import { Camera } from './render/camera';
import { drawDebugPattern } from './render/debug-pattern';
import { countByColor, dumpGlyphs } from './render/debug-dump';
import { Framebuffer } from './render/framebuffer';
import { GlPresenter } from './render/gl/presenter';
import { Rasterizer, createProjected } from './render/rasterizer';
import { type Viewport, computeViewport, viewportEquals } from './render/viewport';
import { Ground } from './scene/ground';
import { Scene } from './scene/scene';
import { Sky } from './scene/sky';
import { Sun, sunDirection } from './scene/sun';
import { createExportDialog } from './ui/export';
import { Hud } from './ui/hud';
import { buildControlPanel } from './ui/panel';

const canvas = requireElement<HTMLCanvasElement>('canvas');
const presenter = new GlPresenter(canvas);

const camera = new Camera();
const rasterizer = new Rasterizer();
const input = new Input(canvas);
const freecam = new FreeCam(camera, input);
const hud = new Hud(requireElement('hud'));

const scene = new Scene();
scene.add(new Sky());
scene.add(new Sun());
scene.add(new Ground());

// Reaproveitados a cada quadro; o gradiente de fundo segue o sol de verdade.
const atmosphere = { sunU: 0.5, sunV: 0.5, horizonV: 0.5 };
const sunDir = { x: 0, y: 0, z: -1 };
const sunScreen = createProjected();

let viewport: Viewport | null = null;
let framebuffer: Framebuffer | null = null;

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
    atmosphere.horizonV = 1 - rasterizer.horizonRow() / currentViewport.rowCount;

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
    scene.render({ camera, viewport: currentViewport, rasterizer, time });

    updateAtmosphere(currentViewport);
    presenter.present(framebuffer, atmosphere);
    hud.update(camera, time, input.isLocked);
};

buildControlPanel(
    createExportDialog((scale) => {
        if (framebuffer === null) throw new Error('Nada renderizado ainda.');
        return presenter.capture(framebuffer, atmosphere, scale);
    }),
);

new GameLoop(update, render).start();

// Alça de diagnóstico: dirigir a câmera pelo console é o único jeito prático de
// checar near plane, horizonte e paralaxe de forma repetível. Só em dev.
if (import.meta.env.DEV) {
    Object.assign(window, {
        engine: {
            camera, settings, scene, presenter, input, freecam,
            getFramebuffer: () => framebuffer,
            dumpGlyphs: () => (framebuffer === null ? '' : dumpGlyphs(framebuffer)),
            countByColor: () => (framebuffer === null ? {} : countByColor(framebuffer)),
            // Congela a cena e mostra o charset em cada cor: confere atlas e paleta.
            showCharset: () => {
                if (framebuffer === null) return;
                drawDebugPattern(framebuffer);
                presenter.present(framebuffer, atmosphere);
            },
            capture: (scale: number) => presenter.capture(framebuffer!, atmosphere, scale),
        },
    });
}
