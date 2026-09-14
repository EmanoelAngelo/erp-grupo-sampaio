/**
 * AS QUITAÇÕES ANTIGAS SEM BAIXA: a lista e a decisão (GAP-PRD-171).
 *
 * Antes do V29, a fatia à vista nascia quitada (`settled_cents =
 * amount_cents`) sem linha em `core_finance_settlements`. A conciliação
 * bancária compara extrato contra BAIXAS: para ela, esses recebimentos não
 * existem. O banco da loja tinha 7 assim (R$ 6.223,45).
 *
 * Criar a baixa que falta muda o que a conciliação de um mês já vivido mostra
 * — é decisão do dono. Este arquivo cobra o MECANISMO que o software oferece
 * para ela: listar quais são, criar sob confirmação (com a data da quitação
 * original, não a de hoje), sem mexer em saldo, resumo nem DRE, sem duplicar
 * no segundo clique, e sem nada rodar sozinho.
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { importStatement, suggestMatches } from '../src/services/core/BankReconciliation.js';
import { createEntry, settleEntry, summarize } from '../src/services/core/FinanceService.js';
import { accountBalanceCents, createAccount } from '../src/services/core/FinanceSetupService.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();

let auth: { Authorization: string };
let companyId: string;

beforeEach(async () => {
  resetDbForTests();
  const res = await loginForTest(app, {
    userId: 'gerente-legado',
    companyId: 'loja-legado',
    profileCodes: ['gerente_loja'],
  });
  auth = { Authorization: `Bearer ${res.body.accessToken}` };
  companyId = res.body.company.id;
});

/** Um lançamento quitado como os de antes do V29: saldo quitado, nenhuma baixa. */
function legado(o: {
  amountCents: number;
  settledAt: string;
  direction?: 'in' | 'out';
  cancelled?: boolean;
  empresa?: string;
  accountId?: string | null;
}): string {
  const id = randomUUID();
  getConnection()
    .prepare(
      `INSERT INTO core_finance_entries
         (id, company_id, direction, amount_cents, status, settled_cents, settled_at, due_date,
          description, origin_type, origin_id, payment_method, account_id, cancelled_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Venda à vista (antiga)', 'sale', ?, 'dinheiro', ?, ?, ?)`,
    )
    .run(
      id,
      o.empresa ?? companyId,
      o.direction ?? 'in',
      o.amountCents,
      o.cancelled ? 'cancelled' : 'settled',
      o.amountCents,
      o.settledAt,
      o.settledAt.slice(0, 10),
      randomUUID(),
      o.accountId ?? null,
      o.cancelled ? o.settledAt : null,
      o.settledAt,
    );
  return id;
}

function baixasDe(entryId: string) {
  return getConnection()
    .prepare('SELECT amount_cents, settled_at, method, note, user_id FROM core_finance_settlements WHERE entry_id = ?')
    .all(entryId) as { amount_cents: number; settled_at: string; method: string | null; note: string; user_id: string | null }[];
}

describe('GAP-PRD-171 — a lista diz quais quitações não têm baixa', () => {
  it('só as quitadas SEM baixa, vivas, desta operação — com o que falta e a data que a baixa levaria', async () => {
    const antiga = legado({ amountCents: 31_970, settledAt: '2026-08-12T15:00:00.000Z' });
    legado({ amountCents: 5_000, settledAt: '2026-08-13T15:00:00.000Z', cancelled: true });
    const nova = createEntry({ companyId, direction: 'in', description: 'Nova', amountCents: 2_000 });
    settleEntry({ companyId, entryId: nova.id, amountCents: 2_000 });

    const res = await request(app).get('/api/v1/core/finance/legacy-settlements').set(auth);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.inCents).toBe(31_970);
    expect(res.body.items[0]).toMatchObject({
      id: antiga,
      missingCents: 31_970,
      explainedCents: 0,
      mirrorDate: '2026-08-12T15:00:00.000Z',
    });
  });

  it('parcialmente explicada: falta só a parte sem baixa', async () => {
    const id = legado({ amountCents: 10_000, settledAt: '2026-08-10T15:00:00.000Z' });
    getConnection()
      .prepare(
        `INSERT INTO core_finance_settlements (id, entry_id, company_id, amount_cents, method, settled_at)
         VALUES (?, ?, ?, 4000, 'pix', '2026-08-11T15:00:00.000Z')`,
      )
      .run(randomUUID(), id, companyId);

    const res = await request(app).get('/api/v1/core/finance/legacy-settlements').set(auth);
    expect(res.body.items[0]).toMatchObject({ id, explainedCents: 4_000, missingCents: 6_000 });
  });
});

