/**
 * A LISTA DA CONCILIAÇÃO BANCÁRIA DECLARA O QUE CORTOU (GAP-PRD-177).
 *
 * `listLines` devolvia no máximo 500 linhas e `listStatements` no máximo 50,
 * sem sinal nenhum. Os totais do relatório nunca cortaram; a LISTA DE
 * TRABALHO cortava — e num mês com mais de 500 lançamentos bancários o fim do
 * extrato, com as linhas ainda sem conciliação, sumia da tela em silêncio.
 *
 * A página agora vem com `total`, `limit`, `offset` e `truncated`, e a
 * próxima página se pede por `offset`.
 */
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { importStatement } from '../src/services/core/BankReconciliation.js';
import { createEntry, settleEntry } from '../src/services/core/FinanceService.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();

let auth: { Authorization: string };
let companyId: string;

beforeEach(async () => {
  resetDbForTests();
  const res = await loginForTest(app, {
    userId: 'gerente-extrato',
    companyId: 'loja-extrato',
    profileCodes: ['gerente_loja'],
  });
  auth = { Authorization: `Bearer ${res.body.accessToken}` };
  companyId = res.body.company.id;
});

/** Um extrato com N linhas, uma por minuto a partir de 1º de agosto. */
function extratoCom(n: number, conta = 'Conta corrente'): string {
  const linhas = Array.from({ length: n }, (_, i) => ({
    occurredAt: `2026-08-${String(1 + Math.floor(i / 40)).padStart(2, '0')}`,
    description: `PIX recebido ${i + 1}`,
    amountCents: 1_000 + i,
    externalId: `${conta}-fitid-${i + 1}`,
  }));
  return importStatement({ companyId, accountLabel: conta, lines: linhas }).statementId;
}

describe('GAP-PRD-177 — a lista de linhas diz quantas existem e pagina', () => {
  it('com 530 linhas, a primeira página traz 500 e DECLARA que há mais', async () => {
    extratoCom(530);

    const res = await request(app).get('/api/v1/core/bank/lines?onlyUnmatched=true').set(auth);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.items).toHaveLength(500);
    expect(res.body.total).toBe(530);
    expect(res.body.truncated).toBe(true);
    expect(res.body.limit).toBe(500);
    expect(res.body.offset).toBe(0);
  });

  it('a segunda página traz o FIM do extrato, sem repetir nem pular linha', async () => {
    extratoCom(530);

    const p1 = await request(app).get('/api/v1/core/bank/lines?onlyUnmatched=true').set(auth);
    const p2 = await request(app).get('/api/v1/core/bank/lines?onlyUnmatched=true&offset=500').set(auth);

    expect(p2.body.items).toHaveLength(30);
    expect(p2.body.truncated).toBe(false);
    const ids = new Set([...p1.body.items, ...p2.body.items].map((l: { id: string }) => l.id));
    expect(ids.size).toBe(530);
    // O último lançamento do mês está na lista — era o que sumia.
    expect(p2.body.items.map((l: { description: string }) => l.description)).toContain('PIX recebido 530');
  });

  it('as casadas se pedem à parte, com o próprio total', async () => {
    const statementId = extratoCom(10);
    const ids = getConnection()
      .prepare('SELECT id FROM core_bank_statement_lines WHERE statement_id = ? ORDER BY occurred_at, id LIMIT 3')
      .all(statementId) as { id: string }[];
    // Casamento encenado direto no banco, com baixas de verdade (a coluna tem
    // chave estrangeira): o que se mede aqui é a LISTA, não o casamento.
    for (const { id } of ids) {
      const titulo = createEntry({ companyId, direction: 'in', description: 'Recebível', amountCents: 1_000 });
      const baixa = settleEntry({ companyId, entryId: titulo.id, amountCents: 1_000 }).settlements[0];
      getConnection()
        .prepare('UPDATE core_bank_statement_lines SET matched_settlement_id = ? WHERE id = ?')
        .run(baixa.id, id);
    }

    const casadas = await request(app).get('/api/v1/core/bank/lines?onlyMatched=true').set(auth);
    const pendentes = await request(app).get('/api/v1/core/bank/lines?onlyUnmatched=true').set(auth);
    expect(casadas.body.total).toBe(3);
    expect(pendentes.body.total).toBe(7);
    expect(casadas.body.truncated).toBe(false);
  });

  it('o limite por página é parâmetro, com teto', async () => {
    extratoCom(30);
    const res = await request(app).get('/api/v1/core/bank/lines?limit=10&offset=25').set(auth);
    expect(res.body.items).toHaveLength(5);
    expect(res.body.total).toBe(30);
    expect(res.body.truncated).toBe(false);

    const enorme = await request(app).get('/api/v1/core/bank/lines?limit=999999').set(auth);
    expect(enorme.body.limit).toBe(2000);
  });

  it('a lista de extratos também declara o corte (antes: 50 em silêncio)', async () => {
    for (let i = 0; i < 52; i += 1) extratoCom(1, `Conta ${i}`);

    const res = await request(app).get('/api/v1/core/bank/statements').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(50);
    expect(res.body.total).toBe(52);
    expect(res.body.truncated).toBe(true);

    const resto = await request(app).get('/api/v1/core/bank/statements?offset=50').set(auth);
    expect(resto.body.items).toHaveLength(2);
  });

  it('a linha de outra operação não entra na conta de ninguém', async () => {
    extratoCom(5);
    const vizinha = await loginForTest(app, {
      userId: 'gerente-vizinha',
      companyId: 'loja-vizinha-extrato',
      profileCodes: ['gerente_loja'],
    });
    const res = await request(app)
      .get('/api/v1/core/bank/lines')
      .set({ Authorization: `Bearer ${vizinha.body.accessToken}` });
    expect(res.body.total).toBe(0);
    expect(res.body.items).toEqual([]);
  });
});
