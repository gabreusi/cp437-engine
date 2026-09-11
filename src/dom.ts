/**
 * Busca um elemento obrigatório pelo id. Falhar aqui, alto e cedo, é melhor do
 * que espalhar `!` ou checagens de null pelos módulos de UI.
 */
export const requireElement = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`Elemento obrigatório não encontrado no HTML: #${id}`);
  }
  return element as T;
};
