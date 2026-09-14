/**
 * O PEDIDO ONLINE PAGO É VENDA DO PERÍODO (GAP-PRD-132).
 *
 * A auditoria mediu: o pedido online entregue deixava `core_orders.sale_id`
 * nulo, "Vendas do período", o ranking de vendedor e o BI liam só
 * `core_sales`, e o financeiro e o DRE contavam a receita do pedido. O gestor
 * que conferia o mês achava dois faturamentos diferentes.
 *
 * A escolha entre as duas saídas da ficha não é gosto: transformar o pedido em
 * `core_sales` (opção a) lançaria a mesma receita duas vezes e baixaria o
 * estoque de novo — é o que `core_fiscal_documents.order_id` já declara. Então
 * os números juntam as duas fontes (opção b), com a MESMA régua do DRE: o
 * pedido entra pelo DIA DO PAGAMENTO, com o total pago; o reembolso aparece
 * como devolução no dia dele.
 */
process.env.TZ = 'UTC';

import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { cancelOrder, checkout, markOrderPaid } from '../src/services/core/StorefrontService.js';
import { incomeStatement } from '../src/services/core/IncomeStatementService.js';
import { hojeNaLoja } from '../src/services/core/CalendarioOperacional.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();
let auth: { Authorization: string };
let companyId: string;
let n = 0;
const HOJE = () => hojeNaLoja();

function produtoDaVitrine(preco: number): string {
  n += 1;
  const id = `prod-rel-${n}`;
  const agora = new Date().toISOString();
  getConnection()
    .prepare(
      `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                  price_cents, active, publish_online, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'UN', 1000, ?, 1, 1, ?, ?)`,
    )
    .run(id, companyId, `REL-${n}`, `Produto online ${n}`, preco, agora, agora);
  getConnection()
    .prepare('INSERT INTO core_stock (company_id, product_id, quantity, reserved, updated_at) VALUES (?, ?, 20, 0, ?)')
    .run(companyId, id, agora);
  return id;
}

function pedidoOnline(productId: string, quantidade: number) {
  const [p] = checkout({
    idempotencyKey: `ck-rel-${(n += 1)}`,
    customerName: 'Cliente Online',
    customerEmail: 'online@exemplo.com',
    customerDocument: '11144477735',
    paymentMethod: 'pix',
    items: [{ productId, quantity: quantidade }],
  });
  return p;
}

async function vendaDeBalcao(total: number): Promise<string> {
  const p = await request(app).post('/api/v1/core/products').set(auth).send({ name: 'Item do balcão', priceCents: total });
  await request(app).post('/api/v1/core/stock/movements').set(auth).send({
    productId: p.body.id,
    movementType: 'in',
    quantity: 5,
    referenceType: 'entrada',
    referenceId: `carga-${randomUUID()}`,
  });
  const res = await request(app)
    .post('/api/v1/core/sales')
    .set(auth)
    .set('Idempotency-Key', randomUUID())
    .send({ items: [{ productId: p.body.id, quantity: 1 }], payments: [{ method: 'dinheiro', amountCents: total }] });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return (res.body.sale ?? res.body).id as string;
}

async function relatorio(id: string, qs = '') {
  const res = await request(app).get(`/api/v1/core/reports/${id}?from=${HOJE()}&to=${HOJE()}${qs}`).set(auth);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as { rows: Record<string, unknown>[]; totals: Record<string, number>; report: { caveat?: string; columns: { key: string }[] } };
}

beforeEach(async () => {
  resetDbForTests();
  n = 0;
  const login = await loginForTest(app, { userId: 'ger-rel', companyId: 'loja-rel', profileCodes: ['gerente_loja'] });
  auth = { Authorization: `Bearer ${login.body.accessToken}` };
  companyId = login.body.company.id;
});

/** Um dia com: 1 venda de balcão (R$ 100), 1 pedido online PAGO, 1 aguardando e 1 cancelado. */
async function diaMisto() {
  await vendaDeBalcao(10_000);
  const produto = produtoDaVitrine(7_500);
  const pago = pedidoOnline(produto, 2); // 15.000 (retirada, sem frete)
  markOrderPaid({ companyId, orderId: pago.id });
  pedidoOnline(produto, 1); // aguardando: não é venda
  const cancelado = pedidoOnline(produto, 1);
  cancelOrder({ companyId, orderId: cancelado.id, reason: 'desistiu' });
  return { pago, produto };
}

