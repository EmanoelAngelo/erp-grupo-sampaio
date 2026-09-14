import { findOneRow, findRows, insertRow } from '../../db/database.js';
import { loadEnv } from '../../config/env.js';
import { buildLogisticsReadinessChecklist } from './LogisticsReadinessService.js';
import {
  getLogisticsCredentialRow,
  listLogisticsCredentialRefs,
  sanitizeLogisticsCredentialForResponse,
  upsertLogisticsCredentials,
} from './LogisticsCredentialService.js';
import {
  processoDeProducao,
  quoteAllCarriers,
  quoteLogisticsCarrier,
  resolveCarrierAccess,
  testLogisticsCarrierConnection,
  trackLogisticsCarrier,
  type LogisticsQuoteOptionResult,
} from './LogisticsCarrierAdapter.js';
import type { LogisticsCarrierId } from './LogisticsCredentialService.js';

export { upsertLogisticsCredentials, listLogisticsCredentialRefs, sanitizeLogisticsCredentialForResponse };

/**
 * Sonda pública, sem empresa: diz só o que vale para o PROCESSO. Se uma
 * operação cota em produção depende da credencial dela — isso está na
 * prontidão, que tem sessão.
 */
export function logisticsHealth() {
  const env = loadEnv();
  return {
    status: 'ok',
    module: 'logistics',
    externalEnabled: env.logisticsExternalEnabled,
    // Era `false` fixo. É a permissão do processo para falar com a produção
    // das transportadoras; a credencial de cada operação é a outra metade.
    productionEnabled: env.logisticsProductionEnabled,
    homologationEnabled: !processoDeProducao(),
    productionBlocked: !env.logisticsProductionEnabled,
  };
}

export function logisticsReadiness(companyId: string) {
  const checklist = buildLogisticsReadinessChecklist(companyId);
  return {
    companyId,
    readyForHomologation: checklist.overallStatus === 'ready_for_homologation',
    // Era `false` fixo: nenhuma credencial jamais tiraria a tela do "bloqueado".
    readyForProduction: checklist.checkoutCarrier.active,
    productionBlocked: checklist.productionBlocked,
    processProductionEnabled: checklist.processProductionEnabled,
    externalEnabled: checklist.externalEnabled,
    overallStatus: checklist.overallStatus,
    providers: checklist.providers,
    blockingReasons: checklist.blockingReasons,
    checkoutCarrier: checklist.checkoutCarrier,
  };
}

/**
 * O estado de cada transportadora, para a tabela da tela.
 *
 * ABRIR A TELA NÃO CHAMA O PROVEDOR (GAP-PRD-126). Esta função testava a
 * conexão de cada transportadora configurada a cada GET — uma chamada HTTP por
 * visita, sobrescrevendo o resultado do último teste. E era dela que a coluna
 * "Conexão: Real" saía, enquanto o checkout, pelo outro caminho, não chamava
 * ninguém. Agora a coluna mostra o último teste GUARDADO, e testar é o botão
 * "Testar conexão" — um ato do gestor, com resultado que fica.
 */
