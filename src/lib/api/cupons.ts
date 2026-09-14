/**
 * Cupons de desconto da loja online — GAP-PRD-123.
 *
 * Dois lados: a GESTÃO (criar, listar, encerrar — `/core/coupons`) e a
 * VITRINE (simular na gaveta do carrinho — `/loja/checkout/cupom`). Quem
 * decide se o cupom vale e quanto desconta é sempre o servidor; o checkout
 * confere de novo.
 */
import { apiRequest, envelope } from '@/lib/api/client';

export interface Cupom {
  id: string;
  code: string;
  description: string | null;
  percent_off: number | null;
  amount_cents: number | null;
  min_order_cents: number;
  starts_at: string;
  ends_at: string | null;
  max_uses: number | null;
  max_uses_per_customer: number | null;
  accumulates_with_promotions: number;
  active: number;
  /** Usos que contam no teto — pedidos não cancelados. */
  uses?: number;
  discount_total_cents?: number;
}

export interface CupomEntrada {
  code: string;
  description?: string;
  percentOff?: number;
  amountCents?: number;
  minOrderCents?: number;
  startsAt?: string;
  endsAt?: string;
  maxUses?: number | null;
  /** Ausente = uma vez por cliente; nulo = sem teto. */
  maxUsesPerCustomer?: number | null;
  accumulatesWithPromotions?: boolean;
}

/** O desconto que o cupom daria no carrinho, loja por loja. */
export interface CupomSimulado {
  code: string;
  discountCents: number;
  lojas: { companyId: string; storeName: string; discountCents: number; description: string | null }[];
}

export const cuponsApi = {
  listar: () => apiRequest<{ items: Cupom[] }>('/core/coupons').then(envelope('items')),
  criar: (corpo: CupomEntrada) =>
    apiRequest<Cupom>('/core/coupons', { method: 'POST', body: corpo }),
  encerrar: (id: string) =>
    apiRequest<Cupom>(`/core/coupons/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};

/**
 * "Aplicar" na gaveta do carrinho. `anonymous` só quer dizer "sem o Bearer do
 * ERP"; com conta vai o token do PORTAL, para o "uma vez por cliente" ser
 * conferido pela conta.
 */
export function simularCupom(input: {
  code: string;
  items: { productId: string; quantity: number }[];
  portalToken?: string | null;
  customerEmail?: string;
}): Promise<CupomSimulado> {
  return apiRequest<CupomSimulado>('/loja/checkout/cupom', {
    method: 'POST',
    anonymous: true,
    headers: input.portalToken ? { 'x-portal-token': input.portalToken } : undefined,
    body: {
      code: input.code,
      items: input.items,
      customerEmail: input.portalToken ? undefined : input.customerEmail,
    },
  });
}
