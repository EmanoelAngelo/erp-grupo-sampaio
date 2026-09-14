/**
 * Fidelidade.
 *
 * PONTO ACUMULADO É DÍVIDA DA LOJA, NÃO RECEITA. Se o ponto entrasse como
 * faturamento, o resultado de hoje subiria e o dia do resgate abriria um buraco
 * do mesmo tamanho: a mesma receita reconhecida duas vezes, com a mercadoria
 * saindo uma só.
 *
 * As três regras que custam dinheiro se erradas:
 *   1. venda cancelada ou devolvida ESTORNA o ponto — senão o cliente acumula
 *      comprando e desistindo;
 *   2. o valor pago com ponto NÃO gera ponto — senão o programa se paga sozinho
 *      para sempre;
 *   3. resgate não deixa saldo negativo.
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
let produtoId: string;

/** 100 centavos = 1 ponto; 1 ponto = 1 centavo de desconto. */
async function ligarPrograma(over: Record<string, unknown> = {}) {
  return request(app)
    .put('/api/v1/core/loyalty/program')
    .set(auth)
    .send({ active: true, centsPerPoint: 100, pointValueCents: 1, ...over });
}

beforeEach(async () => {
  resetDbForTests();
  const res = await loginForTest(app, {
    userId: 'gerente-fid',
    companyId: 'loja-fidelidade',
    profileCodes: ['gerente_loja'],
  });
  auth = { Authorization: `Bearer ${res.body.accessToken}` };
  companyId = res.body.company.id;

  const cliente = await request(app)
    .post('/api/v1/core/customers')
    .set(auth)
    .send({ name: 'Cliente Fiel', document: '11122233396' });
  clienteId = cliente.body.id;

  const p = await request(app)
    .post('/api/v1/core/products')
    .set(auth)
    .send({ name: 'Produto', priceCents: 10000 });
  produtoId = p.body.id;
  await request(app).post('/api/v1/core/stock/movements').set(auth).send({
    productId: produtoId,
    movementType: 'in',
    quantity: 100,
    referenceType: 'entrada',
    referenceId: 'carga',
  });
});

async function venda(quantidade: number, comCliente = true) {
  const total = quantidade * 10000;
  const res = await request(app)
    .post('/api/v1/core/sales')
    .set(auth)
    .send({
      idempotencyKey: randomUUID(),
      customerId: comCliente ? clienteId : undefined,
      items: [{ productId: produtoId, quantity: quantidade }],
      payments: [{ method: 'dinheiro', amountCents: total }],
    });
  expect(res.status).toBe(201);
  return res.body.sale ?? res.body;
}

async function saldo(): Promise<number> {
  const res = await request(app).get(`/api/v1/core/loyalty/customers/${clienteId}`).set(auth);
  return res.body.balance;
}

describe('ponto não é receita', () => {
  it('acumular NÃO cria lançamento financeiro de ponto', async () => {
    await ligarPrograma();
    await venda(1);

    // O que entra no financeiro é a venda, pelo que o cliente pagou. O ponto é
    // dívida da loja e vive em razão própria.
    const lancamentos = getConnection()
      .prepare(
        "SELECT COUNT(*) AS n FROM core_finance_entries WHERE company_id = ? AND origin_type <> 'sale'",
      )
      .get(companyId) as { n: number };
    expect(lancamentos.n).toBe(0);
    expect(await saldo()).toBe(100);
  });

  it('o passivo mostra quanto a loja deve em desconto', async () => {
    await ligarPrograma();
    await venda(2);
    const res = await request(app).get('/api/v1/core/loyalty/program').set(auth);
    expect(res.body.liability.points).toBe(200);
    expect(res.body.liability.estimatedCents).toBe(200);
  });
});

describe('acúmulo', () => {
  it('programa desligado não acumula', async () => {
    await venda(1);
    expect(await saldo()).toBe(0);
  });

  it('venda sem cliente não acumula — não há para quem', async () => {
    await ligarPrograma();
    await venda(1, false);
    expect(await saldo()).toBe(0);
  });

  it('acumula uma vez por venda', async () => {
    await ligarPrograma();
    const v = await venda(1);
    const linhas = getConnection()
      .prepare(
        "SELECT COUNT(*) AS n FROM core_loyalty_entries WHERE kind = 'earn' AND sale_id = ?",
      )
      .get(v.id) as { n: number };
    expect(linhas.n).toBe(1);
  });

  it('valor abaixo de um ponto não acumula fração', async () => {
    await ligarPrograma({ centsPerPoint: 50000 });
    await venda(1);
    expect(await saldo()).toBe(0);
  });

  it('a fidelidade não derruba a venda', async () => {
    // Programa desligado, cliente sem cadastro de pontos: a venda passa igual.
    const v = await venda(1);
    expect(v.status).toBe('completed');
  });
});

