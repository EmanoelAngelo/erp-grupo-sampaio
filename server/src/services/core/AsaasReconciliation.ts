/**
 * Conciliação: o que o Asaas confirmou × o que o financeiro registrou.
 *
 * POR QUE ISSO PRECISA EXISTIR
 *
 * O provedor confirma um pagamento, o webhook chega, o núcleo baixa o estoque
 * e lança a entrada financeira. Três coisas separadas, ligadas por rede. Basta
 * uma delas falhar no meio para a operação passar a ter uma verdade a menos —
 * e nenhuma tela avisaria:
 *
 *   - COBRADO E NÃO LANÇADO: o dinheiro entrou na conta do Asaas e não existe
 *     no financeiro. É receita invisível: some do faturamento, do imposto e da
 *     conferência do fim do mês.
 *   - LANÇADO E NÃO COBRADO: o financeiro diz que recebeu e o provedor não tem
 *     a cobrança. É receita que não existe, inflando o resultado.
 *   - VALOR DIVERGENTE: os dois existem e não batem. Um centavo de diferença
 *     costuma ser arredondamento; mil reais, não.
 *
 * A REGRA QUE NÃO SE QUEBRA: esta conciliação NÃO CORRIGE NADA. Ela compara e
 * relata. Ajustar sozinho o lado que "parece errado" é como acertar a balança
 * empurrando o prato — some com o sintoma e mantém a causa, e a próxima
 * divergência já vem em cima de um número adulterado. Quem decide o que fazer
 * é quem responde pelo caixa.
 *
 * O QUE ENTRA NA COMPARAÇÃO
 *
 * Só intenção CONFIRMADA pelo provedor conta como cobrada — `pending` é
 * cobrança em aberto, não divergência, e tratar as duas igual encheria o
 * relatório de ruído até ninguém mais olhar.
 */
import { getConnection } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { hojeNaLoja, limitesDoPeriodo, somarDias } from './CalendarioOperacional.js';
import type { PaymentOriginType } from './PaymentService.js';
import type { StatusDaCobranca } from './FinanceChargeService.js';

/*
  ============================================================================
  QUANDO O DINHEIRO ENTROU — e por que isto também é um Record TOTAL
  ============================================================================

  Três status significam "o dinheiro entrou": o caminho feliz, o pagamento
  recebido depois do cancelamento e o pagamento de valor diferente. Essa lista
  estava escrita à mão DENTRO do SQL das intenções, e num só dos três lugares
  que precisam dela — a consulta do provedor. A consulta do lado do financeiro
  não filtrava status nenhum, e é dali que nasceu o defeito do bloco abaixo.

  O mapa é `Record<StatusDaCobranca, ...>` sobre a mesma união fechada que
  `FinanceChargeService` declara para os status que `PaymentService` grava:
  nascer um status novo lá quebra a COMPILAÇÃO aqui, e quem o criou decide, no
  mesmo dia, se ele é dinheiro. O import é `import type` de propósito — some na
  compilação e não cria dependência de execução entre os dois serviços.
*/

/** O que cada status da cobrança significa PARA ESTE RELATÓRIO. */
type PapelNaConciliacao =
  /** O dinheiro entrou por ela. É o que se compara com o financeiro. */
  | 'dinheiro_entrou'
  /** Cobrança que ainda pode receber (ou já morreu sem receber). */
  | 'dinheiro_nao_entrou';

const PAPEL_DO_STATUS: Record<StatusDaCobranca, PapelNaConciliacao> = {
  // Nunca chegaram ao provedor: não há cobrança lá fora nem dinheiro aqui.
  unconfigured: 'dinheiro_nao_entrou',
  failed: 'dinheiro_nao_entrou',
  // Boleto/PIX de pé. Cobrança em aberto NÃO é divergência — tratar as duas
  // igual encheria o relatório de ruído até ninguém mais olhar.
  pending: 'dinheiro_nao_entrou',
  overdue: 'dinheiro_nao_entrou',
  // O caminho feliz.
  confirmed: 'dinheiro_entrou',
  // Pagou valor diferente e o pedido NÃO virou pago de propósito: o dinheiro
  // entrou do mesmo jeito e é exatamente quem precisa de alguém olhando.
  amount_mismatch: 'dinheiro_entrou',
  // Dinheiro real recebido DEPOIS do cancelamento — "pendente de
  // regularização" nas palavras do próprio PaymentService.
  paid_after_cancel: 'dinheiro_entrou',
  // Entrou e voltou. Não é dinheiro que está lá hoje.
  refunded: 'dinheiro_nao_entrou',
  chargeback: 'dinheiro_nao_entrou',
  cancelled: 'dinheiro_nao_entrou',
};

