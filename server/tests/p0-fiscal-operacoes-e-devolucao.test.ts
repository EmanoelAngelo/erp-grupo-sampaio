/**
 * P0 FISCAL — OPERAÇÕES DA EMPRESA, PRAZO DE CANCELAMENTO E NF-e DE DEVOLUÇÃO
 * (homologação SIMULADA).
 *
 *  - natureza da operação, CFOP da devolução, grupo e prazo de cancelamento
 *    são parâmetros POR EMPRESA (nunca regra global); sem cadastro valem os
 *    padrões, marcados como pendência contábil;
 *  - o prazo de cancelamento informado pelo contador barra o pedido fora do
 *    prazo ANTES de falar com a SEFAZ; sem prazo, a SEFAZ decide;
 *  - devolução de VENDA: NF-e de entrada, finNFe 4, NFref da NFC-e, CFOP
 *    1202/2202; devolução de COMPRA: saída, finNFe 4, NFref da nota do
 *    fornecedor, CFOP 5202/6202 — e a devolução de compra passa a "emitida"
 *    quando a nota é autorizada;
 *  - o DANFE da devolução de venda diz ENTRADA e mostra a nota referenciada;
 *  - a devolução rejeitada se reemite com o mesmo número.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import { updateFiscalConfig } from '../src/services/core/FiscalConfigService.js';
import { buildAccessKey, setSeriesNextNumber } from '../src/services/core/FiscalKeyService.js';
import {
  createNfceForSale,
  createNfeForSale,
  getDocument,
  listDocumentEvents,
} from '../src/services/core/FiscalDocumentService.js';
import { emitNfceForSale, emitNfeForSale } from '../src/services/core/FiscalPipelineService.js';
import { requestCancel } from '../src/services/core/FiscalEventsService.js';
import {
  exigirOperacaoConfirmadaEmProducao,
  gravarOperacao,
  lerOperacao,
} from '../src/services/core/FiscalOperacoes.js';
import {
  createNfeDeDevolucao,
  destinatarioDaDevolucaoDeCompra,
  emitirNfeDeDevolucao,
} from '../src/services/core/FiscalDevolucao.js';
import { reemitirRejeitada } from '../src/services/core/FiscalReemissao.js';
import { getSaleReturn, vendaParaDevolucao } from '../src/services/core/SaleReturnService.js';
import { destinatarioSugeridoDaDevolucaoDeVenda } from '../src/services/core/SituacaoFiscalDaDevolucao.js';
import { getDevolucao } from '../src/services/core/SupplierReturnService.js';
import { renderDanfe } from '../src/services/core/DanfeRenderer.js';
import { parseSefazResponse, type AuthorizeRequest, type SefazResponse } from '../src/services/core/SefazAdapter.js';
import { SefazTestAdapter } from '../src/services/core/SefazTestAdapter.js';
import type { NfeRecipient } from '../src/services/core/FiscalXmlNfe.js';
import { grupoTributarioPadrao } from './helpers/grupoTributario.js';

class RejeitaUmaVez extends SefazTestAdapter {
  private usado = false;

  override async authorize(input: AuthorizeRequest): Promise<SefazResponse> {
    if (this.usado) return super.authorize(input);
    this.usado = true;
    return parseSefazResponse({
      body:
        `<retEnviNFe><protNFe><infProt><chNFe>${input.accessKey}</chNFe><cStat>778</cStat>`
        + '<xMotivo>Rejeicao: Informado NCM inexistente</xMotivo></infProt></protNFe></retEnviNFe>',
      correlationId: randomUUID(),
    });
  }
}

let empresa: string;
let n = 0;

const CONSUMIDOR_RS: NfeRecipient = {
  document: '123.456.789-09',
  name: 'Maria Consumidora',
  ieIndicator: '9',
  street: 'Rua das Flores',
  number: '10',
  district: 'Centro',
  cityName: 'Pelotas',
  cityIbge: '4314407',
  uf: 'RS',
  zip: '96015000',
};

const CONSUMIDOR_SC: NfeRecipient = {
  ...CONSUMIDOR_RS,
  cityName: 'Florianópolis',
  cityIbge: '4205407',
  uf: 'SC',
  zip: '88010000',
};

const FORNECEDOR_SC: NfeRecipient = {
  document: '14.200.166/0001-87',
  name: 'Fornecedor Catarinense Ltda',
  ieIndicator: '1',
  ie: '253008882',
  street: 'Rua da Indústria',
  number: '900',
  district: 'Distrito Industrial',
  cityName: 'Florianópolis',
  cityIbge: '4205407',
  uf: 'SC',
  zip: '88010000',
};

/** INSERT que preenche, com valor de teste, as colunas NOT NULL sem padrão que o caso não cita. */
function inserir(tabela: string, valores: Record<string, unknown>): void {
  const db = getConnection();
  const colunas = db.prepare(`PRAGMA table_info(${tabela})`).all() as unknown as {
    name: string;
    type: string;
    notnull: number;
    dflt_value: unknown;
    pk: number;
  }[];
  const linha: Record<string, unknown> = { ...valores };
  for (const c of colunas) {
    if (c.name in linha || c.pk || !c.notnull || c.dflt_value !== null) continue;
    linha[c.name] = c.name.endsWith('_at') ? new Date().toISOString() : /INT|REAL/i.test(c.type) ? 0 : 'teste';
  }
  const nomes = Object.keys(linha);
  db.prepare(`INSERT INTO ${tabela} (${nomes.join(', ')}) VALUES (${nomes.map(() => '?').join(', ')})`).run(
    ...(Object.values(linha) as never[]),
  );
}

