/**
 * PRONTIDÃO DA MAQUININHA — o que falta, dito pelo nome (GAP-PRD-014).
 *
 * ## A mentira que havia
 *
 * `overallStatus` virava `ready_for_homologation` no instante em que QUALQUER
 * credencial era gravada — inclusive a da Stone num canal que nenhum código
 * atendia, com toda cobrança devolvendo `failed`. E cada item da homologação
 * virava "ok" se `lastTestStatus` fosse a palavra `homologated`, que nenhum
 * código escrevia.
 *
 * ## O que é agora
 *
 * A prontidão é da CONFIGURAÇÃO (a maquininha de um caixa), e cada degrau é
 * uma pergunta com resposta medida:
 *
 *   1. O canal existe?                  (`driverDe`: agente local sim, nuvem não)
 *   2. O agente daquele caixa está pareado? E falando agora?
 *   3. O cliente TEF respondeu no último sinal do agente?
 *   4. A maquininha está ligada?
 *   5. Homologada? — só com EVIDÊNCIA: cobranças reais (não simuladas) por
 *      aquela configuração — crédito aprovado, débito aprovado, uma recusa,
 *      um cancelamento confirmado pelo aparelho, o comprovante guardado e uma
 *      venda paga com ela.
 *
 * `ready_for_homologation` passa a significar o que diz: existe maquininha
 * num canal que opera, com o agente pareado e online, pronta para as
 * cobranças de homologação.
 */
import { findRows } from '../../db/database.js';
import { loadEnv } from '../../config/env.js';
import { mockProviderBlocked } from './PaymentTerminalCredentialService.js';
import { HOMOLOGATION_CHECKLIST_KEYS } from './PaymentTerminalProviderAdapter.js';
import { driverDe, NOME_DO_PROVEDOR, PROVEDORES_DE_MAQUININHA } from './PaymentTerminalChannels.js';
import { agenteDoCaixa, agenteOnline, saudeDoAgenteOk } from './PaymentTerminalLocalAgentService.js';

export type PaymentTerminalReadinessItemStatus = 'ok' | 'pending' | 'blocked';

export interface PaymentTerminalProviderReadiness {
  provider: string;
  implemented: boolean;
  configured: boolean;
  homologated: boolean;
  productionBlocked: boolean;
  implementationType: 'mock' | 'local_agent';
  /** Canais: o agente local existe para todo provedor real; a nuvem, para nenhum. */
  channels: { local_agent: boolean; cloud: boolean };
  items: Array<{ key: string; label: string; status: PaymentTerminalReadinessItemStatus; message?: string }>;
  blockingReasons: string[];
}

export interface ItemDeHomologacao {
  key: string;
  label: string;
  required: boolean;
  status: 'ok' | 'pending';
  evidence: string | null;
  at: string | null;
}

/** As operações que provam a maquininha, e qual delas é obrigatória. */
const ROTEIRO: Array<{ key: string; label: string; required: boolean }> = [
  { key: 'credit', label: 'Crédito aprovado no aparelho', required: true },
  { key: 'debit', label: 'Débito aprovado no aparelho', required: true },
  { key: 'decline', label: 'Uma cobrança recusada (cartão sem saldo ou senha errada)', required: true },
  { key: 'cancellation', label: 'Cancelamento confirmado pelo aparelho', required: true },
  { key: 'receipt', label: 'Comprovante devolvido pela adquirente', required: true },
  { key: 'pdv', label: 'Venda do PDV paga com a cobrança', required: true },
  { key: 'pix', label: 'PIX aprovado no aparelho', required: false },
  { key: 'refund', label: 'Estorno confirmado pelo aparelho', required: false },
  { key: 'reprint', label: 'Segunda via do comprovante', required: false },
  { key: 'reconciliation', label: 'Cobrança não confirmada resolvida (consulta ou extrato)', required: false },
];

type Linha = Record<string, unknown>;

/**
 * A homologação de UMA configuração, pela evidência gravada.
 *
 * Só conta cobrança REAL (`real === true` e `simulated !== true`) feita por
 * esta configuração: o mock e o modo de treinamento do cliente TEF nunca
 * homologam nada.
 */
