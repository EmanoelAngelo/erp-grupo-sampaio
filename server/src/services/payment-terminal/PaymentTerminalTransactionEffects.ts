/**
 * O que muda numa cobrança de maquininha quando alguém de fora responde.
 *
 * "Alguém de fora" são dois caminhos: o adaptador chamado na hora (o mock) e
 * o agente local que responde depois, pela fila (GAP-PRD-014). Os dois têm de
 * gravar EXATAMENTE a mesma coisa — o estado, o comprovante, o cancelamento, o
 * estorno, o histórico e a auditoria. Se cada caminho escrevesse do seu jeito,
 * o relatório de maquininha contaria diferente a mesma operação conforme o
 * aparelho que a fez. Por isso as escritas moram aqui, num lugar só, e
 * `PaymentTerminalService` (o caminho síncrono) e `PaymentTerminalAgentChannel`
 * (o caminho da fila) chamam as mesmas funções.
 */
import { randomUUID } from 'node:crypto';
import { findOneRow, findRowsDaEmpresa, insertRow, updateRows } from '../../db/database.js';
import { withTransaction } from '../../db/sqlite.js';
import { ApiError } from '../../utils/errors.js';
import { recordAudit } from '../audit/AuditService.js';

type Linha = Record<string, unknown>;

/** Grava na transação DESTA empresa e devolve a linha como ficou. */
export function gravarNaCobranca(companyId: string, id: string, patch: Linha): Linha {
  updateRows<Linha>(
    'payment_terminal_transactions',
    (r) => r.id === id && r.companyId === companyId,
    (r) => ({ ...r, ...patch, updatedAt: new Date().toISOString() }),
  );
  const linha = findOneRow<Linha>(
    'payment_terminal_transactions',
    (r) => r.id === id && r.companyId === companyId,
  );
  if (!linha) {
    throw new ApiError('PAYMENT_TERMINAL_TRANSACTION_NOT_FOUND', 'Transação não encontrada.', 404);
  }
  return linha;
}

/**
 * A resposta chegou DEPOIS de alguém ter decidido pela cobrança.
 *
 * O que gente decidiu olhando o extrato não é sobrescrito pela máquina: a
 * resposta tardia fica no histórico, para a conferência ver se as duas coisas
 * batem.
 */
export function respostaAtrasada(atual: Linha, statusDoProvedor: string, origem = 'provider'): Linha {
  insertRow('payment_terminal_history', {
    id: `pthist-${randomUUID()}`,
    companyId: atual.companyId,
    transactionId: atual.id,
    action: origem === 'agent' ? 'late_agent_answer' : 'late_provider_answer',
    providerStatus: statusDoProvedor,
    currentStatus: atual.status ?? null,
    createdAt: new Date().toISOString(),
  });
  return atual;
}

/**
 * Guarda o comprovante que a adquirente devolveu (GAP-PRD-162).
 *
 * Comprovante é o que a operadora disse no momento da cobrança — ou ele é
 * guardado agora, ou não existe depois.
 */
export function guardarComprovante(
  tx: Linha,
  result: { receiptText?: string | null; customerReceiptText?: string | null; simulated?: boolean },
): void {
  if (!result.receiptText && !result.customerReceiptText) return;
  const ja = findOneRow<Linha>(
    'payment_terminal_receipts',
    (r) => r.transactionId === tx.id && r.companyId === tx.companyId,
  );
  // Uma cobrança, um comprovante: o agente que repete o resultado (rede caiu
  // antes da resposta dele) não gera segunda via fantasma.
  if (ja) return;
  insertRow('payment_terminal_receipts', {
    id: `ptrcp-${randomUUID()}`,
    companyId: tx.companyId,
    transactionId: tx.id,
    provider: tx.provider,
    simulated: result.simulated === true,
    merchantReceiptText: result.receiptText ?? null,
    customerReceiptText: result.customerReceiptText ?? null,
    reprintCount: 0,
    createdAt: new Date().toISOString(),
  });
}

