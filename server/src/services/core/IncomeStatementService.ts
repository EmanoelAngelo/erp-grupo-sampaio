/**
 * ============================================================================
 * DRE — O RESULTADO DO PERÍODO, POR COMPETÊNCIA
 * ============================================================================
 *
 * ## A REGRA, e ela é uma frase
 *
 * **Cada lançamento entra em EXATAMENTE UMA linha do relatório.**
 *
 * O lado é a `direction` do lançamento — `in` é receita, `out` é despesa — e a
 * linha dentro do lado é a `category_id`. Não há segunda passagem, não há
 * ajuste, não há linha "redutora": um fato econômico é contado uma vez, no
 * lado em que ele nasceu.
 *
 * ## Por que essa regra existe escrita, e não implícita no SQL
 *
 * A primeira versão deste relatório somava a devolução DUAS vezes — tirava do
 * faturamento (porque devolução reduz receita) e somava nas despesas por grupo
 * (porque a linha dela é `direction = 'out'`). Pela mesma porta, a entrada sem
 * categoria era contada duas vezes: uma no total e outra na linha "outros".
 * Num cenário de nove lançamentos a conta errava R$ 100,00.
 *
 * Ninguém escreveu isso de propósito. Aconteceu porque a aritmética estava
 * espalhada por três consultas que se pareciam, cada uma somando um recorte, e
 * a soma dos recortes não era o todo. Num relatório financeiro esse é o pior
 * defeito possível: o número sai plausível, ninguém confere, e alguém paga
 * imposto sobre ele.
 *
 * Então a aritmética mora aqui, em UMA passagem, sobre UMA consulta:
 *
 *   1. uma consulta traz os lançamentos do período;
 *   2. um laço classifica cada um em um par (lado, categoria);
 *   3. três invariantes são CONFERIDAS antes de devolver — e estouram se
 *      falharem, em vez de devolver número errado com cara de certo.
 *
 * As invariantes são a prova de que a partição é total e disjunta:
 *
 *   - nenhum id aparece duas vezes;
 *   - a soma dos dois lados é igual à soma bruta de tudo que a consulta trouxe;
 *   - a soma das linhas de cada lado é igual ao total daquele lado.
 *
 * ## O QUE ENTRA: `cancelled_at IS NULL`, e não `status <> 'cancelled'`
 *
 * O critério óbvio não resiste, e o cenário que o derruba tem dois passos:
 *
 *   1. cancela-se a venda — as linhas dela viram `status = 'cancelled'`;
 *   2. alguém dá baixa numa delas — `aplicarStatus` recalcula o status a
 *      partir do saldo e devolve a linha para 'open' ou 'settled'.
 *
 * A receita da venda cancelada volta ao relatório sozinha. `status` é um campo
 * DERIVADO do saldo; usá-lo como memória de um ato humano é confundir duas
 * coisas diferentes. `cancelled_at` é carimbo: quem cancelou, cancelou, e
 * nenhuma baixa reescreve isso. (A baixa em lançamento cancelado, além disso,
 * passou a ser RECUSADA — ver `FinanceService.settleEntry`.)
 *
 * ## A DATA: competência, com escada de fallback
 *
 * O mês é o de `competence_date`. Lançamento com competência nula não cairia
 * em mês nenhum e SUMIRIA do relatório em silêncio — que é a forma mais cara
 * de um número financeiro errar. A migração 56 preenche o que já existe; o
 * COALESCE abaixo garante que nenhum escritor futuro consiga fazer um
 * lançamento desaparecer por esquecimento.
 *
 * ## O QUE ESTE RELATÓRIO NÃO É
 *
 * Não é regime de CAIXA, e não dá para construir um hoje: `core_finance_settlements`
 * tem zero linhas no banco real e sete dos nove lançamentos têm `settled_cents`
 * maior que zero — a baixa acontece sem registrar baixa. Um "caixa" montado
 * sobre isso seria adivinhação com cara de extrato.
 *
 * ## O CMV EXISTE AGORA, e o que exatamente mudou (GAP-V28)
 *
 * Este texto dizia, até esta rodada, que o relatório "não tem CMV nem margem,
 * e isso é RECUSA e não adiamento: `core_sale_items` não tem coluna de custo".
 * A recusa estava certa enquanto durou — somar `quantidade × custo do
 * cadastro` sobre vendas antigas devolve um número plausível e falso, porque o
 * custo do cadastro muda a cada nota de entrada e a margem de março passaria a
 * ser recalculada com o custo de agosto. Todo mês fechado mudaria de resultado
 * sozinho.
 *
 * O que a destravou foi o SNAPSHOT: `core_sale_items.cost_cents` guarda o
 * custo unitário no momento em que a venda fecha, e é lido daí — nunca do
 * cadastro. Uma vez fotografado, o custo daquela venda não muda mais, e é isso
 * que faz o CMV ser um fato em vez de uma estimativa.
 *
 * TRÊS COISAS FICAM DITAS, porque o número sem elas voltaria a mentir:
 *
 *   1. O CMV COBRE SÓ AS VENDAS NOVAS. Linha anterior ao snapshot tem
 *      `cost_cents` nulo e é CONTADA (`itemsBeforeSnapshot`), não somada como
 *      zero. Não há backfill: inventar custo retroativo é exatamente o número
 *      que a recusa evitava.
 *   2. PRODUTO SEM CUSTO NO CADASTRO fica de fora (`itemsWithoutCost`). Custo
 *      zero devolveria 100% de margem — o mesmo defeito que
 *      `GroupInsights.marginWhereReliable` já recusa.
 *   3. O CMV NÃO É DESCONTADO DO RESULTADO. A mercadoria já entrou no DRE como
 *      DESPESA, no lançamento a pagar da nota de entrada; deduzi-la de novo
 *      contaria a mesma compra duas vezes. Ele é medida GERENCIAL exibida ao
 *      lado, com régua própria — a data da VENDA (dia da loja), a mesma do
 *      painel —, e não a competência dos lançamentos.
 *
 * O que o relatório não inclui está dito na PRÓPRIA TELA, em painel fixo, e as
 * frases saem daqui (`caveats`) justamente para que ninguém possa esquecer de
 * renderizar uma delas. Um DRE que omite a própria limitação é um número que o
 * contador usa para pagar imposto.
 */
