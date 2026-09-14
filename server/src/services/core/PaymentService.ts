/**
 * Intenções de pagamento (PIX/boleto) e confirmação por webhook.
 *
 * Regra central: o pedido só vira PAGO por confirmação vinda do provedor ou
 * por baixa manual autorizada. O frontend do comprador nunca declara
 * pagamento — ele apenas exibe o QR e consulta o status.
 *
 * Sem credencial configurada o provedor entra em modo `unconfigured`: a
 * intenção é criada e fica registrada, mas NÃO se inventa QR nem se finge
 * aprovação. É o estado READY_FOR_CREDENTIAL.
 */
import { randomUUID } from 'node:crypto';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { hojeNaLoja, somarDias } from './CalendarioOperacional.js';
import { ApiError } from '../../utils/errors.js';
import { loadEnv } from '../../config/env.js';
import {
  addOrderEvent,
  markOrderPaid,
  markOrderRefunded,
  registerPaymentAfterCancel,
} from './StorefrontService.js';
import {
  asaasEnvFallbackAllowed,
  existeTokenDeWebhookCadastrado,
  findCompanyByAsaasWebhookToken,
  getAsaasApiKey,
  getAsaasCredentialStatus,
  getAsaasWebhookToken,
  temTokenDeWebhookProprio,
} from '../integrations/AsaasCredentialService.js';
import { resolveAsaasEnvironment } from '../integrations/AsaasIntegrationStateService.js';
import { AsaasHttpClient } from '../asaas/AsaasHttpClient.js';
import { secretProvider } from '../../secrets/SecretProvider.js';
import { settleEntry } from './FinanceService.js';
import {
  avisoDasSobrando,
  falhaDeResultadoIncerto,
  motivoDeResultadoIncerto,
  procurarCobrancaJaCriada,
  STATUS_PAGOS_NO_PROVEDOR,
  type CobrancaNoProvedor,
} from './AsaasCobrancaOrfa.js';
import { parcelaCoerente } from './ParcelamentoNoCartao.js';
import { aplicarConfirmacaoNoBalcao } from './PdvPixDaVenda.js';
import { chaveReusada, outraImpressao } from '../api/ImpressaoDaRequisicao.js';

export type PaymentProvider = 'asaas' | 'manual';

/**
 * De onde veio a cobrança.
 *
 * `finance_entry` é o que faltava (GAP-V70): o título do contas a receber —
 * aluguel, OS da oficina, venda a prazo — cobrado por PIX, boleto ou link. Até
 * aqui a única origem VIVA era o pedido online, e `createPaymentIntent` estava
 * escrito sem um único chamador.
 */
export type PaymentOriginType = 'ecommerce_order' | 'sale' | 'service_order' | 'finance_entry';

/** Meios que o caminho vivo sabe cobrar. `manual` não vai ao provedor. */
export type PaymentMethodKind = 'pix' | 'boleto' | 'cartao' | 'manual';

export interface PaymentIntent {
  id: string;
  company_id: string;
  provider: string;
  environment: string;
  origin_type: string;
  origin_id: string;
  method: string;
  amount_cents: number;
  status: string;
  provider_ref: string | null;
  qr_payload: string | null;
  invoice_url: string | null;
  last_error: string | null;
  /** Idas ao provedor para criar esta cobrança (GAP-V76/GAP-PRD-049). */
  attempts?: number;
  created_at: string;
  /** Cartão parcelado (GAP-PRD-114): em quantas vezes. Nulo à vista. */
  installment_count?: number | null;
  /** Id do PLANO de parcelas no provedor — o `installment` de cada parcela. */
  provider_installment_ref?: string | null;
  /** Vencimento enviado ao provedor (GAP-PRD-029); nulo nas linhas antigas. */
  due_date?: string | null;
}

export interface AsaasCredentials {
  apiKey: string;
  baseUrl: string;
  environment: 'sandbox' | 'production';
  /** De onde veio a chave. `env` é fallback de desenvolvimento. */
  source: 'vault' | 'env';
}

export interface AsaasScope {
  companyId: string;
  storeId?: string;
  operationalUnitId?: string;
}

/**
 * Credencial do Asaas DA OPERAÇÃO.
 *
 * Antes esta função lia a chave do ambiente e pronto — uma chave só para as
 * seis operações. Quer dizer: o Pix do cliente da Gringa caía na conta do
 * Preço Justo, e a conciliação de duas empresas virava a mesma pilha. Cada
 * operação tem CNPJ próprio; a conta que recebe tem de ser a dela.
 *
 * A chave vem do cofre por empresa (e por unidade, quando houver). O fallback
 * de ambiente continua existindo para desenvolvimento e é recusado em
 * produção pelo próprio `AsaasCredentialService`.
 *
 * Retorna null quando não há chave: aí o módulo declara `unconfigured` em vez
 * de simular.
 */
export function getAsaasCredentials(scope: AsaasScope): AsaasCredentials | null {
  const env = loadEnv();
  const detalhe = { storeId: scope.storeId, operationalUnitId: scope.operationalUnitId };

  const chaveProducao = getAsaasApiKey(scope.companyId, 'production', detalhe);
  const { environment } = resolveAsaasEnvironment(scope, {
    productionCredentialConfigured: Boolean(chaveProducao),
    productionAllowedByProcess: env.asaasProductionEnabled,
  });

  const apiKey =
    environment === 'production' ? chaveProducao : getAsaasApiKey(scope.companyId, 'sandbox', detalhe);
  if (!apiKey) return null;

  const doCofre = getAsaasCredentialStatus(scope.companyId, detalhe);
  const origem = environment === 'production' ? doCofre.production.source : doCofre.sandbox.source;

  return {
    apiKey,
    baseUrl: environment === 'production' ? env.ASAAS_PRODUCTION_BASE_URL : env.ASAAS_BASE_URL,
    environment,
    source: origem === 'vault' ? 'vault' : 'env',
  };
}

export interface ProviderStatus {
  provider: string;
  configured: boolean;
  environment: string;
  /** Estado honesto para o relatório de prontidão. */
  readiness: 'READY_FOR_CREDENTIAL' | 'READY_FOR_SANDBOX_TEST' | 'PRODUCTION_ENABLED';
  /** O que ainda impede esta operação de cobrar em produção. */
  productionBlockedBy: string[];
}

export function getAsaasStatus(scope: AsaasScope): ProviderStatus {
  const env = loadEnv();
  const creds = getAsaasCredentials(scope);
  const detalhe = { storeId: scope.storeId, operationalUnitId: scope.operationalUnitId };
  const { blockedBy } = resolveAsaasEnvironment(scope, {
    productionCredentialConfigured: Boolean(
      getAsaasApiKey(scope.companyId, 'production', detalhe),
    ),
    productionAllowedByProcess: env.asaasProductionEnabled,
  });

  if (!creds) {
    return {
      provider: 'asaas',
      configured: false,
      environment: 'sandbox',
      readiness: 'READY_FOR_CREDENTIAL',
      productionBlockedBy: blockedBy,
    };
  }
  return {
    provider: 'asaas',
    configured: true,
    environment: creds.environment,
    readiness:
      creds.environment === 'production' ? 'PRODUCTION_ENABLED' : 'READY_FOR_SANDBOX_TEST',
    productionBlockedBy: blockedBy,
  };
}

/** Testa a credencial contra o provedor. Só funciona com chave real. */
export async function testAsaasConnection(
  scope: AsaasScope,
): Promise<{ ok: boolean; detail: string }> {
  const creds = getAsaasCredentials(scope);
  if (!creds) {
    return { ok: false, detail: 'Nenhuma API key configurada para esta operação.' };
  }
  return perguntarMinhaConta(creds.baseUrl, creds.apiKey, creds.environment);
}

/**
 * TESTA A CHAVE DE UM AMBIENTE — o que o ambiente efetivo escondia
 * (GAP-PRD-170).
 *
 * `testAsaasConnection` testa o ambiente EFETIVO: enquanto a porta de
 * produção está fechada, isso é o sandbox. O selo "conexão testada" era
 * satisfeito sem tocar na chave de produção, e a primeira cobrança real virava
 * o primeiro teste dela. Aqui se diz QUAL chave testar, e a de produção vai a
 * `api.asaas.com` (GET /myAccount: leitura, nenhuma cobrança) antes de valer.
 *
 * `tested: false` quando não houve chamada — sem chave, ou produção desligada
 * no processo (`ASAAS_PRODUCTION_ENABLED`, a mesma bandeira que impede um
 * ambiente de desenvolvimento de falar com a produção). Não testado não é
 * "falhou": a tela diz o que falta.
 */