/** Cada pedido de cancelamento/estorno fica registrado — inclusive o que não deu em nada. */
export function registrarTentativa(
  operacao: 'cancel' | 'refund',
  input: {
    companyId: string;
    transactionId: string;
    provider: unknown;
    outcome: string;
    reason: string;
    requestedBy: string | null;
    amountInCents?: number;
    providerMessage?: string | null;
    simulated?: boolean;
    commandId?: string | null;
  },
): void {
  insertRow(operacao === 'cancel' ? 'payment_terminal_cancellations' : 'payment_terminal_refunds', {
    id: `${operacao === 'cancel' ? 'ptcan' : 'ptref'}-${randomUUID()}`,
    companyId: input.companyId,
    transactionId: input.transactionId,
    provider: input.provider,
    ...(operacao === 'refund' ? { amountInCents: input.amountInCents ?? null } : {}),
    outcome: input.outcome,
    reason: input.reason,
    requestedBy: input.requestedBy,
    requestedAt: new Date().toISOString(),
    providerMessage: input.providerMessage ?? null,
    simulated: input.simulated === true,
    commandId: input.commandId ?? null,
  });
}

/** O último pedido de cancelamento/estorno de uma cobrança, como a tela o lê. */
export interface UltimoPedido {
  operacao: 'cancel' | 'refund';
  outcome: string;
  reason: string | null;
  requestedAt: string | null;
  providerMessage: string | null;
  amountInCents: number | null;
}

/**
 * O LEITOR DOS PEDIDOS (GAP-PRD-075).
 *
 * `registrarTentativa` grava cada pedido — inclusive o que a operadora não
 * confirmou e o que o agente nunca retirou —, e nada o lia: a lista de
 * cobranças mostrava a cobrança como se ninguém tivesse pedido nada, e o
 * "alguém pediu, e a operadora não respondeu" que o registro existe para
 * contar morria no banco. Aqui, por cobrança, o mais recente dos dois tipos,
 * SÓ da empresa pedida (o filtro é o da coluna, no SQL).
 */
export function ultimosPedidosDaEmpresa(companyId: string): Map<string, UltimoPedido> {
  const mapa = new Map<string, UltimoPedido>();
  const pedidos = [
    ...findRowsDaEmpresa<Linha>('payment_terminal_cancellations', companyId).map((r) => ({ r, operacao: 'cancel' as const })),
    ...findRowsDaEmpresa<Linha>('payment_terminal_refunds', companyId).map((r) => ({ r, operacao: 'refund' as const })),
  ];
  for (const { r, operacao } of pedidos) {
    const cobranca = typeof r.transactionId === 'string' ? r.transactionId : '';
    if (!cobranca) continue;
    const quando = typeof r.requestedAt === 'string' ? r.requestedAt : null;
    const atual = mapa.get(cobranca);
    if (atual && String(atual.requestedAt ?? '') > String(quando ?? '')) continue;
    mapa.set(cobranca, {
      operacao,
      outcome: String(r.outcome ?? ''),
      reason: typeof r.reason === 'string' ? r.reason : null,
      requestedAt: quando,
      providerMessage: typeof r.providerMessage === 'string' ? r.providerMessage : null,
      amountInCents: typeof r.amountInCents === 'number' ? r.amountInCents : null,
    });
  }
  return mapa;
}

/**
 * Quem confirmou: o adaptador chamado na hora, o agente local pela fila — ou
 * um gestor que conferiu o estorno feito no próprio aparelho (`manual`,
 * GAP-PRD-080), como a conciliação pelo extrato faz com a cobrança.
 */
export type ViaDaConfirmacao = 'provider' | 'agent' | 'manual';

