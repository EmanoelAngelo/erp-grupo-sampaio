/**
 * O NÚMERO PRINCIPAL DA CONCILIAÇÃO — e as três formas de ele mentir.
 *
 * ============================================================================
 * O QUE ESTA TELA É
 * ============================================================================
 *
 * "O que o banco diz × o que o financeiro registrou". Ela não corrige nada:
 * relata a diferença. Por isso a diferença é o produto — e uma diferença errada
 * é pior que nenhuma tela, porque manda alguém procurar dinheiro que não sumiu.
 *
 * ============================================================================
 * OS TRÊS DEFEITOS
 * ============================================================================
 *
 * **1. O estorno somava duas vezes, com o sinal errado.**
 *
 * `reverseSettlement` faz duas coisas: carimba `reversed_at` na baixa original
 * e INSERE uma contrapartida de valor negativo, com `reverses_id` apontando
 * para ela. O filtro daqui era `reversed_at IS NULL`: tirava a original e
 * deixava a contrapartida. Um par baixa+estorno de R$ 500 somava **−R$ 500** no
 * lado do financeiro, em vez de zero — e a contrapartida ainda entrava na lista
 * como "baixado sem extrato", uma divergência que não existe.
 *
 * **2. A linha casada com uma baixa estornada sumia.**
 *
 * `if (!baixa) continue` — a linha do extrato cujo par saiu do conjunto era
 * simplesmente pulada. O banco tem a linha, o financeiro não tem mais a baixa,
 * e o relatório feito para achar exatamente isso ficava calado.
 *
 * **3. O último dia do período sumia de um lado só.**
 *
 * `occurred_at` é DATA de calendário e `settled_at` é INSTANTE. Os dois
 * recebiam o mesmo parâmetro, e '2026-08-31T14:00:00.000Z' <= '2026-08-31' é
 * falso: o extrato do dia 31 entrava e as baixas do dia 31 não. A diferença
 * aparecia como divergência, todo fim de período.
 */
process.env.TZ = 'UTC';

import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { getConnection } from '../src/db/sqlite.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import {
  createEntry,
  reverseSettlement,
  settleEntry,
} from '../src/services/core/FinanceService.js';
import {
  importStatement,
  matchLine,
  reconcileBank,
} from '../src/services/core/BankReconciliation.js';

let companyId: string;

/**
 * `settleEntry` e `reverseSettlement` carimbam `settled_at` com o relógio de
 * verdade. Sem relógio encenado, o PERIODO de agosto só abrigava as baixas
 * enquanto o calendário estivesse em agosto de 2026 — depois disso a baixa
 * caía fora da janela e o teste passava a medir a data de hoje, não a
 * conciliação. O relógio fica parado no meio do período.
 */
const AGORA_NO_PERIODO = '2026-08-15T12:00:00-03:00';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(AGORA_NO_PERIODO));
  resetDbForTests();
  ensureCoreSchema();
  companyId = upsertCompany({
    slug: 'loja-conciliacao',
    legalName: 'Loja Conciliação Ltda',
    tradeName: 'Loja Conciliação',
  });
});

afterEach(() => {
  vi.useRealTimers();
});

/** Uma conta a receber já lançada, pronta para baixa. */
function contaAReceber(amountCents: number, dueDate = '2026-08-15'): string {
  return createEntry({
    companyId,
    direction: 'in',
    amountCents,
    description: 'Parcela de venda',
    dueDate,
  }).id;
}

/** Uma linha no extrato importado. */
function linhaDoExtrato(amountCents: number, occurredAt = '2026-08-15'): string {
  importStatement({
    companyId,
    accountLabel: 'Banco de teste',
    lines: [{ occurredAt, description: 'Crédito', amountCents, externalId: randomUUID() }],
  });
  const linha = getConnection()
    .prepare(
      `SELECT id FROM core_bank_statement_lines
        WHERE company_id = ? ORDER BY rowid DESC LIMIT 1`,
    )
    .get(companyId) as { id: string };
  return linha.id;
}

/** A baixa mais recente de um lançamento. */
function ultimaBaixa(entryId: string): string {
  const r = getConnection()
    .prepare(
      `SELECT id FROM core_finance_settlements
        WHERE entry_id = ? AND reverses_id IS NULL ORDER BY rowid DESC LIMIT 1`,
    )
    .get(entryId) as { id: string };
  return r.id;
}

const PERIODO = { from: '2026-08-01', to: '2026-08-31' };

// ============================================================================

