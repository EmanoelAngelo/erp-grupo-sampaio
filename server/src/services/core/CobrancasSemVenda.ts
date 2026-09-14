/**
 * ============================================================================
 * COBRANÇAS SEM VENDA — o PIX abandonado e pago depois (GAP-PRD-078)
 * ============================================================================
 *
 * ## O que acontecia
 *
 * "Desistir desta cobrança" só limpava a tela do PDV. O PIX continuava de pé
 * no aparelho; o cliente pagava depois, e a cobrança virava APROVADA SEM
 * VENDA — fora de qualquer fila, porque `/pdv/terminal/uncertain` só mostra o
 * não confirmado. A loja recebia e não sabia, ou cobrava por outro meio e
 * recebia duas vezes.
 *
 * ## O que passa a existir
 *
 * - O balcão DESISTE de verdade: `desistirDaCobranca` pede o cancelamento ao
 *   provedor (o mesmo caminho do módulo, com a resposta dele, nunca a
 *   ausência dela). Só da cobrança que o próprio operador fez; a do colega é
 *   do gestor.
 * - A FILA do gestor (`listarPendenciasDaMaquininha`): cobranças em andamento
 *   ou aprovadas, sem venda, há mais de N minutos — e, ao lado, os estornos a
 *   fazer de vendas desfeitas (GAP-PRD-080).
 * - Três saídas para cada cobrança sem venda, todas com motivo, histórico e
 *   auditoria: cancelar/estornar na operadora (rotas do módulo), AMARRAR à
 *   venda que ela pagou (`vincularCobrancaAVenda`) ou REGISTRAR a tratativa
 *   (`registrarTratativa` — o dinheiro foi resolvido por fora, e alguém diz
 *   como).
 *
 * O prazo (`minutos`) existe para a fila não listar o PIX que está na tela do
 * operador AGORA: a cobrança que acabou de nascer ainda tem dono.
 */
import { randomUUID } from 'node:crypto';
import { findOneRow, findRows, insertRow } from '../../db/database.js';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ApiError } from '../../utils/errors.js';
import { recordAudit } from '../audit/AuditService.js';
import { cancelPaymentTerminalTransactionBackend } from '../payment-terminal/PaymentTerminalService.js';
import { gravarNaCobranca } from '../payment-terminal/PaymentTerminalTransactionEffects.js';
import {
  expirarComandosVencidos,
  operacaoPendenteNoAgente,
} from '../payment-terminal/PaymentTerminalAgentChannel.js';
import { bindTerminalTransactionToSale, vistaDaCobranca, type TerminalPaymentResult } from './PdvTerminalService.js';
import type { PedidoDeEstorno } from './EstornoNaMaquininha.js';
import { emReais } from './Money.js';

type Linha = Record<string, unknown>;

/** A cobrança mais nova que isto ainda está na mão do operador. */
export const MINUTOS_SEM_VENDA_PADRAO = 10;

/** Perfis que decidem pelo dinheiro da maquininha (os mesmos da conferência). */
const GESTORES = new Set(['gerente_loja', 'gerente_oficina', 'admin_geral', 'gestor']);

/** O que o balcão chama de método × o que o domínio de terminal grava. */
const METODO_NA_VENDA: Record<string, string> = { credit: 'credito', debit: 'debito', pix: 'pix' };

export interface CobrancaNaFila extends TerminalPaymentResult {
  provider: string | null;
  startedAt: string | null;
  idadeMinutos: number;
  createdBy: string | null;
  pdvTerminalId: string | null;
  cashSessionId: string | null;
  saleId: string | null;
  saleNumber: number | null;
  refundedAmountInCents: number;
  aEstornarCents: number;
  /** O último pedido de estorno da venda desfeita (origem, documento, motivo). */
  ultimoPedido: PedidoDeEstorno | null;
  /** Há cancelamento/estorno esperando o agente local responder. */
  pedidoNoAgente: boolean;
}

function cobrancaOu404(companyId: string, transactionId: string): Linha {
  const tx = findOneRow<Linha>(
    'payment_terminal_transactions',
    (r) => r.id === transactionId && r.companyId === companyId,
  );
  if (!tx) throw new ApiError('CORE_TERMINAL_TX_NOT_FOUND', 'Transação não encontrada.', 404);
  return tx;
}

function inicioDe(row: Linha): string | null {
  return (row.startedAt as string | undefined) ?? (row.createdAt as string | undefined) ?? null;
}

