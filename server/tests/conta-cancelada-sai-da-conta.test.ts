/**
 * UM CRITÉRIO SÓ PARA "EM ABERTO" — nos três lugares que respondem isso.
 *
 * ============================================================================
 * O DEFEITO
 * ============================================================================
 *
 * Cancelar a venda cancela as linhas do financeiro: `SalesService` grava
 * `status = 'cancelled'` E `cancelled_at`, nas duas direções, e ainda derruba a
 * devolução da mesma venda. Essa parte está certa.
 *
 * O que estava errado é a LEITURA. Três telas respondiam "quanto está em
 * aberto" com três critérios diferentes:
 *
 *   - `FinanceService.listEntries` e `summarize`: `settled_cents < amount_cents`
 *     — **sem olhar o cancelamento**;
 *   - o painel: `status = 'open'`;
 *   - o DRE: `cancelled_at IS NULL`.
 *
 * Na prática: a venda é cancelada, e a conta a receber dela continua na lista
 * de Contas e no total de "em aberto". O cobrador liga para o cliente e leva
 * 409 ao tentar baixar — porque `settleEntry` recusa lançamento cancelado, e
 * está certo em recusar. O número mentia; a operação, não.
 *
 * ============================================================================
 * QUAL DOS TRÊS CRITÉRIOS É O CERTO
 * ============================================================================
 *
 * `cancelled_at IS NULL`, e o próprio esquema já explicava por quê:
 *
 *     "O status é DERIVADO: aplicarStatus o recalcula a partir do saldo a cada
 *      baixa e a cada estorno. (...) Carimbo de data não se recalcula: quem
 *      cancelou, cancelou."
 *
 * O DRE já usava o certo. Este arquivo leva o mesmo critério aos outros dois e
 * cobra que os três números batam.
 */
process.env.TZ = 'UTC';

import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { listEntries, summarize, settleEntry } from '../src/services/core/FinanceService.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();

let auth: { Authorization: string };
let companyId: string;

beforeEach(async () => {
  resetDbForTests();
  const res = await loginForTest(app, {
    userId: 'gerente-contas',
    companyId: 'loja-contas',
    profileCodes: ['gerente_loja'],
  });
  auth = { Authorization: `Bearer ${res.body.accessToken}` };
  companyId = res.body.company.id;
});

/** Uma conta a receber, com o vencimento e o cancelamento que se quiser. */
function conta(o: {
  amountCents: number;
  direction?: 'in' | 'out';
  dueDate?: string;
  cancelled?: boolean;
  settledCents?: number;
}): string {
  const id = randomUUID();
  const agora = new Date().toISOString();
  const cancelado = o.cancelled ? agora : null;
  const liquidado = o.settledCents ?? 0;
  getConnection()
    .prepare(
      `INSERT INTO core_finance_entries
         (id, company_id, direction, amount_cents, status, settled_cents, due_date,
          description, origin_type, origin_id, cancelled_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?)`,
    )
    .run(
      id,
      companyId,
      o.direction ?? 'in',
      o.amountCents,
      o.cancelled ? 'cancelled' : liquidado >= o.amountCents ? 'settled' : 'open',
      liquidado,
      o.dueDate ?? '2026-08-31',
      'Parcela de venda',
      randomUUID(),
      cancelado,
      agora,
    );
  return id;
}

/** O total que o PAINEL mostra como "a receber". */
async function aReceberNoPainel(): Promise<number> {
  const res = await request(app).get('/api/v1/core/dashboard').set(auth);
  expect(res.status).toBe(200);
  return res.body.openReceivablesCents as number;
}

// ============================================================================

