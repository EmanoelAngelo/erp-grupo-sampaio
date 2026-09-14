/**
 * A reserva de estoque de um pedido não pago EXPIRA.
 *
 * Até a rodada 34, o checkout reservava o item na hora ("fica indisponível
 * para outro comprador enquanto o pagamento não resolve") e NADA soltava a
 * reserva sozinho. Medido: um visitante sem conta fechava pedidos do estoque
 * inteiro, não pagava, e a loja ficava "esgotada" para quem pagaria — até
 * alguém achar os pedidos e cancelar um a um. O PIX do provedor vence em 24h;
 * a reserva vencia nunca.
 *
 * O conserto reusa o que já existia: `cancelOrder` já solta a reserva
 * corretamente e recusa pedido pago. O que faltava era QUEM o chama com o
 * relógio. `expirarPedidosNaoPagos(agora)` recebe a hora de fora, para o
 * teste não depender de esperar — e para a rotina agendada e o teste
 * provarem a mesma função.
 *
 * A função virou `async` na rodada do GAP-V72: antes de soltar a reserva ela
 * cancela a COBRANÇA no provedor, para o comprador não pagar um pedido que já
 * não existe. Sem credencial configurada (o caso destes cenários) não há ida
 * ao provedor nenhuma — `cancelOrderCharges` marca a intenção sem `provider_ref`
 * como cancelada e segue. Os desfechos medidos aqui continuam idênticos.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { loginForTest } from './helpers/auth.js';
import { abrirParaVisitante, VISITANTE } from './helpers/lojaAberta.js';
import { markOrderPaid } from '../src/services/core/StorefrontService.js';
import {
  PRAZO_DA_RESERVA_MS,
  expirarPedidosNaoPagos,
} from '../src/services/core/OrderReservationExpiry.js';

const app = createApp();
let auth: { Authorization: string };

async function produtoPublicado(nome: string, qty: number): Promise<string> {
  const p = await request(app)
    .post('/api/v1/core/products')
    .set(auth)
    .send({ name: nome, priceCents: 10000, category: 'Geral', publishOnline: true });
  await request(app).post('/api/v1/core/stock/movements').set(auth).send({
    productId: p.body.id,
    movementType: 'in',
    quantity: qty,
    referenceType: 'entrada',
    referenceId: `nf-${nome}`,
  });
  return p.body.id as string;
}

async function pedido(productId: string, quantity: number) {
  const res = await request(app)
    .post('/api/v1/loja/checkout')
    .set('Idempotency-Key', `p-${Math.random()}`)
    .send({ customerName: 'Visitante', ...VISITANTE, paymentMethod: 'pix', items: [{ productId, quantity }] });
  expect(res.status).toBe(201);
  return res.body.orders[0] as { id: string; company_id: string; status: string };
}

async function disponivel(productId: string): Promise<number> {
  const res = await request(app).get('/api/v1/loja/products');
  const item = res.body.items.find((i: { id: string }) => i.id === productId);
  return item.available as number;
}

/** Envelhece o pedido no banco — é o relógio do teste. */
function envelhecer(orderId: string, ms: number) {
  const quando = new Date(Date.now() - ms).toISOString();
  getConnection().prepare('UPDATE core_orders SET created_at = ? WHERE id = ?').run(quando, orderId);
}

beforeEach(async () => {
  resetDbForTests();
  const login = await loginForTest(app, {
    userId: 'ger-gringa',
    companyId: 'gringa',
    profileCodes: ['gerente_loja'],
  });
  auth = { Authorization: `Bearer ${login.body.accessToken}` };
  // O checkout de VISITANTE exige a loja aberta para ele (GAP-PRD-028).
  abrirParaVisitante('gringa');
});

describe('expiração da reserva', () => {
  it('pedido não pago vencido é cancelado e o estoque volta à vitrine', async () => {
    const productId = await produtoPublicado('Tênis', 5);
    const p = await pedido(productId, 5);
    expect(await disponivel(productId)).toBe(0);

    envelhecer(p.id, PRAZO_DA_RESERVA_MS + 60_000);
    const resultado = await expirarPedidosNaoPagos(new Date());

    expect(resultado.cancelados).toBe(1);
    expect(await disponivel(productId)).toBe(5);
    const linha = getConnection().prepare('SELECT status FROM core_orders WHERE id = ?').get(p.id) as { status: string };
    expect(linha.status).toBe('cancelado');
  });

  it('pedido não pago DENTRO do prazo é deixado em paz', async () => {
    const productId = await produtoPublicado('Bota', 3);
    const p = await pedido(productId, 3);
    envelhecer(p.id, PRAZO_DA_RESERVA_MS - 60_000);

    const resultado = await expirarPedidosNaoPagos(new Date());

    expect(resultado.cancelados).toBe(0);
    expect(await disponivel(productId)).toBe(0);
    const linha = getConnection().prepare('SELECT status FROM core_orders WHERE id = ?').get(p.id) as { status: string };
    expect(linha.status).toBe('aguardando_pagamento');
  });

  it('pedido PAGO, por mais velho que seja, nunca é tocado', async () => {
    // Este é o caso que custa dinheiro se errar: cancelar um pedido pago
    // devolveria ao estoque mercadoria que já tem dono.
    const productId = await produtoPublicado('Jaqueta', 2);
    const p = await pedido(productId, 2);
    markOrderPaid({ companyId: p.company_id, orderId: p.id });
    envelhecer(p.id, PRAZO_DA_RESERVA_MS * 10);

    const resultado = await expirarPedidosNaoPagos(new Date());

    expect(resultado.cancelados).toBe(0);
    const linha = getConnection().prepare('SELECT status FROM core_orders WHERE id = ?').get(p.id) as { status: string };
    expect(linha.status).toBe('pago');
  });

  it('o motivo fica na linha do tempo do pedido, para quem ler depois', async () => {
    const productId = await produtoPublicado('Boné', 1);
    const p = await pedido(productId, 1);
    envelhecer(p.id, PRAZO_DA_RESERVA_MS + 1);
    await expirarPedidosNaoPagos(new Date());

    const eventos = getConnection()
      .prepare('SELECT status, note FROM core_order_events WHERE order_id = ? ORDER BY created_at')
      .all(p.id) as { status: string; note: string | null }[];
    const ultimo = eventos[eventos.length - 1];
    expect(ultimo.status).toBe('cancelado');
    expect(ultimo.note ?? '').toMatch(/prazo|pagamento/i);
  });

  it('rodar duas vezes não cancela duas vezes', async () => {
    const productId = await produtoPublicado('Meia', 4);
    const p = await pedido(productId, 4);
    envelhecer(p.id, PRAZO_DA_RESERVA_MS + 1);

    expect((await expirarPedidosNaoPagos(new Date())).cancelados).toBe(1);
    expect((await expirarPedidosNaoPagos(new Date())).cancelados).toBe(0);
    // E o estoque voltou UMA vez, não duas.
    expect(await disponivel(productId)).toBe(4);
  });
});
