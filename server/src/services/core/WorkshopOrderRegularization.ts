/**
 * REGULARIZAR A OS QUE FICOU FORA DAS REGRAS (GAP-PRD-188).
 *
 * ## O dado que motivou
 *
 * O banco da loja tem a OS #1: sem bancada (gravada antes de `workshop_id`
 * existir), em "em andamento" e sem responsável, com um evento
 * finalizada → em andamento na linha do tempo. O card aparece no quadro real,
 * ninguém consegue concluí-lo (`CORE_ORDER_NOT_ASSIGNED`) e ninguém consegue
 * largá-lo (`CORE_ORDER_UNASSIGNED`: "já está no quadro"). A correção pedida
 * era SQL — e SQL no banco da loja é exatamente o que não se faz.
 *
 * A porta que deixou o evento torto nascer foi fechada em `assumeOrder` (não se
 * assume OS paga nem finalizada). O que já está gravado precisa de um caminho
 * pela tela, com motivo e autor, e é este.
 *
 * ## Os dois destinos
 *
 *   quadro    a OS volta às regras: ganha a bancada (a única da empresa, ou a
 *             escolhida) e, se estava numa coluna de trabalho sem responsável,
 *             volta para "em aberto" — o próximo técnico a assume como qualquer
 *             outra;
 *   encerrar  a OS era lançamento indevido (teste, duplicada, aberta por
 *             engano): fecha como FINALIZADA sem custo, motivo
 *             `lancamento_indevido`. Só vale para OS sem dinheiro nenhum — sem
 *             peça, sem mão de obra, sem venda — e ainda na bancada.
 *
 * Nada é apagado: o número, a linha do tempo e os comentários ficam; a
 * regularização entra como mais um passo, com o nome de quem decidiu.
 *
 * ## Quem
 *
 * Só a gestão da oficina (a rota confere). É decisão sobre o quadro inteiro, e
 * `encerrar` é o único jeito de fechar uma OS sem a conclusão técnica.
 */
import { randomUUID } from 'node:crypto';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ApiError } from '../../utils/errors.js';
import {
  addComment,
  exigirOsNoAlcance,
  getOrder,
  isOrderOnBench,
  registrarSituacaoNaCentral,
  type ServiceOrder,
} from './WorkshopCoreService.js';
import { irregularidadesDaOs, type IrregularidadeDaOs } from './WorkshopOrderVersion.js';

export type DestinoDaRegularizacao = 'quadro' | 'encerrar';

/** O motivo gravado em `no_cost_reason` quando a gestão encerra a OS. */
export const MOTIVO_LANCAMENTO_INDEVIDO = 'lancamento_indevido';

export interface OsRegularizada {
  order: ServiceOrder;
  destino: DestinoDaRegularizacao;
  /** O que estava fora das regras ANTES — é o que a auditoria precisa guardar. */
  irregularidadesAntes: IrregularidadeDaOs[];
  statusAntes: string;
  workshopIdAntes: string | null;
}