export async function logisticsProvidersStatus(companyId: string) {
  const creds = listLogisticsCredentialRefs(companyId);
  const carriers: LogisticsCarrierId[] = ['correios', 'jadlog', 'melhor_envio'];
  const items = carriers.map((carrier) => {
    const row = getLogisticsCredentialRow(companyId, carrier);
    const cred = row ? sanitizeLogisticsCredentialForResponse(row) : creds.find((c) => c.carrier === carrier);
    const access = resolveCarrierAccess(companyId, carrier);
    const legado = String(cred?.lastTestStatus ?? '');
    const status = cred?.connectionStatus ?? (legado === 'connection_ok' ? 'ok' : legado === 'connection_failed' ? 'failed' : null);
    const tested = status === 'ok' || status === 'failed';
    const connection = !access.configured
      ? { ok: false, real: false, simulated: false, tested: false, message: 'Não configurado.' }
      : access.mode === 'simulated'
        ? { ok: false, real: false, simulated: true, tested: false, message: 'Sem integração direta: só simulação.' }
        : {
          ok: status === 'ok',
          real: tested,
          simulated: false,
          tested,
          testedAt: cred?.connectionTestedAt ?? null,
          message: (cred?.connectionMessage as string | null | undefined)
            ?? (tested ? undefined : 'Ainda não testada com esta credencial.'),
        };
    return {
      carrier,
      configured: access.configured,
      environment: access.environment ?? 'homologation',
      maskedHint: cred?.maskedHint ?? null,
      contactEmail: cred?.contactEmail ?? null,
      updatedAt: cred?.updatedAt ?? null,
      lastTestAt: cred?.lastTestAt,
      lastTestStatus: cred?.lastTestStatus,
      lastQuote: cred?.lastQuoteStatus
        ? { ok: cred.lastQuoteStatus === 'ok', at: cred.lastQuoteAt ?? null, message: cred.lastQuoteMessage ?? null }
        : null,
      connection,
      access,
      productionBlocked: !access.chargeable,
    };
  });
  return { items, productionBlocked: !items.some((i) => i.access.chargeable) };
}

/**
 * A linha do Melhor Envio na tela Integrações.
 *
 * Era um objeto FIXO em `core.ts` — `configured: false`, "Token sandbox e
 * produção" — que continuaria dizendo "aguardando credencial" depois de o
 * gestor guardar o token pela tela Logística. Agora sai do mesmo `access` que
 * decide a cotação.
 */
export function melhorEnvioIntegrationStatus(companyId: string) {
  const access = resolveCarrierAccess(companyId, 'melhor_envio');
  const base = { provider: 'melhor-envio', configured: access.configured };
  switch (access.mode) {
    case 'production':
      return { ...base, environment: 'producao', readiness: 'PRODUCTION_ENABLED', missing: 'Nada: a cotação de produção vale no checkout.' };
    case 'sandbox':
      return {
        ...base,
        environment: 'sandbox',
        readiness: 'READY_FOR_SANDBOX_TEST',
        missing: 'Token de produção (o de sandbox só confere, não cobra). Loja → Logística.',
      };
    case 'blocked':
      return access.locks.includes('PRODUCAO_DESABILITADA_NO_PROCESSO')
        ? {
          ...base,
          environment: 'producao',
          readiness: 'BLOCKED_BY_PROCESS',
          missing: 'LOGISTICS_PRODUCTION_ENABLED=true no servidor — o token de produção já está guardado.',
        }
        : { ...base, environment: 'sandbox', readiness: 'READY_FOR_CREDENTIAL', missing: 'Token de produção (servidor de produção não usa sandbox).' };
    default:
      return {
        ...base,
        environment: 'producao',
        readiness: 'READY_FOR_CREDENTIAL',
        missing: 'Token de produção do Melhor Envio, colado em Loja → Logística.',
      };
  }
}

export function getLogisticsQuoteById(companyId: string, quoteId: string) {
  // Escopo de empresa no predicado (rodada 48): o id `lgqt-<timestamp>` é
  // adivinhável por janela de tempo — sem o companyId da sessão, a cotação
  // da outra empresa (CEPs, itens, valor declarado) vazava pelo :quoteId.
  return findOneRow('logistics_quotes', (r) => r.id === quoteId && r.companyId === companyId);
}

export function createLogisticsQuote(input: Record<string, unknown>) {
  const row = {
    id: `lgqt-${Date.now()}`,
    status: 'quoted',
    createdAt: new Date().toISOString(),
    ...input,
  };
  return insertRow('logistics_quotes', row);
}