/** Os status em que o dinheiro entrou. Derivado do `Record`, nunca à mão. */
const STATUS_COM_DINHEIRO: StatusDaCobranca[] = (
  Object.keys(PAPEL_DO_STATUS) as StatusDaCobranca[]
).filter((status) => PAPEL_DO_STATUS[status] === 'dinheiro_entrou');

/*
  ============================================================================
  AS DUAS GRAFIAS DA MESMA ORIGEM — e por que isto é um Record TOTAL
  ============================================================================

  O DEFEITO (regressão do V13-ASS-016): a cobrança avulsa criou uma SEGUNDA
  origem de cobrança e este arquivo ficou intocado. Do lado do PROVEDOR a
  intenção do título nasce como `finance_entry:<id do título>`; do lado do
  FINANCEIRO o mesmo título avulso é `manual:<id dele mesmo>` — e a consulta
  nem o trazia, porque filtrava `origin_type IN ('ecommerce_order','sale')`.
  Como a chave da comparação é `origin_type:origin_id`, 'finance_entry:x' nunca
  casava com 'manual:x': TODA cobrança de título paga e JÁ BAIXADA pelo webhook
  caía em `cobrado_nao_lancado`. O relatório feito para achar dinheiro faltando
  passou a acusar dinheiro que não falta — e alerta que sempre grita ensina a
  ignorar alertas.

  A TRADUÇÃO MORA NUM LUGAR SÓ, e é este mapa. Ele é `Record<PaymentOriginType,
  ...>`: quando nascer uma TERCEIRA origem de cobrança, o tipo passa a ter um
  membro a mais e este literal deixa de compilar — a decisão é cobrada de quem
  cria a origem, no dia em que a cria. Uma lista escrita à mão dentro do SQL
  envelheceria calada exatamente como esta envelheceu.
*/

/** Como a cobrança de cada origem encontra o lançamento no financeiro. */
type LigacaoComOFinanceiro =
  /**
   * O lançamento NASCEU do mesmo documento que a cobrança: pedido online e
   * venda gravam `origin_type`/`origin_id` iguais aos da intenção.
   */
  | 'pela_origem_do_lancamento'
  /**
   * A cobrança aponta para o PRÓPRIO título: `origin_id` da intenção é o `id`
   * do lançamento, e a origem do lançamento é outra coisa ('manual', 'sale',
   * o que for). É o caso do contas a receber cobrado por PIX/boleto/link.
   */
  | 'pelo_id_do_lancamento'
  /**
   * A cobrança é UMA LINHA DE PAGAMENTO da venda de balcão (GAP-PRD-077): o
   * PIX gerado pelo provedor no caixa. A venda pode ter sido paga em dinheiro
   * E PIX — comparar o PIX com o título inteiro da venda acusaria a parte em
   * dinheiro como divergência. O lado do financeiro é a linha do PIX em
   * `core_sale_payments`, liquidada, com a referência do provedor.
   */
  | 'pela_linha_de_pagamento_da_venda'
  /** Origem declarada no tipo e sem escritor vivo: não há lançamento a casar. */
  | 'sem_lancamento_no_financeiro';

const LIGACAO_DA_ORIGEM: Record<PaymentOriginType, LigacaoComOFinanceiro> = {
  ecommerce_order: 'pela_origem_do_lancamento',
  // O PIX do balcão (GAP-PRD-077) — ver a ligação acima.
  sale: 'pela_linha_de_pagamento_da_venda',
  finance_entry: 'pelo_id_do_lancamento',
  // `service_order` está no tipo e não tem criador de cobrança nenhum hoje
  // (nenhum `createPaymentIntent` a usa). Declarar 'sem lançamento' é dizer a
  // verdade; inventar uma ligação faria a conciliação prometer um casamento
  // que não existe.
  service_order: 'sem_lancamento_no_financeiro',
};

