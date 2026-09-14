/**
 * Cobrança de um pedido online.
 *
 * É a costura que faltava: o pedido existia, a credencial por operação
 * existia, o webhook existia — e ninguém chamava o provedor.
 *
 * TRÊS REGRAS QUE NÃO SE NEGOCIAM
 *
 * 1. GERAR QR NÃO É RECEBER. O pedido continua `aguardando_pagamento` até o
 *    webhook confirmar. Quem marca pago ao mostrar o QR entrega mercadoria de
 *    graça na primeira semana.
 * 2. UMA COBRANÇA POR PEDIDO. A chave de idempotência é derivada do pedido,
 *    então dez cliques no botão pagar não viram dez cobranças no cartão de
 *    ninguém.
 * 3. A CONTA É DA OPERAÇÃO. A credencial vem do cofre da empresa dona do
 *    pedido — nunca de variável de ambiente compartilhada.
 *
 * Sem credencial configurada, isto NÃO estoura: devolve `unconfigured`, e a
 * loja mostra "pagamento online indisponível" com os meios que existirem. O
 * PDV e o financeiro seguem funcionando sem o Asaas.
 */
import { randomUUID } from 'node:crypto';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { hojeNaLoja, somarDias } from './CalendarioOperacional.js';
import { prazoDaReservaDoPedido } from './PrazoDaReserva.js';
import { ApiError } from '../../utils/errors.js';
import { AsaasHttpClient } from '../asaas/AsaasHttpClient.js';
import {
  adotarCobrancaDoProvedor,
  carregarExibicaoDaCobranca,
  getAsaasCredentials,
  type PaymentIntent,
} from './PaymentService.js';
import {
  cancelarCobrancasOrfas,
  falhaDeResultadoIncerto,
  motivoDeResultadoIncerto,
  procurarCobrancaJaCriada,
  tentouNoProvedor,
} from './AsaasCobrancaOrfa.js';
import { resolveAsaasCustomer } from './AsaasCustomerLinkService.js';
import { addOrderEvent, markOrderRefunded } from './StorefrontService.js';
import { descreverParcelas, divisaoDasParcelas } from './ParcelamentoNoCartao.js';
import { contrapartidaDoPedido } from './OrderRefundLedger.js';
import { receberMercadoriaDevolvida } from './OrderReturnService.js';

/** Métodos que o caminho vivo sabe cobrar hoje. */
export type OnlineMethod = 'pix' | 'boleto' | 'cartao';

/*
  CARTÃO ONLINE (rodada 42), e a decisão combinada com o dono: SEM salvar
  cartão. A arquitetura entrega mais: o número do cartão NUNCA passa pelo ERP.
  A cobrança nasce como CREDIT_CARD no provedor e o cliente digita o cartão na
  PÁGINA DO PROVEDOR (invoiceUrl) — recusa, retry e antifraude são de lá.
  Aqui não existe campo de cartão para salvar, vazar ou entrar em escopo PCI.
  O webhook confirma, com conferência de VALOR (PaymentService).
*/
export interface OrderCharge {
  intent: PaymentIntent;
  /** Copia-e-cola do PIX. Só existe depois que o provedor devolve. */
  pixPayload: string | null;
  pixImageBase64: string | null;
  /** Boleto: linha digitável e página da fatura. */
  bankSlipUrl: string | null;
  identificationField: string | null;
  dueDate: string | null;
  /** `unconfigured` quando a operação ainda não tem credencial. */
  status: string;
  environment: string;
  /**
   * Até quando os itens ficam reservados para este pedido (instante ISO).
   * A mesma conta que a rotina de expiração usa (`PrazoDaReserva`): no
   * boleto, o fim do segundo dia útil depois do último dia de pagamento; no
   * PIX e no cartão, 25 horas. A tela diz isso ao cliente (GAP-PRD-029).
   */
  reservedUntil: string;
}

interface OrderRow {
  id: string;
  company_id: string;
  number: number;
  customer_id: string | null;
  customer_name: string;
  customer_email: string | null;
  customer_document: string | null;
  total_cents: number;
  status: string;
}

