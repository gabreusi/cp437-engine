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
  kind: "slider";
  /**
   * Nome do campo de `Settings` que o slider ajusta, quando é um. Deixa quem
   * recebe um valor de fora (a URL) limitá-lo à mesma faixa que o menu aceita,
   * sem uma segunda tabela de mínimos e máximos.
   */
  key?: string;
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
  kind: "toggle";
  label: string;
  get(): boolean;
  set(value: boolean): void;
}

export interface ChoiceItem {
  kind: "choice";
  label: string;
  options: readonly { value: string; label: string }[];
  get(): string;
  set(value: string): void;
}

export interface ActionItem {
  kind: "action";
  label: string;
  run(): void;
  /** Ações destrutivas ganham outra cor. */
  danger?: boolean;
}

/** Uma linha da lista de objetos: seleciona, e liga ou desliga a visibilidade. */
export interface EntityItem {
  kind: "entity";
  label: string;
  entityId: number;
  selected: boolean;
  visible: boolean;
  toggle(): void;
  select(): void;
}

/** Título de seção. Não recebe foco. */
export interface HeadingItem {
  kind: "heading";
  label: string;
}

/**
 * Uma linha em branco. Não recebe foco, não desenha nada — só dá respiro
 * vertical antes de um `heading` no meio de uma lista (`withHeadingSpacing`,
 * `schema.ts`), sem quebrar a correspondência 1:1 entre índice de item e
 * linha de tela que todo o resto (rolagem, clique, teclado) já assume.
 */
export interface SpacerItem {
  kind: "spacer";
}

export type MenuItem =
  | SliderItem
  | ToggleItem
  | ChoiceItem
  | ActionItem
  | EntityItem
  | HeadingItem
  | SpacerItem;

export interface MenuGroup {
  label: string;
  /**
   * Função e não lista pronta: o grupo de objetos muda a cada quadro,
   * conforme a cena é editada, e uma lista construída na inicialização
   * mostraria a cena de quando a página abriu.
   */
  items(): MenuItem[];
}

export const isFocusable = (item: MenuItem): boolean =>
  item.kind !== "heading" && item.kind !== "spacer";

/** Passo maior com Shift: atravessar um slider de ponta a ponta na mão cansa. */
export const FAST_STEP = 8;

/**
 * Empurra o valor de um item para um lado. Devolve `false` para quem não tem
 * valor — um título ou uma ação, que não são ajustáveis, só acionáveis.
 *
 * Mora aqui, junto dos widgets, e não dentro do menu, porque tem dois donos: as
 * setas do teclado no menu e o clique do cursor no painel lateral do editor
 * fazem exatamente a mesma coisa a um item.
 */
export const adjustItem = (
  item: MenuItem,
  direction: number,
  fast = false,
): boolean => {
  if (item.kind === "slider") {
    const step = item.step * (fast ? FAST_STEP : 1) * direction;
    item.set(clampToRange(item.get() + step, item));
    return true;
  }
  if (item.kind === "choice") {
    const index = item.options.findIndex(
      (option) => option.value === item.get(),
    );
    const next =
      (index + direction + item.options.length) % item.options.length;
    item.set(item.options[next]!.value);
    return true;
  }
  if (item.kind === "toggle") {
    item.set(direction > 0);
    return true;
  }
  return false;
};

export const clampToRange = (value: number, item: SliderItem): number => {
  const clamped = Math.max(item.min, Math.min(item.max, value));
  // Arredondar ao passo evita o valor virar 0.30000000000000004 no rótulo.
  const steps = Math.round((clamped - item.min) / item.step);
  return Math.min(item.max, item.min + steps * item.step);
};

export const formatValue = (item: SliderItem): string =>
  `${item.get().toFixed(item.digits ?? 0)}${item.suffix ?? ""}`;

/**
 * Qual seta de um campo "choice" está sob a coluna: `-1` (esquerda), `1`
 * (direita) ou `0` (nem uma nem outra — ou o item não é "choice").
 *
 * As setas ficam fora da trilha (`trackCol-1` e `trackCol+trackWidth`, ver
 * `draw.ts`) e nunca tiveram teste de clique próprio — só o teclado ciclava
 * `options`. Mora aqui, e não dentro do menu ou do editor, pelo mesmo motivo
 * de `sliderRatioValue`: o widget é o mesmo nos dois lugares.
 */
export const choiceArrowDirection = (
  item: MenuItem,
  col: number,
  trackCol: number,
  trackWidth: number,
): -1 | 0 | 1 => {
  if (item.kind !== "choice") return 0;
  if (col <= trackCol - 1) return -1;
  if (col >= trackCol + trackWidth) return 1;
  return 0;
};

/**
 * O valor de um slider sob uma coluna de tela, dado onde a trilha começa e
 * quanto ela mede.
 *
 * Só depende da coluna: quem arrasta lateralmente não pode perder o valor
 * por ter a linha do cursor variado um pixel, e mora aqui porque o menu de
 * pausa e o painel do editor têm o mesmo widget e não podem divergir.
 */
export const sliderRatioValue = (
  item: SliderItem,
  exactCol: number,
  trackCol: number,
  trackWidth: number,
): number => {
  const ratio = (exactCol - trackCol) / Math.max(1, trackWidth - 1);
  return clampToRange(
    item.min + Math.max(0, Math.min(1, ratio)) * (item.max - item.min),
    item,
  );
};
