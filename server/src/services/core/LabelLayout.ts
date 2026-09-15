/**
 * ============================================================================
 * O LAYOUT EXPLÍCITO DA ETIQUETA — cada elemento numa caixa, em PONTOS
 * ============================================================================
 *
 * ## Por que existe, se a folha HTML já existe
 *
 * DEFEITO QUE ISTO CORRIGE: a folha (`LabelSheet.ts`) é HTML com flexbox —
 * quem decide onde cada coisa cai é o navegador, na hora de imprimir. Serve ao
 * diálogo do sistema, mas não à impressora térmica que fala ZPL, EPL ou TSPL:
 * ela recebe coordenadas em pontos, e não há navegador no meio. Sem um modelo
 * de posição, cada gerador de comando reinventaria o desenho — e a prévia
 * mostraria uma etiqueta enquanto a impressora imprimiria outra.
 *
 * Aqui a etiqueta vira uma LISTA DE CAIXAS (texto, barras, traço) com x, y,
 * largura e altura em pontos da impressora do modelo, já com:
 *
 *   - o módulo das barras em número INTEIRO de pontos, com as zonas de
 *     silêncio dentro da caixa (o leitor precisa delas para achar o começo);
 *   - o texto quebrado em linhas e, quando não cabe, com reticências — nunca
 *     letra cortada ao meio;
 *   - o preço no maior corpo que cabe na largura e, com destaque, o MAIOR
 *     texto da etiqueta;
 *   - nenhuma caixa sobre a outra: o que não cabe SAI da etiqueta e vira aviso
 *     com o nome do campo.
 *
 * Os geradores (`LabelCommands.ts`: ZPL, EPL, TSPL, PDF, HTML exato e a prévia
 * em SVG) só TRADUZEM estas caixas. É isso que dá à prévia a mesma geometria
 * do que imprime.
 *
 * ## A régua é a mesma da folha HTML
 *
 * O corpo de cada texto sai de `escalaTipografica` — a MESMA função que a
 * folha HTML usa (ela foi movida para cá). Duas réguas para a mesma etiqueta
 * seriam duas etiquetas diferentes conforme a impressora.
 *
 * Módulo puro: nada de banco, nada de HTTP.
 */
import { ApiError } from '../../utils/errors.js';
import type { LabelItem } from './BarcodeService.js';
import { desenhoDoCodigo, type Simbologia } from './Ean13.js';
import {
  MODULO_GS1_MM,
  MODULO_MINIMO_MM,
  paginaMm,
  porPagina,
  recuoDaFolhaMm,
  type LabelFormat,
} from './LabelFormats.js';

// ------------------------------------------------------------------ unidades

export const MM_POR_POLEGADA = 25.4;
/** O "px" do CSS é físico: 1/96 de polegada. A escala tipográfica fala nele. */
const PX_CSS_POR_POLEGADA = 96;

export function pontosDoMm(mm: number, dpi: number): number {
  return (mm * dpi) / MM_POR_POLEGADA;
}
/** Milímetro para pontos INTEIROS: a impressora não marca meio ponto. */
export function pontosInteiros(mm: number, dpi: number): number {
  return Math.round(pontosDoMm(mm, dpi));
}
export function mmDosPontos(pontos: number, dpi: number): number {
  return (pontos * MM_POR_POLEGADA) / dpi;
}
export function pontosDoPx(px: number, dpi: number): number {
  return (px * dpi) / PX_CSS_POR_POLEGADA;
}

/**
 * A resolução com que a etiqueta é desenhada: a do MODELO; nos formatos
 * prontos, o palpite pela mídia (203 no rolo, 300 na folha) — o mesmo da
 * folha HTML (`dpiDaImpressora` em LabelSheet.ts).
 */
export function dpiDoFormato(f: Pick<LabelFormat, 'dpi' | 'midia'>): number {
  return f.dpi ?? (f.midia === 'rolo' ? 203 : 300);
}

// ------------------------------------------------------- escala tipográfica

export interface EscalaTipografica {
  /** Corpos em px do CSS (1/96 pol). */
  nome: number;
  attr: number;
  preco: number;
  ean: number;
  rodape: number;
  /** Altura das barras, em milímetro. */
  barrasMm: number;
}

/**
 * A escala tipográfica sai da ALTURA do conteúdo — e da escala que o modelo
 * pediu (50–200 %).
 *
 * Uma etiqueta de 22 mm e uma de 50 mm não podem usar o mesmo corpo de letra:
 * na pequena o texto vaza, na grande sobra papel em branco. Ancorar no papel
 * — e não em constantes por formato — faz um formato novo nascer legível sem
 * ninguém calibrar fonte à mão. Em paisagem o conteúdo gira 90°, e a "altura"
 * que manda no texto é a LARGURA do adesivo.
 *
 * Esta é a régua da folha HTML também (LabelSheet importa daqui).
 */
export function escalaTipografica(
  f: Pick<LabelFormat, 'widthMm' | 'heightMm' | 'orientation' | 'scalePercent' | 'priceHighlight'>,
): EscalaTipografica {
  const h = f.orientation === 'paisagem' ? f.widthMm : f.heightMm;
  const k = (f.scalePercent ?? 100) / 100;
  const destaque = f.priceHighlight !== false;
  return {
    nome: Math.max(6, Math.min(13, h * 0.28)) * k,
    attr: Math.max(5, Math.min(9, h * 0.2)) * k,
    // O preço é o que o cliente lê de longe: cresce mais rápido que o resto —
    // a não ser que o modelo peça o preço discreto.
    preco: (destaque ? Math.max(9, Math.min(30, h * 0.46)) : Math.max(7, Math.min(12, h * 0.26))) * k,
    ean: Math.max(5.5, Math.min(9, h * 0.2)) * k,
    rodape: Math.max(4.5, Math.min(7, h * 0.15)) * k,
    barrasMm: Math.max(4, h * 0.26),
  };
}