function naFila(row: Linha, agora: number): CobrancaNaFila {
  const inicio = inicioDe(row);
  const pedidos = Array.isArray(row.estornosPedidos) ? (row.estornosPedidos as PedidoDeEstorno[]) : [];
  return {
    ...vistaDaCobranca(row),
    provider: (row.provider as string | undefined) ?? null,
    startedAt: inicio,
    idadeMinutos: inicio ? Math.max(0, Math.floor((agora - Date.parse(inicio)) / 60_000)) : 0,
    createdBy: (row.createdBy as string | undefined) ?? null,
    pdvTerminalId: (row.pdvTerminalId as string | null | undefined) ?? null,
    cashSessionId: (row.cashSessionId as string | null | undefined) ?? null,
    saleId: (row.saleId as string | null | undefined) ?? null,
    saleNumber: (row.saleNumber as number | null | undefined) ?? null,
    refundedAmountInCents: Number(row.refundedAmountInCents ?? 0),
    aEstornarCents: Number(row.aEstornarCents ?? 0),
    ultimoPedido: pedidos[pedidos.length - 1] ?? null,
    pedidoNoAgente: false,
  };
}

/** É dinheiro sem dono? Em andamento ou aprovada, sem venda, sem tratativa. */
function ehSemVenda(row: Linha): boolean {
  if (row.saleId || row.semVendaTratadaAt) return false;
  const vista = vistaDaCobranca(row);
  // A não confirmada tem fila própria (`/pdv/terminal/uncertain`): lá o
  // gestor diz primeiro SE foi paga. Aprovada pela conciliação, cai aqui.
  if (vista.needsReconciliation) return false;
  return vista.settled || vista.pending === true;
}

export function listarPendenciasDaMaquininha(
  companyId: string,
  opcoes: { minutos?: number; agora?: Date } = {},
): { minutos: number; semVenda: CobrancaNaFila[]; aEstornar: CobrancaNaFila[] } {
  expirarComandosVencidos(companyId);
  const minutos = Number.isFinite(opcoes.minutos) && (opcoes.minutos as number) >= 0
    ? Math.floor(opcoes.minutos as number)
    : MINUTOS_SEM_VENDA_PADRAO;
  const agora = (opcoes.agora ?? new Date()).getTime();
  const rows = findRows<Linha>('payment_terminal_transactions', (r) => r.companyId === companyId);

  const semVenda = rows
    .filter(ehSemVenda)
    .filter((r) => {
      const inicio = inicioDe(r);
      return !inicio || agora - Date.parse(inicio) >= minutos * 60_000;
    })
    .map((r) => naFila(r, agora));

  const aEstornar = rows
    .filter((r) => Number(r.aEstornarCents ?? 0) > 0)
    .map((r) => ({
      ...naFila(r, agora),
      pedidoNoAgente: operacaoPendenteNoAgente(companyId, String(r.id)) !== null,
    }));

  const maisAntigaPrimeiro = (a: CobrancaNaFila, b: CobrancaNaFila) =>
    String(a.startedAt ?? '').localeCompare(String(b.startedAt ?? ''));
  return { minutos, semVenda: semVenda.sort(maisAntigaPrimeiro), aEstornar: aEstornar.sort(maisAntigaPrimeiro) };
}

/**
 * O balcão desiste da cobrança — e o provedor fica sabendo.
 *
 * O operador desiste da cobrança que ELE fez (o PIX que o cliente não pagou,
 * o cartão aprovado que ele tirou da venda). A de outro operador é do gestor:
 * cancelar a cobrança do colega é mexer no dinheiro do caixa ao lado.
 *
 * Quem decide o que acontece é o caminho do módulo
 * (`cancelPaymentTerminalTransactionBackend`): o estado só muda com a
 * confirmação do provedor; cobrança ainda no PinPad é "cancele no aparelho";
 * cobrança amarrada a venda é "desfaça a venda".
 */
