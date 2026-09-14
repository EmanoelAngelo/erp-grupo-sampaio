/**
 * ============================================================================
 * O CUSTO DO QUE FOI VENDIDO NASCE NA VENDA — GAP-V28
 * ============================================================================
 *
 * ## O defeito, e por que ele não tinha conserto retroativo
 *
 * O DRE não tinha linha de CMV, e a recusa estava escrita em
 * `IncomeStatementService`: "`core_sale_items` não tem coluna de custo. O
 * custo do que foi vendido nunca é gravado no momento da venda, então não
 * existe de onde tirá-lo depois — o custo do cadastro de hoje não é o custo da
 * venda de março."
 *
 * A recusa estava CERTA. Somar `quantidade × custo do cadastro` sobre vendas
 * antigas devolve um número plausível e falso: o custo do produto muda a cada
 * nota de entrada, e a margem de março passaria a ser recalculada com o custo
 * de agosto — todo mês fechado mudaria de resultado sozinho. Isso é pior que
 * não ter CMV, porque tem cara de certo.
 *
 * O único conserto honesto é fotografar o custo NA HORA e passar a mostrar o
 * CMV das vendas NOVAS, dizendo quantas linhas do período ficaram de fora. É o
 * que este arquivo cobra, e o caso central é a MORDIDA:
 *
 *   vende-se a 100 com custo 60; DEPOIS o cadastro passa a custar 90; o CMV
 *   daquela venda tem de continuar 60.
 *
 * Sem o snapshot, esse caso devolve 90 — e é exatamente o que o sistema fazia
 * quando alguém tentava calcular margem lendo `core_products` (o que
 * `GroupInsights.marginWhereReliable` fazia até o GAP-PRD-086: agora o cartão
 * de margem do BI lê o mesmo snapshot, e `margem-do-bi-bate-com-o-dre` cobra).
 *
 * ## As três populações de linha, e por que cada uma tem contagem própria
 *
 * Depois deste conserto, uma linha de venda está num de três estados, e
 * misturá-los produziria o número decorativo que a recusa evitava:
 *
 *   1. `cost_cents > 0`  — custo fotografado. Entra no CMV.
 *   2. `cost_cents = 0`  — o produto foi vendido SEM custo no cadastro. Fica
 *      de fora do CMV (custo zero devolveria margem de 100%, o defeito que
 *      `marginWhereReliable` já nomeia) e é CONTADO.
 *   3. `cost_cents IS NULL` — venda anterior ao conserto, ou linha de serviço
 *      (mão de obra não sai de prateleira). Não tem custo e nunca terá; é
 *      contada à parte para que ninguém leia "CMV do mês" achando que ele
 *      cobre o mês inteiro.
 *
 * ## E o CMV NÃO entra no resultado do DRE
 *
 * Ele é EXIBIDO ao lado, e é decisão, não esquecimento: a compra da mercadoria
 * já entrou no DRE como DESPESA, no lançamento a pagar da nota de entrada
 * (`origin_type = 'nfe_entrada'`). Subtrair o CMV do resultado contaria a
 * mesma mercadoria duas vezes. Este arquivo cobra que `resultCents` continue
 * sendo receita − despesa, sem o CMV no meio.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
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
const SENHA = 'Cmv@DaVenda2026';

/** 15:00Z é meio-dia na loja (UTC-3): longe de qualquer borda de dia. */
const HOJE = '2026-06-10';
const MEIO_DIA = '2026-06-10T15:00:00.000Z';

let empresa: string;
let auth: { Authorization: string };

async function entrar(): Promise<void> {
  const login = 'GERENTE.CMV';
  await upsertUser({ login, displayName: login, password: SENHA });
  const userId = await upsertUser({ login, displayName: login, password: SENHA });
  linkUserToCompany(userId, empresa, 'gerente_loja', false);
  const res = await request(app)
    .post('/api/v1/auth/login')
    .send({ login, password: SENHA, companyId: empresa });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  auth = { Authorization: `Bearer ${res.body.accessToken}` };
}