import { getConnection } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { diaDaLojaSql } from './CalendarioOperacional.js';

/** Uma linha do relatório: uma categoria, de um lado só. */
export interface IncomeStatementLine {
  /** Nulo é a casa própria do que ninguém classificou. */
  categoryId: string | null;
  categoryName: string;
  systemCode: string | null;
  totalCents: number;
  entryCount: number;
}

export interface IncomeStatementSide {
  lines: IncomeStatementLine[];
  totalCents: number;
  entryCount: number;
}

/** Uma parcela NOMEADA da diferença entre o painel e o DRE. */
export interface ReconciliationLine {
  key: string;
  label: string;
  cents: number;
}

/**
 * Por que o painel e o DRE mostram números diferentes.
 *
 * Eles contam conjuntos diferentes, e sempre contarão: o painel soma VENDAS
 * (`core_sales` concluídas, pela data da venda) e o DRE soma LANÇAMENTOS
 * (`core_finance_entries` de entrada, pela competência). Pedido online, receita
 * de serviço e lançamento manual de receita existem no segundo e não no
 * primeiro — no banco real a diferença medida numa operação foi de R$ 329,00,
 * inteirinha de um pedido online.
 *
 * A escolha desta rodada foi NOMEAR a diferença, não forçar a igualdade:
 * fazer o painel somar lançamento transformaria a tela de vendas do dono numa
 * segunda contabilidade, e fazer o DRE somar só venda de balcão jogaria fora a
 * receita do e-commerce — que é receita.
 *
 * `differenceCents` é sempre igual à soma de `lines`. Isso é CONFERIDO, não
 * esperado: um link mudo entre dois números diferentes é o que esta estrutura
 * existe para impedir.
 */
export interface IncomeStatementReconciliation {
  panelRevenueCents: number;
  statementRevenueCents: number;
  differenceCents: number;
  lines: ReconciliationLine[];
}

/**
 * O CUSTO DA MERCADORIA VENDIDA no período — e o que ele NÃO cobre.
 *
 * Cada contagem existe para impedir uma leitura errada do número ao lado:
 * `itemsWithCost` diz sobre quantas linhas a margem foi calculada,
 * `itemsWithoutCost` quantas saíram por o produto não ter custo no cadastro, e
 * `itemsBeforeSnapshot` quantas são de antes de o sistema fotografar custo. Um
 * CMV sem as três seria lido como "o custo do mês", e ele é "o custo das
 * linhas que têm custo".
 */
