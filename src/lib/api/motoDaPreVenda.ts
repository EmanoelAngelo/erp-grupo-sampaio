/**
 * A MOTO DA PRÉ-VENDA NA TELA (GAP-PRD-025, GAP-PRD-111).
 *
 *   segurar      a pré-venda segura AQUELA moto — o chassi que o cliente do
 *                sinal viu no pátio: `PUT /core/quotes/:id/unidades`. Lista
 *                vazia solta;
 *   no balcão    o PDV carrega a pré-venda já com a moto que ela segura (e,
 *                faltando, a mais antiga LIVRE), mostra o chassi na linha e
 *                manda esse chassi na conversão — o servidor recusava a
 *                conversão de moto por não saber qual sai.
 *
 * As funções puras moram aqui para que a regra de escolha seja uma só entre o
 * PDV e quem mais precisar dela.
 */
import { apiRequest } from './client';
import type { ProductUnit, ReservaDaUnidade } from './core';

export const motoDaPreVendaApi = {
  segurar: (quoteId: string, productId: string, unitIds: string[]) =>
    apiRequest<{ unidadesReservadas: ReservaDaUnidade[] }>(`/core/quotes/${quoteId}/unidades`, {
      method: 'PUT',
      body: { productId, unitIds },
    }).then((r) => (Array.isArray(r?.unidadesReservadas) ? r.unidadesReservadas : [])),
};

/**
 * As motos que ESTE documento leva ao balcão: as que ele segura primeiro, e o
 * que faltar entre as livres mais antigas. Nunca a segurada por outro cliente.
 * `jaEscolhidas` evita que duas linhas do mesmo produto peguem a mesma moto.
 */
export function escolherUnidadesDoDocumento(
  disponiveis: ProductUnit[],
  quoteId: string,
  quantidade: number,
  jaEscolhidas: ReadonlySet<string> = new Set(),
): ProductUnit[] {
  const candidatas = disponiveis.filter((u) => u.status === 'in_stock' && !jaEscolhidas.has(u.id));
  const doDocumento = candidatas.filter((u) => u.reserva?.quoteId === quoteId);
  const livres = candidatas.filter((u) => !u.reserva);
  return [...doDocumento, ...livres].slice(0, quantidade);
}

/** Para a venda comum: a moto segurada por uma pré-venda fica de fora. */
export function unidadesLivres(disponiveis: ProductUnit[]): ProductUnit[] {
  return disponiveis.filter((u) => !u.reserva);
}

interface LinhaComUnidades {
  product: { id: string; serialized?: number | null };
  quantity: number;
  unitIds?: string[];
}

/**
 * O corpo `unidades` da conversão: só produto controlado por unidade cuja(s)
 * linha(s) tenham EXATAMENTE as motos da quantidade. Linha incompleta fica de
 * fora — o servidor escolhe por ela (a segurada, ou a mais antiga livre) em vez
 * de recusar por contagem.
 */
export function unidadesDaConversao(
  linhas: LinhaComUnidades[],
): { productId: string; unitIds: string[] }[] | undefined {
  const porProduto = new Map<string, string[]>();
  const incompletos = new Set<string>();
  for (const l of linhas) {
    if (l.product.serialized !== 1) continue;
    const ids = l.unitIds ?? [];
    if (ids.length !== l.quantity) {
      incompletos.add(l.product.id);
      continue;
    }
    porProduto.set(l.product.id, [...(porProduto.get(l.product.id) ?? []), ...ids]);
  }
  for (const p of incompletos) porProduto.delete(p);
  const saida = [...porProduto].map(([productId, unitIds]) => ({ productId, unitIds }));
  return saida.length > 0 ? saida : undefined;
}