function evento(orderId: string, companyId: string, de: string, para: string, userId: string, nota: string): void {
  getConnection()
    .prepare(
      `INSERT INTO core_service_order_events
         (id, order_id, company_id, from_status, to_status, user_id, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(randomUUID(), orderId, companyId, de, para, userId, nota, new Date().toISOString());
}

/**
 * A bancada que a OS sem bancada vai receber.
 *
 * A pedida, se for bancada ativa DESTA empresa; sem pedido, a única da
 * empresa; com várias e sem pedido, a recusa lista as opções.
 */
function bancadaParaAOs(companyId: string, pedida: string | null): string {
  const bancadas = getConnection()
    .prepare('SELECT id, name FROM core_workshops WHERE company_id = ? AND active = 1 ORDER BY name')
    .all(companyId) as unknown as { id: string; name: string }[];
  if (bancadas.length === 0) {
    throw new ApiError(
      'CORE_WORKSHOP_NOT_FOUND',
      'A empresa não tem bancada ativa: cadastre a bancada em Oficinas antes de regularizar a OS.',
      409,
    );
  }
  if (pedida) {
    const achada = bancadas.find((b) => b.id === pedida);
    if (!achada) {
      throw new ApiError('CORE_WORKSHOP_FORBIDDEN', 'Bancada não encontrada nesta empresa.', 403);
    }
    return achada.id;
  }
  if (bancadas.length === 1) return bancadas[0]!.id;
  throw new ApiError(
    'CORE_WORKSHOP_REQUIRED',
    'A empresa tem mais de uma bancada: escolha em qual a OS vai ficar.',
    400,
    { bancadas },
  );
}

export function regularizarOs(input: {
  companyId: string;
  alcance: string[] | null;
  orderId: string;
  userId: string;
  userName: string;
  destino: unknown;
  motivo: unknown;
  workshopId?: unknown;
}): OsRegularizada {
  const destino = String(input.destino ?? '');
  if (destino !== 'quadro' && destino !== 'encerrar') {
    throw new ApiError(
      'CORE_REGULARIZATION_TARGET_INVALID',
      'Diga o que fazer com a OS: devolver ao quadro ou encerrar como lançamento indevido.',
      400,
    );
  }
  const motivo = String(input.motivo ?? '').trim();
  if (!motivo) {
    throw new ApiError(
      'CORE_REASON_REQUIRED',
      'Regularizar a OS exige o motivo — é o que fica na linha do tempo para quem ler depois.',
      400,
    );
  }
  const pedida = input.workshopId ? String(input.workshopId) : null;

  return withTransaction(() => {
    const db = getConnection();
    const antes = exigirOsNoAlcance(input.companyId, input.alcance, input.orderId);
    const irregularidadesAntes = irregularidadesDaOs(antes);

    if (antes.workshop_id && pedida && pedida !== antes.workshop_id) {
      throw new ApiError(
        'CORE_ORDER_ALREADY_HAS_WORKSHOP',
        'Esta OS já tem bancada. Regularizar não transfere OS de bancada.',
        409,
      );
    }
    const bancada = antes.workshop_id ?? bancadaParaAOs(input.companyId, pedida);
    const agora = new Date().toISOString();

    if (destino === 'quadro') {
      if (irregularidadesAntes.length === 0) {
        throw new ApiError(
          'CORE_ORDER_NOTHING_TO_FIX',
          'Esta OS já está dentro das regras: tem bancada e, em coluna de trabalho, responsável.',
          409,
        );
      }
      const devolve = irregularidadesAntes.includes('sem_responsavel');
      db.prepare(
        `UPDATE core_service_orders
            SET workshop_id = ?,
                status = CASE WHEN ? = 1 THEN 'em_aberto' ELSE status END,
                assigned_at = CASE WHEN ? = 1 THEN NULL ELSE assigned_at END,
                status_changed_at = CASE WHEN ? = 1 THEN ? ELSE status_changed_at END,
                updated_at = ?
          WHERE id = ?`,
      ).run(bancada, devolve ? 1 : 0, devolve ? 1 : 0, devolve ? 1 : 0, agora, agora, antes.id);

      if (devolve) {
        evento(antes.id, input.companyId, antes.status, 'em_aberto', input.userId,
          `Regularização: devolvida ao quadro sem responsável — ${motivo}`);
      }
      const partes = [
        irregularidadesAntes.includes('sem_bancada') ? 'a OS ganhou a bancada' : null,
        devolve ? 'voltou para "em aberto" (estava numa coluna de trabalho sem responsável)' : null,
      ].filter(Boolean);
      addComment({
        companyId: input.companyId,
        workshopId: null,
        orderId: antes.id,
        userId: input.userId,
        authorName: input.userName,
        authorKind: 'gestor',
        body: `Regularização: ${partes.join('; ')}. Motivo: ${motivo}`,
      });
    } else {
      if (!isOrderOnBench(antes.status)) {
        throw new ApiError(
          'CORE_ORDER_PAST_BOARD',
          'Só se encerra como lançamento indevido a OS que ainda está na bancada: '
            + 'a da fila do caixa ou finalizada já envolve cobrança.',
          409,
        );
      }
      const pecas = (
        db
          .prepare('SELECT COUNT(*) AS n FROM core_service_order_parts WHERE order_id = ?')
          .get(antes.id) as { n: number }
      ).n;
      if (
        pecas > 0
        || Number(antes.total_cents) > 0
        || Number(antes.labor_cents) > 0
        || Number(antes.parts_cents) > 0
        || antes.sale_id
      ) {
        throw new ApiError(
          'CORE_ORDER_HAS_MONEY',
          'Esta OS tem peça, mão de obra ou venda: ela não é lançamento indevido. '
            + 'Devolva as peças e conclua pelo caminho normal.',
          409,
        );
      }
      db.prepare(
        `UPDATE core_service_orders
            SET workshop_id = ?, status = 'finalizada', has_cost = 0, no_cost_reason = ?,
                diagnosis = COALESCE(diagnosis, ?), approval_requested_at = NULL,
                status_changed_at = ?, closed_at = ?, updated_at = ?
          WHERE id = ?`,
      ).run(
        bancada,
        MOTIVO_LANCAMENTO_INDEVIDO,
        `Encerrada pela gestão como lançamento indevido: ${motivo}`,
        agora,
        agora,
        agora,
        antes.id,
      );
      evento(antes.id, input.companyId, antes.status, 'finalizada', input.userId,
        `Regularização: encerrada como lançamento indevido — ${motivo}`);
      addComment({
        companyId: input.companyId,
        workshopId: null,
        orderId: antes.id,
        userId: input.userId,
        authorName: input.userName,
        authorKind: 'gestor',
        body: `Encerrada como lançamento indevido (sem custo, sem cobrança). Motivo: ${motivo}`,
      });
    }

    registrarSituacaoNaCentral(input.companyId, antes.id);
    return {
      order: getOrder(input.companyId, antes.id)!,
      destino,
      irregularidadesAntes,
      statusAntes: antes.status,
      workshopIdAntes: antes.workshop_id,
    };
  });
}
