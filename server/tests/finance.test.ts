/**
 * Contas a receber e a pagar: baixa, baixa parcial e estorno.
 *
 * O que estes testes protegem é dinheiro. As duas invariantes que não podem
 * cair em nenhuma hipótese: não se recebe mais que o devido, e estornar não
 * apaga o que aconteceu.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { getConnection } from '../src/db/sqlite.js';
import { resetDbForTests } from '../src/db/database.js';
import {
  linkUserToCompany,
  upsertCompany,
  upsertUser,
} from '../src/services/auth/IdentityService.js';

const app = createApp();
const PASSWORD = 'Teste@Financeiro2026';

let companyId: string;
let gestor: { Authorization: string };
let caixa: { Authorization: string };

async function actor(login: string, profile: string): Promise<{ Authorization: string }> {
  const userId = await upsertUser({ login, displayName: login, password: PASSWORD });
  linkUserToCompany(userId, companyId, profile, true);
  const res = await request(app).post('/api/v1/auth/login').send({ login, password: PASSWORD });
  expect(res.status).toBe(200);
  return { Authorization: `Bearer ${res.body.accessToken}` };
}

/** Cria uma conta a receber de valor conhecido. */
async function conta(
  amountCents: number,
  extras: { direction?: 'in' | 'out'; dueDate?: string } = {},
) {
  const res = await request(app)
    .post('/api/v1/core/finance/entries')
    .set(gestor)
    .send({
      direction: extras.direction ?? 'in',
      description: 'Conta de teste',
      amountCents,
      dueDate: extras.dueDate ?? null,
    });
  expect(res.status).toBe(201);
  return res.body as { id: string; balanceCents: number };
}

beforeEach(async () => {
  resetDbForTests();
  companyId = upsertCompany({
    slug: 'loja',
    legalName: 'Loja Ltda',
    tradeName: 'Loja',
  });
  gestor = await actor('GESTORFIN', 'gerente_loja');
  caixa = await actor('CAIXAFIN', 'operador_caixa');
});

describe('baixa', () => {
  it('baixa parcial deixa saldo e não quita', async () => {
    const c = await conta(10_000);

    const res = await request(app)
      .post(`/api/v1/core/finance/entries/${c.id}/settle`)
      .set(caixa)
      .send({ amountCents: 4_000, method: 'dinheiro' });

    expect(res.status).toBe(200);
    expect(res.body.entry.settledCents).toBe(4_000);
    expect(res.body.entry.balanceCents).toBe(6_000);
    expect(res.body.entry.status).toBe('open');
    expect(res.body.entry.settledAt).toBeNull();
  });

  it('somando as parciais até o total, a conta quita', async () => {
    const c = await conta(10_000);
    await request(app)
      .post(`/api/v1/core/finance/entries/${c.id}/settle`)
      .set(caixa)
      .send({ amountCents: 4_000 });
    const fim = await request(app)
      .post(`/api/v1/core/finance/entries/${c.id}/settle`)
      .set(caixa)
      .send({ amountCents: 6_000 });

    expect(fim.body.entry.balanceCents).toBe(0);
    expect(fim.body.entry.status).toBe('settled');
    expect(fim.body.entry.settledAt).toBeTruthy();
    expect(fim.body.settlements).toHaveLength(2);
  });

  it('NÃO recebe mais que o devido', async () => {
    const c = await conta(10_000);
    const res = await request(app)
      .post(`/api/v1/core/finance/entries/${c.id}/settle`)
      .set(caixa)
      .send({ amountCents: 10_001 });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CORE_FINANCE_OVER_SETTLEMENT');

    const saldo = getConnection()
      .prepare('SELECT settled_cents FROM core_finance_entries WHERE id = ?')
      .get(c.id) as { settled_cents: number };
    expect(saldo.settled_cents).toBe(0);
  });

  /**
   * O caso do clique duplo. Conferir o saldo e só então gravar deixaria as
   * duas chamadas passarem pela conferência antes de qualquer uma gravar.
   */
  it('duas baixas do valor cheio: a segunda é recusada, não soma em dobro', async () => {
    const c = await conta(10_000);

    const [a, b] = await Promise.all([
      request(app)
        .post(`/api/v1/core/finance/entries/${c.id}/settle`)
        .set(caixa)
        .send({ amountCents: 10_000 }),
      request(app)
        .post(`/api/v1/core/finance/entries/${c.id}/settle`)
        .set(caixa)
        .send({ amountCents: 10_000 }),
    ]);

    const status = [a.status, b.status].sort();
    expect(status).toEqual([200, 409]);

    const linha = getConnection()
      .prepare('SELECT settled_cents FROM core_finance_entries WHERE id = ?')
      .get(c.id) as { settled_cents: number };
    expect(linha.settled_cents).toBe(10_000);
  });

  it('valor zero ou negativo é recusado', async () => {
    const c = await conta(10_000);
    for (const valor of [0, -500]) {
      const res = await request(app)
        .post(`/api/v1/core/finance/entries/${c.id}/settle`)
        .set(caixa)
        .send({ amountCents: valor });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('CORE_FINANCE_AMOUNT_INVALID');
    }
  });
});

