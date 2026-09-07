import { settings } from '../config';
import { createGroundPen } from '../render/shading';
import type { RenderContext, Renderable } from './scene';

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

    render(context: RenderContext): void {
        const { camera, rasterizer } = context;
        this.pen.begin(context);

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
    }
}
