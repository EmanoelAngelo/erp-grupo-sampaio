/**
 * AS LISTAS EM PÁGINA — GAP-PRD-070 / GAP-PRD-164.
 *
 * Os wrappers antigos (`coreApi.listProducts`, `listCustomers`, `listSales`,
 * `listPurchaseOrders`, `listInboundNotes`…) devolvem só o array, e por isso
 * a tela não tinha como saber que o servidor tinha cortado em 100 ou 200. O
 * servidor agora responde `{ items, total, limit, offset }`; estes wrappers
 * pedem a página e entregam os quatro números à tela, que escreve
 * "mostrando 1–100 de 1.180" e oferece a próxima.
 *
 * Os antigos continuam de pé: telas que só precisam da primeira fatia (o
 * seletor da Oficina, a Conciliação) não mudam de contrato por causa disto.
 *
 * ## Resposta sem `total`
 *
 * Servidor anterior a esta rodada (ou dublê de teste antigo) responde só
 * `{ items }`. Aí o total conhecido é o que chegou, e `totalConhecido` fica
 * falso — a tela diz "mostrando N" sem inventar um "de M". `items` ausente
 * continua sendo falha declarada, pelo mesmo `envelope` do resto da API.
 */
import { apiRequest, envelope } from './client';
import type {
  Customer,
  Equipment,
  InboundNoteSummary,
  Product,
  PurchaseOrder,
  Quote,
  Sale,
  StockMovement,
} from './core';

export interface Pagina<T> {
  items: T[];
  /** Quantos existem no recorte pedido — não só nesta página. */
  total: number;
  limit: number;
  offset: number;
  /** Falso quando a resposta não trouxe `total` (servidor anterior). */
  totalConhecido: boolean;
}

interface CorpoDePagina<T> {
  items: T[];
  total?: number;
  limit?: number;
  offset?: number;
}

/** A página pedida, como a query que o servidor entende. */
export interface PedidoDePagina {
  limit?: number;
  offset?: number;
}

/** Monta a `Pagina` a partir do corpo — tolerante com o servidor antigo. */
export function lerPagina<T>(corpo: CorpoDePagina<T>, pedido: PedidoDePagina = {}): Pagina<T> {
  const items = envelope('items')(corpo as Record<'items', T[]>);
  const offset = typeof corpo.offset === 'number' ? corpo.offset : (pedido.offset ?? 0);
  const limit = typeof corpo.limit === 'number' ? corpo.limit : (pedido.limit ?? items.length);
  const totalConhecido = typeof corpo.total === 'number';
  return {
    items,
    total: totalConhecido ? Number(corpo.total) : offset + items.length,
    limit,
    offset,
    totalConhecido,
  };
}

function query(params: Record<string, string | number | boolean | undefined | null>): string {
  const qs = new URLSearchParams();
  for (const [chave, valor] of Object.entries(params)) {
    if (valor === undefined || valor === null || valor === '' || valor === false) continue;
    qs.set(chave, valor === true ? '1' : String(valor));
  }
  const texto = qs.toString();
  return texto ? `?${texto}` : '';
}

async function pagina<T>(caminho: string, pedido: PedidoDePagina): Promise<Pagina<T>> {
  const corpo = await apiRequest<CorpoDePagina<T>>(caminho);
  return lerPagina(corpo, pedido);
}

/** O cadastro de produtos, com a pendência de envio que a rota sempre mandou junto. */
export async function paginaDeProdutos(
  filtro: {
    search?: string;
    missingShippingData?: boolean;
    /**
     * Ativos, inativos (arquivados) ou todos. Ausente = todos, que é o que a
     * rota devolve às outras telas; a de Produtos pede `ativos` por padrão.
     */
    situacao?: 'ativos' | 'inativos' | 'todos';
  } & PedidoDePagina = {},
): Promise<Pagina<Product> & { missingShippingDataCount: number }> {
  const corpo = await apiRequest<CorpoDePagina<Product> & { missingShippingDataCount?: number }>(
    `/core/products${query({
      search: filtro.search?.trim(),
      missingShippingData: filtro.missingShippingData,
      situacao: filtro.situacao === 'todos' ? undefined : filtro.situacao,
      limit: filtro.limit,
      offset: filtro.offset,
    })}`,
  );
  return {
    ...lerPagina(corpo, filtro),
    missingShippingDataCount: Number(corpo.missingShippingDataCount ?? 0),
  };
}

/** Clientes ativos — com termo, a busca normalizada do balcão (máscara dos dois lados). */
export function paginaDeClientes(
  filtro: { search?: string } & PedidoDePagina = {},
): Promise<Pagina<Customer>> {
  return pagina<Customer>(
    `/core/customers${query({ search: filtro.search?.trim(), limit: filtro.limit, offset: filtro.offset })}`,
    filtro,
  );
}

/** Vendas — `total` já existia na rota; era o wrapper que o jogava fora. */
export function paginaDeVendas(
  filtro: { from?: string; to?: string; customerId?: string } & PedidoDePagina = {},
): Promise<Pagina<Sale>> {
  return pagina<Sale>(`/core/sales${query({ ...filtro })}`, filtro);
}

/** Notas de entrada — com busca (número, chave, fornecedor) e a nota do link (`id`). */
export function paginaDeNotasDeEntrada<T = InboundNoteSummary>(
  filtro: { search?: string; id?: string } & PedidoDePagina = {},
): Promise<Pagina<T>> {
  return pagina<T>(
    `/core/purchases/notes${query({
      search: filtro.search?.trim(),
      id: filtro.id,
      limit: filtro.limit,
      offset: filtro.offset,
    })}`,
    filtro,
  );
}

/** Pedidos de compra, do mais novo para o mais antigo. */
export function paginaDePedidosDeCompra(
  filtro: { status?: string; supplierId?: string } & PedidoDePagina = {},
): Promise<Pagina<PurchaseOrder>> {
  return pagina<PurchaseOrder>(`/core/purchase-orders${query({ ...filtro })}`, filtro);
}

/** O histórico de estoque — a tela já andava de página; agora sabe quantas são. */
export function paginaDeMovimentos(
  filtro: {
    productId?: string;
    kind?: string;
    from?: string;
    to?: string;
    document?: string;
    search?: string;
  } & PedidoDePagina = {},
): Promise<Pagina<StockMovement>> {
  return pagina<StockMovement>(`/core/stock/movements${query({ ...filtro })}`, filtro);
}

/**
 * Equipamentos, com a contagem por origem do MESMO recorte — os cartões
 * "do grupo" e "de cliente" contavam só a página.
 */
export async function paginaDeEquipamentos(
  filtro: { search?: string } & PedidoDePagina = {},
): Promise<
  Pagina<Equipment> & {
    totalPorOrigem: { INTERNAL_PJ_MOTORS: number; EXTERNAL_CUSTOMER: number } | null;
  }
> {
  const corpo = await apiRequest<
    CorpoDePagina<Equipment> & {
      totalPorOrigem?: { INTERNAL_PJ_MOTORS: number; EXTERNAL_CUSTOMER: number };
    }
  >(
    `/core/equipment${query({ search: filtro.search?.trim(), limit: filtro.limit, offset: filtro.offset })}`,
  );
  return { ...lerPagina(corpo, filtro), totalPorOrigem: corpo.totalPorOrigem ?? null };
}

/** Orçamentos e pré-vendas, do mais novo para o mais antigo. */
export function paginaDeOrcamentos(
  filtro: { kind?: string; status?: string } & PedidoDePagina = {},
): Promise<Pagina<Quote>> {
  return pagina<Quote>(`/core/quotes${query({ ...filtro })}`, filtro);
}