describe('o par baixa + estorno soma ZERO', () => {
  it('o total do financeiro não fica negativo', () => {
    const entryId = contaAReceber(50_000);
    settleEntry({ companyId, entryId, amountCents: 50_000, method: 'pix' });
    reverseSettlement({ companyId, settlementId: ultimaBaixa(entryId) });

    const r = reconcileBank({ companyId, ...PERIODO });

    // O defeito devolvia -50_000: tirava a original e deixava a contrapartida.
    expect(r.financeTotalCents).toBe(0);
  });

  it('e a contrapartida do estorno não vira divergência fantasma', () => {
    const entryId = contaAReceber(50_000);
    settleEntry({ companyId, entryId, amountCents: 50_000, method: 'pix' });
    reverseSettlement({ companyId, settlementId: ultimaBaixa(entryId) });

    const r = reconcileBank({ companyId, ...PERIODO });

    expect(r.divergences.filter((d) => d.kind === 'baixado_sem_extrato')).toEqual([]);
  });

  it('a baixa que NÃO foi estornada continua contando', () => {
    const viva = contaAReceber(30_000);
    settleEntry({ companyId, entryId: viva, amountCents: 30_000, method: 'pix' });

    const estornada = contaAReceber(50_000);
    settleEntry({ companyId, entryId: estornada, amountCents: 50_000, method: 'pix' });
    reverseSettlement({ companyId, settlementId: ultimaBaixa(estornada) });

    expect(reconcileBank({ companyId, ...PERIODO }).financeTotalCents).toBe(30_000);
  });
});

// ============================================================================

describe('a linha casada com baixa estornada não some', () => {
  it('ela volta como divergência, com o valor do banco', () => {
    const entryId = contaAReceber(50_000);
    settleEntry({ companyId, entryId, amountCents: 50_000, method: 'pix' });
    const baixaId = ultimaBaixa(entryId);
    const lineId = linhaDoExtrato(50_000);
    matchLine({ companyId, lineId, settlementId: baixaId });

    // O dinheiro voltou depois de conciliado — cheque devolvido, PIX
    // estornado, cobrança contestada. O extrato ainda tem o crédito.
    reverseSettlement({ companyId, settlementId: baixaId });

    const r = reconcileBank({ companyId, ...PERIODO });
    const dela = r.divergences.find((d) => d.lineId === lineId);

    expect(dela).toBeTruthy();
    expect([dela?.kind, dela?.bankCents, dela?.financeCents]).toEqual([
      'no_extrato_sem_baixa',
      50_000,
      null,
    ]);
  });

  it('e a conta do relatório fecha com essa diferença', () => {
    const entryId = contaAReceber(50_000);
    settleEntry({ companyId, entryId, amountCents: 50_000, method: 'pix' });
    const baixaId = ultimaBaixa(entryId);
    matchLine({ companyId, lineId: linhaDoExtrato(50_000), settlementId: baixaId });
    reverseSettlement({ companyId, settlementId: baixaId });

    const r = reconcileBank({ companyId, ...PERIODO });

    expect([r.bankTotalCents, r.financeTotalCents, r.differenceCents]).toEqual([
      50_000,
      0,
      50_000,
    ]);
  });

  it('sem estorno, a linha casada não é divergência nenhuma', () => {
    const entryId = contaAReceber(50_000);
    settleEntry({ companyId, entryId, amountCents: 50_000, method: 'pix' });
    matchLine({
      companyId,
      lineId: linhaDoExtrato(50_000),
      settlementId: ultimaBaixa(entryId),
    });

    const r = reconcileBank({ companyId, ...PERIODO });

    expect([r.divergences, r.matched, r.differenceCents]).toEqual([[], 1, 0]);
  });
});

// ============================================================================

describe('o último dia do período conta dos DOIS lados', () => {
  it('a baixa do dia 31 entra, mesmo tendo hora', () => {
    const entryId = contaAReceber(20_000, '2026-08-31');
    settleEntry({ companyId, entryId, amountCents: 20_000, method: 'pix' });
    // A baixa nasce com o carimbo de AGORA (dia 15, no relógio encenado);
    // o carimbo é empurrado para a tarde do dia 31: o que se prova aqui é
    // que instante <= data não corta mais.
    getConnection()
      .prepare("UPDATE core_finance_settlements SET settled_at = '2026-08-31T14:00:00.000Z'")
      .run();

    expect(reconcileBank({ companyId, ...PERIODO }).financeTotalCents).toBe(20_000);
  });

  it('a linha do extrato do dia 31 entra junto', () => {
    linhaDoExtrato(20_000, '2026-08-31');
    expect(reconcileBank({ companyId, ...PERIODO }).bankTotalCents).toBe(20_000);
  });

  it('e a baixa das 21h30 do dia 31 é do dia 31, não do dia 1º', () => {
    const entryId = contaAReceber(20_000, '2026-08-31');
    settleEntry({ companyId, entryId, amountCents: 20_000, method: 'pix' });
    // 21h30 em Pelotas: em Greenwich já é setembro.
    getConnection()
      .prepare("UPDATE core_finance_settlements SET settled_at = '2026-09-01T00:30:00.000Z'")
      .run();

    expect(reconcileBank({ companyId, ...PERIODO }).financeTotalCents).toBe(20_000);
    expect(reconcileBank({ companyId, from: '2026-09-01', to: '2026-09-30' }).financeTotalCents).toBe(
      0,
    );
  });
});
