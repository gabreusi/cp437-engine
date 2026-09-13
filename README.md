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

Requer WebGPU e nada mais: não há dependência de runtime. Vite e TypeScript são
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

O atlas **usa o layout da CP437**, índice a índice — isto já foi diferente, e
mudou por causa da escolha de glifo por forma (ver "Decisões da iluminação"):
o casamento de forma precisa do alfabeto inteiro para ter o que escolher —
moldura simples e dupla, os quatro meios-bloco, cartas e notas musicais que
nunca tinham uso — e um layout próprio deixaria a maior parte dele fora do
alcance de quem desenha. `glyphForChar` (`palette.ts`) traduz por mapa, não
por aritmética de índice, então a escrita de texto (menu, HUD, nome de
objeto) não perdeu nada com a troca. O que se perde é a conveniência
`charCodeAt` == índice para os imprimíveis, e o que falta: a CP437 tem
`á é í ó ú â ê ô à ç` mas não tem `ã` nem `õ` — um nome de objeto com essas
letras cai para a versão sem acento (`á`→`a`) em vez de sumir da grade.

### Controles

|                 |                                 |
| --------------- | ------------------------------- |
| clique na cena  | captura o mouse                 |
| mouse           | olhar                           |
| `W` `A` `S` `D` | andar                           |
| `Q` `E`         | descer e subir                  |
| `Shift`         | turbo                           |
| `Tab`           | liga e desliga o modo de edição |
| `Esc`           | solta o mouse e abre o menu     |

No **modo de edição** o mouse continua capturado e passa a mover um cursor
desenhado na grade; `W` `A` `S` `D` continuam voando, e **segurar o botão
direito** devolve o olhar ao mouse enquanto durar. Clicar seleciona o objeto sob
o retículo e abre as propriedades dele num painel na lateral, que é operado com o
mesmo cursor. Arrastar desliza o objeto no plano da própria altura,
`Shift`+arrastar sobe e desce, a roda gira, `Del` apaga, e arrastar uma das seis
setas que cercam o objeto estica a face correspondente.

No menu: `▲▼` navegam, `◄►` ajustam, `Enter` aplica, `Tab` volta para os grupos,
`Esc` fecha. O mouse também opera tudo — clicar numa trilha leva o valor até ali
— e quem aponta é o mesmo cursor da engine, com o ponteiro do sistema escondido
enquanto o menu estiver aberto.

No grupo **Objects**, os mesmos gestos valem com o ponteiro do sistema: clicar na
cena seleciona, arrastar desliza, `Shift`+arrastar sobe e desce, a roda gira, as
setas das faces esticam e `Del` apaga. É o mesmo manipulador do modo de edição,
com outro cursor.

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
SurfacePen.style (CPU)        preenche o G-buffer (posição, normal, material,
                             forma); sem luz, o glifo geométrico sai direto
        ▼
Framebuffer (CPU)            dois planos RGBA8 (glifo/alpha/emissivo, cor)
                             mais o G-buffer, para quem tem luz
        ▼
──── fronteira CPU/GPU: G-buffer e planos sobem como texturas por quadro ────
        ▼
ShadingPass (GPU, compute)    shadeSurface + rampa de glifos: ambiente + luzes
                             (raio de sombra) + reflexo (lóbulo no céu, ou raio
                             de espelho) → luminância + textura → caractere
        ▼