describe('a conta de uma venda cancelada some da cobrança', () => {
  it('não aparece na lista de Contas', () => {
    conta({ amountCents: 10_000 });
    conta({ amountCents: 25_000, cancelled: true });

    const abertas = listEntries(companyId, { direction: 'in', situation: 'open' });

    expect(abertas.map((e) => e.amountCents)).toEqual([10_000]);
  });

  it('nem na lista sem filtro de situação — cancelada não é "todas"', () => {
    conta({ amountCents: 10_000 });
    conta({ amountCents: 25_000, cancelled: true });

    /*
      "Todas" quer dizer todas as contas — abertas e quitadas. Uma conta
      cancelada não é uma conta em outro estado: é um fato que o sistema diz que
      não aconteceu. Deixá-la aqui é oferecê-la para baixa numa tela onde o
      operador não tem como saber que ela vai dar 409.
    */
    expect(listEntries(companyId, { direction: 'in' })).toHaveLength(1);
  });

  it('nem no total de "em aberto"', () => {
    conta({ amountCents: 10_000 });
    conta({ amountCents: 25_000, cancelled: true });

    expect(summarize(companyId, 'in').openCents).toBe(10_000);
  });

  it('nem no total de vencidas', () => {
    conta({ amountCents: 10_000, dueDate: '2020-01-01' });
    conta({ amountCents: 25_000, dueDate: '2020-01-01', cancelled: true });

    expect(summarize(companyId, 'in').overdueCents).toBe(10_000);
  });

  it('nem na contagem, nem no total já recebido', () => {
    conta({ amountCents: 10_000, settledCents: 10_000 });
    // Cancelada DEPOIS de recebida: o dinheiro entrou e foi devolvido por
    // fora. Contar isso como recebido infla o realizado do mês.
    conta({ amountCents: 25_000, settledCents: 25_000, cancelled: true });

    const resumo = summarize(companyId, 'in');
    expect([resumo.count, resumo.settledCents]).toEqual([1, 10_000]);
  });

  it('nem no painel', async () => {
    conta({ amountCents: 10_000 });
    conta({ amountCents: 25_000, cancelled: true });

    expect(await aReceberNoPainel()).toBe(10_000);
  });
});

// ============================================================================

describe('os três lugares contam o mesmo', () => {
  /**
   * O cenário que fazia os três divergirem, montado inteiro: uma conta viva,
   * uma cancelada, e uma cancelada cujo `status` foi devolvido para 'open' por
   * uma baixa lançada depois — que é exatamente o caminho que o comentário do
   * esquema descreve.
   */
  it('lista, resumo e painel dão o mesmo número', async () => {
    conta({ amountCents: 10_000 });
    conta({ amountCents: 25_000, cancelled: true });

    // A armadilha do status derivado, gravada à mão porque o serviço (com
    // razão) não deixa mais chegar aqui: linha cancelada com status 'open'.
    const id = conta({ amountCents: 40_000, cancelled: true });
    getConnection().prepare("UPDATE core_finance_entries SET status = 'open' WHERE id = ?").run(id);

    const daLista = listEntries(companyId, { direction: 'in', situation: 'open' }).reduce(
      (soma, e) => soma + e.balanceCents,
      0,
    );
    const doResumo = summarize(companyId, 'in').openCents;
    const doPainel = await aReceberNoPainel();

    expect([daLista, doResumo, doPainel]).toEqual([10_000, 10_000, 10_000]);
  });

  it('o critério é o carimbo, e não o status — porque o status volta atrás', () => {
    /*
      Esta é a linha que derrubava o critério `status = 'open'` do painel: ela
      está cancelada e o status diz o contrário. Só o carimbo sobrevive à
      recontagem, e é por isso que ele é o critério.
    */
    const id = conta({ amountCents: 40_000, cancelled: true });
    getConnection().prepare("UPDATE core_finance_entries SET status = 'open' WHERE id = ?").run(id);

    expect(summarize(companyId, 'in').openCents).toBe(0);
    expect(listEntries(companyId, { direction: 'in' })).toHaveLength(0);
  });
});

// ============================================================================

describe('a operação continua recusando o que o número escondia', () => {
  it('dar baixa em conta cancelada segue sendo 409', () => {
    const id = conta({ amountCents: 25_000, cancelled: true });

    expect(() =>
      settleEntry({ companyId, entryId: id, amountCents: 25_000, method: 'dinheiro' }),
    ).toThrow(/cancelado/i);
  });

  it('a conta a PAGAR cancelada também sai — o fornecedor não é cobrado', () => {
    conta({ amountCents: 7_000, direction: 'out' });
    conta({ amountCents: 90_000, direction: 'out', cancelled: true });

    expect(summarize(companyId, 'out').openCents).toBe(7_000);
    expect(listEntries(companyId, { direction: 'out' })).toHaveLength(1);
  });
});
