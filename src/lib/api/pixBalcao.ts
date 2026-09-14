/**
 * PIX do balcão pelo Asaas (GAP-PRD-077) — o cliente das rotas do QR, da
 * consulta, da desistência e da fila de pendentes.
 *
 * Módulo próprio para o diálogo de pagamento do PDV e o cartão da fila em
 * Contas a receber dependerem só do que usam.
 */
import { apiRequest, envelope } from './client';

export interface StatusDoPixDoBalcao {
  /** O provedor de cobrança gera QR nesta operação. */
  disponivel: boolean;
  ambiente: 'sandbox' | 'production' | null;
  /** A frase para a tela: por que é manual, ou que o QR é de teste. */
  motivo: string;
}

export interface PixDoBalcao {
  intentId: string;
  /** pending | overdue | confirmed | cancelled | failed | amount_mismatch… */
  status: string;
  amountCents: number;
  environment: string;
  providerRef: string | null;
  pixPayload: string | null;
  pixImageBase64: string | null;
  expiresAt: string | null;
  saleId: string | null;
  lastError: string | null;
}

export interface PixPendenteDoBalcao {
  saleId: string;
  saleNumber: number;
  paymentId: string;
  amountCents: number;
  createdAt: string;
  ageDays: number;
  viaProvedor: boolean;
  intentId: string | null;
  intentStatus: string | null;
  providerRef: string | null;
  lastError: string | null;
}

export const pixBalcaoApi = {
  status: () => apiRequest<StatusDoPixDoBalcao>('/core/pdv/pix-asaas/status'),

  /** Gera (ou recupera, pela referência) o QR. A referência é da tela, uma por QR. */
  gerar: (input: {
    amountCents: number;
    referencia: string;
    customerId?: string | null;
    pagadorDocumento?: string | null;
    pagadorNome?: string | null;
  }) => apiRequest<PixDoBalcao>('/core/pdv/pix-asaas', { method: 'POST', body: input }),

  /** Lê o que o ERP sabe; com `consultar`, pergunta ao provedor. */
  situacao: (intentId: string, consultar = false) =>
    apiRequest<PixDoBalcao>(`/core/pdv/pix-asaas/${intentId}${consultar ? '?consultar=1' : ''}`),

  cancelar: (intentId: string) =>
    apiRequest<PixDoBalcao>(`/core/pdv/pix-asaas/${intentId}/cancel`, { method: 'POST' }),

  pendentes: () =>
    apiRequest<{ items: PixPendenteDoBalcao[] }>('/core/pdv/pix-pendentes').then(envelope('items')),

  confirmarPendente: (saleId: string, paymentId: string, note?: string) =>
    apiRequest<{ liquidada: boolean; detail: string }>(
      `/core/sales/${saleId}/payments/${paymentId}/confirmar`,
      { method: 'POST', body: note ? { note } : {} },
    ),
};
