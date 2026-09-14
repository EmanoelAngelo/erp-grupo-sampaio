/**
 * O PROVEDOR DE ENVIO — a interface que o serviço de envios conhece, e as
 * implementações que o servidor aceita (GAP-PRD-120, GAP-PRD-119).
 *
 * O serviço de envios (`EnvioDoPedidoService`) não fala HTTP: ele pede ao
 * provedor da EMPRESA que ponha o envio no carrinho, pague, gere, imprima,
 * rastreie e cancele. Quem implementa hoje:
 *
 *   - Melhor Envio (`MelhorEnvioEnvioClient`), com o token e o AMBIENTE da
 *     credencial guardada pela tela — a mesma régua da cotação
 *     (`resolveCarrierAccess`): sem credencial, sem produção liberada no
 *     processo, ou com token de sandbox em servidor de produção, não há
 *     provedor, e a recusa diz por quê;
 *   - o provedor de TESTE, que só os testes registram — e que o servidor de
 *     produção RECUSA, no registro e no uso (`DEVORA_API_ENV=production` ou
 *     `NODE_ENV=production`).
 *
 * Correios e Jadlog NÃO têm implementação direta (GAP-PRD-118): os serviços
 * deles são comprados e rastreados pelo Melhor Envio, que os intermedia.
 *
 * O provedor devolve os estados já no vocabulário do sistema. O mapeamento do
 * vocabulário do Melhor Envio mora aqui, e só aqui.
 */
import { ApiError } from '../../utils/errors.js';
import { mensagemDoBloqueio, processoDeProducao, resolveCarrierAccess } from './LogisticsCarrierAdapter.js';
import { getLogisticsCredentialRow, getLogisticsCredentials } from './LogisticsCredentialService.js';
import {
  cancelarEtiqueta,
  colocarNoCarrinho,
  gerarEtiqueta,
  linkDaEtiqueta,
  pagarEtiqueta,
  rastrearEnvios,
  removerDoCarrinho,
  type ContextoMelhorEnvio,
  type EnvioNoCarrinho,
  type PedidoDeEtiqueta,
} from './MelhorEnvioEnvioClient.js';

export type EstadoDoEnvio =
  | 'pendente'
  | 'paga'
  | 'etiqueta_gerada'
  | 'postado'
  | 'entregue'
  | 'nao_entregue'
  | 'cancelado';

export interface EventoDoProvedor {
  status: EstadoDoEnvio;
  descricao: string;
  /** ISO 8601. */
  em: string;
  /** Estável entre consultas: a mesma postagem lida duas vezes é uma linha só. */
  chave: string;
}

export interface SituacaoDoEnvio {
  /** `null` quando o provedor mandou um estado que o sistema não conhece. */
  estado: EstadoDoEnvio | null;
  estadoBruto: string | null;
  codigoDeRastreio: string | null;
  eventos: EventoDoProvedor[];
}

export interface ProvedorDeEnvio {
  /** 'melhor_envio' ou 'teste'. */
  readonly id: string;
  readonly ambiente: 'sandbox' | 'production';
  colocarNoCarrinho(pedido: PedidoDeEtiqueta): Promise<EnvioNoCarrinho>;
  pagar(ref: string): Promise<void>;
  gerar(ref: string): Promise<void>;
  linkDaEtiqueta(ref: string): Promise<string>;
  consultar(refs: string[]): Promise<Record<string, SituacaoDoEnvio>>;
  removerDoCarrinho(ref: string): Promise<void>;
  cancelar(ref: string, motivo: string): Promise<void>;
}

// ---------------------------------------------------------------- Melhor Envio

/** O estado do Melhor Envio no vocabulário do sistema. */
export function estadoDoMelhorEnvio(bruto: string | null | undefined): EstadoDoEnvio | null {
  switch (String(bruto ?? '').toLowerCase()) {
    case 'pending':
      return 'pendente';
    case 'released':
    case 'paid':
      return 'paga';
    case 'generated':
    case 'printed':
      return 'etiqueta_gerada';
    case 'posted':
      return 'postado';
    case 'delivered':
      return 'entregue';
    case 'undelivered':
      return 'nao_entregue';
    case 'canceled':
    case 'cancelled':
    case 'expired':
      return 'cancelado';
    default:
      return null;
  }
}

const MARCO: Record<string, { status: EstadoDoEnvio; descricao: string }> = {
  created_at: { status: 'pendente', descricao: 'Envio criado no Melhor Envio' },
  paid_at: { status: 'paga', descricao: 'Etiqueta paga' },
  generated_at: { status: 'etiqueta_gerada', descricao: 'Etiqueta gerada' },
  posted_at: { status: 'postado', descricao: 'Encomenda postada na transportadora' },
  delivered_at: { status: 'entregue', descricao: 'Entrega confirmada pela transportadora' },
  canceled_at: { status: 'cancelado', descricao: 'Envio cancelado' },
  expired_at: { status: 'cancelado', descricao: 'Etiqueta expirada sem postagem' },
};

