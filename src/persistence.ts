/**
 * Liga e desliga a memória entre sessões (`localStorage`) de uma vez só.
 *
 * Quem embarca a engine num iframe manda o estado pela URL (`url-config.ts`), e
 * nesse caso ler o que ficou salvo mudaria o primeiro quadro conforme o
 * histórico de quem abriu — e gravar por cima faria a configuração da URL
 * virar a preferência daquele navegador. Um interruptor só, aqui, para
 * `config.ts` e `World` obedecerem ao mesmo dono.
 */
let enabled = true;

export const setPersistence = (value: boolean): void => {
  enabled = value;
};

export const persistenceEnabled = (): boolean => enabled;
