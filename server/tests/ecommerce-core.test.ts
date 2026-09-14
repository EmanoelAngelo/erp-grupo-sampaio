/**
 * Loja online: vitrine sobre o estoque real, reserva no pedido, baixa só no
 * pagamento, e isolamento entre operações.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetEnvCacheForTests } from '../src/config/env.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { saveShippingSettings } from '../src/services/core/CheckoutShippingService.js';
import { loginForTest } from './helpers/auth.js';
import { abrirParaVisitante, VISITANTE } from './helpers/lojaAberta.js';
import { markOrderPaid, cancelOrder } from '../src/services/core/StorefrontService.js';

const app = createApp();

let gringaAuth: { Authorization: string };
let precoAuth: { Authorization: string };

async function createPublishedProduct(
  auth: { Authorization: string },
  name: string,
  priceCents: number,
  qty: number,
  category = 'Geral',
): Promise<string> {
  const product = await request(app)
    .post('/api/v1/core/products')
    .set(auth)
    .send({ name, priceCents, category, publishOnline: true });
  expect(product.status).toBe(201);
  await request(app).post('/api/v1/core/stock/movements').set(auth).send({
    productId: product.body.id,
    movementType: 'in',
    quantity: qty,
    referenceType: 'entrada',
    referenceId: `nf-${name}`,
  });
  return product.body.id as string;
}

beforeEach(async () => {
  resetDbForTests();
  const gringa = await loginForTest(app, {
    userId: 'ger-gringa',
    companyId: 'gringa',
    profileCodes: ['gerente_loja'],
  });
  gringaAuth = { Authorization: `Bearer ${gringa.body.accessToken}` };
  const preco = await loginForTest(app, {
    userId: 'ger-preco',
    companyId: 'preco-justo',
    profileCodes: ['gerente_loja'],
  });
  precoAuth = { Authorization: `Bearer ${preco.body.accessToken}` };
  // Este arquivo testa o checkout de VISITANTE (GAP-PRD-028: a loja precisa
  // estar aberta para ele) — ver `helpers/lojaAberta.ts`.
  abrirParaVisitante('gringa', 'preco-justo');
});

describe('vitrine', () => {
  it('só mostra produto publicado', async () => {
    await createPublishedProduct(gringaAuth, 'Tênis Publicado', 20000, 5);
    await request(app)
      .post('/api/v1/core/products')
      .set(gringaAuth)
      .send({ name: 'Item Interno', priceCents: 100 }); // publishOnline ausente

    const res = await request(app).get('/api/v1/loja/products');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].name).toBe('Tênis Publicado');
  });

  it('lê o estoque real da operação, sem catálogo paralelo', async () => {
    const id = await createPublishedProduct(gringaAuth, 'Camisa', 9900, 7);
    const before = await request(app).get('/api/v1/loja/products');
    expect(before.body.items[0].available).toBe(7);

    // Movimento feito no ERP aparece na vitrine — mesma fonte.
    await request(app).post('/api/v1/core/stock/movements').set(gringaAuth).send({
      productId: id,
      movementType: 'in',
      quantity: 3,
      referenceType: 'ajuste',
      referenceId: 'aj-1',
    });
    const after = await request(app).get('/api/v1/loja/products');
    expect(after.body.items[0].available).toBe(10);
  });

  it('separa lojas de serviços no portal', async () => {
    const res = await request(app).get('/api/v1/loja/stores');
    const slugs = res.body.stores.map((s: { slug: string }) => s.slug);
    expect(slugs).toContain('gringa');
    expect(slugs).toContain('preco-justo');
  });

  it('filtra por loja', async () => {
    await createPublishedProduct(gringaAuth, 'Produto Gringa', 1000, 2);
    await createPublishedProduct(precoAuth, 'Produto Preço Justo', 1000, 2);

    const res = await request(app).get('/api/v1/loja/products').query({ store: 'gringa' });
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].name).toBe('Produto Gringa');
    expect(res.body.items[0].storeName).toBe('gringa');
  });
});

describe('promoções', () => {
  it('aplicam preço promocional sem alterar o preço-base', async () => {
    const productId = await createPublishedProduct(gringaAuth, 'Jaqueta', 30000, 4);

    const company = getConnection()
      .prepare("SELECT id FROM core_companies WHERE slug = 'gringa'")
      .get() as { id: string };
    getConnection()
      .prepare(
        `INSERT INTO core_promotions (id, company_id, product_id, price_cents, starts_at, ends_at, active, created_at)
         VALUES ('promo-1', ?, ?, 24000, ?, NULL, 1, ?)`,
      )
      .run(company.id, productId, new Date(Date.now() - 3600_000).toISOString(), new Date().toISOString());

    const res = await request(app).get('/api/v1/loja/products');
    const item = res.body.items[0];
    expect(item.basePriceCents).toBe(30000);
    expect(item.priceCents).toBe(24000);
    expect(item.onSale).toBe(true);

    // O cadastro segue com o preço original.
    const product = await request(app).get(`/api/v1/core/products/${productId}`).set(gringaAuth);
    expect(product.body.price_cents).toBe(30000);
  });

  it('o mesmo preço promocional vale no PDV', async () => {
    // A vitrine anunciava o desconto e o balcão cobrava a tabela: o cliente
    // via um preço na internet e outro no caixa.
    const productId = await createPublishedProduct(gringaAuth, 'Casaco', 40000, 5);
    const company = getConnection()
      .prepare("SELECT id FROM core_companies WHERE slug = 'gringa'")
      .get() as { id: string };
    getConnection()
      .prepare(
        `INSERT INTO core_promotions (id, company_id, product_id, percent_off, starts_at, active, created_at)
         VALUES ('promo-pdv', ?, ?, 25, ?, 1, ?)`,
      )
      .run(company.id, productId, new Date(Date.now() - 1000).toISOString(), new Date().toISOString());

    const loja = await request(app).get('/api/v1/loja/products');
    const vitrine = loja.body.items.find((i: { name: string }) => i.name === 'Casaco');
    expect(vitrine.priceCents).toBe(30000);

    const venda = await request(app)
      .post('/api/v1/core/sales')
      .set(gringaAuth)
      .set('Idempotency-Key', 'venda-promocional')
      .send({
        items: [{ productId, quantity: 1 }],
        payments: [{ method: 'dinheiro', amountCents: 30000 }],
      });
    expect(venda.status).toBe(201);
    expect(venda.body.total_cents).toBe(vitrine.priceCents);
  });

  it('promoção expirada não vale', async () => {
    const productId = await createPublishedProduct(gringaAuth, 'Bota', 50000, 2);
    const company = getConnection()
      .prepare("SELECT id FROM core_companies WHERE slug = 'gringa'")
      .get() as { id: string };
    getConnection()
      .prepare(
        `INSERT INTO core_promotions (id, company_id, product_id, price_cents, starts_at, ends_at, active, created_at)
         VALUES ('promo-old', ?, ?, 10000, ?, ?, 1, ?)`,
      )
      .run(
        company.id,
        productId,
        new Date(Date.now() - 7200_000).toISOString(),
        new Date(Date.now() - 3600_000).toISOString(),
        new Date().toISOString(),
      );

    const res = await request(app).get('/api/v1/loja/products');
    expect(res.body.items[0].priceCents).toBe(50000);
    expect(res.body.items[0].onSale).toBe(false);
  });
});

describe('checkout', () => {
  it('reserva estoque sem baixar', async () => {
    const productId = await createPublishedProduct(gringaAuth, 'Mochila', 15000, 5);

    const res = await request(app)
      .post('/api/v1/loja/checkout')
      .set('Idempotency-Key', 'pedido-1')
      .send({
        customerName: 'Ana Compradora',
        ...VISITANTE,
        paymentMethod: 'pix',
        items: [{ productId, quantity: 2 }],
      });
    expect(res.status).toBe(201);
    expect(res.body.orders).toHaveLength(1);
    expect(res.body.orders[0].status).toBe('aguardando_pagamento');

    // Estoque físico intacto, disponível reduzido pela reserva.
    const stock = await request(app).get('/api/v1/core/stock').set(gringaAuth);
    expect(stock.body.items[0].quantity).toBe(5);
    expect(stock.body.items[0].reserved).toBe(2);

    const loja = await request(app).get('/api/v1/loja/products');
    expect(loja.body.items[0].available).toBe(3);
  });

  it('não vende mais do que existe', async () => {
    const productId = await createPublishedProduct(gringaAuth, 'Item Escasso', 1000, 1);
    await request(app)
      .post('/api/v1/loja/checkout')
      .set('Idempotency-Key', 'pedido-a')
      .send({ customerName: 'A', ...VISITANTE, paymentMethod: 'pix', items: [{ productId, quantity: 1 }] });

    const second = await request(app)
      .post('/api/v1/loja/checkout')
      .set('Idempotency-Key', 'pedido-b')
      .send({ customerName: 'B', ...VISITANTE, paymentMethod: 'pix', items: [{ productId, quantity: 1 }] });

    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('CORE_INSUFFICIENT_STOCK');
  });

  it('reenviar o mesmo checkout não duplica pedido', async () => {
    const productId = await createPublishedProduct(gringaAuth, 'Boné', 5000, 10);
    const body = {
      customerName: 'Ana',
      ...VISITANTE,
      paymentMethod: 'pix',
      items: [{ productId, quantity: 1 }],
    };
    const first = await request(app)
      .post('/api/v1/loja/checkout')
      .set('Idempotency-Key', 'repetido')
      .send(body);
    const second = await request(app)
      .post('/api/v1/loja/checkout')
      .set('Idempotency-Key', 'repetido')
      .send(body);

    expect(second.body.orders[0].id).toBe(first.body.orders[0].id);
    const stock = await request(app).get('/api/v1/core/stock').set(gringaAuth);
    expect(stock.body.items[0].reserved).toBe(1);
  });

  it('carrinho com duas lojas vira um pedido por operação', async () => {
    const a = await createPublishedProduct(gringaAuth, 'Da Gringa', 10000, 3);
    const b = await createPublishedProduct(precoAuth, 'Do Preço Justo', 20000, 3);

    const res = await request(app)
      .post('/api/v1/loja/checkout')
      .set('Idempotency-Key', 'multi')
      .send({
        customerName: 'Ana',
        ...VISITANTE,
        paymentMethod: 'pix',
        items: [
          { productId: a, quantity: 1 },
          { productId: b, quantity: 1 },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.orders).toHaveLength(2);
    // Faturamento não se mistura: empresas diferentes.
    const companies = new Set(res.body.orders.map((o: { company_id: string }) => o.company_id));
    expect(companies.size).toBe(2);
  });

  it('recusa produto não publicado', async () => {
    const product = await request(app)
      .post('/api/v1/core/products')
      .set(gringaAuth)
      .send({ name: 'Só interno', priceCents: 1000 });

    const res = await request(app)
      .post('/api/v1/loja/checkout')
      .set('Idempotency-Key', 'nao-publicado')
      .send({
        customerName: 'Ana',
        ...VISITANTE,
        paymentMethod: 'pix',
        items: [{ productId: product.body.id, quantity: 1 }],
      });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('CORE_PRODUCT_NOT_AVAILABLE');
  });

  it('usa o preço promocional no pedido, não o enviado pelo cliente', async () => {
    const productId = await createPublishedProduct(gringaAuth, 'Relógio', 100000, 3);
    const company = getConnection()
      .prepare("SELECT id FROM core_companies WHERE slug = 'gringa'")
      .get() as { id: string };
    getConnection()
      .prepare(
        `INSERT INTO core_promotions (id, company_id, product_id, percent_off, starts_at, active, created_at)
         VALUES ('promo-2', ?, ?, 20, ?, 1, ?)`,
      )
      .run(company.id, productId, new Date(Date.now() - 1000).toISOString(), new Date().toISOString());

    const res = await request(app)
      .post('/api/v1/loja/checkout')
      .set('Idempotency-Key', 'promo-pedido')
      .send({
        customerName: 'Ana',
        ...VISITANTE,
        paymentMethod: 'pix',
        // Cliente tentando ditar o preço: ignorado.
        items: [{ productId, quantity: 1, unitPriceCents: 1 }],
      });
    expect(res.body.orders[0].total_cents).toBe(80000);
  });
});

describe('pagamento e fulfillment', () => {
  /**
   * `entrega: true` ARRANJA a entrega, porque agora é preciso arranjar.
   *
   * Pedido sem forma de entrega escolhida nasce como RETIRADA. Antes nascia
   * com método nulo, que o sistema lia como "entrega", e a loja despachava de
   * graça sem ninguém ver. Quem quer testar o caminho da expedição precisa,
   * como o cliente, escolher entrega e pagar frete.
   */
  async function placeOrder(opcoes: { entrega?: boolean } = {}) {
    const productId = await createPublishedProduct(gringaAuth, 'Produto Pago', 25000, 6);
    const corpo: Record<string, unknown> = {
      customerName: 'Ana',
      ...VISITANTE,
      paymentMethod: 'pix',
      items: [{ productId, quantity: 2 }],
    };

    if (opcoes.entrega) {
      const dono = getConnection()
        .prepare('SELECT company_id FROM core_products WHERE id = ?')
        .get(productId) as { company_id: string };
      saveShippingSettings({
        companyId: dono.company_id,
        pickupEnabled: true,
        deliveryEnabled: true,
        flatRateCents: 2500,
        estimatedDays: 4,
      });
      corpo.shippingMethod = 'tabela_da_loja';
      corpo.shippingZip = '01310-100';
      corpo.shippingAddress = 'Avenida Paulista, 1000 - São Paulo/SP';
    }

    const res = await request(app)
      .post('/api/v1/loja/checkout')
      .set('Idempotency-Key', `p-${Math.random()}`)
      .send(corpo);
    return { order: res.body.orders[0], productId };
  }

  it('sem credencial do provedor a cobrança fica explicitamente não configurada', async () => {
    const { order } = await placeOrder();
    const intents = getConnection()
      .prepare('SELECT status, provider FROM core_payment_intents WHERE origin_id = ?')
      .all(order.id) as unknown as { status: string; provider: string }[];
    expect(intents).toHaveLength(1);
    // Nem "pago", nem QR inventado.
    expect(intents[0].status).toBe('unconfigured');
  });

  it('pagamento confirmado converte reserva em baixa e gera um lançamento', async () => {
    const { order, productId } = await placeOrder();
    markOrderPaid({ companyId: order.company_id, orderId: order.id });

    const stock = await request(app).get('/api/v1/core/stock').set(gringaAuth);
    const line = stock.body.items.find((i: { product_id: string }) => i.product_id === productId);
    expect(line.quantity).toBe(4);
    expect(line.reserved).toBe(0);

    const entries = getConnection()
      .prepare("SELECT COUNT(*) AS n FROM core_finance_entries WHERE origin_type = 'ecommerce_order'")
      .get() as { n: number };
    expect(entries.n).toBe(1);
  });

  it('confirmar duas vezes não baixa estoque de novo', async () => {
    const { order, productId } = await placeOrder();
    markOrderPaid({ companyId: order.company_id, orderId: order.id });
    markOrderPaid({ companyId: order.company_id, orderId: order.id });

    const stock = await request(app).get('/api/v1/core/stock').set(gringaAuth);
    const line = stock.body.items.find((i: { product_id: string }) => i.product_id === productId);
    expect(line.quantity).toBe(4);
  });

  it('cancelar libera a reserva', async () => {
    const { order, productId } = await placeOrder();
    cancelOrder({ companyId: order.company_id, orderId: order.id, reason: 'desistência' });

    const stock = await request(app).get('/api/v1/core/stock').set(gringaAuth);
    const line = stock.body.items.find((i: { product_id: string }) => i.product_id === productId);
    expect(line.quantity).toBe(6);
    expect(line.reserved).toBe(0);
  });

  it('não separa pedido que ainda não foi pago', async () => {
    const { order } = await placeOrder();
    const res = await request(app)
      .post(`/api/v1/core/orders/${order.id}/fulfillment`)
      .set(gringaAuth)
      .send({ status: 'separacao' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CORE_ORDER_NOT_PAID');
  });

  it('pedido pago avança pelas etapas do OMS', async () => {
    // Caminho de ENTREGA: é o único que chega em 'expedido'.
    const { order } = await placeOrder({ entrega: true });
    markOrderPaid({ companyId: order.company_id, orderId: order.id });

    for (const status of ['separacao', 'conferencia', 'embalado', 'expedido']) {
      const res = await request(app)
        .post(`/api/v1/core/orders/${order.id}/fulfillment`)
        .set(gringaAuth)
        // Expedir é DESPACHAR, e diz QUEM leva (GAP-PRD-119): sem a
        // transportadora o código era texto solto, sem link no portal.
        .send(status === 'expedido' ? { status, carrier: 'generic', trackingCode: 'BR123456789' } : { status });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe(status);
    }

    // Pela rota do gestor, com sessão. A pública `GET /loja/orders/:id` foi
    // apagada na rodada 34: devolvia o CPF inteiro do comprador a quem
    // soubesse o id, e nenhuma tela a usava.
    const detail = await request(app).get(`/api/v1/core/orders/${order.id}`).set(gringaAuth);
    expect(detail.status).toBe(200);
    expect(detail.body.tracking_code).toBe('BR123456789');
    expect(detail.body.events.length).toBeGreaterThanOrEqual(5);
  });

  it('o pedido NÃO é lido por quem só sabe o id', async () => {
    /*
      A rota pública existia com o comentário "o id opaco do pedido é a
      credencial" — e devolvia `SELECT *` de core_orders: CPF em claro, e-mail,
      endereço, referência de pagamento. A rota irmã do portal mascara o
      documento. O id circula em URL, histórico e log; não é credencial.
    */
    const { order } = await placeOrder();
    const res = await request(app).get(`/api/v1/loja/orders/${order.id}`);
    expect(res.status).toBe(404);
    expect(res.body.customer_document).toBeUndefined();
  });
});

