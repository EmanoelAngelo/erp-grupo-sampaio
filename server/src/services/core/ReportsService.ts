/**
 * ============================================================================
 * A CENTRAL DE RELATÓRIOS — GAP-V37
 * ============================================================================
 *
 * ## O defeito, e o tamanho dele
 *
 * NENHUM relatório saía da tela. O único gerador de CSV do repositório inteiro
 * vivia dentro do zip mensal do contador (`dre.csv`, `inutilizadas.csv`,
 * `MANIFESTO.csv`); em Posição de estoque, Movimentações, DRE, BI e Auditoria
 * não havia um botão de exportar. O gestor que precisasse do DRE de um
 * trimestre, do razão do estoque ou dos vencidos por faixa copiava número a
 * número para uma planilha — e um contador que pedisse um recorte fora do
 * pacote do mês não tinha caminho nenhum.
 *
 * As telas estavam certas (cada uma provada contra o banco). Elas terminavam
 * nelas mesmas.
 *
 * ## O DESENHO: um catálogo de DADOS, e uma consulta por relatório
 *
 * Cada relatório é uma DECLARAÇÃO — id, rótulo, grupo, filtros que ele de fato
 * usa, colunas com tipo, e a função que devolve as linhas. Três consequências,
 * e as três são o motivo de o arquivo ser assim:
 *
 *   1. A TELA E O CSV LEEM A MESMA COISA. As colunas e as linhas da exportação
 *      são exatamente as que a tela mostrou — não há um segundo SELECT "para o
 *      arquivo". Foi assim que a auditoria já encontrou telas que discordavam
 *      do próprio banco; um relatório que exporta outra consulta é a mesma
 *      doença com um passo a mais.
 *
 *   2. OS FILTROS SÃO DECLARADOS, e a tela só desenha os que existem. Oferecer
 *      um seletor de status num relatório que ignora status é a promessa que o
 *      sistema não cumpre — o mesmo defeito do botão que não fazia nada.
 *
 *   3. O TIPO DA COLUNA MANDA NA FORMATAÇÃO. `money` é CENTAVO INTEIRO até a
 *      última linha: a tela formata em reais para ler, o CSV escreve com
 *      vírgula para somar, e ninguém divide por 100 no meio do caminho.
 *
 * ## O QUE ESTA CENTRAL NÃO FAZ, e por que está escrito
 *
 * NÃO EXISTE PDF, e não é adiamento: não há biblioteca de PDF no servidor
 * (`DanfeRenderer` e `ServiceOrderA4` montam HTML para o navegador imprimir,
 * não PDF). Prometer um botão "PDF" que gera HTML com outro nome seria o
 * rótulo mentiroso que este projeto já removeu de outros lugares. A tela
 * oferece CSV e diz que a impressão em papel é a do navegador.
 *
 * NÃO HÁ AGENDAMENTO nem envio: o pacote do contador tem o dele (GAP-V30/V31),
 * e duplicá-lo aqui criaria duas filas para a mesma coisa.
 *
 * ## O TETO, e por que ele é DECLARADO em vez de silencioso
 *
 * O relatório é montado inteiro na memória e vai inteiro para o navegador. Um
 * `LIMIT` calado é o defeito que a auditoria pegou na lista de vendas — 205
 * viravam 200 sem uma palavra, e o painel afirmava um total que a lista não
 * somava. Aqui o corte existe, é grande, e vem com `truncated: true` e a
 * contagem: quem lê sabe que precisa estreitar o período.
 *
 * E ele voltou por HERANÇA: dois relatórios chamavam serviço com `LIMIT`
 * próprio (500) e ficavam com o dele, respondendo `truncated: false` sobre uma
 * página. Por isso o teto de cada relatório é hoje um campo OBRIGATÓRIO —
 * `ReportSpec.teto` —, e relatório novo que o esqueça não compila. Ver
 * `TetoDoRelatorio`.
 */
import { ApiError } from '../../utils/errors.js';
import { getConnection } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { diaDaLojaSql, hojeNaLoja, mesDaLoja } from './CalendarioOperacional.js';
import { linhaCsv, montarCsv, reaisCsv } from './Csv.js';
import { agingPorFaixas, listEntries } from './FinanceService.js';
import { incomeStatement } from './IncomeStatementService.js';
import { listMovements, listStock } from './InventoryService.js';
import { listBatches } from './BatchService.js';
import { summarize as summarizeCommissions } from './CommissionService.js';
import { recorteDoPedidoQueFatura, sqlDeMarcas } from './GroupInsights.js';
import { ORDER_STATUS_LABEL } from './StorefrontService.js';

/** O canal de cada linha de venda (GAP-PRD-132). */
const CANAL_BALCAO = 'Balcão e oficina';
const CANAL_ONLINE = 'Loja online';
const VENDEDOR_ONLINE = 'Loja online (sem vendedor)';

/**
 * O teto de linhas de um relatório. Grande o bastante para o mês de uma loja,
 * pequeno o bastante para não derrubar o servidor com um pedido de "tudo".
 */
export const TETO_DE_LINHAS = 5_000;