const origensCom = (ligacao: LigacaoComOFinanceiro): PaymentOriginType[] =>
  (Object.keys(LIGACAO_DA_ORIGEM) as PaymentOriginType[]).filter(
    (origem) => LIGACAO_DA_ORIGEM[origem] === ligacao,
  );

/** As origens que casam pelo documento — hoje, pedido online e venda. */
const ORIGENS_PELO_DOCUMENTO = origensCom('pela_origem_do_lancamento');
/** As origens que casam pelo id do título — hoje, o contas a receber. */
const ORIGENS_PELO_TITULO = origensCom('pelo_id_do_lancamento');
/** As origens que casam pela linha de pagamento — hoje, o PIX do balcão. */
const ORIGENS_PELA_LINHA_DA_VENDA = origensCom('pela_linha_de_pagamento_da_venda');

/** `?, ?, ?` do tamanho da lista, para o `IN` do SQL. */
const interrogacoes = (quantos: number) => Array.from({ length: quantos }, () => '?').join(', ');

/** O que cada divergência significa para quem lê. */
export type ReconciliationKind =
  | 'cobrado_nao_lancado'
  | 'lancado_nao_cobrado'
  | 'valor_divergente';

export interface ReconciliationRow {
  kind: ReconciliationKind;
  originType: string;
  originId: string;
  /** O que o provedor confirmou. `null` quando não há cobrança. */
  providerCents: number | null;
  /** O que o financeiro registrou. `null` quando não há lançamento. */
  financeCents: number | null;
  differenceCents: number;
  providerRef: string | null;
  confirmedAt: string | null;
  description: string;
}

export interface ReconciliationReport {
  from: string;
  to: string;
  /** Total confirmado pelo provedor no período. */
  providerCents: number;
  /** Total lançado no financeiro com origem no provedor, no mesmo período. */
  financeCents: number;
  differenceCents: number;
  matched: number;
  rows: ReconciliationRow[];
}

/** Um dia inteiro, do primeiro ao último instante, no relógio da loja. */
function janela(from?: string, to?: string): { from: string; to: string } {
  const fim = to ?? hojeNaLoja();
  const inicio = from ?? somarDias(fim, -30);
  const limites = limitesDoPeriodo(inicio, fim);
  return { from: limites.inicio, to: limites.fim };
}

interface IntentRow {
  origin_type: string;
  origin_id: string;
  amount_cents: number;
  provider_ref: string | null;
  confirmed_at: string | null;
}

interface FinanceRow {
  /** O id do LANÇAMENTO. Serve para não contar a mesma linha duas vezes. */
  id: string;
  origin_type: string;
  origin_id: string;
  settled_cents: number;
  description: string;
}

/**
 * Compara provedor e financeiro num período.
 *
 * A chave da comparação é `(origin_type, origin_id)` — o FATO, não o
 * identificador do provedor. Casar por `provider_ref` deixaria de fora
 * exatamente o caso que mais importa: a cobrança que existe lá e não gerou
 * nada aqui.
 */
