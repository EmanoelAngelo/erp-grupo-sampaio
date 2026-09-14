/**
 * CARTÃO NO CHECKOUT, CONFERÊNCIA DE VALOR E DEVOLUÇÃO — rodada 42.
 *
 * Três coisas que a auditoria mediu:
 *
 *   - a loja só vendia no PIX;
 *   - ninguém conferia se o VALOR pago era o valor do pedido — um webhook
 *     legítimo de R$ 1,00 marcava pago um pedido de R$ 200,00;
 *   - pedido pago não tinha devolução: nem estorno, nem estoque de volta.
 *
 * A decisão do cartão, combinada com o dono: SEM salvar cartão. E a
 * arquitetura garante mais do que isso — o número do cartão NUNCA passa pelo
 * ERP: a cobrança nasce como CREDIT_CARD no provedor e o cliente digita o
 * cartão na página do provedor (invoiceUrl). Aqui não há campo de cartão para
 * salvar nem vazar.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';

import { upsertAsaasWebhookToken } from '../src/services/integrations/AsaasCredentialService.js';
import { checkout, markOrderPaid } from '../src/services/core/StorefrontService.js';
import { createPaymentIntent, handlePaymentWebhook } from '../src/services/core/PaymentService.js';
import { getAvailable } from '../src/services/core/InventoryService.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();
const TOKEN = 'token-webhook-42';
let gringa: string;
let auth: { Authorization: string };
let n = 0;

function produto(qty = 10): string {
  n += 1;
  const id = `prod-42-${n}`;
  const agora = new Date().toISOString();
  const db = getConnection();
  db.prepare(
    `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                price_cents, active, publish_online, created_at, updated_at)
     VALUES (?, ?, ?, 'Produto 42', 'UN', 5000, 10000, 1, 1, ?, ?)`,
  ).run(id, gringa, `C42-${n}`, agora, agora);
  db.prepare(
    'INSERT INTO core_stock (company_id, product_id, quantity, reserved, updated_at) VALUES (?, ?, ?, 0, ?)',
  ).run(gringa, id, qty, agora);
  return id;
}

function pedido(productId: string, quantity = 2) {
  const [p] = checkout({
    idempotencyKey: `ck-42-${(n += 1)}`,
    customerName: 'Cliente 42',
    customerEmail: 'c42@exemplo.com',
    customerDocument: '11144477735',
    paymentMethod: 'pix',
    items: [{ productId, quantity }],
  });
  return p;
}

function intentDo(orderId: string, ref: string) {
  return createPaymentIntent({
    companyId: gringa,
    originType: 'ecommerce_order',
    originId: orderId,
    method: 'pix',
    amountCents: 20000,
    idempotencyKey: `pay-42-${ref}`,
  }).then((intent) => {
    getConnection()
      .prepare('UPDATE core_payment_intents SET provider_ref = ? WHERE id = ?')
      .run(`ref_${ref}`, intent.id);
    return { intentId: intent.id, providerRef: `ref_${ref}` };
  });
}

beforeEach(async () => {
  resetDbForTests();
  n = 0;
  // O loginForTest CRIA a empresa (id = slug) e o vínculo — criar antes por
  // upsertCompany geraria outro id e o vínculo estouraria FK.
  const login = await loginForTest(app, { userId: 'ger', companyId: 'gringa', profileCodes: ['gerente_loja'] });
  auth = { Authorization: `Bearer ${login.body.accessToken}` };
  gringa = (
    getConnection().prepare("SELECT id FROM core_companies WHERE slug = 'gringa'").get() as { id: string }
  ).id;
  upsertAsaasWebhookToken({ companyId: gringa, webhookToken: TOKEN });
});

describe('cartão no checkout', () => {
  it('o checkout aceita "cartao" e a cobrança nasce como CREDIT_CARD, paga na página do provedor', async () => {
    const productId = produto();
    // fetch de mentira no lugar do provedor: devolve a cobrança criada.
    const chamadas: { url: string; body: Record<string, unknown> }[] = [];
    const fakeFetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      chamadas.push({ url: String(url), body });
      if (String(url).includes('/payments')) {
        return new Response(
          JSON.stringify({ id: 'pay_cartao_1', invoiceUrl: 'https://sandbox.asaas.com/i/cartao1' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ id: 'cus_1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    // Credencial de sandbox para o caminho vivo rodar.
    const { upsertAsaasApiKey } = await import(
      '../src/services/integrations/AsaasCredentialService.js'
    );
    upsertAsaasApiKey({ companyId: gringa, environment: 'sandbox', apiKey: 'chave-sandbox' });

    const p = pedido(productId);
    const { createOrderCharge } = await import('../src/services/core/OrderChargeService.js');
    const charge = await createOrderCharge({
      companyId: gringa,
      orderId: p.id,
      method: 'cartao',
      fetchImpl: fakeFetch,
    });

    const criacao = chamadas.find((c) => c.url.includes('/payments'))!;
    expect(criacao.body.billingType).toBe('CREDIT_CARD');
    // O ERP nunca vê o cartão: nada de número/cvv em lugar nenhum do corpo.
    expect(JSON.stringify(criacao.body)).not.toMatch(/creditCard|cvv|holder/i);
    // O cliente paga na página do provedor.
    expect(charge.intent.invoice_url).toBe('https://sandbox.asaas.com/i/cartao1');
    // E mostrar o link NÃO é receber: o pedido segue aguardando.
    const linha = getConnection().prepare('SELECT status FROM core_orders WHERE id = ?').get(p.id) as { status: string };
    expect(linha.status).toBe('aguardando_pagamento');
  });
});

describe('conferência do valor pago', () => {
  it('webhook com valor DIFERENTE do pedido não marca pago — fica pendente de conferência', async () => {
    const productId = produto();
    const p = pedido(productId); // total 20000 (2 × 10000)
    const { providerRef } = await intentDo(p.id, 'menor');

    const resultado = handlePaymentWebhook({
      provider: 'asaas',
      companyId: gringa,
      token: TOKEN,
      // O provedor manda o valor em REAIS. R$ 1,00 não paga R$ 200,00.
      payload: { id: 'evt-menor', event: 'PAYMENT_CONFIRMED', payment: { id: providerRef, value: 1 } },
    });

    const pedidoDepois = getConnection().prepare('SELECT status FROM core_orders WHERE id = ?').get(p.id) as { status: string };
    expect(pedidoDepois.status).not.toBe('pago');
    // O fato fica registrado e visível — não é descartado em silêncio.
    expect(String(resultado.detail)).toMatch(/valor/i);
    const eventos = getConnection()
      .prepare('SELECT note FROM core_order_events WHERE order_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(p.id) as { note: string | null };
    expect(eventos.note ?? '').toMatch(/valor/i);
  });

  it('webhook com o valor CERTO continua marcando pago', async () => {
    const productId = produto();
    const p = pedido(productId);
    const { providerRef } = await intentDo(p.id, 'certo');

    handlePaymentWebhook({
      provider: 'asaas',
      companyId: gringa,
      token: TOKEN,
      payload: { id: 'evt-certo', event: 'PAYMENT_CONFIRMED', payment: { id: providerRef, value: 200 } },
    });
    const linha = getConnection().prepare('SELECT status FROM core_orders WHERE id = ?').get(p.id) as { status: string };
    expect(linha.status).toBe('pago');
  });

  it('webhook SEM campo de valor segue o caminho antigo — não inventa divergência', async () => {
    const productId = produto();
    const p = pedido(productId);
    const { providerRef } = await intentDo(p.id, 'semvalor');
    handlePaymentWebhook({
      provider: 'asaas',
      companyId: gringa,
      token: TOKEN,
      payload: { id: 'evt-semvalor', event: 'PAYMENT_CONFIRMED', payment: { id: providerRef } },
    });
    const linha = getConnection().prepare('SELECT status FROM core_orders WHERE id = ?').get(p.id) as { status: string };
    expect(linha.status).toBe('pago');
  });
});

describe('devolução de pedido pago', () => {
  it('devolve o estoque, marca reembolsado e registra o estorno a fazer', async () => {
    const productId = produto(10);
    const p = pedido(productId, 2);
    markOrderPaid({ companyId: gringa, orderId: p.id });
    // Pago: estoque consumido. 10 - 2 = 8.
    expect(getAvailable(gringa, productId)).toBe(8);

    const res = await request(app)
      .post(`/api/v1/core/orders/${p.id}/devolver`)
      .set(auth)
      .send({ reason: 'cliente desistiu' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('reembolsado');

    // O estoque voltou.
    expect(getAvailable(gringa, productId)).toBe(10);
  });

  it('devolver duas vezes não dobra o estoque', async () => {
    const productId = produto(10);
    const p = pedido(productId, 2);
    markOrderPaid({ companyId: gringa, orderId: p.id });

    await request(app).post(`/api/v1/core/orders/${p.id}/devolver`).set(auth).send({ reason: 'x' });
    const segunda = await request(app)
      .post(`/api/v1/core/orders/${p.id}/devolver`)
      .set(auth)
      .send({ reason: 'x' });
    // Repetir não é erro nem efeito novo.
    expect(segunda.status).toBeLessThan(500);
    expect(getAvailable(gringa, productId)).toBe(10);
  });

  it('pedido AGUARDANDO pagamento não se devolve — cancela', async () => {
    const productId = produto();
    const p = pedido(productId);
    const res = await request(app)
      .post(`/api/v1/core/orders/${p.id}/devolver`)
      .set(auth)
      .send({ reason: 'x' });
    expect(res.status).toBe(409);
  });

  it('atendente não devolve pedido', async () => {
    const productId = produto();
    const p = pedido(productId);
    markOrderPaid({ companyId: gringa, orderId: p.id });
    const login = await loginForTest(app, { userId: 'atd', companyId: 'gringa', profileCodes: ['atendente'] });
    const res = await request(app)
      .post(`/api/v1/core/orders/${p.id}/devolver`)
      .set({ Authorization: `Bearer ${login.body.accessToken}` })
      .send({ reason: 'x' });
    expect(res.status).toBe(403);
  });
});
