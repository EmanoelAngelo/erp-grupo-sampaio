/**
 * Homologação Asaas Sandbox — orquestrador real via Central de Integrações.
 */

import { randomUUID } from 'node:crypto';
import { getConnection } from '../../db/sqlite.js';
import { ApiError } from '../../utils/errors.js';
import { AsaasHttpClient } from '../asaas/AsaasHttpClient.js';
import {
  enqueueOperationalAttempt,
  processOperationalAttempt,
} from '../asaas/AsaasOperationalService.js';
import {
  getAsaasApiKey,
  getAsaasCredentialStatus,
  getAsaasWebhookToken,
} from './AsaasCredentialService.js';
import { getAsaasIntegrationState, upsertAsaasIntegrationState } from './AsaasIntegrationStateService.js';
import { diaDaLoja } from '../core/CalendarioOperacional.js';
import { handlePaymentWebhook, montarCobrancaAsaas } from '../core/PaymentService.js';
import { eventoDoStatusDoProvedor } from '../core/AsaasSincronizacao.js';
import { AVISO_LOCAL_DA_HOMOLOGACAO, describeAsaasWebhook } from '../core/AsaasWebhookInfo.js';

export type HomologationStepStatus =
  | 'pending'
  | 'running'
  | 'success'
  | 'error'
  | 'not_applicable'
  | 'awaiting_external';

export type HomologationStep = {
  key: string;
  label: string;
  category: string;
  status: HomologationStepStatus;
  message?: string;
};

const HOMOLOGATION_TAG = 'DEVORA_HOMOLOGATION';
const TEST_CPF = '24971563792';

function scopeFrom(input: {
  companyId: string;
  storeId?: string;
  operationalUnitId?: string;
}) {
  return {
    companyId: input.companyId,
    storeId: input.storeId,
    operationalUnitId: input.operationalUnitId ?? input.storeId,
  };
}

function clientFor(scope: ReturnType<typeof scopeFrom>, correlationId?: string) {
  return new AsaasHttpClient({
    environment: 'sandbox',
    companyId: scope.companyId,
    storeId: scope.storeId,
    operationalUnitId: scope.operationalUnitId,
    correlationId,
  });
}

function ensureSandboxCredential(companyId: string, scope: ReturnType<typeof scopeFrom>): void {
  const creds = getAsaasCredentialStatus(companyId, scope);
  const key = getAsaasApiKey(companyId, 'sandbox', scope);
  if (!creds.sandbox.configured && !key) {
    throw new ApiError('ASAAS_CREDENTIAL_MISSING', 'CONFIGURAÇÃO: AGUARDANDO CREDENCIAL', 400);
  }
}

export function buildAsaasHomologationChecklist(state: Record<string, unknown>, credentials: ReturnType<typeof getAsaasCredentialStatus>): HomologationStep[] {
  const steps = (state.homologationSteps as HomologationStep[] | undefined) ?? [];
  const byKey = new Map(steps.map((s) => [s.key, s]));

  const def = (key: string, label: string, category: string, fallback: HomologationStepStatus = 'pending'): HomologationStep => {
    const existing = byKey.get(key);
    return existing ?? { key, label, category, status: fallback };
  };

  const credOk = credentials.sandbox.configured ? 'success' : 'pending';
  const connOk = state.connectionVerified ? 'success' : (credentials.sandbox.configured ? 'pending' : 'pending');

  return [
    def('credential', 'Credencial Sandbox', 'CONFIGURAÇÃO', credOk as HomologationStepStatus),
    def('environment', 'Ambiente Sandbox', 'CONFIGURAÇÃO', credentials.sandbox.configured ? 'success' : 'pending'),
    def('connection', 'API Asaas', 'CONEXÃO', connOk as HomologationStepStatus),
    def('customer_create', 'Criação cliente', 'CLIENTES'),
    def('customer_lookup', 'Consulta cliente', 'CLIENTES'),
    def('pix_charge', 'Cobrança PIX', 'PIX'),
    def('pix_qrcode', 'QR Code PIX', 'PIX'),
    def('boleto_charge', 'Cobrança boleto', 'BOLETO'),
    def('boleto_identification', 'Linha digitável/URL', 'BOLETO'),
    def('checkout', 'Checkout seguro', 'CHECKOUT'),
    def('idempotency', 'Idempotência', 'SEGURANÇA'),
    // GAP-PRD-169: os quatro abaixo passaram a EXECUTAR o que o rótulo diz —
    // ou a dizer, com honestidade, que não há o que executar no sandbox.
    def('ar_bridge', 'Cobrança do título (corpo do ERP)', 'ERP'),
    def('reconciliation', 'Consulta da conciliação', 'ERP'),
    def('ecommerce_bridge', 'Pedido online', 'ERP'),
    def('webhook_local', 'Webhook do ERP (token da operação)', 'WEBHOOK'),
    def('webhook_external', 'Aviso do Asaas chegando ao servidor', 'WEBHOOK'),
  ];
}

