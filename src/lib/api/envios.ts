/**
 * O envio do pedido — etiqueta, rastreio e despacho (GAP-PRD-120, GAP-PRD-119).
 *
 * As regras moram no servidor: a prontidão diz o que falta, e cada envio vem
 * com `actions` dizendo o que a tela pode oferecer (imprimir, retomar,
 * atualizar, cancelar). A tela não decide nada sobre estados — ela pergunta.
 */
import { apiRequest } from './client';
import { uuid } from '@/lib/uuid';

export type EstadoDoEnvio =
  | 'pendente'
  | 'paga'
  | 'etiqueta_gerada'
  | 'postado'
  | 'entregue'
  | 'nao_entregue'
  | 'cancelado';

export interface EventoDoEnvio {
  status: string;
  description: string;
  occurredAt: string;
  /** 'provedor' | 'operador' | 'sistema' */
  origin: string;
  userName: string | null;
}

export interface Envio {
  id: string;
  orderId: string;
  channel: 'melhor_envio' | 'manual';
  carrier: string;
  carrierName: string | null;
  serviceCode: string | null;
  serviceName: string | null;
  environment: 'sandbox' | 'production' | null;
  status: EstadoDoEnvio;
  statusLabel: string;
  trackingCode: string | null;
  trackingUrl: string | null;
  priceCents: number | null;
  invoiceKey: string | null;
  contentDeclaration: boolean;
  lastError: string | null;
  lastSync: { at: string; ok: boolean; message: string | null } | null;
  dispatchedAt: string | null;
  deliveredAt: string | null;
  deliveredOrigin: string | null;
  cancelledAt: string | null;
  createdAt: string;
  actions: { pagarEGerar: boolean; imprimir: boolean; sincronizar: boolean; cancelar: boolean };
  events: EventoDoEnvio[];
}

export interface Destinatario {
  nome: string;
  documento: string;
  telefone: string;
  email: string;
  logradouro: string;
  numero: string;
  complemento: string;
  bairro: string;
  cidade: string;
  uf: string;
  cep: string;
}

export interface PendenciaDoEnvio {
  chave: string;
  mensagem: string;
  onde: string | null;
}

export interface ProntidaoDaEtiqueta {
  pedido: { id: string; number: number; status: string; entrega: boolean };
  canal: { mode: string; ambiente: 'sandbox' | 'production' | null; disponivel: boolean; motivo: string | null };
  envioVivo: { id: string; status: EstadoDoEnvio; channel: string } | null;
  servico: { code: string; name: string } | null;
  pacote: { weightGrams: number; heightCm: number; widthCm: number; lengthCm: number } | null;
  remetente: { nome: string; cidade: string; uf: string; cep: string } | null;
  destinatarioSugerido: Partial<Destinatario>;
  nota: { chave: string; numero: number; ambiente: string } | null;
  declaracaoDeConteudoPermitida: boolean;
  faltando: PendenciaDoEnvio[];
  podeComprar: boolean;
}

export interface ServicoCotado {
  code: string;
  name: string;
  priceCents: number;
  estimatedDays: number | null;
  environment: 'sandbox' | 'production' | null;
}

export interface ResultadoDaCompra {
  envio: Envio;
  /** A compra parou no meio (saldo, geração): o envio existe e se retoma. */
  aviso: string | null;
}

export interface ConfiguracaoDeEnvio {
  permitirDeclaracaoDeConteudo: boolean;
  agenciaJadlog: string | null;
  atualizadoEm: string | null;
}

/** Quem leva a encomenda no despacho sem etiqueta do provedor. */
export const TRANSPORTADORAS_DO_DESPACHO: { valor: string; rotulo: string }[] = [
  { valor: 'correios', rotulo: 'Correios' },
  { valor: 'jadlog', rotulo: 'Jadlog' },
  { valor: 'melhor_envio', rotulo: 'Melhor Envio (etiqueta comprada fora do sistema)' },
  { valor: 'generic', rotulo: 'Outra transportadora' },
  { valor: 'propria', rotulo: 'Entrega da loja (motoboy, carro próprio)' },
];

export const enviosApi = {
  doPedido: (orderId: string) =>
    apiRequest<{ readiness: ProntidaoDaEtiqueta; items: Envio[] }>(
      `/logistics/orders/${encodeURIComponent(orderId)}/shipments`,
    ),

  servicos: (orderId: string) =>
    apiRequest<{ options: ServicoCotado[]; message: string | null }>(
      `/logistics/orders/${encodeURIComponent(orderId)}/services`,
      { method: 'POST', body: {} },
    ),

  /** Gasta saldo da carteira do provedor: chave de idempotência por clique. */
  comprarEtiqueta: (
    orderId: string,
    input: { destinatario: Destinatario; servico?: { code: string; name: string } | null },
    idempotencyKey = `etiqueta-${uuid()}`,
  ) =>
    apiRequest<ResultadoDaCompra>(`/logistics/orders/${encodeURIComponent(orderId)}/label`, {
      method: 'POST',
      body: input,
      idempotencyKey,
    }),

  continuar: (shipmentId: string) =>
    apiRequest<ResultadoDaCompra>(`/logistics/shipments/${encodeURIComponent(shipmentId)}/continue`, {
      method: 'POST',
      body: {},
    }),

  linkDaEtiqueta: (shipmentId: string) =>
    apiRequest<{ url: string }>(`/logistics/shipments/${encodeURIComponent(shipmentId)}/label`),

  atualizarRastreio: (shipmentId: string) =>
    apiRequest<Envio>(`/logistics/shipments/${encodeURIComponent(shipmentId)}/sync`, { method: 'POST', body: {} }),

  cancelar: (shipmentId: string, motivo: string) =>
    apiRequest<Envio>(`/logistics/shipments/${encodeURIComponent(shipmentId)}/cancel`, {
      method: 'POST',
      body: { motivo },
    }),

  lerConfiguracao: () => apiRequest<ConfiguracaoDeEnvio>('/logistics/settings/shipping'),

  salvarConfiguracao: (input: { permitirDeclaracaoDeConteudo: boolean; agenciaJadlog: string | null }) =>
    apiRequest<ConfiguracaoDeEnvio>('/logistics/settings/shipping', { method: 'PUT', body: input }),
};

// -------------------------------------------------------------- dia 1

export interface ItemDoDiaUm {
  chave: string;
  titulo: string;
  estado: 'ok' | 'pendente' | 'escolha';
  detalhe: string;
  quem: 'loja' | 'servidor';
  onde: string | null;
}

export interface ProntidaoDaOperacao {
  companyId: string;
  companyName: string;
  itens: ItemDoDiaUm[];
  pendentes: number;
  pronta: boolean;
}

export const diaUmApi = {
  ler: () => apiRequest<{ operacoes: ProntidaoDaOperacao[] }>('/core/loja/prontidao-do-dia-1'),
};
