/**
 * Pedido de compra.
 *
 * A REGRA QUE MANDA AQUI: o pedido NÃO movimenta estoque.
 *
 * Quem dá entrada é a conferência da nota — IMPORTAR → CONFERIR → CONFIRMAR.
 * O fornecedor manda o que ele manda, não o que foi pedido: falta item, vem
 * quantidade diferente, vem produto trocado. Somar o pedido ao estoque faria o
 * sistema afirmar que a mercadoria chegou porque alguém digitou que ia chegar,
 * e a diferença só apareceria no inventário, meses depois, como sumiço.
 *
 * Então o pedido é COMPROMISSO e a nota é FATO. O pedido serve para três
 * coisas, todas antes da mercadoria existir:
 *
 *   1. combinar com o fornecedor o que foi pedido, por quanto;
 *   2. saber o que está para chegar, e desde quando está atrasado;
 *   3. comparar o que chegou com o que foi pedido, quando a nota entrar.
 *
 * A comparação é o ponto: sem pedido, nota divergente passa despercebida — o
 * conferente não tem contra o que conferir além da própria nota.
 */
import { randomUUID } from 'node:crypto';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema, nextSequenceValue } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { loadSupplier } from './SupplierService.js';
import { NOTA_ESTORNADA, NOTA_RECEBIDA } from './InboundNoteStatus.js';
import { limitarDeslocamento, limitarPagina } from './paginacao.js';

export type PurchaseOrderStatus =
  | 'rascunho'
  | 'enviado'
  | 'recebido_parcial'
  | 'recebido'
  | 'cancelado';

export interface PurchaseOrderItemInput {
  productId?: string | null;
  description?: string;
  quantity: number;
  unitCostCents: number;
}

/** Enquanto é rascunho, muda à vontade. Depois de enviado, o combinado é o combinado. */
const EDITAVEL = new Set<PurchaseOrderStatus>(['rascunho']);

function loadOrder(companyId: string, orderId: string): Record<string, unknown> {
  const row = getConnection()
    .prepare('SELECT * FROM core_purchase_orders WHERE id = ? AND company_id = ?')
    .get(orderId, companyId) as Record<string, unknown> | undefined;
  if (!row) throw new ApiError('CORE_PURCHASE_ORDER_NOT_FOUND', 'Pedido não encontrado.', 404);
  return row;
}

function quantidade(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new ApiError('CORE_PURCHASE_ORDER_INVALID', 'Quantidade deve ser maior que zero.', 400);
  }
  return n;
}

function centavos(value: unknown): number {
  const n = Math.round(Number(value ?? 0));
  if (!Number.isFinite(n) || n < 0) {
    throw new ApiError('CORE_PURCHASE_ORDER_INVALID', 'Custo não pode ser negativo.', 400);
  }
  return n;
}

/**
 * Grava os itens e devolve o total.
 *
 * O item aceita produto do cadastro OU descrição livre: compra de material que
 * não é revenda (embalagem, etiqueta, café) não deveria obrigar a criar produto
 * no catálogo só para caber no pedido.
 */