function loadOrder(companyId: string, orderId: string): OrderRow {
  const row = getConnection()
    .prepare('SELECT * FROM core_orders WHERE id = ? AND company_id = ?')
    .get(orderId, companyId) as unknown as OrderRow | undefined;
  if (!row) throw new ApiError('CORE_ORDER_NOT_FOUND', 'Pedido não encontrado.', 404);
  return row;
}

function existingIntent(companyId: string, chave: string): PaymentIntent | undefined {
  return getConnection()
    .prepare('SELECT * FROM core_payment_intents WHERE company_id = ? AND idempotency_key = ?')
    .get(companyId, chave) as unknown as PaymentIntent | undefined;
}

function reload(intentId: string): PaymentIntent {
  return getConnection()
    .prepare('SELECT * FROM core_payment_intents WHERE id = ?')
    .get(intentId) as unknown as PaymentIntent;
}

/**
 * Cria (ou recupera) a cobrança do pedido.
 *
 * `fetchImpl` existe para o teste poder exercitar o caminho inteiro sem rede.
 * NÃO é um provedor de mentira embutido: sem ele, o cliente HTTP real é usado.
 */
export async function createOrderCharge(input: {
  companyId: string;
  orderId: string;
  method: OnlineMethod;
  /**
   * Parcelas no cartão (GAP-PRD-114), já conferidas pelo checkout. Só vale no
   * cartão; a intenção que já existe guarda o plano com que nasceu, e é ele
   * que vale na retentativa.
   */
  installments?: number | null;
  fetchImpl?: typeof fetch;
}): Promise<OrderCharge> {
  ensureCoreSchema();
  const order = loadOrder(input.companyId, input.orderId);

  if (order.status !== 'aguardando_pagamento') {
    throw new ApiError(
      'CORE_ORDER_NOT_CHARGEABLE',
      `Pedido está como "${order.status}" e não aceita nova cobrança.`,
      409,
    );
  }

  // Uma cobrança por pedido e método. Reenviar devolve a mesma.
  const chave = `ecommerce_order:${order.id}:${input.method}`;
  const jaExiste = existingIntent(input.companyId, chave);

  const creds = getAsaasCredentials({ companyId: input.companyId });
  if (!creds) {
    const intent = jaExiste ?? criarIntencao({ order, method: input.method, chave, status: 'unconfigured', environment: 'sandbox' });
    return {
      intent,
      pixPayload: null,
      pixImageBase64: null,
      bankSlipUrl: null,
      identificationField: null,
      dueDate: null,
      status: 'unconfigured',
      environment: 'sandbox',
      reservedUntil: prazoDaReservaDoPedido(input.companyId, input.orderId).ate,
    };
  }

  if (jaExiste?.provider_ref) {
    // Já cobrado: relê os dados de exibição em vez de criar outra cobrança.
    return montarRetorno(jaExiste, creds.environment, input.fetchImpl, input.companyId);
  }

  const intent =
    jaExiste
    ?? criarIntencao({
      order,
      method: input.method,
      chave,
      status: 'pending',
      environment: creds.environment,
      installments: input.method === 'cartao' ? input.installments ?? null : null,
    });
  const parcelas = Number(intent.installment_count ?? 1) > 1 ? Number(intent.installment_count) : 1;

  const cliente = new AsaasHttpClient({
    environment: creds.environment,
    companyId: input.companyId,
    fetchImpl: input.fetchImpl,
  });

  const registrarFalha = (motivo: string) =>
    getConnection()
      .prepare(
        `UPDATE core_payment_intents
            SET status = 'failed', last_error = ?, attempts = attempts + 1, updated_at = ?
          WHERE id = ?`,
      )
      .run(motivo, new Date().toISOString(), intent.id);

  /*
    A INTENÇÃO JÁ EXISTIA E NÃO TEM REFERÊNCIA: PERGUNTA ANTES DE CRIAR
    (GAP-PRD-049).

    É o segundo clique depois de um timeout — ou a retentativa da tela. A
    tentativa anterior pode ter criado a cobrança lá e perdido a resposta;
    criar outra daria ao comprador dois PIX para o mesmo pedido. Procura pela
    referência externa (o id do pedido) e ADOTA; se a consulta falhar, não
    cria — sem prova de ausência, a segunda cobrança é um chute.
  */
  if (jaExiste && (jaExiste.status !== 'unconfigured' || tentouNoProvedor(jaExiste))) {
    let achado: Awaited<ReturnType<typeof procurarCobrancaJaCriada>>;
    try {
      const divisao = divisaoDasParcelas(jaExiste.amount_cents, parcelas);
      achado = await procurarCobrancaJaCriada({
        gateway: cliente,
        originId: order.id,
        method: input.method,
        // No plano de parcelas, o que o provedor guarda com a referência é a
        // PRIMEIRA parcela — a que leva a sobra de centavos.
        amountCents: parcelas > 1 ? divisao.base + divisao.sobra : jaExiste.amount_cents,
      });
    } catch (err) {
      registrarFalha((err as Error).message);
      throw err;
    }
    if (achado.adotar) {
      const adotada = adotarCobrancaDoProvedor(jaExiste.id, achado.adotar, achado.sobrando);
      // A cobrança adotada pode já ter sido PAGA lá — e aí o pedido virou
      // `pago` na adoção. O registro leva a situação de agora, não a de antes.
      const situacao = (
        getConnection().prepare('SELECT status FROM core_orders WHERE id = ?').get(order.id) as
          | { status: string }
          | undefined
      )?.status ?? 'aguardando_pagamento';
      addOrderEvent(
        order.id,
        input.companyId,
        situacao,
        `Cobrança ${input.method.toUpperCase()} que já existia no provedor foi vinculada ao pedido `
          + `(${creds.environment}) — nenhuma cobrança nova foi criada.`,
      );
      return montarRetorno(adotada, creds.environment, input.fetchImpl, input.companyId);
    }
  }

  // O provedor precisa de um cliente para pendurar a cobrança. O vínculo é
  // reaproveitado — não se cria um cliente novo lá a cada compra.
  if (!order.customer_id) {
    throw new ApiError(
      'CORE_ORDER_WITHOUT_CUSTOMER',
      'Pedido sem cliente vinculado; não é possível cobrar.',
      409,
    );
  }
  const vinculo = await resolveAsaasCustomer({
    companyId: input.companyId,
    environment: creds.environment,
    gateway: cliente,
    customer: {
      id: order.customer_id,
      name: order.customer_name,
      document: order.customer_document,
      email: order.customer_email,
    },
  });

  const vencimento = somarDias(hojeNaLoja(), 1);
  let cobranca: Record<string, unknown>;
  try {
    /*
      PARCELADO NO CARTÃO (GAP-PRD-114): `installmentCount` + `totalValue`.
      Antes a cobrança ia sempre com `value` — à vista — mesmo com o selo
      "Parcele em até 6x" na vitrine. O total vai inteiro e o provedor divide
      (a sobra de centavos numa parcela); a conferência do webhook aceita
      exatamente essa divisão.
    */
    cobranca = await cliente.createPayment({
      customer: vinculo.asaasCustomerId,
      billingType:
        input.method === 'pix' ? 'PIX' : input.method === 'boleto' ? 'BOLETO' : 'CREDIT_CARD',
      ...(parcelas > 1
        ? { installmentCount: parcelas, totalValue: order.total_cents / 100 }
        : { value: order.total_cents / 100 }),
      dueDate: vencimento,
      description: `Pedido online #${order.number}`,
      externalReference: order.id,
    });
  } catch (err) {
    /*
      A FALHA FICA REGISTRADA (GAP-PRD-049). Antes o erro subia e a intenção
      ficava `pending` sem referência — nem a tela de cobranças dizia que algo
      falhou, nem a retentativa a reconhecia. Agora é `failed`, com o motivo, e
      quando o desfecho é incerto a frase diz que a cobrança pode existir lá.
    */
    const motivo = err instanceof ApiError ? err.message : `network:${(err as Error).name}`;
    registrarFalha(falhaDeResultadoIncerto(err) ? motivoDeResultadoIncerto(motivo) : motivo);
    throw err;
  }

  const remoto = String(cobranca.id ?? '');
  if (!remoto) {
    getConnection()
      .prepare(
        "UPDATE core_payment_intents SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?",
      )
      .run('provedor não devolveu id da cobrança', new Date().toISOString(), intent.id);
    throw new ApiError('CORE_CHARGE_FAILED', 'O provedor não devolveu a cobrança.', 502);
  }

  getConnection()
    .prepare(
      `UPDATE core_payment_intents
          SET provider_ref = ?, invoice_url = ?, status = 'pending',
              provider_installment_ref = COALESCE(?, provider_installment_ref),
              attempts = attempts + 1, updated_at = ?, due_date = ?
        WHERE id = ?`,
    )
    // O vencimento fica guardado: é por ele que a reserva do boleto vive até
    // o banco poder confirmar (GAP-PRD-029). A ordem segue a do SQL:
    // referência, link, plano de parcelas, hora, vencimento, id.
    .run(
      remoto,
      String(cobranca.invoiceUrl ?? ''),
      cobranca.installment ? String(cobranca.installment) : null,
      new Date().toISOString(),
      vencimento,
      intent.id,
    );

  addOrderEvent(
    order.id,
    input.companyId,
    'aguardando_pagamento',
    `Cobrança ${input.method.toUpperCase()} criada no provedor (${creds.environment})`
      + (parcelas > 1 ? ` em ${descreverParcelas(order.total_cents, parcelas)}.` : '.'),
  );

  return montarRetorno(reload(intent.id), creds.environment, input.fetchImpl, input.companyId, cobranca);
}

