/**
 * Maquininhas integradas da operação — o lado do GESTOR (GAP-PRD-001 e GAP-PRD-076).
 *
 * Não existia rota nem tela para desligar uma configuração de maquininha: a
 * linha `mock` ativa no banco real da Preço Justo só sairia com alguém
 * abrindo o SQLite. E o módulo inteiro — cadastro, credencial, teste de
 * conexão, agente local, homologação, cobranças, fila — só existia por `curl`
 * com Idempotency-Key (GAP-PRD-076). Estas chamadas são o caminho pela tela.
 *
 * Nenhuma recebe `companyId`: o escopo vem da sessão no servidor, e uma
 * configuração, agente ou cobrança de outra operação responde 404.
 */
import { apiRequest, envelope, exigirCampos } from './client';
import type { EstornoNaMaquininha, TerminalPayment } from './core';
import { uuid } from '@/lib/uuid';

/**
 * Uma cobrança nas filas do gestor (GAP-PRD-078/080): a leitura do balcão
 * (`TerminalPayment`) mais de onde veio, há quanto tempo e o que falta estornar.
 */
export interface CobrancaNaFila extends TerminalPayment {
  provider: string | null;
  startedAt: string | null;
  idadeMinutos: number;
  createdBy: string | null;
  pdvTerminalId: string | null;
  cashSessionId: string | null;
  saleId: string | null;
  saleNumber: number | null;
  refundedAmountInCents: number;
  aEstornarCents: number;
  ultimoPedido: {
    origem: 'cancelamento' | 'devolucao';
    referenciaId: string;
    amountInCents: number;
    requestedAt: string;
    reason: string;
  } | null;
  /** Cancelamento/estorno esperando o agente local responder. */
  pedidoNoAgente: boolean;
}

export interface PendenciasDaMaquininha {
  /** A partir de quantos minutos a cobrança sem venda entra na fila. */
  minutos: number;
  /** Em andamento ou aprovadas, sem venda e sem tratativa (GAP-PRD-078). */
  semVenda: CobrancaNaFila[];
  /** Estorno pedido por cancelamento/devolução de venda e ainda não confirmado (GAP-PRD-080). */
  aEstornar: CobrancaNaFila[];
}

const idSeguro = (id: string) => encodeURIComponent(id);

/**
 * As filas e as saídas do dinheiro da maquininha sem dono (GAP-PRD-078/080).
 * O balcão só usa `desistir` (a cobrança que ele mesmo fez); o resto é do
 * gestor, como a conferência de não confirmadas.
 */
export const pendenciasDaMaquininhaApi = {
  listar: (minutos?: number) =>
    apiRequest<PendenciasDaMaquininha>(
      `/core/pdv/terminal/pendencias${minutos == null ? '' : `?minutos=${encodeURIComponent(String(minutos))}`}`,
    ).then((r) => exigirCampos(r, 'semVenda', 'aEstornar')),

  /** Desistir no balcão CANCELA a cobrança na maquininha (não só limpa a tela). */
  desistir: (transactionId: string, reason?: string) =>
    apiRequest<TerminalPayment & { queuedToAgent?: boolean }>(
      `/core/pdv/terminal/${idSeguro(transactionId)}/desistir`,
      { method: 'POST', body: { reason: reason ?? null } },
    ),

  registrarTratativa: (transactionId: string, reason: string) =>
    apiRequest<TerminalPayment>(`/core/pdv/terminal/${idSeguro(transactionId)}/tratativa`, {
      method: 'POST',
      body: { reason },
    }),

  /** Amarra a cobrança aprovada à venda que ela pagou — pelo número da venda. */
  vincularVenda: (transactionId: string, saleNumber: number, reason: string) =>
    apiRequest<TerminalPayment & { saleId: string; saleNumber: number }>(
      `/core/pdv/terminal/${idSeguro(transactionId)}/vincular-venda`,
      { method: 'POST', body: { saleNumber, reason } },
    ),

  /** O estorno da venda desfeita foi feito no próprio aparelho: o gestor registra. */
  estornoManual: (transactionId: string, reason: string) =>
    apiRequest<TerminalPayment>(`/core/pdv/terminal/${idSeguro(transactionId)}/estorno-manual`, {
      method: 'POST',
      body: { reason },
    }),
};

/**
 * A frase que quem cancelou/devolveu precisa ler sobre o cartão (GAP-PRD-080):
 * estornado, enviado ao aparelho, ou pendente — e onde a pendência ficou.
 */
