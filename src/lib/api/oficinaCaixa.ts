/**
 * O caixa da oficina — fila, recebimento e estorno da OS (GAP-PRD-042/104/209/105).
 *
 * Módulo próprio, fora de `coreApi`, pelo mesmo motivo que o serviço do
 * servidor mora fora do roteador: é um domínio só, e tê-lo inteiro num
 * arquivo é o que deixa a tela do PDV e a ficha da OS falarem a MESMA língua
 * com o servidor.
 */
import { apiRequest } from './client';
import type { Sale } from './core';

/** Uma OS esperando o caixa, como a fila a devolve (projeção de `searchOrders`). */
export interface OsAReceber {
  id: string;
  number: number;
  status: string;
  customer_id: string | null;
  customer_display: string | null;
  equipment_display: string | null;
  equipment_public_id?: string | null;
  plate?: string | null;
  workshop_name: string | null;
  mechanic_name: string | null;
  labor_cents: number;
  parts_cents: number;
  total_cents: number;
  status_changed_at?: string | null;
}

export interface FilaDeRecebimento {
  items: OsAReceber[];
  total: number;
  /** A empresa tem bancada? Sem ela, o PDV não oferece "OS a receber". */
  temOficina: boolean;
  /** Faturar a OS para o cliente, e em quantos dias vence. Decisão do dono. */
  faturamentoAPrazo: { habilitado: boolean; prazoDias: number };
}

export interface LinhaDePagamento {
  method: string;
  amountCents: number;
  /** A cobrança da maquininha que autorizou a linha, quando passou por ela. */
  providerRef?: string;
}

export interface CorpoDoRecebimento {
  payments: LinhaDePagamento[];
  cashSessionId?: string | null;
  discountCents?: number;
  surchargeCents?: number;
  customerCreditCents?: number;
  authorizationId?: string | null;
}

/** A OS como volta do recebimento e do estorno — só o que a tela lê. */
export interface OsDoCaixa {
  id: string;
  number: number;
  status: string;
  sale_id: string | null;
  paid_at: string | null;
  total_cents: number;
}

export interface RecebimentoDaOs {
  order: OsDoCaixa;
  sale: Sale;
  /** Verdadeiro quando o servidor devolveu o recebimento que já tinha acontecido. */
  replay: boolean;
}

export const oficinaCaixaApi = {
  fila: () =>
    apiRequest<FilaDeRecebimento>('/core/workshop/pending-payment').then((r) => ({
      items: Array.isArray(r?.items) ? r.items : [],
      total: Number(r?.total ?? 0),
      temOficina: r?.temOficina === true,
      faturamentoAPrazo: {
        habilitado: r?.faturamentoAPrazo?.habilitado === true,
        prazoDias: Number(r?.faturamentoAPrazo?.prazoDias ?? 0),
      },
    })),

  /**
   * A chave vai no cabeçalho e é da TELA: uma por recebimento, a mesma em
   * toda nova tentativa. É ela que faz o reenvio depois de queda de rede
   * devolver o recebimento que já aconteceu, em vez de cobrar de novo.
   */
  receber: (orderId: string, corpo: CorpoDoRecebimento, idempotencyKey: string) =>
    apiRequest<RecebimentoDaOs>(`/core/workshop/orders/${orderId}/checkout`, {
      method: 'POST',
      body: corpo,
      idempotencyKey,
    }),

  estornar: (orderId: string, reason: string, authorizationId?: string) =>
    apiRequest<{ order: OsDoCaixa; sale: Sale }>(`/core/workshop/orders/${orderId}/estorno`, {
      method: 'POST',
      body: { reason, authorizationId },
    }),
};
