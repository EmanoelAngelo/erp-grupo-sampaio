/**
 * ============================================================================
 * NENHUM RELATÓRIO HERDA O TETO DE QUEM ELE CONSULTA
 * ============================================================================
 *
 * ## O defeito, e por que ele é o mesmo de sempre
 *
 * A Central declara `TETO_DE_LINHAS = 5000` e detecta o corte com
 * `todas.length > TETO_DE_LINHAS`. A conta só é verdadeira se a consulta de
 * baixo devolver TUDO — ou pelo menos uma linha a mais que o teto, como
 * `movimentacoes` fazia com `limit: TETO_DE_LINHAS + 1`.
 *
 * Dois relatórios não faziam nem uma coisa nem outra: chamavam um serviço com
 * teto PRÓPRIO, menor, e ficavam com o dele.
 *
 *   - `validade`  → `listBatches`, cujo default é `LIMIT 500`;
 *   - `financeiro` → `listEntries`, com `LIMIT 500` cravado no SQL.
 *
 * O estrago não é a página curta: é a página curta se apresentando como o
 * todo. A resposta saía com `truncated: false`, o rodapé somava só as 500
 * linhas que sobraram, e o CSV — que circula fora do sistema, sem ninguém para
 * perguntar — exportava o recorte COMO SE FOSSE O TODO. É a mesma doença que
 * o cabeçalho de `ReportsService` descreve na lista de vendas: "205 viravam
 * 200 sem uma palavra".
 *
 * ## O que o conserto faz, e por que não é só somar um número
 *
 * Somar `limit` nos dois deixaria o TERCEIRO relatório repetir o defeito no
 * dia em que alguém plugasse outro serviço com `LIMIT` próprio. Então o teto
 * virou DECLARAÇÃO OBRIGATÓRIA: `ReportSpec.teto` é um campo exigido pelo
 * tipo, e relatório novo que o esqueça não compila. Ele tem duas formas e só
 * duas — `{ fonte: 'central' }` (a consulta não corta; quem corta é a Central)
 * e `{ fonte: 'propria', linhas: N }` (a consulta corta em N, e a Central
 * precisa saber). Esquecer não é uma opção disponível.
 *
 * E `truncagem` — a função pura que decide — passou a olhar as duas coisas: o
 * teto da Central E o da fonte. Fonte que devolva o próprio limite é relatada
 * como truncada mesmo abaixo de 5000, porque nesse ponto o sistema não sabe se
 * há mais; "cheguei ao limite do que consigo perguntar" e "acabou" são estados
 * diferentes, e a resposta passa a dizer qual dos dois é.
 *
 * ## Como este guarda falha (quebrando de propósito — conferido)
 *
 *   - tire `limit: TETO_DE_LINHAS + 1` da chamada de `listBatches` no
 *     relatório `validade`: o caso dos 501 lotes volta a ver 500 linhas com
 *     `truncated: false`;
 *   - faça o mesmo com `listEntries` em `financeiro`: idem, com os 501
 *     títulos;
 *   - devolva `truncagem` a `todas > TETO_DE_LINHAS`: os casos de unidade da
 *     fonte com teto próprio ficam vermelhos sem tocar em banco nenhum;
 *   - apague o campo `teto` de qualquer relatório do catálogo: o `tsc` do
 *     servidor recusa o arquivo (`Property 'teto' is missing`), que é o ponto
 *     do campo ser obrigatório.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { getConnection } from '../src/db/sqlite.js';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { loginForTest } from '../tests/helpers/auth.js';
import { TETO_DE_LINHAS, truncagem } from '../src/services/core/ReportsService.js';

const app = createApp();
const LOJA = 'loja-do-teto';
const BASE = '/api/v1/core/reports';

/**
 * UMA linha a mais que o teto que os dois serviços impunham.
 *
 * O número é 501 e não 5001 de propósito: o que se mede é o teto HERDADO, que
 * é 500. Criar cinco mil linhas para provar o mesmo fato custaria dez vezes o
 * tempo e não diria nada a mais — e o teto da própria Central tem caso de
 * unidade em `truncagem`, sem banco.
 */
