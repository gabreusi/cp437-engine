/**
 * Ruído determinístico por coordenada. Sem estado e sem alocação: chamado
 * milhares de vezes por reconstrução de cena.
 *
 * A semente é sorteada uma vez por carga da página, então o céu é diferente a
 * cada visita mas estável enquanto ela durar — redimensionar a janela não
 * embaralha as estrelas.
 */
const seed = Math.random() * 10000;

export const hashNoise = (x: number, y: number): number => {
    const wave = Math.sin((x + seed) * 12.9898 + (y + seed) * 78.233) * 43758.5453;
    return wave - Math.floor(wave);
};
