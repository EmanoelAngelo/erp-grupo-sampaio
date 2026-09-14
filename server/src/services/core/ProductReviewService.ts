/**
 * Avaliações de produto — só de quem comprou E recebeu.
 *
 * A REGRA QUE SUSTENTA TUDO
 *
 * Avaliar exige um pedido ENTREGUE contendo o produto, pertencente a um dos
 * cadastros da conta. Não basta ter pago: opinião sobre produto que ainda não
 * chegou é opinião sobre a foto. E não basta conhecer o id do produto — sem a
 * amarra ao pedido, a seção viraria um mural de opiniões fabricadas, e
 * avaliação fabricada destrói exatamente a confiança que ela existe para
 * criar.
 *
 * UMA AVALIAÇÃO POR PESSOA POR PRODUTO. Reavaliar edita a existente. Dez
 * compras não dão dez votos — senão quem compra sempre domina a nota.
 *
 * PRIVACIDADE: o nome público é abreviado ("Ana S."). A vitrine é pública, e
 * o nome completo de quem comprou não é dado público.
 */
import { randomUUID } from 'node:crypto';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';

export interface ProductReview {
  id: string;
  rating: number;
  comment: string | null;
  displayName: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProductReviewSummary {
  average: number | null;
  count: number;
  items: ProductReview[];
}

/** "Ana Beatriz Silva" -> "Ana S." — primeiro nome e inicial do último. */
export function abreviarNome(completo: string): string {
  const partes = String(completo ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (partes.length === 0) return 'Cliente';
  if (partes.length === 1) return partes[0];
  return `${partes[0]} ${partes[partes.length - 1][0].toUpperCase()}.`;
}

/**
 * O pedido que autoriza a avaliação: ENTREGUE, da conta, contendo o produto.
 *
 * Devolve o pedido mais recente que satisfaz as três condições, ou null.
 */
function pedidoQueAutoriza(
  customerIds: string[],
  productId: string,
): { orderId: string; companyId: string; customerName: string } | null {
  if (customerIds.length === 0) return null;
  const marcadores = customerIds.map(() => '?').join(', ');
  const linha = getConnection()
    .prepare(
      `SELECT o.id, o.company_id, o.customer_name
         FROM core_orders o
         JOIN core_order_items i ON i.order_id = o.id
        WHERE o.customer_id IN (${marcadores})
          AND i.product_id = ?
          AND o.status = 'entregue'
        ORDER BY o.created_at DESC
        LIMIT 1`,
    )
    .get(...customerIds, productId) as
    | { id: string; company_id: string; customer_name: string }
    | undefined;
  if (!linha) return null;
  return { orderId: linha.id, companyId: linha.company_id, customerName: linha.customer_name };
}

/**
 * Registra (ou edita) a avaliação da conta para um produto.
 */
export function submitReview(input: {
  accountId: string;
  customerIds: string[];
  productId: string;
  rating: number;
  comment?: string | null;
}): ProductReview {
  ensureCoreSchema();

  const rating = Number(input.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new ApiError('PORTAL_INVALID_RATING', 'A nota vai de 1 a 5.', 400);
  }
  const comment = input.comment?.trim() || null;
  if (comment && comment.length > 1000) {
    throw new ApiError('PORTAL_COMMENT_TOO_LONG', 'O comentário passa de 1000 caracteres.', 400);
  }

  const autorizacao = pedidoQueAutoriza(input.customerIds, input.productId);
  if (!autorizacao) {
    // A mensagem diz a regra inteira: quem pagou e ainda não recebeu entende
    // por que não consegue, em vez de achar que a loja quebrou.
    throw new ApiError(
      'PORTAL_REVIEW_NOT_ALLOWED',
      'Só quem comprou e já recebeu este produto pode avaliá-lo.',
      403,
    );
  }

  return withTransaction(() => {
    const db = getConnection();
    const agora = new Date().toISOString();
    const existente = db
      .prepare('SELECT id FROM core_product_reviews WHERE account_id = ? AND product_id = ?')
      .get(input.accountId, input.productId) as { id: string } | undefined;

    if (existente) {
      // Reavaliar EDITA: uma pessoa, um voto por produto.
      db.prepare(
        'UPDATE core_product_reviews SET rating = ?, comment = ?, updated_at = ? WHERE id = ?',
      ).run(rating, comment, agora, existente.id);
      return buscar(existente.id);
    }

    const id = randomUUID();
    db.prepare(
      `INSERT INTO core_product_reviews
         (id, product_id, company_id, account_id, order_id, rating, comment,
          display_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.productId,
      autorizacao.companyId,
      input.accountId,
      autorizacao.orderId,
      rating,
      comment,
      abreviarNome(autorizacao.customerName),
      agora,
      agora,
    );
    return buscar(id);
  });
}

function buscar(id: string): ProductReview {
  const r = getConnection()
    .prepare('SELECT * FROM core_product_reviews WHERE id = ?')
    .get(id) as Record<string, unknown>;
  return {
    id: String(r.id),
    rating: Number(r.rating),
    comment: (r.comment as string | null) ?? null,
    displayName: String(r.display_name),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

/**
 * O resumo público de um produto: média, total e as mais recentes.
 *
 * A média sai com uma casa decimal — 4.335 vira 4.3. Mais precisão que isso é
 * ruído; menos esconderia a diferença entre 4.0 e 4.4.
 */
export function listProductReviews(productId: string, limit = 20): ProductReviewSummary {
  ensureCoreSchema();
  const db = getConnection();

  const agregado = db
    .prepare(
      'SELECT AVG(rating) media, COUNT(*) total FROM core_product_reviews WHERE product_id = ?',
    )
    .get(productId) as { media: number | null; total: number };

  const items = (
    db
      .prepare(
        `SELECT * FROM core_product_reviews
          WHERE product_id = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(productId, limit) as unknown as Record<string, unknown>[]
  ).map((r) => ({
    id: String(r.id),
    rating: Number(r.rating),
    comment: (r.comment as string | null) ?? null,
    displayName: String(r.display_name),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  }));

  return {
    average: agregado.media === null ? null : Math.round(agregado.media * 10) / 10,
    count: Number(agregado.total),
    items,
  };
}

/** A avaliação da própria conta para um produto, se houver. */
export function myReview(accountId: string, productId: string): ProductReview | null {
  ensureCoreSchema();
  const r = getConnection()
    .prepare('SELECT id FROM core_product_reviews WHERE account_id = ? AND product_id = ?')
    .get(accountId, productId) as { id: string } | undefined;
  return r ? buscar(r.id) : null;
}
