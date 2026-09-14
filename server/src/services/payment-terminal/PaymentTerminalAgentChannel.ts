/**
 * A FILA DE COMANDOS DO AGENTE LOCAL — o canal PDV → agente → PinPad (GAP-PRD-014).
 *
 * ## O que faltava
 *
 * O agente local pareava e mandava "estou vivo", e nada mais: não existia de
 * onde ele tirasse a cobrança nem para onde devolvesse o resultado. Se o dono
 * instalasse amanhã um PinPad com o cliente TEF da adquirente, o balcão não
 * teria como pedir a cobrança.
 *
 * ## Como funciona
 *
 *   PDV ──POST /core/pdv/terminal/charge──▶ servidor grava a cobrança
 *                                            `in_progress` + comando `startPayment`
 *   agente ──GET  /payment-terminals/agent/commands (assinado)──▶ retira
 *   agente ──(cliente TEF, PinPad, cliente digita a senha)
 *   agente ──POST /payment-terminals/agent/commands/:id/result (assinado)──▶
 *            servidor grava aprovado/recusado + NSU + autorização + comprovante
 *   PDV ──GET /core/pdv/terminal/:id (a cada 2 s)──▶ vê "aprovado" e fecha a venda
 *
 * ## Os dois prazos, e por que são dois
 *
 * - Prazo de RETIRADA (`deliver_by`). Comando que o agente não retirou a
 *   tempo nunca chegou ao aparelho: é seguro dizer "nada foi cobrado" e deixar
 *   o operador tentar de novo. A retirada e a expiração acontecem dentro de
 *   uma transação (BEGIN IMMEDIATE): nunca as duas para o mesmo comando.
 * - Prazo de RESPOSTA (`answer_by`). Depois de retirado, ninguém sabe o que o
 *   aparelho fez até a resposta chegar. Se ela não vem, a cobrança vira
 *   `timeout_uncertain` — NÃO CONFIRMADA — e vai para a conferência do gestor.
 *   Nunca "recusada" (convidaria a cobrar de novo um cliente que pode ter
 *   pago), nunca "aprovada" (entregaria mercadoria sem receber).
 *
 * ## Resposta que chega depois do prazo
 *
 * Se ninguém decidiu nada ainda (a cobrança está "não confirmada" e nenhum
 * gestor conferiu o extrato), a palavra do aparelho é melhor que o "não sei":
 * ela é aplicada, com histórico. Se um gestor já decidiu, a decisão dele fica
 * e a resposta vai só para o histórico — a mesma regra do caminho síncrono
 * (GAP-PRD-008).
 *
 * ## Repetição
 *
 * O agente pode mandar o mesmo resultado duas vezes (a rede caiu antes da
 * resposta dele). O segundo envio devolve o que o primeiro gravou, sem gravar
 * nada: um "aprovado" repetido não vira dois comprovantes.
 */
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { findOneRow, insertRow } from '../../db/database.js';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError, sanitizeForLog } from '../../utils/errors.js';
import { recordAudit } from '../audit/AuditService.js';
import { mockProviderBlocked } from './PaymentTerminalCredentialService.js';
import { registrarSinalDoAgente, type LocalAgentTypedContract } from './PaymentTerminalLocalAgentService.js';
import {
  aplicarCancelamentoConfirmado,
  aplicarEstornoConfirmado,
  gravarNaCobranca,
  guardarComprovante,
  registrarTentativa,
  respostaAtrasada,
} from './PaymentTerminalTransactionEffects.js';

type Linha = Record<string, unknown>;

/** Os prazos de cada comando, em milissegundos. */
export const PRAZOS_DO_AGENTE: Record<LocalAgentTypedContract, { retirarMs: number; responderMs: number }> = {
  // O cliente pode demorar para achar o cartão e digitar a senha; o cliente
  // TEF tem o próprio limite (em geral 2 min). Três minutos cobrem os dois.
  startPayment: { retirarMs: 30_000, responderMs: 180_000 },
  queryStatus: { retirarMs: 30_000, responderMs: 60_000 },
  cancel: { retirarMs: 30_000, responderMs: 120_000 },
  refund: { retirarMs: 30_000, responderMs: 120_000 },
  reprint: { retirarMs: 30_000, responderMs: 60_000 },
  health: { retirarMs: 30_000, responderMs: 30_000 },
};