/** Abaixo disto o preço não é legível: a etiqueta é recusada em vez de sair (o mesmo piso da folha HTML). */
export const PRECO_MINIMO_PX = 7;

// ---------------------------------------------------------- métrica da letra

/**
 * Avanço dos caracteres ASCII 32–126, em milésimos do corpo — a tabela de
 * métricas (AFM) da Helvetica e da Helvetica-Bold, que são as fontes do PDF e
 * as substitutas da Arial na tela.
 */
const HELVETICA = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const HELVETICA_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];
/** Fora do ASCII: os que a etiqueta usa de verdade. */
const EXTRAS: Record<string, [number, number]> = {
  '…': [1000, 1000], '·': [278, 278], '–': [556, 556], '—': [1000, 1000],
  'º': [365, 365], 'ª': [370, 370], '°': [400, 400], '€': [556, 556], '×': [584, 584],
};

function avanco(c: string, negrito: boolean): number {
  const cp = c.codePointAt(0) ?? 0;
  const tabela = negrito ? HELVETICA_BOLD : HELVETICA;
  if (cp >= 32 && cp <= 126) return tabela[cp - 32];
  if (cp === 0xa0) return 278;
  const extra = EXTRAS[c];
  if (extra) return negrito ? extra[1] : extra[0];
  // Letra acentuada: o avanço da letra de base (á = a, Ç = C). O "i" com
  // acento é mais largo que o "i" sem (278 contra 222 na Helvetica).
  const base = c.normalize('NFD')[0] ?? c;
  const cpBase = base.codePointAt(0) ?? 0;
  if (base !== c && cpBase >= 32 && cpBase <= 126) return base === 'i' ? 278 : tabela[cpBase - 32];
  // Desconhecido conta como letra larga: errar para MAIS nunca vaza da caixa.
  return 667;
}

/** Largura de um texto em "em" (fração do corpo). */
export function larguraEmEm(texto: string, negrito: boolean): number {
  let total = 0;
  for (const c of texto) total += avanco(c, negrito);
  return total / 1000;
}

/**
 * Como a letra de uma saída se mede. A folha HTML e o PDF desenham em
 * Helvetica/Arial; a térmica desenha com a letra DELA — e é por isso que a
 * medida vem do perfil de impressão, e não daqui.
 */
export interface MetricaDaFonte {
  nome: string;
  /** O corpo que a saída consegue fazer, o mais próximo do pedido (pontos). */
  corpo(pedido: number): number;
  /** Largura do texto, em pontos, naquele corpo. */
  largura(texto: string, corpo: number, negrito: boolean): number;
}

/** Helvetica/Arial: o PDF e o HTML exato — medida exata. */
export const METRICA_HELVETICA: MetricaDaFonte = {
  nome: 'helvetica',
  corpo: (pedido) => Math.max(1, Math.floor(pedido)),
  largura: (texto, corpo, negrito) => larguraEmEm(texto, negrito) * corpo,
};

/**
 * A fonte escalável RESIDENTE da térmica (a "0" do ZPL e do TSPL, uma
 * condensada). A tabela dela não é pública por modelo; a Helvetica é mais
 * LARGA que uma condensada, e o fator de segurança cobre a diferença entre
 * firmwares. Errar para mais só encurta o texto antes da hora — nunca vaza.
 * O fator exato é item de homologação física (`HOMOLOGACAO_FISICA`).
 */
export function metricaResidente(fator = 1.1): MetricaDaFonte {
  return {
    nome: `residente×${fator}`,
    corpo: (pedido) => Math.max(1, Math.floor(pedido)),
    largura: (texto, corpo, negrito) => larguraEmEm(texto, negrito) * corpo * fator,
  };
}

// -------------------------------------------------------------- os elementos

export type CampoDoLayout =
  | 'nome' | 'descricao' | 'info' | 'atributos' | 'preco' | 'precoDe' | 'complemento'
  | 'validadeLote' | 'barras' | 'avisoDasBarras' | 'ean' | 'codigo' | 'empresa' | 'moldura' | 'risco';

/** Caixa no espaço do CONTEÚDO (antes do giro da paisagem), em pontos. */
interface Caixa {
  x: number;
  y: number;
  largura: number;
  altura: number;
}

export interface TextoNoLayout extends Caixa {
  tipo: 'texto';
  campo: CampoDoLayout;
  /** As linhas, já quebradas e com reticências quando não coube. */
  linhas: string[];
  /** A largura medida de cada linha (pontos), para alinhar sem remedir. */
  larguras: number[];
  /** Corpo da letra em pontos. */
  corpo: number;
  /** Distância entre o topo de uma linha e o da seguinte, em pontos. */
  entrelinha: number;
  negrito: boolean;
  alinhamento: 'esquerda' | 'centro' | 'direita';
  /** O texto não coube inteiro e ganhou reticências. */
  cortado: boolean;
}

