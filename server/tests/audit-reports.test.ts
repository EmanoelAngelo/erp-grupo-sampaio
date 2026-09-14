/**
 * ============================================================================
 * AUDITORIA — FASE 17: RELATÓRIO = BANCO
 * ============================================================================
 *
 * Um cenário CONHECIDO, no centavo, atravessando módulos — e cada relatório
 * cobrado contra a aritmética do cenário E contra consulta SQL direta no
 * banco de auditoria. Nada aqui presume que funciona; a pergunta é sempre
 * "o número da tela é o número do que aconteceu?".
 *
 * O CENÁRIO (uma empresa, preco-justo):
 *
 *   Produtos: P1 Bicicleta 12.345 (custo cadastrado 6.000, mínimo 2)
 *             P2 Capacete  6.789 (custo 2.500, mínimo 8)
 *   Carga inicial: 10 de cada (movimento manual).
 *   COMPRA por NF-e: 5×P1 a 7.000 = 35.000 — estoque +5, dívida 35.000 e o
 *   custo do cadastro REESCRITO para 7.000 (regra da casa: o custo é o da
 *   última carga que entrou).
 *
 *   3 VENDAS em 3 DIAS DA LOJA diferentes, carimbadas NAS BORDAS de
 *   propósito (a loja é UTC-3; o dia D vai de D 03:00Z a D+1 02:59:59.999Z):
 *     V1  2026-06-08 às 23:59:59 da loja (06-09T02:59:59Z)  2×P1 = 24.690
 *     V2  2026-06-09 às 00:00:00 da loja (06-09T03:00:00Z)  1×P2 =  6.789
 *     V3  2026-06-10 meio-dia                         1×P1+2×P2 = 25.923
 *     período: 57.402 / 3 vendas / ticket 19.134 (exato)
 *
 *   1 DEVOLUÇÃO em dinheiro no dia 10: 1×P1 da V1 = 12.345.
 *
 *   Estoque final: P1 = 10+5−2−1+1 = 13 (ok) | P2 = 10−1−2 = 7 (< mínimo 8)
 *   DRE de junho:  receita 57.402 − despesa (35.000 compra + 12.345
 *   devolução) = 10.057.
 *
 * O carimbo retroativo é o mecanismo da casa (audit-dashboard.test.ts): a
 * venda NASCE pela rota (estoque baixado, financeiro lançado) e só o QUANDO é
 * encenado — aqui de forma COERENTE (venda + lançamento + movimento juntos,
 * com a competência no DIA DA LOJA do instante, que é o que a produção
 * PROMETE gravar).
 *
 * O QUE JÁ TEM DONO (não duplicado — status COBERTO_EXISTENTE no relatório):
 *   - filtro por empresa na lista/painel ... audit-dashboard.test.ts
 *   - corte fino de fuso (21h30) ........... o-dia-do-relatorio-e-o-dia-da-loja.test.ts
 *   - aritmética interna do DRE ............ dre-competencia.test.ts
 *   - razão=saldo=rota do estoque .......... audit-inventory.test.ts
 *   - paginação da trilha de auditoria ..... auditoria-tem-leitor.test.ts
 *   - estrutura/peneira do pacote do contador fechamento-contador.test.ts
 *   - insights sem recorte de data ......... bi-grupo.test.ts
 *
 * O ÚLTIMO describe nasceu VERMELHO DE PROPÓSITO — três defeitos reais de
 * produção, cada um com a reprodução no próprio caso. Os três foram
 * CONSERTADOS e os casos ficam como registro executável (e trava de
 * regressão) do que a auditoria achou:
 *
 *   1. GET /core/sales TRUNCAVA EM 200 EM SILÊNCIO: `listSales` tinha
 *      `LIMIT ?` com padrão 200 e a rota não repassava limit/offset nem
 *      devolvia total — num dia com 205 vendas o painel afirmava 205.000 e a
 *      lista somava 200.000. Hoje a rota aceita ?limit (teto 500) e ?offset,
 *      e o corpo devolve `total` do recorte: o corte existe, mas é declarado,
 *      e paginando se chega ao dia inteiro.
 *
 *   2. A DEVOLUÇÃO DOS INSIGHTS ERA ATRIBUÍDA AO DIA DA VENDA, NÃO AO DIA EM
 *      QUE ACONTECEU: `operationsOverview` filtrava `core_sale_returns` por
 *      `s.created_at` (a venda), enquanto o DRE lança a devolução na
 *      competência do FATO. Para o MESMO recorte, o DRE deduzia 12.345 e o BI
 *      respondia devoluções 0. Hoje o recorte é por `r.created_at` — a mesma
 *      régua do DRE.
 *
 *   3. A COMPETÊNCIA DA VENDA NOTURNA CAÍA NO DIA DE GREENWICH: SalesService
 *      gravava `competence_date = now.slice(0, 10)` — a data UTC — logo
 *      abaixo do comentário "venda de hoje compete hoje"; SaleReturnService e
 *      NfeImportService repetiam o corte. Toda venda entre 21h e meia-noite
 *      da loja competia o dia SEGUINTE; na virada do mês, o DRE (e o dre.csv
 *      do pacote do contador) escriturava a receita no mês errado. Hoje os
 *      três escritores usam `diaDaLoja` (CalendarioOperacional) — a mesma
 *      régua que o painel, a lista e o pacote já usavam para LER.
 */
process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';

import { randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { getConnection } from '../src/db/sqlite.js';
import { resetDbForTests } from '../src/db/database.js';
import {
  linkUserToCompany,
  upsertCompany,
  upsertUser,
} from '../src/services/auth/IdentityService.js';

const app = createApp();
const SENHA = 'Relatorio@Auditoria2026';

/** Os três dias da loja do cenário — e os instantes UTC nas bordas. */
const D1 = '2026-06-08';
const D2 = '2026-06-09';
const D3 = '2026-06-10';
/** 23:59:59 do D1 na loja (UTC-3): último segundo do dia. */
const V1_INSTANTE = '2026-06-09T02:59:59.000Z';
/** 00:00:00 do D2 na loja: primeiro segundo do dia. */
const V2_INSTANTE = '2026-06-09T03:00:00.000Z';
const V3_INSTANTE = '2026-06-10T15:00:00.000Z';
const COMPRA_INSTANTE = '2026-06-09T15:00:00.000Z';
const DEVOLUCAO_INSTANTE = '2026-06-10T16:00:00.000Z';

/** CNPJ do <emit> — o mesmo do fornecedor cadastrado, como em audit-purchase. */
const CNPJ_FORNECEDOR = '14200166000187';

interface Ator {
  auth: { Authorization: string };
  userId: string;
}

/** Usuário real, senha Argon2id, login real — o idioma da casa. */
async function ator(login: string, vinculos: [string, string][]): Promise<Ator> {
  const userId = await upsertUser({ login, displayName: login, password: SENHA });
  for (const [companyId, profile] of vinculos) {
    linkUserToCompany(userId, companyId, profile, false);
  }
  const res = await request(app)
    .post('/api/v1/auth/login')
    .send({ login, password: SENHA, companyId: vinculos[0][0] });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { auth: { Authorization: `Bearer ${res.body.accessToken}` }, userId };
}

let precoJusto: string;

beforeEach(() => {
  resetDbForTests();
  precoJusto = upsertCompany({
    slug: 'preco-justo',
    legalName: 'Preço Justo Comércio Ltda',
    tradeName: 'Preço Justo',
    kind: 'retail',
  });
});

afterEach(() => {
  vi.useRealTimers();
});

const gerente = () => ator('GERENTE.RELATORIO', [[precoJusto, 'gerente_loja']]);

// ---------------------------------------------------------------- ferramentas

async function criarProduto(
  auth: Ator['auth'],
  nome: string,
  precoCents: number,
  custoCents: number,
  minStock: number,
): Promise<string> {
  const res = await request(app)
    .post('/api/v1/core/products')
    .set(auth)
    .send({ name: nome, priceCents: precoCents, costCents: custoCents, minStock });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

async function entradaEstoque(auth: Ator['auth'], productId: string, quantidade: number) {
  const res = await request(app).post('/api/v1/core/stock/movements').set(auth).send({
    productId,
    movementType: 'in',
    quantity: quantidade,
    referenceType: 'entrada',
    referenceId: `carga-${productId}`,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
}

/** Venda pela ROTA, dinheiro exato — o total conferido no centavo NA ORIGEM. */
async function vender(
  auth: Ator['auth'],
  itens: { productId: string; quantity: number }[],
  totalEsperadoCents: number,
): Promise<string> {
  const res = await request(app)
    .post('/api/v1/core/sales')
    .set(auth)
    .set('Idempotency-Key', randomUUID())
    .send({ items: itens, payments: [{ method: 'dinheiro', amountCents: totalEsperadoCents }] });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const venda = res.body.sale ?? res.body;
  expect(venda.total_cents).toBe(totalEsperadoCents);
  return venda.id as string;
}

/**
 * NF-e mínima e válida para o parser da casa (o molde de audit-purchase),
 * itens casando com o catálogo por NOME.
 */
function xmlNota(input: {
  sufixoChave: string;
  numero: string;
  itens: { nome: string; qtd: number; vUnit: string; vTotal: string }[];
  vNF: string;
}): string {
  const chave = `3526061420016600018755001000001024100001${input.sufixoChave}`;
  const dets = input.itens
    .map(
      (i, idx) => `      <det nItem="${idx + 1}">
        <prod>
          <cProd>REL-${idx + 1}</cProd><cEAN>SEM GTIN</cEAN>
          <xProd>${i.nome}</xProd><NCM>87141000</NCM><CFOP>5102</CFOP>
          <uCom>UN</uCom><qCom>${i.qtd}</qCom><vUnCom>${i.vUnit}</vUnCom><vProd>${i.vTotal}</vProd>
          <uTrib>UN</uTrib><qTrib>${i.qtd}</qTrib>
        </prod>
      </det>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc versao="4.00">
  <NFe>
    <infNFe Id="NFe${chave}" versao="4.00">
      <ide><nNF>${input.numero}</nNF><serie>1</serie><dhEmi>2026-06-09T10:15:00-03:00</dhEmi></ide>
      <emit><CNPJ>${CNPJ_FORNECEDOR}</CNPJ><xNome>Distribuidora do Relatorio Ltda</xNome></emit>
${dets}
      <total><ICMSTot><vNF>${input.vNF}</vNF></ICMSTot></total>
    </infNFe>
  </NFe>
</nfeProc>`;
}

/** COMPRA real: fornecedor → importar XML → confirmar. Estoque e dívida nascem daqui. */
async function comprarPorNfe(auth: Ator['auth'], nomeProduto: string): Promise<string> {
  const f = await request(app)
    .post('/api/v1/core/suppliers')
    .set(auth)
    .send({ name: 'Distribuidora do Relatorio Ltda', document: CNPJ_FORNECEDOR, paymentTermDays: 0 });
  expect(f.status, JSON.stringify(f.body)).toBe(201);

  const imp = await request(app)
    .post('/api/v1/core/purchases/nfe/import')
    .set(auth)
    .send({
      xml: xmlNota({
        sufixoChave: '1701',
        numero: '4021',
        itens: [{ nome: nomeProduto, qtd: 5, vUnit: '70.00', vTotal: '350.00' }],
        vNF: '350.00',
      }),
    });
  expect(imp.status, JSON.stringify(imp.body)).toBe(201);
  const noteId = imp.body.noteId as string;

  const conf = await request(app)
    .post(`/api/v1/core/purchases/notes/${noteId}/confirm`)
    .set(auth)
    .send({});
  expect(conf.status, JSON.stringify(conf.body)).toBe(200);
  return noteId;
}

async function devolver(
  auth: Ator['auth'],
  saleId: string,
  productId: string,
  quantidade: number,
): Promise<string> {
  const returnable = await request(app).get(`/api/v1/core/sales/${saleId}/returnable`).set(auth);
  expect(returnable.status, JSON.stringify(returnable.body)).toBe(200);
  const item = (returnable.body.items as { sale_item_id: string; product_id: string }[]).find(
    (i) => i.product_id === productId,
  );
  expect(item, JSON.stringify(returnable.body)).toBeDefined();

  const res = await request(app)
    .post('/api/v1/core/sale-returns')
    .set(auth)
    .send({
      saleId,
      reason: 'auditoria fase 17: peça devolvida',
      refundMethod: 'dinheiro',
      items: [{ saleItemId: item!.sale_item_id, quantity: quantidade }],
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

// ------------------------------------------------------------------ carimbos
//
// A venda nasceu pela rota; só o QUANDO é encenado — e de forma COERENTE:
// venda, lançamento financeiro e movimento de estoque viajam JUNTOS para o
// instante, com a competência no DIA DA LOJA do instante (o que a produção
// promete: "venda de hoje compete hoje").

function carimbarVenda(saleId: string, instante: string, diaDaLoja: string) {
  const db = getConnection();
  db.prepare('UPDATE core_sales SET created_at = ? WHERE id = ?').run(instante, saleId);
  db.prepare(
    "UPDATE core_finance_entries SET created_at = ?, competence_date = ? WHERE origin_type = 'sale' AND origin_id = ?",
  ).run(instante, diaDaLoja, saleId);
  db.prepare(
    "UPDATE core_stock_movements SET created_at = ? WHERE reference_type = 'sale' AND reference_id = ?",
  ).run(instante, saleId);
}

function carimbarCompra(noteId: string, instante: string, diaDaLoja: string) {
  const db = getConnection();
  db.prepare('UPDATE core_inbound_notes SET created_at = ?, received_at = ? WHERE id = ?').run(
    instante,
    instante,
    noteId,
  );
  db.prepare(
    "UPDATE core_finance_entries SET created_at = ?, competence_date = ? WHERE origin_type = 'nfe_entrada' AND origin_id = ?",
  ).run(instante, diaDaLoja, noteId);
  db.prepare(
    "UPDATE core_stock_movements SET created_at = ? WHERE reference_type = 'nfe_entrada' AND reference_id = ?",
  ).run(instante, noteId);
}

function carimbarDevolucao(returnId: string, instante: string, diaDaLoja: string) {
  const db = getConnection();
  db.prepare('UPDATE core_sale_returns SET created_at = ? WHERE id = ?').run(instante, returnId);
  db.prepare(
    "UPDATE core_finance_entries SET created_at = ?, competence_date = ? WHERE origin_type = 'sale_return' AND origin_id = ?",
  ).run(instante, diaDaLoja, returnId);
  db.prepare(
    "UPDATE core_stock_movements SET created_at = ? WHERE reference_type = 'sale_return' AND reference_id = ?",
  ).run(instante, returnId);
}

interface Cenario {
  p1: string;
  p2: string;
  v1: string;
  v2: string;
  v3: string;
  noteId: string;
  returnId: string;
}

async function montarCenario(auth: Ator['auth']): Promise<Cenario> {
  const p1 = await criarProduto(auth, 'Bicicleta do Relatorio', 12_345, 6_000, 2);
  const p2 = await criarProduto(auth, 'Capacete do Relatorio', 6_789, 2_500, 8);
  await entradaEstoque(auth, p1, 10);
  await entradaEstoque(auth, p2, 10);

  const noteId = await comprarPorNfe(auth, 'Bicicleta do Relatorio');

  const v1 = await vender(auth, [{ productId: p1, quantity: 2 }], 24_690);
  const v2 = await vender(auth, [{ productId: p2, quantity: 1 }], 6_789);
  const v3 = await vender(
    auth,
    [
      { productId: p1, quantity: 1 },
      { productId: p2, quantity: 2 },
    ],
    25_923,
  );

  const returnId = await devolver(auth, v1, p1, 1);

  carimbarVenda(v1, V1_INSTANTE, D1);
  carimbarVenda(v2, V2_INSTANTE, D2);
  carimbarVenda(v3, V3_INSTANTE, D3);
  carimbarCompra(noteId, COMPRA_INSTANTE, D2);
  carimbarDevolucao(returnId, DEVOLUCAO_INSTANTE, D3);

  return { p1, p2, v1, v2, v3, noteId, returnId };
}

async function painel(auth: Ator['auth'], from: string, to: string) {
  const res = await request(app).get(`/api/v1/core/dashboard?from=${from}&to=${to}`).set(auth);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as {
    revenueCents: number;
    salesCount: number;
    averageTicketCents: number;
    openReceivablesCents: number;
    byDay: { day: string; sales_count: number; revenue_cents: number }[];
    lowStock: { product_id: string; quantity: number }[];
  };
}

async function listaDeVendas(auth: Ator['auth'], from: string, to: string) {
  const res = await request(app).get(`/api/v1/core/sales?from=${from}&to=${to}`).set(auth);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.items as { id: string; status: string; total_cents: number }[];
}

// ============================================================================

describe('a lista de vendas é o banco — total, bordas do dia e recorte', () => {
  it('as bordas do dia da loja ficam DENTRO do dia: 23:59:59 é do dia 8, 00:00:00 é do dia 9', async () => {
    const g = await gerente();
    const c = await montarCenario(g.auth);

    // Cada dia devolve exatamente a sua venda — um segundo separa V1 de V2 e
    // eles caem em dias diferentes da loja, cada um no SEU dia.
    const dia1 = await listaDeVendas(g.auth, D1, D1);
    expect(dia1.map((s) => s.id)).toEqual([c.v1]);
    expect(dia1[0].total_cents).toBe(24_690);

    const dia2 = await listaDeVendas(g.auth, D2, D2);
    expect(dia2.map((s) => s.id)).toEqual([c.v2]);

    const dia3 = await listaDeVendas(g.auth, D3, D3);
    expect(dia3.map((s) => s.id)).toEqual([c.v3]);

    // O período inteiro soma 57.402 — e a soma é conferida também contra o
    // SQL cru do banco de auditoria, não só contra a aritmética do cenário.
    const periodo = await listaDeVendas(g.auth, D1, D3);
    expect(periodo.map((s) => s.id).sort()).toEqual([c.v1, c.v2, c.v3].sort());
    const somaDaLista = periodo.reduce((a, s) => a + s.total_cents, 0);
    expect(somaDaLista).toBe(57_402);

    const doBanco = getConnection()
      .prepare(
        `SELECT COALESCE(SUM(total_cents), 0) AS total, COUNT(*) AS n
           FROM core_sales
          WHERE company_id = ? AND status = 'completed'
            AND created_at >= '2026-06-08T03:00:00.000Z'
            AND created_at <= '2026-06-11T02:59:59.999Z'`,
      )
      .get(precoJusto) as { total: number; n: number };
    expect(somaDaLista).toBe(doBanco.total);
    expect(periodo).toHaveLength(doBanco.n);
  });

  it('o painel diz o MESMO número da lista, dia a dia — e a soma das barras é o total', async () => {
    const g = await gerente();
    await montarCenario(g.auth);

    const p = await painel(g.auth, D1, D3);
    expect(p.revenueCents).toBe(57_402);
    expect(p.salesCount).toBe(3);
    expect(p.averageTicketCents).toBe(19_134); // 57.402 / 3, exato

    expect(p.byDay).toEqual([
      { day: D1, sales_count: 1, revenue_cents: 24_690 },
      { day: D2, sales_count: 1, revenue_cents: 6_789 },
      { day: D3, sales_count: 1, revenue_cents: 25_923 },
    ]);
    expect(p.byDay.reduce((a, d) => a + d.revenue_cents, 0)).toBe(p.revenueCents);

    // E cada barra é a soma da lista daquele dia — dois lugares, um número.
    for (const barra of p.byDay) {
      const doDia = await listaDeVendas(g.auth, barra.day, barra.day);
      expect(doDia.reduce((a, s) => a + s.total_cents, 0)).toBe(barra.revenue_cents);
    }
  });
});

// ============================================================================

describe('o razão do estoque atravessa compra, venda e devolução', () => {
  it('o saldo da rota = soma dos deltas do razão = aritmética do cenário', async () => {
    const g = await gerente();
    const c = await montarCenario(g.auth);

    // P1: 10 (carga) + 5 (compra XML) − 2 (V1) − 1 (V3) + 1 (devolução) = 13
    // P2: 10 (carga) − 1 (V2) − 2 (V3) = 7
    const stock = await request(app).get('/api/v1/core/stock').set(g.auth);
    expect(stock.status).toBe(200);
    const porId = new Map(
      (stock.body.items as { product_id: string; quantity: number }[]).map((i) => [
        i.product_id,
        i.quantity,
      ]),
    );
    expect(porId.get(c.p1)).toBe(13);
    expect(porId.get(c.p2)).toBe(7);

    // O razão confirma: a soma dos deltas é o saldo, produto a produto.
    // (`quantity` é gravado JÁ COM SINAL — saída é negativa; somar direto é
    // exatamente a definição de razão.)
    const razao = (productId: string) =>
      (
        getConnection()
          .prepare(
            `SELECT COALESCE(SUM(quantity), 0) AS saldo
               FROM core_stock_movements WHERE company_id = ? AND product_id = ?`,
          )
          .get(precoJusto, productId) as { saldo: number }
      ).saldo;
    expect(razao(c.p1)).toBe(13);
    expect(razao(c.p2)).toBe(7);

    // O painel aponta SÓ o capacete como estoque baixo (7 < mínimo 8).
    const p = await painel(g.auth, D3, D3);
    expect(p.lowStock.map((l) => l.product_id)).toEqual([c.p2]);
    expect(p.lowStock[0].quantity).toBe(7);

    // E a devolução aparece no relatório de devoluções com o valor exato.
    const devolucoes = await request(app).get('/api/v1/core/sale-returns').set(g.auth);
    expect(devolucoes.status).toBe(200);
    const linhas = devolucoes.body.items as { id: string; total_cents: number }[];
    expect(linhas.map((r) => r.id)).toEqual([c.returnId]);
    expect(linhas[0].total_cents).toBe(12_345);
  });

  it('o filtro de data das movimentações recorta pelo dia da loja — e bate com o SQL', async () => {
    const g = await gerente();
    const c = await montarCenario(g.auth);

    // No D2 aconteceram exatamente DUAS coisas: a compra (XML_RECEIPT, +5 de
    // P1) e a venda V2 (SALE, −1 de P2).
    const res = await request(app)
      .get(`/api/v1/core/stock/movements?from=${D2}&to=${D2}`)
      .set(g.auth);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const doDia2 = res.body.items as {
      id: string;
      kind: string;
      product_id: string;
      quantity: number;
      movement_type: string;
    }[];
    expect(doDia2).toHaveLength(2);
    const porKind = new Map(doDia2.map((m) => [m.kind, m]));
    expect(porKind.get('XML_RECEIPT')?.product_id).toBe(c.p1);
    expect(porKind.get('XML_RECEIPT')?.quantity).toBe(5);
    expect(porKind.get('SALE')?.product_id).toBe(c.p2);
    // O histórico devolve o DELTA com sinal: a venda tirou 1 da prateleira.
    expect(porKind.get('SALE')?.quantity).toBe(-1);

    const noBanco = getConnection()
      .prepare(
        `SELECT COUNT(*) AS n FROM core_stock_movements
          WHERE company_id = ?
            AND created_at >= '2026-06-09T03:00:00.000Z'
            AND created_at <= '2026-06-10T02:59:59.999Z'`,
      )
      .get(precoJusto) as { n: number };
    expect(doDia2).toHaveLength(noBanco.n);
  });

  it('a paginação percorre o razão inteiro: soma das páginas = total, sem duplicar nem perder', async () => {
    const g = await gerente();
    await montarCenario(g.auth);

    // O cenário produz 8 movimentos: 2 cargas + 1 compra + 4 linhas de venda
    // (V1, V2 e as duas de V3) + 1 devolução.
    const esperados = getConnection()
      .prepare(
        `SELECT id FROM core_stock_movements WHERE company_id = ?
          ORDER BY created_at DESC, rowid DESC`,
      )
      .all(precoJusto) as { id: string }[];
    expect(esperados).toHaveLength(8);

    const paginados: string[] = [];
    for (let offset = 0; offset < 8; offset += 3) {
      const res = await request(app)
        .get(`/api/v1/core/stock/movements?limit=3&offset=${offset}`)
        .set(g.auth);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      paginados.push(...(res.body.items as { id: string }[]).map((m) => m.id));
    }

    // Mesma ordem, mesmo conteúdo, nenhum id repetido, nenhum perdido.
    expect(paginados).toEqual(esperados.map((m) => m.id));
    expect(new Set(paginados).size).toBe(8);
  });
});

// ============================================================================

describe('DRE, painel e lista dizem o MESMO número para o MESMO recorte', () => {
  it('receita 57.402, despesa 47.345, resultado 10.057 — no centavo e igual ao SQL', async () => {
    const g = await gerente();
    await montarCenario(g.auth);

    const res = await request(app)
      .get(`/api/v1/core/finance/income-statement?from=${D1}&to=${D3}`)
      .set(g.auth);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const dre = res.body as {
      revenue: {
        totalCents: number;
        entryCount: number;
        lines: { categoryName: string; totalCents: number; entryCount: number }[];
      };
      expense: {
        totalCents: number;
        lines: { categoryName: string; totalCents: number; entryCount: number }[];
      };
      resultCents: number;
      reconciliation: {
        panelRevenueCents: number;
        statementRevenueCents: number;
        differenceCents: number;
      };
    };

    // Receita: as 3 vendas, classificadas na categoria de sistema.
    expect(dre.revenue.totalCents).toBe(57_402);
    expect(dre.revenue.entryCount).toBe(3);
    const venda = dre.revenue.lines.find((l) => l.categoryName === 'Venda de mercadoria');
    expect(venda?.totalCents).toBe(57_402);

    // Despesa: a compra (35.000) e a devolução (12.345), cada uma na sua linha.
    expect(dre.expense.totalCents).toBe(47_345);
    const compra = dre.expense.lines.find((l) => l.categoryName === 'Compra de mercadoria');
    const devolucao = dre.expense.lines.find((l) => l.categoryName === 'Devolução a cliente');
    expect(compra?.totalCents).toBe(35_000);
    expect(compra?.entryCount).toBe(1);
    expect(devolucao?.totalCents).toBe(12_345);
    expect(devolucao?.entryCount).toBe(1);

    expect(dre.resultCents).toBe(10_057);

    // O DRE e o painel respondem o MESMO faturamento para o MESMO recorte —
    // e a conciliação não tem diferença a nomear.
    const p = await painel(g.auth, D1, D3);
    expect(dre.reconciliation.panelRevenueCents).toBe(p.revenueCents);
    expect(dre.reconciliation.statementRevenueCents).toBe(57_402);
    expect(dre.reconciliation.differenceCents).toBe(0);

    // Contra o banco cru: soma dos lançamentos não-cancelados por competência.
    const doBanco = getConnection()
      .prepare(
        `SELECT direction, COALESCE(SUM(amount_cents), 0) AS total
           FROM core_finance_entries
          WHERE company_id = ? AND cancelled_at IS NULL
            AND competence_date >= ? AND competence_date <= ?
          GROUP BY direction`,
      )
      .all(precoJusto, D1, D3) as { direction: string; total: number }[];
    const porDirecao = new Map(doBanco.map((r) => [r.direction, r.total]));
    expect(porDirecao.get('in')).toBe(dre.revenue.totalCents);
    expect(porDirecao.get('out')).toBe(dre.expense.totalCents);

    // E o "a pagar" da tela de Contas é exatamente a dívida da compra: a
    // devolução em dinheiro nasce quitada e não fica em aberto.
    const contas = await request(app)
      .get('/api/v1/core/finance/entries?direction=out')
      .set(g.auth);
    expect(contas.status).toBe(200);
    expect(contas.body.summary.openCents).toBe(35_000);
    expect(p.openReceivablesCents).toBe(0); // vendas em dinheiro nascem quitadas
  });
});

// ============================================================================

describe('os insights respondem número derivado do banco — não zero decorativo', () => {
  it('operations: faturamento, contagem, ticket, devolução e líquido do recorte', async () => {
    const g = await gerente();
    await montarCenario(g.auth);

    const res = await request(app)
      .get(`/api/v1/core/insights/operations?from=${D1}&to=${D3}`)
      .set(g.auth);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const op = res.body.operations[0] as {
      companyId: string;
      salesCount: number;
      revenueCents: number;
      averageTicketCents: number;
      returnsCents: number;
      netCents: number;
    };
    expect(op.companyId).toBe(precoJusto);
    expect(op.salesCount).toBe(3);
    expect(op.revenueCents).toBe(57_402);
    expect(op.averageTicketCents).toBe(19_134);
    expect(op.returnsCents).toBe(12_345);
    expect(op.netCents).toBe(45_057); // 57.402 − 12.345

    // Os totals repetem a única operação — e batem com o painel do recorte.
    const p = await painel(g.auth, D1, D3);
    expect(res.body.totals.revenueCents).toBe(p.revenueCents);
    expect(res.body.totals.salesCount).toBe(p.salesCount);
  });

  it('products: quantidade e dinheiro por produto, na ordem do dinheiro', async () => {
    const g = await gerente();
    await montarCenario(g.auth);

    const res = await request(app)
      .get(`/api/v1/core/insights/products?from=${D1}&to=${D3}`)
      .set(g.auth);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const itens = res.body.items as { name: string; quantity: number; revenue_cents: number }[];

    // P1: 2 (V1) + 1 (V3) = 3 unidades, 37.035. P2: 1 (V2) + 2 (V3) = 3, 20.367.
    expect(itens.map((i) => i.name)).toEqual(['Bicicleta do Relatorio', 'Capacete do Relatorio']);
    expect(itens[0].quantity).toBe(3);
    expect(itens[0].revenue_cents).toBe(37_035);
    expect(itens[1].quantity).toBe(3);
    expect(itens[1].revenue_cents).toBe(20_367);
    // A soma dos produtos É o faturamento do período.
    expect(itens.reduce((a, i) => a + i.revenue_cents, 0)).toBe(57_402);
  });

  it('margin: o custo é o da compra confirmada (7.000), não o do cadastro velho (6.000)', async () => {
    const g = await gerente();
    await montarCenario(g.auth);

    const res = await request(app)
      .get(`/api/v1/core/insights/margin?from=${D1}&to=${D3}`)
      .set(g.auth);
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    /*
      A compra por NF-e reescreveu o custo de P1 para 7.000 — regra da casa.
      custo = 3×7.000 (P1) + 3×2.500 (P2) = 28.500; margem = 57.402 − 28.500
      = 28.902; percentual = round(28.902/57.402×1000)/10 = 50,4.
      Se a confirmação da nota deixar de reescrever o custo, o custo cai para
      25.500 e este caso fica vermelho — é o fio compra→relatório de margem.
    */
    expect(res.body.consideredItems).toBe(4); // 4 linhas de item vendidas
    expect(res.body.skippedNoCost).toBe(0);
    expect(res.body.revenueCents).toBe(57_402);
    expect(res.body.costCents).toBe(28_500);
    expect(res.body.marginCents).toBe(28_902);
    expect(res.body.marginPercent).toBe(50.4);
  });
});

// ============================================================================

/** Abre o zip do pacote (o mesmo leitor de fechamento-contador.test.ts). */
function abrirZip(zip: Buffer): Map<string, string> {
  const fim = zip.length - 22;
  expect(zip.readUInt32LE(fim)).toBe(0x06054b50);
  const entradas = zip.readUInt16LE(fim + 10);
  let cursor = zip.readUInt32LE(fim + 16);

  const saida = new Map<string, string>();
  for (let i = 0; i < entradas; i += 1) {
    expect(zip.readUInt32LE(cursor)).toBe(0x02014b50);
    const tamanhoNome = zip.readUInt16LE(cursor + 28);
    const tamanhoExtra = zip.readUInt16LE(cursor + 30);
    const tamanhoComentario = zip.readUInt16LE(cursor + 32);
    const offsetLocal = zip.readUInt32LE(cursor + 42);
    const nome = zip.subarray(cursor + 46, cursor + 46 + tamanhoNome).toString('utf8');

    expect(zip.readUInt32LE(offsetLocal)).toBe(0x04034b50);
    const comprimido = zip.readUInt32LE(offsetLocal + 18);
    const nomeLocal = zip.readUInt16LE(offsetLocal + 26);
    const extraLocal = zip.readUInt16LE(offsetLocal + 28);
    const inicio = offsetLocal + 30 + nomeLocal + extraLocal;

    saida.set(
      nome,
      inflateRawSync(zip.subarray(inicio, inicio + comprimido)).toString('utf8'),
    );
    cursor += 46 + tamanhoNome + tamanhoExtra + tamanhoComentario;
  }
  return saida;
}

describe('a exportação do contador leva os números do banco', () => {
  it('o dre.csv de junho tem as MESMAS parcelas do DRE, em reais com vírgula, da empresa certa', async () => {
    const g = await gerente();
    await montarCenario(g.auth);

    const res = await request(app)
      .get('/api/v1/core/fiscal/closings/2026-06/pacote')
      .set(g.auth)
      .buffer(true)
      .parse((r, cb) => {
        const pedacos: Buffer[] = [];
        r.on('data', (d: Buffer) => pedacos.push(d));
        r.on('end', () => cb(null, Buffer.concat(pedacos)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/zip');
    // A empresa certa está no NOME do arquivo — o contador arquiva por ele.
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="pacote-preco-justo-2026-06.zip"',
    );

    const dentro = abrirZip(res.body as Buffer);
    const csv = dentro.get('resultado/dre.csv');
    expect(csv, [...dentro.keys()].join(', ')).toBeDefined();
    const linhas = csv!.replace(/^﻿/, '').trimEnd().split('\r\n');

    // Dinheiro em reais com vírgula, linha a linha — os MESMOS números que o
    // banco soma: 574,02 de receita, 350,00 + 123,45 de despesa, 100,57 de
    // resultado. Nenhum centavo cru, nenhuma casa a mais.
    expect(linhas[0]).toBe('lado;categoria;lancamentos;valor');
    expect(linhas).toContain('Receita;Venda de mercadoria;3;574,02');
    expect(linhas).toContain('Receita;TOTAL;3;574,02');
    expect(linhas).toContain('Despesa;Compra de mercadoria;1;350,00');
    expect(linhas).toContain('Despesa;Devolução a cliente;1;123,45');
    expect(linhas).toContain('Despesa;TOTAL;2;473,45');
    expect(linhas).toContain('Resultado;Receita - Despesa;;100,57');

    // E o CSV é o RELATÓRIO: os mesmos totais que a rota do DRE responde para
    // o mesmo mês — exportar não pode ser uma segunda contabilidade.
    const dre = await request(app)
      .get('/api/v1/core/finance/income-statement?from=2026-06-01&to=2026-06-30')
      .set(g.auth);
    expect(dre.status).toBe(200);
    expect(dre.body.revenue.totalCents).toBe(57_402);
    expect(dre.body.expense.totalCents).toBe(47_345);
    expect(dre.body.resultCents).toBe(10_057);
  });
});

// ============================================================================
//
// DEFEITOS REAIS — os três casos abaixo nasceram VERMELHOS DE PROPÓSITO e
// ficaram verdes com o conserto. Cada um cobra o comportamento CERTO; não
// enfraquecer as asserções: elas são o registro executável da auditoria e a
// trava contra o defeito voltar.

describe('os achados da auditoria: relatório que não era o banco', () => {
  it('a lista de vendas devolve o dia INTEIRO — 205 vendas não podem virar 200 em silêncio', async () => {
    /*
      DEFEITO (consertado): `listSales` cortava em `LIMIT 200` e a rota
      GET /core/sales não repassava limit/offset nem devolvia total. O painel
      somava TUDO no SQL; a lista parava na venda 200 — o invariante que
      audit-dashboard.test.ts estabeleceu ("a soma das concluídas da lista é
      o faturamento do painel") quebrava sem erro nenhum: o relatório mentia
      por omissão.

      O conserto não removeu o corte — uma página de milhares continuaria
      sendo um peso —; ele o tornou HONESTO: a rota aceita ?limit (teto 500)
      e ?offset, e o corpo devolve `total`, o tamanho real do recorte. A
      exigência deste caso continua a mesma: NENHUMA venda invisível — quem
      pagina chega ao número do painel sem perder nem duplicar venda.
    */
    const g = await gerente();

    // 205 vendas concluídas de 1.000 no mesmo dia da loja — fabricadas direto
    // no banco (o mecanismo de o-dia-do-relatorio-e-o-dia-da-loja.test.ts):
    // o que está sob teste aqui é a LEITURA, não a escrita. O MESMO instante
    // em todas, de propósito: é o pior caso para a ordenação de uma página.
    const stmt = getConnection().prepare(
      `INSERT INTO core_sales
         (id, company_id, number, status, subtotal_cents, discount_cents, total_cents,
          change_cents, idempotency_key, created_at)
       VALUES (?, ?, ?, 'completed', 1000, 0, 1000, 0, ?, ?)`,
    );
    for (let i = 1; i <= 205; i += 1) {
      stmt.run(randomUUID(), precoJusto, i, randomUUID(), V3_INSTANTE);
    }

    const p = await painel(g.auth, D3, D3);
    expect(p.revenueCents).toBe(205_000);
    expect(p.salesCount).toBe(205);

    // A página padrão continua cortando — mas agora DIZ o que cortou: o
    // total é o do recorte, não o do pedaço devolvido.
    const primeira = await request(app)
      .get(`/api/v1/core/sales?from=${D3}&to=${D3}`)
      .set(g.auth);
    expect(primeira.status, JSON.stringify(primeira.body)).toBe(200);
    expect(primeira.body.total).toBe(205);

    // E PAGINANDO se chega ao dia inteiro: as páginas juntas têm as 205
    // vendas, nenhum id repetido, nenhum perdido — e a soma é o número do
    // painel. Dois lugares, um número.
    const todas: { id: string; status: string; total_cents: number }[] = [];
    for (let offset = 0; offset < 205; offset += 100) {
      const pagina = await request(app)
        .get(`/api/v1/core/sales?from=${D3}&to=${D3}&limit=100&offset=${offset}`)
        .set(g.auth);
      expect(pagina.status, JSON.stringify(pagina.body)).toBe(200);
      // O total não muda conforme a página anda — ele é do recorte.
      expect(pagina.body.total).toBe(205);
      todas.push(...(pagina.body.items as typeof todas));
    }

    expect(todas).toHaveLength(205);
    expect(new Set(todas.map((s) => s.id)).size).toBe(205);
    const somaDaLista = todas
      .filter((s) => s.status === 'completed')
      .reduce((a, s) => a + s.total_cents, 0);
    expect(somaDaLista).toBe(p.revenueCents);
  });

  it('a devolução dos insights pertence ao dia em que ACONTECEU — como no DRE', async () => {
    /*
      DEFEITO: `operationsOverview` (GroupInsights) filtra as devoluções por
      `s.created_at` — a data da VENDA — enquanto o DRE lança a devolução na
      competência do fato (SaleReturnService: "diminuindo o resultado do mês
      em que aconteceu — que é onde ela de fato aconteceu"). No cenário, a
      venda é do dia 8 e a devolução do dia 10: para o recorte do dia 10, o
      DRE deduz 12.345 e o BI responde 0. Duas superfícies, a mesma pergunta,
      dois números.
    */
    const g = await gerente();
    await montarCenario(g.auth);

    // O DRE do dia 10 registra a devolução — este é o lado CERTO, e passa.
    const dre = await request(app)
      .get(`/api/v1/core/finance/income-statement?from=${D3}&to=${D3}`)
      .set(g.auth);
    expect(dre.status).toBe(200);
    const linhaDevolucao = (
      dre.body.expense.lines as { categoryName: string; totalCents: number }[]
    ).find((l) => l.categoryName === 'Devolução a cliente');
    expect(linhaDevolucao?.totalCents).toBe(12_345);

    // O BI do MESMO recorte tem de dizer a MESMA devolução.
    const insights = await request(app)
      .get(`/api/v1/core/insights/operations?from=${D3}&to=${D3}`)
      .set(g.auth);
    expect(insights.status).toBe(200);
    expect(insights.body.operations[0].returnsCents).toBe(12_345);

    // E o dia 8 — quando nada foi devolvido — não pode carregar a devolução
    // que só aconteceria dois dias depois.
    const dia8 = await request(app)
      .get(`/api/v1/core/insights/operations?from=${D1}&to=${D1}`)
      .set(g.auth);
    expect(dia8.body.operations[0].returnsCents).toBe(0);
  });

  it('a venda das 22h30 compete o dia da LOJA — não o dia de Greenwich', async () => {
    /*
      DEFEITO: SalesService grava `competence_date = now.slice(0, 10)` — a
      data UTC — logo abaixo do comentário "Competência é a data do fato ...
      venda de hoje compete hoje". Às 22h30 da loja (01:30Z do dia seguinte),
      o "hoje" do operador é 08/06 e a competência gravada é 09/06: toda
      venda entre 21h e meia-noite compete o dia seguinte, e na virada do mês
      o DRE — e o dre.csv que vai ao contador — escritura a receita no mês
      errado. O painel, a lista e o pacote já usam o calendário da loja
      (CalendarioOperacional); o escritor da competência ficou para trás.

      O relógio é encenado com data falsa (o mecanismo de audit-auth.test.ts)
      porque o defeito mora no ESCRITOR: carimbar o banco depois, como o
      resto desta suíte faz, mascararia exatamente o que se quer medir.
    */
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-06-09T01:30:00.000Z').getTime() });

    const g = await gerente();
    const p1 = await criarProduto(g.auth, 'Farol Noturno', 10_000, 4_000, 0);
    await entradaEstoque(g.auth, p1, 3);
    const venda = await vender(g.auth, [{ productId: p1, quantity: 1 }], 10_000);

    const lancamento = getConnection()
      .prepare(
        `SELECT competence_date FROM core_finance_entries
          WHERE company_id = ? AND origin_type = 'sale' AND origin_id = ?`,
      )
      .get(precoJusto, venda) as { competence_date: string };

    // 01:30Z de 09/06 é 22:30 de 08/06 na loja: a venda compete 08/06.
    expect(lancamento.competence_date).toBe('2026-06-08');

    // E o DRE do dia da loja tem de conter a receita da própria noite.
    const dre = await request(app)
      .get('/api/v1/core/finance/income-statement?from=2026-06-08&to=2026-06-08')
      .set(g.auth);
    expect(dre.status).toBe(200);
    expect(dre.body.revenue.totalCents).toBe(10_000);
    expect(dre.body.reconciliation.panelRevenueCents).toBe(10_000);
  });
});
