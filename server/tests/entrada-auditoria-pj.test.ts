/**
 * ============================================================================
 * ENTRADA DE MERCADORIA — a auditoria da Preço Justo (trilha "entrada")
 * ============================================================================
 *
 * Um caso por achado, e cada um fica VERMELHO sem o conserto dele:
 *
 *   B-02  a NF-e emitida para OUTRA empresa do grupo não entra nesta;
 *   B-03  a remessa de bonificação (CFOP x910…) entra sem conta a pagar, com a
 *         dispensa gravada;
 *   B-04  o fator resolvido da nota fica gravado na linha — e o pedido conta
 *         unidades, não caixas;
 *   B-05  o `cEANTrib` casa o item com o produto que já existe;
 *   B-06  o produto que a nota cadastra nasce na unidade tributável, com o EAN
 *         da unidade — e o código da caixa NÃO entra no cadastro (PED-ent-01);
 *   B-08  a nota estornada entra de novo com o mesmo XML, numa conferência nova;
 *   B-09  o custo leva desconto, frete (rateado), IPI e ST;
 *   B-10  a conferência diz o estado de cada dado fiscal;
 *   B-11  o casamento não aceita produto inativo nem escolhe homônimo;
 *   B-13  o ajuste manual tem rótulo próprio, não "acerto de inventário";
 *   B-14  o estorno devolve o custo de antes;
 *   B-16  o inventário aceita o bipe;
 *   B-17  a contagem não aceita produto de outra empresa nem modelo de grade;
 *   B-18  o blur do fator não grava "chegou tudo";
 *   B-19  o fator que alguém já deu para o item do fornecedor é lembrado;
 *   B-21  o estorno não passa por cima do reservado;
 *   M01   o fator digitado numa linha SEM produto não some;
 *   M02   sem protocolo de autorização, a nota não entra na produção;
 *   M04   o código que já é de um modelo de grade é nomeado antes de gravar;
 *   M05   a leitura da nota diz o fator que a confirmação aplicaria.
 */
process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { getConnection } from '../src/db/sqlite.js';
import { resetDbForTests } from '../src/db/database.js';
import { loginForTest } from './helpers/auth.js';
import {
  completarFatoresDasNotasRecebidas,
  conferirItem,
  confirmNfe,
  estornarNota,
  importNfe,
  linkNoteItem,
  listNoteItems,
} from '../src/services/core/NfeImportService.js';
import { updateFiscalConfig } from '../src/services/core/FiscalConfigService.js';
import { reserveStock } from '../src/services/core/InventoryService.js';
import { addProductBarcode } from '../src/services/core/CatalogAuxService.js';
import { createPurchaseOrder, linkNoteToOrder } from '../src/services/core/PurchaseOrderService.js';
import { digitoVerificadorGtin } from '../src/services/core/Gtin.js';
import { custoMedioPorProduto } from '../src/services/core/PoliticaDeGestaoService.js';

const app = createApp();

const CNPJ_FORNECEDOR = '14200166000187';
const CNPJ_DA_LOJA = '11222333000181';
const CNPJ_DA_GRINGA = '99999999000191';

/** GTIN válido a partir do corpo — o verificador calculado, nunca chutado. */
const gtin = (corpo: string) => `${corpo}${digitoVerificadorGtin(corpo)}`;
const EAN_UNIDADE = gtin('789123456789');
const DUN_CAIXA = gtin('1789123456789');
const EAN_OUTRO = gtin('789490001151');

let auth: { Authorization: string };
let companyId: string;
let userId: string;
let sequencia = 0;

