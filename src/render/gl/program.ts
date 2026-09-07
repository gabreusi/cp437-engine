const compile = (gl: WebGL2RenderingContext, type: number, source: string): WebGLShader => {
    const shader = gl.createShader(type);
    if (shader === null) throw new Error('Não foi possível criar o shader.');

    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(shader);
        gl.deleteShader(shader);
        const kind = type === gl.VERTEX_SHADER ? 'vertex' : 'fragment';
        throw new Error(`Falha ao compilar o ${kind} shader:\n${log ?? '(sem log)'}`);
    }
    return shader;
};

/**
 * Programa de shader com cache de localização de uniform.
 *
 * `getUniformLocation` faz busca por nome no driver; chamar por quadro é
 * desperdício silencioso. O cache resolve uma vez e guarda — inclusive o `null`
 * de um uniform que o compilador removeu por não ser usado.
 */
export class Program {
    readonly handle: WebGLProgram;
    private readonly uniforms = new Map<string, WebGLUniformLocation | null>();

    constructor(
        private readonly gl: WebGL2RenderingContext,
        vertexSource: string,
        fragmentSource: string,
    ) {
        const vertex = compile(gl, gl.VERTEX_SHADER, vertexSource);
        const fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentSource);

        const handle = gl.createProgram();
        if (handle === null) throw new Error('Não foi possível criar o programa.');

        gl.attachShader(handle, vertex);
        gl.attachShader(handle, fragment);
        gl.linkProgram(handle);

        // Os shaders já estão embutidos no programa linkado.
        gl.deleteShader(vertex);
        gl.deleteShader(fragment);

        if (!gl.getProgramParameter(handle, gl.LINK_STATUS)) {
            const log = gl.getProgramInfoLog(handle);
            gl.deleteProgram(handle);
            throw new Error(`Falha ao linkar o programa:\n${log ?? '(sem log)'}`);
        }
        this.handle = handle;
    }

    use(): void {
        this.gl.useProgram(this.handle);
    }

    uniform(name: string): WebGLUniformLocation | null {
        const cached = this.uniforms.get(name);
        if (cached !== undefined) return cached;

        const location = this.gl.getUniformLocation(this.handle, name);
        this.uniforms.set(name, location);
        return location;
    }

    /** Associa um sampler a uma unidade de textura, pelo nome do uniform. */
    setTextureUnit(name: string, unit: number): void {
        this.gl.uniform1i(this.uniform(name), unit);
    }

    dispose(): void {
        this.gl.deleteProgram(this.handle);
        this.uniforms.clear();
    }
}
