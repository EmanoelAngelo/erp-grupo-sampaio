/**
 * A loja aberta para visitante — a decisão que o DONO pode tomar (GAP-PRD-028).
 *
 * Desde o lote E1 da remediação, comprar na loja online exige conta por
 * padrão. Os arquivos que testam FRETE, RESERVA, PAGAMENTO e PREÇO pelo
 * checkout público não falam de identidade: eles declaram que a loja deles
 * está aberta para visitante, pela MESMA função que a tela do dono usa. A
 * identidade do checkout é cobrada em `checkout-exige-conta.test.ts` e em
 * `checkout-cpf-alheio-nao-sequestra.test.ts`.
 */
import { definirModoDoCheckout } from '../../src/services/core/CheckoutIdentityService.js';

export function abrirParaVisitante(...companyIds: string[]): void {
  for (const companyId of companyIds) definirModoDoCheckout(companyId, 'visitante');
}

/**
 * Quem compra sem conta, com o que o servidor exige desde o GAP-PRD-191:
 * CPF com dígito verificador certo e e-mail válido. Os arquivos que testam
 * frete, reserva e pagamento pelo checkout de visitante espalham isto no
 * corpo; a recusa sem os dois é cobrada em
 * `checkout-visitante-confere-dados.test.ts`.
 */
export const VISITANTE = {
  customerDocument: '529.982.247-25',
  customerEmail: 'visitante@exemplo.com',
} as const;
