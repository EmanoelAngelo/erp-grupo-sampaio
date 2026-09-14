/**
 * ============================================================================
 * A CONTRAPARTIDA FINANCEIRA DO REEMBOLSO DO PEDIDO ONLINE (GAP-PRD-031)
 * ============================================================================
 *
 * ## O DEFEITO
 *
 * O pagamento do pedido lança UMA entrada já liquidada (`origin_type =
 * 'ecommerce_order'`, `markOrderPaid`). A devolução mexia no provedor, no
 * estoque e no status — e em NENHUM lançamento. A receita devolvida continuava
 * liquidada: o DRE do mês contava dinheiro que tinha voltado ao cliente, e a
 * conciliação do Asaas mostrava um estorno sem espelho no ERP. O caminho de
 * "desfazer a baixa pela tela" não servia: a entrada do pedido nasce quitada,
 * sem baixa em `core_finance_settlements` para estornar.
 *
 * ## O QUE ESTE MÓDULO FAZ
 *
 * Lança o dinheiro que VOLTA como fato próprio, na direção contrária — o mesmo
 * desenho da devolução de balcão (`SaleReturnService`):
 *
 *   - `origin_type = 'ecommerce_order_refund'`, `origin_id` = o pedido,
 *     direção `out`, categoria de sistema `devolucao` ("Devolução a cliente");
 *   - competência e vencimento no DIA DA LOJA em que o reembolso aconteceu —
 *     a receita do mês do pagamento não é reescrita (o mês pode estar
 *     fechado); a devolução diminui o resultado do mês em que ocorreu;
 *   - quando o provedor DEVOLVEU (estorno pedido com sucesso, ou o aviso de
 *     estorno/contestação do webhook), a saída nasce QUITADA e com a baixa
 *     espelho — a conciliação bancária compara extrato contra baixas;
 *   - quando o dinheiro ainda NÃO voltou (sem cobrança online, pagamento
 *     manual, estorno no provedor que falhou), a saída nasce EM ABERTO: é uma
 *     conta a pagar ao cliente, com vencimento hoje, e quem paga dá a baixa em
 *     Contas. Se depois o provedor confirmar o estorno, a baixa é dada aqui.
 *
 * UMA contrapartida por pedido: a `UNIQUE (origin_type, origin_id, direction,
 * installment_number)` de `core_finance_entries` segura o webhook repetido e
 * o clique duplo. Pedido que nunca lançou receita (não foi pago pelo caminho
 * que lança) não ganha contrapartida — não há o que contrapor.
 *
 * Este módulo NÃO importa `StorefrontService`: é chamado de dentro dele
 * (`markOrderRefunded`), e a importação de volta faria um ciclo.
 */
import { randomUUID } from 'node:crypto';
import { getConnection } from '../../db/sqlite.js';
import { systemCategoryId } from './FinanceSetupService.js';
import { inserirBaixaEspelho, settleEntry } from './FinanceService.js';
import { diaDaLoja } from './CalendarioOperacional.js';

/** A origem do lançamento do dinheiro que volta ao cliente do pedido online. */
export const ORIGEM_DO_REEMBOLSO = 'ecommerce_order_refund';

/**
 * Onde está o dinheiro no momento do reembolso.
 *
 *   `devolvido_pelo_provedor` — o provedor devolveu (ou avisou que devolveu):
 *                               a saída nasce quitada.
 *   `a_devolver`              — ninguém devolveu ainda: conta a pagar.
 */
export type SituacaoDoDinheiro = 'devolvido_pelo_provedor' | 'a_devolver';

export interface ContrapartidaDoReembolso {
  /** Nulo quando o pedido nunca lançou receita. */
  entryId: string | null;
  amountCents: number;
  quitada: boolean;
}

interface LinhaDoLancamento {
  id: string;
  amount_cents: number;
  settled_cents: number;
  cancelled_at: string | null;
}

/** A saída de reembolso deste pedido, se já existe. */
export function contrapartidaDoPedido(
  companyId: string,
  orderId: string,
): LinhaDoLancamento | undefined {
  return getConnection()
    .prepare(
      `SELECT id, amount_cents, settled_cents, cancelled_at
         FROM core_finance_entries
        WHERE company_id = ? AND origin_type = ? AND origin_id = ? AND direction = 'out'`,
    )
    .get(companyId, ORIGEM_DO_REEMBOLSO, orderId) as unknown as LinhaDoLancamento | undefined;
}