/*
  `createLogisticsShipment` e `listLogisticsShipments` moravam aqui (GAP-PRD-120):
  o primeiro gravava QUALQUER corpo na coleção `logistics_shipments` como
  "quoted" — sem pedido, sem provedor, com o `companyId` do corpo por cima; o
  segundo lia essa coleção. O envio de verdade é de um pedido e vive em
  `core_shipments` (ver `EnvioDoPedidoService`). A coleção antiga fica sem
  escritor e sem leitor; linhas antigas nela, se houver, não são pedido de
  ninguém.
*/

export function listLogisticsCarrierConfigs(companyId: string) {
  return listLogisticsCredentialRefs(companyId);
}

export async function backendLogisticsQuote(companyId: string, input: {
  originZipCode: string;
  destinationZipCode: string;
  weightGrams?: number;
  heightCm?: number;
  widthCm?: number;
  lengthCm?: number;
  declaredValueInCents?: number;
  carrier?: LogisticsCarrierId;
}) {
  // SEM DEFAULT SILENCIOSO. Antes faltava peso e o sistema assumia 500 g,
  // caixa 10×15×20 e R$ 100 declarados. O transportador cobra pelo pacote
  // real: a diferença aparece depois, com a mercadoria já vendida.
  const obrigatorios: { campo: string; valor: unknown }[] = [
    { campo: 'CEP de origem', valor: input.originZipCode },
    { campo: 'CEP de destino', valor: input.destinationZipCode },
    { campo: 'peso', valor: input.weightGrams },
    { campo: 'altura', valor: input.heightCm },
    { campo: 'largura', valor: input.widthCm },
    { campo: 'comprimento', valor: input.lengthCm },
  ];
  const faltando = obrigatorios
    .filter(({ valor }) =>
      valor === undefined || valor === null || valor === '' || Number(valor) <= 0,
    )
    .map(({ campo }) => campo)
    // CEP não é número: a checagem acima o rejeitaria por `Number('01001000')`
    // ser válido, mas string vazia já cai antes.
    .filter((campo, i, todos) => todos.indexOf(campo) === i);

  if (faltando.length > 0) {
    return {
      options: [],
      simulated: false,
      real: false,
      code: 'SHIPPING_DATA_REQUIRED',
      missing: faltando,
      message: `Não é possível cotar frete sem: ${faltando.join(', ')}.`,
    };
  }

  const req = {
    originZipCode: String(input.originZipCode),
    destinationZipCode: String(input.destinationZipCode),
    weightGrams: Number(input.weightGrams),
    heightCm: Number(input.heightCm),
    widthCm: Number(input.widthCm),
    lengthCm: Number(input.lengthCm),
    // Valor declarado zero é legítimo (amostra sem valor comercial); só não
    // pode ser inventado.
    declaredValueInCents: Number(input.declaredValueInCents ?? 0),
  };

  if (input.carrier) {
    const result = await quoteLogisticsCarrier(companyId, input.carrier, req);
    return { options: result.options ?? [], simulated: result.simulated, real: result.real, message: result.message };
  }

  /*
    SEM VARIÁVEL DE TESTE NO CAMINHO (GAP-PRD-126).

    Aqui morava `if (env.logisticsHomologationTests)`: sem essa variável — o
    padrão de qualquer instalação —, a cotação sem transportadora escolhida
    (que é a do checkout e a da página do produto) nunca chamava ninguém, nem
    com o token gravado. Agora toda transportadora COM credencial é cotada pelo
    seu próprio adapter, e o ambiente da credencial decide para onde a chamada
    vai. O preço cobrável é só o de produção; o resto chega marcado.
  */
  const carriers: LogisticsCarrierId[] = ['correios', 'jadlog', 'melhor_envio'];
  const configuradas = carriers.filter((c) => resolveCarrierAccess(companyId, c).configured);

  if (configuradas.length === 0) {
    if (processoDeProducao()) {
      return {
        options: [] as LogisticsQuoteOptionResult[],
        simulated: false,
        real: false,
        code: 'NO_CARRIER_CONFIGURED',
        message: 'Nenhuma transportadora conectada nesta operação.',
      };
    }
    return { options: quoteAllCarriers(companyId, req), simulated: true, real: false, message: 'Cotação simulada — nenhuma transportadora conectada.' };
  }

  const options: LogisticsQuoteOptionResult[] = [];
  const avisos: string[] = [];
  for (const carrier of configuradas) {
    const result = await quoteLogisticsCarrier(companyId, carrier, req);
    if (result.options) options.push(...result.options);
    if (result.message && (!result.ok || result.simulated)) avisos.push(result.message);
  }

  return {
    options,
    simulated: options.length > 0 && options.every((o) => o.simulated),
    real: options.some((o) => o.real),
    message: avisos.length > 0 ? avisos.join(' ') : undefined,
  };
}

