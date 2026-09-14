/**
 * Adapters logísticos do backend.
 *
 * QUEM DECIDE SE A CHAMADA É REAL, E PARA ONDE ELA VAI (GAP-PRD-030, GAP-PRD-126)
 *
 * Antes eram duas variáveis de ambiente, e as duas ao contrário do que o nome
 * dizia: `canRunRealCalls` devolvia `false` justamente com
 * `LOGISTICS_PRODUCTION_ENABLED=true`, e a cotação do checkout só chamava a
 * transportadora com `LOGISTICS_HOMOLOGATION_TESTS=true` — uma variável de
 * TESTE, que nenhuma tela mostrava. Com o token gravado, a tela dizia
 * "Conexão: Real" e o checkout seguia sem transportadora.
 *
 * Agora quem decide é a CREDENCIAL, pelo ambiente com que o gestor a guardou,
 * mais UMA trava de processo com o mesmo desenho do Asaas:
 *
 *   sem credencial                  → nada a cotar
 *   Correios / Jadlog               → simulação (não há cliente HTTP: os serviços deles chegam
 *                                     pelo Melhor Envio — GAP-PRD-118)
 *   Melhor Envio, token de sandbox  → chamada REAL ao sandbox; o preço é de
 *                                     ambiente de teste e NÃO vira cobrança
 *   Melhor Envio, token de produção → chamada REAL à produção, se o processo
 *                                     permitir (`LOGISTICS_PRODUCTION_ENABLED`);
 *                                     é a única cotação que o checkout cobra
 *
 * Toda recusa sai com um código (`locks`), e a prontidão devolve os códigos
 * para a tela dizer exatamente o que falta — inclusive o nome da variável do
 * servidor, quando é ela.
 *
 * GUARDA DE PROCESSO. Em servidor de produção (`DEVORA_API_ENV=production` ou
 * `NODE_ENV=production`), nem a simulação nem o sandbox operam: preço
 * inventado ou de ambiente de teste não aparece para cliente de verdade, nem
 * como estimativa na página do produto.
 */

import { loadEnv } from '../../config/env.js';
import {
  getLogisticsCredentialRow,
  getLogisticsCredentials,
  markCredentialTest,
  type LogisticsCarrierId,
  type LogisticsCredentialEnvironment,
} from './LogisticsCredentialService.js';
import {
  conferirContaMelhorEnvio,
  cotarMelhorEnvio,
  MelhorEnvioError,
  type MelhorEnvioAmbiente,
} from './MelhorEnvioClient.js';

export interface LogisticsQuoteRequest {
  originZipCode: string;
  destinationZipCode: string;
  weightGrams: number;
  heightCm: number;
  widthCm: number;
  lengthCm: number;
  declaredValueInCents: number;
}

/** De onde o preço veio. `null` para a simulação, que não veio de lugar nenhum. */
export type LogisticsQuoteEnvironment = 'sandbox' | 'production' | null;

export interface LogisticsQuoteOptionResult {
  carrier: LogisticsCarrierId;
  serviceCode: string;
  serviceName: string;
  priceInCents: number;
  insuranceInCents: number;
  estimatedDays: number;
  /**
   * `true` quando o número NÃO é preço de contrato: inventado pelo simulador
   * ou vindo do SANDBOX. Todo consumidor que decide cobrança já descarta
   * `simulated` — o sandbox entra aqui para herdar esse descarte.
   */
  simulated: boolean;
  /** `true` quando houve chamada HTTP de verdade ao provedor. */
  real?: boolean;
  environment?: LogisticsQuoteEnvironment;
}

export interface LogisticsAdapterResult {
  ok: boolean;
  real: boolean;
  simulated: boolean;
  pending?: boolean;
  message?: string;
  environment?: LogisticsQuoteEnvironment;
  locks?: LogisticsAccessLock[];
  options?: LogisticsQuoteOptionResult[];
  trackingEvents?: Array<{ status: string; description: string; occurredAt: string }>;
  labelReference?: string;
}

