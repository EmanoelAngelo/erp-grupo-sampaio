/**
 * BI: comparar as operações do grupo.
 *
 * O painel já mostra o dia a dia de UMA operação. O que faltava era olhar as
 * seis lado a lado — que é a pergunta que o dono faz e nenhuma tela respondia:
 * qual loja está vendendo mais, qual tem ticket maior, o que sai em uma e
 * encalha na outra.
 *
 * O ESCOPO SEGUE O VÍNCULO, não "todas as empresas".
 *
 * As operações consideradas são as que a pessoa tem em `core_user_companies` —
 * o mesmo modelo do resto do sistema. Uma consulta que atravessasse empresas
 * livremente seria a única no repositório a fazer isso, e viraria a porta por
 * onde um gerente de loja veria o resultado das outras cinco. E o vínculo sozinho
 * também não basta: a operação entra só se o perfil de lá abriria o BI
 * (GAP-PRD-084, ver `companiesOf`).
 *
 * MARGEM SÓ ONDE O CUSTO É CONFIÁVEL.
 *
 * Produto cadastrado sem custo tem `cost_cents = 0`, e calcular margem sobre
 * isso devolveria 100% — um número bonito e falso, que faria a loja parecer
 * lucrativa onde ninguém sabe o que pagou. Então esses produtos ficam FORA do
 * cálculo, e a resposta diz QUANTOS ficaram: sem essa contagem, uma margem
 * calculada sobre 3 de 300 produtos pareceria a margem da loja.
 */
import { getConnection } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { limitesDoPeriodo } from './CalendarioOperacional.js';
import { operacoesOndeOPerfilAbre } from '../auth/AlcanceCruzado.js';

/**
 * Quem lê o BI — a lista que as quatro rotas de `/insights` passam ao guarda
 * (`requireProfile`, com o atalho de `admin_geral` e `gestor`).
 *
 * Mora aqui, e as rotas a importam, porque é ELA que decide também quais
 * operações entram na comparação (GAP-PRD-084): a mesma lista nos dois lados,
 * e não duas cópias para divergir.
 */
export const PERFIS_QUE_LEEM_O_BI = ['gerente_loja', 'gerente_oficina'] as const;

/**
 * ============================================================================
 * O RECORTE DA VENDA QUE FATURA — uma frase só, e ela não é por complemento
 * ============================================================================
 *
 * ## O defeito
 *
 * O SELECT da agregação por marca era compartilhado de propósito (ver
 * `sqlDeMarcas`), justamente para não haver "duas grafias do mesmo
 * agrupamento". O SELECT era. O WHERE não:
 *
 *   painel (`GET /core/dashboard`)       →  igualdade com 'completed'
 *   BI     (`GET /core/insights/brands`) →  DIFERENÇA de 'cancelled'
 *
 * As duas frases dizem o mesmo conjunto POR ACIDENTE: `core_sales` só recebe
 * `'completed'` (no INSERT da venda) e `'cancelled'` (no UPDATE do
 * cancelamento). No dia em que nascer um terceiro status — devolvida, em
 * espera, estornada —, o painel o exclui, o BI o inclui, e duas telas passam a
 * discordar sobre o mesmo dia sem ninguém tocar em nenhuma das duas.
 *
 * ## Por que a lista por COMPLEMENTO é a parte errada
 *
 * `<> 'cancelled'` não diz quem fatura; diz quem não fatura. É uma lista que
 * MUDA SOZINHA quando alguém acrescenta um valor à coluna — o status novo
 * entra no faturamento por omissão, que é a pior direção possível para um
 * número que o dono lê todo dia.
 *
 * `FATURA` inverte isso: é um `Record` TOTAL sobre os status que existem, e
 * acrescentar um valor ao tipo sem decidir se ele fatura NÃO COMPILA. A
 * decisão passa a ser obrigatória e visível, em vez de herdada.
 */
export type StatusDaVenda = 'completed' | 'cancelled';

/**
 * Cada status, e se ele conta como faturamento. TOTAL de propósito: o `tsc`
 * recusa o arquivo se `StatusDaVenda` ganhar um nome e este objeto não.
 */
const FATURA: Record<StatusDaVenda, boolean> = {
  // A venda concluída. É ela, e só ela, que soma hoje.
  completed: true,
  // Cancelada deixou de valer — não é "venda com ressalva", é venda que não é.
  cancelled: false,
};