export function getLogisticsHomologationBackend(companyId: string) {
  const items = findRows('logistics_homologation_executions', (r) => r.companyId === companyId);
  return items.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))[0] ?? null;
}

export function upsertLogisticsHomologationBackend(input: Record<string, unknown>) {
  const existing = findOneRow('logistics_homologation_executions', (r) => r.idempotencyKey === input.idempotencyKey);
  if (existing) return existing;
  return insertRow('logistics_homologation_executions', {
    id: `lghom-${Date.now()}`,
    status: 'in_progress',
    stepsCompleted: [],
    productionEnabled: false,
    createdAt: new Date().toISOString(),
    ...input,
  });
}

export async function runLogisticsHomologationBackend(companyId: string, carrier: LogisticsCarrierId, storeId?: string) {
  const env = loadEnv();
  const steps: string[] = [];
  const readiness = buildLogisticsReadinessChecklist(companyId);
  const provider = readiness.providers.find((p) => p.carrier === carrier);
  // Sem credencial não há o que homologar — com ou sem variável de teste.
  if (!provider?.configured) {
    return { status: 'pending', stepsCompleted: steps, blockingReasons: provider?.blockingReasons ?? ['Credenciais ausentes.'] };
  }

  const connection = await testLogisticsCarrierConnection(companyId, carrier, storeId);
  steps.push(connection.real ? 'connection_real' : connection.simulated ? 'connection_simulated' : 'connection_pending');

  const quote = await quoteLogisticsCarrier(companyId, carrier, {
    originZipCode: '01310100',
    destinationZipCode: '30130000',
    weightGrams: 500,
    heightCm: 10,
    widthCm: 15,
    lengthCm: 20,
    declaredValueInCents: 10000,
  }, storeId);
  steps.push(quote.real ? 'quote_real' : quote.simulated ? 'quote_simulated' : 'quote_pending');

  const track = await trackLogisticsCarrier(companyId, carrier, 'TEST-TRACK-001', storeId);
  steps.push(track.real ? 'tracking_real' : track.simulated ? 'tracking_simulated' : 'tracking_pending');

  const homologated = connection.real && quote.real;
  return {
    status: homologated ? 'homologated_partial' : 'pending_credential',
    stepsCompleted: steps,
    homologated,
    productionBlocked: !env.logisticsProductionEnabled,
    message: homologated
      ? 'Homologação parcial com chamadas reais.'
      : 'ADAPTER PREPARADO / CREDENCIAL PENDENTE — nenhuma etapa mock marcada como homologada.',
  };
}

/*
  Aqui existiram dois adaptadores "legacy compat" sem chamador:
  `upsertLogisticsCarrierCredentials` (que embrulhava
  `upsertLogisticsCredentials`, o que TODO mundo já chama direto) e
  `simulateBackendQuote` (uma cotação com peso e caixa INVENTADOS — 500g,
  10x15x20 — exatamente o default silencioso que `backendLogisticsQuote`
  recusa de propósito). Compatibilidade com um passado que ninguém chama não
  é compatibilidade; saíram MEDIDOS.
*/
