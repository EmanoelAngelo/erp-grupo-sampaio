/**
 * A folha de etiquetas — HTML autocontido, medido em milímetro.
 *
 * ## O único desenho de etiqueta de produto
 *
 * Toda etiqueta de produto sai daqui: a folha da tela de etiquetas (formatos
 * prontos de `LabelFormats` e MODELOS da loja, `LabelTemplateService`), a
 * prévia de um modelo e a etiqueta avulsa da fila de impressão. Esta última
 * (`PrintRenderer.renderProductLabel`, job PRODUCT_LABEL) não tem desenho
 * próprio: monta o item com `buildLabels` — o preço VIGENTE, o mesmo que o
 * caixa cobra — e chama `renderLabelSheet` no formato `rolo_50x30`.
 *
 * Por isso uma mudança no desenho daqui vale também para a fila, e para a
 * SEGUNDA VIA dela: a etiqueta não reaproveita o payload congelado do job
 * original, é redesenhada com o cadastro e o preço de hoje
 * (`TIPOS_QUE_SEGUEM_O_CADASTRO` em PrintEngine.ts). É de propósito: a
 * etiqueta anuncia quanto o caixa cobra daqui em diante, não registra um fato
 * passado como o cupom. Fica fora de PrintRenderer.ts só por tamanho: é a
 * folha inteira — N etiquetas, paginação, escala de letra, simbologias.
 *
 * ## A repetição
 *
 * Uma linha com `quantity: 3` vira TRÊS etiquetas iguais no papel. A conta é
 * feita aqui, e não no cliente, porque é a paginação que decide onde a próxima
 * coluna começa — e paginação errada desperdiça folha adesiva, que custa.
 *
 * ## Imprimir etiqueta não é entrada de estoque
 *
 * Nada aqui toca saldo, razão ou movimento: a folha é desenho. Reimprimir
 * trinta etiquetas é trinta adesivos, não trinta peças.
 */
import { getConnection } from '../../db/sqlite.js';
import { ApiError } from '../../utils/errors.js';
import type { LabelItem } from './BarcodeService.js';
import { desenhoDoCodigo, svgDoDesenho } from './Ean13.js';
import {
  DPIS_DA_IMPRESSORA,
  MODULOS_DO_EAN13,
  MODULO_GS1_MM,
  MODULO_MINIMO_MM,
  RESPIRO_LATERAL_MM,
  paginaMm,
  porPagina,
  recuoDaFolhaMm,
  type LabelFormat,
} from './LabelFormats.js';
import { dataNaEtiqueta, escalaTipografica } from './LabelLayout.js';

/**
 * O nome que aparece no rodapé da etiqueta. Fantasia primeiro: é como a loja é conhecida.
 * Exportado: a etiqueta em ZPL/EPL/TSPL/PDF (LabelPrintService) põe o MESMO nome no rodapé.
 */
export function nomeDaEmpresa(companyId: string): string {
  const c = getConnection()
    .prepare('SELECT trade_name, legal_name FROM core_companies WHERE id = ?')
    .get(companyId) as { trade_name: string | null; legal_name: string } | undefined;
  return c?.trade_name || c?.legal_name || '';
}