/**
 * A data do Melhor Envio vem como "2026-09-10 14:32:05", sem fuso: é horário
 * de Brasília. Sem o fuso explícito, o servidor leria como UTC e a postagem
 * apareceria três horas adiantada para o cliente.
 */
export function dataDoMelhorEnvio(bruto: string): string {
  const t = bruto.trim().replace(' ', 'T');
  const comFuso = /[zZ]|[+-]\d{2}:?\d{2}$/.test(t) ? t : `${t}-03:00`;
  const d = new Date(comFuso);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

class ProvedorMelhorEnvio implements ProvedorDeEnvio {
  readonly id = 'melhor_envio';

  constructor(
    private readonly ctx: ContextoMelhorEnvio,
    readonly ambiente: 'sandbox' | 'production',
  ) {}

  colocarNoCarrinho(pedido: PedidoDeEtiqueta) {
    return colocarNoCarrinho(this.ctx, pedido);
  }

  pagar(ref: string) {
    return pagarEtiqueta(this.ctx, ref);
  }

  gerar(ref: string) {
    return gerarEtiqueta(this.ctx, ref);
  }

  linkDaEtiqueta(ref: string) {
    return linkDaEtiqueta(this.ctx, ref);
  }

  async consultar(refs: string[]): Promise<Record<string, SituacaoDoEnvio>> {
    const brutos = await rastrearEnvios(this.ctx, refs);
    const saida: Record<string, SituacaoDoEnvio> = {};
    for (const [id, s] of Object.entries(brutos)) {
      saida[id] = {
        estado: estadoDoMelhorEnvio(s.status),
        estadoBruto: s.status,
        codigoDeRastreio: s.tracking ?? s.melhorEnvioTracking,
        eventos: s.marcos
          .filter((m) => MARCO[m.chave])
          .map((m) => ({ ...MARCO[m.chave], em: dataDoMelhorEnvio(m.em), chave: `me:${m.chave}` })),
      };
    }
    return saida;
  }

  removerDoCarrinho(ref: string) {
    return removerDoCarrinho(this.ctx, ref);
  }

  cancelar(ref: string, motivo: string) {
    return cancelarEtiqueta(this.ctx, ref, motivo);
  }
}

// ---------------------------------------------------------------- de teste

let provedorDeTeste: ProvedorDeEnvio | null = null;

function recusaDeProducao(): ApiError {
  return new ApiError(
    'LOGISTICS_TEST_PROVIDER_IN_PRODUCTION',
    'O provedor de envio de TESTE não opera em servidor de produção (DEVORA_API_ENV/NODE_ENV=production).',
    500,
  );
}

/**
 * Registra (ou tira, com `null`) o provedor de teste. Só a suíte chama.
 *
 * Em servidor de produção o registro é RECUSADO — e o uso também, em
 * `abrirProvedorDeEnvio`, caso o ambiente mude depois do registro: etiqueta de
 * mentira não pode chegar a cliente de verdade.
 */
export function registrarProvedorDeTeste(p: ProvedorDeEnvio | null): void {
  if (p && processoDeProducao()) throw recusaDeProducao();
  provedorDeTeste = p;
}

// ---------------------------------------------------------------- abertura

/**
 * O provedor de envio da empresa, pronto para usar — ou a recusa com o motivo.
 *
 * O acesso é o MESMO da cotação: quem cota em produção compra em produção;
 * quem só tem token de sandbox compra no sandbox (e isso só fora de servidor
 * de produção). Simulação não compra etiqueta: não há etiqueta simulada que a
 * agência aceite.
 */
export function abrirProvedorDeEnvio(companyId: string): ProvedorDeEnvio {
  if (provedorDeTeste) {
    if (processoDeProducao()) throw recusaDeProducao();
    return provedorDeTeste;
  }
  const access = resolveCarrierAccess(companyId, 'melhor_envio');
  if (access.mode === 'none') {
    throw new ApiError(
      'LOGISTICS_PROVIDER_NOT_CONFIGURED',
      'Nenhum token do Melhor Envio guardado nesta operação. Guarde-o em Loja → Logística.',
      409,
      { locks: access.locks },
    );
  }
  if (!access.realCalls || (access.mode !== 'production' && access.mode !== 'sandbox')) {
    throw new ApiError('LOGISTICS_PROVIDER_BLOCKED', mensagemDoBloqueio(access), 409, { locks: access.locks });
  }
  const creds = getLogisticsCredentials(companyId, 'melhor_envio');
  const token = String(creds?.token ?? creds?.apiKey ?? '');
  if (!token) {
    throw new ApiError('LOGISTICS_PROVIDER_NOT_CONFIGURED', 'O token do Melhor Envio não pôde ser lido do cofre.', 409);
  }
  const row = getLogisticsCredentialRow(companyId, 'melhor_envio');
  const contato = String(row?.contactEmail ?? '').trim() || null;
  const ambiente = access.mode === 'production' ? 'production' : 'sandbox';
  return new ProvedorMelhorEnvio({ token, ambiente, contato }, ambiente);
}
