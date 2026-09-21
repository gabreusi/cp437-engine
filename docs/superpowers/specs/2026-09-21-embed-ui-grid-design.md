# Embed: grade de UI própria, aspect-ratios e configuração por URL

Motivo: a engine embarcada num iframe de ~624×500 gera uma grade de cena com
células de ~3,5×7 px, e o menu (desenhado nessa mesma grade) fica ilegível.

## 1. Grade de UI

- `render/ui-viewport.ts`: `computeUiViewport` — célula fixa em px CSS (8×16 ×
  `uiScale`), independente de `renderScale` e dos tetos da cena. Cobre o
  retângulo do canvas da cena; a sobra sub-célula fica de fora.
- Um `Framebuffer` de UI (mesmo tipo da cena; só células resolvidas). Todo o
  `render/text.ts` e `ui/menu/draw.ts` seguem iguais.
- `GpuPresenter`: segundo atlas (célula de UI) + segundo `GridPass`, desenhado
  no render pass da cena, depois da grade da cena e antes do bloom, com
  `setViewport` no retângulo da UI. Os planos `cells`/`colors` sobem por
  `writeTexture` (sem `ShadingPass`).
- `Cursor` guarda posição em px CSS e expõe `sceneCol/Row` (mira em objetos) e
  `uiCol/Row` (widgets). Retículo desenhado na grade de UI.
- Menu de pausa e painel do editor migram para a grade de UI. `Manipulator`
  e as setas de face continuam na grade da cena.
- Layout compacto: abaixo de `COMPACT_COLS` colunas, os grupos viram abas
  numa fileira no topo.

## 2. Cena

- `computeViewport(..., minCellWidth)`: piso de largura de célula em px CSS
  (padrão 6; `Settings.minCellWidth`). Desktop grande não muda.
- `fovDegrees` vale para o eixo menor (vertical em paisagem, horizontal em
  retrato), com teto de FOV horizontal. Um só cálculo, em `render/camera.ts`.

## 3. URL

- `url-config.ts`: parse único, antes de `loadSettings`.
- Settings: qualquer chave de `Settings`, tipo derivado do default.
- Cenário: `scene=demo|empty|<base64url(deflate-raw(JSON))>`, `cam=x,y,z,yaw,pitch`.
- Flags: `hud`, `menu`, `ui`, `orbit`, `lock`, `persist`.
- Persistência: settings/cena na URL ⇒ a sessão não lê nem grava
  `localStorage` (a menos que `persist=1`).
- Menu: ação "Copy embed URL" (só o que difere do default).
