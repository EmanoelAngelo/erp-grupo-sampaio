/**
 * ============================================================================
 * A VENDA DESFEITA DESFAZ A COBRANÇA DA MAQUININHA (GAP-PRD-080)
 * ============================================================================
 *
 * ## O que acontecia
 *
 * `cancelSale` desfazia estoque, comissão, fidelidade, crédito, financeiro e
 * gaveta — e não tocava na cobrança da maquininha. A devolução "estorno no
 * cartão" gravava o documento com o comentário "volta pela operadora" e
 * também não. A cobrança ficava `authorized`, amarrada a uma venda cancelada,
 * sem estorno pedido e sem rastro: a conferência de maquininha deixava de
 * bater com as vendas, e o estorno dependia de alguém lembrar de fazê-lo no
 * aparelho.
 *
 * ## O que passa a acontecer — em dois tempos
 *
 * 1. DENTRO da transação da venda (`marcarCobrancasAEstornar`): cada cobrança
 *    que pagou a venda recebe o valor "a estornar" (`aEstornarCents`) e o
 *    pedido (origem, documento, quem, por quê). É dado, não chamada de rede:
 *    se o cancelamento/devolução falhar, a marca volta atrás junto.
 *
 * 2. DEPOIS do commit (`executarEstornosPendentes`): o estorno é pedido à
 *    operadora pelo caminho de sempre (`refundPaymentTerminalTransactionBackend`
 *    — mock na hora, agente local pela fila). O resultado de cada um volta
 *    para quem cancelou: estornado, enviado ao agente, ou PENDENTE com o
 *    motivo. Pendente não desfaz o cancelamento (a venda já não vale); fica na
 *    fila "Estornos a fazer" da Conferência de maquininha, onde o gestor pede
 *    de novo ou registra o estorno feito no próprio aparelho
 *    (`registrarEstornoManual`, com motivo e auditoria, como a conciliação
 *    pelo extrato).
 *
 * ## Devolução parcial no cartão
 *
 * O valor da devolução é distribuído pelas cobranças de cartão da venda, até o
 * que cada uma ainda pode estornar. Pedir no cartão MAIS do que o cartão
 * integrado pagou é recusado antes de gravar (409): o excedente foi pago por
 * outro meio e volta por outro meio. Venda sem cobrança integrada (maquininha
 * avulsa) segue como antes — o estorno é no aparelho, e a resposta diz isso.
 */
import { randomUUID } from 'node:crypto';
import { findOneRow, findRows, insertRow } from '../../db/database.js';
import { ApiError } from '../../utils/errors.js';
import { recordAudit } from '../audit/AuditService.js';
import { refundPaymentTerminalTransactionBackend } from '../payment-terminal/PaymentTerminalService.js';
import {
  aplicarEstornoConfirmado,
  gravarNaCobranca,
  registrarTentativa,
} from '../payment-terminal/PaymentTerminalTransactionEffects.js';
import { operacaoPendenteNoAgente } from '../payment-terminal/PaymentTerminalAgentChannel.js';
import { vistaDaCobranca, type TerminalPaymentResult } from './PdvTerminalService.js';
import { emReais } from './Money.js';

type Linha = Record<string, unknown>;

/** De onde se estorna: o que foi pago e ainda não voltou inteiro. */
const ESTORNAVEIS = new Set(['authorized', 'confirmed', 'partially_refunded']);
const DE_CARTAO = new Set(['credit', 'debit']);

export interface PedidoDeEstorno {
  origem: 'cancelamento' | 'devolucao';
  referenciaId: string;
  amountInCents: number;
  requestedAt: string;
  requestedBy: string;
  reason: string;
}

export interface EstornoNaMaquininha {
  transactionId: string;
  amountInCents: number;
  resultado: 'estornado' | 'enviado_ao_agente' | 'pendente';
  message: string;
  code?: string;
}

/** O que esta cobrança ainda pode receber de pedido de estorno. */
function disponivel(tx: Linha): number {
  return Math.max(
    0,
    Number(tx.amountInCents ?? 0) - Number(tx.refundedAmountInCents ?? 0) - Number(tx.aEstornarCents ?? 0),
  );
}

function cobrancasDaVenda(companyId: string, saleId: string): Linha[] {
  return findRows<Linha>(
    'payment_terminal_transactions',
    (r) => r.companyId === companyId && r.saleId === saleId,
  ).sort((a, b) => String(a.startedAt ?? '').localeCompare(String(b.startedAt ?? '')));
}

