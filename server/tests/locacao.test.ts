/**
 * Contrato de locação.
 *
 * LOCAR NÃO É VENDER: o bem sai da loja sem sair do patrimônio. Por isso locar
 * RESERVA em vez de dar baixa — continua no saldo, porque é da loja, e some do
 * disponível, porque está fora.
 *
 * A promessa que isso sustenta: O BALCÃO NÃO VENDE A PEÇA QUE ESTÁ COM O
 * CLIENTE. Essa proteção só passou a existir junto com este módulo — a venda
 * ignorava a reserva e consumia o saldo assim mesmo.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();
let auth: { Authorization: string };
let companyId: string;
let clienteId: string;

beforeEach(async () => {
  resetDbForTests();
  const res = await loginForTest(app, {
    userId: 'gerente-loc',
    companyId: 'loja-locacao',
    profileCodes: ['gerente_loja'],
  });
  auth = { Authorization: `Bearer ${res.body.accessToken}` };
  companyId = res.body.company.id;

  const cliente = await request(app)
    .post('/api/v1/core/customers')
    .set(auth)
    .send({ name: 'Cliente Locatário', document: '11122233396' });
  clienteId = cliente.body.id;
});

async function produto(nome: string, qtd: number) {
  const p = await request(app)
    .post('/api/v1/core/products')
    .set(auth)
    .send({ name: nome, priceCents: 50000 });
  await request(app).post('/api/v1/core/stock/movements').set(auth).send({
    productId: p.body.id,
    movementType: 'in',
    quantity: qtd,
    referenceType: 'entrada',
    referenceId: `carga-${p.body.id}`,
  });
  return p.body.id as string;
}

function estoque(productId: string): { quantity: number; reserved: number } {
  return getConnection()
    .prepare('SELECT quantity, reserved FROM core_stock WHERE company_id = ? AND product_id = ?')
    .get(companyId, productId) as { quantity: number; reserved: number };
}

function amanha(dias = 3): string {
  return new Date(Date.now() + dias * 86400000).toISOString();
}

async function locar(productId: string, quantidade: number, over: Record<string, unknown> = {}) {
  return request(app)
    .post('/api/v1/core/rentals')
    .set(auth)
    .send({
      customerId: clienteId,
      endsAt: amanha(),
      items: [{ productId, quantity: quantidade, unitCents: 10000 }],
      ...over,
    });
}

describe('locar reserva, não dá baixa', () => {
  it('o bem continua no saldo e sai do disponível', async () => {
    const p = await produto('Cadeira', 10);
    const res = await locar(p, 3);
    expect(res.status).toBe(201);

    const st = estoque(p);
    // Continua sendo da loja: o saldo não muda.
    expect(st.quantity).toBe(10);
    // Está fora: some do disponível.
    expect(st.reserved).toBe(3);
  });

  it('NÃO se aluga mais do que está livre', async () => {
    const p = await produto('Mesa', 2);
    await locar(p, 2);
    const segunda = await locar(p, 1);
    expect(segunda.status).toBe(409);
  });
});

describe('o balcão não vende o que está locado', () => {
  it('venda é recusada quando o saldo está reservado', async () => {
    const p = await produto('Projetor', 1);
    await locar(p, 1);

    const venda = await request(app)
      .post('/api/v1/core/sales')
      .set(auth)
      .send({
        idempotencyKey: randomUUID(),
        items: [{ productId: p, quantity: 1 }],
        payments: [{ method: 'dinheiro', amountCents: 50000 }],
      });

    // Antes desta rodada a venda passava e deixava o disponível em -1.
    expect(venda.status).toBe(409);
    expect(venda.body.error.code).toBe('CORE_STOCK_RESERVED');
    expect(estoque(p).quantity).toBe(1);
  });

  it('a parte NÃO locada continua vendável', async () => {
    const p = await produto('Caixa de som', 5);
    await locar(p, 2);

    const venda = await request(app)
      .post('/api/v1/core/sales')
      .set(auth)
      .send({
        idempotencyKey: randomUUID(),
        items: [{ productId: p, quantity: 3 }],
        payments: [{ method: 'dinheiro', amountCents: 150000 }],
      });
    // Reservar não pode travar a loja inteira: só o que está fora fica preso.
    expect(venda.status).toBe(201);
  });

  it('faltar mercadoria continua sendo outro erro, com outra mensagem', async () => {
    const p = await produto('Tripé', 1);
    const venda = await request(app)
      .post('/api/v1/core/sales')
      .set(auth)
      .send({
        idempotencyKey: randomUUID(),
        items: [{ productId: p, quantity: 5 }],
        payments: [{ method: 'dinheiro', amountCents: 250000 }],
      });
    // Quem ouve "está reservado" sobre prateleira vazia procura reserva que
    // não existe.
    expect(venda.body.error.code).toBe('CORE_INSUFFICIENT_STOCK');
  });
});

describe('devolução', () => {
  it('devolver solta a reserva e libera para vender', async () => {
    const p = await produto('Tenda', 4);
    const c = await locar(p, 4);

    await request(app)
      .post(`/api/v1/core/rentals/${c.body.id}/return`)
      .set(auth)
      .send({ items: [{ productId: p, quantity: 4 }] });

    expect(estoque(p).reserved).toBe(0);

    const venda = await request(app)
      .post('/api/v1/core/sales')
      .set(auth)
      .send({
        idempotencyKey: randomUUID(),
        items: [{ productId: p, quantity: 1 }],
        payments: [{ method: 'dinheiro', amountCents: 50000 }],
      });
    expect(venda.status).toBe(201);
  });

  it('devolução parcial solta só o que voltou', async () => {
    const p = await produto('Cadeira', 3);
    const c = await locar(p, 3);

    const res = await request(app)
      .post(`/api/v1/core/rentals/${c.body.id}/return`)
      .set(auth)
      .send({ items: [{ productId: p, quantity: 2 }] });

    expect(estoque(p).reserved).toBe(1);
    // Ainda falta uma: o contrato continua aberto.
    expect(res.body.status).toBe('aberto');
  });

  it('devolvendo tudo, o contrato encerra sozinho', async () => {
    const p = await produto('Toldo', 2);
    const c = await locar(p, 2);
    const res = await request(app)
      .post(`/api/v1/core/rentals/${c.body.id}/return`)
      .set(auth)
      .send({ items: [{ productId: p, quantity: 2 }] });
    expect(res.body.status).toBe('devolvido');
  });

  it('não se devolve mais do que se levou', async () => {
    const p = await produto('Banqueta', 5);
    const c = await locar(p, 2);
    const res = await request(app)
      .post(`/api/v1/core/rentals/${c.body.id}/return`)
      .set(auth)
      .send({ items: [{ productId: p, quantity: 3 }] });
    expect(res.status).toBe(409);
  });

  it('contrato encerrado não recebe devolução', async () => {
    const p = await produto('Palco', 1);
    const c = await locar(p, 1);
    await request(app)
      .post(`/api/v1/core/rentals/${c.body.id}/return`)
      .set(auth)
      .send({ items: [{ productId: p, quantity: 1 }] });
    const segunda = await request(app)
      .post(`/api/v1/core/rentals/${c.body.id}/return`)
      .set(auth)
      .send({ items: [{ productId: p, quantity: 1 }] });
    expect(segunda.status).toBe(409);
  });
});

describe('cancelamento', () => {
  it('cancelar solta a mercadoria presa', async () => {
    const p = await produto('Gerador', 2);
    const c = await locar(p, 2);
    expect(estoque(p).reserved).toBe(2);

    await request(app)
      .post(`/api/v1/core/rentals/${c.body.id}/cancel`)
      .set(auth)
      .send({ reason: 'Cliente desistiu' });

    // Contrato cancelado que mantivesse a reserva tiraria mercadoria de
    // circulação para sempre.
    expect(estoque(p).reserved).toBe(0);
  });

  it('cancelar exige motivo', async () => {
    const p = await produto('Refletor', 1);
    const c = await locar(p, 1);
    const res = await request(app)
      .post(`/api/v1/core/rentals/${c.body.id}/cancel`)
      .set(auth)
      .send({ reason: '' });
    expect(res.status).toBe(400);
  });
});

describe('período e atraso', () => {
  it('devolução antes da retirada é recusada', async () => {
    const p = await produto('Mesa alta', 2);
    const res = await locar(p, 1, {
      startsAt: amanha(5),
      endsAt: amanha(2),
    });
    expect(res.status).toBe(400);
  });

  it('atrasado é calculado, não gravado', async () => {
    const p = await produto('Freezer', 1);
    const c = await locar(p, 1, { startsAt: amanha(-10), endsAt: amanha(-2) });

    const res = await request(app).get(`/api/v1/core/rentals/${c.body.id}`).set(auth);
    // Estado gravado envelheceria sozinho: o contrato só ficaria atrasado
    // quando alguém abrisse a tela.
    expect(res.body.atrasado).toBe(true);
  });

  it('contrato sem cliente não existe', async () => {
    const p = await produto('Ventilador', 1);
    const res = await request(app)
      .post('/api/v1/core/rentals')
      .set(auth)
      .send({ customerId: randomUUID(), endsAt: amanha(), items: [{ productId: p, quantity: 1 }] });
    expect(res.status).toBe(404);
  });
});
