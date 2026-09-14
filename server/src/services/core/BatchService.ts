/**
 * ============================================================================
 * LOTE E VALIDADE — o ciclo que não existia em camada nenhuma (GAP-V35)
 * ============================================================================
 *
 * ## O defeito
 *
 * O grupo vende produto pesável. `core_products` tem `weighable`, `plu_code` e
 * `tare_grams` desde a rodada da balança — o catálogo foi desenhado para
 * varejo de alimento, que é exatamente o segmento em que validade é obrigação
 * operacional e sanitária, não conveniência.
 *
 * E não havia UMA coluna de lote ou de validade: nem em `core_products`, nem em
 * `core_stock`, nem em `core_stock_movements`, nem uma tabela de lote em
 * `sqlite_master`. As três consequências, todas reais:
 *
 *   1. perda por vencimento INVISÍVEL — nenhuma tela, rota ou relatório
 *      respondia "o que vence esta semana";
 *   2. mercadoria vencida VENDÁVEL no PDV, sem nenhuma trava;
 *   3. recall impossível — "de qual lote era?" não tinha resposta.
 *
 * ## Por que o nome é BatchService, e não LoteService
 *
 * Escolha registrada, porque as duas eram defensáveis. A casa escreve
 * IDENTIDADE em inglês (nome de arquivo de serviço, nome de tabela, nome de
 * coluna) e EXPLICAÇÃO em português (comentário, mensagem de erro, rótulo de
 * tela). `core_product_batches` fica ao lado de `core_product_units`, que é a
 * tabela-irmã em desenho — filha do produto, com estado próprio e uma
 * dimensão nova no razão. Um `LoteService.ts` escrevendo em
 * `core_product_batches` obrigaria quem procura a saber as duas palavras.
 *
 * ## O desenho, em uma frase
 *
 * O lote é DIMENSÃO DO RAZÃO — `core_stock_movements.batch_id` —, e o saldo por
 * lote é a SOMA dos movimentos daquele lote. É a mesma decisão do local de
 * estoque, pelo mesmo motivo, e é a terceira vez que ela se paga: nenhum
 * segundo cache a manter em dia, `core_stock.quantity` não muda de
 * significado, e o `CHECK (quantity >= 0)` continua protegendo o que sempre
 * protegeu.
 *
 * ## As cinco regras que este módulo cumpre
 *
 *   1. OPT-IN. `core_products.tracks_batches` nasce 0 e produto sem controle
 *      não ganha campo obrigatório nenhum, não muda de caminho na venda, não
 *      aparece em alerta e não paga uma consulta a mais — a leitura da flag
 *      pegou carona no SELECT que `applyMovement` já fazia.
 *   2. SALDO POR LOTE derivado do razão, com a identidade
 *      anterior + delta = posterior gravada em cada linha
 *      (`batch_quantity_before` / `batch_balance_after`).
 *   3. ENTRADA declara o lote; SAÍDA o preserva por FEFO — o que vence
 *      primeiro sai primeiro —, com o lote escolhido gravado no movimento.
 *   4. CONFERÊNCIA: quem olhou a caixa e quando (`checked_at`/`checked_by`).
 *   5. LOTE VENCIDO NÃO SAI PELA VENDA. Ver `podeConsumirVencido` abaixo: a
 *      régua está escrita lá, com a lista de saídas que PODEM levar o vencido
 *      embora (perda, ajuste, uso interno) — porque a mercadoria vencida
 *      precisa de um caminho para sair, e esse caminho não é o balcão.
 *
 * ## O ciclo de importação com InventoryService
 *
 * `InventoryService` importa este arquivo (para o FEFO e a validação do lote
 * na saída) e este arquivo importa `applyMovement` de lá (para a alocação, que
 * é um par de movimentos). O ciclo é inofensivo pelo mesmo motivo já
 * documentado em `EquipmentStockLink`: nenhum dos dois chama nada do outro
 * durante a AVALIAÇÃO do módulo — só declarações de função atravessam, e elas
 * são içadas. Se alguém puser trabalho no corpo de um destes módulos, este é o
 * parágrafo que explica por que ele quebrou.
 */
import { randomUUID } from 'node:crypto';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { hojeNaLoja, somarDias } from './CalendarioOperacional.js';
import { applyMovement } from './InventoryService.js';

/**
 * SAÍDAS QUE PODEM LEVAR UM LOTE VENCIDO EMBORA.
 *
 * Lista de EXCEÇÕES declarada por extenso, e nunca por complemento. A régua é
 * "venda de lote vencido é recusada"; o problema é que uma régua só de recusa
 * prenderia a mercadoria vencida no sistema para sempre — ela precisa de porta
 * de saída, e a porta é a perda, o uso interno e o acerto de contagem.
 *
 * Por que não escrever o contrário ("recusa em `sale` e `ecommerce_order`"): a
 * lista por complemento é bomba-relógio nesta casa. O dia em que nascer um
 * canal novo de venda — marketplace, aplicativo, televendas — ele entraria
 * calado na lista dos que PODEM vender vencido, sem ninguém decidir isso. Com a
 * lista de exceções, o canal novo nasce protegido e quem quiser a exceção
 * precisa vir aqui escrevê-la.
 *
 * ## De onde cada nome saiu — GREPADO, não suposto
 *
 * A primeira versão desta lista dizia `'inventario'`, que NÃO EXISTE em lugar
 * nenhum do projeto: o acerto de contagem grava `'inventory_count'`. O efeito
 * seria um beco sem saída silencioso — a loja conta a geladeira, encontra menos
 * do que o sistema diz porque o iogurte vencido foi jogado fora, e o acerto é
 * RECUSADO com uma mensagem sobre venda de produto vencido. A contagem inteira
 * ficaria travada, e a única saída seria cancelá-la.
 *
 * Os nomes abaixo vieram de um grep de `referenceType:` em `server/src`, um por
 * um. É o preço de manter uma lista fechada, e ele se paga.
 *
 * `manual`, `ajuste`, `perda` e `uso_interno` são os rótulos que a rota de
 * movimento manual aceita (`REFERENCIAS_MANUAIS`, em core.ts) — a porta pela
 * qual o descarte acontece. `inventory_count` é o acerto da contagem, pelo
 * motivo do parágrafo acima. `transferencia` está aqui porque ali a mercadoria
 * não sai: ela volta na perna de entrada, e recusar a perna de saída deixaria o
 * lote vencido preso na prateleira errada. `estorno_entrada` está porque
 * desfazer uma entrada é devolver ao fornecedor — que é justamente o que se faz
 * com o vencido.
 *
 * QUEM FICOU DE FORA, e por quê: `sale`, `ecommerce_order`, `pre_venda`,
 * `rental_contract` e `service_order`. As três primeiras são venda por canais
 * diferentes; `rental_contract` entrega mercadoria ao cliente; e
 * `service_order` põe a peça DENTRO da moto de alguém — óleo e cola vencidos
 * num conserto são o mesmo risco sanitário da prateleira, com a agravante de
 * que o cliente não vê o rótulo.
 */
