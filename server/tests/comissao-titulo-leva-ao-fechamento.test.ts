/**
 * O TÍTULO DA COMISSÃO LEVA DE VOLTA AO FECHAMENTO (GAP-PRD-174).
 *
 * ============================================================================
 * O DEFEITO
 * ============================================================================
 *
 * `CommissionService.fecharPeriodo` cria a conta a pagar por `createEntry`,
 * que gravava `origin_type = 'manual'` com `origin_id` = o próprio título. O
 * vínculo morava só em `core_commission_closings.finance_entry_id`, na direção
 * fechamento → título. Do contas a pagar da comissão não se chegava ao
 * fechamento: auditar "que fechamento gerou esta conta" exigia SQL. E o
 * histórico de fechamentos era gravado sem nenhuma tela que o lesse.
 *
 * ============================================================================
 * O CONSERTO
 * ============================================================================
 *
 * O título nasce com origem própria (`commission_closing`, id do fechamento),
 * o rótulo diz de quem e de que período, a lista do contas a pagar filtra
 * pelos títulos de um fechamento (a volta), e o histórico ganha leitor:
 * `GET /core/commissions/closings` e `/closings/:id` (com as linhas de
 * comissão e a situação do título).
 */
process.env.TZ = 'UTC';

import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import {
  createGroup,
  registrarComissaoDaVenda,
  setMemberGroup,
  setTier,
} from '../src/services/core/CommissionService.js';
import { loginForTest } from './helpers/auth.js';
import { linkUserToCompany } from '../src/services/auth/IdentityService.js';

const app = createApp();

let auth: { Authorization: string };
let companyId: string;
let vendedor: string;

const DE = '2026-08-01';
const ATE = '2026-08-31';

beforeEach(async () => {
  resetDbForTests();
  const res = await loginForTest(app, {
    userId: 'gerente-comissao',
    companyId: 'loja-comissao-volta',
    profileCodes: ['gerente_loja'],
  });
  auth = { Authorization: `Bearer ${res.body.accessToken}` };
  companyId = res.body.company.id;

  vendedor = randomUUID();
  const agora = new Date().toISOString();
  getConnection()
    .prepare(
      `INSERT INTO core_users (id, login, display_name, password_hash, active, created_at, updated_at)
       VALUES (?, ?, 'Joana Vendedora', 'x', 1, ?, ?)`,
    )
    .run(vendedor, `v-${vendedor}`, agora, agora);
  /*
    A vendedora é EMPREGADA da operação — o vínculo faltava aqui.

    Este arranjo inseria a linha em core_users e parava: um usuário sem
    vínculo nenhum, que no sistema de verdade não existe (quem vende entrou
    por Usuários e Acesso, com vínculo). A conferência nova de
    setMemberGroup — comissionar quem NÃO é da operação é travessia de
    empresa — encosta exatamente nessa lacuna do arranjo, e não no que este
    arquivo mede.
  */
  linkUserToCompany(vendedor, companyId, 'atendente', false);
  const grupo = createGroup(companyId, 'Balcão');
  setTier(companyId, grupo.id, 0, 1_000); // 10%
  setMemberGroup(companyId, vendedor, grupo.id);
});

/** Uma venda comissionada, com a comissão registrada na competência dada. */
function venda(numero: number, baseCents: number, dia: string): string {
  const saleId = randomUUID();
  getConnection()
    .prepare(
      `INSERT INTO core_sales
         (id, company_id, number, status, subtotal_cents, discount_cents, total_cents,
          change_cents, seller_id, idempotency_key, created_at)
       VALUES (?, ?, ?, 'completed', ?, 0, ?, 0, ?, ?, ?)`,
    )
    .run(saleId, companyId, numero, baseCents, baseCents, vendedor, randomUUID(), `${dia}T15:00:00.000Z`);
  registrarComissaoDaVenda({ companyId, sellerId: vendedor, saleId, baseCents, competenceDate: dia });
  return saleId;
}

