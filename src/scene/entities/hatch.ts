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
 * Não é 1. Duas faixas vizinhas são duas retas independentes: o DDA do
 * rasterizador (`Rasterizer.drawScreenLine`) decide os próprios passos pelo
 * comprimento *daquela* reta, não em sincronia com a vizinha, então os pontos
 * que cada uma efetivamente marca não caem nas mesmas frações de `u`. Um vão
 * *contínuo* — a distância que esta subdivisão mede — de uma célula inteira
 * não garante célula vizinha depois que os dois lados arredondam (`Math.round`)
 * cada um para o seu canto: a folga tem que cobrir esse desalinhamento de fase,
 * não só o vão em si. 0.2 é o valor que fechou o caso mais raso testado — um
 * painel quase de perfil, perto — sem abrir buraco; acima de ~0.5 ele reabre.
 */
const SPACING_CELLS = 0.2;

/**
 * Teto de faixas por face — rede de segurança, não o mecanismo principal.
 *
 * A densidade real vem da subdivisão adaptativa logo abaixo, que só quebra um
 * intervalo enquanto o vão medido *na tela* passa de uma célula. Este teto só
 * existe para o caso patológico de a câmera estar dentro da própria face — o
 * near plane corta as arestas o tempo todo, a distância nunca fica confiável,
 * e sem um teto o laço giraria para sempre.
 */
const MAX_SUBDIVISIONS = 4096;

/**
 * Quantos pontos ao longo de `u` entram na medida do vão entre duas faixas.
 *
 * Duas não bastam. O vão entre a faixa em `vA` e a faixa em `vB`, como função
 * de `u`, é uma razão de um polinômio linear por um quadrático sempre
 * positivo — álgebra, não intuição: a profundidade de cada aresta é afim em
 * `u`, a diferença de duas projeções com denominadores diferentes cancela os
 * termos cruzados e sobra grau 1 sobre grau 2. Essa forma pode crescer no
 * meio do intervalo e cair de novo nas duas pontas — um bojo — e é isso que
 * media só as bordas (`u = ±halfU`) deixava passar: as duas bordas mediam
 * folga, o bojo no meio da face não, e dava para ver através do objeto bem
 * no centro dela, olhando de perto e em ângulo composto (inclinado nos dois
 * eixos ao mesmo tempo — o caso que faz as duas coordenadas de tela mudarem
 * junto). Amostrar o meio além das bordas não prova nada por si, mas um bojo
 * de grau 1/2 não tem espaço para outro pico escondido entre três amostras
 * igualmente espaçadas na prática, e o custo extra é só mais duas projeções.
 */
const U_SAMPLES = 5;

// Rascunhos: isto roda por face, por objeto, por quadro.
const start: Vec3 = vec3();
const end: Vec3 = vec3();
const normal: Vec3 = vec3();
const curSamples: Projected[] = [];
const nextSamples: Projected[] = [];
const curValid: boolean[] = [];
const nextValid: boolean[] = [];
for (let i = 0; i < U_SAMPLES; i += 1) {
  curSamples.push(createProjected());
  nextSamples.push(createProjected());
  curValid.push(false);
  nextValid.push(false);
}

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
 * Projeta `U_SAMPLES` pontos ao longo de `u`, num dado `v`, recortando cada
 * um ao retângulo da tela. Marca em `outValid` quais pontas realmente
 * projetaram, e devolve quantas foram.
 *
 * Uma ponta não projeta (`rasterizer.project` devolve `false`) tanto perto do
 * near plane quanto simplesmente *atrás* da câmera — e a segunda é comum aqui:
 * `u` varre a largura inteira da face em passos fixos, e numa face grande
 * vista de um ângulo aberto (o painel, bem mais largo que fundo) a ponta
 * extrema pode cair fora do hemisfério da câmera enquanto o resto da face —
 * inclusive o `v` sendo medido — está perfeitamente visível. Se uma falha
 * dessas derrubasse a amostra inteira, `hatchFace` trataria a linha toda como
 * "sem medida confiável" e cairia no menor passo possível para a face inteira,
 * sem nunca voltar a andar rápido — exatamente a metade que ficava sem
 * hachura. Cada ponta é independente: as que falham somem da comparação (ver
 * `maxChebyshev`), e só quando *nenhuma* projeta é que a linha é mesmo
 * inconfiável.
 *
 * O recorte por coordenada (não é o Liang-Barsky exato do rasterizador, só um
 * clamp) existe para não gastar o orçamento de subdivisão medindo vão entre
 * pontos que estão todos fora da tela: uma face colada na câmera pode ter a
 * maior parte de si mesma fora do campo de visão, e sem o recorte o vão ali
 * mediria centenas de células — muito além do teto — e comeria a verba que a
 * parte visível precisa.
 */
