/**
 * A BAIXA ACEITA Idempotency-Key (GAP-PRD-173).
 *
 * ============================================================================
 * O DEFEITO
 * ============================================================================
 *
 * `POST /finance/entries/:id/settle` não lia a chave. Dois POST iguais de
 * 5.000 num título de 10.000 — clique duplo, rede lenta que reenvia, dois
 * caixas na mesma conta — respondiam 200/200 e gravavam DUAS baixas. O teto do
 * devido (UPDATE condicional) segura o TOTAL: 3×6.000 dá 1×200 e 2×409. Mas a
 * repetição de uma parcial passa inteira, e o título aparece quitado com
 * metade do dinheiro.
 *
 * ============================================================================
 * O CONSERTO
 * ============================================================================
 *
 * Com a chave, o segundo pedido devolve a baixa do primeiro (`replayed:
 * true`), sem gravar outra linha, sem segundo registro na trilha. A chave é da
 * empresa; reaproveitá-la para outro título, outro valor ou outra forma é 422
 * CORE_IDEMPOTENCY_KEY_REUSED (a mesma resposta de toda chave reusada com outro
 * corpo, RES-IDEM-VIZ) — devolver a baixa antiga anunciaria como feita uma
 * baixa que ninguém gravou.
 */
process.env.TZ = 'UTC';

import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

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
    userId: 'gerente-baixa',
    companyId: 'loja-baixa',
    profileCodes: ['gerente_loja'],
  });
  auth = { Authorization: `Bearer ${res.body.accessToken}` };
  companyId = res.body.company.id;
});

