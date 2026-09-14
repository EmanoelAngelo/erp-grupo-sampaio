/**
 * Quem pode fechar pedido na loja online desta operação (GAP-PRD-028).
 *
 * Módulo próprio, fora de `core.ts`, porque é um assunto só e cabe em duas
 * chamadas. O servidor é quem decide: sem escolha do dono, vale 'conta'.
 */
import { apiRequest } from './client';

export type ModoDoCheckout = 'conta' | 'visitante';

export interface PoliticaDoCheckout {
  mode: ModoDoCheckout;
  /** O que vale quando o dono ainda não escolheu. */
  padrao: ModoDoCheckout;
  /** Falso = está valendo o padrão, ninguém escolheu ainda. */
  configurado: boolean;
}

export const checkoutPolicyApi = {
  obter: () => apiRequest<PoliticaDoCheckout>('/core/storefront/checkout-policy'),
  definir: (mode: ModoDoCheckout) =>
    apiRequest<PoliticaDoCheckout>('/core/storefront/checkout-policy', {
      method: 'PUT',
      body: { mode },
    }),
};