/**
 * ============================================================================
 * DE ONDE VEM O TETO DE CADA RELATÓRIO — e por que isto é um TIPO, e não prosa
 * ============================================================================
 *
 * ## O defeito que este tipo fecha
 *
 * A Central declarava um teto de 5000 e detectava o corte com
 * `todas.length > TETO_DE_LINHAS`. A conta só é verdadeira se a consulta de
 * baixo devolver TUDO — ou uma linha a mais que o teto, como `movimentacoes`
 * fazia de propósito.
 *
 * Dois relatórios não faziam nem uma coisa nem outra: chamavam serviço com
 * teto PRÓPRIO e ficavam com o dele. `validade` pegava o `LIMIT 500` padrão de
 * `listBatches`; `financeiro`, o `LIMIT 500` cravado no SQL de `listEntries`.
 * A resposta saía com `truncated: false`, o rodapé somava só o que sobrou, e o
 * CSV exportava o recorte COMO SE FOSSE O TODO. É a doença que o cabeçalho
 * deste arquivo já descrevia na lista de vendas — "205 viravam 200 sem uma
 * palavra" — reaparecendo por herança.
 *
 * ## Por que declarar, e não só acertar os dois
 *
 * Acertar os dois deixaria o TERCEIRO nascer com o mesmo defeito, calado, no
 * dia em que alguém plugasse outro serviço com `LIMIT` próprio — que é
 * exatamente como estes dois nasceram. Aqui o teto é campo OBRIGATÓRIO de
 * `ReportSpec`: relatório novo sem `teto` não compila. E as formas são duas e
 * só duas, sem "outro" nem opcional, para que a escolha seja consciente:
 *
 *   - `{ fonte: 'central' }` — a consulta NÃO corta (nenhum LIMIT no caminho),
 *     então quem corta é a Central, em `TETO_DE_LINHAS`;
 *   - `{ fonte: 'propria', linhas: N }` — a consulta corta em N, e a Central
 *     precisa saber disso para não chamar de "tudo" o que é uma página.
 *
 * Pedir `TETO_DE_LINHAS + 1` à fonte e declarar esse número é o padrão da
 * casa: a linha excedente é justamente o que faz `todas.length > TETO` dizer
 * a verdade.
 */
export type TetoDoRelatorio =
  | { fonte: 'central' }
  | { fonte: 'propria'; linhas: number };

/**
 * Truncou? E onde cortar?
 *
 * Pura, exportada e testada sozinha — a decisão que estava embutida em uma
 * linha do `runReport` e por isso não tinha como ser exercitada sem encher o
 * banco de cinco mil linhas.
 *
 * A REGRA NOVA: bater no teto da FONTE já é truncar, mesmo abaixo dos 5000.
 * Com 500 linhas vindas de uma consulta que devolve no máximo 500, o sistema
 * NÃO SABE se há mais — e `truncated: false` afirmaria que acabou. "Cheguei ao
 * limite do que consigo perguntar" e "acabou" são estados diferentes, e esta
 * casa não deixa os dois terem a mesma cara.
 */
export function truncagem(
  quantasVieram: number,
  teto: TetoDoRelatorio,
): { truncated: boolean; corte: number } {
  const corte = teto.fonte === 'propria' ? Math.min(teto.linhas, TETO_DE_LINHAS) : TETO_DE_LINHAS;
  const bateuNaFonte = teto.fonte === 'propria' && quantasVieram >= teto.linhas;
  return { truncated: bateuNaFonte || quantasVieram > TETO_DE_LINHAS, corte };
}

export type ColumnKind = 'text' | 'money' | 'quantity' | 'number' | 'date' | 'datetime';

export interface ReportColumn {
  key: string;
  label: string;
  kind: ColumnKind;
}

/** Os filtros que a Central sabe desenhar. Cada relatório declara os SEUS. */
export type ReportFilter = 'periodo' | 'situacao' | 'direcao' | 'categoria' | 'busca';

export interface ReportDefinition {
  id: string;
  label: string;
  /** Onde ele aparece na Central — o mesmo vocabulário do menu. */
  group: 'Vendas' | 'Estoque' | 'Financeiro' | 'Compras';
  description: string;
  filters: ReportFilter[];
  columns: ReportColumn[];
  /**
   * A ressalva do relatório, quando ele tem uma. Ela vem do SERVIDOR pela
   * mesma razão das ressalvas do DRE: a tela renderiza o que recebe e não tem
   * como esquecer justamente a frase que incomoda.
   */
  caveat?: string;
}

export interface ReportQuery {
  companyId: string;
  from: string;
  to: string;
  situacao?: string;
  direcao?: 'in' | 'out';
  categoria?: string;
  busca?: string;
}

export interface ReportResult {
  report: ReportDefinition;
  from: string;
  to: string;
  rows: Record<string, unknown>[];
  /** Soma por coluna de dinheiro/quantidade — a mesma que o rodapé mostra. */
  totals: Record<string, number>;
  generatedAt: string;
  /** Passou do teto? A resposta DIZ, em vez de cortar em silêncio. */
  truncated: boolean;
  rowCount: number;
}

interface ReportSpec extends ReportDefinition {
  run: (q: ReportQuery) => Record<string, unknown>[];
  /**
   * OBRIGATÓRIO, e é essa obrigatoriedade que é o conserto.
   *
   * Sem o campo, um relatório novo herda em silêncio o `LIMIT` de quem ele
   * consulta e a Central chama a página de "tudo". Com ele, esquecer não
   * compila. Ver `TetoDoRelatorio`.
   */
  teto: TetoDoRelatorio;
}

/** A consulta não corta; quem corta é a Central. O caso da maioria. */
const TETO_DA_CENTRAL: TetoDoRelatorio = { fonte: 'central' };

/**
 * A fonte recebe UMA LINHA A MAIS que o teto da Central — é o que faz
 * `todas.length > TETO_DE_LINHAS` dizer a verdade em vez de empatar no limite.
 */
const TETO_PEDIDO_A_FONTE: TetoDoRelatorio = { fonte: 'propria', linhas: TETO_DE_LINHAS + 1 };

// ---------------------------------------------------------------------------
// Ferramentas comuns
// ---------------------------------------------------------------------------

function col(key: string, label: string, kind: ColumnKind = 'text'): ReportColumn {
  return { key, label, kind };
}