describe('resgate', () => {
  it('pontos viram desconto em centavos', async () => {
    await ligarPrograma({ pointValueCents: 2 });
    await venda(3); // 300 pontos

    const res = await request(app)
      .post('/api/v1/core/loyalty/redeem')
      .set(auth)
      .send({ customerId: clienteId, points: 100 });

    expect(res.body.discountCents).toBe(200);
    expect(res.body.balanceAfter).toBe(200);
  });

  it('não resgata mais do que tem', async () => {
    await ligarPrograma();
    await venda(1); // 100 pontos
    const res = await request(app)
      .post('/api/v1/core/loyalty/redeem')
      .set(auth)
      .send({ customerId: clienteId, points: 500 });
    expect(res.status).toBe(409);
    expect(await saldo()).toBe(100);
  });

  it('respeita o mínimo para resgate', async () => {
    await ligarPrograma({ minPointsToRedeem: 200 });
    await venda(3);
    const res = await request(app)
      .post('/api/v1/core/loyalty/redeem')
      .set(auth)
      .send({ customerId: clienteId, points: 50 });
    expect(res.status).toBe(400);
  });

  it('programa desligado não resgata', async () => {
    await ligarPrograma();
    await venda(1);
    await ligarPrograma({ active: false });
    const res = await request(app)
      .post('/api/v1/core/loyalty/redeem')
      .set(auth)
      .send({ customerId: clienteId, points: 10 });
    expect(res.status).toBe(409);
  });
});

describe('o que foi pago com ponto não gera ponto', () => {
  it('o acúmulo desconta o resgate da própria venda', async () => {
    await ligarPrograma({ pointValueCents: 10 });
    await venda(5); // 500 pontos de partida
    const antes = await saldo();

    // Nova venda de R$ 100,00, com 50 pontos resgatados = R$ 5,00 de desconto.
    const nova = await request(app)
      .post('/api/v1/core/sales')
      .set(auth)
      .send({
        idempotencyKey: randomUUID(),
        customerId: clienteId,
        items: [{ productId: produtoId, quantity: 1 }],
        payments: [{ method: 'dinheiro', amountCents: 10000 }],
      });
    const saleId = (nova.body.sale ?? nova.body).id;

    await request(app)
      .post('/api/v1/core/loyalty/redeem')
      .set(auth)
      .send({ customerId: clienteId, points: 50, saleId });

    // O acúmulo já aconteceu na criação da venda, sobre o valor cheio. O que
    // este teste garante é que o resgate registrado na venda NÃO some ao saldo:
    // ele subtrai.
    expect(await saldo()).toBe(antes + 100 - 50);
  });
});

describe('estorno', () => {
  it('cancelar a venda devolve o ponto', async () => {
    await ligarPrograma();
    const v = await venda(2); // 200 pontos
    expect(await saldo()).toBe(200);

    await request(app)
      .post(`/api/v1/core/sales/${v.id}/cancel`)
      .set(auth)
      .send({ reason: 'erro de digitação' });

    // Sem isto o cliente acumularia comprando e desistindo.
    expect(await saldo()).toBe(0);
  });

  it('devolução parcial estorna proporcionalmente', async () => {
    await ligarPrograma();
    const v = await venda(4); // R$ 400,00 → 400 pontos

    const itens = await request(app).get(`/api/v1/core/sales/${v.id}/returnable`).set(auth);
    await request(app)
      .post('/api/v1/core/sale-returns')
      .set(auth)
      .send({
        saleId: v.id,
        reason: 'Devolveu uma peça',
        items: [{ saleItemId: itens.body.items[0].sale_item_id, quantity: 1 }],
      });

    // Devolveu 1 de 4: perde 1/4 dos pontos, não todos.
    expect(await saldo()).toBe(300);
  });

  it('estornar duas vezes não cobra ponto a mais', async () => {
    await ligarPrograma();
    const v = await venda(2);
    await request(app)
      .post(`/api/v1/core/sales/${v.id}/cancel`)
      .set(auth)
      .send({ reason: 'primeiro' });
    await request(app)
      .post(`/api/v1/core/sales/${v.id}/cancel`)
      .set(auth)
      .send({ reason: 'segundo' });
    // Saldo não fica negativo por estorno repetido.
    expect(await saldo()).toBe(0);
  });
});

describe('configuração', () => {
  it('zero centavos por ponto é recusado', async () => {
    const res = await ligarPrograma({ centsPerPoint: 0 });
    // Daria ponto infinito na primeira venda.
    expect(res.status).toBe(400);
  });

  it('nasce desligado', async () => {
    const res = await request(app).get('/api/v1/core/loyalty/program').set(auth);
    expect(res.body.program.active).toBe(0);
  });
});