// ------------------------------------------------------------------ acesso

export type LogisticsAccessMode = 'none' | 'simulated' | 'sandbox' | 'production' | 'blocked';

/**
 * Por que a cotação desta transportadora não vale como preço cobrado.
 *
 * Os códigos são estáveis: a tela os traduz, e o teste os cobra.
 */
export type LogisticsAccessLock =
  | 'SEM_CREDENCIAL'
  | 'SEM_INTEGRACAO_DIRETA'
  | 'CREDENCIAL_DE_SANDBOX'
  | 'PRODUCAO_DESABILITADA_NO_PROCESSO'
  | 'SANDBOX_EM_SERVIDOR_DE_PRODUCAO'
  | 'SIMULACAO_EM_SERVIDOR_DE_PRODUCAO';

export interface LogisticsCarrierAccess {
  carrier: LogisticsCarrierId;
  configured: boolean;
  environment: LogisticsCredentialEnvironment | null;
  mode: LogisticsAccessMode;
  /** Se a cotação faz chamada HTTP ao provedor. */
  realCalls: boolean;
  /** Se a cotação vale como preço cobrado do cliente no checkout. */
  chargeable: boolean;
  locks: LogisticsAccessLock[];
}

/** As transportadoras com cliente HTTP escrito. As outras só simulam. */
export const COM_INTEGRACAO_DIRETA: ReadonlySet<LogisticsCarrierId> = new Set(['melhor_envio']);

/**
 * O processo é de produção?
 *
 * Lê `process.env` direto, pelo mesmo critério da trava de produção do `loadEnv`:
 * `NODE_ENV` é a variável que hospedagem e container definem sozinhos, e
 * `DEVORA_API_ENV` é a deste projeto. Qualquer uma das duas basta.
 */
export function processoDeProducao(): boolean {
  return process.env.DEVORA_API_ENV === 'production' || process.env.NODE_ENV === 'production';
}

function ambienteDaLinha(row: Record<string, unknown> | null): LogisticsCredentialEnvironment | null {
  if (!row) return null;
  return row.environment === 'production' ? 'production' : 'homologation';
}

export function resolveCarrierAccess(
  companyId: string,
  carrier: LogisticsCarrierId,
  storeId?: string,
): LogisticsCarrierAccess {
  const row = getLogisticsCredentialRow(companyId, carrier, storeId);
  const creds = row ? getLogisticsCredentials(companyId, carrier, storeId) : null;
  const environment = creds ? ambienteDaLinha(row) : null;
  const base = { carrier, configured: Boolean(creds), environment };

  if (!creds) {
    return { ...base, mode: 'none', realCalls: false, chargeable: false, locks: ['SEM_CREDENCIAL'] };
  }

  if (!COM_INTEGRACAO_DIRETA.has(carrier) || !(creds.token || creds.apiKey)) {
    if (processoDeProducao()) {
      return {
        ...base,
        mode: 'blocked',
        realCalls: false,
        chargeable: false,
        locks: ['SEM_INTEGRACAO_DIRETA', 'SIMULACAO_EM_SERVIDOR_DE_PRODUCAO'],
      };
    }
    return { ...base, mode: 'simulated', realCalls: false, chargeable: false, locks: ['SEM_INTEGRACAO_DIRETA'] };
  }

  if (environment !== 'production') {
    if (processoDeProducao()) {
      return {
        ...base,
        mode: 'blocked',
        realCalls: false,
        chargeable: false,
        locks: ['CREDENCIAL_DE_SANDBOX', 'SANDBOX_EM_SERVIDOR_DE_PRODUCAO'],
      };
    }
    return { ...base, mode: 'sandbox', realCalls: true, chargeable: false, locks: ['CREDENCIAL_DE_SANDBOX'] };
  }

  if (!loadEnv().logisticsProductionEnabled) {
    return {
      ...base,
      mode: 'blocked',
      realCalls: false,
      chargeable: false,
      locks: ['PRODUCAO_DESABILITADA_NO_PROCESSO'],
    };
  }

  return { ...base, mode: 'production', realCalls: true, chargeable: true, locks: [] };
}