export interface CostOfGoodsSold {
  /** Soma de `custo unitário × quantidade` das linhas com custo maior que zero. */
  costCents: number;
  /** A receita DAS MESMAS linhas — comparar com outra base daria margem falsa. */
  revenueCents: number;
  marginCents: number;
  /** Nulo quando não há receita considerada: "não dá para saber" ≠ "zero". */
  marginPercent: number | null;
  itemsWithCost: number;
  /** Produto vendido com o cadastro sem custo — pendência de cadastro. */
  itemsWithoutCost: number;
  /** Venda anterior ao snapshot, ou linha de serviço: não tem custo e nunca terá. */
  itemsBeforeSnapshot: number;
}

export interface IncomeStatement {
  companyId: string;
  from: string;
  to: string;
  revenue: IncomeStatementSide;
  expense: IncomeStatementSide;
  resultCents: number;
  /**
   * O CMV do período — exibido AO LADO do resultado, nunca dentro dele.
   *
   * A régua é a data da VENDA (dia da loja), a mesma do painel, e não a
   * competência dos lançamentos: o custo pertence à mercadoria que saiu, e ela
   * saiu no dia da venda.
   */
  cogs: CostOfGoodsSold;
  /** O que ninguém classificou — a linha condicional da ressalva. */
  uncategorized: {
    entryCount: number;
    revenueCents: number;
    expenseCents: number;
  };
  reconciliation: IncomeStatementReconciliation;
  /** As frases da ressalva, prontas. A tela renderiza a lista inteira. */
  caveats: string[];
}

const SEM_CATEGORIA_ID = null;
const SEM_CATEGORIA_NOME = 'Sem categoria';

/**
 * Rótulo de cada origem, para a linha de conciliação.
 *
 * ## POR QUE O MAPA PRECISA ESTAR COMPLETO
 *
 * O fallback logo abaixo escreve `Origem "entrada_manual"` — o nome interno da
 * coluna, com aspas e underscore, no meio de um relatório que o contador lê.
 * Isso não é rótulo: é a tabela vazando para a tela.
 *
 * E foi o que aconteceu. O mapa nomeava CINCO origens; o sistema escreve SEIS
 * em `core_finance_entries`. A compra sem nota fiscal (GAP-V17) grava
 * `entrada_manual` — origem própria, de propósito, para a compra digitada não
 * se apresentar como NF-e —, e quem a acrescentou no ESCRITOR não voltou a
 * nenhum dos dois LEITORES: nem a este, nem ao `ORIGEM_LEGIVEL_SQL` de
 * `FinanceService`. As duas lacunas eram o mesmo esquecimento.
 *
 * O conjunto fechado, um por escritor: 'sale' (SalesService), 'sale_return'
 * (SaleReturnService), 'nfe_entrada' e 'entrada_manual' (NfeImportService),
 * 'ecommerce_order' (StorefrontService) e 'manual' (o avulso de
 * FinanceService). Todos os seis estão aqui.
 *
 * `dre-competencia` monta uma linha de cada e recusa qualquer rótulo que
 * comece por `Origem "` — origem nova sem nome da casa fica vermelha lá.
 */
const ROTULO_DA_ORIGEM: Record<string, string> = {
  sale: 'Venda de balcão',
  ecommerce_order: 'Pedido online',
  manual: 'Lançamento manual de receita',
  sale_return: 'Devolução',
  nfe_entrada: 'Entrada de NF-e',
  // A compra sem nota fiscal. O nome é o mesmo que a tela de entrada usa e o
  // mesmo do rótulo do contas a pagar — três lugares, uma palavra só.
  entrada_manual: 'Entrada manual',
  // A conta a pagar do fechamento de comissão (GAP-PRD-174). É saída, e o
  // mapa só nomeia receita por origem hoje — mas origem escrita sem nome
  // aqui é o esquecimento que este mapa existe para impedir.
  commission_closing: 'Fechamento de comissão',
};

function rotuloDaOrigem(origem: string): string {
  return ROTULO_DA_ORIGEM[origem] ?? `Origem "${origem}"`;
}

interface LinhaCrua {
  id: string;
  direction: string;
  amount_cents: number;
  category_id: string | null;
  category_name: string | null;
  system_code: string | null;
  origin_type: string;
}

