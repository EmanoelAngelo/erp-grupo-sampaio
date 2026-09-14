/**
 * Peças da oficina.
 *
 * PEÇA NÃO É PRODUTO DE REVENDA, e o schema já dizia isso: `kind = 'part'` e
 * `workshop_id` separam o estoque de peças de celulares do de mobilidade. O que
 * faltava era a visão — quem está na bancada precisa saber o que tem na
 * gaveta, e hoje não tinha onde olhar.
 *
 * O MECÂNICO NÃO VÊ CUSTO. É regra já estabelecida no repositório para a razão
 * de estoque, e vale igual aqui: o que a empresa pagou no fornecedor não é
 * assunto de quem monta a peça. E o campo é REMOVIDO da resposta, não escondido
 * na tela — dado que não sai do servidor não vaza por inspeção do navegador.
 *
 * A DEVOLUÇÃO DE PEÇA existia só como rótulo (`WORKSHOP_PART_RETURN`) e sem
 * escritor. Sem ela, peça requisitada e não usada some do estoque para sempre:
 * o mecânico pegou três parafusos, usou dois, e o terceiro nunca voltou a
 * existir no sistema.
 */
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { abaixoDoMinimo, applyMovement } from './InventoryService.js';
import { isSerialized, unitsByExitReference } from './ProductUnitService.js';
import { exigirOsNoAlcance, recalcularTotaisDaOS } from './WorkshopCoreService.js';
import {
  custoDaPecaConsumida,
  estadoDaPeca,
  soltarPromessaParcial,
} from './WorkshopPartsReservation.js';

/** Perfis que enxergam custo. Fora desta lista, o campo não sai do servidor. */
const VEEM_CUSTO = ['admin_geral', 'gestor', 'gerente_loja', 'gerente_oficina', 'estoquista'];

export function podeVerCusto(profiles: string[]): boolean {
  return profiles.some((p) => VEEM_CUSTO.includes(p));
}

export function listParts(
  companyId: string,
  options: {
    workshopId?: string | null;
    /** O alcance de bancadas de quem está olhando. `null` = a empresa inteira. */
    workshopIds?: string[] | null;
    search?: string;
    hideCost?: boolean;
  } = {},
): Record<string, unknown>[] {
  ensureCoreSchema();

  const params: (string | number)[] = [companyId];
  let sql = `SELECT p.id, p.internal_code, p.barcode, p.name, p.unit, p.price_cents,
                    p.cost_cents, p.min_stock, p.workshop_id, p.active,
                    p.storage_location,
                    COALESCE(s.quantity, 0) AS stock_quantity,
                    COALESCE(s.reserved, 0) AS reserved,
                    w.name AS workshop_name
               FROM core_products p
               LEFT JOIN core_stock s ON s.product_id = p.id AND s.company_id = p.company_id
               LEFT JOIN core_workshops w ON w.id = p.workshop_id AND w.company_id = p.company_id
              WHERE p.company_id = ? AND p.kind = 'part' AND p.active = 1`;

  // Peça pertence a UMA oficina: a bancada de celulares não enxerga o estoque
  // de mobilidade, e vice-versa.
  if (options.workshopId) {
    sql += ' AND p.workshop_id = ?';
    params.push(options.workshopId);
  } else if (options.workshopIds && options.workshopIds.length > 0) {
    /*
      O RECORTE DE BANCADA VALIA NA OS E NÃO VALIA NA LISTA.

      O subtítulo da tela sempre disse "a de celulares não enxerga a de
      mobilidade" — e a lista mostrava as duas, porque ninguém passava o
      recorte. `addPart` recusava a peça da outra bancada, então a separação
      existia onde dá erro e não existia onde se procura: o mecânico via a
      peça, escolhia, e levava 403.
    */
    sql += ` AND p.workshop_id IN (${options.workshopIds.map(() => '?').join(', ')})`;
    params.push(...options.workshopIds);
  }
  if (options.search) {
    // A LOCALIZAÇÃO ENTRA NA BUSCA. "O que tem na prateleira F1?" era pergunta
    // sem resposta no sistema anterior — o campo existia e não era procurável.
    sql += ' AND (p.name LIKE ? OR p.internal_code LIKE ? OR p.barcode = ?'
      + ' OR p.storage_location LIKE ?)';
    params.push(
      `%${options.search}%`,
      `%${options.search}%`,
      options.search,
      `%${options.search}%`,
    );
  }

  sql += ' ORDER BY p.name LIMIT 300';
  const rows = getConnection().prepare(sql).all(...params) as unknown as Record<string, unknown>[];

  return rows.map((row) => {
    const disponivel = Number(row.stock_quantity) - Number(row.reserved);
    const base = {
      ...row,
      available: disponivel,
      // Abaixo do mínimo é o que faz alguém repor antes de faltar no meio de
      // um conserto.
      below_minimum: abaixoDoMinimo(disponivel, Number(row.min_stock)),
    };
    if (!options.hideCost) return base;

    // Removido, não zerado: um custo zero seria lido como peça de graça.
    const semCusto: Record<string, unknown> = { ...base };
    delete semCusto.cost_cents;
    return semCusto;
  });
}

