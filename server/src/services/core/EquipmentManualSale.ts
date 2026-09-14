/**
 * ============================================================================
 * DESFAZER A "VENDA À MÃO" DA PLAQUINHA INTERNA (GAP-PRD-189, GAP-PRD-112)
 * ============================================================================
 *
 * ## O defeito que sobra depois da recusa
 *
 * `assignOwner` passou a recusar o registro de venda à mão da moto que ainda
 * está no pátio de uma loja do grupo. O que já foi registrado antes disso fica:
 * plaquinha `SOLD`, com dono, sem venda nenhuma por trás — e a auditoria mediu
 * que a única volta era mexer no banco. O banco da loja tem exatamente um caso
 * assim (GAP-PRD-112): um equipamento `INTERNAL_PJ_MOTORS` vendido à mão, sem
 * unidade correspondente.
 *
 * ## O que esta função faz, e o que ela NÃO desfaz
 *
 * Desfaz SÓ o registro à mão: `sale_status = 'SOLD'` com `sale_id` nulo, numa
 * plaquinha interna sem unidade vinculada. A plaquinha volta a `NOT_SOLD`, sem
 * dono, e fica adotável pela unidade da loja — para a moto sair pelo PDV, com
 * estoque, financeiro e nota. O evento guarda o dono anterior e o motivo: a
 * história não se apaga.
 *
 * Não desfaz venda de verdade. Com `sale_id`, quem desfaz é o cancelamento ou a
 * devolução da venda (`devolverPelaUnidade`). Com unidade vinculada, quem deu o
 * dono foi a venda da loja (inclusive a online, que não tem `sale_id`) — e
 * soltar dali apagaria o caminho entre a pessoa e a moto dela.
 *
 * Se a moto REALMENTE foi vendida antes do sistema (moto que saiu anos atrás e
 * voltou para revisão), o registro à mão está certo e deve ficar: a decisão é
 * de quem conhece a moto, por isso a função exige o motivo por escrito.
 */
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { getEquipment, recordEquipmentEvent, type Equipment } from './EquipmentService.js';

/** A plaquinha tem uma "venda à mão" que esta função sabe desfazer? */
export function temVendaAMao(equipmentId: string): boolean {
  ensureCoreSchema();
  const linha = getConnection()
    .prepare(
      `SELECT 1 AS ok FROM core_equipment e
        WHERE e.id = ? AND e.origin = 'INTERNAL_PJ_MOTORS' AND e.sale_status = 'SOLD'
          AND e.sale_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM core_product_units u WHERE u.equipment_id = e.id)`,
    )
    .get(equipmentId) as { ok?: number } | undefined;
  return Boolean(linha?.ok);
}

export function desfazerVendaAMao(input: {
  companyId: string;
  equipmentId: string;
  userId: string;
  motivo: string;
}): Equipment {
  ensureCoreSchema();
  const motivo = String(input.motivo ?? '').trim();
  if (motivo.length < 3) {
    throw new ApiError(
      'CORE_REASON_REQUIRED',
      'Diga por que o registro de venda está sendo desfeito — o motivo fica no histórico da máquina.',
      400,
    );
  }

  return withTransaction(() => {
    const db = getConnection();
    const eq = getEquipment(input.companyId, input.equipmentId);
    if (!eq) throw new ApiError('CORE_EQUIPMENT_NOT_FOUND', 'Equipamento não encontrado.', 404);

    if (eq.origin !== 'INTERNAL_PJ_MOTORS') {
      throw new ApiError(
        'CORE_MANUAL_SALE_NOT_APPLICABLE',
        'Só a moto interna do grupo tem registro de venda à mão. Equipamento de cliente não foi vendido pela loja.',
        409,
      );
    }
    if (eq.sale_status !== 'SOLD') {
      throw new ApiError('CORE_MANUAL_SALE_NOT_APPLICABLE', 'Esta plaquinha não tem venda registrada.', 409);
    }
    const saleId = (
      db.prepare('SELECT sale_id FROM core_equipment WHERE id = ?').get(input.equipmentId) as
        | { sale_id: string | null }
        | undefined
    )?.sale_id;
    if (saleId) {
      throw new ApiError(
        'CORE_MANUAL_SALE_NOT_APPLICABLE',
        'Esta plaquinha foi vendida por uma venda do sistema: o que a desfaz é o cancelamento ou a devolução ' +
          'da venda, que devolve também o estoque e o dinheiro.',
        409,
      );
    }
    const unidade = db
      .prepare('SELECT id FROM core_product_units WHERE equipment_id = ? LIMIT 1')
      .get(input.equipmentId) as { id: string } | undefined;
    if (unidade) {
      throw new ApiError(
        'CORE_EQUIPMENT_LINKED_TO_UNIT',
        'Esta plaquinha está vinculada a uma unidade da loja: o dono veio da venda da loja e não se desfaz aqui.',
        409,
      );
    }

    const donoAnterior = eq.owner_customer_id
      ? (db
          .prepare('SELECT name FROM core_customers WHERE id = ? AND company_id = ?')
          .get(String(eq.owner_customer_id), input.companyId) as { name: string } | undefined)
      : undefined;

    db.prepare(
      `UPDATE core_equipment
          SET owner_customer_id = NULL, sale_status = 'NOT_SOLD', sold_at = NULL, sale_id = NULL,
              updated_at = ?
        WHERE id = ? AND company_id = ?`,
    ).run(new Date().toISOString(), input.equipmentId, input.companyId);

    recordEquipmentEvent({
      equipmentId: input.equipmentId,
      companyId: input.companyId,
      eventType: 'sale_reverted',
      description:
        `Registro de venda à mão desfeito — motivo: ${motivo}. ` +
        `Dono registrado antes: ${donoAnterior?.name ?? 'sem nome'}` +
        `${eq.sold_at ? `, desde ${String(eq.sold_at).slice(0, 10)}` : ''}. ` +
        'A plaquinha volta a poder ser vinculada à unidade da loja, e a venda sai pelo PDV.',
      userId: input.userId,
    });

    return getEquipment(input.companyId, input.equipmentId)!;
  });
}