function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function brl(cents: number): string {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

const mm = (n: number) => n.toLocaleString('pt-BR', { maximumFractionDigits: 2 });

/** CSS: 96 px por polegada, 25,4 mm por polegada. */
const PX_POR_MM = 96 / 25.4;

/** Em paisagem o conteúdo gira 90°: a "altura" que manda no texto é a largura do adesivo. */
function alturaDoConteudo(f: LabelFormat): number {
  return f.orientation === 'paisagem' ? f.widthMm : f.heightMm;
}
/** O lado onde correm o texto e as barras: em paisagem é a ALTURA do adesivo. */
function larguraDoConteudo(f: LabelFormat): number {
  return f.orientation === 'paisagem' ? f.heightMm : f.widthMm;
}

/**
 * A escala tipográfica sai da ALTURA da etiqueta — e da escala que o modelo
 * pediu (50–200 %).
 *
 * A conta mora em `escalaTipografica` (LabelLayout.ts), a régua do layout
 * explícito que a etiqueta em ZPL, EPL, TSPL e PDF usa. Ela morava aqui, e
 * duas cópias divergiriam no dia em que uma mudasse: a mesma etiqueta sairia
 * com um tamanho de letra no navegador e outro na térmica.
 *
 * O PREÇO é a exceção: o tamanho daqui é o TETO, e a largura manda de verdade
 * (ver `blocoDoPreco`).
 */
function escala(f: LabelFormat) {
  return escalaTipografica(f);
}

/**
 * Quantas linhas INTEIRAS de texto cabem na altura reservada.
 *
 * DEFEITO QUE ISTO CORRIGE: a altura máxima do nome era 26 % da etiqueta, que
 * não é múltiplo da altura da linha — a 100 % cabiam 3,13 linhas, a 130 %
 * 2,41, e a última linha saía cortada no meio, com as letras pela metade.
 */
function linhasQueCabem(alturaMm: number, linhaPx: number): number {
  return Math.max(1, Math.floor((alturaMm * PX_POR_MM) / linhaPx + 1e-6));
}

// --------------------------------------------------------------- o preço

/**
 * Avanço dos caracteres do preço em Arial Bold, em "em" (fração do corpo). É a
 * tabela de métricas da fonte — a mesma da Liberation Sans e da Helvetica, que
 * são as substitutas no Linux e no Mac.
 */
const AVANCO_ARIAL_BOLD: Record<string, number> = {
  '0': 0.556, '1': 0.556, '2': 0.556, '3': 0.556, '4': 0.556,
  '5': 0.556, '6': 0.556, '7': 0.556, '8': 0.556, '9': 0.556,
  ',': 0.278, '.': 0.278, ' ': 0.278, ' ': 0.278, ' ': 0.278,
  R: 0.722, $: 0.556, '-': 0.333,
};

/** Largura de um texto em "em" — o que não está na tabela conta como letra larga. */
export function larguraDoTextoEmEm(texto: string): number {
  let t = 0;
  for (const c of texto) t += AVANCO_ARIAL_BOLD[c] ?? 0.667;
  return t;
}

/** Folga para diferença de fonte e de arredondamento do navegador. */
const FOLGA_DA_FONTE = 0.92;
/** Abaixo disto o preço não é legível: a folha é recusada em vez de sair. */
export const PRECO_MINIMO_PX = 7;

/**
 * O preço, com o corpo que CABE na largura.
 *
 * DEFEITO QUE ISTO CORRIGE: o preço tinha um corpo só, calculado pela altura
 * (em paisagem, pelo lado LONGO), com `white-space: nowrap` dentro de uma
 * etiqueta com `overflow: hidden` — sem ajuste, sem aviso. Num 50 × 30 em
 * paisagem, "R$ 1.299,90" media 33 mm num espaço de 28,8: sem promoção sumiam
 * os CENTAVOS; com promoção (bloco alinhado à direita) sumia o INÍCIO, e o
 * adesivo dizia "299,90". Pelo CDC, a loja fica obrigada ao preço anunciado.
 * Agora o corpo é o menor entre o teto da escala e o que cabe na largura útil,
 * medida pela tabela de avanços da fonte. Na promoção, o "de" divide a linha
 * com o preço só se isso não encolher o preço demais; senão vai para a linha
 * de cima. E se nem 7 px couberem, a folha é recusada dizendo o produto.
 */
function blocoDoPreco(item: LabelItem, f: LabelFormat, s: ReturnType<typeof escala>): string {
  const util = (larguraDoConteudo(f) - RESPIRO_LATERAL_MM) * PX_POR_MM * FOLGA_DA_FONTE;
  const texto = brl(item.priceCents);
  const em = larguraDoTextoEmEm(texto);
  const sozinho = Math.min(s.preco, util / em);
  const exigir = (tamanho: number) => {
    if (tamanho < PRECO_MINIMO_PX) {
      throw new ApiError(
        'CORE_LABEL_PRICE_DOES_NOT_FIT',
        `O preço de "${item.name}" (${texto}) não cabe na largura desta etiqueta `
          + `(${mm(larguraDoConteudo(f))} mm${f.orientation === 'paisagem' ? ' — em paisagem, a altura do adesivo' : ''}) `
          + 'nem com a letra no tamanho mínimo, e sairia cortado. Use uma etiqueta mais larga ou a orientação retrato.',
        400,
        { productId: item.productId, preco: texto },
      );
    }
  };
  const px = (n: number) => n.toFixed(2);

  if (item.onSale) {
    const textoDe = brl(item.listPriceCents);
    const emDe = larguraDoTextoEmEm(textoDe);
    const tamDe = Math.min(s.attr, util / emDe);
    const vao = 1.5 * PX_POR_MM;
    const aoLado = Math.min(s.preco, (util - emDe * tamDe - vao) / em);
    if (aoLado >= PRECO_MINIMO_PX && aoLado >= sozinho * 0.85) {
      return `<div class="preco-bloco">
             <span class="de" style="font-size:${px(tamDe)}px">${esc(textoDe)}</span>
             <span class="preco" style="font-size:${px(aoLado)}px">${esc(texto)}</span>
           </div>`;
    }
    exigir(sozinho);
    return `<div class="preco-bloco empilhado">
             <span class="de" style="font-size:${px(tamDe)}px">${esc(textoDe)}</span>
             <span class="preco" style="font-size:${px(sozinho)}px">${esc(texto)}</span>
           </div>`;
  }
  exigir(sozinho);
  return `<div class="preco" style="font-size:${px(sozinho)}px">${esc(texto)}</div>`;
}

// ------------------------------------------------------ o código de barras

/**
 * O ponto da impressora.
 *
 * DEFEITO QUE ISTO CORRIGE: o ponto era um palpite pela mídia — 203 dpi no
 * rolo, 300 na folha — mesmo quando o MODELO dizia a impressora. Numa térmica
 * de 300 dpi, um módulo arredondado para pontos de 203 (0,125 mm) cai em 2,95
 * pontos dela: o rasterizador arredonda cada barra para 2 ou 3, e o leitor
 * mede barras desiguais. Agora vale o dpi do modelo; o palpite fica só para os
 * formatos prontos, que não têm impressora.
 */
function dpiDaImpressora(f: LabelFormat): number {
  return f.dpi ?? (f.midia === 'rolo' ? 203 : 300);
}
function pontoDaImpressoraMm(f: LabelFormat): number {
  return 25.4 / dpiDaImpressora(f);
}

/**
 * O módulo que vai para o PAPEL, para um código de `modulos` módulos — a mesma
 * conta para o desenho e para o aviso do modelo (o aviso fala do que imprime).
 *
 * Arredonda para um número inteiro de pontos (barras uniformes), MENOS quando
 * o arredondamento tiraria da faixa GS1 um módulo que estava dentro dela: 40 mm
 * de rolo dão 0,343 mm (104 % do nominal), e dois pontos seriam 0,25 mm (76 %).
 * Aí fica a medida exata.
 */
function moduloNoPapel(
  f: LabelFormat,
  modulos: number,
): { bruto: number; modulo: number; pontos: number; emPontoInteiro: boolean } {
  const bruto = (larguraDoConteudo(f) - RESPIRO_LATERAL_MM) / modulos;
  const ponto = pontoDaImpressoraMm(f);
  const arredondado = Math.floor(bruto / ponto + 1e-9) * ponto;
  const tiraDaFaixaGs1 = bruto >= MODULO_GS1_MM && arredondado < MODULO_GS1_MM;
  const modulo = arredondado >= MODULO_MINIMO_MM && !tiraDaFaixaGs1 ? arredondado : bruto;
  const pontos = modulo / ponto;
  return { bruto, modulo, pontos, emPontoInteiro: Math.abs(pontos - Math.round(pontos)) < 1e-6 };
}

/**
 * A menor largura útil (lado das barras) em que o EAN-13 cabe com um número
 * INTEIRO de pontos desta impressora e dentro da faixa GS1 — o que o aviso do
 * ponto quebrado sugere.
 */
function larguraParaPontoInteiroMm(dpi: number): number {
  const ponto = 25.4 / dpi;
  const pontos = Math.ceil(MODULO_GS1_MM / ponto - 1e-9);
  return Math.ceil((pontos * ponto * MODULOS_DO_EAN13 + RESPIRO_LATERAL_MM) * 10) / 10;
}

/**
 * As barras de um item, com a LARGURA do módulo arredondada ao ponto da
 * impressora.
 *
 * DEFEITO QUE ISTO CORRIGE: o SVG esticava a 100 % da largura, e o módulo
 * saía com uma fração qualquer de ponto (40 mm de rolo = 2,75 pontos): o
 * rasterizador arredondava cada barra para 2 ou 3, até ±36 % de erro no que o
 * leitor mede. Agora o módulo é um número inteiro de pontos (e o código fica
 * centrado); se nem assim passar do mínimo, ele fica com a medida exata.
 */
function barrasDoItem(item: LabelItem, f: LabelFormat): { html: string; problema: string | null } {
  const d = desenhoDoCodigo(item.barcode);
  if (!d.ok) {
    return {
      html: `<div class="sem-ean">CÓDIGO INVÁLIDO: ${esc(item.barcode)}</div>`,
      problema: `o código ${item.barcode} tem ${d.motivo} — o leitor o recusaria. Corrija no cadastro do produto.`,
    };
  }
  const { bruto, modulo } = moduloNoPapel(f, d.modulos);
  if (bruto < MODULO_MINIMO_MM) {
    const precisa = Math.ceil((d.modulos * MODULO_MINIMO_MM + RESPIRO_LATERAL_MM) * 10) / 10;
    return {
      html: `<div class="sem-ean">CÓDIGO LONGO DEMAIS PARA ESTA ETIQUETA</div>`,
      problema: `o código ${item.barcode} (${d.simbologia}) precisa de ${mm(precisa)} mm de largura para as barras serem lidas, `
        + `e a etiqueta tem ${mm(larguraDoConteudo(f))} mm. Use uma etiqueta mais larga ou um código mais curto.`,
    };
  }
  return { html: `<div class="barras">${svgDoDesenho(d, d.modulos * modulo)}</div>`, problema: null };
}

function etiqueta(item: LabelItem, f: LabelFormat, empresa: string, s: ReturnType<typeof escala>): string {
  const mostra = (c: Parameters<typeof f.campos.includes>[0]) => f.campos.includes(c);

  const partes: string[] = [];
  if (mostra('nome')) {
    partes.push(`<div class="nome">${esc(item.name)}</div>`);
  }
  if (mostra('descricao') && item.shortDescription) {
    partes.push(`<div class="attr">${esc(item.shortDescription)}</div>`);
  }
  // Marca, unidade e SKU dividem UMA linha curta: cada um sozinho gastaria uma
  // linha inteira de uma etiqueta que mal cabe o nome.
  const info = [
    mostra('marca') ? item.brand : '',
    mostra('unidade') ? item.unit : '',
    mostra('sku') && item.sku ? `SKU ${item.sku}` : '',
  ].filter((v) => String(v ?? '').trim() !== '');
  if (info.length) partes.push(`<div class="attr">${esc(info.join(' · '))}</div>`);
  if (mostra('atributos') && item.attributes) {
    partes.push(`<div class="attr">${esc(item.attributes)}</div>`);
  }
  if (mostra('preco')) {
    // "De / por" só aparece quando há promoção: em etiqueta sem promoção, um
    // preço riscado ao lado do outro é a receita para o cliente ler o errado.
    partes.push(blocoDoPreco(item, f, s));
  }
  if (mostra('complemento') && f.complementText) {
    partes.push(`<div class="attr">${esc(f.complementText)}</div>`);
  }
  // Validade e lote dividem UMA linha, como no layout explícito (LabelLayout):
  // a mesma etiqueta tem de dizer a mesma coisa no navegador e na térmica.
  const validade = mostra('validade') ? dataNaEtiqueta(item.validade) : '';
  const lote = mostra('lote') ? String(item.lote ?? '').trim() : '';
  const linhaDoLote = [validade ? `Val. ${validade}` : '', lote ? `Lote ${lote}` : ''].filter(Boolean).join(' · ');
  if (linhaDoLote) partes.push(`<div class="attr">${esc(linhaDoLote)}</div>`);
  if (mostra('barras')) {
    if (item.barcode) {
      partes.push(barrasDoItem(item, f).html);
    } else if (item.codigoPendente === 'ao_imprimir') {
      partes.push(`<div class="sem-ean">O CÓDIGO DE BARRAS É GERADO AO IMPRIMIR</div>`);
    } else if (item.codigoPendente === 'sem_permissao') {
      partes.push(`<div class="sem-ean">SEM CÓDIGO DE BARRAS — gere no cadastro do produto</div>`);
    } else {
      partes.push(`<div class="sem-ean">SEM CÓDIGO DE BARRAS</div>`);
    }
  }
  // O NÚMERO sai sempre que marcado — com ou sem o desenho. Ele morava dentro
  // do "se há barras", e o cartaz com "Número do código de barras" (sem o
  // desenho) saía sem o número que o repositor queria conferir.
  if (mostra('ean') && item.barcode) {
    partes.push(`<div class="ean">${esc(item.barcode)}</div>`);
  }
  if (mostra('codigo') || mostra('empresa')) {
    partes.push(
      `<div class="rodape">
         <span class="cod">${mostra('codigo') ? esc(item.internalCode) : ''}</span>
         <span>${mostra('empresa') ? esc(empresa) : ''}</span>
       </div>`,
    );
  }

  const conteudo = partes.join('');
  if (f.orientation === 'paisagem') {
    // O adesivo sai de lado na impressora: o conteúdo é montado deitado (largura
    // e altura trocadas) e girado 90° para caber exatamente no retângulo.
    return `<div class="etq"><div class="giro">${conteudo}</div></div>`;
  }
  return `<div class="etq">${conteudo}</div>`;
}

export interface LabelSheetInput {
  format: LabelFormat;
  items: LabelItem[];
  companyId: string;
  /**
   * Em que posição da PRIMEIRA folha a impressão começa (1 = a primeira).
   *
   * Sem isto, a folha sempre começava na célula 1: reetiquetar cinco produtos
   * em momentos diferentes gastava cinco folhas A4 de 30 com uma etiqueta
   * cada, e recolocar a folha já usada não adiantava.
   */
  comecarEm?: number;
  /**
   * A etiqueta de TESTE: contorno preto meio milímetro para dentro da borda de
   * cada adesivo, também no papel — se ele sai torto, a calibração X/Y do
   * modelo diz quanto corrigir.
   */
  moldura?: boolean;
}

/**
 * Monta a folha.
 *
 * `@page` em milímetro é o que faz o adesivo sair no tamanho certo. O `grid`
 * com `grid-auto-rows` fixo garante que a etiqueta ocupe exatamente a altura
 * declarada, e não a altura do seu conteúdo — senão um nome comprido empurraria
 * toda a coluna e o resto da folha sairia fora do adesivo.
 */
export function renderLabelSheet(input: LabelSheetInput): string {
  const { format: f, items } = input;
  const companyName = nomeDaEmpresa(input.companyId);
  const s = escala(f);
  const pagina = paginaMm(f);
  const recuo = recuoDaFolhaMm(f);
  const hConteudo = alturaDoConteudo(f);
  const wConteudo = larguraDoConteudo(f);
  // No rolo de um MODELO, a margem de cima é respiro dentro do adesivo.
  const respiroTopo = f.paperWidthMm && f.midia === 'rolo' ? Math.max(0.6, f.marginTopMm) : 0.6;
  const linhaDoNome = s.nome * 1.12;
  const linhasDoNome = linhasQueCabem(hConteudo * 0.26, linhaDoNome);
  const linhaDoAttr = s.attr * 1.1;
  const linhasDoAttr = linhasQueCabem(hConteudo * 0.14, linhaDoAttr);

  // As células puladas no começo da primeira folha (etiquetas já usadas).
  const pular = Math.max(0, Math.min(porPagina(f) - 1, Math.floor(Number(input.comecarEm ?? 1)) - 1));
  const todas: string[] = new Array<string>(pular).fill('<div class="etq-vazia"></div>');
  // Uma linha com quantidade 3 vira três etiquetas — montadas UMA vez e
  // repetidas: com 200 cópias, desenhar o código 200 vezes era trabalho à toa
  // numa rota síncrona.
  for (const item of items) {
    const html = etiqueta(item, f, companyName, s);
    for (let i = 0; i < item.quantity; i += 1) todas.push(html);
  }

  const cabem = porPagina(f);
  const paginas: string[] = [];
  for (let i = 0; i < todas.length; i += cabem) {
    paginas.push(`<section class="folha">${todas.slice(i, i + cabem).join('')}</section>`);
  }

  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<title>Etiquetas — ${esc(f.label)}</title>
<style>
  @page { size: ${pagina.largura}mm ${pagina.altura}mm; margin: 0; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: Arial, Helvetica, sans-serif; color: #000; }

  .folha {
    width: ${pagina.largura}mm;
    height: ${pagina.altura}mm;
    padding: ${recuo.topo}mm 0 0 ${recuo.esquerda}mm;
    display: grid;
    grid-template-columns: repeat(${f.columns}, ${f.widthMm}mm);
    grid-auto-rows: ${f.heightMm}mm;
    column-gap: ${f.gapXmm}mm;
    row-gap: ${f.gapYmm}mm;
    align-content: start;
    overflow: hidden;
    /* Cada folha é uma página. Sem isto, a segunda folha começaria no meio da
       primeira e todo o resto sairia deslocado. */
    page-break-after: always;
  }
  .folha:last-child { page-break-after: auto; }

  .etq {
    position: relative;
    width: ${f.widthMm}mm;
    height: ${f.heightMm}mm;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    line-height: 1.1;
    padding: ${respiroTopo}mm 0.6mm 0.6mm 0.6mm;
    font-size: ${s.nome.toFixed(2)}px;
  }
  .etq-vazia { width: ${f.widthMm}mm; height: ${f.heightMm}mm; }
  .giro {
    position: absolute; top: 0; left: 0;
    width: ${wConteudo}mm; height: ${hConteudo}mm;
    display: flex; flex-direction: column; padding: 0.6mm;
    transform-origin: top left;
    transform: translateX(${f.widthMm}mm) rotate(90deg);
  }
  /* O nome ocupa um número INTEIRO de linhas (${linhasDoNome}), com reticência
     na última — nunca uma linha cortada ao meio. Palavra longa quebra em vez
     de sair pela borda, e o nome não encolhe até sumir quando há muitos campos. */
  .nome { font-weight: bold; line-height: 1.12;
          display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: ${linhasDoNome};
          max-height: ${(linhasDoNome * linhaDoNome).toFixed(2)}px; overflow: hidden;
          overflow-wrap: anywhere; flex-shrink: 0; }
  .attr { font-size: ${s.attr.toFixed(2)}px; color: #222; line-height: 1.1;
          display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: ${linhasDoAttr};
          max-height: ${(linhasDoAttr * linhaDoAttr).toFixed(2)}px; overflow: hidden; overflow-wrap: anywhere; }
  .preco { font-size: ${s.preco.toFixed(2)}px; font-weight: bold; text-align: right;
           line-height: 1; margin: 0.3mm 0; white-space: nowrap; flex-shrink: 0; }
  .preco-bloco { display: flex; align-items: baseline; justify-content: flex-end;
                 gap: 1.5mm; margin: 0.3mm 0; flex-shrink: 0; white-space: nowrap; }
  .preco-bloco.empilhado { flex-direction: column; align-items: flex-end; gap: 0; }
  .preco-bloco .de { font-size: ${s.attr.toFixed(2)}px; text-decoration: line-through; color: #444; }
  .preco-bloco .preco { margin: 0; }
  .barras { height: ${s.barrasMm.toFixed(2)}mm; margin-top: auto; flex-shrink: 0;
            display: flex; justify-content: center; }
  .barras svg { display: block; height: 100%; }
  .ean { font-family: "Courier New", monospace; font-size: ${s.ean.toFixed(2)}px;
         letter-spacing: 1.2px; text-align: center; line-height: 1.1; flex-shrink: 0; }
  .sem-ean { font-size: ${s.ean.toFixed(2)}px; text-align: center; border: 1px dashed #000;
             padding: 0.8mm; margin-top: auto; flex-shrink: 0; }
  .rodape { display: flex; justify-content: space-between; font-size: ${s.rodape.toFixed(2)}px;
            color: #444; line-height: 1; flex-shrink: 0; }
  .rodape .cod { font-family: "Courier New", monospace; }

  /* Na tela, a folha ganha contorno para conferência. No papel some. */
  @media screen {
    body { background: #f4f4f5; padding: 16px; }
    .folha { background: #fff; box-shadow: 0 1px 4px rgba(0,0,0,.25); margin: 0 auto 16px; }
    .etq { outline: 1px dashed #ccc; outline-offset: -1px; }
    .etq-vazia { outline: 1px dotted #e4e4e7; outline-offset: -1px; }
  }${input.moldura ? `
  /* Etiqueta de teste: o contorno sai também no papel, meio milímetro para dentro. */
  .folha .etq { outline: 0.25mm solid #000; outline-offset: -0.75mm; }` : ''}${f.offsetXmm || f.offsetYmm ? `
  /* Calibração do modelo: cada etiqueta desloca no papel o que a impressora puxa torto. */
  .etq, .etq-vazia { transform: translate(${f.offsetXmm ?? 0}mm, ${f.offsetYmm ?? 0}mm); }` : ''}
</style></head><body>
${paginas.join('\n')}
</body></html>`;
}

/** Quantas etiquetas e quantas folhas o lote vai gastar — a tela mostra antes. */
export function resumoDaFolha(
  f: LabelFormat,
  items: LabelItem[],
  comecarEm = 1,
): { etiquetas: number; folhas: number } {
  const etiquetas = items.reduce((t, i) => t + i.quantity, 0);
  const pular = Math.max(0, Math.min(porPagina(f) - 1, Math.floor(comecarEm) - 1));
  return { etiquetas, folhas: etiquetas > 0 ? Math.ceil((etiquetas + pular) / porPagina(f)) : 0 };
}

/**
 * Os itens cujo código NÃO virou barra nesta folha, com o motivo: verificador
 * errado, caractere que o código de barras não representa, ou código longo
 * demais para a largura. A tela mostra antes de a pessoa colar o adesivo.
 */
export function problemasDosCodigos(f: LabelFormat, items: LabelItem[]): { name: string; motivo: string }[] {
  if (!f.campos.includes('barras')) return [];
  const problemas: { name: string; motivo: string }[] = [];
  for (const item of items) {
    if (!item.barcode) continue;
    const { problema } = barrasDoItem(item, f);
    if (problema) problemas.push({ name: item.name, motivo: problema });
  }
  return problemas;
}

/**
 * O que o gestor precisa saber do MODELO antes de gastar o rolo — vai para a
 * prévia e para a resposta do salvar. Não recusa: avisa.
 *
 * - O módulo do código de barras abaixo do mínimo GS1 (entre 0,19 e 0,264 mm:
 *   imprime, mas leitor a laser pode falhar).
 * - O módulo que NÃO cai num número inteiro de pontos da impressora (ver
 *   abaixo).
 * - Os campos marcados que, somados, passam da altura do adesivo — antes o
 *   nome encolhia até sumir sem nenhum aviso, e o que estava embaixo saía
 *   cortado.
 *
 * ## O ponto quebrado (C-etiquetas-05, reauditoria)
 *
 * DEFEITO QUE ISTO CORRIGE: o rolo de 40 × 30 a 203 dpi — o "Novo modelo" do
 * editor — tem módulo de 0,343 mm, que são 2,75 pontos da térmica. Arredondar
 * para 2 pontos (0,25 mm) tiraria o código da faixa GS1, então `moduloNoPapel`
 * fica com a medida exata; mas a impressora só marca pontos INTEIROS, e cada
 * barra sai com 2 ou 3 pontos — o leitor mede barras desiguais e erra ou
 * demora. Nenhum aviso saía (só havia o do mínimo GS1), e a loja descobria na
 * gôndola. Agora a prévia e o salvar dizem quantos pontos são, e o que resolve:
 * a impressora de resolução maior em que o módulo fecha, ou a largura mínima
 * em que ele fecha nesta impressora.
 */
export function avisosDoFormato(f: LabelFormat): string[] {
  const avisos: string[] = [];
  const mostra = (c: Parameters<typeof f.campos.includes>[0]) => f.campos.includes(c);
  const largura = larguraDoConteudo(f);
  const lado = f.orientation === 'paisagem' ? ' de altura (em paisagem as barras correm na altura)' : ' de largura';
  if (mostra('barras')) {
    // O módulo que de fato vai para o papel (depois do arredondamento ao ponto).
    const { modulo, pontos, emPontoInteiro } = moduloNoPapel(f, MODULOS_DO_EAN13);
    if (modulo < MODULO_GS1_MM) {
      avisos.push(
        `Com ${mm(largura)} mm úteis, cada barra do código fica com ${mm(Math.round(modulo * 1000) / 1000)} mm — abaixo do mínimo GS1 `
          + `(${mm(MODULO_GS1_MM)} mm): leitores a laser podem falhar. Para leitura segura, use ao menos `
          + `${mm(Math.ceil((MODULO_GS1_MM * MODULOS_DO_EAN13 + RESPIRO_LATERAL_MM) * 10) / 10)} mm${lado}.`,
      );
    } else if (!emPontoInteiro) {
      const dpi = dpiDaImpressora(f);
      // A primeira resolução MAIOR em que o módulo desta largura fecha em pontos inteiros.
      const resolve = DPIS_DA_IMPRESSORA.find((d) => d > dpi && moduloNoPapel({ ...f, dpi: d }, MODULOS_DO_EAN13).emPontoInteiro);
      const impressora = f.dpi
        ? `Na impressora deste modelo (${dpi} dpi)`
        : `Numa impressora de ${dpi} dpi (a mais comum para ${f.midia === 'rolo' ? 'rolo' : 'folha'})`;
      avisos.push(
        `${impressora}, cada barra do código fica com `
          + `${(Math.round(modulo * 1000) / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 3 })} mm, que são `
          + `${mm(Math.round(pontos * 100) / 100)} pontos. A impressora só marca pontos inteiros: umas barras saem com `
          + `${Math.floor(pontos)} pontos e outras com ${Math.ceil(pontos)}, e o leitor pode errar ou demorar a ler. `
          + `Para barras iguais, ${resolve ? `use uma impressora de ${resolve} dpi ou ` : 'use '}uma etiqueta de ao menos `
          + `${mm(larguraParaPontoInteiroMm(dpi))} mm${lado}.`,
      );
    }
  }

  const s = escala(f);
  const h = alturaDoConteudo(f);
  const pxEmMm = (px: number) => px / PX_POR_MM;
  const respiroTopo = f.paperWidthMm && f.midia === 'rolo' && f.orientation !== 'paisagem' ? Math.max(0.6, f.marginTopMm) : 0.6;
  let altura = respiroTopo + 0.6;
  if (mostra('nome')) altura += pxEmMm(linhasQueCabem(h * 0.26, s.nome * 1.12) * s.nome * 1.12);
  const linhasDeDetalhe = [
    mostra('descricao'),
    mostra('marca') || mostra('unidade') || mostra('sku'),
    mostra('atributos'),
    mostra('complemento'),
    // Validade e lote dividem uma linha.
    mostra('validade') || mostra('lote'),
  ].filter(Boolean).length;
  altura += linhasDeDetalhe * pxEmMm(s.attr * 1.1);
  if (mostra('preco')) altura += pxEmMm(s.preco) + 0.6;
  if (mostra('barras')) altura += s.barrasMm;
  if (mostra('ean')) altura += pxEmMm(s.ean * 1.1);
  if (mostra('codigo') || mostra('empresa')) altura += pxEmMm(s.rodape);
  if (altura > h + 0.05) {
    avisos.push(
      `Os campos marcados pedem cerca de ${mm(Math.round(altura * 10) / 10)} mm de altura e a etiqueta tem ${mm(h)} mm`
        + `${f.orientation === 'paisagem' ? ' (em paisagem, a largura do adesivo)' : ''}: o que fica embaixo — código de barras, `
        + 'número, rodapé — pode sair cortado. Tire um campo, diminua a escala do texto ou aumente a etiqueta.',
    );
  }
  return avisos;
}