async function fechar(): Promise<{ closingId: string; financeEntryId: string; totalCents: number }> {
  const res = await request(app)
    .post('/api/v1/core/commissions/close')
    .set(auth)
    .send({ sellerId: vendedor, from: DE, to: ATE, dueDate: '2026-09-10' });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

describe('GAP-PRD-174 — do contas a pagar se chega ao fechamento', () => {
  it('o título nasce com a origem do fechamento, e o rótulo diz de quem e de que período', async () => {
    venda(11, 100_000, '2026-08-05');
    venda(12, 50_000, '2026-08-20');
    const f = await fechar();

    const lista = await request(app).get('/api/v1/core/finance/entries?direction=out').set(auth);
    expect(lista.status).toBe(200);
    const titulo = (lista.body.items as Record<string, unknown>[]).find((e) => e.id === f.financeEntryId);

    expect(titulo?.originType).toBe('commission_closing');
    expect(titulo?.originId).toBe(f.closingId);
    expect(titulo?.originLabel).toBe('Fechamento de comissão — Joana Vendedora · 01/08/2026 a 31/08/2026');
    expect(titulo?.amountCents).toBe(15_000);
  });

  it('a volta: os títulos DE UM fechamento, pelo filtro de origem', async () => {
    venda(11, 100_000, '2026-08-05');
    const f = await fechar();

    const res = await request(app)
      .get(`/api/v1/core/finance/entries?originType=commission_closing&originId=${f.closingId}`)
      .set(auth);
    expect(res.status).toBe(200);
    expect(res.body.items.map((e: { id: string }) => e.id)).toEqual([f.financeEntryId]);
  });

  it('o histórico lista o fechamento, com o título e a situação dele', async () => {
    venda(11, 100_000, '2026-08-05');
    const f = await fechar();

    const res = await request(app).get('/api/v1/core/commissions/closings').set(auth);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.items).toHaveLength(1);
    const item = res.body.items[0];
    expect(item.id).toBe(f.closingId);
    expect(item.sellerName).toBe('Joana Vendedora');
    expect(item.periodFrom).toBe(DE);
    expect(item.periodTo).toBe(ATE);
    expect(item.totalCents).toBe(10_000);
    expect(item.financeEntryId).toBe(f.financeEntryId);
    expect(item.entryBalanceCents).toBe(10_000);
    expect(item.lineCount).toBe(1);
    expect(item.closedByName).toBeTruthy();

    // Pagou metade: o histórico acompanha o título.
    await request(app)
      .post(`/api/v1/core/finance/entries/${f.financeEntryId}/settle`)
      .set(auth)
      .send({ amountCents: 4_000 });
    const depois = await request(app).get('/api/v1/core/commissions/closings').set(auth);
    expect(depois.body.items[0].entryBalanceCents).toBe(6_000);
  });

  it('o fechamento por id traz as vendas que ele levou', async () => {
    venda(11, 100_000, '2026-08-05');
    venda(12, 50_000, '2026-08-20');
    const f = await fechar();

    const res = await request(app).get(`/api/v1/core/commissions/closings/${f.closingId}`).set(auth);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.closing.id).toBe(f.closingId);
    expect(res.body.lines.map((l: { saleNumber: number }) => l.saleNumber)).toEqual([11, 12]);
    expect(res.body.lines.map((l: { amountCents: number }) => l.amountCents)).toEqual([10_000, 5_000]);
  });

  it('fechamento de outra operação é 404 — o id não atravessa empresa', async () => {
    venda(11, 100_000, '2026-08-05');
    const f = await fechar();

    const vizinha = await loginForTest(app, {
      userId: 'gerente-vizinha-comissao',
      companyId: 'loja-vizinha-comissao',
      profileCodes: ['gerente_loja'],
    });
    const authVizinha = { Authorization: `Bearer ${vizinha.body.accessToken}` };

    const detalhe = await request(app).get(`/api/v1/core/commissions/closings/${f.closingId}`).set(authVizinha);
    expect(detalhe.status).toBe(404);
    const lista = await request(app).get('/api/v1/core/commissions/closings').set(authVizinha);
    expect(lista.body.items).toEqual([]);
  });

  it('o caixa não lê o histórico de comissões — é folha de pagamento', async () => {
    const caixa = await loginForTest(app, {
      userId: 'caixa-comissao',
      companyId,
      profileCodes: ['operador_caixa_loja'],
    });
    const res = await request(app)
      .get('/api/v1/core/commissions/closings')
      .set({ Authorization: `Bearer ${caixa.body.accessToken}` });
    expect(res.status).toBe(403);
  });
});
