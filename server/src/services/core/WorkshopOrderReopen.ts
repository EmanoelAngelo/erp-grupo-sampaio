/**
 * A OS PAGA VOLTA PARA A FILA DO CAIXA QUANDO A VENDA DELA CAI (GAP-PRD-105).
 *
 * ## O defeito
 *
 * `settleOrder` era só ida: a venda nascia, a OS virava `finalizada` com
 * `sale_id` e `paid_at`, e nada no sistema sabia desfazer isso. Cancelar a
 * venda pela tela de vendas desfazia estoque, título, gaveta, comissão e
 * pontos — e deixava a OS "finalizada" apontando para uma venda cancelada. A
 * oficina passava a ter um serviço entregue que ninguém pagou e que nenhuma
 * fila mostrava; a correção era SQL.
 *
 * ## A regra escolhida (e por que ela é o padrão seguro)
 *
 * Cancelar a venda da OS reabre a OS em `aguardando_pagamento`, sem venda e
 * sem data de pagamento, com o motivo na linha do tempo. Três razões:
 *
 *   1. o serviço foi feito — as peças já saíram da gaveta na conclusão técnica,
 *      e voltar a OS para a bancada fingiria que o conserto não aconteceu;
 *   2. a fila do caixa é o único lugar onde a OS pode receber de novo, então
 *      é para lá que ela precisa ir para o erro de cobrança ser consertado;
 *   3. se a CONTA estava errada (mão de obra, peça), o gerente já tem o gesto:
 *      mover a OS da fila do caixa de volta para a bancada é decisão de gestão
 *      (`CORE_LEAVE_PAYMENT_MANAGER_ONLY` em `moveOrder`).
 *
 * O número da OS, o histórico e a venda cancelada continuam existindo — nada é
 * apagado. A venda antiga é nomeada na linha do tempo e na auditoria.
 *
 * ## Por que um módulo próprio, e só com o banco
 *
 * Quem chama é `cancelSale`, DENTRO da transação dele, e por isso a reabertura
 * anda junto com o resto do cancelamento: ou os dois acontecem, ou nenhum. O
 * módulo não importa serviço nenhum — `SalesService` o importa, e o caminho de
 * volta (estorno pela ficha da OS) importa `SalesService`; sem esta separação
 * os dois se importariam em círculo.
 */
import { randomUUID } from 'node:crypto';
import { getConnection } from '../../db/sqlite.js';
import { recordDomainEvent } from '../sync/DomainEvents.js';

export interface OsReaberta {
  orderId: string;
  number: number;
}

/**
 * Reabre a OS que a venda `saleId` tinha finalizado. Sem OS ligada à venda,
 * não faz nada e devolve nulo — a venda de balcão comum passa por aqui sem
 * efeito nenhum.
 *
 * Idempotente: a OS só é reaberta enquanto estiver `finalizada` com esta venda.
 * Cancelar a mesma venda de novo não encontra mais OS nenhuma.
 */
export function reabrirOsDaVendaCancelada(input: {
  companyId: string;
  saleId: string;
  userId: string;
  reason?: string | null;
}): OsReaberta | null {
  const db = getConnection();
  const os = db
    .prepare(
      `SELECT id, number FROM core_service_orders
        WHERE company_id = ? AND sale_id = ? AND status = 'finalizada'`,
    )
    .get(input.companyId, input.saleId) as { id: string; number: number } | undefined;
  if (!os) return null;

  const venda = db
    .prepare('SELECT number FROM core_sales WHERE id = ? AND company_id = ?')
    .get(input.saleId, input.companyId) as { number: number } | undefined;

  const agora = new Date().toISOString();
  db.prepare(
    `UPDATE core_service_orders
        SET status = 'aguardando_pagamento', sale_id = NULL, paid_at = NULL, closed_at = NULL,
            status_changed_at = ?, updated_at = ?
      WHERE id = ?`,
  ).run(agora, agora, os.id);

  const motivo = input.reason?.trim();
  const nota =
    `Recebimento estornado: venda #${venda?.number ?? '?'} cancelada. `
    + 'A OS voltou para a fila do caixa.'
    + (motivo ? ` Motivo: ${motivo}` : '');
  db.prepare(
    `INSERT INTO core_service_order_events
       (id, order_id, company_id, from_status, to_status, user_id, note, created_at)
     VALUES (?, ?, ?, 'finalizada', 'aguardando_pagamento', ?, ?, ?)`,
  ).run(randomUUID(), os.id, input.companyId, input.userId, nota, agora);

  /*
    A CENTRAL SABE QUE A OS VOLTOU (GAP-PRD-100).

    O retrato é o mesmo de `registrarSituacaoNaCentral` (WorkshopCoreService) —
    a OS inteira depois da mudança. Escrito aqui, e não importado de lá, pela
    mesma razão do cabeçalho: este módulo só fala com o banco, e o evento de
    domínio é folha (`DomainEvents` não importa serviço nenhum).
  */
  const retrato = db
    .prepare('SELECT * FROM core_service_orders WHERE id = ?')
    .get(os.id) as Record<string, unknown> & { workshop_id: string | null };
  recordDomainEvent({
    eventType: 'service_order.status_changed',
    aggregateType: 'service_order',
    aggregateId: os.id,
    companyId: input.companyId,
    operationalUnitId: retrato.workshop_id,
    operation: 'update',
    payload: retrato,
    occurredAt: agora,
  });

  return { orderId: os.id, number: os.number };
}

/**
 * Quantas vezes o recebimento desta OS já foi estornado.
 *
 * É o que separa a chave padrão de um recebimento da chave do recebimento
 * seguinte: sem isto, a OS reaberta cobrada de novo sem cabeçalho encontraria
 * a venda CANCELADA pela mesma chave `os-<id>` e seria dada como "já recebida".
 */
export function estornosDaOs(companyId: string, orderId: string): number {
  const linha = getConnection()
    .prepare(
      `SELECT COUNT(*) AS n FROM core_service_order_events
        WHERE company_id = ? AND order_id = ?
          AND from_status = 'finalizada' AND to_status = 'aguardando_pagamento'`,
    )
    .get(companyId, orderId) as { n: number };
  return linha.n;
}
