import { settings } from "../config";
import { copyRgb } from "../math/color";
import { type Vec3, vec3 } from "../math/vec3";
import { NO_OWNER } from "../light/shade";
import { COLOR } from "../render/palette";
import { TEXTURE_ID } from "../render/ramp";
import { createDeferredSurface } from "../render/framebuffer";
import { createGroundPen, createMaterial, fogAmount, groundBand } from "../render/shading";
import type { Renderable, RenderContext } from "./scene";

/**
 * Grade quadriculada infinita.
 *
 * As linhas são geradas em volta da câmera, não como uma malha fixa: a grade é
 * ancorada na célula onde a câmera está, então o número de linhas é constante e
 * o mundo não acaba por mais longe que se voe. É a generalização em duas
 * dimensões do `distance % lineSpacingWorld` que a animação original usava para
 * fazer as linhas correrem sem acumular erro de ponto flutuante.
 *
 * É também a maior superfície da cena, e a única que cobre metade da tela:
 * quase todo o custo de iluminação está aqui, e é por isso que o estilo do chão
 * corta névoa antes de qualquer conta de luz.
 */
export class Ground implements Renderable {
  private readonly pen = createGroundPen();

  /**
   * Material dedicado ao que um espelho vê do chão — separado de
   * `fillMaterial` de propósito: aquele é reescrito célula a célula dentro
   * do próprio `fillLitFloor()`, e ler esse ponteiro de outro objeto
   * dependeria de qual célula foi processada por último, uma dependência de
   * ordem que o contrato de `Renderable` proíbe. Este aqui só muda em
   * `contribute()`, antes de qualquer `render()` do quadro.
   */
  private readonly reflectionMaterial = createMaterial();

  private readonly ray: Vec3 = vec3();
  private readonly surface = createDeferredSurface();

  /**
   * Publica o material que um espelho vê do chão, antes de qualquer
   * `render()` do quadro — ver `LightWorld.groundMaterial` e o comentário em
   * `reflectionMaterial`. Cor fixa e plausível (`COLOR.GRID_MID`, a mesma
   * faixa que `groundBand` usa a meia distância): reproduzir a variação por
   * distância/textura da grade aqui exigiria a câmera, que `shadeSurface`
   * não recebe, só para um reflexo de um bounce só.
   */
  contribute(context: RenderContext): void {
    const material = this.reflectionMaterial;
    copyRgb(material.albedo, COLOR.GRID_MID);
    material.emissiveStrength = 0;
    material.reflectivity = settings.groundReflectivity;
    material.gloss = settings.groundGloss;
    material.mirror = true;
    context.lights.groundMaterial = material;
  }

  render(context: RenderContext): void {
    const { camera, rasterizer } = context;
    this.pen.begin(context);
    this.pen.texture = settings.gridTexture;

    const spacing = Math.max(0.1, settings.gridSize);
    const reach = settings.viewDistance;

    // Ancorar na célula da câmera é o que mantém a grade quieta enquanto se
    // anda: as linhas não deslizam, elas simplesmente já estão lá.
    const baseX = Math.floor(camera.position.x / spacing) * spacing;
    const baseZ = Math.floor(camera.position.z / spacing) * spacing;
    const lineCount = Math.ceil(reach / spacing);

    for (let index = -lineCount; index <= lineCount; index += 1) {
      const offset = index * spacing;

      // Paralelas a X.
      const z = baseZ + offset;
      rasterizer.line(baseX - reach, 0, z, baseX + reach, 0, z, this.pen.style);

      // Paralelas a Z.
      const x = baseX + offset;
      rasterizer.line(x, 0, baseZ - reach, x, 0, baseZ + reach, this.pen.style);
    }

    this.fillLitFloor(context);
  }