/**
 * Marca o que está a estornar. Roda DENTRO da transação da venda.
 *
 * `valorCents` nulo = tudo o que as cobranças da venda ainda podem estornar
 * (cancelamento). Com valor (devolução), só as cobranças de cartão entram, e
 * pedir mais do que elas podem é recusado.
 */
export function marcarCobrancasAEstornar(input: {
  companyId: string;
  saleId: string;
  saleNumber: number | null;
  userId: string;
  origem: 'cancelamento' | 'devolucao';
  referenciaId: string;
  motivo: string;
  valorCents: number | null;
}): { transactionId: string; amountInCents: number }[] {
  const todas = cobrancasDaVenda(input.companyId, input.saleId).filter((tx) =>
    ESTORNAVEIS.has(String(tx.status ?? '')),
  );
  const candidatas = input.valorCents === null
    ? todas
    : todas.filter((tx) => DE_CARTAO.has(String(tx.paymentMethod ?? '')));
  if (candidatas.length === 0) return [];

  const partes: { tx: Linha; valor: number }[] = [];
  if (input.valorCents === null) {
    for (const tx of candidatas) {
      const v = disponivel(tx);
      if (v > 0) partes.push({ tx, valor: v });
    }
  } else {
    const podeEstornar = candidatas.reduce((s, tx) => s + disponivel(tx), 0);
    if (input.valorCents > podeEstornar) {
      throw new ApiError(
        'CORE_RETURN_CARD_EXCEEDS_TERMINAL',
        `Esta venda tem ${emReais(podeEstornar)} no cartão pela maquininha integrada que ainda podem `
          + `ser estornados, e o estorno no cartão desta devolução seria de ${emReais(input.valorCents)}. `
          + 'O que passa disso foi pago por outro meio: devolva essa parte em dinheiro, PIX ou crédito.',
        409,
        { saleId: input.saleId, podeEstornarCents: podeEstornar, pedidoCents: input.valorCents },
      );
    }
    let falta = input.valorCents;
    for (const tx of candidatas) {
      if (falta <= 0) break;
      const v = Math.min(disponivel(tx), falta);
      if (v > 0) {
        partes.push({ tx, valor: v });
        falta -= v;
      }
    }
  }

  const agora = new Date().toISOString();
  return partes.map(({ tx, valor }) => {
    const pedido: PedidoDeEstorno = {
      origem: input.origem,
      referenciaId: input.referenciaId,
      amountInCents: valor,
      requestedAt: agora,
      requestedBy: input.userId,
      reason: input.motivo,
    };
    const anteriores = Array.isArray(tx.estornosPedidos) ? (tx.estornosPedidos as PedidoDeEstorno[]) : [];
    gravarNaCobranca(input.companyId, String(tx.id), {
      aEstornarCents: Number(tx.aEstornarCents ?? 0) + valor,
      estornosPedidos: [...anteriores, pedido],
    });
    insertRow('payment_terminal_history', {
      id: `pthist-${randomUUID()}`,
      companyId: input.companyId,
      transactionId: tx.id,
      action: 'refund_requested_by_sale',
      origem: input.origem,
      saleId: input.saleId,
      referenciaId: input.referenciaId,
      amountInCents: valor,
      reason: input.motivo,
      userId: input.userId,
      createdAt: agora,
    });
    recordAudit({
      companyId: input.companyId,
      userId: input.userId,
      action: 'pdv.terminal.estorno_a_fazer',
      entityType: 'payment_terminal_transaction',
      entityId: String(tx.id),
      detail: {
        saleId: input.saleId,
        saleNumber: input.saleNumber,
        origem: input.origem,
        referenciaId: input.referenciaId,
        amountInCents: valor,
        reason: input.motivo,
      },
    });
    return { transactionId: String(tx.id), amountInCents: valor };
  });
}

/**
 * Pede à operadora o que está a estornar. Roda DEPOIS do commit da venda.
 *
 * Nunca lança: o cancelamento/devolução já aconteceu, e o que não se
 * confirmou aqui fica "a estornar" na fila do gestor, com o motivo.
 */