/**
 * A COLUNA QUE DECIDE O MÊS, escrita uma vez e usada nas duas pontas.
 *
 * Aparece no WHERE do relatório. Qualquer outra consulta que precise do mesmo
 * recorte usa esta constante, para que "o período do DRE" não passe a
 * significar duas coisas em dois lugares.
 */
export const COMPETENCIA = `COALESCE(e.competence_date, e.due_date, ${diaDaLojaSql('e.created_at')})`;

/** O acumulador de um lado do relatório, enquanto o laço roda. */
class LadoEmConstrucao {
  private readonly porCategoria = new Map<string, IncomeStatementLine>();

  totalCents = 0;
  entryCount = 0;

  acumular(linha: LinhaCrua): void {
    // A chave do agrupamento é o ID da categoria, e o texto vazio representa
    // "nenhuma". Usar o NOME agruparia duas categorias homônimas de pais
    // diferentes na mesma linha; usar `null` como chave de Map funciona, mas
    // esconde a intenção de quem lê.
    const chave = linha.category_id ?? '';
    const atual = this.porCategoria.get(chave) ?? {
      categoryId: linha.category_id ?? SEM_CATEGORIA_ID,
      categoryName: linha.category_name ?? SEM_CATEGORIA_NOME,
      systemCode: linha.system_code ?? null,
      totalCents: 0,
      entryCount: 0,
    };
    atual.totalCents += linha.amount_cents;
    atual.entryCount += 1;
    this.porCategoria.set(chave, atual);

    this.totalCents += linha.amount_cents;
    this.entryCount += 1;
  }

  /**
   * Fecha o lado — e CONFERE que as linhas somam o total dele.
   *
   * A conferência não é decorativa: é a única coisa que garante que agrupar não
   * perdeu nem duplicou centavo. Sem ela, um erro de acumulação sairia como um
   * relatório bonito.
   */
  fechar(): IncomeStatementSide {
    const lines = [...this.porCategoria.values()].sort(ordenarLinhas);

    const somaDasLinhas = lines.reduce((acc, l) => acc + l.totalCents, 0);
    const somaDosCount = lines.reduce((acc, l) => acc + l.entryCount, 0);
    if (somaDasLinhas !== this.totalCents || somaDosCount !== this.entryCount) {
      throw new Error(
        'DRE: as linhas não somam o total do lado — ' +
          `linhas ${somaDasLinhas} (${somaDosCount} lançamentos) contra total ` +
          `${this.totalCents} (${this.entryCount} lançamentos).`,
      );
    }

    return { lines, totalCents: this.totalCents, entryCount: this.entryCount };
  }
}

/**
 * Maior primeiro, e "Sem categoria" sempre por último.
 *
 * O que não foi classificado é o que precisa de ação, não o que precisa de
 * destaque no meio do relatório: ele tem lugar fixo no fim, onde a ressalva o
 * aponta.
 */
function ordenarLinhas(a: IncomeStatementLine, b: IncomeStatementLine): number {
  if (a.categoryId === null) return 1;
  if (b.categoryId === null) return -1;
  if (b.totalCents !== a.totalCents) return b.totalCents - a.totalCents;
  return a.categoryName.localeCompare(b.categoryName, 'pt-BR');
}

/**
 * O faturamento como o PAINEL o calcula: venda concluída, pela data da venda.
 *
 * A comparação usa o DIA DA LOJA da coluna, e não `created_at >= ?`, porque
 * `created_at` é um timestamp inteiro e o limite superior chega como data: com
 * a comparação crua, '2026-08-31T14:00:00Z' <= '2026-08-31' é FALSO e o
 * último dia do período sumia do total. O painel usava a forma crua; agora os
 * dois usam esta, e a conciliação compara duas contas do mesmo dia.
 *
 * "Dia da loja" e não dia de Greenwich: a venda das 21h30 é do dia em que o
 * operador a fez. Ver `CalendarioOperacional`.
 */
export function panelRevenueCents(companyId: string, from: string, to: string): number {
  ensureCoreSchema();
  const row = getConnection()
    .prepare(
      `SELECT COALESCE(SUM(total_cents), 0) AS total
         FROM core_sales
        WHERE company_id = ? AND status = 'completed'
          AND ${diaDaLojaSql('created_at')} >= ? AND ${diaDaLojaSql('created_at')} <= ?`,
    )
    .get(companyId, from, to) as { total: number };
  return Number(row.total);
}