const UM_A_MAIS_QUE_QUINHENTOS = 501;

let auth: { Authorization: string };

async function entrar(): Promise<void> {
  const res = await loginForTest(app, {
    userId: 'gerente-teto',
    companyId: LOJA,
    profileCodes: ['gerente_loja'],
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  auth = { Authorization: `Bearer ${res.body.accessToken as string}` };
}

interface Resultado {
  rows: Record<string, unknown>[];
  totals: Record<string, number>;
  truncated: boolean;
  rowCount: number;
}

async function relatorio(id: string, qs = ''): Promise<Resultado> {
  const res = await request(app).get(`${BASE}/${id}?${qs}`).set(auth);
  expect(res.status, `${id}: ${JSON.stringify(res.body)}`).toBe(200);
  return res.body as Resultado;
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  await entrar();
});

// ===========================================================================

describe('a decisão de truncar, sozinha — sem banco, sem rota', () => {
  it('fonte sem teto: só a Central corta, e ela DIZ quando corta', () => {
    expect(truncagem(10, { fonte: 'central' })).toEqual({ truncated: false, corte: TETO_DE_LINHAS });
    expect(truncagem(TETO_DE_LINHAS, { fonte: 'central' }).truncated).toBe(false);
    expect(truncagem(TETO_DE_LINHAS + 1, { fonte: 'central' }).truncated).toBe(true);
  });

  it('fonte COM teto próprio: bater no limite dela já é truncar', () => {
    /*
      É o caso que não existia. Com 500 linhas de uma fonte que devolve no
      máximo 500, o sistema NÃO SABE se há mais — e dizer `truncated: false`
      é afirmar que acabou. Dois estados diferentes com a mesma cara é o
      defeito que esta casa persegue desde "vazio ≠ não consegui perguntar".
    */
    expect(truncagem(499, { fonte: 'propria', linhas: 500 }).truncated).toBe(false);
    expect(truncagem(500, { fonte: 'propria', linhas: 500 }).truncated).toBe(true);
    expect(truncagem(500, { fonte: 'propria', linhas: 500 }).corte).toBe(500);
  });

  it('e o teto da Central continua mandando quando é ele o menor', () => {
    const grande = { fonte: 'propria', linhas: TETO_DE_LINHAS * 10 } as const;
    expect(truncagem(TETO_DE_LINHAS + 1, grande)).toEqual({
      truncated: true,
      corte: TETO_DE_LINHAS,
    });
  });
});

// ===========================================================================

describe('validade e lotes: 501 lotes no banco são 501 linhas no relatório', () => {
  /**
   * Lotes com saldo, inseridos direto: o que se mede é o TETO da consulta, e
   * quinhentas e uma chamadas HTTP mediriam a paciência do CI.
   */
  function encherDeLotes(quantos: number): string {
    const db = getConnection();
    const produto = randomUUID();
    const agora = new Date().toISOString();
    db.prepare(
      `INSERT INTO core_products (id, company_id, internal_code, name, price_cents, cost_cents,
                                  created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(produto, LOJA, 'LOTE-TETO', 'Iogurte de teto', 1_000, 400, agora, agora);

    const lote = db.prepare(
      `INSERT INTO core_product_batches (id, company_id, product_id, code, expires_on,
                                         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const movimento = db.prepare(
      `INSERT INTO core_stock_movements (id, company_id, product_id, movement_type, quantity,
                                         reference_type, reference_id, balance_after,
                                         batch_id, created_at)
       VALUES (?, ?, ?, 'in', 1, 'entrada', ?, 1, ?, ?)`,
    );
    for (let i = 0; i < quantos; i += 1) {
      const id = randomUUID();
      // A validade cresce com o índice para que a ordem FEFO seja estável.
      lote.run(id, LOJA, produto, `L-${String(i).padStart(4, '0')}`, '2030-01-01', agora, agora);
      movimento.run(randomUUID(), LOJA, produto, `ent-${id}`, id, agora);
    }
    return produto;
  }

  it('o relatório traz os 501, e não os 500 do serviço que ele consulta', async () => {
    encherDeLotes(UM_A_MAIS_QUE_QUINHENTOS);
    const r = await relatorio('validade');
    expect(
      r.rowCount,
      'o relatório herdou o LIMIT 500 de listBatches e chamou o recorte de "tudo"',
    ).toBe(UM_A_MAIS_QUE_QUINHENTOS);
    expect(r.rows).toHaveLength(UM_A_MAIS_QUE_QUINHENTOS);
    expect(r.truncated).toBe(false);
  });

  it('e o CSV leva as mesmas 501 linhas — o arquivo é o que circula por aí', async () => {
    encherDeLotes(UM_A_MAIS_QUE_QUINHENTOS);
    const res = await request(app).get(`${BASE}/validade?formato=csv`).set(auth);
    expect(res.status, res.text).toBe(200);
    // Cabeçalho (5 linhas: título, empresa, período, gerado em, ressalva),
    // linha em branco, cabeçalho de colunas, 501 linhas e o TOTAL.
    const linhas = res.text.split('\r\n').filter((l) => l.length > 0);
    expect(linhas.filter((l) => l.startsWith('L-'))).toHaveLength(UM_A_MAIS_QUE_QUINHENTOS);
  });
});

describe('títulos a pagar e a receber: 501 lançamentos são 501 linhas', () => {
  function encherDeTitulos(quantos: number): void {
    const db = getConnection();
    const agora = new Date().toISOString();
    const inserir = db.prepare(
      `INSERT INTO core_finance_entries (id, company_id, direction, amount_cents, status,
                                         due_date, description, origin_type, origin_id,
                                         created_at)
       VALUES (?, ?, 'in', 1000, 'open', '2026-06-15', ?, 'manual', ?, ?)`,
    );
    for (let i = 0; i < quantos; i += 1) {
      const id = randomUUID();
      inserir.run(id, LOJA, `Título ${String(i).padStart(4, '0')}`, id, agora);
    }
  }

  it('o relatório traz os 501, e não os 500 cravados no SQL do serviço', async () => {
    encherDeTitulos(UM_A_MAIS_QUE_QUINHENTOS);
    const r = await relatorio('financeiro', 'from=2026-06-01&to=2026-06-30');
    expect(
      r.rowCount,
      'o relatório herdou o LIMIT 500 de listEntries e chamou o recorte de "tudo"',
    ).toBe(UM_A_MAIS_QUE_QUINHENTOS);
    expect(r.truncated).toBe(false);
    // E o rodapé soma as 501, não as 500: era ele que mentia para baixo.
    expect(r.totals.amount_cents).toBe(UM_A_MAIS_QUE_QUINHENTOS * 1_000);
  });

  it('o lançamento CANCELADO continua fora — o corte não trouxe carona', async () => {
    /*
      A auditoria suspeitou que o relatório filtrasse cancelado DEPOIS do
      corte, mostrando bem menos que 500. Não é o caso: `listEntries` já
      exclui `cancelled_at IS NOT NULL` no WHERE, ANTES do LIMIT. O caso fica
      porque alargar o teto seria a hora exata de alguém "simplificar" o filtro
      para dentro do TypeScript e criar o defeito que não existia.
    */
    encherDeTitulos(3);
    getConnection()
      .prepare("UPDATE core_finance_entries SET cancelled_at = ? WHERE description LIKE '%0000'")
      .run(new Date().toISOString());
    const r = await relatorio('financeiro', 'from=2026-06-01&to=2026-06-30');
    expect(r.rowCount).toBe(2);
    expect(JSON.stringify(r.rows)).not.toContain('Título 0000');
  });
});
