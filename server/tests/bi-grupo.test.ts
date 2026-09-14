/**
 * BI: comparar as operações do grupo.
 *
 * Duas regras, e as duas existem para o número não mentir:
 *
 *   O ESCOPO SEGUE O VÍNCULO. Só entram as operações que a pessoa tem em
 *   `core_user_companies`. Uma consulta que atravessasse empresas seria a
 *   única do repositório a fazer isso — e a porta por onde um gerente de loja
 *   veria o resultado das outras cinco.
 *
 *   MARGEM SÓ ONDE O CUSTO É CONFIÁVEL. Produto sem custo cadastrado devolveria
 *   100% de margem, um número bonito e falso. Ele fica de fora, e a resposta
 *   diz QUANTOS ficaram: 62% calculado sobre 3 de 300 itens não é a margem da
 *   loja.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();
let auth: { Authorization: string };

beforeEach(async () => {
  resetDbForTests();
  const res = await loginForTest(app, {
    userId: 'gerente-bi',
    companyId: 'loja-bi',
    profileCodes: ['gerente_loja'],
  });
  auth = { Authorization: `Bearer ${res.body.accessToken}` };
});

async function produto(nome: string, preco: number, custo: number, qtd = 50) {
  const p = await request(app)
    .post('/api/v1/core/products')
    .set(auth)
    .send({ name: nome, priceCents: preco, costCents: custo });
  await request(app).post('/api/v1/core/stock/movements').set(auth).send({
    productId: p.body.id,
    movementType: 'in',
    quantity: qtd,
    referenceType: 'entrada',
    referenceId: `carga-${p.body.id}`,
  });
  return p.body.id as string;
}

async function vender(productId: string, quantidade: number, total: number) {
  const res = await request(app)
    .post('/api/v1/core/sales')
    .set(auth)
    .send({
      idempotencyKey: randomUUID(),
      items: [{ productId, quantity: quantidade }],
      payments: [{ method: 'dinheiro', amountCents: total }],
    });
  expect(res.status).toBe(201);
  return (res.body.sale ?? res.body).id as string;
}

describe('visão por operação', () => {
  it('soma faturamento e calcula ticket médio', async () => {
    const p = await produto('Item', 10000, 4000);
    await vender(p, 1, 10000);
    await vender(p, 3, 30000);

    const res = await request(app).get('/api/v1/core/insights/operations').set(auth);
    const loja = res.body.operations[0];
    expect(loja.salesCount).toBe(2);
    expect(loja.revenueCents).toBe(40000);
    expect(loja.averageTicketCents).toBe(20000);
  });

  it('venda cancelada NÃO é faturamento', async () => {
    const p = await produto('Item', 10000, 4000);
    const v = await vender(p, 1, 10000);
    await vender(p, 1, 10000);
    await request(app).post(`/api/v1/core/sales/${v}/cancel`).set(auth).send({ reason: 'erro' });

    const res = await request(app).get('/api/v1/core/insights/operations').set(auth);
    // Cancelar é desfazer: a venda deixou de valer.
    expect(res.body.operations[0].salesCount).toBe(1);
    expect(res.body.operations[0].revenueCents).toBe(10000);
  });

  it('devolução aparece ao lado, sem apagar a venda', async () => {
    const p = await produto('Item', 10000, 4000);
    const v = await vender(p, 2, 20000);

    const itens = await request(app).get(`/api/v1/core/sales/${v}/returnable`).set(auth);
    await request(app)
      .post('/api/v1/core/sale-returns')
      .set(auth)
      .send({
        saleId: v,
        reason: 'Devolveu uma',
        items: [{ saleItemId: itens.body.items[0].sale_item_id, quantity: 1 }],
      });

    const res = await request(app).get('/api/v1/core/insights/operations').set(auth);
    const loja = res.body.operations[0];
    // O faturamento continua sendo o que foi vendido; o líquido é que cai.
    expect(loja.revenueCents).toBe(20000);
    expect(loja.returnsCents).toBe(10000);
    expect(loja.netCents).toBe(10000);
  });

  it('sem venda, ticket médio é zero e não divisão por zero', async () => {
    const res = await request(app).get('/api/v1/core/insights/operations').set(auth);
    expect(res.body.operations[0].averageTicketCents).toBe(0);
    expect(res.body.totals.averageTicketCents).toBe(0);
  });
});

describe('o escopo segue o vínculo', () => {
  it('só aparecem as operações da pessoa', async () => {
    // Outra empresa existe e vende, mas o gerente não está vinculado a ela.
    const outra = await loginForTest(app, {
      userId: 'gerente-vizinha-bi',
      companyId: 'loja-vizinha-bi',
      profileCodes: ['gerente_loja'],
    });
    const authOutra = { Authorization: `Bearer ${outra.body.accessToken}` };
    const p = await request(app)
      .post('/api/v1/core/products')
      .set(authOutra)
      .send({ name: 'Da vizinha', priceCents: 50000, costCents: 10000 });
    await request(app).post('/api/v1/core/stock/movements').set(authOutra).send({
      productId: p.body.id,
      movementType: 'in',
      quantity: 10,
      referenceType: 'entrada',
      referenceId: 'c',
    });
    await request(app)
      .post('/api/v1/core/sales')
      .set(authOutra)
      .send({
        idempotencyKey: randomUUID(),
        items: [{ productId: p.body.id, quantity: 1 }],
        payments: [{ method: 'dinheiro', amountCents: 50000 }],
      });

    const res = await request(app).get('/api/v1/core/insights/operations').set(auth);
    expect(res.body.operations).toHaveLength(1);
    expect(res.body.totals.revenueCents).toBe(0);
  });
});

describe('margem só onde o custo é confiável', () => {
  it('produto SEM custo fica de fora, e a resposta diz quantos', async () => {
    const comCusto = await produto('Com custo', 10000, 6000);
    const semCusto = await produto('Sem custo', 10000, 0);
    await vender(comCusto, 1, 10000);
    await vender(semCusto, 1, 10000);

    const res = await request(app).get('/api/v1/core/insights/margin').set(auth);

    // Incluir o sem custo devolveria margem de 70% — bonita e falsa.
    expect(res.body.consideredItems).toBe(1);
    expect(res.body.skippedNoCost).toBe(1);
    expect(res.body.revenueCents).toBe(10000);
    expect(res.body.costCents).toBe(6000);
    expect(res.body.marginPercent).toBe(40);
  });

  it('sem nada considerado, o percentual é NULO — não zero', async () => {
    const semCusto = await produto('Sem custo', 10000, 0);
    await vender(semCusto, 1, 10000);

    const res = await request(app).get('/api/v1/core/insights/margin').set(auth);
    // Zero afirmaria margem zero; nulo diz "não dá para saber". São coisas
    // diferentes, e decidir preço com base na primeira custa dinheiro.
    expect(res.body.marginPercent).toBeNull();
    expect(res.body.skippedNoCost).toBe(1);
  });
});

describe('o que mais sai', () => {
  it('ordena por valor e traz a quantidade junto', async () => {
    const caro = await produto('Caro', 50000, 20000);
    const barato = await produto('Barato', 1000, 400);
    await vender(caro, 1, 50000);
    await vender(barato, 20, 20000);

    const res = await request(app).get('/api/v1/core/insights/products').set(auth);
    // O que sai mais em peça não é o que traz mais dinheiro — confundir os dois
    // leva a reforçar o estoque errado, então os dois números aparecem.
    expect(res.body.items[0].name).toBe('Caro');
    expect(res.body.items[0].revenue_cents).toBe(50000);
    const b = res.body.items.find((i: { name: string }) => i.name === 'Barato');
    expect(b.quantity).toBe(20);
  });

  it('venda cancelada não conta no ranking', async () => {
    const p = await produto('Item', 10000, 4000);
    const v = await vender(p, 5, 50000);
    await request(app).post(`/api/v1/core/sales/${v}/cancel`).set(auth).send({ reason: 'erro' });

    const res = await request(app).get('/api/v1/core/insights/products').set(auth);
    expect(res.body.items).toHaveLength(0);
  });
});
