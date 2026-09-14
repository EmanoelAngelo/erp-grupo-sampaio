/**
 * ============================================================================
 * AUDITORIA FASE 8 — O DINHEIRO FECHA
 * ============================================================================
 *
 * Fluxo conhecido, atravessado de ponta a ponta por HTTP, com matemática em
 * centavos inteiros conferida em cada parada:
 *
 *   1. venda balcão de R$ 500,00 (R$ 300 dinheiro + R$ 200 crédito), com
 *      operadora cadastrada (crédito 1x, 3,5%, D+30) e comissão de 5% para o
 *      vendedor → lançamentos a receber exatos (fatia quitada + fatia na
 *      operadora), taxa como DESPESA, DRE com a receita EXATA, comissão sobre
 *      a base real (subtotal − desconto de cabeçalho);
 *   2. fechamento da comissão → conta a pagar de folha, visível no DRE;
 *   3. cancelamento da venda → o dinheiro dela SOME dos QUATRO lugares que
 *      respondem "quanto" — lista, resumo, painel e DRE (o D1 da auditoria
 *      antiga: três lugares, três números);
 *   4. conta a pagar com vencimento → baixa parcial → saldo exato → quitação
 *      → estorno de baixa devolve ao aberto → vencida aparece como vencida —
 *      com os TOTAIS agregados acompanhando cada passo (a parte que os testes
 *      unitários de FinanceService não cobrem).
 *
 * A regra de comissão AFIRMADA pelo serviço (CommissionService, cabeçalho):
 * base = subtotal (líquido de desconto de LINHA) MENOS desconto de CABEÇALHO;
 * o ACRÉSCIMO fica fora. O terceiro caso prova as três partes pela rota.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { getConnection } from '../src/db/sqlite.js';
import { resetDbForTests } from '../src/db/database.js';
import {
  linkUserToCompany,
  upsertCompany,
  upsertUser,
} from '../src/services/auth/IdentityService.js';
import { createProduct } from '../src/services/core/CatalogService.js';
import { applyMovement } from '../src/services/core/InventoryService.js';
import { diaDaLoja, hojeNaLoja, somarDias } from '../src/services/core/CalendarioOperacional.js';

/*
  O RELÓGIO DESTE ARQUIVO FICA NA HORA QUE O DERRUBAVA (GAP-PRD-175).

  Às 22:58 de Pelotas (01:58 em Greenwich, já no dia seguinte) o primeiro caso
  ficava vermelho com o produto certo: o teste datava o D+30 pelo dia UTC da
  venda e o serviço, pelo dia da loja. Em vez de torcer para a suíte rodar de
  dia, o arquivo vive nessa hora — o relógio anda (shouldAdvanceTime), mas
  começa na fronteira em que os dois calendários discordam.
*/
const NOITE_EM_PELOTAS = new Date('2026-09-11T01:58:00.000Z');
beforeAll(() => {
  vi.useFakeTimers({ now: NOITE_EM_PELOTAS, toFake: ['Date'], shouldAdvanceTime: true });
});
afterAll(() => {
  vi.useRealTimers();
});

const app = createApp();
const SENHA = 'Auditoria@Fase8!2026';

// Janela larga para DRE/resumos: pega o lançamento independentemente de o dia
// UTC (usado na competência da venda) e o dia da loja divergirem perto da
// meia-noite, e pega também a parcela D+30 e a competência do fechamento.
const DE = '2020-01-01';
const ATE = '2031-12-31';

let empresa: string;
let gestor: { Authorization: string };
let vendedorId: string;
let produto: string;

interface EntryDto {
  id: string;
  direction: string;
  description: string;
  amountCents: number;
  settledCents: number;
  balanceCents: number;
  status: string;
  dueDate: string | null;
  settledAt: string | null;
  overdue: boolean;
  categoryId: string | null;
  categoryName: string | null;
}

async function ator(login: string, profile: string): Promise<{ Authorization: string }> {
  const userId = await upsertUser({ login, displayName: login, password: SENHA });
  linkUserToCompany(userId, empresa, profile, true);
  const res = await request(app)
    .post('/api/v1/auth/login')
    .send({ login, password: SENHA, companyId: empresa });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { Authorization: `Bearer ${res.body.accessToken}` };
}

