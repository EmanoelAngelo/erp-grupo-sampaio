/**
 * A VENDA DAS 21H30 É DO DIA EM QUE ELA ACONTECEU.
 *
 * ============================================================================
 * POR QUE UM ARQUIVO SÓ PARA ISTO
 * ============================================================================
 *
 * `calendario-da-loja.test.ts` prova que a REGRA está certa. Este prova que ela
 * chegou aos lugares onde o erro custa dinheiro — e são lugares diferentes, com
 * consultas diferentes, que erravam do mesmo jeito por motivos independentes:
 *
 *   - o PAINEL, que o gerente abre no fim do expediente;
 *   - o DRE, que vira base de apuração;
 *   - a LISTA DE VENDAS, onde se procura a venda de ontem;
 *   - a lista de DOCUMENTOS FISCAIS;
 *   - o PACOTE DO CONTADOR, onde a venda no mês errado é escrituração no mês
 *     errado.
 *
 * O cenário é sempre o mesmo, porque o defeito era sempre o mesmo: uma venda
 * gravada em `2026-09-01T00:30:00.000Z`, que é **21h30 do dia 31 de agosto em
 * Pelotas**. Antes desta rodada, todos os cinco a colocavam em setembro.
 *
 * ============================================================================
 * O FUSO DA MÁQUINA NÃO PODE DECIDIR NADA
 * ============================================================================
 *
 * Forçado para UTC antes de qualquer import, como no arquivo da regra: esta
 * máquina de desenvolvimento roda em America/Sao_Paulo, e sem isso o teste
 * acertaria por acidente aqui e falharia no servidor.
 */
process.env.TZ = 'UTC';

import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { incomeStatement } from '../src/services/core/IncomeStatementService.js';
import { listSales } from '../src/services/core/SalesService.js';
import { listFiscalDocuments } from '../src/services/core/FiscalDocumentService.js';
import { periodBounds, previaDoFechamento } from '../src/services/core/FiscalClosingService.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();

/** 21h30 de 31/08 em Pelotas. Em Greenwich já é dia 1º de setembro. */
const VENDA_DAS_21H30 = '2026-09-01T00:30:00.000Z';
const DIA_DA_LOJA = '2026-08-31';
const DIA_DE_GREENWICH = '2026-09-01';

let auth: { Authorization: string };
let companyId: string;

beforeEach(async () => {
  resetDbForTests();
  const res = await loginForTest(app, {
    userId: 'gerente-fuso',
    companyId: 'loja-fuso',
    profileCodes: ['gerente_loja'],
  });
  auth = { Authorization: `Bearer ${res.body.accessToken}` };
  companyId = res.body.company.id;
});