function criarIntencao(input: {
  order: OrderRow;
  method: OnlineMethod;
  chave: string;
  status: string;
  environment: string;
  installments?: number | null;
}): PaymentIntent {
  const db = getConnection();
  const id = randomUUID();
  const agora = new Date().toISOString();
  const parcelas = input.installments && input.installments > 1 ? input.installments : null;
  db.prepare(
    `INSERT INTO core_payment_intents
       (id, company_id, provider, environment, origin_type, origin_id, method,
        amount_cents, status, idempotency_key, created_at, updated_at, installment_count)
     VALUES (?, ?, 'asaas', ?, 'ecommerce_order', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.order.company_id,
    input.environment,
    input.order.id,
    input.method,
    input.order.total_cents,
    input.status,
    input.chave,
    agora,
    agora,
    parcelas,
  );
  return reload(id);
}

/**
 * Dados de exibição da cobrança.
 *
 * O CORPO DESTA FUNÇÃO MUDOU DE CASA (GAP-V70), e o motivo é que ela ganhou um
 * segundo consumidor: o título do contas a receber mostra exatamente o mesmo
 * copia-e-cola, a mesma linha digitável e o mesmo link de fatura que o pedido
 * online. Duas cópias divergiriam no primeiro ajuste — e a segunda seria a que
 * ninguém testou. A regra (falha ao buscar QR NÃO derruba nada; copia-e-cola
 * guardado não é buscado de novo) continua a mesma, agora em
 * `carregarExibicaoDaCobranca`.
 */
async function montarRetorno(
  intent: PaymentIntent,
  environment: string,
  fetchImpl: typeof fetch | undefined,
  companyId: string,
  cobrancaCriada?: Record<string, unknown>,
): Promise<OrderCharge> {
  const exibicao = await carregarExibicaoDaCobranca({
    intent,
    companyId,
    environment,
    fetchImpl,
    cobrancaCriada,
  });
  return {
    ...exibicao,
    // Na releitura o provedor não manda o vencimento de novo: vale o que foi
    // guardado na criação (GAP-PRD-029).
    dueDate: exibicao.dueDate ?? intent.due_date ?? null,
    intent,
    status: intent.status,
    environment,
    reservedUntil: prazoDaReservaDoPedido(companyId, intent.origin_id).ate,
  };
}

/**
 * Cancela a cobrança no provedor.
 *
 * Chamado quando o pedido é cancelado antes de pagar. Falha do provedor NÃO
 * impede o cancelamento do pedido: a alternativa seria manter reservado um
 * estoque que ninguém vai comprar. O erro fica registrado na intenção.
 */
export async function cancelOrderCharges(input: {
  companyId: string;
  orderId: string;
  fetchImpl?: typeof fetch;
}): Promise<{ cancelled: number; failed: number }> {
  ensureCoreSchema();
  const db = getConnection();
  const intents = db
    .prepare(
      `SELECT * FROM core_payment_intents
        WHERE company_id = ? AND origin_type = 'ecommerce_order' AND origin_id = ?
          AND status IN ('pending', 'overdue', 'failed')`,
    )
    .all(input.companyId, input.orderId) as unknown as PaymentIntent[];

  let cancelled = 0;
  let failed = 0;

  for (const intent of intents) {
    const agora = new Date().toISOString();
    if (!intent.provider_ref) {
      /*
        SEM REFERÊNCIA NÃO QUER DIZER SEM COBRANÇA (GAP-PRD-049). A criação
        que foi ao provedor e voltou sem resposta pode ter deixado a cobrança
        viva lá — e o comprador, com o PIX na mão, pagaria um pedido
        cancelado. Procura pela referência externa e cancela lá também. Se a
        consulta falhar, o erro fica na intenção e ela NÃO é dada como
        cancelada: o pedido se cancela do mesmo jeito (a regra desta função).
      */
      let referencia: string | null = null;
      if (tentouNoProvedor(intent)) {
        try {
          referencia = await cancelarCobrancasOrfas({
            gateway: new AsaasHttpClient({
              environment: intent.environment as 'sandbox' | 'production',
              companyId: input.companyId,
              fetchImpl: input.fetchImpl,
            }),
            originId: intent.origin_id,
            method: intent.method,
            amountCents: intent.amount_cents,
          });
        } catch (err) {
          db.prepare(
            'UPDATE core_payment_intents SET last_error = ?, updated_at = ? WHERE id = ?',
          ).run(`cancelamento: ${(err as Error).message}`, agora, intent.id);
          failed += 1;
          continue;
        }
      }
      db.prepare(
        `UPDATE core_payment_intents
            SET status = 'cancelled', provider_ref = COALESCE(provider_ref, ?), updated_at = ?
          WHERE id = ?`,
      ).run(referencia, agora, intent.id);
      cancelled += 1;
      continue;
    }
    try {
      const cliente = new AsaasHttpClient({
        environment: intent.environment as 'sandbox' | 'production',
        companyId: input.companyId,
        fetchImpl: input.fetchImpl,
      });
      // Plano de parcelas: derruba o PLANO, não só a primeira parcela (GAP-PRD-114).
      if (intent.provider_installment_ref) await cliente.cancelInstallment(intent.provider_installment_ref);
      else await cliente.cancelPayment(intent.provider_ref);
      db.prepare(
        "UPDATE core_payment_intents SET status = 'cancelled', updated_at = ? WHERE id = ?",
      ).run(agora, intent.id);
      cancelled += 1;
    } catch (err) {
      db.prepare(
        'UPDATE core_payment_intents SET last_error = ?, updated_at = ? WHERE id = ?',
      ).run(`cancelamento: ${(err as Error).message}`, agora, intent.id);
      failed += 1;
    }
  }

  return { cancelled, failed };
}

// ------------------------------------------------------ devolução (rodada 42)

/**
 * Etapas em que a mercadoria NUNCA saiu da loja: devolver o pedido nelas é,
 * por definição, ter a mercadoria na mão.
 */
const MERCADORIA_NA_LOJA = new Set([
  'pago',
  'separacao',
  'conferencia',
  'embalado',
  'pronto_para_retirada',
]);

export interface ResultadoDaDevolucao {
  status: string;
  providerRefund: 'done' | 'failed' | 'not_applicable';
  /**
   * O dinheiro: `devolvido_pelo_provedor` (saída quitada), `a_devolver` (conta
   * a pagar ao cliente, em Contas) ou `sem_receita` (o pedido não lançou
   * receita, não há o que contrapor).
   */
  dinheiro: 'devolvido_pelo_provedor' | 'a_devolver' | 'sem_receita';
  /** A mercadoria: `recebida` (voltou ao estoque), `aguardando` conferência. */
  mercadoria: 'recebida' | 'aguardando' | 'nao_se_aplica';
  /** O que o fiscal precisa fazer, quando o pedido tem NF-e autorizada. */
  pendenciaFiscal: string | null;
}

/** A NF-e autorizada do pedido, dita como pendência — ou nulo. */
function pendenciaFiscalDoPedido(companyId: string, orderId: string): string | null {
  const nota = getConnection()
    .prepare(
      `SELECT number FROM core_fiscal_documents
        WHERE company_id = ? AND order_id = ? AND model = '55' AND status = 'AUTHORIZED'
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(companyId, orderId) as { number: number } | undefined;
  return nota
    ? `A NF-e nº ${nota.number} deste pedido está autorizada: a nota de devolução ou o `
      + 'cancelamento dela é feito em Fiscal → Documentos.'
    : null;
}

/** Como o pedido ficou — lido do banco, e não do que se pretendia fazer. */
function situacaoDaDevolucao(
  companyId: string,
  orderId: string,
  providerRefund: ResultadoDaDevolucao['providerRefund'],
  pendenciaFiscal: string | null,
): ResultadoDaDevolucao {
  const pedido = getConnection()
    .prepare('SELECT status, return_goods_status FROM core_orders WHERE id = ? AND company_id = ?')
    .get(orderId, companyId) as { status: string; return_goods_status: string | null };
  const saida = contrapartidaDoPedido(companyId, orderId);
  return {
    status: pedido.status,
    providerRefund,
    dinheiro: !saida
      ? 'sem_receita'
      : Number(saida.settled_cents) >= Number(saida.amount_cents)
        ? 'devolvido_pelo_provedor'
        : 'a_devolver',
    mercadoria:
      pedido.return_goods_status === 'recebida' || pedido.return_goods_status === 'aguardando'
        ? pedido.return_goods_status
        : 'nao_se_aplica',
    pendenciaFiscal,
  };
}

/**
 * Devolve um pedido PAGO: estorno no provedor, contrapartida financeira,
 * pedido reembolsado — e a mercadoria de volta ao estoque SÓ se estiver na mão.
 *
 * A auditoria mediu dois buracos nesta função. O primeiro (GAP-PRD-122): ela
 * devolvia o estoque de todo pedido devolvível, inclusive o `expedido` e o
 * `entregue` — saldo vendável com o pacote ainda na transportadora, contra o
 * contrato escrito em `markOrderRefunded`. O segundo (GAP-PRD-031): nenhum
 * lançamento — a receita devolvida continuava liquidada no DRE.
 *
 * AS PARTES, e a ordem importa:
 *
 *   1. ESTORNO NO PROVEDOR — tentado quando há cobrança confirmada e
 *      credencial. Falha ou ausência NÃO aborta a devolução: a contrapartida
 *      nasce EM ABERTO (conta a pagar ao cliente) e o fato fica no pedido.
 *      Chamada externa não cabe numa transação local; ela vem antes.
 *   2. NUMA TRANSAÇÃO SÓ: o pedido vira `reembolsado` com a contrapartida
 *      (`markOrderRefunded`) e, se `mercadoriaNaMao`, o recebimento conferido
 *      devolve os itens ao estoque (`receberMercadoriaDevolvida`). Sem a
 *      mercadoria na mão, ela fica "a conferir" e o estoque não se mexe.
 *
 * `mercadoriaNaMao` omitido vale SIM para as etapas em que a mercadoria nunca
 * saiu da loja, e NÃO para `expedido` e `entregue` — quem está no balcão com o
 * pacote devolvido diz `true`.
 */
export async function refundOrder(input: {
  companyId: string;
  orderId: string;
  reason: string;
  userId?: string | null;
  fetchImpl?: typeof fetch;
  mercadoriaNaMao?: boolean;
}): Promise<ResultadoDaDevolucao> {
  ensureCoreSchema();
  const db = getConnection();
  const order = db
    .prepare('SELECT * FROM core_orders WHERE id = ? AND company_id = ?')
    .get(input.orderId, input.companyId) as unknown as (OrderRow & { status: string }) | undefined;
  if (!order) throw new ApiError('CORE_ORDER_NOT_FOUND', 'Pedido não encontrado.', 404);

  // Devolução é para pedido que JÁ TEVE dinheiro. Antes do pagamento, o
  // caminho é cancelar — que solta a reserva sem falar de estorno.
  const DEVOLVIVEIS = new Set([
    'pago',
    'separacao',
    'conferencia',
    'embalado',
    'expedido',
    'pronto_para_retirada',
    'entregue',
  ]);
  if (order.status === 'reembolsado') {
    // Repetir não é erro nem efeito novo: devolve como o pedido está.
    return situacaoDaDevolucao(
      input.companyId,
      input.orderId,
      'not_applicable',
      pendenciaFiscalDoPedido(input.companyId, input.orderId),
    );
  }
  if (!DEVOLVIVEIS.has(order.status)) {
    throw new ApiError(
      'CORE_ORDER_NOT_REFUNDABLE',
      `Pedido está como "${order.status}". Antes do pagamento, use o cancelamento.`,
      409,
    );
  }

  // 1) Estorno no provedor — melhor esforço, nunca bloqueante.
  let providerRefund: 'done' | 'failed' | 'not_applicable' = 'not_applicable';
  const intent = db
    .prepare(
      `SELECT * FROM core_payment_intents
        WHERE company_id = ? AND origin_type = 'ecommerce_order' AND origin_id = ?
          AND provider_ref IS NOT NULL AND status IN ('confirmed', 'received')
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(input.companyId, input.orderId) as unknown as PaymentIntent | undefined;
  const creds = intent ? getAsaasCredentials({ companyId: input.companyId }) : null;
  if (intent?.provider_ref && creds) {
    try {
      const cliente = new AsaasHttpClient({
        environment: creds.environment,
        companyId: input.companyId,
        fetchImpl: input.fetchImpl,
      });
      // Plano de parcelas: estorna o PLANO inteiro (GAP-PRD-114). Estornar só a
      // primeira cobrança devolveria uma parcela e deixaria as outras no cartão.
      if (intent.provider_installment_ref) await cliente.refundInstallment(intent.provider_installment_ref);
      else await cliente.refundPayment(intent.provider_ref);
      providerRefund = 'done';
      addOrderEvent(
        input.orderId,
        input.companyId,
        order.status,
        `Estorno solicitado ao provedor (cobrança ${intent.provider_ref}).`,
        input.userId ?? undefined,
      );
    } catch (err) {
      providerRefund = 'failed';
      addOrderEvent(
        input.orderId,
        input.companyId,
        order.status,
        `ESTORNO NO PROVEDOR FALHOU (${(err as Error).message}). `
          + 'O reembolso ao cliente precisa ser feito manualmente.',
        input.userId ?? undefined,
      );
    }
  } else {
    addOrderEvent(
      input.orderId,
      input.companyId,
      order.status,
      'Sem cobrança confirmada no provedor: o reembolso ao cliente é manual.',
      input.userId ?? undefined,
    );
  }

  // 2) Dinheiro, mercadoria e pedido — juntos ou nada.
  const naMao = input.mercadoriaNaMao ?? MERCADORIA_NA_LOJA.has(order.status);
  const pendenciaFiscal = pendenciaFiscalDoPedido(input.companyId, input.orderId);
  withTransaction(() => {
    markOrderRefunded({
      companyId: input.companyId,
      orderId: input.orderId,
      reason: `devolvido (${input.reason || 'sem motivo informado'})`,
      providerRef: intent?.provider_ref ?? undefined,
      userId: input.userId ?? null,
      dinheiro: providerRefund === 'done' ? 'devolvido_pelo_provedor' : 'a_devolver',
      metodo: intent?.method ?? null,
      // O e-mail ao cliente só promete estorno quando o provedor o aceitou (GAP-PRD-037).
      comoOValorVolta: providerRefund === 'done' ? 'estorno_solicitado' : 'devolucao_pela_loja',
    });
    const agora = db
      .prepare('SELECT return_goods_status FROM core_orders WHERE id = ?')
      .get(input.orderId) as { return_goods_status: string | null };
    if (naMao && agora.return_goods_status === 'aguardando') {
      receberMercadoriaDevolvida({
        companyId: input.companyId,
        orderId: input.orderId,
        userId: input.userId ?? null,
        nota: 'Conferida no ato da devolução.',
      });
    }
    if (pendenciaFiscal) {
      addOrderEvent(input.orderId, input.companyId, 'reembolsado', pendenciaFiscal, input.userId ?? undefined);
    }
  });

  return situacaoDaDevolucao(input.companyId, input.orderId, providerRefund, pendenciaFiscal);
}
