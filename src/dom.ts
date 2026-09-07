/**
 * Busca um elemento obrigatório pelo id. Falhar aqui, alto e cedo, é melhor do
 * que espalhar `!` ou checagens de null por todos os módulos de UI.
 */
export const requireElement = <T extends HTMLElement>(id: string): T => {
    const element = document.getElementById(id);
    if (element === null) {
        throw new Error(`Elemento obrigatório não encontrado no HTML: #${id}`);
    }
    return element as T;
};

/** Referências resolvidas uma única vez no bootstrap. */
export interface SceneElements {
    stage: HTMLElement;
    sky: HTMLElement;
    floor: HTMLElement;
    probe: HTMLElement;
}

export const resolveSceneElements = (): SceneElements => ({
    stage: requireElement('stage'),
    sky: requireElement('sky'),
    floor: requireElement('floor'),
    probe: requireElement('probe'),
});