/** A frase que explica o bloqueio, para a resposta de teste/cotação. */
export function mensagemDoBloqueio(access: LogisticsCarrierAccess): string {
  if (access.locks.includes('PRODUCAO_DESABILITADA_NO_PROCESSO')) {
    return 'Token de produção guardado, mas o servidor está com a produção de logística desligada '
      + '(LOGISTICS_PRODUCTION_ENABLED). Nenhuma chamada foi feita.';
  }
  if (access.locks.includes('SANDBOX_EM_SERVIDOR_DE_PRODUCAO')) {
    return 'Token de sandbox não opera em servidor de produção. Guarde o token de produção do Melhor Envio.';
  }
  if (access.locks.includes('SIMULACAO_EM_SERVIDOR_DE_PRODUCAO')) {
    return `${access.carrier}: sem integração direta, e simulação não opera em servidor de produção.`;
  }
  return 'Credenciais ausentes.';
}

function ambienteDoProvedor(access: LogisticsCarrierAccess): MelhorEnvioAmbiente {
  return access.mode === 'production' ? 'production' : 'sandbox';
}

function contatoDaLinha(companyId: string, carrier: LogisticsCarrierId, storeId?: string): string | null {
  const row = getLogisticsCredentialRow(companyId, carrier, storeId);
  const email = String(row?.contactEmail ?? '').trim();
  return email || null;
}

function mensagemDeFalha(err: unknown, padrao: string): string {
  if (err instanceof MelhorEnvioError) return err.message;
  return err instanceof Error ? err.message : padrao;
}

// ---------------------------------------------------------------- simulação

function simulateQuote(carrier: LogisticsCarrierId, req: LogisticsQuoteRequest): LogisticsQuoteOptionResult[] {
  const base = 1200 + req.weightGrams / 100;
  const distance = Math.abs(Number(req.originZipCode.slice(0, 2)) - Number(req.destinationZipCode.slice(0, 2))) || 1;
  const price = Math.round(base * (1 + distance * 0.05));
  const services: Record<LogisticsCarrierId, Array<{ code: string; name: string; days: number; mult: number }>> = {
    correios: [
      { code: 'PAC', name: 'PAC', days: 8, mult: 1 },
      { code: 'SEDEX', name: 'SEDEX', days: 3, mult: 1.8 },
    ],
    jadlog: [
      { code: 'JAD_PACKAGE', name: 'Jadlog Package', days: 5, mult: 1.2 },
      { code: 'JAD_EXPRESS', name: 'Jadlog Express', days: 2, mult: 2.1 },
    ],
    melhor_envio: [
      { code: 'ME_ECON', name: 'Melhor Envio Econômico', days: 7, mult: 0.95 },
      { code: 'ME_EXP', name: 'Melhor Envio Expresso', days: 4, mult: 1.6 },
    ],
    generic: [{ code: 'GEN_STD', name: 'Transportadora Genérica', days: 6, mult: 1 }],
  };
  return services[carrier].map((s) => ({
    carrier,
    serviceCode: s.code,
    serviceName: s.name,
    priceInCents: Math.round(price * s.mult),
    insuranceInCents: Math.round(req.declaredValueInCents * 0.01),
    estimatedDays: s.days,
    simulated: true,
    real: false,
    environment: null,
  }));
}

// ------------------------------------------------------------------ conexão

