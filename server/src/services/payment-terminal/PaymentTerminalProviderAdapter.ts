/**
 * Adapters backend Payment Terminal.
 *
 * - `mock`: o provedor de teste, executado aqui mesmo (dev/teste; recusado em
 *   produção e homologação — GAP-PRD-001).
 * - Provedores reais: a cobrança NÃO passa por este arquivo. Ela vai pela fila
 *   do agente local (`PaymentTerminalAgentChannel`, GAP-PRD-014), que fala com
 *   o PinPad pelo cliente TEF da adquirente. As funções abaixo respondem
 *   pendente para provedor real porque daqui não há o que chamar — e quem
 *   chama não pode transformar isso em aprovado, cancelado ou estornado.
 * - A conexão de um provedor real é a presença do agente e a saúde do cliente
 *   TEF que ele relatou (`testPaymentTerminalConnection`).
 */

import { loadEnv } from '../../config/env.js';
import { findRows } from '../../db/database.js';
import {
  ambienteQueBloqueiaOMock,
  assertMockProviderAllowed,
  getPaymentTerminalCredentials,
  markPaymentTerminalTest,
  type PaymentTerminalProviderId,
} from './PaymentTerminalCredentialService.js';
import {
  agenteDoCaixa,
  agenteOnline,
  getLocalAgentStatusDetailed,
  saudeDoAgenteOk,
} from './PaymentTerminalLocalAgentService.js';
import { driverDe } from './PaymentTerminalChannels.js';

export const HOMOLOGATION_CHECKLIST_KEYS = [
  'configuration', 'credential', 'connection', 'terminal', 'credit', 'debit',
  'installments', 'pix', 'decline', 'timeout', 'status_query', 'cancellation',
  'refund', 'receipt', 'reprint', 'pdv', 'cash', 'financial', 'nfce',
  'idempotency', 'recovery', 'reconciliation',
] as const;

export interface PaymentTerminalAdapterResult {
  ok: boolean;
  real: boolean;
  simulated: boolean;
  pending?: boolean;
  message?: string;
  status?: string;
  providerTransactionId?: string;
  providerNsu?: string;
  providerTid?: string;
  authorizationCode?: string;
  maskedCard?: string;
  cardBrand?: string;
  /**
   * Via do ESTABELECIMENTO do comprovante, como a adquirente devolveu.
   *
   * É guardada em `payment_terminal_receipts` no momento da cobrança
   * (GAP-PRD-162): comprovante é documento do que a operadora disse, e o
   * sistema não o remonta depois a partir de valor e bandeira.
   */
  receiptText?: string;
  /** Via do CLIENTE, quando a adquirente devolve as duas separadas. */
  customerReceiptText?: string;
  /**
   * Copia-e-cola do PIX que a maquininha exibe em QR.
   *
   * Só existe para PIX, e só enquanto o pagamento está pendente: depois de
   * confirmado o código não serve mais para nada e mostrá-lo convidaria a um
   * segundo pagamento do mesmo valor.
   */
  qrPayload?: string;
}

function canRunReal(provider: PaymentTerminalProviderId, hasCreds: boolean): boolean {
  const env = loadEnv();
  return hasCreds && env.paymentTerminalHomologationTests && !env.paymentTerminalProductionEnabled && provider === 'mock';
}

function mockPaymentResult(method: string, amountInCents: number, scenario?: string): PaymentTerminalAdapterResult {
  if (scenario === 'decline') {
    return { ok: false, real: false, simulated: true, status: 'declined', message: 'Transação recusada (mock).' };
  }
  if (scenario === 'timeout_uncertain') {
    return { ok: false, real: false, simulated: true, status: 'timeout_uncertain', message: 'Timeout incerto — consultar status antes de nova cobrança.' };
  }

  /**
   * PIX NÃO É APROVADO NA HORA, e o mock não pode fingir que é.
   *
   * No aparelho real o fluxo é assíncrono: a maquininha exibe o QR, o cliente
   * abre o banco, escaneia e paga — e a confirmação chega segundos depois, por
   * consulta ou callback do provedor. Devolver `authorized` na primeira
   * chamada ensinaria ao PDV um fluxo que não existe, e todo o caminho teria
   * de ser refeito quando o SDK real chegasse.
   *
   * Então aqui ele nasce PENDENTE, com o copia-e-cola. Quem confirma é o
   * provedor — ver `confirmPixOnTerminal`, que em ambiente de teste exige uma
   * ação explícita de quem está testando, nunca a passagem do tempo.
   */
  if (method === 'pix') {
    return {
      ok: false,
      real: false,
      simulated: true,
      pending: true,
      status: 'in_progress',
      providerTransactionId: `mock-pix-${Date.now()}`,
      qrPayload: `00020126MOCK-PIX-${amountInCents}-${Date.now()}`,
      message: 'QR na maquininha. Aguardando o cliente pagar.',
    };
  }

  return {
    ok: true,
    real: false,
    simulated: true,
    status: 'authorized',
    providerTransactionId: `mock-${Date.now()}`,
    providerNsu: String(Math.floor(Math.random() * 999999)).padStart(6, '0'),
    providerTid: `TID${Date.now()}`,
    authorizationCode: 'MOCK123',
    maskedCard: method === 'pix' ? undefined : '****1234',
    cardBrand: method === 'pix' ? undefined : 'VISA',
    receiptText: comprovanteMock('ESTABELECIMENTO', method, amountInCents),
    customerReceiptText: comprovanteMock('CLIENTE', method, amountInCents),
    message: 'Transação mock autorizada.',
  };
}

