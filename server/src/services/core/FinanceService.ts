/**
 * Contas a receber e a pagar.
 *
 * São o MESMO domínio visto dos dois lados: `direction = 'in'` é o que entra,
 * `'out'` é o que sai. Separar em duas tabelas duplicaria a regra de baixa, e
 * a segunda cópia divergiria da primeira no primeiro ajuste.
 *
 * O que faltava aqui não era a leitura — `core_finance_entries` já existia e
 * já era alimentada pelas vendas. Faltava o writer: dar baixa, dar baixa
 * PARCIAL e estornar.
 *
 * TRÊS DECISÕES QUE SUSTENTAM O RESTO
 *
 * 1. BAIXA PARCIAL É A REGRA, não exceção. Cliente que paga metade hoje e
 *    metade no fim do mês é o caso comum. Por isso o saldo mora em
 *    `settled_cents` e o total pago é a soma das baixas, não um booleano.
 *
 * 2. NÃO SE PAGA MAIS QUE O DEVIDO. Garantido por UPDATE condicional, não por
 *    conferência antes do gravar: duas baixas simultâneas passariam as duas
 *    pela conferência e estourariam o valor.
 *
 * 3. ESTORNO NÃO APAGA. Grava a contrapartida negativa e marca a original.
 *    Apagar a linha faria o extrato do mês fechar diferente do que fechou no
 *    dia — e é justamente o estorno que alguém vai querer auditar depois.
 */
import { randomUUID } from 'node:crypto';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { hojeNaLoja } from './CalendarioOperacional.js';
import { ApiError } from '../../utils/errors.js';
import { recordDomainEvent } from '../sync/DomainEvents.js';
import { chaveReusada, impressaoDe, outraImpressao } from '../api/ImpressaoDaRequisicao.js';
/*
  A COMPETÊNCIA VEM DE LÁ, e não de uma segunda cópia aqui.

  "O período do relatório" não pode significar duas coisas em dois arquivos: o
  DRE e o recorte por centro de custo precisam somar EXATAMENTE o mesmo
  conjunto de lançamentos, ou as duas telas se contradizem sem que nenhuma
  esteja obviamente errada.
*/
import { COMPETENCIA } from './IncomeStatementService.js';

export type FinanceDirection = 'in' | 'out';

export interface FinanceEntry {
  id: string;
  direction: FinanceDirection;
  description: string;
  amountCents: number;
  settledCents: number;
  /** Quanto ainda falta. Vem pronto para a tela não recalcular errado. */
  balanceCents: number;
  status: string;
  dueDate: string | null;
  settledAt: string | null;
  /** `true` quando venceu e ainda há saldo. */
  overdue: boolean;
  counterpartyName: string | null;
  originType: string;
  /**
   * O ID do documento que gerou o título — a metade que FALTAVA da
   * rastreabilidade.
   *
   * `origin_type` e `origin_id` sempre foram gravados íntegros; a API só
   * serializava o tipo. Quem abria o contas a pagar e queria a nota da dívida
   * tinha o texto "NF-e 1234" — sem id, sem link — e auditar um lançamento
   * estranho exigia SQL na mão. O próprio audit-purchase deixou registrado:
   * "a amarração dívida→nota (origin_id) NÃO sai pela API".
   */
  originId: string;
  /**
   * Rótulo legível da origem ('Venda #7', 'Nota 4711 — Fornecedor X'), já
   * resolvido no SQL. Nulo quando a origem não tem superfície própria
   * (lançamento manual) ou o documento não foi encontrado — a tela só mostra
   * link para onde dá para ir.
   */
  originLabel: string | null;
  /** Qual parcela é esta, e de quantas. 1 de 1 é o lançamento comum. */
  installmentNumber: number;
  installmentTotal: number;
  /**
   * Para que foi o dinheiro. Vem junto da lista porque o filtro por categoria
   * existe: filtrar por um campo que a linha não mostra deixa quem filtrou sem
   * como conferir o resultado.
   */
  categoryId: string | null;
  categoryName: string | null;
  /**
   * DE QUEM É A DESPESA (ou a receita) — o centro de custo (GAP-V25).
   *
   * A coluna era gravada por `createEntry` desde sempre e NINGUÉM a lia: nem
   * relatório, nem filtro, nem lista. Preencher centro de custo era trabalho
   * sem retorno, e o cadastro dele existia inteiro para não responder nada.
   *
   * Vem junto da linha pelo mesmo motivo da categoria: filtrar por um campo
   * que a lista não mostra deixa quem filtrou sem como conferir o resultado.
   */
  costCenterId: string | null;
  costCenterName: string | null;
  /** Carimbo do cancelamento. Preenchido = o fato não conta em relatório. */
  cancelledAt: string | null;
  createdAt: string;
}

export interface FinanceSettlement {
  id: string;
  amountCents: number;
  method: string | null;
  settledAt: string;
  note: string | null;
  reversedAt: string | null;
  /** Preenchido quando ESTA linha é o estorno de outra. */
  reversesId: string | null;
}

function hoje(): string {
  return hojeNaLoja();
}

function toEntry(row: Record<string, unknown>): FinanceEntry {
  const amount = Number(row.amount_cents);
  const settled = Number(row.settled_cents ?? 0);
  const balance = amount - settled;
  const due = (row.due_date as string | null) ?? null;

  return {
    id: String(row.id),
    direction: row.direction as FinanceDirection,
    description: String(row.description),
    amountCents: amount,
    settledCents: settled,
    balanceCents: balance,
    status: String(row.status),
    dueDate: due,
    settledAt: (row.settled_at as string | null) ?? null,
    // Vencido é quem passou da data E ainda deve. Conta quitada com data
    // antiga não é problema de ninguém.
    overdue: Boolean(due) && due! < hoje() && balance > 0,
    counterpartyName: (row.counterparty_name as string | null) ?? null,
    originType: String(row.origin_type),
    originId: String(row.origin_id),
    originLabel: (row.origin_label as string | null) ?? null,
    installmentNumber: Number(row.installment_number ?? 1),
    installmentTotal: Number(row.installment_total ?? 1),
    categoryId: (row.category_id as string | null) ?? null,
    categoryName: (row.category_name as string | null) ?? null,
    costCenterId: (row.cost_center_id as string | null) ?? null,
    costCenterName: (row.cost_center_name as string | null) ?? null,
    cancelledAt: (row.cancelled_at as string | null) ?? null,
    createdAt: String(row.created_at),
  };
}

