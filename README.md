# Outrun ASCII

Engine 3D caseira que rasteriza para caracteres. Sol fatiado, céu estrelado e
grade quadriculada infinita, tudo desenhado como texto, com câmera livre.
Sem Three.js e sem biblioteca de renderização: projeção, clipping, z-buffer e
traçado de linha são escritos à mão.

## Rodando

```bash
npm install
npm run dev      # servidor de desenvolvimento com HMR
npm run build    # typecheck + bundle estático em dist/
npm run preview  # serve o dist/ para conferir o build
```

Requer WebGL2. A única dependência de runtime é `cropperjs`, usada no recorte
da imagem exportada.

### Controles

| | |
|---|---|
| clique na cena | captura o mouse |
| mouse | olhar |
| `W` `A` `S` `D` | andar |
| `Q` `E` | descer e subir |
| `Shift` | turbo |
| `Esc` | solta o mouse |

A engrenagem no canto abre o painel de ajustes; o HUD mostra fps e estado da
câmera.

## O pipeline

```
Renderable.render(ctx)        primitivas em coordenadas de MUNDO
        ▼
Rasterizer (CPU)             mundo → view → clip no near plane → projeção
                             → célula fracionária → clip 2D → DDA
                             glifo escolhido pela inclinação em tela
        ▼
Framebuffer (CPU)            RGBA8 por célula (glifo, cor, alpha) + profundidade
        ▼
──────── fronteira CPU/GPU: um texSubImage2D de ~40 KB por quadro ────────
        ▼
GlPresenter (GPU)            céu → grid → bloom → composite
```

O grid inteiro sai em **um draw call**: um triângulo que cobre a tela, e o
fragment shader descobre em que célula caiu, lê glifo e cor numa *data texture*
e amostra o atlas de fontes. Não existe quad por célula.

## Decisões que explicam o código

**A grade é medida em profundidade, não em fileiras de tela.** A versão anterior
deste projeto era uma animação com perspectiva falsa: um `focalLength` derivado
da altura da janela e linhas divergindo de um ponto de fuga fixo. Nada disso
sobrevive a uma câmera que se move, e tudo foi substituído por projeção de
verdade.

**Clipping em dois estágios.** No near plane, em espaço de view, antes da divisão
perspectiva — sem isso um ponto atrás da câmera projeta para coordenadas que se
espalham pela tela inteira. E no retângulo da tela, antes de rasterizar — uma
linha perto do horizonte projeta para um segmento de comprimento absurdo, e o
laço andaria milhões de células fora de vista.

**Profundidade interpolada em `1/w`.** Só o inverso é linear em espaço de tela.
Interpolar `w` direto faz a névoa escorregar ao longo das linhas quando a câmera
gira.

**A proporção da célula entra na projeção, uma vez.** `aspect = (colunas /
fileiras) / CELL_ASPECT`. Como o atlas é nosso, a proporção da célula é escolha
nossa (1:2) e não refém da fonte do sistema.

**O céu não tem paralaxe.** Estrelas e sol são direções unitárias transformadas
apenas pela rotação da câmera. Andar não os move; girar move. É o correto para
o infinito.

**Tolerância no teste de profundidade.** As duas famílias de linhas do chão são
coplanares, e a fileira na tela é função apenas da profundidade — então numa
mesma fileira as duas têm profundidade matematicamente igual. Sem folga, o ruído
de ponto flutuante rejeita metade das células e a grade sai picotada.

**Perda de contexto é tratada desde o começo.** `webglcontextlost` acontece em
suspensão de aba e troca de GPU; sem recriar os recursos a tela fica preta para
sempre.

## Estrutura

```
src/
  core/
    loop.ts          passo fixo de update + render
    input.ts         teclado e mouse sob pointer lock
    freecam.ts       traduz input em movimento de câmera
  math/
    vec3.ts          operações com destino explícito, sem alocar no hot path
    mat4.ts          matriz de view em forma fechada
    noise.ts         ruído determinístico por coordenada
  render/
    viewport.ts      teto de colunas, tamanho de célula, devicePixelRatio
    camera.ts        posição, yaw, pitch, fov
    framebuffer.ts   grade de células no formato que a GPU consome direto
    rasterizer.ts    clipping, DDA, escolha de glifo
    shading.ts       distância → névoa → cor
    palette.ts       cores e charset
    debug-dump.ts    despeja o framebuffer como texto
    gl/
      context.ts     contexto, resize, perda e restauração
      atlas.ts       atlas de glifos gerado num canvas 2D
      program.ts     compilação e cache de uniforms
      presenter.ts   orquestra os passes; captura para export
      passes/        background, grid, bloom, composite
  scene/
    scene.ts         Renderable e composição
    ground.ts        grade infinita ancorada na câmera
    sky.ts           estrelas e horizonte
    sun.ts           disco celeste com as fatias
  ui/
    panel.ts         controles gerados a partir de config.ts
    hud.ts           fps e estado da câmera
    export.ts        captura em 3x, recorte e download
  config.ts          fonte única dos parâmetros ajustáveis
```

## Depurando

Em desenvolvimento, `window.engine` expõe `camera`, `settings`, `scene`,
`presenter`, `capture(escala)`, `dumpGlyphs()` e `countByColor()`. Os dois
últimos respondem a pergunta que a GPU não responde: *qual caractere está
realmente naquela célula*, e *que camada sumiu*.

## O que ainda não existe

Isto é a engine, não o jogo. Não há entidades além do cenário, colisão, nem
estado de jogo. A costura para isso é `Renderable`, e o corte a fazer quando
chegar a hora é separar `settings` (o que o jogador configura) de um `gameState`
(o que o loop simula).
