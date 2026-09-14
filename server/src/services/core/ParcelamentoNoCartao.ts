/**
 * PARCELAMENTO NO CARTÃO DA LOJA ONLINE (GAP-PRD-114).
 *
 * ## O defeito
 *
 * `core_storefront_settings.installments_max` virava o selo "Parcele em até
 * Nx" na vitrine — e mais nada. O checkout não aceitava o número de parcelas e
 * a cobrança de cartão ia ao provedor à vista: o cliente lia "6x" e a fatura
 * nascia em 1x. Promessa comercial que o sistema não cumpria.
 *
 * ## As regras, num lugar só
 *
 *   - PARCELA É DO CARTÃO. PIX e boleto são à vista; pedir parcela neles é
 *     recusado, não ignorado — ignorar faria o cliente achar que parcelou.
 *   - O TETO É DE CADA LOJA. Carrinho com duas operações gera duas cobranças; a
 *     escolha vale para as duas e precisa caber no teto das duas. A recusa
 *     nomeia a loja que não comporta.
 *   - PARCELA MÍNIMA DE R$ 5,00, a do provedor para cartão parcelado. Recusar
 *     aqui, antes do pedido nascer, dá à pessoa o número que cabe; recusar lá
 *     deixaria um pedido com cobrança falha.
 *   - OS CENTAVOS FECHAM PELO PROVEDOR. A cobrança vai com `totalValue` (não
 *     `installmentValue`): o provedor divide e põe a sobra numa parcela, e a
 *     conferência de valor do webhook aceita exatamente essa divisão.
 */
import { getConnection } from '../../db/sqlite.js';
import { ApiError } from '../../utils/errors.js';

/** Menor parcela que o provedor aceita no cartão parcelado. */
export const PARCELA_MINIMA_CENTS = 500;

const emReais = (cents: number) => `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`;

/**
 * O número de parcelas que o checkout pediu. Ausente, nulo ou vazio é 1 (à
 * vista). Qualquer outra coisa tem de ser inteiro de 1 a 24 — o mesmo teto do
 * cadastro da loja.
 */
export function lerParcelasDoCheckout(valor: unknown, metodo: string): number {
  if (valor === undefined || valor === null || valor === '') return 1;
  const n = Number(valor);
  if (!Number.isInteger(n) || n < 1 || n > 24) {
    throw new ApiError(
      'CORE_CHECKOUT_INSTALLMENTS_INVALID',
      'Número de parcelas inválido: escolha de 1 a 24.',
      400,
    );
  }
  if (n > 1 && metodo !== 'cartao') {
    throw new ApiError(
      'CORE_CHECKOUT_INSTALLMENTS_INVALID',
      'Parcelamento é só no cartão de crédito. PIX e boleto são à vista.',
      400,
    );
  }
  return n;
}

/** Quantas vezes cabem neste total sem a parcela ficar abaixo do mínimo. */
export function maximoPelaParcelaMinima(totalCents: number): number {
  return Math.max(1, Math.floor(totalCents / PARCELA_MINIMA_CENTS));
}

/**
 * A escolha cabe NESTA loja? Chamado dentro da transação do checkout, antes
 * de o pedido nascer — a recusa desfaz o carrinho inteiro.
 */
export function conferirParcelasDaLoja(input: {
  companyId: string;
  totalCents: number;
  parcelas: number;
}): void {
  if (input.parcelas <= 1) return;
  const loja = getConnection()
    .prepare(
      `SELECT c.trade_name AS nome, st.installments_max AS teto
         FROM core_companies c
         LEFT JOIN core_storefront_settings st ON st.company_id = c.id
        WHERE c.id = ?`,
    )
    .get(input.companyId) as { nome: string; teto: number | null } | undefined;
  const nome = loja?.nome ?? 'Esta loja';
  const teto = loja?.teto ?? null;

  if (teto === null || teto <= 1) {
    throw new ApiError(
      'CORE_CHECKOUT_INSTALLMENTS_INVALID',
      `${nome} vende no cartão só à vista. Escolha 1x ou separe o pedido.`,
      400,
    );
  }
  if (input.parcelas > teto) {
    throw new ApiError(
      'CORE_CHECKOUT_INSTALLMENTS_INVALID',
      `${nome} parcela em até ${teto}x.`,
      400,
    );
  }
  const cabe = maximoPelaParcelaMinima(input.totalCents);
  if (input.parcelas > cabe) {
    throw new ApiError(
      'CORE_CHECKOUT_INSTALLMENTS_INVALID',
      `A parcela mínima no cartão é ${emReais(PARCELA_MINIMA_CENTS)}: o pedido de ${nome} `
        + `(${emReais(input.totalCents)}) parcela em até ${cabe}x.`,
      400,
    );
  }
}

/** Como o provedor divide: todas iguais e a sobra de centavos numa só. */
export function divisaoDasParcelas(totalCents: number, parcelas: number): { base: number; sobra: number } {
  const base = Math.floor(totalCents / parcelas);
  return { base, sobra: totalCents - base * parcelas };
}

/**
 * O valor desta parcela é coerente com o plano?
 *
 * O webhook de cartão parcelado chega POR PARCELA, com o valor dela. Comparar
 * com o total acusaria divergência em toda confirmação; comparar com
 * igualdade estrita erraria a parcela que carrega a sobra.
 */
export function parcelaCoerente(valorCents: number, totalCents: number, parcelas: number): boolean {
  const { base, sobra } = divisaoDasParcelas(totalCents, parcelas);
  return valorCents >= base && valorCents <= base + sobra;
}

/** "6x de R$ 100,00" ou "3x de R$ 33,33 (uma de R$ 33,34)". */
export function descreverParcelas(totalCents: number, parcelas: number): string {
  const { base, sobra } = divisaoDasParcelas(totalCents, parcelas);
  return sobra === 0
    ? `${parcelas}x de ${emReais(base)}`
    : `${parcelas}x de ${emReais(base)} (uma de ${emReais(base + sobra)})`;
}
