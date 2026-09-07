import { SKY_GLSL } from '../../sky-colors';
import { FULLSCREEN_VERTEX, drawFullscreen } from '../fullscreen';
import { Program } from '../program';

/**
 * Gradientes do céu.
 *
 * Substitui os `radial-gradient` que ficavam no CSS do `#stage` e eram
 * reposicionados por um hack de porcentagem. Agora acompanham a posição real do
 * sol e do horizonte projetados pela câmera, que é o que eles sempre quiseram
 * ser: o brilho fica atrás do sol porque *está* atrás do sol.
 */
const FRAGMENT_SOURCE = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform vec2 uSun;         // posição do sol em UV, y para cima
uniform float uHorizon;    // horizonte contínuo em UV, y para cima
uniform float uGround;     // topo da bruma, alinhado à linha desenhada
uniform vec2 uAspect;      // corrige o formato da janela nas distâncias
uniform float uGroundHaze; // intensidade artística da bruma
uniform float uHazeScale;  // alcance da bruma, derivado da névoa e da altitude

${SKY_GLSL}

/**
 * Queda suave em torno de uma elipse.
 *
 * Exponencial e não smoothstep: smoothstep termina em zero a uma distância
 * definida, e essa fronteira aparece como um arco visível no céu. A exponencial
 * nunca chega a zero, então não tem borda.
 */
float halo(vec2 uv, vec2 center, vec2 radius) {
    float d = length((uv - center) / radius);
    return exp(-d * d * 2.2);
}

void main() {
    vec2 uv = vUv * uAspect;

    // Halo grande e frio acima do horizonte, que dá volume ao céu.
    float wash = halo(uv, vec2(uSun.x, uHorizon) * uAspect, vec2(1.30, 0.85));

    // Brilho quente atrás do sol.
    float glow = halo(uv, uSun * uAspect, vec2(0.50, 0.34));

    // Faixa fina de atmosfera colada no horizonte.
    float band = halo(uv, vec2(uSun.x, uHorizon) * uAspect, vec2(0.95, 0.10));

    // Abaixo do horizonte o fundo precisa ler como chão distante, não como céu.
    // Sem isto, onde a névoa apaga a grade sobra exatamente a mesma cor de cima
    // da linha, e o vão parece buraco em vez de bruma rasteira.
    //
    // O perfil não é arbitrário: a distância do chão numa fileira é
    // inversamente proporcional a quanto ela está abaixo do horizonte, então
    // 1/below reproduz a mesma névoa que apaga a grade — e a bruma passa a
    // crescer sozinha com a altitude, que é justamente quando o vão aparece.
    // O smoothstep existe só para a fronteira não serrilhar na fileira exata.
    float below = uGround - vUv.y;
    float ground = smoothstep(0.0, 0.004, below) * min(1.0, uHazeScale / max(below, 1e-4));

    // O fundo é cenário, não protagonista: o neon é que tem que brilhar.
    vec3 color = VOID_COLOR;
    color += PURPLE * wash * WASH_WEIGHT;
    color += PINK * glow * GLOW_WEIGHT;
    color += CYAN * band * BAND_WEIGHT;
    color += HAZE * ground * uGroundHaze;

    fragColor = vec4(color, 1.0);
}`;

export interface Atmosphere {
    /** Posição do sol em UV, com y crescendo para cima. */
    sunU: number;
    sunV: number;
    /** Altura do horizonte em UV, y para cima. Contínua, para os halos. */
    horizonV: number;
    /**
     * Onde a bruma rasteira começa, em UV.
     *
     * Separado de `horizonV` porque o horizonte é desenhado com `_`, que a
     * fonte assenta na base da célula, enquanto `horizonV` cai na borda de
     * cima dela. Sem isso a bruma começa uma célula acima da linha e passa
     * por cima dela.
     */
    groundV: number;
    /**
     * Alcance da bruma rasteira, em unidades de UV.
     *
     * Combina altitude da câmera, abertura da lente e ajustes de névoa numa
     * constante só, para o shader não precisar conhecer nada da cena.
     */
    hazeScale: number;
}

export class BackgroundPass {
    private readonly program: Program;

    constructor(private readonly gl: WebGL2RenderingContext) {
        this.program = new Program(gl, FULLSCREEN_VERTEX, FRAGMENT_SOURCE);
    }

    draw(atmosphere: Atmosphere, width: number, height: number, groundHaze: number): void {
        const { gl } = this;
        this.program.use();

        // Distâncias medidas no eixo maior, senão o halo achata junto com a janela.
        const aspect = width / Math.max(1, height);
        gl.uniform2f(this.program.uniform('uAspect'), Math.max(1, aspect), Math.max(1, 1 / aspect));
        gl.uniform2f(this.program.uniform('uSun'), atmosphere.sunU, atmosphere.sunV);
        gl.uniform1f(this.program.uniform('uHorizon'), atmosphere.horizonV);
        gl.uniform1f(this.program.uniform('uGround'), atmosphere.groundV);
        gl.uniform1f(this.program.uniform('uGroundHaze'), groundHaze);
        gl.uniform1f(this.program.uniform('uHazeScale'), atmosphere.hazeScale);

        drawFullscreen(gl);
    }

    dispose(): void {
        this.program.dispose();
    }
}