/*
  O RÓTULO DA ORIGEM SAI DO SQL, resolvido junto da lista.

  A alternativa — a tela buscar a venda/nota/pedido de cada linha para montar
  o texto — custaria uma requisição por linha ou um dicionário que ninguém
  manteria em dia. Aqui são LEFT JOINs por chave primária: quando o documento
  existe, o rótulo sai pronto; quando não existe (origem sem superfície, como
  o lançamento manual), o SQLite propaga o NULL pelo `||` e o rótulo é nulo —
  que é a verdade: não há para onde navegar.

  ## A QUINTA ORIGEM, QUE FICOU DE FORA POR RODADAS

  Este CASE nomeava quatro origens e a compra sem nota fiscal (GAP-V17) grava
  uma QUINTA — `entrada_manual` —, de propósito: é o que impede a compra
  digitada de se apresentar como NF-e em relatório, conciliação e estorno.
  Sem o ramo dela, o CASE caía no `ELSE NULL`, o título voltava com
  `originLabel` nulo e a ContasPage — que só faz link do que tem rótulo —
  deixava a dívida da feira SEM PORTA. A rastreabilidade existia no banco e
  morria aqui, no serializador, que é o defeito que esta constante nasceu para
  fechar.

  As duas espécies moram na MESMA tabela (`core_inbound_notes`, separadas por
  `doc_type`), então o JOIN é um só e o que muda é o PREFIXO do rótulo:
  "Nota 4711" para a NF-e, "Entrada manual EM-7" para o recibo digitado. Um
  prefixo só para as duas seria a mentira que a origem própria existe para
  impedir.

  ## O CONJUNTO É FECHADO, E ESTÁ TODO AQUI

  As origens que o sistema escreve em `core_finance_entries` são seis, uma por
  escritor: 'sale' (SalesService), 'sale_return' (SaleReturnService),
  'nfe_entrada' e 'entrada_manual' (NfeImportService), 'ecommerce_order'
  (StorefrontService) e 'manual' (o avulso, aqui mesmo). As cinco primeiras
  têm documento e rótulo; 'manual' aponta para si mesma e cai no `ELSE NULL`
  por decisão — não há tela do lançamento avulso para onde navegar, e oferecer
  link seria porta desenhada que não abre.

  ('finance_entry' e 'ecommerce_order' também aparecem em `origin_type`, mas em
  `core_payment_intents` — outra tabela, outro CASE, o de `PaymentService`.)

  ## A SÉTIMA: O FECHAMENTO DE COMISSÃO (GAP-PRD-174)

  `CommissionService.fecharPeriodo` cria a conta a pagar da comissão. Ela
  nascia 'manual', apontando para si mesma, e o vínculo morava só em
  `core_commission_closings.finance_entry_id` — do fechamento se chegava ao
  título, do título não se chegava ao fechamento. Agora o título nasce com
  `origin_type = 'commission_closing'` e `origin_id` = o fechamento, e o
  rótulo diz de quem e de que período. Os títulos antigos (gravados como
  'manual') se corrigem pelo passo descrito em
  `docs/audits/remediacao/migracoes/FIN.md`.

  A varredura de `titulo-e-origem-sao-navegaveis` monta um lançamento de cada
  espécie e cobra a decisão explícita: origem nova sem rótulo nem declaração
  fica vermelha lá, e não em silêncio na tela do contas a pagar.
*/
const ORIGEM_LEGIVEL_SQL = `CASE e.origin_type
         WHEN 'sale' THEN 'Venda #' || v.number
         WHEN 'sale_return' THEN 'Devolução #' || dev.number || ' da venda #' || vd.number
         WHEN 'nfe_entrada' THEN CASE WHEN nota.id IS NULL THEN NULL
           ELSE 'Nota ' || COALESCE(nota.number, 'sem número')
                || COALESCE(' — ' || forn.name, '') END
         WHEN 'entrada_manual' THEN CASE WHEN nota.id IS NULL THEN NULL
           ELSE 'Entrada manual ' || COALESCE(nota.number, 'sem número')
                || COALESCE(' — ' || forn.name, '') END
         WHEN 'ecommerce_order' THEN 'Pedido online #' || ped.number
         WHEN 'ecommerce_order_refund' THEN 'Reembolso do pedido online #' || ped.number
         -- A SÉTIMA ORIGEM (GAP-PRD-089): o crédito com o fornecedor que nasce
         -- da devolução de parte de uma compra.
         WHEN 'devolucao_fornecedor' THEN CASE WHEN devf.id IS NULL THEN NULL
           ELSE 'Devolução ao fornecedor #' || devf.number
                || COALESCE(' — ' || fdev.name, '') END
         WHEN 'commission_closing' THEN CASE WHEN fech.id IS NULL THEN NULL
           ELSE 'Fechamento de comissão — ' || COALESCE(vend.display_name, 'vendedor')
                || ' · ' || substr(fech.period_from, 9, 2) || '/' || substr(fech.period_from, 6, 2)
                || '/' || substr(fech.period_from, 1, 4)
                || ' a ' || substr(fech.period_to, 9, 2) || '/' || substr(fech.period_to, 6, 2)
                || '/' || substr(fech.period_to, 1, 4) END
         ELSE NULL END`;

const JOINS_DA_ORIGEM = `LEFT JOIN core_sales v ON e.origin_type = 'sale' AND v.id = e.origin_id
               LEFT JOIN core_sale_returns dev ON e.origin_type = 'sale_return' AND dev.id = e.origin_id
               LEFT JOIN core_sales vd ON vd.id = dev.sale_id
               LEFT JOIN core_inbound_notes nota
                      ON e.origin_type IN ('nfe_entrada', 'entrada_manual')
                     AND nota.id = e.origin_id
               LEFT JOIN core_suppliers forn ON forn.id = nota.supplier_id
               LEFT JOIN core_orders ped
                      ON e.origin_type IN ('ecommerce_order', 'ecommerce_order_refund')
                     AND ped.id = e.origin_id
               LEFT JOIN core_supplier_returns devf
                      ON e.origin_type = 'devolucao_fornecedor' AND devf.id = e.origin_id
               LEFT JOIN core_suppliers fdev ON fdev.id = devf.supplier_id
               LEFT JOIN core_commission_closings fech
                      ON e.origin_type = 'commission_closing' AND fech.id = e.origin_id
                     AND fech.company_id = e.company_id
               LEFT JOIN core_users vend ON vend.id = fech.seller_id`;

export interface FinanceFilters {
  direction?: FinanceDirection;
  /** 'open' | 'settled' | 'overdue' — 'overdue' é derivado, não é status. */
  situation?: string;
  dueFrom?: string;
  dueTo?: string;
  search?: string;
  /**
   * A VOLTA da rastreabilidade: os lançamentos de UM documento.
   *
   * É a consulta que a ficha da venda/nota/pedido faz para listar os seus
   * títulos — o avesso do `originId` que cada linha agora carrega. Os dois
   * chegam juntos: tipo sem id devolveria todos os títulos de venda da
   * empresa, e id sem tipo apostaria que UUIDs nunca colidem entre domínios.
   */
  originType?: string;
  originId?: string;
  /**
   * Só os lançamentos desta categoria.
   *
   * O valor especial `sem-categoria` pede o oposto: as linhas que ninguém
   * classificou. É a lista que o DRE aponta na ressalva — sem um jeito de
   * chegar nelas, saber que existem 40 lançamentos sem categoria não ajuda
   * ninguém a classificá-los.
   */
  categoryId?: string;
  /**
   * Só os lançamentos deste centro de custo (GAP-V25).
   *
   * Mesmo desenho do filtro por categoria, inclusive o avesso
   * (`sem-centro-de-custo`): a coluna era escrita e não tinha leitor nenhum, e
   * o primeiro leitor de um campo assim precisa vir com o caminho para o que
   * ficou EM BRANCO — senão saber que existem lançamentos sem centro não
   * ajuda ninguém a classificá-los.
   */
  costCenterId?: string;
  /**
   * QUANTAS LINHAS NO MÁXIMO — e por que o campo nasce agora.
   *
   * O `LIMIT 500` vivia cravado no SQL, sem jeito de pedir mais. Servia à TELA
   * de Contas, que pagina; não servia à Central de Relatórios, que declara teto
   * de 5000 e detecta truncagem contando o que recebeu. O relatório
   * `financeiro` herdava o 500 daqui e saía com `truncated: false` — a página
   * se apresentando como o todo, e o CSV levando o recorte para fora do sistema
   * como se fosse a lista inteira.
   *
   * O padrão continua 500: nenhum chamador existente muda de comportamento.
   * Quem precisa de mais pede, e assume o custo de montar a lista maior.
   */
  limit?: number;
}

/** O valor que pede o avesso do filtro: o que ficou sem classificação. */
export const SEM_CATEGORIA = 'sem-categoria';

/** O avesso do filtro por centro de custo: o que ninguém atribuiu. */
export const SEM_CENTRO_DE_CUSTO = 'sem-centro-de-custo';

export function listEntries(companyId: string, filters: FinanceFilters = {}): FinanceEntry[] {
  ensureCoreSchema();

  const params: unknown[] = [companyId];
  // O nome da contraparte sai de cliente OU fornecedor conforme o lado. Fazer
  // isto no SQL evita a tela pedir uma lista de clientes só para exibir nome.
  let sql = `SELECT e.*,
                    COALESCE(c.name, s.name) AS counterparty_name,
                    cat.name AS category_name,
                    cc.name AS cost_center_name,
                    ${ORIGEM_LEGIVEL_SQL} AS origin_label
               FROM core_finance_entries e
               LEFT JOIN core_customers c ON c.id = e.customer_id
               LEFT JOIN core_suppliers s ON s.id = e.supplier_id
               LEFT JOIN core_finance_categories cat ON cat.id = e.category_id
               LEFT JOIN core_cost_centers cc ON cc.id = e.cost_center_id
               ${JOINS_DA_ORIGEM}
              WHERE e.company_id = ? AND e.cancelled_at IS NULL`;

  /*
    CANCELADA NÃO É UM ESTADO DA CONTA — é a conta não existir.

    Esta lista não olhava o cancelamento. A venda era cancelada, `SalesService`
    carimbava `cancelled_at` nas duas direções, e a parcela continuava aqui
    como se fosse cobrável: o cobrador ligava para o cliente e levava 409 ao
    tentar dar baixa, porque `settleEntry` recusa lançamento cancelado — e
    recusa com razão. O número mentia; a operação, não.

    O critério é o CARIMBO e não o `status`, e o esquema já explicava por quê:
    `aplicarStatus` recalcula o status a cada baixa e a cada estorno, então uma
    baixa lançada depois do cancelamento devolvia a linha para 'open'. Carimbo
    de data não se recalcula.
  */

  if (filters.direction) {
    sql += ' AND e.direction = ?';
    params.push(filters.direction);
  }
  if (filters.situation === 'open') {
    sql += ' AND e.settled_cents < e.amount_cents';
  } else if (filters.situation === 'settled') {
    sql += ' AND e.settled_cents >= e.amount_cents';
  } else if (filters.situation === 'overdue') {
    sql += ' AND e.settled_cents < e.amount_cents AND e.due_date IS NOT NULL AND e.due_date < ?';
    params.push(hoje());
  }
  if (filters.dueFrom) {
    sql += ' AND e.due_date >= ?';
    params.push(filters.dueFrom);
  }
  if (filters.dueTo) {
    sql += ' AND e.due_date <= ?';
    params.push(filters.dueTo);
  }
  if (filters.search) {
    sql += ' AND (e.description LIKE ? OR c.name LIKE ? OR s.name LIKE ?)';
    const like = `%${filters.search}%`;
    params.push(like, like, like);
  }
  if (filters.categoryId === SEM_CATEGORIA) {
    sql += ' AND e.category_id IS NULL';
  } else if (filters.categoryId) {
    sql += ' AND e.category_id = ?';
    params.push(filters.categoryId);
  }
  // O primeiro leitor da coluna `cost_center_id` (GAP-V25) — e ele vem com o
  // avesso junto, pelo mesmo motivo da categoria.
  if (filters.costCenterId === SEM_CENTRO_DE_CUSTO) {
    sql += ' AND e.cost_center_id IS NULL';
  } else if (filters.costCenterId) {
    sql += ' AND e.cost_center_id = ?';
    params.push(filters.costCenterId);
  }
  // Só juntos: tipo sem id devolveria a empresa inteira, id sem tipo apostaria
  // em UUIDs nunca colidirem entre domínios. Metade do par é ignorada.
  if (filters.originType && filters.originId) {
    sql += ' AND e.origin_type = ? AND e.origin_id = ?';
    params.push(filters.originType, filters.originId);
  }

  // Sem vencimento vai para o fim: são os lançamentos à vista, já resolvidos.
  //
  // O teto é PARÂMETRO com o mesmo padrão de antes (500). Cravado no texto do
  // SQL, ele viajava para dentro da Central de Relatórios sem que ninguém
  // pudesse vê-lo — ver o comentário de `FinanceFilters.limit`.
  sql += ' ORDER BY e.due_date IS NULL, e.due_date, e.created_at DESC LIMIT ?';
  params.push(Math.max(Math.trunc(Number(filters.limit ?? 500)) || 500, 1));

  const rows = getConnection()
    .prepare(sql)
    .all(...(params as never[])) as unknown as Record<string, unknown>[];
  return rows.map(toEntry);
}

