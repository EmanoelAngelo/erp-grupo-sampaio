/**
 * PIX NO BALCÃO PELO ASAAS (GAP-PRD-077) — gerar o QR, acompanhar, desistir,
 * e a fila do que ficou pendente.
 *
 * ## Como o balcão usa
 *
 *   1. O caixa escolhe PIX e pede o QR: nasce uma cobrança PIX na conta DA
 *      OPERAÇÃO, com origem `sale` ainda sem venda (`pdv-pix:<referência>`), e
 *      o QR + copia-e-cola voltam para a tela.
 *   2. A tela consulta a cada poucos segundos (`consultarPixDoBalcao`, que só
 *      lê) e, no botão "Já pagou?", pergunta ao PROVEDOR (`consultar: true`) —
 *      o webhook não é a única porta.
 *   3. Pago: a linha entra na venda liquidada (`paymentIntentId`). Ainda não
 *      pago e o cliente precisa ir: a linha entra PENDENTE, e o webhook (ou a
 *      passada de sincronização, GAP-PRD-016) a liquida quando o dinheiro cair.
 *   4. Desistiu: a cobrança é cancelada no provedor — QR largado vivo seria
 *      dinheiro entrando sem venda.
 *
 * ## O pagador
 *
 * O provedor pendura toda cobrança num cliente com CPF/CNPJ. Venda de balcão
 * costuma ser anônima: sem cliente no carrinho, a tela pede o CPF de quem paga
 * (o mesmo que o app do banco mostra). Não se inventa pagador — nem o CNPJ da
 * própria loja: quem decide usar "consumidor final" genérico é o dono, e o
 * sistema não toma essa decisão por ele.
 */
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { hojeNaLoja } from './CalendarioOperacional.js';
import { AsaasHttpClient } from '../asaas/AsaasHttpClient.js';
import { resolveAsaasCustomer } from './AsaasCustomerLinkService.js';
import { findOrCreateCustomer } from './CatalogService.js';
import {
  aplicarStatusConsultado,
  carregarExibicaoDaCobranca,
  createPaymentIntent,
  getAsaasCredentials,
  reloadIntent,
  type PaymentIntent,
} from './PaymentService.js';
import { liquidarLinhaPendenteDaVenda, RASCUNHO_DO_BALCAO } from './PdvPixDaVenda.js';
import * as Impressao from '../api/ImpressaoDaRequisicao.js';

export interface PixDoBalcao {
  intentId: string;
  status: string;
  amountCents: number;
  environment: string;
  providerRef: string | null;
  pixPayload: string | null;
  pixImageBase64: string | null;
  /** Até quando o QR vale, como o provedor informou. */
  expiresAt: string | null;
  /** A venda que este PIX fechou, quando já fechou. */
  saleId: string | null;
  lastError: string | null;
}

/** O provedor de cobrança está pronto para gerar QR nesta operação? */
export function statusDoPixDoBalcao(companyId: string): {
  disponivel: boolean;
  ambiente: string | null;
  motivo: string;
} {
  const creds = getAsaasCredentials({ companyId });
  if (!creds) {
    return {
      disponivel: false,
      ambiente: null,
      motivo:
        'Sem credencial do Asaas nesta operação: o PIX é conferido no app do banco e lançado à mão. '
        + 'Configure em Integrações › Asaas para gerar o QR pelo sistema.',
    };
  }
  return {
    disponivel: true,
    ambiente: creds.environment,
    motivo:
      creds.environment === 'sandbox'
        ? 'Asaas em ambiente de TESTES: o QR não cobra ninguém de verdade.'
        : 'Asaas em produção: o QR cobra de verdade.',
  };
}

function doBalcao(companyId: string, intentId: string): PaymentIntent {
  const intent = getConnection()
    .prepare(
      `SELECT * FROM core_payment_intents
        WHERE id = ? AND company_id = ? AND origin_type = 'sale' AND provider = 'asaas'`,
    )
    .get(intentId, companyId) as unknown as PaymentIntent | undefined;
  if (!intent) throw new ApiError('CORE_PIX_BALCAO_NOT_FOUND', 'PIX do balcão não encontrado nesta operação.', 404);
  return intent;
}

function vista(intent: PaymentIntent, extra: Partial<PixDoBalcao> = {}): PixDoBalcao {
  return {
    intentId: intent.id,
    status: intent.status,
    amountCents: intent.amount_cents,
    environment: intent.environment,
    providerRef: intent.provider_ref,
    pixPayload: intent.qr_payload ?? null,
    pixImageBase64: null,
    expiresAt: null,
    saleId: intent.origin_id.startsWith(RASCUNHO_DO_BALCAO) ? null : intent.origin_id,
    lastError: intent.last_error,
    ...extra,
  };
}

