/**
 * MERCADORIA NA NOTA, SERVIÇO NA NFS-e — GAP-PRD-024.
 *
 * A venda da OS tem as duas coisas: peça (mercadoria — ICMS, NFC-e ou NF-e) e
 * mão de obra (serviço — ISS, NFS-e). Nenhum documento declara as duas juntas
 * pelo caminho deste sistema: a NFC-e não tem onde pôr o serviço, e a NFS-e
 * não tem onde pôr a peça (a lista da LC 116, item 14.01, deixa as peças fora
 * do ISS, sujeitas ao ICMS).
 *
 * Este módulo é a régua que SEPARA, usada pela montagem da nota de mercadoria
 * (`loadSaleForNfce` → NFC-e, NF-e, DANFCE, prontidão) e pela NFS-e:
 *
 *  - linha com produto é mercadoria e vai para a nota;
 *  - linha sem produto é serviço e vai para a NFS-e;
 *  - o PAGAMENTO é rateado: a nota declara o que o cliente pagou PELAS PEÇAS,
 *    na proporção de cada forma — `vPag` fecha com o `vNF` sem inventar troco;
 *  - a venda de OS cobrada antes desta correção (uma linha "Ordem de serviço
 *    #N", sem produto) é itemizada PELA PRÓPRIA OS — peças e mão de obra —,
 *    desde que o valor cobrado seja o total da OS. É o caminho de conserto do
 *    dado que já existe, sem reescrever a venda.
 *
 * O que ela RECUSA: desconto ou acréscimo no total de uma venda que mistura
 * mercadoria e serviço. Dividir esse valor entre os dois documentos é regra
 * tributária (o desconto incondicional reduz a base de qual imposto?), e o
 * sistema não inventa tributação — diz o motivo e para.
 */
import { getConnection } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import type { NfceSale, NfceSaleItem } from './FiscalXmlNfce.js';
import { descricaoDaMaoDeObra, osDaVenda, vendaDaOs } from './VendaDaOficina.js';

/** Uma linha de serviço da venda — o que a NFS-e vai declarar. */
export interface ServicoDaVenda {
  description: string;
  totalCents: number;
}

/**
 * Reparte `alvoCents` entre os pagamentos, na proporção de cada um, e fecha
 * no centavo (a última forma absorve o resto do arredondamento).
 *
 * O troco sai antes: ele é dinheiro que voltou, e não pagou nada. Sai da forma
 * "dinheiro" (é ela que gera troco) ou, sem ela, da última.
 */
export function ratearPagamentos(
  pagamentos: { method: string; amountCents: number }[],
  trocoCents: number,
  alvoCents: number,
): { method: string; amountCents: number }[] {
  const liquidos = pagamentos.map((p) => ({ ...p }));
  let troco = Math.max(0, trocoCents);
  const ordem = [
    ...liquidos.filter((p) => p.method === 'dinheiro'),
    ...liquidos.filter((p) => p.method !== 'dinheiro').reverse(),
  ];
  for (const p of ordem) {
    if (troco <= 0) break;
    const tira = Math.min(troco, p.amountCents);
    p.amountCents -= tira;
    troco -= tira;
  }
  const comValor = liquidos.filter((p) => p.amountCents > 0);
  const total = comValor.reduce((s, p) => s + p.amountCents, 0);
  if (total <= 0 || alvoCents <= 0) return [];

  const rateados = comValor.map((p) => ({
    method: p.method,
    amountCents: Math.floor((p.amountCents * alvoCents) / total),
  }));
  const somados = rateados.reduce((s, p) => s + p.amountCents, 0);
  rateados[rateados.length - 1].amountCents += alvoCents - somados;
  return rateados.filter((p) => p.amountCents > 0);
}

interface ProdutoFiscal {
  ncm: string | null;
  cest: string | null;
  cfop: string | null;
  origin: string | null;
  unit: string | null;
  barcode: string | null;
  internal_code: string | null;
  tax_profile: string | null;
}

