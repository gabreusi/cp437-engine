import { settings } from "../config";
import { copyRgb, type Rgb, rgb } from "../math/color";
import { type Vec3, vec3 } from "../math/vec3";
import { NO_OWNER, type ShadeOptions, shadeSurface } from "../light/shade";
import { GLYPH } from "../render/palette";
import { glyphForPatch, RAMP } from "../render/ramp";
import type { Fragment } from "../render/rasterizer";
import { createGroundPen, createMaterial, fogAmount, groundBand, writeHdrColor } from "../render/shading";
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
   * O material do chão entre as linhas.
   *
   * Separado do da linha por um campo só, e é o campo que importa: aqui
   * `emissiveStrength` é zero. A linha é neon e brilha sozinha; o vão entre
   * duas linhas é superfície, e só aparece se alguma luz bater nele.
   */
  private readonly fillMaterial = createMaterial();

  /**
   * Duas opções de sombreamento para a mesma conta.
   *
   * `probe` é a passada barata que decide se a célula vale um sombreamento de
   * verdade: é o mesmo kernel sem os raios de sombra, que é a parte cara. Só
   * as células que passam do limiar pagam a segunda passada, com sombra. Não é
   * uma aproximação escrita à parte — é a mesma função, com uma opção a
   * menos, e por isso não pode discordar da versão completa.
   *
   * Nas duas, `ambient` é falso: o preenchimento existe para mostrar onde bate
   * luz *direta*, e a luz ambiente chega em todo lugar por definição — somada,
   * ela levaria todas as células acima do limiar e o vazio entre as linhas,
   * que é metade do estilo, sumiria.
   *
   * `reflections` também é falso, e por um motivo parecido: o lóbulo do céu
   * devolve uma lavagem quase uniforme em toda a superfície horizontal. O
   * especular das luzes continua ligado — é ele que desenha a coluna do sol
   * refletida no chão, que é a imagem que este preenchimento existe para
   * conseguir.
   */
  private readonly probe: ShadeOptions = {
    shadows: false,
    reflections: false,
    shadowThreshold: 0.004,
    maxShadowLights: 0,
    ambient: false,
  };

  private readonly lit: ShadeOptions = {
    shadows: true,
    reflections: false,
    shadowThreshold: 0.004,
    maxShadowLights: 3,
    ambient: false,
  };

  private readonly ray: Vec3 = vec3();
  private readonly shaded: Rgb = rgb();
  private readonly fragment: Fragment = {
    glyph: 0,
    color: rgb(),
    alpha: 1,
    emissive: 0,
    opaque: false,
  };

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
    const { camera, rasterizer, viewport, lights, shading } = context;
    const { lit } = this.pen;

    // Sem iluminação, ou com a rampa desligada, o glifo volta a ser só
    // geometria — e um pedaço de chão não tem geometria própria para mostrar.
    if (!lit.lit || lit.rampMode === RAMP.OFF) return;

    // O plano do chão visto exatamente de perfil não tem área na tela.
    const height = camera.position.y;
    // if (Math.abs(height) < 1e-3) return;

    const threshold = settings.groundFillLight;
    const texture = settings.gridTexture;
    const reach = settings.viewDistance;

    this.probe.shadowThreshold = shading.shadowThreshold;
    this.lit.shadows = shading.shadows;
    this.lit.shadowThreshold = shading.shadowThreshold;
    this.lit.maxShadowLights = shading.maxShadowLights;

    const material = this.fillMaterial;
    material.emissiveStrength = 0;
    material.reflectivity = settings.groundReflectivity;
    material.gloss = settings.groundGloss;
    material.mirror = true;

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

        copyRgb(material.albedo, groundBand(depth));

        // A vista sai do fragmento para a câmera: é o raio ao contrário.
        const viewX = -this.ray.x;
        const viewY = -this.ray.y;
        const viewZ = -this.ray.z;

        let luminance = shadeSurface(
          lights,
          material,
          x,
          0,
          z,
          0,
          1,
          0,
          viewX,
          viewY,
          viewZ,
          NO_OWNER,
          this.probe,
          this.shaded,
        );
        if (luminance < threshold) continue;

        // Passou no barato: agora vale o raio de sombra. Um corpo entre
        // a luz e o chão tem que apagar a poça, não só as linhas dentro
        // dela.
        if (this.lit.shadows) {
          luminance = shadeSurface(
            lights,
            material,
            x,
            0,
            z,
            0,
            1,
            0,
            viewX,
            viewY,
            viewZ,
            NO_OWNER,
            this.lit,
            this.shaded,
          );
          if (luminance < threshold) continue;
        }

        const glyph = glyphForPatch(
          luminance,
          lit.rampExposure,
          texture,
          x,
          0,
          z,
        );
        if (glyph === GLYPH.SPACE || glyph === GLYPH.BLANK) continue;

        writeHdrColor(this.fragment, this.shaded);
        rasterizer.plotCell(
          col,
          row,
          glyph,
          this.fragment.color,
          depth,
          (1 - fog) ** 1.2,
          this.fragment.emissive,
        );
      }
    }
  }
}