const projectSamples = (
  shape: BoxShape,
  rasterizer: Rasterizer,
  colCount: number,
  rowCount: number,
  axis: number,
  depth: number,
  uAxis: number,
  halfU: number,
  vAxis: number,
  v: number,
  out: Projected[],
  outValid: boolean[],
): number => {
  let validCount = 0;
  for (let i = 0; i < U_SAMPLES; i += 1) {
    const u = -halfU + (2 * halfU * i) / (U_SAMPLES - 1);
    localPoint(shape, axis, depth, uAxis, u, vAxis, v, start);
    const point = out[i]!;
    const ok = rasterizer.project(start.x, start.y, start.z, point);
    outValid[i] = ok;
    if (!ok) continue;
    validCount += 1;
    point.col = Math.min(Math.max(point.col, 0), colCount);
    point.row = Math.min(Math.max(point.row, 0), rowCount);
  }
  return validCount;
};

/**
 * Maior vão em células — Chebyshev, e não euclidiano, pelo mesmo motivo de
 * sempre: a pergunta é sobre células, não pixels.
 *
 * Só compara amostras válidas dos dois lados: uma ponta que não projetou não
 * participa, em vez de contaminar a linha inteira (ver `projectSamples`).
 * `null` quando nenhum par de amostras é comparável — sem distância
 * confiável, e quem chama trata como vão infinito.
 */
const maxChebyshev = (
  a: Projected[],
  aValid: boolean[],
  b: Projected[],
  bValid: boolean[],
): number | null => {
  let worst = -1;
  for (let i = 0; i < U_SAMPLES; i += 1) {
    if (!aValid[i] || !bValid[i]) continue;
    const pa = a[i]!;
    const pb = b[i]!;
    const gap = Math.max(Math.abs(pa.col - pb.col), Math.abs(pa.row - pb.row));
    if (gap > worst) worst = gap;
  }
  return worst < 0 ? null : worst;
};

const copySamples = (
  dst: Projected[],
  dstValid: boolean[],
  src: Projected[],
  srcValid: boolean[],
): void => {
  for (let i = 0; i < U_SAMPLES; i += 1) {
    dstValid[i] = srcValid[i]!;
    if (!srcValid[i]) continue;
    const d = dst[i]!;
    const s = src[i]!;
    d.col = s.col;
    d.row = s.row;
    d.depth = s.depth;
  }
};

/** Rascunho da posição da câmera em espaço local da caixa (ver `facesCamera`). */
const localCamera: Vec3 = vec3();