/** A venda de OS antiga (uma linha sem produto), itemizada pela própria OS. */
function itemizarPelaOs(sale: NfceSale): { itens: NfceSaleItem[]; servicos: ServicoDaVenda[] } | null {
  const os = osDaVenda(sale.companyId, sale.id);
  if (!os) return null;
  let daOs: ReturnType<typeof vendaDaOs>;
  try {
    daOs = vendaDaOs(sale.companyId, os.id);
  } catch {
    // A conta da OS não fecha — itemizar por ela declararia outro valor.
    return null;
  }
  const cobrado = sale.items.reduce((s, i) => s + i.totalCents, 0);
  if (cobrado !== daOs.totalCents) return null;

  const produto = getConnection().prepare(
    `SELECT ncm, cest, cfop, origin, unit, barcode, internal_code, tax_profile
       FROM core_products WHERE id = ? AND company_id = ?`,
  );
  const itens: NfceSaleItem[] = daOs.pecas.map((p) => {
    const f = (produto.get(p.productId, sale.companyId) as ProdutoFiscal | undefined) ?? null;
    return {
      productId: p.productId,
      description: p.description,
      quantity: p.quantity,
      unitPriceCents: p.unitPriceCents,
      discountCents: 0,
      totalCents: p.totalCents,
      ncm: f?.ncm ?? null,
      cest: f?.cest ?? null,
      cfop: f?.cfop ?? null,
      origin: f?.origin ?? null,
      unit: f?.unit ?? null,
      barcode: f?.barcode ?? null,
      internalCode: f?.internal_code ?? null,
      taxProfile: f?.tax_profile ?? null,
      saleItemId: null,
      unidades: [],
    };
  });
  const servicos =
    daOs.maoDeObraCents > 0
      ? [{ description: descricaoDaMaoDeObra(daOs.number), totalCents: daOs.maoDeObraCents }]
      : [];
  return { itens, servicos };
}

/**
 * A venda como a NOTA DE MERCADORIA a enxerga: só as linhas com produto, com
 * o total e o pagamento delas. Venda sem serviço volta intacta.
 */
export function separarMercadoriaDeServico(sale: NfceSale): NfceSale {
  ensureCoreSchema();
  const temServico = sale.items.some((i) => !i.productId);
  if (!temServico) return sale;

  let mercadorias = sale.items.filter((i) => Boolean(i.productId));
  let servicos: ServicoDaVenda[] = sale.items
    .filter((i) => !i.productId)
    .map((i) => ({ description: i.description, totalCents: i.totalCents }));

  if (mercadorias.length === 0) {
    const pelaOs = itemizarPelaOs(sale);
    if (pelaOs) {
      mercadorias = pelaOs.itens;
      servicos = pelaOs.servicos;
    }
  }

  if (sale.discountCents !== 0 || sale.surchargeCents !== 0) {
    return {
      ...sale,
      items: mercadorias,
      servicos,
      recusaDaSeparacao:
        'Esta venda mistura mercadoria e serviço e tem desconto ou acréscimo no total. Dividir '
        + 'esse valor entre a nota das peças e a NFS-e é regra tributária do contador, e o '
        + 'sistema não a inventa: lance o desconto na linha (peça ou mão de obra) em vez do total.',
    };
  }

  const mercadoriaCents = mercadorias.reduce((s, i) => s + i.totalCents, 0);
  return {
    ...sale,
    items: mercadorias,
    subtotalCents: mercadoriaCents,
    totalCents: mercadoriaCents,
    changeCents: 0,
    payments: ratearPagamentos(sale.payments, sale.changeCents, mercadoriaCents),
    servicos,
    recusaDaSeparacao: null,
  };
}

/** O texto da recusa da nota de mercadoria para venda só de serviço. */
export function mensagemVendaSoDeServico(servicos: ServicoDaVenda[]): string {
  const total = servicos.reduce((s, i) => s + i.totalCents, 0);
  return (
    `Esta venda é só de serviço (mão de obra, R$ ${(total / 100).toFixed(2).replace('.', ',')}): `
    + 'o documento dela é a NFS-e, não a nota de mercadoria.'
  );
}