/** Gera (ou recupera, pela referência) o QR do PIX do balcão. */
export async function criarPixDoBalcao(input: {
  companyId: string;
  userId?: string | null;
  amountCents: number;
  /** Gerada pela tela a cada QR: repetir o clique devolve o MESMO QR. */
  referencia: string;
  customerId?: string | null;
  pagadorDocumento?: string | null;
  pagadorNome?: string | null;
  fetchImpl?: typeof fetch;
}): Promise<PixDoBalcao> {
  ensureCoreSchema();
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new ApiError('CORE_INVALID_AMOUNT', 'Informe o valor do PIX.', 400);
  }
  const referencia = String(input.referencia ?? '').trim();
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(referencia)) {
    throw new ApiError('CORE_PIX_BALCAO_REFERENCIA', 'Referência do QR inválida.', 400);
  }
  const creds = getAsaasCredentials({ companyId: input.companyId });
  if (!creds) {
    throw new ApiError('CORE_ASAAS_UNCONFIGURED', statusDoPixDoBalcao(input.companyId).motivo, 409);
  }

  const chave = `${RASCUNHO_DO_BALCAO}${referencia}`;
  const jaExiste = getConnection()
    .prepare('SELECT * FROM core_payment_intents WHERE company_id = ? AND idempotency_key = ?')
    .get(input.companyId, chave) as unknown as PaymentIntent | undefined;

  /*
    O MESMO QR É A MESMA REFERÊNCIA COM O MESMO PEDIDO (RES-IDEM-VIZ).

    A referência vem da tela, e a cobrança da referência era devolvida sem
    olhar o valor: a de um QR de R$ 50 reenviada com R$ 80 mostrava o QR de
    R$ 50 como se fosse o novo, e o cliente pagava o valor errado. A recusa é
    ANTES do cadastro do pagador e do provedor; cobrança anterior à impressão
    (nula) segue a regra de sempre.
  */
  const impressao = Impressao.impressaoDe({
    origem: 'pdv-pix',
    valor: input.amountCents,
    cliente: Impressao.texto(input.customerId),
    pagador: String(input.pagadorDocumento ?? '').replace(/\D/g, ''),
  });
  const gravada = (jaExiste as unknown as { idempotency_fingerprint?: string | null } | undefined)
    ?.idempotency_fingerprint;
  if (jaExiste && Impressao.outraImpressao(gravada, impressao)) {
    throw Impressao.chaveReusada('o PIX do balcão desta referência', { intentId: jaExiste.id });
  }

  let asaasCustomerId: string | undefined;
  if (!jaExiste?.provider_ref) {
    // O PAGADOR: o cliente do carrinho, ou quem a tela identificou pelo CPF.
    const db = getConnection();
    let cliente = input.customerId
      ? (db
          .prepare('SELECT id, name, document, email, phone FROM core_customers WHERE id = ? AND company_id = ?')
          .get(input.customerId, input.companyId) as
          | { id: string; name: string; document: string | null; email: string | null; phone: string | null }
          | undefined)
      : undefined;
    const documento = String(input.pagadorDocumento ?? '').replace(/\D/g, '');
    if (!cliente?.document && documento) {
      const criado = findOrCreateCustomer(input.companyId, {
        name: String(input.pagadorNome ?? '').trim() || cliente?.name || 'Cliente do balcão',
        document: documento,
      }) as { id: string; name: string; document: string | null; email: string | null; phone: string | null };
      cliente = criado;
    }
    if (!cliente?.document) {
      throw new ApiError(
        'CORE_PIX_BALCAO_SEM_PAGADOR',
        'O provedor pendura o PIX num pagador com CPF/CNPJ: informe o CPF de quem vai pagar, ou identifique o cliente na venda.',
        400,
      );
    }
    const gateway = new AsaasHttpClient({
      environment: creds.environment,
      companyId: input.companyId,
      fetchImpl: input.fetchImpl,
    });
    const vinculo = await resolveAsaasCustomer({
      companyId: input.companyId,
      environment: creds.environment,
      gateway,
      customer: {
        id: String(cliente.id),
        name: String(cliente.name),
        document: cliente.document,
        email: cliente.email,
        phone: cliente.phone,
      },
    });
    asaasCustomerId = vinculo.asaasCustomerId;
  }

  const loja = getConnection()
    .prepare('SELECT trade_name FROM core_companies WHERE id = ?')
    .get(input.companyId) as { trade_name: string } | undefined;
  const intent = await createPaymentIntent({
    companyId: input.companyId,
    originType: 'sale',
    originId: chave,
    method: 'pix',
    amountCents: input.amountCents,
    idempotencyKey: chave,
    impressao,
    asaasCustomerId,
    description: `PIX no balcão — ${loja?.trade_name ?? 'loja'}`,
    // PIX de balcão vence hoje: o cliente paga agora, na frente do caixa.
    dueDate: hojeNaLoja(),
    fetchImpl: input.fetchImpl,
  });
  if (intent.status === 'failed') {
    throw new ApiError(
      'CORE_PIX_BALCAO_FALHOU',
      `O provedor não gerou o PIX: ${intent.last_error ?? 'sem motivo informado'}. Tente de novo ou receba por outro meio.`,
      502,
    );
  }
  const exibicao = await carregarExibicaoDaCobranca({
    intent,
    companyId: input.companyId,
    environment: intent.environment,
    fetchImpl: input.fetchImpl,
  });
  return vista(reloadIntent(intent.id), {
    pixPayload: exibicao.pixPayload,
    pixImageBase64: exibicao.pixImageBase64,
    expiresAt: exibicao.dueDate,
  });
}

