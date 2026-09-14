/**
 * Fluxo ponta a ponta pela API HTTP: login real -> abrir caixa -> cadastrar
 * produto -> entrada de estoque -> venda -> fechamento de caixa.
 *
 * Também cobre o que a auditoria apontou como crítico: um operador não pode
 * ler nem escrever nada de outra empresa, e sem token não se acessa nada.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();

async function tokenFor(userId: string, companyId: string, profile: string): Promise<string> {
  const res = await loginForTest(app, { userId, companyId, profileCodes: [profile] });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

let managerToken: string;

beforeEach(async () => {
  resetDbForTests();
  managerToken = await tokenFor('gerente', 'loja-alpha', 'gerente_loja');
});

describe('autenticação', () => {
  it('recusa acesso sem token', async () => {
    const res = await request(app).get('/api/v1/core/products');
    expect(res.status).toBe(401);
  });

  it('recusa senha errada', async () => {
    await loginForTest(app, { userId: 'alguem', companyId: 'loja-alpha' });
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ login: 'alguem@loja-alpha', password: 'senha-errada' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('API_INVALID_CREDENTIALS');
  });

  it('não aceita login na visão consolidada do grupo', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ login: 'x', password: 'y', companyId: 'grupo-sampaio' });
    expect(res.status).toBe(400);
  });

  it('bloqueia após tentativas repetidas', async () => {
    await loginForTest(app, { userId: 'alvo', companyId: 'loja-alpha' });
    for (let i = 0; i < 5; i += 1) {
      await request(app)
        .post('/api/v1/auth/login')
        .send({ login: 'alvo@loja-alpha', password: 'errada' });
    }
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ login: 'alvo@loja-alpha', password: 'errada' });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('API_LOGIN_LOCKED');
  });
});

describe('fluxo completo de balcão', () => {
  it('caixa, produto, estoque, venda e fechamento', async () => {
    const auth = { Authorization: `Bearer ${managerToken}` };

    // 1. Abertura de caixa com fundo de troco de R$ 100,00.
    const cash = await request(app)
      .post('/api/v1/core/cash/open')
      .set(auth)
      .send({ openingCents: 10000 });
    expect(cash.status).toBe(201);
    const sessionId = cash.body.id as string;

    // 2. Produto novo, com código interno gerado automaticamente.
    const product = await request(app)
      .post('/api/v1/core/products')
      .set(auth)
      .send({ name: 'Tênis Runner', priceCents: 25000, unit: 'PAR', barcode: '7891234567895' });
    expect(product.status).toBe(201);
    expect(String(product.body.internal_code)).toMatch(/^GS-\d{6}$/);
    const productId = product.body.id as string;

    // 3. Entrada de estoque.
    const entry = await request(app)
      .post('/api/v1/core/stock/movements')
      .set(auth)
      .send({
        productId,
        movementType: 'in',
        quantity: 5,
        referenceType: 'entrada',
        referenceId: 'nf-teste-1',
      });
    expect(entry.status).toBe(201);
    expect(entry.body.balance).toBe(5);

    // 4. Venda de 2 unidades, em dinheiro, vinculada ao caixa aberto.
    const sale = await request(app)
      .post('/api/v1/core/sales')
      .set(auth)
      .set('Idempotency-Key', 'venda-e2e-1')
      .send({
        cashSessionId: sessionId,
        items: [{ productId, quantity: 2 }],
        payments: [{ method: 'dinheiro', amountCents: 50000 }],
      });
    expect(sale.status).toBe(201);
    expect(sale.body.total_cents).toBe(50000);

    // 5. Reenvio da mesma venda devolve a original, sem duplicar.
    const retry = await request(app)
      .post('/api/v1/core/sales')
      .set(auth)
      .set('Idempotency-Key', 'venda-e2e-1')
      .send({
        cashSessionId: sessionId,
        items: [{ productId, quantity: 2 }],
        payments: [{ method: 'dinheiro', amountCents: 50000 }],
      });
    expect(retry.status).toBe(200);
    expect(retry.body.id).toBe(sale.body.id);

    // 6. Estoque baixou uma única vez.
    const stock = await request(app).get('/api/v1/core/stock').set(auth);
    expect(stock.body.items[0].quantity).toBe(3);

    // 7. Esperado em gaveta = 100,00 de abertura + 500,00 da venda.
    const summary = await request(app)
      .get(`/api/v1/core/cash/${sessionId}/summary`)
      .set(auth);
    expect(summary.body.expectedCents).toBe(60000);

    // 8. Fechamento com R$ 5,00 a menos registra a diferença.
    const close = await request(app)
      .post(`/api/v1/core/cash/${sessionId}/close`)
      .set(auth)
      .send({ countedCents: 59500 });
    expect(close.status).toBe(200);
    expect(close.body.expected_cents).toBe(60000);
    expect(close.body.difference_cents).toBe(-500);

    // 9. O painel reflete a venda.
    const dashboard = await request(app).get('/api/v1/core/dashboard').set(auth);
    expect(dashboard.body.revenueCents).toBe(50000);
    expect(dashboard.body.salesCount).toBe(1);
    expect(dashboard.body.averageTicketCents).toBe(50000);
  });

  it('recusa venda sem estoque suficiente', async () => {
    const auth = { Authorization: `Bearer ${managerToken}` };
    const product = await request(app)
      .post('/api/v1/core/products')
      .set(auth)
      .send({ name: 'Item Escasso', priceCents: 1000 });
    const res = await request(app)
      .post('/api/v1/core/sales')
      .set(auth)
      .set('Idempotency-Key', 'venda-sem-estoque')
      .send({
        items: [{ productId: product.body.id, quantity: 1 }],
        payments: [{ method: 'dinheiro', amountCents: 1000 }],
      });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CORE_INSUFFICIENT_STOCK');
  });
});

describe('isolamento entre operações', () => {
  it('não enxerga o catálogo de outra empresa', async () => {
    const alphaAuth = { Authorization: `Bearer ${managerToken}` };
    await request(app)
      .post('/api/v1/core/products')
      .set(alphaAuth)
      .send({ name: 'Produto Alpha', priceCents: 1000 });

    const betaToken = await tokenFor('gerente-beta', 'loja-beta', 'gerente_loja');
    const betaList = await request(app)
      .get('/api/v1/core/products')
      .set({ Authorization: `Bearer ${betaToken}` });

    expect(betaList.status).toBe(200);
    expect(betaList.body.items).toHaveLength(0);
  });

  it('não permite ler venda de outra empresa pelo id', async () => {
    const alphaAuth = { Authorization: `Bearer ${managerToken}` };
    const product = await request(app)
      .post('/api/v1/core/products')
      .set(alphaAuth)
      .send({ name: 'Produto Alpha', priceCents: 1000 });
    await request(app).post('/api/v1/core/stock/movements').set(alphaAuth).send({
      productId: product.body.id,
      movementType: 'in',
      quantity: 3,
      referenceType: 'entrada',
      referenceId: 'nf-iso',
    });
    const sale = await request(app)
      .post('/api/v1/core/sales')
      .set(alphaAuth)
      .set('Idempotency-Key', 'venda-iso')
      .send({
        items: [{ productId: product.body.id, quantity: 1 }],
        payments: [{ method: 'dinheiro', amountCents: 1000 }],
      });

    const betaToken = await tokenFor('gerente-beta', 'loja-beta', 'gerente_loja');
    const res = await request(app)
      .get(`/api/v1/core/sales/${sale.body.id}`)
      .set({ Authorization: `Bearer ${betaToken}` });
    expect(res.status).toBe(404);
  });
});

describe('RBAC', () => {
  /*
    A REGRA MUDOU (PJ-CAIXA, 2026-09-14). Era "o balcão cadastra produto e dá
    entrada sem depender do gerente". Na entrega da Preço Justo o dono separou
    os papéis: o login do PDV opera o caixa e NÃO administra produto nem
    estoque — quem cadastra e recebe é a gestão da loja (ADMIN-<operação>). Um
    login de caixa específico pode ganhar essa retaguarda de volta pela tela de
    Usuários (capability pdv.backoffice); o modelo padrão do caixa da loja não a
    traz mais. O que o operador continua NÃO podendo fazer é desfazer venda.
  */
  it('operador de caixa da loja NÃO cadastra produto nem dá entrada (403); a gerência faz', async () => {
    const operatorToken = await tokenFor('caixa', 'loja-alpha', 'operador_caixa_loja');
    const auth = { Authorization: `Bearer ${operatorToken}` };

    const product = await request(app)
      .post('/api/v1/core/products')
      .set(auth)
      .send({ name: 'Cadastrado no balcão', priceCents: 1500 });
    expect(product.status).toBe(403);

    const gerente = { Authorization: `Bearer ${await tokenFor('gerente-rbac', 'loja-alpha', 'gerente_loja')}` };
    const doGerente = await request(app)
      .post('/api/v1/core/products')
      .set(gerente)
      .send({ name: 'Cadastrado pela gerência', priceCents: 1500 });
    expect(doGerente.status).toBe(201);

    const movimento = {
      productId: doGerente.body.id,
      movementType: 'in',
      quantity: 6,
      referenceType: 'entrada',
      referenceId: 'balcao-1',
    };
    const peloCaixa = await request(app).post('/api/v1/core/stock/movements').set(auth).send(movimento);
    expect(peloCaixa.status).toBe(403);
    const pelaGerencia = await request(app).post('/api/v1/core/stock/movements').set(gerente).send(movimento);
    expect(pelaGerencia.status).toBe(201);
    // O saldo é o da entrada da gerência, uma vez só: a tentativa do caixa não gravou nada.
    expect(pelaGerencia.body.balance).toBe(6);
  });

  it('operador de caixa não cancela venda', async () => {
    const operatorToken = await tokenFor('caixa', 'loja-alpha', 'operador_caixa_loja');
    const res = await request(app)
      .post('/api/v1/core/sales/qualquer/cancel')
      .set({ Authorization: `Bearer ${operatorToken}` })
      .send({});
    expect(res.status).toBe(403);
  });
});