function venda(): { saleId: string; productId: string; saleItemId: string } {
  ensureCoreSchema();
  n += 1;
  const id = `venda-${n}`;
  const db = getConnection();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents, price_cents,
                                ncm, cfop, origin, active, created_at, updated_at)
     VALUES (?, ?, ?, 'Camisa', 'UN', 1000, 5000, '62052000', '5102', '0', 1, ?, ?)`,
  ).run(`p-${id}`, empresa, `PJ-${n}`, now, now);
  db.prepare(
    `INSERT INTO core_sales (id, company_id, number, status, subtotal_cents, discount_cents,
                             surcharge_cents, total_cents, origin, idempotency_key, change_cents, created_at)
     VALUES (?, ?, ?, 'completed', 10000, 0, 0, 10000, 'pdv', ?, 0, ?)`,
  ).run(id, empresa, n, `k-${id}`, now);
  db.prepare(
    `INSERT INTO core_sale_items (id, sale_id, company_id, product_id, description, quantity,
                                  unit_price_cents, discount_cents, total_cents)
     VALUES (?, ?, ?, ?, 'Camisa', 2, 5000, 0, 10000)`,
  ).run(`i-${id}`, id, empresa, `p-${id}`);
  db.prepare(
    `INSERT INTO core_sale_payments (id, sale_id, company_id, method, amount_cents, status, created_at)
     VALUES (?, ?, ?, 'dinheiro', 10000, 'settled', ?)`,
  ).run(`pay-${id}`, id, empresa, now);
  return { saleId: id, productId: `p-${id}`, saleItemId: `i-${id}` };
}

/** O registro da devolução de UMA das duas camisas. */
function devolucaoDeVenda(v: { saleId: string; productId: string; saleItemId: string }): string {
  const id = `dev-${randomUUID().slice(0, 8)}`;
  inserir('core_sale_returns', {
    id,
    company_id: empresa,
    number: n,
    sale_id: v.saleId,
    reason: 'Defeito na costura',
    total_cents: 5000,
    refund_method: 'dinheiro',
    created_at: new Date().toISOString(),
  });
  inserir('core_sale_return_items', {
    id: `${id}-1`,
    return_id: id,
    company_id: empresa,
    sale_item_id: v.saleItemId,
    product_id: v.productId,
    quantity: 1,
    unit_price_cents: 5000,
    total_cents: 5000,
    restock: 0,
    created_at: new Date().toISOString(),
  });
  return id;
}

/**
 * A compra (NF-e do fornecedor de SC) e a devolução de 3 unidades a R$ 20,00.
 *
 * `cadastroDoFornecedor` grava o fornecedor e o vincula à nota: é dele que o
 * destinatário da NF-e de devolução é lido, em vez de redigitado. `null` é a
 * nota sem fornecedor vinculado; um objeto parcial serve para provar a recusa
 * que nomeia o campo que falta.
 */
function devolucaoDeCompra(
  docType: 'nfe' | 'manual' = 'nfe',
  cadastroDoFornecedor: Record<string, unknown> | null = null,
): { returnId: string; chaveDaCompra: string } {
  ensureCoreSchema();
  n += 1;
  const now = new Date().toISOString();
  const produto = `p-compra-${n}`;
  getConnection()
    .prepare(
      `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents, price_cents,
                                  ncm, cfop, origin, active, created_at, updated_at)
       VALUES (?, ?, ?, 'Camisa atacado', 'UN', 2000, 5000, '62052000', '5102', '0', 1, ?, ?)`,
    )
    .run(produto, empresa, `PJC-${n}`, now, now);
  const chaveDaCompra = buildAccessKey({
    ufCode: '42',
    aamm: '2609',
    cnpj: '14200166000187',
    model: '55',
    serie: 1,
    number: 900 + n,
    emissionType: '1',
    numericCode: '12345678',
  });
  let fornecedor: string | null = null;
  if (cadastroDoFornecedor) {
    fornecedor = `forn-${n}`;
    inserir('core_suppliers', { id: fornecedor, company_id: empresa, ...cadastroDoFornecedor });
  }
  const nota = `nota-${n}`;
  inserir('core_inbound_notes', {
    id: nota,
    company_id: empresa,
    access_key: chaveDaCompra,
    number: String(900 + n),
    series: '1',
    total_cents: 10000,
    status: 'received',
    doc_type: docType,
    supplier_id: fornecedor,
  });
  const returnId = `devc-${n}`;
  inserir('core_supplier_returns', {
    id: returnId,
    company_id: empresa,
    number: n,
    note_id: nota,
    reason: 'Lote com defeito',
    goods_cents: 6000,
    credit_cents: 6000,
    finance_mode: 'sem_financeiro',
    fiscal_status: 'pendente',
    created_at: now,
  });
  inserir('core_supplier_return_items', {
    id: `${returnId}-1`,
    return_id: returnId,
    company_id: empresa,
    product_id: produto,
    quantity: 3,
    unit_cost_cents: 2000,
    total_cents: 6000,
    created_at: now,
  });
  return { returnId, chaveDaCompra };
}

function xmlDe(documentId: string): string {
  return String(
    (getConnection().prepare('SELECT xml_original FROM core_fiscal_documents WHERE id = ?').get(documentId) as {
      xml_original: string;
    }).xml_original,
  );
}

function proximoNumero(model: '55' | '65'): number {
  return Number(
    (getConnection()
      .prepare('SELECT next_number FROM core_fiscal_series WHERE company_id = ? AND model = ? AND serie = 1')
      .get(empresa, model) as { next_number: number }).next_number,
  );
}

function configurar(companyId: string): void {
  updateFiscalConfig({
    companyId,
    patch: {
      legalName: 'Preço Justo Comércio Ltda',
      cnpj: '11.222.333/0001-81',
      ie: '0960123456',
      crt: '1',
      street: 'Rua XV de Novembro',
      number: '100',
      district: 'Centro',
      cityName: 'Pelotas',
      cityIbge: '4314407',
      zip: '96015000',
      uf: 'RS',
    },
  });
  grupoTributarioPadrao(companyId);
  setSeriesNextNumber({ companyId, model: '55', serie: 1, nextNumber: 1 });
  setSeriesNextNumber({ companyId, model: '65', serie: 1, nextNumber: 1 });
}

beforeEach(() => {
  resetDbForTests();
  n = 0;
  empresa = upsertCompany({ slug: 'preco-justo', legalName: 'Preço Justo Ltda', tradeName: 'Preço Justo' });
  configurar(empresa);
});

describe('operações fiscais — parâmetros do contador, por empresa', () => {
  it('sem cadastro valem os padrões, marcados como pendência contábil', () => {
    const devolucao = lerOperacao(empresa, 'devolucao_venda');
    expect(devolucao).toMatchObject({
      natOp: 'DEVOLUCAO DE VENDA',
      cfopInterno: '1202',
      cfopInterestadual: '2202',
      direcao: 'entrada',
      origem: 'padrao',
      confirmadaPeloContador: false,
    });
    expect(devolucao.pendencias.join(' ')).toMatch(/não confirmad/);
    const compra = lerOperacao(empresa, 'devolucao_compra');
    expect(compra).toMatchObject({ cfopInterno: '5202', cfopInterestadual: '6202', direcao: 'saida' });
    const venda = lerOperacao(empresa, 'venda_nfce');
    expect(venda.natOp).toBe('VENDA AO CONSUMIDOR');
    expect(venda.pendencias.join(' ')).toMatch(/prazo de cancelamento/);
  });

  it('a natureza gravada vai para o XML — e só desta empresa', () => {
    gravarOperacao({ companyId: empresa, operacao: 'venda_nfce', natOp: 'VENDA DE MERCADORIA NO VAREJO' });
    const outra = upsertCompany({ slug: 'gringa', legalName: 'Gringa Ltda', tradeName: 'Gringa' });
    configurar(outra);

    const daPrecoJusto = createNfceForSale({ companyId: empresa, saleId: venda().saleId });
    expect(xmlDe(daPrecoJusto.document.id)).toContain('<natOp>VENDA DE MERCADORIA NO VAREJO</natOp>');
    expect(lerOperacao(outra, 'venda_nfce').natOp).toBe('VENDA AO CONSUMIDOR');
  });

  it('o CFOP da devolução é conferido pelo alcance; o CFOP da venda mora no grupo tributário', () => {
    expect(() => gravarOperacao({ companyId: empresa, operacao: 'devolucao_venda', cfopInterno: '5202' })).toThrow(
      /começa com 1/,
    );
    expect(() => gravarOperacao({ companyId: empresa, operacao: 'devolucao_compra', cfopInterestadual: '5202' })).toThrow(
      /começa com 6/,
    );
    expect(() => gravarOperacao({ companyId: empresa, operacao: 'venda_nfe', cfopInterno: '5102' })).toThrow(
      /grupo tributário/,
    );
    expect(() => gravarOperacao({ companyId: empresa, operacao: 'devolucao_venda', grupoTributario: 'NAO-EXISTE' })).toThrow(
      /não existe/,
    );
    expect(() => gravarOperacao({ companyId: empresa, operacao: 'inventada' })).toThrow(/desconhecida/);
  });

  it('em PRODUÇÃO a devolução só sai com a operação confirmada pelo contador', () => {
    expect(() => exigirOperacaoConfirmadaEmProducao(empresa, 'devolucao_venda', 'production')).toThrow(
      /confirmada pelo contador/,
    );
    expect(() => exigirOperacaoConfirmadaEmProducao(empresa, 'devolucao_venda', 'homologation')).not.toThrow();
    gravarOperacao({ companyId: empresa, operacao: 'devolucao_venda', confirmadaPeloContador: true });
    expect(() => exigirOperacaoConfirmadaEmProducao(empresa, 'devolucao_venda', 'production')).not.toThrow();
  });
});

describe('cancelamento — o prazo que o contador informou para a UF', () => {
  it('dentro do prazo cancela; fora do prazo é recusado ANTES de falar com a SEFAZ', async () => {
    gravarOperacao({ companyId: empresa, operacao: 'venda_nfce', prazoCancelamentoMinutos: 30 });

    const dentro = await emitNfceForSale({ companyId: empresa, saleId: venda().saleId, developmentMode: true });
    const autorizadaEm = new Date(getDocument(empresa, dentro.document.id)!.authorizedAt!).getTime();
    const ok = await requestCancel({
      companyId: empresa,
      documentId: dentro.document.id,
      justification: 'Erro de digitação no valor da venda',
      adapter: new SefazTestAdapter(),
      now: new Date(autorizadaEm + 10 * 60_000),
    });
    expect(ok.accepted).toBe(true);

    const fora = await emitNfceForSale({ companyId: empresa, saleId: venda().saleId, developmentMode: true });
    const autorizadaFora = new Date(getDocument(empresa, fora.document.id)!.authorizedAt!).getTime();
    await expect(
      requestCancel({
        companyId: empresa,
        documentId: fora.document.id,
        justification: 'Erro de digitação no valor da venda',
        adapter: new SefazTestAdapter(),
        now: new Date(autorizadaFora + 31 * 60_000),
      }),
    ).rejects.toThrow(/prazo de cancelamento/);
    expect(getDocument(empresa, fora.document.id)!.status).toBe('AUTHORIZED');
    // Nada foi pedido à SEFAZ: nenhum "cancelamento pedido" na linha do tempo.
    expect(listDocumentEvents(empresa, fora.document.id).some((e) => e.eventType === 'cancel_requested')).toBe(false);
  });

  it('sem prazo informado, nada é barrado aqui — a SEFAZ decide', async () => {
    const r = await emitNfceForSale({ companyId: empresa, saleId: venda().saleId, developmentMode: true });
    const autorizadaEm = new Date(getDocument(empresa, r.document.id)!.authorizedAt!).getTime();
    const cancelado = await requestCancel({
      companyId: empresa,
      documentId: r.document.id,
      justification: 'Cliente desistiu da compra no balcão',
      adapter: new SefazTestAdapter(),
      now: new Date(autorizadaEm + 10 * 24 * 60 * 60_000),
    });
    expect(cancelado.accepted).toBe(true);
  });
});

describe('NF-e de devolução de VENDA — entrada, finNFe 4, NFref da NFC-e', () => {
  it('sai com tpNF 0, CFOP 1202, a chave da NFC-e no NFref e "sem pagamento"; a pendência vem declarada', async () => {
    const v = venda();
    const cupom = await emitNfceForSale({ companyId: empresa, saleId: v.saleId, developmentMode: true });
    const returnId = devolucaoDeVenda(v);

    const r = await emitirNfeDeDevolucao({
      companyId: empresa,
      operacao: 'devolucao_venda',
      returnId,
      recipient: CONSUMIDOR_RS,
      developmentMode: true,
    });
    expect(r.document.status).toBe('AUTHORIZED');
    expect(r.document.saleId).toBeNull();
    expect(r.pendencias.length).toBeGreaterThan(0);

    const xml = xmlDe(r.document.id);
    expect(xml).toContain('<mod>55</mod>');
    expect(xml).toContain('<tpNF>0</tpNF>');
    expect(xml).toContain('<finNFe>4</finNFe>');
    expect(xml).toContain('<natOp>DEVOLUCAO DE VENDA</natOp>');
    expect(xml).toContain(`<refNFe>${cupom.document.accessKey}</refNFe>`);
    expect(xml).toContain('<idDest>1</idDest>');
    expect(xml).toContain('<CFOP>1202</CFOP>');
    expect(xml).toMatch(/<tPag>90<\/tPag>\s*<vPag>0\.00<\/vPag>/);
    expect(xml).toContain('<vNF>50.00</vNF>');

    // A ficha da devolução mostra a nota; a NFC-e da venda continua autorizada.
    expect(getSaleReturn(empresa, returnId).notaDeDevolucao).toMatchObject({
      status: 'AUTHORIZED',
      referencedAccessKey: cupom.document.accessKey,
    });
    expect(getDocument(empresa, cupom.document.id)!.status).toBe('AUTHORIZED');
  });

  it('consumidor de outra UF: CFOP 2202 e idDest 2', async () => {
    const v = venda();
    await emitNfceForSale({ companyId: empresa, saleId: v.saleId, developmentMode: true });
    const { document } = createNfeDeDevolucao({
      companyId: empresa,
      operacao: 'devolucao_venda',
      returnId: devolucaoDeVenda(v),
      recipient: CONSUMIDOR_SC,
    });
    const xml = xmlDe(document.id);
    expect(xml).toContain('<CFOP>2202</CFOP>');
    expect(xml).toContain('<idDest>2</idDest>');
  });

  it('é idempotente: dois pedidos, uma nota e um número', async () => {
    const v = venda();
    await emitNfceForSale({ companyId: empresa, saleId: v.saleId, developmentMode: true });
    const returnId = devolucaoDeVenda(v);
    const a = createNfeDeDevolucao({ companyId: empresa, operacao: 'devolucao_venda', returnId, recipient: CONSUMIDOR_RS });
    const b = createNfeDeDevolucao({ companyId: empresa, operacao: 'devolucao_venda', returnId, recipient: CONSUMIDOR_RS });
    expect(b.document.id).toBe(a.document.id);
    expect(b.created).toBe(false);
    expect(proximoNumero('55')).toBe(2);
  });

  it('venda sem nota autorizada (comprovante não fiscal) não gera NF-e de devolução — nem número', () => {
    const v = venda();
    expect(() =>
      createNfeDeDevolucao({ companyId: empresa, operacao: 'devolucao_venda', returnId: devolucaoDeVenda(v), recipient: CONSUMIDOR_RS }),
    ).toThrow(/nota AUTORIZADA/);
    expect(proximoNumero('55')).toBe(1);
  });

  it('o DANFE da devolução de venda diz ENTRADA, DEVOLUÇÃO e mostra a nota referenciada', async () => {
    const v = venda();
    const cupom = await emitNfceForSale({ companyId: empresa, saleId: v.saleId, developmentMode: true });
    const r = await emitirNfeDeDevolucao({
      companyId: empresa,
      operacao: 'devolucao_venda',
      returnId: devolucaoDeVenda(v),
      recipient: CONSUMIDOR_RS,
      developmentMode: true,
    });
    const html = renderDanfe(empresa, r.document.id);
    expect(html).toContain('0 — ENTRADA');
    expect(html).toContain('FINALIDADE: DEVOLUÇÃO');
    expect(html).toContain('DEVOLUCAO DE VENDA');
    expect(html).toContain(cupom.document.accessKey!.slice(0, 4));
    expect(html).toContain('Nota referenciada');
  });

  it('a devolução rejeitada se reemite com o MESMO número, ainda devolução', async () => {
    const v = venda();
    await emitNfceForSale({ companyId: empresa, saleId: v.saleId, developmentMode: true });
    const returnId = devolucaoDeVenda(v);
    const r = await emitirNfeDeDevolucao({
      companyId: empresa,
      operacao: 'devolucao_venda',
      returnId,
      recipient: CONSUMIDOR_RS,
      developmentMode: true,
      adapter: new RejeitaUmaVez(),
    });
    expect(r.document.status).toBe('REJECTED');

    const reemitida = reemitirRejeitada({ companyId: empresa, documentId: r.document.id });
    expect(reemitida.numero).toBe(r.document.number);
    expect(reemitida.document.accessKey).not.toBe(r.document.accessKey);
    const xml = xmlDe(r.document.id);
    expect(xml).toContain('<finNFe>4</finNFe>');
    expect(xml).toContain('<CFOP>1202</CFOP>');
    expect(proximoNumero('55')).toBe(2);
  });
});

/**
 * O SELO FISCAL DA DEVOLUÇÃO ENXERGA OS DOIS MODELOS (P0 fiscal — resíduo).
 *
 * O DEFEITO: `estadoFiscalDaVenda` perguntava por `fiscalStatusForSale`, que
 * lê SÓ o cupom (modelo 65). A venda documentada pela NF-e de balcão — a
 * feature que esta mesma frente acrescentou — respondia `nao_fiscal`, com a
 * frase "não há documento fiscal a regularizar", e a ficha da devolução
 * escondia o gesto de emitir a NF-e de devolução. A rota, medida no mesmo
 * caso, emitia a nota sem reclamar: o servidor sabia e a tela negava.
 *
 * E depois de emitida a nota da devolução, o selo continuava dizendo
 * "PENDENTE DE REGULARIZAÇÃO" — mandando emitir — logo acima do bloco que
 * mostrava a nota já autorizada.
 */
describe('o selo fiscal da venda enxerga os DOIS modelos', () => {
  it('venda documentada pela NF-e de balcão: PENDENTE DE REGULARIZAÇÃO, nomeando a NF-e (não "não fiscal")', async () => {
    const v = venda();
    const nota = await emitNfeForSale({
      companyId: empresa,
      saleId: v.saleId,
      recipient: CONSUMIDOR_RS,
      developmentMode: true,
    });
    expect(nota.document.status).toBe('AUTHORIZED');
    const returnId = devolucaoDeVenda(v);

    const ficha = getSaleReturn(empresa, returnId) as unknown as {
      fiscal: { estado: string; rotulo: string; detalhe: string; documentoModelo: string | null };
    };
    expect(ficha.fiscal).toMatchObject({
      estado: 'pendente_regularizacao',
      rotulo: 'PENDENTE DE REGULARIZAÇÃO',
      documentoModelo: '55',
    });
    expect(ficha.fiscal.detalhe).toContain('NF-e (modelo 55)');
    // A venda ANTES de escolher os itens diz o mesmo — é a mesma pergunta.
    expect((vendaParaDevolucao(empresa, v.saleId).fiscal as { estado: string }).estado).toBe(
      'pendente_regularizacao',
    );
  });

  it('a NF-e de devolução autorizada encerra a regularização: DEVOLUÇÃO DOCUMENTADA', async () => {
    const v = venda();
    await emitNfeForSale({
      companyId: empresa,
      saleId: v.saleId,
      recipient: CONSUMIDOR_RS,
      developmentMode: true,
    });
    const returnId = devolucaoDeVenda(v);
    const r = await emitirNfeDeDevolucao({
      companyId: empresa,
      operacao: 'devolucao_venda',
      returnId,
      recipient: CONSUMIDOR_RS,
      developmentMode: true,
    });
    expect(r.document.status).toBe('AUTHORIZED');

    const ficha = getSaleReturn(empresa, returnId) as unknown as {
      fiscal: { estado: string; rotulo: string; detalhe: string };
    };
    expect(ficha.fiscal).toMatchObject({
      estado: 'devolucao_documentada',
      rotulo: 'DEVOLUÇÃO DOCUMENTADA',
    });
    expect(ficha.fiscal.detalhe).toContain(`nº ${r.document.number}`);

    /*
      A pergunta SEM o registro (a venda antes de escolher os itens) continua
      olhando só a venda: ali não há devolução de que falar, e a nota da venda
      segue autorizada.
    */
    expect((vendaParaDevolucao(empresa, v.saleId).fiscal as { estado: string }).estado).toBe(
      'pendente_regularizacao',
    );
  });

  it('NF-e da venda ainda não autorizada: NF-E PENDENTE — e o gesto da devolução não se oferece', () => {
    const v = venda();
    createNfeForSale({ companyId: empresa, saleId: v.saleId, recipient: CONSUMIDOR_RS });
    const returnId = devolucaoDeVenda(v);
    expect(getSaleReturn(empresa, returnId).fiscal).toMatchObject({
      estado: 'nota_pendente',
      rotulo: 'NF-E PENDENTE',
      documentoModelo: '55',
    });
  });
});

describe('NF-e de devolução de COMPRA — saída, finNFe 4, NFref da nota do fornecedor', () => {
  it('fornecedor de SC: tpNF 1, CFOP 6202, NFref da compra; autorizada, a devolução vira "emitida"', async () => {
    const { returnId, chaveDaCompra } = devolucaoDeCompra();
    const r = await emitirNfeDeDevolucao({
      companyId: empresa,
      operacao: 'devolucao_compra',
      returnId,
      recipient: FORNECEDOR_SC,
      developmentMode: true,
    });
    expect(r.document.status).toBe('AUTHORIZED');
    const xml = xmlDe(r.document.id);
    expect(xml).toContain('<tpNF>1</tpNF>');
    expect(xml).toContain('<finNFe>4</finNFe>');
    expect(xml).toContain('<natOp>DEVOLUCAO DE COMPRA</natOp>');
    expect(xml).toContain('<CFOP>6202</CFOP>');
    expect(xml).toContain('<idDest>2</idDest>');
    expect(xml).toContain(`<refNFe>${chaveDaCompra}</refNFe>`);
    expect(xml).toContain('<IE>253008882</IE>');
    expect(xml).toContain('<vNF>60.00</vNF>');

    const devolucao = getDevolucao(empresa, returnId);
    expect(devolucao.fiscalStatus).toBe('emitida');
    expect(devolucao.fiscalAccessKey).toBe(r.document.accessKey);
    expect(devolucao.notaDeDevolucao?.status).toBe('AUTHORIZED');
  });

  it('compra que entrou sem NF-e (entrada manual) não tem o que referenciar — recusa sem número', () => {
    const { returnId } = devolucaoDeCompra('manual');
    expect(() =>
      createNfeDeDevolucao({ companyId: empresa, operacao: 'devolucao_compra', returnId, recipient: FORNECEDOR_SC }),
    ).toThrow(/entrada manual/);
    expect(proximoNumero('55')).toBe(1);
  });
});

/**
 * O DESTINATÁRIO LIDO DO CADASTRO (P0 fiscal).
 *
 * O defeito: a rota exigia o destinatário INTEIRO no corpo — nome, CNPJ,
 * indicador de IE e endereço com código IBGE — e nenhuma tela a chamava. Pedir
 * que a gerência redigite o endereço do fornecedor a cada devolução é pedir que
 * ela erre, e o digitado divergiria do cadastro que a própria NF-e de entrada
 * preencheu. O dado está no banco: devolução → nota de entrada → fornecedor.
 */
describe('o destinatário da devolução de compra sai do cadastro do fornecedor', () => {
  const CADASTRO_COMPLETO = {
    name: 'Fornecedor Catarinense Ltda',
    document: '14.200.166/0001-87',
    state_registration: '253008882',
    street: 'Rua da Indústria',
    number: '900',
    district: 'Distrito Industrial',
    city: 'Florianópolis',
    city_ibge: '4205407',
    state: 'SC',
    zip: '88010-000',
  };

  it('monta o destinatário do cadastro, e a nota sai com ele', async () => {
    const { returnId, chaveDaCompra } = devolucaoDeCompra('nfe', CADASTRO_COMPLETO);

    const destinatario = destinatarioDaDevolucaoDeCompra(empresa, returnId);
    expect(destinatario).toMatchObject({
      document: '14200166000187',
      name: 'Fornecedor Catarinense Ltda',
      // Com inscrição estadual gravada, é contribuinte; a mercadoria volta para
      // quem a revende, então não é consumo do destinatário.
      ieIndicator: '1',
      ie: '253008882',
      consumidorFinal: false,
      cityIbge: '4205407',
      uf: 'SC',
      zip: '88010000',
    });

    const r = await emitirNfeDeDevolucao({
      companyId: empresa,
      operacao: 'devolucao_compra',
      returnId,
      recipient: destinatario,
      developmentMode: true,
    });
    expect(r.document.status).toBe('AUTHORIZED');
    const xml = xmlDe(r.document.id);
    expect(xml).toContain('<CNPJ>14200166000187</CNPJ>');
    expect(xml).toContain('<IE>253008882</IE>');
    expect(xml).toContain('<cMun>4205407</cMun>');
    expect(xml).toContain(`<refNFe>${chaveDaCompra}</refNFe>`);
  });

  it('sem inscrição estadual, o fornecedor é ISENTO (indIEDest 2) — e não "não contribuinte"', () => {
    const { returnId } = devolucaoDeCompra('nfe', { ...CADASTRO_COMPLETO, state_registration: null });
    const destinatario = destinatarioDaDevolucaoDeCompra(empresa, returnId);
    expect(destinatario.ieIndicator).toBe('2');
    expect(destinatario.ie).toBeNull();
  });

  it('cadastro incompleto RECUSA nomeando cada campo que falta — nada é inventado', () => {
    const { returnId } = devolucaoDeCompra('nfe', {
      ...CADASTRO_COMPLETO,
      city_ibge: null,
      number: null,
    });
    let erro: unknown;
    try {
      destinatarioDaDevolucaoDeCompra(empresa, returnId);
    } catch (err) {
      erro = err;
    }
    expect((erro as { code?: string }).code).toBe('CORE_FISCAL_RETURN_SUPPLIER_INCOMPLETE');
    expect((erro as Error).message).toMatch(/número/);
    expect((erro as Error).message).toMatch(/código IBGE do município/);
    // Recusa de cadastro não gasta número fiscal.
    expect(proximoNumero('55')).toBe(1);
  });

  it('nota de entrada sem fornecedor vinculado recusa com o caminho de quem vincula', () => {
    const { returnId } = devolucaoDeCompra('nfe', null);
    expect(() => destinatarioDaDevolucaoDeCompra(empresa, returnId)).toThrow(
      /não tem fornecedor cadastrado/,
    );
  });
});

/**
 * O QUE A LOJA JÁ SABE SOBRE QUEM DEVOLVEU (P0 fiscal).
 *
 * A NF-e de devolução de VENDA é nota de ENTRADA, e o leiaute exige o endereço
 * do destinatário com código IBGE — endereço que a loja não tem (a NFC-e do
 * balcão sai com o CPF). O que ela tem é o nome e o documento que foram para a
 * nota, e é com eles que o formulário da tela nasce preenchido. Montar o
 * destinatário sozinho poria endereço inventado numa nota fiscal.
 */
describe('o destinatário SUGERIDO da devolução de venda', () => {
  it('vem do cliente da venda quando a NFC-e não guarda destinatário', () => {
    const v = venda();
    inserir('core_customers', {
      id: 'cli-1',
      company_id: empresa,
      name: 'Maria Consumidora',
      document: '123.456.789-09',
      active: 1,
    });
    getConnection().prepare('UPDATE core_sales SET customer_id = ? WHERE id = ?').run('cli-1', v.saleId);
    const returnId = devolucaoDeVenda(v);

    expect(destinatarioSugeridoDaDevolucaoDeVenda(empresa, returnId)).toEqual({
      name: 'Maria Consumidora',
      document: '12345678909',
    });
  });

  it('venda sem cliente e sem destinatário na nota: nulo — o formulário nasce vazio, e é honesto', () => {
    const returnId = devolucaoDeVenda(venda());
    expect(destinatarioSugeridoDaDevolucaoDeVenda(empresa, returnId)).toBeNull();
  });

  it('o destinatário da NOTA ganha do cadastro: é quem foi para o fisco', async () => {
    const v = venda();
    inserir('core_customers', {
      id: 'cli-2',
      company_id: empresa,
      name: 'Nome de hoje no cadastro',
      document: '123.456.789-09',
      active: 1,
    });
    getConnection().prepare('UPDATE core_sales SET customer_id = ? WHERE id = ?').run('cli-2', v.saleId);

    /*
      A NF-e guarda o destinatário DAQUELA nota (`recipient_name`); a NFC-e não
      guarda nenhum. Aqui a nota da venda passa a ter destinatário gravado — o
      caso da venda faturada em NF-e —, e ele tem de ganhar do cadastro: o
      cadastro mostra o nome de HOJE, e a nota mostra o que foi ao fisco.
    */
    await emitNfceForSale({ companyId: empresa, saleId: v.saleId, developmentMode: true });
    getConnection()
      .prepare('UPDATE core_fiscal_documents SET recipient_name = ?, recipient_document = ? WHERE sale_id = ?')
      .run('Maria da Nota', '52998224725', v.saleId);

    const returnId = devolucaoDeVenda(v);
    expect(destinatarioSugeridoDaDevolucaoDeVenda(empresa, returnId)).toEqual({
      name: 'Maria da Nota',
      document: '52998224725',
    });
  });
});