describe('webhook de pagamento', () => {
  // Rota sem operação na URL: quem prova a origem é o token do ambiente. Estes
  // testes passavam sem token nenhum, o que só era possível porque a ausência
  // de token dispensava a conferência.
  const TOKEN_AMBIENTE = 'token-do-ambiente';

  beforeEach(() => {
    process.env.ASAAS_WEBHOOK_AUTH_TOKEN = TOKEN_AMBIENTE;
    resetEnvCacheForTests();
  });

  afterEach(() => {
    delete process.env.ASAAS_WEBHOOK_AUTH_TOKEN;
    resetEnvCacheForTests();
  });

  it('rejeita evento sem identificador', async () => {
    const res = await request(app)
      .post('/api/v1/loja/webhooks/payments/asaas')
      .set('asaas-access-token', TOKEN_AMBIENTE)
      .send({});
    expect(res.status).toBe(400);
  });

  it('não processa o mesmo evento duas vezes', async () => {
    const payload = { id: 'evt_1', event: 'PAYMENT_RECEIVED', payment: { id: 'pay_1' } };
    const first = await request(app)
      .post('/api/v1/loja/webhooks/payments/asaas')
      .set('asaas-access-token', TOKEN_AMBIENTE)
      .send(payload);
    const second = await request(app)
      .post('/api/v1/loja/webhooks/payments/asaas')
      .set('asaas-access-token', TOKEN_AMBIENTE)
      .send(payload);
    expect(first.body.duplicated).toBe(false);
    expect(second.body.duplicated).toBe(true);
  });

  it('sem token de ambiente, a rota sem operação não aceita nada', async () => {
    delete process.env.ASAAS_WEBHOOK_AUTH_TOKEN;
    resetEnvCacheForTests();

    const res = await request(app)
      .post('/api/v1/loja/webhooks/payments/asaas')
      .send({ id: 'evt_aberto', event: 'PAYMENT_RECEIVED', payment: { id: 'pay_aberto' } });

    expect(res.status).toBe(503);
  });
});