function replaceItems(
  companyId: string,
  orderId: string,
  items: PurchaseOrderItemInput[],
): number {
  const db = getConnection();
  db.prepare('DELETE FROM core_purchase_order_items WHERE order_id = ?').run(orderId);

  if (items.length === 0) {
    throw new ApiError('CORE_PURCHASE_ORDER_EMPTY', 'O pedido precisa de ao menos um item.', 400);
  }

  const now = new Date().toISOString();
  let total = 0;

  for (const item of items) {
    const qtd = quantidade(item.quantity);
    const custo = centavos(item.unitCostCents);
    let descricao = String(item.description ?? '').trim();
    const productId = item.productId ? String(item.productId) : null;

    if (productId) {
      const produto = db
        .prepare('SELECT id, name FROM core_products WHERE id = ? AND company_id = ?')
        .get(productId, companyId) as { id: string; name: string } | undefined;
      if (!produto) {
        throw new ApiError('CORE_PRODUCT_NOT_FOUND', 'Produto não encontrado.', 404);
      }
      if (!descricao) descricao = produto.name;
    }

    if (!descricao) {
      throw new ApiError('CORE_PURCHASE_ORDER_INVALID', 'Informe o produto ou a descrição.', 400);
    }

    const totalItem = Math.round(qtd * custo);
    total += totalItem;

    db.prepare(
      `INSERT INTO core_purchase_order_items
         (id, order_id, company_id, product_id, description, quantity, unit_cost_cents,
          total_cents, received_quantity, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    ).run(randomUUID(), orderId, companyId, productId, descricao, qtd, custo, totalItem, now);
  }

  return total;
}

export function createPurchaseOrder(input: {
  companyId: string;
  userId?: string;
  supplierId: string;
  items: PurchaseOrderItemInput[];
  expectedAt?: string | null;
  notes?: string | null;
}): Record<string, unknown> {
  ensureCoreSchema();
  return withTransaction(() => {
    const fornecedor = loadSupplier(input.companyId, input.supplierId);
    if (!fornecedor.active) {
      throw new ApiError('CORE_SUPPLIER_INACTIVE', 'Fornecedor desativado não recebe pedido.', 400);
    }

    const db = getConnection();
    const id = randomUUID();
    const now = new Date().toISOString();
    const numero = nextSequenceValue(input.companyId, 'purchase_order');

    // Sem data informada, a previsão sai do prazo do fornecedor. É a razão de o
    // prazo existir no cadastro: previsão digitada à mão envelhece e ninguém
    // volta para corrigir.
    const previsao =
      input.expectedAt ??
      (Number(fornecedor.delivery_days) > 0
        ? new Date(Date.now() + Number(fornecedor.delivery_days) * 86400000).toISOString()
        : null);

    db.prepare(
      `INSERT INTO core_purchase_orders
         (id, company_id, number, supplier_id, status, expected_at, notes, total_cents,
          created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'rascunho', ?, ?, 0, ?, ?, ?)`,
    ).run(
      id,
      input.companyId,
      numero,
      input.supplierId,
      previsao,
      input.notes ? String(input.notes).trim() : null,
      input.userId ?? null,
      now,
      now,
    );

    const total = replaceItems(input.companyId, id, input.items);
    db.prepare('UPDATE core_purchase_orders SET total_cents = ? WHERE id = ?').run(total, id);

    return loadOrder(input.companyId, id);
  });
}

export function updatePurchaseOrderItems(
  companyId: string,
  orderId: string,
  items: PurchaseOrderItemInput[],
): Record<string, unknown> {
  ensureCoreSchema();
  return withTransaction(() => {
    const order = loadOrder(companyId, orderId);
    // Depois de enviado, mudar o pedido reescreveria o que já foi combinado com
    // o fornecedor — e a nota chegaria divergente de um pedido que mudou aqui
    // dentro, sem ele saber.
    if (!EDITAVEL.has(order.status as PurchaseOrderStatus)) {
      throw new ApiError(
        'CORE_PURCHASE_ORDER_LOCKED',
        'Pedido já enviado não pode ser alterado. Cancele e faça outro.',
        409,
      );
    }
    const total = replaceItems(companyId, orderId, items);
    getConnection()
      .prepare('UPDATE core_purchase_orders SET total_cents = ?, updated_at = ? WHERE id = ?')
      .run(total, new Date().toISOString(), orderId);
    return loadOrder(companyId, orderId);
  });
}

/** Rascunho vira pedido de verdade: é daqui que se espera mercadoria. */
export function sendPurchaseOrder(companyId: string, orderId: string): Record<string, unknown> {
  ensureCoreSchema();
  const order = loadOrder(companyId, orderId);
  if (order.status !== 'rascunho') {
    throw new ApiError('CORE_PURCHASE_ORDER_LOCKED', 'Só rascunho pode ser enviado.', 409);
  }
  getConnection()
    .prepare("UPDATE core_purchase_orders SET status = 'enviado', updated_at = ? WHERE id = ?")
    .run(new Date().toISOString(), orderId);
  return loadOrder(companyId, orderId);
}

export function cancelPurchaseOrder(
  companyId: string,
  orderId: string,
  reason: string,
): Record<string, unknown> {
  ensureCoreSchema();
  const order = loadOrder(companyId, orderId);
  if (order.status === 'recebido') {
    // O que chegou, chegou. Cancelar depois não desfaz a nota nem a dívida —
    // só faria o pedido mentir sobre uma entrega que aconteceu.
    throw new ApiError(
      'CORE_PURCHASE_ORDER_RECEIVED',
      // O "outro caminho" existe desde o GAP-PRD-089 — a frase agora o nomeia.
      'Pedido já recebido não é cancelado. Para mandar mercadoria de volta, registre a '
        + 'devolução ao fornecedor contra a nota (Compras › Devoluções ao fornecedor).',
      409,
    );
  }
  const motivo = String(reason ?? '').trim();
  if (motivo.length < 3) {
    throw new ApiError('CORE_PURCHASE_ORDER_INVALID', 'Informe o motivo do cancelamento.', 400);
  }
  getConnection()
    .prepare(
      `UPDATE core_purchase_orders SET status = 'cancelado', cancel_reason = ?, updated_at = ?
        WHERE id = ?`,
    )
    .run(motivo, new Date().toISOString(), orderId);
  return loadOrder(companyId, orderId);
}

/**
 * Recalcula o que já chegou, a partir das notas CONFIRMADAS deste pedido.
 *
 * A conta sai da nota, nunca de digitação: é a nota que diz o que entrou no
 * estoque, e o pedido só reflete. Casamento por produto — item de nota sem
 * produto casado não conta, porque não se sabe o que ele é.
 */
export function recalcReceived(companyId: string, orderId: string): Record<string, unknown> {
  ensureCoreSchema();
  return withTransaction(() => {
    const order = loadOrder(companyId, orderId);
    const db = getConnection();

    const itens = db
      .prepare('SELECT id, product_id, quantity FROM core_purchase_order_items WHERE order_id = ?')
      .all(orderId) as unknown as { id: string; product_id: string | null; quantity: number }[];

    let algumRecebido = false;
    let todosCompletos = itens.length > 0;

    for (const item of itens) {
      let recebido = 0;
      if (item.product_id) {
        /*
          O RECEBIDO É O QUE A DOCA CONTOU, não o que o arquivo fatura.

          Esta soma usava `i.quantity` (o FATURADO) e a divergência que a
          conferência existe para revelar sumia no pedido: a doca contava 8 de
          10, o estoque entrava com 8 — e o pedido afirmava "10 de 10,
          recebido". O comprador nunca ficava sabendo que faltam 2 na
          prateleira olhando para o pedido.

          O COALESCE é a MESMA régua de confirmNfe: `received_quantity` NULO é
          "ninguém conferiu" (nota antiga, ou confirmada direto), e aí vale o
          faturado; ZERO é "conferi e não veio nada", e zero conta como zero.
        */
        const row = db
          .prepare(
            `SELECT COALESCE(SUM(
                      COALESCE(i.received_quantity, i.quantity)
                      * COALESCE(i.conversion_factor, 1)
                    ), 0) AS q
               FROM core_inbound_note_items i
               JOIN core_inbound_notes n ON n.id = i.note_id
              -- A nota confirmada é gravada como 'recebida' por
              -- NfeImportService. Esta consulta procurava 'received', em
              -- inglês, e nunca casava: a mercadoria chegava, o estoque subia,
              -- e o pedido continuava "enviado" para sempre com
              -- received_quantity zerado. O status vive em português no banco;
              -- ver NOTA_RECEBIDA.
              --
              -- O fator de conversão multiplica pelo MESMO motivo que em
              -- confirmNfe: o item do pedido está na unidade do CADASTRO e o
              -- da nota, na unidade da NOTA. Fornecedor que fatura 2 CX de 12
              -- entregou 24 UN — sem o fator, o pedido de 24 compararia 24
              -- com 2 e afirmaria "faltam 22" com a prateleira cheia.
              WHERE n.company_id = ? AND n.purchase_order_id = ? AND n.status = ?
                AND i.product_id = ?`,
          )
          .get(companyId, orderId, NOTA_RECEBIDA, item.product_id) as { q: number };
        recebido = row.q;
      }
      db.prepare('UPDATE core_purchase_order_items SET received_quantity = ? WHERE id = ?').run(
        recebido,
        item.id,
      );
      if (recebido > 0) algumRecebido = true;
      if (recebido < item.quantity) todosCompletos = false;
    }

    // Cancelado não volta a andar por causa de nota; e rascunho ainda nem foi
    // enviado, então nota contra ele é dado, não mudança de estado.
    //
    // 'recebido' ENTROU na lista quando o estorno nasceu (GAP-V20): antes
    // dele, recebido era estado final e não havia caminho legítimo de volta.
    // Agora há — a nota estornada sai da soma (o WHERE acima só conta
    // 'recebida'), e um pedido cujo recebimento foi desfeito precisa voltar a
    // dizer 'enviado'/'recebido_parcial' em vez de afirmar entrega que o
    // razão nega. Pedido que continua sustentado por notas vivas recalcula
    // para 'recebido' de novo — a conta é refeita do zero, nunca somada.
    if (
      order.status === 'enviado'
      || order.status === 'recebido_parcial'
      || order.status === 'recebido'
    ) {
      const novo = todosCompletos ? 'recebido' : algumRecebido ? 'recebido_parcial' : 'enviado';
      db.prepare('UPDATE core_purchase_orders SET status = ?, updated_at = ? WHERE id = ?').run(
        novo,
        new Date().toISOString(),
        orderId,
      );
    }

    return loadOrder(companyId, orderId);
  });
}

/** Amarra uma nota ao pedido que ela atende, e reflete o que chegou. */
export function linkNoteToOrder(
  companyId: string,
  noteId: string,
  orderId: string,
): Record<string, unknown> {
  ensureCoreSchema();
  return withTransaction(() => {
    const order = loadOrder(companyId, orderId);

    // Pedido cancelado é compromisso DESFEITO: amarrar nota nele gravaria
    // recebimento num pedido morto — um retrato que ninguém decidiu, e que o
    // status nunca mais reflete (o recalc pula 'cancelado' de propósito). A
    // mercadoria que chegou assim mesmo entra pela nota, sem pedido, e a
    // conversa com o fornecedor é de gente.
    if (order.status === 'cancelado') {
      throw new ApiError(
        'CORE_PURCHASE_ORDER_CANCELLED',
        'Pedido cancelado não recebe nota. A mercadoria entra pela nota, sem amarração.',
        409,
      );
    }

    const db = getConnection();
    const nota = db
      .prepare(
        `SELECT id, supplier_id, purchase_order_id, status
           FROM core_inbound_notes WHERE id = ? AND company_id = ?`,
      )
      .get(noteId, companyId) as
      | { id: string; supplier_id: string | null; purchase_order_id: string | null; status: string }
      | undefined;
    if (!nota) throw new ApiError('CORE_INBOUND_NOTE_NOT_FOUND', 'Nota não encontrada.', 404);

    // Nota ESTORNADA é documento morto (GAP-V20): amarrá-la não mudaria o
    // recebido (o recálculo só conta 'recebida'), mas deixaria o vínculo
    // gravado — um pedido apontando para um retrato que já foi desfeito, sem
    // ninguém decidir isso. Recusa nomeada, como o pedido cancelado acima.
    if (nota.status === NOTA_ESTORNADA) {
      throw new ApiError(
        'CORE_INBOUND_NOTE_REVERSED',
        'Nota estornada não se amarra a pedido. Se a mercadoria chegou, lance a entrada de novo.',
        409,
      );
    }

    // Nota de um fornecedor contra pedido de outro esconderia a divergência
    // mais grosseira que existe: mercadoria que veio de quem não foi pedido.
    if (nota.supplier_id && nota.supplier_id !== order.supplier_id) {
      throw new ApiError(
        'CORE_PURCHASE_ORDER_SUPPLIER_MISMATCH',
        'A nota é de outro fornecedor.',
        409,
      );
    }

    db.prepare('UPDATE core_inbound_notes SET purchase_order_id = ? WHERE id = ?').run(
      orderId,
      noteId,
    );

    // Re-amarrar reprojeta os DOIS lados. Só o destino era recalculado, e o
    // pedido que PERDEU a nota ficava com o retrato velho: status
    // 'recebido_parcial' e received_quantity gravado, com a lista de notas
    // vazia — um recebimento afirmado sem nenhuma nota que o sustente.
    if (nota.purchase_order_id && nota.purchase_order_id !== orderId) {
      recalcReceived(companyId, nota.purchase_order_id);
    }
    return recalcReceived(companyId, orderId);
  });
}

export function getPurchaseOrder(
  companyId: string,
  orderId: string,
): Record<string, unknown> {
  ensureCoreSchema();
  const order = loadOrder(companyId, orderId);
  const db = getConnection();
  const items = db
    .prepare(
      `SELECT i.*, p.internal_code
         FROM core_purchase_order_items i
         LEFT JOIN core_products p ON p.id = i.product_id
        WHERE i.order_id = ? ORDER BY i.created_at`,
    )
    .all(orderId) as unknown as Record<string, unknown>[];
  const fornecedor = db
    .prepare('SELECT name, trade_name, document FROM core_suppliers WHERE id = ?')
    .get(order.supplier_id as string) as Record<string, unknown> | undefined;
  // `inboundNotes` e não `notes`: o pedido já tem um campo `notes`, que é a
  // observação escrita por quem comprou. Espalhar o array por cima apagaria a
  // observação sem nenhum aviso.
  //
  // `doc_type` VIAJA JUNTO, e é conserto de costura: a lista não dizia a
  // ESPÉCIE do documento, e a espécie é o que decide a origem do lançamento
  // financeiro que ele gerou — NF-e importada nasce 'nfe_entrada', compra
  // digitada sem nota fiscal nasce 'entrada_manual' (GAP-V17). Sem ela, a ficha
  // do pedido perguntava ao financeiro DUAS vezes por nota, uma por espécie, e
  // ficava com a união: funcionava, e guardava na TELA uma segunda definição de
  // "o que é entrada manual". No dia em que a régua daqui mudar — uma terceira
  // espécie, um recibo de produtor rural —, a tela continuaria adivinhando pela
  // regra velha, e a soma continuaria fechando por acidente. Com a espécie na
  // resposta, a régua vive num lugar só: aqui.
  const inboundNotes = db
    .prepare(
      `SELECT id, access_key, number, series, total_cents, status, received_at, doc_type
         FROM core_inbound_notes WHERE company_id = ? AND purchase_order_id = ?
        ORDER BY created_at`,
    )
    .all(companyId, orderId) as unknown as Record<string, unknown>[];

  return { ...order, supplier: fornecedor ?? null, items, inboundNotes };
}

/**
 * Os pedidos, do mais novo para o mais antigo — em página (GAP-PRD-164).
 *
 * Parava em 200 sem offset nem contagem: o 201º pedido sumia da tela sem
 * aviso. O padrão continua 200 (a Conciliação e as Etiquetas não pedem página);
 * `countPurchaseOrders` é o `total` do mesmo recorte.
 */
export function listPurchaseOrders(
  companyId: string,
  filters: FiltroDosPedidos & { limit?: number; offset?: number } = {},
): Record<string, unknown>[] {
  ensureCoreSchema();
  const filtro = filtroDosPedidos(companyId, filters);
  const sql = `SELECT o.*, s.name AS supplier_name, s.trade_name AS supplier_trade_name
                 FROM core_purchase_orders o
                 JOIN core_suppliers s ON s.id = o.supplier_id
                WHERE ${filtro.where}
                ORDER BY o.number DESC LIMIT ? OFFSET ?`;
  return getConnection()
    .prepare(sql)
    .all(
      ...filtro.params,
      limitarPagina(filters.limit, 200),
      limitarDeslocamento(filters.offset),
    ) as unknown as Record<string, unknown>[];
}

export interface FiltroDosPedidos {
  status?: string;
  supplierId?: string;
}

function filtroDosPedidos(
  companyId: string,
  filters: FiltroDosPedidos,
): { where: string; params: (string | number)[] } {
  let where = 'o.company_id = ?';
  const params: (string | number)[] = [companyId];
  if (filters.status) {
    where += ' AND o.status = ?';
    params.push(filters.status);
  }
  if (filters.supplierId) {
    where += ' AND o.supplier_id = ?';
    params.push(filters.supplierId);
  }
  return { where, params };
}

/** Quantos pedidos o recorte de `listPurchaseOrders` tem, sem o LIMIT. */
export function countPurchaseOrders(companyId: string, filters: FiltroDosPedidos = {}): number {
  ensureCoreSchema();
  const filtro = filtroDosPedidos(companyId, filters);
  const linha = getConnection()
    .prepare(
      `SELECT COUNT(*) AS total
         FROM core_purchase_orders o
         JOIN core_suppliers s ON s.id = o.supplier_id
        WHERE ${filtro.where}`,
    )
    .get(...filtro.params) as { total: number };
  return Number(linha.total);
}