async function entradas(direction: 'in' | 'out'): Promise<{
  items: EntryDto[];
  summary: {
    openCents: number;
    overdueCents: number;
    settledCents: number;
    count: number;
    openCount: number;
    overdueCount: number;
  };
}> {
  const res = await request(app)
    .get(`/api/v1/core/finance/entries?direction=${direction}`)
    .set(gestor);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

/** O pedaço do DRE que este arquivo confere. */
interface LinhaDoDre {
  systemCode: string | null;
  totalCents: number;
  entryCount: number;
}
interface LadoDoDre {
  totalCents: number;
  entryCount: number;
  lines: LinhaDoDre[];
}
interface DreDaRota {
  revenue: LadoDoDre;
  expense: LadoDoDre;
  resultCents: number;
}

async function dre(): Promise<DreDaRota> {
  const res = await request(app)
    .get(`/api/v1/core/finance/income-statement?from=${DE}&to=${ATE}`)
    .set(gestor);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as DreDaRota;
}

function linhaDoDre(lado: LadoDoDre, systemCode: string): LinhaDoDre | undefined {
  return lado.lines.find((l) => l.systemCode === systemCode);
}

/** Operadora Cielo: crédito 1x, taxa em bps, depósito em D+`dias`. */
async function operadoraCredito1x(feeBps: number, dias: number): Promise<void> {
  const op = await request(app).post('/api/v1/core/acquirers').set(gestor).send({ name: 'Cielo' });
  expect(op.status, JSON.stringify(op.body)).toBe(201);
  const rate = await request(app)
    .put(`/api/v1/core/acquirers/${op.body.acquirer.id}/rates`)
    .set(gestor)
    .send({ paymentMethod: 'credito', installments: 1, feeBps, settlementDays: dias });
  expect(rate.status, JSON.stringify(rate.body)).toBe(200);
}

/** Grupo de comissão com uma faixa desde zero, e o vendedor dentro. */
async function comissaoDe(rateBps: number): Promise<void> {
  const g = await request(app)
    .post('/api/v1/core/commissions/groups')
    .set(gestor)
    .send({ name: 'Balcão' });
  expect(g.status, JSON.stringify(g.body)).toBe(201);
  const t = await request(app)
    .put(`/api/v1/core/commissions/groups/${g.body.group.id}/tiers`)
    .set(gestor)
    .send({ minCents: 0, rateBps });
  expect(t.status, JSON.stringify(t.body)).toBe(200);
  const m = await request(app)
    .put(`/api/v1/core/commissions/members/${vendedorId}`)
    .set(gestor)
    .send({ groupId: g.body.group.id });
  expect(m.status, JSON.stringify(m.body)).toBe(200);
}

async function vender(body: Record<string, unknown>, chave: string) {
  const res = await request(app)
    .post('/api/v1/core/sales')
    .set(gestor)
    .set('Idempotency-Key', chave)
    .send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; number: number; total_cents: number; created_at: string };
}

function linhasDeComissao(): {
  seller_id: string;
  origin_type: string;
  base_cents: number;
  rate_bps: number;
  amount_cents: number;
  status: string;
}[] {
  return getConnection()
    .prepare('SELECT * FROM core_commission_entries WHERE company_id = ? ORDER BY created_at')
    .all(empresa) as never;
}

beforeEach(async () => {
  resetDbForTests();
  empresa = upsertCompany({
    slug: 'preco-justo',
    legalName: 'Preço Justo Comércio Ltda',
    tradeName: 'Preço Justo',
    kind: 'retail',
  });
  gestor = await ator('GESTOR.FASE8', 'gestor');
  vendedorId = await upsertUser({
    login: 'VEND.FASE8',
    displayName: 'Vendedora Fase 8',
    password: SENHA,
  });
  linkUserToCompany(vendedorId, empresa, 'atendente', true);
  // Produto de R$ 250,00 — dois dele fazem os R$ 500,00 do cenário.
  produto = createProduct(empresa, { name: 'Jaqueta Parka', priceCents: 25_000 }).id as string;
  applyMovement({
    companyId: empresa,
    productId: produto,
    movementType: 'in',
    quantity: 10,
    referenceType: 'ajuste',
    referenceId: 'estoque-fase8',
  });
});