async function titulo(authDe = auth, valor = 10_000): Promise<string> {
  const res = await request(app)
    .post('/api/v1/core/finance/entries')
    .set(authDe)
    .send({ direction: 'in', description: 'Aluguel da sala', amountCents: valor, dueDate: '2026-09-20' });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

function baixasDe(entryId: string): { amount_cents: number }[] {
  return getConnection()
    .prepare('SELECT amount_cents FROM core_finance_settlements WHERE entry_id = ?')
    .all(entryId) as unknown as { amount_cents: number }[];
}

function auditoriasDe(entryId: string): number {
  const row = getConnection()
    .prepare(
      `SELECT COUNT(*) AS n FROM core_audit_log
        WHERE action = 'finance.settled' AND entity_id = ?`,
    )
    .get(entryId) as { n: number };
  return Number(row.n);
}

describe('GAP-PRD-173 — o reenvio da mesma baixa não vira segunda baixa', () => {
  it('dois POST iguais EM PARALELO com a mesma chave: uma baixa só, e os dois veem a mesma resposta', async () => {
    const id = await titulo();
    const chave = randomUUID();

    const [a, b] = await Promise.all([
      request(app)
        .post(`/api/v1/core/finance/entries/${id}/settle`)
        .set(auth)
        .set('Idempotency-Key', chave)
        .send({ amountCents: 5_000, method: 'pix' }),
      request(app)
        .post(`/api/v1/core/finance/entries/${id}/settle`)
        .set(auth)
        .set('Idempotency-Key', chave)
        .send({ amountCents: 5_000, method: 'pix' }),
    ]);

    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(b.status, JSON.stringify(b.body)).toBe(200);
    // Um dos dois foi o reenvio.
    expect([a.body.replayed, b.body.replayed].filter(Boolean)).toHaveLength(1);
    expect(a.body.entry.settledCents).toBe(5_000);
    expect(b.body.entry.settledCents).toBe(5_000);
    expect(baixasDe(id)).toEqual([{ amount_cents: 5_000 }]);
    // A trilha registra o recebimento uma vez, como o banco.
    expect(auditoriasDe(id)).toBe(1);
  });

  it('o reenvio DEPOIS de o título quitar devolve a baixa, não "já está quitado"', async () => {
    const id = await titulo(auth, 4_000);
    const chave = randomUUID();

    const primeiro = await request(app)
      .post(`/api/v1/core/finance/entries/${id}/settle`)
      .set(auth)
      .set('Idempotency-Key', chave)
      .send({ amountCents: 4_000 });
    expect(primeiro.status).toBe(200);
    expect(primeiro.body.entry.balanceCents).toBe(0);

    // A resposta do primeiro se perdeu; a tela manda de novo.
    const reenvio = await request(app)
      .post(`/api/v1/core/finance/entries/${id}/settle`)
      .set(auth)
      .set('Idempotency-Key', chave)
      .send({ amountCents: 4_000 });
    expect(reenvio.status, JSON.stringify(reenvio.body)).toBe(200);
    expect(reenvio.body.replayed).toBe(true);
    expect(reenvio.body.settlements).toHaveLength(1);
  });

  it('a mesma chave para OUTRO valor é recusada, e nada é gravado', async () => {
    const id = await titulo();
    const chave = randomUUID();
    await request(app)
      .post(`/api/v1/core/finance/entries/${id}/settle`)
      .set(auth)
      .set('Idempotency-Key', chave)
      .send({ amountCents: 3_000 });

    const outro = await request(app)
      .post(`/api/v1/core/finance/entries/${id}/settle`)
      .set(auth)
      .set('Idempotency-Key', chave)
      .send({ amountCents: 2_000 });

    // A mesma resposta de toda chave reusada com outro corpo (RES-IDEM-VIZ):
    // 422 CORE_IDEMPOTENCY_KEY_REUSED, e não mais o 409 próprio da baixa.
    expect(outro.status).toBe(422);
    expect(outro.body.error?.code ?? outro.body.code).toBe('CORE_IDEMPOTENCY_KEY_REUSED');
    expect(baixasDe(id)).toEqual([{ amount_cents: 3_000 }]);
  });

  it('a mesma chave para OUTRA forma de recebimento também é recusada', async () => {
    const id = await titulo();
    const chave = randomUUID();
    const primeiro = await request(app)
      .post(`/api/v1/core/finance/entries/${id}/settle`)
      .set(auth)
      .set('Idempotency-Key', chave)
      .send({ amountCents: 3_000, method: 'pix' });
    expect(primeiro.status).toBe(200);

    const outro = await request(app)
      .post(`/api/v1/core/finance/entries/${id}/settle`)
      .set(auth)
      .set('Idempotency-Key', chave)
      .send({ amountCents: 3_000, method: 'dinheiro' });
    expect(outro.status, JSON.stringify(outro.body)).toBe(422);
    expect(outro.body.error.code).toBe('CORE_IDEMPOTENCY_KEY_REUSED');
    expect(baixasDe(id)).toEqual([{ amount_cents: 3_000 }]);
  });

  it('pedido de baixa anterior à impressão digital: a regra de antes (título e valor)', async () => {
    const id = await titulo();
    const chave = randomUUID();
    await request(app)
      .post(`/api/v1/core/finance/entries/${id}/settle`)
      .set(auth)
      .set('Idempotency-Key', chave)
      .send({ amountCents: 3_000, method: 'pix' });
    getConnection()
      .prepare('UPDATE core_finance_settle_requests SET idempotency_fingerprint = NULL WHERE idempotency_key = ?')
      .run(chave);

    // Mesma chave, mesmo título e valor, outra forma: a regra antiga não
    // olhava a forma, e devolve a baixa já feita.
    const reenvio = await request(app)
      .post(`/api/v1/core/finance/entries/${id}/settle`)
      .set(auth)
      .set('Idempotency-Key', chave)
      .send({ amountCents: 3_000, method: 'dinheiro' });
    expect(reenvio.status, JSON.stringify(reenvio.body)).toBe(200);
    expect(reenvio.body.replayed).toBe(true);

    // Outro valor continua recusado, como sempre foi.
    const outroValor = await request(app)
      .post(`/api/v1/core/finance/entries/${id}/settle`)
      .set(auth)
      .set('Idempotency-Key', chave)
      .send({ amountCents: 2_000, method: 'pix' });
    expect(outroValor.status).toBe(422);
    expect(baixasDe(id)).toEqual([{ amount_cents: 3_000 }]);
  });

  it('a mesma chave para OUTRO título também é recusada', async () => {
    const um = await titulo();
    const outroTitulo = await titulo();
    const chave = randomUUID();
    await request(app)
      .post(`/api/v1/core/finance/entries/${um}/settle`)
      .set(auth)
      .set('Idempotency-Key', chave)
      .send({ amountCents: 1_000 });

    const res = await request(app)
      .post(`/api/v1/core/finance/entries/${outroTitulo}/settle`)
      .set(auth)
      .set('Idempotency-Key', chave)
      .send({ amountCents: 1_000 });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CORE_IDEMPOTENCY_KEY_REUSED');
    expect(baixasDe(outroTitulo)).toEqual([]);
  });

  it('a chave é da EMPRESA: outra operação com a mesma chave dá a própria baixa', async () => {
    const id = await titulo();
    const chave = 'chave-repetida-entre-lojas';
    await request(app)
      .post(`/api/v1/core/finance/entries/${id}/settle`)
      .set(auth)
      .set('Idempotency-Key', chave)
      .send({ amountCents: 1_000 });

    const vizinha = await loginForTest(app, {
      userId: 'gerente-vizinha',
      companyId: 'loja-vizinha',
      profileCodes: ['gerente_loja'],
    });
    const authVizinha = { Authorization: `Bearer ${vizinha.body.accessToken}` };
    const idVizinha = await titulo(authVizinha);
    const res = await request(app)
      .post(`/api/v1/core/finance/entries/${idVizinha}/settle`)
      .set(authVizinha)
      .set('Idempotency-Key', chave)
      .send({ amountCents: 1_000 });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.replayed).toBeFalsy();
    expect(baixasDe(idVizinha)).toEqual([{ amount_cents: 1_000 }]);
    expect(companyId).not.toBe(vizinha.body.company.id);
  });

  it('sem chave, o comportamento antigo continua: cada POST é uma baixa (a tela passa a mandar a chave)', async () => {
    const id = await titulo();
    await request(app).post(`/api/v1/core/finance/entries/${id}/settle`).set(auth).send({ amountCents: 1_000 });
    await request(app).post(`/api/v1/core/finance/entries/${id}/settle`).set(auth).send({ amountCents: 1_000 });
    expect(baixasDe(id)).toHaveLength(2);
  });
});