GpuPresenter (WebGPU)         céu → grid → bloom → composite
```

O grid inteiro sai em **um draw call**: um triângulo que cobre a tela, e o
fragment shader descobre em que célula caiu, lê glifo e cor nas duas _data
textures_ que `ShadingPass` produziu, e amostra o atlas de fontes. Não existe
quad por célula.

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

**Perda de dispositivo é tratada desde o começo.** `device.lost` (o equivalente
WebGPU de `webglcontextlost`) acontece em suspensão de aba e troca de GPU; sem
recriar os recursos a tela fica preta para sempre.

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

**O chão entre as linhas aparece onde bate luz direta.** Até aqui a iluminação
do chão só existia _nas_ linhas: uma poça de luz de um orbe acendia os traços
que passavam por dentro dela e deixava o quadrado inteiro preto — o que lê como
uma grade brilhante no vácuo, e não como luz caindo sobre uma superfície. O vão
agora é preenchido, com um corte: abaixo de um limiar de luz direta a célula
fica preta como sempre foi. O vazio entre as linhas é metade do estilo, e encher
o chão inteiro apagaria a leitura de grade — o limiar é o que deixa isso ser
escolha de quem olha, de "só o núcleo das poças" até "o chão todo".

**O preenchimento é varrido em espaço de tela, e a luz ambiente fica de fora.**
Em tela porque o caminho inverso da projeção já existe — é o mesmo que a seleção
usa —, o custo fica preso ao tamanho da janela em vez de crescer com a distância
de visão, e só as células ainda vazias são visitadas: onde a linha já escreveu, o
preenchimento não tem o que fazer, e é justamente ali que o quadro é mais denso.
Sem ambiente porque ela chega em todo lugar por definição: somada, levaria toda
célula acima do limiar e não sobraria vazio nenhum. O lóbulo do céu também fica
de fora, pelo mesmo motivo — ele devolve uma lavagem quase uniforme em qualquer
superfície horizontal. O especular das luzes continua ligado, e é ele que desenha
a coluna do sol refletida no chão.

**A célula decide se vale um raio de sombra antes de pagar por ele.** O
preenchimento sombreia duas vezes: a primeira sem sombra nenhuma, que é o mesmo
kernel sem a parte cara, só para saber se a célula passa do limiar; a segunda,
completa, só para quem passou. Não é uma aproximação escrita à parte — é a mesma
função com uma opção a menos, e por isso não pode discordar da versão completa. É
o que faz o chão inteiro preenchido custar menos de um milissegundo a mais.

**Uma caixa pode bloquear luz para a própria parede oposta.** O raio de
sombra de uma superfície ignora o corpo que a representa — sem isso a
primeira coisa que ele acerta é a própria face que o emitiu, e a cena inteira
sai em sombra, o acne clássico. Ignorar o corpo inteiro resolve isso, mas
resolve rápido demais: uma caixa também para de bloquear luz para a sua
própria parede *oposta*, porque as duas são o mesmo `ownerId`. Isso não
aparece de fora — as duas faces de uma caixa nunca são vistas ao mesmo tempo
— mas fica óbvio de dentro de uma sala fechada, olhando para uma parede
iluminada por um sol que deveria estar bloqueado pela parede do lado de fora:
a caixa inteira vira vidro para a própria luz. A correção não é abandonar o
corte, é dar um raio a mais: perto da face que emitiu o raio (a escala do
erro de ponto flutuante, a mesma de sempre) continua ignorado; a partir de
uma fração do tamanho do próprio corpo — bem menor que a "sala", bem maior
que o acne — o raio volta a valer, e a parede oposta volta a bloquear. Uma
esfera não ganha esse raio a mais: não tem "lado oposto" para separar de
acne, e continua no corte de sempre.

**Sólido é a face preenchida, não uma primitiva nova.** A engine só sabe desenhar
linha, então uma superfície opaca é uma face hachurada com linhas próximas o
bastante para não sobrar buraco — exatamente como o painel refletivo sempre foi
feito, e agora pelo mesmo código. Um corpo em wireframe já bloqueava luz, mas se
deixava atravessar pelo olhar, e um objeto que projeta sombra e não tapa o que
está atrás é uma contradição que o olho percebe antes de saber nomear. Só as
faces viradas para a câmera são desenhadas: as de trás caem à mesma profundidade
das da frente dentro da tolerância do z-buffer, e desenhá-las deixaria metade das
células decidida por ordem de desenho em vez de por distância. As doze arestas
continuam sendo desenhadas por cima, com a normal da costura de cada uma — elas
são a silhueta.

**Um efeito de luz tinge a célula, não a substitui.** O framebuffer guarda um
glifo e uma cor por célula, e a regra de sempre é "quem está mais perto vence
inteiro" — certa para duas superfícies, errada para um feixe de holofote ou
poeira em suspensão, que não têm corpo próprio e vencer o teste de
profundidade só significa "esta luz incide aqui". Sem distinguir os dois
casos, um feixe que passa raspando uma parede ganhava a célula por inteiro:
trocava o glifo da parede pelo próprio ponto, e — pior — apagava a marca de
"corpo sólido" (ver acima) que a parede tinha deixado, abrindo um buraco para
o céu bem no meio do objeto. `Fragment.fuse` existe para esse caso: em vez de
substituir, soma cor e emissivo sobre o que já estiver na célula, preservando
o glifo e a opacidade de quem estava lá. Por isso o feixe vive numa segunda
passada (`renderGlow`, depois de `render` de toda a cena) — só assim ele
sempre encontra a parede já desenhada, não importa a ordem em que os dois
objetos foram criados.

**"Corpo sólido" não pode sumir só porque outra coisa desenhou por cima.** O
mesmo "quem está mais perto vence inteiro" tem uma segunda vítima além do
feixe: as próprias arestas do monólito, desenhadas por cima da hachura da sua
face (ver acima). Uma aresta é traço, não corpo — `opaque=false`, de
propósito, para continuar vazia entre a tinta quando não há nada atrás dela.
Mas quando ela cai bem em cima da hachura da própria face, à mesma
profundidade, vencer o empate apagava o `opaque` que a hachura tinha deixado:
o vão do glifo `:` da aresta virava janela para o céu bem no meio de uma
parede que deveria ser sólida — o mesmo defeito do feixe, só que entre duas
superfícies do mesmo objeto em vez de entre luz e superfície. A correção é
`opaque` **pegajoso**: só herda de quem já estava lá quando as duas
profundidades coincidem (mesma superfície, dentro da tolerância do z-buffer)
— uma superfície genuinamente mais perto, a uma distância diferente de
verdade, não herda nada e decide sozinha com o próprio `opaque`. Isso resolve
a aresta de graça, mas não o disco do orbe ou a carcaça do holofote: os dois
são corpo, não hachura em cima de outra coisa, então não têm de quem herdar —
precisam declarar `opaque=true` eles mesmos, senão a franja do próprio
degradê (onde o glifo escolhido para aquele brilho tem pouca tinta) vira o
mesmo buraco.

**Uma área preenchida nunca paga a busca por forma.** O interior de uma face
não tem silhueta para preservar — ali o traço é meio e não fim —, então ela
busca só por cobertura: o glifo do pool inteiro da textura cuja cobertura
*medida* no atlas está mais perto do nível-alvo, nunca o nível mais baixo,
porque o espaço deixaria um buraco no meio de um corpo sólido. O chão
preenchido é o caso oposto e usa o nível vazio de propósito: é assim que uma
poça de luz tem borda em vez de retângulo. A busca por forma (a mesma que a
aresta usa, ver abaixo) fica reservada para quem gera poucos fragmentos por
quadro — hachura de face sozinha já soma milhares.

**O nível de uma rampa é medido, não suposto.** O índice de um fragmento
preenchido é uma busca binária pelo glifo, dentro do pool da textura ordenado
por cobertura, cuja cobertura real no atlas (mesma medição de seis amostras
do casamento de forma, reduzida a uma média) está mais perto do nível-alvo —
a posição de cada caractere na rampa não é palpite nenhum, e o pool em si
não é mais uma string de meia dúzia de caracteres digitada à mão: é medido a
partir da CP437 inteira (ver "A rampa de glifos é escolha, não conclusão").

**As camadas do céu são luz do sol, e passaram a saber disso.** O roxo em volta
do horizonte, o rosa atrás do disco e o ciano rente à linha eram três constantes:
o céu ficava igual com o sol a quatro graus ou a quarenta, com um disco de três
graus ou de trinta, e continuava rosa depois de o sol se pôr — o gradiente tinha
a _posição_ do sol e ignorava tudo o mais sobre ele. Agora o sol se descreve em
três escalares, e quem pinta o céu só os lê: quanto ele acende as camadas, o
quanto disso é poente rasante, e a largura do halo. É o mesmo trio que o raio de
reflexo consome, pela regra que `sky-colors.ts` já registrava — a grade não pode
refletir um poente que não está mais pintado atrás dela.

**O poente e a sombra caem em curvas diferentes.** A luz direcional some quando o
disco encosta no horizonte: dali para baixo ela é rasante e não ilumina mais
nada. A atmosfera não — o que brilha num poente é o ar iluminado por baixo, e ele
continua aceso um bom tempo depois de o disco sumir. Uma curva só apagaria o rosa
com o sol ainda em vista, que é justamente a hora em que ele deveria estar mais
forte.

**Desligar o sol não é afundá-lo.** Com a elevação no fundo da escala ele ainda
ilumina de raspão e o poente continua aceso — é fim de tarde, não noite. O
interruptor tira o disco, a luz direcional e o que o céu espalhava dela, e o que
sobra é a cena iluminada só pelo que existe nela: as estrelas, o neon da grade e
os orbes. A luz nem entra na lista do quadro — uma direcional de intensidade zero
custaria o mesmo teste por fragmento para não fazer nada, e ainda apareceria na
contagem do HUD como se estivesse iluminando.

**Traçado analítico, sem malha e sem grid ou BVH.** Tudo o que a engine desenha
é linha — até uma face sólida, que é linha repetida —, e um raio não acerta
linha: cada objeto declara a esfera ou a caixa que o representa. Com o custo
por teste constante e algumas dezenas de corpos, uma estrutura de aceleração
espacial custaria mais para manter do que economiza — mas "custo constante"
não quer dizer "custo igual": uma caixa (duas transformações de matriz e três
slabs) é bem mais cara de testar que uma esfera (só produtos escalares), e
toda caixa cabe inteira numa esfera do mesmo centro. Por isso o raio testa
primeiro essa esfera envolvente, e só paga o teste de caixa se ela for
atingida — nunca dá falso negativo, e descarta de graça a parede de uma sala
que o raio nem chega perto.

**A resolução é o que torna isto viável.** São 180 colunas, não 1920 — o
orçamento por fragmento é cem vezes o de um shader de pixel. A cena de
demonstração custa 4,4 ms de CPU por quadro; com treze luzes e dezesseis corpos,
6,4 ms.

**A luz cai a partir de uma distância de referência, não do inverso do quadrado
puro.** A curva é a mesma, mas ancorada: numa cena de dezenas de unidades de
lado, a queda física deixaria "força 6" sem significado nenhum no slider.

**A hachura do espelho é medida em células, não em unidades de mundo.** A placa
refletiva é preenchida com linhas paralelas, e quantas depende de quanto ela
ocupa _na tela_: o rasterizador projeta a aresta e diz a quantas células as
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

**A rampa de glifos é escolha, não conclusão — mas é um peso, não um switch.**
Quanto a luz pode vencer a forma na escolha do glifo de aresta é
`rampWeight`, um número contínuo (`config.ts`), não três algoritmos
separados: zero é geometria pura — a leitura de wireframe de sempre, a
referência para comparar — e subindo, os fragmentos mais iluminados de uma
aresta ganham glifos mais pesados sem que a direção da linha pare de opinar.
Era um `enum` de três modos (`classic`/`family`/`off`) até essa distinção se
revelar o próprio bug: no modo padrão, a forma da aresta era calculada
certo e descartada por completo por uma indexação linear cega, e é por isso
que toda aresta de um monólito lia como o mesmo `:` não importa a luz. Um
peso contínuo sobre a mesma busca (ver abaixo) elimina essa bifurcação: não
existe mais um modo em que a forma é jogada fora, só um em que ela pesa
menos.

**O glifo de uma aresta vem de casamento de forma *e* de luz, não de um
balde de quatro nem de uma indexação cega.** Inspirado em
alexharri.com/blog/ascii-rendering: cada glifo candidato tem um vetor de
seis amostras, medido lendo o próprio canvas do atlas (`glyph-shape.ts`,
`render/atlas-canvas.ts`) — o mesmo bitmap que a GPU usa para desenhar, à mão
ou da fonte do sistema, tanto faz. A reta que o rasterizador está desenhando
tem uma forma local (direção mais onde exatamente ela cruza a célula,
`offsetCol`/`offsetRow`) que o vizinho mais próximo compara contra os
candidatos, **junto com** a cobertura-alvo que a luz pede — as duas coisas
na mesma busca, ponderadas por `rampWeight` (`nearestWeightedGlyph`,
`glyph-shape.ts`). É o que abre a porta que a classificação de quatro
baldes (`VERTICAL/HORIZONTAL/UP/DOWN`) nunca abriu: duas arestas de uma
caixa que se cruzam na mesma célula podem virar um canto de moldura de
verdade (`┌┐└┘├┤┬┴┼`, ver "O nome"), e sob luz forte podem pesar mais sem
perder a direção. O `_`/`-` de sempre — perto assenta no chão, longe pesa
menos — continua sendo decisão de distância, não de forma: ela só filtra
qual dos dois entra no conjunto de candidatos antes da busca.

**O contraste direcional atravessa a borda da célula sem imagem nenhuma.** O
artigo usa doze amostras fora da célula para saber se uma forma continua na
vizinha, porque a fonte dele é uma imagem já pronta — só dá para *olhar*
pixel que já existe. Aqui a fonte é uma primitiva analítica (reta, ou família
de retas paralelas na hachura), e essa função de cobertura responde em
qualquer ponto da tela, dentro ou fora da célula atual — então as doze
amostras externas custam avaliação, não pixel de vizinho nenhum
(`sampleLineCoverage`/`enhanceContrast`, `glyph-shape.ts`). É o que evita o
vizinho-mais-próximo pular de glifo por um triz entre duas células da mesma
aresta. O que **não** foi portado do artigo é a k-d tree, mas por um motivo
diferente do original: o pool de candidatos hoje é a CP437 quase inteira
(~256 glifos, medidos uma vez só a partir de `palette.ts`), não dezenas — e é
exatamente por isso que a busca por fragmento não varre o pool inteiro. Ela
é uma janela de umas dezenas de candidatos em torno do ponto onde o mínimo
combinado (forma + cobertura-alvo) deveria estar, achado por busca binária
num array já ordenado por cobertura — o suficiente para o custo por
fragmento não se importar com o pool ter crescido.

**Textura é o alfabeto de onde o glifo sai, e agora é medido, não
digitado.** Uma engine que rasteriza para caracteres tem um canal que
nenhuma outra tem — a forma do glifo — e a rampa já usava metade dele para
carregar luz. A outra metade é superfície: `lisa` é o pool inteiro da CP437
sem filtro, o gradiente mais fino possível e o que mais expõe letras e
símbolos fora dos blocos de sempre; `áspera` é o subconjunto medido desse
mesmo pool cujas seis amostras concordam entre si — preenchimento uniforme
dentro da célula, variância baixa — espaçado por um degrau mínimo de
cobertura, o que reproduz o degrau grosso que o olho lê como aspereza sem
depender de uma lista de blocos hand-typed; `irregular` é o mesmo pool
áspero com o nível deslocado por ruído. O peso da rampa continua sendo
preferência de quem olha; a textura é do objeto, e é por isso que ela mora
na entidade e não em `settings` — dois monólitos lado a lado, sob a mesma
luz e o mesmo peso, podem ser de materiais diferentes.

**O ruído da textura irregular é ancorado no mundo, não na tela.** Sorteado por
célula de tela ele nadaria sobre a superfície a cada passo da câmera, que é o
oposto de textura. A posição de mundo é quantizada antes do sorteio, e é a
quantização que dá área à mancha: sem ela cada fragmento tira um número próprio e
a superfície vira chuvisco.

**A textura fica na caneta, não no material.** `light/` não sabe o que é um
glifo, e o material é transporte de luz — o mesmo motivo pelo qual a normal da
face também não mora lá. A `SurfacePen` é a ponte entre luz e caractere, e
textura é exatamente a decisão que essa ponte toma.

**O menu é desenhado na grade de caracteres.** O painel em DOM que ele substitui
vivia fora da cena: tinha folha de estilo própria, era um segundo lugar onde a
paleta morava, e ficava sobre o canvas sem pertencer a ele. Este passa pelo mesmo
bloom e pelas mesmas scanlines — o visual de CRT não é imitado, é o mesmo caminho
de render. Só foi possível porque o charset passou a ter a tabela ASCII com o
índice igual ao código do caractere, e o Latin-1 junto, para acento ser um
detalhe de conteúdo e não uma limitação técnica. O vocabulário de blocos e
moldura que ele desenha é o da CP437; veja _O nome_.

### As decisões da edição

**Editar não exige soltar o mouse.** O caminho anterior era o do navegador:
`Esc` solta o ponteiro, o menu abre, e a cena é operada com o cursor do sistema
por cima dela. Funciona e cobra caro — para mover um objeto é preciso sair do
voo, atravessar um menu de oito grupos e voltar, e o painel tapa justamente o
que está sendo editado. No modo de edição a captura nunca é solta: o mouse
deixa de girar a câmera e passa a mover um cursor da própria engine, e o teclado
continua voando.

**O cursor é desenhado no framebuffer.** Não é conveniência: é a mesma razão pela
qual o menu deixou de ser DOM. O retículo passa pelo bloom e pelas scanlines
como o resto da cena, em vez de flutuar por cima dela sem pertencer a ela. Os
braços dele ficam afastados do centro e em distâncias diferentes nos dois eixos
— o vão é o que o olho encontra numa grade que já é feita de linhas, e a célula
é 1:2.

**Um cursor só, para o menu e para o editor.** O menu apontava com a seta do
sistema, que cai entre duas células e não diz em qual delas vai clicar — num
menu desenhado na grade, isso é o ponteiro discordando da interface. Agora os
dois usam o mesmo retículo, e o ponteiro do sistema fica escondido enquanto ele
estiver em uso: dois cursores na tela ao mesmo tempo é pior do que nenhum.

**O cursor se alimenta de duas fontes, e a escolha não é preferência.** Com o
ponteiro capturado não existe posição absoluta, só movimento relativo, e o
cursor integra esse movimento. Solto, a posição absoluta existe e é ela que
manda — integrar deltas nesse caso deixaria o retículo escorregar em relação ao
ponteiro de verdade, e o clique cairia num lugar diferente do que a tela mostra.

**O botão direito devolve o olhar ao mouse, sem sair do modo de edição.** Mirar
a câmera é metade de posicionar um objeto: é preciso ver a cena do lado certo
para saber onde ele tem que ficar. Obrigar a sair do modo para cada olhada
reconstruiria, por dentro, o vaivém que o modo veio eliminar. Enquanto o botão
está pressionado o retículo fica parado onde estava, que é o que permite voltar
a arrastar de onde se parou.

**Selecionar não é mover.** O arrasto leva o objeto para debaixo do cursor, e
quem clica quase nunca acerta o centro de um monólito de seis metros — então o
primeiro quadro do clique dava um salto do tamanho do erro. A diferença entre o
objeto e o ponto onde o raio fura o plano é guardada no clique e somada de volta
a cada quadro: clicar sem mexer o mouse não move nada, e o ponto agarrado
continua sob o cursor durante o arrasto inteiro. Ela é refeita quando o arrasto
vertical muda a altura, porque o plano onde o objeto desliza é o da própria
altura dele.

**As setas de redimensionar são medidas na tela, não no eixo.** Cada face
projeta o próprio eixo e descobre quantas células uma unidade de mundo vale
_ali_; o arrasto é projetado sobre essa direção. Uma sensibilidade fixa erraria
por um fator de dez entre um objeto colado na câmera e um no fim da cena, e a
seta apontaria para dentro do objeto na metade das voltas que se dá em torno
dele. A face oposta fica onde está — o centro anda metade do que a extensão
cresceu — senão puxar a face de trás empurraria a da frente e o objeto pareceria
fugir do cursor.

**O manipulador é um só, para dois donos.** O menu opera a cena com o ponteiro
do sistema; o editor, com o cursor da engine. É o mesmo gesto, e duas
implementações divergiriam no primeiro ajuste — uma passaria a esticar pela face
e a outra continuaria só arrastando. O que muda entre os dois é de onde vêm a
célula e o deslocamento, então tudo no manipulador é escrito em células de tela
e quem chama converte.

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
    mirror-bounce.ts espelho vira fonte de luz secundária, um bounce só
    shade.ts         queda de luz e tingimento de occluders para reflexo — o
                     kernel de sombreamento por fragmento em si vive em
                     render/gpu/passes/shading.ts (WGSL)
  render/
    viewport.ts      teto de colunas, tamanho de célula, devicePixelRatio
    camera.ts        posição, yaw, pitch, fov
    framebuffer.ts   dois planos no formato que a GPU consome direto
    rasterizer.ts    clipping, DDA, posição de mundo, disco, raio inverso
    shading.ts       a caneta que liga luz a caractere; o chão
    ramp.ts          luminância → glifo, nos três modos e nas três texturas
    palette.ts       cores nomeadas e os 256 glifos
    text.ts          texto e molduras escritos na grade
    sky-colors.ts    as cores do céu, compartilhadas com o shader
    atlas-canvas.ts  o canvas 2D com os 256 glifos, que o atlas da GPU sobe
    debug-dump.ts    despeja o framebuffer como texto
    gpu/
      context.ts     dispositivo WebGPU, resize, perda
      atlas.ts       sobe o atlas de glifos como textura
      light-upload.ts luzes e occluders para a GPU, como storage buffer
      presenter.ts   orquestra os passes; captura fora da tela, para diagnóstico
      passes/        shading (compute, WGSL — o kernel de luz e a escolha de
                     glifo), background, grid, bloom, composite
  scene/
    scene.ts         Renderable, contribute e render
    ground.ts        grade infinita, e o chão entre as linhas onde há luz
    sky.ts           estrelas e horizonte
    sun.ts           disco celeste, e a luz direcional que ele é
    world.ts         os objetos da cena: criar, escolher, salvar
    entities/
      entity.ts      o objeto como dado, e os campos que o menu edita
      box.ts         a caixa orientada, desenhada e testada pela mesma matriz
      hatch.ts       encher uma face com linhas, na densidade que a tela pede
      orb.ts         esfera emissiva: a luz colorida e o que se vê dela
      monolith.ts    caixa sólida ou em wireframe, que recebe luz e projeta sombra
      panel.ts       placa refletiva: onde o raio de espelho tem o que mostrar
  ui/
    menu/            o menu de pausa, desenhado em caracteres
    cursor.ts        o ponteiro da engine, desenhado na grade
    editor.ts        modo de edição: seleção e painel lateral
    manipulator.ts   selecionar, arrastar, girar e esticar pelas faces
    hud.ts           fps, custo da cena e estado da câmera
  config.ts          fonte única dos parâmetros ajustáveis
```