/** Uma venda concluída, com o carimbo exato que se quiser. */
function venda(totalCents: number, carimbo: string): string {
  const id = randomUUID();
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
          change_cents, idempotency_key, created_at)
       VALUES (?, ?, ?, 'completed', ?, 0, ?, 0, ?, ?)`,
    )
    .run(id, companyId, numero, totalCents, totalCents, randomUUID(), carimbo);
  return id;
}

// ============================================================================

describe('o painel do fim do expediente', () => {
  it('a venda das 21h30 aparece no dia 31, e não some do dia dele', async () => {
    venda(10_000, VENDA_DAS_21H30);

    const res = await request(app)
      .get(`/api/v1/core/dashboard?from=${DIA_DA_LOJA}&to=${DIA_DA_LOJA}`)
      .set(auth);

    expect(res.status).toBe(200);
    expect(res.body.revenueCents).toBe(10_000);
    expect(res.body.salesCount).toBe(1);
  });

  it('e NÃO aparece no dia seguinte', async () => {
    venda(10_000, VENDA_DAS_21H30);

    const res = await request(app)
      .get(`/api/v1/core/dashboard?from=${DIA_DE_GREENWICH}&to=${DIA_DE_GREENWICH}`)
      .set(auth);

    expect(res.body.revenueCents).toBe(0);
    expect(res.body.salesCount).toBe(0);
  });

  it('o gráfico por dia rotula a barra com o dia da loja', async () => {
    venda(10_000, VENDA_DAS_21H30);
    // E uma do meio da tarde, para a barra não ser a única.
    venda(2_500, '2026-08-31T17:00:00.000Z');

    const res = await request(app)
      .get(`/api/v1/core/dashboard?from=${DIA_DA_LOJA}&to=${DIA_DA_LOJA}`)
      .set(auth);

    const dias = (res.body.byDay as { day: string; revenue_cents: number }[]).map((d) => d.day);
    expect(dias).toEqual([DIA_DA_LOJA]);
    expect(res.body.revenueCents).toBe(12_500);
  });

  it('a primeira venda da manhã seguinte é do dia seguinte', async () => {
    // 06h00 de 1º de setembro em Pelotas: 09:00Z. Nenhuma ambiguidade.
    venda(4_000, '2026-09-01T09:00:00.000Z');

    const doDia31 = await request(app)
      .get(`/api/v1/core/dashboard?from=${DIA_DA_LOJA}&to=${DIA_DA_LOJA}`)
      .set(auth);
    const doDia1 = await request(app)
      .get(`/api/v1/core/dashboard?from=${DIA_DE_GREENWICH}&to=${DIA_DE_GREENWICH}`)
      .set(auth);

    expect([doDia31.body.revenueCents, doDia1.body.revenueCents]).toEqual([0, 4_000]);
  });
});

// ============================================================================

describe('o DRE de agosto', () => {
  it('conta a venda das 21h30 do dia 31', () => {
    venda(10_000, VENDA_DAS_21H30);

    const agosto = incomeStatement(companyId, '2026-08-01', '2026-08-31');
    const setembro = incomeStatement(companyId, '2026-09-01', '2026-09-30');

    expect([agosto.reconciliation.panelRevenueCents, setembro.reconciliation.panelRevenueCents]).toEqual([
      10_000,
      0,
    ]);
  });
});

// ============================================================================

describe('a lista de vendas', () => {
  it('traz a venda quando se filtra o dia 31', () => {
    venda(10_000, VENDA_DAS_21H30);

    const doDia31 = listSales(companyId, { from: DIA_DA_LOJA, to: DIA_DA_LOJA });
    const doDia1 = listSales(companyId, { from: DIA_DE_GREENWICH, to: DIA_DE_GREENWICH });

    expect([doDia31.length, doDia1.length]).toEqual([1, 0]);
  });

  it('o último dia do período não some — o defeito clássico do recorte', () => {
    // Meio-dia, longe de qualquer fronteira de fuso: aqui o que se prova é que
    // a ponta de cima é inclusiva, e não o fuso.
    venda(10_000, '2026-08-31T15:00:00.000Z');

    expect(listSales(companyId, { from: '2026-08-01', to: '2026-08-31' })).toHaveLength(1);
  });
});

// ============================================================================

describe('os documentos fiscais', () => {
  /** Uma nota autorizada com o carimbo escolhido. */
  function documento(carimbo: string): void {
    getConnection()
      .prepare(
        `INSERT INTO core_fiscal_documents
           (id, company_id, model, serie, number, access_key, environment, status,
            issued_at, created_at, updated_at)
         VALUES (?, ?, '65', 1, 1, ?, 'production', 'AUTHORIZED', ?, ?, ?)`,
      )
      .run(randomUUID(), companyId, '4'.repeat(44), carimbo, carimbo, carimbo);
  }

  it('a nota das 21h30 está na lista do dia 31', () => {
    documento(VENDA_DAS_21H30);

    expect(listFiscalDocuments(companyId, { from: DIA_DA_LOJA, to: DIA_DA_LOJA })).toHaveLength(1);
    expect(
      listFiscalDocuments(companyId, { from: DIA_DE_GREENWICH, to: DIA_DE_GREENWICH }),
    ).toHaveLength(0);
  });
});

// ============================================================================

describe('a promoção dura o dia que promete', () => {
  // Promoção por categoria exige categoria que exista (GAP-PRD-032/197): o
  // PromotionService recusa grafia que não está em produto nem em Categorias e
  // marcas. O que se mede aqui é a vigência, não o alvo — então o alvo existe.
  beforeEach(() => {
    const agora = new Date().toISOString();
    getConnection()
      .prepare(
        `INSERT INTO core_categories (id, company_id, name, parent_id, active, created_at, updated_at)
         VALUES (?, ?, 'Vestuário', NULL, 1, ?, ?)`,
      )
      .run(randomUUID(), companyId, agora, agora);
  });

  /**
   * O campo da tela é `<input type="date">`: manda '2026-12-31'. Quem convertia
   * era o navegador, com `new Date(...).toISOString()` — meia-noite de
   * Greenwich, que em Pelotas é 21h do dia 30.
   *
   * Resultado: a promoção de fim de ano morria às 21h do dia 30, com a campanha
   * ainda anunciada na vitrine e o preço voltando ao de tabela sozinho. Três
   * horas de venda do dia mais movimentado do ano, ao preço errado.
   */
  async function criarPromocao(startsAt?: string, endsAt?: string) {
    const res = await request(app)
      .post('/api/v1/core/promotions')
      .set(auth)
      .send({ category: 'Vestuário', percentOff: 20, startsAt, endsAt });
    // A vigência só se mede numa promoção que existe. Recusa aqui aparece com
    // as palavras do servidor, e não como leitura de linha que não foi gravada.
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res;
  }

  function vigencia(): { starts_at: string; ends_at: string | null } {
    return getConnection()
      .prepare('SELECT starts_at, ends_at FROM core_promotions WHERE company_id = ?')
      .get(companyId) as { starts_at: string; ends_at: string | null };
  }

  it('"válida até 31/12" vale até o último instante do dia 31', async () => {
    expect((await criarPromocao('2026-12-01', '2026-12-31')).status).toBe(201);

    const { ends_at: fim } = vigencia();
    // 23h30 do dia 31 em Pelotas — a hora da virada, com a loja cheia.
    expect('2027-01-01T02:30:00.000Z' <= String(fim)).toBe(true);
    // E o dia 1º já está fora.
    expect('2027-01-01T03:00:00.000Z' <= String(fim)).toBe(false);
  });

  it('"começa em 01/12" começa na virada do dia 1º, e não às 21h do dia 30', async () => {
    await criarPromocao('2026-12-01', '2026-12-31');

    const { starts_at: inicio } = vigencia();
    expect(inicio).toBe('2026-12-01T03:00:00.000Z');
    // Às 22h do dia 30 de novembro ela ainda não vale.
    expect('2026-12-01T01:00:00.000Z' >= inicio).toBe(false);
  });

  it('sem prazo continua sem prazo', async () => {
    await criarPromocao(undefined, undefined);
    expect(vigencia().ends_at).toBeNull();
  });

  it('quem manda instante completo continua mandando instante completo', async () => {
    // A API não deixou de aceitar o formato antigo: só parou de EXIGIR que a
    // tela fizesse a conversão.
    await criarPromocao('2026-12-01T10:00:00.000Z', '2026-12-31T20:00:00.000Z');
    expect(vigencia()).toEqual({
      starts_at: '2026-12-01T10:00:00.000Z',
      ends_at: '2026-12-31T20:00:00.000Z',
    });
  });
});

// ============================================================================

describe('o pacote do contador', () => {
  it('o mês de agosto vai até o último instante do dia 31 na loja', () => {
    const agosto = periodBounds('2026-08');
    expect(VENDA_DAS_21H30 >= agosto.inicio && VENDA_DAS_21H30 <= agosto.fim).toBe(true);
  });

  it('a nota das 21h30 do dia 31 aparece como matéria-prima de AGOSTO', () => {
    getConnection()
      .prepare(
        `INSERT INTO core_fiscal_documents
           (id, company_id, model, serie, number, access_key, environment, status,
            issued_at, created_at, updated_at)
         VALUES (?, ?, '55', 1, 1, ?, 'production', 'AUTHORIZED', ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        companyId,
        '5'.repeat(44),
        VENDA_DAS_21H30,
        VENDA_DAS_21H30,
        VENDA_DAS_21H30,
      );

    expect(previaDoFechamento(companyId, '2026-08').mesesComMateriaPrima).toEqual(['2026-08']);
  });
});