export async function testAsaasCredential(
  scope: AsaasScope,
  environment: 'sandbox' | 'production',
): Promise<{ environment: 'sandbox' | 'production'; tested: boolean; ok: boolean; detail: string }> {
  const env = loadEnv();
  const detalhe = { storeId: scope.storeId, operationalUnitId: scope.operationalUnitId };
  const apiKey = getAsaasApiKey(scope.companyId, environment, detalhe);
  const nome = environment === 'production' ? 'produção' : 'sandbox';
  if (!apiKey) {
    return {
      environment,
      tested: false,
      ok: false,
      detail: `Nenhuma API key de ${nome} configurada para esta operação.`,
    };
  }
  if (environment === 'production' && !env.asaasProductionEnabled) {
    return {
      environment,
      tested: false,
      ok: false,
      detail:
        'O servidor está com produção desligada (ASAAS_PRODUCTION_ENABLED): a chave de produção não é testada daqui.',
    };
  }
  const baseUrl = environment === 'production' ? env.ASAAS_PRODUCTION_BASE_URL : env.ASAAS_BASE_URL;
  const r = await perguntarMinhaConta(baseUrl, apiKey, environment);
  return { environment, tested: true, ...r };
}

async function perguntarMinhaConta(
  baseUrl: string,
  apiKey: string,
  environment: string,
): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(`${baseUrl}/myAccount`, {
      headers: { access_token: apiKey },
      signal: AbortSignal.timeout(loadEnv().ASAAS_TIMEOUT_MS),
    });
    if (res.ok) return { ok: true, detail: `Conexão OK (${environment}).` };

    // "HTTP 401" não diz a quem configura o que fazer em seguida. O código
    // continua no fim da frase para quem for investigar.
    const explicacao =
      res.status === 401 || res.status === 403
        ? 'O Asaas recusou a credencial. Confira se a chave é deste ambiente e se ainda está ativa'
        : res.status === 404
          ? 'Endereço da API não encontrado — confira a URL configurada'
          : res.status >= 500
            ? 'O Asaas respondeu com erro no lado deles. Tente de novo em alguns minutos'
            : 'O Asaas recusou a chamada';
    return { ok: false, detail: `${explicacao} (HTTP ${res.status}).` };
  } catch (err) {
    // Nunca vaza a chave no erro.
    const nome = (err as Error).name;
    const explicacao =
      nome === 'TimeoutError' || nome === 'AbortError'
        ? 'O Asaas não respondeu no tempo esperado'
        : 'Não foi possível alcançar o Asaas a partir deste servidor';
    return { ok: false, detail: `${explicacao} (${nome}).` };
  }
}

function findIntent(companyId: string, key: string): PaymentIntent | undefined {
  return getConnection()
    .prepare('SELECT * FROM core_payment_intents WHERE company_id = ? AND idempotency_key = ?')
    .get(companyId, key) as unknown as PaymentIntent | undefined;
}

export interface CreatePaymentIntentInput {
  companyId: string;
  originType: PaymentOriginType;
  originId: string;
  method: PaymentMethodKind;
  amountCents: number;
  idempotencyKey: string;
  /**
   * O que a chave do CLIENTE pediu — `v1:` de `ImpressaoDaRequisicao` (RES-IDEM-VIZ).
   *
   * Só passa quem recebe a chave de fora: o PIX do balcão, cuja referência do
   * QR vem da tela. Com ela, a mesma chave com outro valor é 422 em vez de
   * devolver a cobrança antiga. Chave derivada pelo servidor (pedido + meio,
   * título + meio) não precisa: o servidor não a reusa com outro pedido.
   */
  impressao?: string | null;
  /**
   * Cliente JÁ resolvido no provedor (`resolveAsaasCustomer`).
   *
   * O provedor pendura a cobrança em alguém; sem isto ele recusa. Quem resolve
   * o vínculo é o chamador, porque cada origem sabe de qual cadastro é o
   * cliente — o pedido tem o dele, o título financeiro tem o do lançamento.
   */
  asaasCustomerId?: string;
  /** O que aparece na fatura do cliente. */
  description?: string;
  /** Vencimento no provedor (AAAA-MM-DD). Omitido, amanhã. */
  dueDate?: string;
  /** Unidade, quando a operação tiver conta Asaas por unidade. */
  storeId?: string;
  operationalUnitId?: string;
  /**
   * Só para teste: substitui o `fetch` do cliente HTTP.
   *
   * NÃO é um provedor de mentira embutido — sem ele, o cliente real é usado.
   * É a mesma porta que `createOrderCharge` abre, e é o que permite provar o
   * caminho inteiro sem rede.
   */
  fetchImpl?: typeof fetch;
}

/**
 * Cria (ou recupera) a intenção de pagamento.
 *
 * Idempotente pela chave: reenviar não gera uma segunda cobrança no provedor,
 * que é justamente o erro que cobraria o cliente duas vezes.
 *
 * COM UMA EXCEÇÃO, e ela é o retry do GAP-V76: intenção que ficou `failed` SEM
 * `provider_ref` não chegou a virar cobrança lá fora. Devolvê-la como está
 * deixaria o título sem cobrança para sempre — o comprador esperando um boleto
 * que nunca existiu. Nesse caso, e só nele, o provedor é chamado de novo sobre
 * a MESMA intenção: a idempotência que já existia é o que torna o "tentar de
 * novo" seguro.
 */