describe('"Vendas do período" junta balcão e loja online, e bate com o DRE', () => {
  it('o pedido pago entra com canal, cliente e total; aguardando e cancelado ficam fora', async () => {
    const { pago } = await diaMisto();
    const r = await relatorio('vendas');
    expect(r.report.columns.map((c) => c.key)).toContain('canal');

    const online = r.rows.filter((l) => l.canal === 'Loja online');
    expect(online).toHaveLength(1);
    expect(online[0]).toMatchObject({
      numero: pago.number,
      cliente: 'Cliente Online',
      vendedor: 'Loja online (sem vendedor)',
      itens: 2,
      total_cents: 15_000,
      dia: HOJE(),
    });
    expect(r.rows.filter((l) => l.canal === 'Balcão e oficina')).toHaveLength(1);
    expect(r.totals.total_cents).toBe(25_000);
    expect(String(r.report.caveat)).toMatch(/pedido online/i);

    // A régua é a do DRE: a mesma receita no mesmo dia.
    const dre = incomeStatement(companyId, HOJE(), HOJE());
    expect(dre.revenue.totalCents).toBe(r.totals.total_cents);
  });

  it('o painel mostra o pedido online ao lado, e a soma fecha com o relatório', async () => {
    await diaMisto();
    const painel = await request(app).get(`/api/v1/core/dashboard?from=${HOJE()}&to=${HOJE()}`).set(auth);
    expect(painel.status).toBe(200);
    expect(painel.body.revenueCents).toBe(10_000);
    expect(painel.body.onlineRevenueCents).toBe(15_000);
    expect(painel.body.onlineOrdersCount).toBe(1);
    const r = await relatorio('vendas');
    expect(painel.body.revenueCents + painel.body.onlineRevenueCents).toBe(r.totals.total_cents);
  });

  it('pedir só as canceladas não traz pedido online (cancelado nunca foi receita)', async () => {
    await diaMisto();
    const r = await relatorio('vendas', '&situacao=cancelled');
    expect(r.rows.filter((l) => l.canal === 'Loja online')).toHaveLength(0);
  });

  it('o pedido reembolsado continua na venda do dia em que foi pago; o reembolso é devolução', async () => {
    const { pago } = await diaMisto();
    const dev = await request(app).post(`/api/v1/core/orders/${pago.id}/devolver`).set(auth).send({ reason: 'desistiu' });
    expect(dev.status).toBe(200);
    const r = await relatorio('vendas');
    expect(r.rows.filter((l) => l.canal === 'Loja online')).toHaveLength(1);
    const dre = incomeStatement(companyId, HOJE(), HOJE());
    expect(dre.revenue.totalCents).toBe(r.totals.total_cents);
  });
});

describe('vendedor e produtos contam o online, declarado', () => {
  it('o ranking de vendedor tem a linha própria da loja online', async () => {
    await diaMisto();
    const r = await relatorio('vendedor');
    const online = r.rows.find((l) => l.vendedor === 'Loja online (sem vendedor)');
    expect(online).toMatchObject({ sales_count: 1, revenue_cents: 15_000, ticket_cents: 15_000 });
    expect(String(r.report.caveat)).toMatch(/comiss/i);
  });

  it('"Produtos vendidos" soma os itens do pedido online pago (sem o frete)', async () => {
    const { produto } = await diaMisto();
    const r = await relatorio('produtos');
    const linha = r.rows.find((l) => l.codigo === `REL-${produto.split('-').pop()}`);
    expect(linha).toMatchObject({ quantidade: 2, revenue_cents: 15_000 });
  });
});

describe('o BI do grupo conta a loja online, e mostra a parte dela', () => {
  it('faturamento, vendas e a coluna da loja online; o reembolso entra nas devoluções', async () => {
    const { pago } = await diaMisto();
    const antes = await request(app).get(`/api/v1/core/insights/operations?from=${HOJE()}&to=${HOJE()}`).set(auth);
    expect(antes.body.operations[0]).toMatchObject({
      salesCount: 2,
      revenueCents: 25_000,
      onlineOrdersCount: 1,
      onlineRevenueCents: 15_000,
      returnsCents: 0,
      netCents: 25_000,
    });

    await request(app).post(`/api/v1/core/orders/${pago.id}/devolver`).set(auth).send({ reason: 'desistiu' });
    const depois = await request(app).get(`/api/v1/core/insights/operations?from=${HOJE()}&to=${HOJE()}`).set(auth);
    expect(depois.body.operations[0]).toMatchObject({
      revenueCents: 25_000,
      returnsCents: 15_000,
      netCents: 10_000,
    });
    expect(depois.body.totals).toMatchObject({ onlineRevenueCents: 15_000, returnsCents: 15_000 });
  });
});