/**
 * O comprovante do provider de teste diz, NO PRÓPRIO TEXTO, que é simulado.
 *
 * Comprovante é papel que sai da loja na mão do cliente: um "COMPROVANTE"
 * sem a marca de teste, impresso num ensaio, é indistinguível do real.
 */
function comprovanteMock(via: 'ESTABELECIMENTO' | 'CLIENTE', method: string, amountInCents: number): string {
  return [
    'COMPROVANTE MOCK — SIMULADO, NÃO É COBRANÇA REAL',
    `VIA DO ${via}`,
    `${method.toUpperCase()} R$ ${(amountInCents / 100).toFixed(2)}`,
    'CARTAO ****1234 VISA · AUT MOCK123',
    'HOMOLOGAÇÃO INTERNA',
  ].join('\n');
}

/** Referência da cobrança original — o que um adaptador real precisa para desfazê-la. */
export interface PaymentTerminalOperationRef {
  transactionId: string;
  providerTransactionId?: string;
  providerNsu?: string;
  amountInCents: number;
}

export async function testPaymentTerminalConnection(
  companyId: string,
  provider: PaymentTerminalProviderId,
  storeId?: string,
): Promise<PaymentTerminalAdapterResult> {
  if (provider === 'mock') {
    /*
      Em produção a leitura também não finge (GAP-PRD-001).

      Sem isto, o painel de provedores respondia "Conexão MOCK OK" num
      processo de produção — e contava o mock como configurado. Aqui a porta
      é de LEITURA (o painel chama para todos os provedores), então a recusa
      é uma resposta, não um 403 que derrubaria o painel inteiro.
    */
    const bloqueio = ambienteQueBloqueiaOMock();
    if (bloqueio) {
      return {
        ok: false,
        real: false,
        simulated: true,
        status: 'blocked',
        message: `Provider de TESTE bloqueado em ${bloqueio}: ele aprovaria sem dinheiro trocar de mãos.`,
      };
    }
    markPaymentTerminalTest(companyId, provider, 'connection_ok', storeId);
    return {
      ok: true,
      real: false,
      simulated: true,
      message: 'Conexão MOCK OK — uso interno/dev. Não homologa provider real.',
    };
  }
  return conexaoDoProvedorReal(companyId, provider, storeId);
}

/**
 * A "conexão" de um provedor real é o caminho até o aparelho (GAP-PRD-014).
 *
 * Pelo agente local: o agente do caixa daquela maquininha está pareado,
 * falou nos últimos 90 segundos, e o cliente TEF respondeu no último sinal
 * dele. Qualquer degrau que falte é dito pelo nome. Pela nuvem: não existe,
 * e a resposta diz isso — nunca "conexão OK" para um caminho que nenhum código
 * atende.
 */
function conexaoDoProvedorReal(
  companyId: string,
  provider: PaymentTerminalProviderId,
  storeId?: string,
): PaymentTerminalAdapterResult {
  const configs = findRows<Record<string, unknown>>(
    'payment_terminal_configurations',
    (r) =>
      r.companyId === companyId
      && r.provider === provider
      && (!storeId || r.storeId === storeId || r.pdvTerminalId === storeId || r.storeId == null),
  );
  const config = configs.find((c) => c.active !== false) ?? configs[0];
  if (!config) {
    return {
      ok: false,
      real: false,
      simulated: false,
      pending: true,
      message: `Maquininha ${provider} não cadastrada — PENDENTE. Cadastre-a em Configurações › Maquininhas.`,
    };
  }
  const driver = driverDe(config);
  if (!driver.implemented) {
    markPaymentTerminalTest(companyId, provider, 'connection_not_implemented', storeId);
    return { ok: false, real: false, simulated: false, pending: true, message: String(driver.reason) };
  }
  const agente = agenteDoCaixa(companyId, (config.pdvTerminalId as string | null | undefined) ?? null);
  if (!agente) {
    markPaymentTerminalTest(companyId, provider, 'connection_pending', storeId);
    return {
      ok: false,
      real: false,
      simulated: false,
      pending: true,
      message: 'Agente local não pareado para o caixa desta maquininha — PENDENTE. Gere o código de pareamento.',
    };
  }
  if (!agenteOnline(agente)) {
    markPaymentTerminalTest(companyId, provider, 'connection_failed', storeId);
    return {
      ok: false,
      real: false,
      simulated: false,
      message: `Agente local fora do ar (último sinal: ${String(agente.lastSeenAt ?? 'nunca')}).`,
    };
  }
  if (!saudeDoAgenteOk(agente)) {
    const saude = (agente.health ?? {}) as Record<string, unknown>;
    markPaymentTerminalTest(companyId, provider, 'connection_failed', storeId);
    return {
      ok: false,
      real: false,
      simulated: false,
      message: `Agente local online, mas o cliente TEF não respondeu${saude.message ? `: ${String(saude.message)}` : '.'}`,
    };
  }
  markPaymentTerminalTest(companyId, provider, 'connection_ok', storeId);
  return {
    ok: true,
    real: true,
    simulated: false,
    message: `Agente local online e cliente TEF respondendo (último sinal: ${String(agente.lastSeenAt)}).`,
  };
}

