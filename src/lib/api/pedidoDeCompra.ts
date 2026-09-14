/**
 * O pedido de compra que SAI do sistema — papel e e-mail (GAP-PRD-090).
 *
 * "Enviar ao fornecedor" só mudava o status: nada saía. As duas rotas daqui são
 * o que sai de verdade — o A4 do pedido e a mensagem na fila de e-mail com o A4
 * anexado. Módulo próprio pela regra da casa: `core.ts` intocado.
 */
import { apiRequest } from './client';
import type { PurchaseOrderDetail } from './core';

export interface PedidoParaPapel {
  html: string;
  numero: number;
  status: string;
  fornecedor: string;
  emailDoFornecedor: string | null;
}

export interface EnvioDoPedidoPorEmail {
  /** false = já havia uma mensagem igual pendente na fila; nada novo entrou. */
  queued: boolean;
  toAddress: string;
  /** READY = o carteiro entrega; READY_FOR_CREDENTIAL = fica na fila até existir SMTP. */
  readiness: 'READY' | 'READY_FOR_CREDENTIAL';
  missing: string[];
  order: PurchaseOrderDetail;
}

export const pedidoDeCompraApi = {
  impressao: (id: string) =>
    apiRequest<PedidoParaPapel>(`/core/purchase-orders/${encodeURIComponent(id)}/impressao`),

  /** `to` só quando quem compra quer outro endereço que não o do cadastro. */
  enviarPorEmail: (id: string, to?: string) =>
    apiRequest<EnvioDoPedidoPorEmail>(`/core/purchase-orders/${encodeURIComponent(id)}/email`, {
      method: 'POST',
      body: to ? { to } : {},
    }),
};
