/**
 * A FRONTEIRA ENTRE A LOJA DE MOTOS E A OFICINA, NA TELA (GAP-PRD-109, GAP-PRD-189).
 *
 *   moto do estoque   plaquinha interna ainda não vendida: a OS dela é de
 *                     montagem ou preparação interna, sem cliente do cadastro
 *                     (o servidor recusa com CORE_ORDER_STOCK_MOTO_WITH_CUSTOMER);
 *   venda à mão       a plaquinha interna marcada vendida sem venda no sistema:
 *                     a ficha desfaz, com motivo, para a moto sair pelo PDV —
 *                     `POST /core/equipment/:id/owner/desfazer`.
 */
import { apiRequest } from './client';

export const vendaAMaoApi = {
  desfazer: (equipmentId: string, motivo: string) =>
    apiRequest<Record<string, unknown>>(`/core/equipment/${equipmentId}/owner/desfazer`, {
      method: 'POST',
      body: { motivo },
    }),
};

/**
 * A máquina é moto do ESTOQUE do grupo, ainda não vendida? Devolve a loja em
 * cujo pátio ela está (quando a unidade já a adotou), ou `null` se não for.
 */
export function motoDoEstoque(
  e:
    | { origin?: string; sale_status?: string; estoque?: { companyName: string } | null }
    | null
    | undefined,
): { loja: string | null } | null {
  if (!e || e.origin !== 'INTERNAL_PJ_MOTORS' || e.sale_status !== 'NOT_SOLD') return null;
  return { loja: e.estoque?.companyName ?? null };
}

/** A frase do aviso, a mesma no PDV da oficina e no quadro. */
export function avisoDeMotoDoEstoque(estoque: { loja: string | null }): string {
  return (
    `Moto do estoque ${estoque.loja ? `da ${estoque.loja}` : 'do grupo'}, ainda não vendida: a OS é de `
    + 'montagem ou preparação interna, sem cliente. Depois da venda, a moto passa a ser do comprador e a OS '
    + 'dele abre com o cadastro.'
  );
}