/**
 * Tira da OS a peça requisitada e não usada.
 *
 * Sem isto a peça some da conta e some da gaveta: o mecânico pegou três, usou
 * duas, e a terceira nunca voltou a existir em lugar nenhum.
 *
 * O QUE ACONTECE COM O SALDO depende de onde a peça estava (rodada 55). Se ela
 * já tinha SAÍDO, volta como entrada de tipo próprio — `WORKSHOP_PART_RETURN`,
 * e não um ajuste de inventário, que esconderia a origem. Se ela nunca saiu —
 * ainda prometida, ou com a promessa desfeita pela recusa do cliente —, não há
 * o que devolver ao saldo, e o único efeito é tirá-la da conta. A régua inteira
 * está no bloco de comentário dentro da função.
 *
 * ## QUEM DEVOLVE, E O QUE A DEVOLUÇÃO DERRUBA (GAP-PRD-103)
 *
 * A função conferia só a EMPRESA: qualquer mecânico da empresa devolvia peça
 * de OS alheia — inclusive de bancada que ele nem enxerga —, enquanto a porta
 * irmã, o lançamento (`addPart`), recusava quem não assumiu. E o total caía
 * com a aprovação do cliente de pé, sobre um valor que ele nunca viu. Agora:
 * a OS é conferida pelo ALCANCE de bancada (404 fora dele), só o responsável
 * — ou a gestão da oficina — devolve, e a mudança de valor derruba a
 * aprovação como em `addPart` e `setLabor`.
 */
