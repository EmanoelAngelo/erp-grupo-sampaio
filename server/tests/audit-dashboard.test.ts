/**
 * ============================================================================
 * AUDITORIA — FASE 3: O PAINEL NÃO PODE SER NÚMERO DECORATIVO
 * ============================================================================
 *
 * A pergunta desta fase não é "o painel responde 200?" — é "o número que o
 * gerente lê no fim do expediente é o número do que aconteceu?". O método é
 * montar um cenário CONHECIDO, no centavo, e cobrar cada campo do painel
 * contra a aritmética do cenário:
 *
 *   - 3 vendas concluídas HOJE (24.690 + 6.789 + 19.134 = 50.613 centavos),
 *     1 venda CANCELADA hoje (12.345) e 1 venda de ONTEM (6.789) — o painel
 *     do dia tem de dizer 50.613 / 3 vendas / ticket 16.871, nem um centavo
 *     a mais pelas duas que não pertencem ao recorte;
 *   - uma conta a PAGAR (9.999) e uma a RECEBER (30.000) com baixa parcial de
 *     10.000 — "em aberto" do painel tem de ser exatamente 20.000: a pagar
 *     não entra, baixa parcial desconta, e as parcelas das vendas em dinheiro
 *     (que nascem quitadas) contribuem zero;
 *   - estoque conhecido (10 de cada, mínimo declarado) — a lista de "estoque
 *     baixo" do painel aponta exatamente o produto que ficou abaixo do
 *     mínimo, e a posição de estoque bate com as unidades vendidas
 *     (inclusive a devolvida pelo cancelamento).
 *
 * Depois, as duas perguntas de vazamento: a venda de ontem NÃO entra no hoje
 * (o corte fino de fuso — venda das 21h30 — já é coberto por
 * o-dia-do-relatorio-e-o-dia-da-loja.test.ts; aqui cobramos o corte de
 * calendário dentro do fluxo) e a venda da GRINGA não engorda o painel da
 * CONCEITO — nem o contrário.
 *
 * E as superfícies que respondem a MESMA pergunta têm de dar o MESMO número
 * para o mesmo recorte:
 *
 *   - painel × lista de vendas (GET /core/sales): a soma das concluídas da
 *     lista é o faturamento do painel;
 *   - painel × BI de operações (GET /core/insights/operations): mesmo
 *     faturamento, mesma contagem, mesmo ticket;
 *   - painel × contas (GET /finance/entries?direction=in): mesmo "em aberto";
 *   - painel × DRE: já coberto por dre-competencia.test.ts (o DRE devolve a
 *     reconciliação com panelRevenueCents e nomeia cada parcela da
 *     diferença) — não duplicamos.
 *
 * O ÚLTIMO describe FICA VERMELHO DE PROPÓSITO: GET /api/v1/bi/dashboard
 * (corporate-bi, alcançável por qualquer gerente_loja via permissão
 * corporate-bi.view) devolve revenueCents/salesCount/receivablesCents/
 * inventoryValueCents HARDCODED EM ZERO (CorporateBIService.ts,
 * getExecutiveDashboardBackend) com vendas reais no banco — a definição
 * exata de número decorativo. Defeito de produção: não consertar aqui,
 * reportado na auditoria.
 *
 * Não existe superfície de "valor total de estoque" no painel do core — o
 * único lugar do repositório que nomeia inventoryValueCents é o stub acima,
 * que responde 0. Registrado como não aplicável no relatório da auditoria.
 */
process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';

import { randomUUID } from 'node:crypto';
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
const SENHA = 'Painel@Auditoria2026';

/** Dias fixos, longe de qualquer meia-noite: 15:00Z é meio-dia na loja (UTC-3). */
const HOJE = '2026-06-10';
const ONTEM = '2026-06-09';
const MEIO_DIA_HOJE = '2026-06-10T15:00:00.000Z';
const MEIO_DIA_ONTEM = '2026-06-09T15:00:00.000Z';

interface Ator {
  auth: { Authorization: string };
  userId: string;
}

/** Usuário real, senha Argon2id, login real — o mesmo idioma da casa. */
async function ator(login: string, vinculos: [string, string][]): Promise<Ator> {
  const userId = await upsertUser({ login, displayName: login, password: SENHA });
  for (const [companyId, profile] of vinculos) {
    linkUserToCompany(userId, companyId, profile, false);
  }
  const res = await request(app)
    .post('/api/v1/auth/login')
    .send({ login, password: SENHA, companyId: vinculos[0][0] });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { auth: { Authorization: `Bearer ${res.body.accessToken}` }, userId };
}