/** O prefixo dos avisos que a própria homologação gera — nunca contam como aviso do Asaas. */
export const PREFIXO_DO_AVISO_LOCAL = AVISO_LOCAL_DA_HOMOLOGACAO;

/**
 * O AVISO DO ASAAS CHEGOU? — a prova do webhook externo (GAP-PRD-169).
 *
 * O passo "Endpoint externo" ficava verde porque `ASAAS_WEBHOOK_PUBLIC_URL`
 * tinha texto. Texto numa variável não prova que o Asaas alcança o servidor.
 * A prova é o próprio Asaas: a homologação cria cobranças de teste no
 * sandbox, e o Asaas manda o aviso delas (PAYMENT_CREATED) para a URL
 * cadastrada no painel. Se um aviso sobre ESSAS cobranças chegou por fora (e
 * não pelo passo local, que tem prefixo próprio), o caminho inteiro está
 * provado: URL pública, painel do Asaas e token da operação.
 *
 * Enquanto não chega, o passo fica `awaiting_external` — nunca verde.
 */
export function conferirAvisoExternoDaHomologacao(input: {
  companyId: string;
  storeId?: string;
  operationalUnitId?: string;
}): HomologationStep | null {
  const scope = scopeFrom(input);
  const state = getAsaasIntegrationState(scope);
  const steps = ((state.homologationSteps as HomologationStep[] | undefined) ?? []).map((s) => ({ ...s }));
  const passo = steps.find((s) => s.key === 'webhook_external');
  const sonda = state.homologationProbe as
    | { startedAt?: string; paymentIds?: string[] }
    | undefined;
  if (!passo || !sonda?.paymentIds?.length) return passo ?? null;

  const marcadores = sonda.paymentIds.map(() => '?').join(',');
  const aviso = getConnection()
    .prepare(
      `SELECT event_type, received_at, json_extract(payload, '$.payment.id') AS cobranca
         FROM core_payment_webhooks
        WHERE company_id = ? AND provider = 'asaas'
          AND event_id NOT LIKE ?
          AND received_at >= ?
          AND json_extract(payload, '$.payment.id') IN (${marcadores})
        ORDER BY received_at LIMIT 1`,
    )
    .get(
      scope.companyId,
      `${PREFIXO_DO_AVISO_LOCAL}%`,
      sonda.startedAt ?? '',
      ...sonda.paymentIds,
    ) as { event_type: string | null; received_at: string; cobranca: string } | undefined;

  if (aviso) {
    passo.status = 'success';
    passo.message =
      `O Asaas alcançou este servidor: aviso ${aviso.event_type ?? 'de pagamento'} da cobrança de teste `
      + `${aviso.cobranca} recebido em ${aviso.received_at}, com o token da operação conferido.`;
  } else {
    const info = describeAsaasWebhook(scope.companyId);
    passo.status = 'awaiting_external';
    passo.message = info.publiclyReachable
      ? `Aguardando o aviso do Asaas sobre as cobranças de teste (${sonda.paymentIds.join(', ')}). `
        + `Confira se a URL ${info.url} está cadastrada no painel do Asaas desta operação, com o token, e confira de novo.`
      : `O endereço ${info.url} não é alcançável de fora: o Asaas não consegue avisar este servidor. `
        + 'Defina GRUPO_SAMPAIO_PUBLIC_URL (ou ASAAS_WEBHOOK_PUBLIC_URL) com o endereço HTTPS público da API e reinicie.';
  }
  upsertAsaasIntegrationState(scope, { homologationSteps: steps });
  return passo;
}