export async function desistirDaCobranca(input: {
  companyId: string;
  userId: string;
  profiles: string[];
  transactionId: string;
  reason?: string | null;
}): Promise<TerminalPaymentResult & { queuedToAgent?: boolean }> {
  const tx = cobrancaOu404(input.companyId, input.transactionId);
  const gestor = input.profiles.some((p) => GESTORES.has(p));
  if (!gestor && tx.createdBy !== input.userId) {
    throw new ApiError(
      'CORE_TERMINAL_DESISTIR_NOT_OWNER',
      'Esta cobrança foi feita por outro operador. Peça ao gerente para tratá-la em Vendas › '
        + 'Conferência de maquininha.',
      403,
      { transactionId: input.transactionId },
    );
  }
  const motivo = String(input.reason ?? '').trim() || 'Desistência no balcão, antes de fechar a venda.';
  const resposta = await cancelPaymentTerminalTransactionBackend({
    companyId: input.companyId,
    userId: input.userId,
    transactionId: input.transactionId,
    reason: motivo,
  });
  recordAudit({
    companyId: input.companyId,
    userId: input.userId,
    action: 'pdv.terminal.desistencia',
    entityType: 'payment_terminal_transaction',
    entityId: input.transactionId,
    detail: { reason: motivo, queuedToAgent: resposta.queuedToAgent === true, byManager: gestor && tx.createdBy !== input.userId },
  });
  if (resposta.queuedToAgent) {
    return {
      ...vistaDaCobranca(cobrancaOu404(input.companyId, input.transactionId)),
      queuedToAgent: true,
      message: String(resposta.message ?? 'Pedido de cancelamento enviado ao aparelho.'),
    };
  }
  return vistaDaCobranca(resposta);
}

/**
 * O gestor registra o que foi feito com a cobrança sem venda.
 *
 * Para quando o dinheiro já se resolveu por fora — o cliente recebeu o PIX de
 * volta pelo banco, a venda foi refeita no aparelho avulso — e a cobrança só
 * precisa sair da fila COM a explicação. A cobrança continua como está no
 * provedor; o que muda é que ela deixa de ser dinheiro sem dono.
 */
export function registrarTratativa(input: {
  companyId: string;
  userId: string;
  transactionId: string;
  reason: string;
}): TerminalPaymentResult {
  const tx = cobrancaOu404(input.companyId, input.transactionId);
  const motivo = String(input.reason ?? '').trim();
  if (motivo.length < 3) {
    throw new ApiError(
      'CORE_TERMINAL_REASON_REQUIRED',
      'Diga o que foi feito com esta cobrança — fica na auditoria com o seu nome.',
      400,
    );
  }
  if (!ehSemVenda(tx)) {
    throw new ApiError(
      'CORE_TERMINAL_NOT_WITHOUT_SALE',
      `Esta cobrança não é uma cobrança sem venda (está "${vistaDaCobranca(tx).state}"`
        + `${tx.saleId ? ', amarrada a uma venda' : ''}).`,
      409,
      { transactionId: input.transactionId },
    );
  }
  const agora = new Date().toISOString();
  const final = withTransaction(() => {
    const gravada = gravarNaCobranca(input.companyId, input.transactionId, {
      semVendaTratadaAt: agora,
      semVendaTratadaPor: input.userId,
      semVendaMotivo: motivo,
    });
    insertRow('payment_terminal_history', {
      id: `pthist-${randomUUID()}`,
      companyId: input.companyId,
      transactionId: input.transactionId,
      action: 'without_sale_handled',
      reason: motivo,
      userId: input.userId,
      createdAt: agora,
    });
    recordAudit({
      companyId: input.companyId,
      userId: input.userId,
      action: 'pdv.terminal.sem_venda.tratada',
      entityType: 'payment_terminal_transaction',
      entityId: input.transactionId,
      detail: {
        reason: motivo,
        state: vistaDaCobranca(tx).state,
        amountInCents: Number(tx.amountInCents ?? 0),
      },
    });
    return gravada;
  });
  return vistaDaCobranca(final);
}

/**
 * O gestor amarra a cobrança aprovada à venda que ela pagou.
 *
 * O caso real: a maquininha caiu (ou foi desligada) no meio do atendimento, a
 * venda saiu com o cartão/PIX lançado à mão, e a cobrança aprovada ficou
 * sozinha. A venda precisa ter uma linha do MESMO meio e do MESMO valor,
 * liquidada e ainda sem cobrança apontada — senão amarrar faria uma linha
 * valer por duas cobranças, ou uma cobrança pagar o que não pagou.
 */
