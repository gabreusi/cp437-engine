import { type Vec3, vec3 } from "../../math/vec3";
import { createProjected, type Projected, type Rasterizer } from "../../render/rasterizer";
import type { SurfacePen } from "../../render/shading";
import type { RenderContext } from "../scene";
import type { BoxShape } from "./box";

/**
 * Preencher a face de uma caixa com hachura.
 *
 * Uma superfície opaca numa engine que só sabe desenhar linha é uma face
 * preenchida com linhas paralelas próximas o bastante para não sobrar buraco.
 * É como o painel refletivo sempre foi feito, e a razão continua a mesma:
 * reaproveita inteiro o caminho de clipping, DDA e profundidade que já existe,
 * cada fragmento ganha posição de mundo de graça — que é o que a iluminação
 * precisa — e o resultado continua sendo desenhado como a engine desenha tudo.
 *
 * Vive fora dos dois objetos que a usam porque é uma só decisão de densidade, e
 * duas cópias dela se separariam: o monólito passaria a vazar de perto e o
 * painel não, ou o contrário.
 */

/**
 * Folga entre linhas da hachura, em células de tela.
 *
 * Um significa "linhas vizinhas em células vizinhas", que é a condição exata
 * para não sobrar buraco. Abaixo de um seria desenhar duas vezes na mesma
 * célula; acima, a face deixa de ser opaca e se enxerga através dela.
 */
const SPACING_CELLS = 1;

/**
 * Teto de linhas, como múltiplo da altura da janela em fileiras.
 *
 * O limite real é a tela: uma face não pode precisar de muito mais linhas do
 * que a janela tem fileiras. A folga de três existe porque a hachura é
 * distribuída pela face inteira, e uma face maior que a tela gasta boa parte
 * das linhas fora dela — a folga é o que mantém a parte visível fechada.
 * Amarrar o teto ao viewport, e não a um número fixo, é o que impede o custo de
 * acompanhar o tamanho da face em unidades de mundo.
 */
const MAX_SCREENS = 3;

// Rascunhos: isto roda por face, por objeto, por quadro.
const start: Vec3 = vec3();
const end: Vec3 = vec3();
const normal: Vec3 = vec3();
const firstEnd: Projected = createProjected();
const lastEnd: Projected = createProjected();

/**
 * O que a última medição de aresta encontrou.
 *
 * Fora da função pelo mesmo motivo que os vetores acima: devolver um objeto
 * seria alocar uma vez por face, por objeto, por quadro.
 */
let edgeSpan = 0;
let edgeNearDepth = 1;
let edgeFarDepth = 1;

/**
 * O ponto da aresta que cai a `screen` do caminho *na tela*, como fração do
 * comprimento dela em mundo.
 *
 * É a correção que faltava, e é a mesma regra que o rasterizador já segue para
 * profundidade e posição de mundo: o que é linear em espaço de tela é `1/w`, não
 * `w`. Distribuir as faixas uniformemente em espaço de mundo — que é o que esta
 * hachura fazia — só dá espaçamento uniforme na tela quando a face está de
 * frente. De esguelha, a metade próxima da face ocupa a maior parte da tela com
 * metade das faixas, e o vão entre elas passa de uma célula: é assim que se
 * enxerga através de um corpo sólido, e só nos ângulos.
 *
 * Com a correção, a contagem continua sendo o comprimento em células e o
 * espaçamento sai uniforme em qualquer ângulo — nenhuma linha a mais para
 * fechar o buraco.
 */
const perspective = (
  screen: number,
  nearDepth: number,
  farDepth: number,
): number => {
  if (nearDepth === farDepth) return screen;
  // Invertendo `s = (1/w - 1/w0) / (1/w1 - 1/w0)`, que é a interpolação em
  // `1/w` resolvida para o parâmetro de mundo.
  return (screen * nearDepth) / (farDepth - screen * (farDepth - nearDepth));
};

/** Meia-extensão da caixa naquele eixo. */
const halfOn = (half: Vec3, axis: number): number =>
  axis === 0 ? half.x : axis === 1 ? half.y : half.z;

/**
 * Ponto local montado a partir dos três eixos, na ordem certa.
 *
 * O vetor de trabalho é do módulo e não da chamada: isto roda uma vez por linha
 * de hachura, e alocar aqui seria entregar milhares de objetos por quadro ao
 * coletor de lixo — a mesma razão pela qual `vec3` escreve em destino explícito.
 */
const local = new Float64Array(3);

const localPoint = (
  shape: BoxShape,
  axis: number,
  depth: number,
  uAxis: number,
  u: number,
  vAxis: number,
  v: number,
  out: Vec3,
): Vec3 => {
  local[axis] = depth;
  local[uAxis] = u;
  local[vAxis] = v;
  return shape.toWorldPoint(local[0]!, local[1]!, local[2]!, out);
};

/**
 * Mede uma aresta transversal: quanto ela ocupa na tela e a que profundidade
 * cada ponta caiu.
 *
 * A profundidade entra porque o espaçamento das faixas não pode ser decidido só
 * pelo comprimento: veja `hatchFace`. `false` quando alguma ponta está atrás do
 * near plane — a face está colada na câmera, e densidade máxima é a resposta
 * certa.
 *
 * A métrica do comprimento é Chebyshev, e não euclidiana, porque a pergunta é
 * sobre células e não sobre pixels: duas faixas sem vão são duas faixas que não
 * pulam nenhuma coluna nem nenhuma fileira.
 */
