/**
 * COMISSÃO É O ÚNICO PONTO EM QUE APURAÇÃO VIRA CONTA A PAGAR.
 *
 * ============================================================================
 * OS DOIS DEFEITOS
 * ============================================================================
 *
 * **1. O fechamento eram três escritas soltas.**
 *
 * `fecharPeriodo` cria a conta a pagar, grava o fechamento e marca as linhas
 * como fechadas — três instruções, nenhuma transação em volta. Uma falha no
 * meio deixa a conta a pagar ÓRFÃ (dinheiro a pagar sem fechamento que o
 * explique) **e** as linhas ainda abertas — de modo que o próximo fechamento
 * paga o mesmo período outra vez.
 *
 * `withTransaction` é reentrante (usa SAVEPOINT quando já há transação aberta),
 * então envolver o bloco inteiro não conflita com o `createEntry` de dentro.
 *
 * **2. A devolução em duas etapas deixava comissão residual.**
 *
 * O estorno aplicava a proporção devolvida sobre o SALDO VIVO da comissão, e
 * não sobre a comissão ORIGINAL. Devolvendo metade duas vezes:
 *
 *     venda R$ 1.000, comissão 10% = R$ 100
 *     1ª devolução de R$ 500 → 50% de 100 = 50   (saldo: 50)
 *     2ª devolução de R$ 500 → 50% de  50 = 25   (saldo: 25)
 *
 * A venda inteira voltou e o vendedor continua com R$ 25 a receber sobre ela.
 * Em três etapas sobra mais; em cinco, mais ainda.
 *
 * A conta certa é sobre o ACUMULADO: quanto já voltou da venda, contra a
 * comissão original, menos o que já foi estornado. Assim ela se corrige
 * sozinha, inclusive no arredondamento.
 */
process.env.TZ = 'UTC';

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';

import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { getConnection } from '../src/db/sqlite.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import {
  estornarComissaoDaDevolucao,
  estornarComissaoDaVenda,
  fecharPeriodo,
  registrarComissaoDaVenda,
  createGroup,
  setMemberGroup,
  setTier,
} from '../src/services/core/CommissionService.js';
import { listEntries } from '../src/services/core/FinanceService.js';

let companyId: string;
let vendedor: string;

const HOJE = new Date().toISOString().slice(0, 10);

beforeEach(() => {
  resetDbForTests();
  ensureCoreSchema();
  companyId = upsertCompany({
    slug: 'loja-comissao',
    legalName: 'Loja Comissão Ltda',
    tradeName: 'Loja Comissão',
  });

  vendedor = randomUUID();
  const agora = new Date().toISOString();
  getConnection()
    .prepare(
      `INSERT INTO core_users (id, login, display_name, password_hash, active, created_at, updated_at)
       VALUES (?, ?, 'Vendedor', 'x', 1, ?, ?)`,
    )
    .run(vendedor, `v-${vendedor}`, agora, agora);

  // Dez por cento, faixa única.
  const grupo = createGroup(companyId, 'Balcão');
  setTier(companyId, grupo.id, 0, 1_000);
  setMemberGroup(companyId, vendedor, grupo.id);
});

/** Uma venda comissionada de R$ 1.000,00. */
function vendaDeMil(): string {
  const saleId = randomUUID();
  const numero =
    Number(
      (
        getConnection()
          .prepare('SELECT COALESCE(MAX(number), 0) AS n FROM core_sales WHERE company_id = ?')
          .get(companyId) as { n: number }
      ).n,
    ) + 1;
  getConnection()
    .prepare(
      `INSERT INTO core_sales
         (id, company_id, number, status, subtotal_cents, discount_cents, total_cents,
          change_cents, seller_id, idempotency_key, created_at)
       VALUES (?, ?, ?, 'completed', 100000, 0, 100000, 0, ?, ?, ?)`,
    )
    .run(saleId, companyId, numero, vendedor, randomUUID(), new Date().toISOString());

  registrarComissaoDaVenda({
    companyId,
    sellerId: vendedor,
    saleId,
    baseCents: 100_000,
    competenceDate: HOJE,
  });
  return saleId;
}

/** O que ainda está vivo de comissão daquela venda. */
function saldoDaVenda(saleId: string): number {
  const r = getConnection()
    .prepare(
      `SELECT COALESCE(SUM(amount_cents), 0) AS total
         FROM core_commission_entries WHERE company_id = ? AND sale_id = ?`,
    )
    .get(companyId, saleId) as { total: number };
  return Number(r.total);
}

// ============================================================================