/**
 * A face está virada para a câmera.
 *
 * Não é só economia: as faces de trás caem à mesma profundidade das da frente
 * dentro da tolerância do z-buffer, e desenhá-las deixaria metade das células
 * decidida por ordem de desenho em vez de por distância.
 *
 * `true` também quando a câmera está *dentro* da caixa — nos três eixos ao
 * mesmo tempo, em espaço local. Sem isso, um jogador que chega perto o
 * bastante para entrar na pegada da base (o chão não tem colisão) faz esse
 * teste falhar nas seis faces de uma vez: cada face sozinha está "atrás" da
 * câmera, então nenhuma desenha, e sobra só o wireframe das arestas — o
 * mesmo sintoma de ver através do objeto que a hachura corrigiu, só que
 * agora por culling em vez de densidade. Cá dentro não há como saber qual
 * face você veria de fora, então a resposta seguinta é desenhar todas: pior
 * a sombra errada numa face de esguelha do que nenhuma face.
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
  shape.toLocalPoint(cameraX, cameraY, cameraZ, localCamera);
  if (
    Math.abs(localCamera.x) <= half.x &&
    Math.abs(localCamera.y) <= half.y &&
    Math.abs(localCamera.z) <= half.z
  ) {
    return true;
  }

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
 * Preenche uma face com linhas paralelas, subdividindo até que o vão entre
 * duas faixas vizinhas — medido em vários pontos ao longo delas, na tela —
 * não passe de uma célula.
 *
 * A versão anterior tentava prever essa densidade com uma fórmula fechada:
 * contava as faixas pelo comprimento em células de uma única aresta
 * transversal e distribuía o resto por interpolação em `1/w`, a mesma regra
 * que profundidade e posição de mundo seguem em espaço de tela. Isso supõe
 * que a posição na tela varia proporcionalmente a `1/w`, o que só é exato
 * quando a outra coordenada de tela não muda com `v` — falha numa face
 * inclinada nos dois eixos ao mesmo tempo. Uma versão seguinte trocou a
 * fórmula por medida direta, mas só nas duas bordas (`u = ±halfU`): o vão
 * entre duas faixas, como função de `u`, pode ter um bojo no meio que as
 * bordas sozinhas não veem (ver `U_SAMPLES`) — o mesmo ângulo composto, buraco
 * bem no centro da face em vez de na borda.
 *
 * A subdivisão adaptativa não supõe nada sobre a forma da curva: mede a
 * distância de verdade em várias amostras ao longo da faixa e só aceita o
 * passo quando todas cabem numa célula, subdividindo ao meio quando alguma
 * não cabe. Custa mais projeções por face, mas cada uma é barata, e a maioria
 * das faces — de frente, ou moderadamente inclinadas — fecha em um ou dois
 * passos.
 */
export const hatchFace = (
  shape: BoxShape,
  context: RenderContext,
  half: Vec3,
  axis: number,
  sign: number,
  pen: SurfacePen,
): void => {
  const { rasterizer, viewport } = context;
  const { colCount, rowCount } = viewport;

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

  const span = halfV * 2;
  const minStep = span / MAX_SUBDIVISIONS;

  let v = -halfV;
  stripe(v);
  let curValidCount = projectSamples(
    shape,
    rasterizer,
    colCount,
    rowCount,
    axis,
    depth,
    uAxis,
    halfU,
    vAxis,
    v,
    curSamples,
    curValid,
  );

  // Salto adaptativo: dobra o passo a cada acerto, reduz à metade a cada
  // recusa. Começa tentando a face inteira de uma vez — é o caminho comum, e
  // fecha em um só passo quando a face está de frente ou moderadamente longe.
  let step = span;

  for (let guard = 0; guard < MAX_SUBDIVISIONS && v < halfV - 1e-9; guard += 1) {
    const candidate = Math.min(v + step, halfV);
    const validCount = projectSamples(
      shape,
      rasterizer,
      colCount,
      rowCount,
      axis,
      depth,
      uAxis,
      halfU,
      vAxis,
      candidate,
      nextSamples,
      nextValid,
    );

    // `null` quando nenhuma amostra dos dois lados coincide (ver
    // `maxChebyshev`): sem distância confiável, trata como vão infinito, o
    // que força subdivisão até o passo mínimo — a resposta certa para uma
    // face colada no near plane. Mas só quando pelo menos um dos dois lados
    // tem alguma amostra válida: se os dois lados são totalmente inválidos —
    // a ponta inteira atrás da câmera, não só perto do near plane —, não há
    // nada visível entre eles para medir, e forçar o passo mínimo aqui é o
    // que fazia a face desperdiçar o orçamento inteiro atravessando, de
    // milímetro em milímetro, a metade da altura que ficou para trás quando a
    // câmera sobe acima do meio do objeto: a metade visível, lá na frente,
    // nunca chegava a receber uma única faixa.
    const bothInvisible = curValidCount === 0 && validCount === 0;
    const gap = bothInvisible ? 0 : (maxChebyshev(curSamples, curValid, nextSamples, nextValid) ?? Infinity);

    if (gap <= SPACING_CELLS || candidate - v <= minStep) {
      stripe(candidate);
      v = candidate;
      curValidCount = validCount;
      if (validCount > 0) {
        copySamples(curSamples, curValid, nextSamples, nextValid);
      } else {
        curValid.fill(false);
      }
      step *= 2;
    } else {
      step *= 0.5;
    }
  }

  if (v < halfV) stripe(halfV);

  pen.area = false;
};
