/**
 * Os widgets que o menu sabe desenhar.
 *
 * Uma união fechada, e não uma hierarquia: o menu inteiro cabe em cinco formas,
 * e um `switch` sobre elas é conferido pelo compilador — acrescentar um tipo
 * novo quebra o desenho e a navegação no mesmo lugar, em vez de silenciosamente
 * não aparecer.
 *
 * Os acessores são funções e não caminhos em texto porque metade dos valores
 * mora em `settings`, a outra metade dentro de um objeto da cena, e um caminho
 * perderia a checagem de tipo justamente onde ela vale mais.
 */

export interface SliderItem {
    kind: 'slider';
    label: string;
    min: number;
    max: number;
    step: number;
    digits?: number;
    suffix?: string;
    get(): number;
    set(value: number): void;
}

export interface ToggleItem {
    kind: 'toggle';
    label: string;
    get(): boolean;
    set(value: boolean): void;
}

export interface ChoiceItem {
    kind: 'choice';
    label: string;
    options: readonly { value: string; label: string }[];
    get(): string;
    set(value: string): void;
}

export interface ActionItem {
    kind: 'action';
    label: string;
    run(): void;
    /** Ações destrutivas ganham outra cor. */
    danger?: boolean;
}

/** Uma linha da lista de objetos: seleciona, e liga ou desliga a visibilidade. */
export interface EntityItem {
    kind: 'entity';
    label: string;
    entityId: number;
    selected: boolean;
    visible: boolean;
    toggle(): void;
    select(): void;
}

/** Título de seção. Não recebe foco. */
export interface HeadingItem {
    kind: 'heading';
    label: string;
}

export type MenuItem =
    | SliderItem
    | ToggleItem
    | ChoiceItem
    | ActionItem
    | EntityItem
    | HeadingItem;

export interface MenuGroup {
    label: string;
    /**
     * Função e não lista pronta: o grupo de objetos muda a cada quadro,
     * conforme a cena é editada, e uma lista construída na inicialização
     * mostraria a cena de quando a página abriu.
     */
    items(): MenuItem[];
}

export const isFocusable = (item: MenuItem): boolean => item.kind !== 'heading';

/** Passo maior com Shift: atravessar um slider de ponta a ponta na mão cansa. */
export const FAST_STEP = 8;

export const clampToRange = (value: number, item: SliderItem): number => {
    const clamped = Math.max(item.min, Math.min(item.max, value));
    // Arredondar ao passo evita o valor virar 0.30000000000000004 no rótulo.
    const steps = Math.round((clamped - item.min) / item.step);
    return Math.min(item.max, item.min + steps * item.step);
};

export const formatValue = (item: SliderItem): string =>
    `${item.get().toFixed(item.digits ?? 0)}${item.suffix ?? ''}`;