describe('GAP-PRD-171 — criar as baixas-espelho é decisão, e só acontece confirmada', () => {
  it('sem confirmação, nada é gravado', async () => {
    const id = legado({ amountCents: 32_900, settledAt: '2026-08-14T15:00:00.000Z' });
    const res = await request(app).post('/api/v1/core/finance/legacy-settlements/mirror').set(auth).send({});
    expect(res.status).toBe(400);
    expect(baixasDe(id)).toEqual([]);
  });

  it('confirmada: a baixa nasce com a data da quitação original, a forma, quem decidiu e a nota de migração', async () => {
    const id = legado({ amountCents: 107_475, settledAt: '2026-08-15T15:00:00.000Z' });

    const res = await request(app)
      .post('/api/v1/core/finance/legacy-settlements/mirror')
      .set(auth)
      .send({ confirm: true });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ created: 1, totalCents: 107_475 });

    const [baixa] = baixasDe(id);
    expect(baixa.amount_cents).toBe(107_475);
    expect(baixa.settled_at).toBe('2026-08-15T15:00:00.000Z');
    expect(baixa.method).toBe('dinheiro');
    expect(baixa.note).toContain('migração');
    expect(baixa.user_id).toBeTruthy();

    const trilha = getConnection()
      .prepare("SELECT COUNT(*) AS n FROM core_audit_log WHERE action = 'finance.legacy_settlements_mirrored'")
      .get() as { n: number };
    expect(Number(trilha.n)).toBe(1);
  });

  it('o segundo clique não duplica — o que falta é recalculado', async () => {
    const id = legado({ amountCents: 180_000, settledAt: '2026-08-16T15:00:00.000Z' });
    await request(app).post('/api/v1/core/finance/legacy-settlements/mirror').set(auth).send({ confirm: true });
    const segunda = await request(app)
      .post('/api/v1/core/finance/legacy-settlements/mirror')
      .set(auth)
      .send({ confirm: true });

    expect(segunda.body.created).toBe(0);
    expect(baixasDe(id)).toHaveLength(1);
    const lista = await request(app).get('/api/v1/core/finance/legacy-settlements').set(auth);
    expect(lista.body.count).toBe(0);
  });

  it('não mexe em saldo, resumo nem DRE — só dá à conciliação com o que casar', async () => {
    const conta = createAccount(companyId, { name: 'Banco', openingBalanceCents: 0 });
    const id = legado({ amountCents: 31_970, settledAt: '2026-08-12T15:00:00.000Z', accountId: conta.id });
    const antes = { saldo: accountBalanceCents(companyId, conta.id), resumo: summarize(companyId, 'in') };

    const { statementId } = importStatement({
      companyId,
      accountLabel: 'Banco',
      lines: [{ occurredAt: '2026-08-12', description: 'Depósito', amountCents: 31_970, externalId: 'fitid-1' }],
    });
    const linha = getConnection()
      .prepare('SELECT id FROM core_bank_statement_lines WHERE statement_id = ?')
      .get(statementId) as { id: string };
    // Antes: a conciliação não tem com o que casar o depósito.
    expect(suggestMatches(companyId, linha.id)).toEqual([]);

    await request(app).post('/api/v1/core/finance/legacy-settlements/mirror').set(auth).send({ confirm: true });

    expect(accountBalanceCents(companyId, conta.id)).toBe(antes.saldo);
    expect(summarize(companyId, 'in')).toEqual(antes.resumo);
    const entry = getConnection()
      .prepare('SELECT settled_cents FROM core_finance_entries WHERE id = ?')
      .get(id) as { settled_cents: number };
    expect(entry.settled_cents).toBe(31_970);
    // Depois: a baixa-espelho é sugerida para o depósito do mesmo dia.
    const sugestoes = suggestMatches(companyId, linha.id) as { entry_id: string }[];
    expect(sugestoes.map((s) => s.entry_id)).toEqual([id]);
  });

  it('só os lançamentos escolhidos, quando a lista vem no corpo', async () => {
    const um = legado({ amountCents: 1_000, settledAt: '2026-08-01T15:00:00.000Z' });
    const outro = legado({ amountCents: 2_000, settledAt: '2026-08-02T15:00:00.000Z' });
    const res = await request(app)
      .post('/api/v1/core/finance/legacy-settlements/mirror')
      .set(auth)
      .send({ confirm: true, entryIds: [um] });
    expect(res.body.created).toBe(1);
    expect(baixasDe(um)).toHaveLength(1);
    expect(baixasDe(outro)).toHaveLength(0);
  });

  it('outra operação não vê nem cria as baixas desta', async () => {
    const id = legado({ amountCents: 9_000, settledAt: '2026-08-03T15:00:00.000Z' });
    const vizinha = await loginForTest(app, {
      userId: 'gerente-vizinha-legado',
      companyId: 'loja-vizinha-legado',
      profileCodes: ['gerente_loja'],
    });
    const authVizinha = { Authorization: `Bearer ${vizinha.body.accessToken}` };
    const lista = await request(app).get('/api/v1/core/finance/legacy-settlements').set(authVizinha);
    expect(lista.body.count).toBe(0);
    await request(app)
      .post('/api/v1/core/finance/legacy-settlements/mirror')
      .set(authVizinha)
      .send({ confirm: true, entryIds: [id] });
    expect(baixasDe(id)).toEqual([]);
  });

  it('o caixa não decide isso', async () => {
    const caixa = await loginForTest(app, { userId: 'caixa-legado', companyId, profileCodes: ['operador_caixa_loja'] });
    const res = await request(app)
      .post('/api/v1/core/finance/legacy-settlements/mirror')
      .set({ Authorization: `Bearer ${caixa.body.accessToken}` })
      .send({ confirm: true });
    expect(res.status).toBe(403);
  });
});
