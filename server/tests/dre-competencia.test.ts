/**
 * ============================================================================
 * O DRE — E A ÚNICA COISA QUE UM TESTE DE RELATÓRIO FINANCEIRO PRECISA PROVAR
 * ============================================================================
 *
 * Um relatório de dinheiro erra de um jeito que nenhum outro código erra: o
 * número sai PLAUSÍVEL. Ninguém abre o banco para conferir R$ 594,00; abre-se
 * a tela, o valor parece razoável, e ele vira base de imposto.
 *
 * Por isso a conta do primeiro grupo está ESCRITA À MÃO, parcela por parcela,
 * dentro do próprio teste. Se a soma esperada viesse da mesma consulta que
 * produz o relatório, o teste provaria apenas que a consulta é igual a si
 * mesma — e continuaria verde com a devolução contada duas vezes, que é
 * exatamente o defeito que derrubou a primeira versão desta rodada.
 *
 * COMO CADA GRUPO FALHA (verificado quebrando de propósito):
 *
 *   - somando a devolução também como redutora da receita, o resultado do
 *     primeiro cenário cai de R$ 594,00 para R$ 394,00 e quatro asserções
 *     estouram;
 *   - trocando `cancelled_at IS NULL` por `status <> 'cancelled'` em
 *     `IncomeStatementService`, o grupo do cancelamento fica vermelho na
 *     asserção que vem DEPOIS da baixa — e só nela, que é o ponto;
 *   - devolvendo `POST /finance/entries` ao formato antigo (seis campos), o
 *     grupo dos quatro campos falha nos quatro;
 *   - tirando `seedSystemCategories` do passo 56, o grupo do backfill falha
 *     com todas as categorias ainda nulas — a migração verde que não faz nada;
 *   - mapeando o backfill só por `origin_type`, a taxa de cartão sai
 *     classificada como "Venda de mercadoria" e a asserção de direção estoura.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { loginForTest } from './helpers/auth.js';
import { incomeStatement } from '../src/services/core/IncomeStatementService.js';
import { systemCategoryId } from '../src/services/core/FinanceSetupService.js';
import { migrateCoreSchema } from '../src/db/core-migrations.js';
import { diaDaLoja } from '../src/services/core/CalendarioOperacional.js';

const app = createApp();
const EMPRESA = 'loja-dre';

let auth: { Authorization: string };
let companyId: string;

/**
 * O dia de hoje DA LOJA — competência de tudo que o cenário monta.
 *
 * ERA `new Date().toISOString().slice(0, 10)`, que é o dia de GREENWICH — e
 * este arquivo inteiro existe para provar que o relatório usa o dia da LOJA.
 * O teste media com uma régua e cobrava a outra.
 *
 * O sintoma tem hora marcada: das 21h à meia-noite no Amapá (UTC−3), o dia de
 * Greenwich já virou e o da loja não. A venda que o caso acabou de criar
 * competia em 30/08 (dia da loja) e a janela do relatório pedia 31/08 (dia de
 * Greenwich): receita ZERO, e três casos vermelhos sem que uma linha de código
 * de produção tivesse mudado. De manhã ficava verde de novo — a pior forma de
 * vermelho, porque ensina a rodar de novo até passar.
 *
 * `diaDaLoja` é a MESMA função que `SalesService` usa para carimbar a
 * competência e que `diaDaLojaSql` usa para cortar o período. Medir e cobrar
 * passam a usar a mesma régua.
 */
const HOJE = diaDaLoja(new Date().toISOString());

beforeEach(async () => {
  resetDbForTests();
  const res = await loginForTest(app, {
    userId: 'gerente-dre',
    companyId: EMPRESA,
    profileCodes: ['gerente_loja'],
  });
  auth = { Authorization: `Bearer ${res.body.accessToken}` };
  companyId = res.body.company.id;
});

/**
 * Um lançamento com valor, direção, origem e categoria escolhidos à mão.
 *
 * O cenário é montado assim, e não por sete jornadas de tela, porque o que
 * está sob teste é a ARITMÉTICA. As jornadas reais entram nos grupos seguintes,
 * onde o que se prova é outra coisa: que a venda, a devolução e o cancelamento
 * chegam ao relatório do jeito certo.
 */
