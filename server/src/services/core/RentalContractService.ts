/**
 * Contrato de locação.
 *
 * LOCAR NÃO É VENDER, e a diferença decide o que acontece com o estoque.
 *
 * Na venda a mercadoria vira de outro e sai do saldo. Na locação ela continua
 * sendo da loja e volta — então locar RESERVA em vez de dar baixa. O item
 * continua no saldo, porque é patrimônio da loja, e some do DISPONÍVEL, porque
 * está fora. É isso que impede o balcão de vender a cadeira que está na festa
 * do cliente.
 *
 * Essa proteção só passou a valer de verdade nesta rodada: a venda ignorava a
 * reserva e consumia o saldo assim mesmo (com 1 em estoque e 1 reservado, a
 * venda passava e deixava o disponível em -1). O `SalesService` agora recusa,
 * e é o que sustenta a promessa daqui.
 *
 * Devolver solta a reserva. Cancelar também: contrato que não aconteceu não
 * pode manter mercadoria presa.
 */
import { randomUUID } from 'node:crypto';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema, nextSequenceValue } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { getAvailable, releaseReservation, reserveStock } from './InventoryService.js';
import { modeloAtivo, recusaDeProdutoInativo } from './produtoVendavel.js';

export type RentalStatus = 'aberto' | 'devolvido' | 'cancelado';

export interface RentalItemInput {
  productId: string;
  quantity: number;
  unitCents?: number;
}

function loadContract(companyId: string, contractId: string): Record<string, unknown> {
  const row = getConnection()
    .prepare('SELECT * FROM core_rental_contracts WHERE id = ? AND company_id = ?')
    .get(contractId, companyId) as Record<string, unknown> | undefined;
  if (!row) throw new ApiError('CORE_RENTAL_NOT_FOUND', 'Contrato não encontrado.', 404);
  return row;
}