/** Os status que somam. Derivado do `Record`, nunca escrito à mão. */
export const STATUS_QUE_FATURAM: readonly StatusDaVenda[] = (
  Object.keys(FATURA) as StatusDaVenda[]
).filter((status) => FATURA[status]);

/**
 * A frase SQL do recorte — `<alias>status IN (...)`, montada da lista derivada.
 *
 * Interpolar texto em SQL é o que esta casa evita; aqui é seguro e é a única
 * forma possível: os valores são literais de um tipo fechado, resolvidos em
 * tempo de compilação, e nunca tocam entrada de usuário.
 *
 * ## POR QUE ELA VIROU FUNÇÃO
 *
 * O DEFEITO: `RECORTE_DA_VENDA_QUE_FATURA` cobria UMA consulta de cinco. Ele
 * entrou por dentro de `sqlDeMarcas` — e a promessa "um status novo quebra a
 * COMPILAÇÃO" passou a valer só para `byBrand`. As outras quatro consultas da
 * MESMA rota do painel (`totals`, `byDay`, `topProducts`, `bySeller`) seguiam
 * com `status = 'completed'` escrito à mão, e não usavam a constante por um
 * motivo bobo e caro: duas delas consultam `core_sales` SEM apelido, e a frase
 * fixa dizia `s.status`.
 *
 * No dia do terceiro status marcado como `true` no `Record`, o arquivo compila,
 * `byBrand` cresce, `totals.revenue_cents` não, e
 * `byBrandUnallocatedCents = totals.revenue_cents − somaDasMarcas` fica
 * NEGATIVO — a tela renderiza qualquer valor não-zero desse campo como
 * "desconto ou acréscimo de rodapé", ou seja, mostra mercadoria como desconto.
 *
 * O apelido virou PARÂMETRO para que não sobre nenhuma consulta sem frase
 * derivada por incompatibilidade de grafia.
 */
export function recorteDaVendaQueFatura(alias?: string): string {
  const prefixo = alias ? `${alias}.` : '';
  return `${prefixo}status IN (${STATUS_QUE_FATURAM.map((status) => `'${status}'`).join(', ')})`;
}

/** A frase com o apelido `s`, que é o das consultas deste arquivo. */
export const RECORTE_DA_VENDA_QUE_FATURA = recorteDaVendaQueFatura('s');

/**
 * ============================================================================
 * O PEDIDO ONLINE QUE FATURA (GAP-PRD-132) — a mesma régua do DRE
 * ============================================================================
 *
 * O pedido da loja online não vira `core_sales` (isso lançaria a receita duas
 * vezes: ela já entrou no financeiro no pagamento), e por isso os números de
 * venda que liam só `core_sales` o ignoravam enquanto o DRE o contava.
 *
 * Fatura o pedido que FOI PAGO (`paid_at`), no DIA DO PAGAMENTO, pelo total
 * pago (itens + frete) — exatamente o lançamento de entrada que o DRE soma. O
 * cancelado nunca foi pago; o reembolsado continua sendo venda do dia em que
 * foi pago, e o reembolso aparece como devolução no dia dele (a contrapartida
 * `ecommerce_order_refund`), como a devolução de balcão.
 */
export function recorteDoPedidoQueFatura(alias?: string): string {
  const prefixo = alias ? `${alias}.` : '';
  return `${prefixo}paid_at IS NOT NULL`;
}

export interface OperationSummary {
  companyId: string;
  tradeName: string;
  /** Vendas de balcão/oficina MAIS pedidos online pagos. */
  salesCount: number;
  /** Faturamento de balcão/oficina MAIS pedidos online pagos (GAP-PRD-132). */
  revenueCents: number;
  /** Faturamento ÷ vendas. Zero vendas devolve zero, não divisão por zero. */
  averageTicketCents: number;
  /** Devoluções de balcão MAIS reembolsos da loja online. */
  returnsCents: number;
  /** Faturamento menos devoluções: é o que de fato ficou. */
  netCents: number;
  /** Quantos dos `salesCount` são pedidos da loja online. */
  onlineOrdersCount: number;
  /** Quanto do `revenueCents` veio da loja online. */
  onlineRevenueCents: number;
}

