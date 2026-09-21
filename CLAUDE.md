# CP437 Engine — guia para o Claude

Engine 3D em TypeScript puro que rasteriza para uma grade de caracteres na CPU e
apresenta tudo em **um draw call** WebGPU. Sem dependência de runtime (Three.js,
libs de render ou de math não existem aqui — e não devem ser adicionadas).

> O `README.md` é a fonte do **porquê**: cada decisão de projeto está justificada
> lá, em prosa. Este arquivo é o **como**: contratos, invariantes e onde mexer.
> Antes de "corrigir" algo que parece estranho, procure a decisão no README — a
> maioria das esquisitices é deliberada e está documentada.

## Comandos

```bash
npm run dev        # Vite + HMR
npm run typecheck  # tsc --noEmit
npm run build      # typecheck + bundle em dist/
```

Não há testes nem linter. **`npm run typecheck` é a única porta de qualidade** —
rode depois de qualquer alteração. `tsconfig` é estrito de verdade:
`noUncheckedIndexedAccess`, `noUnusedLocals/Parameters`, `verbatimModuleSyntax`
(use `import type` para tipos). Formatação: Prettier com defaults, 2 espaços.

## Convenções

- **Comentários, docs e mensagens de commit em português.** Rótulos de interface
  (menu, HUD) **em inglês**. Não misture.
- Comentários explicam *por que*, não *o que*. O código já diz o quê.
- Math com **destino explícito** (`out` como primeiro argumento) — `vec3.add(out,
  a, b)`, `setRgb(out, …)`. **Nada aloca no hot path**: objetos reutilizados em
  escopo de módulo ou campos privados da classe. Um `{x,y,z}` novo por fragmento
  mata o orçamento de CPU.
- Enums são objetos `as const` + `type X = (typeof X)[keyof typeof X]`
  (`LIGHT`, `OCCLUDER`, `ENTITY`, `RAMP`, `TEXTURE`, `SLOPE`, `GLYPH`).
- Ângulos em **radianos** no dado; graus só na fronteira da interface.

## Pipeline

```
scene.contribute(ctx)  → LightWorld (luzes + occluders), antes de qualquer desenho
scene.render(ctx)      → primitivas em coordenadas de MUNDO
scene.render(ctx) fase 2 → renderGlow(ctx): incidência sobre o que já foi desenhado
Rasterizer (CPU)       → view → clip near → projeção → célula → clip 2D → DDA
SurfacePen.style       → G-buffer (posição, normal, material, forma); sem luz, glifo geométrico direto
Framebuffer (CPU)      → 2 planos RGBA8 [glifo, alpha, emissivo, 255]/[r,g,b,255] + G-buffer
──── fronteira CPU/GPU ─────────────────────────────────────────────
ShadingPass (WGSL, compute) → shadeSurface + ramp: luminância + textura → glifo, por célula
GpuPresenter (WebGPU)  → background → grid → UiLayer (grade da interface) → bloom → composite
```

Menu, painel do editor e retículo **não** escrevem no framebuffer da cena: têm
uma segunda grade (`render/ui-viewport.ts`), com célula fixa em px CSS, o
próprio `Framebuffer` (`uiFramebuffer` em `main.ts`) e o próprio atlas
(`render/gpu/ui-layer.ts`, que reusa `GridPass`). Só células resolvidas, sem
`ShadingPass`. Setas de face do `Manipulator` continuam na grade da cena.
A grade de UI é composta **por cima** da cena, então célula transparente deixa o
ASCII da cena vazar por baixo do glifo: painéis desenham com
`framebuffer.opaqueOverlay = true` (o vão do glifo vira o fundo do painel, ver
`GridPass.setOpaqueFill`). Retículo e ajuda sobre a cena nua ficam transparentes.

## Contratos que todo código novo respeita

