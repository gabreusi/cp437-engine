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

uniform vec2 uSun;        // posição do sol em UV, y para cima
uniform float uHorizon;   // altura do horizonte em UV, y para cima
uniform vec2 uAspect;     // corrige o formato da janela nas distâncias

const vec3 VOID_COLOR = vec3(0.020, 0.000, 0.055);
const vec3 PINK = vec3(1.000, 0.235, 0.745);
const vec3 CYAN = vec3(0.000, 0.886, 1.000);
const vec3 PURPLE = vec3(0.290, 0.024, 0.408);

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

    // O fundo é cenário, não protagonista: o neon é que tem que brilhar.
    vec3 color = VOID_COLOR;
    color += PURPLE * wash * 0.30;
    color += PINK * glow * 0.22;
    color += CYAN * band * 0.16;

    fragColor = vec4(color, 1.0);
}`;

export interface Atmosphere {
    /** Posição do sol em UV, com y crescendo para cima. */
    sunU: number;
    sunV: number;
    /** Altura do horizonte em UV, y para cima. */
    horizonV: number;
}

export class BackgroundPass {
    private readonly program: Program;

    constructor(private readonly gl: WebGL2RenderingContext) {
        this.program = new Program(gl, FULLSCREEN_VERTEX, FRAGMENT_SOURCE);
    }

    draw(atmosphere: Atmosphere, width: number, height: number): void {
        const { gl } = this;
        this.program.use();

        // Distâncias medidas no eixo maior, senão o halo achata junto com a janela.
        const aspect = width / Math.max(1, height);
        gl.uniform2f(this.program.uniform('uAspect'), Math.max(1, aspect), Math.max(1, 1 / aspect));
        gl.uniform2f(this.program.uniform('uSun'), atmosphere.sunU, atmosphere.sunV);
        gl.uniform1f(this.program.uniform('uHorizon'), atmosphere.horizonV);

        drawFullscreen(gl);
    }

    dispose(): void {
        this.program.dispose();
    }
}