export interface MarginSummary {
  /** Linhas com custo FOTOGRAFADO na venda maior que zero (GAP-PRD-086). */
  consideredItems: number;
  /**
   * Linhas vendidas com o cadastro sem custo (snapshot = 0) — sem isto, a
   * margem mente. É o `itemsWithoutCost` do DRE.
   */
  skippedNoCost: number;
  /**
   * Linhas sem custo gravado (snapshot NULO): venda anterior ao snapshot, ou
   * linha de serviço. Ficam fora e são contadas — é o `itemsBeforeSnapshot`
   * do DRE. Usar o custo de HOJE do cadastro nelas inventaria um custo que
   * ninguém fotografou.
   */
  skippedBeforeSnapshot: number;
  revenueCents: number;
  costCents: number;
  marginCents: number;
  marginPercent: number | null;
}

/**
 * As operações que entram na comparação. É daqui que sai todo o resto.
 *
 * Não basta o VÍNCULO (GAP-PRD-084): a operação só entra se o perfil da pessoa
 * LÁ abriria o BI lá. Quem é gerente na Conceito e mecânico na PJ Motors vê a
 * Conceito — e a PJ fica de fora, como ficaria com o token dela.
 */
function companiesOf(userId: string): { id: string; trade_name: string }[] {
  return operacoesOndeOPerfilAbre(userId, PERFIS_QUE_LEEM_O_BI);
}

function periodo(
  from?: string,
  to?: string,
  coluna = 's.created_at',
): { sql: string; params: string[] } {
  let sql = '';
  const params: string[] = [];
  // O painel do grupo compara SEIS operações. Se o recorte fosse o de
  // Greenwich, todas elas mostrariam o mesmo dia errado — e a comparação entre
  // lojas continuaria parecendo coerente.
  //
  // A coluna é parâmetro porque nem todo fato deste arquivo é uma venda: a
  // devolução tem carimbo próprio, e recortá-la pelo carimbo da venda seria
  // responder outra pergunta.
  const limites = limitesDoPeriodo(from, to);
  if (from) {
    sql += ` AND ${coluna} >= ?`;
    params.push(limites.inicio);
  }
  if (to) {
    sql += ` AND ${coluna} <= ?`;
    params.push(limites.fim);
  }
  return { sql, params };
}

