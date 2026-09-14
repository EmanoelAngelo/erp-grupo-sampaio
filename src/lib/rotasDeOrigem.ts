/**
 * ============================================================================
 * ONDE MORA CADA DOCUMENTO — e como se chega NELE, não à tela dele
 * ============================================================================
 *
 * ## O DEFEITO
 *
 * O título do contas a pagar virou link na rodada V22, e o link levava à TELA:
 * `/sistema/compras/entrada-notas`. Quem clicava em "Nota 4711 — Distribuidora
 * Alfa" chegava na lista inteira e ainda tinha de achar a 4711 no meio de
 * duzentas linhas. É meia navegação — a pessoa chega na sala certa e a gaveta
 * continua fechada —, e o gesto que ela precisa fazer depois é exatamente o
 * que o link prometeu evitar.
 *
 * Aqui o destino passa a carregar o ID do documento, e a tela de destino o
 * abre sozinha.
 *
 * ## O NOME DO PARÂMETRO É O NOME DO DOCUMENTO
 *
 * `?venda=`, `?nota=`, `?pedido=`, `?devolucao=` — o substantivo em português
 * que a loja usa, no singular, valendo o id. Um `?id=` genérico obrigaria cada
 * tela a documentar de que id se trata, e duas telas acabariam entendendo
 * coisas diferentes pelo mesmo nome.
 *
 * O parâmetro FICA na URL depois de aberto (ao contrário do `?documento=` do
 * PDV, que é consumido): abrir um documento não destrói nada, e um F5 — ou o
 * link colado num grupo de WhatsApp — tem de continuar mostrando o mesmo
 * papel. As telas também ESCREVEM o parâmetro quando alguém abre um documento
 * pela lista, o que faz o endereço da tela descrever o que está na tela.
 *
 * ## ORIGEM SEM DESTINO NÃO VIRA LINK
 *
 * `destinoDaOrigem` devolve `null` para o que não tem superfície — o
 * lançamento avulso (`manual`), que aponta para si mesmo. Porta desenhada que
 * não abre é pior que porta nenhuma, e é a regra que a ContasPage já seguia.
 *
 * ## DOIS "PEDIDOS", DOIS NOMES — por que o da loja é `?encomenda=`
 *
 * `ecommerce_order` era a única origem que parava na TELA: levava a
 * `/sistema/pedidos` sem parâmetro, porque `PedidosPage` (em `GestaoPages.tsx`)
 * ainda não lia nenhum, e inventar um parâmetro que ninguém consome seria a
 * promessa vazia que este arquivo existe para não fazer. A tela passou a ler, e
 * a porta abre.
 *
 * O nome NÃO pode ser `?pedido=`: esse já é do pedido de COMPRA, em
 * `/sistema/compras/pedidos`. São dois papéis diferentes — um é o que a loja
 * ENCOMENDA do fornecedor, o outro é o que o CLIENTE encomenda da loja — e dois
 * documentos disputando a mesma palavra é como duas telas passam a entender
 * coisas diferentes pelo mesmo nome (o mesmo motivo pelo qual não existe um
 * `?id=` genérico aqui).
 *
 * `encomenda` é o substantivo que a casa já usa para o pedido da loja:
 * `StorefrontService` divide carrinho de duas operações em "duas encomendas, de
 * dois endereços, com dois pesos", e é isso que uma linha de `core_orders` é.
 */

/** O parâmetro pelo qual cada tela reconhece o seu documento. */
export const PARAM_DA_VENDA = 'venda';
export const PARAM_DA_NOTA = 'nota';
export const PARAM_DO_PEDIDO_DE_COMPRA = 'pedido';
export const PARAM_DA_DEVOLUCAO = 'devolucao';
export const PARAM_DA_ENCOMENDA = 'encomenda';
/*
  A DEVOLUÇÃO AO FORNECEDOR (GAP-PRD-089) não usa `?devolucao=`: esse já é da
  devolução do CLIENTE (`/sistema/vendas/devolucoes`). São dois papéis — um é
  a mercadoria que o cliente trouxe de volta, o outro a que a loja manda de
  volta ao fornecedor — e dois documentos disputando a mesma palavra é como
  duas telas passam a entender coisas diferentes pelo mesmo nome.
*/
export const PARAM_DA_DEVOLUCAO_DE_COMPRA = 'devolucao-compra';