function lancamento(o: {
  direction: 'in' | 'out';
  amountCents: number;
  origin: string;
  systemCode?: string;
  competence?: string;
  cancelledAt?: string;
  description?: string;
}): string {
  const id = randomUUID();
  const categoria = o.systemCode ? systemCategoryId(companyId, o.systemCode) : null;
  getConnection()
    .prepare(
      `INSERT INTO core_finance_entries
         (id, company_id, direction, amount_cents, status, settled_cents,
          description, origin_type, origin_id, category_id, competence_date,
          cancelled_at, created_at)
       VALUES (?, ?, ?, ?, 'open', 0, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      companyId,
      o.direction,
      o.amountCents,
      o.description ?? `Lançamento ${o.origin}`,
      o.origin,
      randomUUID(),
      categoria,
      o.competence ?? HOJE,
      o.cancelledAt ?? null,
      new Date().toISOString(),
    );
  return id;
}

/** Uma venda concluída no painel, com o total que se quiser. */
function vendaNoPainel(totalCents: number, dia = HOJE): string {
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
    .run(id, companyId, numero, totalCents, totalCents, randomUUID(), `${dia}T12:00:00.000Z`);
  return id;
}

function linha(lado: { lines: { categoryName: string; totalCents: number }[] }, nome: string) {
  return lado.lines.find((l) => l.categoryName === nome);
}

// ============================================================================
// 1. A ARITMÉTICA, CONFERIDA NA MÃO
// ============================================================================

describe('a aritmética do DRE, número por número', () => {
  /*
    O CENÁRIO, e a conta feita à mão aqui embaixo.

    RECEITA
      venda de balcão .................. R$ 1.000,00   100000
      pedido online ....................R$   329,00    32900
      receita manual sem categoria .... R$    50,00     5000
                                        -----------  --------
      total da receita ................ R$ 1.379,00   137900

    DESPESA
      taxa de cartão .................. R$    35,00     3500
      devolução a cliente ............. R$   200,00    20000
      compra de mercadoria (NF-e) ..... R$   400,00    40000
      comissão (folha) ................ R$    60,00     6000
      despesa manual sem categoria .... R$    90,00     9000
                                        -----------  --------
      total da despesa ................ R$   785,00    78500

    RESULTADO = 137900 - 78500 =        R$   594,00    59400

    FORA DA CONTA, e cada um por um motivo diferente:
      venda cancelada ................. R$   777,00   (cancelled_at preenchido)
      venda do mês passado ............ R$   500,00   (competência fora do período)

    Confira você também: 100000 + 32900 = 132900; 132900 + 5000 = 137900.
    3500 + 20000 = 23500; + 40000 = 63500; + 6000 = 69500; + 9000 = 78500.
    137900 - 78500 = 59400.
  */
  function cenario(): void {
    lancamento({ direction: 'in', amountCents: 100000, origin: 'sale', systemCode: 'venda' });
    lancamento({
      direction: 'in',
      amountCents: 32900,
      origin: 'ecommerce_order',
      systemCode: 'venda',
    });
    lancamento({ direction: 'in', amountCents: 5000, origin: 'manual' });

    lancamento({ direction: 'out', amountCents: 3500, origin: 'sale', systemCode: 'taxa_cartao' });
    lancamento({
      direction: 'out',
      amountCents: 20000,
      origin: 'sale_return',
      systemCode: 'devolucao',
    });
    lancamento({
      direction: 'out',
      amountCents: 40000,
      origin: 'nfe_entrada',
      systemCode: 'fornecedor',
    });
    lancamento({ direction: 'out', amountCents: 6000, origin: 'manual', systemCode: 'folha' });
    lancamento({ direction: 'out', amountCents: 9000, origin: 'manual' });

    lancamento({
      direction: 'in',
      amountCents: 77700,
      origin: 'sale',
      systemCode: 'venda',
      cancelledAt: new Date().toISOString(),
    });
    lancamento({
      direction: 'in',
      amountCents: 50000,
      origin: 'sale',
      systemCode: 'venda',
      competence: '2020-01-15',
    });
  }

  it('receita, despesa e resultado batem com a conta escrita à mão', () => {
    cenario();
    const dre = incomeStatement(companyId, HOJE, HOJE);

    expect(dre.revenue.totalCents).toBe(137900);
    expect(dre.expense.totalCents).toBe(78500);
    expect(dre.resultCents).toBe(59400);

    // A contagem também: oito lançamentos entram, dois ficam de fora.
    expect(dre.revenue.entryCount).toBe(3);
    expect(dre.expense.entryCount).toBe(5);
  });

  it('a RECEITA sai por categoria — não só a despesa', () => {
    cenario();
    const dre = incomeStatement(companyId, HOJE, HOJE);

    // Venda de balcão e pedido online compartilham a categoria de sistema
    // 'venda': 100000 + 32900.
    expect(linha(dre.revenue, 'Venda de mercadoria')?.totalCents).toBe(132900);
    expect(linha(dre.revenue, 'Venda de mercadoria')?.entryCount).toBe(2);
    expect(linha(dre.revenue, 'Sem categoria')?.totalCents).toBe(5000);
  });

  it('a despesa sai por categoria, e cada uma com o valor exato', () => {
    cenario();
    const dre = incomeStatement(companyId, HOJE, HOJE);

    expect(linha(dre.expense, 'Taxa de cartão')?.totalCents).toBe(3500);
    expect(linha(dre.expense, 'Devolução a cliente')?.totalCents).toBe(20000);
    expect(linha(dre.expense, 'Compra de mercadoria')?.totalCents).toBe(40000);
    expect(linha(dre.expense, 'Folha e pró-labore')?.totalCents).toBe(6000);
    expect(linha(dre.expense, 'Sem categoria')?.totalCents).toBe(9000);
  });

  it('a DEVOLUÇÃO entra UMA vez, e do lado da despesa', () => {
    cenario();
    const dre = incomeStatement(companyId, HOJE, HOJE);

    // Uma linha só, com o valor cheio.
    const devolucoes = dre.expense.lines.filter((l) => l.categoryName === 'Devolução a cliente');
    expect(devolucoes).toHaveLength(1);
    expect(devolucoes[0].totalCents).toBe(20000);
    expect(devolucoes[0].entryCount).toBe(1);

    // E NÃO aparece do lado da receita, nem como redutora.
    expect(dre.revenue.lines.some((l) => l.categoryName === 'Devolução a cliente')).toBe(false);
    // A receita continua cheia: 137900, e não 137900 - 20000.
    expect(dre.revenue.totalCents).toBe(137900);

    // A prova aritmética de que ela foi subtraída UMA vez: contada duas, o
    // resultado seria 39400.
    expect(dre.resultCents).toBe(59400);
  });

  it('cada lançamento entra em exatamente uma linha — a partição é total e disjunta', () => {
    cenario();
    const dre = incomeStatement(companyId, HOJE, HOJE);

    // Soma das linhas dos dois lados = soma bruta de tudo que conta.
    const somaDasLinhas =
      dre.revenue.lines.reduce((a, l) => a + l.totalCents, 0) +
      dre.expense.lines.reduce((a, l) => a + l.totalCents, 0);
    expect(somaDasLinhas).toBe(137900 + 78500);

    // Contagem: oito lançamentos, nenhum a mais, nenhum a menos.
    const somaDosCount =
      dre.revenue.lines.reduce((a, l) => a + l.entryCount, 0) +
      dre.expense.lines.reduce((a, l) => a + l.entryCount, 0);
    expect(somaDosCount).toBe(8);
  });

  it('o lançamento sem categoria tem casa própria em cada lado, e é contado uma vez', () => {
    cenario();
    const dre = incomeStatement(companyId, HOJE, HOJE);

    expect(dre.uncategorized.entryCount).toBe(2);
    expect(dre.uncategorized.revenueCents).toBe(5000);
    expect(dre.uncategorized.expenseCents).toBe(9000);

    // A ressalva NOMEIA o número — a linha que só aparece quando é verdade.
    expect(dre.caveats.some((f) => f.includes('2 lançamento(s) sem categoria'))).toBe(true);
  });

  it('sem lançamento sem categoria, a ressalva não inventa a linha', () => {
    lancamento({ direction: 'in', amountCents: 1000, origin: 'sale', systemCode: 'venda' });
    const dre = incomeStatement(companyId, HOJE, HOJE);

    expect(dre.uncategorized.entryCount).toBe(0);
    expect(dre.caveats.some((f) => f.includes('sem categoria'))).toBe(false);
    // E as ressalvas fixas continuam lá: elas nunca dependem do dado.
    expect(dre.caveats.some((f) => f.includes('CMV'))).toBe(true);
    expect(dre.caveats.some((f) => f.includes('COMPETÊNCIA'))).toBe(true);
  });
});

// ============================================================================
// 2. O CRITÉRIO DO QUE ENTRA — E O CENÁRIO QUE DERRUBOU O ANTERIOR
// ============================================================================

describe('venda cancelada não conta, e continua não contando depois da baixa', () => {
  async function produto(nome: string, preco: number, qtd: number): Promise<string> {
    const p = await request(app)
      .post('/api/v1/core/products')
      .set(auth)
      .send({ name: nome, priceCents: preco });
    await request(app).post('/api/v1/core/stock/movements').set(auth).send({
      productId: p.body.id,
      movementType: 'in',
      quantity: qtd,
      referenceType: 'entrada',
      referenceId: `carga-${p.body.id}`,
    });
    return p.body.id as string;
  }

  /**
   * Venda a prazo: nasce em aberto, então é possível dar baixa nela.
   *
   * Exige cliente identificado — venda sem pagamento é conta a receber, e o
   * servidor recusa uma conta a receber de ninguém.
   */
  async function vendaFiada(productId: string, quantity: number) {
    const cliente = await request(app)
      .post('/api/v1/core/customers')
      .set(auth)
      .send({ name: 'Cliente do Fiado' });
    expect(cliente.status).toBe(201);
    const res = await request(app)
      .post('/api/v1/core/sales')
      .set(auth)
      .send({
        idempotencyKey: randomUUID(),
        items: [{ productId, quantity }],
        payments: [],
        customerId: cliente.body.id,
      });
    expect(res.status).toBe(201);
    return (res.body.sale ?? res.body) as { id: string };
  }

  it('cancelar tira a receita, e a baixa posterior NÃO a traz de volta', async () => {
    const p = await produto('Capacete', 30000, 5);
    const venda = await vendaFiada(p, 1);

    const antes = incomeStatement(companyId, HOJE, HOJE);
    expect(antes.revenue.totalCents).toBe(30000);

    const cancel = await request(app)
      .post(`/api/v1/core/sales/${venda.id}/cancel`)
      .set(auth)
      .send({ reason: 'Cliente desistiu' });
    expect(cancel.status).toBe(200);

    const depois = incomeStatement(companyId, HOJE, HOJE);
    expect(depois.revenue.totalCents).toBe(0);
    expect(depois.resultCents).toBe(0);

    const lanc = getConnection()
      .prepare(
        "SELECT id, status, cancelled_at FROM core_finance_entries WHERE origin_type = 'sale' AND origin_id = ?",
      )
      .get(venda.id) as { id: string; status: string; cancelled_at: string | null };
    expect(lanc.status).toBe('cancelled');
    expect(lanc.cancelled_at).toBeTruthy();

    /*
      O CENÁRIO QUE DERRUBOU `status <> 'cancelled'`.

      Dar baixa num lançamento cancelado fazia `aplicarStatus` recalcular o
      status a partir do saldo — a linha voltava para 'settled' e a receita
      cancelada reaparecia no relatório. Agora a baixa é RECUSADA na entrada.
    */
    const baixa = await request(app)
      .post(`/api/v1/core/finance/entries/${lanc.id}/settle`)
      .set(auth)
      .send({ amountCents: 30000 });
    expect(baixa.status).toBe(409);
    expect(baixa.body.error?.code ?? baixa.body.code).toBe('CORE_FINANCE_ENTRY_CANCELLED');

    /*
      E O CRITÉRIO RESISTE MESMO SEM O GUARDA.

      A recusa acima é a porta da frente. Aqui o teste simula o que qualquer
      outro escritor faria — o que `aplicarStatus` fazia sozinho — mexendo no
      status direto no banco. Se o relatório dependesse de `status`, esta
      linha sozinha ressuscitaria a receita.
    */
    getConnection()
      .prepare(
        "UPDATE core_finance_entries SET status = 'settled', settled_cents = amount_cents WHERE id = ?",
      )
      .run(lanc.id);

    const aindaDepois = incomeStatement(companyId, HOJE, HOJE);
    expect(aindaDepois.revenue.totalCents).toBe(0);
  });

  it('cancelar venda com devolução parcial não deixa despesa órfã no resultado', async () => {
    const p = await produto('Pneu', 20000, 10);
    const res = await request(app)
      .post('/api/v1/core/sales')
      .set(auth)
      .send({
        idempotencyKey: randomUUID(),
        items: [{ productId: p, quantity: 2 }],
        payments: [{ method: 'dinheiro', amountCents: 40000 }],
      });
    const venda = res.body.sale ?? res.body;

    const devolviveis = await request(app)
      .get(`/api/v1/core/sales/${venda.id}/returnable`)
      .set(auth);
    const dev = await request(app)
      .post('/api/v1/core/sale-returns')
      .set(auth)
      .send({
        saleId: venda.id,
        reason: 'Peça errada',
        items: [{ saleItemId: devolviveis.body.items[0].sale_item_id, quantity: 1 }],
      });
    expect(dev.status).toBe(201);

    // Antes do cancelamento: R$ 400,00 de receita e R$ 200,00 de devolução.
    const comDevolucao = incomeStatement(companyId, HOJE, HOJE);
    expect(comDevolucao.revenue.totalCents).toBe(40000);
    expect(comDevolucao.expense.totalCents).toBe(20000);
    expect(comDevolucao.resultCents).toBe(20000);

    await request(app)
      .post(`/api/v1/core/sales/${venda.id}/cancel`)
      .set(auth)
      .send({ reason: 'Venda inteira desfeita' });

    /*
      A VENDA INTEIRA CAIU, E A DEVOLUÇÃO DELA CAIU JUNTO.

      Sem isto o relatório mostraria receita zero e despesa de R$ 200,00 — um
      prejuízo do tamanho do que foi devolvido, de uma venda que o sistema diz
      que nunca aconteceu.
    */
    const depois = incomeStatement(companyId, HOJE, HOJE);
    expect(depois.revenue.totalCents).toBe(0);
    expect(depois.expense.totalCents).toBe(0);
    expect(depois.resultCents).toBe(0);
  });

  it('a devolução de uma venda viva entra uma vez só, como despesa', async () => {
    const p = await produto('Correia', 5000, 10);
    const res = await request(app)
      .post('/api/v1/core/sales')
      .set(auth)
      .send({
        idempotencyKey: randomUUID(),
        items: [{ productId: p, quantity: 4 }],
        payments: [{ method: 'dinheiro', amountCents: 20000 }],
      });
    const venda = res.body.sale ?? res.body;
    const devolviveis = await request(app)
      .get(`/api/v1/core/sales/${venda.id}/returnable`)
      .set(auth);
    await request(app)
      .post('/api/v1/core/sale-returns')
      .set(auth)
      .send({
        saleId: venda.id,
        reason: 'Uma unidade a mais',
        items: [{ saleItemId: devolviveis.body.items[0].sale_item_id, quantity: 1 }],
      });

    const dre = incomeStatement(companyId, HOJE, HOJE);
    // Conta à mão: receita 20000, devolução 5000, resultado 15000.
    expect(dre.revenue.totalCents).toBe(20000);
    expect(linha(dre.expense, 'Devolução a cliente')?.totalCents).toBe(5000);
    expect(dre.expense.totalCents).toBe(5000);
    expect(dre.resultCents).toBe(15000);
  });
});

// ============================================================================
// 3. PAINEL x DRE — A DIFERENÇA É NOMEADA ATÉ O ÚLTIMO CENTAVO
// ============================================================================

describe('painel e DRE contam conjuntos diferentes, e a diferença tem nome', () => {
  it('o pedido online é a diferença, e ela sai nomeada', () => {
    // O painel soma VENDAS: R$ 1.074,75 em duas vendas de balcão.
    vendaNoPainel(100000);
    vendaNoPainel(7475);
    // O DRE soma LANÇAMENTOS: as mesmas duas vendas, mais o pedido online.
    lancamento({ direction: 'in', amountCents: 100000, origin: 'sale', systemCode: 'venda' });
    lancamento({ direction: 'in', amountCents: 7475, origin: 'sale', systemCode: 'venda' });
    lancamento({
      direction: 'in',
      amountCents: 32900,
      origin: 'ecommerce_order',
      systemCode: 'venda',
    });

    const dre = incomeStatement(companyId, HOJE, HOJE);
    const c = dre.reconciliation;

    // Os dois números da tela, escritos à mão: 107475 e 140375.
    expect(c.panelRevenueCents).toBe(107475);
    expect(c.statementRevenueCents).toBe(140375);
    expect(c.differenceCents).toBe(32900);

    // E a diferença NÃO é um link mudo: ela é uma parcela com nome.
    expect(c.lines).toHaveLength(1);
    expect(c.lines[0].key).toBe('ecommerce_order');
    expect(c.lines[0].cents).toBe(32900);
    expect(c.lines[0].label).toContain('Pedido online');
  });

  it('toda origem que entra na conciliação tem NOME DA CASA — nenhuma cai no genérico', () => {
    /*
      O DEFEITO: `ROTULO_DA_ORIGEM` nomeava cinco origens e o sistema escreve
      SEIS em `core_finance_entries`. A compra sem nota fiscal (GAP-V17) grava
      `entrada_manual` — origem própria, de propósito, para a compra digitada
      não se apresentar como NF-e —, e o mapa não a conhecia: a linha da
      conciliação saía com o fallback `Origem "entrada_manual"`, com aspas e
      underscore, no meio de um relatório que o contador lê.

      "Origem do jeito que o banco escreveu" não é rótulo: é o nome interno da
      coluna vazando para a tela. E é o mesmo esquecimento do outro lado
      (`FinanceService.ORIGEM_LEGIVEL_SQL`) — quem acrescentou a origem no
      ESCRITOR não voltou a nenhum dos dois LEITORES.

      A varredura cobra as CINCO origens de receita com documento; se um dia
      uma sétima aparecer sem rótulo, o `Origem "…"` denuncia aqui.
    */
    vendaNoPainel(10000);
    lancamento({ direction: 'in', amountCents: 10000, origin: 'sale', systemCode: 'venda' });
    lancamento({ direction: 'in', amountCents: 1100, origin: 'ecommerce_order' });
    lancamento({ direction: 'in', amountCents: 1200, origin: 'manual' });
    lancamento({ direction: 'in', amountCents: 1300, origin: 'sale_return' });
    lancamento({ direction: 'in', amountCents: 1400, origin: 'nfe_entrada' });
    lancamento({ direction: 'in', amountCents: 1500, origin: 'entrada_manual' });

    const c = incomeStatement(companyId, HOJE, HOJE).reconciliation;

    // Nenhuma linha pode exibir o nome cru da coluna.
    for (const l of c.lines) {
      expect(l.label, `origem sem rótulo da casa: ${l.key}`).not.toMatch(/^Origem "/);
    }

    const rotulo = (chave: string) => c.lines.find((l) => l.key === chave)?.label ?? '';
    expect(rotulo('ecommerce_order')).toContain('Pedido online');
    expect(rotulo('manual')).toContain('Lançamento manual');
    expect(rotulo('sale_return')).toContain('Devolução');
    expect(rotulo('nfe_entrada')).toContain('Entrada de NF-e');
    // A que faltava, com o nome que a loja usa — e sem aspas nem underscore.
    expect(rotulo('entrada_manual')).toContain('Entrada manual');

    // E a conciliação continua fechando: rótulo novo não mexe em centavo.
    expect(c.lines.reduce((a, l) => a + l.cents, 0)).toBe(c.differenceCents);
  });

  it('a soma das parcelas nomeadas é exatamente a diferença', () => {
    vendaNoPainel(50000);
    lancamento({ direction: 'in', amountCents: 50000, origin: 'sale', systemCode: 'venda' });
    lancamento({ direction: 'in', amountCents: 12345, origin: 'ecommerce_order' });
    lancamento({ direction: 'in', amountCents: 777, origin: 'manual' });

    const c = incomeStatement(companyId, HOJE, HOJE).reconciliation;
    const soma = c.lines.reduce((a, l) => a + l.cents, 0);
    expect(soma).toBe(c.differenceCents);
    expect(c.differenceCents).toBe(12345 + 777);
  });

  it('venda contada em datas diferentes vira parcela com nome, não sobra sem explicação', () => {
    // A venda aconteceu hoje; o lançamento dela competiu ontem (o caso do
    // ajuste manual de competência). O painel vê hoje, o DRE vê ontem.
    vendaNoPainel(30000);
    lancamento({
      direction: 'in',
      amountCents: 30000,
      origin: 'sale',
      systemCode: 'venda',
      competence: '2020-01-01',
    });

    const c = incomeStatement(companyId, HOJE, HOJE).reconciliation;
    expect(c.panelRevenueCents).toBe(30000);
    expect(c.statementRevenueCents).toBe(0);
    expect(c.differenceCents).toBe(-30000);
    expect(c.lines.some((l) => l.key === 'criterio_de_data' && l.cents === -30000)).toBe(true);
    expect(c.lines.reduce((a, l) => a + l.cents, 0)).toBe(c.differenceCents);
  });

  it('o painel conta o ÚLTIMO dia do período', async () => {
    // A venda cai às 12h do dia final. Com a comparação crua de timestamp
    // contra data, `'...T12:00:00.000Z' <= '<dia>'` é falso e ela sumia.
    vendaNoPainel(45000, '2026-03-31');
    const res = await request(app)
      .get('/api/v1/core/dashboard?from=2026-03-01&to=2026-03-31')
      .set(auth);
    expect(res.status).toBe(200);
    expect(res.body.revenueCents).toBe(45000);
    expect(res.body.salesCount).toBe(1);
  });
});

// ============================================================================
// 4. A ROTA — OS QUATRO CAMPOS, O FILTRO E O ALCANCE
// ============================================================================

describe('a rota de lançamento repassa os quatro campos', () => {
  it('categoria, centro de custo, conta e competência chegam ao banco', async () => {
    const setup = await request(app).get('/api/v1/core/finance/setup').set(auth);
    expect(setup.status).toBe(200);
    const categoria = (setup.body.categories as { id: string; direction: string }[]).find(
      (c) => c.direction === 'out',
    )!;

    const centro = await request(app)
      .post('/api/v1/core/finance/cost-centers')
      .set(auth)
      .send({ code: 'ADM', name: 'Administrativo' });
    expect(centro.status).toBe(201);

    const conta = await request(app)
      .post('/api/v1/core/finance/accounts')
      .set(auth)
      .send({ name: 'Banco do Grupo', kind: 'banco' });
    expect(conta.status).toBe(201);

    const criado = await request(app)
      .post('/api/v1/core/finance/entries')
      .set(auth)
      .send({
        direction: 'out',
        description: 'Aluguel de março',
        amountCents: 250000,
        dueDate: '2026-04-05',
        categoryId: categoria.id,
        costCenterId: centro.body.costCenter.id,
        accountId: conta.body.account.id,
        competenceDate: '2026-03-31',
      });
    expect(criado.status).toBe(201);

    /*
      A CONFERÊNCIA É NO BANCO, e a chamada foi por HTTP.

      Chamar `createEntry` direto passaria com a rota exatamente como ela
      estava — ela montava o objeto nomeando seis campos e descartava estes
      quatro em silêncio. É o formato de defeito da rodada 22: serviço certo,
      rota que não repassa, suíte verde.
    */
    const row = getConnection()
      .prepare(
        `SELECT category_id, cost_center_id, account_id, competence_date
           FROM core_finance_entries WHERE id = ?`,
      )
      .get(criado.body.id) as Record<string, string | null>;

    expect(row.category_id).toBe(categoria.id);
    expect(row.cost_center_id).toBe(centro.body.costCenter.id);
    expect(row.account_id).toBe(conta.body.account.id);
    expect(row.competence_date).toBe('2026-03-31');
  });

  it('recusa categoria do lado errado — receita não classifica despesa', async () => {
    const setup = await request(app).get('/api/v1/core/finance/setup').set(auth);
    const receita = (setup.body.categories as { id: string; direction: string }[]).find(
      (c) => c.direction === 'in',
    )!;

    const res = await request(app)
      .post('/api/v1/core/finance/entries')
      .set(auth)
      .send({
        direction: 'out',
        description: 'Conta de luz',
        amountCents: 10000,
        categoryId: receita.id,
      });
    expect(res.status).toBe(400);
    expect(res.body.error?.code ?? res.body.code).toBe('CORE_FINANCE_CATEGORY_DIRECTION');
  });
});

describe('o filtro por categoria chega no serviço', () => {
  it('a lista devolve só a categoria pedida', async () => {
    const setup = await request(app).get('/api/v1/core/finance/setup').set(auth);
    const categorias = setup.body.categories as { id: string; direction: string; system_code: string | null }[];
    const folha = categorias.find((c) => c.system_code === 'folha')!;
    const imposto = categorias.find((c) => c.system_code === 'imposto')!;

    for (const [cat, desc] of [
      [folha.id, 'Pró-labore'],
      [imposto.id, 'DAS'],
    ] as const) {
      const r = await request(app)
        .post('/api/v1/core/finance/entries')
        .set(auth)
        .send({ direction: 'out', description: desc, amountCents: 5000, categoryId: cat });
      expect(r.status).toBe(201);
    }
    await request(app)
      .post('/api/v1/core/finance/entries')
      .set(auth)
      .send({ direction: 'out', description: 'Sem classificação', amountCents: 5000 });

    const todos = await request(app).get('/api/v1/core/finance/entries').set(auth);
    expect(todos.body.items).toHaveLength(3);

    const soFolha = await request(app)
      .get(`/api/v1/core/finance/entries?categoryId=${folha.id}`)
      .set(auth);
    expect(soFolha.body.items).toHaveLength(1);
    expect(soFolha.body.items[0].description).toBe('Pró-labore');
    // A linha mostra a categoria pela qual foi filtrada — filtro sem leitor
    // deixaria quem filtrou sem como conferir o resultado.
    expect(soFolha.body.items[0].categoryName).toBe('Folha e pró-labore');

    const semCategoria = await request(app)
      .get('/api/v1/core/finance/entries?categoryId=sem-categoria')
      .set(auth);
    expect(semCategoria.body.items).toHaveLength(1);
    expect(semCategoria.body.items[0].description).toBe('Sem classificação');
  });
});

describe('o alcance das rotas novas bate com a tela', () => {
  /**
   * A tela do DRE é ROTA_GESTAO, que no roteador do navegador inclui
   * estoquista e atendente. Guarda mais estreito que a tela quebra tela em
   * produção — é o erro que a rodada 23 existe para impedir, e ele quase foi
   * cometido na rodada seguinte.
   */
  it('atendente alcança o DRE e a lista de categorias', async () => {
    const res = await loginForTest(app, {
      userId: 'atendente-dre',
      companyId: EMPRESA,
      profileCodes: ['atendente'],
    });
    const dela = { Authorization: `Bearer ${res.body.accessToken}` };

    const dre = await request(app).get('/api/v1/core/finance/income-statement').set(dela);
    expect(dre.status).toBe(200);

    const cats = await request(app).get('/api/v1/core/finance/categories').set(dela);
    expect(cats.status).toBe(200);
    expect(cats.body.items.length).toBeGreaterThan(0);
  });

  it('mecânico não alcança nem um nem outro', async () => {
    const res = await loginForTest(app, {
      userId: 'mecanico-dre',
      companyId: EMPRESA,
      profileCodes: ['mecanico'],
    });
    const dele = { Authorization: `Bearer ${res.body.accessToken}` };

    expect((await request(app).get('/api/v1/core/finance/income-statement').set(dele)).status).toBe(
      403,
    );
    expect((await request(app).get('/api/v1/core/finance/categories').set(dele)).status).toBe(403);
  });
});

// ============================================================================
// 5. O BACKFILL DA MIGRAÇÃO 56
// ============================================================================

describe('o backfill classifica onde não havia categoria nenhuma', () => {
  /**
   * O cenário é o do banco real: quatro das seis operações têm ZERO categorias
   * cadastradas, e são justamente elas que concentram os lançamentos legados.
   * Um backfill que buscasse a categoria antes de semeá-la trocaria NULL por
   * NULL, não mudaria uma linha, e o passo seria marcado como aplicado.
   */
  function empresaSemCategoriaNenhuma(): void {
    getConnection().prepare('DELETE FROM core_finance_categories WHERE company_id = ?').run(companyId);
    const quantas = getConnection()
      .prepare('SELECT COUNT(*) AS n FROM core_finance_categories WHERE company_id = ?')
      .get(companyId) as { n: number };
    expect(Number(quantas.n)).toBe(0);
  }

  function categoriaDe(entryId: string): { system_code: string | null; direction: string } | null {
    const row = getConnection()
      .prepare(
        `SELECT cat.system_code, cat.direction
           FROM core_finance_entries e
           LEFT JOIN core_finance_categories cat ON cat.id = e.category_id
          WHERE e.id = ?`,
      )
      .get(entryId) as { system_code: string | null; direction: string } | undefined;
    return row?.system_code ? { system_code: row.system_code, direction: row.direction } : null;
  }

  it('muda linha: parcela vira receita e taxa de cartão vira despesa, na MESMA origem', () => {
    empresaSemCategoriaNenhuma();

    const parcela = lancamento({ direction: 'in', amountCents: 100000, origin: 'sale' });
    const taxa = lancamento({ direction: 'out', amountCents: 3500, origin: 'sale' });
    const pedido = lancamento({ direction: 'in', amountCents: 32900, origin: 'ecommerce_order' });
    const devolucao = lancamento({ direction: 'out', amountCents: 20000, origin: 'sale_return' });
    const compra = lancamento({ direction: 'out', amountCents: 40000, origin: 'nfe_entrada' });
    const manual = lancamento({ direction: 'out', amountCents: 9000, origin: 'manual' });

    // Antes: nada classificado. Se o passo não mudar linha, isto continua.
    for (const id of [parcela, taxa, pedido, devolucao, compra, manual]) {
      expect(categoriaDe(id)).toBeNull();
    }

    getConnection().exec("DELETE FROM core_meta WHERE key = 'core_migration_step_56';");
    migrateCoreSchema();

    /*
      O MAPA É POR ORIGEM **E** DIREÇÃO.

      `origin_type = 'sale'` produz as duas linhas abaixo. Mapear só por origem
      carimbaria "Venda de mercadoria" — categoria de RECEITA — no lançamento
      de SAÍDA da taxa de cartão.
    */
    expect(categoriaDe(parcela)).toEqual({ system_code: 'venda', direction: 'in' });
    expect(categoriaDe(taxa)).toEqual({ system_code: 'taxa_cartao', direction: 'out' });
    expect(categoriaDe(pedido)).toEqual({ system_code: 'venda', direction: 'in' });
    expect(categoriaDe(devolucao)).toEqual({ system_code: 'devolucao', direction: 'out' });
    expect(categoriaDe(compra)).toEqual({ system_code: 'fornecedor', direction: 'out' });

    // O manual continua sem categoria: não há origem que diga para que o
    // dinheiro foi, e chutar seria inventar classificação.
    expect(categoriaDe(manual)).toBeNull();
  });

  it('o DRE de uma empresa legada deixa de ser uma linha só de "sem categoria"', () => {
    empresaSemCategoriaNenhuma();
    lancamento({ direction: 'in', amountCents: 100000, origin: 'sale' });
    lancamento({ direction: 'out', amountCents: 40000, origin: 'nfe_entrada' });

    const antes = incomeStatement(companyId, HOJE, HOJE);
    expect(antes.revenue.lines[0].categoryId).toBeNull();
    expect(antes.uncategorized.entryCount).toBe(2);

    getConnection().exec("DELETE FROM core_meta WHERE key = 'core_migration_step_56';");
    migrateCoreSchema();

    const depois = incomeStatement(companyId, HOJE, HOJE);
    expect(depois.uncategorized.entryCount).toBe(0);
    expect(linha(depois.revenue, 'Venda de mercadoria')?.totalCents).toBe(100000);
    expect(linha(depois.expense, 'Compra de mercadoria')?.totalCents).toBe(40000);
    // E o total não muda: classificar não cria nem destrói dinheiro.
    expect(depois.revenue.totalCents).toBe(antes.revenue.totalCents);
    expect(depois.resultCents).toBe(60000);
  });

  it('não escreve por cima de classificação feita por gente', () => {
    // A categoria de IMPOSTO num lançamento de NF-e: alguém decidiu isso, e a
    // máquina não desfaz decisão de gente.
    const imposto = systemCategoryId(companyId, 'imposto');
    const id = lancamento({
      direction: 'out',
      amountCents: 40000,
      origin: 'nfe_entrada',
      systemCode: 'imposto',
    });
    expect(imposto).toBeTruthy();

    getConnection().exec("DELETE FROM core_meta WHERE key = 'core_migration_step_56';");
    migrateCoreSchema();

    const row = getConnection()
      .prepare('SELECT category_id FROM core_finance_entries WHERE id = ?')
      .get(id) as { category_id: string };
    expect(row.category_id).toBe(imposto);
  });

  it('carimba cancelled_at nos lançamentos que já estavam cancelados', () => {
    const id = randomUUID();
    getConnection()
      .prepare(
        `INSERT INTO core_finance_entries
           (id, company_id, direction, amount_cents, status, settled_cents,
            description, origin_type, origin_id, competence_date, created_at)
         VALUES (?, ?, 'in', 77700, 'cancelled', 0, 'Venda cancelada antiga', 'sale', ?, ?, ?)`,
      )
      .run(id, companyId, randomUUID(), HOJE, new Date().toISOString());

    getConnection().exec("DELETE FROM core_meta WHERE key = 'core_migration_step_56';");
    migrateCoreSchema();

    const row = getConnection()
      .prepare('SELECT cancelled_at FROM core_finance_entries WHERE id = ?')
      .get(id) as { cancelled_at: string | null };
    expect(row.cancelled_at).toBeTruthy();
    // E o relatório continua sem ela, agora por um critério que resiste.
    expect(incomeStatement(companyId, HOJE, HOJE).revenue.totalCents).toBe(0);
  });
});