export function operationsOverview(input: {
  userId: string;
  from?: string;
  to?: string;
}): { operations: OperationSummary[]; totals: Omit<OperationSummary, 'companyId' | 'tradeName'> } {
  ensureCoreSchema();
  const db = getConnection();
  const { sql: filtro, params } = periodo(input.from, input.to);
  const { sql: filtroDevolucoes, params: paramsDevolucoes } = periodo(
    input.from,
    input.to,
    'r.created_at',
  );
  // O pedido online pelo carimbo do PAGAMENTO; o reembolso pelo carimbo DELE.
  const { sql: filtroPedidos, params: paramsPedidos } = periodo(input.from, input.to, 'o.paid_at');
  const { sql: filtroReembolsos, params: paramsReembolsos } = periodo(
    input.from,
    input.to,
    'e.created_at',
  );

  const operations: OperationSummary[] = companiesOf(input.userId).map((c) => {
    // Venda cancelada não é faturamento: ela deixou de valer.
    const vendas = db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(s.total_cents), 0) AS total
           FROM core_sales s
          WHERE s.company_id = ? AND ${RECORTE_DA_VENDA_QUE_FATURA}${filtro}`,
      )
      .get(c.id, ...params) as { n: number; total: number };

    /*
      Devolução é fato posterior e próprio: aparece ao lado, diminuindo o
      resultado, sem apagar a venda que aconteceu.

      E ela pertence ao dia em que ACONTECEU — `r.created_at` —, a mesma
      régua do DRE, que lança a devolução na competência do fato. O recorte
      era por `s.created_at`, o carimbo da VENDA: para o dia da devolução o
      BI respondia zero enquanto o DRE deduzia o valor, e o relatório de um
      período fechado mudava retroativamente quando chegava uma devolução de
      venda antiga. O JOIN com core_sales saiu junto: só existia para servir
      o filtro errado.
    */
    const devolucoes = db
      .prepare(
        `SELECT COALESCE(SUM(r.total_cents), 0) AS total
           FROM core_sale_returns r
          WHERE r.company_id = ?${filtroDevolucoes}`,
      )
      .get(c.id, ...paramsDevolucoes) as { total: number };

    // A loja online (GAP-PRD-132): o que foi pago no período, e o que voltou.
    const pedidos = db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(o.total_cents), 0) AS total
           FROM core_orders o
          WHERE o.company_id = ? AND ${recorteDoPedidoQueFatura('o')}${filtroPedidos}`,
      )
      .get(c.id, ...paramsPedidos) as { n: number; total: number };
    const reembolsos = db
      .prepare(
        `SELECT COALESCE(SUM(e.amount_cents), 0) AS total
           FROM core_finance_entries e
          WHERE e.company_id = ? AND e.origin_type = 'ecommerce_order_refund'
            AND e.direction = 'out' AND e.cancelled_at IS NULL${filtroReembolsos}`,
      )
      .get(c.id, ...paramsReembolsos) as { total: number };

    const quantas = vendas.n + pedidos.n;
    const faturou = vendas.total + pedidos.total;
    const voltou = devolucoes.total + reembolsos.total;
    return {
      companyId: c.id,
      tradeName: c.trade_name,
      salesCount: quantas,
      revenueCents: faturou,
      averageTicketCents: quantas > 0 ? Math.round(faturou / quantas) : 0,
      returnsCents: voltou,
      netCents: faturou - voltou,
      onlineOrdersCount: pedidos.n,
      onlineRevenueCents: pedidos.total,
    };
  });

  const totals = operations.reduce(
    (acc, o) => ({
      salesCount: acc.salesCount + o.salesCount,
      revenueCents: acc.revenueCents + o.revenueCents,
      averageTicketCents: 0,
      returnsCents: acc.returnsCents + o.returnsCents,
      netCents: acc.netCents + o.netCents,
      onlineOrdersCount: acc.onlineOrdersCount + o.onlineOrdersCount,
      onlineRevenueCents: acc.onlineRevenueCents + o.onlineRevenueCents,
    }),
    {
      salesCount: 0,
      revenueCents: 0,
      averageTicketCents: 0,
      returnsCents: 0,
      netCents: 0,
      onlineOrdersCount: 0,
      onlineRevenueCents: 0,
    },
  );
  totals.averageTicketCents =
    totals.salesCount > 0 ? Math.round(totals.revenueCents / totals.salesCount) : 0;

  return { operations, totals };
}

/**
 * O que mais sai, somando as operações vinculadas.
 *
 * Por QUANTIDADE e por VALOR, porque respondem perguntas diferentes: o que sai
 * mais em peça pode não ser o que traz mais dinheiro, e confundir os dois leva
 * a reforçar o estoque errado.
 */
export function topProducts(input: {
  userId: string;
  from?: string;
  to?: string;
  limit?: number;
}): Record<string, unknown>[] {
  ensureCoreSchema();
  const empresas = companiesOf(input.userId);
  if (empresas.length === 0) return [];

  const marcadores = empresas.map(() => '?').join(',');
  const { sql: filtro, params } = periodo(input.from, input.to);

  return getConnection()
    .prepare(
      `SELECT si.description AS name, p.internal_code,
              SUM(si.quantity) AS quantity,
              SUM(si.total_cents) AS revenue_cents,
              COUNT(DISTINCT s.company_id) AS operations
         FROM core_sale_items si
         JOIN core_sales s ON s.id = si.sale_id
         LEFT JOIN core_products p ON p.id = si.product_id
        WHERE s.company_id IN (${marcadores}) AND ${RECORTE_DA_VENDA_QUE_FATURA}${filtro}
        GROUP BY si.description, p.internal_code
        ORDER BY revenue_cents DESC
        LIMIT ?`,
    )
    .all(
      ...empresas.map((c) => c.id),
      ...params,
      Math.min(Math.max(Number(input.limit ?? 10), 1), 50),
    ) as unknown as Record<string, unknown>[];
}