export function fraseDosEstornosNaMaquininha(
  estornos: EstornoNaMaquininha[] | undefined,
  formatar: (cents: number) => string,
): string {
  if (!estornos || estornos.length === 0) return '';
  return estornos
    .map((e) =>
      e.resultado === 'estornado'
        ? `Estorno de ${formatar(e.amountInCents)} confirmado na maquininha.`
        : e.resultado === 'enviado_ao_agente'
          ? `Estorno de ${formatar(e.amountInCents)} enviado ao aparelho — confirme no comprovante.`
          : `Estorno de ${formatar(e.amountInCents)} NÃO confirmado pela operadora: ${e.message}`,
    )
    .join(' ');
}

/** O item de homologação medido pela evidência (cobrança real que aconteceu). */
export interface ItemDeHomologacao {
  key: string;
  label: string;
  required: boolean;
  status: 'ok' | 'pending';
  evidence: string | null;
  at: string | null;
}

export interface HomologacaoDaMaquininha {
  configurationId: string;
  homologated: boolean;
  items: ItemDeHomologacao[];
  missing: string[];
}

export interface AgenteResumo {
  agentId: string;
  online: boolean;
  lastSeenAt: string | null;
  health: { tefClient?: string | null; pinpad?: string | null; message?: string | null } | null;
  version: string | null;
}

/** Uma configuração de maquininha como o servidor a mostra (sem credencial). */
export interface ConfiguracaoDeMaquininha {
  id: string;
  provider: string;
  displayName?: string | null;
  terminalIdentifier?: string | null;
  environment?: string | null;
  /** Ligada = o cartão desta operação passa pelo aparelho e exige cobrança aprovada. */
  active: boolean;
  /** Provider de TESTE (mock): aprova sem dinheiro trocar de mãos. */
  simulated: boolean;
  /**
   * Gravada e ligada, mas IGNORADA neste ambiente — o caso da configuração de
   * teste em produção. O balcão lança o cartão à mão enquanto ela existir.
   */
  blockedInThisEnvironment: boolean;
  hasCredentials?: boolean;
  deactivatedAt?: string | null;
  deactivatedBy?: string | null;
  deactivationReason?: string | null;
  activatedAt?: string | null;
  createdAt?: string | null;
  lastTestAt?: string | null;
  lastTestStatus?: string | null;
  /** O caixa desta maquininha; nulo = a operação inteira (GAP-PRD-014). */
  pdvTerminalId?: string | null;
  /** Por onde a cobrança chega ao aparelho. */
  channel?: 'mock' | 'local_agent' | 'cloud';
  /** Esse caminho existe neste sistema? */
  implemented?: boolean;
  channelLabel?: string | null;
  channelReason?: string | null;
  readinessStatus?: string | null;
  agent?: AgenteResumo | null;
  homologation?: HomologacaoDaMaquininha | null;
  blockingReasons?: string[];
}

export interface MaquininhasDaOperacao {
  /** Nome do ambiente que proíbe o provider de teste, ou `null` (dev/teste). */
  environmentBlocksTestProvider: string | null;
  items: ConfiguracaoDeMaquininha[];
}

export interface ProntidaoDasMaquininhas {
  overallStatus: 'pending' | 'awaiting_agent' | 'channel_not_implemented' | 'ready_for_homologation' | 'homologated';
  readyForHomologation: boolean;
  productionBlocked: boolean;
  blockingReasons: string[];
  providers: Array<{ provider: string; channels: { local_agent: boolean; cloud: boolean } }>;
}

export interface AgenteLocal {
  agentId: string;
  pdvTerminalId: string | null;
  status: 'pairing' | 'paired' | 'revoked' | 'offline' | string;
  paired: boolean;
  online: boolean;
  version: string | null;
  hostname: string | null;
  lastSeenAt: string | null;
  pairedAt: string | null;
  health: AgenteResumo['health'];
  revokedAt: string | null;
  revocationReason: string | null;
  pairingExpiresAt: string | null;
}

export interface CodigoDePareamento {
  agentId: string;
  pairingCode: string;
  expiresAt: string;
  pdvTerminalId: string | null;
  pdvTerminalName: string | null;
  ttlSeconds: number;
}

/**
 * O último pedido de cancelamento/estorno feito para uma cobrança (GAP-PRD-075)
 * — inclusive o que a operadora não confirmou. `outcome` vem cru do servidor; a
 * tela traduz os que conhece e mostra os outros como vieram.
 */