/** O que o agente pode responder, por comando. `in_progress` não encerra o comando. */
const RESULTADOS_ACEITOS: Record<LocalAgentTypedContract, ReadonlySet<string>> = {
  startPayment: new Set(['in_progress', 'approved', 'declined', 'cancelled', 'failed', 'uncertain']),
  queryStatus: new Set(['approved', 'declined', 'cancelled', 'failed', 'not_found', 'uncertain']),
  cancel: new Set(['approved', 'declined', 'failed']),
  refund: new Set(['approved', 'declined', 'failed']),
  reprint: new Set(['approved', 'failed']),
  health: new Set(['approved', 'failed']),
};

/** O que o aparelho disse → estado da cobrança. */
const ESTADO_DA_COBRANCA: Record<string, string> = {
  approved: 'authorized',
  declined: 'declined',
  cancelled: 'cancelled',
  failed: 'failed',
  not_found: 'failed',
  uncertain: 'timeout_uncertain',
};

export interface ComandoDoAgente {
  id: string;
  companyId: string;
  agentId: string;
  configurationId: string | null;
  pdvTerminalId: string | null;
  transactionId: string | null;
  command: LocalAgentTypedContract;
  payload: Record<string, unknown>;
  status: 'queued' | 'delivered' | 'answered' | 'expired';
  attempts: number;
  requestedBy: string | null;
  createdAt: string;
  deliverBy: string;
  answerBy: string | null;
  deliveredAt: string | null;
  answeredAt: string | null;
  expiredAt: string | null;
  resultStatus: string | null;
  result: Record<string, unknown> | null;
}

interface LinhaSql {
  id: string;
  company_id: string;
  agent_id: string;
  configuration_id: string | null;
  pdv_terminal_id: string | null;
  transaction_id: string | null;
  command: string;
  payload: string;
  status: string;
  attempts: number;
  requested_by: string | null;
  created_at: string;
  deliver_by: string;
  answer_by: string | null;
  answer_window_ms: number;
  delivered_at: string | null;
  answered_at: string | null;
  expired_at: string | null;
  result_status: string | null;
  result: string | null;
}

