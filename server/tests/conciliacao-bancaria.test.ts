/**
 * Conciliação bancária.
 *
 * A regra que este arquivo protege é a mesma da conciliação do Asaas: ELA NÃO
 * CORRIGE NADA. Compara e relata. Ajustar sozinha o lado que "parece errado" é
 * acertar a balança empurrando o prato — some com o sintoma, mantém a causa, e
 * a próxima conferência parte de um número adulterado.
 *
 * A segunda: CASAR É ATO DE QUEM CONFERE. O sistema sugere; a pessoa confirma.
 * Casamento automático engoliria justamente o caso que interessa — dois valores
 * iguais no mesmo dia que são fatos diferentes.
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
    userId: 'gerente-banco',
    companyId: 'loja-banco',
    profileCodes: ['gerente_loja'],
  });
  auth = { Authorization: `Bearer ${res.body.accessToken}` };
  companyId = res.body.company.id;
});

/** Lançamento com baixa, do jeito que o FinanceService deixa. */
function baixa(valorCents: number, quando: string, descricao = 'Recebimento'): string {
  const db = getConnection();
  const entryId = `ent-${Math.random().toString(36).slice(2)}`;
  const settlementId = `set-${Math.random().toString(36).slice(2)}`;
  db.prepare(
    `INSERT INTO core_finance_entries
       (id, company_id, direction, amount_cents, status, settled_cents, settled_at,
        description, origin_type, origin_id, created_at)
     VALUES (?, ?, 'in', ?, 'settled', ?, ?, ?, 'manual', ?, ?)`,
  ).run(entryId, companyId, valorCents, valorCents, quando, descricao, entryId, quando);
  db.prepare(
    `INSERT INTO core_finance_settlements
       (id, entry_id, company_id, amount_cents, method, settled_at)
     VALUES (?, ?, ?, ?, 'pix', ?)`,
  ).run(settlementId, entryId, companyId, valorCents, quando);
  return settlementId;
}

async function importar(linhas: Record<string, unknown>[], conta = 'Conta corrente') {
  return request(app)
    .post('/api/v1/core/bank/statements')
    .set(auth)
    .send({ accountLabel: conta, lines: linhas });
}

async function conciliar() {
  const res = await request(app).get('/api/v1/core/bank/conciliacao').set(auth);
  return res.body;
}

describe('importação', () => {
  it('importa as linhas do extrato', async () => {
    const res = await importar([
      { occurredAt: '2026-08-10T12:00:00.000Z', description: 'PIX recebido', amountCents: 15000 },
      { occurredAt: '2026-08-11T12:00:00.000Z', description: 'Tarifa', amountCents: -3500 },
    ]);
    expect(res.status).toBe(201);
    expect(res.body.imported).toBe(2);
  });

  it('reimportar o mesmo arquivo NÃO duplica', async () => {
    const linha = {
      occurredAt: '2026-08-10T12:00:00.000Z',
      description: 'PIX',
      amountCents: 15000,
      externalId: 'FITID-1',
    };
    await importar([linha]);
    const segunda = await importar([linha]);

    // Quem concilia baixa o arquivo de novo para pegar os últimos dias: é o
    // caso normal, não erro.
    expect(segunda.body.imported).toBe(0);
    expect(segunda.body.skipped).toBe(1);
  });

  it('linha de valor zero é ruído do arquivo, não movimento', async () => {
    const res = await importar([
      { occurredAt: '2026-08-10T12:00:00.000Z', description: 'Saldo', amountCents: 0 },
    ]);
    expect(res.body.imported).toBe(0);
  });

  it('extrato sem linha é recusado', async () => {
    const res = await importar([]);
    expect(res.status).toBe(400);
  });
});

describe('as três divergências', () => {
  it('dinheiro no extrato sem baixa no financeiro', async () => {
    await importar([
      { occurredAt: '2026-08-10T12:00:00.000Z', description: 'Depósito', amountCents: 50000 },
    ]);
    const r = await conciliar();
    expect(r.divergences).toHaveLength(1);
    // É o que mais esconde receita: entrou e o financeiro não sabe.
    expect(r.divergences[0].kind).toBe('no_extrato_sem_baixa');
    expect(r.divergences[0].bankCents).toBe(50000);
  });

  it('baixa no financeiro sem nada no extrato', async () => {
    baixa(30000, '2026-08-10T12:00:00.000Z');
    const r = await conciliar();
    expect(r.divergences).toHaveLength(1);
    // Infla o resultado: o financeiro diz que recebeu e o banco não viu.
    expect(r.divergences[0].kind).toBe('baixado_sem_extrato');
    expect(r.divergences[0].financeCents).toBe(30000);
  });

  it('casados com valores diferentes viram divergência de valor', async () => {
    const s = baixa(30000, '2026-08-10T12:00:00.000Z');
    await importar([
      { occurredAt: '2026-08-10T12:00:00.000Z', description: 'PIX', amountCents: 29500 },
    ]);
    const linhas = await request(app).get('/api/v1/core/bank/lines').set(auth);
    await request(app)
      .post(`/api/v1/core/bank/lines/${linhas.body.items[0].id}/match`)
      .set(auth)
      .send({ settlementId: s });

    const r = await conciliar();
    const divergencia = r.divergences.find(
      (d: { kind: string }) => d.kind === 'valor_divergente',
    );
    // Tarifa descontada na entrada costuma explicar; diferença redonda, não.
    expect(divergencia.differenceCents).toBe(-500);
  });

  it('casado e batendo não aparece como divergência', async () => {
    const s = baixa(30000, '2026-08-10T12:00:00.000Z');
    await importar([
      { occurredAt: '2026-08-10T12:00:00.000Z', description: 'PIX', amountCents: 30000 },
    ]);
    const linhas = await request(app).get('/api/v1/core/bank/lines').set(auth);
    await request(app)
      .post(`/api/v1/core/bank/lines/${linhas.body.items[0].id}/match`)
      .set(auth)
      .send({ settlementId: s });

    const r = await conciliar();
    expect(r.divergences).toHaveLength(0);
    expect(r.matched).toBe(1);
  });
});