export async function testLogisticsCarrierConnection(
  companyId: string,
  carrier: LogisticsCarrierId,
  storeId?: string,
): Promise<LogisticsAdapterResult> {
  const access = resolveCarrierAccess(companyId, carrier, storeId);
  if (access.mode === 'none') {
    return { ok: false, real: false, simulated: false, pending: true, message: 'Credenciais ausentes.', locks: access.locks };
  }
  if (access.mode === 'blocked') {
    return {
      ok: false,
      real: false,
      simulated: false,
      pending: true,
      message: mensagemDoBloqueio(access),
      locks: access.locks,
    };
  }
  if (access.mode === 'simulated') {
    markCredentialTest(companyId, carrier, 'connection_simulated', storeId);
    return {
      ok: false,
      real: false,
      simulated: true,
      pending: true,
      locks: access.locks,
      message: `SEM INTEGRAÇÃO DIRETA (${carrier}): conexão real não implementada — os serviços desta `
        + 'transportadora são cotados, comprados e rastreados pelo Melhor Envio.',
    };
  }

  const creds = getLogisticsCredentials(companyId, carrier, storeId);
  const ambiente = ambienteDoProvedor(access);
  const rotulo = ambiente === 'production' ? 'produção' : 'sandbox';
  try {
    const { conta } = await conferirContaMelhorEnvio({
      token: String(creds?.token ?? creds?.apiKey),
      ambiente,
      contato: contatoDaLinha(companyId, carrier, storeId),
    });
    const message = `Conexão com o Melhor Envio (${rotulo}) OK${conta ? ` — conta de ${conta}` : ''}.`;
    markCredentialTest(companyId, carrier, 'connection_ok', storeId, { kind: 'connection', ok: true, message });
    return { ok: true, real: true, simulated: false, environment: ambiente, message, locks: access.locks };
  } catch (err) {
    const message = mensagemDeFalha(err, 'Falha na conexão.');
    markCredentialTest(companyId, carrier, 'connection_failed', storeId, { kind: 'connection', ok: false, message });
    return { ok: false, real: true, simulated: false, environment: ambiente, message, locks: access.locks };
  }
}

// ------------------------------------------------------------------ cotação

export async function quoteLogisticsCarrier(
  companyId: string,
  carrier: LogisticsCarrierId,
  req: LogisticsQuoteRequest,
  storeId?: string,
): Promise<LogisticsAdapterResult> {
  const access = resolveCarrierAccess(companyId, carrier, storeId);

  if (access.mode === 'none') {
    if (processoDeProducao()) {
      return { ok: false, real: false, simulated: false, pending: true, options: [], locks: access.locks, message: 'Credenciais ausentes.' };
    }
    return {
      ok: false,
      real: false,
      simulated: true,
      pending: true,
      locks: access.locks,
      message: 'Credenciais ausentes — cotação simulada estrutural (não homologada).',
      options: simulateQuote(carrier, req),
    };
  }

  if (access.mode === 'blocked') {
    return {
      ok: false,
      real: false,
      simulated: false,
      pending: true,
      options: [],
      locks: access.locks,
      message: mensagemDoBloqueio(access),
    };
  }

  if (access.mode === 'simulated') {
    markCredentialTest(companyId, carrier, 'quote_simulated', storeId);
    return {
      ok: true,
      real: false,
      simulated: true,
      options: simulateQuote(carrier, req),
      locks: access.locks,
      message: `Cotação SIMULADA — sem integração direta com ${carrier}; não vale para cobrar.`,
    };
  }

  const creds = getLogisticsCredentials(companyId, carrier, storeId);
  const ambiente = ambienteDoProvedor(access);
  try {
    const servicos = await cotarMelhorEnvio({
      token: String(creds?.token ?? creds?.apiKey),
      ambiente,
      contato: contatoDaLinha(companyId, carrier, storeId),
      pacote: req,
    });
    const deSandbox = ambiente === 'sandbox';
    const options: LogisticsQuoteOptionResult[] = servicos.map((s) => ({
      carrier,
      serviceCode: s.serviceCode,
      serviceName: s.serviceName,
      priceInCents: s.priceInCents,
      insuranceInCents: 0,
      // Sem prazo do provedor, 0 seria "chega hoje"; o checkout lê o campo e
      // trata o não-finito como "prazo desconhecido".
      estimatedDays: s.estimatedDays ?? Number.NaN,
      simulated: deSandbox,
      real: true,
      environment: ambiente,
    }));
    const message = options.length === 0
      ? 'O Melhor Envio não devolveu nenhum serviço disponível para este trecho e pacote.'
      : deSandbox
        ? 'Cotação REAL do sandbox do Melhor Envio: preço de ambiente de teste, não vale para cobrar.'
        : undefined;
    markCredentialTest(companyId, carrier, 'quote_ok', storeId, { kind: 'quote', ok: true, message: message ?? null });
    return { ok: true, real: true, simulated: deSandbox, environment: ambiente, options, locks: access.locks, message };
  } catch (err) {
    const message = mensagemDeFalha(err, 'Falha na cotação real.');
    markCredentialTest(companyId, carrier, 'quote_failed', storeId, { kind: 'quote', ok: false, message });
    return { ok: false, real: true, simulated: false, environment: ambiente, options: [], locks: access.locks, message };
  }
}