export function mapAsaasConnectionError(err: unknown): Record<string, unknown> {
  if (err instanceof ApiError) {
    if (err.code === 'ASAAS_CREDENTIAL_MISSING') {
      return { ok: false, code: err.code, message: 'Credencial não configurada. Salve a API Key Sandbox primeiro.' };
    }
    if (err.code === 'ASAAS_DISABLED') {
      return { ok: false, code: err.code, message: 'Integração Asaas desabilitada no servidor.' };
    }
    if (err.code === 'ASAAS_PRODUCTION_DISABLED') {
      return { ok: false, code: err.code, message: 'Produção bloqueada nesta etapa.' };
    }
    if (err.code === 'ASAAS_CONNECTION_FAILED') {
      return { ok: false, code: err.code, message: 'Asaas indisponível ou erro de comunicação.' };
    }
    if (err.code === 'ASAAS_REMOTE_ERROR') {
      return { ok: false, code: err.code, message: 'Credencial inválida ou rejeitada pelo Asaas Sandbox.' };
    }
    return { ok: false, code: err.code, message: 'Erro ao testar conexão com Asaas.' };
  }
  return { ok: false, code: 'ASAAS_CONNECTION_FAILED', message: 'Erro de comunicação com Asaas.' };
}

export async function testAsaasSandboxConnection(input: {
  companyId: string;
  storeId?: string;
  operationalUnitId?: string;
  correlationId?: string;
}): Promise<Record<string, unknown>> {
  const scope = scopeFrom(input);
  try {
    ensureSandboxCredential(input.companyId, scope);
  } catch (err) {
    return mapAsaasConnectionError(err);
  }

  try {
    const client = clientFor(scope, input.correlationId);
    const result = await client.testConnection();
    const now = new Date().toISOString();
    /*
      O AMBIENTE PEDIDO NÃO É DESTE TESTE (GAP-PRD-170). Esta gravação levava
      `environment: 'sandbox'` junto, e a homologação — que chama este teste
      no primeiro passo — desfazia o "Pedir produção" do dono sem avisar: ele
      homologava, e a trava CONFIGURACAO_EM_SANDBOX voltava. O teste do sandbox
      carimba o selo do sandbox; o pedido de produção é do PATCH, e só dele.
    */
    upsertAsaasIntegrationState(scope, {
      connectionVerified: true,
      lastConnectionTestAt: now,
      lastConnectionError: null,
    });
    return {
      ok: true,
      message: 'Conexão Asaas Sandbox validada.',
      environment: result.environment,
      connectionVerified: true,
      lastConnectionTestAt: now,
    };
  } catch (err) {
    const mapped = mapAsaasConnectionError(err);
    upsertAsaasIntegrationState(scope, {
      connectionVerified: false,
      lastConnectionTestAt: new Date().toISOString(),
      lastConnectionError: mapped.message,
    });
    return mapped;
  }
}

/**
 * O MOTIVO QUE O ASAAS DEVOLVEU — e que se perdia no caminho (rodada 63).
 *
 * O `AsaasHttpClient` levanta `ApiError('ASAAS_REMOTE_ERROR', 'Erro Asaas
 * 400', 400, data)` e guarda a resposta inteira em `details`. É lá que mora a
 * explicação: o Asaas responde uma lista `errors`, cada uma com `code` e
 * `description`, e a `description` é a frase que diz o que consertar.
 *
 * A homologação gravava só `err.message` — o genérico "Erro Asaas 400" —, e o
 * dono lia na tela que a homologação não passou, sem nada sobre o motivo. Um
 * código HTTP sozinho não conserta nada; a frase do provedor conserta.
 *
 * O código continua no fim, entre parênteses, para quem for procurar no manual.
 */
