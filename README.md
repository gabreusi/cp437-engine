# CP437 Engine

Engine 3D caseira que rasteriza para caracteres. Sol fatiado, céu estrelado,
grade quadriculada infinita e objetos com luz colorida, sombra e reflexo — tudo
desenhado como texto, com câmera livre. Sem Three.js e sem biblioteca de
renderização: projeção, clipping, z-buffer, traçado de linha, traçado de raio e
o menu são escritos à mão.

## Rodando

```bash
npm install
npm run dev      # servidor de desenvolvimento com HMR
npm run build    # typecheck + bundle estático em dist/
npm run preview  # serve o dist/ para conferir o build
```

Requer WebGL2 e nada mais: não há dependência de runtime. Vite e TypeScript são
ferramentas de build.

## O nome

O nome vem da CP437, a code page do IBM PC original — a tabela de caracteres de onde a arte
ANSI dos anos oitenta tirava tudo. Não é referência decorativa: **todo glifo
próprio do atlas vem de lá**. Os blocos `░▒▓█`, as meias alturas `▀▄`, a moldura
`─│┌┐└┘├┤┬┴┼` que desenha o menu, as setas `◄►▲▼` dos sliders, o `·` das
estrelas.

A única exceção é o `▁` da linha do horizonte, e ela prova a regra: a CP437 não
tem um traço rente à base da célula, e é exatamente por isso que ele precisou ser
desenhado à mão.

O atlas **não** usa o layout da CP437, e isso é decisão, não descuido. Duas
razões: os imprimíveis ficam no índice igual ao seu código, o que faz escrever
texto na grade ser `charCodeAt` sem tabela de tradução; e a faixa alta é Latin-1,
não a extensão da CP437, porque a CP437 tem `á é í ó ú â ê ô à ç` mas não tem
`ã` nem `õ`. O menu acabou em inglês, mas a engine não deixa de precisar dos
acentos por isso: esta documentação e os nomes de objeto que qualquer pessoa
digitar passam pelo mesmo atlas.

### Controles

| | |
|---|---|
| clique na cena | captura o mouse |
| mouse | olhar |
| `W` `A` `S` `D` | andar |
| `Q` `E` | descer e subir |
| `Shift` | turbo |
| `Esc` | solta o mouse e abre o menu |

No menu: `▲▼` navegam, `◄►` ajustam, `Enter` aplica, `Tab` volta para os grupos,
`Esc` fecha. O mouse também opera tudo — clicar numa trilha leva o valor até ali.

No grupo **Objects**, clicar na cena seleciona o objeto sob o cursor, arrastar o
desliza no plano da própria altura, `Shift`+arrastar sobe e desce, a roda gira, e
`Del` apaga.

A interface do menu é escrita em inglês; comentários e documentação, em
português. Os rótulos são o que qualquer pessoa lê ao abrir a engine; o resto é
para quem trabalha nela.

## O pipeline

```
Renderable.contribute(ctx)    luzes e corpos, antes de qualquer desenho
        ▼
Renderable.render(ctx)        primitivas em coordenadas de MUNDO
        ▼
Rasterizer (CPU)             mundo → view → clip no near plane → projeção
                             → célula fracionária → clip 2D → DDA
                             posição de mundo interpolada por fragmento
        ▼
shadeSurface (CPU)           ambiente + luzes (raio de sombra) + reflexo
                             (lóbulo no céu, ou raio de espelho nos corpos)
        ▼
rampa de glifos              luminância → caractere
        ▼
Framebuffer (CPU)            dois planos RGBA8: glifo/alpha/emissivo e cor
        ▼
──── fronteira CPU/GPU: dois texSubImage2D de ~86 KB por quadro ────
        ▼
GlPresenter (GPU)            céu → grid → bloom → composite
```

O grid inteiro sai em **um draw call**: um triângulo que cobre a tela, e o
fragment shader descobre em que célula caiu, lê glifo e cor em duas *data
textures* e amostra o atlas de fontes. Não existe quad por célula.

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

