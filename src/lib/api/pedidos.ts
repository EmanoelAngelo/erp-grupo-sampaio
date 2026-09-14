/**
 * Ações do gestor sobre o pedido online (lote E4 da remediação).
 *
 * Módulo próprio, fora de `core.ts`: cada chamada aqui é uma porta que o
 * servidor já guarda com perfil e motivo. A tela só leva o que a pessoa disse.
 */
import { apiRequest } from './client';
import type { SolicitacaoDeDevolucao } from './posVenda';

export interface PedidoMinimo {
  id: string;
  number: number;
  status: string;
}

/** O que a devolução fez — lido do banco pelo servidor (GAP-PRD-122/031). */
export interface ResultadoDaDevolucao {
  status: string;
  providerRefund: 'done' | 'failed' | 'not_applicable';
  /** Quitada pelo provedor, a pagar em Contas, ou sem receita a contrapor. */
  dinheiro: 'devolvido_pelo_provedor' | 'a_devolver' | 'sem_receita';
  /** Voltou ao estoque, ou aguarda o recebimento conferido. */
  mercadoria: 'recebida' | 'aguardando' | 'nao_se_aplica';
  pendenciaFiscal: string | null;
}

/**
 * O que a devolução fez, em palavras — dinheiro, mercadoria e fiscal
 * (GAP-PRD-031, GAP-PRD-122). É o servidor quem diz; a tela só traduz.
 */
export function resumoDaDevolucao(numero: number, r: ResultadoDaDevolucao): string {
  const partes = [`Pedido #${numero} devolvido.`];
  if (r.dinheiro === 'devolvido_pelo_provedor') {
    partes.push('O estorno saiu pelo provedor e a saída já está quitada no financeiro.');
  } else if (r.dinheiro === 'a_devolver') {
    partes.push(
      r.providerRefund === 'failed'
        ? 'O estorno no provedor FALHOU: o reembolso ficou em Contas a pagar — devolva ao cliente e dê a baixa lá.'
        : 'O reembolso ficou em Contas a pagar — devolva ao cliente e dê a baixa lá.',
    );
  }
  if (r.mercadoria === 'recebida') partes.push('A mercadoria voltou ao estoque.');
  else if (r.mercadoria === 'aguardando') {
    partes.push(
      'O estoque só volta quando a mercadoria for conferida: use "Confirmar recebimento" na ficha do pedido.',
    );
  }
  if (r.pendenciaFiscal) partes.push(r.pendenciaFiscal);
  return partes.join(' ');
}

export interface RecebimentoDaDevolucao {
  orderId: string;
  itens: {
    productId: string;
    description: string;
    quantidadeDoPedido: number;
    voltouAoEstoque: number;
  }[];
  unidadesDeVolta: number;
  unidadesQueNaoVoltaram: number;
}

export const pedidosApi = {
  /** Cancela pedido ainda não pago — solta a reserva e a cobrança (GAP-PRD-124). */
  cancelar: (orderId: string, reason: string) =>
    apiRequest<PedidoMinimo>(`/core/orders/${orderId}/cancel`, {
      method: 'POST',
      body: { reason },
    }),
  /** Volta UMA etapa do fulfillment, com motivo (GAP-PRD-121). Só gerência. */
  desfazerEtapa: (orderId: string, reason: string) =>
    apiRequest<PedidoMinimo>(`/core/orders/${orderId}/fulfillment/voltar`, {
      method: 'POST',
      body: { reason },
    }),
  /**
   * Devolve o pedido pago: o dinheiro volta; a mercadoria volta ao estoque só
   * se estiver na mão (`mercadoriaNaMao`; omitido, o servidor decide pela
   * etapa).
   */
  devolver: (orderId: string, body: { reason: string; mercadoriaNaMao?: boolean }) =>
    apiRequest<ResultadoDaDevolucao>(`/core/orders/${orderId}/devolver`, {
      method: 'POST',
      body,
    }),
  /** A loja decide o pedido de devolução que a cliente abriu no portal (GAP-PRD-125). */
  decidirSolicitacao: (
    orderId: string,
    requestId: string,
    body: { decisao: 'aprovar' | 'recusar'; nota?: string },
  ) =>
    apiRequest<SolicitacaoDeDevolucao>(
      `/core/orders/${orderId}/devolucao/solicitacoes/${requestId}/decidir`,
      { method: 'POST', body },
    ),
  /** O recebimento conferido: quanto de cada item voltou vendável. */
  receberDevolucao: (
    orderId: string,
    body: { itens?: { productId: string; quantidade: number }[]; nota?: string },
  ) =>
    apiRequest<RecebimentoDaDevolucao>(`/core/orders/${orderId}/devolucao/receber`, {
      method: 'POST',
      body,
    }),
};