/**
 * O SQL que decide a que MARCA uma linha de venda pertence — escrito uma vez.
 *
 * Ele mora aqui e é usado também pelo painel (`GET /core/dashboard`), porque
 * "marca da linha" precisa querer dizer a MESMA coisa nas duas telas. Duas
 * grafias do mesmo agrupamento seriam dois relatórios que discordam sobre o
 * mesmo dia — e quem lê escolheria o número preferido.
 *
 * TRÊS AUSÊNCIAS CAEM NO MESMO BALDE, e é de propósito: marca nula (o produto
 * nunca teve), marca em branco (alguém salvou o campo vazio) e linha sem
 * produto de catálogo (serviço, mão de obra de OS). São a mesma frase — "não
 * dá para dizer a marca" — e separá-las em três linhas encheria o relatório de
 * ruído. Filtrá-las, por outro lado, seria pior: no banco real ZERO de
 * dezenove produtos têm marca preenchida, e o relatório nasceria vazio ao
 * mesmo tempo em que a soma dos grupos deixaria de bater com o faturamento.
 */
const MARCA_DA_LINHA =
  "CASE WHEN p.brand IS NULL OR TRIM(p.brand) = '' THEN 'Sem marca' ELSE TRIM(p.brand) END";

export interface BrandSummary {
  brand: string;
  quantity: number;
  /** Soma dos totais das LINHAS. O desconto de rodapé não é rateado — ver a rota. */
  revenue_cents: number;
  /** Quantas VENDAS distintas tocaram esta marca — não é a soma das quantidades. */
  sales_count: number;
}

/**
 * O SELECT da agregação por marca, com o RECORTE DE QUEM CHAMA concatenado.
 *
 * A forma é feia de propósito: o mesmo texto serve o painel (uma empresa, pelo
 * dia da loja da venda), os insights (as empresas do vínculo) e o relatório de
 * marca da Central. Escrever consultas parecidas é como o DRE já errou uma vez
 * — cada `SUM` com um `WHERE` diferente é uma aritmética a mais para divergir
 * das outras.
 *
 * ## O QUE MUDOU: o status saiu da mão de quem chama
 *
 * O parâmetro era o WHERE INTEIRO, e cada chamador escrevia o próprio recorte
 * de status: o painel com igualdade a 'completed', o BI com diferença de
 * 'cancelled'. Duas grafias do mesmo agrupamento — exatamente o que este SELECT
 * compartilhado existe para impedir, acontecendo na metade que ele não cobria.
 *
 * Agora `RECORTE_DA_VENDA_QUE_FATURA` é acrescentado AQUI, sempre, e o
 * parâmetro é só o recorte de ESCOPO e PERÍODO de quem pergunta. Não é
 * disciplina de quem escreve: é impossível divergir, porque a frase do status
 * não passa mais pela assinatura.
 */
export function sqlDeMarcas(escopoEPeriodo: string): string {
  return `SELECT ${MARCA_DA_LINHA} AS brand,
                 SUM(i.quantity) AS quantity,
                 SUM(i.total_cents) AS revenue_cents,
                 COUNT(DISTINCT i.sale_id) AS sales_count
            FROM core_sale_items i
            JOIN core_sales s ON s.id = i.sale_id
            LEFT JOIN core_products p ON p.id = i.product_id
           WHERE ${RECORTE_DA_VENDA_QUE_FATURA} AND (${escopoEPeriodo})
           GROUP BY brand
           ORDER BY revenue_cents DESC, brand`;
}

/**
 * Quantas marcas o PAINEL desenha antes de juntar o resto numa linha só.
 *
 * ## O defeito
 *
 * `byBrand` não tinha limite nenhum, enquanto `topProducts` e `bySeller` da
 * mesma resposta são `LIMIT 10` e `topBrands` do BI é limitado a 200. Catálogo
 * com centenas de marcas renderiza centenas de barras na tela que o gestor abre
 * todo dia — e cada barra é desenhada contra a maior do recorte, então as da
 * cauda viram traços de um pixel que não comparam nada.
 *
 * O número é o mesmo dos dois vizinhos do painel de propósito: três recortes do
 * mesmo cartão com três tetos diferentes seriam três respostas para "o topo de
 * quê".
 */
export const TETO_DE_MARCAS_NO_PAINEL = 10;