**Profundidade e posição de mundo interpoladas em `1/w`.** Só o inverso é linear
em espaço de tela. Interpolar `w` direto faz a névoa escorregar ao longo das
linhas quando a câmera gira; interpolar a posição direto faz a sombra escorregar
de baixo do objeto pelo mesmo motivo.

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

### As decisões da iluminação

**A cor da célula é RGB, e não um índice de paleta.** A célula guardava um byte
apontando para uma tabela de dezessete cores, o que bastava enquanto o cenário
era pintado à mão. Não sobrevive a luz colorida: a cor de uma linha da grade
iluminada por um orbe ciano e outro magenta não está em tabela nenhuma. As cores
do cenário são exatamente as mesmas, nos mesmos literais hex.

**O que passa de 1.0 vive no canal emissivo.** A célula tem oito bits por canal,
mas o sombreamento produz valores acima de 1 — e é justamente esse excesso que
vira halo no bloom, que não tem bright-pass. A cor normalizada pelo pico guarda o
matiz, o pico vai para o canal emissivo, e o shader remultiplica. O alvo de
render é RGBA16F pelo mesmo motivo: em oito bits o estouro seria cortado antes de
o bloom ver.

**A grade é neon, não asfalto.** Ela emite na própria cor. Sem isso seria uma
superfície horizontal iluminada por um sol a quatro graus de elevação, ou seja,
praticamente preta — fisicamente correto e completamente errado para o estilo. A
luz das outras fontes soma por cima.

**Traçado analítico, sem malha e sem BVH.** O que a engine desenha é wireframe, e
um raio não acerta aresta: cada objeto declara a esfera ou a caixa que o
representa. Com o custo por teste constante e uma dúzia de corpos, uma estrutura
de aceleração custaria mais para manter do que economiza.

**A resolução é o que torna isto viável.** São 180 colunas, não 1920 — o
orçamento por fragmento é cem vezes o de um shader de pixel. A cena de
demonstração custa 4,4 ms de CPU por quadro; com treze luzes e dezesseis corpos,
6,4 ms.

**A luz cai a partir de uma distância de referência, não do inverso do quadrado
puro.** A curva é a mesma, mas ancorada: numa cena de dezenas de unidades de
lado, a queda física deixaria "força 6" sem significado nenhum no slider.

**A hachura do espelho é medida em células, não em unidades de mundo.** A placa
refletiva é preenchida com linhas paralelas, e quantas depende de quanto ela
ocupa *na tela*: o rasterizador projeta a aresta e diz a quantas células as
linhas vizinhas estão caindo. Contar por unidade de mundo, que era a versão
anterior, erra nas duas pontas — de longe desenha vinte linhas que caem nas
mesmas três fileiras, de perto deixa uma fileira vazia entre cada duas, e um
espelho que se enxerga através não é um espelho. Distância pura também não
serviria: ela ignora a inclinação, e uma placa de esguelha precisa de menos
linhas, não de mais.

**Coleta antes de desenho.** Iluminação não respeita ordem de desenho — o chão
precisa saber do orbe que ainda não foi desenhado, e do monólito atrás da câmera
que projeta sombra na frente dela. Por isso `contribute` é uma fase separada de
`render`.

**A rampa de glifos é escolha, não conclusão.** A rampa clássica de dez níveis
é a mais expressiva e a que dá mais sensação de superfície iluminada, mas sob luz
forte uma linha da grade deixa de ser `/` e vira `#`: a leitura de wireframe
cede. O modo `por família` preserva a silhueta com quatro níveis, e `desligada` é
a referência. Os três custam vinte linhas porque o sombreamento devolve a
luminância de qualquer jeito.

**O menu é desenhado na grade de caracteres.** O painel em DOM que ele substitui
vivia fora da cena: tinha folha de estilo própria, era um segundo lugar onde a
paleta morava, e ficava sobre o canvas sem pertencer a ele. Este passa pelo mesmo
bloom e pelas mesmas scanlines — o visual de CRT não é imitado, é o mesmo caminho
de render. Só foi possível porque o charset passou a ter a tabela ASCII com o
índice igual ao código do caractere, e o Latin-1 junto, para acento ser um
detalhe de conteúdo e não uma limitação técnica. O vocabulário de blocos e
moldura que ele desenha é o da CP437; veja *O nome*.