beforeEach(async () => {
  resetDbForTests();
  empresa = upsertCompany({
    slug: 'conceito',
    legalName: 'Conceito Moda Feminina Ltda',
    tradeName: 'Conceito',
    kind: 'retail',
  });
  await entrar();
});

async function criarProduto(nome: string, precoCents: number, custoCents: number): Promise<string> {
  const res = await request(app)
    .post('/api/v1/core/products')
    .set(auth)
    .send({ name: nome, priceCents: precoCents, costCents: custoCents });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

async function carregar(productId: string, quantidade: number): Promise<void> {
  const res = await request(app).post('/api/v1/core/stock/movements').set(auth).send({
    productId,
    movementType: 'in',
    quantity: quantidade,
    referenceType: 'entrada',
    referenceId: `carga-${productId}-${randomUUID()}`,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
}

async function vender(
  itens: { productId: string; quantity: number }[],
  totalCents: number,
): Promise<string> {
  const res = await request(app)
    .post('/api/v1/core/sales')
    .set(auth)
    .set('Idempotency-Key', randomUUID())
    .send({ items: itens, payments: [{ method: 'dinheiro', amountCents: totalCents }] });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const venda = res.body.sale ?? res.body;
  expect(venda.total_cents).toBe(totalCents);
  return venda.id as string;
}

function carimbar(saleId: string): void {
  getConnection().prepare('UPDATE core_sales SET created_at = ? WHERE id = ?').run(MEIO_DIA, saleId);
}

async function dre() {
  const res = await request(app)
    .get(`/api/v1/core/finance/income-statement?from=${HOJE}&to=${HOJE}`)
    .set(auth);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as {
    resultCents: number;
    revenue: { totalCents: number };
    expense: { totalCents: number };
    cogs: {
      costCents: number;
      revenueCents: number;
      marginCents: number;
      marginPercent: number | null;
      itemsWithCost: number;
      itemsWithoutCost: number;
      itemsBeforeSnapshot: number;
    };
    caveats: string[];
  };
}

describe('a venda fotografa o custo do item', () => {
  it('grava o custo do cadastro na linha da venda — e é centavo inteiro', async () => {
    const produto = await criarProduto('Bicicleta Aro 29', 12_345, 6_000);
    await carregar(produto, 10);
    const venda = await vender([{ productId: produto, quantity: 2 }], 24_690);

    const linha = getConnection()
      .prepare('SELECT cost_cents, quantity FROM core_sale_items WHERE sale_id = ?')
      .get(venda) as { cost_cents: number | null; quantity: number };

    // O snapshot é o custo UNITÁRIO, o mesmo significado de
    // `core_products.cost_cents` de onde ele veio — e o mesmo de
    // `unit_price_cents` ao lado dele na linha.
    expect(linha.cost_cents).toBe(6_000);
    expect(linha.quantity).toBe(2);
    expect(Number.isInteger(linha.cost_cents)).toBe(true);
  });

  it('A MORDIDA: mudar o custo do cadastro DEPOIS não reescreve o CMV da venda', async () => {
    /*
      É o caso inteiro deste gap. Sem o snapshot, o CMV da venda de hoje
      passaria a ser calculado com o custo de amanhã: o mês fechado mudaria de
      resultado sozinho a cada nota de entrada que altera o custo médio.
    */
    const produto = await criarProduto('Bicicleta Aro 29', 10_000, 6_000);
    await carregar(produto, 10);
    const venda = await vender([{ productId: produto, quantity: 1 }], 10_000);
    carimbar(venda);

    const antes = await dre();
    expect(antes.cogs.costCents).toBe(6_000);

    // O custo do cadastro sobe — nota de entrada mais cara, reprecificação,
    // qualquer coisa. O passado não muda por isso.
    const alterou = await request(app)
      .put(`/api/v1/core/products/${produto}`)
      .set(auth)
      .send({ costCents: 9_000 });
    expect(alterou.status, JSON.stringify(alterou.body)).toBe(200);

    const depois = await dre();
    expect(depois.cogs.costCents).toBe(6_000);
    expect(depois.cogs.revenueCents).toBe(10_000);
    expect(depois.cogs.marginCents).toBe(4_000);
    expect(depois.cogs.marginPercent).toBe(40);
  });
});

describe('o DRE mostra CMV e margem — e diz o que ficou de fora', () => {
  it('produto SEM custo no cadastro não entra no CMV, e é contado', async () => {
    /*
      Custo zero devolveria margem de 100%: um número bonito que faz a loja
      parecer lucrativa onde ninguém sabe o que pagou. A linha fica fora e a
      resposta DIZ quantas ficaram — a mesma régua de `marginWhereReliable`.
    */
    const comCusto = await criarProduto('Bicicleta Aro 29', 10_000, 6_000);
    const semCusto = await criarProduto('Boné da loja', 5_000, 0);
    await carregar(comCusto, 10);
    await carregar(semCusto, 10);

    const v1 = await vender([{ productId: comCusto, quantity: 1 }], 10_000);
    const v2 = await vender([{ productId: semCusto, quantity: 1 }], 5_000);
    carimbar(v1);
    carimbar(v2);

    const r = await dre();
    expect(r.cogs.costCents).toBe(6_000);
    expect(r.cogs.revenueCents).toBe(10_000);
    expect(r.cogs.itemsWithCost).toBe(1);
    expect(r.cogs.itemsWithoutCost).toBe(1);
    expect(r.cogs.marginPercent).toBe(40);
    expect(r.caveats.join(' ')).toContain('sem custo cadastrado');
  });

  it('venda anterior ao conserto não vira CMV zero: é contada à parte e ressalvada', async () => {
    /*
      A prova de que o passado é NOMEADO em vez de inventado. A linha antiga é
      encenada apagando o snapshot — que é exatamente o retrato de toda venda
      feita antes desta rodada.
    */
    const produto = await criarProduto('Bicicleta Aro 29', 10_000, 6_000);
    await carregar(produto, 10);
    const nova = await vender([{ productId: produto, quantity: 1 }], 10_000);
    const antiga = await vender([{ productId: produto, quantity: 1 }], 10_000);
    carimbar(nova);
    carimbar(antiga);
    getConnection()
      .prepare('UPDATE core_sale_items SET cost_cents = NULL WHERE sale_id = ?')
      .run(antiga);

    const r = await dre();
    expect(r.cogs.costCents).toBe(6_000);
    expect(r.cogs.itemsWithCost).toBe(1);
    expect(r.cogs.itemsBeforeSnapshot).toBe(1);
    const ressalva = r.caveats.join(' ');
    expect(ressalva).toContain('sem custo gravado');
    // E a frase antiga — a recusa — não pode continuar impressa: ela ficou
    // falsa no minuto em que o snapshot passou a existir.
    expect(ressalva).not.toContain('Não há CMV nem margem');
  });

  it('sem nenhuma linha com custo, a margem é NULA — e não zero', async () => {
    // Nulo é "não dá para saber"; zero seria "vendeu sem lucro". São
    // afirmações diferentes, e a segunda é mentira.
    const semCusto = await criarProduto('Boné da loja', 5_000, 0);
    await carregar(semCusto, 10);
    carimbar(await vender([{ productId: semCusto, quantity: 1 }], 5_000));

    const r = await dre();
    expect(r.cogs.costCents).toBe(0);
    expect(r.cogs.marginPercent).toBeNull();
  });
});

describe('o CMV não é subtraído do resultado — a mercadoria já é despesa', () => {
  it('resultCents continua sendo receita menos despesa, sem o CMV no meio', async () => {
    /*
      A compra entra no DRE como despesa pelo lançamento a pagar da nota. Se o
      CMV também fosse deduzido, a mesma mercadoria sairia duas vezes do
      resultado — o defeito clássico de misturar o gerencial com o contábil.
    */
    const produto = await criarProduto('Bicicleta Aro 29', 10_000, 6_000);
    await carregar(produto, 10);
    carimbar(await vender([{ productId: produto, quantity: 1 }], 10_000));

    const r = await dre();
    expect(r.cogs.costCents).toBe(6_000);
    expect(r.resultCents).toBe(r.revenue.totalCents - r.expense.totalCents);
    expect(r.caveats.join(' ')).toContain('não é descontado do resultado');
  });
});