/** A ficha de uma devolução ao fornecedor. */
export function rotaDaDevolucaoAoFornecedor(returnId: string): string {
  return `/sistema/compras/devolucoes?${PARAM_DA_DEVOLUCAO_DE_COMPRA}=${encodeURIComponent(returnId)}`;
}

/** A devolução NOVA contra uma nota de entrada — o botão "Devolver". */
export function rotaDaNovaDevolucaoAoFornecedor(noteId: string): string {
  return `/sistema/compras/devolucoes?${PARAM_DA_NOTA}=${encodeURIComponent(noteId)}`;
}

/** A ficha de uma nota de entrada (NF-e ou entrada manual). */
export function rotaDaNotaDeEntrada(noteId: string): string {
  return `/sistema/compras/entrada-notas?${PARAM_DA_NOTA}=${encodeURIComponent(noteId)}`;
}

/** A ficha de um pedido de compra. */
export function rotaDoPedidoDeCompra(orderId: string): string {
  return `/sistema/compras/pedidos?${PARAM_DO_PEDIDO_DE_COMPRA}=${encodeURIComponent(orderId)}`;
}

/** A ficha de um pedido da LOJA — o que o cliente encomendou pelo e-commerce. */
export function rotaDoPedidoDaLoja(orderId: string): string {
  return `/sistema/pedidos?${PARAM_DA_ENCOMENDA}=${encodeURIComponent(orderId)}`;
}

/**
 * O FECHAMENTO DE COMISSÃO (GAP-PRD-174) — `?fechamento=`, o substantivo da
 * tela de Comissões. A conta a pagar da comissão nascia como lançamento
 * avulso e não levava a lugar nenhum; agora ela abre o fechamento que a
 * gerou, na aba "Fechamentos".
 */
export const PARAM_DO_FECHAMENTO = 'fechamento';

export function rotaDoFechamentoDeComissao(closingId: string): string {
  return `/sistema/financeiro/comissoes?${PARAM_DO_FECHAMENTO}=${encodeURIComponent(closingId)}`;
}

/**
 * Para onde navega o título de cada origem — com o documento junto.
 *
 * O conjunto é o mesmo que o servidor sabe rotular
 * (`FinanceService.ORIGEM_LEGIVEL_SQL`): sale, sale_return, nfe_entrada,
 * entrada_manual e ecommerce_order. As duas espécies de nota de entrada
 * dividem a mesma tela porque dividem a mesma tabela — o que as separa é a
 * ORIGEM do título, e é ela que a ficha usa para achar os lançamentos de volta.
 */
export function destinoDaOrigem(originType: string, originId: string): string | null {
  switch (originType) {
    case 'sale':
      return `/sistema/vendas?${PARAM_DA_VENDA}=${encodeURIComponent(originId)}`;
    case 'sale_return':
      return `/sistema/vendas/devolucoes?${PARAM_DA_DEVOLUCAO}=${encodeURIComponent(originId)}`;
    case 'nfe_entrada':
    case 'entrada_manual':
      return rotaDaNotaDeEntrada(originId);
    // O reembolso do pedido (GAP-PRD-031) mora na mesma ficha do pedido.
    case 'ecommerce_order':
    case 'ecommerce_order_refund':
      return rotaDoPedidoDaLoja(originId);
    // O crédito a receber do fornecedor abre a ficha da devolução que o criou.
    case 'devolucao_fornecedor':
      return rotaDaDevolucaoAoFornecedor(originId);
    case 'commission_closing':
      return rotaDoFechamentoDeComissao(originId);
    default:
      // 'manual' e qualquer origem futura: sem superfície conhecida, sem link.
      return null;
  }
}

/**
 * A origem que uma nota de entrada grava no financeiro.
 *
 * A NF-e e a compra digitada moram na MESMA tabela (`core_inbound_notes`,
 * separadas por `doc_type`) e nascem com origens DIFERENTES, de propósito: é o
 * que impede a compra sem nota fiscal de se apresentar como NF-e em relatório,
 * conciliação e estorno (GAP-V17). A ficha que quiser os títulos da nota tem de
 * perguntar com a origem certa — perguntar sempre `nfe_entrada` devolveria
 * lista vazia para metade das notas, e "nenhum título" é indistinguível de
 * "não gerou dívida".
 */
export function origemDaNota(docType: string | null | undefined): string {
  return String(docType ?? 'nfe') === 'manual' ? 'entrada_manual' : 'nfe_entrada';
}