beforeEach(async () => {
  resetDbForTests();
  sequencia = 0;
  const res = await loginForTest(app, {
    userId: 'gerente-entrada-pj',
    companyId: 'loja-entrada-pj',
    profileCodes: ['gerente_loja'],
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  auth = { Authorization: `Bearer ${res.body.accessToken}` };
  companyId = res.body.company.id;
  userId = res.body.user.id;
});

// ---------------------------------------------------------------- helpers

interface Item {
  cProd: string;
  xProd: string;
  cEAN?: string;
  cEANTrib?: string;
  cfop?: string;
  ncm?: string;
  uCom?: string;
  qCom: number;
  vUnCom: number;
  uTrib?: string;
  qTrib?: number;
  vDesc?: number;
  vFrete?: number;
  vIPI?: number;
  vICMSST?: number;
}

function chave(n: number): string {
  return `352609${CNPJ_FORNECEDOR}55001${String(n).padStart(9, '0')}1${String(n).padStart(8, '0')}5`;
}

function nfeXml(opcoes: {
  itens: Item[];
  dest?: string | null;
  tpAmb?: '1' | '2';
  /** undefined = sem protNFe; objeto = o protocolo que o arquivo traz. */
  prot?: { cStat: string; chNFe?: string };
  totalFrete?: number;
  numero?: number;
}): { xml: string; chave: string } {
  sequencia += 1;
  const n = opcoes.numero ?? sequencia;
  const k = chave(n);
  const det = opcoes.itens
    .map((i, idx) => {
      const vProd = (i.qCom * i.vUnCom).toFixed(2);
      const imposto = [
        '<imposto><ICMS><ICMSSN500><orig>0</orig><CSOSN>500</CSOSN>',
        i.vICMSST !== undefined ? `<vICMSST>${i.vICMSST.toFixed(2)}</vICMSST>` : '',
        '</ICMSSN500></ICMS>',
        i.vIPI !== undefined
          ? `<IPI><cEnq>999</cEnq><IPITrib><CST>50</CST><vIPI>${i.vIPI.toFixed(2)}</vIPI></IPITrib></IPI>`
          : '',
        '</imposto>',
      ].join('');
      return `<det nItem="${idx + 1}"><prod>
        <cProd>${i.cProd}</cProd><cEAN>${i.cEAN ?? 'SEM GTIN'}</cEAN><xProd>${i.xProd}</xProd>
        <NCM>${i.ncm ?? '87141000'}</NCM><CFOP>${i.cfop ?? '5102'}</CFOP>
        <uCom>${i.uCom ?? 'UN'}</uCom><qCom>${i.qCom}</qCom><vUnCom>${i.vUnCom.toFixed(2)}</vUnCom>
        <vProd>${vProd}</vProd><cEANTrib>${i.cEANTrib ?? 'SEM GTIN'}</cEANTrib>
        <uTrib>${i.uTrib ?? i.uCom ?? 'UN'}</uTrib><qTrib>${i.qTrib ?? i.qCom}</qTrib>
        ${i.vDesc !== undefined ? `<vDesc>${i.vDesc.toFixed(2)}</vDesc>` : ''}
        ${i.vFrete !== undefined ? `<vFrete>${i.vFrete.toFixed(2)}</vFrete>` : ''}
      </prod>${imposto}</det>`;
    })
    .join('');
  const vNF = opcoes.itens.reduce((s, i) => s + i.qCom * i.vUnCom, 0) + (opcoes.totalFrete ?? 0);
  const dest = opcoes.dest === null ? '' : `<dest><CNPJ>${opcoes.dest ?? CNPJ_DA_LOJA}</CNPJ><xNome>Destinatario</xNome></dest>`;
  const prot = opcoes.prot
    ? `<protNFe><infProt><tpAmb>1</tpAmb><chNFe>${opcoes.prot.chNFe ?? k}</chNFe><cStat>${opcoes.prot.cStat}</cStat>`
      + `<xMotivo>Motivo ${opcoes.prot.cStat}</xMotivo><nProt>135260000000001</nProt></infProt></protNFe>`
    : '';
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc versao="4.00" xmlns="http://www.portalfiscal.inf.br/nfe"><NFe>
  <infNFe Id="NFe${k}" versao="4.00">
    <ide><nNF>${n}</nNF><serie>1</serie><dhEmi>2026-09-10T10:00:00-03:00</dhEmi>${opcoes.tpAmb ? `<tpAmb>${opcoes.tpAmb}</tpAmb>` : ''}</ide>
    <emit><CNPJ>${CNPJ_FORNECEDOR}</CNPJ><xNome>Distribuidora da Auditoria Ltda</xNome></emit>
    ${dest}
    ${det}
    <total><ICMSTot><vFrete>${(opcoes.totalFrete ?? 0).toFixed(2)}</vFrete><vNF>${vNF.toFixed(2)}</vNF></ICMSTot></total>
  </infNFe>
</NFe>${prot}</nfeProc>`;
  return { xml, chave: k };
}

async function produto(corpo: Record<string, unknown>): Promise<string> {
  const res = await request(app)
    .post('/api/v1/core/products')
    .set(auth)
    .send({ priceCents: 5000, ...corpo });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

function saldo(productId: string): number {
  const row = getConnection()
    .prepare('SELECT quantity FROM core_stock WHERE company_id = ? AND product_id = ?')
    .get(companyId, productId) as { quantity: number } | undefined;
  return row?.quantity ?? 0;
}

function custo(productId: string): number {
  return (getConnection().prepare('SELECT cost_cents FROM core_products WHERE id = ?').get(productId) as {
    cost_cents: number;
  }).cost_cents;
}

function contar(sql: string, ...params: unknown[]): number {
  return (getConnection().prepare(sql).get(...(params as never[])) as { n: number }).n;
}

function importar(xml: string) {
  return importNfe({ companyId, userId, xml });
}

function cnpjDaLoja(): void {
  updateFiscalConfig({ companyId, patch: { cnpj: CNPJ_DA_LOJA } });
}

function producao(): void {
  cnpjDaLoja();
  getConnection()
    .prepare("UPDATE core_fiscal_configs SET environment = 'production' WHERE company_id = ?")
    .run(companyId);
}

// ------------------------------------------------------------------ B-02

describe('B-02 — a NF-e de outra empresa do grupo não entra nesta', () => {
  it('destinatário diferente do CNPJ da empresa: 409 e nada gravado (upload e prévia)', async () => {
    cnpjDaLoja();
    const { xml } = nfeXml({ dest: CNPJ_DA_GRINGA, itens: [{ cProd: 'A', xProd: 'Cabo', qCom: 1, vUnCom: 10 }] });

    const res = await request(app).post('/api/v1/core/purchases/nfe/import').set(auth).send({ xml });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe('CORE_NFE_OUTRO_DESTINATARIO');
    expect(res.body.error.message).toMatch(/99\.999\.999\/0001-91/);
    expect(contar('SELECT COUNT(*) AS n FROM core_inbound_notes WHERE company_id = ?', companyId)).toBe(0);
    expect(contar('SELECT COUNT(*) AS n FROM core_suppliers WHERE company_id = ?', companyId)).toBe(0);

    const previa = await request(app).post('/api/v1/core/purchases/nfe/preview').set(auth).send({ xml });
    expect(previa.status).toBe(409);
    expect(previa.body.error.code).toBe('CORE_NFE_OUTRO_DESTINATARIO');
  });

  it('destinatário igual (com máscara ou sem): entra', async () => {
    cnpjDaLoja();
    const { xml } = nfeXml({ itens: [{ cProd: 'A', xProd: 'Cabo', qCom: 1, vUnCom: 10 }] });
    const res = await request(app).post('/api/v1/core/purchases/nfe/import').set(auth).send({ xml });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it('empresa sem CNPJ configurado: não bloqueia, e a lista mostra o destinatário', async () => {
    const { xml } = nfeXml({ dest: CNPJ_DA_GRINGA, itens: [{ cProd: 'A', xProd: 'Cabo', qCom: 1, vUnCom: 10 }] });
    const res = await request(app).post('/api/v1/core/purchases/nfe/import').set(auth).send({ xml });
    expect(res.status).toBe(201);
    const lista = await request(app).get('/api/v1/core/purchases/notes').set(auth);
    expect(lista.body.items[0].recipient_document).toBe(CNPJ_DA_GRINGA);
  });

  it('a nota de outro destinatário que entrou ANTES da trava não se confirma', () => {
    const { xml } = nfeXml({ dest: CNPJ_DA_GRINGA, itens: [{ cProd: 'A', xProd: 'Cabo', qCom: 1, vUnCom: 10 }] });
    const { noteId } = importar(xml);
    cnpjDaLoja();
    expect(() => confirmNfe({ companyId, noteId, userId, createMissing: true })).toThrow(/não para esta empresa/);
    expect(contar('SELECT COUNT(*) AS n FROM core_stock_movements WHERE company_id = ?', companyId)).toBe(0);
  });
});

// ------------------------------------------------------------------ M02

describe('M02 — sem protocolo de autorização, a nota não entra na produção', () => {
  it('XML sem protNFe: 409, nada gravado', () => {
    producao();
    const { xml } = nfeXml({ tpAmb: '1', itens: [{ cProd: 'A', xProd: 'Cabo', qCom: 1, vUnCom: 10 }] });
    expect(() => importar(xml)).toThrow(/protocolo de autorização/);
    expect(contar('SELECT COUNT(*) AS n FROM core_inbound_notes WHERE company_id = ?', companyId)).toBe(0);
  });

  it('rejeitada (cStat 302) ou protocolo de outra chave: 409', () => {
    producao();
    const rejeitada = nfeXml({ tpAmb: '1', prot: { cStat: '302' }, itens: [{ cProd: 'A', xProd: 'Cabo', qCom: 1, vUnCom: 10 }] });
    expect(() => importar(rejeitada.xml)).toThrow(/não autorizou/);
    const outraChave = nfeXml({
      tpAmb: '1',
      prot: { cStat: '100', chNFe: chave(999) },
      itens: [{ cProd: 'A', xProd: 'Cabo', qCom: 1, vUnCom: 10 }],
    });
    expect(() => importar(outraChave.xml)).toThrow(/OUTRA nota/);
  });

  it('autorizada (cStat 100, chave igual): entra', () => {
    producao();
    const { xml } = nfeXml({ tpAmb: '1', prot: { cStat: '100' }, itens: [{ cProd: 'A', xProd: 'Cabo', qCom: 1, vUnCom: 10 }] });
    expect(importar(xml).duplicated).toBe(false);
  });
});

// ------------------------------------------------------------------ B-03

describe('B-03 — bonificação não gera conta a pagar', () => {
  it('todos os itens em CFOP 5910: estoque entra, título não nasce, e a dispensa fica gravada', () => {
    const { xml } = nfeXml({ itens: [{ cProd: 'BR', xProd: 'Brinde', cfop: '5910', qCom: 12, vUnCom: 12.5 }] });
    const { noteId } = importar(xml);
    const r = confirmNfe({ companyId, noteId, userId, createMissing: true });

    expect(r.semContaAPagar).toMatch(/5910/);
    expect(contar('SELECT COUNT(*) AS n FROM core_finance_entries WHERE origin_id = ?', noteId)).toBe(0);
    const nota = getConnection()
      .prepare('SELECT finance_waiver_reason, finance_waiver_at, total_cents FROM core_inbound_notes WHERE id = ?')
      .get(noteId) as { finance_waiver_reason: string; finance_waiver_at: string; total_cents: number };
    expect(nota.total_cents).toBe(15000);
    expect(nota.finance_waiver_reason).toMatch(/bonificação/);
    expect(nota.finance_waiver_at).toBeTruthy();
    expect(contar('SELECT COUNT(*) AS n FROM core_stock_movements WHERE reference_id = ?', noteId)).toBe(1);
  });

  it('nota mista (compra + brinde): o título nasce pelo total, com aviso', () => {
    const { xml } = nfeXml({
      itens: [
        { cProd: 'C', xProd: 'Compra', cfop: '5102', qCom: 1, vUnCom: 100 },
        { cProd: 'B', xProd: 'Brinde', cfop: '5910', qCom: 1, vUnCom: 10 },
      ],
    });
    const { noteId } = importar(xml);
    const r = confirmNfe({ companyId, noteId, userId, createMissing: true });
    expect(r.aviso).toMatch(/Nota mista/);
    expect(contar('SELECT COUNT(*) AS n FROM core_finance_entries WHERE origin_id = ?', noteId)).toBe(1);
  });
});

// ------------------------------------------------------------ B-04 / M05

describe('B-04 — o fator resolvido fica gravado, e o pedido conta unidades', () => {
  it('pedido de 120 UN, nota de 10 CX com qTrib 120, confirmada sem conferência: pedido com 120', async () => {
    const parafuso = await produto({ name: 'Parafuso', unit: 'UN', barcode: EAN_UNIDADE });
    const forn = await request(app)
      .post('/api/v1/core/suppliers')
      .set(auth)
      .send({ name: 'Distribuidora da Auditoria Ltda', document: CNPJ_FORNECEDOR });
    expect(forn.status, JSON.stringify(forn.body)).toBe(201);
    const pedido = createPurchaseOrder({
      companyId,
      userId,
      supplierId: forn.body.id,
      items: [{ productId: parafuso, quantity: 120, unitCostCents: 50 }],
    });

    const { xml } = nfeXml({
      itens: [{ cProd: 'P', xProd: 'Parafuso cx', cEAN: DUN_CAIXA, cEANTrib: EAN_UNIDADE, uCom: 'CX', qCom: 10, vUnCom: 6, uTrib: 'UN', qTrib: 120 }],
    });
    const { noteId } = importar(xml);
    linkNoteToOrder(companyId, noteId, String(pedido.id));
    confirmNfe({ companyId, noteId, userId });

    expect(saldo(parafuso)).toBe(120);
    expect(listNoteItems(companyId, noteId)[0].conversionFactor).toBe(12);
    const itemDoPedido = getConnection()
      .prepare('SELECT received_quantity FROM core_purchase_order_items WHERE order_id = ?')
      .get(String(pedido.id)) as { received_quantity: number };
    expect(itemDoPedido.received_quantity).toBe(120);
  });

  it('a releitura grava o fator das notas recebidas antes da correção', async () => {
    const parafuso = await produto({ name: 'Parafuso', unit: 'UN', barcode: EAN_UNIDADE });
    const { xml } = nfeXml({
      itens: [{ cProd: 'P', xProd: 'Parafuso cx', cEANTrib: EAN_UNIDADE, uCom: 'CX', qCom: 10, vUnCom: 6, uTrib: 'UN', qTrib: 120 }],
    });
    const { noteId } = importar(xml);
    confirmNfe({ companyId, noteId, userId });
    // O retrato de uma nota confirmada antes desta rodada: fator nulo.
    getConnection().prepare('UPDATE core_inbound_note_items SET conversion_factor = NULL WHERE note_id = ?').run(noteId);

    expect(completarFatoresDasNotasRecebidas(companyId).linhasCompletadas).toBe(1);
    expect(listNoteItems(companyId, noteId)[0].conversionFactor).toBe(12);
    expect(saldo(parafuso)).toBe(120);
  });
});

describe('M05 — a leitura diz o fator que a confirmação aplicaria', () => {
  it('produto em CX e nota em CX (com qTrib 120): 1, não 12', async () => {
    await produto({ name: 'Caixa de parafusos', unit: 'CX', barcode: DUN_CAIXA });
    const { xml } = nfeXml({
      itens: [{ cProd: 'P', xProd: 'Parafuso cx', cEAN: DUN_CAIXA, uCom: 'CX', qCom: 10, vUnCom: 6, uTrib: 'UN', qTrib: 120 }],
    });
    const { noteId } = importar(xml);
    expect(listNoteItems(companyId, noteId)[0].resolvedFactor).toBe(1);
  });

  it('produto em UN e nota em CX sem par tributável: nulo — a confirmação vai pedir', async () => {
    await produto({ name: 'Parafuso', unit: 'UN', barcode: EAN_UNIDADE });
    const { xml } = nfeXml({ itens: [{ cProd: 'P', xProd: 'Parafuso', cEAN: EAN_UNIDADE, uCom: 'CX', qCom: 10, vUnCom: 6 }] });
    const { noteId } = importar(xml);
    expect(listNoteItems(companyId, noteId)[0].resolvedFactor).toBeNull();
  });
});

// ------------------------------------------------------- B-05 / B-06 / M01

describe('B-05 — o cEANTrib casa o item', () => {
  it('cEAN "SEM GTIN" e cEANTrib = EAN do produto: casa por barcode_trib', async () => {
    const p = await produto({ name: 'Refrigerante lata', barcode: EAN_UNIDADE });
    const { xml } = nfeXml({ itens: [{ cProd: 'R', xProd: 'REFRI LT', cEANTrib: EAN_UNIDADE, qCom: 12, vUnCom: 3 }] });
    const r = importar(xml);
    expect(r.items[0].productId).toBe(p);
    expect(r.items[0].matchedBy).toBe('barcode_trib');
  });
});

describe('B-06 — o produto cadastrado pela nota nasce na unidade tributável', () => {
  it('10 CX de 12 (uTrib UN, qTrib 120): produto em UN, EAN da unidade, saldo 120, custo da unidade', () => {
    const { xml } = nfeXml({
      itens: [{ cProd: 'N', xProd: 'Sabonete', cEAN: DUN_CAIXA, cEANTrib: EAN_UNIDADE, uCom: 'CX', qCom: 10, vUnCom: 60, uTrib: 'UN', qTrib: 120 }],
    });
    const { noteId } = importar(xml);
    confirmNfe({ companyId, noteId, userId, createMissing: true });

    const produtoCriado = getConnection()
      .prepare('SELECT id, unit, barcode, cost_cents, pack_unit, pack_factor FROM core_products WHERE company_id = ?')
      .get(companyId) as { id: string; unit: string; barcode: string; cost_cents: number; pack_unit: string; pack_factor: number };
    expect(produtoCriado.unit).toBe('UN');
    expect(produtoCriado.barcode).toBe(EAN_UNIDADE);
    expect(produtoCriado.pack_unit).toBe('CX');
    expect(produtoCriado.pack_factor).toBe(12);
    expect(produtoCriado.cost_cents).toBe(500);
    expect(saldo(produtoCriado.id)).toBe(120);
    /*
      REVISÃO (PED-ent-01): este caso esperava 1 aqui — o DUN-14 da caixa como
      código ADICIONAL do produto em UN. Era o defeito: sem multiplicador, o bipe
      da caixa no balcão vendia UMA unidade. O código da caixa fica fora do
      cadastro, e a próxima nota casa pelo de-para (ver o describe PED-ent-01).
    */
    expect(
      contar('SELECT COUNT(*) AS n FROM core_product_barcodes WHERE product_id = ? AND barcode = ?', produtoCriado.id, DUN_CAIXA),
    ).toBe(0);
  });

  /*
    B-estoque-entrada-R01: o ramo AUTOMÁTICO fazia nascer na unidade tributável
    QUALQUER uTrib diferente do uCom. Com o fornecedor que tributa em peso, o
    pacote de 5 kg nascia em KG, com saldo 50 para 10 pacotes, custo do quilo e
    sem o EAN do pacote. Sem o conserto, estes casos dão KG / 50 / 500 / null.
  */
  it('sabão em pó 5 kg (10 UN = 50 KG, cEANTrib SEM GTIN): nasce em UN, com o EAN do pacote, saldo 10 e custo do pacote', async () => {
    const { xml } = nfeXml({
      itens: [{ cProd: 'SAB5', xProd: 'Sabao em po 5kg', cEAN: EAN_UNIDADE, uCom: 'UN', qCom: 10, vUnCom: 25, uTrib: 'KG', qTrib: 50 }],
    });
    const { noteId } = importar(xml);
    // A leitura diz o mesmo que a confirmação vai fazer (M05): fator 1.
    expect(listNoteItems(companyId, noteId)[0].resolvedFactor).toBe(1);
    confirmNfe({ companyId, noteId, userId, createMissing: true });

    const criado = getConnection()
      .prepare('SELECT id, unit, barcode, cost_cents, pack_unit, pack_factor FROM core_products WHERE company_id = ?')
      .get(companyId) as { id: string; unit: string; barcode: string | null; cost_cents: number; pack_unit: string | null; pack_factor: number | null };
    expect(criado.unit).toBe('UN');
    expect(criado.barcode).toBe(EAN_UNIDADE);
    expect(criado.cost_cents).toBe(2500);
    expect(criado.pack_unit).toBeNull();
    expect(criado.pack_factor).toBeNull();
    expect(saldo(criado.id)).toBe(10);

    // E o bipe do pacote no PDV acha o produto.
    const bipe = await request(app).get('/api/v1/core/products/search').query({ q: EAN_UNIDADE }).set(auth);
    expect(bipe.status).toBe(200);
    expect((bipe.body.items as { id: string }[])[0]?.id).toBe(criado.id);
  });

  it('o mesmo EAN no cEAN e no cEANTrib (tributado em KG): nasce em UN — cada bipe baixa um pacote, não um quilo', () => {
    const { xml } = nfeXml({
      itens: [{ cProd: 'SAB5', xProd: 'Sabao em po 5kg', cEAN: EAN_UNIDADE, cEANTrib: EAN_UNIDADE, uCom: 'UN', qCom: 10, vUnCom: 25, uTrib: 'KG', qTrib: 50 }],
    });
    const { noteId } = importar(xml);
    confirmNfe({ companyId, noteId, userId, createMissing: true });
    const criado = getConnection()
      .prepare('SELECT id, unit, barcode FROM core_products WHERE company_id = ?')
      .get(companyId) as { id: string; unit: string; barcode: string | null };
    expect(criado.unit).toBe('UN');
    expect(criado.barcode).toBe(EAN_UNIDADE);
    expect(saldo(criado.id)).toBe(10);
  });

  it('caixa tributada em dúzia (10 CX = 20 DZ) e em litro (10 FD = 60 L): o produto fica na unidade da nota', () => {
    const { xml } = nfeXml({
      itens: [
        { cProd: 'OVO', xProd: 'Ovos caixa', uCom: 'CX', qCom: 10, vUnCom: 30, uTrib: 'DZ', qTrib: 20 },
        { cProd: 'AGUA', xProd: 'Agua fardo', uCom: 'FD', qCom: 10, vUnCom: 18, uTrib: 'L', qTrib: 60 },
      ],
    });
    const { noteId } = importar(xml);
    confirmNfe({ companyId, noteId, userId, createMissing: true });
    const criados = getConnection()
      .prepare('SELECT id, name, unit FROM core_products WHERE company_id = ? ORDER BY name')
      .all(companyId) as { id: string; name: string; unit: string }[];
    expect(criados.map((c) => [c.name, c.unit, saldo(c.id)])).toEqual([
      ['Agua fardo', 'FD', 10],
      ['Ovos caixa', 'CX', 10],
    ]);
  });
});

describe('M01 — o fator digitado na linha sem produto não some', () => {
  it('fornecedor que tributa em CX: o conferente digita 12 e o produto nasce em UN com saldo 120', () => {
    const { xml } = nfeXml({ itens: [{ cProd: 'N', xProd: 'Pilha', uCom: 'CX', qCom: 10, vUnCom: 24, uTrib: 'CX', qTrib: 10 }] });
    const { noteId } = importar(xml);
    conferirItem({ companyId, noteId, itemIndex: 0, conversionFactor: 12 });
    confirmNfe({ companyId, noteId, userId, createMissing: true });

    const criado = getConnection()
      .prepare('SELECT id, unit, cost_cents FROM core_products WHERE company_id = ?')
      .get(companyId) as { id: string; unit: string; cost_cents: number };
    expect(criado.unit).toBe('UN');
    expect(criado.cost_cents).toBe(200);
    expect(saldo(criado.id)).toBe(120);
  });

  /*
    REVISÃO: o GTIN tributável da CAIXA não vira o código da UNIDADE. Com uTrib
    = uCom = CX, o `cEANTrib` é o código da caixa; a primeira versão o gravava
    como código principal do produto nascido em UN, e o bipe da caixa fechada
    no balcão valia uma unidade.
  */
  it('uTrib = uCom = CX com o GTIN da caixa nos dois campos: o produto em UN não leva o código da caixa como principal', () => {
    const { xml } = nfeXml({
      itens: [{ cProd: 'N', xProd: 'Pilha', cEAN: DUN_CAIXA, cEANTrib: DUN_CAIXA, uCom: 'CX', qCom: 10, vUnCom: 24, uTrib: 'CX', qTrib: 10 }],
    });
    const { noteId } = importar(xml);
    conferirItem({ companyId, noteId, itemIndex: 0, conversionFactor: 12 });
    confirmNfe({ companyId, noteId, userId, createMissing: true });

    const criado = getConnection()
      .prepare('SELECT id, unit, barcode FROM core_products WHERE company_id = ?')
      .get(companyId) as { id: string; unit: string; barcode: string | null };
    expect(criado.unit).toBe('UN');
    expect(criado.barcode).toBeNull();
    expect(saldo(criado.id)).toBe(120);
    // REVISÃO (PED-ent-01): nem principal nem adicional — este caso esperava 1
    // (adicional), e o bipe da caixa no balcão vendia uma unidade.
    expect(
      contar('SELECT COUNT(*) AS n FROM core_product_barcodes WHERE product_id = ? AND barcode = ?', criado.id, DUN_CAIXA),
    ).toBe(0);
  });

  it('fator digitado que não é o do par tributável (5 KG por caixa, 12 peças): nasce em UN, não em KG', () => {
    const { xml } = nfeXml({
      itens: [{ cProd: 'N', xProd: 'Sabao', cEANTrib: EAN_UNIDADE, uCom: 'CX', qCom: 10, vUnCom: 24, uTrib: 'KG', qTrib: 50 }],
    });
    const { noteId } = importar(xml);
    conferirItem({ companyId, noteId, itemIndex: 0, conversionFactor: 12 });
    confirmNfe({ companyId, noteId, userId, createMissing: true });

    const criado = getConnection()
      .prepare('SELECT id, unit, barcode FROM core_products WHERE company_id = ?')
      .get(companyId) as { id: string; unit: string; barcode: string | null };
    expect(criado.unit).toBe('UN');
    // O EAN do quilo não é o da peça.
    expect(criado.barcode).toBeNull();
    expect(saldo(criado.id)).toBe(120);
  });
});

// ------------------------------------------------------------------ B-08

describe('B-08 — a nota estornada entra de novo com o mesmo XML', () => {
  it('reimportar pede a nova conferência; confirmada, o saldo sobe de novo e a estornada fica no histórico', async () => {
    const cabo = await produto({ name: 'Cabo', barcode: EAN_OUTRO });
    const { xml, chave: k } = nfeXml({ itens: [{ cProd: 'C', xProd: 'Cabo', cEAN: EAN_OUTRO, qCom: 5, vUnCom: 10 }] });
    const primeira = await request(app).post('/api/v1/core/purchases/nfe/import').set(auth).send({ xml });
    await request(app).post(`/api/v1/core/purchases/notes/${primeira.body.noteId}/confirm`).set(auth).send({});
    const estorno = await request(app)
      .post(`/api/v1/core/purchases/notes/${primeira.body.noteId}/estornar`)
      .set(auth)
      .send({ reason: 'vinculado ao produto errado' });
    expect(estorno.status, JSON.stringify(estorno.body)).toBe(200);
    expect(saldo(cabo)).toBe(0);

    const semPedir = await request(app).post('/api/v1/core/purchases/nfe/import').set(auth).send({ xml });
    expect(semPedir.status).toBe(409);
    expect(semPedir.body.error.code).toBe('CORE_NOTE_REVERSED_REOPENABLE');
    expect(semPedir.body.error.message).toMatch(/vinculado ao produto errado/);

    const denovo = await request(app)
      .post('/api/v1/core/purchases/nfe/import')
      .set(auth)
      .send({ xml, reabrirEstornada: true });
    expect(denovo.status, JSON.stringify(denovo.body)).toBe(201);
    expect(denovo.body.noteId).not.toBe(primeira.body.noteId);
    expect(denovo.body.reabriuEstornada).toBe(primeira.body.noteId);

    const conf = await request(app).post(`/api/v1/core/purchases/notes/${denovo.body.noteId}/confirm`).set(auth).send({});
    expect(conf.status, JSON.stringify(conf.body)).toBe(200);
    expect(saldo(cabo)).toBe(5);

    const notas = getConnection()
      .prepare('SELECT id, access_key, status FROM core_inbound_notes WHERE company_id = ? ORDER BY created_at')
      .all(companyId) as { id: string; access_key: string; status: string }[];
    expect(notas).toHaveLength(2);
    expect(notas.find((n) => n.id === primeira.body.noteId)).toMatchObject({ status: 'estornada', access_key: `${k}-estornada-1` });
    expect(notas.find((n) => n.id === denovo.body.noteId)).toMatchObject({ status: 'recebida', access_key: k });
    const titulos = getConnection()
      .prepare("SELECT status FROM core_finance_entries WHERE company_id = ? AND origin_type = 'nfe_entrada' ORDER BY created_at")
      .all(companyId) as { status: string }[];
    expect(titulos.map((t) => t.status)).toEqual(['cancelled', 'open']);
  });
});

// ------------------------------------------------------------------ B-09

describe('B-09 — o custo da entrada leva desconto, frete, IPI e ST', () => {
  it('vProd 100, qCom 10, vDesc 10, vIPI 5: custo 9,50', async () => {
    const p = await produto({ name: 'Lâmpada', barcode: EAN_OUTRO });
    const { xml } = nfeXml({ itens: [{ cProd: 'L', xProd: 'Lampada', cEAN: EAN_OUTRO, qCom: 10, vUnCom: 10, vDesc: 10, vIPI: 5 }] });
    const { noteId } = importar(xml);
    confirmNfe({ companyId, noteId, userId });
    expect(custo(p)).toBe(950);
    const mov = getConnection()
      .prepare("SELECT unit_cost_cents FROM core_stock_movements WHERE reference_id = ? AND movement_type = 'in'")
      .get(noteId) as { unit_cost_cents: number };
    expect(mov.unit_cost_cents).toBe(950);
  });

  it('frete só no total da nota: rateado pelo valor dos produtos', async () => {
    const a = await produto({ name: 'Item A', barcode: EAN_OUTRO });
    const b = await produto({ name: 'Item B', barcode: EAN_UNIDADE });
    const { xml } = nfeXml({
      totalFrete: 40,
      itens: [
        { cProd: 'A', xProd: 'Item A', cEAN: EAN_OUTRO, qCom: 10, vUnCom: 10 },
        { cProd: 'B', xProd: 'Item B', cEAN: EAN_UNIDADE, qCom: 10, vUnCom: 30 },
      ],
    });
    const { noteId } = importar(xml);
    confirmNfe({ companyId, noteId, userId });
    expect(custo(a)).toBe(1100);
    expect(custo(b)).toBe(3300);
  });
});

// ------------------------------------------------------------------ B-10

describe('B-10 — o estado de cada dado fiscal na conferência', () => {
  it('NCM do cadastro diferente do da nota: DIVERGENTE; "SEM GTIN": NÃO APLICÁVEL', async () => {
    const p = await produto({ name: 'Roteador', ncm: '85176277', barcode: EAN_OUTRO });
    const { xml } = nfeXml({
      itens: [
        { cProd: 'R', xProd: 'Roteador', cEAN: EAN_OUTRO, ncm: '85171300', qCom: 1, vUnCom: 100 },
        { cProd: 'S', xProd: 'Sem codigo', qCom: 1, vUnCom: 5 },
      ],
    });
    const { noteId } = importar(xml);
    const [roteador, semCodigo] = listNoteItems(companyId, noteId);
    expect(roteador.productId).toBe(p);
    expect(roteador.fiscal.ncm).toBe('DIVERGENTE');
    expect(roteador.productNcm).toBe('85176277');
    expect(roteador.fiscal.barcode).toBe('CONFIRMADO');
    expect(semCodigo.semGtin).toBe(true);
    expect(semCodigo.fiscal.barcode).toBe('NAO_APLICAVEL');
    expect(semCodigo.fiscal.ncm).toBe('AUTO_DETECTADO');
  });
});

// ------------------------------------------------------------------ B-11

describe('B-11 — o casamento não aceita inativo nem escolhe homônimo', () => {
  it('EAN de um produto inativo: sem vínculo, com o motivo', async () => {
    const p = await produto({ name: 'Antigo', barcode: EAN_OUTRO });
    getConnection().prepare('UPDATE core_products SET active = 0 WHERE id = ?').run(p);
    const { xml } = nfeXml({ itens: [{ cProd: 'X', xProd: 'Qualquer', cEAN: EAN_OUTRO, qCom: 1, vUnCom: 1 }] });
    const r = importar(xml);
    expect(r.items[0].productId).toBeNull();
    expect(r.items[0].matchNote).toMatch(/INATIVO/);
    expect(() => linkNoteItem({ companyId, noteId: r.noteId, itemIndex: 0, productId: p })).toThrow(/inativo/);
  });

  it('dois produtos com o mesmo nome: nenhum é escolhido', async () => {
    await produto({ name: 'Cabo USB' });
    await produto({ name: 'Cabo USB' });
    const { xml } = nfeXml({ itens: [{ cProd: 'U', xProd: 'Cabo USB', qCom: 1, vUnCom: 1 }] });
    const r = importar(xml);
    expect(r.items[0].productId).toBeNull();
    expect(r.items[0].matchNote).toMatch(/mais de um produto/);
  });
});

// ------------------------------------------------------------------ B-13

describe('B-13 — o ajuste de saldo manual tem rótulo próprio', () => {
  it('adjust +3 pela tela: MANUAL_ADJUSTMENT_POSITIVE, "Ajuste manual de saldo (+)"', async () => {
    const p = await produto({ name: 'Fita' });
    // Com motivo: desde a reauditoria do B-13, o ajuste positivo também o exige
    // (caso seguinte).
    const res = await request(app).post('/api/v1/core/stock/movements').set(auth).send({
      productId: p,
      movementType: 'adjust',
      quantity: 3,
      referenceType: 'ajuste',
      referenceId: 'ajuste-b13',
      reason: 'Três rolos achados atrás da gôndola',
    });
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    const mov = getConnection()
      .prepare('SELECT kind FROM core_stock_movements WHERE reference_id = ?')
      .get('ajuste-b13') as { kind: string };
    expect(mov.kind).toBe('MANUAL_ADJUSTMENT_POSITIVE');
    const tipos = await request(app).get('/api/v1/core/stock/movement-kinds').set(auth);
    const rotulo = (tipos.body.items as { kind: string; label: string }[]).find((k) => k.kind === 'MANUAL_ADJUSTMENT_POSITIVE');
    expect(rotulo?.label).toBe('Ajuste manual de saldo (+)');
  });

  /*
    B-13#reauditoria — a metade que faltava: o ajuste POSITIVO sem motivo
    passava (a rota só exigia motivo na saída e no ajuste negativo), e o +20 sem
    uma palavra virava sobra sem explicação. Sem o conserto, este caso dá 201.
  */
  it('adjust +20 sem motivo é recusado com CORE_REASON_REQUIRED, e nada entra no estoque', async () => {
    const p = await produto({ name: 'Fita larga' });
    const res = await request(app).post('/api/v1/core/stock/movements').set(auth).send({
      productId: p,
      movementType: 'adjust',
      quantity: 20,
      referenceType: 'ajuste',
      referenceId: 'ajuste-b13-mudo',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CORE_REASON_REQUIRED');
    expect(saldo(p)).toBe(0);
    expect(contar("SELECT COUNT(*) AS n FROM core_stock_movements WHERE reference_id = 'ajuste-b13-mudo'")).toBe(0);

    // A entrada avulsa, que é mercadoria que CHEGOU, continua sem motivo.
    const entrada = await request(app).post('/api/v1/core/stock/movements').set(auth).send({
      productId: p,
      movementType: 'in',
      quantity: 20,
      referenceType: 'entrada',
      referenceId: 'entrada-b13',
    });
    expect(entrada.status, JSON.stringify(entrada.body)).toBe(201);
    expect(saldo(p)).toBe(20);
  });
});

// ----------------------------------------------------------- B-14 / B-21

describe('B-14 — o estorno devolve o custo de antes', () => {
  it('custo 5,00; nota com custo 50,00 confirmada e estornada: volta a 5,00', async () => {
    const p = await produto({ name: 'Disjuntor', barcode: EAN_OUTRO, costCents: 500 });
    const { xml } = nfeXml({ itens: [{ cProd: 'D', xProd: 'Disjuntor', cEAN: EAN_OUTRO, qCom: 2, vUnCom: 50 }] });
    const { noteId } = importar(xml);
    confirmNfe({ companyId, noteId, userId });
    expect(custo(p)).toBe(5000);

    const r = estornarNota({ companyId, noteId, userId, reason: 'custo errado' });
    expect(r.custosRestaurados).toBe(1);
    expect(custo(p)).toBe(500);
  });
});

describe('B-21 — o estorno não passa por cima do reservado', () => {
  it('10 da nota e 6 reservados: recusa nomeando a reserva, e nada muda', async () => {
    const p = await produto({ name: 'Ventilador', barcode: EAN_OUTRO });
    const { xml } = nfeXml({ itens: [{ cProd: 'V', xProd: 'Ventilador', cEAN: EAN_OUTRO, qCom: 10, vUnCom: 50 }] });
    const { noteId } = importar(xml);
    confirmNfe({ companyId, noteId, userId });
    reserveStock({
      companyId,
      productId: p,
      quantity: 6,
      referenceType: 'pre_venda',
      referenceId: 'pv-b21',
      documentNumber: 'Pré-venda #7',
    });

    expect(() => estornarNota({ companyId, noteId, userId, reason: 'nota errada' })).toThrow(/reservado.*Pré-venda #7/);
    expect(saldo(p)).toBe(10);
  });
});

// ------------------------------------------------------------ B-16 / B-17

describe('B-16 — o inventário aceita o bipe', () => {
  it('três bipes do EAN somam 3; o código adicional também acha; o produto fora da lista entra', async () => {
    const p = await produto({ name: 'Pilha AA', barcode: EAN_OUTRO });
    const fora = await produto({ name: 'Pilha AAA', barcode: EAN_UNIDADE });
    addProductBarcode(companyId, p, DUN_CAIXA);
    const aberta = await request(app).post('/api/v1/core/inventory-counts').set(auth).send({ productIds: [p] });
    expect(aberta.status, JSON.stringify(aberta.body)).toBe(201);
    const bipar = (codigo: string) =>
      request(app).post(`/api/v1/core/inventory-counts/${aberta.body.id}/items`).set(auth).send({ barcode: codigo, increment: 1 });

    await bipar(EAN_OUTRO);
    await bipar(EAN_OUTRO);
    const terceira = await bipar(DUN_CAIXA);
    expect(terceira.status, JSON.stringify(terceira.body)).toBe(200);
    const item = (terceira.body.items as { product_id: string; counted_quantity: number; extra_barcodes: string }[]).find(
      (i) => i.product_id === p,
    );
    expect(item?.counted_quantity).toBe(3);
    expect(item?.extra_barcodes).toContain(DUN_CAIXA);

    const foraDaLista = await bipar(EAN_UNIDADE);
    expect(foraDaLista.status).toBe(200);
    expect((foraDaLista.body.items as { product_id: string }[]).some((i) => i.product_id === fora)).toBe(true);

    const desconhecido = await bipar(gtin('789000000000'));
    expect(desconhecido.status).toBe(404);
  });
});

describe('B-17 — a contagem não aceita produto alheio nem modelo de grade', () => {
  it('produto de outra empresa: 404 e nenhuma linha; modelo de grade: 400', async () => {
    const outra = await loginForTest(app, { userId: 'gerente-outra', companyId: 'loja-outra-pj', profileCodes: ['gerente_loja'] });
    const alheio = await request(app)
      .post('/api/v1/core/products')
      .set({ Authorization: `Bearer ${outra.body.accessToken}` })
      .send({ name: 'Produto da Gringa', priceCents: 100 });
    const nosso = await produto({ name: 'Nosso' });
    const aberta = await request(app).post('/api/v1/core/inventory-counts').set(auth).send({ productIds: [nosso] });

    const res = await request(app)
      .post(`/api/v1/core/inventory-counts/${aberta.body.id}/items`)
      .set(auth)
      .send({ productId: alheio.body.id, countedQuantity: 5 });
    expect(res.status).toBe(404);
    expect(contar('SELECT COUNT(*) AS n FROM core_inventory_count_items WHERE count_id = ?', aberta.body.id)).toBe(1);

    const modelo = await produto({ name: 'Camiseta (modelo)' });
    const variante = await produto({ name: 'Camiseta P' });
    getConnection().prepare('UPDATE core_products SET parent_id = ? WHERE id = ?').run(modelo, variante);
    const grade = await request(app)
      .post(`/api/v1/core/inventory-counts/${aberta.body.id}/items`)
      .set(auth)
      .send({ productId: modelo, countedQuantity: 2 });
    expect(grade.status).toBe(400);
    expect(grade.body.error.code).toBe('CORE_PRODUCT_IS_GRID_MODEL');
  });
});

// ------------------------------------------------------------------ B-18

describe('B-18 — o fator sem a quantidade não grava "chegou tudo"', () => {
  it('conferir só com conversionFactor mantém a contagem nula', async () => {
    const { xml } = nfeXml({ itens: [{ cProd: 'F', xProd: 'Fusivel', uCom: 'CX', qCom: 2, vUnCom: 10 }] });
    const { noteId } = importar(xml);
    const res = await request(app)
      .post(`/api/v1/core/purchases/notes/${noteId}/conferir`)
      .set(auth)
      .send({ itemIndex: 0, conversionFactor: 10 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.items[0].receivedQuantity).toBeNull();
    expect(res.body.items[0].conversionFactor).toBe(10);
  });
});

// ------------------------------------------------------------------ B-19

describe('B-19 — o fator que alguém já deu é lembrado para o item do fornecedor', () => {
  it('UND contra UN: declarado uma vez, a próxima nota do mesmo fornecedor entra sem digitação', async () => {
    const p = await produto({ name: 'Esponja', unit: 'UN' });
    const primeira = importar(nfeXml({ itens: [{ cProd: 'ESP-1', xProd: 'ESPONJA DUPLA', uCom: 'UND', qCom: 5, vUnCom: 2 }] }).xml);
    linkNoteItem({ companyId, noteId: primeira.noteId, itemIndex: 0, productId: p });
    expect(() => confirmNfe({ companyId, noteId: primeira.noteId, userId })).toThrow(/unidade diferente/);
    conferirItem({ companyId, noteId: primeira.noteId, itemIndex: 0, conversionFactor: 1 });
    confirmNfe({ companyId, noteId: primeira.noteId, userId });

    const segunda = importar(nfeXml({ itens: [{ cProd: 'ESP-1', xProd: 'ESPONJA DUPLA', uCom: 'UND', qCom: 7, vUnCom: 2 }] }).xml);
    expect(segunda.items[0].productId).toBe(p);
    expect(listNoteItems(companyId, segunda.noteId)[0].resolvedFactor).toBe(1);
    confirmNfe({ companyId, noteId: segunda.noteId, userId });
    expect(saldo(p)).toBe(12);
    // A declaração tem autor e data na trilha, com a unidade do cadastro de então (R02).
    expect(
      contar(
        "SELECT COUNT(*) AS n FROM core_audit_log WHERE action = 'purchase.note_item.factor_declared' AND json_extract(detail, '$.unidadeDoCadastro') = 'UN'",
      ),
    ).toBe(1);
  });

  /*
    B-estoque-entrada-R02: o "1" que a confirmação grava sozinha (B-04) quando a
    nota e o cadastro estão na MESMA unidade era reaproveitado como fator
    aprendido. Sem o conserto, a quarta nota (10 CX de 12, com o produto já em
    UN) entra como 10 UN — resolvedFactor 1 e saldo 40.
  */
  it('o fator automático não é aprendido: Pilha AA em CX, três notas em CX, o produto passa para UN — a nota em CX é recusada', async () => {
    const p = await produto({ name: 'Pilha AA', unit: 'CX' });
    const linha = { cProd: 'PIL-AA', xProd: 'PILHA AA', uCom: 'CX', vUnCom: 24, uTrib: 'CX' };
    for (let n = 0; n < 3; n += 1) {
      const nota = importar(nfeXml({ itens: [{ ...linha, qCom: 10, qTrib: 10 }] }).xml);
      if (!nota.items[0].productId) linkNoteItem({ companyId, noteId: nota.noteId, itemIndex: 0, productId: p });
      confirmNfe({ companyId, noteId: nota.noteId, userId });
      // O B-04 continua: o fator resolvido fica na linha, para o pedido.
      expect(listNoteItems(companyId, nota.noteId)[0].conversionFactor).toBe(1);
    }
    expect(saldo(p)).toBe(30);
    // Ninguém declarou fator nenhum: nada foi para a trilha como declaração.
    expect(contar("SELECT COUNT(*) AS n FROM core_audit_log WHERE action = 'purchase.note_item.factor_declared'")).toBe(0);

    // O gerente passa a pilha para UN, para vender por unidade, sem preencher a embalagem.
    getConnection().prepare("UPDATE core_products SET unit = 'UN' WHERE id = ?").run(p);

    const quarta = importar(nfeXml({ itens: [{ ...linha, qCom: 10, qTrib: 10 }] }).xml);
    expect(quarta.items[0].productId).toBe(p);
    expect(listNoteItems(companyId, quarta.noteId)[0].resolvedFactor).toBeNull();
    expect(() => confirmNfe({ companyId, noteId: quarta.noteId, userId })).toThrow(/unidade diferente/);
    expect(saldo(p)).toBe(30);

    // Quem está com a caixa na mão responde, e aí entra certo.
    conferirItem({ companyId, noteId: quarta.noteId, itemIndex: 0, conversionFactor: 12 });
    confirmNfe({ companyId, noteId: quarta.noteId, userId });
    expect(saldo(p)).toBe(150);
    expect(custo(p)).toBe(200);
  });

  it('o fator declarado contra OUTRA unidade do cadastro não vale: "1 UND = 1 UN" não responde UND contra CX', async () => {
    const p = await produto({ name: 'Esponja', unit: 'UN' });
    const primeira = importar(nfeXml({ itens: [{ cProd: 'ESP-1', xProd: 'ESPONJA DUPLA', uCom: 'UND', qCom: 5, vUnCom: 2 }] }).xml);
    linkNoteItem({ companyId, noteId: primeira.noteId, itemIndex: 0, productId: p });
    conferirItem({ companyId, noteId: primeira.noteId, itemIndex: 0, conversionFactor: 1 });
    confirmNfe({ companyId, noteId: primeira.noteId, userId });
    expect(saldo(p)).toBe(5);

    // O cadastro passa a ser em caixa: a resposta "1" era para UN, não para CX.
    getConnection().prepare("UPDATE core_products SET unit = 'CX' WHERE id = ?").run(p);
    const segunda = importar(nfeXml({ itens: [{ cProd: 'ESP-1', xProd: 'ESPONJA DUPLA', uCom: 'UND', qCom: 7, vUnCom: 2 }] }).xml);
    expect(segunda.items[0].productId).toBe(p);
    expect(listNoteItems(companyId, segunda.noteId)[0].resolvedFactor).toBeNull();
    expect(() => confirmNfe({ companyId, noteId: segunda.noteId, userId })).toThrow(/unidade diferente/);
    expect(saldo(p)).toBe(5);
  });

  /*
    REVISÃO do R02: `core_audit_log` só tem índice por (empresa, data). O JOIN
    direto com a trilha (`a.entity_id = i.id`) a varria INTEIRA a cada linha sem
    fator — medido: 300 mil registros na trilha, nota de 60 linhas "UND", 22 s
    para ler e 28 s para confirmar. A busca agora fica presa à janela da
    confirmação da nota anterior, pelo índice. Sem o conserto, o plano da
    consulta diz "SCAN a" (a trilha inteira).
  */
  it('a busca do fator declarado vai pelo índice da trilha (empresa, data), sem varrer a trilha inteira', async () => {
    const p = await produto({ name: 'Esponja', unit: 'UN' });
    const primeira = importar(nfeXml({ itens: [{ cProd: 'ESP-1', xProd: 'ESPONJA DUPLA', uCom: 'UND', qCom: 5, vUnCom: 2 }] }).xml);
    linkNoteItem({ companyId, noteId: primeira.noteId, itemIndex: 0, productId: p });
    conferirItem({ companyId, noteId: primeira.noteId, itemIndex: 0, conversionFactor: 1 });
    confirmNfe({ companyId, noteId: primeira.noteId, userId });

    // A trilha de uma loja com meses de uso: vinte mil registros de outras coisas.
    const db = getConnection();
    const inserir = db.prepare(
      `INSERT INTO core_audit_log (id, company_id, user_id, action, entity_type, entity_id, detail, ip, created_at)
       VALUES (?, ?, ?, 'sale.created', 'sale', ?, NULL, NULL, ?)`,
    );
    db.exec('BEGIN');
    for (let i = 0; i < 20_000; i += 1) {
      inserir.run(`trilha-r02-${i}`, companyId, userId, `venda-r02-${i}`, new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString());
    }
    db.exec('COMMIT');
    db.exec('ANALYZE');

    const segunda = importar(nfeXml({ itens: [{ cProd: 'ESP-1', xProd: 'ESPONJA DUPLA', uCom: 'UND', qCom: 7, vUnCom: 2 }] }).xml);
    const consultas: string[] = [];
    const preparar = db.prepare.bind(db);
    const espiao = vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
      consultas.push(sql);
      return preparar(sql);
    }) as typeof db.prepare);
    try {
      // O fator declarado continua sendo achado (o comportamento do B-19 não muda).
      expect(listNoteItems(companyId, segunda.noteId)[0].resolvedFactor).toBe(1);
    } finally {
      espiao.mockRestore();
    }
    const doAprendido = consultas.find((sql) => sql.includes('core_audit_log') && sql.includes('conversion_factor'));
    expect(doAprendido, 'a consulta do fator aprendido não foi feita').toBeTruthy();
    const marcadores = ((doAprendido as string).match(/\?/g) ?? []).length;
    const plano = (db.prepare(`EXPLAIN QUERY PLAN ${doAprendido}`).all(...Array(marcadores).fill(null)) as { detail: string }[])
      .map((r) => r.detail)
      .join(' | ');
    expect(plano).not.toMatch(/SCAN a\b/);
    // A subconsulta correlata aparece como "SEARCH a EXISTS USING INDEX …".
    expect(plano).toMatch(/SEARCH a\b[^|]*USING INDEX ix_audit_company \(company_id=\? AND created_at/);
  });
});

// ------------------------------------------------------------------ M04

describe('M04 — o código que já é de um modelo de grade é nomeado antes de gravar', () => {
  it('a leitura mostra o motivo, e a confirmação recusa citando a linha, sem criar produto', async () => {
    const modelo = await produto({ name: 'Camiseta Básica', barcode: EAN_OUTRO });
    const variante = await produto({ name: 'Camiseta Básica P' });
    getConnection().prepare('UPDATE core_products SET parent_id = ? WHERE id = ?').run(modelo, variante);
    const { xml } = nfeXml({
      itens: [
        { cProd: 'OK', xProd: 'Meia', qCom: 1, vUnCom: 5 },
        { cProd: 'CAM', xProd: 'CAMISETA BASICA', cEAN: EAN_OUTRO, qCom: 3, vUnCom: 20 },
      ],
    });
    const { noteId } = importar(xml);
    expect(listNoteItems(companyId, noteId)[1].matchNote).toMatch(/modelo de grade/);

    const antes = contar('SELECT COUNT(*) AS n FROM core_products WHERE company_id = ?', companyId);
    expect(() => confirmNfe({ companyId, noteId, userId, createMissing: true })).toThrow(/CAMISETA BASICA.*variante/);
    expect(contar('SELECT COUNT(*) AS n FROM core_products WHERE company_id = ?', companyId)).toBe(antes);
  });
});

// ------------------------------------------------------------- PED-ent-01

/*
  O DUN-14 DA CAIXA NÃO VIRA CÓDIGO DO PRODUTO EM UN. Sem o conserto, a
  confirmação grava o código da caixa em `core_product_barcodes`, a busca do
  PDV acha o produto por ele e o bipe da caixa de 12 vende 1.
*/
describe('PED-ent-01 — o código da caixa não entra no cadastro da unidade', () => {
  it('cEAN = DUN-14 da caixa e cEANTrib = EAN da unidade: o PDV acha pela unidade, não pela caixa', async () => {
    const { xml } = nfeXml({
      itens: [{ cProd: 'SAB-12', xProd: 'Sabonete', cEAN: DUN_CAIXA, cEANTrib: EAN_UNIDADE, uCom: 'CX', qCom: 10, vUnCom: 60, uTrib: 'UN', qTrib: 120 }],
    });
    const { noteId } = importar(xml);
    confirmNfe({ companyId, noteId, userId, createMissing: true });

    const criado = getConnection()
      .prepare('SELECT id, unit, barcode FROM core_products WHERE company_id = ?')
      .get(companyId) as { id: string; unit: string; barcode: string };
    expect(criado.unit).toBe('UN');
    expect(criado.barcode).toBe(EAN_UNIDADE);
    expect(contar('SELECT COUNT(*) AS n FROM core_product_barcodes WHERE company_id = ?', companyId)).toBe(0);

    const pelaCaixa = await request(app).get('/api/v1/core/products/search').query({ q: DUN_CAIXA }).set(auth);
    expect(pelaCaixa.status, JSON.stringify(pelaCaixa.body)).toBe(200);
    expect((pelaCaixa.body.items as { id: string }[]).some((p) => p.id === criado.id)).toBe(false);

    const pelaUnidade = await request(app).get('/api/v1/core/products/search').query({ q: EAN_UNIDADE }).set(auth);
    expect(pelaUnidade.status).toBe(200);
    expect((pelaUnidade.body.items as { id: string }[])[0]?.id).toBe(criado.id);
  });

  it('a próxima nota do mesmo fornecedor casa pelo de-para — o código da caixa não faz falta', () => {
    // uTrib = uCom = CX, o DUN nos dois campos: o produto nasce em UN sem código nenhum.
    const linha = { cProd: 'PIL-12', xProd: 'Pilha', cEAN: DUN_CAIXA, cEANTrib: DUN_CAIXA, uCom: 'CX', vUnCom: 24, uTrib: 'CX' };
    const primeira = importar(nfeXml({ itens: [{ ...linha, qCom: 10, qTrib: 10 }] }).xml);
    conferirItem({ companyId, noteId: primeira.noteId, itemIndex: 0, conversionFactor: 12 });
    confirmNfe({ companyId, noteId: primeira.noteId, userId, createMissing: true });
    const criado = getConnection()
      .prepare('SELECT id FROM core_products WHERE company_id = ?')
      .get(companyId) as { id: string };

    const segunda = importar(nfeXml({ itens: [{ ...linha, qCom: 5, qTrib: 5 }] }).xml);
    expect(segunda.items[0].productId).toBe(criado.id);
    expect(segunda.items[0].matchedBy).toBe('supplier_code');
    // O fator 12 que o conferente deu para este item do fornecedor é lembrado (B-19).
    confirmNfe({ companyId, noteId: segunda.noteId, userId });
    expect(saldo(criado.id)).toBe(180);
  });
});

// ------------------------------------------------------ B-03 (complemento)

/*
  A REMESSA SEM ÔNUS NÃO REESCREVE O CUSTO. Sem o conserto, a bonificação
  declarada a 0,00 zera o custo do produto (e puxa o custo médio para a metade);
  a declarada a 12,50 faz o produto custar 12,50.
*/
describe('B-03 (complemento) — bonificação, amostra e consignação não mexem no custo', () => {
  function custoDoRazao(noteId: string): number | null {
    return (
      getConnection()
        .prepare("SELECT unit_cost_cents FROM core_stock_movements WHERE reference_id = ? AND movement_type = 'in'")
        .get(noteId) as { unit_cost_cents: number | null }
    ).unit_cost_cents;
  }

  it('custo 10,00; bonificação de 10 a 0,00: saldo sobe, custo e custo médio continuam 10,00', async () => {
    const p = await produto({ name: 'Shampoo', barcode: EAN_OUTRO, costCents: 1000 });
    const compra = importar(nfeXml({ itens: [{ cProd: 'SH', xProd: 'Shampoo', cEAN: EAN_OUTRO, qCom: 10, vUnCom: 10 }] }).xml);
    confirmNfe({ companyId, noteId: compra.noteId, userId });
    expect(custoMedioPorProduto(companyId).get(p)).toBe(1000);

    const brinde = importar(
      nfeXml({ itens: [{ cProd: 'SH', xProd: 'Shampoo', cEAN: EAN_OUTRO, cfop: '5910', qCom: 10, vUnCom: 0 }] }).xml,
    );
    confirmNfe({ companyId, noteId: brinde.noteId, userId });

    expect(saldo(p)).toBe(20);
    expect(custo(p)).toBe(1000);
    // O razão não afirma custo pago (nulo, não zero): o zero entraria na média
    // móvel e diria que o shampoo passou a custar 5,00.
    expect(custoDoRazao(brinde.noteId)).toBeNull();
    expect(custoMedioPorProduto(companyId).get(p)).toBe(1000);
  });

  it('bonificação com valor de referência (CFOP 6910 a 12,50): o custo do cadastro fica', async () => {
    const p = await produto({ name: 'Condicionador', barcode: EAN_OUTRO, costCents: 1000 });
    const { noteId } = importar(
      nfeXml({ itens: [{ cProd: 'CD', xProd: 'Condicionador', cEAN: EAN_OUTRO, cfop: '6910', qCom: 4, vUnCom: 12.5 }] }).xml,
    );
    confirmNfe({ companyId, noteId, userId });
    expect(saldo(p)).toBe(4);
    expect(custo(p)).toBe(1000);
    expect(
      contar("SELECT COUNT(*) AS n FROM core_audit_log WHERE action = 'product.cost_changed' AND entity_id = ?", p),
    ).toBe(0);
  });

  it('o mesmo produto numa linha paga e numa de brinde (o brinde por último): vale o custo da paga', async () => {
    const p = await produto({ name: 'Creme', barcode: EAN_OUTRO, costCents: 500 });
    const { noteId } = importar(
      nfeXml({
        itens: [
          { cProd: 'CR', xProd: 'Creme', cEAN: EAN_OUTRO, cfop: '5102', qCom: 10, vUnCom: 8 },
          { cProd: 'CR', xProd: 'Creme', cEAN: EAN_OUTRO, cfop: '5910', qCom: 2, vUnCom: 0 },
        ],
      }).xml,
    );
    confirmNfe({ companyId, noteId, userId });
    expect(saldo(p)).toBe(12);
    expect(custo(p)).toBe(800);
    expect(custoDoRazao(noteId)).toBe(800);
  });

  it('o produto que a bonificação cadastra nasce sem custo, e não com o valor declarado', () => {
    const { noteId } = importar(nfeXml({ itens: [{ cProd: 'AM', xProd: 'Amostra de perfume', cfop: '5911', qCom: 3, vUnCom: 12.5 }] }).xml);
    confirmNfe({ companyId, noteId, userId, createMissing: true });
    const criado = getConnection()
      .prepare('SELECT id, cost_cents FROM core_products WHERE company_id = ?')
      .get(companyId) as { id: string; cost_cents: number };
    expect(criado.cost_cents).toBe(0);
    expect(saldo(criado.id)).toBe(3);
  });
});

// ------------------------------------------------------ B-04 (complemento)

/*
  A RELEITURA DAS NOTAS RECEBIDAS COMPLETA O FATOR. Sem o conserto, a rota
  reler-notas não chama `completarFatoresDasNotasRecebidas` e o pedido amarrado à
  nota antiga continua com as 10 caixas contadas como 10 unidades.
*/
describe('B-04 (complemento) — POST reler-notas completa o fator das notas antigas', () => {
  it('nota recebida sem fator ganha 12, e o pedido amarrado passa de 10 para 120', async () => {
    const parafuso = await produto({ name: 'Parafuso', unit: 'UN', barcode: EAN_UNIDADE });
    const forn = await request(app)
      .post('/api/v1/core/suppliers')
      .set(auth)
      .send({ name: 'Distribuidora da Auditoria Ltda', document: CNPJ_FORNECEDOR });
    expect(forn.status, JSON.stringify(forn.body)).toBe(201);
    const pedido = createPurchaseOrder({
      companyId,
      userId,
      supplierId: forn.body.id,
      items: [{ productId: parafuso, quantity: 120, unitCostCents: 50 }],
    });
    const { xml } = nfeXml({
      itens: [{ cProd: 'P', xProd: 'Parafuso cx', cEAN: DUN_CAIXA, cEANTrib: EAN_UNIDADE, uCom: 'CX', qCom: 10, vUnCom: 6, uTrib: 'UN', qTrib: 120 }],
    });
    const { noteId } = importar(xml);
    linkNoteToOrder(companyId, noteId, String(pedido.id));
    confirmNfe({ companyId, noteId, userId });

    // O retrato de uma nota confirmada antes da correção: fator nulo e o pedido contando caixas.
    getConnection().prepare('UPDATE core_inbound_note_items SET conversion_factor = NULL WHERE note_id = ?').run(noteId);
    getConnection()
      .prepare('UPDATE core_purchase_order_items SET received_quantity = 10 WHERE order_id = ?')
      .run(String(pedido.id));

    const res = await request(app).post('/api/v1/core/fiscal/classification/reler-notas').set(auth);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ fatoresCompletados: 1, pedidosRecalculados: 1 });
    expect(listNoteItems(companyId, noteId)[0].conversionFactor).toBe(12);
    const itemDoPedido = getConnection()
      .prepare('SELECT received_quantity FROM core_purchase_order_items WHERE order_id = ?')
      .get(String(pedido.id)) as { received_quantity: number };
    expect(itemDoPedido.received_quantity).toBe(120);
    // O estoque não anda: a releitura corrige o registro, não dá entrada de novo.
    expect(saldo(parafuso)).toBe(120);

    const segunda = await request(app).post('/api/v1/core/fiscal/classification/reler-notas').set(auth);
    expect(segunda.body).toMatchObject({ fatoresCompletados: 0, pedidosRecalculados: 0 });
  });
});
