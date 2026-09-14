/**
 * O carrinho da CONTA e a renovação da sessão (GAP-PRD-193).
 *
 * O carrinho de quem entrou mora no servidor, por conta: só produto e
 * quantidade — preço e disponível vêm da vitrine a cada leitura. O login
 * FUNDE o carrinho do aparelho com o da conta (mesmo produto = a maior
 * quantidade). Toda chamada leva o `x-portal-token`.
 */
import { comTokenPortal } from '@/lib/portalSession';

export interface ProdutoDoCarrinho {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  brand: string | null;
  imageUrl: string | null;
  basePriceCents: number;
  priceCents: number;
  onSale: boolean;
  available: number;
  storeSlug: string;
  storeName: string;
}

export interface CarrinhoDoServidor {
  items: { productId: string; quantity: number; product: ProdutoDoCarrinho }[];
  /** O que não pôde ficar (saiu da vitrine, precisa escolher o tamanho). */
  descartados: { productId: string; motivo: 'indisponivel' | 'escolha_o_tamanho' }[];
  updatedAt: string | null;
}

export type ItemParaOServidor = { productId: string; quantity: number };

export const carrinhoApi = {
  ler: (token: string) => comTokenPortal<CarrinhoDoServidor>('/loja/portal/carrinho', token),
  trocar: (token: string, items: ItemParaOServidor[]) =>
    comTokenPortal<CarrinhoDoServidor>('/loja/portal/carrinho', token, {
      method: 'PUT',
      body: { items },
    }),
  mesclar: (token: string, items: ItemParaOServidor[]) =>
    comTokenPortal<CarrinhoDoServidor>('/loja/portal/carrinho/mesclar', token, {
      method: 'POST',
      body: { items },
    }),
  acrescentar: (token: string, item: ItemParaOServidor) =>
    comTokenPortal<CarrinhoDoServidor>('/loja/portal/carrinho/itens', token, {
      method: 'POST',
      body: item,
    }),
  /** Lê a própria sessão — e, como toda leitura do portal, a desliza. */
  renovarSessao: (token: string) =>
    comTokenPortal<{ expiresAt: string; absoluteExpiresAt: string }>('/loja/portal/sessao', token),
};
