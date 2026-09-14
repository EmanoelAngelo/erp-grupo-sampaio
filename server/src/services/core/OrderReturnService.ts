/**
 * ============================================================================
 * O RECEBIMENTO DA MERCADORIA DEVOLVIDA (GAP-PRD-122)
 * ============================================================================
 *
 * ## O DEFEITO
 *
 * `markOrderRefunded` dizia "o estoque NÃO retorna sozinho — a devolução física
 * entra por movimento próprio, com quem a recebeu". `refundOrder` fazia o
 * contrário: devolvia o estoque de TODO pedido devolvível, inclusive o
 * `expedido` e o `entregue`. A auditoria mediu: disponível 8 → 10 com o pacote
 * ainda na transportadora — saldo vendável que não existe na prateleira, e o
 * cliente seguinte comprando o que a loja não tem.
 *
 * ## A HISTÓRIA ÚNICA, AGORA
 *
 * Dinheiro e mercadoria são DOIS fatos, e cada um tem a sua hora:
 *
 *   - o REEMBOLSO (dinheiro) marca o pedido `reembolsado`, lança a
 *     contrapartida financeira e deixa a mercadoria "a conferir"
 *     (`return_goods_status = 'aguardando'`);
 *   - o RECEBIMENTO (este módulo) é quem devolve ao estoque — e só o que foi
 *     CONFERIDO: a quantidade que volta vendável por item; o resto (avaria,
 *     extravio) fica registrado como não devolvido, sem virar saldo.
 *
 * Quem devolve pelo ERP diz se a mercadoria já está na mão
 * (`refundOrder({ mercadoriaNaMao })`): para os pedidos que nunca saíram da
 * loja (pago, separação, conferência, embalado, pronto para retirada) é o
 * padrão, e o recebimento acontece na mesma transação. O estorno que chega
 * pelo provedor (webhook) nunca devolve estoque: ninguém conferiu nada.
 */
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { applyMovement } from './InventoryService.js';
import { addOrderEvent } from './StorefrontService.js';

/** Estados da mercadoria de um pedido reembolsado. Nulo = nada a conferir. */
export type SituacaoDaMercadoria = 'aguardando' | 'recebida';

export interface ItemRecebido {
  productId: string;
  description: string;
  quantidadeDoPedido: number;
  voltouAoEstoque: number;
}

export interface RecebimentoDaDevolucao {
  orderId: string;
  itens: ItemRecebido[];
  /** Soma do que voltou vendável. */
  unidadesDeVolta: number;
  /** Soma do que NÃO voltou (avaria, extravio). */
  unidadesQueNaoVoltaram: number;
}

interface LinhaDoPedido {
  id: string;
  number: number;
  status: string;
  return_goods_status: string | null;
}

/**
 * Registra a mercadoria devolvida que foi conferida.
 *
 * `itens` omitido = tudo voltou vendável. Com `itens`, cada produto do pedido
 * informa quanto voltou ao estoque (0 a quantidade comprada); produto que não
 * aparece na lista não voltou.
 */