## Depurando

Em desenvolvimento, `window.engine` expõe `camera`, `settings`, `scene`, `world`,
`lights`, `menu`, `rasterizer`, `presenter`, `capture(escala)`, `dumpGlyphs()`,
`countByColor()`, `showCharset()`, `setOverlay(fn)` e `step()`.

`dumpGlyphs` e `countByColor` respondem a pergunta que a GPU não responde: _qual
caractere está realmente naquela célula_, e _que camada sumiu_. `showCharset`
cobre a cena com os 256 glifos e confere atlas e data textures.

`step()` desenha um quadro sob demanda. Numa aba em segundo plano o
`requestAnimationFrame` não dispara, e sem ele qualquer verificação de "mudei o
ajuste, o que aconteceu?" mede o quadro anterior e conclui que nada mudou.

## O que ainda não existe

Isto é a engine, não o jogo. Não há colisão nem estado de jogo, e a simulação não
faz nada além de mover a câmera e girar os orbes. A costura para isso é
`Renderable` e o `World`, que é onde o `gameState` já começou a existir: os
ajustes de `settings` são preferência de quem olha, a cena é conteúdo — a
distinção que importa é essa, não mais quem é salvo: os dois são, cada um sob
sua própria chave de `localStorage`, e cada um mesclado sobre seus próprios
defaults ao carregar.