export interface BarrasNoLayout extends Caixa {
  tipo: 'barras';
  campo: 'barras';
  /** Largura de UM módulo, em pontos inteiros. */
  modulo: number;
  simbologia: Simbologia;
  /** O código como está no cadastro. */
  dados: string;
  /** 1 = barra, 0 = espaço — sem as zonas de silêncio. */
  bits: string;
  /** Módulos de zona de silêncio à esquerda e à direita (dentro da caixa). */
  silencioEsquerda: number;
  silencioDireita: number;
}

export interface TracoNoLayout extends Caixa {
  tipo: 'caixa';
  campo: 'moldura' | 'risco';
  /** Espessura da linha, em pontos. `risco` é cheio (a caixa inteira pintada). */
  espessura: number;
}

export type ElementoDoLayout = TextoNoLayout | BarrasNoLayout | TracoNoLayout;

export interface EtiquetaNoLayout {
  dpi: number;
  /** O ADESIVO, em pontos (espaço da etiqueta, depois do giro). */
  larguraPontos: number;
  alturaPontos: number;
  /** 90 = paisagem: o conteúdo gira 90° no sentido horário, lido de cima para baixo. */
  rotacao: 0 | 90;
  /** O espaço do conteúdo: igual ao adesivo em retrato, trocado em paisagem. */
  larguraDoConteudo: number;
  alturaDoConteudo: number;
  /** A área onde os elementos podem estar (as margens internas de fora). */
  areaUtil: Caixa;
  elementos: ElementoDoLayout[];
  /** Campos marcados que NÃO couberam e saíram desta etiqueta. */
  omitidos: string[];
  avisos: string[];
}

/**
 * A caixa de um elemento no espaço da ETIQUETA (x à direita, y para baixo),
 * depois do giro. A mesma transformação da folha HTML
 * (`translateX(largura) rotate(90deg)`): o ponto (cx, cy) do conteúdo vai para
 * (L − cy, cx) — o topo do conteúdo fica na borda DIREITA do adesivo.
 */
export function caixaNaEtiqueta(etq: Pick<EtiquetaNoLayout, 'rotacao' | 'larguraPontos'>, c: Caixa): Caixa {
  if (etq.rotacao === 0) return { x: c.x, y: c.y, largura: c.largura, altura: c.altura };
  return { x: etq.larguraPontos - c.y - c.altura, y: c.x, largura: c.altura, altura: c.largura };
}

/** A caixa de CADA LINHA de um texto (espaço do conteúdo), com o corpo centrado na entrelinha. */
export function caixasDasLinhas(t: TextoNoLayout): Caixa[] {
  const folga = Math.floor((t.entrelinha - t.corpo) / 2);
  return t.linhas.map((_, i) => ({ x: t.x, y: t.y + i * t.entrelinha + folga, largura: t.largura, altura: t.corpo }));
}

/** Onde a linha começa, dada a largura medida e o alinhamento (espaço do conteúdo). */
export function xDaLinha(t: TextoNoLayout, i: number): number {
  const w = t.larguras[i] ?? 0;
  if (t.alinhamento === 'direita') return t.x + t.largura - w;
  if (t.alinhamento === 'centro') return t.x + (t.largura - w) / 2;
  return t.x;
}

// --------------------------------------------------------------- o texto

/** Reais como o cliente lê — com espaço comum (a térmica não conhece o espaço rígido). */
export function precoEmReais(cents: number): string {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }).replace(new RegExp(String.fromCharCode(0xa0), 'g'), ' ');
}

/** "AAAA-MM-DD" → "DD/MM/AAAA"; vazio para o que não for data de calendário. */
export function dataNaEtiqueta(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? '').trim());
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}

/**
 * Quebra o texto em linhas que cabem na largura. Palavra maior que a linha
 * quebra por caractere (não sai pela borda). Passou do número de linhas: a
 * última ganha reticências — nunca uma linha cortada ao meio.
 */
