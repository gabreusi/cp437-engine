import { settings } from "../../config";
import { EMISSIVE_RANGE, type Framebuffer } from "../framebuffer";
import { SHADOW_THRESHOLD } from "../../light/shade";
import type { LightWorld } from "../../light/world";
import type { Camera } from "../camera";
import type { ShadedPlanes } from "../debug-dump";
import {
  AREA_LUT_LEVELS,
  AREA_LUT_ROWS,
  buildAreaGlyphLut,
  buildEdgeShapePool,
  updateGlyphShapeTable,
} from "../ramp";
import type { Viewport } from "../viewport";
import type { Presenter } from "../gl/presenter";
import { type GlyphAtlas, atlasCellWidthFor, buildGlyphAtlas } from "./atlas";
import { GpuContext } from "./context";
import { type Atmosphere, BackgroundPass } from "./passes/background";
import { BloomPass } from "./passes/bloom";
import { CompositePass } from "./passes/composite";
import { GridPass } from "./passes/grid";
import { ShadingPass } from "./passes/shading";
import { RenderTarget } from "./target";

export type { Atmosphere };

/** Formato HDR de todo alvo intermediário — ver o comentário de `RenderTarget`. */
const SCENE_FORMAT: GPUTextureFormat = "rgba16float";

/** Período das scanlines em pixels CSS, o mesmo do CSS que elas substituem. */
const SCANLINE_PERIOD_CSS = 5;

interface Resources {
  shading: ShadingPass;
  grid: GridPass;
  background: BackgroundPass;
  bloom: BloomPass;
  composite: CompositePass;
  scene: RenderTarget;
  atlas: GlyphAtlas | null;
  atlasCellWidth: number;
}

/**
 * Onde o framebuffer da CPU vira pixels — backend WebGPU. Implementa a mesma
 * interface `Presenter` que `render/gl/presenter.ts::GlPresenter`, então
 * `main.ts` não sabe qual dos dois está por baixo.
 *
 * A diferença estrutural: criação de dispositivo é assíncrona
 * (`navigator.gpu.requestAdapter/requestDevice`), então `resources` só
 * existe depois que `GpuContext.whenReady()` resolve — até lá, todo método
 * é um no-op seguro, do mesmo jeito que `isLost` já protegia o backend
 * WebGL2 contra desenhar sem contexto.
 */