## Estrutura

```
src/
  core/
    loop.ts          passo fixo de update + render
    input.ts         teclado e mouse, capturado e solto
    freecam.ts       traduz input em movimento de câmera
  math/
    vec3.ts          operações com destino explícito, sem alocar no hot path
    mat4.ts          matriz de view em forma fechada
    color.ts         RGB em 0..1, onde a matemática de luz acontece
    noise.ts         ruído determinístico por coordenada
  light/
    types.ts         luz, material, corpo, modelo de céu
    world.ts         luzes e corpos do quadro, com pool
    trace.ts         raio contra esfera e caixa orientada; sombra e espelho
    sky.ts           o que um raio vê ao olhar para o céu
    shade.ts         o kernel: uma superfície, todas as luzes, uma cor
  render/
    viewport.ts      teto de colunas, tamanho de célula, devicePixelRatio
    camera.ts        posição, yaw, pitch, fov
    framebuffer.ts   dois planos no formato que a GPU consome direto
    rasterizer.ts    clipping, DDA, posição de mundo, disco, raio inverso
    shading.ts       a caneta que liga luz a caractere; o chão
    ramp.ts          luminância → glifo, nos três modos
    palette.ts       cores nomeadas e os 256 glifos
    text.ts          texto e molduras escritos na grade
    sky-colors.ts    as cores do céu, compartilhadas com o shader
    debug-dump.ts    despeja o framebuffer como texto
    gl/
      context.ts     contexto, resize, perda, suporte a meia precisão
      atlas.ts       atlas de glifos, fonte mais os desenhados à mão
      program.ts     compilação e cache de uniforms
      presenter.ts   orquestra os passes; captura fora da tela, para diagnóstico
      passes/        background, grid, bloom, composite
  scene/
    scene.ts         Renderable, contribute e render
    ground.ts        grade infinita ancorada na câmera
    sky.ts           estrelas e horizonte
    sun.ts           disco celeste, e a luz direcional que ele é
    world.ts         os objetos da cena: criar, escolher, salvar
    entities/
      entity.ts      o objeto como dado, e os campos que o menu edita
      box.ts         a caixa orientada, desenhada e testada pela mesma matriz
      orb.ts         esfera emissiva: a luz colorida e o que se vê dela
      monolith.ts    caixa em wireframe que recebe luz e projeta sombra
      panel.ts       placa refletiva: onde o raio de espelho tem o que mostrar
  ui/
    menu/            o menu de pausa, desenhado em caracteres
    hud.ts           fps, custo da cena e estado da câmera
  config.ts          fonte única dos parâmetros ajustáveis
```

## Depurando

Em desenvolvimento, `window.engine` expõe `camera`, `settings`, `scene`, `world`,
`lights`, `menu`, `rasterizer`, `presenter`, `capture(escala)`, `dumpGlyphs()`,
`countByColor()`, `showCharset()`, `setOverlay(fn)` e `step()`.

`dumpGlyphs` e `countByColor` respondem a pergunta que a GPU não responde: *qual
caractere está realmente naquela célula*, e *que camada sumiu*. `showCharset`
cobre a cena com os 256 glifos e confere atlas e data textures.

`step()` desenha um quadro sob demanda. Numa aba em segundo plano o
`requestAnimationFrame` não dispara, e sem ele qualquer verificação de "mudei o
ajuste, o que aconteceu?" mede o quadro anterior e conclui que nada mudou.

## O que ainda não existe

Isto é a engine, não o jogo. Não há colisão nem estado de jogo, e a simulação não
faz nada além de mover a câmera e girar os orbes. A costura para isso é
`Renderable` e o `World`, que é onde o `gameState` já começou a existir: os
ajustes de `settings` são preferência de quem olha, a cena é conteúdo, e só a
cena é salva.