let conceito: string;
let gringa: string;

beforeEach(() => {
  resetDbForTests();
  conceito = upsertCompany({
    slug: 'conceito',
    legalName: 'Conceito Moda Feminina Ltda',
    tradeName: 'Conceito',
    kind: 'retail',
  });
  gringa = upsertCompany({
    slug: 'gringa',
    legalName: 'Gringa Comércio de Roupas Ltda',
    tradeName: 'Gringa',
    kind: 'retail',
  });
});

const gerenteConceito = () => ator('GERENTE.CONCEITO', [[conceito, 'gerente_loja']]);
const gerenteGringa = () => ator('GERENTE.GRINGA', [[gringa, 'gerente_loja']]);

// ---------------------------------------------------------------- ferramentas

async function criarProduto(
  auth: Ator['auth'],
  nome: string,
  precoCents: number,
  minStock = 0,
): Promise<string> {
  const res = await request(app)
    .post('/api/v1/core/products')
    .set(auth)
    .send({ name: nome, priceCents: precoCents, minStock });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

async function entradaEstoque(auth: Ator['auth'], productId: string, quantidade: number) {
  const res = await request(app).post('/api/v1/core/stock/movements').set(auth).send({
    productId,
    movementType: 'in',
    quantity: quantidade,
    referenceType: 'entrada',
    referenceId: `carga-${productId}`,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
}

/** Venda pela ROTA, paga em dinheiro no valor exato — e o total conferido no centavo. */
async function vender(
  auth: Ator['auth'],
  itens: { productId: string; quantity: number }[],
  totalEsperadoCents: number,
): Promise<string> {
  const res = await request(app)
    .post('/api/v1/core/sales')
    .set(auth)
    .set('Idempotency-Key', randomUUID())
    .send({ items: itens, payments: [{ method: 'dinheiro', amountCents: totalEsperadoCents }] });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const venda = res.body.sale ?? res.body;
  // Asserção matemática na origem: o preço é do SERVIDOR, e tem de bater
  // com a aritmética do cenário antes de qualquer painel entrar em cena.
  expect(venda.total_cents).toBe(totalEsperadoCents);
  return venda.id as string;
}

/**
 * Move o carimbo da venda para um instante conhecido. A venda nasceu pela
 * rota (estoque baixado, financeiro lançado); só o QUANDO é encenado, porque
 * o relógio do teste não é o relógio do cenário.
 */
function carimbar(saleId: string, instante: string) {
  getConnection()
    .prepare('UPDATE core_sales SET created_at = ? WHERE id = ?')
    .run(instante, saleId);
}

async function painel(auth: Ator['auth'], from?: string, to?: string) {
  const qs = from && to ? `?from=${from}&to=${to}` : '';
  const res = await request(app).get(`/api/v1/core/dashboard${qs}`).set(auth);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as {
    revenueCents: number;
    salesCount: number;
    averageTicketCents: number;
    openReceivablesCents: number;
    byDay: { day: string; sales_count: number; revenue_cents: number }[];
    topProducts: { product_id: string; quantity: number; revenue_cents: number }[];
    bySeller: { sales_count: number; revenue_cents: number }[];
    lowStock: { product_id: string; quantity: number; below_minimum: number }[];
  };
}

interface Cenario {
  p1: string; // Bicicleta — 12.345, mínimo 2
  p2: string; // Capacete — 6.789, mínimo 8
  vendasDeHoje: string[];
  cancelada: string;
  deOntem: string;
}

/**
 * O cenário conhecido da Conceito. Toda a aritmética dos casos sai daqui:
 *
 *   HOJE:  V1 = 2×12.345 = 24.690 | V2 = 1×6.789 | V3 = 12.345+6.789 = 19.134
 *          total 50.613, 3 vendas, ticket 16.871 (exato: 50.613/3)
 *   HOJE, cancelada: 1×12.345 (o estoque volta; o número não pode ficar)
 *   ONTEM: 1×6.789
 *
 *   Estoque: 10 de cada → P1 = 10−2−1−1+1(cancelamento) = 7 (mínimo 2: ok)
 *                         P2 = 10−1−1−1(ontem)          = 7 (mínimo 8: BAIXO)
 */
async function montarCenarioConceito(auth: Ator['auth']): Promise<Cenario> {
  const p1 = await criarProduto(auth, 'Bicicleta Aro 29', 12_345, 2);
  const p2 = await criarProduto(auth, 'Capacete Urbano', 6_789, 8);
  await entradaEstoque(auth, p1, 10);
  await entradaEstoque(auth, p2, 10);

  const v1 = await vender(auth, [{ productId: p1, quantity: 2 }], 24_690);
  const v2 = await vender(auth, [{ productId: p2, quantity: 1 }], 6_789);
  const v3 = await vender(
    auth,
    [
      { productId: p1, quantity: 1 },
      { productId: p2, quantity: 1 },
    ],
    19_134,
  );

  const cancelada = await vender(auth, [{ productId: p1, quantity: 1 }], 12_345);
  const cancel = await request(app)
    .post(`/api/v1/core/sales/${cancelada}/cancel`)
    .set(auth)
    .send({ reason: 'auditoria: venda desfeita' });
  expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);

  const deOntem = await vender(auth, [{ productId: p2, quantity: 1 }], 6_789);

  for (const id of [v1, v2, v3, cancelada]) carimbar(id, MEIO_DIA_HOJE);
  carimbar(deOntem, MEIO_DIA_ONTEM);

  return { p1, p2, vendasDeHoje: [v1, v2, v3], cancelada, deOntem };
}

// ============================================================================

describe('o painel devolve exatamente o cenário montado', () => {
  it('faturamento, contagem e ticket do dia batem no centavo — cancelada e a de ontem ficam fora', async () => {
    const g = await gerenteConceito();
    const c = await montarCenarioConceito(g.auth);

    const dia = await painel(g.auth, HOJE, HOJE);

    // 24.690 + 6.789 + 19.134 — nem a cancelada (12.345), nem a de ontem (6.789).
    expect(dia.revenueCents).toBe(50_613);
    expect(dia.salesCount).toBe(3);
    expect(dia.averageTicketCents).toBe(16_871); // 50.613 / 3, exato

    // O gráfico por dia é o mesmo total, com o mesmo rótulo de dia.
    expect(dia.byDay).toEqual([{ day: HOJE, sales_count: 3, revenue_cents: 50_613 }]);

    // Top produtos: P1 = 2+1 unidades (37.035), P2 = 1+1 (13.578) — a unidade
    // da venda cancelada NÃO aparece, e a soma dos produtos É o faturamento.
    const porProduto = new Map(dia.topProducts.map((t) => [t.product_id, t]));
    expect(porProduto.get(c.p1)?.quantity).toBe(3);
    expect(porProduto.get(c.p1)?.revenue_cents).toBe(37_035);
    expect(porProduto.get(c.p2)?.quantity).toBe(2);
    expect(porProduto.get(c.p2)?.revenue_cents).toBe(13_578);
    expect(dia.topProducts.reduce((a, t) => a + t.revenue_cents, 0)).toBe(50_613);

    // Vendedores: partição do mesmo total — somar os grupos devolve o todo.
    expect(dia.bySeller.reduce((a, s) => a + s.revenue_cents, 0)).toBe(50_613);
    expect(dia.bySeller.reduce((a, s) => a + s.sales_count, 0)).toBe(3);
  });

  it('o período de dois dias soma ontem + hoje, e a soma das barras é o total', async () => {
    const g = await gerenteConceito();
    await montarCenarioConceito(g.auth);

    const periodo = await painel(g.auth, ONTEM, HOJE);

    expect(periodo.revenueCents).toBe(57_402); // 50.613 + 6.789
    expect(periodo.salesCount).toBe(4);
    expect(periodo.byDay).toEqual([
      { day: ONTEM, sales_count: 1, revenue_cents: 6_789 },
      { day: HOJE, sales_count: 3, revenue_cents: 50_613 },
    ]);
    expect(periodo.byDay.reduce((a, d) => a + d.revenue_cents, 0)).toBe(periodo.revenueCents);

    // E o recorte só de ontem devolve só ontem — a venda de hoje não recua.
    const ontem = await painel(g.auth, ONTEM, ONTEM);
    expect(ontem.revenueCents).toBe(6_789);
    expect(ontem.salesCount).toBe(1);
  });

  it('o estoque do painel é o estoque das vendas — e "baixo" aponta só quem ficou abaixo do mínimo', async () => {
    const g = await gerenteConceito();
    const c = await montarCenarioConceito(g.auth);

    // Posição de estoque: P1 vendeu 4 e recuperou 1 no cancelamento; P2 vendeu 3.
    const stock = await request(app).get('/api/v1/core/stock').set(g.auth);
    expect(stock.status).toBe(200);
    const porId = new Map(
      (stock.body.items as { product_id: string; quantity: number }[]).map((i) => [
        i.product_id,
        i.quantity,
      ]),
    );
    expect(porId.get(c.p1)).toBe(7);
    expect(porId.get(c.p2)).toBe(7);

    // O painel aponta SÓ o capacete (7 < mínimo 8); a bicicleta (7 ≥ 2) não.
    const dia = await painel(g.auth, HOJE, HOJE);
    expect(dia.lowStock.map((l) => l.product_id)).toEqual([c.p2]);
    expect(dia.lowStock[0].quantity).toBe(7);
  });
});

// ============================================================================

describe('contas em aberto: o número do painel é o número das Contas', () => {
  it('a pagar não entra, baixa parcial desconta, e GET /finance/entries responde o MESMO valor', async () => {
    const g = await gerenteConceito();
    await montarCenarioConceito(g.auth);

    // Uma conta a PAGAR de 9.999 — não é "a receber", não pode entrar.
    const pagar = await request(app)
      .post('/api/v1/core/finance/entries')
      .set(g.auth)
      .send({ direction: 'out', description: 'Aluguel da loja', amountCents: 9_999, dueDate: HOJE });
    expect(pagar.status, JSON.stringify(pagar.body)).toBe(201);

    // Uma conta a RECEBER de 30.000 com baixa parcial de 10.000.
    const receber = await request(app)
      .post('/api/v1/core/finance/entries')
      .set(g.auth)
      .send({ direction: 'in', description: 'Condicional da cliente', amountCents: 30_000, dueDate: HOJE });
    expect(receber.status, JSON.stringify(receber.body)).toBe(201);
    const baixa = await request(app)
      .post(`/api/v1/core/finance/entries/${receber.body.id}/settle`)
      .set(g.auth)
      .send({ amountCents: 10_000, method: 'pix' });
    expect(baixa.status, JSON.stringify(baixa.body)).toBe(200);

    /*
      20.000 EXATOS. Se as parcelas das vendas em dinheiro (que nascem
      quitadas) ou a parcela da venda CANCELADA vazassem para cá, o número
      seria outro — a igualdade estrita cobre os três critérios de uma vez.
    */
    const dia = await painel(g.auth, HOJE, HOJE);
    expect(dia.openReceivablesCents).toBe(20_000);

    // A tela de Contas responde a MESMA pergunta com o MESMO número.
    const contas = await request(app)
      .get('/api/v1/core/finance/entries?direction=in')
      .set(g.auth);
    expect(contas.status).toBe(200);
    expect(contas.body.summary.openCents).toBe(20_000);
    expect(contas.body.summary.openCents).toBe(dia.openReceivablesCents);

    // E o "em aberto" a pagar existe do lado de lá, intacto e separado.
    const aPagar = await request(app)
      .get('/api/v1/core/finance/entries?direction=out')
      .set(g.auth);
    expect(aPagar.body.summary.openCents).toBe(9_999);
  });
});

// ============================================================================

describe('a empresa do vizinho não engorda o painel', () => {
  it('a venda da Gringa não entra na Conceito — nem a da Conceito na Gringa', async () => {
    const gConceito = await gerenteConceito();
    const gGringa = await gerenteGringa();
    const c = await montarCenarioConceito(gConceito.auth);

    // A Gringa vende 99.999 no MESMO instante do dia.
    const vestido = await criarProduto(gGringa.auth, 'Vestido Longo', 99_999);
    await entradaEstoque(gGringa.auth, vestido, 5);
    const vendaGringa = await vender(gGringa.auth, [{ productId: vestido, quantity: 1 }], 99_999);
    carimbar(vendaGringa, MEIO_DIA_HOJE);

    // O painel da Conceito continua sendo a aritmética da Conceito.
    const daConceito = await painel(gConceito.auth, HOJE, HOJE);
    expect(daConceito.revenueCents).toBe(50_613);
    expect(daConceito.salesCount).toBe(3);
    expect(daConceito.topProducts.map((t) => t.product_id)).not.toContain(vestido);

    // E o da Gringa é só a Gringa: 1 venda, ticket = a própria venda, nada a receber
    // (a venda em dinheiro nasce quitada) e nenhum produto da Conceito.
    const daGringa = await painel(gGringa.auth, HOJE, HOJE);
    expect(daGringa.revenueCents).toBe(99_999);
    expect(daGringa.salesCount).toBe(1);
    expect(daGringa.averageTicketCents).toBe(99_999);
    expect(daGringa.openReceivablesCents).toBe(0);
    expect(daGringa.topProducts.map((t) => t.product_id)).not.toContain(c.p1);

    // A lista de vendas da Gringa também não carrega a venda alheia.
    const lista = await request(app)
      .get(`/api/v1/core/sales?from=${HOJE}&to=${HOJE}`)
      .set(gGringa.auth);
    expect((lista.body.items as { id: string }[]).map((s) => s.id)).toEqual([vendaGringa]);
  });
});

// ============================================================================

describe('dois lugares, um número — para o mesmo recorte', () => {
  it('a lista de vendas soma o faturamento que o painel afirma', async () => {
    const g = await gerenteConceito();
    const c = await montarCenarioConceito(g.auth);

    const dia = await painel(g.auth, HOJE, HOJE);
    const lista = await request(app)
      .get(`/api/v1/core/sales?from=${HOJE}&to=${HOJE}`)
      .set(g.auth);
    expect(lista.status).toBe(200);
    const itens = lista.body.items as { id: string; status: string; total_cents: number }[];

    // A lista mostra a cancelada (com o status dela) — mas o dinheiro do
    // relatório é o das concluídas, e é IGUAL ao do painel.
    const concluidas = itens.filter((s) => s.status === 'completed');
    expect(concluidas.reduce((a, s) => a + s.total_cents, 0)).toBe(dia.revenueCents);
    expect(concluidas).toHaveLength(dia.salesCount);
    expect(itens.find((s) => s.id === c.cancelada)?.status).toBe('cancelled');
    // A venda de ontem não está no recorte de hoje da lista.
    expect(itens.map((s) => s.id)).not.toContain(c.deOntem);
  });

  it('o BI de operações diz o mesmo faturamento, a mesma contagem e o mesmo ticket', async () => {
    const g = await gerenteConceito();
    await montarCenarioConceito(g.auth);

    const dia = await painel(g.auth, HOJE, HOJE);
    const insights = await request(app)
      .get(`/api/v1/core/insights/operations?from=${HOJE}&to=${HOJE}`)
      .set(g.auth);
    expect(insights.status, JSON.stringify(insights.body)).toBe(200);

    const totals = insights.body.totals as {
      revenueCents: number;
      salesCount: number;
      averageTicketCents: number;
    };
    expect(totals.revenueCents).toBe(dia.revenueCents);
    expect(totals.salesCount).toBe(dia.salesCount);
    expect(totals.averageTicketCents).toBe(dia.averageTicketCents);
    // E em valor absoluto, para o caso dos DOIS regredirem juntos:
    expect(totals.revenueCents).toBe(50_613);
    expect(totals.averageTicketCents).toBe(16_871);
  });
});

// ============================================================================

describe('o BI corporativo decorativo saiu do ar', () => {
  /*
    Este describe nasceu VERMELHO acusando defeito real: GET /bi/dashboard
    devolvia TODOS os indicadores executivos hardcoded em zero
    (getExecutiveDashboardBackend), alcançável por qualquer gerente_loja —
    número decorativo com cara de dashboard. bi.test.ts só conferia a FORMA
    (toHaveProperty), então o zero passava verde lá.

    A auditoria decidiu pela REMOÇÃO, não pelo preenchimento: nenhuma tela
    chamava a rota (BiPage usa /insights/*, que responde número de verdade), e
    dashboard executivo cross-empresa é decisão de produto, não lacuna de
    implementação. Mentira removida > mentira melhorada. A cobertura fina da
    remoção vive em audit-guardas.test.ts; aqui fica a prova de que a venda
    recém-feita NÃO alimenta mais um painel que respondia zero.
  */
  it('GET /bi/dashboard não existe mais — o zero decorativo não tem onde morar', async () => {
    const g = await gerenteConceito();
    const p = await criarProduto(g.auth, 'Item do Executivo', 25_000);
    await entradaEstoque(g.auth, p, 3);
    await vender(g.auth, [{ productId: p, quantity: 1 }], 25_000);

    const res = await request(app).get('/api/v1/bi/dashboard').set(g.auth);
    expect(res.status).toBe(404);
    expect(res.body?.error?.code).toBe('API_NOT_FOUND');
  });
});