export async function processPaymentTerminalTransaction(
  companyId: string,
  provider: PaymentTerminalProviderId,
  input: {
    paymentMethod: string;
    amountInCents: number;
    installments?: number;
    scenario?: string;
    storeId?: string;
  },
): Promise<PaymentTerminalAdapterResult> {
  // Cobrança é a porta que vira dinheiro na tela: o mock não passa daqui em
  // produção/homologação, não importa por qual rota a chamada chegou.
  assertMockProviderAllowed(provider);
  const creds = getPaymentTerminalCredentials(companyId, provider, input.storeId);
  if (provider === 'mock' || canRunReal(provider, Boolean(creds))) {
    const result = mockPaymentResult(input.paymentMethod, input.amountInCents, input.scenario);
    markPaymentTerminalTest(companyId, provider, result.ok ? `${input.paymentMethod}_ok` : `${input.paymentMethod}_failed`, input.storeId);
    return result;
  }
  return {
    ok: false,
    real: false,
    simulated: false,
    pending: true,
    status: 'failed',
    message:
      `Provider ${provider}: a cobrança real não passa por aqui — vai pela fila do agente local `
      + '(cobrança pelo PDV ou por POST /payment-terminals/transactions).',
  };
}

/*
  CANCELAR E ESTORNAR DESFAZEM DINHEIRO — o mock não desfaz o que não fez.

  As duas funções recebem a REFERÊNCIA da cobrança original (`ref`), que é o
  que um adaptador real precisa mandar à adquirente (id/NSU e valor). O mock
  não usa, mas a assinatura já é a do contrato: quem escrever o adaptador real
  não precisa mexer em quem chama.

  E o resultado de provedor sem implementação é `pending` SEM `status`, de
  propósito: quem chama não pode transformar "ninguém respondeu" em
  `cancelled` — foi exatamente esse `??` que a auditoria achou (GAP-PRD-079).
*/
export async function cancelPaymentTerminalTransaction(
  companyId: string,
  provider: PaymentTerminalProviderId,
  storeId?: string,
  ref?: PaymentTerminalOperationRef,
): Promise<PaymentTerminalAdapterResult> {
  void ref;
  assertMockProviderAllowed(provider);
  if (provider === 'mock' || canRunReal(provider, Boolean(getPaymentTerminalCredentials(companyId, provider, storeId)))) {
    markPaymentTerminalTest(companyId, provider, 'cancellation_ok', storeId);
    return { ok: true, real: false, simulated: true, status: 'cancelled', message: 'Cancelamento mock OK.' };
  }
  return { ok: false, real: false, simulated: false, pending: true, message: 'Cancelamento real pendente.' };
}

export async function refundPaymentTerminalTransaction(
  companyId: string,
  provider: PaymentTerminalProviderId,
  storeId?: string,
  ref?: PaymentTerminalOperationRef,
): Promise<PaymentTerminalAdapterResult> {
  void ref;
  assertMockProviderAllowed(provider);
  if (provider === 'mock' || canRunReal(provider, Boolean(getPaymentTerminalCredentials(companyId, provider, storeId)))) {
    markPaymentTerminalTest(companyId, provider, 'refund_ok', storeId);
    return { ok: true, real: false, simulated: true, status: 'refunded', message: 'Estorno mock OK.' };
  }
  return { ok: false, real: false, simulated: false, pending: true, message: 'Estorno real pendente.' };
}

/**
 * Como o provedor opera HOJE neste sistema (GAP-PRD-014): o mock aqui mesmo;
 * todo provedor real pelo agente local. "structural" saiu — era o nome de
 * "não faz nada" com cara de categoria.
 */
export function getProviderImplementationType(provider: PaymentTerminalProviderId): 'mock' | 'local_agent' {
  if (provider === 'mock') return 'mock';
  return 'local_agent';
}

export function getLocalAgentStatus(companyId: string, storeId?: string): { paired: boolean; online: boolean; message: string } {
  const detailed = getLocalAgentStatusDetailed(companyId, storeId);
  return {
    paired: Boolean(detailed.paired),
    online: Boolean(detailed.online),
    message: String(detailed.message ?? 'Local Agent preparado.'),
  };
}