  /**
   * O chão entre as linhas, onde bate luz direta.
   *
   * Até aqui a iluminação do chão só existia *nas* linhas: uma poça de luz de
   * um orbe acendia os traços que passavam por dentro dela e deixava o quadrado
   * inteiro preto, o que lê como uma grade brilhante no vácuo e não como luz
   * caindo sobre uma superfície. Este é o vão preenchido.
   *
   * A varredura é em espaço de tela, e não em mundo, por três motivos. O
   * caminho inverso da projeção já existe e é o mesmo que a seleção usa, então
   * a célula pintada é exatamente a célula sob o ponto. O custo fica preso ao
   * tamanho da janela em vez de crescer com a distância de visão. E só as
   * células ainda vazias são visitadas — onde a linha já escreveu, o
   * preenchimento não tem o que fazer, e essa é justamente a região mais densa
   * do quadro.
   */
  private fillLitFloor(context: RenderContext): void {
    const { camera, rasterizer, viewport } = context;
    const { lit } = this.pen;

    // Sem iluminação, ou com o peso da rampa zerado, o glifo volta a ser só
    // geometria — e um pedaço de chão não tem geometria própria para mostrar.
    if (!lit.lit || lit.rampWeight <= 0) return;

    // O plano do chão visto exatamente de perfil não tem área na tela.
    const height = camera.position.y;

    const texture = settings.gridTexture;
    const reach = settings.viewDistance;

    // O sombreamento (e o limiar `groundFillLight`) agora rodam no
    // `ShadingPass`: aqui só a geometria decide quais células valem a pena
    // varrer, e o G-buffer carrega o resto. Sem a passada barata de antes —
    // ela existia para poupar o kernel de luz na CPU, e é exatamente esse
    // custo que a GPU paraleliza.
    const surface = this.surface;
    surface.normalX = 0;
    surface.normalY = 1;
    surface.normalZ = 0;
    surface.ownerId = NO_OWNER;
    surface.emissiveR = 0;
    surface.emissiveG = 0;
    surface.emissiveB = 0;
    surface.emissiveStrength = 0;
    surface.reflectivity = settings.groundReflectivity;
    surface.gloss = settings.groundGloss;
    surface.mirror = true;
    surface.textureId = TEXTURE_ID[texture];
    surface.area = true;
    // Piso "cru": o chão pode devolver espaço e sumir — ver `DeferredSurface.variant`.
    surface.variant = true;
    // O vazio entre linhas é metade do estilo: com ambiente somado, toda
    // célula passaria do limiar e a leitura de grade sumiria — mesmo motivo
    // de sempre, ver `ShadeOptions.ambient` em `light/shade.ts`.
    surface.ambient = false;
    // O lóbulo do céu devolve uma lavagem quase uniforme na superfície
    // horizontal inteira: o especular das luzes (que já entra sozinho,
    // fora deste interruptor) desenha a coluna do sol, e é só isso que o
    // preenchimento quer mostrar — mesmo com reflexo ligado no ajuste global.
    surface.reflections = false;

    // O chão fica de um lado só do horizonte, e qual lado depende de a
    // câmera estar acima ou abaixo do plano. Começar na fileira certa evita
    // lançar meia tela de raios que não encontram nada.
    const horizon = Math.round(rasterizer.horizonRow());
    const firstRow = height > 0 ? Math.max(0, horizon + 1) : 0;
    const lastRow =
      height > 0
        ? viewport.rowCount - 1
        : Math.min(viewport.rowCount - 1, horizon);

    const { forward, position } = camera;

    for (let row = firstRow; row <= lastRow; row += 1) {
      for (let col = 0; col < viewport.colCount; col += 1) {
        // A checagem mais barata primeiro: a linha já ocupou a célula.
        if (!rasterizer.cellIsEmpty(col, row)) continue;

        rasterizer.rayThrough(col + 0.5, row + 0.5, this.ray);
        const distance = -height / this.ray.y;
        if (!(distance > 0)) continue;

        // O raio é unitário, então a distância ao longo dele não é a
        // profundidade de view — que é o que o z-buffer compara. A
        // projeção sobre o eixo da câmera converte uma na outra.
        const depth =
          distance *
          (this.ray.x * forward.x +
            this.ray.y * forward.y +
            this.ray.z * forward.z);
        if (depth <= 0 || depth > reach) continue;

        const fog = fogAmount(depth);
        if (fog >= 1) continue;

        const x = position.x + this.ray.x * distance;
        const z = position.z + this.ray.z * distance;

        const band = groundBand(depth);
        surface.albedoR = band.r;
        surface.albedoG = band.g;
        surface.albedoB = band.b;
        surface.worldX = x;
        surface.worldY = 0;
        surface.worldZ = z;

        rasterizer.plotCellDeferred(
          col,
          row,
          depth,
          (1 - fog) ** 1.2,
          false,
          surface,
        );
      }
    }
  }
}
