/**
 * FLUXO DE CAIXA PROJETADO (GAP-PRD-094).
 *
 * "Tenho caixa para pagar o fornecedor dia 20?" — a pergunta exigia filtrar
 * as duas telas de Contas por vencimento e somar de cabeça. Não havia rota,
 * serviço, tela nem teste. Este arquivo cobra a conta que a rota nova faz:
 *
 *   saldo projetado = saldo de hoje das contas
 *                   + vencidos que se decidiu contar
 *                   + Σ (a receber − a pagar) por vencimento
 *
 * com o SALDO EM ABERTO de cada título (não o valor original), cancelado
 * fora pelo carimbo, e cada coisa que ficou de fora dita pelo nome.
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { hojeNaLoja, somarDias } from '../src/services/core/CalendarioOperacional.js';
import { createAccount } from '../src/services/core/FinanceSetupService.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();

let auth: { Authorization: string };
let companyId: string;
let HOJE: string;

beforeEach(async () => {
  resetDbForTests();
  const res = await loginForTest(app, {
    userId: 'gerente-fluxo',
    companyId: 'loja-fluxo',
    profileCodes: ['gerente_loja'],
  });
  auth = { Authorization: `Bearer ${res.body.accessToken}` };
  companyId = res.body.company.id;
  HOJE = hojeNaLoja();
});

const dia = (n: number) => somarDias(HOJE, n);

function titulo(o: {
  direction: 'in' | 'out';
  amountCents: number;
  dueDate: string | null;
  settledCents?: number;
  accountId?: string | null;
  cancelled?: boolean;
  description?: string;
}): string {
  const id = randomUUID();
  const liquidado = o.settledCents ?? 0;
  getConnection()
    .prepare(
      `INSERT INTO core_finance_entries
         (id, company_id, direction, amount_cents, status, settled_cents, due_date,
          description, origin_type, origin_id, account_id, cancelled_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?, ?)`,
    )
    .run(
      id,
      companyId,
      o.direction,
      o.amountCents,
      o.cancelled ? 'cancelled' : liquidado >= o.amountCents ? 'settled' : 'open',
      liquidado,
      o.dueDate,
      o.description ?? (o.direction === 'in' ? 'A receber' : 'A pagar'),
      id,
      o.accountId ?? null,
      o.cancelled ? new Date().toISOString() : null,
      new Date().toISOString(),
    );
  return id;
}

async function fluxo(qs = '') {
  const res = await request(app).get(`/api/v1/core/finance/cash-flow${qs ? `?${qs}` : ''}`).set(auth);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as {
    from: string;
    to: string;
    granularity: 'day' | 'week';
    openingBalanceCents: number;
    periods: { start: string; end: string; inCents: number; outCents: number; netCents: number; balanceCents: number; count: number; items: { id: string; balanceCents: number }[] }[];
    totals: { inCents: number; outCents: number; netCents: number };
    closingBalanceCents: number;
    lowestBalance: { cents: number; date: string };
    firstNegativeDate: string | null;
    overdue: { inCents: number; outCents: number; count: number; countedInCents: number; countedOutCents: number };
    noDueDate: { count: number; inCents: number; outCents: number };
    beyond: { count: number };
    withoutAccount: { count: number } | null;
    settledWithoutAccountCents: number;
    caveats: string[];
  };
}

describe('GAP-PRD-094 — o que entra, o que sai, e onde o saldo vai parar', () => {
  it('30 dias por padrão, dia a dia, começando no saldo de hoje das contas', async () => {
    const banco = createAccount(companyId, { name: 'Banco', openingBalanceCents: 100_000 });
    titulo({ direction: 'in', amountCents: 20_000, settledCents: 20_000, dueDate: dia(-3), accountId: banco.id });
    titulo({ direction: 'in', amountCents: 30_000, dueDate: dia(5), accountId: banco.id });
    titulo({ direction: 'out', amountCents: 80_000, dueDate: dia(10), accountId: banco.id });

    const f = await fluxo();

    expect(f.from).toBe(HOJE);
    expect(f.to).toBe(dia(29));
    expect(f.granularity).toBe('day');
    expect(f.periods).toHaveLength(30);
    // 100.000 de partida + 20.000 já recebidos.
    expect(f.openingBalanceCents).toBe(120_000);
    expect(f.periods[5]).toMatchObject({ start: dia(5), inCents: 30_000, balanceCents: 150_000 });
    expect(f.periods[10]).toMatchObject({ start: dia(10), outCents: 80_000, balanceCents: 70_000 });
    expect(f.totals).toEqual({ inCents: 30_000, outCents: 80_000, netCents: -50_000 });
    expect(f.closingBalanceCents).toBe(70_000);
    expect(f.lowestBalance).toEqual({ cents: 70_000, date: dia(10) });
    expect(f.firstNegativeDate).toBeNull();
  });

  it('conta o SALDO em aberto de cada título, não o valor original; cancelado não entra', async () => {
    titulo({ direction: 'in', amountCents: 10_000, settledCents: 4_000, dueDate: dia(2) });
    titulo({ direction: 'in', amountCents: 50_000, dueDate: dia(2), cancelled: true });

    const f = await fluxo();
    expect(f.periods[2].inCents).toBe(6_000);
    expect(f.periods[2].count).toBe(1);
  });

  it('"tenho caixa para pagar o fornecedor dia 20?" — o primeiro dia negativo sai pronto', async () => {
    createAccount(companyId, { name: 'Banco', openingBalanceCents: 50_000 });
    titulo({ direction: 'out', amountCents: 30_000, dueDate: dia(7), description: 'Aluguel' });
    titulo({ direction: 'out', amountCents: 40_000, dueDate: dia(19), description: 'Fornecedor' });
    titulo({ direction: 'in', amountCents: 25_000, dueDate: dia(25) });

    const f = await fluxo();
    expect(f.firstNegativeDate).toBe(dia(19));
    expect(f.lowestBalance).toEqual({ cents: -20_000, date: dia(19) });
    expect(f.closingBalanceCents).toBe(5_000);
  });

  it('vencidos: por padrão conta a DÍVIDA vencida hoje e não o recebível atrasado', async () => {
    createAccount(companyId, { name: 'Banco', openingBalanceCents: 10_000 });
    titulo({ direction: 'out', amountCents: 3_000, dueDate: dia(-10) });
    titulo({ direction: 'in', amountCents: 8_000, dueDate: dia(-40) });

    const padrao = await fluxo();
    expect(padrao.overdue).toMatchObject({ inCents: 8_000, outCents: 3_000, count: 2, countedOutCents: 3_000, countedInCents: 0 });
    expect(padrao.closingBalanceCents).toBe(7_000);
    expect(padrao.caveats.join(' ')).toContain('recebível atrasado não é dinheiro garantido');

    const ambos = await fluxo('overdue=both');
    expect(ambos.closingBalanceCents).toBe(15_000);
    const nenhum = await fluxo('overdue=none');
    expect(nenhum.closingBalanceCents).toBe(10_000);
  });

  it('60 e 90 dias viram semanas; o horizonte é parâmetro', async () => {
    titulo({ direction: 'in', amountCents: 1_000, dueDate: dia(0) });
    titulo({ direction: 'in', amountCents: 2_000, dueDate: dia(6) });
    titulo({ direction: 'in', amountCents: 4_000, dueDate: dia(7) });
    titulo({ direction: 'out', amountCents: 500, dueDate: dia(89) });

    const f = await fluxo('days=90');
    expect(f.granularity).toBe('week');
    expect(f.to).toBe(dia(89));
    expect(f.periods).toHaveLength(13);
    expect(f.periods[0]).toMatchObject({ start: dia(0), end: dia(6), inCents: 3_000 });
    expect(f.periods[1]).toMatchObject({ start: dia(7), inCents: 4_000 });
    expect(f.periods[12]).toMatchObject({ end: dia(89), outCents: 500 });

    const diario = await fluxo('days=60&granularity=day');
    expect(diario.periods).toHaveLength(60);
  });

  it('o que fica de fora é dito: sem vencimento, depois do horizonte, dinheiro sem conta', async () => {
    createAccount(companyId, { name: 'Banco', openingBalanceCents: 0 });
    titulo({ direction: 'in', amountCents: 9_000, dueDate: null });
    titulo({ direction: 'out', amountCents: 1_000, dueDate: dia(45) });
    titulo({ direction: 'in', amountCents: 7_000, settledCents: 7_000, dueDate: dia(-1), accountId: null });

    const f = await fluxo();
    expect(f.noDueDate).toMatchObject({ count: 1, inCents: 9_000 });
    expect(f.beyond.count).toBe(1);
    expect(f.settledWithoutAccountCents).toBe(7_000);
    const ressalvas = f.caveats.join(' ');
    expect(ressalvas).toContain('sem vencimento');
    expect(ressalvas).toContain('sem conta definida');
  });

  it('por conta: saldo daquela conta, títulos daquela conta, e o que não diz conta é nomeado', async () => {
    const banco = createAccount(companyId, { name: 'Banco', openingBalanceCents: 10_000 });
    const caixinha = createAccount(companyId, { name: 'Caixinha', kind: 'caixinha', openingBalanceCents: 500 });
    titulo({ direction: 'in', amountCents: 2_000, dueDate: dia(1), accountId: banco.id });
    titulo({ direction: 'in', amountCents: 3_000, dueDate: dia(1), accountId: caixinha.id });
    titulo({ direction: 'out', amountCents: 4_000, dueDate: dia(1), accountId: null });

    const f = await fluxo(`accountId=${banco.id}`);
    expect(f.openingBalanceCents).toBe(10_000);
    expect(f.totals.inCents).toBe(2_000);
    expect(f.totals.outCents).toBe(0);
    expect(f.withoutAccount?.count).toBe(1);

    const todas = await fluxo();
    expect(todas.openingBalanceCents).toBe(10_500);
    expect(todas.totals).toMatchObject({ inCents: 5_000, outCents: 4_000 });
  });

  it('conta de outra operação é 404; gerente da vizinha não enxerga os títulos daqui', async () => {
    const banco = createAccount(companyId, { name: 'Banco', openingBalanceCents: 99_000 });
    titulo({ direction: 'in', amountCents: 1_000, dueDate: dia(1) });

    const vizinha = await loginForTest(app, {
      userId: 'gerente-vizinha-fluxo',
      companyId: 'loja-vizinha-fluxo',
      profileCodes: ['gerente_loja'],
    });
    const authVizinha = { Authorization: `Bearer ${vizinha.body.accessToken}` };

    const alheia = await request(app).get(`/api/v1/core/finance/cash-flow?accountId=${banco.id}`).set(authVizinha);
    expect(alheia.status).toBe(404);
    const dela = await request(app).get('/api/v1/core/finance/cash-flow').set(authVizinha);
    expect(dela.body.totals.inCents).toBe(0);
    expect(dela.body.openingBalanceCents).toBe(0);
  });

  it('só a gerência vê — o caixa não lê saldo projetado das contas', async () => {
    const caixa = await loginForTest(app, { userId: 'caixa-fluxo', companyId, profileCodes: ['operador_caixa_loja'] });
    const res = await request(app)
      .get('/api/v1/core/finance/cash-flow')
      .set({ Authorization: `Bearer ${caixa.body.accessToken}` });
    expect(res.status).toBe(403);
  });

  it('entrada inválida é recusada com a frase certa', async () => {
    const data = await request(app).get('/api/v1/core/finance/cash-flow?to=20-09-2026').set(auth);
    expect(data.status).toBe(400);
    const longo = await request(app).get('/api/v1/core/finance/cash-flow?days=400').set(auth);
    expect(longo.status).toBe(400);
    const passado = await fluxo(`from=${dia(-10)}&to=${dia(5)}`);
    expect(passado.from).toBe(HOJE);
    expect(passado.caveats.join(' ')).toContain('A projeção começa hoje');
  });
});