export function vincularCobrancaAVenda(input: {
  companyId: string;
  userId: string;
  transactionId: string;
  /** A venda pelo id — ou pelo número, que é o que o gestor tem no comprovante. */
  saleId?: string | null;
  saleNumber?: number | null;
  reason: string;
}): TerminalPaymentResult & { saleId: string; saleNumber: number } {
  const tx = cobrancaOu404(input.companyId, input.transactionId);
  const db = getConnection();
  const venda = (
    input.saleId
      ? db
        .prepare('SELECT id, number, status FROM core_sales WHERE id = ? AND company_id = ?')
        .get(String(input.saleId), input.companyId)
      : Number.isInteger(input.saleNumber)
        ? db
          .prepare('SELECT id, number, status FROM core_sales WHERE number = ? AND company_id = ?')
          .get(Number(input.saleNumber), input.companyId)
        : undefined
  ) as { id: string; number: number; status: string } | undefined;
  if (!venda) throw new ApiError('CORE_SALE_NOT_FOUND', 'Venda não encontrada nesta operação.', 404);

  const vista = vistaDaCobranca(tx);
  if (tx.saleId) {
    throw new ApiError(
      'CORE_SALE_TERMINAL_TX_ALREADY_USED',
      'Esta cobrança já está amarrada a uma venda.',
      409,
      { transactionId: input.transactionId, saleId: tx.saleId },
    );
  }
  if (!vista.settled) {
    throw new ApiError(
      'CORE_SALE_TERMINAL_TX_NOT_APPROVED',
      `Só cobrança aprovada paga venda — esta está "${vista.state}".`,
      409,
      { transactionId: input.transactionId, state: vista.state },
    );
  }
  if (venda.status !== 'completed') {
    throw new ApiError(
      'CORE_SALE_NOT_COMPLETED',
      `A venda #${venda.number} está "${venda.status}": cobrança se amarra a venda concluída.`,
      409,
      { saleId: venda.id },
    );
  }

  const metodo = METODO_NA_VENDA[String(tx.paymentMethod ?? '')] ?? String(tx.paymentMethod ?? '');
  const valor = Number(tx.amountInCents ?? 0);
  const linhas = db
    .prepare(
      `SELECT id, method, amount_cents, status, provider_ref
         FROM core_sale_payments WHERE sale_id = ? AND company_id = ?`,
    )
    .all(venda.id, input.companyId) as unknown as {
    id: string;
    method: string;
    amount_cents: number;
    status: string | null;
    provider_ref: string | null;
  }[];
  const linha = linhas.find(
    (l) => l.method === metodo && l.amount_cents === valor && (l.status ?? 'settled') === 'settled' && !l.provider_ref,
  );
  if (!linha) {
    throw new ApiError(
      'CORE_TERMINAL_BIND_NO_MATCHING_LINE',
      `A venda #${venda.number} não tem uma linha de ${metodo} de ${emReais(valor)} liquidada e sem cobrança `
        + 'apontada. Só se amarra a cobrança à linha que ela pagou.',
      409,
      {
        transactionId: input.transactionId,
        saleId: venda.id,
        linhas: linhas.map((l) => ({ method: l.method, amountCents: l.amount_cents, status: l.status, comCobranca: Boolean(l.provider_ref) })),
      },
    );
  }
  const motivo = String(input.reason ?? '').trim();
  if (!motivo) {
    throw new ApiError('CORE_TERMINAL_REASON_REQUIRED', 'Diga como você conferiu que esta cobrança pagou esta venda.', 400);
  }

  const agora = new Date().toISOString();
  withTransaction(() => {
    db.prepare(
      'UPDATE core_sale_payments SET provider_ref = ?, provider = COALESCE(provider, ?) WHERE id = ? AND company_id = ?',
    ).run(input.transactionId, (tx.provider as string | undefined) ?? null, linha.id, input.companyId);
    bindTerminalTransactionToSale({
      companyId: input.companyId,
      transactionId: input.transactionId,
      saleId: venda.id,
      saleNumber: venda.number,
    });
    gravarNaCobranca(input.companyId, input.transactionId, {
      vinculadaPor: input.userId,
      vinculadaEm: agora,
      vinculoMotivo: motivo,
    });
    insertRow('payment_terminal_history', {
      id: `pthist-${randomUUID()}`,
      companyId: input.companyId,
      transactionId: input.transactionId,
      action: 'bound_to_sale_by_manager',
      saleId: venda.id,
      saleNumber: venda.number,
      reason: motivo,
      userId: input.userId,
      createdAt: agora,
    });
    recordAudit({
      companyId: input.companyId,
      userId: input.userId,
      action: 'pdv.terminal.sem_venda.vinculada',
      entityType: 'payment_terminal_transaction',
      entityId: input.transactionId,
      detail: { saleId: venda.id, saleNumber: venda.number, paymentId: linha.id, reason: motivo },
    });
  });
  return {
    ...vistaDaCobranca(cobrancaOu404(input.companyId, input.transactionId)),
    saleId: venda.id,
    saleNumber: venda.number,
  };
}