const measureEdge = (
  shape: BoxShape,
  rasterizer: Rasterizer,
  axis: number,
  depth: number,
  uAxis: number,
  u: number,
  vAxis: number,
  halfV: number,
): boolean => {
  localPoint(shape, axis, depth, uAxis, u, vAxis, -halfV, start);
  if (!rasterizer.project(start.x, start.y, start.z, firstEnd)) return false;

  localPoint(shape, axis, depth, uAxis, u, vAxis, halfV, end);
  if (!rasterizer.project(end.x, end.y, end.z, lastEnd)) return false;

  edgeSpan = Math.max(
    Math.abs(lastEnd.col - firstEnd.col),
    Math.abs(lastEnd.row - firstEnd.row),
  );
  edgeNearDepth = firstEnd.depth;
  edgeFarDepth = lastEnd.depth;
  return true;
};

/**
 * A face está virada para a câmera.
 *
 * Não é só economia: as faces de trás caem à mesma profundidade das da frente
 * dentro da tolerância do z-buffer, e desenhá-las deixaria metade das células
 * decidida por ordem de desenho em vez de por distância.
 */
export const facesCamera = (
  shape: BoxShape,
  center: Vec3,
  half: Vec3,
  axis: number,
  sign: number,
  cameraX: number,
  cameraY: number,
  cameraZ: number,
): boolean => {
  shape.toWorldDirection(
    axis === 0 ? sign : 0,
    axis === 1 ? sign : 0,
    axis === 2 ? sign : 0,
    normal,
  );

  // A normal já carrega o lado, então o centro da face é o centro da caixa
  // mais a meia-extensão naquela direção.
  const reach = halfOn(half, axis);
  const toCameraX = cameraX - (center.x + normal.x * reach);
  const toCameraY = cameraY - (center.y + normal.y * reach);
  const toCameraZ = cameraZ - (center.z + normal.z * reach);

  return normal.x * toCameraX + normal.y * toCameraY + normal.z * toCameraZ > 0;
};

/**
 * Preenche uma face com linhas paralelas, com densidade decidida na tela.
 *
 * Contar linhas por unidade de mundo — que é o que a primeira versão do painel
 * fazia — erra nas duas pontas: de longe desenha vinte linhas que caem nas
 * mesmas três fileiras, e de perto deixa uma fileira vazia entre cada duas, e
 * uma superfície que se enxerga através não é uma superfície. A medida é feita
 * nas duas arestas transversais e vale a maior: com a face inclinada, a aresta
 * próxima é a que abre buraco primeiro.
 */
export const hatchFace = (
  shape: BoxShape,
  context: RenderContext,
  half: Vec3,
  axis: number,
  sign: number,
  pen: SurfacePen,
): void => {
  const { rasterizer } = context;

  // Os dois eixos que sobram, em ordem cíclica: `u` é o comprimento da linha,
  // `v` a direção em que elas se empilham.
  const uAxis = (axis + 1) % 3;
  const vAxis = (axis + 2) % 3;

  const depth = halfOn(half, axis) * sign;
  const halfU = halfOn(half, uAxis);
  const halfV = halfOn(half, vAxis);

  // Uma normal só para a face inteira: é um plano, não uma caixa.
  shape.toWorldDirection(
    axis === 0 ? sign : 0,
    axis === 1 ? sign : 0,
    axis === 2 ? sign : 0,
    normal,
  );
  pen.normal(normal.x, normal.y, normal.z);

  // As linhas daqui são preenchimento, não aresta: a rampa muda com isso.
  pen.area = true;

  const stripe = (v: number): void => {
    localPoint(shape, axis, depth, uAxis, -halfU, vAxis, v, start);
    localPoint(shape, axis, depth, uAxis, halfU, vAxis, v, end);
    rasterizer.line(start.x, start.y, start.z, end.x, end.y, end.z, pen.style);
  };

  const maxRows = context.viewport.rowCount * MAX_SCREENS;

  // Vale a aresta que ocupa mais tela: é ela que abre vão primeiro, e é o
  // perfil de profundidade dela que descreve a perspectiva desta face.
  let rows = maxRows;
  let nearDepth = 1;
  let farDepth = 1;

  let span = -1;
  if (
    measureEdge(shape, rasterizer, axis, depth, uAxis, -halfU, vAxis, halfV)
  ) {
    span = edgeSpan;
    nearDepth = edgeNearDepth;
    farDepth = edgeFarDepth;
  }
  if (
    measureEdge(shape, rasterizer, axis, depth, uAxis, halfU, vAxis, halfV) &&
    edgeSpan > span
  ) {
    span = edgeSpan;
    nearDepth = edgeNearDepth;
    farDepth = edgeFarDepth;
  }

  if (span >= 0) {
    rows = Math.min(maxRows, Math.max(1, Math.ceil(span / SPACING_CELLS)));
  } else {
    // Nenhuma ponta projetou: a face está atravessando o near plane. Sem
    // perspectiva conhecida, a distribuição volta a ser linear.
    nearDepth = 1;
    farDepth = 1;
  }

  for (let index = 0; index <= rows; index += 1) {
    stripe(-halfV + perspective(index / rows, nearDepth, farDepth) * halfV * 2);
  }

  pen.area = false;
};