export class GpuPresenter implements Presenter {
  private readonly context: GpuContext;
  private resources: Resources | null = null;
  private viewport: Viewport | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.context = new GpuContext(canvas);
    this.context.onRestore(() => this.createResources());
    void this.context.whenReady().then(() => {
      this.createResources();
      if (this.viewport !== null) this.applyResize(this.viewport);
    });
  }

  private createResources(): void {
    if (!this.context.isReady) return;
    const { device, format } = this.context;
    const width = Math.max(1, this.viewport?.pixelWidth ?? 1);
    const height = Math.max(1, this.viewport?.pixelHeight ?? 1);

    this.resources = {
      shading: new ShadingPass(device),
      grid: new GridPass(device, SCENE_FORMAT),
      background: new BackgroundPass(device, SCENE_FORMAT),
      bloom: new BloomPass(device, width, height, SCENE_FORMAT),
      composite: new CompositePass(device, format),
      scene: new RenderTarget(device, width, height, SCENE_FORMAT),
      atlas: null,
      atlasCellWidth: 0,
    };

    if (this.viewport !== null) this.applyResize(this.viewport);
  }

  /** Ver o comentário em `Presenter.isAtlasReady` — aqui só depois que `whenReady()` resolver. */
  isAtlasReady(): boolean {
    return this.resources?.atlas !== null && this.resources?.atlas !== undefined;
  }

  resize(viewport: Viewport): void {
    this.viewport = viewport;
    this.applyResize(viewport);
  }

  private applyResize(viewport: Viewport): void {
    const resources = this.resources;
    if (!this.context.isReady || resources === null) return;

    this.context.resize(viewport);
    resources.shading.resize(viewport.colCount, viewport.rowCount);
    resources.grid.resize(viewport.colCount, viewport.rowCount);
    resources.scene.resize(viewport.pixelWidth, viewport.pixelHeight);
    resources.bloom.resize(viewport.pixelWidth, viewport.pixelHeight);

    const cellWidth = atlasCellWidthFor(viewport.cellWidth * viewport.dpr);
    if (resources.atlas === null || cellWidth !== resources.atlasCellWidth) {
      this.rebuildAtlas(cellWidth);
      resources.atlasCellWidth = cellWidth;
    }
  }

  /**
   * Refaz o atlas e tudo que depende da forma medida dos glifos — mesma
   * hora de sempre (resize/DPI/perda de dispositivo), ver
   * `render/gl/presenter.ts::rebuildGlyphAtlas`.
   */
  private rebuildAtlas(cellWidth: number): void {
    const resources = this.resources;
    if (resources === null) return;

    resources.atlas = buildGlyphAtlas(this.context.device, cellWidth);
    resources.grid.setAtlas(resources.atlas);
    updateGlyphShapeTable(resources.atlas);

    const edgeNear = buildEdgeShapePool(true);
    const edgeFar = buildEdgeShapePool(false);
    resources.shading.setGlyphLuts(
      buildAreaGlyphLut(),
      AREA_LUT_ROWS,
      AREA_LUT_LEVELS,
      edgeNear,
      edgeNear.length / 8,
      edgeFar,
      edgeFar.length / 8,
    );
  }

  /**
   * Refaz o atlas com o tamanho de célula atual — chamado de
   * `ensureFontLoaded().then(...)` em `main.ts`, ver o comentário
   * equivalente em `GlPresenter.refreshAtlas`.
   */
  refreshAtlas(): void {
    const resources = this.resources;
    const viewport = this.viewport;
    if (!this.context.isReady || resources === null || viewport === null) return;

    const cellWidth = atlasCellWidthFor(viewport.cellWidth * viewport.dpr);
    this.rebuildAtlas(cellWidth);
    resources.atlasCellWidth = cellWidth;
  }

  private runShading(
    encoder: GPUCommandEncoder,
    framebuffer: Framebuffer,
    lights: LightWorld,
    camera: Camera,
  ): void {
    const resources = this.resources;
    if (resources === null) return;

    resources.shading.dispatch(
      encoder,
      framebuffer,
      lights,
      camera.position.x,
      camera.position.y,
      camera.position.z,
      {
        shadowsEnabled: settings.shadowsEnabled,
        shadowThreshold: SHADOW_THRESHOLD,
        maxShadowLights: Math.round(settings.maxShadowLights),
        groundFillLight: settings.groundFillLight,
        rampWeight: settings.lightingEnabled ? settings.rampWeight : 0,
        rampExposure: settings.rampExposure,
        emissiveRange: EMISSIVE_RANGE,
      },
    );
  }

  present(
    framebuffer: Framebuffer,
    atmosphere: Atmosphere,
    lights: LightWorld,
    camera: Camera,
  ): void {
    const resources = this.resources;
    const viewport = this.viewport;
    if (!this.context.isReady || resources === null || viewport === null) return;
    const shadingCells = resources.shading.cellsTexture;
    const shadingColors = resources.shading.colorsTexture;
    if (shadingCells === null || shadingColors === null) return;

    const { device } = this.context;
    const encoder = device.createCommandEncoder({ label: "frame" });

    this.runShading(encoder, framebuffer, lights, camera);

    const scenePass = encoder.beginRenderPass({
      label: "scene",
      colorAttachments: [
        { view: resources.scene.view, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } },
      ],
    });
    resources.background.draw(scenePass, atmosphere, viewport.pixelWidth, viewport.pixelHeight, settings.groundHaze);
    resources.grid.draw(scenePass, shadingCells, shadingColors);
    scenePass.end();

    resources.bloom.render(encoder, resources.scene.view, settings.bloomRadius);

    const canvasView = this.context.canvasTexture.createView();
    const compositePass = encoder.beginRenderPass({
      label: "composite",
      colorAttachments: [{ view: canvasView, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
    });
    resources.composite.draw(
      compositePass,
      resources.scene.view,
      resources.bloom.halfView,
      resources.bloom.quarterView,
      {
        bloomIntensity: settings.bloomIntensity,
        scanlinePeriod: SCANLINE_PERIOD_CSS * viewport.dpr,
        scanlineStrength: settings.scanlineStrength,
        vignetteStrength: settings.vignetteStrength,
      },
    );
    compositePass.end();

    device.queue.submit([encoder.finish()]);
  }

  /**
   * Renderiza um quadro extra fora da tela, em resolução ampliada, e lê de
   * volta — ver o comentário equivalente em `GlPresenter.capture`. Assíncrono
   * aqui porque `mapAsync` não tem versão síncrona em WebGPU (diferente de
   * `gl.readPixels`); quem chama espera a promise resolver antes de usar o
   * canvas devolvido.
   */
  async capture(
    framebuffer: Framebuffer,
    atmosphere: Atmosphere,
    lights: LightWorld,
    camera: Camera,
    scale: number,
  ): Promise<HTMLCanvasElement> {
    const resources = this.resources;
    const viewport = this.viewport;
    if (!this.context.isReady || resources === null || viewport === null) {
      throw new Error("Contexto WebGPU indisponível para a captura.");
    }

    const { device } = this.context;
    const width = Math.round(viewport.pixelWidth * scale);
    const height = Math.round(viewport.pixelHeight * scale);

    const encoder = device.createCommandEncoder({ label: "capture" });
    this.runShading(encoder, framebuffer, lights, camera);

    const scene = new RenderTarget(device, width, height, SCENE_FORMAT);
    const bloom = new BloomPass(device, width, height, SCENE_FORMAT);
    const target = new RenderTarget(device, width, height, "rgba8unorm");

    const scenePass = encoder.beginRenderPass({
      colorAttachments: [{ view: scene.view, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
    });
    resources.background.draw(scenePass, atmosphere, width, height, settings.groundHaze);
    const shadingCells = resources.shading.cellsTexture;
    const shadingColors = resources.shading.colorsTexture;
    if (shadingCells !== null && shadingColors !== null) {
      resources.grid.draw(scenePass, shadingCells, shadingColors);
    }
    scenePass.end();

    bloom.render(encoder, scene.view, settings.bloomRadius * scale);

    const composite = new CompositePass(device, "rgba8unorm");
    const compositePass = encoder.beginRenderPass({
      colorAttachments: [{ view: target.view, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
    });
    composite.draw(compositePass, scene.view, bloom.halfView, bloom.quarterView, {
      bloomIntensity: settings.bloomIntensity,
      scanlinePeriod: SCANLINE_PERIOD_CSS * viewport.dpr * scale,
      scanlineStrength: settings.scanlineStrength,
      vignetteStrength: settings.vignetteStrength,
    });
    compositePass.end();

    const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
    const readBuffer = device.createBuffer({
      size: bytesPerRow * height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    encoder.copyTextureToBuffer(
      { texture: target.texture },
      { buffer: readBuffer, bytesPerRow },
      { width, height },
    );

    device.queue.submit([encoder.finish()]);

    await readBuffer.mapAsync(GPUMapMode.READ);
    const mapped = new Uint8ClampedArray(readBuffer.getMappedRange().slice(0));
    readBuffer.unmap();
    readBuffer.destroy();
    scene.dispose();
    bloom.dispose();
    target.dispose();
    composite.dispose();

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (ctx === null) throw new Error("Canvas 2D indisponível para a captura.");
    const image = ctx.createImageData(width, height);
    for (let row = 0; row < height; row += 1) {
      const source = row * bytesPerRow;
      image.data.set(mapped.subarray(source, source + width * 4), row * width * 4);
    }
    ctx.putImageData(image, 0, 0);

    return canvas;
  }

  /** Ver `ShadingPass.readPlanes` (WebGL2) — aqui via `mapAsync`, então devolve uma promise. */
  async readShadedPlanes(): Promise<ShadedPlanes | null> {
    const resources = this.resources;
    const viewport = this.viewport;
    if (!this.context.isReady || resources === null || viewport === null) return null;
    const cellsTex = resources.shading.cellsTexture;
    const colorsTex = resources.shading.colorsTexture;
    if (cellsTex === null || colorsTex === null) return null;

    const { device } = this.context;
    const { colCount, rowCount } = viewport;
    const bytesPerRow = Math.ceil((colCount * 4) / 256) * 256;

    const readOne = async (texture: GPUTexture): Promise<Uint8Array> => {
      const buffer = device.createBuffer({
        size: bytesPerRow * rowCount,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer(
        { texture },
        { buffer, bytesPerRow },
        { width: colCount, height: rowCount },
      );
      device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const tight = new Uint8Array(colCount * rowCount * 4);
      const mapped = new Uint8Array(buffer.getMappedRange());
      for (let row = 0; row < rowCount; row += 1) {
        tight.set(mapped.subarray(row * bytesPerRow, row * bytesPerRow + colCount * 4), row * colCount * 4);
      }
      buffer.unmap();
      buffer.destroy();
      return tight;
    };

    const [cells, colors] = await Promise.all([readOne(cellsTex), readOne(colorsTex)]);
    return { colCount, rowCount, cells, colors };
  }

  dispose(): void {
    const resources = this.resources;
    if (resources === null) return;

    resources.shading.dispose();
    resources.grid.dispose();
    resources.background.dispose();
    resources.bloom.dispose();
    resources.composite.dispose();
    resources.scene.dispose();
    this.resources = null;
  }
}