/** O que o painel mostra por marca, e a soma de TODAS elas. */
export interface MarcasDoPainel {
  /** As do topo, mais — quando há corte — a linha nomeada do excedente. */
  linhas: BrandSummary[];
  /**
   * A soma de TODAS as marcas, cortadas incluídas.
   *
   * Ela existe separada das linhas porque é dela que sai
   * `byBrandUnallocatedCents`, o desconto de rodapé que não pertence a marca
   * nenhuma. Somar só as linhas MOSTRADAS faria as marcas cortadas
   * reaparecerem dentro desse número, e a legenda da tela passaria a chamar
   * mercadoria de desconto — uma mentira nova criada pelo próprio conserto.
   */
  somaCents: number;
}

/**
 * As marcas do painel, cortadas no teto SEM esconder o que ficou fora.
 *
 * O excedente vira UMA LINHA NOMEADA ("Outras 23 marcas") em vez de sumir. É a
 * mesma decisão que "Sem marca" é um GRUPO e não um filtro, e a mesma que o DRE
 * toma ao nomear a diferença para o painel: a soma continua fechando com o
 * faturamento, e quem lê vê de quanto é o que não coube.
 *
 * O `sales_count` da linha do excedente é CONTADO NO BANCO, com
 * `COUNT(DISTINCT)`, e não somado das linhas cortadas: uma venda que tocou duas
 * dessas marcas conta uma vez, não duas. Somar seria inventar um número — e um
 * número inventado dentro de uma linha que existe justamente para ser honesta
 * seria pior que o defeito original.
 */
export function marcasDoPainel(escopoEPeriodo: string, params: unknown[]): MarcasDoPainel {
  const db = getConnection();
  const todas = db
    .prepare(sqlDeMarcas(escopoEPeriodo))
    .all(...(params as never[])) as unknown as BrandSummary[];
  const somaCents = todas.reduce((acc, linha) => acc + Number(linha.revenue_cents), 0);

  if (todas.length <= TETO_DE_MARCAS_NO_PAINEL) return { linhas: todas, somaCents };

  const mostradas = todas.slice(0, TETO_DE_MARCAS_NO_PAINEL);
  const cortadas = todas.slice(TETO_DE_MARCAS_NO_PAINEL);
  const marcadores = cortadas.map(() => '?').join(', ');
  const vendas = db
    .prepare(
      `SELECT COUNT(DISTINCT i.sale_id) AS n
         FROM core_sale_items i
         JOIN core_sales s ON s.id = i.sale_id
         LEFT JOIN core_products p ON p.id = i.product_id
        WHERE ${RECORTE_DA_VENDA_QUE_FATURA} AND (${escopoEPeriodo})
          AND ${MARCA_DA_LINHA} IN (${marcadores})`,
    )
    .get(...(params as never[]), ...cortadas.map((l) => l.brand)) as { n: number };

  return {
    linhas: [
      ...mostradas,
      {
        brand: `Outras ${cortadas.length} marcas`,
        quantity: cortadas.reduce((acc, l) => acc + Number(l.quantity), 0),
        revenue_cents: cortadas.reduce((acc, l) => acc + Number(l.revenue_cents), 0),
        sales_count: vendas.n,
      },
    ],
    somaCents,
  };
}

/**
 * Vendas por MARCA nas operações do vínculo — GAP-V44.
 *
 * "Qual marca vende mais" não tinha resposta em superfície nenhuma: os
 * insights agregavam por produto, por operação e por margem, e nunca por
 * marca. O ingrediente sempre esteve em `core_products.brand`.
 *
 * O escopo é o VÍNCULO, como todo o resto deste arquivo. A venda cancelada
 * fica de fora pelo mesmo motivo de `operationsOverview`: ela deixou de valer.
 */
export function topBrands(input: {
  userId: string;
  from?: string;
  to?: string;
  limit?: number;
}): BrandSummary[] {
  ensureCoreSchema();
  const empresas = companiesOf(input.userId);
  if (empresas.length === 0) return [];

  const marcadores = empresas.map(() => '?').join(',');
  const { sql: filtro, params } = periodo(input.from, input.to);

  return getConnection()
    .prepare(
      // Só o ESCOPO e o PERÍODO: o recorte de status vem de `sqlDeMarcas`, e é
      // isso que impede esta consulta de divergir da do painel.
      // Só o ESCOPO e o PERÍODO: o recorte de status vem de `sqlDeMarcas`, e é
      // isso que impede esta consulta de divergir da do painel.
      `${sqlDeMarcas(`s.company_id IN (${marcadores})${filtro}`)} LIMIT ?`,
    )
    .all(
      ...empresas.map((c) => c.id),
      ...params,
      Math.min(Math.max(Number(input.limit ?? 30), 1), 200),
    ) as unknown as BrandSummary[];
}