export function createRentalContract(input: {
  companyId: string;
  userId?: string;
  customerId: string;
  items: RentalItemInput[];
  startsAt?: string | null;
  endsAt: string;
  depositCents?: number;
  notes?: string | null;
}): Record<string, unknown> {
  ensureCoreSchema();

  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new ApiError('CORE_RENTAL_EMPTY', 'O contrato precisa de ao menos um item.', 400);
  }
  if (!input.endsAt) {
    throw new ApiError('CORE_RENTAL_NO_END', 'Informe a data combinada de devolução.', 400);
  }

  return withTransaction(() => {
    const db = getConnection();

    const cliente = db
      .prepare('SELECT id FROM core_customers WHERE id = ? AND company_id = ?')
      .get(input.customerId, input.companyId) as { id: string } | undefined;
    // Locação sem cliente não existe: alguém tem de responder pelo bem.
    if (!cliente) throw new ApiError('CORE_CUSTOMER_NOT_FOUND', 'Cliente não encontrado.', 404);

    const inicio = input.startsAt ?? new Date().toISOString();
    if (new Date(input.endsAt).getTime() <= new Date(inicio).getTime()) {
      throw new ApiError('CORE_RENTAL_BAD_PERIOD', 'A devolução tem de ser depois da retirada.', 400);
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    const numero = nextSequenceValue(input.companyId, 'rental_contract');

    db.prepare(
      `INSERT INTO core_rental_contracts
         (id, company_id, number, customer_id, status, starts_at, ends_at, total_cents,
          deposit_cents, notes, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'aberto', ?, ?, 0, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.companyId,
      numero,
      input.customerId,
      inicio,
      input.endsAt,
      Math.max(0, Math.round(Number(input.depositCents ?? 0))),
      input.notes ? String(input.notes).trim() : null,
      input.userId ?? null,
      now,
      now,
    );

    let total = 0;
    for (const item of input.items) {
      const quantidade = Number(item.quantity);
      if (!Number.isFinite(quantidade) || quantidade <= 0) {
        throw new ApiError('CORE_RENTAL_QUANTITY', 'Quantidade inválida.', 400);
      }
      const produto = db
        .prepare(
          `SELECT p.id, p.name, p.kind, p.active, ${modeloAtivo('p')} AS modelo_ativo
             FROM core_products p WHERE p.id = ? AND p.company_id = ?`,
        )
        .get(item.productId, input.companyId) as
        | { id: string; name: string; kind: string | null; active: number; modelo_ativo: number }
        | undefined;
      if (!produto) throw new ApiError('CORE_PRODUCT_NOT_FOUND', 'Produto não encontrado.', 404);

      // PRODUTO ARQUIVADO NÃO SE ALUGA. A tela de locação carrega a lista do
      // cadastro inteira, então nenhum filtro de busca protegia daqui — e o
      // contrato RESERVA saldo em nome do produto que a loja tirou de uso.
      if (Number(produto.active) !== 1 || Number(produto.modelo_ativo) !== 1) {
        throw recusaDeProdutoInativo(produto.name, 'ser alugado', produto.id);
      }

      /*
        PEÇA DE BANCADA NÃO SE ALUGA.

        A locação era o caminho aberto: o seletor de produto do contrato não
        passa pela busca do PDV — a tela carrega a lista inteira de produtos da
        empresa —, então nenhum filtro de busca protegia daqui. E o contrato
        RESERVA o saldo: alugar uma peça tiraria do disponível a bateria que a
        oficina está contando para terminar um conserto, sem que nada na tela
        de peças dissesse para onde ela foi. O item ainda voltaria "quando o
        cliente devolvesse", o que para uma peça de reposição não quer dizer
        nada — ela é aplicada, não devolvida.

        A recusa é no SERVIÇO e não na lista: a tela pode ser corrigida depois,
        e enquanto isso quem escolher a peça na lista recebe uma frase que
        explica, em vez de um contrato que prende estoque de oficina.
      */
      if (String(produto.kind ?? 'retail') === 'part') {
        throw new ApiError(
          'CORE_PART_CANNOT_BE_RENTED',
          `"${produto.name}" é peça de oficina e não se aluga: o saldo dela sustenta os consertos e sai por requisição de ordem de serviço.`,
          409,
        );
      }

      // Não se aluga o que não está livre: a peça pode já estar em outro
      // contrato, reservada para pré-venda ou vendida.
      const disponivel = getAvailable(input.companyId, produto.id);
      if (quantidade > disponivel) {
        throw new ApiError(
          'CORE_RENTAL_UNAVAILABLE',
          `"${produto.name}" tem ${disponivel} livre(s) para locar.`,
          409,
        );
      }

      const unitario = Math.max(0, Math.round(Number(item.unitCents ?? 0)));
      total += Math.round(unitario * quantidade);

      db.prepare(
        `INSERT INTO core_rental_contract_items
           (id, contract_id, company_id, product_id, quantity, returned_quantity, unit_cents, created_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
      ).run(randomUUID(), id, input.companyId, produto.id, quantidade, unitario, now);

      // RESERVA, não baixa: o bem continua sendo da loja.
      reserveStock({
        companyId: input.companyId,
        productId: produto.id,
        quantity: quantidade,
        referenceType: 'rental_contract',
        referenceId: `${id}:${produto.id}`,
        documentNumber: `Locação #${numero}`,
        userId: input.userId ?? null,
      });
    }

    db.prepare('UPDATE core_rental_contracts SET total_cents = ? WHERE id = ?').run(total, id);
    return getRentalContract(input.companyId, id);
  });
}

/**
 * O cliente trouxe o bem de volta.
 *
 * Parcial é o caso normal: trouxe duas das três cadeiras. Só o que voltou solta
 * reserva; o resto continua fora e continua indisponível para venda.
 */
export function returnRentalItems(input: {
  companyId: string;
  contractId: string;
  userId?: string;
  items: { productId: string; quantity: number }[];
}): Record<string, unknown> {
  ensureCoreSchema();
  return withTransaction(() => {
    const contrato = loadContract(input.companyId, input.contractId);
    if (contrato.status !== 'aberto') {
      throw new ApiError('CORE_RENTAL_CLOSED', 'Contrato já encerrado.', 409);
    }

    const db = getConnection();
    for (const devolvido of input.items) {
      const quantidade = Number(devolvido.quantity);
      if (!Number.isFinite(quantidade) || quantidade <= 0) continue;

      const item = db
        .prepare(
          'SELECT * FROM core_rental_contract_items WHERE contract_id = ? AND product_id = ?',
        )
        .get(input.contractId, devolvido.productId) as
        | { id: string; quantity: number; returned_quantity: number }
        | undefined;
      if (!item) {
        throw new ApiError('CORE_RENTAL_ITEM_NOT_FOUND', 'Item não pertence a este contrato.', 404);
      }

      const restante = item.quantity - item.returned_quantity;
      if (quantidade > restante + 1e-9) {
        throw new ApiError(
          'CORE_RENTAL_RETURN_EXCEEDS',
          `Devolução maior que o locado: restam ${restante}.`,
          409,
        );
      }

      db.prepare(
        'UPDATE core_rental_contract_items SET returned_quantity = returned_quantity + ? WHERE id = ?',
      ).run(quantidade, item.id);

      // Voltou: libera para vender ou locar de novo.
      releaseReservation({
        companyId: input.companyId,
        productId: devolvido.productId,
        quantity: quantidade,
        referenceType: 'rental_return',
        referenceId: `${input.contractId}:${devolvido.productId}:${randomUUID()}`,
        documentNumber: `Locação #${contrato.number}`,
        userId: input.userId ?? null,
      });
    }

    // Tudo de volta: o contrato encerra sozinho.
    const pendente = db
      .prepare(
        `SELECT COALESCE(SUM(quantity - returned_quantity), 0) AS falta
           FROM core_rental_contract_items WHERE contract_id = ?`,
      )
      .get(input.contractId) as { falta: number };

    if (pendente.falta <= 1e-9) {
      db.prepare(
        "UPDATE core_rental_contracts SET status = 'devolvido', returned_at = ?, updated_at = ? WHERE id = ?",
      ).run(new Date().toISOString(), new Date().toISOString(), input.contractId);
    }

    return getRentalContract(input.companyId, input.contractId);
  });
}