describe('a conciliação NÃO corrige', () => {
  it('conciliar não cria, não altera e não apaga lançamento', async () => {
    baixa(30000, '2026-08-10T12:00:00.000Z');
    await importar([
      { occurredAt: '2026-08-10T12:00:00.000Z', description: 'Outro valor', amountCents: 99900 },
    ]);

    const antes = getConnection()
      .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents),0) AS t FROM core_finance_entries')
      .get() as { n: number; t: number };

    await conciliar();
    await conciliar();

    const depois = getConnection()
      .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents),0) AS t FROM core_finance_entries')
      .get() as { n: number; t: number };

    // Relatar duas vezes não pode mexer em nada: quem decide é quem responde
    // pelo caixa.
    expect(depois).toEqual(antes);
  });

  it('o resumo mostra a diferença sem escondê-la', async () => {
    baixa(30000, '2026-08-10T12:00:00.000Z');
    await importar([
      { occurredAt: '2026-08-10T12:00:00.000Z', description: 'Depósito', amountCents: 50000 },
    ]);
    const r = await conciliar();
    expect(r.bankTotalCents).toBe(50000);
    expect(r.financeTotalCents).toBe(30000);
    expect(r.differenceCents).toBe(20000);
  });
});

describe('casar é ato de quem confere', () => {
  it('sugere pelo valor e pela data, sem casar', async () => {
    const s = baixa(30000, '2026-08-10T12:00:00.000Z');
    await importar([
      { occurredAt: '2026-08-11T12:00:00.000Z', description: 'PIX', amountCents: 30000 },
    ]);
    const linhas = await request(app).get('/api/v1/core/bank/lines').set(auth);
    const linhaId = linhas.body.items[0].id;

    const sug = await request(app)
      .get(`/api/v1/core/bank/lines/${linhaId}/suggestions`)
      .set(auth);
    expect(sug.body.items).toHaveLength(1);
    expect(sug.body.items[0].id).toBe(s);

    // Sugerir não é casar: a linha continua sem par até alguém confirmar.
    const r = await conciliar();
    expect(r.matched).toBe(0);
  });

  it('a mesma baixa não casa com duas linhas', async () => {
    const s = baixa(30000, '2026-08-10T12:00:00.000Z');
    await importar([
      { occurredAt: '2026-08-10T12:00:00.000Z', description: 'A', amountCents: 30000, externalId: 'a' },
      { occurredAt: '2026-08-10T12:00:00.000Z', description: 'B', amountCents: 30000, externalId: 'b' },
    ]);
    const linhas = await request(app).get('/api/v1/core/bank/lines').set(auth);

    await request(app)
      .post(`/api/v1/core/bank/lines/${linhas.body.items[0].id}/match`)
      .set(auth)
      .send({ settlementId: s });

    const segunda = await request(app)
      .post(`/api/v1/core/bank/lines/${linhas.body.items[1].id}/match`)
      .set(auth)
      .send({ settlementId: s });

    // Permitir faria o mesmo dinheiro aparecer conciliado duas vezes e sumir
    // da lista de divergências.
    expect(segunda.status).toBe(409);
  });

  it('desfazer o casamento devolve a linha para a lista', async () => {
    const s = baixa(30000, '2026-08-10T12:00:00.000Z');
    await importar([
      { occurredAt: '2026-08-10T12:00:00.000Z', description: 'PIX', amountCents: 30000 },
    ]);
    const linhas = await request(app).get('/api/v1/core/bank/lines').set(auth);
    const linhaId = linhas.body.items[0].id;

    await request(app)
      .post(`/api/v1/core/bank/lines/${linhaId}/match`)
      .set(auth)
      .send({ settlementId: s });
    await request(app).delete(`/api/v1/core/bank/lines/${linhaId}/match`).set(auth);

    const r = await conciliar();
    expect(r.matched).toBe(0);
    expect(r.divergences.length).toBeGreaterThan(0);
  });
});

describe('isolamento', () => {
  it('extrato de outra operação não aparece', async () => {
    await importar([
      { occurredAt: '2026-08-10T12:00:00.000Z', description: 'PIX', amountCents: 15000 },
    ]);
    const outra = await loginForTest(app, {
      userId: 'gerente-vizinha-banco',
      companyId: 'loja-vizinha-banco',
      profileCodes: ['gerente_loja'],
    });
    const res = await request(app)
      .get('/api/v1/core/bank/conciliacao')
      .set({ Authorization: `Bearer ${outra.body.accessToken}` });
    expect(res.body.divergences).toHaveLength(0);
  });
});