describe('o fluxo do dinheiro, ponta a ponta', () => {
  it('venda 300+200 com operadora e comissão: lançamentos, DRE, fechamento e cancelamento — os quatro lugares contam o mesmo', async () => {
    await operadoraCredito1x(350, 30); // 3,5%, D+30
    await comissaoDe(500); // 5%

    // ---------------------------------------------------------------- venda
    const venda = await vender(
      {
        items: [{ productId: produto, quantity: 2 }],
        payments: [
          { method: 'dinheiro', amountCents: 30_000 },
          { method: 'credito', amountCents: 20_000, installments: 1 },
        ],
        sellerId: vendedorId,
      },
      'audit-fase8-venda-1',
    );
    expect(venda.total_cents).toBe(50_000);

    // O serviço data o calendário da operadora pelo DIA DA LOJA da venda
    // (`somarDias(diaDaLoja(instante))` em SalesService) — é contra ELE que o
    // vencimento D+30 é conferido. O dia UTC do carimbo (`slice(0, 10)`) só
    // coincide de dia: às 22:58 de Pelotas já é o dia seguinte em Greenwich.
    const diaDaVenda = diaDaLoja(venda.created_at);
    const d30 = somarDias(diaDaVenda, 30);

    // --------------------------------------------- a receber, ao centavo
    const aReceber = await entradas('in');
    expect(aReceber.items).toHaveLength(2);

    const fatiaDinheiro = aReceber.items.find((e) => e.amountCents === 30_000)!;
    expect(fatiaDinheiro, JSON.stringify(aReceber.items)).toBeTruthy();
    expect(fatiaDinheiro.status).toBe('settled');
    expect(fatiaDinheiro.settledCents).toBe(30_000);
    expect(fatiaDinheiro.balanceCents).toBe(0);
    expect(fatiaDinheiro.categoryName).toBe('Venda de mercadoria');

    const fatiaCartao = aReceber.items.find((e) => e.amountCents === 20_000)!;
    expect(fatiaCartao, JSON.stringify(aReceber.items)).toBeTruthy();
    expect(fatiaCartao.status).toBe('open');
    expect(fatiaCartao.settledCents).toBe(0);
    expect(fatiaCartao.balanceCents).toBe(20_000);
    expect(fatiaCartao.overdue).toBe(false);
    expect(fatiaCartao.dueDate).toBe(d30); // o dinheiro do cartão cai em D+30
    expect(fatiaCartao.categoryName).toBe('Venda de mercadoria');

    // A identidade: as fatias somam EXATAMENTE o total da venda.
    expect(fatiaDinheiro.amountCents + fatiaCartao.amountCents).toBe(venda.total_cents);
    expect(aReceber.summary).toEqual({
      openCents: 20_000,
      overdueCents: 0,
      settledCents: 30_000,
      count: 2,
      // GAP-PRD-208: a contagem que acompanha o "em aberto" é a dos abertos —
      // só a fatia do cartão deve; a do dinheiro nasceu quitada.
      openCount: 1,
      overdueCount: 0,
    });

    // ------------------------------------- a taxa da operadora é DESPESA
    const aPagar = await entradas('out');
    expect(aPagar.items).toHaveLength(1);
    const taxa = aPagar.items[0];
    // 3,5% de R$ 200,00 = R$ 7,00 — só sobre a parte do cartão.
    expect(taxa.amountCents).toBe(700);
    expect(taxa.status).toBe('open');
    expect(taxa.dueDate).toBe(d30);
    expect(taxa.categoryName).toBe('Taxa de cartão');
    expect(aPagar.summary.openCents).toBe(700);

    // ------------------------------------------------- DRE: receita EXATA
    let demo = await dre();
    expect(demo.revenue.totalCents).toBe(50_000);
    expect(demo.revenue.entryCount).toBe(2);
    const linhaVenda = linhaDoDre(demo.revenue, 'venda');
    expect(linhaVenda?.totalCents).toBe(50_000);
    expect(linhaVenda?.entryCount).toBe(2);
    const linhaTaxa = linhaDoDre(demo.expense, 'taxa_cartao');
    expect(linhaTaxa?.totalCents).toBe(700);
    expect(demo.expense.totalCents).toBe(700);
    expect(demo.resultCents).toBe(49_300);
    expect(demo.uncategorized.entryCount).toBe(0);
    // Painel e DRE contam o mesmo: só há venda de balcão, diferença zero.
    expect(demo.reconciliation.panelRevenueCents).toBe(50_000);
    expect(demo.reconciliation.differenceCents).toBe(0);

    // ------------------------- comissão: 5% sobre subtotal − desconto = base
    const linhas = linhasDeComissao();
    expect(linhas).toHaveLength(1);
    expect(linhas[0].seller_id).toBe(vendedorId);
    expect(linhas[0].base_cents).toBe(50_000); // subtotal 50.000 − desconto 0
    expect(linhas[0].rate_bps).toBe(500);
    expect(linhas[0].amount_cents).toBe(2_500); // 5% de 500,00 = R$ 25,00

    const resumo1 = await request(app)
      .get(`/api/v1/core/commissions/summary?from=${DE}&to=${ATE}`)
      .set(gestor);
    expect(resumo1.status).toBe(200);
    expect(resumo1.body.rows).toHaveLength(1);
    expect(resumo1.body.rows[0].sellerId).toBe(vendedorId);
    expect(resumo1.body.rows[0].apuradoCents).toBe(2_500);
    expect(resumo1.body.rows[0].saldoCents).toBe(2_500);
    expect(resumo1.body.semComissao.vendas).toBe(0);

    // -------------------------- fechamento: comissão vira conta a pagar
    const vencimentoFolha = somarDias(hojeNaLoja(), 7);
    const fechamento = await request(app)
      .post('/api/v1/core/commissions/close')
      .set(gestor)
      .send({ sellerId: vendedorId, from: DE, to: ATE, dueDate: vencimentoFolha });
    expect(fechamento.status, JSON.stringify(fechamento.body)).toBe(201);
    expect(fechamento.body.totalCents).toBe(2_500);
    expect(fechamento.body.financeEntryId).toBeTruthy();

    const aPagar2 = await entradas('out');
    const folha = aPagar2.items.find((e) => e.id === fechamento.body.financeEntryId)!;
    expect(folha, JSON.stringify(aPagar2.items)).toBeTruthy();
    expect(folha.amountCents).toBe(2_500);
    expect(folha.categoryName).toBe('Folha e pró-labore');
    expect(folha.dueDate).toBe(vencimentoFolha);
    expect(aPagar2.summary.openCents).toBe(700 + 2_500);

    demo = await dre();
    expect(linhaDoDre(demo.expense, 'folha')?.totalCents).toBe(2_500);
    expect(demo.expense.totalCents).toBe(3_200);
    expect(demo.resultCents).toBe(50_000 - 3_200);

    // ------------------- cancelamento: o D1 da auditoria antiga, reprovado?
    const cancel = await request(app)
      .post(`/api/v1/core/sales/${venda.id}/cancel`)
      .set(gestor)
      .send({ reason: 'auditoria fase 8' });
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
    expect(cancel.body.status).toBe('cancelled');

    // (1) LISTA: os lançamentos da venda saem — inclusive a fatia da operadora
    //     e a taxa dela; a folha do fechamento fica, por regra declarada.
    const listaFinal = await entradas('in');
    expect(listaFinal.items).toHaveLength(0);
    // (2) RESUMO: aberto, vencido e recebido zeram juntos.
    expect(listaFinal.summary).toEqual({
      openCents: 0,
      overdueCents: 0,
      settledCents: 0,
      count: 0,
      openCount: 0,
      overdueCount: 0,
    });
    const pagarFinal = await entradas('out');
    expect(pagarFinal.items.map((e) => e.id)).toEqual([folha.id]);
    expect(pagarFinal.summary.openCents).toBe(2_500);

    // (3) PAINEL: faturamento e "a receber em aberto" também zeram.
    const painel = await request(app)
      .get(`/api/v1/core/dashboard?from=${DE}&to=${ATE}`)
      .set(gestor);
    expect(painel.status).toBe(200);
    expect(painel.body.revenueCents).toBe(0);
    expect(painel.body.openReceivablesCents).toBe(0);

    // (4) DRE: a receita sai, a taxa sai, e sobra só a folha já fechada.
    demo = await dre();
    expect(demo.revenue.totalCents).toBe(0);
    expect(linhaDoDre(demo.expense, 'taxa_cartao')).toBeUndefined();
    expect(demo.expense.totalCents).toBe(2_500);
    expect(demo.resultCents).toBe(-2_500);
    expect(demo.reconciliation.panelRevenueCents).toBe(0);
    expect(demo.reconciliation.differenceCents).toBe(0);

    // E a comissão volta atrás como ESTORNO (linha nova), zerando o saldo —
    // a conta a pagar já emitida não muda de valor, por regra declarada.
    const resumo2 = await request(app)
      .get(`/api/v1/core/commissions/summary?from=${DE}&to=${ATE}`)
      .set(gestor);
    expect(resumo2.body.rows[0].apuradoCents).toBe(2_500);
    expect(resumo2.body.rows[0].estornadoCents).toBe(2_500);
    expect(resumo2.body.rows[0].saldoCents).toBe(0);
    const estorno = linhasDeComissao().find((l) => l.origin_type === 'sale_cancel')!;
    expect(estorno.amount_cents).toBe(-2_500);
  });
});