describe('estorno', () => {
  it('devolve o saldo, reabre a conta e PRESERVA o histórico', async () => {
    const c = await conta(10_000);
    const baixa = await request(app)
      .post(`/api/v1/core/finance/entries/${c.id}/settle`)
      .set(caixa)
      .send({ amountCents: 10_000 });
    expect(baixa.body.entry.status).toBe('settled');

    const settlementId = baixa.body.settlements[0].id;
    const res = await request(app)
      .post(`/api/v1/core/finance/settlements/${settlementId}/reverse`)
      .set(gestor)
      .send({ note: 'Cheque devolvido' });

    expect(res.status).toBe(200);
    expect(res.body.entry.balanceCents).toBe(10_000);
    expect(res.body.entry.status).toBe('open');
    expect(res.body.entry.settledAt).toBeNull();

    // O ponto: a baixa original CONTINUA lá, marcada, e o estorno é uma linha
    // própria apontando para ela.
    const linhas = res.body.settlements as {
      id: string;
      amountCents: number;
      reversedAt: string | null;
      reversesId: string | null;
    }[];
    expect(linhas).toHaveLength(2);

    const original = linhas.find((l) => l.id === settlementId)!;
    expect(original.amountCents).toBe(10_000);
    expect(original.reversedAt).toBeTruthy();

    const estorno = linhas.find((l) => l.reversesId === settlementId)!;
    expect(estorno.amountCents).toBe(-10_000);

    // A soma das linhas bate com o saldo do lançamento.
    expect(linhas.reduce((s, l) => s + l.amountCents, 0)).toBe(0);
  });

  it('estornar duas vezes a mesma baixa é recusado', async () => {
    const c = await conta(5_000);
    const baixa = await request(app)
      .post(`/api/v1/core/finance/entries/${c.id}/settle`)
      .set(caixa)
      .send({ amountCents: 5_000 });
    const id = baixa.body.settlements[0].id;

    await request(app).post(`/api/v1/core/finance/settlements/${id}/reverse`).set(gestor).send({});
    const segunda = await request(app)
      .post(`/api/v1/core/finance/settlements/${id}/reverse`)
      .set(gestor)
      .send({});

    expect(segunda.status).toBe(409);
    expect(segunda.body.error.code).toBe('CORE_SETTLEMENT_ALREADY_REVERSED');

    const linha = getConnection()
      .prepare('SELECT settled_cents FROM core_finance_entries WHERE id = ?')
      .get(c.id) as { settled_cents: number };
    expect(linha.settled_cents).toBe(0);
  });

  it('não se estorna um estorno', async () => {
    const c = await conta(5_000);
    const baixa = await request(app)
      .post(`/api/v1/core/finance/entries/${c.id}/settle`)
      .set(caixa)
      .send({ amountCents: 5_000 });

    const primeiro = await request(app)
      .post(`/api/v1/core/finance/settlements/${baixa.body.settlements[0].id}/reverse`)
      .set(gestor)
      .send({});

    const linhaEstorno = (primeiro.body.settlements as { id: string; reversesId: string | null }[])
      .find((l) => l.reversesId)!;

    const res = await request(app)
      .post(`/api/v1/core/finance/settlements/${linhaEstorno.id}/reverse`)
      .set(gestor)
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CORE_SETTLEMENT_IS_REVERSAL');
  });

  it('caixa não estorna — é decisão de gestão', async () => {
    const c = await conta(5_000);
    const baixa = await request(app)
      .post(`/api/v1/core/finance/entries/${c.id}/settle`)
      .set(caixa)
      .send({ amountCents: 5_000 });

    const res = await request(app)
      .post(`/api/v1/core/finance/settlements/${baixa.body.settlements[0].id}/reverse`)
      .set(caixa)
      .send({});
    expect(res.status).toBe(403);
  });
});