export interface FinanceSummary {
  openCents: number;
  overdueCents: number;
  settledCents: number;
  /** TODOS os lançamentos vivos do lado — quitados inclusive. */
  count: number;
  /**
   * Quantos AINDA DEVEM (GAP-PRD-208). É a contagem que acompanha
   * `openCents`: o KPI "Em aberto" dizia "1 lançamento(s)" com o único
   * lançamento já liquidado, porque usava `count`.
   */
  openCount: number;
  /** Quantos dos abertos já passaram do vencimento — a mesma régua de `overdueCents`. */
  overdueCount: number;
}

/** Totais do lado pedido. Somados no banco: a tela lista 500, o total é de tudo. */
export function summarize(companyId: string, direction: FinanceDirection): FinanceSummary {
  ensureCoreSchema();
  const dia = hoje();
  const row = getConnection()
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN settled_cents < amount_cents
                           THEN amount_cents - settled_cents ELSE 0 END), 0) AS open_cents,
         COALESCE(SUM(CASE WHEN settled_cents < amount_cents
                            AND due_date IS NOT NULL AND due_date < ?
                           THEN amount_cents - settled_cents ELSE 0 END), 0) AS overdue_cents,
         COALESCE(SUM(settled_cents), 0) AS settled_cents,
         COUNT(*) AS count,
         COALESCE(SUM(CASE WHEN settled_cents < amount_cents THEN 1 ELSE 0 END), 0) AS open_count,
         COALESCE(SUM(CASE WHEN settled_cents < amount_cents
                            AND due_date IS NOT NULL AND due_date < ?
                           THEN 1 ELSE 0 END), 0) AS overdue_count
       FROM core_finance_entries
      WHERE company_id = ? AND direction = ? AND cancelled_at IS NULL`,
    )
    .get(dia, dia, companyId, direction) as Record<string, number>;

  return {
    openCents: Number(row.open_cents),
    overdueCents: Number(row.overdue_cents),
    settledCents: Number(row.settled_cents),
    count: Number(row.count),
    openCount: Number(row.open_count),
    overdueCount: Number(row.overdue_count),
  };
}

export interface FinanceAging {
  /** O que ainda não venceu — inclui o lançamento em aberto SEM vencimento. */
  notDueCents: number;
  days1to30Cents: number;
  days31to60Cents: number;
  days61to90Cents: number;
  over90Cents: number;
}

/**
 * O vencido por IDADE — a pergunta que `overdueCents` não responde.
 *
 * O gestor via QUANTO estava vencido, mas não HÁ QUANTO TEMPO: priorizar
 * cobrança (ligar primeiro para a dívida de 90 dias, não para a de 3) exigia
 * filtrar datas na mão. As faixas são as da casa: a vencer, 1-30, 31-60,
 * 61-90 e mais de 90 dias.
 *
 * Duas decisões que impedem número mentiroso:
 *
 * 1. A RÉGUA É O DIA DA LOJA (`hoje()`), a MESMA de `overdue` e do resumo.
 *    Uma segunda régua (UTC, por exemplo) faria as faixas somarem diferente
 *    do `overdueCents` logo ao lado, perto da meia-noite.
 *
 * 2. QUEM CONTA É O SALDO, não o valor original. Conta de 100 com 40 pagos
 *    deve 60 — envelhecer os 100 inflaria a régua de cobrança com dinheiro
 *    que já entrou.
 */
export function agingPorFaixas(companyId: string, direction: FinanceDirection): FinanceAging {
  ensureCoreSchema();
  const dia = hoje();
  // `julianday` de duas datas puras devolve diferença exata em dias — sem
  // hora, sem fuso, sem float sobrando: o CAST é só formalidade.
  const row = getConnection()
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN atraso IS NULL OR atraso <= 0 THEN saldo END), 0) AS not_due,
         COALESCE(SUM(CASE WHEN atraso BETWEEN 1 AND 30 THEN saldo END), 0)  AS d1_30,
         COALESCE(SUM(CASE WHEN atraso BETWEEN 31 AND 60 THEN saldo END), 0) AS d31_60,
         COALESCE(SUM(CASE WHEN atraso BETWEEN 61 AND 90 THEN saldo END), 0) AS d61_90,
         COALESCE(SUM(CASE WHEN atraso > 90 THEN saldo END), 0)              AS d90_mais
       FROM (
         SELECT amount_cents - settled_cents AS saldo,
                CAST(julianday(?) - julianday(due_date) AS INTEGER) AS atraso
           FROM core_finance_entries
          WHERE company_id = ? AND direction = ?
            AND cancelled_at IS NULL AND settled_cents < amount_cents
       )`,
    )
    .get(dia, companyId, direction) as Record<string, number>;

  return {
    notDueCents: Number(row.not_due),
    days1to30Cents: Number(row.d1_30),
    days31to60Cents: Number(row.d31_60),
    days61to90Cents: Number(row.d61_90),
    over90Cents: Number(row.d90_mais),
  };
}

export function listSettlements(companyId: string, entryId: string): FinanceSettlement[] {
  ensureCoreSchema();
  const rows = getConnection()
    .prepare(
      `SELECT * FROM core_finance_settlements
        WHERE company_id = ? AND entry_id = ? ORDER BY settled_at`,
    )
    .all(companyId, entryId) as unknown as Record<string, unknown>[];

  return rows.map((r) => ({
    id: String(r.id),
    amountCents: Number(r.amount_cents),
    method: (r.method as string | null) ?? null,
    settledAt: String(r.settled_at),
    note: (r.note as string | null) ?? null,
    reversedAt: (r.reversed_at as string | null) ?? null,
    reversesId: (r.reverses_id as string | null) ?? null,
  }));
}

function getEntryRow(companyId: string, entryId: string): Record<string, unknown> {
  const row = getConnection()
    .prepare('SELECT * FROM core_finance_entries WHERE company_id = ? AND id = ?')
    .get(companyId, entryId) as Record<string, unknown> | undefined;
  if (!row) {
    throw new ApiError('CORE_FINANCE_ENTRY_NOT_FOUND', 'Lançamento não encontrado.', 404);
  }
  return row;
}

/**
 * Dá baixa, total ou parcial.
 *
 * O valor sobe por UPDATE CONDICIONAL: a própria condição garante que a soma
 * não ultrapasse o devido. Conferir antes e gravar depois deixaria uma janela
 * entre as duas coisas — dois cliques no botão, ou dois caixas na mesma conta,
 * passariam os dois pela conferência.
 */