describe('a conta a pagar da compra, com os totais acompanhando cada passo', () => {
  it('vencimento → baixa parcial → saldo exato → quitação → estorno devolve ao aberto → vencida é vencida', async () => {
    // A categoria de sistema "Compra de mercadoria", pela rota do seletor.
    const cats = await request(app)
      .get('/api/v1/core/finance/categories?direction=out')
      .set(gestor);
    expect(cats.status).toBe(200);
    const fornecedor = cats.body.items.find(
      (c: { system_code: string | null }) => c.system_code === 'fornecedor',
    );
    expect(fornecedor, JSON.stringify(cats.body.items)).toBeTruthy();

    // A dívida da nota: R$ 250,00 vencendo em 10 dias.
    const vence = somarDias(hojeNaLoja(), 10);
    const criada = await request(app)
      .post('/api/v1/core/finance/entries')
      .set(gestor)
      .send({
        direction: 'out',
        description: 'NF 123 · Fornecedor Têxtil',
        amountCents: 25_000,
        dueDate: vence,
        categoryId: fornecedor.id,
      });
    expect(criada.status, JSON.stringify(criada.body)).toBe(201);
    const contaId = criada.body.id as string;
    expect(criada.body.dueDate).toBe(vence);
    expect(criada.body.categoryId).toBe(fornecedor.id);

    // Baixa PARCIAL: R$ 100,00 de R$ 250,00.
    const parcial = await request(app)
      .post(`/api/v1/core/finance/entries/${contaId}/settle`)
      .set(gestor)
      .send({ amountCents: 10_000, method: 'pix' });
    expect(parcial.status, JSON.stringify(parcial.body)).toBe(200);
    expect(parcial.body.entry.settledCents).toBe(10_000);
    expect(parcial.body.entry.balanceCents).toBe(15_000); // saldo em aberto EXATO
    expect(parcial.body.entry.status).toBe('open');

    let resumo = (await entradas('out')).summary;
    expect(resumo.openCents).toBe(15_000);
    expect(resumo.settledCents).toBe(10_000);
    expect(resumo.overdueCents).toBe(0); // ainda não venceu

    // A visão por categoria devolve a conta — com o saldo, não o total.
    const porCategoria = await request(app)
      .get(`/api/v1/core/finance/entries?direction=out&categoryId=${fornecedor.id}`)
      .set(gestor);
    expect(porCategoria.status).toBe(200);
    expect(porCategoria.body.items).toHaveLength(1);
    expect(porCategoria.body.items[0].id).toBe(contaId);
    expect(porCategoria.body.items[0].balanceCents).toBe(15_000);

    // E no DRE ela está na linha certa, pelo valor de COMPETÊNCIA (inteiro,
    // não o baixado — regime de competência, declarado na ressalva).
    let demo = await dre();
    expect(linhaDoDre(demo.expense, 'fornecedor')?.totalCents).toBe(25_000);
    expect(linhaDoDre(demo.expense, 'fornecedor')?.entryCount).toBe(1);

    // Baixa do resto: quitada.
    const resto = await request(app)
      .post(`/api/v1/core/finance/entries/${contaId}/settle`)
      .set(gestor)
      .send({ amountCents: 15_000, method: 'pix' });
    expect(resto.status).toBe(200);
    expect(resto.body.entry.balanceCents).toBe(0);
    expect(resto.body.entry.status).toBe('settled');
    expect(resto.body.entry.settledAt).toBeTruthy();

    resumo = (await entradas('out')).summary;
    expect(resumo.openCents).toBe(0);
    expect(resumo.settledCents).toBe(25_000);

    // Estorno da PRIMEIRA baixa devolve exatamente R$ 100,00 ao aberto.
    const baixaOriginal = parcial.body.settlements[0].id as string;
    const estorno = await request(app)
      .post(`/api/v1/core/finance/settlements/${baixaOriginal}/reverse`)
      .set(gestor)
      .send({ note: 'pagamento em duplicidade' });
    expect(estorno.status, JSON.stringify(estorno.body)).toBe(200);
    expect(estorno.body.entry.settledCents).toBe(15_000);
    expect(estorno.body.entry.balanceCents).toBe(10_000);
    expect(estorno.body.entry.status).toBe('open');
    // O histórico PERMANECE: original marcada + contrapartida negativa.
    expect(estorno.body.settlements).toHaveLength(3);
    const negativa = estorno.body.settlements.find(
      (s: { reversesId: string | null }) => s.reversesId === baixaOriginal,
    );
    expect(negativa?.amountCents).toBe(-10_000);

    resumo = (await entradas('out')).summary;
    expect(resumo.openCents).toBe(10_000);
    expect(resumo.settledCents).toBe(15_000);

    // Quita de novo, e desta vez fica quitada.
    const fim = await request(app)
      .post(`/api/v1/core/finance/entries/${contaId}/settle`)
      .set(gestor)
      .send({ amountCents: 10_000 });
    expect(fim.status).toBe(200);
    expect(fim.body.entry.status).toBe('settled');
    expect((await entradas('out')).summary.settledCents).toBe(25_000);

    // ------------------------------------------------ atraso vira "vencida"
    const ontem = somarDias(hojeNaLoja(), -1);
    const atrasada = await request(app)
      .post('/api/v1/core/finance/entries')
      .set(gestor)
      .send({
        direction: 'out',
        description: 'NF 124 · Fornecedor Têxtil',
        amountCents: 4_000,
        dueDate: ontem,
        categoryId: fornecedor.id,
      });
    expect(atrasada.status).toBe(201);
    expect(atrasada.body.overdue).toBe(true);

    const vencidas = await request(app)
      .get('/api/v1/core/finance/entries?direction=out&situation=overdue')
      .set(gestor);
    expect(vencidas.status).toBe(200);
    expect(vencidas.body.items.map((e: { id: string }) => e.id)).toEqual([atrasada.body.id]);
    expect(vencidas.body.summary.overdueCents).toBe(4_000);
    expect(vencidas.body.summary.openCents).toBe(4_000);

    // A linha do DRE acompanha: 250,00 + 40,00 na MESMA categoria.
    demo = await dre();
    expect(linhaDoDre(demo.expense, 'fornecedor')?.totalCents).toBe(29_000);
    expect(linhaDoDre(demo.expense, 'fornecedor')?.entryCount).toBe(2);
  });
});

