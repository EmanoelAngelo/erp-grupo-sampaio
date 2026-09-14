/**
 * Em quantas vezes o carrinho pode ir no cartão (GAP-PRD-114).
 *
 * O selo "Parcele em até Nx" era tudo o que a loja dizia — o checkout não
 * oferecia a escolha e a cobrança ia à vista. Aqui mora a MESMA conta que o
 * servidor faz antes de o pedido nascer (`ParcelamentoNoCartao.ts`):
 *
 *   - o carrinho vira um pedido por loja, e a escolha vale para todos — então
 *     o máximo é o MENOR teto entre as lojas do carrinho;
 *   - loja sem teto (ou com teto 1) vende no cartão só à vista;
 *   - nenhuma parcela abaixo de R$ 5,00, a mínima do provedor.
 *
 * A tela só oferece o que o servidor vai aceitar; a recusa dele continua
 * valendo para quem chamar a API por fora.
 */

export const PARCELA_MINIMA_CENTS = 500;

export interface LojaDoCarrinho {
  nome: string;
  /** Itens + frete desta loja: é o valor da cobrança dela. */
  totalCents: number;
  /** Teto de parcelas no cartão. Nulo = só à vista. */
  teto: number | null;
}

export function maximoDeParcelas(lojas: LojaDoCarrinho[]): number {
  if (lojas.length === 0) return 1;
  let maximo = Infinity;
  for (const loja of lojas) {
    const teto = loja.teto != null && loja.teto > 1 ? loja.teto : 1;
    const pelaMinima = Math.max(1, Math.floor(loja.totalCents / PARCELA_MINIMA_CENTS));
    maximo = Math.min(maximo, teto, pelaMinima);
  }
  return Number.isFinite(maximo) ? Math.max(1, maximo) : 1;
}

const emReais = (cents: number) =>
  `R$ ${(cents / 100).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;

/**
 * "6x de R$ 100,00" — a sobra de centavos vai numa parcela, como o provedor
 * faz; a frase diz isso em vez de prometer parcelas iguais que não são.
 */
export function descreverParcelas(totalCents: number, parcelas: number): string {
  if (parcelas <= 1) return `à vista, ${emReais(totalCents)}`;
  const base = Math.floor(totalCents / parcelas);
  const sobra = totalCents - base * parcelas;
  return sobra === 0
    ? `${parcelas}x de ${emReais(base)}`
    : `${parcelas}x de ${emReais(base)} (uma de ${emReais(base + sobra)})`;
}