export function settleEntry(input: {
  companyId: string;
  entryId: string;
  amountCents: number;
  method?: string | null;
  note?: string | null;
  userId?: string | null;
  /**
   * A chave do PEDIDO de baixa (GAP-PRD-173).
   *
   * O teto do devido segura o total, mas não a repetição de uma baixa
   * PARCIAL: dois POST iguais de 5.000 num título de 10.000 passavam os dois.
   * Com a chave, o segundo devolve a baixa do primeiro (`replayed: true`) e
   * nada é gravado de novo. Opcional porque os escritores internos (webhook,
   * PIX do balcão) já são idempotentes pela própria referência do provedor.
   */
  idempotencyKey?: string | null;
}): { entry: FinanceEntry; settlements: FinanceSettlement[]; replayed?: boolean } {
  ensureCoreSchema();

  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new ApiError('CORE_FINANCE_AMOUNT_INVALID', 'Informe um valor maior que zero.', 400);
  }
  const chave = input.idempotencyKey?.trim() || null;
  if (chave && chave.length > 200) {
    throw new ApiError('CORE_IDEMPOTENCY_KEY_INVALID', 'Idempotency-Key longa demais.', 400);
  }
  // O que este pedido de baixa é: título, valor e forma (RES-IDEM-VIZ).
  const impressao = impressaoDe({
    titulo: input.entryId,
    valor: input.amountCents,
    forma: String(input.method ?? '').trim(),
  });

  return withTransaction(() => {
    const db = getConnection();

    /*
      O PEDIDO REPETIDO DEVOLVE O QUE O PRIMEIRO FEZ — antes de qualquer outra
      conferência. Se o primeiro deu certo e depois o título foi quitado ou
      cancelado, a repetição não é um pedido novo a recusar: é o mesmo pedido,
      e a resposta certa é a baixa que ele já gerou.

      Mesma chave com OUTRO título, OUTRO valor ou OUTRA forma é engano de quem
      chamou — devolver a baixa antiga faria a tela anunciar como feita uma
      baixa que ninguém gravou. A resposta é a de toda chave reusada com outro
      corpo (RES-IDEM-VIZ): 422 CORE_IDEMPOTENCY_KEY_REUSED — era 409
      CORE_IDEMPOTENCY_CONFLICT, e nenhuma tela lia o código (a de Contas
      mostra a mensagem do servidor). O pedido anterior à impressão (coluna
      nula) segue a regra antiga, que é título e valor.
    */
    if (chave) {
      const ja = db
        .prepare(
          `SELECT entry_id, amount_cents, idempotency_fingerprint FROM core_finance_settle_requests
            WHERE company_id = ? AND idempotency_key = ?`,
        )
        .get(input.companyId, chave) as
        | { entry_id: string; amount_cents: number; idempotency_fingerprint: string | null }
        | undefined;
      if (ja) {
        if (
          ja.entry_id !== input.entryId
          || Number(ja.amount_cents) !== input.amountCents
          || outraImpressao(ja.idempotency_fingerprint, impressao)
        ) {
          throw chaveReusada('uma baixa (título, valor e forma de recebimento)');
        }
        return {
          entry: toEntry(entryComContraparte(input.companyId, input.entryId)),
          settlements: listSettlements(input.companyId, input.entryId),
          replayed: true,
        };
      }
    }

    const alvo = getEntryRow(input.companyId, input.entryId);

    /*
      NÃO SE PAGA O QUE FOI CANCELADO — e isto é metade de um conserto.

      A outra metade está em `aplicarStatus`, logo abaixo. O cenário que
      derrubou o critério antigo do DRE (`status <> 'cancelled'`) tem dois
      passos: cancela-se a venda, e as linhas dela ficam `cancelled`; alguém
      dá baixa numa delas, `aplicarStatus` recalcula o status a partir do
      saldo, e a linha volta a ser 'open' ou 'settled'. A receita de uma venda
      cancelada reaparecia no relatório sem que ninguém tivesse descancelado
      coisa alguma.

      Guardar só a leitura do relatório resolveria o número e deixaria de pé a
      operação sem sentido — dar baixa em conta que não existe mais. A recusa
      é aqui, na entrada.
    */
    if (alvo.cancelled_at) {
      throw new ApiError(
        'CORE_FINANCE_ENTRY_CANCELLED',
        'Este lançamento foi cancelado e não aceita baixa.',
        409,
      );
    }

    const resultado = db
      .prepare(
        `UPDATE core_finance_entries
            SET settled_cents = settled_cents + ?
          WHERE id = ? AND company_id = ?
            AND settled_cents + ? <= amount_cents`,
      )
      .run(input.amountCents, input.entryId, input.companyId, input.amountCents);

    if (Number(resultado.changes) === 0) {
      const atual = getEntryRow(input.companyId, input.entryId);
      const saldo = Number(atual.amount_cents) - Number(atual.settled_cents ?? 0);
      throw new ApiError(
        'CORE_FINANCE_OVER_SETTLEMENT',
        saldo <= 0
          ? 'Este lançamento já está quitado.'
          : `Valor acima do saldo devedor (${(saldo / 100).toFixed(2)}).`,
        409,
      );
    }

    const now = new Date().toISOString();
    const settlementId = randomUUID();
    db.prepare(
      `INSERT INTO core_finance_settlements
         (id, entry_id, company_id, amount_cents, method, settled_at, user_id, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      settlementId,
      input.entryId,
      input.companyId,
      input.amountCents,
      input.method ?? null,
      now,
      input.userId ?? null,
      input.note ?? null,
    );

    // A memória do pedido nasce na MESMA transação da baixa: ou as duas
    // existem, ou nenhuma. Gravada antes, um erro no meio deixaria a chave
    // "atendida" sem baixa nenhuma; gravada depois, fora da transação, um
    // segundo pedido entraria na janela.
    if (chave) {
      db.prepare(
        `INSERT INTO core_finance_settle_requests
           (company_id, idempotency_key, entry_id, amount_cents, settlement_id, user_id, created_at,
            idempotency_fingerprint)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.companyId,
        chave,
        input.entryId,
        input.amountCents,
        settlementId,
        input.userId ?? null,
        now,
        impressao,
      );
    }

    aplicarStatus(input.companyId, input.entryId, now);

    const atualizado = entryComContraparte(input.companyId, input.entryId);
    recordDomainEvent({
      eventType: 'finance.entry_settled',
      aggregateType: 'finance_entry',
      aggregateId: input.entryId,
      companyId: input.companyId,
      operation: 'update',
      payload: {
        id: input.entryId,
        status: (atualizado as Record<string, unknown>).status,
        settled_cents: (atualizado as Record<string, unknown>).settled_cents,
        settled_at: (atualizado as Record<string, unknown>).settled_at,
        amount_cents: (atualizado as Record<string, unknown>).amount_cents,
        direction: (atualizado as Record<string, unknown>).direction,
      },
      occurredAt: now,
    });

    return {
      entry: toEntry(atualizado),
      settlements: listSettlements(input.companyId, input.entryId),
    };
  });
}

/**
 * Estorna uma baixa.
 *
 * A baixa original permanece, marcada; entra uma linha negativa apontando para
 * ela. Quem auditar meses depois precisa ver que houve pagamento e que ele foi
 * desfeito — não um lançamento que nunca existiu.
 */
