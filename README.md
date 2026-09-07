# Outrun ASCII

Gerador de wallpaper outrun renderizado inteiramente em caracteres ASCII: sol
fatiado, céu com estrelas que piscam e uma grade em perspectiva que corre para o
horizonte. Os parâmetros são ajustáveis em tempo real e a cena pode ser
recortada e exportada como PNG.

## Rodando

```bash
npm install
npm run dev      # servidor de desenvolvimento com HMR
npm run build    # typecheck + bundle estático em dist/
npm run preview  # serve o dist/ para conferir o build
```

Sem framework: Vite + TypeScript e dois pacotes em runtime (`html2canvas` para
capturar o palco, `cropperjs` para o recorte).

## Como funciona

A cena é texto, não canvas. Dois `<span>` dentro de um único `<pre>` — céu e
chão — dividem a mesma grade monoespaçada. As camadas são separadas porque mudam
em ritmos diferentes: o céu é caro de montar e quase estático, então só é
reserializado quando alguma estrela troca de caractere; o chão é redesenhado a
cada quadro.

Duas decisões explicam a maior parte do código:

**A grade é medida, não estimada.** `src/engine/layout.ts` mede uma célula da
fonte num `<pre>` invisível (`#probe`), porque a proporção largura/altura muda
com a fonte que o sistema acabou escolhendo e com o `clamp()` do CSS. Toda a
perspectiva depende desse número.

**Nada é alocado no laço de animação.** `CharBuffer` é criado uma vez por layout
e reaproveitado: cada quadro limpa e repinta. A serialização agrupa células
vizinhas de mesma cor num único `<span>`, senão seriam milhares de elementos.

## Estrutura

```
src/
  config.ts          estado ajustável e paletas de caracteres
  types.ts           Layout, Cell, Star
  dom.ts             resolução dos elementos obrigatórios
  engine/
    noise.ts         ruído determinístico por coordenada
    buffer.ts        grade de caracteres + serialização para HTML
    layout.ts        medição da célula, perspectiva, gradientes do fundo
    sun.ts           disco do sol e as fatias horizontais
    stars.ts         nascimento das estrelas e ciclo de brilho
    floor.ts         horizonte, neblina, trilhos e linhas de profundidade
    renderer.ts      laço de animação e estado da cena
  ui/
    controls.ts      painel de ajustes
    export.ts        captura, recorte e download
  styles/            tokens, base, cena, painel, modal
```

`src/config.ts` é a única fonte dos valores padrão: o HTML declara apenas a
faixa de cada slider, e o painel se inicializa a partir de `settings`.
