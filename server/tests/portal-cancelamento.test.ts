/**
 * Cancelamento pelo cliente, e o que acontece quando o dinheiro chega depois.
 *
 * Dois riscos concretos moram aqui:
 *
 * 1. O botão libera reserva de estoque. Cancelar dez vezes não pode devolver
 *    dez peças ao estoque livre — seria estoque inventado, e a operação
 *    venderia o que não tem.
 *
 * 2. O provedor confirma pagamentos com atraso. Um PIX pago segundos antes do
 *    cancelamento chega depois dele. O pedido NÃO pode ressuscitar: a reserva
 *    já foi liberada e a peça pode ter sido vendida a outra pessoa. Também não
 *    pode sumir: é dinheiro real na conta da empresa e alguém precisa
 *    regularizar.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
// O código e o link moram selados fora do corpo da fila (GAP-PRD-007): o
// teste lê o e-mail como o CLIENTE o recebe, pela montagem do carteiro.
import { textoDeEntrega } from '../src/services/notifications/EmailService.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import {
  advanceFulfillment,
  checkout,
  listOrders,
} from '../src/services/core/StorefrontService.js';
import { confirmarEmail } from '../src/services/core/CustomerPortalService.js';
import { createPaymentIntent, handlePaymentWebhook } from '../src/services/core/PaymentService.js';
import { upsertAsaasWebhookToken } from '../src/services/integrations/AsaasCredentialService.js';

const app = createApp();
const SENHA = 'senha-do-cliente-2026';
const TOKEN_WEBHOOK = 'token-webhook-cancelamento';

let gringa: string;
let n = 0;

function produto(companyId: string): string {
  n += 1;
  const id = `prod-cancel-${n}`;
  const agora = new Date().toISOString();
  const db = getConnection();
  db.prepare(
    `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                price_cents, active, publish_online, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'UN', 4000, 10000, 1, 1, ?, ?)`,
  ).run(id, companyId, `CN-${n}`, `Item ${n}`, agora, agora);
  db.prepare(
    'INSERT INTO core_stock (company_id, product_id, quantity, reserved, updated_at) VALUES (?, ?, 20, 0, ?)',
  ).run(companyId, id, agora);
  return id;
}

function comprar(input: { email: string; documento: string; chave: string }): {
  orderId: string;
  productId: string;
} {
  const productId = produto(gringa);
  const [pedido] = checkout({
    idempotencyKey: input.chave,
    customerName: 'Cliente do Portal',
    customerEmail: input.email,
    customerDocument: input.documento,
    paymentMethod: 'pix',
    items: [{ productId, quantity: 2 }],
  });
  return { orderId: pedido.id, productId };
}

async function criarAcesso(email: string, documento: string) {
  const res = await request(app)
    .post('/api/v1/loja/portal/registrar')
    .send({ termsAccepted: true, email, document: documento, password: SENHA });
  expect(res.status).toBe(201);
  // Rodada 50: a co-prova espera o código — prova a caixa na hora, como o
  // dono dela faria (a espera em si mora em cadastro-por-email.test.ts).
  const linha = getConnection()
    .prepare(
      `SELECT id FROM core_email_queue
        WHERE template = 'verificacao_email' AND to_address = ?
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(email) as { id: string } | undefined;
  const codigo = (linha ? textoDeEntrega(linha.id) : null)?.match(/é: (\d{6})/)?.[1];
  expect(codigo, 'codigo de verificacao ausente na fila').toBeTruthy(); confirmarEmail({ accountId: res.body.account.id as string, codigo });
  return res.body.token as string;
}

function reservado(productId: string): number {
  const linha = getConnection()
    .prepare('SELECT reserved FROM core_stock WHERE company_id = ? AND product_id = ?')
    .get(gringa, productId) as { reserved: number };
  return linha.reserved;
}

function statusDoPedido(orderId: string): string {
  return (
    getConnection().prepare('SELECT status FROM core_orders WHERE id = ?').get(orderId) as {
      status: string;
    }
  ).status;
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  n = 0;
  gringa = await upsertCompany({ slug: 'gringa', tradeName: 'Gringa', legalName: 'Gringa Ltda' });
  upsertAsaasWebhookToken({ companyId: gringa, webhookToken: TOKEN_WEBHOOK });
});

describe('cancelamento pelo cliente', () => {
  it('cancela pedido aguardando pagamento e devolve a reserva ao estoque livre', async () => {
    const pedido = comprar({ email: 'ana@exemplo.com', documento: '111.444.777-35', chave: 'x1' });
    const token = await criarAcesso('ana@exemplo.com', '111.444.777-35');
    expect(reservado(pedido.productId)).toBe(2);

    const res = await request(app)
      .post(`/api/v1/loja/portal/pedidos/${pedido.orderId}/cancelar`)
      .set('x-portal-token', token);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelado');
    expect(reservado(pedido.productId)).toBe(0);
  });

  it('dez cliques em cancelar liberam a reserva UMA vez', async () => {
    const pedido = comprar({ email: 'ana@exemplo.com', documento: '111.444.777-35', chave: 'x2' });
    const token = await criarAcesso('ana@exemplo.com', '111.444.777-35');

    for (let i = 0; i < 10; i += 1) {
      const res = await request(app)
        .post(`/api/v1/loja/portal/pedidos/${pedido.orderId}/cancelar`)
        .set('x-portal-token', token);
      expect(res.status).toBe(200);
    }

    // Sem a idempotência, dez cliques fariam reserva ir a -18: estoque livre
    // maior do que a quantidade física.
    expect(reservado(pedido.productId)).toBe(0);
    const estoque = getConnection()
      .prepare('SELECT quantity FROM core_stock WHERE company_id = ? AND product_id = ?')
      .get(gringa, pedido.productId) as { quantity: number };
    expect(estoque.quantity).toBe(20);
  });

  it('a cobrança pendente é cancelada junto — PIX cancelado não recebe mais', async () => {
    const pedido = comprar({ email: 'ana@exemplo.com', documento: '111.444.777-35', chave: 'x3' });
    await createPaymentIntent({
      companyId: gringa,
      originType: 'ecommerce_order',
      originId: pedido.orderId,
      method: 'pix',
      amountCents: 20000,
      idempotencyKey: 'pay-x3',
    });
    // Cobrança viva de verdade: é esta que não pode continuar recebendo.
    getConnection()
      .prepare("UPDATE core_payment_intents SET status = 'pending' WHERE origin_id = ?")
      .run(pedido.orderId);
    const token = await criarAcesso('ana@exemplo.com', '111.444.777-35');

    await request(app)
      .post(`/api/v1/loja/portal/pedidos/${pedido.orderId}/cancelar`)
      .set('x-portal-token', token)
      .expect(200);

    const intent = getConnection()
      .prepare('SELECT status FROM core_payment_intents WHERE origin_id = ?')
      .get(pedido.orderId) as { status: string };
    expect(intent.status).toBe('cancelled');
  });

  it('pedido já pago NÃO se cancela pelo portal — o caminho é devolução', async () => {
    const pedido = comprar({ email: 'ana@exemplo.com', documento: '111.444.777-35', chave: 'x4' });
    const intent = await createPaymentIntent({
      companyId: gringa,
      originType: 'ecommerce_order',
      originId: pedido.orderId,
      method: 'pix',
      amountCents: 20000,
      idempotencyKey: 'pay-x4',
    });
    getConnection()
      .prepare("UPDATE core_payment_intents SET provider_ref = 'pay_x4' WHERE id = ?")
      .run(intent.id);
    handlePaymentWebhook({
      provider: 'asaas',
      companyId: gringa,
      token: TOKEN_WEBHOOK,
      payload: { id: 'ev-x4', event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_x4' } },
    });
    const token = await criarAcesso('ana@exemplo.com', '111.444.777-35');

    const res = await request(app)
      .post(`/api/v1/loja/portal/pedidos/${pedido.orderId}/cancelar`)
      .set('x-portal-token', token);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CORE_ORDER_ALREADY_PAID');
    expect(statusDoPedido(pedido.orderId)).toBe('pago');
  });

  it('pedido já em separação NÃO se cancela — a mercadoria já saiu da prateleira', async () => {
    const pedido = comprar({ email: 'ana@exemplo.com', documento: '111.444.777-35', chave: 'x5' });
    const intent = await createPaymentIntent({
      companyId: gringa,
      originType: 'ecommerce_order',
      originId: pedido.orderId,
      method: 'pix',
      amountCents: 20000,
      idempotencyKey: 'pay-x5',
    });
    getConnection()
      .prepare("UPDATE core_payment_intents SET provider_ref = 'pay_x5' WHERE id = ?")
      .run(intent.id);
    handlePaymentWebhook({
      provider: 'asaas',
      companyId: gringa,
      token: TOKEN_WEBHOOK,
      payload: { id: 'ev-x5', event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_x5' } },
    });
    advanceFulfillment({ companyId: gringa, orderId: pedido.orderId, toStatus: 'separacao' });
    const token = await criarAcesso('ana@exemplo.com', '111.444.777-35');

    const res = await request(app)
      .post(`/api/v1/loja/portal/pedidos/${pedido.orderId}/cancelar`)
      .set('x-portal-token', token);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CORE_ORDER_IN_FULFILLMENT');
    expect(statusDoPedido(pedido.orderId)).toBe('separacao');
  });

  it('cliente NÃO cancela pedido de outro cliente — nem sabendo o id', async () => {
    const alheio = comprar({ email: 'ana@exemplo.com', documento: '111.444.777-35', chave: 'x6' });
    comprar({ email: 'bruno@exemplo.com', documento: '529.982.247-25', chave: 'x7' });
    const tokenBruno = await criarAcesso('bruno@exemplo.com', '529.982.247-25');

    const res = await request(app)
      .post(`/api/v1/loja/portal/pedidos/${alheio.orderId}/cancelar`)
      .set('x-portal-token', tokenBruno);

    expect(res.status).toBe(404);
    expect(statusDoPedido(alheio.orderId)).toBe('aguardando_pagamento');
    expect(reservado(alheio.productId)).toBe(2);
  });

  it('sem sessão não cancela nada', async () => {
    const pedido = comprar({ email: 'ana@exemplo.com', documento: '111.444.777-35', chave: 'x8' });

    const res = await request(app).post(
      `/api/v1/loja/portal/pedidos/${pedido.orderId}/cancelar`,
    );

    expect(res.status).toBe(401);
    expect(statusDoPedido(pedido.orderId)).toBe('aguardando_pagamento');
  });
});

describe('webhook que chega depois do cancelamento', () => {
  it('não ressuscita o pedido nem reserva estoque de novo', async () => {
    const pedido = comprar({ email: 'ana@exemplo.com', documento: '111.444.777-35', chave: 'y1' });
    const intent = await createPaymentIntent({
      companyId: gringa,
      originType: 'ecommerce_order',
      originId: pedido.orderId,
      method: 'pix',
      amountCents: 20000,
      idempotencyKey: 'pay-y1',
    });
    getConnection()
      .prepare("UPDATE core_payment_intents SET provider_ref = 'pay_y1' WHERE id = ?")
      .run(intent.id);
    const token = await criarAcesso('ana@exemplo.com', '111.444.777-35');
    await request(app)
      .post(`/api/v1/loja/portal/pedidos/${pedido.orderId}/cancelar`)
      .set('x-portal-token', token)
      .expect(200);

    handlePaymentWebhook({
      provider: 'asaas',
      companyId: gringa,
      token: TOKEN_WEBHOOK,
      payload: { id: 'ev-y1', event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_y1' } },
    });

    expect(statusDoPedido(pedido.orderId)).toBe('cancelado');
    expect(reservado(pedido.productId)).toBe(0);
  });

  it('o dinheiro recebido fica registrado e visível para o cliente', async () => {
    const pedido = comprar({ email: 'ana@exemplo.com', documento: '111.444.777-35', chave: 'y2' });
    const intent = await createPaymentIntent({
      companyId: gringa,
      originType: 'ecommerce_order',
      originId: pedido.orderId,
      method: 'pix',
      amountCents: 20000,
      idempotencyKey: 'pay-y2',
    });
    getConnection()
      .prepare("UPDATE core_payment_intents SET provider_ref = 'pay_y2' WHERE id = ?")
      .run(intent.id);
    const token = await criarAcesso('ana@exemplo.com', '111.444.777-35');
    await request(app)
      .post(`/api/v1/loja/portal/pedidos/${pedido.orderId}/cancelar`)
      .set('x-portal-token', token)
      .expect(200);

    handlePaymentWebhook({
      provider: 'asaas',
      companyId: gringa,
      token: TOKEN_WEBHOOK,
      payload: { id: 'ev-y2', event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_y2' } },
    });

    const res = await request(app)
      .get(`/api/v1/loja/portal/pedidos/${pedido.orderId}`)
      .set('x-portal-token', token);

    expect(res.status).toBe(200);
    expect(res.body.payments[0].statusLabel).toBe('Recebido após o cancelamento');
    const avisos = res.body.timeline.filter(
      (e: { statusLabel: string }) =>
        e.statusLabel === 'Pagamento recebido após o cancelamento',
    );
    expect(avisos).toHaveLength(1);
  });

  it('o provedor reenviando o mesmo aviso não gera pendência duplicada', async () => {
    const pedido = comprar({ email: 'ana@exemplo.com', documento: '111.444.777-35', chave: 'y3' });
    const intent = await createPaymentIntent({
      companyId: gringa,
      originType: 'ecommerce_order',
      originId: pedido.orderId,
      method: 'pix',
      amountCents: 20000,
      idempotencyKey: 'pay-y3',
    });
    getConnection()
      .prepare("UPDATE core_payment_intents SET provider_ref = 'pay_y3' WHERE id = ?")
      .run(intent.id);
    const token = await criarAcesso('ana@exemplo.com', '111.444.777-35');
    await request(app)
      .post(`/api/v1/loja/portal/pedidos/${pedido.orderId}/cancelar`)
      .set('x-portal-token', token)
      .expect(200);

    for (let i = 0; i < 5; i += 1) {
      handlePaymentWebhook({
        provider: 'asaas',
        companyId: gringa,
        token: TOKEN_WEBHOOK,
        payload: { id: `ev-y3-${i}`, event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_y3' } },
      });
    }

    const eventos = getConnection()
      .prepare(
        `SELECT COUNT(*) c FROM core_order_events
          WHERE order_id = ? AND status = 'pagamento_apos_cancelamento'`,
      )
      .get(pedido.orderId) as { c: number };
    expect(eventos.c).toBe(1);
    expect(statusDoPedido(pedido.orderId)).toBe('cancelado');
  });

  it('a operação enxerga a pendência na lista de pedidos', async () => {
    const normal = comprar({ email: 'ana@exemplo.com', documento: '111.444.777-35', chave: 'y4' });
    const conflito = comprar({ email: 'ana@exemplo.com', documento: '111.444.777-35', chave: 'y5' });
    const intent = await createPaymentIntent({
      companyId: gringa,
      originType: 'ecommerce_order',
      originId: conflito.orderId,
      method: 'pix',
      amountCents: 20000,
      idempotencyKey: 'pay-y5',
    });
    getConnection()
      .prepare("UPDATE core_payment_intents SET provider_ref = 'pay_y5' WHERE id = ?")
      .run(intent.id);
    const token = await criarAcesso('ana@exemplo.com', '111.444.777-35');
    await request(app)
      .post(`/api/v1/loja/portal/pedidos/${conflito.orderId}/cancelar`)
      .set('x-portal-token', token)
      .expect(200);
    handlePaymentWebhook({
      provider: 'asaas',
      companyId: gringa,
      token: TOKEN_WEBHOOK,
      payload: { id: 'ev-y5', event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_y5' } },
    });

    // Sem esta marca a pendência existiria só do lado do cliente: ele vê o
    // dinheiro preso e ninguém da operação fica sabendo.
    const lista = listOrders(gringa);
    const linhaConflito = lista.find((o) => o.id === conflito.orderId);
    const linhaNormal = lista.find((o) => o.id === normal.orderId);
    expect(linhaConflito?.payment_after_cancel).toBeTruthy();
    expect(linhaNormal?.payment_after_cancel).toBeFalsy();
  });
});