describe('a base da comissão, afirmada pela rota', () => {
  it('desconto de cabeçalho reduz a base; o acréscimo NÃO entra nela', async () => {
    await comissaoDe(500); // 5%

    // Subtotal 2 × 250,00 = 500,00; desconto de rodapé 20,00 (4%, dentro da
    // alçada); acréscimo 15,00. Total cobrado = 495,00.
    const venda = await vender(
      {
        items: [{ productId: produto, quantity: 2 }],
        discountCents: 2_000,
        surchargeCents: 1_500,
        payments: [{ method: 'dinheiro', amountCents: 49_500 }],
        sellerId: vendedorId,
      },
      'audit-fase8-base-comissao',
    );
    expect(venda.total_cents).toBe(49_500);

    const [linha] = linhasDeComissao();
    expect(linha, 'a venda deveria ter gerado comissão').toBeTruthy();
    // A REGRA REAL: base = subtotal − desconto de cabeçalho = 48.000.
    // Nem o total cobrado (49.500, que embute o acréscimo), nem o bruto.
    expect(linha.base_cents).toBe(48_000);
    expect(linha.amount_cents).toBe(2_400); // 5% de 480,00
    // Se o acréscimo entrasse na base, seriam 2.475 — e este número é o que
    // NÃO pode aparecer.
    expect(linha.amount_cents).not.toBe(2_475);
  });
});