export function reverseSettlement(input: {
  companyId: string;
  settlementId: string;
  userId?: string | null;
  note?: string | null;
}): { entry: FinanceEntry; settlements: FinanceSettlement[] } {
  ensureCoreSchema();

  return withTransaction(() => {
    const db = getConnection();
    const original = db
      .prepare('SELECT * FROM core_finance_settlements WHERE id = ? AND company_id = ?')
      .get(input.settlementId, input.companyId) as Record<string, unknown> | undefined;

    if (!original) {
      throw new ApiError('CORE_SETTLEMENT_NOT_FOUND', 'Baixa não encontrada.', 404);
    }
    if (original.reversed_at) {
      throw new ApiError('CORE_SETTLEMENT_ALREADY_REVERSED', 'Esta baixa já foi estornada.', 409);
    }
    // Estornar um estorno é um jeito confuso de refazer o pagamento; quem quer
    // isso dá uma baixa nova.
    if (original.reverses_id) {
      throw new ApiError(
        'CORE_SETTLEMENT_IS_REVERSAL',
        'Esta linha já é um estorno. Para refazer o pagamento, lance uma nova baixa.',
        409,
      );
    }

    const entryId = String(original.entry_id);
    const valor = Number(original.amount_cents);
    const now = new Date().toISOString();

    db.prepare('UPDATE core_finance_settlements SET reversed_at = ? WHERE id = ?').run(
      now,
      input.settlementId,
    );

    db.prepare(
      `INSERT INTO core_finance_settlements
         (id, entry_id, company_id, amount_cents, method, settled_at, user_id, note, reverses_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      entryId,
      input.companyId,
      -valor,
      (original.method as string | null) ?? null,
      now,
      input.userId ?? null,
      input.note ?? 'Estorno',
      input.settlementId,
    );

    db.prepare(
      'UPDATE core_finance_entries SET settled_cents = settled_cents - ? WHERE id = ? AND company_id = ?',
    ).run(valor, entryId, input.companyId);

    aplicarStatus(input.companyId, entryId, now);

    return {
      entry: toEntry(entryComContraparte(input.companyId, entryId)),
      settlements: listSettlements(input.companyId, entryId),
    };
  });
}

/**
 * Recalcula o status a partir do saldo.
 *
 * O status é DERIVADO, nunca definido à mão: assim uma baixa parcial seguida
 * de estorno não deixa uma conta quitada sem estar paga.
 *
 * COM UMA EXCEÇÃO, e é ela que sustenta o DRE: o cancelamento NÃO é derivado
 * do saldo. Um lançamento cancelado que recebesse um estorno de baixa voltaria
 * para 'open' aqui dentro, e a receita cancelada reapareceria no relatório.
 * Cancelado permanece cancelado; quem quer cobrar de novo lança de novo.
 */
function aplicarStatus(companyId: string, entryId: string, now: string): void {
  const db = getConnection();
  const row = getEntryRow(companyId, entryId);
  if (row.cancelled_at) return;
  const quitado = Number(row.settled_cents ?? 0) >= Number(row.amount_cents);

  db.prepare('UPDATE core_finance_entries SET status = ?, settled_at = ? WHERE id = ?').run(
    quitado ? 'settled' : 'open',
    quitado ? now : null,
    entryId,
  );
}

function entryComContraparte(companyId: string, entryId: string): Record<string, unknown> {
  return getConnection()
    .prepare(
      `SELECT e.*, COALESCE(c.name, s.name) AS counterparty_name,
              cat.name AS category_name,
              ${ORIGEM_LEGIVEL_SQL} AS origin_label
         FROM core_finance_entries e
         LEFT JOIN core_customers c ON c.id = e.customer_id
         LEFT JOIN core_suppliers s ON s.id = e.supplier_id
         LEFT JOIN core_finance_categories cat ON cat.id = e.category_id
         ${JOINS_DA_ORIGEM}
        WHERE e.company_id = ? AND e.id = ?`,
    )
    .get(companyId, entryId) as Record<string, unknown>;
}

/**
 * Cria um lançamento avulso.
 *
 * Existe para a conta que NÃO nasce de uma venda: aluguel, energia, a nota do
 * fornecedor que chegou fora do pedido. `origin_type = 'manual'` deixa isso
 * explícito no extrato, para ninguém procurar a venda que originou.
 */
/**
 * A conta padrão da empresa, ou nulo se ainda não há nenhuma.
 *
 * Nulo é resposta legítima: o sistema funciona sem cadastro de conta, e
 * obrigar a cadastrar uma para lançar a primeira despesa seria burocracia
 * antes do valor.
 */
function contaPadrao(companyId: string): string | null {
  const row = getConnection()
    .prepare(
      'SELECT id FROM core_finance_accounts WHERE company_id = ? AND is_default = 1 AND active = 1',
    )
    .get(companyId) as { id: string } | undefined;
  return row?.id ?? null;
}

/**
 * Vencimento mensal: o mesmo dia, N meses adiante, com CLAMP de fim de mês.
 *
 * 31/jan + 1 mês é 28/fev (29 em bissexto), não 3/mar — o carnê combinado
 * "todo dia 31" cai no último dia do mês curto, como qualquer boleto real. E
 * o clamp NÃO gruda: a soma é sempre sobre o PRIMEIRO vencimento, então a
 * parcela de março volta para o dia 31 em vez de herdar o 28 de fevereiro.
 *
 * Aritmética pura sobre a data de calendário. `new Date('YYYY-MM-DD')` com
 * fuso já mordeu duas rodadas daqui (a data recuava um dia); o único uso de
 * Date abaixo é `Date.UTC(ano, mes, 0)`, que serve apenas para perguntar
 * quantos dias o mês tem.
 */
function mesMais(dia: string, meses: number): string {
  const [ano, mes, diaDoMes] = dia.split('-').map(Number);
  const totalMeses = ano * 12 + (mes - 1) + meses;
  const anoAlvo = Math.floor(totalMeses / 12);
  const mesAlvo = (totalMeses % 12) + 1;
  const ultimoDiaDoMes = new Date(Date.UTC(anoAlvo, mesAlvo, 0)).getUTCDate();
  const diaAlvo = Math.min(diaDoMes, ultimoDiaDoMes);
  return `${anoAlvo}-${String(mesAlvo).padStart(2, '0')}-${String(diaAlvo).padStart(2, '0')}`;
}

/** Teto de parcelas do carnê manual. 60 meses é prazo de financiamento de
 *  carro; acima disso é quase certamente dedo a mais no campo. */
const MAX_PARCELAS = 60;

export function createEntry(input: {
  companyId: string;
  direction: FinanceDirection;
  description: string;
  amountCents: number;
  dueDate?: string | null;
  customerId?: string | null;
  supplierId?: string | null;
  /** Para que foi o dinheiro. Opcional — ver o cabeçalho de FinanceSetupService. */
  categoryId?: string | null;
  /** De qual operação saiu. */
  costCenterId?: string | null;
  /** Onde o dinheiro entra ou sai. Omitido, cai na conta padrão da empresa. */
  accountId?: string | null;
  /**
   * Data do FATO, para o DRE. Omitida, vale o vencimento, e na falta dele,
   * hoje — aluguel pago com atraso tem de competir no mês do aluguel.
   */
  competenceDate?: string | null;
  note?: string | null;
  /**
   * PARCELAR EM N — o carnê do balcão (mensal, a partir do vencimento).
   *
   * O esquema esperava por isto desde que a parcela entrou na UNIQUE: o
   * comentário de `core_finance_entries` promete que baixa, estorno e
   * conciliações "já funcionam sobre parcela sem uma linha de código nova".
   * O que faltava era o escritor. Omitido ou 1 = o lançamento único de sempre.
   */
  installments?: number | null;
  /**
   * O DOCUMENTO QUE GEROU O TÍTULO, quando não é um lançamento avulso
   * (GAP-PRD-174).
   *
   * O fechamento de comissão criava a conta a pagar como 'manual', apontando
   * para si mesma: do contas a pagar não se chegava ao fechamento, só do
   * fechamento ao título. Com a origem própria, o título sabe de onde veio e
   * o rótulo da origem vira link. Só para lançamento de UMA parcela — o grupo
   * do carnê é o `origin_id`, e um documento de fora não pode disputá-lo.
   */
  origin?: { type: 'commission_closing'; id: string } | null;
}): FinanceEntry {
  ensureCoreSchema();

  if (!input.description.trim()) {
    throw new ApiError('CORE_FINANCE_DESCRIPTION_REQUIRED', 'Descreva o lançamento.', 400);
  }
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new ApiError('CORE_FINANCE_AMOUNT_INVALID', 'Informe um valor maior que zero.', 400);
  }

  const parcelas = input.installments ?? 1;
  if (!Number.isInteger(parcelas) || parcelas < 1 || parcelas > MAX_PARCELAS) {
    throw new ApiError(
      'CORE_FINANCE_INSTALLMENTS_INVALID',
      `Informe um número de parcelas entre 1 e ${MAX_PARCELAS}.`,
      400,
    );
  }
  if (parcelas > 1 && !input.dueDate) {
    // O carnê é um calendário de cobrança; sem o primeiro vencimento não há
    // de onde contar os meses seguintes.
    throw new ApiError(
      'CORE_FINANCE_INSTALLMENTS_DUE_DATE_REQUIRED',
      'Informe o primeiro vencimento para parcelar.',
      400,
    );
  }
  if (parcelas > 1 && Math.floor(input.amountCents / parcelas) < 1) {
    // Parcela de zero centavo nasceria quitada (saldo 0) sem ninguém pagar.
    throw new ApiError(
      'CORE_FINANCE_INSTALLMENTS_TOO_SMALL',
      'O valor não rende nem um centavo por parcela. Reduza o número de parcelas.',
      400,
    );
  }
  if (input.origin && (parcelas > 1 || !String(input.origin.id ?? '').trim())) {
    // Erro de programação, não de quem digita: a origem de documento é de um
    // título só, e precisa do id do documento.
    throw new ApiError(
      'CORE_FINANCE_ORIGIN_INVALID',
      'Título gerado por documento tem uma parcela e aponta para o documento.',
      400,
    );
  }
  if (input.categoryId) {
    /*
      A CATEGORIA TEM DE SER DA EMPRESA E DO LADO CERTO.

      Sem esta conferência, um `categoryId` vindo do corpo da requisição podia
      pôr uma categoria de RECEITA num lançamento de SAÍDA — e o DRE mostraria
      a despesa dentro da linha de receita, com o total geral certo e o
      detalhamento mentindo. É a mesma armadilha que o backfill da migração 56
      desarma mapeando por origem E direção; a porta do formulário precisava
      da mesma tranca.
    */
    const categoria = getConnection()
      .prepare(
        'SELECT direction FROM core_finance_categories WHERE id = ? AND company_id = ?',
      )
      .get(input.categoryId, input.companyId) as { direction: string } | undefined;
    if (!categoria) {
      throw new ApiError('CORE_FINANCE_CATEGORY_NOT_FOUND', 'Categoria não encontrada.', 404);
    }
    if (categoria.direction !== input.direction) {
      throw new ApiError(
        'CORE_FINANCE_CATEGORY_DIRECTION',
        input.direction === 'in'
          ? 'Esta categoria é de despesa e não serve para uma conta a receber.'
          : 'Esta categoria é de receita e não serve para uma conta a pagar.',
        400,
      );
    }
  }

  return withTransaction(() => {
    const inserir = getConnection().prepare(
      `INSERT INTO core_finance_entries
         (id, company_id, direction, amount_cents, status, due_date, settled_cents,
          customer_id, supplier_id, description, origin_type, origin_id,
          installment_number, installment_total,
          category_id, cost_center_id, account_id, competence_date, note, created_at)
       VALUES (?, ?, ?, ?, 'open', ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    // 'manual' é o avulso, que aponta para si mesmo; com `origin`, o título
    // aponta para o documento que o gerou (GAP-PRD-174).
    const tipoDaOrigem = input.origin?.type ?? 'manual';

    /*
      A DIVISÃO É EM CENTAVOS INTEIROS E O RESTO VAI NA PRIMEIRA PARCELA —
      regra da casa, a mesma da taxa da operadora. R$ 100,00 em 3 é
      33,34 + 33,33 + 33,33: a soma fecha no centavo por construção, e quem
      confere o carnê contra o combinado vê a diferença logo na primeira
      folha, não escondida na última.

      O GRUPO é o `origin_id` comum: a UNIQUE
      (origin_type, origin_id, direction, installment_number) já foi desenhada
      para isso, então nenhuma coluna nova entra — parcela repetida no mesmo
      grupo é o banco que recusa. Com 1 parcela, o origin_id aponta para o
      próprio lançamento, como sempre apontou.
    */
    const base = Math.floor(input.amountCents / parcelas);
    const resto = input.amountCents - base * parcelas;
    const grupoId = randomUUID();
    const conta = input.accountId ?? contaPadrao(input.companyId);
    const criadoEm = new Date().toISOString();
    const descricao = input.description.trim();

    let primeiroId = '';
    for (let i = 0; i < parcelas; i += 1) {
      const id = randomUUID();
      if (i === 0) primeiroId = id;
      const valorDaParcela = base + (i === 0 ? resto : 0);
      const vencimento =
        parcelas > 1 ? mesMais(input.dueDate!, i) : (input.dueDate ?? null);
      const titulo = parcelas > 1 ? `${descricao} (${i + 1}/${parcelas})` : descricao;

      inserir.run(
        id,
        input.companyId,
        input.direction,
        valorDaParcela,
        vencimento,
        input.customerId ?? null,
        input.supplierId ?? null,
        titulo,
        tipoDaOrigem,
        input.origin ? input.origin.id : parcelas > 1 ? grupoId : id,
        i + 1,
        parcelas,
        input.categoryId ?? null,
        input.costCenterId ?? null,
        conta,
        // Vencimento como competência é a aproximação certa para lançamento
        // digitado: quem cadastra a conta de luz de março põe o vencimento de
        // março. Sem vencimento, hoje. No carnê sem competência explícita,
        // cada parcela compete no próprio mês — como o seguro pago em 12x.
        input.competenceDate ?? vencimento ?? hojeNaLoja(),
        input.note?.trim() || null,
        criadoEm,
      );

      // Lançamento financeiro é fato para a central: sem ele, o consolidado do
      // grupo não fecha com o caixa da loja. Cada parcela é um fato próprio —
      // vence e baixa sozinha.
      recordDomainEvent({
        eventType: 'finance.entry_recorded',
        aggregateType: 'finance_entry',
        aggregateId: id,
        companyId: input.companyId,
        payload: {
          id,
          direction: input.direction,
          amount_cents: valorDaParcela,
          status: 'open',
          due_date: vencimento,
          customer_id: input.customerId ?? null,
          supplier_id: input.supplierId ?? null,
          description: titulo,
          origin_type: tipoDaOrigem,
          origin_id: input.origin ? input.origin.id : parcelas > 1 ? grupoId : id,
          installment_number: i + 1,
          installment_total: parcelas,
        },
      });
    }

    return toEntry(entryComContraparte(input.companyId, primeiroId));
  });
}

/**
 * A BAIXA-ESPELHO do que nasce quitado (V29).
 *
 * O DEFEITO que isto conserta: a fatia à vista da venda gravava
 * `settled_cents = amount_cents` direto, sem linha em
 * `core_finance_settlements`. O saldo fechava, mas o histórico não contava a
 * história — a conciliação bancária compara extrato contra BAIXAS, e para ela
 * essas entradas não existiam (o banco real tinha 7 de 9 lançamentos quitados
 * e zero baixas); regime de caixa, idem.
 *
 * NÃO abre transação: é peça de composição, chamada de DENTRO da transação de
 * quem criou o lançamento — a baixa nasce ou morre junto com ele. E não passa
 * por `settleEntry` de propósito: o lançamento já nasceu com o saldo quitado,
 * e somar de novo pagaria em dobro.
 *
 * COMPATIBILIDADE: lançamentos antigos quitados sem baixa não são reescritos —
 * inventar baixa retroativa com carimbo de hoje sujaria a conciliação de um
 * mês já vivido. A regra vale do conserto em diante.
 */
/**
 * O GANCHO DA COBRANÇA PARCELADA (GAP-V73).
 *
 * Parte um título de UMA parcela em N, para que a cobrança parcelada no
 * provedor tenha do lado de cá um carnê de verdade: N títulos, N vencimentos,
 * N baixas. Sem isto, o Asaas mandaria três boletos e o financeiro continuaria
 * com um lançamento só — cada webhook tentaria baixar o total, e dois dos três
 * pagamentos seriam recusados por "valor acima do saldo".
 *
 * ## Por que isto mora AQUI, e não no serviço da cobrança
 *
 * `core_finance_entries` tem um escritor só, e é este arquivo. A régua de
 * centavos (base + resto na PRIMEIRA parcela) e o calendário mensal com clamp
 * de fim de mês são os MESMOS de `createEntry` — reescrevê-los no serviço da
 * cobrança criaria uma segunda aritmética para divergir da primeira no
 * primeiro ajuste, e a segunda seria a que ninguém confere.
 *
 * ## As quatro recusas, e o que cada uma evita
 *
 * 1. LANÇAMENTO QUE JÁ É PARCELA não se re-parcela: o grupo já existe e a
 *    UNIQUE (origin_type, origin_id, direction, installment_number) recusaria
 *    no banco, com erro ilegível em vez de mensagem.
 * 2. TÍTULO COM BAIXA não se parte: o dinheiro já pago não tem em qual parcela
 *    morar, e a primeira nasceria quitada sem ninguém ter combinado isso.
 * 3. SEM VENCIMENTO não há de onde contar os meses seguintes — a mesma regra
 *    do carnê digitado.
 * 4. SÓ O LANÇAMENTO AVULSO (`origin_type = 'manual'`). É o único cuja origem
 *    é ELE MESMO, então o grupo pode ser o próprio id sem disputar numeração
 *    com ninguém. Partir um título de venda usaria o id da VENDA como grupo, e
 *    a parcela 2 do carnê colidiria com a parcela 2 do cartão da mesma venda —
 *    silenciosamente, porque as duas moram na mesma UNIQUE. Quem quer parcelar
 *    a cobrança de uma venda lança o título avulso e cobra por ele.
 */
export interface ParcelaDoCarne {
  entryId: string;
  number: number;
  total: number;
  amountCents: number;
  dueDate: string | null;
}

export function parcelarEntrada(input: {
  companyId: string;
  entryId: string;
  installments: number;
}): ParcelaDoCarne[] {
  ensureCoreSchema();

  const recusa = (motivo: string) => {
    throw new ApiError('CORE_FINANCE_CHARGE_INSTALLMENTS_REFUSED', motivo, 409);
  };

  return withTransaction(() => {
    const db = getConnection();
    const alvo = getEntryRow(input.companyId, input.entryId);
    const parcelas = input.installments;

    if (!Number.isInteger(parcelas) || parcelas < 2 || parcelas > MAX_PARCELAS) {
      throw new ApiError(
        'CORE_FINANCE_INSTALLMENTS_INVALID',
        `Informe um número de parcelas entre 2 e ${MAX_PARCELAS}.`,
        400,
      );
    }
    if (alvo.cancelled_at) recusa('Este lançamento foi cancelado e não aceita cobrança.');
    if (Number(alvo.installment_total ?? 1) > 1) {
      recusa('Este título já é parcela de um carnê e não se parcela de novo.');
    }
    if (Number(alvo.settled_cents ?? 0) > 0) {
      recusa('Este título já tem baixa registrada; parcelá-lo faria o carnê nascer mentindo.');
    }
    if (!alvo.due_date) recusa('Informe o vencimento do título antes de parcelar a cobrança.');
    if (String(alvo.origin_type) !== 'manual') {
      recusa(
        'Só o lançamento avulso pode ser parcelado na cobrança. '
          + 'Este título veio de um documento e a numeração das parcelas é dele.',
      );
    }

    const total = Number(alvo.amount_cents);
    if (Math.floor(total / parcelas) < 1) {
      throw new ApiError(
        'CORE_FINANCE_INSTALLMENTS_TOO_SMALL',
        'O valor não rende nem um centavo por parcela. Reduza o número de parcelas.',
        400,
      );
    }

    const base = Math.floor(total / parcelas);
    const resto = total - base * parcelas;
    const primeiroVencimento = String(alvo.due_date);
    const descricao = String(alvo.description).trim();
    const criadoEm = new Date().toISOString();
    // O grupo é o PRÓPRIO id, como em `createEntry` com uma parcela só: para o
    // lançamento avulso, `origin_id` sempre apontou para ele mesmo.
    const grupoId = String(alvo.origin_id);

    // A primeira parcela é o título QUE JÁ EXISTE — id preservado. Cancelá-lo e
    // recriar tudo apagaria a trilha do lançamento original e quebraria
    // qualquer referência a ele.
    db.prepare(
      `UPDATE core_finance_entries
          SET amount_cents = ?, description = ?, installment_number = 1, installment_total = ?
        WHERE id = ? AND company_id = ?`,
    ).run(base + resto, `${descricao} (1/${parcelas})`, parcelas, input.entryId, input.companyId);

    const inserir = db.prepare(
      `INSERT INTO core_finance_entries
         (id, company_id, direction, amount_cents, status, due_date, settled_cents,
          customer_id, supplier_id, description, origin_type, origin_id,
          installment_number, installment_total,
          category_id, cost_center_id, account_id, competence_date, note, created_at)
       VALUES (?, ?, ?, ?, 'open', ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const geradas: ParcelaDoCarne[] = [
      {
        entryId: input.entryId,
        number: 1,
        total: parcelas,
        amountCents: base + resto,
        dueDate: primeiroVencimento,
      },
    ];

    for (let i = 1; i < parcelas; i += 1) {
      const id = randomUUID();
      const vencimento = mesMais(primeiroVencimento, i);
      inserir.run(
        id,
        input.companyId,
        String(alvo.direction),
        base,
        vencimento,
        (alvo.customer_id as string | null) ?? null,
        (alvo.supplier_id as string | null) ?? null,
        `${descricao} (${i + 1}/${parcelas})`,
        String(alvo.origin_type),
        grupoId,
        i + 1,
        parcelas,
        (alvo.category_id as string | null) ?? null,
        (alvo.cost_center_id as string | null) ?? null,
        (alvo.account_id as string | null) ?? null,
        // Cada parcela compete no PRÓPRIO mês, como o seguro pago em 12x — a
        // mesma escolha do carnê digitado.
        vencimento,
        (alvo.note as string | null) ?? null,
        criadoEm,
      );

      recordDomainEvent({
        eventType: 'finance.entry_recorded',
        aggregateType: 'finance_entry',
        aggregateId: id,
        companyId: input.companyId,
        payload: {
          id,
          direction: String(alvo.direction),
          amount_cents: base,
          status: 'open',
          due_date: vencimento,
          customer_id: (alvo.customer_id as string | null) ?? null,
          supplier_id: (alvo.supplier_id as string | null) ?? null,
          description: `${descricao} (${i + 1}/${parcelas})`,
          origin_type: String(alvo.origin_type),
          origin_id: grupoId,
          installment_number: i + 1,
          installment_total: parcelas,
        },
      });

      geradas.push({
        entryId: id,
        number: i + 1,
        total: parcelas,
        amountCents: base,
        dueDate: vencimento,
      });
    }

    return geradas;
  });
}

export function inserirBaixaEspelho(input: {
  companyId: string;
  entryId: string;
  amountCents: number;
  method?: string | null;
  settledAt: string;
  userId?: string | null;
  note?: string | null;
}): void {
  getConnection()
    .prepare(
      `INSERT INTO core_finance_settlements
         (id, entry_id, company_id, amount_cents, method, settled_at, user_id, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      input.entryId,
      input.companyId,
      input.amountCents,
      input.method ?? null,
      input.settledAt,
      input.userId ?? null,
      input.note ?? null,
    );
}

// ------------------------------------------------------- centro de custo

/**
 * ============================================================================
 * O CENTRO DE CUSTO GANHA UM LEITOR (GAP-V25)
 * ============================================================================
 *
 * ## O defeito
 *
 * `core_cost_centers` tem cadastro completo (criar, renomear, desativar, com
 * auditoria), `createEntry` GRAVA `cost_center_id`, a rota o repassa — e
 * NENHUMA consulta do sistema o lia. Preencher centro de custo era trabalho
 * sem retorno: nenhum relatório agrupava por centro, nenhuma lista o mostrava,
 * nenhum filtro o aceitava. A tela de cadastros dizia isso em texto, o que é
 * honesto e não resolve: um campo obrigatório-por-costume que não responde
 * nada acaba preenchido de qualquer jeito, e aí passa a mentir.
 *
 * ## Por que este relatório é IRMÃO do DRE, e não uma linha dentro dele
 *
 * O DRE tem uma regra de uma frase: cada lançamento entra em EXATAMENTE UMA
 * linha, e a linha é a categoria. Centro de custo é OUTRA pergunta sobre o
 * mesmo dinheiro — "de quem é esta despesa" em vez de "para que ela foi" —, e
 * enfiá-la lá dentro faria a mesma quantia aparecer em duas partições da mesma
 * estrutura. Foi exatamente assim que a primeira versão daquele relatório
 * contou a devolução duas vezes.
 *
 * Então: mesmo PERÍODO, mesma COMPETÊNCIA (a constante é importada de lá, para
 * que "o período" não passe a significar duas coisas), mesmo critério de
 * cancelamento — e uma partição própria, com a mesma conferência de cobertura.
 *
 * ## O que fica FORA e por quê
 *
 * Nada fica fora. O lançamento sem centro atribuído entra na linha "Sem centro
 * de custo", que é a mais importante do relatório no primeiro mês: é ela que
 * mede o quanto o rateio ainda não foi feito. Omiti-la faria os totais deste
 * relatório serem menores que os do DRE sem nenhuma explicação na tela.
 */
export interface CostCenterLine {
  /** Nulo é a casa própria do que ninguém atribuiu. */
  costCenterId: string | null;
  costCenterCode: string | null;
  costCenterName: string;
  revenueCents: number;
  expenseCents: number;
  /** Entrou menos saiu, no centro. Negativo é o normal num centro de despesa. */
  resultCents: number;
  entryCount: number;
}

export interface CostCenterReport {
  from: string;
  to: string;
  lines: CostCenterLine[];
  revenueTotalCents: number;
  expenseTotalCents: number;
  resultCents: number;
  entryCount: number;
  /** Quanto do período ainda não tem dono. É a régua do rateio. */
  unassigned: { entryCount: number; revenueCents: number; expenseCents: number };
}

const SEM_CENTRO_NOME = 'Sem centro de custo';

/** Maior despesa primeiro; "Sem centro de custo" sempre por último. */
function ordenarCentros(a: CostCenterLine, b: CostCenterLine): number {
  if (a.costCenterId === null) return 1;
  if (b.costCenterId === null) return -1;
  const pesoA = a.expenseCents + a.revenueCents;
  const pesoB = b.expenseCents + b.revenueCents;
  if (pesoB !== pesoA) return pesoB - pesoA;
  return a.costCenterName.localeCompare(b.costCenterName, 'pt-BR');
}

/**
 * O período por centro de custo.
 *
 * `from` e `to` são datas `YYYY-MM-DD`, inclusivas nas duas pontas — o mesmo
 * contrato do DRE, para que as duas telas possam ser comparadas lado a lado.
 */
export function relatorioPorCentroDeCusto(
  companyId: string,
  from: string,
  to: string,
): CostCenterReport {
  ensureCoreSchema();

  const rows = getConnection()
    .prepare(
      `SELECT e.id, e.direction, e.amount_cents, e.cost_center_id,
              cc.code AS cost_center_code, cc.name AS cost_center_name
         FROM core_finance_entries e
         LEFT JOIN core_cost_centers cc ON cc.id = e.cost_center_id
        WHERE e.company_id = ?
          AND e.cancelled_at IS NULL
          AND ${COMPETENCIA} >= ?
          AND ${COMPETENCIA} <= ?`,
    )
    .all(companyId, from, to) as unknown as {
    id: string;
    direction: string;
    amount_cents: number;
    cost_center_id: string | null;
    cost_center_code: string | null;
    cost_center_name: string | null;
  }[];

  const porCentro = new Map<string, CostCenterLine>();
  const vistos = new Set<string>();
  let receitaTotal = 0;
  let despesaTotal = 0;

  for (const row of rows) {
    // A partição é disjunta por construção; a conferência custa um Set e paga
    // por si na primeira vez que um JOIN novo duplicar linha.
    if (vistos.has(row.id)) {
      throw new Error(
        `Centro de custo: o lançamento ${row.id} apareceu duas vezes na consulta.`,
      );
    }
    vistos.add(row.id);

    const chave = row.cost_center_id ?? '';
    const linha = porCentro.get(chave) ?? {
      costCenterId: row.cost_center_id ?? null,
      costCenterCode: row.cost_center_code ?? null,
      /*
        CENTRO DESATIVADO CONTINUA APARECENDO com o nome dele.

        `listCostCenters` esconde o inativo do FORMULÁRIO, que é onde esconder
        faz sentido — ninguém deve atribuir a um centro que a empresa encerrou.
        No RELATÓRIO do passado, esconder o nome transformaria despesa de um
        centro real em "Sem centro de custo", e o mês fechado mudaria de cara
        no dia em que alguém desativasse um centro. O JOIN não filtra `active`
        de propósito.
      */
      costCenterName: row.cost_center_name ?? SEM_CENTRO_NOME,
      revenueCents: 0,
      expenseCents: 0,
      resultCents: 0,
      entryCount: 0,
    };

    const valor = Number(row.amount_cents);
    if (row.direction === 'in') {
      linha.revenueCents += valor;
      receitaTotal += valor;
    } else if (row.direction === 'out') {
      linha.expenseCents += valor;
      despesaTotal += valor;
    } else {
      // Nenhum lançamento pode ficar fora do relatório em silêncio.
      throw new Error(
        `Centro de custo: o lançamento ${row.id} tem direção "${row.direction}", que não é 'in' nem 'out'.`,
      );
    }
    linha.resultCents = linha.revenueCents - linha.expenseCents;
    linha.entryCount += 1;
    porCentro.set(chave, linha);
  }

  const lines = [...porCentro.values()].sort(ordenarCentros);

  // A PROVA DE COBERTURA: as linhas somam os totais, ou o relatório estoura em
  // vez de devolver número errado com cara de certo.
  const somaReceita = lines.reduce((acc, l) => acc + l.revenueCents, 0);
  const somaDespesa = lines.reduce((acc, l) => acc + l.expenseCents, 0);
  const somaCount = lines.reduce((acc, l) => acc + l.entryCount, 0);
  if (somaReceita !== receitaTotal || somaDespesa !== despesaTotal || somaCount !== rows.length) {
    throw new Error(
      'Centro de custo: as linhas não somam o total do período — '
        + `receita ${somaReceita} contra ${receitaTotal}, despesa ${somaDespesa} contra `
        + `${despesaTotal}, ${somaCount} lançamentos contra ${rows.length}.`,
    );
  }

  const semCentro = lines.find((l) => l.costCenterId === null);

  return {
    from,
    to,
    lines,
    revenueTotalCents: receitaTotal,
    expenseTotalCents: despesaTotal,
    resultCents: receitaTotal - despesaTotal,
    entryCount: rows.length,
    unassigned: {
      entryCount: semCentro?.entryCount ?? 0,
      revenueCents: semCentro?.revenueCents ?? 0,
      expenseCents: semCentro?.expenseCents ?? 0,
    },
  };
}

/*
  ============================================================================
  A DEVOLUÇÃO AO FORNECEDOR NO FINANCEIRO (GAP-PRD-089)
  ============================================================================

  Devolver parte de uma compra muda a DÍVIDA, e são dois casos, com dois
  gestos — os dois moram aqui porque este arquivo é quem escreve título.

  ABATIMENTO — a nota ainda deve. A dívida com o fornecedor DIMINUI: não houve
  pagamento, houve mercadoria que voltou. Por isso não é baixa (baixa é
  dinheiro que saiu, e a conciliação bancária procuraria no extrato um
  pagamento que nunca existiu); é o valor do título que cai, com a frase na
  observação e o valor original guardado no documento da devolução. Se o
  abatimento leva o título a zero sem nada pago, o título é CANCELADO pelo
  carimbo — título de zero centavo seria uma dívida que não existe.

  CRÉDITO — a nota já foi paga. O fornecedor passa a DEVER: nasce um título a
  receber dele, com origem própria ('devolucao_fornecedor'), que se baixa
  quando o dinheiro voltar ou quando o crédito for compensado na próxima compra.
*/

/**
 * Abate parte de um título A PAGAR em aberto — dentro da transação de quem chama.
 *
 * O UPDATE é condicional ao saldo aberto, como a baixa: dois abatimentos
 * simultâneos não passam os dois de um saldo que só comporta um.
 */
export function abaterTituloPorDevolucao(input: {
  companyId: string;
  entryId: string;
  amountCents: number;
  observacao: string;
}): { antesCents: number; depoisCents: number; cancelado: boolean } {
  ensureCoreSchema();
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new ApiError('CORE_FINANCE_AMOUNT_INVALID', 'Informe um valor maior que zero.', 400);
  }
  const db = getConnection();
  const alvo = getEntryRow(input.companyId, input.entryId);
  if (alvo.cancelled_at || alvo.direction !== 'out') {
    throw new ApiError(
      'CORE_FINANCE_ENTRY_NOT_ABATABLE',
      'Só um título a pagar vivo pode ser abatido.',
      409,
    );
  }
  const antes = Number(alvo.amount_cents);
  const pago = Number(alvo.settled_cents ?? 0);
  const depois = antes - input.amountCents;
  const agora = new Date().toISOString();
  const nota = [String(alvo.note ?? '').trim(), input.observacao.trim()].filter(Boolean).join(' · ');

  if (depois === 0 && pago === 0) {
    // Tudo o que se devia voltou: o título deixa de existir, pelo carimbo.
    db.prepare(
      `UPDATE core_finance_entries
          SET status = 'cancelled', cancelled_at = COALESCE(cancelled_at, ?), note = ?
        WHERE id = ? AND company_id = ? AND settled_cents = 0`,
    ).run(agora, nota, input.entryId, input.companyId);
  } else {
    const r = db
      .prepare(
        `UPDATE core_finance_entries SET amount_cents = amount_cents - ?, note = ?
          WHERE id = ? AND company_id = ? AND amount_cents - settled_cents >= ?`,
      )
      .run(input.amountCents, nota, input.entryId, input.companyId, input.amountCents);
    if (Number(r.changes) === 0) {
      throw new ApiError(
        'CORE_FINANCE_ABATEMENT_EXCEEDS',
        `O abatimento passa do saldo em aberto do título (${((antes - pago) / 100).toFixed(2)}).`,
        409,
      );
    }
    aplicarStatus(input.companyId, input.entryId, agora);
  }

  const atualizado = getEntryRow(input.companyId, input.entryId);
  recordDomainEvent({
    eventType: 'finance.entry_recorded',
    aggregateType: 'finance_entry',
    aggregateId: input.entryId,
    companyId: input.companyId,
    operation: 'update',
    payload: {
      id: input.entryId,
      direction: atualizado.direction,
      amount_cents: atualizado.amount_cents,
      settled_cents: atualizado.settled_cents,
      status: atualizado.status,
      due_date: atualizado.due_date,
      settled_at: atualizado.settled_at,
      supplier_id: atualizado.supplier_id,
      description: atualizado.description,
      origin_type: atualizado.origin_type,
      origin_id: atualizado.origin_id,
    },
    occurredAt: agora,
  });
  return { antesCents: antes, depoisCents: Math.max(0, depois), cancelado: depois === 0 && pago === 0 };
}

/**
 * O crédito com o fornecedor — um título A RECEBER dele, com origem própria.
 * Dentro da transação de quem chama.
 */
export function lancarCreditoDeDevolucao(input: {
  companyId: string;
  returnId: string;
  supplierId: string | null;
  amountCents: number;
  dueDate: string;
  description: string;
  categoryId: string | null;
}): string {
  ensureCoreSchema();
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new ApiError('CORE_FINANCE_AMOUNT_INVALID', 'Informe um valor maior que zero.', 400);
  }
  const id = randomUUID();
  const agora = new Date().toISOString();
  getConnection()
    .prepare(
      `INSERT INTO core_finance_entries
         (id, company_id, direction, amount_cents, status, due_date, settled_cents,
          supplier_id, description, origin_type, origin_id, category_id, account_id,
          competence_date, created_at)
       VALUES (?, ?, 'in', ?, 'open', ?, 0, ?, ?, 'devolucao_fornecedor', ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.companyId,
      input.amountCents,
      input.dueDate,
      input.supplierId,
      input.description,
      input.returnId,
      input.categoryId,
      contaPadrao(input.companyId),
      hojeNaLoja(),
      agora,
    );
  recordDomainEvent({
    eventType: 'finance.entry_recorded',
    aggregateType: 'finance_entry',
    aggregateId: id,
    companyId: input.companyId,
    payload: {
      id,
      direction: 'in',
      amount_cents: input.amountCents,
      status: 'open',
      due_date: input.dueDate,
      supplier_id: input.supplierId,
      description: input.description,
      origin_type: 'devolucao_fornecedor',
      origin_id: input.returnId,
    },
  });
  return id;
}