const SAIDAS_QUE_PODEM_LEVAR_VENCIDO = new Set([
  'manual',
  'ajuste',
  'perda',
  'uso_interno',
  'inventory_count',
  'transferencia',
  'estorno_entrada',
]);

export function podeConsumirVencido(referenceType: string): boolean {
  return SAIDAS_QUE_PODEM_LEVAR_VENCIDO.has(referenceType);
}

/** As faixas do alerta, do mais urgente ao mais tranquilo. */
export const FAIXAS_DE_VALIDADE = [
  'vencido',
  'vence_em_7',
  'vence_em_15',
  'vence_em_30',
  'em_dia',
  'sem_validade',
] as const;

export type FaixaDeValidade = (typeof FAIXAS_DE_VALIDADE)[number];

export const FAIXA_LABEL: Record<FaixaDeValidade, string> = {
  vencido: 'Vencido',
  vence_em_7: 'Vence em até 7 dias',
  vence_em_15: 'Vence em 8 a 15 dias',
  vence_em_30: 'Vence em 16 a 30 dias',
  em_dia: 'Em dia',
  sem_validade: 'Sem validade declarada',
};

export interface BatchRow {
  id: string;
  company_id: string;
  product_id: string;
  product_name: string;
  internal_code: string;
  unit: string;
  code: string;
  manufactured_on: string | null;
  expires_on: string | null;
  location_id: string | null;
  location_name: string | null;
  checked_at: string | null;
  checked_by: string | null;
  checked_by_name: string | null;
  note: string | null;
  created_at: string;
  /** Derivado do razão. Nunca gravado — ver o cabeçalho deste arquivo. */
  quantity: number;
  /** Saldo × custo do cadastro, em CENTAVOS INTEIROS, arredondado no servidor. */
  value_cents: number;
  /** Em qual faixa do alerta este lote cai HOJE, medido no fuso da loja. */
  faixa: FaixaDeValidade;
  /** Negativo quando já venceu. Nulo quando não há validade declarada. */
  dias_para_vencer: number | null;
}

/**
 * A CONTA DO LOTE, num lugar só.
 *
 * Saldo é SUM(quantity) dos movimentos daquele lote — inclusive os de reserva,
 * que entram com quantity 0 e portanto não somam nada. Valor é saldo × custo do
 * CADASTRO, arredondado POR LOTE, que é a mesma decisão (e o mesmo texto) de
 * `SQL_VALOR_DO_ITEM` em InventoryService: dinheiro é centavo inteiro, e 0,5 kg
 * × 333 centavos daria 166,5, que não existe.
 */
const SQL_SALDO_DO_LOTE = `(SELECT COALESCE(SUM(mv.quantity), 0)
                              FROM core_stock_movements mv
                             WHERE mv.batch_id = b.id AND mv.company_id = b.company_id)`;

/** Data de calendário válida (AAAA-MM-DD), ou nulo. Nunca instante. */
function dataDeCalendario(valor: unknown, campo: string): string | null {
  if (valor === undefined || valor === null || valor === '') return null;
  const texto = String(valor).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(texto)) {
    throw new ApiError(
      'CORE_BATCH_INVALID_DATE',
      `${campo} deve ser uma data no formato AAAA-MM-DD.`,
      400,
    );
  }
  return texto;
}

/**
 * Em que faixa uma validade cai, medida contra HOJE na loja.
 *
 * A régua está aqui e no SQL de `batchAlerts` lado a lado, pelo mesmo motivo de
 * `SQL_ABAIXO_DO_MINIMO` e `abaixoDoMinimo`: são a MESMA regra escrita para
 * dois leitores. Separá-las é como as três definições de "abaixo do mínimo"
 * nasceram nesta casa.
 *
 * O DIA IMPRESSO AINDA VALE. Lote que vence hoje NÃO está vencido — o rótulo
 * diz "consumir até", e recusar a venda no próprio dia jogaria fora mercadoria
 * boa. Vencido é `expires_on < hoje`, com o `<` fazendo trabalho de verdade.
 */
export function faixaDaValidade(expiresOn: string | null, hoje = hojeNaLoja()): FaixaDeValidade {
  if (!expiresOn) return 'sem_validade';
  if (expiresOn < hoje) return 'vencido';
  if (expiresOn <= somarDias(hoje, 7)) return 'vence_em_7';
  if (expiresOn <= somarDias(hoje, 15)) return 'vence_em_15';
  if (expiresOn <= somarDias(hoje, 30)) return 'vence_em_30';
  return 'em_dia';
}

/** Quantos dias faltam. Negativo quando já venceu; nulo sem validade. */
function diasParaVencer(expiresOn: string | null, hoje = hojeNaLoja()): number | null {
  if (!expiresOn) return null;
  const um = Date.UTC(
    Number(expiresOn.slice(0, 4)),
    Number(expiresOn.slice(5, 7)) - 1,
    Number(expiresOn.slice(8, 10)),
  );
  const outro = Date.UTC(
    Number(hoje.slice(0, 4)),
    Number(hoje.slice(5, 7)) - 1,
    Number(hoje.slice(8, 10)),
  );
  return Math.round((um - outro) / 86_400_000);
}

/**
 * Este produto controla lote?
 *
 * NUNCA é chamada de dentro de `applyMovement`: lá a flag chega de carona no
 * SELECT que já buscava o dono do produto, e é isso que garante a regra 1 —
 * produto sem controle não paga uma consulta a mais por causa deste módulo.
 */
