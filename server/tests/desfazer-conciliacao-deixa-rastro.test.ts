/**
 * DESFAZER O CASAMENTO BANCÁRIO DEIXA RASTRO (GAP-V26).
 *
 * ## Por que a trilha importa MAIS aqui do que no casamento
 *
 * Casar grava `matched_by` e `matched_at` na própria linha: quem conferiu fica
 * escrito no fato. DESFAZER APAGA esses dois campos — é a única operação desta
 * tela que destrói informação.
 *
 * Sem gravação na trilha central, o desfazer era invisível por construção: a
 * linha voltava a parecer nunca conferida, a divergência reaparecia no
 * relatório sem história, e ninguém saberia que alguém já a tinha resolvido
 * uma vez e mudou de ideia. Numa tela cujo produto é a lista de divergências,
 * isso é apagar a resposta e a pergunta ao mesmo tempo.
 *
 * ## O que se cobra aqui
 *
 * O ato inteiro pela ROTA: desfaz, devolve o que desfez (para a trilha poder
 * nomear a baixa que ficou solta de novo), registra em `core_audit_log`, e a
 * divergência volta ao relatório.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();
let auth: { Authorization: string };
let companyId: string;

beforeEach(async () => {
  resetDbForTests();
  const res = await loginForTest(app, {
    userId: 'gerente-desfaz',
    companyId: 'loja-desfaz',
    profileCodes: ['gerente_loja'],
  });
  auth = { Authorization: `Bearer ${res.body.accessToken}` };
  companyId = res.body.company.id;
});

/** Um lançamento já baixado — o outro lado do casamento. */
function baixa(valorCents: number, quando: string, descricao = 'Recebimento'): string {
  const db = getConnection();
  const entryId = `ent-${Math.random().toString(36).slice(2)}`;
  const settlementId = `set-${Math.random().toString(36).slice(2)}`;
  db.prepare(
    `INSERT INTO core_finance_entries
       (id, company_id, direction, amount_cents, status, settled_cents, settled_at,
        description, origin_type, origin_id, created_at)
     VALUES (?, ?, 'in', ?, ?, ?, ?, ?, 'manual', ?, ?)`,
  ).run(entryId, companyId, valorCents, 'settled', valorCents, quando, descricao, entryId, quando);
  db.prepare(
    `INSERT INTO core_finance_settlements
       (id, entry_id, company_id, amount_cents, method, settled_at)
     VALUES (?, ?, ?, ?, 'pix', ?)`,
  ).run(settlementId, entryId, companyId, valorCents, quando);
  return settlementId;
}