describe('lista e totais', () => {
  it('separa o que se recebe do que se paga', async () => {
    await conta(10_000, { direction: 'in' });
    await conta(3_000, { direction: 'out' });

    const receber = await request(app)
      .get('/api/v1/core/finance/entries?direction=in')
      .set(gestor);
    const pagar = await request(app)
      .get('/api/v1/core/finance/entries?direction=out')
      .set(gestor);

    expect(receber.body.items).toHaveLength(1);
    expect(receber.body.summary.openCents).toBe(10_000);
    expect(pagar.body.items).toHaveLength(1);
    expect(pagar.body.summary.openCents).toBe(3_000);
  });

  it('vencido é quem passou da data E ainda deve', async () => {
    const vencida = await conta(10_000, { dueDate: '2020-01-01' });
    await conta(7_000, { dueDate: '2099-12-31' });

    const antes = await request(app)
      .get('/api/v1/core/finance/entries?direction=in')
      .set(gestor);
    expect(antes.body.summary.overdueCents).toBe(10_000);

    const vencidas = await request(app)
      .get('/api/v1/core/finance/entries?direction=in&situation=overdue')
      .set(gestor);
    expect(vencidas.body.items).toHaveLength(1);
    expect(vencidas.body.items[0].overdue).toBe(true);

    // Depois de paga, some do vencido mesmo com a data velha.
    await request(app)
      .post(`/api/v1/core/finance/entries/${vencida.id}/settle`)
      .set(caixa)
      .send({ amountCents: 10_000 });

    const depois = await request(app)
      .get('/api/v1/core/finance/entries?direction=in')
      .set(gestor);
    expect(depois.body.summary.overdueCents).toBe(0);
  });

  it('os totais somam TUDO, não só a página listada', async () => {
    for (let i = 0; i < 12; i += 1) await conta(1_000);
    const res = await request(app)
      .get('/api/v1/core/finance/entries?direction=in')
      .set(gestor);
    expect(res.body.summary.count).toBe(12);
    expect(res.body.summary.openCents).toBe(12_000);
  });

  it('conta de outra operação não aparece', async () => {
    await conta(10_000);
    const outraCo = upsertCompany({
      slug: 'outra',
      legalName: 'Outra Ltda',
      tradeName: 'Outra',
    });
    const outroUser = await upsertUser({
      login: 'GESTOROUTRA',
      displayName: 'Outra',
      password: PASSWORD,
    });
    linkUserToCompany(outroUser, outraCo, 'gerente_loja', true);
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ login: 'GESTOROUTRA', password: PASSWORD });

    const res = await request(app)
      .get('/api/v1/core/finance/entries?direction=in')
      .set({ Authorization: `Bearer ${login.body.accessToken}` });

    expect(res.body.items).toHaveLength(0);
    expect(res.body.summary.openCents).toBe(0);
  });
});
