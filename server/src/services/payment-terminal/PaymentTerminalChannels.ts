/**
 * POR ONDE A COBRANÇA CHEGA AO APARELHO — e se esse caminho existe (GAP-PRD-014).
 *
 * ## O que havia
 *
 * Sete provedores "estruturais": qualquer configuração que não fosse o mock
 * era aceita, contada como maquininha integrada pelo balcão, e toda cobrança
 * devolvia `failed`. Cadastrar a credencial da Stone fazia a loja PARAR de
 * vender no cartão — a venda passava a exigir uma transação aprovada que
 * nenhum código sabia produzir. E a prontidão dizia `ready_for_homologation`.
 *
 * ## O que é um canal
 *
 * O provedor diz DE QUEM é o dinheiro (Stone, Cielo, Rede…); o canal diz POR
 * ONDE o pedido de cobrança chega ao aparelho. São três:
 *
 * - `mock`: o provedor de teste. Só em desenvolvimento/teste; em produção e
 *   homologação ele é recusado (GAP-PRD-001).
 * - `local_agent`: o agente local instalado no computador do caixa retira o
 *   comando da fila, fala com o cliente TEF da adquirente (PinPad) e devolve
 *   o resultado assinado. Serve a QUALQUER adquirente que o cliente TEF
 *   atenda — a adquirente é um rótulo para a conferência, não um SDK que este
 *   servidor carregue. É o canal implementado.
 * - `cloud`: a API na nuvem da adquirente, empurrando a cobrança para uma
 *   maquininha "smart". Cada adquirente tem a sua, e NENHUMA está escrita
 *   aqui. Em vez de fingir, este módulo recusa cadastrar e ligar
 *   configuração nesse canal, dizendo por quê.
 *
 * Um canal novo (o adaptador de nuvem de uma adquirente) entra em
 * `ADAPTADORES_DE_NUVEM` e passa a valer para cadastro, ligação, prontidão e
 * balcão de uma vez — a pergunta "existe caminho?" mora só aqui.
 */
import { ApiError } from '../../utils/errors.js';

export type CanalDaMaquininha = 'mock' | 'local_agent' | 'cloud';

export const PROVEDORES_DE_MAQUININHA = [
  'generic_tef',
  'stone',
  'cielo',
  'rede',
  'getnet',
  'pagbank',
  'mercado_pago',
  'mock',
] as const;

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

/**
 * Adquirentes com adaptador de NUVEM escrito e testado neste servidor.
 *
 * Vazio, e é a verdade: nenhum. Quem escolher uma maquininha "smart" que só
 * fala pela nuvem da adquirente precisa deste adaptador antes do go-live — e o
 * sistema diz isso na tela de cadastro, em vez de aceitar a credencial e
 * parar o balcão.
 */
export const ADAPTADORES_DE_NUVEM: ReadonlySet<string> = new Set<string>();

export interface DriverDaMaquininha {
  provider: string;
  channel: CanalDaMaquininha;
  implemented: boolean;
  implementationType: 'mock' | 'local_agent' | 'cloud' | 'not_implemented';
  /** Como a tela nomeia o caminho. */
  label: string;
  /** Por que não opera, quando não opera. */
  reason: string | null;
}

export function provedorConhecido(provider: string): boolean {
  return (PROVEDORES_DE_MAQUININHA as readonly string[]).includes(provider);
}

/** O canal de uma configuração gravada (ou do que se pretende gravar). */
export function canalDe(config: { provider?: unknown; connectionMode?: unknown }): CanalDaMaquininha {
  const provider = String(config.provider ?? 'mock');
  if (provider === 'mock') return 'mock';
  // TEF genérico é, por definição, o cliente TEF no computador do caixa.
  if (provider === 'generic_tef') return 'local_agent';
  return config.connectionMode === 'local_agent' ? 'local_agent' : 'cloud';
}

export function driverDe(config: { provider?: unknown; connectionMode?: unknown }): DriverDaMaquininha {
  const provider = String(config.provider ?? 'mock');
  const channel = canalDe(config);
  const nome = NOME_DO_PROVEDOR[provider] ?? provider;
  if (channel === 'mock') {
    return {
      provider,
      channel,
      implemented: true,
      implementationType: 'mock',
      label: 'Maquininha de TESTE (simulada)',
      reason: null,
    };
  }
  if (channel === 'local_agent') {
    return {
      provider,
      channel,
      implemented: true,
      implementationType: 'local_agent',
      label: `${nome} pelo agente local (PinPad + cliente TEF)`,
      reason: null,
    };
  }
  const temAdaptador = ADAPTADORES_DE_NUVEM.has(provider);
  return {
    provider,
    channel,
    implemented: temAdaptador,
    implementationType: temAdaptador ? 'cloud' : 'not_implemented',
    label: `${nome} pela nuvem da adquirente`,
    reason: temAdaptador
      ? null
      : `A integração pela nuvem da ${nome} não está implementada neste sistema. Use o agente local `
        + '(PinPad com o cliente TEF da adquirente) ou mantenha o cartão lançado à mão.',
  };
}

/**
 * Recusa gravar/ligar uma configuração cujo caminho não existe.
 *
 * É o que impede "cadastrar a credencial deixa o balcão sem cartão": a
 * configuração nem nasce num canal que nenhum código atende.
 */
export function assertCanalImplementado(config: { provider?: unknown; connectionMode?: unknown }): DriverDaMaquininha {
  const provider = String(config.provider ?? 'mock');
  if (!provedorConhecido(provider)) {
    throw new ApiError(
      'PAYMENT_TERMINAL_PROVIDER_UNKNOWN',
      `Provedor de maquininha desconhecido: "${provider}".`,
      400,
      { provider, known: PROVEDORES_DE_MAQUININHA },
    );
  }
  const driver = driverDe(config);
  if (!driver.implemented) {
    throw new ApiError('PAYMENT_TERMINAL_CHANNEL_NOT_IMPLEMENTED', String(driver.reason), 409, {
      provider,
      channel: driver.channel,
    });
  }
  return driver;
}

/** O modo de conexão que o cadastro grava quando ninguém diz: o único que existe. */
export function modoPadrao(provider: string): 'local_agent' | 'cloud' {
  if (provider === 'mock') return 'cloud';
  return 'local_agent';
}