export function homologacaoDaConfiguracao(
  companyId: string,
  config: Linha,
): { configurationId: string; homologated: boolean; items: ItemDeHomologacao[]; missing: string[] } {
  const txs = findRows<Linha>(
    'payment_terminal_transactions',
    (r) =>
      r.companyId === companyId
      && r.configurationId === config.id
      && r.real === true
      && r.simulated !== true,
  );
  const ids = new Set(txs.map((t) => String(t.id)));
  const recibos = findRows<Linha>(
    'payment_terminal_receipts',
    (r) => r.companyId === companyId && ids.has(String(r.transactionId)) && r.simulated !== true,
  );
  const primeira = (f: (t: Linha) => boolean): Linha | null => txs.find(f) ?? null;
  const aprovada = (metodo: string) => primeira((t) => t.paymentMethod === metodo && Boolean(t.authorizedAt));
  const achados: Record<string, { evidence: string; at: string | null } | null> = {};
  const marcar = (key: string, t: Linha | null, campoData: string) => {
    achados[key] = t ? { evidence: String(t.id), at: (t[campoData] as string | undefined) ?? null } : null;
  };
  marcar('credit', aprovada('credit'), 'authorizedAt');
  marcar('debit', aprovada('debit'), 'authorizedAt');
  marcar('pix', aprovada('pix'), 'authorizedAt');
  marcar('decline', primeira((t) => t.status === 'declined'), 'providerAnsweredAt');
  marcar('cancellation', primeira((t) => Boolean(t.cancelledAt) && t.cancellationSimulated !== true), 'cancelledAt');
  marcar('refund', primeira((t) => Boolean(t.refundedAt) && t.refundSimulated !== true), 'refundedAt');
  marcar('pdv', primeira((t) => Boolean(t.saleId)), 'boundAt');
  marcar('reconciliation', primeira((t) => Boolean(t.reconciledAt)), 'reconciledAt');
  const recibo = recibos[0] ?? null;
  achados.receipt = recibo ? { evidence: String(recibo.transactionId), at: (recibo.createdAt as string) ?? null } : null;
  const reimpresso = recibos.find((r) => Number(r.reprintCount ?? 0) > 0) ?? null;
  achados.reprint = reimpresso
    ? { evidence: String(reimpresso.transactionId), at: (reimpresso.lastReprintAt as string) ?? null }
    : null;

  const items: ItemDeHomologacao[] = ROTEIRO.map((passo) => ({
    key: passo.key,
    label: passo.label,
    required: passo.required,
    status: achados[passo.key] ? 'ok' : 'pending',
    evidence: achados[passo.key]?.evidence ?? null,
    at: achados[passo.key]?.at ?? null,
  }));
  const missing = items.filter((i) => i.required && i.status !== 'ok').map((i) => i.label);
  return { configurationId: String(config.id), homologated: missing.length === 0, items, missing };
}

export type EstadoDaConfiguracao =
  | 'channel_not_implemented'
  | 'test_only'
  | 'blocked_in_environment'
  | 'awaiting_agent'
  | 'agent_offline'
  | 'tef_client_unavailable'
  | 'inactive'
  | 'ready_for_homologation'
  | 'homologated';

/** A prontidão de cada maquininha cadastrada, com o próximo passo. */
export function prontidaoDasConfiguracoes(companyId: string) {
  const configs = findRows<Linha>('payment_terminal_configurations', (r) => r.companyId === companyId);
  const bloqueioDoMock = mockProviderBlocked();
  return configs.map((c) => {
    const driver = driverDe(c);
    const pdvTerminalId = (c.pdvTerminalId as string | null | undefined) ?? null;
    const agente = driver.channel === 'local_agent' ? agenteDoCaixa(companyId, pdvTerminalId) : null;
    const homologacao = driver.channel === 'local_agent' ? homologacaoDaConfiguracao(companyId, c) : null;
    const pendencias: string[] = [];
    let estado: EstadoDaConfiguracao;
    if (!driver.implemented) {
      estado = 'channel_not_implemented';
      pendencias.push(String(driver.reason));
    } else if (driver.channel === 'mock') {
      estado = bloqueioDoMock ? 'blocked_in_environment' : 'test_only';
      pendencias.push(
        bloqueioDoMock
          ? 'Maquininha de TESTE: este ambiente a ignora. Desligue-a.'
          : 'Maquininha de TESTE: aprova sem dinheiro. Nunca homologa provedor real.',
      );
    } else if (!agente) {
      estado = 'awaiting_agent';
      pendencias.push('Gere o código de pareamento e informe-o no agente local do computador do caixa.');
    } else if (!agenteOnline(agente)) {
      estado = 'agent_offline';
      pendencias.push('O agente local está pareado, mas não fala com o servidor há mais de 90 segundos.');
    } else if (!saudeDoAgenteOk(agente)) {
      estado = 'tef_client_unavailable';
      const saude = (agente.health ?? {}) as Linha;
      pendencias.push(
        `O agente está online, mas o cliente TEF não respondeu${saude.message ? `: ${String(saude.message)}` : '.'}`,
      );
    } else if (homologacao?.homologated) {
      estado = c.active === false ? 'inactive' : 'homologated';
      if (c.active === false) pendencias.push('Homologada e desligada: ligue-a para o balcão usar.');
    } else {
      estado = c.active === false ? 'inactive' : 'ready_for_homologation';
      if (c.active === false) {
        pendencias.push('Desligada: ligue-a para fazer as cobranças de homologação no balcão.');
      }
      pendencias.push(...(homologacao?.missing ?? []).map((m) => `Homologação: ${m}.`));
    }
    return {
      configurationId: String(c.id),
      displayName: (c.displayName as string | undefined) ?? null,
      provider: String(c.provider ?? ''),
      providerName: NOME_DO_PROVEDOR[String(c.provider)] ?? String(c.provider ?? ''),
      channel: driver.channel,
      channelLabel: driver.label,
      implemented: driver.implemented,
      active: c.active !== false,
      pdvTerminalId,
      agent: agente
        ? {
            agentId: String(agente.id),
            online: agenteOnline(agente),
            lastSeenAt: (agente.lastSeenAt as string | undefined) ?? null,
            health: agente.health ?? null,
            version: (agente.version as string | undefined) ?? null,
          }
        : null,
      status: estado,
      homologation: homologacao,
      blockingReasons: pendencias,
    };
  });
}