export interface PedidoDaCobranca {
  operacao: 'cancel' | 'refund';
  outcome: string;
  reason: string | null;
  requestedAt: string | null;
  providerMessage: string | null;
  amountInCents: number | null;
}

/** Uma cobrança de maquininha como o módulo a grava. */
export interface CobrancaDaMaquininha {
  /** O último pedido de cancelamento/estorno, quando houve algum. */
  ultimoPedido?: PedidoDaCobranca | null;
  id: string;
  provider?: string | null;
  paymentMethod?: string | null;
  amountInCents?: number;
  status?: string | null;
  channel?: string | null;
  providerNsu?: string | null;
  providerAuthorizationCode?: string | null;
  maskedCard?: string | null;
  cardBrand?: string | null;
  saleId?: string | null;
  saleNumber?: number | null;
  simulated?: boolean;
  startedAt?: string | null;
  refundedAmountInCents?: number | null;
  providerMessage?: string | null;
}

export interface ComandoDoAgente {
  id: string;
  command: string;
  status: 'queued' | 'delivered' | 'answered' | 'expired';
  transactionId: string | null;
  createdAt: string;
  deliveredAt: string | null;
  answeredAt: string | null;
  expiredAt: string | null;
  resultStatus: string | null;
  amountInCents: number | null;
}

export interface ResultadoDaConexao {
  ok: boolean;
  real: boolean;
  simulated: boolean;
  pending?: boolean;
  message?: string;
}

export interface Comprovante {
  transactionId: string;
  receiptType: 'merchant' | 'customer';
  receiptText: string;
  simulated: boolean;
  reprintCount: number;
}

export interface PainelDaMaquininha {
  transactionsTotal: number;
  authorized: number;
  confirmed?: number;
  declined: number;
  /** Não confirmadas (inclui a órfã e a que o agente não respondeu). */
  timeoutUncertain: number;
  grossAmountInCents: number;
}

/** Resposta de cancelar/estornar: pelo agente, o pedido vai para a fila (202). */
export interface PedidoAoAparelho {
  id: string;
  status?: string | null;
  queuedToAgent?: boolean;
  commandId?: string;
  message?: string;
}

const seguro = (id: string) => encodeURIComponent(id);

