/**
 * "CANCELADA" TEM UM CRITÉRIO SÓ — também no saldo da conta bancária
 * (GAP-PRD-172) — e o KPI "Em aberto" conta os abertos (GAP-PRD-208).
 *
 * ============================================================================
 * O DEFEITO (GAP-PRD-172)
 * ============================================================================
 *
 * Sete leitores do financeiro decidem "cancelado" pelo CARIMBO
 * (`cancelled_at IS NULL`): a lista, o resumo, as faixas de atraso, o DRE, o
 * centro de custo, o painel e o fornecedor. O saldo da conta bancária
 * (`accountBalanceCents`) era o oitavo, e decidia pelo STATUS
 * (`status <> 'cancelled'`).
 *
 * Hoje os dois coincidem por acidente: `settleEntry` recusa lançamento
 * cancelado e `aplicarStatus` preserva o 'cancelled'. Basta um escritor futuro
 * carimbar `cancelled_at` sem trocar o status — ou o status ser recalculado
 * depois do carimbo — para o saldo da conta passar a contar dinheiro de um
 * fato cancelado enquanto o resto do sistema já o esqueceu.
 *
 * O esquema documenta qual é o certo: "O status é DERIVADO (...) Carimbo de
 * data não se recalcula: quem cancelou, cancelou."
 *
 * ============================================================================
 * O DEFEITO (GAP-PRD-208)
 * ============================================================================
 *
 * O KPI "Em aberto" de Contas mostrava como subtítulo `summary.count` — a
 * contagem de TODOS os lançamentos do lado, quitados inclusive. "R$ 0,00 · 1
 * lançamento(s)" com o único lançamento já liquidado.
 */
process.env.TZ = 'UTC';

import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { summarize } from '../src/services/core/FinanceService.js';
import { accountBalanceCents, createAccount } from '../src/services/core/FinanceSetupService.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();

let auth: { Authorization: string };
let companyId: string;

beforeEach(async () => {
  resetDbForTests();
  const res = await loginForTest(app, {
    userId: 'gerente-saldo',
    companyId: 'loja-saldo',
    profileCodes: ['gerente_loja'],
  });
  auth = { Authorization: `Bearer ${res.body.accessToken}` };
  companyId = res.body.company.id;
});

/** Um lançamento cru, com o status e o carimbo que o cenário pedir. */
function lancamento(o: {
  accountId?: string | null;
  direction?: 'in' | 'out';
  amountCents: number;
  settledCents?: number;
  status?: 'open' | 'settled' | 'cancelled';
  cancelledAt?: string | null;
  dueDate?: string;
}): string {
  const id = randomUUID();
  const agora = new Date().toISOString();
  const liquidado = o.settledCents ?? 0;
  getConnection()
    .prepare(
      `INSERT INTO core_finance_entries
         (id, company_id, direction, amount_cents, status, settled_cents, due_date,
          description, origin_type, origin_id, account_id, cancelled_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'Lançamento', 'manual', ?, ?, ?, ?)`,
    )
    .run(
      id,
      companyId,
      o.direction ?? 'in',
      o.amountCents,
      o.status ?? (liquidado >= o.amountCents ? 'settled' : 'open'),
      liquidado,
      o.dueDate ?? '2026-09-30',
      id,
      o.accountId ?? null,
      o.cancelledAt ?? null,
      agora,
    );
  return id;
}

describe('GAP-PRD-172 — o saldo da conta usa o carimbo, como os outros sete', () => {
  it('lançamento carimbado como cancelado NÃO entra no saldo, mesmo com status derivado de outro valor', () => {
    const conta = createAccount(companyId, { name: 'Banco do Grupo', openingBalanceCents: 100_000 });
    lancamento({ accountId: conta.id, amountCents: 10_000, settledCents: 10_000 });
    // O escritor futuro: carimbou o cancelamento e o status ficou 'settled'.
    lancamento({
      accountId: conta.id,
      amountCents: 5_000,
      settledCents: 5_000,
      status: 'settled',
      cancelledAt: new Date().toISOString(),
    });

    // 100.000 de partida + 10.000 recebidos. Os 5.000 cancelados não existem.
    expect(accountBalanceCents(companyId, conta.id)).toBe(110_000);
  });

  it('o saldo e o resumo concordam sobre o mesmo conjunto de lançamentos', () => {
    const conta = createAccount(companyId, { name: 'Banco do Grupo', openingBalanceCents: 0 });
    lancamento({ accountId: conta.id, amountCents: 20_000, settledCents: 20_000 });
    lancamento({
      accountId: conta.id,
      amountCents: 7_000,
      settledCents: 7_000,
      status: 'settled',
      cancelledAt: new Date().toISOString(),
    });
    lancamento({
      accountId: conta.id,
      direction: 'out',
      amountCents: 3_000,
      settledCents: 3_000,
    });

    const recebido = summarize(companyId, 'in').settledCents;
    const pago = summarize(companyId, 'out').settledCents;

    // Os dois leitores enxergam a mesma coisa: quem foi cancelado some dos dois.
    expect(accountBalanceCents(companyId, conta.id)).toBe(recebido - pago);
    expect(accountBalanceCents(companyId, conta.id)).toBe(17_000);
  });

  it('a tela de cadastros recebe o saldo pelo mesmo critério', async () => {
    const conta = createAccount(companyId, { name: 'Caixinha', kind: 'caixinha', openingBalanceCents: 1_000 });
    lancamento({ accountId: conta.id, amountCents: 4_000, settledCents: 4_000 });
    lancamento({
      accountId: conta.id,
      amountCents: 9_000,
      settledCents: 9_000,
      status: 'open',
      cancelledAt: new Date().toISOString(),
    });

    const res = await request(app).get('/api/v1/core/finance/setup').set(auth);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const linha = (res.body.accounts as { id: string; balanceCents: number }[]).find(
      (c) => c.id === conta.id,
    );
    expect(linha?.balanceCents).toBe(5_000);
  });
});

describe('GAP-PRD-208 — o resumo conta os ABERTOS, não todos', () => {
  it('openCount conta só quem ainda deve; count continua sendo o total do lado', () => {
    lancamento({ amountCents: 10_000, settledCents: 10_000 }); // quitado
    lancamento({ amountCents: 8_000, settledCents: 3_000 }); // parcial: ainda aberto
    lancamento({ amountCents: 5_000, dueDate: '2020-01-10' }); // aberto e vencido
    lancamento({ amountCents: 2_000, cancelledAt: new Date().toISOString(), status: 'cancelled' });

    const r = summarize(companyId, 'in');
    expect(r.count).toBe(3);
    expect(r.openCount).toBe(2);
    expect(r.overdueCount).toBe(1);
    expect(r.openCents).toBe(10_000);
  });

  it('com o único lançamento liquidado, "em aberto" conta zero', async () => {
    lancamento({ amountCents: 12_345, settledCents: 12_345 });

    const res = await request(app)
      .get('/api/v1/core/finance/entries?direction=in')
      .set(auth);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.summary.openCents).toBe(0);
    expect(res.body.summary.openCount).toBe(0);
    expect(res.body.summary.count).toBe(1);
  });
});