// ------------------------------------------------------------- rastreamento

export async function trackLogisticsCarrier(
  companyId: string,
  carrier: LogisticsCarrierId,
  trackingCode: string,
  storeId?: string,
): Promise<LogisticsAdapterResult> {
  const access = resolveCarrierAccess(companyId, carrier, storeId);
  if (!access.realCalls) {
    // Simulação não opera em servidor de produção — nem esta, de conferência.
    if (processoDeProducao()) {
      return { ok: false, real: false, simulated: false, pending: true, locks: access.locks, message: mensagemDoBloqueio(access) };
    }
    return {
      ok: true,
      real: false,
      simulated: true,
      trackingEvents: [
        { status: 'simulated', description: `Simulação ${carrier} — ${trackingCode}`, occurredAt: new Date().toISOString() },
      ],
      message: 'Rastreamento simulado — não homologado.',
    };
  }
  /*
    O RASTREIO REAL EXISTE, MAS É POR ENVIO (GAP-PRD-119). O Melhor Envio
    rastreia a etiqueta que ELE vendeu, pelo id do envio — não um código
    avulso digitado aqui. A consulta acontece na ficha do pedido ("Atualizar
    rastreio") e sozinha, pela agenda (`RastreioAgendado`). Código avulso se
    acompanha pelo link público da transportadora.
  */
  return {
    ok: false,
    real: false,
    simulated: false,
    pending: false,
    environment: access.mode === 'production' ? 'production' : 'sandbox',
    message: 'O rastreio do Melhor Envio é feito por envio comprado pelo sistema: consulte na ficha do pedido '
      + '(Pedidos → Atualizar rastreio), ou deixe a agenda consultar sozinha. Código avulso se acompanha pelo '
      + 'link público da transportadora.',
  };
}

/**
 * Cotação simulada de conferência para quando NENHUMA transportadora tem
 * credencial. Em servidor de produção não existe: simulação não aparece para
 * cliente de verdade.
 */
export function quoteAllCarriers(
  companyId: string,
  req: LogisticsQuoteRequest,
  carrierFilter?: LogisticsCarrierId,
): LogisticsQuoteOptionResult[] {
  if (processoDeProducao()) return [];
  const carriers: LogisticsCarrierId[] = carrierFilter
    ? [carrierFilter]
    : ['correios', 'jadlog', 'melhor_envio'];
  const all: LogisticsQuoteOptionResult[] = [];
  for (const carrier of carriers) {
    const creds = getLogisticsCredentials(companyId, carrier);
    if (!creds) continue;
    all.push(...simulateQuote(carrier, req));
  }
  if (all.length === 0) {
    return simulateQuote('correios', req);
  }
  return all;
}