**`Renderable` (`scene/scene.ts`)** — `contribute?(ctx)` registra luz/corpo,
`render(ctx)` desenha, `renderGlow?(ctx)` tinge por cima do que `render` de
*toda* a cena já desenhou naquele quadro. Nunca desenhe em `contribute`, nunca
registre luz em `render`: iluminação não pode depender da ordem da lista da
cena. Pelo mesmo motivo, nada que dependa de encontrar superfície já desenhada
(`Fragment.fuse`) vai em `render` — só em `renderGlow`, senão o resultado muda
conforme a ordem dos objetos.

**Duas grades, um cursor** — `Cursor` guarda a posição em **px CSS** e a lê nas
duas grades: `sceneCol/Row/ExactCol/ExactRow` para mirar em objetos,
`uiCol/Row/ExactCol/ExactRow` para widgets. Nunca use `scene*` para hit-test
de menu, nem `ui*` para mira: as células têm tamanhos bem diferentes.
`computeLayout`/`computePanelLayout` recebem `UiViewport`; nada de menu depende
de `renderScale`.

**`RenderContext`** — `{ camera, viewport, rasterizer, time, lights, shading }`.
Reaproveitado; não guarde referência entre quadros.

**`Rasterizer` (`render/rasterizer.ts`)** — única fonte de primitivas:
`line(a, b, style)`, `disc(center, raio, …)`, `plot/plotCell`, `project`,
`projectDirection`, `rayThrough(col,row,out)` (caminho inverso, usado por
seleção e preenchimento do chão), `radiusRowsAt`, `angularRadiusRows`,
`horizonRow`, `cellIsEmpty`. **A engine só sabe desenhar linha e disco** — uma
face sólida é `hatch.ts` repetindo linhas na densidade que a tela pede.

**`SurfacePen` (`render/shading.ts`)** — a ponte luz→caractere. Segura
`material`, `normal(x,y,z)`, `ownerId` (para não se auto-sombrear), `texture`,
`area` (face preenchida busca só por cobertura medida no pool inteiro da
textura; aresta busca por forma *e* cobertura juntas, ponderadas por
`settings.rampWeight` — um peso contínuo, não um switch de modos), `fogged`,
e o gancho `beforeShade` (só o chão usa). Entrega `pen.style` ao
rasterizador. `begin(ctx)` uma vez por quadro.

**`LightWorld` (`light/world.ts`)** — pool. `begin()` zera contadores,
`addLight()` / `addOccluder(ownerId)` devolvem objetos reciclados; **preencha
todos os campos**, o anterior ainda está lá.

**`EntityKindDef` (`scene/entities/entity.ts`)** — tipo de objeto = dado
(`EntityState`, um formato só) + comportamento no registro `ENTITY_KINDS`
(`scene/world.ts`): `defaults`, `contribute`, `render`, `renderGlow?`,
`fields`, `uniformSize`.

**`Framebuffer`** — `plot()` faz o teste de profundidade com tolerância
(`DEPTH_TOLERANCE`; sem ela a grade sai picotada). `isEmpty()` lê o **alpha**,
não a profundidade. Valores acima de 1.0 vão para o canal emissivo
(`EMISSIVE_RANGE = 4`), via `writeHdrColor` — é o que vira halo no bloom.
`fuse=true` muda o que acontece ao vencer o teste: em vez de substituir glifo
e `opaque`, soma cor e emissivo sobre o que já está na célula — é como um
feixe de luz ilumina uma parede em vez de apagá-la (ver `Fragment.fuse` e
`spotlight.ts`). Fora do `fuse`, `opaque` ainda é **pegajoso** quando as duas
profundidades coincidem (mesma superfície, tolerância de `DEPTH_TOLERANCE`):
uma aresta desenhada em cima da própria hachura não some o `opaque` dela só
por vencer o empate. Uma profundidade genuinamente diferente não herda nada —
decide sozinha. Todo corpo sólido sem hachura por baixo (disco do orbe, disco
do holofote) tem que passar `opaque=true` explicitamente: não há nada para
herdar de.