export function receberMercadoriaDevolvida(input: {
  companyId: string;
  orderId: string;
  userId?: string | null;
  itens?: { productId: string; quantidade: number }[] | null;
  nota?: string | null;
}): RecebimentoDaDevolucao {
  ensureCoreSchema();
  return withTransaction(() => {
    const db = getConnection();
    const pedido = db
      .prepare(
        'SELECT id, number, status, return_goods_status FROM core_orders WHERE id = ? AND company_id = ?',
      )
      .get(input.orderId, input.companyId) as unknown as LinhaDoPedido | undefined;
    if (!pedido) throw new ApiError('CORE_ORDER_NOT_FOUND', 'Pedido não encontrado.', 404);
    if (pedido.return_goods_status === 'recebida') {
      throw new ApiError(
        'CORE_ORDER_RETURN_ALREADY_RECEIVED',
        'A mercadoria deste pedido já foi conferida e lançada no estoque.',
        409,
      );
    }
    if (pedido.return_goods_status !== 'aguardando') {
      throw new ApiError(
        'CORE_ORDER_RETURN_NOT_PENDING',
        pedido.status === 'reembolsado'
          ? 'Este pedido não tem mercadoria a conferir.'
          : 'Só se recebe a mercadoria de um pedido reembolsado. Faça a devolução primeiro.',
        409,
      );
    }

    const linhas = db
      .prepare(
        `SELECT product_id, MIN(description) AS description, SUM(quantity) AS quantity
           FROM core_order_items WHERE order_id = ?
          GROUP BY product_id ORDER BY MIN(rowid)`,
      )
      .all(input.orderId) as { product_id: string; description: string; quantity: number }[];

    const pedidas = new Map<string, number>();
    if (input.itens) {
      if (!Array.isArray(input.itens)) {
        throw new ApiError('CORE_ORDER_RETURN_ITEM', 'Informe os itens como lista.', 400);
      }
      for (const item of input.itens) {
        const linha = linhas.find((l) => l.product_id === item?.productId);
        if (!linha) {
          throw new ApiError(
            'CORE_ORDER_RETURN_ITEM',
            'Um dos itens informados não é deste pedido.',
            400,
            { productId: item?.productId ?? null },
          );
        }
        const q = Number(item.quantidade);
        if (!Number.isFinite(q) || q < 0 || q > Number(linha.quantity)) {
          throw new ApiError(
            'CORE_ORDER_RETURN_ITEM',
            `"${linha.description}": a quantidade que volta vai de 0 a ${linha.quantity}.`,
            400,
            { productId: linha.product_id },
          );
        }
        pedidas.set(linha.product_id, q);
      }
    }

    const itens: ItemRecebido[] = linhas.map((l) => ({
      productId: l.product_id,
      description: l.description,
      quantidadeDoPedido: Number(l.quantity),
      voltouAoEstoque: input.itens ? (pedidas.get(l.product_id) ?? 0) : Number(l.quantity),
    }));

    const nota = typeof input.nota === 'string' && input.nota.trim() ? input.nota.trim() : null;
    for (const item of itens) {
      if (item.voltouAoEstoque <= 0) continue;
      // A chave do razão (referência + produto + tipo) segura a repetição.
      applyMovement({
        companyId: input.companyId,
        productId: item.productId,
        movementType: 'in',
        quantity: item.voltouAoEstoque,
        referenceType: 'ecommerce_order_refund',
        referenceId: input.orderId,
        kind: 'SALE_RETURN',
        documentNumber: `Devolução do pedido #${pedido.number}`,
        userId: input.userId ?? null,
        note: nota,
      });
    }

    const agora = new Date().toISOString();
    db.prepare(
      "UPDATE core_orders SET return_goods_status = 'recebida', return_goods_at = ?, updated_at = ? WHERE id = ?",
    ).run(agora, agora, input.orderId);

    const deVolta = itens.reduce((s, i) => s + i.voltouAoEstoque, 0);
    const naoVoltaram = itens.reduce((s, i) => s + (i.quantidadeDoPedido - i.voltouAoEstoque), 0);
    const faltas = itens
      .filter((i) => i.voltouAoEstoque < i.quantidadeDoPedido)
      .map((i) => `${i.quantidadeDoPedido - i.voltouAoEstoque} × ${i.description}`);
    addOrderEvent(
      input.orderId,
      input.companyId,
      pedido.status,
      `Mercadoria devolvida conferida: ${deVolta} unidade(s) de volta ao estoque.`
        + (faltas.length ? ` Não voltaram ao estoque (avaria ou extravio): ${faltas.join(', ')}.` : '')
        + (nota ? ` Observação: ${nota}` : ''),
      input.userId ?? undefined,
    );

    return {
      orderId: input.orderId,
      itens,
      unidadesDeVolta: deVolta,
      unidadesQueNaoVoltaram: naoVoltaram,
    };
  });
}