export function motivoDoErroAsaas(err: unknown): string {
  if (err instanceof ApiError) {
    const detalhes = err.details as { errors?: { description?: string }[] } | undefined;
    const descricoes = (detalhes?.errors ?? [])
      .map((e) => String(e?.description ?? '').trim())
      .filter(Boolean);
    if (descricoes.length > 0) {
      // Várias reclamações viram uma frase só: perder qualquer uma faria o
      // dono consertar metade e voltar a falhar pela outra.
      return `${descricoes.join(' · ')} (${err.message})`;
    }
    return err.message;
  }
  return err instanceof Error ? err.message : 'Erro na etapa.';
}

async function runStep(
  steps: HomologationStep[],
  key: string,
  fn: () => Promise<string | void>,
): Promise<void> {
  const step = steps.find((s) => s.key === key);
  if (!step) return;
  step.status = 'running';
  try {
    const msg = await fn();
    step.status = 'success';
    if (msg) step.message = msg;
  } catch (err) {
    step.status = 'error';
    // A explicação do provedor, e não o código HTTP sozinho.
    step.message = motivoDoErroAsaas(err);
    throw err;
  }
}

export async function runAsaasSandboxHomologation(input: {
  companyId: string;
  storeId?: string;
  operationalUnitId?: string;
  correlationId?: string;
  userId?: string;
}): Promise<Record<string, unknown>> {
  const scope = scopeFrom(input);
  ensureSandboxCredential(input.companyId, scope);

  const credentials = getAsaasCredentialStatus(input.companyId, scope);
  /*
    PASSOS NOVOS A CADA CORRIDA (GAP-PRD-169). A lista nascia do estado
    gravado da corrida ANTERIOR: se a de hoje parasse no terceiro passo, os
    seguintes continuavam verdes da de ontem — passo verde sem verificação
    executada. Cada corrida começa do zero.
  */
  const steps = buildAsaasHomologationChecklist({}, credentials);
  const inicio = new Date().toISOString();

  upsertAsaasIntegrationState(scope, {
    homologationStatus: 'running',
    homologationSteps: steps,
    homologationProbe: null,
    lastHomologationAt: inicio,
  });

  const homologationId = `asaas-hom-${Date.now()}`;
  let sandboxHomologated = false;
  let overallError: string | null = null;

  try {
    await runStep(steps, 'connection', async () => {
      const conn = await testAsaasSandboxConnection(input);
      if (!conn.ok) throw new ApiError(String(conn.code ?? 'ASAAS_CONNECTION_FAILED'), String(conn.message), 502);
      return 'Conexão Sandbox OK';
    });

    const client = clientFor(scope, input.correlationId);
    let customerId: string | undefined;
    let pixPaymentId: string | undefined;
    let boletoPaymentId: string | undefined;

    await runStep(steps, 'customer_create', async () => {
      /*
        O CLIENTE NASCE COMPLETO — porque o checkout exige (rodada 63).

        Ele nascia com nome e CPF, que basta para PIX e boleto: os nove
        primeiros passos passavam. O `POST /checkouts` recusava com 400 e sete
        reclamações — "o campo email deve existir para o customer informado", e
        o mesmo para phone, address, addressNumber, postalCode, province e
        city —, derrubando a homologação e os seis passos seguintes.

        Os dados são de TESTE e ficam no sandbox: nenhuma pessoa real, nenhum
        endereço real. O CPF já era o de teste; o resto acompanha.
      */
      const customer = await client.createCustomer({
        name: `${HOMOLOGATION_TAG} Cliente Teste`,
        cpfCnpj: TEST_CPF,
        email: 'homologacao@exemplo.com.br',
        // DDD + número, sem o 55 do país: o Asaas recusa o celular com o
        // código internacional na frente ("O celular informado é inválido").
        phone: '5333333333',
        mobilePhone: '53991234567',
        address: 'Rua de Teste da Homologacao',
        addressNumber: '100',
        province: 'Centro',
        postalCode: '96010000',
        externalReference: `${HOMOLOGATION_TAG}-${randomUUID()}`,
        observations: HOMOLOGATION_TAG,
      }) as Record<string, unknown>;
      customerId = String(customer.id);
      // O id do cliente de teste fica na mensagem do passo, gravada no estado
      // da integração e devolvida à tela. A coleção `asaas_sandbox_homologations`
      // que o repetia não tinha leitor e foi aposentada (GAP-PRD-075).
      return `Cliente ${customerId}`;
    });

    await runStep(steps, 'customer_lookup', async () => {
      const row = await client.getCustomer(String(customerId)) as Record<string, unknown>;
      if (!row.id) throw new ApiError('ASAAS_HOMOLOGATION_FAILED', 'Cliente não encontrado.', 502);
      return 'Consulta OK';
    });

    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + 3);

    await runStep(steps, 'pix_charge', async () => {
      const payment = await client.createPayment({
        customer: customerId,
        billingType: 'PIX',
        value: 10.5,
        dueDate: diaDaLoja(dueDate),
        externalReference: `${HOMOLOGATION_TAG}-pix-${randomUUID()}`,
        description: HOMOLOGATION_TAG,
      }) as Record<string, unknown>;
      pixPaymentId = String(payment.id);
      return `PIX ${pixPaymentId}`;
    });

    await runStep(steps, 'pix_qrcode', async () => {
      const qr = await client.getPixQrCode(String(pixPaymentId)) as Record<string, unknown>;
      if (!(qr.encodedImage ?? qr.payload)) {
        throw new ApiError('ASAAS_HOMOLOGATION_FAILED', 'QR Code PIX não retornado.', 502);
      }
      return 'QR Code OK';
    });

    await runStep(steps, 'boleto_charge', async () => {
      const payment = await client.createPayment({
        customer: customerId,
        billingType: 'BOLETO',
        value: 25,
        dueDate: diaDaLoja(dueDate),
        externalReference: `${HOMOLOGATION_TAG}-boleto-${randomUUID()}`,
        description: HOMOLOGATION_TAG,
      }) as Record<string, unknown>;
      boletoPaymentId = String(payment.id);
      return `Boleto ${boletoPaymentId}`;
    });

    await runStep(steps, 'boleto_identification', async () => {
      const field = await client.getIdentificationField(String(boletoPaymentId)) as Record<string, unknown>;
      if (!(field.identificationField ?? field.barCode)) {
        throw new ApiError('ASAAS_HOMOLOGATION_FAILED', 'Linha digitável não retornada.', 502);
      }
      return 'Linha digitável OK';
    });

    await runStep(steps, 'checkout', async () => {
      const checkout = await client.createCheckout({
        customer: customerId,
        billingTypes: ['CREDIT_CARD'],
        chargeTypes: ['DETACHED'],
        items: [{ name: `${HOMOLOGATION_TAG} Item`, value: 15, quantity: 1 }],
        callback: { successUrl: 'https://example.com/success', cancelUrl: 'https://example.com/cancel' },
      }) as Record<string, unknown>;
      if (!(checkout.id ?? checkout.url)) {
        throw new ApiError('ASAAS_HOMOLOGATION_FAILED', 'Checkout não retornado.', 502);
      }
      return 'Checkout hospedado OK — sem captura PAN/CVV';
    });

    await runStep(steps, 'idempotency', async () => {
      const idempotencyKey = `${HOMOLOGATION_TAG}-idempotent-${randomUUID()}`;
      const sourceId = `cust-local-${randomUUID()}`;
      const first = enqueueOperationalAttempt({
        companyId: input.companyId,
        storeId: scope.storeId,
        operationType: 'asaas_customer_sync',
        sourceType: 'customer',
        sourceId,
        idempotencyKey,
        correlationId: input.correlationId ?? homologationId,
        payload: { name: `${HOMOLOGATION_TAG} Idempotência`, customerId: sourceId, document: TEST_CPF },
      });
      const duplicate = enqueueOperationalAttempt({
        companyId: input.companyId,
        storeId: scope.storeId,
        operationType: 'asaas_customer_sync',
        sourceType: 'customer',
        sourceId,
        idempotencyKey,
        correlationId: input.correlationId ?? homologationId,
        payload: { name: `${HOMOLOGATION_TAG} Idempotência`, customerId: sourceId, document: TEST_CPF },
      });
      if (duplicate.id !== first.id) throw new ApiError('ASAAS_HOMOLOGATION_FAILED', 'Idempotência falhou.', 502);
      await processOperationalAttempt(String(first.id), input.companyId);
      return 'Idempotência validada';
    });

    /*
      ============================================================
      OS PASSOS DO ERP — cada verde é uma verificação executada (GAP-PRD-169)
      ============================================================

      Antes: "Contas a Receber" rodava a fila legada (que não é o caminho do
      título), e "Conciliação" e "E-commerce" viravam verdes por atribuição,
      com as frases fixas "Estrutura de conciliação CP59 disponível" e "Bridge
      e-commerce CP61 compatível". A tela dizia que a homologação "escreve em
      Contas a Receber, concilia e recebe o próprio webhook".

      Agora nenhum dado do ERP é inventado (nenhum título é criado no Contas a
      Receber da operação por um teste), e o que se prova é o que o sandbox
      pode provar:
    */
    await runStep(steps, 'ar_bridge', async () => {
      // O CORPO que o título manda (`montarCobrancaAsaas`, o mesmo de
      // `requestAsaasCharge`), aceito pelo provedor desta conta, e a
      // referência externa de volta — é por ela que o webhook e a procura de
      // órfãs acham a cobrança. Cancelada em seguida: nada fica vivo.
      const origem = `${HOMOLOGATION_TAG}-titulo-${randomUUID()}`;
      const criada = await client.createPayment(
        montarCobrancaAsaas({
          asaasCustomerId: customerId,
          method: 'pix',
          amountCents: 1050,
          dueDate: diaDaLoja(dueDate),
          description: `${HOMOLOGATION_TAG} cobrança do título`,
          originId: origem,
        }),
      ) as Record<string, unknown>;
      const id = String(criada.id ?? '');
      if (!id) throw new ApiError('ASAAS_HOMOLOGATION_FAILED', 'O provedor não devolveu o id da cobrança.', 502);
      if (String(criada.externalReference ?? '') !== origem) {
        throw new ApiError(
          'ASAAS_HOMOLOGATION_FAILED',
          'O provedor não devolveu a referência externa: o ERP não conseguiria achar esta cobrança pelo título.',
          502,
        );
      }
      await client.cancelPayment(id);
      return `O Asaas aceitou a cobrança montada pelo mesmo código do título (${id}) e devolveu a referência `
        + 'que o ERP usa para achá-la; ela foi cancelada em seguida. Nenhum título foi criado no Contas a Receber.';
    });

    await runStep(steps, 'reconciliation', async () => {
      // A MESMA pergunta da conciliação com o provedor (`GET /payments/:id`)
      // e a MESMA tradução de status (`eventoDoStatusDoProvedor`): um status
      // que a conciliação não conhecesse seria dinheiro que ela não aplicaria.
      const remota = await client.getPayment(String(pixPaymentId)) as Record<string, unknown>;
      const status = String(remota.status ?? '');
      const evento = eventoDoStatusDoProvedor(status);
      if (!evento) {
        throw new ApiError(
          'ASAAS_HOMOLOGATION_FAILED',
          `O provedor respondeu o status "${status}", que a conciliação não sabe traduzir.`,
          502,
        );
      }
      return `A consulta que a conciliação faz respondeu a cobrança ${pixPaymentId} em ${status} `
        + `(a conciliação a lê como ${evento}).`;
    });

    const ecomStep = steps.find((s) => s.key === 'ecommerce_bridge')!;
    ecomStep.status = 'not_applicable';
    ecomStep.message =
      'Não há chamada própria do pedido online para exercitar no sandbox: ele cobra pelo mesmo cliente '
      + 'e pelos mesmos meios provados acima (PIX, boleto e checkout). O fluxo do pedido é coberto pelos '
      + 'testes automáticos do sistema.';

    await runStep(steps, 'webhook_local', async () => {
      // O caminho REAL do aviso (`handlePaymentWebhook`), com o token DESTA
      // operação — o mesmo que o Asaas vai mandar. Sem token cadastrado o ERP
      // recusa todo aviso (503), e a homologação precisa dizer isso agora, e
      // não na primeira cobrança paga.
      const token = getAsaasWebhookToken(input.companyId, {
        storeId: scope.storeId,
        operationalUnitId: scope.operationalUnitId,
      });
      if (!token) {
        throw new ApiError(
          'ASAAS_WEBHOOK_TOKEN_MISSING',
          'Falta o token do webhook desta operação: sem ele o ERP recusa todo aviso do Asaas. '
            + 'Guarde o token em Credenciais e rode de novo.',
          400,
        );
      }
      const r = handlePaymentWebhook({
        provider: 'asaas',
        token,
        companyId: input.companyId,
        payload: {
          id: `${PREFIXO_DO_AVISO_LOCAL}${randomUUID()}`,
          event: 'PAYMENT_CREATED',
          payment: { id: pixPaymentId, customer: customerId, value: 10.5 },
        },
      });
      if (!r.accepted) throw new ApiError('ASAAS_HOMOLOGATION_FAILED', r.detail, 502);
      return `O ERP recebeu e registrou o aviso pelo mesmo caminho que o Asaas usa, com o token da operação conferido (${r.detail})`;
    });

    // O AVISO DE FORA: as cobranças de teste acabaram de nascer no sandbox, e o
    // Asaas avisa a URL cadastrada. A prova é a chegada — conferida agora e
    // de novo quando o dono pedir (`conferirAvisoExternoDaHomologacao`).
    upsertAsaasIntegrationState(scope, {
      homologationSteps: steps,
      homologationProbe: {
        startedAt: inicio,
        paymentIds: [pixPaymentId, boletoPaymentId].filter(Boolean),
      },
    });
    const externo = conferirAvisoExternoDaHomologacao(scope);
    const extStep = steps.find((s) => s.key === 'webhook_external')!;
    if (externo) {
      extStep.status = externo.status;
      extStep.message = externo.message;
    }

    /*
      Homologado = nenhum passo caiu e nenhum ficou sem rodar. O aviso de fora
      pode estar a caminho (`awaiting_external`): ele não segura o selo do
      sandbox — o card do webhook e este passo continuam dizendo que ainda não
      chegou.
    */
    sandboxHomologated = steps.every(
      (s) => s.status === 'success' || s.status === 'not_applicable' || s.status === 'awaiting_external',
    );

  } catch (err) {
    overallError = err instanceof ApiError ? err.message : 'Homologação interrompida.';
  }

  const homologationStatus = sandboxHomologated ? 'homologated' : (overallError ? 'error' : 'partial');
  upsertAsaasIntegrationState(scope, {
    homologationStatus,
    sandboxHomologated,
    homologationSteps: steps,
    lastHomologationAt: new Date().toISOString(),
    homologationId,
  });

  /*
    UMA TRILHA SÓ (GAP-PRD-075). Esta função gravava a corrida duas vezes fora
    do núcleo — um resumo em `asaas_sandbox_homologations` e uma linha em
    `integration_audit_entries` —, que ninguém lia; a rota que a chama
    (`POST /core/integrations/asaas/homologar`) já registra a corrida em
    `core_audit_log`, com o id e o resultado, e o estado da integração guarda
    os passos. As duas coleções foram aposentadas, e o passo 85 copia as linhas
    antigas para `core_audit_log`.
  */
  return {
    ok: sandboxHomologated,
    /*
      O CONTRATO QUE A TELA LÊ (GAP-PRD-169). A tela pergunta
      `status === 'passed'`; o serviço devolvia só `homologationStatus`, e a
      homologação que PASSAVA aparecia como "não passou" — o teste da rota
      espiava o serviço com um `status` que ele nunca mandou.
    */
    status: sandboxHomologated ? 'passed' : overallError ? 'failed' : 'partial',
    homologationId,
    sandboxHomologated,
    homologationStatus,
    steps,
    message: sandboxHomologated
      ? 'ASAAS SANDBOX HOMOLOGADO'
      : (overallError ?? 'Homologação incompleta — verifique checklist.'),
    productionBlocked: true,
  };
}

/*
  Aqui morava `getAsaasIntegrationPanel`, o painel que só o roteador
  `/integrations` servia (GAP-PRD-075). O painel que a tela lê é
  `GET /core/integrations/asaas`.
*/
