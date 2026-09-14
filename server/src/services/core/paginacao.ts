/**
 * A PÁGINA DAS LISTAS DE ESCRITÓRIO — GAP-PRD-070 / GAP-PRD-164.
 *
 * Produtos, clientes, notas de entrada, pedidos de compra, equipamentos,
 * orçamentos, pedidos online e o histórico de estoque cortavam em 100, 200 ou
 * 300 linhas e devolviam só `{ items }`. A tela desenhava o corte como se fosse
 * a lista inteira: o 101º cliente não existia para quem não digitasse um termo,
 * a 201ª nota sumia da Entrada de Notas, e o gestor concluía que "só tem 100
 * produtos". Do outro lado, `?limit=1000000` devolvia o catálogo inteiro numa
 * resposta só.
 *
 * A regra passa a ser uma, a mesma de `/sales` e da Auditoria:
 *
 *   - a resposta diz `{ items, total, limit, offset }` — `total` respeita os
 *     filtros, para a tela saber quantas páginas existem e escrever
 *     "mostrando 1–100 de 1.180";
 *   - o `limit` tem teto (500). Página maior que isso é o navegador varrendo o
 *     banco — quem precisa de TUDO usa o relatório da Central, que exporta;
 *   - o padrão de cada lista continua o de antes. Quem não pede página recebe
 *     exatamente as linhas que recebia, e agora sabe que existem outras.
 */

/** O maior pedaço que uma lista de tela devolve de uma vez. */
export const TETO_DA_PAGINA = 500;

export interface PaginaPedida {
  limit: number;
  offset: number;
}

/**
 * Lê `limit`/`offset` da query — tolerante com o que chega torto.
 *
 * Texto, zero, negativo ou ausente no `limit` vira o padrão da lista (e não
 * erro: a tela antiga não manda nada, e um 400 aqui quebraria quem sempre
 * funcionou). Acima do teto, o teto. Offset torto vira zero.
 */
export function lerPagina(
  query: { limit?: unknown; offset?: unknown },
  padrao: number,
  teto: number = TETO_DA_PAGINA,
): PaginaPedida {
  return {
    limit: limitarPagina(query.limit, padrao, teto),
    offset: limitarDeslocamento(query.offset),
  };
}

/** O `limit` saneado: inteiro entre 1 e o teto, padrão quando não é número. */
export function limitarPagina(
  valor: unknown,
  padrao: number,
  teto: number = TETO_DA_PAGINA,
): number {
  const numero = Math.floor(Number(valor));
  if (valor === undefined || valor === null || valor === '' || !Number.isFinite(numero) || numero < 1) {
    return Math.min(padrao, teto);
  }
  return Math.min(numero, teto);
}

/** O `offset` saneado: inteiro não negativo. */
export function limitarDeslocamento(valor: unknown): number {
  const numero = Math.floor(Number(valor));
  return Number.isFinite(numero) && numero > 0 ? numero : 0;
}