export const maquininhasApi = {
  // `exigirCampos`: sem `items` a resposta é contrato quebrado, e o card mostra
  // o erro em vez de estourar no `.length` (a varredura `toda-tela-monta`
  // derrubava a Conferência de maquininha inteira por isso).
  listar: () =>
    apiRequest<MaquininhasDaOperacao>('/core/pdv/terminal/configurations').then((r) =>
      exigirCampos(r, 'items'),
    ),

  /** Desliga — sempre pode, inclusive em produção. Motivo obrigatório. */
  desligar: (id: string, reason: string) =>
    apiRequest<ConfiguracaoDeMaquininha>(
      `/core/pdv/terminal/configurations/${seguro(id)}/deactivate`,
      { method: 'POST', body: { reason } },
    ),

  /** Religa — o servidor recusa religar a de teste em produção e a sem agente pareado. */
  religar: (id: string, reason: string) =>
    apiRequest<ConfiguracaoDeMaquininha>(
      `/core/pdv/terminal/configurations/${seguro(id)}/activate`,
      { method: 'POST', body: { reason } },
    ),

  // ------------------------------------------------ módulo (GAP-PRD-076)

  prontidao: () =>
    apiRequest<ProntidaoDasMaquininhas>('/payment-terminals/readiness').then((r) =>
      exigirCampos(r, 'overallStatus', 'blockingReasons'),
    ),

  /** Nasce DESLIGADA quando é maquininha real: liga depois de parear o agente. */
  cadastrar: (input: {
    provider: string;
    displayName: string;
    terminalIdentifier?: string | null;
    pdvTerminalId?: string | null;
    connectionMode?: string;
  }) =>
    apiRequest<ConfiguracaoDeMaquininha>('/payment-terminals/configurations', {
      method: 'POST',
      body: input,
      idempotencyKey: `cfg-${uuid()}`,
    }),

  editar: (
    id: string,
    patch: { displayName?: string; terminalIdentifier?: string | null; pdvTerminalId?: string | null },
  ) =>
    apiRequest<ConfiguracaoDeMaquininha>(`/payment-terminals/configurations/${seguro(id)}`, {
      method: 'PATCH',
      body: patch,
    }),

  /** Vai para o cofre do servidor; a resposta nunca devolve o segredo. */
  salvarCredencial: (input: {
    configurationId: string;
    provider: string;
    accessToken: string;
    merchantId?: string;
    establishmentCode?: string;
    terminalSerial?: string;
  }) =>
    apiRequest<ConfiguracaoDeMaquininha>('/payment-terminals/credentials', {
      method: 'POST',
      body: input,
      idempotencyKey: `cred-${uuid()}`,
    }),

  testarConexao: (provider: string) =>
    apiRequest<ResultadoDaConexao>(`/payment-terminals/providers/${seguro(provider)}/test-connection`, {
      method: 'POST',
      body: {},
    }),

  agentes: () =>
    apiRequest<{ items: AgenteLocal[] }>('/payment-terminals/local-agents').then(envelope('items')),

  /** Código de uso único, dez minutos, para o agente do caixa escolhido. */
  gerarCodigo: (pdvTerminalId: string | null) =>
    apiRequest<CodigoDePareamento>('/payment-terminals/local-agent/pairing', {
      method: 'POST',
      body: { pdvTerminalId },
    }),

  revogarAgente: (agentId: string, reason: string) =>
    apiRequest<AgenteLocal>(`/payment-terminals/local-agents/${seguro(agentId)}/revoke`, {
      method: 'POST',
      body: { reason },
    }),

  cobrancas: () =>
    apiRequest<{ items: CobrancaDaMaquininha[] }>('/payment-terminals/transactions').then(envelope('items')),

  comprovante: (transactionId: string, via: 'merchant' | 'customer' = 'merchant') =>
    apiRequest<Comprovante>(`/payment-terminals/transactions/${seguro(transactionId)}/receipt?via=${via}`),

  reimprimir: (transactionId: string, via: 'merchant' | 'customer' = 'merchant') =>
    apiRequest<Comprovante>(`/payment-terminals/transactions/${seguro(transactionId)}/reprint`, {
      method: 'POST',
      body: { via },
    }),

  cancelar: (transactionId: string, reason: string) =>
    apiRequest<PedidoAoAparelho>(`/payment-terminals/transactions/${seguro(transactionId)}/cancel`, {
      method: 'POST',
      body: { reason },
    }),

  estornar: (transactionId: string, reason: string, amountInCents?: number | null) =>
    apiRequest<PedidoAoAparelho>(`/payment-terminals/transactions/${seguro(transactionId)}/refund`, {
      method: 'POST',
      body: { reason, amountInCents: amountInCents ?? null },
    }),

  /** Pergunta ao cliente TEF o desfecho de uma cobrança não confirmada. */
  consultarNoAparelho: (transactionId: string) =>
    apiRequest<PedidoAoAparelho>(`/payment-terminals/transactions/${seguro(transactionId)}/query`, {
      method: 'POST',
      body: {},
    }),

  /** Os números da maquininha na operação (aprovadas, recusadas, não confirmadas, bruto). */
  painel: () =>
    apiRequest<PainelDaMaquininha>('/payment-terminals/dashboard').then((r) =>
      exigirCampos(r, 'transactionsTotal', 'authorized', 'declined', 'timeoutUncertain', 'grossAmountInCents'),
    ),

  comandos: (status?: string) =>
    apiRequest<{ items: ComandoDoAgente[] }>(
      `/payment-terminals/agent-commands${status ? `?status=${encodeURIComponent(status)}` : ''}`,
    ).then(envelope('items')),
};

/** O que cada estado de prontidão quer dizer, para quem não é técnico. */
export const ROTULO_DA_PRONTIDAO: Record<string, string> = {
  pending: 'Nenhuma maquininha real cadastrada',
  awaiting_agent: 'Aguardando o agente local',
  agent_offline: 'Agente fora do ar',
  tef_client_unavailable: 'Cliente TEF sem resposta',
  channel_not_implemented: 'Caminho não disponível',
  inactive: 'Desligada',
  ready_for_homologation: 'Pronta para homologar',
  homologated: 'Homologada',
  test_only: 'De teste (simulada)',
  blocked_in_environment: 'Ignorada neste ambiente',
};

export const NOME_DO_PROVEDOR: Record<string, string> = {
  generic_tef: 'TEF genérico',
  stone: 'Stone',
  cielo: 'Cielo',
  rede: 'Rede',
  getnet: 'Getnet',
  pagbank: 'PagBank',
  mercado_pago: 'Mercado Pago',
  mock: 'Teste (simulada)',
};