## Invariantes que quebram em silêncio

- **Interpole em `1/w`**, nunca em `w`: profundidade e posição de mundo. Senão a
  névoa e a sombra escorregam quando a câmera gira.
- **Clip em dois estágios**: near plane em espaço de view (antes da divisão
  perspectiva) e retângulo de tela (antes do DDA).
- **`aspect = (colCount / rowCount) / CELL_ASPECT`**, `CELL_ASPECT = 2` — a
  célula é 1:2. Entra na projeção uma vez só.
- **Céu não tem paralaxe**: estrelas e sol são direções unitárias, só rotação.
- **O sol se descreve em `lights.sky`** (`sunGlow`, `horizonGlow`, `sunSpread`)
  durante `contribute`; `main.ts` e `sky-colors.ts`/shader só **leem**. Nunca
  recalcule o céu num segundo lugar — o reflexo e o fundo divergiriam.
- Alinhamento horizonte/bruma depende de `Math.round(horizonRow())` casar entre
  `Sky.drawHorizon`, `Ground` e `updateAtmosphere` em `main.ts`.
- **Sombra de caixa consigo mesma usa um bias maior, não o corte de sempre**
  (`light/trace.ts`, `SELF_SHADOW_FRACTION`). Ignorar o próprio corpo inteiro
  (o que ainda acontece para esfera) impede a caixa de bloquear luz para a
  sua própria parede oposta — some quando visto de fora, mas de dentro de uma
  sala o sol atravessa a parede como se ela não existisse.
- Ruído de textura irregular é ancorado em **posição de mundo quantizada**, nunca
  em célula de tela.
- Perda de dispositivo é tratada desde o começo (`device.lost`, `render/gpu/context.ts`
  — o equivalente WebGPU de `webglcontextlost`); recursos são recriados. Não
  assuma dispositivo vivo.

## Onde mexer

| Quero… | Vá em |
| --- | --- |
| novo ajuste do menu | `config.ts` (`Settings` + default) → `ui/menu/schema.ts` (grupo) |
| novo tipo de objeto | `scene/entities/<novo>.ts` com `EntityKindDef` → registre em `ENTITY_KINDS` e `ENTITY_ORDER` (`scene/world.ts`) → `ENTITY` em `entity.ts` |
| novo glifo | `render/palette.ts` (`GLYPH`, `CHARSET` — tabela CP437 real); desenhados à mão em `render/atlas-canvas.ts` (`PAINTERS`, indexado por caractere) |
| efeito de tela | `render/gpu/passes/` + ordem em `gpu/presenter.ts` |
| parâmetro de URL (embed) | `url-config.ts` (lê) e `embed-url.ts` (escreve); campo de `Settings` já funciona sozinho pelo nome |
| tamanho/layout do menu | `render/ui-viewport.ts` (célula) e `ui/menu/draw.ts` (`computeLayout`, compacto abaixo de `COMPACT_BELOW_COLS`) |
| como a luz vira caractere | `render/ramp.ts` (rampa e texturas) |
| escolha de glifo por forma (aresta, disco, cobertura de preenchimento) | `render/glyph-shape.ts` (amostragem, contraste, vizinho mais próximo) + candidatos em `render/ramp.ts` |
| matemática de luz | `render/gpu/passes/shading.ts` (kernel de sombreamento, reflexo e céu, em WGSL — única implementação, não há mais versão CPU) e `light/trace.ts` (raio×esfera/caixa; ainda roda na CPU para as sondas de `light/mirror-bounce.ts`) |
| gesto de edição | `ui/manipulator.ts` (um só, para menu e editor) |
| efeito de luz que tinge em vez de desenhar (feixe, poeira) | `Fragment.fuse` no `SurfaceStyle` + hook `renderGlow` do `EntityKindDef` (ver `spotlight.ts`) |

