import { FULLSCREEN_VERTEX, drawFullscreen } from "../fullscreen";
import { Program } from "../program";

/**
 * Junta cena e bloom e aplica o tratamento de CRT.
 *
 * Scanlines e vinheta eram o `#stage::after` do CSS, com os mesmos números:
 * período de 5px escurecendo 20% nos últimos 3, e vinheta elíptica começando
 * a 55% do raio até 55% de preto. Estar num shader é o que abre caminho para
 * distorção de barril e aberração cromática depois — não construídas agora.
 */
const FRAGMENT_SOURCE = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uScene;
uniform sampler2D uBloomHalf;
uniform sampler2D uBloomQuarter;

uniform float uBloomIntensity;
uniform float uScanlinePeriod;
uniform float uScanlineStrength;
uniform float uVignetteStrength;

void main() {
    vec3 base = texture(uScene, vUv).rgb;

    // A escala maior contribui menos, mas espalha mais longe: é o halo amplo.
    vec3 bloom = texture(uBloomHalf, vUv).rgb * 0.65
               + texture(uBloomQuarter, vUv).rgb * 0.55;

    vec3 color = base + bloom * uBloomIntensity;

    float phase = fract(gl_FragCoord.y / uScanlinePeriod);
    float scanline = phase < 0.4 ? 1.0 : 1.0 - uScanlineStrength;

    vec2 centered = (vUv - 0.5) * 2.0;
    float vignette = 1.0 - uVignetteStrength
        * smoothstep(0.35, 1.15, length(centered / vec2(1.2, 1.0)));

    color *= scanline * vignette;

    // Tone map exponencial: comprime os núcleos do bloom, que passam de 1, sem
    // amplificar meio-tom. Cortar seco chaparia justamente o miolo do brilho, e
    // um Reinhard puro escureceria a cena inteira para resolver só os picos.
    color = vec3(1.0) - exp(-color * 1.4);

    fragColor = vec4(color, 1.0);
}`;

export interface CompositeOptions {
  bloomIntensity: number;
  scanlinePeriod: number;
  scanlineStrength: number;
  vignetteStrength: number;
}

export class CompositePass {
  private readonly program: Program;

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.program = new Program(gl, FULLSCREEN_VERTEX, FRAGMENT_SOURCE);
    this.program.use();
    this.program.setTextureUnit("uScene", 0);
    this.program.setTextureUnit("uBloomHalf", 1);
    this.program.setTextureUnit("uBloomQuarter", 2);
  }

  draw(
    scene: WebGLTexture,
    bloomHalf: WebGLTexture,
    bloomQuarter: WebGLTexture,
    options: CompositeOptions,
  ): void {
    const { gl } = this;
    gl.disable(gl.BLEND);

    this.program.use();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, scene);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, bloomHalf);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, bloomQuarter);

    gl.uniform1f(
      this.program.uniform("uBloomIntensity"),
      options.bloomIntensity,
    );
    gl.uniform1f(
      this.program.uniform("uScanlinePeriod"),
      options.scanlinePeriod,
    );
    gl.uniform1f(
      this.program.uniform("uScanlineStrength"),
      options.scanlineStrength,
    );
    gl.uniform1f(
      this.program.uniform("uVignetteStrength"),
      options.vignetteStrength,
    );

    drawFullscreen(gl);
  }

  dispose(): void {
    this.program.dispose();
  }
}