export function reconcileAsaas(input: {
  companyId: string;
  from?: string;
  to?: string;
}): ReconciliationReport {
  ensureCoreSchema();
  const db = getConnection();
  const { from, to } = janela(input.from, input.to);

  /*
    OS TRÊS DESFECHOS EM QUE O DINHEIRO ENTROU — e não só o feliz.

    `PaymentService` grava três estados para cobrança paga:

      - `confirmed`         — o caminho feliz;
      - `paid_after_cancel` — dinheiro real recebido DEPOIS do cancelamento,
        que o próprio código descreve como "pendente de regularização";
      - `amount_mismatch`   — pagou valor diferente do pedido, e o pedido não
        virou pago de propósito.

    A conciliação lia só o primeiro. Os outros dois são exatamente o dinheiro
    que precisa de alguém olhando, e sumiam do único relatório feito para
    achá-los.

    O recorte também tinha de mudar: nenhum dos dois carimba `confirmed_at`.
    Incluí-los no `status` sem trocar a coluna da janela os deixaria de fora do
    mesmo jeito — verde por outro motivo.
  */
  const intents = db
    .prepare(
      `SELECT origin_type, origin_id, amount_cents, provider_ref,
              COALESCE(confirmed_at, updated_at) AS confirmed_at
         FROM core_payment_intents
        WHERE company_id = ?
          AND provider = 'asaas'
          AND status IN (${interrogacoes(STATUS_COM_DINHEIRO.length)})
          AND COALESCE(confirmed_at, updated_at) BETWEEN ? AND ?`,
    )
    .all(input.companyId, ...STATUS_COM_DINHEIRO, from, to) as unknown as IntentRow[];

  /**
   * SÓ O QUE PASSOU PELO PROVEDOR.
   *
   * O `EXISTS` não é detalhe de performance: sem ele o total do financeiro
   * incluiria dinheiro no balcão e cartão na maquininha física, e o cartão
   * "Diferença" acusaria uma falta que não existe. Foi o que a tela mostrou na
   * primeira vez que rodou contra dados reais — R$ 319,70 em vermelho no
   * resumo e "tudo confere" logo abaixo. Um alerta que contradiz o próprio
   * detalhe ensina a ignorar alertas.
   */
  /*
    DUAS CONSULTAS PORQUE SÃO DUAS LIGAÇÕES, e a chave sai JÁ TRADUZIDA.

    A do TÍTULO vem primeiro e a do DOCUMENTO ignora o que ela já trouxe: um
    título de venda cobrado como título (`finance_entry:<id do título>`) casa
    pelas duas — e somá-lo duas vezes dobraria o total do financeiro e faria a
    "Diferença" aparecer com o sinal invertido, que é a mesma classe de mentira
    que este relatório existe para não contar.
  */
  const lancamentos: FinanceRow[] = [];
  const jaContados = new Set<string>();

  const acrescentar = (linhas: FinanceRow[]) => {
    for (const linha of linhas) {
      if (jaContados.has(linha.id)) continue;
      jaContados.add(linha.id);
      lancamentos.push(linha);
    }
  };

  /*
    ============================================================================
    O DEFEITO: UM BOLETO EM ABERTO ROUBAVA O LANÇAMENTO DO DOCUMENTO
    ============================================================================

    O `EXISTS` da consulta POR TÍTULO não olhava o `status` da intenção. Então
    QUALQUER cobrança de título — inclusive uma ainda `pending`, que não é
    dinheiro e nem entra na consulta do provedor lá em cima — bastava para
    reescrever a chave do lançamento como `finance_entry:<id>`. E o dedupe,
    fazendo exatamente o seu trabalho, retirava essa mesma linha da consulta
    POR DOCUMENTO.

    Num lançamento de PEDIDO ONLINE já liquidado pelo webhook do pedido o
    desfecho era determinístico: a intenção CONFIRMADA do pedido perdia o
    lançamento (`cobrado_nao_lancado`) e o lançamento perdia a cobrança
    (`lancado_nao_cobrado`). Duas divergências de mentira nascidas de um boleto
    em aberto — a MESMA classe de falso positivo que esta correção existe para
    matar. E o caminho é alcançável pela tela: `POST /core/finance/entries/:id
    /charge` não restringe `origin_type`, e o botão "Cobrar via Asaas" é
    oferecido para qualquer título em aberto com cliente.

    A REGRA QUE CONSERTA: o lançamento é contado sob a grafia da cobrança QUE
    TROUXE O DINHEIRO. Quando nenhuma trouxe, sob a grafia da que existe. Daí
    as três passadas, nesta ordem — e a ordem É a regra, porque a primeira que
    reivindica a linha define a chave:

      1. TÍTULO com dinheiro dentro  — a cobrança do título foi paga;
      2. DOCUMENTO                   — o pedido/venda tem cobrança própria;
      3. TÍTULO em aberto            — sobrou só o boleto de pé (é o caso do
         título baixado no caixa com o boleto ainda vivo, que É divergência).
  */
  const passadaPeloTitulo = (somenteComDinheiro: boolean) => {
    if (ORIGENS_PELO_TITULO.length === 0) return;
    // A cobrança aponta para o `id` do lançamento; a chave da comparação passa
    // a ser a GRAFIA DA COBRANÇA (`finance_entry:<id do título>`), que é o fato
    // como o provedor o cobra — e é o que a tela mostra na linha da divergência.
    const recorteDeStatus = somenteComDinheiro
      ? `AND p.status IN (${interrogacoes(STATUS_COM_DINHEIRO.length)})`
      : '';
    const statusParams = somenteComDinheiro ? STATUS_COM_DINHEIRO : [];
    acrescentar(
      db
        .prepare(
          `SELECT f.id,
                  (SELECT p.origin_type FROM core_payment_intents p
                    WHERE p.company_id = f.company_id
                      AND p.provider = 'asaas'
                      AND p.origin_type IN (${interrogacoes(ORIGENS_PELO_TITULO.length)})
                      AND p.origin_id = f.id
                      ${recorteDeStatus}
                    LIMIT 1) AS origin_type,
                  f.id AS origin_id, f.settled_cents, f.description
             FROM core_finance_entries f
            WHERE f.company_id = ?
              AND f.direction = 'in'
              AND f.status = 'settled'
              AND f.settled_at BETWEEN ? AND ?
              AND EXISTS (
                    SELECT 1 FROM core_payment_intents p
                     WHERE p.company_id = f.company_id
                       AND p.provider = 'asaas'
                       AND p.origin_type IN (${interrogacoes(ORIGENS_PELO_TITULO.length)})
                       AND p.origin_id = f.id
                       ${recorteDeStatus}
                  )`,
        )
        .all(
          ...ORIGENS_PELO_TITULO,
          ...statusParams,
          input.companyId,
          from,
          to,
          ...ORIGENS_PELO_TITULO,
          ...statusParams,
        ) as unknown as FinanceRow[],
    );
  };

  // 1ª passada: só a cobrança de título que TROUXE DINHEIRO reivindica a linha.
  passadaPeloTitulo(true);

  if (ORIGENS_PELO_DOCUMENTO.length > 0) {
    acrescentar(
      db
        .prepare(
          `SELECT f.id, f.origin_type, f.origin_id, f.settled_cents, f.description
             FROM core_finance_entries f
            WHERE f.company_id = ?
              AND f.direction = 'in'
              AND f.status = 'settled'
              AND f.origin_type IN (${interrogacoes(ORIGENS_PELO_DOCUMENTO.length)})
              AND f.settled_at BETWEEN ? AND ?
              AND EXISTS (
                    SELECT 1 FROM core_payment_intents p
                     WHERE p.company_id = f.company_id
                       AND p.provider = 'asaas'
                       AND p.origin_type = f.origin_type
                       AND p.origin_id = f.origin_id
                  )`,
        )
        .all(
          input.companyId,
          ...ORIGENS_PELO_DOCUMENTO,
          from,
          to,
        ) as unknown as FinanceRow[],
    );
  }

  /*
    A LINHA DO PIX DO BALCÃO (GAP-PRD-077). O que o ERP registrou como
    recebido pelo provedor numa venda de balcão: a linha de PIX liquidada, com
    a referência do provedor, na data em que foi liquidada (a linha pendente
    liquidada dias depois conta no dia em que o dinheiro entrou).
  */
  if (ORIGENS_PELA_LINHA_DA_VENDA.length > 0) {
    acrescentar(
      db
        .prepare(
          `SELECT 'linha:' || sp.id AS id, 'sale' AS origin_type, sp.sale_id AS origin_id,
                  sp.amount_cents AS settled_cents, 'Venda #' || s.number AS description
             FROM core_sale_payments sp
             JOIN core_sales s ON s.id = sp.sale_id
            WHERE sp.company_id = ?
              AND sp.status = 'settled'
              AND sp.provider = 'asaas'
              AND sp.payment_intent_id IS NOT NULL
              AND COALESCE(sp.settled_at, sp.created_at) BETWEEN ? AND ?`,
        )
        .all(input.companyId, from, to) as unknown as FinanceRow[],
    );
  }

  /*
    3ª passada: o que sobrou com cobrança de título EM ABERTO.

    Aqui mora o caso legítimo que a 1ª passada não pega e a 2ª não alcança: o
    boleto continua vivo no provedor e alguém já deu baixa no caixa — o cliente
    ainda pode pagar de novo, e isso É divergência (`lancado_nao_cobrado`).
    Sem esta passada o conserto teria calado um alerta verdadeiro para matar um
    falso, que é trocar de defeito e não consertar nenhum.
  */
  passadaPeloTitulo(false);

  /*
    UM FATO PODE TER VÁRIAS LINHAS DOS DOIS LADOS — e o `Map` guardava só a
    última.

    No financeiro: um pedido de R$ 300 em 3× tem TRÊS lançamentos com a mesma
    origem, diferindo em `installment_number`. A comparação via só a última
    parcela e acusava R$ 200 de divergência que não existe — no relatório que o
    gerente usa justamente para decidir se falta dinheiro.

    No provedor: duas cobranças confirmadas para o mesmo pedido são pagamento
    em duplicidade. Somar as duas faz a divergência APARECER, com o valor certo;
    guardar só a última a escondia.

    Os totais do rodapé sempre somaram tudo. Era a comparação fato a fato que
    dizia outra coisa — duas contas do mesmo relatório discordando.
  */
  const porFato = (t: string, i: string) => `${t}:${i}`;

  const noProvedor = new Map<string, IntentRow>();
  for (const i of intents) {
    const chave = porFato(i.origin_type, i.origin_id);
    const anterior = noProvedor.get(chave);
    noProvedor.set(
      chave,
      anterior
        ? { ...anterior, amount_cents: anterior.amount_cents + i.amount_cents }
        : { ...i },
    );
  }

  const noFinanceiro = new Map<string, FinanceRow>();
  for (const f of lancamentos) {
    const chave = porFato(f.origin_type, f.origin_id);
    const anterior = noFinanceiro.get(chave);
    noFinanceiro.set(
      chave,
      anterior
        ? { ...anterior, settled_cents: anterior.settled_cents + f.settled_cents }
        : { ...f },
    );
  }

  const rows: ReconciliationRow[] = [];
  let batidos = 0;

  for (const [chave, intent] of noProvedor) {
    const financeiro = noFinanceiro.get(chave);

    if (!financeiro) {
      // Dinheiro na conta do Asaas que não existe no financeiro: some do
      // faturamento e do imposto sem ninguém perceber.
      rows.push({
        kind: 'cobrado_nao_lancado',
        originType: intent.origin_type,
        originId: intent.origin_id,
        providerCents: intent.amount_cents,
        financeCents: null,
        differenceCents: intent.amount_cents,
        providerRef: intent.provider_ref,
        confirmedAt: intent.confirmed_at,
        description: 'Cobrança confirmada pelo provedor sem lançamento no financeiro.',
      });
      continue;
    }

    if (financeiro.settled_cents !== intent.amount_cents) {
      rows.push({
        kind: 'valor_divergente',
        originType: intent.origin_type,
        originId: intent.origin_id,
        providerCents: intent.amount_cents,
        financeCents: financeiro.settled_cents,
        differenceCents: intent.amount_cents - financeiro.settled_cents,
        providerRef: intent.provider_ref,
        confirmedAt: intent.confirmed_at,
        description: financeiro.description,
      });
      continue;
    }

    batidos += 1;
  }

  for (const [chave, financeiro] of noFinanceiro) {
    if (noProvedor.has(chave)) continue;

    // Chegar aqui já significa que há intenção no Asaas para este fato: a
    // consulta acima só traz lançamento com cobrança no provedor. Venda de
    // balcão não é divergência, é outro meio de pagamento.
    rows.push({
      kind: 'lancado_nao_cobrado',
      originType: financeiro.origin_type,
      originId: financeiro.origin_id,
      providerCents: null,
      financeCents: financeiro.settled_cents,
      differenceCents: -financeiro.settled_cents,
      providerRef: null,
      confirmedAt: null,
      description: 'Lançamento no financeiro sem cobrança confirmada no provedor.',
    });
  }

  const totalProvedor = intents.reduce((acc, i) => acc + i.amount_cents, 0);
  const totalFinanceiro = lancamentos.reduce((acc, f) => acc + f.settled_cents, 0);

  return {
    from,
    to,
    providerCents: totalProvedor,
    financeCents: totalFinanceiro,
    differenceCents: totalProvedor - totalFinanceiro,
    matched: batidos,
    // Maior divergência primeiro: é por onde alguém começa a investigar.
    rows: rows.sort((a, b) => Math.abs(b.differenceCents) - Math.abs(a.differenceCents)),
  };
}