/**
 * Lança (ou quita) a contrapartida do reembolso. Deve ser chamada DENTRO da
 * transação que marca o pedido reembolsado — a saída nasce ou morre junto.
 */
export function lancarContrapartidaDoReembolso(input: {
  companyId: string;
  orderId: string;
  situacao: SituacaoDoDinheiro;
  /** Meio pelo qual o dinheiro voltou (o da cobrança). Vai na baixa. */
  metodo?: string | null;
  userId?: string | null;
}): ContrapartidaDoReembolso {
  const db = getConnection();

  const existente = contrapartidaDoPedido(input.companyId, input.orderId);
  if (existente) {
    const saldo = Number(existente.amount_cents) - Number(existente.settled_cents ?? 0);
    // O provedor confirmou DEPOIS um estorno que tinha ficado a pagar (a
    // chamada ao provedor falhou e alguém estornou pelo painel dele): a conta
    // a pagar ao cliente se quita aqui, uma vez.
    if (input.situacao === 'devolvido_pelo_provedor' && saldo > 0 && !existente.cancelled_at) {
      settleEntry({
        companyId: input.companyId,
        entryId: existente.id,
        amountCents: saldo,
        method: input.metodo ?? null,
        note: 'Estorno confirmado pelo provedor de pagamento.',
        userId: input.userId ?? null,
      });
      return { entryId: existente.id, amountCents: Number(existente.amount_cents), quitada: true };
    }
    return {
      entryId: existente.id,
      amountCents: Number(existente.amount_cents),
      quitada: saldo <= 0,
    };
  }

  // A receita que este reembolso contrapõe. Sem ela, não há contrapartida.
  const receita = db
    .prepare(
      `SELECT e.amount_cents, e.customer_id, o.number
         FROM core_finance_entries e
         JOIN core_orders o ON o.id = e.origin_id
        WHERE e.company_id = ? AND e.origin_type = 'ecommerce_order' AND e.origin_id = ?
          AND e.direction = 'in' AND e.cancelled_at IS NULL`,
    )
    .get(input.companyId, input.orderId) as
    | { amount_cents: number; customer_id: string | null; number: number }
    | undefined;
  if (!receita || Number(receita.amount_cents) <= 0) {
    return { entryId: null, amountCents: 0, quitada: false };
  }

  const valor = Number(receita.amount_cents);
  const quitada = input.situacao === 'devolvido_pelo_provedor';
  const agora = new Date().toISOString();
  const dia = diaDaLoja(agora);
  const id = randomUUID();
  const inserido = db
    .prepare(
      `INSERT INTO core_finance_entries
         (id, company_id, direction, amount_cents, status, due_date, settled_at,
          settled_cents, customer_id, description, origin_type, origin_id,
          category_id, competence_date, created_at)
       VALUES (?, ?, 'out', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (origin_type, origin_id, direction, installment_number) DO NOTHING`,
    )
    .run(
      id,
      input.companyId,
      valor,
      quitada ? 'settled' : 'open',
      dia,
      quitada ? agora : null,
      quitada ? valor : 0,
      receita.customer_id,
      quitada
        ? `Reembolso do pedido online #${receita.number}`
        : `Reembolso a pagar ao cliente — pedido online #${receita.number}`,
      ORIGEM_DO_REEMBOLSO,
      input.orderId,
      systemCategoryId(input.companyId, 'devolucao'),
      dia,
      agora,
    );
  if (Number(inserido.changes) === 0) {
    // Corrida perdida para outro escritor na mesma transação lógica: vale o dele.
    const vencedor = contrapartidaDoPedido(input.companyId, input.orderId)!;
    return {
      entryId: vencedor.id,
      amountCents: Number(vencedor.amount_cents),
      quitada: Number(vencedor.settled_cents) >= Number(vencedor.amount_cents),
    };
  }

  // O que nasce quitado nasce com a baixa (V29): sem ela, a conciliação
  // bancária não enxerga o dinheiro que saiu.
  if (quitada) {
    inserirBaixaEspelho({
      companyId: input.companyId,
      entryId: id,
      amountCents: valor,
      method: input.metodo ?? null,
      settledAt: agora,
      userId: input.userId ?? null,
      note: 'Estorno devolvido pelo provedor de pagamento.',
    });
  }
  return { entryId: id, amountCents: valor, quitada };
}