O atlas tem 256 glifos na ordem da **CP437 real** — `render/palette.ts` monta
`CHARSET` como essa tabela, e `glyphForChar` traduz caractere → índice por
mapa (não por aritmética: a CP437 não é contígua com o código Unicode). Um
acento fora da CP437 (`ã`, `õ`) cai para a letra sem acento antes de virar
espaço. Ver "O nome" no README.

## Persistência e estado

- `settings` (`config.ts`) = preferência de quem olha. Salvo em `localStorage`
  sob `cp437-engine/settings`, automaticamente a cada mudança de controle no
  menu (`saveSettings()`, chamado pelos helpers `slider`/`toggle` de
  `ui/menu/schema.ts`). No `loadSettings()` (chamado uma vez, em `main.ts`,
  antes de qualquer leitura de `settings`), o salvo é mesclado sobre uma cópia
  congelada dos defaults — mesmo espírito do merge de `World.load()` abaixo.
- `World` (`scene/world.ts`) = conteúdo. Salvo em `localStorage` sob
  `cp437-engine/scene`; `current` (posição animada) é derivado e não serializa.
  No `load`, o salvo é mesclado sobre `createEntity(kind, defaults())` — campos
  novos nascem com valor sensato em cenas antigas.

## URL, embed e persistência

`url-config.ts` lê a URL uma vez, no topo de `main.ts`. Qualquer campo de
`Settings` vira parâmetro (tipo pelo default; números são limitados à faixa do
slider por `applySettingOverrides` — por isso um ajuste novo só precisa de
slider com `key`). URL com settings ou `scene` desliga o `localStorage`
(`persistence.ts`) na sessão, salvo `persist=1`. `main.ts` usa top-level `await`
para decodificar a cena antes do primeiro quadro (`scene/scene-codec.ts`). O
menu tem "Copy embed URL" (`embed-url.ts`). Lista de parâmetros: README, "Embedding".

## Depuração

`window.engine` em dev (`main.ts`): `camera`, `settings`, `scene`, `world`,
`lights`, `menu`, `editor`, `manipulator`, `cursor`, `rasterizer`, `presenter`,
`input`, `freecam`, `getUiFramebuffer()`, `getUiViewport()`, `capture(escala)`, `dumpGlyphs()`, `countByColor()`,
`showCharset()`, `setOverlay(fn)`, `step(dt)`.

`step()` é essencial: em aba de segundo plano o `requestAnimationFrame` não
dispara, e verificar "mudei o ajuste, o que aconteceu?" mediria o quadro
anterior. `dumpGlyphs`/`countByColor` respondem o que a GPU não responde: qual
caractere está mesmo na célula, e que camada sumiu.

**Teste visual é o usuário quem faz.** Depois de mudar renderização,
iluminação ou qualquer coisa que só se confirma olhando a tela, não dirija o
navegador para verificar (screenshot, `readShadedPlanes`, ficar caçando
célula por célula) — rode `npm run typecheck`, descreva o que mudou e peça
para o usuário conferir na tela dele. Ele vê o resultado de uma vez; caçar
pixel por navegador automatizado é lento e não é confiável. Só dirija o
navegador você mesmo se o usuário pedir o contrário.

## Custo

180 colunas × 90 fileiras no teto (`render/viewport.ts`), e piso de célula de
`settings.minCellWidth` (6 px CSS) — janela pequena tem menos colunas, não células
menores. O orçamento por
fragmento é ~100× o de um shader de pixel, e é isso que torna traçado de raio na
CPU viável. Referência: cena demo ≈ 4,4 ms de CPU/quadro; 13 luzes e 16 corpos
≈ 6,4 ms. O HUD mostra `sceneMs`, luzes e occluders — **é o número a vigiar** ao
mexer em `light/`, `shading.ts` ou `ground.ts`. Cortes que existem de propósito:
`range` da luz, `shadowThreshold`, `maxShadowLights`, e o duplo sombreamento do
chão (sonda barata sem sombra → completo só para quem passa do limiar).