export function quebrarEmLinhas(
  texto: string,
  largura: number,
  maxLinhas: number,
  medir: (t: string) => number,
  reticencias: string,
): { linhas: string[]; cortado: boolean } {
  const palavras = String(texto ?? '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const linhas: string[] = [];
  let atual = '';
  for (const p of palavras) {
    const tentativa = atual ? `${atual} ${p}` : p;
    if (medir(tentativa) <= largura) {
      atual = tentativa;
      continue;
    }
    if (atual) linhas.push(atual);
    if (medir(p) <= largura) {
      atual = p;
      continue;
    }
    let pedaco = '';
    for (const c of p) {
      if (!pedaco || medir(pedaco + c) <= largura) pedaco += c;
      else {
        linhas.push(pedaco);
        pedaco = c;
      }
    }
    atual = pedaco;
  }
  if (atual) linhas.push(atual);
  const limite = Math.max(1, maxLinhas);
  if (linhas.length <= limite) return { linhas, cortado: false };
  const mantidas = linhas.slice(0, limite);
  mantidas[limite - 1] = comReticencias(`${mantidas[limite - 1]} ${linhas[limite]}`, largura, medir, reticencias);
  return { linhas: mantidas, cortado: true };
}

/** Encurta a linha até caber com as reticências. */
export function comReticencias(linha: string, largura: number, medir: (t: string) => number, reticencias: string): string {
  let base = [...linha];
  while (base.length > 0 && medir(`${base.join('').trimEnd()}${reticencias}`) > largura) base = base.slice(0, -1);
  return `${base.join('').trimEnd()}${reticencias}`;
}

// --------------------------------------------------------------- o layout

export interface OpcoesDoLayout {
  /** O nome da loja, para o rodapé. */
  empresa: string;
  metrica?: MetricaDaFonte;
  /** "…" onde a letra existe (HTML, PDF); "..." na térmica, cuja tabela pode não ter o caractere. */
  reticencias?: string;
  /** Teto do módulo em pontos: ZPL, EPL e TSPL aceitam de 1 a 10. */
  moduloMaximo?: number;
  /** A etiqueta de TESTE: moldura na borda do adesivo, para conferir o alinhamento no papel. */
  moldura?: boolean;
}

interface Bloco {
  campo: string;
  altura: number;
  montar: (y: number) => ElementoDoLayout[];
  /** Só o nome encolhe (menos linhas) antes de algum campo sair. */
  encolher?: () => boolean;
}

/**
 * A etiqueta de UM item, em caixas.
 *
 * Em cima, de cima para baixo: nome, descrição, marca/unidade/SKU, grade,
 * preço, texto próprio, validade/lote — a ordem da folha HTML. Embaixo,
 * encostados na borda: código de barras, número e rodapé.
 *
 * Quando não cabe, na ordem: o nome perde linhas (até uma); saem descrição,
 * texto próprio, marca/unidade/SKU, validade/lote, grade, rodapé e o número
 * do código. Preço e barras não saem: se nem eles cabem, a etiqueta é recusada
 * dizendo o que fazer (`CORE_LABEL_LAYOUT_DOES_NOT_FIT`).
 */
export function layoutDaEtiqueta(f: LabelFormat, item: LabelItem, opcoes: OpcoesDoLayout): EtiquetaNoLayout {
  const metrica = opcoes.metrica ?? METRICA_HELVETICA;
  const reticencias = opcoes.reticencias ?? '…';
  const moduloMaximo = Math.max(1, Math.floor(opcoes.moduloMaximo ?? 10));
  const dpi = dpiDoFormato(f);
  const paisagem = f.orientation === 'paisagem';
  const Wl = pontosInteiros(f.widthMm, dpi);
  const Hl = pontosInteiros(f.heightMm, dpi);
  const Wc = paisagem ? Hl : Wl;
  const Hc = paisagem ? Wl : Hl;
  const s = escalaTipografica(f);
  const mostra = (c: string) => (f.campos as readonly string[]).includes(c);
  const medir = (texto: string, corpo: number, negrito: boolean) => metrica.largura(texto, corpo, negrito);
  const corpoDoPx = (px: number) => metrica.corpo(pontosDoPx(px, dpi));
  const avisos: string[] = [];
  const omitidos: string[] = [];

  // A moldura da etiqueta de teste fica meia milímetro para dentro da borda;
  // o conteúdo começa depois dela.
  const inset = opcoes.moldura ? Math.max(1, pontosInteiros(0.5, dpi)) : 0;
  const espessuraDaMoldura = Math.max(1, pontosInteiros(0.25, dpi));
  const margemDaMoldura = opcoes.moldura ? inset + espessuraDaMoldura + 1 : 0;

  // As margens internas da folha HTML: 0,6 mm; no rolo de um MODELO em
  // retrato, a margem de cima do modelo é respiro dentro do adesivo.
  const respiroTopoMm = f.paperWidthMm && f.midia === 'rolo' && !paisagem ? Math.max(0.6, f.marginTopMm) : 0.6;
  const pad = Math.max(1, pontosInteiros(0.6, dpi), margemDaMoldura);
  const x0 = pad;
  const larguraUtil = Wc - 2 * pad;
  const y0 = Math.max(1, pontosInteiros(respiroTopoMm, dpi), margemDaMoldura);
  const y1 = Hc - pad;
  const vao = Math.max(1, pontosInteiros(0.3, dpi));
  if (larguraUtil <= 0 || y1 <= y0) {
    throw new ApiError(
      'CORE_LABEL_LAYOUT_DOES_NOT_FIT',
      `A etiqueta de ${f.widthMm} × ${f.heightMm} mm não tem área útil depois das margens. Aumente a etiqueta ou diminua a margem superior.`,
      400,
    );
  }

  // --- texto de corpo livre
  const blocoDeTexto = (
    campo: CampoDoLayout,
    texto: string,
    corpoPx: number,
    opcoesDoTexto: { negrito?: boolean; maxLinhas?: number; alinhamento?: TextoNoLayout['alinhamento'] } = {},
  ): Bloco | null => {
    const limpo = String(texto ?? '').replace(new RegExp(String.fromCharCode(0xa0), 'g'), ' ').trim();
    if (!limpo) return null;
    const negrito = opcoesDoTexto.negrito ?? false;
    const corpo = corpoDoPx(corpoPx);
    const entrelinha = Math.ceil(corpo * 1.12);
    let maxLinhas = Math.max(1, opcoesDoTexto.maxLinhas ?? 1);
    let q = quebrarEmLinhas(limpo, larguraUtil, maxLinhas, (t) => medir(t, corpo, negrito), reticencias);
    const bloco: Bloco = {
      campo,
      altura: q.linhas.length * entrelinha,
      montar: (y) => [{
        tipo: 'texto', campo, x: x0, y, largura: larguraUtil, altura: q.linhas.length * entrelinha,
        linhas: q.linhas, larguras: q.linhas.map((l) => medir(l, corpo, negrito)), corpo, entrelinha, negrito,
        alinhamento: opcoesDoTexto.alinhamento ?? 'esquerda', cortado: q.cortado,
      }],
      encolher: () => {
        if (q.linhas.length <= 1) return false;
        maxLinhas = q.linhas.length - 1;
        q = quebrarEmLinhas(limpo, larguraUtil, maxLinhas, (t) => medir(t, corpo, negrito), reticencias);
        bloco.altura = q.linhas.length * entrelinha;
        return true;
      },
    };
    return bloco;
  };

  // Quantas linhas inteiras cabem numa fração da altura (a mesma conta da folha HTML).
  const linhasEm = (fracao: number, corpoPx: number) => {
    const corpo = corpoDoPx(corpoPx);
    return Math.max(1, Math.floor((Hc * fracao) / Math.ceil(corpo * 1.12) + 1e-6));
  };

  // ------------------------------------------------------------- o preço
  const blocoDoPreco = (): Bloco | null => {
    if (!mostra('preco')) return null;
    const texto = precoEmReais(item.priceCents);
    const minimo = pontosDoPx(PRECO_MINIMO_PX, dpi);
    const maiorQueCabe = (t: string, tetoPx: number, larguraMax: number, negrito: boolean) => {
      let c = corpoDoPx(tetoPx);
      for (let i = 0; i < 400 && c > 1 && medir(t, c, negrito) > larguraMax; i += 1) {
        const menor = metrica.corpo(c - 1);
        if (menor >= c) break;
        c = menor;
      }
      return c;
    };
    const exigir = (c: number) => {
      if (c < minimo || medir(texto, c, true) > larguraUtil) {
        throw new ApiError(
          'CORE_LABEL_PRICE_DOES_NOT_FIT',
          `O preço de "${item.name}" (${texto}) não cabe na largura desta etiqueta `
            + `(${mmDosPontos(larguraUtil, dpi).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mm úteis${paisagem ? ' — em paisagem, a altura do adesivo' : ''}) `
            + 'nem com a letra no tamanho mínimo, e sairia cortado. Use uma etiqueta mais larga ou a orientação retrato.',
          400,
          { productId: item.productId, preco: texto },
        );
      }
    };
    const sozinho = maiorQueCabe(texto, s.preco, larguraUtil, true);
    const texto1 = (campo: CampoDoLayout, t: string, corpo: number, negrito: boolean, x: number, y: number, largura: number): TextoNoLayout => ({
      tipo: 'texto', campo, x, y, largura, altura: Math.ceil(corpo * 1.05), linhas: [t], larguras: [medir(t, corpo, negrito)],
      corpo, entrelinha: Math.ceil(corpo * 1.05), negrito, alinhamento: 'direita', cortado: false,
    });
    const risco = (de: TextoNoLayout): TracoNoLayout => {
      const w = de.larguras[0];
      const esp = Math.max(1, Math.round(de.corpo * 0.08));
      return { tipo: 'caixa', campo: 'risco', x: de.x + de.largura - w, y: de.y + Math.round(de.altura * 0.55), largura: Math.ceil(w), altura: esp, espessura: esp };
    };

    if (item.onSale && item.listPriceCents > item.priceCents) {
      // "De / por" só com promoção de verdade: um preço riscado ao lado do
      // outro sem promoção é a receita para o cliente ler o errado.
      const textoDe = precoEmReais(item.listPriceCents);
      const corpoDe = maiorQueCabe(textoDe, s.attr, larguraUtil, false);
      const larguraDe = Math.ceil(medir(textoDe, corpoDe, false));
      const vaoDoDe = pontosInteiros(1.5, dpi);
      const aoLado = maiorQueCabe(texto, s.preco, larguraUtil - larguraDe - vaoDoDe, true);
      if (aoLado >= minimo && aoLado >= sozinho * 0.85 && medir(texto, aoLado, true) + larguraDe + vaoDoDe <= larguraUtil) {
        const alturaDaLinha = Math.ceil(aoLado * 1.05);
        return {
          campo: 'preco',
          altura: alturaDaLinha,
          montar: (y) => {
            const preco = texto1('preco', texto, aoLado, true, x0, y, larguraUtil);
            const larguraPreco = Math.ceil(preco.larguras[0]);
            // O "de" encosta embaixo, à esquerda do preço.
            const alturaDe = Math.ceil(corpoDe * 1.05);
            const de = texto1('precoDe', textoDe, corpoDe, false, x0, y + alturaDaLinha - alturaDe, larguraUtil - larguraPreco - vaoDoDe);
            return [de, risco(de), preco];
          },
        };
      }
      exigir(sozinho);
      const alturaDe = Math.ceil(corpoDe * 1.05);
      const alturaPreco = Math.ceil(sozinho * 1.05);
      return {
        campo: 'preco',
        altura: alturaDe + alturaPreco,
        montar: (y) => {
          const de = texto1('precoDe', textoDe, corpoDe, false, x0, y, larguraUtil);
          return [de, risco(de), texto1('preco', texto, sozinho, true, x0, y + alturaDe, larguraUtil)];
        },
      };
    }
    exigir(sozinho);
    return {
      campo: 'preco',
      altura: Math.ceil(sozinho * 1.05),
      montar: (y) => [texto1('preco', texto, sozinho, true, x0, y, larguraUtil)],
    };
  };

  // --------------------------------------------------- o código de barras
  const blocoDasBarras = (): Bloco | null => {
    if (!mostra('barras')) return null;
    const aviso = (t: string) => blocoDeTexto('avisoDasBarras', t, s.ean, { alinhamento: 'centro', maxLinhas: 2 });
    if (!item.barcode) {
      if (item.codigoPendente === 'ao_imprimir') return aviso('O CÓDIGO DE BARRAS É GERADO AO IMPRIMIR');
      if (item.codigoPendente === 'sem_permissao') return aviso('SEM CÓDIGO DE BARRAS — gere no cadastro do produto');
      return aviso('SEM CÓDIGO DE BARRAS');
    }
    const d = desenhoDoCodigo(item.barcode);
    if (!d.ok) {
      avisos.push(`"${item.name}": o código ${item.barcode} tem ${d.motivo} — o leitor o recusaria. Corrija no cadastro do produto.`);
      return aviso(`CÓDIGO INVÁLIDO: ${item.barcode}`);
    }
    /*
      O MÓDULO EM PONTOS INTEIROS. A impressora só marca pontos inteiros: um
      módulo de 2,75 pontos sai com barras de 2 e de 3, e o leitor mede barras
      desiguais. Aqui o módulo é o maior número inteiro de pontos em que o
      código INTEIRO — com as zonas de silêncio — cabe na largura útil.
    */
    const pontoMm = MM_POR_POLEGADA / dpi;
    const modulo = Math.min(moduloMaximo, Math.floor(larguraUtil / d.modulos));
    if (modulo < 1 || modulo * pontoMm < MODULO_MINIMO_MM - 1e-9) {
      const precisa = Math.ceil(Math.ceil(MODULO_MINIMO_MM / pontoMm) * pontoMm * d.modulos + 2 * mmDosPontos(pad, dpi));
      avisos.push(
        `"${item.name}": o código ${item.barcode} (${d.simbologia}) precisa de ${precisa} mm de largura para as barras serem lidas `
          + `nesta impressora de ${dpi} dpi. Use uma etiqueta mais larga ou um código mais curto.`,
      );
      return aviso('CÓDIGO LONGO DEMAIS PARA ESTA ETIQUETA');
    }
    if (modulo * pontoMm < MODULO_GS1_MM - 1e-9) {
      avisos.push(
        `Cada barra do código fica com ${(modulo * pontoMm).toLocaleString('pt-BR', { maximumFractionDigits: 3 })} mm `
          + `(${modulo} ponto(s) de ${dpi} dpi) — abaixo do mínimo GS1 (0,264 mm): leitores a laser podem falhar.`,
      );
    }
    const larguraDoSimbolo = d.modulos * modulo;
    const altura = Math.max(pontosInteiros(4, dpi), pontosInteiros(s.barrasMm, dpi));
    const x = x0 + Math.floor((larguraUtil - larguraDoSimbolo) / 2);
    return {
      campo: 'barras',
      altura,
      montar: (y) => [{
        tipo: 'barras', campo: 'barras', x, y, largura: larguraDoSimbolo, altura, modulo,
        simbologia: d.simbologia, dados: item.barcode, bits: d.bits,
        silencioEsquerda: d.silencioEsquerda, silencioDireita: d.silencioDireita,
      }],
    };
  };

  // ------------------------------------------------------------ o rodapé
  const blocoDoRodape = (): Bloco | null => {
    // O rodapé não passa por `blocoDeTexto`: o espaço rígido do nome da loja
    // (que o cadastro pode trazer) é trocado aqui, senão a térmica o imprime cru.
    const rigido = new RegExp(String.fromCharCode(0xa0), 'g');
    const codigo = mostra('codigo') ? String(item.internalCode ?? '').replace(rigido, ' ').trim() : '';
    const empresa = mostra('empresa') ? String(opcoes.empresa ?? '').replace(rigido, ' ').trim() : '';
    if (!codigo && !empresa) return null;
    const corpo = corpoDoPx(s.rodape);
    const entrelinha = Math.ceil(corpo * 1.12);
    const vaoDoMeio = pontosInteiros(1, dpi);
    return {
      campo: 'rodape',
      altura: entrelinha,
      montar: (y) => {
        const els: TextoNoLayout[] = [];
        let larguraDoCodigo = 0;
        if (codigo) {
          const teto = empresa ? Math.floor(larguraUtil * 0.55) : larguraUtil;
          const cabe = medir(codigo, corpo, false) <= teto ? codigo : comReticencias(codigo, teto, (t) => medir(t, corpo, false), reticencias);
          larguraDoCodigo = Math.ceil(medir(cabe, corpo, false));
          els.push({
            tipo: 'texto', campo: 'codigo', x: x0, y, largura: larguraDoCodigo, altura: entrelinha, linhas: [cabe],
            larguras: [medir(cabe, corpo, false)], corpo, entrelinha, negrito: false, alinhamento: 'esquerda', cortado: cabe !== codigo,
          });
        }
        if (empresa) {
          const inicio = codigo ? x0 + larguraDoCodigo + vaoDoMeio : x0;
          const largura = x0 + larguraUtil - inicio;
          if (largura > corpo) {
            const cabe = medir(empresa, corpo, false) <= largura ? empresa : comReticencias(empresa, largura, (t) => medir(t, corpo, false), reticencias);
            els.push({
              tipo: 'texto', campo: 'empresa', x: inicio, y, largura, altura: entrelinha, linhas: [cabe],
              larguras: [medir(cabe, corpo, false)], corpo, entrelinha, negrito: false, alinhamento: 'direita', cortado: cabe !== empresa,
            });
          }
        }
        return els;
      },
    };
  };

  // ------------------------------------------------------- os blocos
  const info = [
    mostra('marca') ? item.brand : '',
    mostra('unidade') ? item.unit : '',
    mostra('sku') && item.sku ? `SKU ${item.sku}` : '',
  ].filter((v) => String(v ?? '').trim() !== '').join(' · ');
  const validade = mostra('validade') ? dataNaEtiqueta(item.validade) : '';
  const lote = mostra('lote') ? String(item.lote ?? '').trim() : '';
  const linhaDoLote = [validade ? `Val. ${validade}` : '', lote ? `Lote ${lote}` : ''].filter(Boolean).join(' · ');

  const nome = mostra('nome') ? blocoDeTexto('nome', item.name, s.nome, { negrito: true, maxLinhas: linhasEm(0.26, s.nome) }) : null;
  const topo: (Bloco | null)[] = [
    nome,
    mostra('descricao') ? blocoDeTexto('descricao', item.shortDescription, s.attr, { maxLinhas: linhasEm(0.14, s.attr) }) : null,
    blocoDeTexto('info', info, s.attr),
    mostra('atributos') ? blocoDeTexto('atributos', item.attributes, s.attr, { maxLinhas: linhasEm(0.14, s.attr) }) : null,
    blocoDoPreco(),
    mostra('complemento') ? blocoDeTexto('complemento', f.complementText ?? '', s.attr) : null,
    blocoDeTexto('validadeLote', linhaDoLote, s.attr),
  ];
  const base: (Bloco | null)[] = [
    blocoDasBarras(),
    mostra('ean') && item.barcode ? blocoDeTexto('ean', item.barcode, s.ean, { alinhamento: 'centro' }) : null,
    blocoDoRodape(),
  ];
  let blocosDeCima = topo.filter((b): b is Bloco => b !== null);
  let blocosDeBaixo = base.filter((b): b is Bloco => b !== null);

  const alturaPedida = () => {
    const todos = [...blocosDeCima, ...blocosDeBaixo];
    return todos.reduce((t, b) => t + b.altura, 0) + Math.max(0, todos.length - 1) * vao;
  };
  const disponivel = y1 - y0;
  const ORDEM_DE_SAIDA = ['descricao', 'complemento', 'info', 'validadeLote', 'atributos', 'rodape', 'ean'];
  const ROTULO: Record<string, string> = {
    descricao: 'descrição', complemento: 'texto próprio', info: 'marca/unidade/SKU', validadeLote: 'validade/lote',
    atributos: 'grade', rodape: 'rodapé (código interno e loja)', ean: 'número do código de barras',
  };
  while (alturaPedida() > disponivel) {
    if (nome && blocosDeCima.includes(nome) && nome.encolher?.()) continue;
    const sai = ORDEM_DE_SAIDA.find((c) => [...blocosDeCima, ...blocosDeBaixo].some((b) => b.campo === c));
    if (!sai) break;
    blocosDeCima = blocosDeCima.filter((b) => b.campo !== sai);
    blocosDeBaixo = blocosDeBaixo.filter((b) => b.campo !== sai);
    omitidos.push(ROTULO[sai] ?? sai);
  }
  // O nome é o último a sair: a etiqueta sem nome ainda vende (preço e barras).
  if (alturaPedida() > disponivel && nome && blocosDeCima.includes(nome)) {
    blocosDeCima = blocosDeCima.filter((b) => b !== nome);
    omitidos.push('nome');
  }
  if (alturaPedida() > disponivel) {
    throw new ApiError(
      'CORE_LABEL_LAYOUT_DOES_NOT_FIT',
      `Nesta etiqueta (${f.widthMm} × ${f.heightMm} mm${paisagem ? ', paisagem' : ''}) nem o preço e o código de barras cabem juntos `
        + `(pedem ${mmDosPontos(alturaPedida(), dpi).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mm e há `
        + `${mmDosPontos(disponivel, dpi).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mm). Aumente a etiqueta, diminua a escala do texto ou desmarque um dos dois.`,
      400,
    );
  }
  if (omitidos.length) {
    avisos.push(`Não couberam nesta etiqueta e ficaram de fora: ${omitidos.join(', ')}. Aumente a etiqueta ou diminua a escala do texto.`);
  }

  // ------------------------------------------------------- a montagem
  const elementos: ElementoDoLayout[] = [];
  let y = y0;
  for (const b of blocosDeCima) {
    elementos.push(...b.montar(y));
    y += b.altura + vao;
  }
  let yBaixo = y1;
  for (const b of [...blocosDeBaixo].reverse()) {
    yBaixo -= b.altura;
    elementos.push(...b.montar(yBaixo));
    yBaixo -= vao;
  }

  /*
    O PREÇO É O MAIOR TEXTO QUANDO HÁ DESTAQUE. O preço encolhe para caber na
    largura; o nome não — e numa etiqueta estreita o nome saía MAIOR que o
    preço que ele devia destacar. Aqui o nome acompanha o preço para baixo.
  */
  if (f.priceHighlight !== false) {
    const preco = elementos.find((e): e is TextoNoLayout => e.tipo === 'texto' && e.campo === 'preco');
    if (preco) {
      for (const e of elementos) {
        if (e.tipo !== 'texto' || e.campo === 'preco' || e.corpo < preco.corpo) continue;
        const novo = metrica.corpo(Math.max(1, preco.corpo - 1));
        // Fonte de tamanhos fixos (EPL) pode não ter um corpo menor: fica como está.
        if (novo >= e.corpo) continue;
        e.larguras = e.linhas.map((l) => medir(l, novo, e.negrito));
        e.corpo = novo;
      }
    }
  }

  if (opcoes.moldura) {
    elementos.push({ tipo: 'caixa', campo: 'moldura', x: inset, y: inset, largura: Wc - 2 * inset, altura: Hc - 2 * inset, espessura: espessuraDaMoldura });
  }

  return {
    dpi,
    larguraPontos: Wl,
    alturaPontos: Hl,
    rotacao: paisagem ? 90 : 0,
    larguraDoConteudo: Wc,
    alturaDoConteudo: Hc,
    areaUtil: { x: x0, y: y0, largura: larguraUtil, altura: y1 - y0 },
    elementos,
    omitidos,
    avisos,
  };
}

// ------------------------------------------------------------ a paginação

export interface CelulaDaPagina {
  /** Canto superior esquerdo da etiqueta na página, em pontos (já com a calibração). */
  x: number;
  y: number;
  /** Índice da etiqueta desenhada (na lista de etiquetas distintas), ou nulo: posição pulada. */
  etiqueta: number | null;
}

export interface PaginaDaImpressao {
  largura: number;
  altura: number;
  celulas: CelulaDaPagina[];
}

/**
 * As páginas do lote: onde cada etiqueta cai, em pontos.
 *
 * Numa FOLHA a página é o papel inteiro; num ROLO, a página é UMA linha de
 * etiquetas (um rolo de duas colunas imprime duas por página). `comecarEm`
 * pula as posições já usadas da primeira página — a folha adesiva pela metade
 * e a linha do rolo de duas colunas com a da esquerda já arrancada.
 *
 * Cada posição é arredondada a partir do MILÍMETRO, e não somando pontos
 * arredondados: somar arredondamento acumula erro, e na décima linha da folha
 * a etiqueta já cairia um ponto e meio fora do adesivo.
 *
 * A CALIBRAÇÃO (deslocamento X/Y do modelo) empurra todas as posições. O que
 * sairia para fora do papel encosta na borda e vira aviso.
 */
export function paginarEtiquetas(
  f: LabelFormat,
  quantidades: readonly number[],
  comecarEm = 1,
): { paginas: PaginaDaImpressao[]; avisos: string[] } {
  const dpi = dpiDoFormato(f);
  const pagina = paginaMm(f);
  const recuo = recuoDaFolhaMm(f);
  const cabem = porPagina(f);
  const linhas = f.rows ?? 1;
  const avisos: string[] = [];
  const pular = Math.max(0, Math.min(cabem - 1, Math.floor(Number(comecarEm) || 1) - 1));
  const Wp = pontosInteiros(pagina.largura, dpi);
  const Hp = pontosInteiros(pagina.altura, dpi);
  const Wl = pontosInteiros(f.widthMm, dpi);
  const Hl = pontosInteiros(f.heightMm, dpi);
  const offX = f.offsetXmm ?? 0;
  const offY = f.offsetYmm ?? 0;

  const posicoes: { x: number; y: number }[] = [];
  let encostou = false;
  /*
    UM PONTO DE FOLGA NA BORDA. A página e cada posição são arredondadas do
    milímetro separadamente: no rolo de 2 colunas (100 mm = 799,2 pontos → 799;
    segunda coluna em 52 mm = 415,6 → 416; etiqueta de 384) a soma dá 800 sem
    deslocamento nenhum. Sem a folga, o arredondamento virava "calibração para
    fora do papel" — aviso falso e a coluna puxada um ponto.
  */
  for (let r = 0; r < linhas; r += 1) {
    for (let c = 0; c < f.columns; c += 1) {
      let x = pontosInteiros(recuo.esquerda + c * (f.widthMm + f.gapXmm) + offX, dpi);
      let y = pontosInteiros(recuo.topo + r * (f.heightMm + f.gapYmm) + offY, dpi);
      if (x < 0) { x = 0; encostou = true; }
      if (y < 0) { y = 0; encostou = true; }
      if (x + Wl > Wp + 1) { x = Math.max(0, Wp - Wl); encostou = true; }
      if (y + Hl > Hp + 1) { y = Math.max(0, Hp - Hl); encostou = true; }
      posicoes.push({ x, y });
    }
  }
  if (encostou) {
    avisos.push(
      `O deslocamento de calibração (X ${offX} mm, Y ${offY} mm) levaria parte da etiqueta para fora do papel: `
        + 'ela saiu encostada na borda. Confira a calibração com a etiqueta de teste.',
    );
  }

  const sequencia: (number | null)[] = new Array<number | null>(pular).fill(null);
  quantidades.forEach((q, i) => {
    for (let k = 0; k < q; k += 1) sequencia.push(i);
  });
  const paginas: PaginaDaImpressao[] = [];
  for (let i = 0; i < sequencia.length; i += cabem) {
    paginas.push({
      largura: Wp,
      altura: Hp,
      celulas: sequencia.slice(i, i + cabem).map((etiqueta, k) => ({ ...posicoes[k], etiqueta })),
    });
  }
  return { paginas, avisos };
}