describe('a devolução em etapas não deixa resíduo', () => {
  it('a venda inteira devolvida em UMA etapa zera a comissão', () => {
    const saleId = vendaDeMil();
    expect(saldoDaVenda(saleId)).toBe(10_000);

    registrarDevolucao(saleId, 100_000);

    expect(saldoDaVenda(saleId)).toBe(0);
  });

  it('a venda inteira devolvida em DUAS etapas também zera', () => {
    const saleId = vendaDeMil();

    registrarDevolucao(saleId, 50_000);
    expect(saldoDaVenda(saleId)).toBe(5_000);

    registrarDevolucao(saleId, 50_000);

    // O defeito deixava R$ 25,00 aqui: metade do saldo VIVO, não da original.
    expect(saldoDaVenda(saleId)).toBe(0);
  });

  it('e em QUATRO etapas de um quarto', () => {
    const saleId = vendaDeMil();
    for (let i = 0; i < 4; i += 1) registrarDevolucao(saleId, 25_000);
    expect(saldoDaVenda(saleId)).toBe(0);
  });

  it('devolução parcial deixa exatamente a proporção que sobrou', () => {
    const saleId = vendaDeMil();
    registrarDevolucao(saleId, 30_000);
    // 30% de R$ 1.000 voltou: sobram 70% de R$ 100,00.
    expect(saldoDaVenda(saleId)).toBe(7_000);
  });

  it('o centavo do arredondamento não vira resíduo permanente', () => {
    /*
      R$ 333,33 de R$ 1.000,00 é 33,333%: o estorno de cada etapa arredonda.
      Como a conta é sobre o ACUMULADO menos o já estornado, o arredondamento
      de uma etapa é corrigido na seguinte, em vez de somar.
    */
    const saleId = vendaDeMil();
    registrarDevolucao(saleId, 33_333);
    registrarDevolucao(saleId, 33_333);
    registrarDevolucao(saleId, 33_334);

    expect(saldoDaVenda(saleId)).toBe(0);
  });

  it('devolver mais do que a venda não gera comissão negativa', () => {
    const saleId = vendaDeMil();
    registrarDevolucao(saleId, 100_000);
    registrarDevolucao(saleId, 20_000);

    expect(saldoDaVenda(saleId)).toBe(0);
  });
});

/**
 * Uma devolução como `SaleReturnService` a produz: grava o documento e chama o
 * estorno com o acumulado que o serviço enxerga.
 */
function registrarDevolucao(saleId: string, valorCents: number): string {
  const returnId = randomUUID();
  const agora = new Date().toISOString();
  const numero =
    Number(
      (
        getConnection()
          .prepare(
            'SELECT COALESCE(MAX(number), 0) AS n FROM core_sale_returns WHERE company_id = ?',
          )
          .get(companyId) as { n: number }
      ).n,
    ) + 1;
  getConnection()
    .prepare(
      `INSERT INTO core_sale_returns
         (id, company_id, sale_id, number, reason, total_cents, refund_method, created_at)
       VALUES (?, ?, ?, ?, 'Arrependimento', ?, 'dinheiro', ?)`,
    )
    .run(returnId, companyId, saleId, numero, valorCents, agora);

  estornarComissaoDaDevolucao({
    companyId,
    saleId,
    returnId,
    devolvidoCents: valorCents,
    subtotalCents: 100_000,
  });
  return returnId;
}

// ============================================================================

describe('o cancelamento depois da devolução parcial não tira demais', () => {
  it('cancelar leva só o que sobrou', () => {
    const saleId = vendaDeMil();
    registrarDevolucao(saleId, 40_000);
    expect(saldoDaVenda(saleId)).toBe(6_000);

    estornarComissaoDaVenda({ companyId, saleId });

    expect(saldoDaVenda(saleId)).toBe(0);
  });
});

// ============================================================================

describe('o fechamento é um ato só', () => {
  it('conta a pagar, fechamento e linhas marcadas andam juntos', () => {
    vendaDeMil();

    const r = fecharPeriodo({ companyId, sellerId: vendedor, from: HOJE, to: HOJE });

    expect(r.totalCents).toBe(10_000);
    expect(r.financeEntryId).toBeTruthy();

    const fechadas = getConnection()
      .prepare(
        `SELECT COUNT(*) AS n FROM core_commission_entries
          WHERE company_id = ? AND status = 'fechado' AND closing_id = ?`,
      )
      .get(companyId, r.closingId) as { n: number };
    expect(fechadas.n).toBe(1);
  });

  it('se a conta a pagar falhar, NADA fica de pé', () => {
    /*
      O modo de falha que a transação existe para impedir: a conta a pagar é
      criada, e a instrução seguinte estoura. Sem transação, sobra dinheiro a
      pagar sem fechamento que o explique E as linhas continuam abertas — o
      próximo fechamento paga o mesmo período de novo.

      A falha é provocada apagando a tabela de fechamentos: o INSERT do meio
      falha, e o que já foi escrito tem de voltar atrás.
    */
    vendaDeMil();
    /*
      A falha é injetada por GATILHO, e não apagando a tabela: apagar quebra o
      banco do arquivo inteiro e o teste seguinte morre por tabela ausente — o
      guarda derrubando o vizinho. O gatilho vale só nesta conexão, some com o
      próximo `resetDbForTests`, e reproduz exatamente o que se quer: a conta a
      pagar já criada e a instrução seguinte estourando.
    */
    getConnection().exec(
      `CREATE TRIGGER trava_fechamento BEFORE INSERT ON core_commission_closings
         BEGIN SELECT RAISE(ABORT, 'falha proposital'); END;`,
    );

    expect(() => fecharPeriodo({ companyId, sellerId: vendedor, from: HOJE, to: HOJE })).toThrow();
    getConnection().exec('DROP TRIGGER trava_fechamento');

    // A conta a pagar da comissão não pode ter sobrado.
    const contas = listEntries(companyId, { direction: 'out' }).filter((e) =>
      e.description.startsWith('Comissão'),
    );
    expect(contas).toEqual([]);

    // E as linhas continuam ABERTAS, para o fechamento seguinte pegá-las.
    const abertas = getConnection()
      .prepare(
        `SELECT COUNT(*) AS n FROM core_commission_entries
          WHERE company_id = ? AND status = 'aberto'`,
      )
      .get(companyId) as { n: number };
    expect(abertas.n).toBe(1);
  });

  it('o mesmo período não fecha duas vezes', () => {
    vendaDeMil();
    fecharPeriodo({ companyId, sellerId: vendedor, from: HOJE, to: HOJE });

    expect(() => fecharPeriodo({ companyId, sellerId: vendedor, from: HOJE, to: HOJE })).toThrow(
      /já foi fechado/i,
    );
  });
});