/**
 * Quanto voltou ao cliente como CRÉDITO NA LOJA no período.
 *
 * Devolução paga em crédito não gera lançamento nenhum — o dinheiro não saiu,
 * virou saldo do cliente. Sob competência isso deixa a receita inflada pelo
 * valor devolvido: a venda continua somando e a devolução não subtrai de lugar
 * nenhum. Não dá para lançar como despesa (o caixa não pagou nada) nem para
 * abater da venda (seria reescrever mês fechado).
 *
 * Então o valor é MEDIDO e NOMEADO na ressalva. Zero significa que não há
 * ressalva a fazer, e a frase não aparece.
 *
 * ## O QUE MUDOU COM O CRÉDITO DE LOJA (GAP-V10/V47), e o que NÃO mudou
 *
 * Este texto dizia, até aqui, que "o crédito ainda nem existe como saldo no
 * sistema". Passou a existir: `core_customer_credits` é a razão do vale, com
 * dono, extrato e consumo na venda seguinte (ver `CustomerCreditService`).
 *
 * A ressalva continua VALENDO, e a conta é a mesma. O período da CONCESSÃO
 * segue inflado exatamente neste valor — a venda original somou receita e a
 * devolução não a subtraiu. O período do RESGATE, por outro lado, não precisa
 * de ressalva nenhuma: a venda paga com vale reconhece receita cheia porque a
 * loja entregou mercadoria e se livrou de uma dívida do mesmo tamanho. Por isso
 * o resgate não vira desconto (reduziria a receita nas DUAS pontas do ciclo)
 * nem despesa (não saiu dinheiro): ele LIQUIDA o recebível da venda, com baixa
 * de método próprio.
 */
function creditoNaLojaCents(companyId: string, from: string, to: string): number {
  const row = getConnection()
    .prepare(
      `SELECT COALESCE(SUM(total_cents), 0) AS total
         FROM core_sale_returns
        WHERE company_id = ? AND refund_method = 'credito'
          AND ${diaDaLojaSql('created_at')} >= ? AND ${diaDaLojaSql('created_at')} <= ?`,
    )
    .get(companyId, from, to) as { total: number };
  return Number(row.total);
}