export function returnPartToStock(input: {
  companyId: string;
  /** O alcance de bancadas de quem devolve (`resolveWorkshopScope`); nulo = a empresa. */
  workshopId?: string | string[] | null;
  orderId: string;
  partId: string;
  quantity: number;
  userId: string;
  /** Quem assina a queda da aprovação na linha do tempo. */
  userName?: string;
  /** Gerente da oficina (ou gestor/admin): devolve peça de OS de outro técnico. */
  isManager?: boolean;
  reason?: string | null;
}): { returned: number } {
  ensureCoreSchema();

  const quantidade = Number(input.quantity);
  if (!Number.isFinite(quantidade) || quantidade <= 0) {
    throw new ApiError('CORE_INVALID_QUANTITY', 'Quantidade deve ser maior que zero.', 400);
  }

  return withTransaction(() => {
    const db = getConnection();
    // A OS COMO ERA: é dela que sai o total aprovado, se a aprovação cair.
    const antes = exigirOsNoAlcance(input.companyId, input.workshopId ?? null, input.orderId);
    if (antes.mechanic_id && antes.mechanic_id !== input.userId && !input.isManager) {
      throw new ApiError(
        'CORE_ORDER_NOT_ASSIGNED_TO_YOU',
        'Esta OS está atribuída a outro técnico. Quem devolve peça é quem assumiu, ou o gerente da oficina.',
        403,
      );
    }
    const peca = db
      .prepare(
        `SELECT sp.*, so.number AS order_number, so.status AS order_status
           FROM core_service_order_parts sp
           JOIN core_service_orders so ON so.id = sp.order_id
          WHERE sp.id = ? AND sp.order_id = ? AND so.company_id = ?`,
      )
      .get(input.partId, input.orderId, input.companyId) as
      | {
          id: string;
          product_id: string;
          quantity: number;
          returned_quantity: number | null;
          order_number: number;
          order_status: string;
        }
      | undefined;
    if (!peca) throw new ApiError('CORE_PART_NOT_FOUND', 'Peça não encontrada nesta OS.', 404);

    // OS finalizada já virou custo e, se houve, já foi faturada. Devolver peça
    // depois disso mudaria um valor que o cliente já pagou.
    if (peca.order_status === 'finalizada') {
      throw new ApiError(
        'CORE_ORDER_FINISHED',
        'OS finalizada: a peça já entrou no custo e no faturamento.',
        409,
      );
    }

    const jaDevolvido = Number(peca.returned_quantity ?? 0);
    const restante = peca.quantity - jaDevolvido;
    if (quantidade > restante + 1e-9) {
      throw new ApiError(
        'CORE_PART_RETURN_EXCEEDS',
        `Devolução maior que o requisitado: restam ${restante}.`,
        409,
      );
    }

    db.prepare(
      'UPDATE core_service_order_parts SET returned_quantity = COALESCE(returned_quantity, 0) + ? WHERE id = ?',
    ).run(quantidade, input.partId);

    /*
      DEVOLVER TEM DOIS TEMPOS, PORQUE SÃO DOIS FATOS DIFERENTES (rodada 55).

      A pergunta que decide é UMA: a peça chegou a SAIR da prateleira?

        SAIU (estado 'consumida') -> volta mesmo, como entrada de tipo próprio.
        NÃO SAIU                  -> não há o que devolver ao saldo.

      E "não saiu" tem TRÊS formas, não uma. A primeira versão desta linha
      olhava só 'prometida' e mandava todo o resto para a entrada — o que
      INVENTA mercadoria em dois casos reais:

        'solta'        o cliente recusou o orçamento e a promessa caiu. A peça
                       está na prateleira. Dar entrada criaria uma segunda.
        'sem_registro' a linha existe sem movimento nenhum (OS anterior a esta
                       rodada com dado incompleto, ou falha no meio).

      Saldo inventado é o pior defeito de um estoque: ele não dói na hora, dói
      na contagem, meses depois, quando ninguém consegue mais reconstruir de
      onde veio a diferença.
    */
    const estado = estadoDaPeca(input.companyId, input.orderId, input.partId, peca.product_id);

    if (estado === 'prometida') {
      soltarPromessaParcial({
        companyId: input.companyId,
        orderId: input.orderId,
        partId: input.partId,
        productId: peca.product_id,
        quantity: quantidade,
        acumuladoDevolvido: jaDevolvido + quantidade,
        orderNumber: peca.order_number,
        userId: input.userId,
      });
    } else if (estado === 'consumida') {
      // A peça que volta é a MESMA que saiu: as unidades são achadas pela
      // referência de saída da OS, e não escolhidas de novo. Escolher outra
      // deixaria a que o mecânico devolveu marcada como consumida para sempre.
      const unidades = isSerialized(input.companyId, peca.product_id)
        ? unitsByExitReference(input.companyId, 'service_order', `${input.orderId}:${input.partId}`)
            .slice(0, quantidade)
            .map((u) => u.id)
        : undefined;

      applyMovement({
        companyId: input.companyId,
        productId: peca.product_id,
        movementType: 'in',
        quantity: quantidade,
        unitIds: unidades,
        referenceType: 'workshop_part_return',
        referenceId: `${input.partId}:${jaDevolvido + quantidade}`,
        kind: 'WORKSHOP_PART_RETURN',
        documentNumber: `OS #${peca.order_number}`,
        userId: input.userId,
        reason: input.reason ?? null,
        note: `Peça não usada devolvida da OS #${peca.order_number}`,
        // Volta com o MESMO custo com que saiu (GAP-PRD-101): a entrada
        // desfaz a saída, e um custo diferente mudaria o valor do estoque por
        // uma peça que nunca deixou a loja.
        unitCostCents:
          custoDaPecaConsumida(input.companyId, input.orderId, input.partId, peca.product_id)
          ?? undefined,
      });
    }
    // 'solta' e 'sem_registro' caem aqui de propósito: a peça está na
    // prateleira, e o único efeito da devolução é tirá-la da conta do cliente
    // — o que a recontagem logo abaixo faz.

    /*
      A CONTA DA OS TEM DE CAIR JUNTO.

      Faltava, e não aparecia porque nenhuma tela chamava esta função. Sem esta
      linha o cliente pagaria pelo parafuso que está de volta na gaveta, e uma
      OS com tudo devolvido continuaria com total maior que zero — o que faz
      `completeTechnical` recusar encerrá-la sem custo, mesmo sendo garantia em
      que nada foi usado.

      Dentro da MESMA transação do movimento de estoque: se a devolução for
      desfeita, a conta volta junto.
    */
    recalcularTotaisDaOS(input.orderId, {
      companyId: input.companyId,
      workshopId: input.workshopId ?? null,
      userId: input.userId,
      userName: input.userName,
      isManager: input.isManager,
      antes,
    });

    return { returned: quantidade };
  });
}
