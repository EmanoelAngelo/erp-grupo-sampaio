/**
 * ============================================================================
 * O RELANÇAMENTO SEM `cashSessionId` NÃO TIRA O DINHEIRO DA CONFERÊNCIA
 * (R2-IDEM, item 3 — a pergunta do verificador, respondida com prova)
 * ============================================================================
 *
 * A pergunta: `POST /offline-sales/:id/relaunch` aceita `cashSessionId` nulo
 * (core.ts, a rota do relançamento). A venda em DINHEIRO relançada sem gaveta
 * ficaria fora de qualquer gaveta e do fechamento?
 *
 * Não fica, e o motivo não mora na rota: mora em `createSale`. Sem gaveta
 * informada e com espécie entrando, a venda pergunta a `gavetaDoDinheiro`
 * (GAP-PRD-134) — a gaveta aberta do caixa do pedido, ou a ÚNICA aberta da
 * operação; nenhuma, ou mais de uma sem caixa no pedido, é recusa nomeada
 * (409 CORE_CASH_SESSION_REQUIRED) antes de gravar qualquer linha. A venda nasce
 * com a gaveta achada, e o movimento de espécie vai para ela — é o que o
 * fechamento soma. A exceção é a operação que NUNCA abriu gaveta, que não tem
 * fechamento a desmentir; a venda guardada offline, que já nasceu numa gaveta,
 * nunca é dessa operação.
 *
 * Este arquivo mede os dois lados pela rota real: a venda relançada sem
 * gaveta cai na gaveta aberta e aparece no resumo dela; sem gaveta aberta, o
 * relançamento é recusado, nada é vendido, e a pendência guarda o motivo.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { getConnection } from '../src/db/sqlite.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();
const LOJA = 'loja-relanca-sem-gaveta';

type Auth = { Authorization: string };
let gerente: Auth;
let caixa: Auth;

async function entrar(userId: string, perfil: string): Promise<Auth> {
  const res = await loginForTest(app, { userId, companyId: LOJA, profileCodes: [perfil] });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { Authorization: `Bearer ${res.body.accessToken as string}` };
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  gerente = await entrar('gerente-relanca-sem-gaveta', 'gerente_loja');
  caixa = await entrar('caixa-relanca-sem-gaveta', 'operador_caixa_loja');
});

async function produto(): Promise<string> {
  const p = await request(app)
    .post('/api/v1/core/products')
    .set(gerente)
    .send({ name: `Camiseta ${randomUUID().slice(0, 6)}`, priceCents: 5000 });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  const r = await request(app).post('/api/v1/core/stock/movements').set(gerente).send({
    productId: p.body.id,
    movementType: 'in',
    quantity: 10,
    referenceType: 'entrada',
    referenceId: `carga-${randomUUID()}`,
  });
  expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
  return p.body.id as string;
}

async function abrirCaixa(): Promise<string> {
  const res = await request(app).post('/api/v1/core/cash/open').set(caixa).send({ openingCents: 0 });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

async function fecharCaixa(id: string): Promise<void> {
  const res = await request(app).post(`/api/v1/core/cash/${id}/close`).set(gerente).send({ countedCents: 0 });
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
}

/** A venda feita offline num turno que fechou, entregue pela fila. */
async function pendenciaDoTurnoFechado(p: string, turno: string): Promise<string> {
  const r = await request(app)
    .post('/api/v1/core/offline-sales')
    .set(caixa)
    .send({
      idempotencyKey: `pdv-${randomUUID()}`,
      label: 'venda do PDV',
      body: {
        cashSessionId: turno,
        items: [{ productId: p, quantity: 1 }],
        payments: [{ method: 'dinheiro', amountCents: 5000 }],
      },
      queuedAt: '2026-09-12T14:05:00.000Z',
      errorCode: 'CORE_CASH_SESSION_CLOSED',
      errorMessage: 'O caixa informado já foi fechado.',
    });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.pendencia.id as string;
}

function relancarSemGaveta(id: string) {
  return request(app).post(`/api/v1/core/offline-sales/${id}/relaunch`).set(caixa).send({ cashSessionId: null, terminalId: null });
}

function vendas(): number {
  return (getConnection().prepare('SELECT COUNT(*) AS n FROM core_sales WHERE company_id = ?').get(LOJA) as { n: number }).n;
}

// ============================================================================

describe('relançar em dinheiro sem dizer a gaveta', () => {
  it('a venda cai na gaveta aberta, com o movimento de espécie que o fechamento soma', async () => {
    const p = await produto();
    const turnoVelho = await abrirCaixa();
    await fecharCaixa(turnoVelho);
    const pendencia = await pendenciaDoTurnoFechado(p, turnoVelho);
    const gaveta = await abrirCaixa();

    const r = await relancarSemGaveta(pendencia);
    expect(r.status, JSON.stringify(r.body)).toBe(201);

    const venda = getConnection()
      .prepare('SELECT cash_session_id FROM core_sales WHERE id = ?')
      .get(r.body.sale.id as string) as { cash_session_id: string | null };
    expect(venda.cash_session_id).toBe(gaveta);
    const movimento = getConnection()
      .prepare(
        `SELECT session_id, amount_cents FROM core_cash_movements
          WHERE company_id = ? AND reference_type = 'sale' AND reference_id = ?`,
      )
      .get(LOJA, r.body.sale.id as string) as { session_id: string; amount_cents: number } | undefined;
    expect(movimento).toEqual({ session_id: gaveta, amount_cents: 5000 });

    // O resumo da gaveta — o que o fechamento confere — conta os R$ 50.
    const resumo = await request(app).get(`/api/v1/core/cash/${gaveta}/summary`).set(gerente);
    expect(resumo.status, JSON.stringify(resumo.body)).toBe(200);
    expect(resumo.body.expectedCents).toBe(5000);
  });

  it('sem gaveta aberta, é recusado com o valor e o que fazer — nada é vendido, e a pendência guarda o motivo', async () => {
    const p = await produto();
    const turnoVelho = await abrirCaixa();
    await fecharCaixa(turnoVelho);
    const pendencia = await pendenciaDoTurnoFechado(p, turnoVelho);

    const r = await relancarSemGaveta(pendencia);
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(r.body.error.code).toBe('CORE_CASH_SESSION_REQUIRED');
    expect(r.body.error.message).toMatch(/50,00/);
    expect(vendas()).toBe(0);
    const linha = getConnection()
      .prepare('SELECT status, error_code FROM core_offline_sale_pendings WHERE id = ?')
      .get(pendencia) as { status: string; error_code: string };
    expect(linha).toEqual({ status: 'pendente', error_code: 'CORE_CASH_SESSION_REQUIRED' });
  });
});