/** Centavo inteiro, sempre. Nulo e lixo viram zero em vez de NaN na planilha. */
function centavos(valor: unknown): number {
  const n = Number(valor ?? 0);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

// ---------------------------------------------------------------------------
// O catálogo
// ---------------------------------------------------------------------------

const RELATORIOS: ReportSpec[] = [
  // ------------------------------------------------------------------ Vendas
  {
    id: 'vendas',
    teto: TETO_DA_CENTRAL,
    label: 'Vendas do período',
    group: 'Vendas',
    description:
      'Uma linha por venda — balcão, oficina e loja online: número, canal, data, cliente, '
      + 'vendedor e total.',
    filters: ['periodo', 'situacao'],
    columns: [
      col('numero', 'Número', 'number'),
      col('canal', 'Canal'),
      col('dia', 'Dia', 'date'),
      col('cliente', 'Cliente'),
      col('vendedor', 'Vendedor'),
      col('situacao', 'Situação'),
      col('itens', 'Itens', 'quantity'),
      col('total_cents', 'Total', 'money'),
    ],
    caveat:
      'O dia é o da LOJA (fuso de São Paulo): a venda das 21h30 pertence ao dia em '
      + 'que o operador a fez, não ao dia de Greenwich. O PEDIDO ONLINE entra quando é '
      + 'PAGO, no dia do pagamento e pelo total pago (itens + frete) — a mesma régua do '
      + 'DRE; o cancelado nunca foi receita e não entra, e o reembolsado continua na venda '
      + 'do dia em que foi pago (o reembolso aparece como devolução no dia dele). O número '
      + 'do pedido online é da numeração da loja, separada da do balcão.',
    run: (q) => {
      /*
        A SITUAÇÃO É FILTRO DECLARADO, e o padrão é "só concluída".

        Um relatório de vendas que somasse a cancelada junto teria total maior
        que o painel do mesmo dia — e alguém escolheria o número preferido. O
        padrão é o do painel; quem quiser ver as canceladas pede por elas.
      */
      const situacao = q.situacao === 'todas' ? null : (q.situacao || 'completed');
      const params: (string | number)[] = [q.companyId, q.from, q.to];
      let filtro = '';
      if (situacao) {
        filtro = ' AND s.status = ?';
        params.push(situacao);
      }
      const balcao = getConnection()
        .prepare(
          `SELECT s.number AS numero,
                  '${CANAL_BALCAO}' AS canal,
                  ${diaDaLojaSql('s.created_at')} AS dia,
                  COALESCE(c.name, 'Consumidor') AS cliente,
                  COALESCE(u.display_name, 'Sem vendedor') AS vendedor,
                  s.status AS situacao,
                  (SELECT COALESCE(SUM(i.quantity), 0) FROM core_sale_items i
                    WHERE i.sale_id = s.id) AS itens,
                  s.total_cents
             FROM core_sales s
             LEFT JOIN core_customers c ON c.id = s.customer_id
             LEFT JOIN core_users u ON u.id = s.seller_id
            WHERE s.company_id = ?
              AND ${diaDaLojaSql('s.created_at')} >= ? AND ${diaDaLojaSql('s.created_at')} <= ?
              ${filtro}
            ORDER BY s.number DESC`,
        )
        .all(...params) as Record<string, unknown>[];

      /*
        O PEDIDO ONLINE PAGO TAMBÉM É VENDA DO PERÍODO (GAP-PRD-132).

        Este relatório lia só `core_sales` e o DRE contava o pedido: o gestor
        achava dois faturamentos para o mesmo mês. O pedido não vira venda de
        balcão (lançaria a receita duas vezes); ele entra aqui, com canal
        próprio, pela régua do DRE. Pedido cancelado nunca foi receita: pedir
        "só as canceladas" não o traz.
      */
      const online =
        situacao === null || situacao === 'completed'
          ? (
              getConnection()
                .prepare(
                  `SELECT o.number AS numero,
                          '${CANAL_ONLINE}' AS canal,
                          ${diaDaLojaSql('o.paid_at')} AS dia,
                          o.customer_name AS cliente,
                          '${VENDEDOR_ONLINE}' AS vendedor,
                          o.status AS situacao,
                          (SELECT COALESCE(SUM(i.quantity), 0) FROM core_order_items i
                            WHERE i.order_id = o.id) AS itens,
                          o.total_cents
                     FROM core_orders o
                    WHERE o.company_id = ? AND ${recorteDoPedidoQueFatura('o')}
                      AND ${diaDaLojaSql('o.paid_at')} >= ? AND ${diaDaLojaSql('o.paid_at')} <= ?
                    ORDER BY o.paid_at DESC`,
                )
                .all(q.companyId, q.from, q.to) as Record<string, unknown>[]
            ).map((l) => ({
              ...l,
              situacao: `Pedido ${String(ORDER_STATUS_LABEL[String(l.situacao)] ?? l.situacao).toLowerCase()}`,
            }))
          : [];
      return [...balcao, ...online];
    },
  },
  {
    id: 'produtos',
    teto: TETO_DA_CENTRAL,
    label: 'Produtos vendidos',
    group: 'Vendas',
    description: 'Quanto saiu de cada produto e quanto dinheiro ele trouxe.',
    filters: ['periodo'],
    columns: [
      col('codigo', 'Código'),
      col('produto', 'Produto'),
      col('quantidade', 'Quantidade', 'quantity'),
      col('revenue_cents', 'Faturamento', 'money'),
    ],
    caveat:
      'O que mais SAI em peça nem sempre é o que traz mais dinheiro — por isso as '
      + 'duas colunas, e nunca uma só. Inclui os itens dos pedidos da loja online PAGOS no '
      + 'período (pelo dia do pagamento), sem o frete.',
    run: (q) =>
      getConnection()
        .prepare(
          // Balcão e loja online juntos, por produto (GAP-PRD-132): o item
          // vendido no site é o mesmo produto do item vendido no balcão.
          `SELECT codigo, produto, SUM(quantidade) AS quantidade, SUM(revenue_cents) AS revenue_cents
             FROM (
               SELECT i.product_id, COALESCE(p.internal_code, '') AS codigo,
                      i.description AS produto, i.quantity AS quantidade,
                      i.total_cents AS revenue_cents
                 FROM core_sale_items i
                 JOIN core_sales s ON s.id = i.sale_id
                 LEFT JOIN core_products p ON p.id = i.product_id
                WHERE i.company_id = ? AND s.status = 'completed'
                  AND ${diaDaLojaSql('s.created_at')} >= ? AND ${diaDaLojaSql('s.created_at')} <= ?
               UNION ALL
               SELECT oi.product_id, COALESCE(p.internal_code, ''), oi.description,
                      oi.quantity, oi.total_cents
                 FROM core_order_items oi
                 JOIN core_orders o ON o.id = oi.order_id
                 LEFT JOIN core_products p ON p.id = oi.product_id
                WHERE o.company_id = ? AND ${recorteDoPedidoQueFatura('o')}
                  AND ${diaDaLojaSql('o.paid_at')} >= ? AND ${diaDaLojaSql('o.paid_at')} <= ?
             )
            GROUP BY product_id, produto, codigo
            ORDER BY revenue_cents DESC`,
        )
        .all(q.companyId, q.from, q.to, q.companyId, q.from, q.to) as Record<string, unknown>[],
  },
  {
    id: 'vendedor',
    teto: TETO_DA_CENTRAL,
    label: 'Vendas por vendedor',
    group: 'Vendas',
    description:
      'Quantas vendas e quanto faturou cada pessoa do balcão — e a loja online, numa linha própria.',
    filters: ['periodo'],
    columns: [
      col('vendedor', 'Vendedor'),
      col('sales_count', 'Vendas', 'number'),
      col('revenue_cents', 'Faturamento', 'money'),
      col('ticket_cents', 'Ticket médio', 'money'),
    ],
    caveat:
      'Pedido da loja online não tem vendedor: aparece na linha "Loja online (sem '
      + 'vendedor)", pelo dia do pagamento. A comissão continua apurada só sobre a venda de '
      + 'balcão e oficina.',
    run: (q) => {
      const balcao = getConnection()
        .prepare(
          `SELECT COALESCE(u.display_name, 'Sem vendedor') AS vendedor,
                  COUNT(*) AS sales_count,
                  COALESCE(SUM(s.total_cents), 0) AS revenue_cents,
                  CAST(ROUND(COALESCE(SUM(s.total_cents), 0) * 1.0 / COUNT(*)) AS INTEGER)
                    AS ticket_cents
             FROM core_sales s
             LEFT JOIN core_users u ON u.id = s.seller_id
            WHERE s.company_id = ? AND s.status = 'completed'
              AND ${diaDaLojaSql('s.created_at')} >= ? AND ${diaDaLojaSql('s.created_at')} <= ?
            GROUP BY s.seller_id, u.display_name`,
        )
        .all(q.companyId, q.from, q.to) as Record<string, unknown>[];
      // A loja online no ranking (GAP-PRD-132): uma linha, só quando vendeu.
      const online = getConnection()
        .prepare(
          `SELECT '${VENDEDOR_ONLINE}' AS vendedor,
                  COUNT(*) AS sales_count,
                  COALESCE(SUM(o.total_cents), 0) AS revenue_cents,
                  CAST(ROUND(COALESCE(SUM(o.total_cents), 0) * 1.0 / COUNT(*)) AS INTEGER)
                    AS ticket_cents
             FROM core_orders o
            WHERE o.company_id = ? AND ${recorteDoPedidoQueFatura('o')}
              AND ${diaDaLojaSql('o.paid_at')} >= ? AND ${diaDaLojaSql('o.paid_at')} <= ?
           HAVING COUNT(*) > 0`,
        )
        .all(q.companyId, q.from, q.to) as Record<string, unknown>[];
      return [...balcao, ...online].sort(
        (a, b) => Number(b.revenue_cents) - Number(a.revenue_cents),
      );
    },
  },
  {
    id: 'marca',
    teto: TETO_DA_CENTRAL,
    label: 'Vendas por marca',
    group: 'Vendas',
    description: 'Qual marca vendeu mais no período — em peça e em dinheiro.',
    filters: ['periodo'],
    columns: [
      col('brand', 'Marca'),
      col('quantity', 'Quantidade', 'quantity'),
      col('sales_count', 'Vendas', 'number'),
      col('revenue_cents', 'Faturamento', 'money'),
    ],
    caveat:
      '"Sem marca" é um GRUPO, não um filtro: produto sem marca cadastrada, com o '
      + 'campo em branco, e linha de serviço caem nele — sem isso o relatório '
      + 'nasceria vazio e a soma não fecharia com o faturamento. O desconto de '
      + 'rodapé da venda não é rateado entre as marcas: ele não tem dono entre as '
      + 'linhas, e escolher um critério inventaria número.',
    run: (q) =>
      getConnection()
        .prepare(
          // O recorte de STATUS não é escrito aqui: `sqlDeMarcas` o acrescenta
          // sempre, para que este relatório, o painel e o BI não possam
          // divergir sobre o que é faturamento. Ver `RECORTE_DA_VENDA_QUE_FATURA`.
          sqlDeMarcas(
            `i.company_id = ?
               AND ${diaDaLojaSql('s.created_at')} >= ? AND ${diaDaLojaSql('s.created_at')} <= ?`,
          ),
        )
        .all(q.companyId, q.from, q.to) as Record<string, unknown>[],
  },
  {
    id: 'comissao',
    teto: TETO_DA_CENTRAL,
    label: 'Comissão por vendedor',
    group: 'Vendas',
    description: 'Apurado, estornado e saldo por vendedor na competência.',
    filters: ['periodo'],
    columns: [
      col('vendedor', 'Vendedor'),
      col('apurado_cents', 'Apurado', 'money'),
      col('estornado_cents', 'Estornado', 'money'),
      col('saldo_cents', 'Saldo', 'money'),
      col('aberto', 'Lançamentos em aberto', 'number'),
    ],
    caveat:
      'Venda de vendedor sem grupo de comissão, ou cujo valor não alcança faixa '
      + 'nenhuma, NÃO gera linha aqui — some do relatório sem sumir do '
      + 'faturamento. A tela de Comissões mostra o contador dessas vendas.',
    run: (q) =>
      summarizeCommissions(q.companyId, q.from, q.to).rows.map((r) => ({
        vendedor: r.sellerName ?? 'Sem vendedor',
        apurado_cents: r.apuradoCents,
        estornado_cents: r.estornadoCents,
        saldo_cents: r.saldoCents,
        aberto: r.aberto,
      })),
  },

  // ----------------------------------------------------------------- Estoque
  {
    id: 'estoque',
    teto: TETO_DA_CENTRAL,
    label: 'Posição de estoque',
    group: 'Estoque',
    description: 'Saldo, reservado, mínimo, custo e preço de cada produto.',
    filters: ['busca'],
    columns: [
      col('internal_code', 'Código'),
      col('name', 'Produto'),
      col('unit', 'Unidade'),
      col('quantity', 'Saldo', 'quantity'),
      col('reserved', 'Reservado', 'quantity'),
      col('min_stock', 'Mínimo', 'quantity'),
      col('cost_cents', 'Custo unitário', 'money'),
      col('price_cents', 'Preço', 'money'),
      col('value_cents', 'Valor em estoque', 'money'),
    ],
    caveat:
      'É a posição de AGORA, não a do fim do período: saldo não tem data. Produto '
      + 'que não controla estoque (serviço de balcão) fica de fora.',
    run: (q) =>
      listStock(q.companyId, { search: q.busca }) as unknown as Record<string, unknown>[],
  },
  {
    id: 'minimo',
    teto: TETO_DA_CENTRAL,
    label: 'Abaixo do estoque mínimo',
    group: 'Estoque',
    description: 'O que precisa ser reposto, com o quanto falta.',
    filters: ['busca'],
    columns: [
      col('internal_code', 'Código'),
      col('name', 'Produto'),
      col('quantity', 'Saldo', 'quantity'),
      col('min_stock', 'Mínimo', 'quantity'),
      col('falta', 'Falta', 'quantity'),
      col('cost_cents', 'Custo unitário', 'money'),
    ],
    run: (q) =>
      listStock(q.companyId, { lowOnly: true, search: q.busca }).map((l) => ({
        internal_code: l.internal_code,
        name: l.name,
        quantity: l.quantity,
        min_stock: l.min_stock,
        // A conta que a tela fazia de cabeça. Nunca negativa: quem está acima
        // do mínimo não aparece nesta lista.
        falta: Math.max(Number(l.min_stock ?? 0) - Number(l.quantity ?? 0), 0),
        cost_cents: l.cost_cents,
      })),
  },
  {
    id: 'valorizacao',
    teto: TETO_DA_CENTRAL,
    label: 'Valorização do estoque',
    group: 'Estoque',
    description: 'Quanto vale a prateleira, produto a produto — saldo × custo.',
    filters: ['busca'],
    columns: [
      col('internal_code', 'Código'),
      col('name', 'Produto'),
      col('quantity', 'Saldo', 'quantity'),
      col('cost_cents', 'Custo unitário', 'money'),
      col('value_cents', 'Valor', 'money'),
    ],
    caveat:
      'O custo é o da RÉGUA escolhida em Configurações › Política de gestão (GAP-PRD-166): '
      + 'por padrão o do CADASTRO de hoje (último custo); com "custo médio", a média '
      + 'móvel das entradas registradas no razão. Quem precisa do custo histórico de uma '
      + 'saída lê o razão em Movimentações. Produto com saldo e sem custo entra com valor '
      + 'zero — e a coluna de custo mostra o zero, para a pendência de cadastro aparecer.',
    run: (q) =>
      listStock(q.companyId, { search: q.busca })
        .filter((l) => Number(l.quantity ?? 0) !== 0)
        .map((l) => ({
          internal_code: l.internal_code,
          name: l.name,
          quantity: l.quantity,
          // O custo que a régua USOU — a coluna e o valor são a mesma conta.
          cost_cents: (l as { valuation_cost_cents?: number }).valuation_cost_cents ?? l.cost_cents,
          value_cents: l.value_cents,
        }))
        .sort((a, b) => centavos(b.value_cents) - centavos(a.value_cents)),
  },
  {
    id: 'movimentacoes',
    teto: TETO_PEDIDO_A_FONTE,
    label: 'Movimentações de estoque',
    group: 'Estoque',
    description: 'O razão do período: o que entrou, o que saiu e por quê.',
    filters: ['periodo', 'busca'],
    columns: [
      col('created_at', 'Quando', 'datetime'),
      col('internal_code', 'Código'),
      col('product_name', 'Produto'),
      col('kind', 'Tipo'),
      col('quantity', 'Quantidade', 'quantity'),
      col('balance_after', 'Saldo depois', 'quantity'),
      col('unit_cost_cents', 'Custo unitário', 'money'),
      col('document_number', 'Documento'),
      col('reason', 'Motivo'),
      col('user_name', 'Quem'),
    ],
    caveat:
      'Cada linha é um FATO do razão e não muda depois de gravada. O saldo de hoje '
      + 'é a soma delas — não há segundo cache.',
    run: (q) =>
      listMovements(q.companyId, {
        from: q.from,
        to: q.to,
        search: q.busca,
        limit: TETO_DE_LINHAS + 1,
      }) as unknown as Record<string, unknown>[],
  },
  {
    id: 'validade',
    teto: TETO_PEDIDO_A_FONTE,
    label: 'Validade e lotes',
    group: 'Estoque',
    description: 'Lote a lote: quanto sobrou, quando vence e se já foi conferido.',
    filters: ['busca'],
    columns: [
      col('code', 'Lote'),
      col('internal_code', 'Código'),
      col('product_name', 'Produto'),
      col('expires_on', 'Vence em', 'date'),
      col('dias_para_vencer', 'Dias', 'number'),
      col('faixa', 'Situação'),
      col('quantity', 'Saldo', 'quantity'),
      col('value_cents', 'Valor', 'money'),
      col('checked_at', 'Conferido em', 'datetime'),
    ],
    caveat:
      'O dia impresso ainda vale: lote que vence HOJE não está vencido. Saldo sem '
      + 'lote declarado não aparece aqui — ele é a pendência que a tela de Validade '
      + 'nomeia.',
    run: (q) =>
      /*
        O LIMITE VAI EXPLÍCITO — sem ele, `listBatches` aplicava o default dela
        (`LIMIT 500`) e a Central chamava a página de "tudo", com
        `truncated: false`. Ver `TetoDoRelatorio`.
      */
      listBatches(q.companyId, {
        search: q.busca,
        limit: TETO_DE_LINHAS + 1,
      }) as unknown as Record<string, unknown>[],
  },

  // -------------------------------------------------------------- Financeiro
  {
    id: 'financeiro',
    teto: TETO_PEDIDO_A_FONTE,
    label: 'Títulos a pagar e a receber',
    group: 'Financeiro',
    description: 'Lançamentos com vencimento, saldo, origem e categoria.',
    filters: ['periodo', 'direcao', 'situacao', 'categoria', 'busca'],
    columns: [
      col('due_date', 'Vencimento', 'date'),
      col('direcao', 'Direção'),
      col('description', 'Descrição'),
      col('counterparty', 'Contraparte'),
      col('categoria', 'Categoria'),
      col('origem', 'Origem'),
      col('parcela', 'Parcela'),
      col('amount_cents', 'Valor', 'money'),
      col('settled_cents', 'Baixado', 'money'),
      col('balance_cents', 'Saldo', 'money'),
      col('situacao', 'Situação'),
    ],
    caveat:
      'O período recorta pelo VENCIMENTO, e não pela competência — é a pergunta de '
      + 'quem cobra e de quem paga. O resultado por competência é o relatório DRE. '
      + 'Lançamento cancelado não entra.',
    run: (q) => {
      const itens = listEntries(q.companyId, {
        direction: q.direcao,
        situation: q.situacao && q.situacao !== 'todas' ? q.situacao : undefined,
        dueFrom: q.from,
        dueTo: q.to,
        categoryId: q.categoria,
        search: q.busca,
        /*
          O LIMITE VAI EXPLÍCITO. `listEntries` tinha `LIMIT 500` cravado no
          SQL e nenhum jeito de pedir mais: a Central herdava o teto da TELA de
          Contas e chamava as 500 de "tudo". Ver `TetoDoRelatorio`.
        */
        limit: TETO_DE_LINHAS + 1,
      });
      /*
        O FILTRO DE CANCELADO É REDUNDANTE E FICA — `listEntries` já exclui
        `cancelled_at IS NOT NULL` no WHERE, ANTES do corte, e a auditoria
        suspeitou (sem confirmar) que ele filtrasse DEPOIS. Não filtra. A linha
        continua aqui como cinto de segurança barato, com esta nota para
        ninguém a ler como prova de que o serviço não filtra.
      */
      return itens
        .filter((e) => !e.cancelledAt)
        .map((e) => ({
          due_date: e.dueDate,
          direcao: e.direction === 'in' ? 'A receber' : 'A pagar',
          description: e.description,
          counterparty: e.counterpartyName ?? '',
          categoria: e.categoryName ?? 'Sem categoria',
          origem: e.originLabel ?? e.originType,
          parcela: `${e.installmentNumber}/${e.installmentTotal}`,
          amount_cents: e.amountCents,
          settled_cents: e.settledCents,
          balance_cents: e.balanceCents,
          situacao: e.overdue ? 'Vencido' : e.status,
        }));
    },
  },
  {
    id: 'aging',
    teto: TETO_DA_CENTRAL,
    label: 'Vencidos por faixa de idade',
    group: 'Financeiro',
    description: 'A receber e a pagar, separados por há quanto tempo venceram.',
    filters: [],
    columns: [
      col('direcao', 'Direção'),
      col('nao_vencido_cents', 'A vencer', 'money'),
      col('d1_30_cents', '1 a 30 dias', 'money'),
      col('d31_60_cents', '31 a 60 dias', 'money'),
      col('d61_90_cents', '61 a 90 dias', 'money'),
      col('d90_cents', 'Mais de 90 dias', 'money'),
    ],
    caveat:
      'A régua é HOJE no fuso da loja, e quem envelhece é o SALDO — não o valor '
      + 'original. Conta de 100 com 40 pagos deve 60, e são os 60 que aparecem na '
      + 'faixa. Por isso este relatório não tem período: ele é uma fotografia de '
      + 'agora.',
    run: (q) =>
      (['in', 'out'] as const).map((d) => {
        const f = agingPorFaixas(q.companyId, d);
        return {
          direcao: d === 'in' ? 'A receber' : 'A pagar',
          nao_vencido_cents: f.notDueCents,
          d1_30_cents: f.days1to30Cents,
          d31_60_cents: f.days31to60Cents,
          d61_90_cents: f.days61to90Cents,
          d90_cents: f.over90Cents,
        };
      }),
  },
  {
    id: 'dre',
    teto: TETO_DA_CENTRAL,
    label: 'Resultado do período (DRE)',
    group: 'Financeiro',
    description: 'Receita e despesa por categoria, por competência, com o resultado.',
    filters: ['periodo'],
    columns: [
      col('lado', 'Lado'),
      col('categoria', 'Categoria'),
      col('lancamentos', 'Lançamentos', 'number'),
      col('valor_cents', 'Valor', 'money'),
    ],
    caveat:
      'É regime de COMPETÊNCIA, não de caixa. As linhas de TOTAL e de RESULTADO '
      + 'entram na tabela como linhas — some as de Receita e as de Despesa '
      + 'separadamente, nunca a coluna inteira.',
    run: (q) => {
      const dre = incomeStatement(q.companyId, q.from, q.to);
      const linhas: Record<string, unknown>[] = [];
      for (const l of dre.revenue.lines) {
        linhas.push({
          lado: 'Receita',
          categoria: l.categoryName,
          lancamentos: l.entryCount,
          valor_cents: l.totalCents,
        });
      }
      linhas.push({
        lado: 'Receita',
        categoria: 'TOTAL',
        lancamentos: dre.revenue.entryCount,
        valor_cents: dre.revenue.totalCents,
      });
      for (const l of dre.expense.lines) {
        linhas.push({
          lado: 'Despesa',
          categoria: l.categoryName,
          lancamentos: l.entryCount,
          valor_cents: l.totalCents,
        });
      }
      linhas.push({
        lado: 'Despesa',
        categoria: 'TOTAL',
        lancamentos: dre.expense.entryCount,
        valor_cents: dre.expense.totalCents,
      });
      linhas.push({
        lado: 'Resultado',
        categoria: 'Receita − Despesa',
        lancamentos: '',
        valor_cents: dre.resultCents,
      });
      /*
        O CMV ENTRA COMO LINHA PRÓPRIA, e nunca dentro do resultado (GAP-V28).

        A compra da mercadoria já é despesa neste mesmo relatório, no título da
        nota de entrada. Somar o CMV ao resultado tiraria a mesma compra duas
        vezes. Ele aparece abaixo do resultado, nomeado, com a régua dele.
      */
      linhas.push({
        lado: 'CMV (gerencial)',
        categoria: `Custo do vendido — ${dre.cogs.itemsWithCost} linha(s) com custo`,
        lancamentos: dre.cogs.itemsWithCost,
        valor_cents: dre.cogs.costCents,
      });
      return linhas;
    },
  },

  // ----------------------------------------------------------------- Compras
  {
    id: 'compras',
    teto: TETO_DA_CENTRAL,
    label: 'Notas de entrada',
    group: 'Compras',
    description: 'O que entrou de fornecedor no período, com situação e total.',
    filters: ['periodo', 'situacao'],
    columns: [
      col('emitida_em', 'Emissão', 'date'),
      col('numero', 'Número'),
      col('serie', 'Série'),
      col('fornecedor', 'Fornecedor'),
      col('especie', 'Espécie'),
      col('situacao', 'Situação'),
      col('total_cents', 'Total', 'money'),
      col('recebida_em', 'Recebida em', 'datetime'),
      col('recebida_por', 'Recebida por'),
    ],
    caveat:
      'O recorte é pela data de EMISSÃO da nota — quando ela não tem emissão '
      + 'declarada, vale o dia em que entrou no sistema. Nota estornada aparece '
      + 'com a situação dela, e não some: o estorno é fato, não apagamento.',
    run: (q) => {
      const params: (string | number)[] = [q.companyId, q.from, q.to];
      let filtro = '';
      if (q.situacao && q.situacao !== 'todas') {
        filtro = ' AND n.status = ?';
        params.push(q.situacao);
      }
      return getConnection()
        .prepare(
          `SELECT COALESCE(SUBSTR(n.issued_at, 1, 10), ${diaDaLojaSql('n.created_at')})
                    AS emitida_em,
                  n.number AS numero, n.series AS serie,
                  COALESCE(s.name, 'Sem fornecedor') AS fornecedor,
                  COALESCE(n.doc_type, 'nfe') AS especie,
                  n.status AS situacao,
                  n.total_cents,
                  n.received_at AS recebida_em,
                  COALESCE(u.display_name, '') AS recebida_por
             FROM core_inbound_notes n
             LEFT JOIN core_suppliers s ON s.id = n.supplier_id
             LEFT JOIN core_users u ON u.id = n.received_by
            WHERE n.company_id = ?
              AND COALESCE(SUBSTR(n.issued_at, 1, 10), ${diaDaLojaSql('n.created_at')}) >= ?
              AND COALESCE(SUBSTR(n.issued_at, 1, 10), ${diaDaLojaSql('n.created_at')}) <= ?
              ${filtro}
            ORDER BY emitida_em DESC, n.number DESC`,
        )
        .all(...params) as Record<string, unknown>[];
    },
  },
];

// ---------------------------------------------------------------------------
// A API do serviço
// ---------------------------------------------------------------------------

/**
 * O catálogo SEM as funções — é isto que a tela desenha.
 *
 * A separação é o que impede a consulta de viajar até o navegador junto da
 * descrição dela.
 */
export function listReports(): ReportDefinition[] {
  return RELATORIOS.map((spec) => semARotina(spec));
}

/** A declaração do relatório, sem o `run`. Um lugar só, dois chamadores. */
function semARotina(spec: ReportSpec): ReportDefinition {
  return {
    id: spec.id,
    label: spec.label,
    group: spec.group,
    description: spec.description,
    filters: spec.filters,
    columns: spec.columns,
    caveat: spec.caveat,
  };
}

function acharRelatorio(id: string): ReportSpec {
  const achado = RELATORIOS.find((r) => r.id === id);
  if (!achado) {
    throw new ApiError(
      'CORE_REPORT_NOT_FOUND',
      `Relatório "${id}" não existe. Veja a lista em GET /core/reports.`,
      404,
    );
  }
  return achado;
}

/**
 * O período efetivo do pedido.
 *
 * O padrão é o MÊS CORRENTE da loja, e não "tudo": um relatório sem recorte
 * somaria a história inteira da empresa numa coluna só, que é resultado de
 * período nenhum — a mesma decisão que o DRE já toma na rota dele.
 */
export function periodoDoPedido(from?: string, to?: string): { from: string; to: string } {
  const mes = mesDaLoja();
  const inicio = (from ?? '').trim() || `${mes}-01`;
  const fim = (to ?? '').trim() || hojeNaLoja();
  if (inicio > fim) {
    throw new ApiError(
      'CORE_REPORT_INVALID_PERIOD',
      `O início (${inicio}) é depois do fim (${fim}).`,
      400,
    );
  }
  return { from: inicio, to: fim };
}

/**
 * Roda um relatório e devolve linhas + totais.
 *
 * OS TOTAIS SÃO CALCULADOS AQUI, sobre as MESMAS linhas que voltam — e não por
 * uma segunda consulta com `SUM`. É a lição do DRE: cada agregação escrita à
 * parte é uma aritmética a mais para divergir da tabela que está na tela, e um
 * rodapé que não soma as linhas de cima é o formato de erro que ninguém
 * confere.
 */
export function runReport(id: string, q: ReportQuery): ReportResult {
  ensureCoreSchema();
  const spec = acharRelatorio(id);
  const todas = spec.run(q);
  /*
    A DECISÃO SAIU DAQUI e virou `truncagem`, que é pura e tem caso próprio.

    Era `todas.length > TETO_DE_LINHAS`, e essa conta só é verdadeira quando a
    consulta devolve tudo. Para uma fonte com teto próprio ela mentia por
    construção: 500 de 500 nunca passa de 5000, então `truncated` saía `false`
    sobre uma página. Ver `TetoDoRelatorio`.
  */
  const { truncated, corte } = truncagem(todas.length, spec.teto);
  const rows = todas.length > corte ? todas.slice(0, corte) : todas;

  const totals: Record<string, number> = {};
  for (const coluna of spec.columns) {
    if (coluna.kind !== 'money' && coluna.kind !== 'quantity') continue;
    totals[coluna.key] = rows.reduce((acc, linha) => {
      const n = Number(linha[coluna.key] ?? 0);
      return acc + (Number.isFinite(n) ? n : 0);
    }, 0);
  }
  // Dinheiro é centavo INTEIRO até no rodapé: quantidade pode ser fracionária
  // (0,75 kg), valor nunca.
  for (const coluna of spec.columns) {
    if (coluna.kind === 'money') totals[coluna.key] = Math.round(totals[coluna.key]);
  }

  return {
    report: semARotina(spec),
    from: q.from,
    to: q.to,
    rows,
    totals,
    generatedAt: new Date().toISOString(),
    truncated,
    rowCount: todas.length,
  };
}

/**
 * O nome fantasia da operação, para o cabeçalho do arquivo.
 *
 * Ele mora aqui e não na rota pelo mesmo motivo do resto: o CSV é montado
 * neste arquivo, e um cabeçalho que depende de quem chama sai diferente
 * conforme o chamador. Nulo devolve o id — que é feio e é a verdade, melhor
 * que um arquivo anônimo na pasta de downloads.
 */
export function nomeDaEmpresa(companyId: string): string {
  const row = getConnection()
    .prepare('SELECT trade_name FROM core_companies WHERE id = ?')
    .get(companyId) as { trade_name?: string } | undefined;
  return row?.trade_name ?? companyId;
}

/**
 * O MESMO resultado, em CSV — e "o mesmo" é literal: a exportação recebe o
 * `ReportResult` já montado, em vez de rodar a consulta de novo.
 *
 * É a diferença entre um arquivo que confere com a tela e um que quase
 * confere. Rodar duas vezes abriria a porta para o relatório mudar entre a
 * leitura e o download (uma venda a mais, uma baixa a mais), e quem recebesse
 * os dois juraria que o sistema erra.
 *
 * O CABEÇALHO CARREGA O CONTEXTO. Sem ele, o arquivo na pasta de downloads é
 * uma tabela sem dono: de qual empresa, de qual período, gerada quando. A
 * ressalva vai junto pelo mesmo motivo de ela existir na tela.
 */
export function reportToCsv(resultado: ReportResult, nomeDaEmpresa: string): string {
  const linhas: string[] = [];
  linhas.push(linhaCsv([resultado.report.label]));
  linhas.push(linhaCsv(['Empresa', nomeDaEmpresa]));
  linhas.push(linhaCsv(['Período', `${resultado.from} a ${resultado.to}`]));
  linhas.push(linhaCsv(['Gerado em', resultado.generatedAt]));
  if (resultado.report.caveat) linhas.push(linhaCsv(['Ressalva', resultado.report.caveat]));
  if (resultado.truncated) {
    /*
      O NÚMERO É O DAS LINHAS QUE ESTÃO NO ARQUIVO, e não `TETO_DE_LINHAS`.

      A frase dizia "as primeiras 5000" mesmo quando o corte tinha sido outro —
      e passou a poder ser outro no dia em que a fonte ganhou teto declarado.
      Um aviso de truncagem que erra o número do corte é a truncagem silenciosa
      com uma etapa a mais.

      E `rowCount` é o que a consulta CONSEGUIU trazer, que pode ser menos que o
      que existe no banco quando a fonte tem teto próprio — por isso "pelo
      menos": afirmar o total exato seria inventar o que ninguém perguntou.
    */
    linhas.push(
      linhaCsv([
        'ATENÇÃO',
        `O relatório tem pelo menos ${resultado.rowCount} linhas e o arquivo traz as `
          + `primeiras ${resultado.rows.length}. Estreite o período.`,
      ]),
    );
  }
  linhas.push('');
  linhas.push(linhaCsv(resultado.report.columns.map((c) => c.label)));

  for (const linha of resultado.rows) {
    linhas.push(
      linhaCsv(
        resultado.report.columns.map((c) => {
          const valor = linha[c.key];
          if (c.kind === 'money') return reaisCsv(centavos(valor));
          if (valor === null || valor === undefined) return '';
          return String(valor);
        }),
      ),
    );
  }

  const temTotal = resultado.report.columns.some((c) => c.key in resultado.totals);
  if (temTotal && resultado.rows.length > 0) {
    linhas.push(
      linhaCsv(
        resultado.report.columns.map((c, i) => {
          if (i === 0) return 'TOTAL';
          if (!(c.key in resultado.totals)) return '';
          return c.kind === 'money'
            ? reaisCsv(resultado.totals[c.key])
            : String(resultado.totals[c.key]);
        }),
      ),
    );
  }

  return montarCsv(linhas);
}

/**
 * O nome do arquivo: relatório, empresa e período, nesta ordem.
 *
 * Quem baixa três relatórios do mesmo mês precisa distingui-los na pasta de
 * downloads sem abrir os três — e quem baixa o mesmo relatório de três meses,
 * idem. Só ASCII e hífen: acento em nome de arquivo atravessa
 * `Content-Disposition`, proxy e sistema de arquivos de jeitos diferentes.
 */
export function nomeDoArquivo(id: string, from: string, to: string): string {
  const limpo = id.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  return `${limpo}-${from}-a-${to}.csv`;
}