export function productTracksBatches(companyId: string, productId: string): boolean {
  ensureCoreSchema();
  const row = getConnection()
    .prepare('SELECT tracks_batches FROM core_products WHERE id = ? AND company_id = ?')
    .get(productId, companyId) as { tracks_batches: number } | undefined;
  return row?.tracks_batches === 1;
}

/**
 * Liga ou desliga o controle de lote de um produto.
 *
 * Mora AQUI, e não em `CatalogService`, por posse: o módulo do lote é dono do
 * próprio interruptor, com as próprias recusas. A tela do produto chama esta
 * rota em separado depois de salvar a ficha — o mesmo desenho da grade e do
 * kit, que também não entram no INSERT do cadastro.
 *
 * DESLIGAR É PERMITIDO e não apaga nada: os movimentos que já carregam lote
 * continuam carregando, porque foi o que aconteceu. O que muda é o futuro —
 * saída nova deixa de escolher lote. Apagar o passado para "limpar" seria
 * exatamente a mentira que o razão imutável existe para impedir.
 */
export function setBatchControl(input: {
  companyId: string;
  productId: string;
  tracksBatches: boolean;
  userId?: string | null;
}): { productId: string; tracksBatches: boolean } {
  ensureCoreSchema();
  return withTransaction(() => {
    const db = getConnection();
    const produto = db
      .prepare(
        `SELECT id, name, serialized, stock_control,
                EXISTS (SELECT 1 FROM core_products f WHERE f.parent_id = p.id) AS tem_grade
           FROM core_products p WHERE p.id = ? AND p.company_id = ?`,
      )
      .get(input.productId, input.companyId) as
      | {
          id: string;
          name: string;
          serialized: number;
          stock_control: number;
          tem_grade: number;
        }
      | undefined;
    if (!produto) {
      throw new ApiError('CORE_PRODUCT_INVALID', 'O produto informado não é desta operação.', 404);
    }

    if (input.tracksBatches) {
      /*
        SERIALIZADO E LOTE SÃO EXCLUDENTES, como pesável e serializado.

        A unidade serializada JÁ tem identidade individual: a moto que sai é
        AQUELA moto, escolhida pelo caixa. Sobrepor lote criaria duas escolhas
        concorrentes para a mesma saída — qual peça sai × de qual lote sai — sem
        que nenhuma das duas mande, e o FEFO passaria a discordar da unidade
        escolhida no balcão. Quem precisa de validade por peça a guarda na
        própria unidade.
      */
      if (produto.serialized === 1) {
        throw new ApiError(
          'CORE_BATCH_AND_SERIALIZED',
          `"${produto.name}" é controlado por unidade: cada peça já tem identidade própria, `
            + 'e o lote criaria uma segunda escolha para a mesma saída.',
          400,
        );
      }
      /*
        SERVIÇO NÃO TEM LOTE. Produto sem controle de estoque não sai de
        prateleira nenhuma (`stock_control = 0`, o serviço de balcão): não há
        movimento para carregar `batch_id`, e o saldo por lote de um produto
        que nunca move seria uma tabela de zeros com cara de controle.
      */
      if (produto.stock_control === 0) {
        throw new ApiError(
          'CORE_BATCH_WITHOUT_STOCK',
          `"${produto.name}" não controla estoque: não há movimento para carregar o lote.`,
          400,
        );
      }
      /*
        MODELO DE GRADE não recebe nem entrega saldo — quem se move é a
        variante. `applyMovement` já recusa movimentá-lo; ligar lote aqui daria
        ao gestor uma tela de lotes que nunca teria uma linha.
      */
      if (produto.tem_grade) {
        throw new ApiError(
          'CORE_PRODUCT_IS_GRID_MODEL',
          `"${produto.name}" é um modelo de grade: o lote fica na variante (tamanho/cor), `
            + 'que é quem tem saldo.',
          400,
        );
      }
    }

    db.prepare(
      'UPDATE core_products SET tracks_batches = ?, updated_at = ? WHERE id = ? AND company_id = ?',
    ).run(
      input.tracksBatches ? 1 : 0,
      new Date().toISOString(),
      input.productId,
      input.companyId,
    );
    return { productId: input.productId, tracksBatches: input.tracksBatches };
  });
}

export interface BatchInput {
  productId: string;
  code: string;
  manufacturedOn?: string | null;
  expiresOn?: string | null;
  locationId?: string | null;
  note?: string | null;
  userId?: string | null;
}

/**
 * Cadastra o lote. Não move saldo nenhum — quem move é o razão.
 *
 * O CÓDIGO É ÚNICO POR PRODUTO. Repetir o mesmo código no mesmo produto é
 * recusado em vez de virar um segundo lote homônimo: dois "L2409" do mesmo
 * iogurte com validades diferentes fariam o FEFO escolher um e o operador
 * procurar o outro na prateleira.
 */
