import { FULLSCREEN_VERTEX, drawFullscreen } from '../fullscreen';
import { Program } from '../program';
import { RenderTarget } from '../target';

/** Cópia simples. Renderizada num alvo menor com LINEAR, vira downsample. */
const BLIT_SOURCE = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uSource;
void main() {
    fragColor = texture(uSource, vUv);
}`;

/**
 * Gaussiana separável de nove taps.
 *
 * Separável significa duas passadas de nove amostras em vez de uma de oitenta e
 * uma — o mesmo resultado por uma fração do custo.
 */
const BLUR_SOURCE = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uSource;
uniform vec2 uDirection;

const float WEIGHTS[5] = float[](0.227027, 0.194595, 0.121622, 0.054054, 0.016216);

void main() {
    vec3 sum = texture(uSource, vUv).rgb * WEIGHTS[0];
    for (int i = 1; i < 5; i++) {
        vec2 offset = uDirection * float(i);
        sum += texture(uSource, vUv + offset).rgb * WEIGHTS[i];
        sum += texture(uSource, vUv - offset).rgb * WEIGHTS[i];
    }
    fragColor = vec4(sum, 1.0);
}`;

/**
 * Bloom em duas escalas.
 *
 * É o que substitui o `text-shadow` da versão em DOM, e faz melhor: raio e
 * intensidade são controláveis, o brilho vaza entre células vizinhas como num
 * CRT de verdade, e o custo não depende de quantos caracteres estão acesos.
 *
 * Sem bright-pass: o fundo é quase preto e só o neon tem energia, então a
 * própria imagem já serve de fonte.
 */
export class BloomPass {
    private readonly blit: Program;
    private readonly blur: Program;

    private readonly half: RenderTarget;
    private readonly halfPing: RenderTarget;
    private readonly quarter: RenderTarget;
    private readonly quarterPing: RenderTarget;

    constructor(
        private readonly gl: WebGL2RenderingContext,
        width: number,
        height: number,
        hdr = false,
    ) {
        this.blit = new Program(gl, FULLSCREEN_VERTEX, BLIT_SOURCE);
        this.blur = new Program(gl, FULLSCREEN_VERTEX, BLUR_SOURCE);

        // Os alvos do bloom acompanham a precisão da cena: cortar em 1 aqui
        // desfaria o estouro que a cena acabou de produzir.
        this.half = new RenderTarget(gl, width / 2, height / 2, hdr);
        this.halfPing = new RenderTarget(gl, width / 2, height / 2, hdr);
        this.quarter = new RenderTarget(gl, width / 4, height / 4, hdr);
        this.quarterPing = new RenderTarget(gl, width / 4, height / 4, hdr);

        this.blit.use();
        this.blit.setTextureUnit('uSource', 0);
        this.blur.use();
        this.blur.setTextureUnit('uSource', 0);
    }

    get halfTexture(): WebGLTexture {
        return this.half.texture;
    }

    get quarterTexture(): WebGLTexture {
        return this.quarter.texture;
    }

    resize(width: number, height: number): void {
        this.half.resize(width / 2, height / 2);
        this.halfPing.resize(width / 2, height / 2);
        this.quarter.resize(width / 4, height / 4);
        this.quarterPing.resize(width / 4, height / 4);
    }

    render(sceneTexture: WebGLTexture, radius: number): void {
        const { gl } = this;
        gl.disable(gl.BLEND);
        gl.activeTexture(gl.TEXTURE0);

        this.downsample(sceneTexture, this.half);
        this.blurTarget(this.half, this.halfPing, radius);

        this.downsample(this.half.texture, this.quarter);
        this.blurTarget(this.quarter, this.quarterPing, radius);
    }

    private downsample(source: WebGLTexture, target: RenderTarget): void {
        const { gl } = this;
        target.bind();
        this.blit.use();
        gl.bindTexture(gl.TEXTURE_2D, source);
        drawFullscreen(gl);
    }

    /** Horizontal para o ping, vertical de volta para o alvo. */
    private blurTarget(target: RenderTarget, ping: RenderTarget, radius: number): void {
        const { gl } = this;
        const stepX = radius / target.width;
        const stepY = radius / target.height;

        this.blur.use();

        ping.bind();
        gl.uniform2f(this.blur.uniform('uDirection'), stepX, 0);
        gl.bindTexture(gl.TEXTURE_2D, target.texture);
        drawFullscreen(gl);

        target.bind();
        gl.uniform2f(this.blur.uniform('uDirection'), 0, stepY);
        gl.bindTexture(gl.TEXTURE_2D, ping.texture);
        drawFullscreen(gl);
    }

    dispose(): void {
        this.blit.dispose();
        this.blur.dispose();
        this.half.dispose();
        this.halfPing.dispose();
        this.quarter.dispose();
        this.quarterPing.dispose();
    }
}