/**
 * A situação do PIX do balcão. Sem `consultar`, só lê o que o ERP sabe (o
 * webhook pode já ter confirmado); com `consultar`, pergunta ao provedor e
 * aplica a resposta pelo mesmo caminho do webhook.
 */
export async function consultarPixDoBalcao(input: {
  companyId: string;
  intentId: string;
  consultar?: boolean;
  fetchImpl?: typeof fetch;
}): Promise<PixDoBalcao> {
  ensureCoreSchema();
  const intent = doBalcao(input.companyId, input.intentId);
  if (input.consultar && intent.provider_ref && (intent.status === 'pending' || intent.status === 'overdue')) {
    const gateway = new AsaasHttpClient({
      environment: intent.environment as 'sandbox' | 'production',
      companyId: input.companyId,
      fetchImpl: input.fetchImpl,
    });
    const remoto = await gateway.getPayment(intent.provider_ref);
    const status = String(remoto.status ?? '');
    const evento =
      status === 'RECEIVED' || status === 'CONFIRMED' || status === 'RECEIVED_IN_CASH'
        ? 'PAYMENT_RECEIVED'
        : status === 'OVERDUE'
          ? 'PAYMENT_OVERDUE'
          : '';
    aplicarStatusConsultado({
      companyId: input.companyId,
      intentId: intent.id,
      evento,
      pagamento: { id: intent.provider_ref, value: remoto.value, billingType: remoto.billingType },
    });
  }
  return vista(reloadIntent(intent.id));
}

/**
 * DESISTIR DO QR: cancela a cobrança no provedor. Só vale para o PIX que
 * ainda não fechou venda e não foi pago — o pago se estorna, não se cancela.
 */
export async function cancelarPixDoBalcao(input: {
  companyId: string;
  intentId: string;
  fetchImpl?: typeof fetch;
}): Promise<PixDoBalcao> {
  ensureCoreSchema();
  const intent = doBalcao(input.companyId, input.intentId);
  if (!intent.origin_id.startsWith(RASCUNHO_DO_BALCAO)) {
    throw new ApiError(
      'CORE_PIX_BALCAO_JA_NA_VENDA',
      'Este PIX já está numa venda: a pendência dele se resolve pela venda, não pela tela de pagamento.',
      409,
    );
  }
  if (intent.status === 'cancelled') return vista(intent);
  if (intent.status !== 'pending' && intent.status !== 'overdue' && intent.status !== 'failed') {
    throw new ApiError(
      'CORE_PIX_BALCAO_NAO_CANCELAVEL',
      `Este PIX está como "${intent.status}": dinheiro que entrou não se cancela — use-o na venda ou estorne.`,
      409,
    );
  }
  if (intent.provider_ref) {
    const gateway = new AsaasHttpClient({
      environment: intent.environment as 'sandbox' | 'production',
      companyId: input.companyId,
      fetchImpl: input.fetchImpl,
    });
    try {
      await gateway.cancelPayment(intent.provider_ref);
    } catch (err) {
      getConnection()
        .prepare('UPDATE core_payment_intents SET last_error = ?, updated_at = ? WHERE id = ?')
        .run(`cancelamento: ${(err as Error).message}`, new Date().toISOString(), intent.id);
      throw new ApiError(
        'CORE_PIX_BALCAO_CANCELAMENTO_FALHOU',
        'O provedor não cancelou o PIX: ele continua pagável. Tente de novo antes de receber por outro meio.',
        502,
      );
    }
  }
  getConnection()
    .prepare("UPDATE core_payment_intents SET status = 'cancelled', updated_at = ? WHERE id = ?")
    .run(new Date().toISOString(), intent.id);
  return vista(reloadIntent(intent.id));
}