function reais(cents: number): string {
  return (cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
}

/**
 * O CMV do período — GAP-V28.
 *
 * ## Uma consulta, três populações, nenhuma soma escondida
 *
 * O agrupamento é por ESTADO DO SNAPSHOT, e não por produto: o que interessa
 * aqui não é "quanto custou cada item", é "sobre quanto do período este número
 * fala". As três populações são disjuntas e cobrem toda linha de venda
 * concluída do recorte:
 *
 *   - `cost_cents > 0`      → entra no CMV e na margem;
 *   - `cost_cents = 0`      → produto sem custo no cadastro, fica fora;
 *   - `cost_cents IS NULL`  → venda anterior ao snapshot, ou linha de serviço.
 *
 * ## O RECORTE É O DA VENDA, e isso é escolha
 *
 * `status = 'completed'` e o DIA DA LOJA de `core_sales.created_at` — os
 * mesmos de `panelRevenueCents`, logo acima. Recortar pela competência do
 * lançamento poria o CMV numa régua e a mercadoria em outra: uma venda de 30
 * de junho com lançamento de competência de julho traria o custo para junho e
 * a receita para julho, e a margem de cada mês sairia errada nos dois.
 *
 * A venda CANCELADA não entra, pela mesma razão do painel: ela deixou de
 * valer, e a mercadoria voltou para a prateleira.
 *
 * ## A receita comparada é a DAS MESMAS LINHAS
 *
 * `SUM(total_cents)` das linhas com custo, e não o faturamento do período.
 * Dividir o custo de três itens pela receita de trezentos devolveria uma
 * margem de 99% — o erro simétrico do custo zero.
 */
function custoDoVendido(companyId: string, from: string, to: string): CostOfGoodsSold {
  const row = getConnection()
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN i.cost_cents > 0
                           THEN CAST(ROUND(i.cost_cents * i.quantity) AS INTEGER) END), 0)
           AS custo,
         COALESCE(SUM(CASE WHEN i.cost_cents > 0 THEN i.total_cents END), 0) AS receita,
         COALESCE(SUM(CASE WHEN i.cost_cents > 0 THEN 1 ELSE 0 END), 0)      AS com_custo,
         COALESCE(SUM(CASE WHEN i.cost_cents = 0 THEN 1 ELSE 0 END), 0)      AS sem_custo,
         COALESCE(SUM(CASE WHEN i.cost_cents IS NULL THEN 1 ELSE 0 END), 0)  AS sem_retrato
       FROM core_sale_items i
       JOIN core_sales s ON s.id = i.sale_id
      WHERE i.company_id = ? AND s.status = 'completed'
        AND ${diaDaLojaSql('s.created_at')} >= ? AND ${diaDaLojaSql('s.created_at')} <= ?`,
    )
    .get(companyId, from, to) as Record<string, number>;

  const costCents = Number(row.custo);
  const revenueCents = Number(row.receita);
  const marginCents = revenueCents - costCents;

  return {
    costCents,
    revenueCents,
    marginCents,
    // Sem receita considerada não há percentual: devolver 0 afirmaria "vendeu
    // sem lucro", que é diferente de "não dá para saber".
    marginPercent:
      revenueCents > 0 ? Math.round((marginCents / revenueCents) * 1000) / 10 : null,
    itemsWithCost: Number(row.com_custo),
    itemsWithoutCost: Number(row.sem_custo),
    itemsBeforeSnapshot: Number(row.sem_retrato),
  };
}

/**
 * O demonstrativo do período.
 *
 * `from` e `to` são datas `YYYY-MM-DD`, inclusivas nas duas pontas.
 */
export function incomeStatement(companyId: string, from: string, to: string): IncomeStatement {
  ensureCoreSchema();
  const db = getConnection();

  /*
    UMA CONSULTA. Tudo que o relatório soma sai daqui, e nada é somado no SQL.

    Agregar no banco pareceria mais eficiente e traria de volta o defeito que
    esta rodada existe para consertar: cada `SUM` com um `WHERE` diferente é
    uma aritmética a mais para divergir das outras. São centenas de linhas por
    mês numa loja — o laço é irrelevante, a corretude não.
  */
  const rows = db
    .prepare(
      `SELECT e.id, e.direction, e.amount_cents, e.category_id, e.origin_type,
              cat.name AS category_name, cat.system_code AS system_code
         FROM core_finance_entries e
         LEFT JOIN core_finance_categories cat ON cat.id = e.category_id
        WHERE e.company_id = ?
          AND e.cancelled_at IS NULL
          AND ${COMPETENCIA} >= ?
          AND ${COMPETENCIA} <= ?`,
    )
    .all(companyId, from, to) as unknown as LinhaCrua[];

  const receita = new LadoEmConstrucao();
  const despesa = new LadoEmConstrucao();
  const receitaPorOrigem = new Map<string, number>();

  const vistos = new Set<string>();
  let somaBruta = 0;

  for (const row of rows) {
    // A partição é DISJUNTA por construção: um id só passa por aqui uma vez.
    // A conferência custa um Set e paga por si na primeira vez que um JOIN
    // novo duplicar linha — que é o jeito clássico de um relatório dobrar de
    // tamanho sem ninguém notar.
    if (vistos.has(row.id)) {
      throw new Error(`DRE: o lançamento ${row.id} apareceu duas vezes na consulta.`);
    }
    vistos.add(row.id);

    const valor = Number(row.amount_cents);
    somaBruta += valor;
    const linha: LinhaCrua = { ...row, amount_cents: valor };

    // A partição é TOTAL: as duas direções cobrem tudo o que existe, e uma
    // terceira direção é erro — não um caso a ignorar em silêncio, que seria
    // dinheiro sumindo do relatório.
    if (row.direction === 'in') {
      receita.acumular(linha);
      receitaPorOrigem.set(
        row.origin_type,
        (receitaPorOrigem.get(row.origin_type) ?? 0) + valor,
      );
    } else if (row.direction === 'out') {
      despesa.acumular(linha);
    } else {
      throw new Error(
        `DRE: o lançamento ${row.id} tem direção "${row.direction}", que não é ` +
          "'in' nem 'out'. Nenhum lançamento pode ficar fora do relatório.",
      );
    }
  }

  const revenue = receita.fechar();
  const expense = despesa.fechar();

  // A PROVA DE COBERTURA. Se ela falhar, algum lançamento entrou em duas linhas
  // ou em nenhuma — e é melhor estourar do que devolver um resultado errado.
  if (revenue.totalCents + expense.totalCents !== somaBruta) {
    throw new Error(
      `DRE: a soma dos lados (${revenue.totalCents} + ${expense.totalCents}) não bate ` +
        `com a soma bruta dos lançamentos (${somaBruta}).`,
    );
  }
  if (revenue.entryCount + expense.entryCount !== rows.length) {
    throw new Error(
      `DRE: ${revenue.entryCount + expense.entryCount} lançamentos classificados para ` +
        `${rows.length} trazidos pela consulta.`,
    );
  }

  const resultCents = revenue.totalCents - expense.totalCents;

  /*
    O "sem categoria" NÃO é somado de novo: ele é LIDO das linhas que já
    existem. Somá-lo à parte seria a segunda aritmética que esta rodada
    proibiu — e foi exatamente assim que a entrada sem categoria passou a ser
    contada duas vezes na versão anterior.
  */
  const semCategoriaReceita = revenue.lines.find((l) => l.categoryId === null);
  const semCategoriaDespesa = expense.lines.find((l) => l.categoryId === null);
  const uncategorized = {
    entryCount: (semCategoriaReceita?.entryCount ?? 0) + (semCategoriaDespesa?.entryCount ?? 0),
    revenueCents: semCategoriaReceita?.totalCents ?? 0,
    expenseCents: semCategoriaDespesa?.totalCents ?? 0,
  };

  const reconciliation = conciliarComPainel(companyId, from, to, revenue, receitaPorOrigem);
  const cogs = custoDoVendido(companyId, from, to);

  return {
    companyId,
    from,
    to,
    revenue,
    expense,
    /*
      O CMV NÃO ENTRA AQUI, e a linha existe para dizê-lo: `resultCents`
      continua sendo receita − despesa dos LANÇAMENTOS. A compra da mercadoria
      já é despesa (a nota de entrada gera o título a pagar); subtrair o CMV
      também tiraria a mesma mercadoria duas vezes do resultado.
    */
    resultCents,
    cogs,
    uncategorized,
    reconciliation,
    caveats: montarRessalva(companyId, from, to, uncategorized, cogs),
  };
}

/**
 * A diferença entre o painel e o DRE, decomposta até o último centavo.
 *
 * Cada parcela tem NOME. O que sobra depois de nomear as origens é a diferença
 * de CRITÉRIO DE DATA — o painel mede pela data da venda, o DRE pela
 * competência —, e ela também vira linha com nome, em vez de virar "outros".
 */
function conciliarComPainel(
  companyId: string,
  from: string,
  to: string,
  revenue: IncomeStatementSide,
  receitaPorOrigem: Map<string, number>,
): IncomeStatementReconciliation {
  const painel = panelRevenueCents(companyId, from, to);
  const lines: ReconciliationLine[] = [];

  for (const [origem, cents] of receitaPorOrigem) {
    if (origem === 'sale' || cents === 0) continue;
    lines.push({
      key: origem,
      label: `${rotuloDaOrigem(origem)}: entra no DRE e não no painel`,
      cents,
    });
  }
  lines.sort((a, b) => b.cents - a.cents);

  const deBalcao = receitaPorOrigem.get('sale') ?? 0;
  const porData = deBalcao - painel;
  if (porData !== 0) {
    lines.push({
      key: 'criterio_de_data',
      label:
        'Venda de balcão contada em datas diferentes: o painel usa a data da venda, ' +
        'o DRE usa a competência do lançamento',
      cents: porData,
    });
  }

  const differenceCents = revenue.totalCents - painel;
  const somaDasParcelas = lines.reduce((acc, l) => acc + l.cents, 0);
  if (somaDasParcelas !== differenceCents) {
    // Sem esta conferência, a tela mostraria uma diferença e uma lista de
    // motivos que não a explicam — que é pior do que não explicar nada, porque
    // parece explicação.
    throw new Error(
      `DRE: a diferença para o painel (${differenceCents}) não é igual à soma das ` +
        `parcelas nomeadas (${somaDasParcelas}).`,
    );
  }

  return {
    panelRevenueCents: painel,
    statementRevenueCents: revenue.totalCents,
    differenceCents,
    lines,
  };
}

/**
 * A RESSALVA — a parte mais importante da tela, e por isso ela nasce aqui.
 *
 * As frases vêm do servidor por um motivo: a tela renderiza a lista inteira e
 * não tem como esquecer uma. Se cada frase fosse texto solto no componente,
 * a primeira reescrita da tela deixaria de fora justamente a que incomoda.
 *
 * As quatro primeiras são sempre verdadeiras. As últimas só aparecem quando
 * têm valor — ressalva que aparece sempre vira paisagem, e ninguém lê.
 */
function montarRessalva(
  companyId: string,
  from: string,
  to: string,
  uncategorized: { entryCount: number; revenueCents: number; expenseCents: number },
  cogs: CostOfGoodsSold,
): string[] {
  const frases = [
    /*
      A PRIMEIRA FRASE MUDOU DE ASSUNTO nesta rodada. Ela dizia "Não há CMV nem
      margem: o custo do item não é gravado no momento da venda" — e ficou
      FALSA no minuto em que o snapshot passou a existir. Ressalva que
      envelhece e continua impressa é pior que ressalva nenhuma: ensina quem lê
      a não acreditar na lista inteira.

      O que continua verdadeiro, e por isso segue impresso, é o alcance: o CMV
      é gerencial, tem régua própria (a data da venda) e NÃO é descontado do
      resultado, porque a compra já entrou como despesa.
    */
    'O CMV é medido pela data da VENDA e não é descontado do resultado: a compra ' +
      'da mercadoria já entra aqui como despesa, no título da nota de entrada — ' +
      'tirá-la duas vezes seria contar a mesma compra duas vezes.',
    'Não há rateio: cada lançamento pertence inteiro à empresa em que foi lançado.',
    'Não há provisão nem depreciação.',
    'É regime de COMPETÊNCIA, não de caixa: conta o mês do fato, não o dia em que ' +
      'o dinheiro entrou ou saiu.',
    'A devolução aparece como DESPESA, na categoria dela — não como desconto da ' +
      'receita. Fazer as duas coisas a contaria duas vezes.',
    'Comissão estornada depois do fechamento não volta a este resultado: o estorno ' +
      'entra na apuração seguinte.',
  ];

  if (uncategorized.entryCount > 0) {
    const total = uncategorized.revenueCents + uncategorized.expenseCents;
    frases.push(
      `${uncategorized.entryCount} lançamento(s) sem categoria, somando R$ ${reais(total)} ` +
        `(R$ ${reais(uncategorized.revenueCents)} em receita e ` +
        `R$ ${reais(uncategorized.expenseCents)} em despesa).`,
    );
  }

  /*
    AS DUAS RESSALVAS DO CMV, e cada uma só aparece quando tem valor.

    Elas são o que impede o número de ser lido como "o custo do mês". A
    primeira nomeia a pendência de CADASTRO (produto vendido sem custo); a
    segunda, o buraco do PASSADO (venda anterior ao dia em que o sistema passou
    a fotografar custo). A segunda some sozinha com o tempo — e é assim que
    tem de ser: ressalva permanente vira paisagem.
  */
  if (cogs.itemsWithoutCost > 0) {
    frases.push(
      `${cogs.itemsWithoutCost} linha(s) de venda do período ficaram FORA do CMV por o ` +
        'produto estar sem custo cadastrado. Custo zero devolveria 100% de margem, ' +
        'então elas não entram na conta — e a margem acima vale sobre ' +
        `${cogs.itemsWithCost} linha(s), não sobre tudo o que foi vendido.`,
    );
  }
  if (cogs.itemsBeforeSnapshot > 0) {
    frases.push(
      `${cogs.itemsBeforeSnapshot} linha(s) de venda do período estão sem custo gravado: ` +
        'são vendas anteriores ao dia em que o sistema passou a fotografar o custo na ' +
        'hora da venda (ou linhas de serviço, que não saem de prateleira). Não há ' +
        'conserto retroativo — reconstruir o custo de então com o custo de hoje seria ' +
        'inventar número.',
    );
  }

  const credito = creditoNaLojaCents(companyId, from, to);
  if (credito > 0) {
    frases.push(
      `R$ ${reais(credito)} devolvidos como CRÉDITO NA LOJA não aparecem aqui: ` +
        'não saiu dinheiro, então não há lançamento — e a receita do período está ' +
        'inflada nesse valor.',
    );
  }

  return frases;
}