type ProntidaoDeConfiguracao = ReturnType<typeof prontidaoDasConfiguracoes>[number];

function buildProviderReadiness(provider: string, configs: ProntidaoDeConfiguracao[]): PaymentTerminalProviderReadiness {
  const env = loadEnv();
  const dele = configs.filter((c) => c.provider === provider);
  const operaveis = dele.filter((c) => c.implemented);
  const homologated = dele.some((c) => c.homologation?.homologated === true);
  const configured = provider === 'mock' ? dele.length > 0 : operaveis.length > 0;
  const agenteOk = operaveis.some((c) => c.agent?.online === true);
  const items: PaymentTerminalProviderReadiness['items'] = [
    {
      key: 'channel',
      label: 'CANAL',
      status: provider === 'mock' ? 'blocked' : 'ok',
      message: provider === 'mock'
        ? 'Provedor de teste: nunca homologa nem opera em produção.'
        : 'Agente local (PinPad + cliente TEF) disponível. Integração pela nuvem: não implementada.',
    },
    {
      key: 'configuration',
      label: 'MAQUININHA CADASTRADA',
      status: configured ? 'ok' : 'pending',
      message: configured ? undefined : `Cadastre a maquininha ${NOME_DO_PROVEDOR[provider] ?? provider} num caixa.`,
    },
    {
      key: 'terminal',
      label: 'AGENTE PAREADO E ONLINE',
      status: agenteOk ? 'ok' : 'pending',
      message: agenteOk ? undefined : 'Pareie o agente local do caixa.',
    },
    ...HOMOLOGATION_CHECKLIST_KEYS.filter((k) => !['configuration', 'credential', 'terminal'].includes(k)).map(
      (key) => ({
        key,
        label: key.toUpperCase(),
        status: homologated ? ('ok' as const) : ('pending' as const),
        message: homologated ? undefined : `${key} pendente.`,
      }),
    ),
  ];
  return {
    provider,
    implemented: true,
    configured,
    homologated,
    productionBlocked: !env.paymentTerminalProductionEnabled,
    implementationType: provider === 'mock' ? 'mock' : 'local_agent',
    channels: { local_agent: provider !== 'mock', cloud: false },
    items,
    blockingReasons: dele.flatMap((c) => c.blockingReasons.map((m) => `${c.displayName ?? c.providerName}: ${m}`)),
  };
}

export function buildPaymentTerminalReadinessChecklist(companyId: string) {
  const env = loadEnv();
  const configs = prontidaoDasConfiguracoes(companyId);
  const providers = PROVEDORES_DE_MAQUININHA.map((p) => buildProviderReadiness(p, configs));
  const reais = configs.filter((c) => c.provider !== 'mock');
  const ordem: EstadoDaConfiguracao[] = [
    'homologated',
    'ready_for_homologation',
    'inactive',
    'tef_client_unavailable',
    'agent_offline',
    'awaiting_agent',
    'channel_not_implemented',
  ];
  const melhor = ordem.find((e) => reais.some((c) => c.status === e));
  let overallStatus: 'pending' | 'homologated' | 'ready_for_homologation' | 'awaiting_agent' | 'channel_not_implemented';
  if (!reais.length) overallStatus = 'pending';
  else if (melhor === 'homologated') overallStatus = 'homologated';
  else if (melhor === 'ready_for_homologation' || melhor === 'inactive') overallStatus = 'ready_for_homologation';
  else if (melhor === 'channel_not_implemented') overallStatus = 'channel_not_implemented';
  else overallStatus = 'awaiting_agent';
  return {
    overallStatus,
    productionBlocked: !env.paymentTerminalProductionEnabled,
    terminalEnabled: env.paymentTerminalEnabled,
    providers,
    configurations: configs,
    blockingReasons: configs.flatMap((c) => c.blockingReasons.map((m) => `${c.displayName ?? c.providerName}: ${m}`)),
  };
}