export async function executarEstornosPendentes(input: {
  companyId: string;
  userId: string;
  saleId: string;
}): Promise<EstornoNaMaquininha[]> {
  const resultados: EstornoNaMaquininha[] = [];
  for (const tx of cobrancasDaVenda(input.companyId, input.saleId)) {
    const valor = Number(tx.aEstornarCents ?? 0);
    if (valor <= 0) continue;
    const pedidos = Array.isArray(tx.estornosPedidos) ? (tx.estornosPedidos as PedidoDeEstorno[]) : [];
    const motivo = pedidos[pedidos.length - 1]?.reason ?? 'Venda desfeita';
    try {
      const r = await refundPaymentTerminalTransactionBackend({
        companyId: input.companyId,
        userId: input.userId,
        transactionId: String(tx.id),
        amountInCents: valor,
        reason: motivo,
      });
      resultados.push(
        r.queuedToAgent
          ? {
              transactionId: String(tx.id),
              amountInCents: valor,
              resultado: 'enviado_ao_agente',
              message: String(r.message ?? 'Pedido de estorno enviado ao agente local.'),
            }
          : {
              transactionId: String(tx.id),
              amountInCents: valor,
              resultado: 'estornado',
              message: 'Estorno confirmado pela operadora.',
            },
      );
    } catch (err) {
      resultados.push({
        transactionId: String(tx.id),
        amountInCents: valor,
        resultado: 'pendente',
        code: err instanceof ApiError ? err.code : 'PAYMENT_TERMINAL_PROVIDER_ERROR',
        message:
          `${err instanceof Error ? err.message : String(err)} O estorno fica em Vendas › Conferência `
          + 'de maquininha › Estornos a fazer.',
      });
    }
  }
  return resultados;
}

/**
 * O gestor afirma que o estorno foi feito no próprio aparelho.
 *
 * É a conciliação do estorno: alguém olhou o comprovante do aparelho (ou o
 * extrato) e está dizendo que o dinheiro voltou ao cliente. Exige motivo, vai
 * para o histórico e para a auditoria com o nome de quem afirmou, e baixa o
 * "a estornar" pela mesma função que a resposta da operadora usa.
 */
export function registrarEstornoManual(input: {
  companyId: string;
  userId: string;
  transactionId: string;
  reason: string;
}): TerminalPaymentResult {
  const tx = findOneRow<Linha>(
    'payment_terminal_transactions',
    (r) => r.id === input.transactionId && r.companyId === input.companyId,
  );
  if (!tx) throw new ApiError('CORE_TERMINAL_TX_NOT_FOUND', 'Transação não encontrada.', 404);
  const aEstornar = Number(tx.aEstornarCents ?? 0);
  if (aEstornar <= 0) {
    throw new ApiError(
      'CORE_TERMINAL_NOTHING_TO_REFUND',
      'Esta cobrança não tem estorno a fazer: só o estorno pedido por cancelamento ou devolução de venda '
        + 'é registrado aqui.',
      409,
      { transactionId: input.transactionId },
    );
  }
  const motivo = String(input.reason ?? '').trim();
  if (motivo.length < 3) {
    throw new ApiError(
      'CORE_TERMINAL_REASON_REQUIRED',
      'Diga como o estorno foi feito (ex.: "estornado no aparelho, NSU 123456").',
      400,
    );
  }
  const noAgente = operacaoPendenteNoAgente(input.companyId, input.transactionId);
  if (noAgente) {
    throw new ApiError(
      'PAYMENT_TERMINAL_OPERATION_IN_PROGRESS',
      'O estorno desta cobrança está esperando o agente local. Aguarde a resposta do aparelho.',
      409,
      { transactionId: input.transactionId, commandId: noAgente.id },
    );
  }
  const restante = Number(tx.amountInCents ?? 0) - Number(tx.refundedAmountInCents ?? 0);
  const valor = Math.min(aEstornar, restante);
  registrarTentativa('refund', {
    companyId: input.companyId,
    transactionId: input.transactionId,
    provider: tx.provider,
    outcome: 'confirmed_manually',
    reason: motivo,
    requestedBy: input.userId,
    amountInCents: valor,
  });
  const final = aplicarEstornoConfirmado({
    companyId: input.companyId,
    transactionId: input.transactionId,
    userId: input.userId,
    reason: motivo,
    amountInCents: valor,
    simulated: false,
    via: 'manual',
  });
  recordAudit({
    companyId: input.companyId,
    userId: input.userId,
    action: 'pdv.terminal.estorno_manual',
    entityType: 'payment_terminal_transaction',
    entityId: input.transactionId,
    detail: { amountInCents: valor, reason: motivo, saleId: tx.saleId ?? null },
  });
  return vistaDaCobranca(final);
}