export function createBatch(companyId: string, input: BatchInput): BatchRow {
  ensureCoreSchema();
  const code = String(input.code ?? '').trim();
  if (!code) {
    throw new ApiError(
      'CORE_BATCH_CODE_REQUIRED',
      'Informe o código do lote — é ele que o operador lê na embalagem.',
      400,
    );
  }
  const fabricacao = dataDeCalendario(input.manufacturedOn, 'Data de fabricação');
  const validade = dataDeCalendario(input.expiresOn, 'Data de validade');
  /*
    FABRICADO DEPOIS DE VENCER é erro de digitação, não um lote.

    Recusar aqui é barato; deixar passar produz um lote que o relatório de
    validade mostra como vencido no dia em que chegou, e ninguém entende por quê.
  */
  if (fabricacao && validade && fabricacao > validade) {
    throw new ApiError(
      'CORE_BATCH_INVALID_DATE',
      'A fabricação é posterior à validade — confira as duas datas.',
      400,
    );
  }

  return withTransaction(() => {
    const db = getConnection();
    const produto = db
      .prepare('SELECT id, name, tracks_batches FROM core_products WHERE id = ? AND company_id = ?')
      .get(input.productId, companyId) as
      | { id: string; name: string; tracks_batches: number }
      | undefined;
    // O produto é da MESMA empresa — o mesmo guarda de entrega de
    // `applyMovement`, e pela mesma razão: lote da empresa A pendurado em
    // produto da B seria saldo-fantasma que nenhuma tela mostra.
    if (!produto) {
      throw new ApiError('CORE_PRODUCT_INVALID', 'O produto informado não é desta operação.', 404);
    }
    if (produto.tracks_batches !== 1) {
      throw new ApiError(
        'CORE_BATCH_NOT_APPLICABLE',
        `"${produto.name}" não controla lote e validade. Ligue o controle no cadastro do `
          + 'produto antes de cadastrar lotes.',
        400,
        { productId: input.productId },
      );
    }

    const jaExiste = db
      .prepare(
        'SELECT id FROM core_product_batches WHERE company_id = ? AND product_id = ? AND code = ?',
      )
      .get(companyId, input.productId, code) as { id: string } | undefined;
    if (jaExiste) {
      throw new ApiError(
        'CORE_BATCH_DUPLICATE',
        `Já existe o lote "${code}" para este produto.`,
        409,
        { batchId: jaExiste.id },
      );
    }

    if (input.locationId) {
      const local = db
        .prepare('SELECT id FROM core_stock_locations WHERE id = ? AND company_id = ?')
        .get(input.locationId, companyId);
      if (!local) {
        throw new ApiError('CORE_LOCATION_NOT_FOUND', 'Local não encontrado.', 404);
      }
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO core_product_batches
         (id, company_id, product_id, code, manufactured_on, expires_on, location_id,
          note, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      companyId,
      input.productId,
      code,
      fabricacao,
      validade,
      input.locationId ?? null,
      String(input.note ?? '').trim() || null,
      input.userId ?? null,
      now,
      now,
    );
    return getBatch(companyId, id)!;
  });
}

/**
 * Acha o lote pelo código, ou cadastra. É o que a ENTRADA usa.
 *
 * Idempotente por (empresa, produto, código): lançar duas entradas do mesmo
 * lote não cria dois lotes. A validade do primeiro cadastro MANDA — reescrevê-la
 * na segunda entrada mudaria calada a validade da mercadoria que já está na
 * prateleira, e quem digitou errado na primeira vez corrige pela tela, à vista.
 */
export function findOrCreateBatch(companyId: string, input: BatchInput): BatchRow {
  ensureCoreSchema();
  const code = String(input.code ?? '').trim();
  const existente = code
    ? (getConnection()
        .prepare(
          'SELECT id FROM core_product_batches WHERE company_id = ? AND product_id = ? AND code = ?',
        )
        .get(companyId, input.productId, code) as { id: string } | undefined)
    : undefined;
  if (existente) return getBatch(companyId, existente.id)!;
  return createBatch(companyId, input);
}

const SQL_SELECT_BATCH = `
  SELECT b.*,
         p.name          AS product_name,
         p.internal_code AS internal_code,
         p.unit          AS unit,
         l.name          AS location_name,
         u.display_name  AS checked_by_name,
         ${SQL_SALDO_DO_LOTE} AS quantity,
         CAST(ROUND(${SQL_SALDO_DO_LOTE} * p.cost_cents) AS INTEGER) AS value_cents
    FROM core_product_batches b
    JOIN core_products p ON p.id = b.product_id
    LEFT JOIN core_stock_locations l ON l.id = b.location_id
    LEFT JOIN core_users u ON u.id = b.checked_by`;

/** Acrescenta a faixa e os dias — a metade em TypeScript da régua única. */
function comFaixa(row: BatchRow, hoje: string): BatchRow {
  return {
    ...row,
    faixa: faixaDaValidade(row.expires_on, hoje),
    dias_para_vencer: diasParaVencer(row.expires_on, hoje),
  };
}

/** Um lote, sempre filtrado pelo tenant da sessão. */
export function getBatch(companyId: string, batchId: string): BatchRow | null {
  ensureCoreSchema();
  const row = getConnection()
    .prepare(`${SQL_SELECT_BATCH} WHERE b.id = ? AND b.company_id = ?`)
    .get(batchId, companyId) as BatchRow | undefined;
  return row ? comFaixa(row, hojeNaLoja()) : null;
}

export interface BatchFilters {
  productId?: string;
  faixa?: FaixaDeValidade;
  search?: string;
  /** Lote zerado some por padrão: ele já foi embora e polui a lista de ação. */
  incluirZerados?: boolean;
  /** Só o que ainda não passou pela conferência. */
  somenteNaoConferidos?: boolean;
  limit?: number;
  offset?: number;
}

/** Os lotes da empresa. Sempre filtrados pelo tenant da sessão. */
export function listBatches(companyId: string, options: BatchFilters = {}): BatchRow[] {
  ensureCoreSchema();
  const hoje = hojeNaLoja();
  const params: unknown[] = [companyId];
  let sql = `${SQL_SELECT_BATCH} WHERE b.company_id = ?`;

  if (options.productId) {
    sql += ' AND b.product_id = ?';
    params.push(options.productId);
  }
  if (options.search) {
    sql += ' AND (b.code LIKE ? OR p.name LIKE ? OR p.internal_code LIKE ?)';
    params.push(`%${options.search}%`, `%${options.search}%`, `%${options.search}%`);
  }
  if (options.somenteNaoConferidos) sql += ' AND b.checked_at IS NULL';
  /*
    A FAIXA É FILTRADA NO SQL, com a MESMA régua de `faixaDaValidade` — e não
    filtrando em memória depois do LIMIT, que devolveria página vazia com lote
    de sobra no banco.
  */
  if (options.faixa) {
    const em7 = somarDias(hoje, 7);
    const em15 = somarDias(hoje, 15);
    const em30 = somarDias(hoje, 30);
    const clausula: Record<FaixaDeValidade, string> = {
      vencido: 'b.expires_on IS NOT NULL AND b.expires_on < ?',
      vence_em_7: 'b.expires_on IS NOT NULL AND b.expires_on >= ? AND b.expires_on <= ?',
      vence_em_15: 'b.expires_on IS NOT NULL AND b.expires_on > ? AND b.expires_on <= ?',
      vence_em_30: 'b.expires_on IS NOT NULL AND b.expires_on > ? AND b.expires_on <= ?',
      em_dia: 'b.expires_on IS NOT NULL AND b.expires_on > ?',
      sem_validade: 'b.expires_on IS NULL',
    };
    sql += ` AND (${clausula[options.faixa]})`;
    if (options.faixa === 'vencido') params.push(hoje);
    if (options.faixa === 'vence_em_7') params.push(hoje, em7);
    if (options.faixa === 'vence_em_15') params.push(em7, em15);
    if (options.faixa === 'vence_em_30') params.push(em15, em30);
    if (options.faixa === 'em_dia') params.push(em30);
  }
  if (!options.incluirZerados) sql += ` AND ${SQL_SALDO_DO_LOTE} > 0`;

  /*
    A ORDEM É A DO FEFO, e não a alfabética: quem abre esta tela quer saber o
    que vence primeiro. Lote sem validade declarada vai para o fim — ele não
    tem urgência a comunicar, e deixá-lo no topo (nulo ordena antes em SQLite)
    empurraria o vencido para a segunda página.
  */
  sql += ' ORDER BY (b.expires_on IS NULL), b.expires_on ASC, p.name ASC, b.code ASC';
  sql += ' LIMIT ? OFFSET ?';
  params.push(options.limit ?? 500, options.offset ?? 0);

  const rows = getConnection().prepare(sql).all(...(params as never[])) as unknown as BatchRow[];
  return rows.map((row) => comFaixa(row, hoje));
}

export interface SaldoDeLote {
  /** Nulo é o balde "sem lote declarado" — pendência, não buraco. */
  batchId: string | null;
  code: string | null;
  expiresOn: string | null;
  quantity: number;
}

/**
 * Onde está o saldo deste produto, lote a lote — derivado do razão.
 *
 * O balde de `batch_id` nulo entra na lista como qualquer outro, com código
 * nulo. Escondê-lo faria a soma dos lotes discordar do saldo do produto, e é
 * justamente essa diferença que a tela de Validade existe para cobrar.
 */
export function balancesByBatch(companyId: string, productId: string): SaldoDeLote[] {
  ensureCoreSchema();
  const rows = getConnection()
    .prepare(
      `SELECT m.batch_id AS batchId, b.code AS code, b.expires_on AS expiresOn,
              SUM(m.quantity) AS quantity
         FROM core_stock_movements m
         LEFT JOIN core_product_batches b ON b.id = m.batch_id
        WHERE m.company_id = ? AND m.product_id = ?
        GROUP BY m.batch_id
        HAVING SUM(m.quantity) <> 0
        ORDER BY (b.expires_on IS NULL), b.expires_on ASC`,
    )
    .all(companyId, productId) as unknown as SaldoDeLote[];
  return rows;
}

/** Saldo de UM lote. Sempre pelo razão — nunca por coluna gravada. */
export function batchBalance(companyId: string, batchId: string): number {
  ensureCoreSchema();
  const row = getConnection()
    .prepare(
      `SELECT COALESCE(SUM(quantity), 0) AS saldo
         FROM core_stock_movements WHERE company_id = ? AND batch_id = ?`,
    )
    .get(companyId, batchId) as { saldo: number };
  return row.saldo;
}

/** Saldo que ainda NÃO tem lote declarado — a pendência da tela. */
export function saldoSemLote(companyId: string, productId: string): number {
  ensureCoreSchema();
  const row = getConnection()
    .prepare(
      `SELECT COALESCE(SUM(quantity), 0) AS saldo
         FROM core_stock_movements
        WHERE company_id = ? AND product_id = ? AND batch_id IS NULL`,
    )
    .get(companyId, productId) as { saldo: number };
  return row.saldo;
}

/**
 * FEFO — o que vence primeiro sai primeiro.
 *
 * ## Por que UM lote por movimento, e não vários
 *
 * A chave de idempotência do razão é
 * UNIQUE (empresa, tipo de referência, referência, produto, tipo de movimento),
 * e ela é a proteção mais forte deste sistema — é o que impede que a mesma
 * venda baixe estoque duas vezes. Rachar uma saída em duas linhas para
 * atravessar dois lotes colidiria nessa chave: as duas linhas teriam
 * exatamente os mesmos cinco campos.
 *
 * A escolha, então, é entre mudar a chave (alto risco, vinte pontos de leitura,
 * o projetor da central e o espelho do bootstrap) e escolher UM lote por saída.
 * Escolhemos o lote — e não é só o caminho barato: fisicamente é o que
 * acontece. Quem pesa 300 g de queijo pega de UMA peça aberta.
 *
 * ## A ordem da escolha
 *
 *   1. o lote NÃO VENCIDO que vence primeiro e que COBRE a saída inteira;
 *   2. senão, o balde SEM LOTE, se ele cobrir — é a mercadoria que entrou antes
 *      de o controle existir, ou por um caminho que ainda não declara lote (a
 *      nota fiscal). Deixá-lo em último é o que faz a pendência DIMINUIR: o
 *      lote declarado sai primeiro, e o balde só é tocado quando não há
 *      alternativa;
 *   3. senão, RECUSA — nomeando os lotes e os saldos, para que o operador
 *      venda em linhas separadas. Recusa com a conta na mão é melhor que uma
 *      escolha silenciosa que ninguém consegue reconstruir depois.
 *
 * O lote VENCIDO nunca é escolhido aqui, em nenhum passo. Ver
 * `podeConsumirVencido`: a saída que pode levá-lo embora informa o lote
 * explicitamente, porque tirar mercadoria vencida da prateleira é um ato
 * deliberado, nunca um efeito colateral de uma venda.
 */
export function pickBatchFefo(input: {
  companyId: string;
  productId: string;
  quantity: number;
  referenceType: string;
}): string | null {
  ensureCoreSchema();
  const hoje = hojeNaLoja();
  const lotes = getConnection()
    .prepare(
      `SELECT b.id, b.code, b.expires_on,
              ${SQL_SALDO_DO_LOTE} AS quantity
         FROM core_product_batches b
        WHERE b.company_id = ? AND b.product_id = ?
        ORDER BY (b.expires_on IS NULL), b.expires_on ASC, b.created_at ASC`,
    )
    .all(input.companyId, input.productId) as unknown as {
    id: string;
    code: string;
    expires_on: string | null;
    quantity: number;
  }[];

  const comSaldo = lotes.filter((l) => l.quantity > 0);
  const vencido = (l: { expires_on: string | null }) =>
    l.expires_on !== null && l.expires_on < hoje;
  const vencidos = comSaldo.filter(vencido);
  /*
    A SAÍDA QUE PODE LEVAR O VENCIDO ESCOLHE ENTRE TODOS — e é o desfecho
    certo, não uma brecha: o `ORDER BY` já está em ordem de validade, então a
    perda lançada sem escolher lote descarta o mais velho, que é o que a pessoa
    com a caixa na mão quer fazer. A venda continua vendo só os não vencidos.
  */
  const candidatos = podeConsumirVencido(input.referenceType) ? comSaldo : comSaldo.filter((l) => !vencido(l));

  const cobre = candidatos.find((l) => l.quantity >= input.quantity);
  if (cobre) return cobre.id;

  const semLote = saldoSemLote(input.companyId, input.productId);
  if (semLote >= input.quantity) return null;

  /*
    NENHUMA FONTE ÚNICA COBRE. A recusa carrega a conta inteira porque quem
    está no balcão precisa saber o que fazer — "estoque insuficiente" seria
    mentira (o saldo existe) e "escolha outro lote" não diz qual.
  */
  const detalhe = [
    ...candidatos.map((l) => `lote ${l.code} tem ${l.quantity}`),
    ...(semLote > 0 ? [`${semLote} sem lote declarado`] : []),
  ];
  if (detalhe.length === 0 && vencidos.length > 0) {
    throw new ApiError(
      'CORE_BATCH_EXPIRED',
      `Todo o saldo disponível está em lote vencido (${vencidos
        .map((l) => `${l.code}, venceu em ${l.expires_on}`)
        .join('; ')}). Mercadoria vencida não sai pela venda: dê baixa por perda `
        + 'em Estoque › Movimentações.',
      409,
      { productId: input.productId, vencidos: vencidos.map((l) => l.code) },
    );
  }
  throw new ApiError(
    'CORE_BATCH_SPLIT_REQUIRED',
    `Nenhum lote sozinho cobre ${input.quantity}: ${detalhe.join('; ')}. `
      + 'Lance uma linha por lote — o movimento guarda de qual lote a mercadoria saiu.',
    409,
    {
      productId: input.productId,
      requested: input.quantity,
      lotes: candidatos.map((l) => ({ code: l.code, quantity: l.quantity })),
      semLote,
    },
  );
}

/**
 * O lote informado pelo chamador serve para este movimento?
 *
 * Três perguntas, nesta ordem, porque é a ordem em que elas ficam úteis: o lote
 * é DESTA empresa e deste produto (tenant), ele NÃO ESTÁ VENCIDO para quem está
 * pedindo, e ele TEM saldo.
 *
 * As duas últimas só valem na SAÍDA. Entrar mercadoria num lote vencido é
 * legítimo — é a caixa que chegou vencida do fornecedor, e ela precisa ser
 * REGISTRADA para aparecer no relatório e voltar para quem a mandou.
 */
export function assertBatchUsable(input: {
  companyId: string;
  productId: string;
  batchId: string;
  quantity: number;
  direction: 'in' | 'out';
  referenceType: string;
}): void {
  ensureCoreSchema();
  const lote = getConnection()
    .prepare(
      `SELECT id, code, expires_on, product_id
         FROM core_product_batches WHERE id = ? AND company_id = ?`,
    )
    .get(input.batchId, input.companyId) as
    | { id: string; code: string; expires_on: string | null; product_id: string }
    | undefined;
  /*
    TENANT. O lote da empresa A é INVISÍVEL e INCONSUMÍVEL pela B — e a recusa
    é a mesma para "não existe" e "é de outra empresa", de propósito: dizer
    "existe, mas não é sua" já entrega que aquele id existe.
  */
  if (!lote || lote.product_id !== input.productId) {
    throw new ApiError(
      'CORE_BATCH_NOT_FOUND',
      'Lote não encontrado para este produto nesta operação.',
      404,
      { batchId: input.batchId },
    );
  }

  if (input.direction === 'in') return;

  const hoje = hojeNaLoja();
  if (lote.expires_on && lote.expires_on < hoje && !podeConsumirVencido(input.referenceType)) {
    throw new ApiError(
      'CORE_BATCH_EXPIRED',
      `O lote ${lote.code} venceu em ${lote.expires_on} e não pode ser vendido. `
        + 'Para tirá-lo da prateleira, lance uma saída por perda em Estoque › Movimentações.',
      409,
      { batchId: lote.id, code: lote.code, expiresOn: lote.expires_on },
    );
  }

  const saldo = batchBalance(input.companyId, input.batchId);
  if (saldo < input.quantity) {
    throw new ApiError(
      'CORE_BATCH_INSUFFICIENT',
      `O lote ${lote.code} tem ${saldo} — não dá para tirar ${input.quantity}.`,
      409,
      { batchId: lote.id, code: lote.code, available: saldo, requested: input.quantity },
    );
  }
}

/**
 * A conferência: quem olhou a caixa e disse "é este lote, esta validade".
 *
 * É o gesto que a referência mostra no recebimento, e o molde é o mesmo de
 * `counted_by`/`counted_at` da contagem de inventário: carimbo com autor e
 * hora, nunca um booleano. "Conferido" sem quem e quando não sobrevive à
 * primeira divergência.
 *
 * IDEMPOTENTE: conferir duas vezes não reescreve o primeiro carimbo. Quem
 * conferiu foi quem conferiu — o segundo clique não rouba a autoria do
 * primeiro.
 */
export function markBatchChecked(input: {
  companyId: string;
  batchId: string;
  userId?: string | null;
}): { batch: BatchRow; duplicated: boolean } {
  ensureCoreSchema();
  return withTransaction(() => {
    const db = getConnection();
    const atual = db
      .prepare('SELECT id, checked_at FROM core_product_batches WHERE id = ? AND company_id = ?')
      .get(input.batchId, input.companyId) as { id: string; checked_at: string | null } | undefined;
    if (!atual) {
      throw new ApiError('CORE_BATCH_NOT_FOUND', 'Lote não encontrado nesta operação.', 404);
    }
    if (atual.checked_at) {
      return { batch: getBatch(input.companyId, input.batchId)!, duplicated: true };
    }
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE core_product_batches SET checked_at = ?, checked_by = ?, updated_at = ?
        WHERE id = ? AND company_id = ?`,
    ).run(now, input.userId ?? null, now, input.batchId, input.companyId);
    return { batch: getBatch(input.companyId, input.batchId)!, duplicated: false };
  });
}

/**
 * Corrige a ficha do lote — validade digitada errada, local, observação.
 *
 * O CÓDIGO NÃO SE EDITA: ele é a identidade que o razão já aponta, e trocá-lo
 * renomearia retroativamente a mercadoria de todo movimento que saiu daquele
 * lote. Lote com código errado se resolve criando o certo e transferindo o
 * saldo por alocação — que deixa rastro, ao contrário do UPDATE.
 */
export function updateBatch(
  companyId: string,
  batchId: string,
  input: {
    manufacturedOn?: string | null;
    expiresOn?: string | null;
    locationId?: string | null;
    note?: string | null;
  },
): BatchRow {
  ensureCoreSchema();
  return withTransaction(() => {
    const db = getConnection();
    const atual = db
      .prepare('SELECT * FROM core_product_batches WHERE id = ? AND company_id = ?')
      .get(batchId, companyId) as
      | {
          id: string;
          manufactured_on: string | null;
          expires_on: string | null;
          location_id: string | null;
          note: string | null;
        }
      | undefined;
    if (!atual) {
      throw new ApiError('CORE_BATCH_NOT_FOUND', 'Lote não encontrado nesta operação.', 404);
    }

    const fabricacao =
      input.manufacturedOn === undefined
        ? atual.manufactured_on
        : dataDeCalendario(input.manufacturedOn, 'Data de fabricação');
    const validade =
      input.expiresOn === undefined
        ? atual.expires_on
        : dataDeCalendario(input.expiresOn, 'Data de validade');
    if (fabricacao && validade && fabricacao > validade) {
      throw new ApiError(
        'CORE_BATCH_INVALID_DATE',
        'A fabricação é posterior à validade — confira as duas datas.',
        400,
      );
    }
    const local = input.locationId === undefined ? atual.location_id : input.locationId || null;
    if (local) {
      const existe = db
        .prepare('SELECT id FROM core_stock_locations WHERE id = ? AND company_id = ?')
        .get(local, companyId);
      if (!existe) throw new ApiError('CORE_LOCATION_NOT_FOUND', 'Local não encontrado.', 404);
    }

    db.prepare(
      `UPDATE core_product_batches
          SET manufactured_on = ?, expires_on = ?, location_id = ?, note = ?, updated_at = ?
        WHERE id = ? AND company_id = ?`,
    ).run(
      fabricacao,
      validade,
      local,
      input.note === undefined ? atual.note : String(input.note ?? '').trim() || null,
      new Date().toISOString(),
      batchId,
      companyId,
    );
    return getBatch(companyId, batchId)!;
  });
}

/**
 * ALOCAÇÃO: o saldo sem lote declarado passa a ter lote.
 *
 * É a porta de saída da pendência que a entrada por nota fiscal cria — o XML
 * traz quantidade e custo, não lote —, e é o gesto que a conferência da doca
 * faz de qualquer jeito: abrir a caixa e ler a validade impressa.
 *
 * ## Por que um PAR de movimentos, e não um UPDATE
 *
 * O razão é imutável. Reescrever `batch_id` numa linha antiga mudaria o
 * passado: a saída que aconteceu "sem lote" passaria a ter acontecido "do lote
 * L2409", e o `batch_balance_after` daquela linha viraria mentira. O par
 * saída-sem-lote + entrada-no-lote diz a verdade — a mercadoria não mudou de
 * quantidade, mudou de identidade — e é EXATAMENTE o desenho que
 * `transferStock` já usa entre locais, com a mesma referência compartilhada
 * pelas duas pernas e o mesmo truque de `:saida`/`:entrada` para não colidir na
 * chave de idempotência.
 */
export function allocateToBatch(input: {
  companyId: string;
  productId: string;
  batchId: string;
  quantity: number;
  userId?: string | null;
  note?: string | null;
}): { reference: string; quantity: number } {
  ensureCoreSchema();
  if (!Number.isFinite(input.quantity) || input.quantity <= 0) {
    throw new ApiError('CORE_INVALID_QUANTITY', 'Quantidade inválida.', 400);
  }
  return withTransaction(() => {
    const lote = getBatch(input.companyId, input.batchId);
    if (!lote || lote.product_id !== input.productId) {
      throw new ApiError(
        'CORE_BATCH_NOT_FOUND',
        'Lote não encontrado para este produto nesta operação.',
        404,
      );
    }
    const disponivel = saldoSemLote(input.companyId, input.productId);
    if (disponivel < input.quantity) {
      throw new ApiError(
        'CORE_BATCH_NOTHING_TO_ALLOCATE',
        `Há ${disponivel} sem lote declarado — não dá para alocar ${input.quantity}.`,
        409,
        { available: disponivel, requested: input.quantity },
      );
    }

    const reference = randomUUID();
    const motivo = `Alocação no lote ${lote.code}`;
    /*
      A PERNA DE SAÍDA usa `referenceType: 'ajuste'` — que está na lista das
      saídas que podem levar vencido — porque alocar mercadoria numa validade
      já passada é legítimo: é assim que se descobre, na doca, que a caixa
      recebida na semana passada já estava vencida. A trava sanitária está na
      VENDA, e continua inteira.
    */
    applyMovement({
      companyId: input.companyId,
      productId: input.productId,
      movementType: 'out',
      quantity: input.quantity,
      referenceType: 'ajuste',
      referenceId: `${reference}:saida`,
      kind: 'MANUAL_EXIT',
      reason: motivo,
      note: input.note ?? null,
      userId: input.userId ?? null,
      // Explicitamente o balde: sem isto o FEFO escolheria um lote declarado e
      // a alocação roubaria saldo de quem já estava certo.
      semLote: true,
    });
    applyMovement({
      companyId: input.companyId,
      productId: input.productId,
      movementType: 'in',
      quantity: input.quantity,
      referenceType: 'ajuste',
      referenceId: `${reference}:entrada`,
      kind: 'MANUAL_ENTRY',
      reason: motivo,
      note: input.note ?? null,
      userId: input.userId ?? null,
      batchId: input.batchId,
    });
    return { reference, quantity: input.quantity };
  });
}

export interface FaixaDoAlerta {
  faixa: FaixaDeValidade;
  label: string;
  lotes: number;
  quantity: number;
  valueCents: number;
}

export interface BatchAlerts {
  /** O dia em que a medição foi feita, no fuso da loja. */
  hoje: string;
  faixas: FaixaDoAlerta[];
  /** Quantos lotes com saldo ainda não passaram pela conferência. */
  naoConferidos: number;
  /** Produtos que controlam lote e têm saldo sem lote declarado. */
  produtosComSaldoSemLote: number;
  /** Quanto desse saldo sem lote existe, somado. */
  quantidadeSemLote: number;
}

/**
 * O ALERTA — vencido e a vencer, por faixa, com estoque e valor.
 *
 * A régua das faixas é a MESMA de `faixaDaValidade`, escrita aqui em SQL para
 * o outro leitor. Lado a lado, como `SQL_ABAIXO_DO_MINIMO` e `abaixoDoMinimo`:
 * duas cópias distantes é como as três definições de "abaixo do mínimo"
 * nasceram nesta casa.
 *
 * SÓ LOTE COM SALDO entra. Lote zerado já foi embora — contá-lo faria o alerta
 * gritar sobre mercadoria que não está mais na prateleira, e um alerta que
 * grita sobre tudo não aponta nada.
 */
export function batchAlerts(companyId: string): BatchAlerts {
  ensureCoreSchema();
  const hoje = hojeNaLoja();
  const em7 = somarDias(hoje, 7);
  const em15 = somarDias(hoje, 15);
  const em30 = somarDias(hoje, 30);

  const rows = getConnection()
    .prepare(
      `SELECT CASE
                WHEN lote.expires_on IS NULL        THEN 'sem_validade'
                WHEN lote.expires_on <  ?           THEN 'vencido'
                WHEN lote.expires_on <= ?           THEN 'vence_em_7'
                WHEN lote.expires_on <= ?           THEN 'vence_em_15'
                WHEN lote.expires_on <= ?           THEN 'vence_em_30'
                ELSE 'em_dia'
              END AS faixa,
              COUNT(*) AS lotes,
              COALESCE(SUM(lote.saldo), 0) AS quantity,
              COALESCE(SUM(CAST(ROUND(lote.saldo * lote.cost_cents) AS INTEGER)), 0)
                AS value_cents
         FROM (SELECT b.id AS id, b.expires_on AS expires_on, p.cost_cents AS cost_cents,
                      ${SQL_SALDO_DO_LOTE} AS saldo
                 FROM core_product_batches b
                 JOIN core_products p ON p.id = b.product_id
                WHERE b.company_id = ?) AS lote
        WHERE lote.saldo > 0
        GROUP BY faixa`,
    )
    .all(hoje, em7, em15, em30, companyId) as unknown as {
    faixa: FaixaDeValidade;
    lotes: number;
    quantity: number;
    value_cents: number;
  }[];

  const porFaixa = new Map(rows.map((r) => [r.faixa, r]));
  /*
    TODA FAIXA APARECE, inclusive a que está zerada. Faixa ausente faria a tela
    ter de inventar a linha "Vencido: 0" — e uma tela que às vezes tem a linha e
    às vezes não deixa o gestor sem saber se ele leu o número ou se o número
    não existe.
  */
  const faixas = FAIXAS_DE_VALIDADE.map((faixa) => {
    const achada = porFaixa.get(faixa);
    return {
      faixa,
      label: FAIXA_LABEL[faixa],
      lotes: achada?.lotes ?? 0,
      quantity: achada?.quantity ?? 0,
      valueCents: achada?.value_cents ?? 0,
    };
  });

  const naoConferidos = getConnection()
    .prepare(
      `SELECT COUNT(*) AS n FROM core_product_batches b
        WHERE b.company_id = ? AND b.checked_at IS NULL AND ${SQL_SALDO_DO_LOTE} > 0`,
    )
    .get(companyId) as { n: number };

  const semLote = getConnection()
    .prepare(
      `SELECT COUNT(*) AS produtos, COALESCE(SUM(pendente.saldo), 0) AS quantidade
         FROM (SELECT m.product_id AS product_id, SUM(m.quantity) AS saldo
                 FROM core_stock_movements m
                 JOIN core_products p ON p.id = m.product_id
                WHERE m.company_id = ? AND m.batch_id IS NULL AND p.tracks_batches = 1
                GROUP BY m.product_id
               HAVING SUM(m.quantity) > 0) AS pendente`,
    )
    .get(companyId) as { produtos: number; quantidade: number };

  return {
    hoje,
    faixas,
    naoConferidos: naoConferidos.n,
    produtosComSaldoSemLote: semLote.produtos,
    quantidadeSemLote: semLote.quantidade,
  };
}

export interface PendenciaSemLote {
  productId: string;
  productName: string;
  internalCode: string;
  unit: string;
  quantity: number;
}

/**
 * Os produtos que controlam lote e têm saldo SEM lote declarado.
 *
 * É a lista de trabalho da doca: cada linha é uma caixa que chegou por nota
 * fiscal (ou entrou antes de o controle existir) e ainda não teve a validade
 * lida. Existe para que o balde diminua — sem esta lista ele cresceria calado,
 * e o módulo inteiro viraria enfeite.
 */
export function pendenciasSemLote(companyId: string): PendenciaSemLote[] {
  ensureCoreSchema();
  return getConnection()
    .prepare(
      `SELECT p.id AS productId, p.name AS productName, p.internal_code AS internalCode,
              p.unit AS unit, SUM(m.quantity) AS quantity
         FROM core_stock_movements m
         JOIN core_products p ON p.id = m.product_id
        WHERE m.company_id = ? AND m.batch_id IS NULL AND p.tracks_batches = 1
        GROUP BY p.id
       HAVING SUM(m.quantity) > 0
        ORDER BY p.name`,
    )
    .all(companyId) as unknown as PendenciaSemLote[];
}