export interface PixPendenteDoBalcao {
  saleId: string;
  saleNumber: number;
  paymentId: string;
  amountCents: number;
  createdAt: string;
  /** Há quantos dias a linha espera. */
  ageDays: number;
  /** O PIX passou pelo provedor (tem cobrança) ou foi só declarado pendente. */
  viaProvedor: boolean;
  intentId: string | null;
  intentStatus: string | null;
  providerRef: string | null;
  lastError: string | null;
}

/**
 * A FILA DO QUE FICOU PENDENTE — a tela que faltava para o "pending" deixar de
 * ser beco. Mais antigas primeiro: é por elas que alguém começa a cobrar.
 */
export function listarPixPendentesDoBalcao(companyId: string): PixPendenteDoBalcao[] {
  ensureCoreSchema();
  const linhas = getConnection()
    .prepare(
      `SELECT sp.id AS payment_id, sp.sale_id, s.number AS sale_number, sp.amount_cents, sp.created_at,
              sp.payment_intent_id, i.status AS intent_status, COALESCE(sp.provider_ref, i.provider_ref) AS provider_ref,
              i.last_error
         FROM core_sale_payments sp
         JOIN core_sales s ON s.id = sp.sale_id
         LEFT JOIN core_payment_intents i ON i.id = sp.payment_intent_id
        WHERE sp.company_id = ? AND sp.status = 'pending' AND s.status <> 'cancelled'
        ORDER BY sp.created_at ASC
        LIMIT 500`,
    )
    .all(companyId) as Record<string, unknown>[];
  const agora = Date.now();
  return linhas.map((l) => ({
    saleId: String(l.sale_id),
    saleNumber: Number(l.sale_number),
    paymentId: String(l.payment_id),
    amountCents: Number(l.amount_cents),
    createdAt: String(l.created_at),
    ageDays: Math.max(0, Math.floor((agora - Date.parse(String(l.created_at))) / 86_400_000)),
    viaProvedor: Boolean(l.payment_intent_id),
    intentId: (l.payment_intent_id as string | null) ?? null,
    intentStatus: (l.intent_status as string | null) ?? null,
    providerRef: (l.provider_ref as string | null) ?? null,
    lastError: (l.last_error as string | null) ?? null,
  }));
}

/**
 * RESOLVER UMA LINHA PENDENTE.
 *
 * Com cobrança no provedor, quem responde é o PROVEDOR: pergunta-se a ele, e
 * só a confirmação dele liquida — ninguém "aprova no braço" um PIX que o Asaas
 * diz não ter recebido. Sem cobrança (PIX declarado pendente por integração),
 * a confirmação é de quem conferiu o extrato, com a nota obrigatória e o nome
 * de quem confirmou na baixa.
 */
export async function confirmarPixPendente(input: {
  companyId: string;
  saleId: string;
  paymentId: string;
  userId?: string | null;
  note?: string | null;
  fetchImpl?: typeof fetch;
}): Promise<{ liquidada: boolean; detail: string }> {
  ensureCoreSchema();
  const linha = getConnection()
    .prepare('SELECT * FROM core_sale_payments WHERE id = ? AND sale_id = ? AND company_id = ?')
    .get(input.paymentId, input.saleId, input.companyId) as
    | { id: string; status: string; payment_intent_id: string | null }
    | undefined;
  if (!linha) throw new ApiError('CORE_SALE_PAYMENT_NOT_FOUND', 'Pagamento da venda não encontrado.', 404);
  if (linha.status === 'settled') return { liquidada: false, detail: 'Este pagamento já estava liquidado.' };

  if (linha.payment_intent_id) {
    const depois = await consultarPixDoBalcao({
      companyId: input.companyId,
      intentId: linha.payment_intent_id,
      consultar: true,
      fetchImpl: input.fetchImpl,
    });
    const atual = getConnection()
      .prepare('SELECT status FROM core_sale_payments WHERE id = ?')
      .get(linha.id) as { status: string };
    if (atual.status === 'settled') {
      return { liquidada: true, detail: 'O provedor confirmou o PIX: a venda foi liquidada.' };
    }
    throw new ApiError(
      'CORE_PIX_BALCAO_NAO_PAGO',
      `O Asaas diz que este PIX está "${depois.status}" — não foi pago. Cobre o cliente ou receba por outro meio.`,
      409,
    );
  }

  const nota = String(input.note ?? '').trim();
  if (nota.length < 5) {
    throw new ApiError(
      'CORE_PIX_CONFIRMACAO_SEM_NOTA',
      'Diga como o recebimento foi conferido (ex.: "extrato do banco, 11/09, 14h32") — é o que fica na baixa.',
      400,
    );
  }
  return withTransaction(() =>
    liquidarLinhaPendenteDaVenda({
      companyId: input.companyId,
      saleId: input.saleId,
      paymentId: input.paymentId,
      note: `PIX conferido à mão: ${nota.slice(0, 180)}`,
      userId: input.userId ?? null,
    }),
  );
}