/**
 * Margem, e só onde ela significa alguma coisa.
 *
 * Produto sem custo cadastrado sai do cálculo, e a resposta diz quantos saíram.
 * Uma margem de 62% calculada sobre 3 de 300 produtos não é a margem da loja —
 * é a margem de três produtos, e quem lê precisa saber disso para não decidir
 * preço em cima dela.
 *
 * ## UMA RÉGUA DE CUSTO SÓ — a do DRE (GAP-PRD-086)
 *
 * O custo é o FOTOGRAFADO na venda (`core_sale_items.cost_cents`), não o de
 * hoje do cadastro. Esta função multiplicava a quantidade vendida por
 * `core_products.cost_cents`, e o DRE (`IncomeStatementService.custoDoVendido`)
 * pelo snapshot: vendidas 2 un. com custo 8.000 e depois o cadastro a 12.000,
 * o BI dizia 40% e o DRE 60% sobre as mesmas vendas — e a margem de março
 * mudava sozinha quando entrava a nota de agosto.
 *
 * As populações são as MESMAS três do DRE, com os mesmos contadores: snapshot
 * maior que zero entra; zero (produto vendido sem custo) fica fora e conta em
 * `skippedNoCost`; nulo (venda anterior ao snapshot, ou linha de serviço) fica
 * fora e conta em `skippedBeforeSnapshot`. O arredondamento por linha é o do
 * DRE (`ROUND(custo × quantidade)`), para a quantidade fracionada dar o mesmo
 * centavo nas duas telas. `tests/margem-do-bi-bate-com-o-dre.test.ts` cobra a
 * igualdade campo a campo.
 */
export function marginWhereReliable(input: {
  userId: string;
  from?: string;
  to?: string;
}): MarginSummary {
  ensureCoreSchema();
  const empresas = companiesOf(input.userId);
  if (empresas.length === 0) {
    return {
      consideredItems: 0,
      skippedNoCost: 0,
      skippedBeforeSnapshot: 0,
      revenueCents: 0,
      costCents: 0,
      marginCents: 0,
      marginPercent: null,
    };
  }

  const marcadores = empresas.map(() => '?').join(',');
  const { sql: filtro, params } = periodo(input.from, input.to);
  const ids = empresas.map((c) => c.id);

  const row = getConnection()
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN si.cost_cents > 0 THEN 1 ELSE 0 END), 0) AS com_custo,
         COALESCE(SUM(CASE WHEN si.cost_cents > 0 THEN si.total_cents END), 0) AS receita,
         COALESCE(SUM(CASE WHEN si.cost_cents > 0
                           THEN CAST(ROUND(si.cost_cents * si.quantity) AS INTEGER) END), 0) AS custo,
         COALESCE(SUM(CASE WHEN si.cost_cents = 0 THEN 1 ELSE 0 END), 0) AS sem_custo,
         COALESCE(SUM(CASE WHEN si.cost_cents IS NULL THEN 1 ELSE 0 END), 0) AS sem_retrato
         FROM core_sale_items si
         JOIN core_sales s ON s.id = si.sale_id
        WHERE s.company_id IN (${marcadores}) AND ${RECORTE_DA_VENDA_QUE_FATURA}${filtro}`,
    )
    .get(...ids, ...params) as Record<string, number>;

  const receita = Number(row.receita);
  const custo = Number(row.custo);
  const margem = receita - custo;

  return {
    consideredItems: Number(row.com_custo),
    skippedNoCost: Number(row.sem_custo),
    skippedBeforeSnapshot: Number(row.sem_retrato),
    revenueCents: receita,
    costCents: custo,
    marginCents: margem,
    // Sem receita considerada não há percentual: devolver 0 sugeriria margem
    // zero, que é uma afirmação diferente de "não dá para saber".
    marginPercent: receita > 0 ? Math.round((margem / receita) * 1000) / 10 : null,
  };
}