/** Importa uma linha e devolve o id dela. */
async function importarUmaLinha(valorCents: number, quando: string): Promise<string> {
  const res = await request(app)
    .post('/api/v1/core/bank/statements')
    .set(auth)
    .send({
      accountLabel: 'Conta corrente',
      lines: [{ occurredAt: quando, description: 'PIX recebido', amountCents: valorCents }],
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const linha = getConnection()
    .prepare('SELECT id FROM core_bank_statement_lines WHERE company_id = ?')
    .get(companyId) as { id: string };
  return linha.id;
}

function trilha(action: string): Record<string, unknown>[] {
  return getConnection()
    .prepare('SELECT * FROM core_audit_log WHERE company_id = ? AND action = ?')
    .all(companyId, action) as unknown as Record<string, unknown>[];
}

describe('desfazer pela rota', () => {
  it('devolve a linha para as pendentes e o dinheiro para as divergências', async () => {
    const settlementId = baixa(15_000, '2026-08-10T12:00:00.000Z');
    const lineId = await importarUmaLinha(15_000, '2026-08-10');

    const casou = await request(app)
      .post(`/api/v1/core/bank/lines/${lineId}/match`)
      .set(auth)
      .send({ settlementId });
    expect(casou.status, JSON.stringify(casou.body)).toBe(200);

    const antes = await request(app).get('/api/v1/core/bank/conciliacao').set(auth);
    expect(antes.body.divergences).toHaveLength(0);

    const desfez = await request(app)
      .delete(`/api/v1/core/bank/lines/${lineId}/match`)
      .set(auth);
    expect(desfez.status, JSON.stringify(desfez.body)).toBe(200);

    const depois = await request(app).get('/api/v1/core/bank/conciliacao').set(auth);
    // Duas divergências: a linha do banco sem baixa, e a baixa sem linha. É
    // exatamente o retrato de antes do casamento — nada foi corrigido, o
    // engano só deixou de estar escondido.
    expect(depois.body.divergences).toHaveLength(2);
  });

  it('a resposta NOMEIA a baixa que voltou a ficar solta', async () => {
    const settlementId = baixa(15_000, '2026-08-10T12:00:00.000Z');
    const lineId = await importarUmaLinha(15_000, '2026-08-10');
    await request(app)
      .post(`/api/v1/core/bank/lines/${lineId}/match`)
      .set(auth)
      .send({ settlementId });

    const desfez = await request(app)
      .delete(`/api/v1/core/bank/lines/${lineId}/match`)
      .set(auth);

    expect(desfez.body.settlementId).toBe(settlementId);
    expect(desfez.body.amountCents).toBe(15_000);
  });

  it('GRAVA na trilha quem desfez, qual linha e qual baixa', async () => {
    const settlementId = baixa(15_000, '2026-08-10T12:00:00.000Z');
    const lineId = await importarUmaLinha(15_000, '2026-08-10');
    await request(app)
      .post(`/api/v1/core/bank/lines/${lineId}/match`)
      .set(auth)
      .send({ settlementId });

    await request(app).delete(`/api/v1/core/bank/lines/${lineId}/match`).set(auth);

    const registros = trilha('bank.line_unmatched');
    expect(registros).toHaveLength(1);
    expect(registros[0].entity_id).toBe(lineId);
    expect(registros[0].user_id).toBeTruthy();
    const detail = JSON.parse(String(registros[0].detail)) as Record<string, unknown>;
    // A baixa nomeada é o que permite reencontrar o fato depois: `matched_by`
    // e `matched_at` acabaram de ser apagados da linha.
    expect(detail.settlementId).toBe(settlementId);
    expect(detail.amountCents).toBe(15_000);
  });

  it('casar também deixa rastro — os dois lados do mesmo ato', async () => {
    const settlementId = baixa(15_000, '2026-08-10T12:00:00.000Z');
    const lineId = await importarUmaLinha(15_000, '2026-08-10');
    await request(app)
      .post(`/api/v1/core/bank/lines/${lineId}/match`)
      .set(auth)
      .send({ settlementId });

    const registros = trilha('bank.line_matched');
    expect(registros).toHaveLength(1);
    expect(registros[0].entity_id).toBe(lineId);
  });

  it('linha de outra empresa não é desfeita — nem existe daqui', async () => {
    const outra = await loginForTest(app, {
      userId: 'gerente-vizinho',
      companyId: 'loja-vizinha',
      profileCodes: ['gerente_loja'],
    });
    const settlementId = baixa(15_000, '2026-08-10T12:00:00.000Z');
    const lineId = await importarUmaLinha(15_000, '2026-08-10');
    await request(app)
      .post(`/api/v1/core/bank/lines/${lineId}/match`)
      .set(auth)
      .send({ settlementId });

    const tentativa = await request(app)
      .delete(`/api/v1/core/bank/lines/${lineId}/match`)
      .set({ Authorization: `Bearer ${outra.body.accessToken}` });

    expect(tentativa.status).toBe(404);
    // E o casamento continua de pé na empresa dona.
    const linha = getConnection()
      .prepare('SELECT matched_settlement_id FROM core_bank_statement_lines WHERE id = ?')
      .get(lineId) as { matched_settlement_id: string | null };
    expect(linha.matched_settlement_id).toBe(settlementId);
  });
});