export async function createPaymentIntent(input: CreatePaymentIntentInput): Promise<PaymentIntent> {
  ensureCoreSchema();
  if (input.amountCents <= 0) {
    throw new ApiError('CORE_INVALID_AMOUNT', 'Valor da cobrança inválido.', 400);
  }

  const creds =
    input.method === 'manual'
      ? null
      : getAsaasCredentials({
          companyId: input.companyId,
          storeId: input.storeId,
          operationalUnitId: input.operationalUnitId,
        });

  const existing = findIntent(input.companyId, input.idempotencyKey);
  if (existing) {
    const gravada = (existing as unknown as { idempotency_fingerprint?: string | null }).idempotency_fingerprint;
    if (input.impressao && outraImpressao(gravada, input.impressao)) {
      throw chaveReusada('outra cobrança', { intentId: existing.id });
    }
    const podeRetentar = !existing.provider_ref && existing.status === 'failed' && creds;
    if (podeRetentar) {
      // Retentativa: antes de criar, pergunta ao provedor se a tentativa
      // anterior já criou (GAP-PRD-049).
      await requestAsaasCharge(existing.id, creds, input, { retentativa: true });
      return reloadIntent(existing.id);
    }
    return existing;
  }

  const id = randomUUID();
  const now = new Date().toISOString();

  withTransaction(() => {
    getConnection()
      .prepare(
        `INSERT INTO core_payment_intents
           (id, company_id, provider, environment, origin_type, origin_id, method,
            amount_cents, status, idempotency_key, created_at, updated_at, idempotency_fingerprint)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.companyId,
        input.method === 'manual' ? 'manual' : 'asaas',
        creds?.environment ?? 'sandbox',
        input.originType,
        input.originId,
        input.method,
        input.amountCents,
        // Sem credencial o estado é explícito — não é "pendente de pagamento",
        // é "não configurado". Confundir os dois esconde o problema.
        input.method === 'manual' ? 'pending' : creds ? 'pending' : 'unconfigured',
        input.idempotencyKey,
        now,
        now,
        input.impressao ?? null,
      );
  });

  if (creds && input.method !== 'manual') {
    await requestAsaasCharge(id, creds, input);
  }

  return reloadIntent(id);
}

export function reloadIntent(intentId: string): PaymentIntent {
  return getConnection()
    .prepare('SELECT * FROM core_payment_intents WHERE id = ?')
    .get(intentId) as unknown as PaymentIntent;
}

/** Como cada meio se chama do lado do provedor. */
function billingTypeDe(method: string): string {
  if (method === 'pix') return 'PIX';
  if (method === 'cartao') return 'CREDIT_CARD';
  return 'BOLETO';
}

/**
 * O CORPO DA COBRANÇA que o ERP manda ao Asaas — um lugar só.
 *
 * Extraído de `requestAsaasCharge` para a homologação poder exercitar O MESMO
 * corpo (GAP-PRD-169): o passo "Cobrança do título" era um selo verde sobre a
 * fila legada, que não é o caminho do título. Agora ele manda ao sandbox
 * exatamente o que o título mandaria, e confere o que volta.
 */
export function montarCobrancaAsaas(input: {
  asaasCustomerId?: string;
  method: string;
  amountCents: number;
  dueDate?: string | null;
  description?: string | null;
  originId: string;
}): Record<string, unknown> {
  return {
    customer: input.asaasCustomerId,
    billingType: billingTypeDe(input.method),
    // Centavos INTEIROS aqui dentro; o provedor fala reais. A divisão é o
    // último passo, na fronteira, e nunca volta para o banco.
    value: input.amountCents / 100,
    dueDate: input.dueDate ?? somarDias(hojeNaLoja(), 1),
    description: input.description ?? `Cobrança ${input.originId}`,
    externalReference: input.originId,
  };
}

/**
 * Chama o Asaas para criar a cobrança. Falha de rede não derruba o pedido:
 * a intenção fica com o erro registrado para retry.
 *
 * ## Por que isto passou a usar o `AsaasHttpClient`
 *
 * Antes montava a requisição à mão, com `fetch` global e a chave no header
 * escrito aqui. Três consequências: (a) não havia como provar o caminho sem
 * rede — nenhum teste conseguia entrar; (b) a cobrança nascia SEM CLIENTE, e o
 * provedor recusa cobrança sem cliente, então este caminho nunca teria
 * funcionado de verdade; (c) o tratamento de 429, timeout e ambiente vivia em
 * duas cópias, uma aqui e outra no cliente HTTP.
 *
 * Agora é o mesmo cliente que o pedido online usa. `fetchImpl` é a porta do
 * teste, e a chave nunca é escrita nem no erro guardado.
 *
 * ## Retentativa pergunta antes de criar (GAP-PRD-049)
 *
 * Timeout na criação não prova que a cobrança não existe: o provedor pode ter
 * gravado antes de a resposta se perder. Na retentativa, a cobrança criada lá
 * é procurada pela referência externa e ADOTADA; se a consulta falhar, nada é
 * criado — criar no escuro é o que cobrava o cliente duas vezes.
 */
async function requestAsaasCharge(
  intentId: string,
  creds: AsaasCredentials,
  input: CreatePaymentIntentInput,
  opcoes: { retentativa?: boolean } = {},
): Promise<void> {
  const db = getConnection();
  const falhou = (motivo: string) =>
    db
      .prepare(
        `UPDATE core_payment_intents
            SET status = 'failed', last_error = ?, attempts = attempts + 1, updated_at = ?
          WHERE id = ?`,
      )
      .run(motivo, new Date().toISOString(), intentId);

  const cliente = new AsaasHttpClient({
    environment: creds.environment,
    companyId: input.companyId,
    storeId: input.storeId,
    operationalUnitId: input.operationalUnitId,
    fetchImpl: input.fetchImpl,
  });

  if (opcoes.retentativa) {
    try {
      const achado = await procurarCobrancaJaCriada({
        gateway: cliente,
        originId: input.originId,
        method: input.method,
        amountCents: reloadIntent(intentId).amount_cents,
      });
      if (achado.adotar) {
        adotarCobrancaDoProvedor(intentId, achado.adotar, achado.sobrando);
        return;
      }
    } catch (err) {
      falhou(
        err instanceof ApiError
          ? err.message
          : 'Não foi possível conferir no provedor se a tentativa anterior criou a cobrança.',
      );
      return;
    }
  }

  try {
    const cobranca = await cliente.createPayment(
      montarCobrancaAsaas({
        asaasCustomerId: input.asaasCustomerId,
        method: input.method,
        amountCents: input.amountCents,
        dueDate: input.dueDate,
        description: input.description,
        originId: input.originId,
      }),
    );

    const remoto = String(cobranca.id ?? '');
    if (!remoto) {
      falhou('provedor não devolveu id da cobrança');
      return;
    }

    db.prepare(
      `UPDATE core_payment_intents
          SET provider_ref = ?, invoice_url = ?, status = 'pending', last_error = NULL,
              attempts = attempts + 1, updated_at = ?
        WHERE id = ?`,
    ).run(
      remoto,
      String(cobranca.invoiceUrl ?? ''),
      new Date().toISOString(),
      intentId,
    );
  } catch (err) {
    // A mensagem do `ApiError` do cliente HTTP já é "Erro Asaas 500" ou "Falha
    // de conexão" — nunca carrega a chave, e é o que a tela mostra. Quando a
    // falha deixa a dúvida "criou ou não criou", a frase diz isso (GAP-PRD-049).
    const motivo = err instanceof ApiError ? err.message : `network:${(err as Error).name}`;
    falhou(falhaDeResultadoIncerto(err) ? motivoDeResultadoIncerto(motivo) : motivo);
  }
}

/**
 * As cobranças de UM documento.
 *
 * `companyId` é obrigatório, e não é burocracia: sem ele esta consulta
 * devolvia a intenção de QUALQUER operação que tivesse o mesmo id de origem —
 * a função estava escrita assim e sem chamador nenhum, então o vazamento
 * nunca chegou a acontecer. Ele não vai começar agora que ela ganhou tela.
 */
export function getIntentsFor(input: {
  companyId: string;
  originType: string;
  originId: string;
}): PaymentIntent[] {
  ensureCoreSchema();
  return getConnection()
    .prepare(
      `SELECT * FROM core_payment_intents
        WHERE company_id = ? AND origin_type = ? AND origin_id = ?
        ORDER BY created_at`,
    )
    .all(input.companyId, input.originType, input.originId) as unknown as PaymentIntent[];
}

/**
 * O QUE ACONTECEU COM AS COBRANÇAS — a lista que não existia (GAP-V75).
 *
 * Cobrança `failed` com `last_error`, tentativa que não foi adiante, cobrança
 * vencida: tudo isso já era gravado e não aparecia em tela nenhuma. O gestor
 * descobria pela reclamação do comprador ou pela divergência da conciliação.
 *
 * A origem sai com RÓTULO resolvido no SQL, pelo mesmo motivo do rótulo do
 * financeiro: a alternativa seria a tela buscar o título de cada linha, uma
 * requisição por linha. Origem sem superfície fica com rótulo nulo — a verdade
 * é que não há para onde ir.
 */
export interface PaymentIntentView {
  id: string;
  originType: string;
  originId: string;
  originLabel: string | null;
  method: string;
  provider: string;
  environment: string;
  amountCents: number;
  status: string;
  providerRef: string | null;
  invoiceUrl: string | null;
  lastError: string | null;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  confirmedAt: string | null;
  /**
   * A baixa que ESTA cobrança produziu no título ainda está de pé (GAP-PRD-092).
   *
   * Só faz sentido para cobrança de título com referência no provedor; nas
   * demais é nulo. É o que deixa a tela oferecer "Estornar cobrança" também
   * para a cobrança já estornada no portal cuja baixa ninguém desfez — e não
   * oferecer para a que não tem mais nada a desfazer.
   */
  settlementStanding: boolean | null;
  /** Cartão parcelado (GAP-PRD-114): em quantas vezes. 1 à vista. */
  installmentCount: number;
}

const ORIGEM_DA_COBRANCA_SQL = `CASE i.origin_type
         WHEN 'ecommerce_order' THEN 'Pedido online #' || ped.number
         WHEN 'finance_entry' THEN fin.description
         WHEN 'sale' THEN CASE WHEN i.origin_id LIKE 'pdv-pix:%'
           THEN 'PIX do balcão (venda ainda não fechada)'
           ELSE 'Venda #' || ven.number END
         ELSE NULL END`;

const JOINS_DA_COBRANCA = `LEFT JOIN core_orders ped
                 ON i.origin_type = 'ecommerce_order' AND ped.id = i.origin_id
               LEFT JOIN core_finance_entries fin
                 ON i.origin_type = 'finance_entry' AND fin.id = i.origin_id
               LEFT JOIN core_sales ven
                 ON i.origin_type = 'sale' AND ven.id = i.origin_id`;

function toIntentView(row: Record<string, unknown>): PaymentIntentView {
  return {
    id: String(row.id),
    originType: String(row.origin_type),
    originId: String(row.origin_id),
    originLabel: (row.origin_label as string | null) ?? null,
    method: String(row.method),
    provider: String(row.provider),
    environment: String(row.environment),
    amountCents: Number(row.amount_cents),
    status: String(row.status),
    providerRef: (row.provider_ref as string | null) || null,
    invoiceUrl: (row.invoice_url as string | null) || null,
    lastError: (row.last_error as string | null) || null,
    attempts: Number(row.attempts ?? 0),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    confirmedAt: (row.confirmed_at as string | null) ?? null,
    settlementStanding:
      row.baixa_de_pe === null || row.baixa_de_pe === undefined ? null : Number(row.baixa_de_pe) === 1,
    installmentCount: Number(row.installment_count ?? 1) > 1 ? Number(row.installment_count) : 1,
  };
}

/** A baixa `Asaas <cobrança>` ainda de pé no título — nula fora de título. */
const BAIXA_DE_PE_SQL = `CASE WHEN i.origin_type = 'finance_entry' AND i.provider_ref IS NOT NULL
         THEN EXISTS (SELECT 1 FROM core_finance_settlements st
                       WHERE st.company_id = i.company_id AND st.entry_id = i.origin_id
                         AND st.note = 'Asaas ' || i.provider_ref
                         AND st.reverses_id IS NULL AND st.reversed_at IS NULL)
         ELSE NULL END`;

export function listPaymentIntents(input: {
  companyId: string;
  status?: string;
  originType?: string;
  limit?: number;
}): PaymentIntentView[] {
  ensureCoreSchema();
  const params: unknown[] = [input.companyId];
  let sql = `SELECT i.*, ${ORIGEM_DA_COBRANCA_SQL} AS origin_label, ${BAIXA_DE_PE_SQL} AS baixa_de_pe
               FROM core_payment_intents i
               ${JOINS_DA_COBRANCA}
              WHERE i.company_id = ?`;
  if (input.status) {
    sql += ' AND i.status = ?';
    params.push(input.status);
  }
  if (input.originType) {
    sql += ' AND i.origin_type = ?';
    params.push(input.originType);
  }
  sql += ' ORDER BY i.created_at DESC LIMIT ?';
  params.push(Math.min(Math.max(input.limit ?? 200, 1), 500));

  const rows = getConnection()
    .prepare(sql)
    .all(...(params as never[])) as unknown as Record<string, unknown>[];
  return rows.map(toIntentView);
}

/**
 * O que a tela precisa mostrar de uma cobrança: copia-e-cola, linha digitável,
 * link da fatura.
 *
 * Vive aqui, e não em cada chamador, porque pedido online e título financeiro
 * mostram a MESMA coisa — duas cópias divergiriam no primeiro ajuste, e a
 * segunda seria a que ninguém testou.
 *
 * Falha ao buscar o QR NÃO derruba nada: a cobrança existe, e a tela mostra o
 * link da fatura. Perder a cobrança porque o QR não veio seria trocar um
 * problema pequeno por um grande.
 */
export interface ChargeDisplay {
  pixPayload: string | null;
  pixImageBase64: string | null;
  bankSlipUrl: string | null;
  identificationField: string | null;
  dueDate: string | null;
}

export async function carregarExibicaoDaCobranca(input: {
  intent: PaymentIntent;
  companyId: string;
  environment: string;
  fetchImpl?: typeof fetch;
  /** Corpo devolvido pelo provedor na criação, quando acabou de acontecer. */
  cobrancaCriada?: Record<string, unknown>;
}): Promise<ChargeDisplay> {
  const { intent, cobrancaCriada } = input;
  const base: ChargeDisplay = {
    pixPayload: null,
    pixImageBase64: null,
    bankSlipUrl: (cobrancaCriada?.bankSlipUrl as string | undefined) ?? intent.invoice_url ?? null,
    identificationField: null,
    dueDate: (cobrancaCriada?.dueDate as string | undefined) ?? null,
  };
  if (!intent.provider_ref) return base;

  // O copia-e-cola já guardado NÃO é buscado de novo. Ele é estável enquanto a
  // cobrança existir, e reabrir a tela não pode virar uma ida ao provedor a
  // cada vez: é latência para quem espera e consumo de limite por nada.
  if (intent.method === 'pix' && intent.qr_payload) {
    base.pixPayload = intent.qr_payload;
    return base;
  }

  const cliente = new AsaasHttpClient({
    environment: input.environment as 'sandbox' | 'production',
    companyId: input.companyId,
    fetchImpl: input.fetchImpl,
  });

  if (intent.method === 'pix') {
    try {
      const qr = await cliente.getPixQrCode(intent.provider_ref);
      base.pixPayload = (qr.payload as string | undefined) ?? null;
      base.pixImageBase64 = (qr.encodedImage as string | undefined) ?? null;
      base.dueDate = (qr.expirationDate as string | undefined) ?? base.dueDate;
      if (base.pixPayload) {
        getConnection()
          .prepare('UPDATE core_payment_intents SET qr_payload = ?, updated_at = ? WHERE id = ?')
          .run(base.pixPayload, new Date().toISOString(), intent.id);
      }
    } catch {
      base.pixPayload = intent.qr_payload ?? null;
    }
  } else if (intent.method === 'boleto') {
    try {
      const linha = await cliente.getIdentificationField(intent.provider_ref);
      base.identificationField =
        (linha.identificationField as string | undefined)
        ?? (linha.barCode as string | undefined)
        ?? null;
    } catch {
      base.identificationField = null;
    }
  }
  // Cartão não tem copia-e-cola nem linha digitável: o cliente paga na página
  // do provedor (`invoice_url`), e o número do cartão nunca passa por aqui.

  return base;
}

/**
 * RE-TENTAR A COBRANÇA QUE FALHOU (GAP-V76).
 *
 * O DEFEITO: `requestAsaasCharge` gravava `failed` e ninguém reprocessava. Se o
 * provedor oscilasse na criação, não havia job nem botão — só o reenvio do
 * mesmo checkout re-tentava, e quem tinha fechado a aba ficava sem cobrança até
 * o pedido expirar em 25 horas. Do lado do financeiro nem isso existia.
 *
 * O retry NÃO é uma segunda cobrança: ele reusa a MESMA intenção, pela mesma
 * chave de idempotência. Por isso a recusa dura logo abaixo — cobrança que JÁ
 * tem `provider_ref` existe no provedor, e "tentar de novo" ali seria cobrar o
 * cliente duas vezes.
 */
export interface RetriedCharge extends ChargeDisplay {
  intent: PaymentIntent;
  status: string;
  environment: string;
  invoiceUrl: string | null;
}

export async function retryPaymentIntent(input: {
  companyId: string;
  intentId: string;
  fetchImpl?: typeof fetch;
}): Promise<RetriedCharge> {
  ensureCoreSchema();
  const intent = getConnection()
    .prepare('SELECT * FROM core_payment_intents WHERE id = ? AND company_id = ?')
    .get(input.intentId, input.companyId) as unknown as PaymentIntent | undefined;
  if (!intent) {
    throw new ApiError('CORE_PAYMENT_INTENT_NOT_FOUND', 'Cobrança não encontrada.', 404);
  }
  if (intent.provider_ref) {
    throw new ApiError(
      'CORE_PAYMENT_INTENT_NOT_RETRIABLE',
      'Esta cobrança já existe no provedor. Gerar de novo cobraria o cliente duas vezes.',
      409,
    );
  }
  if (intent.status !== 'failed' && intent.status !== 'unconfigured') {
    throw new ApiError(
      'CORE_PAYMENT_INTENT_NOT_RETRIABLE',
      `Cobrança em "${intent.status}" não é o caso de re-tentar.`,
      409,
    );
  }

  if (intent.origin_type === 'finance_entry') {
    const { chargeFinanceEntry } = await import('./FinanceChargeService.js');
    const r = await chargeFinanceEntry({
      companyId: input.companyId,
      entryId: intent.origin_id,
      method: intent.method as 'pix' | 'boleto' | 'cartao',
      fetchImpl: input.fetchImpl,
    });
    return {
      intent: r.intent,
      status: r.status,
      environment: r.environment,
      invoiceUrl: r.invoiceUrl,
      pixPayload: r.pixPayload,
      pixImageBase64: r.pixImageBase64,
      bankSlipUrl: r.bankSlipUrl,
      identificationField: r.identificationField,
      dueDate: r.dueDate,
    };
  }

  if (intent.origin_type === 'ecommerce_order') {
    const { createOrderCharge } = await import('./OrderChargeService.js');
    const r = await createOrderCharge({
      companyId: input.companyId,
      orderId: intent.origin_id,
      method: intent.method as 'pix' | 'boleto' | 'cartao',
      fetchImpl: input.fetchImpl,
    });
    return {
      intent: r.intent,
      status: r.status,
      environment: r.environment,
      invoiceUrl: r.intent.invoice_url ?? null,
      pixPayload: r.pixPayload,
      pixImageBase64: r.pixImageBase64,
      bankSlipUrl: r.bankSlipUrl,
      identificationField: r.identificationField,
      dueDate: r.dueDate,
    };
  }

  // Origem sem caminho de re-cobrança é recusa declarada, não silêncio: fingir
  // que re-tentou seria pior do que dizer que não há por onde.
  throw new ApiError(
    'CORE_PAYMENT_INTENT_NOT_RETRIABLE',
    `Origem "${intent.origin_type}" não tem caminho de re-cobrança.`,
    409,
  );
}

/**
 * Efeito de cada evento do Asaas sobre a intenção de pagamento.
 *
 * A tabela é o mapa, e é curta de propósito: evento que não está aqui fica
 * REGISTRADO e sem efeito. Inventar equivalência — tratar um evento
 * desconhecido como confirmação, por exemplo — é o erro que faz o pedido sair
 * sem ninguém ter pago.
 *
 * `rank` resolve evento fora de ordem. A internet não garante ordem: o
 * `PAYMENT_CONFIRMED` pode chegar antes do `PAYMENT_CREATED` que veio antes
 * dele. Só se aplica evento de posto igual ou superior ao que a intenção já
 * alcançou — um "pendente" atrasado nunca desfaz um "recebido".
 *
 * Estorno e chargeback são exceção declarada: ANDAM PARA TRÁS de propósito,
 * porque são fatos posteriores ao pagamento, não notícias atrasadas.
 */
const EVENTOS_ASAAS: Record<string, { status: string; rank: number; reverses?: boolean }> = {
  PAYMENT_CREATED: { status: 'pending', rank: 1 },
  PAYMENT_AWAITING_RISK_ANALYSIS: { status: 'pending', rank: 1 },
  PAYMENT_UPDATED: { status: 'pending', rank: 1 },
  PAYMENT_OVERDUE: { status: 'overdue', rank: 2 },
  PAYMENT_RECEIVED: { status: 'confirmed', rank: 3 },
  PAYMENT_CONFIRMED: { status: 'confirmed', rank: 3 },
  PAYMENT_REFUNDED: { status: 'refunded', rank: 4, reverses: true },
  PAYMENT_CHARGEBACK_REQUESTED: { status: 'chargeback', rank: 4, reverses: true },
  PAYMENT_CHARGEBACK_DISPUTE: { status: 'chargeback', rank: 4, reverses: true },
  PAYMENT_DELETED: { status: 'cancelled', rank: 4, reverses: true },
};

/**
 * Posto atual da intenção, para comparar com o do evento que chegou.
 *
 * `amount_mismatch` e `paid_after_cancel` NÃO TINHAM POSTO (valiam zero), e
 * os dois são desfechos de dinheiro que ENTROU. Um `PAYMENT_OVERDUE` ou
 * `PAYMENT_UPDATED` atrasado os reescrevia como "vencida"/"pendente", e o
 * sinal de dinheiro a conferir sumia da conciliação. Têm o posto da
 * confirmação, que é o fato que os produziu.
 */
const RANK_POR_STATUS: Record<string, number> = {
  unconfigured: 0,
  failed: 0,
  pending: 1,
  overdue: 2,
  confirmed: 3,
  amount_mismatch: 3,
  paid_after_cancel: 3,
  refunded: 4,
  chargeback: 4,
  cancelled: 4,
};

/** Como o provedor chama cada meio — para casar a cobrança órfã pelo meio certo. */
const MEIO_DO_TIPO_ASAAS: Record<string, string> = {
  PIX: 'pix',
  BOLETO: 'boleto',
  CREDIT_CARD: 'cartao',
};

/**
 * Cobrança do ERP para um `provider_ref` que ela ainda não conhece (GAP-PRD-049).
 *
 * Criação com timeout: o provedor criou, a resposta se perdeu, e a intenção
 * ficou sem `provider_ref`. Quando o cliente paga essa cobrança, o evento traz
 * a referência externa (o id da origem, que toda criação envia) — é por ela que
 * se acha a intenção, sem inventar nada:
 *
 *   - só intenção SEM `provider_ref`, em `failed`/`pending` (as que podem ter
 *     virado cobrança sem saber);
 *   - da operação que o token provou, quando há uma;
 *   - do mesmo meio, quando o evento diz o meio;
 *   - e só se for UMA. Duas candidatas é dúvida, e dúvida não baixa título.
 */
function intencaoPelaReferenciaExterna(
  pagamento: Record<string, unknown> | undefined,
  companyId: string | null,
): PaymentIntent | undefined {
  const referencia = String(pagamento?.externalReference ?? '');
  if (!referencia) return undefined;

  const tipo = pagamento?.billingType ? String(pagamento.billingType) : null;
  const meio = tipo ? MEIO_DO_TIPO_ASAAS[tipo] : undefined;
  // Meio que o ERP não cobra (débito, transferência…) não é cobrança nossa.
  if (tipo && tipo !== 'UNDEFINED' && !meio) return undefined;

  const params: string[] = [referencia];
  let sql = `SELECT * FROM core_payment_intents
              WHERE origin_id = ? AND provider = 'asaas' AND provider_ref IS NULL
                AND status IN ('failed', 'pending')`;
  if (companyId) {
    sql += ' AND company_id = ?';
    params.push(companyId);
  }
  if (meio) {
    sql += ' AND method = ?';
    params.push(meio);
  }
  const candidatas = getConnection()
    .prepare(sql)
    .all(...params) as unknown as PaymentIntent[];
  return candidatas.length === 1 ? candidatas[0] : undefined;
}

/** A baixa DESTA cobrança já foi feita no título? (GAP-PRD-091) */
function tituloJaBaixadoPorEstaCobranca(intent: PaymentIntent, providerRef: string): boolean {
  return Boolean(
    getConnection()
      .prepare(
        `SELECT 1 AS n FROM core_finance_settlements
          WHERE entry_id = ? AND company_id = ? AND note = ? AND reverses_id IS NULL
          LIMIT 1`,
      )
      .get(intent.origin_id, intent.company_id, `Asaas ${providerRef}`),
  );
}

/**
 * O que o evento FAZ com a cobrança e com a origem dela.
 *
 * Saiu de dentro do webhook para ter um segundo chamador: a retentativa que
 * ADOTA uma cobrança órfã já paga (GAP-PRD-049) aplica aqui a confirmação que
 * o webhook dela, respondido como "não encontrada", nunca aplicou.
 *
 * Roda dentro da transação de quem chama: a intenção só vira `confirmed` se a
 * baixa do título ou o pagamento do pedido também forem gravados.
 */
function aplicarEventoNaCobranca(input: {
  intent: PaymentIntent;
  regra: { status: string; rank: number; reverses?: boolean };
  nomeDoEvento: string;
  pagamento: Record<string, unknown> | undefined;
  providerRef: string;
}): string {
  const { intent, regra, nomeDoEvento, pagamento, providerRef } = input;
  const db = getConnection();
  const postoAtual = RANK_POR_STATUS[intent.status] ?? 0;

  /*
    A CONFERÊNCIA DE VALOR SAIU DE DENTRO DO PEDIDO (rodada 42 → GAP-V70).

    Ela vivia dentro do ramo do `ecommerce_order`, e o título financeiro
    entrou como segunda origem: mantê-la lá dentro faria a cobrança do
    contas a receber nascer SEM ela — um webhook legítimo de R$ 1,00
    quitaria um aluguel de R$ 300,00, bastando criar uma cobrança avulsa de
    qualquer valor na mesma conta. A conferência é da CASA, não do pedido.

    Evento SEM valor segue o caminho antigo: inventar divergência onde o
    provedor não mandou número travaria pagamento bom por formato de
    payload.
  */
  const valorPagoReais = pagamento?.value;
  const valorPagoCents =
    typeof valorPagoReais === 'number' ? Math.round(valorPagoReais * 100) : null;
  /*
    CARTÃO PARCELADO (GAP-PRD-114): o evento chega POR PARCELA, com o valor
    dela. A conferência passa a ser "cabe na divisão do plano" — comparar com o
    total acusaria divergência em toda parcela confirmada.
  */
  const parcelas = Number(intent.installment_count ?? 1);
  const valorDivergente =
    valorPagoCents !== null
    && (parcelas > 1
      ? !parcelaCoerente(valorPagoCents, intent.amount_cents, parcelas)
      : valorPagoCents !== intent.amount_cents);
  const emReais = (cents: number) => `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`;
  const textoDaDivergencia = () =>
    `valor pago ${emReais(valorPagoCents ?? 0)} difere do cobrado ${emReais(intent.amount_cents)}`;

  /*
    PAGO DEPOIS DE CANCELADA NO ERP (GAP-PRD-016).

    `cancelled` tem posto 4 e a confirmação, 3: pela régua, o recebimento de
    uma cobrança que o ERP cancelou era "notícia velha" e caía no `ignorado`
    abaixo. Mas não é notícia velha — é DINHEIRO QUE ENTROU: o boleto pago no
    mesmo dia do cancelamento, a cobrança restaurada no painel. Ignorar tirava
    esse dinheiro do único relatório feito para achá-lo (a conciliação só
    enxerga intenção com dinheiro dentro).

    Não se ressuscita nada: a intenção vira `paid_after_cancel`, que a
    conciliação conta como dinheiro, e o motivo fica escrito para quem decide
    entre estornar e baixar à mão.
  */
  if (regra.status === 'confirmed' && intent.status === 'cancelled') {
    const valor = valorPagoCents ?? intent.amount_cents;
    db.prepare(
      `UPDATE core_payment_intents
          SET status = 'paid_after_cancel', last_error = ?,
              confirmed_at = COALESCE(confirmed_at, ?), updated_at = ?
        WHERE id = ?`,
    ).run(
      `pagamento de ${emReais(valor)} recebido numa cobrança já cancelada no ERP — decidir entre estornar e baixar à mão`,
      new Date().toISOString(),
      new Date().toISOString(),
      intent.id,
    );
    if (intent.origin_type === 'ecommerce_order') {
      const pedido = db
        .prepare('SELECT status FROM core_orders WHERE id = ?')
        .get(intent.origin_id) as { status: string } | undefined;
      if (pedido?.status === 'cancelado') {
        registerPaymentAfterCancel({
          companyId: intent.company_id,
          orderId: intent.origin_id,
          providerRef,
          amountCents: valor,
        });
      } else if (pedido) {
        addOrderEvent(
          intent.origin_id,
          intent.company_id,
          pedido.status,
          `Pagamento de ${emReais(valor)} recebido numa cobrança que o ERP já tinha cancelado `
            + `(${providerRef}). Conferir se o pedido foi pago duas vezes.`,
        );
      }
    }
    return 'Pagamento recebido numa cobrança CANCELADA no ERP — pendente de regularização.';
  }

  if (regra.rank < postoAtual && !regra.reverses) {
    // Notícia velha. Aplicar faria o pedido pago voltar a pendente.
    return `Evento ${nomeDoEvento} anterior ao estado atual (${intent.status}) — ignorado.`;
  }

  /*
    SEGUNDA CONFIRMAÇÃO SOBRE DESFECHO JÁ REGISTRADO (GAP-PRD-091).

    Valor divergente e pagamento depois do cancelamento esperam decisão de
    quem controla o caixa. O `PAYMENT_RECEIVED` que chega depois do
    `PAYMENT_CONFIRMED` é o MESMO dinheiro: reaplicar escreveria um segundo
    aviso no pedido e apagaria o estado que a conciliação precisa ver.
  */
  if (
    regra.status === 'confirmed'
    && (intent.status === 'amount_mismatch' || intent.status === 'paid_after_cancel')
  ) {
    return `Cobrança já registrada como ${intent.status} — nova confirmação não muda nada.`;
  }

  const agora = new Date().toISOString();
  // A hora da confirmação é a da PRIMEIRA: a segunda não reescreve a história.
  db.prepare(
    `UPDATE core_payment_intents
        SET status = ?,
            confirmed_at = CASE WHEN ? = 'confirmed' THEN COALESCE(confirmed_at, ?) ELSE confirmed_at END,
            updated_at = ?
      WHERE id = ?`,
  ).run(regra.status, regra.status, agora, agora, intent.id);

  if (regra.status === 'confirmed' && intent.origin_type === 'ecommerce_order') {
    const pedido = db
      .prepare('SELECT status FROM core_orders WHERE id = ?')
      .get(intent.origin_id) as { status: string } | undefined;

    if (pedido?.status === 'cancelado') {
      // DINHEIRO REAL NUM PEDIDO CANCELADO. Não ressuscita o pedido —
      // a reserva já foi liberada e o item pode ter sido vendido a
      // outra pessoa. Também não se ignora: fica registrado e visível,
      // esperando decisão de quem controla o caixa.
      registerPaymentAfterCancel({
        companyId: intent.company_id,
        orderId: intent.origin_id,
        providerRef,
        amountCents: intent.amount_cents,
      });
      db.prepare(
        "UPDATE core_payment_intents SET status = 'paid_after_cancel', updated_at = ? WHERE id = ?",
      ).run(new Date().toISOString(), intent.id);
      return 'Pagamento recebido APÓS o cancelamento — pendente de regularização.';
    }

    /*
      CONFERÊNCIA DE VALOR (rodada 42). O provedor manda o valor pago
      em REAIS no evento. Até aqui ninguém o comparava com o pedido:
      um webhook legítimo de R$ 1,00 marcava pago um pedido de
      R$ 200,00 — bastava criar uma cobrança avulsa de qualquer valor
      na mesma conta. Divergiu, o pedido NÃO vira pago: o fato fica
      registrado no pedido e a intenção marcada, esperando decisão de
      quem controla o caixa. Evento SEM valor segue o caminho antigo —
      inventar divergência onde o provedor não mandou número seria
      travar pagamento bom por formato de payload.

      A comparação subiu para o alto do bloco (é da CASA, não do
      pedido); o texto do pedido continua o mesmo, palavra por palavra.
    */
    if (valorDivergente) {
      db.prepare(
        "UPDATE core_payment_intents SET status = 'amount_mismatch', last_error = ?, updated_at = ? WHERE id = ?",
      ).run(
        `valor pago R$ ${((valorPagoCents ?? 0) / 100).toFixed(2)} difere do pedido R$ ${(intent.amount_cents / 100).toFixed(2)}`,
        new Date().toISOString(),
        intent.id,
      );
      addOrderEvent(
        intent.origin_id,
        intent.company_id,
        'aguardando_pagamento',
        `Pagamento recebido com VALOR divergente: R$ ${((valorPagoCents ?? 0) / 100).toFixed(2)} `
          + `contra R$ ${(intent.amount_cents / 100).toFixed(2)} do pedido. `
          + 'Pendente de conferência — o pedido não foi marcado como pago.',
      );
      return 'Valor divergente do pedido — pendente de conferência.';
    }

    // `markOrderPaid` é idempotente do lado do pedido: a segunda
    // confirmação (CONFIRMED depois RECEIVED) passa por aqui sem efeito.
    markOrderPaid({
      companyId: intent.company_id,
      orderId: intent.origin_id,
      provider: intent.provider,
      providerRef,
    });
    return 'Pedido confirmado.';
  }

  if (regra.status === 'confirmed' && intent.origin_type === 'finance_entry') {
    /*
      O DINHEIRO ENTROU: O TÍTULO É BAIXADO (GAP-V70).

      É a metade que faltava da cobrança avulsa. Sem isto, o cliente
      pagaria o PIX e o contas a receber continuaria em aberto — o
      cobrador ligaria para quem já pagou, e a conciliação acusaria
      "cobrado e não lançado" todo mês.

      QUATRO CUIDADOS, e cada um cobre um jeito conhecido de errar:

      1. VALOR DIVERGENTE NÃO BAIXA. A conferência é a mesma do pedido, e
         ela é da casa: cobrança avulsa de R$ 1,00 na mesma conta não
         quita um aluguel de R$ 300,00.

      2. A BAIXA PASSA POR `settleEntry`. Não se escreve `settled_cents`
         à mão aqui: é ele que grava a linha em `core_finance_settlements`
         (sem a qual a conciliação bancária não enxerga a entrada), que
         recusa lançamento cancelado e que impede pagar mais que o
         devido. Um segundo escritor de baixa divergiria do primeiro.

      3. A BAIXA DESTA COBRANÇA É UMA SÓ (GAP-PRD-091). Boleto e cartão
         emitem CONFIRMED e depois RECEIVED, com ids diferentes. O segundo
         chamava `settleEntry` de novo, que recusava "já está quitado", e o
         catch gravava "baixa recusada" numa cobrança paga — alerta falso
         em toda cobrança por boleto ou cartão. A baixa leva a nota
         `Asaas <cobrança>`: se ela já existe, a confirmação é a mesma.

      4. RECUSA DE `settleEntry` NÃO DERRUBA O WEBHOOK. Se alguém baixou
         o título no caixa antes de o webhook chegar, `settleEntry` recusa
         — e relançar aqui devolveria erro ao provedor, que reenviaria o
         evento para sempre. O dinheiro ENTROU: a intenção fica
         `confirmed` com o motivo registrado, e a divergência aparece na
         conciliação, que é onde ela se resolve.
    */
    if (valorDivergente) {
      db.prepare(
        "UPDATE core_payment_intents SET status = 'amount_mismatch', last_error = ?, updated_at = ? WHERE id = ?",
      ).run(textoDaDivergencia(), new Date().toISOString(), intent.id);
      return 'Valor divergente do título — pendente de conferência.';
    }
    if (tituloJaBaixadoPorEstaCobranca(intent, providerRef)) {
      return 'Pagamento já confirmado — o título já foi baixado por esta cobrança.';
    }
    try {
      settleEntry({
        companyId: intent.company_id,
        entryId: intent.origin_id,
        amountCents: intent.amount_cents,
        method: intent.method === 'boleto' ? 'boleto' : intent.method,
        note: `Asaas ${providerRef}`,
      });
      return 'Título baixado pelo pagamento do provedor.';
    } catch (err) {
      const motivo = err instanceof Error ? err.message : String(err);
      db.prepare('UPDATE core_payment_intents SET last_error = ?, updated_at = ? WHERE id = ?').run(
        `baixa recusada: ${motivo}`,
        new Date().toISOString(),
        intent.id,
      );
      return `Pagamento confirmado, título NÃO baixado (${motivo}).`;
    }
  }

  if (regra.status === 'confirmed' && intent.origin_type === 'sale') {
    /*
      O PIX DO BALCÃO VIA ASAAS (GAP-PRD-077). Nenhum webhook tratava origem
      `sale`: a linha pendente da venda ficava pendente para sempre. Agora a
      confirmação liquida a linha e baixa o título da venda — com a mesma
      conferência de valor da casa. Cobrança ainda sem venda (o QR na tela do
      caixa) só fica confirmada: quem fecha a venda é a tela, que consulta.
    */
    if (valorDivergente) {
      db.prepare(
        "UPDATE core_payment_intents SET status = 'amount_mismatch', last_error = ?, updated_at = ? WHERE id = ?",
      ).run(textoDaDivergencia(), new Date().toISOString(), intent.id);
      return 'Valor divergente do PIX do balcão — pendente de conferência.';
    }
    return aplicarConfirmacaoNoBalcao({ intent, providerRef });
  }

  if (regra.reverses && intent.origin_type === 'finance_entry') {
    // Estorno/chargeback de título: o fato fica REGISTRADO na intenção e
    // a baixa NÃO é desfeita sozinha, pelo mesmo motivo declarado no
    // pedido logo abaixo — estornar receita mexe em competência e em
    // fechamento de mês. Quem controla o caixa desfaz a baixa pela tela.
    //
    // O TEXTO DIZ ONDE (GAP-PRD-092). "Desfaça pela tela" não apontava tela
    // nenhuma; agora o gesto existe — Contas › Cobranças online › "Estornar
    // cobrança" — e, quando o estorno foi pedido pelo próprio ERP, a baixa já
    // foi desfeita lá e o aviso diz isso em vez de mandar desfazer de novo.
    const baixaDePe = Boolean(
      db
        .prepare(
          `SELECT 1 AS n FROM core_finance_settlements
            WHERE entry_id = ? AND company_id = ? AND note = ?
              AND reverses_id IS NULL AND reversed_at IS NULL
            LIMIT 1`,
        )
        .get(intent.origin_id, intent.company_id, `Asaas ${providerRef}`),
    );
    return baixaDePe
      ? `Pagamento ${regra.status} no provedor — a baixa do título continua de pé: desfaça em Contas a receber › Cobranças online › "Estornar cobrança".`
      : `Pagamento ${regra.status} — a baixa do título já foi desfeita (ou nunca existiu).`;
  }

  if (regra.reverses && intent.origin_type === 'ecommerce_order') {
    // O dinheiro voltou ao cliente. O pedido precisa dizer isso: deixá-lo
    // como "pago" faria a expedição separar mercadoria de um pedido que
    // já foi desfeito.
    //
    // O DINHEIRO QUE VOLTOU GANHA LANÇAMENTO (GAP-PRD-031). A entrada
    // do pedido nasce quitada e sem baixa: não havia baixa a desfazer
    // pela tela, e a receita devolvida ficava no DRE. A contrapartida
    // é uma SAÍDA própria, quitada, na competência do dia do estorno —
    // a receita do mês do pagamento não é reescrita. O estoque NÃO
    // volta sozinho: a mercadoria fica "a conferir" (GAP-PRD-122).
    markOrderRefunded({
      companyId: intent.company_id,
      orderId: intent.origin_id,
      reason: regra.status,
      providerRef,
      dinheiro: 'devolvido_pelo_provedor',
      metodo: intent.method,
    });
    return `Pagamento ${regra.status}.`;
  }

  return `Intenção em ${regra.status}.`;
}

/**
 * ADOTA A COBRANÇA QUE O PROVEDOR JÁ TINHA (GAP-PRD-049).
 *
 * A intenção ganha o `provider_ref` que a resposta perdida não trouxe. Se a
 * cobrança já foi PAGA lá, a confirmação é aplicada aqui mesmo — o webhook
 * dela, se chegou antes, foi respondido como "não encontrada" e o provedor não
 * o repete.
 *
 * `provider_ref IS NULL` no UPDATE é o que impede duas adoções concorrentes de
 * pendurarem cobranças diferentes na mesma intenção.
 */
export function adotarCobrancaDoProvedor(
  intentId: string,
  cobranca: CobrancaNoProvedor,
  sobrando: CobrancaNoProvedor[] = [],
): PaymentIntent {
  withTransaction(() => {
    const db = getConnection();
    const agora = new Date().toISOString();
    const adotou = db
      .prepare(
        `UPDATE core_payment_intents
            SET provider_ref = ?, invoice_url = COALESCE(?, invoice_url), status = ?,
                provider_installment_ref = COALESCE(?, provider_installment_ref),
                last_error = ?, attempts = attempts + 1, updated_at = ?
          WHERE id = ? AND provider_ref IS NULL`,
      )
      .run(
        cobranca.id,
        cobranca.invoiceUrl,
        cobranca.status === 'OVERDUE' ? 'overdue' : 'pending',
        cobranca.installment ?? null,
        avisoDasSobrando(sobrando),
        agora,
        intentId,
      );
    if (Number(adotou.changes) === 0) return;

    if (STATUS_PAGOS_NO_PROVEDOR.has(cobranca.status)) {
      aplicarEventoNaCobranca({
        intent: reloadIntent(intentId),
        regra: EVENTOS_ASAAS.PAYMENT_RECEIVED,
        nomeDoEvento: 'PAYMENT_RECEIVED',
        pagamento: cobranca.valueCents === null ? undefined : { value: cobranca.valueCents / 100 },
        providerRef: cobranca.id,
      });
    }
  });
  return reloadIntent(intentId);
}

/**
 * APLICA O QUE O PROVEDOR DIZ DA COBRANÇA — sem webhook nenhum (GAP-PRD-016).
 *
 * A conciliação só enxergava o que o webhook trouxe: URL errada, 503 por
 * falta de token, servidor desligado além da janela de reenvio — e o dinheiro
 * que entrou não existia para o sistema. A sincronização pergunta ao provedor
 * (`GET /payments/:id`) e entrega a resposta AQUI, traduzida para o evento
 * equivalente. É o MESMO efeito do webhook, pelo mesmo `aplicarEventoNaCobranca`:
 * régua de posto, conferência de valor, baixa única por cobrança. Um segundo
 * escritor de baixa divergiria do primeiro.
 *
 * O webhook que chegar DEPOIS encontra o estado já aplicado e não repete nada
 * (baixa por cobrança é uma só; `markOrderPaid` é idempotente).
 */
export function aplicarStatusConsultado(input: {
  companyId: string;
  intentId: string;
  /** O evento equivalente ao status do provedor (`PAYMENT_RECEIVED`…). */
  evento: string;
  pagamento: Record<string, unknown>;
}): { antes: string; depois: string; detail: string } {
  return withTransaction(() => {
    const db = getConnection();
    const intent = db
      .prepare('SELECT * FROM core_payment_intents WHERE id = ? AND company_id = ?')
      .get(input.intentId, input.companyId) as unknown as PaymentIntent | undefined;
    if (!intent || !intent.provider_ref) {
      throw new ApiError('CORE_PAYMENT_INTENT_NOT_FOUND', 'Cobrança não encontrada.', 404);
    }
    const agora = new Date().toISOString();
    const regra = EVENTOS_ASAAS[input.evento];
    let detail = 'Status do provedor igual ao do ERP.';
    /*
      SÓ O QUE MUDA ALGUMA COISA. A consulta devolve o estado INTEIRO, não uma
      notícia: "apagada" sobre a cobrança que o próprio ERP cancelou é a mesma
      verdade dita de novo — reaplicá-la mandaria o pedido cancelado para
      "reembolsado" pelo ramo de reversão. Sobre cobrança cancelada aqui, só a
      CONFIRMAÇÃO interessa (o dinheiro que entrou depois do cancelamento).
    */
    const mudaAlgo =
      regra
      && regra.status !== intent.status
      && (intent.status !== 'cancelled' || regra.status === 'confirmed');
    if (regra && mudaAlgo) {
      detail = aplicarEventoNaCobranca({
        intent,
        regra,
        nomeDoEvento: input.evento,
        pagamento: input.pagamento,
        providerRef: intent.provider_ref,
      });
    }
    db.prepare('UPDATE core_payment_intents SET provider_checked_at = ? WHERE id = ?').run(agora, intent.id);
    return { antes: intent.status, depois: reloadIntent(intent.id).status, detail };
  });
}

/**
 * Processa webhook de pagamento.
 *
 * Três proteções: o token do webhook precisa bater com o da operação, o
 * `event_id` é único — reprocessar a mesma notificação não confirma o pedido
 * duas vezes nem baixa estoque de novo —, e a cobrança tem de ser da operação
 * que o token provou.
 *
 * ## As três portas que chegam aqui (GAP-PRD-002)
 *
 *   - `POST /loja/webhooks/payments/:provider/:companyId` — a URL POR
 *     OPERAÇÃO, a que a tela de Integrações manda cadastrar;
 *   - `POST /loja/webhooks/payments/:provider` — sem empresa na URL;
 *   - `POST /webhooks/asaas` — a URL que o painel do Asaas da loja JÁ TEM
 *     cadastrada. Ela gravava o evento numa coleção legada e devolvia 200: o
 *     dinheiro entrava e nada era baixado, e o Asaas, tendo recebido 2xx, não
 *     reenviava. Agora entra aqui, pelo mesmo processamento.
 *
 * Nas duas sem empresa, quem diz de quem é o evento é o token.
 */
export function handlePaymentWebhook(input: {
  provider: string;
  token?: string;
  payload: Record<string, unknown>;
  /**
   * Operação dona do webhook, quando a URL a identifica.
   *
   * Cada operação registra a própria URL no painel do Asaas, com o próprio
   * token. Sem isso o token teria de ser um só para as seis — e o token de uma
   * empresa valeria para confirmar o pedido de outra.
   */
  companyId?: string;
}): { accepted: boolean; duplicated: boolean; detail: string } {
  ensureCoreSchema();

  /*
    ================================================================
    A ROTA SEM EMPRESA PERGUNTA AO TOKEN DE QUEM ELE É
    ================================================================

    Sem `companyId` na URL, o token era comparado com o do AMBIENTE — e a
    conferência de tenant, logo abaixo, era curto-circuitada. Quem tivesse o
    token do `.env` marcava como pago o pedido de QUALQUER uma das seis
    operações.

    A saída não é adivinhar a empresa: é perguntar ao token.
    `findCompanyByAsaasWebhookToken` faz isso em tempo constante. Conhecer o
    token PROVA de quem é o evento; é para isso que ele serve.

    O token do AMBIENTE sobra como atalho de desenvolvimento, com dois cercos
    (GAP-PRD-113): em produção ele não vale (pelos dois nomes de produção), e
    fora dela não vale para cobrança de operação que já tem token próprio.
  */
  const companyIdDaUrl = input.companyId ?? null;
  const companyIdDoToken =
    !companyIdDaUrl && input.token ? findCompanyByAsaasWebhookToken(input.token) : null;
  const companyId = companyIdDaUrl ?? companyIdDoToken;

  const expected = companyId
    ? getAsaasWebhookToken(companyId)
    : asaasEnvFallbackAllowed()
      ? secretProvider.getAsaasWebhookToken()
      : null;

  // SEM TOKEN CONFIGURADO, RECUSA -- não dispensa.
  //
  // A comparação abaixo só prova alguma coisa se existir com o que comparar.
  // Enquanto isto era `if (expected && ...)`, operação sem token cadastrado
  // caía fora do `if` inteiro e o evento entrava sem nenhuma prova de origem.
  //
  // 503 e não 401: a falha é nossa, não de quem chamou. O Asaas repete evento
  // que não recebeu 2xx, então o que chegar antes de alguém colar o token volta
  // sozinho depois. EXCEÇÃO: na rota sem empresa, se EXISTE token cadastrado e
  // o informado não é nenhum deles, a resposta é 401 — "compare com o do
  // Asaas" —, e não "salve o token", que mandaria gravar de novo o valor errado.
  if (!expected) {
    if (!companyIdDaUrl && existeTokenDeWebhookCadastrado()) {
      throw new ApiError('API_WEBHOOK_UNAUTHORIZED', 'Token de webhook inválido.', 401);
    }
    throw new ApiError(
      'API_WEBHOOK_UNCONFIGURED',
      'Webhook sem token configurado para esta operação: nada a conferir, nada é aceito.',
      503,
    );
  }
  if (input.token !== expected) {
    throw new ApiError('API_WEBHOOK_UNAUTHORIZED', 'Token de webhook inválido.', 401);
  }

  const event = input.payload as { id?: string; event?: string; payment?: Record<string, unknown> };
  const nomeDoEvento = String(event.event ?? '');
  const providerRef = String(event.payment?.id ?? '');
  /*
    O IDENTIFICADOR DO EVENTO (GAP-PRD-091, a mesma família).

    O formato antigo do webhook do Asaas não traz `id` próprio. O fallback era
    o id da COBRANÇA — igual para o `PAYMENT_CREATED` e para o
    `PAYMENT_RECEIVED` da mesma cobrança —, e o recebimento chegava como
    "Evento já recebido": dinheiro na conta, título em aberto. Sem `id`, o
    evento é identificado pelo PAR tipo + cobrança.
  */
  const eventId = event.id
    ? String(event.id)
    : providerRef && nomeDoEvento
      ? `${nomeDoEvento}:${providerRef}`
      : '';
  if (!eventId) {
    throw new ApiError('API_WEBHOOK_INVALID', 'Evento sem identificador.', 400);
  }

  const db = getConnection();
  const already = db
    .prepare('SELECT id, processed FROM core_payment_webhooks WHERE provider = ? AND event_id = ?')
    .get(input.provider, eventId) as { id: string; processed: number } | undefined;
  /*
    SÓ EVENTO PROCESSADO É DUPLICATA.

    A linha do webhook é gravada ANTES de processar, para que o provedor nunca
    receba 200 por um evento que o ERP não guardou. Processada, descarta; não
    processada, RETOMA — é a segunda chance que o reenvio do provedor existe
    para dar.
  */
  if (already && already.processed === 1) {
    return { accepted: true, duplicated: true, detail: 'Evento já recebido.' };
  }

  const webhookId = already?.id ?? randomUUID();
  if (!already) {
    db.prepare(
      `INSERT INTO core_payment_webhooks
         (id, provider, event_id, event_type, payload, processed, received_at, company_id)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
    ).run(
      webhookId,
      input.provider,
      eventId,
      nomeDoEvento,
      JSON.stringify(input.payload),
      new Date().toISOString(),
      companyId,
    );
  }

  try {
    /*
      UMA TRANSAÇÃO PARA O EFEITO INTEIRO. A intenção só vira `confirmed` se
      a baixa do título ou o pagamento do pedido também forem gravados; se
      qualquer parte falhar, nada fica pela metade e a linha do webhook
      continua `processed = 0`, esperando a próxima entrega.
    */
    const detail = withTransaction(() => {
      const regra = EVENTOS_ASAAS[nomeDoEvento];
      let texto = 'Evento registrado sem efeito.';
      let empresaDoEvento = companyId;

      if (regra && providerRef) {
        let intent = db
          .prepare('SELECT * FROM core_payment_intents WHERE provider_ref = ?')
          .get(providerRef) as unknown as PaymentIntent | undefined;
        /*
          AS PARCELAS 2..N DO CARTÃO (GAP-PRD-114). O provedor cria uma
          cobrança por parcela, todas com o mesmo `installment`; a intenção
          guarda o id da primeira e o do plano. Sem esta busca, a confirmação
          que chegasse primeiro por outra parcela morria em "Cobrança não
          encontrada no ERP".
        */
        const plano = String(event.payment?.installment ?? '');
        if (!intent && plano) {
          intent = db
            .prepare('SELECT * FROM core_payment_intents WHERE provider_installment_ref = ?')
            .get(plano) as unknown as PaymentIntent | undefined;
        }
        const orfa = intent ? undefined : intencaoPelaReferenciaExterna(event.payment, companyId);
        intent = intent ?? orfa;

        if (!intent) {
          texto = 'Cobrança não encontrada no ERP.';
        } else if (companyId && intent.company_id !== companyId) {
          // Webhook de uma operação não confirma a cobrança de outra, mesmo com
          // token válido: o token prova QUEM chamou, não sobre o que pode agir.
          throw new ApiError(
            'API_WEBHOOK_TENANT_MISMATCH',
            'Cobrança pertence a outra operação.',
            403,
          );
        } else if (!companyId && temTokenDeWebhookProprio(intent.company_id)) {
          // O token do AMBIENTE não atravessa para operação que tem o dela
          // (GAP-PRD-113): quem cadastrou o próprio token é conferido por ele.
          throw new ApiError(
            'API_WEBHOOK_TENANT_MISMATCH',
            'Cobrança pertence a uma operação com token próprio: o token do ambiente não vale para ela.',
            403,
          );
        } else {
          empresaDoEvento = intent.company_id;
          if (orfa) {
            // A cobrança que a resposta perdida não trouxe (GAP-PRD-049).
            db.prepare(
              'UPDATE core_payment_intents SET provider_ref = ?, updated_at = ? WHERE id = ? AND provider_ref IS NULL',
            ).run(providerRef, new Date().toISOString(), orfa.id);
            intent = reloadIntent(orfa.id);
          }
          texto = aplicarEventoNaCobranca({
            intent,
            regra,
            nomeDoEvento,
            pagamento: event.payment,
            providerRef,
          });
        }
      }

      db.prepare(
        `UPDATE core_payment_webhooks
            SET processed = 1, processed_at = ?, error = NULL, company_id = COALESCE(company_id, ?)
          WHERE id = ?`,
      ).run(new Date().toISOString(), empresaDoEvento, webhookId);
      return texto;
    });

    return { accepted: true, duplicated: false, detail };
  } catch (err) {
    /*
      A falha fica na linha, e é RELANÇADA. Engolir aqui devolveria 200 ao
      provedor, que pararia de reenviar — e a linha com processed = 0 ficaria
      para sempre. Sem 2xx, o Asaas tenta de novo; com a retomada acima, a
      próxima tentativa termina o serviço.
    */
    const motivo = err instanceof Error ? err.message : String(err);
    db.prepare('UPDATE core_payment_webhooks SET error = ? WHERE id = ?').run(motivo, webhookId);
    throw err;
  }
}
