/**
 * ============================================================================
 * A VENDA NO SERVIDOR — o que a reauditoria da trilha "venda" do Preço Justo
 * achou
 * ============================================================================
 *
 *   A-produto-R01        o piso de preço do A-produto-17 barrava a promoção, a
 *                        tabela e a faixa que a própria gestão criou: o caixa
 *                        não vendia o item em promoção sem gerente, e a recusa
 *                        culpava o "preço de venda do cadastro" e mandava
 *                        corrigir em Produtos um cadastro que estava acima do
 *                        piso. O orçamento tinha a mesma conta.
 *   E-venda-servidor-R01 cancelar a venda a prazo (ou com PIX pendente) já
 *                        recebida em Contas a receber devolvia um resumo todo
 *                        zero — a tela dizia "Nada desta venda tinha sido
 *                        recebido" — e, com uma devolução em dinheiro no meio,
 *                        o cancelamento era recusado como "outro meio".
 *
 * Tudo sobe por HTTP com token real e confere o banco; cada caso falha na
 * versão anterior do servidor.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { getConnection } from '../src/db/sqlite.js';
import { createQuote } from '../src/services/core/QuoteService.js';
import { setPriceTier } from '../src/services/core/CatalogAuxService.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();
const LOJA = 'loja-reauditoria-venda';

type Auth = { Authorization: string };
let gerente: Auth;
let companyId: string;

async function entrar(userId: string, perfil: string): Promise<{ auth: Auth; userId: string }> {
  const res = await loginForTest(app, { userId, companyId: LOJA, profileCodes: [perfil] });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return {
    auth: { Authorization: `Bearer ${res.body.accessToken as string}` },
    userId: String(res.body.user.id),
  };
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  const res = await loginForTest(app, {
    userId: 'gerente-reaud',
    companyId: LOJA,
    profileCodes: ['gerente_loja'],
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  gerente = { Authorization: `Bearer ${res.body.accessToken as string}` };
  companyId = String(res.body.company.id);
});

async function produto(
  precoCents: number,
  opcoes: { nome?: string; categoria?: string; piso?: number; quantidade?: number } = {},
): Promise<string> {
  const p = await request(app)
    .post('/api/v1/core/products')
    .set(gerente)
    .send({ name: opcoes.nome ?? `Produto ${randomUUID().slice(0, 6)}`, priceCents: precoCents });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  const quantidade = opcoes.quantidade ?? 20;
  if (quantidade > 0) {
    const m = await request(app).post('/api/v1/core/stock/movements').set(gerente).send({
      productId: p.body.id,
      movementType: 'in',
      quantity: quantidade,
      referenceType: 'entrada',
      referenceId: `carga-${p.body.id as string}`,
    });
    expect(m.status, JSON.stringify(m.body)).toBeLessThan(300);
  }
  getConnection()
    .prepare('UPDATE core_products SET min_price_cents = ?, category = COALESCE(?, category) WHERE id = ?')
    .run(opcoes.piso ?? 0, opcoes.categoria ?? null, p.body.id);
  return String(p.body.id);
}

function vender(corpo: Record<string, unknown>, auth: Auth = gerente) {
  return request(app)
    .post('/api/v1/core/sales')
    .set(auth)
    .set('Idempotency-Key', randomUUID())
    .send(corpo);
}

async function promocao(corpo: Record<string, unknown>): Promise<string> {
  // A promoção é do GERENTE — é a decisão de gestão que o piso não pode anular.
  const res = await request(app).post('/api/v1/core/promotions').set(gerente).send(corpo);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return String(res.body.id);
}

function contarVendas(): number {
  return Number(
    (
      getConnection().prepare('SELECT COUNT(*) AS n FROM core_sales WHERE company_id = ?').get(companyId) as {
        n: number;
      }
    ).n,
  );
}

// ============================================================================
describe('A-produto-R01 — o preço que a gestão definiu não é concessão do balcão contra o piso', () => {
  it('promoção do gerente abaixo do piso: o caixa vende pelo preço da promoção sem liberação', async () => {
    const caixa = await entrar('caixa-reaud', 'operador_caixa_loja');
    const p = await produto(2990, { nome: 'Perfume Floral', piso: 2500 });
    await promocao({ productId: p, priceCents: 2392 });

    const res = await vender(
      {
        items: [{ productId: p, quantity: 1 }],
        payments: [{ method: 'dinheiro', amountCents: 2392 }],
      },
      caixa.auth,
    );
    // Antes: 403 CORE_DISCOUNT_NEEDS_AUTHORIZATION — "o próprio preço de venda
    // do cadastro, R$ 23,92, já está abaixo desse piso" — sem desconto nenhum.
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.total_cents ?? res.body.totalCents).toBe(2392);
    expect(contarVendas()).toBe(1);
  });

  it('desconto do balcão POR CIMA da promoção continua pedindo gestor — e a recusa nomeia a promoção, não o cadastro', async () => {
    const caixa = await entrar('caixa-reaud', 'operador_caixa_loja');
    const p = await produto(2990, { nome: 'Perfume Floral', piso: 2500 });
    await promocao({ productId: p, priceCents: 2392 });

    const res = await vender(
      {
        items: [{ productId: p, quantity: 1, unitPriceCents: 2200 }],
        payments: [{ method: 'dinheiro', amountCents: 2200 }],
      },
      caixa.auth,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error.code).toBe('CORE_DISCOUNT_NEEDS_AUTHORIZATION');
    expect(res.body.error.message).toMatch(/Perfume Floral/);
    expect(res.body.error.message).toMatch(/a promoção deste produto já fixa R\$ 23,92/);
    // Antes: culpava o cadastro (R$ 29,90, acima do piso) e mandava a Produtos.
    expect(res.body.error.message).not.toMatch(/preço de venda do cadastro/);
    expect(res.body.error.message).not.toMatch(/Produtos/);
    expect(res.body.error.message).toMatch(/tire o desconto dado no balcão/);
    expect(res.body.error.details.abaixoDoPiso[0]).toMatchObject({
      productId: p,
      unitarioCobradoCents: 2200,
      pisoCents: 2500,
      precoDoCadastroCents: null,
      precoDaGestao: { fonte: 'promocao', precoCents: 2392 },
    });
    expect(contarVendas()).toBe(0);
  });

  it('promoção de 20% na CATEGORIA: vende sem liberação, e o desconto no rodapé por cima dela pede gestor nomeando a categoria', async () => {
    const caixa = await entrar('caixa-reaud', 'operador_caixa_loja');
    const p = await produto(2990, { nome: 'Perfume Floral', piso: 2500, categoria: 'Perfumaria' });
    await promocao({ category: 'Perfumaria', percentOff: 20 });

    const semDesconto = await vender(
      {
        items: [{ productId: p, quantity: 1 }],
        payments: [{ method: 'dinheiro', amountCents: 2392 }],
      },
      caixa.auth,
    );
    expect(semDesconto.status, JSON.stringify(semDesconto.body)).toBe(201);

    const comRodape = await vender(
      {
        items: [{ productId: p, quantity: 1 }],
        discountCents: 100,
        payments: [{ method: 'dinheiro', amountCents: 2292 }],
      },
      caixa.auth,
    );
    expect(comRodape.status, JSON.stringify(comRodape.body)).toBe(403);
    expect(comRodape.body.error.message).toMatch(
      /a promoção de 20% da categoria "Perfumaria" já fixa R\$ 23,92/,
    );
  });

  it('tabela de preço de atacado do cliente abaixo do piso: vende sem liberação', async () => {
    const caixa = await entrar('caixa-reaud', 'operador_caixa_loja');
    const p = await produto(2990, { nome: 'Perfume Floral', piso: 2500 });
    const agora = new Date().toISOString();
    const tabela = randomUUID();
    getConnection()
      .prepare(
        `INSERT INTO core_price_tables (id, company_id, name, percent_off, active, created_at, updated_at)
         VALUES (?, ?, 'Atacado', 20, 1, ?, ?)`,
      )
      .run(tabela, companyId, agora, agora);
    const cliente = randomUUID();
    getConnection()
      .prepare(
        `INSERT INTO core_customers (id, company_id, name, active, price_table_id, created_at, updated_at)
         VALUES (?, ?, 'Revenda do Bairro', 1, ?, ?, ?)`,
      )
      .run(cliente, companyId, tabela, agora, agora);

    const res = await vender(
      {
        items: [{ productId: p, quantity: 1 }],
        customerId: cliente,
        payments: [{ method: 'dinheiro', amountCents: 2392 }],
      },
      caixa.auth,
    );
    // Antes: 403 — a tabela que o gerente deu ao cliente virava "desconto do balcão".
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const abaixo = await vender(
      {
        items: [{ productId: p, quantity: 1, unitPriceCents: 2300 }],
        customerId: cliente,
        payments: [{ method: 'dinheiro', amountCents: 2300 }],
      },
      caixa.auth,
    );
    expect(abaixo.status, JSON.stringify(abaixo.body)).toBe(403);
    expect(abaixo.body.error.message).toMatch(/a tabela de preço "Atacado" do cliente já fixa R\$ 23,92/);
  });

  it('faixa por quantidade abaixo do piso (REVISÃO — o terceiro preço da gestão, sem caso): vende sem liberação; o desconto por cima nomeia a faixa', async () => {
    const caixa = await entrar('caixa-reaud', 'operador_caixa_loja');
    const p = await produto(2990, { nome: 'Perfume Floral', piso: 2500 });
    // A faixa é do cadastro do produto: a partir de 3 unidades, R$ 23,92 cada.
    setPriceTier(companyId, p, 3, 2392);

    const semDesconto = await vender(
      {
        items: [{ productId: p, quantity: 3 }],
        payments: [{ method: 'dinheiro', amountCents: 3 * 2392 }],
      },
      caixa.auth,
    );
    // Sem o conserto: 403 — a faixa virava "desconto do balcão" contra o piso.
    expect(semDesconto.status, JSON.stringify(semDesconto.body)).toBe(201);
    expect(semDesconto.body.total_cents ?? semDesconto.body.totalCents).toBe(3 * 2392);

    const comDesconto = await vender(
      {
        items: [{ productId: p, quantity: 3, discountCents: 150 }],
        payments: [{ method: 'dinheiro', amountCents: 3 * 2392 - 150 }],
      },
      caixa.auth,
    );
    expect(comDesconto.status, JSON.stringify(comDesconto.body)).toBe(403);
    expect(comDesconto.body.error.message).toMatch(
      /a faixa de preço por quantidade deste produto já fixa R\$ 23,92/,
    );
    expect(comDesconto.body.error.details.abaixoDoPiso[0].precoDaGestao).toMatchObject({
      fonte: 'faixa',
      precoCents: 2392,
    });
  });

  it('controle: sem preço da gestão, o piso vale como sempre (R$ 23,92 digitado num produto de R$ 29,90 pede gestor)', async () => {
    const caixa = await entrar('caixa-reaud', 'operador_caixa_loja');
    const p = await produto(2990, { nome: 'Perfume Floral', piso: 2500 });
    const res = await vender(
      {
        items: [{ productId: p, quantity: 1, unitPriceCents: 2392 }],
        payments: [{ method: 'dinheiro', amountCents: 2392 }],
      },
      caixa.auth,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    // R$ 5,98 sobre R$ 29,90 também passa da alçada: a recusa fala das duas
    // coisas, e o piso continua sendo o do cadastro — nenhuma gestão o baixou.
    expect(res.body.error.message).toMatch(/abaixo do piso de R\$ 25,00/);
    expect(res.body.error.message).not.toMatch(/já fixa/);
    expect(res.body.error.details.abaixoDoPiso[0].precoDaGestao).toBeNull();
  });

  it('o ORÇAMENTO segue a mesma conta: a linha pelo preço da promoção é escrita sem liberação; o desconto por cima pede gestor', async () => {
    const caixa = await entrar('caixa-reaud', 'operador_caixa_loja');
    const p = await produto(2990, { nome: 'Perfume Floral', piso: 2500 });
    await promocao({ productId: p, priceCents: 2392 });

    // Antes: CORE_DISCOUNT_NEEDS_AUTHORIZATION — "o próprio preço de venda do
    // cadastro, R$ 23,92, já está abaixo desse piso".
    const doc = createQuote({
      companyId,
      userId: caixa.userId,
      items: [{ productId: p, quantity: 1 }],
      alcada: { profileCodes: ['operador_caixa_loja'] },
    });
    expect(doc.id).toBeTruthy();

    expect(() =>
      createQuote({
        companyId,
        userId: caixa.userId,
        items: [{ productId: p, quantity: 1, unitPriceCents: 2200 }],
        alcada: { profileCodes: ['operador_caixa_loja'] },
      }),
    ).toThrow(/a promoção deste produto já fixa R\$ 23,92/);
  });
});

// ============================================================================
describe('E-venda-servidor-R01 — o cancelamento conta o que a venda recebeu depois, em Contas a receber', () => {
  async function cliente(nome: string): Promise<string> {
    const res = await request(app).post('/api/v1/core/customers').set(gerente).send({ name: nome });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return String(res.body.id);
  }

  function tituloDaVenda(saleId: string): string {
    const row = getConnection()
      .prepare(
        `SELECT id FROM core_finance_entries
          WHERE origin_type = 'sale' AND origin_id = ? AND direction = 'in'
          ORDER BY installment_number LIMIT 1`,
      )
      .get(saleId) as { id: string } | undefined;
    expect(row, 'a venda precisa ter o título a receber').toBeTruthy();
    return row!.id;
  }

  async function baixarEmContasAReceber(entryId: string, amountCents: number, method: string) {
    const res = await request(app)
      .post(`/api/v1/core/finance/entries/${entryId}/settle`)
      .set(gerente)
      .send({ amountCents, method });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }

  function cancelar(saleId: string) {
    return request(app)
      .post(`/api/v1/core/sales/${saleId}/cancel`)
      .set(gerente)
      .send({ reason: 'Cliente devolveu o item' });
  }

  it('fiada de R$ 200 paga depois em dinheiro: o cancelamento diz que R$ 200 voltam ao cliente — e não "nada recebido"', async () => {
    const c = await cliente('Cliente do Fiado');
    const p = await produto(20000);
    const v = await vender({ items: [{ productId: p, quantity: 1 }], payments: [], customerId: c });
    expect(v.status, JSON.stringify(v.body)).toBe(201);
    await baixarEmContasAReceber(tituloDaVenda(v.body.id), 20000, 'dinheiro');

    const res = await cancelar(v.body.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // Antes: o resumo vinha todo zero, sem campo nenhum para os R$ 200 — e a
    // tela escrevia "Nada desta venda tinha sido recebido".
    expect(res.body.reembolso.recebidoDepois).toEqual({ cents: 20000, meios: ['dinheiro'] });
    expect(res.body.reembolso.aDevolverAMao).toEqual({ dinheiro: 0, credito: 0, debito: 0, pix: 0 });
    expect(res.body.reembolso.gavetaCents).toBe(0);
  });

  it('PIX pendente (sem cobrança integrada) baixado à mão: o cancelamento manda devolver por PIX', async () => {
    const p = await produto(8000);
    const v = await vender({
      items: [{ productId: p, quantity: 1 }],
      payments: [{ method: 'pix', amountCents: 8000, status: 'pending' }],
    });
    expect(v.status, JSON.stringify(v.body)).toBe(201);
    await baixarEmContasAReceber(tituloDaVenda(v.body.id), 8000, 'pix');

    const res = await cancelar(v.body.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.reembolso.recebidoDepois).toEqual({ cents: 8000, meios: ['pix'] });
  });

  it('o que entrou no ato não conta de novo como "depois": dinheiro com troco e PIX pago na hora', async () => {
    const p = await produto(5000);
    const emDinheiro = await vender({
      items: [{ productId: p, quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: 6000 }],
    });
    expect(emDinheiro.status, JSON.stringify(emDinheiro.body)).toBe(201);
    const r1 = await cancelar(emDinheiro.body.id);
    expect(r1.status, JSON.stringify(r1.body)).toBe(200);
    expect(r1.body.reembolso.recebidoDepois).toEqual({ cents: 0, meios: [] });
    expect(r1.body.reembolso.aDevolverAMao.dinheiro).toBe(5000);

    const porPix = await vender({
      items: [{ productId: p, quantity: 1 }],
      payments: [{ method: 'pix', amountCents: 5000 }],
    });
    expect(porPix.status, JSON.stringify(porPix.body)).toBe(201);
    const r2 = await cancelar(porPix.body.id);
    expect(r2.status, JSON.stringify(r2.body)).toBe(200);
    expect(r2.body.reembolso.recebidoDepois).toEqual({ cents: 0, meios: [] });
    expect(r2.body.reembolso.aDevolverAMao.pix).toBe(5000);
  });

  it('fiada ainda em aberto: nada entrou, e o resumo continua todo zero', async () => {
    const c = await cliente('Cliente que ainda deve');
    const p = await produto(8000);
    const v = await vender({ items: [{ productId: p, quantity: 1 }], payments: [], customerId: c });
    expect(v.status, JSON.stringify(v.body)).toBe(201);
    const res = await cancelar(v.body.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.reembolso.recebidoDepois).toEqual({ cents: 0, meios: [] });
  });

  it('fiada paga depois e devolvida pela metade em dinheiro: o cancelamento do resto não é recusado como "outro meio"', async () => {
    const c = await cliente('Cliente do Fiado');
    const p = await produto(10000);
    const v = await vender({ items: [{ productId: p, quantity: 2 }], payments: [], customerId: c });
    expect(v.status, JSON.stringify(v.body)).toBe(201);
    await baixarEmContasAReceber(tituloDaVenda(v.body.id), 20000, 'dinheiro');

    const itens = await request(app).get(`/api/v1/core/sales/${v.body.id as string}/returnable`).set(gerente);
    expect(itens.status, JSON.stringify(itens.body)).toBe(200);
    const dev = await request(app)
      .post('/api/v1/core/sale-returns')
      .set(gerente)
      .send({
        saleId: v.body.id,
        reason: 'Uma unidade voltou',
        refundMethod: 'dinheiro',
        items: [{ saleItemId: itens.body.items[0].sale_item_id, quantity: 1 }],
      });
    // A devolução mede o que entrou depois (`limitesDeReembolso`) e aceita.
    expect(dev.status, JSON.stringify(dev.body)).toBe(201);

    const res = await cancelar(v.body.id);
    // Antes: 409 CORE_SALE_RETURN_OTHER_MEANS — "R$ 100,00 devolvidos em
    // dinheiro, e ela recebeu R$ 0,00 em dinheiro".
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.reembolso.jaDevolvidoCents).toBe(10000);
    expect(res.body.reembolso.recebidoDepois).toEqual({ cents: 10000, meios: ['dinheiro'] });
  });
});