/** O provedor CONFIRMOU o cancelamento: agora, e só agora, o estado muda. */
export function aplicarCancelamentoConfirmado(input: {
  companyId: string;
  transactionId: string;
  userId: string | null;
  reason: string;
  simulated: boolean;
  via?: ViaDaConfirmacao;
}): Linha {
  const agora = new Date().toISOString();
  return withTransaction(() => {
    const atual = findOneRow<Linha>(
      'payment_terminal_transactions',
      (r) => r.id === input.transactionId && r.companyId === input.companyId,
    );
    if (!atual) {
      throw new ApiError('PAYMENT_TERMINAL_TRANSACTION_NOT_FOUND', 'Transação não encontrada.', 404);
    }
    const final = gravarNaCobranca(input.companyId, input.transactionId, {
      // Cancelada inteira: nada mais a estornar (GAP-PRD-080).
      ...(Number(atual.aEstornarCents ?? 0) > 0 ? { aEstornarCents: 0 } : {}),
      status: 'cancelled',
      previousStatus: atual.status ?? null,
      cancelledAt: agora,
      cancelledBy: input.userId,
      cancellationReason: input.reason,
      cancellationSimulated: input.simulated,
      cancellationVia: input.via ?? 'provider',
    });
    insertRow('payment_terminal_history', {
      id: `pthist-${randomUUID()}`,
      companyId: input.companyId,
      transactionId: input.transactionId,
      action: 'transaction_cancelled',
      reason: input.reason,
      userId: input.userId,
      via: input.via ?? 'provider',
      createdAt: agora,
    });
    recordAudit({
      companyId: input.companyId,
      userId: input.userId,
      action: 'payment_terminal.transaction.cancelled',
      entityType: 'payment_terminal_transaction',
      entityId: input.transactionId,
      detail: {
        previousStatus: atual.status ?? null,
        reason: input.reason,
        simulated: input.simulated,
        via: input.via ?? 'provider',
      },
    });
    return final;
  });
}

/** O provedor CONFIRMOU o estorno de `amountInCents`. */
export function aplicarEstornoConfirmado(input: {
  companyId: string;
  transactionId: string;
  userId: string | null;
  reason: string;
  amountInCents: number;
  simulated: boolean;
  via?: ViaDaConfirmacao;
}): Linha {
  const agora = new Date().toISOString();
  return withTransaction(() => {
    const atual = findOneRow<Linha>(
      'payment_terminal_transactions',
      (r) => r.id === input.transactionId && r.companyId === input.companyId,
    );
    if (!atual) {
      throw new ApiError('PAYMENT_TERMINAL_TRANSACTION_NOT_FOUND', 'Transação não encontrada.', 404);
    }
    const total = Number(atual.amountInCents ?? 0);
    const estornado = Number(atual.refundedAmountInCents ?? 0) + input.amountInCents;
    const aEstornar = Number(atual.aEstornarCents ?? 0);
    const final = gravarNaCobranca(input.companyId, input.transactionId, {
      // O estorno pedido pelo cancelamento/devolução da venda (GAP-PRD-080)
      // baixa do "a estornar" pelo valor que a operadora confirmou.
      ...(aEstornar > 0 ? { aEstornarCents: Math.max(0, aEstornar - input.amountInCents) } : {}),
      status: estornado >= total ? 'refunded' : 'partially_refunded',
      previousStatus: atual.status ?? null,
      refundedAt: agora,
      refundedBy: input.userId,
      refundReason: input.reason,
      refundedAmountInCents: estornado,
      refundSimulated: input.simulated,
      refundVia: input.via ?? 'provider',
    });
    insertRow('payment_terminal_history', {
      id: `pthist-${randomUUID()}`,
      companyId: input.companyId,
      transactionId: input.transactionId,
      action: 'transaction_refunded',
      amountInCents: input.amountInCents,
      reason: input.reason,
      userId: input.userId,
      via: input.via ?? 'provider',
      createdAt: agora,
    });
    recordAudit({
      companyId: input.companyId,
      userId: input.userId,
      action: 'payment_terminal.transaction.refunded',
      entityType: 'payment_terminal_transaction',
      entityId: input.transactionId,
      detail: {
        amountInCents: input.amountInCents,
        refundedTotal: estornado,
        reason: input.reason,
        simulated: input.simulated,
        via: input.via ?? 'provider',
      },
    });
    return final;
  });
}
