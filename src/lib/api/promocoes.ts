/**
 * Promoções — o cliente da tela de gestão (GAP-PRD-032/033/197/194).
 *
 * A regra é do servidor: ele confere o alvo (produto desta empresa, pelo id,
 * código interno ou de barras; ou uma categoria que existe), o desconto (um
 * desconto de verdade; o grátis só confirmado), o período, o horário e o teto
 * de unidades. A tela desenha, pergunta e mostra a recusa com as palavras dele.
 */
import { apiRequest, envelope } from '@/lib/api/client';

export interface Promocao {
  id: string;
  product_id: string | null;
  /** Nome e código do produto, quando o alvo é um produto desta empresa. */
  product_name?: string | null;
  product_code?: string | null;
  category: string | null;
  price_cents: number | null;
  percent_off: number | null;
  starts_at: string;
  ends_at: string | null;
  /** '3' = toda quarta (GAP-V03). Nulo = todos os dias. */
  weekdays: string | null;
  /** 'HH:MM' da loja; nulo = o dia inteiro (GAP-PRD-194). */
  starts_time?: string | null;
  ends_time?: string | null;
  /** Estoque promocional; nulo = sem teto (GAP-PRD-194). */
  max_units?: number | null;
  units_used?: number;
  units_left?: number | null;
  /** 1 = o grátis foi confirmado por quem criou (GAP-PRD-032). */
  free_confirmed?: number;
  active: number;
  /** O que a regra de hoje recusaria nesta linha (legado). Vazio = ok. */
  problemas?: string[];
}

/** O corpo de criação e de edição — o servidor confere e normaliza. */
export interface PromocaoEntrada {
  productId?: string | null;
  category?: string | null;
  priceCents?: number | null;
  percentOff?: number | null;
  confirmarGratis?: boolean;
  startsAt?: string | null;
  endsAt?: string | null;
  weekdays?: number[];
  startsTime?: string | null;
  endsTime?: string | null;
  maxUnits?: number | null;
}

export interface Sobreposicao {
  id: string;
  alvo: string;
}

/** Um produto achado pela busca do seletor. */
export interface ProdutoAchado {
  id: string;
  name: string;
  internal_code: string | null;
  price_cents: number;
}

export const promocoesApi = {
  listar: () => apiRequest<{ items: Promocao[] }>('/core/promotions').then(envelope('items')),
  criar: (corpo: PromocaoEntrada) =>
    apiRequest<{ id: string; sobreposicoes?: Sobreposicao[] }>('/core/promotions', {
      method: 'POST',
      body: corpo,
    }),
  editar: (id: string, corpo: PromocaoEntrada) =>
    apiRequest<{ id: string; sobreposicoes?: Sobreposicao[] }>(
      `/core/promotions/${encodeURIComponent(id)}`,
      { method: 'PATCH', body: corpo },
    ),
  encerrar: (id: string) =>
    apiRequest<void>(`/core/promotions/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /** A busca de produto do cadastro: nome, código interno ou de barras. */
  buscarProdutos: (termo: string) =>
    apiRequest<{ items: ProdutoAchado[] }>(
      `/core/products?search=${encodeURIComponent(termo)}&limit=8`,
    ).then(envelope('items')),
};