/** Cancelar solta tudo que ainda está preso. */
export function cancelRentalContract(input: {
  companyId: string;
  contractId: string;
  userId?: string;
  reason: string;
}): Record<string, unknown> {
  ensureCoreSchema();
  const motivo = String(input.reason ?? '').trim();
  if (motivo.length < 3) {
    throw new ApiError('CORE_RENTAL_REASON', 'Informe o motivo do cancelamento.', 400);
  }

  return withTransaction(() => {
    const contrato = loadContract(input.companyId, input.contractId);
    if (contrato.status !== 'aberto') {
      throw new ApiError('CORE_RENTAL_CLOSED', 'Contrato já encerrado.', 409);
    }

    const db = getConnection();
    const itens = db
      .prepare('SELECT * FROM core_rental_contract_items WHERE contract_id = ?')
      .all(input.contractId) as unknown as {
      product_id: string;
      quantity: number;
      returned_quantity: number;
    }[];

    for (const item of itens) {
      const preso = item.quantity - item.returned_quantity;
      if (preso <= 0) continue;
      // Contrato cancelado que mantivesse a reserva tiraria mercadoria de
      // circulação para sempre, sem nada apontando o motivo.
      releaseReservation({
        companyId: input.companyId,
        productId: item.product_id,
        quantity: preso,
        referenceType: 'rental_cancel',
        referenceId: `${input.contractId}:${item.product_id}`,
        documentNumber: `Locação #${contrato.number}`,
        userId: input.userId ?? null,
      });
    }

    db.prepare(
      "UPDATE core_rental_contracts SET status = 'cancelado', cancel_reason = ?, updated_at = ? WHERE id = ?",
    ).run(motivo, new Date().toISOString(), input.contractId);

    return getRentalContract(input.companyId, input.contractId);
  });
}

export function getRentalContract(companyId: string, contractId: string): Record<string, unknown> {
  ensureCoreSchema();
  const contrato = loadContract(companyId, contractId);
  const items = getConnection()
    .prepare(
      `SELECT i.*, p.name, p.internal_code
         FROM core_rental_contract_items i
         JOIN core_products p ON p.id = i.product_id
        WHERE i.contract_id = ? ORDER BY p.name`,
    )
    .all(contractId) as unknown as Record<string, unknown>[];

  const cliente = getConnection()
    .prepare('SELECT name, phone FROM core_customers WHERE id = ?')
    .get(contrato.customer_id as string) as Record<string, unknown> | undefined;

  // Atrasado é CALCULADO, não gravado: um estado guardado envelheceria sozinho
  // e o contrato só ficaria atrasado quando alguém abrisse a tela.
  const atrasado =
    contrato.status === 'aberto' && new Date(String(contrato.ends_at)).getTime() < Date.now();

  return { ...contrato, customer: cliente ?? null, items, atrasado };
}

export function listRentalContracts(
  companyId: string,
  filters: { status?: string } = {},
): Record<string, unknown>[] {
  ensureCoreSchema();
  let sql = `SELECT c.*, cu.name AS customer_name
               FROM core_rental_contracts c
               JOIN core_customers cu ON cu.id = c.customer_id
              WHERE c.company_id = ?`;
  const params: (string | number)[] = [companyId];
  if (filters.status) {
    sql += ' AND c.status = ?';
    params.push(filters.status);
  }
  sql += ' ORDER BY c.number DESC LIMIT 200';

  const rows = getConnection().prepare(sql).all(...params) as unknown as Record<string, unknown>[];
  const agora = Date.now();
  return rows.map((r) => ({
    ...r,
    atrasado: r.status === 'aberto' && new Date(String(r.ends_at)).getTime() < agora,
  }));
}