function lerJson(texto: string | null): Record<string, unknown> | null {
  if (!texto) return null;
  try {
    return JSON.parse(texto) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function paraComando(l: LinhaSql): ComandoDoAgente {
  return {
    id: l.id,
    companyId: l.company_id,
    agentId: l.agent_id,
    configurationId: l.configuration_id,
    pdvTerminalId: l.pdv_terminal_id,
    transactionId: l.transaction_id,
    command: l.command as LocalAgentTypedContract,
    payload: lerJson(l.payload) ?? {},
    status: l.status as ComandoDoAgente['status'],
    attempts: Number(l.attempts ?? 0),
    requestedBy: l.requested_by,
    createdAt: l.created_at,
    deliverBy: l.deliver_by,
    answerBy: l.answer_by,
    deliveredAt: l.delivered_at,
    answeredAt: l.answered_at,
    expiredAt: l.expired_at,
    resultStatus: l.result_status,
    result: lerJson(l.result),
  };
}

// ---------------------------------------------------------------- avisos

/**
 * Quem está esperando comando (long-poll), por agente. Mora em memória: é
 * só um atalho para o agente não esperar a próxima volta do laço dele — a
 * fila de verdade é a tabela, e o agente sempre relê a tabela ao acordar.
 */
const AVISOS = new EventEmitter();
AVISOS.setMaxListeners(0);

function avisarAgente(agentId: string): void {
  // Depois do commit da transação que enfileirou: o `setImmediate` só roda
  // quando o código síncrono em curso (e o COMMIT dele) terminou.
  setImmediate(() => AVISOS.emit(agentId));
}

// ---------------------------------------------------------------- enfileirar

export function enfileirarComando(input: {
  companyId: string;
  agentId: string;
  command: LocalAgentTypedContract;
  payload: Record<string, unknown>;
  configurationId?: string | null;
  pdvTerminalId?: string | null;
  transactionId?: string | null;
  requestedBy?: string | null;
  agora?: Date;
}): ComandoDoAgente {
  ensureCoreSchema();
  const agora = input.agora ?? new Date();
  const prazo = PRAZOS_DO_AGENTE[input.command];
  const id = `ptcmd-${randomUUID()}`;
  getConnection()
    .prepare(
      `INSERT INTO core_payment_terminal_agent_commands
         (id, company_id, agent_id, configuration_id, pdv_terminal_id, transaction_id,
          command, payload, status, attempts, requested_by, created_at, deliver_by,
          answer_window_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.companyId,
      input.agentId,
      input.configurationId ?? null,
      input.pdvTerminalId ?? null,
      input.transactionId ?? null,
      input.command,
      JSON.stringify(input.payload ?? {}),
      input.requestedBy ?? null,
      agora.toISOString(),
      new Date(agora.getTime() + prazo.retirarMs).toISOString(),
      prazo.responderMs,
    );
  avisarAgente(input.agentId);
  return comandoOu404(input.companyId, id);
}

function comandoOu404(companyId: string, id: string): ComandoDoAgente {
  const l = getConnection()
    .prepare('SELECT * FROM core_payment_terminal_agent_commands WHERE id = ? AND company_id = ?')
    .get(id, companyId) as LinhaSql | undefined;
  if (!l) {
    throw new ApiError('PAYMENT_TERMINAL_AGENT_COMMAND_NOT_FOUND', 'Comando do agente não encontrado.', 404);
  }
  return paraComando(l);
}

/** Existe pedido de cancelamento/estorno ainda sem resposta para esta cobrança? */
export function operacaoPendenteNoAgente(companyId: string, transactionId: string): ComandoDoAgente | null {
  ensureCoreSchema();
  const l = getConnection()
    .prepare(
      `SELECT * FROM core_payment_terminal_agent_commands
        WHERE company_id = ? AND transaction_id = ? AND command IN ('cancel','refund')
          AND status IN ('queued','delivered')
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(companyId, transactionId) as LinhaSql | undefined;
  return l ? paraComando(l) : null;
}

// ---------------------------------------------------------------- expirar

/**
 * Vence o que passou do prazo. Idempotente; chamado antes de toda leitura que
 * importa (retirada, resultado, consulta do PDV, fila de conferência).
 */
export function expirarComandosVencidos(companyId: string, agora = new Date()): number {
  ensureCoreSchema();
  const iso = agora.toISOString();
  return withTransaction(() => {
    const db = getConnection();
    const vencidos = db
      .prepare(
        `SELECT * FROM core_payment_terminal_agent_commands
          WHERE company_id = ?
            AND ((status = 'queued' AND deliver_by < ?)
              OR (status = 'delivered' AND answer_by IS NOT NULL AND answer_by < ?))`,
      )
      .all(companyId, iso, iso) as unknown as LinhaSql[];
    for (const l of vencidos) {
      const cmd = paraComando(l);
      const nuncaRetirado = cmd.status === 'queued';
      db.prepare(
        `UPDATE core_payment_terminal_agent_commands
            SET status = 'expired', expired_at = ?
          WHERE id = ? AND status = ?`,
      ).run(iso, cmd.id, cmd.status);
      insertRow('payment_terminal_dead_letter', {
        id: `ptdl-${randomUUID()}`,
        companyId: cmd.companyId,
        commandId: cmd.id,
        command: cmd.command,
        agentId: cmd.agentId,
        transactionId: cmd.transactionId,
        reason: nuncaRetirado ? 'not_delivered' : 'no_answer',
        message: nuncaRetirado
          ? 'O agente local não retirou o comando a tempo: o aparelho nunca o recebeu.'
          : 'O agente retirou o comando e não respondeu a tempo: ninguém sabe o que o aparelho fez.',
        createdAt: iso,
      });
      aplicarVencimento(cmd, nuncaRetirado);
    }
    return vencidos.length;
  });
}

function aplicarVencimento(cmd: ComandoDoAgente, nuncaRetirado: boolean): void {
  if (!cmd.transactionId) return;
  const tx = findOneRow<Linha>(
    'payment_terminal_transactions',
    (r) => r.id === cmd.transactionId && r.companyId === cmd.companyId,
  );
  if (!tx) return;
  if (cmd.command === 'startPayment') {
    if (tx.providerCallState !== 'awaiting_agent') return;
    if (nuncaRetirado) {
      // Seguro: o aparelho nunca viu o pedido. O operador pode tentar de novo.
      gravarNaCobranca(cmd.companyId, String(tx.id), {
        status: 'failed',
        providerCallState: 'agent_not_delivered',
        agentStage: null,
        providerAnsweredAt: new Date().toISOString(),
        providerMessage:
          'O agente local não retirou a cobrança a tempo — NADA foi cobrado. Confira se o agente está ligado e tente de novo.',
      });
    } else {
      gravarNaCobranca(cmd.companyId, String(tx.id), {
        status: 'timeout_uncertain',
        providerCallState: 'agent_timeout',
        agentStage: null,
        providerMessage:
          'O agente local recebeu a cobrança e não respondeu a tempo. NÃO cobre de novo: confira no extrato da operadora.',
      });
    }
    return;
  }
  if (cmd.command === 'cancel' || cmd.command === 'refund') {
    registrarTentativa(cmd.command, {
      companyId: cmd.companyId,
      transactionId: String(tx.id),
      provider: tx.provider,
      outcome: nuncaRetirado ? 'not_delivered' : 'no_answer',
      reason: String(cmd.payload.reason ?? ''),
      requestedBy: cmd.requestedBy,
      amountInCents: Number(cmd.payload.amountInCents ?? 0),
      providerMessage: nuncaRetirado
        ? 'O agente não retirou o pedido: nada foi feito no aparelho.'
        : 'O agente não respondeu: confira no extrato da operadora se o pedido foi feito.',
      commandId: cmd.id,
    });
  }
}

// ---------------------------------------------------------------- retirar

export interface ComandoEntregue {
  id: string;
  command: LocalAgentTypedContract;
  transactionId: string | null;
  payload: Record<string, unknown>;
  deliveredAt: string | null;
  answerBy: string | null;
  /** Já tinha sido entregue: o agente reiniciou e está pegando de volta o que ficou sem resposta. */
  redelivery: boolean;
}

/**
 * O agente retira o que é dele — e o que ficou sem resposta volta junto.
 *
 * O comando `queued` vira `delivered` aqui, dentro de uma transação. Os já
 * `delivered` e ainda no prazo voltam marcados como reentrega: o agente que
 * reiniciou no meio de uma cobrança precisa saber que ela existe para
 * consultar o cliente TEF antes de fazer qualquer outra coisa.
 */
export function retirarComandos(agente: { agentId: string; companyId: string }, agora = new Date()): ComandoEntregue[] {
  expirarComandosVencidos(agente.companyId, agora);
  const iso = agora.toISOString();
  return withTransaction(() => {
    const db = getConnection();
    const novos = db
      .prepare(
        `SELECT * FROM core_payment_terminal_agent_commands
          WHERE agent_id = ? AND company_id = ? AND status = 'queued'
          ORDER BY created_at LIMIT 20`,
      )
      .all(agente.agentId, agente.companyId) as unknown as LinhaSql[];
    const entregues: ComandoEntregue[] = [];
    for (const l of novos) {
      const answerBy = new Date(agora.getTime() + Number(l.answer_window_ms)).toISOString();
      db.prepare(
        `UPDATE core_payment_terminal_agent_commands
            SET status = 'delivered', delivered_at = ?, answer_by = ?, attempts = attempts + 1
          WHERE id = ? AND status = 'queued'`,
      ).run(iso, answerBy, l.id);
      if (l.command === 'startPayment' && l.transaction_id) {
        const tx = findOneRow<Linha>(
          'payment_terminal_transactions',
          (r) => r.id === l.transaction_id && r.companyId === agente.companyId,
        );
        if (tx?.providerCallState === 'awaiting_agent') {
          gravarNaCobranca(agente.companyId, String(tx.id), { agentStage: 'delivered', agentDeliveredAt: iso });
        }
      }
      entregues.push({
        id: l.id,
        command: l.command as LocalAgentTypedContract,
        transactionId: l.transaction_id,
        payload: lerJson(l.payload) ?? {},
        deliveredAt: iso,
        answerBy,
        redelivery: false,
      });
    }
    const pendentes = db
      .prepare(
        `SELECT * FROM core_payment_terminal_agent_commands
          WHERE agent_id = ? AND company_id = ? AND status = 'delivered' AND delivered_at < ?
          ORDER BY created_at LIMIT 20`,
      )
      .all(agente.agentId, agente.companyId, iso) as unknown as LinhaSql[];
    for (const l of pendentes) {
      entregues.push({
        id: l.id,
        command: l.command as LocalAgentTypedContract,
        transactionId: l.transaction_id,
        payload: lerJson(l.payload) ?? {},
        deliveredAt: l.delivered_at,
        answerBy: l.answer_by,
        redelivery: true,
      });
    }
    return entregues;
  });
}

/**
 * Long-poll: sem nada para retirar, espera até `esperaMs` por um comando
 * novo. O teto é curto (25 s) para não prender conexão em proxy nenhum.
 */
export async function aguardarComandos(
  agente: { agentId: string; companyId: string },
  esperaMs: number,
): Promise<ComandoEntregue[]> {
  const agora = retirarComandos(agente);
  const espera = Math.max(0, Math.min(25_000, Number.isFinite(esperaMs) ? esperaMs : 0));
  if (agora.some((c) => !c.redelivery) || espera === 0) return agora;
  await new Promise<void>((resolve) => {
    const fim = setTimeout(pronto, espera);
    function pronto() {
      clearTimeout(fim);
      AVISOS.off(agente.agentId, pronto);
      resolve();
    }
    AVISOS.on(agente.agentId, pronto);
  });
  return retirarComandos(agente);
}

// ---------------------------------------------------------------- resultado

export interface ResultadoDoAgente {
  status: string;
  message?: string | null;
  providerTransactionId?: string | null;
  nsu?: string | null;
  authorizationCode?: string | null;
  maskedCard?: string | null;
  cardBrand?: string | null;
  acquirer?: string | null;
  installments?: number | null;
  merchantReceipt?: string | null;
  customerReceipt?: string | null;
  qrPayload?: string | null;
  /** O cliente TEF estava em modo de treinamento: nada é dinheiro. */
  simulated?: boolean;
  /** Etapa informada enquanto a cobrança anda (`in_progress`). */
  stage?: string | null;
}

function texto(v: unknown, max: number): string | null {
  if (v === undefined || v === null || v === '') return null;
  return String(v).slice(0, max);
}

/** Cartão só sai mascarado: se o agente mandar mais que os quatro últimos, o resto some aqui. */
function mascarar(cartao: string | null): string | null {
  if (!cartao) return null;
  const digitos = cartao.replace(/\D/g, '');
  if (digitos.length <= 4) return cartao.includes('*') ? cartao.slice(0, 32) : `****${digitos}`;
  return `****${digitos.slice(-4)}`;
}

export function normalizarResultado(bruto: unknown): ResultadoDoAgente {
  const b = (bruto && typeof bruto === 'object' ? bruto : {}) as Record<string, unknown>;
  const parcelas = b.installments == null ? null : Number(b.installments);
  return {
    status: String(b.status ?? '').trim(),
    message: texto(b.message, 300),
    providerTransactionId: texto(b.providerTransactionId, 120),
    nsu: texto(b.nsu, 60),
    authorizationCode: texto(b.authorizationCode, 60),
    maskedCard: mascarar(texto(b.maskedCard, 40)),
    cardBrand: texto(b.cardBrand, 40),
    acquirer: texto(b.acquirer, 60),
    installments: parcelas != null && Number.isInteger(parcelas) && parcelas > 0 ? parcelas : null,
    merchantReceipt: texto(b.merchantReceipt, 8000),
    customerReceipt: texto(b.customerReceipt, 8000),
    qrPayload: texto(b.qrPayload, 2000),
    simulated: b.simulated === true,
    stage: texto(b.stage, 40),
  };
}

export interface RespostaAoAgente {
  commandId: string;
  accepted: boolean;
  duplicate: boolean;
  /** O que o servidor ficou sabendo — o agente usa para confirmar (CNF) ou desfazer (NCN) no cliente TEF. */
  outcome: 'applied' | 'progress' | 'late_applied' | 'late_ignored' | 'recorded';
  transactionStatus: string | null;
  /** O agente deve CONFIRMAR a transação no cliente TEF? (Só quando o servidor a tem como aprovada.) */
  confirmOnTef: boolean;
  message: string;
}

/**
 * O agente devolve o resultado de um comando.
 *
 * Tudo numa transação: o comando fecha e a cobrança muda juntos, ou nada
 * muda. Repetir o mesmo resultado devolve a mesma resposta sem gravar.
 */
export function registrarResultadoDoAgente(
  agente: { agentId: string; companyId: string },
  commandId: string,
  bruto: unknown,
  agora = new Date(),
): RespostaAoAgente {
  expirarComandosVencidos(agente.companyId, agora);
  const resultado = normalizarResultado(bruto);
  return withTransaction(() => {
    const db = getConnection();
    const l = db
      .prepare(
        `SELECT * FROM core_payment_terminal_agent_commands
          WHERE id = ? AND agent_id = ? AND company_id = ?`,
      )
      .get(commandId, agente.agentId, agente.companyId) as LinhaSql | undefined;
    // Comando de outro agente é "não existe": nenhum agente fala pelo outro.
    if (!l) {
      throw new ApiError('PAYMENT_TERMINAL_AGENT_COMMAND_NOT_FOUND', 'Comando não encontrado para este agente.', 404);
    }
    const cmd = paraComando(l);
    if (!RESULTADOS_ACEITOS[cmd.command].has(resultado.status)) {
      throw new ApiError(
        'PAYMENT_TERMINAL_AGENT_RESULT_INVALID',
        `Resultado "${resultado.status}" não existe para o comando ${cmd.command}.`,
        400,
        { accepted: [...RESULTADOS_ACEITOS[cmd.command]] },
      );
    }
    if (cmd.status === 'answered') {
      const tx = cmd.transactionId ? txDa(cmd) : null;
      return {
        commandId: cmd.id,
        accepted: true,
        duplicate: true,
        outcome: 'recorded',
        transactionStatus: (tx?.status as string | undefined) ?? null,
        confirmOnTef: cmd.command === 'startPayment' && tx?.status === 'authorized' && tx?.agentConfirmOnTef === true,
        message: 'Resultado já registrado.',
      };
    }
    if (cmd.status === 'queued' || (cmd.status === 'expired' && !cmd.deliveredAt)) {
      // O agente não retirou este comando: responder por ele seria inventar.
      throw new ApiError(
        'PAYMENT_TERMINAL_AGENT_COMMAND_NOT_DELIVERED',
        'Este comando não foi retirado por este agente. Nada deve ter sido feito no aparelho.',
        409,
      );
    }

    // Em produção, resultado de TREINAMENTO do cliente TEF não vira dinheiro.
    const treinoEmProducao = resultado.simulated === true && mockProviderBlocked();

    if (resultado.status === 'in_progress') {
      // Etapa intermediária: não fecha o comando; renova o prazo de resposta
      // (o cliente está na frente do PinPad, o QR do PIX está na tela).
      const answerBy = new Date(agora.getTime() + Number(l.answer_window_ms)).toISOString();
      db.prepare(
        `UPDATE core_payment_terminal_agent_commands SET answer_by = ? WHERE id = ? AND status = 'delivered'`,
      ).run(answerBy, cmd.id);
      const tx = txDa(cmd);
      if (tx && tx.providerCallState === 'awaiting_agent') {
        gravarNaCobranca(cmd.companyId, String(tx.id), {
          agentStage: resultado.stage === 'awaiting_customer' ? 'awaiting_customer' : 'processing',
          agentMessage: resultado.message,
          ...(resultado.qrPayload ? { qrPayload: resultado.qrPayload } : {}),
        });
      }
      return {
        commandId: cmd.id,
        accepted: true,
        duplicate: false,
        outcome: 'progress',
        transactionStatus: (tx?.status as string | undefined) ?? null,
        confirmOnTef: false,
        message: 'Etapa registrada.',
      };
    }

    const statusFinal = treinoEmProducao ? 'failed' : resultado.status;
    db.prepare(
      `UPDATE core_payment_terminal_agent_commands
          SET status = 'answered', answered_at = ?, result_status = ?, result = ?
        WHERE id = ?`,
    ).run(
      agora.toISOString(),
      statusFinal,
      JSON.stringify(sanitizeForLog({ ...resultado, merchantReceipt: undefined, customerReceipt: undefined })),
      cmd.id,
    );

    const resposta = aplicarResultado(cmd, { ...resultado, status: statusFinal }, treinoEmProducao, cmd.status === 'expired');
    recordAudit({
      companyId: cmd.companyId,
      userId: null,
      action: `payment_terminal.agent.result.${cmd.command}`,
      entityType: 'payment_terminal_agent_command',
      entityId: cmd.id,
      detail: {
        agentId: cmd.agentId,
        transactionId: cmd.transactionId,
        status: statusFinal,
        outcome: resposta.outcome,
        simulated: resultado.simulated === true,
      },
    });
    registrarSinalDoAgente(agente.agentId);
    return { commandId: cmd.id, accepted: true, duplicate: false, ...resposta };
  });
}

function txDa(cmd: ComandoDoAgente): Linha | null {
  if (!cmd.transactionId) return null;
  return findOneRow<Linha>(
    'payment_terminal_transactions',
    (r) => r.id === cmd.transactionId && r.companyId === cmd.companyId,
  ) ?? null;
}

function aplicarResultado(
  cmd: ComandoDoAgente,
  r: ResultadoDoAgente,
  treinoEmProducao: boolean,
  depoisDoPrazo: boolean,
): Omit<RespostaAoAgente, 'commandId' | 'accepted' | 'duplicate'> {
  const tx = txDa(cmd);
  if (cmd.command === 'startPayment' || cmd.command === 'queryStatus') {
    if (!tx) {
      return { outcome: 'recorded', transactionStatus: null, confirmOnTef: false, message: 'Resultado registrado.' };
    }
    const novo = ESTADO_DA_COBRANCA[r.status] ?? 'failed';
    const aguardando = tx.providerCallState === 'awaiting_agent';
    const semDecisaoHumana =
      tx.status === 'timeout_uncertain' && tx.providerCallState !== 'reconciled' && !tx.reconciledAt;
    if (!aguardando && !semDecisaoHumana) {
      respostaAtrasada(tx, novo, 'agent');
      return {
        outcome: 'late_ignored',
        transactionStatus: String(tx.status ?? ''),
        confirmOnTef: tx.status === 'authorized' && novo === 'authorized',
        message: 'A cobrança já tinha desfecho decidido; a resposta ficou no histórico.',
      };
    }
    if (cmd.command === 'queryStatus' && r.status === 'uncertain') {
      // O cliente TEF também não sabe: nada muda, a conferência continua.
      return {
        outcome: 'recorded',
        transactionStatus: String(tx.status ?? ''),
        confirmOnTef: false,
        message: 'O aparelho também não sabe o desfecho: a cobrança continua para conferência.',
      };
    }
    const agoraIso = new Date().toISOString();
    const aprovado = novo === 'authorized';
    const final = gravarNaCobranca(cmd.companyId, String(tx.id), {
      status: novo,
      providerCallState: 'answered',
      providerAnsweredAt: agoraIso,
      authorizedAt: aprovado ? agoraIso : undefined,
      agentStage: null,
      providerTransactionId: r.providerTransactionId ?? undefined,
      providerNsu: r.nsu ?? undefined,
      providerAuthorizationCode: r.authorizationCode ?? undefined,
      providerMessage: treinoEmProducao
        ? 'O cliente TEF respondeu em modo de TREINAMENTO: recusado em produção, nada foi cobrado.'
        : (r.message ?? undefined),
      maskedCard: r.maskedCard ?? undefined,
      cardBrand: r.cardBrand ?? undefined,
      acquirer: r.acquirer ?? undefined,
      qrPayload: aprovado ? null : tx.qrPayload,
      simulated: r.simulated === true,
      real: r.simulated !== true,
      agentConfirmOnTef: aprovado,
    });
    if (aprovado) {
      guardarComprovante(final, {
        receiptText: r.merchantReceipt,
        customerReceiptText: r.customerReceipt,
        simulated: r.simulated === true,
      });
    }
    if (!aguardando || depoisDoPrazo) {
      insertRow('payment_terminal_history', {
        id: `pthist-${randomUUID()}`,
        companyId: cmd.companyId,
        transactionId: tx.id,
        action: cmd.command === 'queryStatus' ? 'status_confirmed_by_agent' : 'late_agent_answer_applied',
        providerStatus: novo,
        previousStatus: tx.status ?? null,
        createdAt: agoraIso,
      });
    }
    return {
      outcome: aguardando && !depoisDoPrazo ? 'applied' : 'late_applied',
      transactionStatus: novo,
      confirmOnTef: aprovado,
      message: aprovado ? 'Aprovação registrada.' : 'Resultado registrado.',
    };
  }

  if ((cmd.command === 'cancel' || cmd.command === 'refund') && tx) {
    const reason = String(cmd.payload.reason ?? '');
    const valor = Number(cmd.payload.amountInCents ?? 0);
    registrarTentativa(cmd.command, {
      companyId: cmd.companyId,
      transactionId: String(tx.id),
      provider: tx.provider,
      outcome: r.status === 'approved' ? 'confirmed' : r.status,
      reason,
      requestedBy: cmd.requestedBy,
      amountInCents: valor,
      providerMessage: r.message ?? null,
      simulated: r.simulated === true,
      commandId: cmd.id,
    });
    if (r.status !== 'approved') {
      return {
        outcome: 'recorded',
        transactionStatus: String(tx.status ?? ''),
        confirmOnTef: false,
        message: 'Recusa registrada; a cobrança continua como estava.',
      };
    }
    const final = cmd.command === 'cancel'
      ? aplicarCancelamentoConfirmado({
          companyId: cmd.companyId,
          transactionId: String(tx.id),
          userId: cmd.requestedBy,
          reason,
          simulated: r.simulated === true,
          via: 'agent',
        })
      : aplicarEstornoConfirmado({
          companyId: cmd.companyId,
          transactionId: String(tx.id),
          userId: cmd.requestedBy,
          reason,
          amountInCents: valor,
          simulated: r.simulated === true,
          via: 'agent',
        });
    return {
      outcome: depoisDoPrazo ? 'late_applied' : 'applied',
      transactionStatus: String(final.status ?? ''),
      confirmOnTef: true,
      message: cmd.command === 'cancel' ? 'Cancelamento registrado.' : 'Estorno registrado.',
    };
  }

  return { outcome: 'recorded', transactionStatus: null, confirmOnTef: false, message: 'Resultado registrado.' };
}

// ---------------------------------------------------------------- consulta

export function listarComandosDoAgente(
  companyId: string,
  filtro: { status?: string; transactionId?: string; limit?: number } = {},
): ComandoDoAgente[] {
  expirarComandosVencidos(companyId);
  const limite = Math.min(Math.max(Number(filtro.limit ?? 100), 1), 500);
  const partes = ['company_id = ?'];
  const args: (string | number)[] = [companyId];
  if (filtro.status) {
    partes.push('status = ?');
    args.push(filtro.status);
  }
  if (filtro.transactionId) {
    partes.push('transaction_id = ?');
    args.push(filtro.transactionId);
  }
  args.push(limite);
  const linhas = getConnection()
    .prepare(
      `SELECT * FROM core_payment_terminal_agent_commands
        WHERE ${partes.join(' AND ')}
        ORDER BY created_at DESC LIMIT ?`,
    )
    .all(...args) as unknown as LinhaSql[];
  return linhas.map(paraComando);
}
