/**
 * Fila de transmissão fiscal.
 *
 * A fila existe porque a rede cai. Sem ela, uma falha de conexão obrigaria o
 * caixa a escolher entre travar a venda ou perder a nota — e as duas opções
 * são ruins. Com ela, o documento fica registrado e a transmissão acontece
 * quando der.
 *
 * O CASO QUE JUSTIFICA O RESTO: TIMEOUT
 *
 * O ERP envia, a SEFAZ recebe e autoriza, e a conexão cai antes da resposta.
 * Reenviar seria pedir a mesma pizza porque o entregador demorou — só que aqui
 * o resultado é DUAS notas para a mesma venda. Por isso, depois de um timeout,
 * o worker CONSULTA a chave antes de qualquer reenvio. Essa consulta é a razão
 * de existir deste módulo, mais do que a fila em si.
 *
 * O QUE NÃO SE RETENTA: rejeição fiscal. Um CNPJ inválido continuará inválido
 * na décima tentativa; retentar só enche a fila e a auditoria.
 */
import { randomUUID } from 'node:crypto';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError, logError } from '../../utils/errors.js';
import { recordAudit } from '../audit/AuditService.js';
import { getDocument, transition, type FiscalDocument } from './FiscalDocumentService.js';
import { getFiscalConfig } from './FiscalConfigService.js';
import type { FiscalEnvironment } from './FiscalKeyService.js';
import {
  isRetryable,
  requiresConsultBeforeRetry,
  type SefazAdapter,
  type SefazResponse,
} from './SefazAdapter.js';
import { TransportFailure } from './SefazTestAdapter.js';
import {
  enterContingency,
  finishContingency,
  isEligibleForContingency,
  reasonFromOutcome,
} from './FiscalContingencyService.js';
import { avisarNotaDoPedido } from '../notifications/AvisoDaNotaDoPedido.js';
import {
  abrirPeriodo,
  emitidaOffline,
  encerrarPeriodo,
  lerPoliticaDeContingencia,
  periodoAtivo,
  type MotivoDoPeriodo,
} from './FiscalContingenciaOffline.js';

/**
 * A INDISPONIBILIDADE CONFIRMADA ABRE O PERÍODO (GAP-PRD-098) — só com a
 * modalidade off-line decidida pelo contador, e só para NFC-e. A partir daí a
 * PRÓXIMA venda nasce off-line; a nota que falhou continua a mesma, na fila.
 * Falhar aqui não derruba a transmissão: é registro, não decisão da nota.
 */
function abrirPeriodoSeCouber(input: {
  companyId: string;
  model: string;
  motivo: MotivoDoPeriodo;
  codigo: string | null;
  mensagem: string | null;
  userId?: string | null;
}): void {
  if (input.model !== '65') return;
  if (lerPoliticaDeContingencia(input.companyId).modo !== 'OFFLINE_NFCE') return;
  try {
    abrirPeriodo({
      companyId: input.companyId,
      motivo: input.motivo,
      origem: 'AUTOMATICA',
      codigoDoGatilho: input.codigo,
      mensagemDoGatilho: input.mensagem,
      userId: input.userId ?? null,
    });
  } catch (err) {
    logError('FISCAL_CONTINGENCY_OPEN_FAILED', { companyId: input.companyId, error: String(err) });
  }
}

/** Resposta conclusiva da SEFAZ para NFC-e: ela está no ar, e o período fecha. */
function encerrarPeriodoPelaResposta(companyId: string, model: string, cStat: string | null): void {
  if (model !== '65' || !periodoAtivo(companyId)) return;
  encerrarPeriodo({
    companyId,
    origem: 'AUTOMATICA',
    cStat,
    motivo: 'A SEFAZ respondeu a uma autorização.',
  });
}

/** Espera entre tentativas, em minutos. Cresce para não martelar o serviço. */
const BACKOFF_MINUTES = [1, 5, 15, 60, 240];

/** Depois disto o item para e espera decisão humana — nada de laço infinito. */
export const MAX_ATTEMPTS = BACKOFF_MINUTES.length;

/** Quanto tempo a trava vale, para o item se soltar sozinho após um crash. */
const LOCK_MINUTES = 10;

const PROCESS_ID = `${process.pid}-${randomUUID().slice(0, 8)}`;

export interface QueueItem {
  id: string;
  companyId: string;
  documentId: string;
  operation: string;
  status: string;
  attempts: number;
  nextAttemptAt: string | null;
  lastAttemptAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

function toItem(row: Record<string, unknown>): QueueItem {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    documentId: String(row.document_id),
    operation: String(row.operation),
    status: String(row.status),
    attempts: Number(row.attempts ?? 0),
    nextAttemptAt: (row.next_attempt_at as string | null) ?? null,
    lastAttemptAt: (row.last_attempt_at as string | null) ?? null,
    errorCode: (row.error_code as string | null) ?? null,
    errorMessage: (row.error_message as string | null) ?? null,
  };
}

function minutesFrom(base: Date, minutes: number): string {
  return new Date(base.getTime() + minutes * 60_000).toISOString();
}

/**
 * O ambiente em que a NOTA foi montada — é o `tpAmb` que está dentro do XML
 * assinado, e é para o host desse ambiente que ela tem de ir (GAP-PRD-020).
 *
 * A fila perguntava à configuração ATUAL da operação. Com o trabalhador de
 * fundo transmitindo o que ficou para trás, a nota de homologação que esperou
 * a virada da operação para produção seria mandada ao host de produção com
 * `tpAmb=2` dentro — rejeição 252, e uma nota perdida por causa de uma data.
 */
function ambienteDaNota(daNota: string, daOperacao: FiscalEnvironment): FiscalEnvironment {
  return daNota === 'production' || daNota === 'homologation' ? daNota : daOperacao;
}

/**
 * Põe o documento na fila.
 *
 * IDEMPOTENTE: a chave `doc:<id>:<operação>` tem UNIQUE no banco, então
 * enfileirar duas vezes o mesmo documento devolve o item existente em vez de
 * criar um segundo — dois itens produziriam duas transmissões da mesma nota.
 */
export function enqueue(input: {
  companyId: string;
  documentId: string;
  operation?: string;
  userId?: string | null;
}): QueueItem {
  ensureCoreSchema();
  const operation = input.operation ?? 'authorize';
  const chave = `doc:${input.documentId}:${operation}`;

  return withTransaction(() => {
    const db = getConnection();
    const existente = db
      .prepare('SELECT * FROM core_fiscal_queue WHERE company_id = ? AND idempotency_key = ?')
      .get(input.companyId, chave) as Record<string, unknown> | undefined;
    if (existente) return toItem(existente);

    const doc = getDocument(input.companyId, input.documentId);
    if (!doc) {
      throw new ApiError('CORE_FISCAL_DOCUMENT_NOT_FOUND', 'Documento fiscal não encontrado.', 404);
    }

    const now = new Date();
    const id = randomUUID();
    db.prepare(
      `INSERT INTO core_fiscal_queue
         (id, company_id, document_id, operation, status, attempts, next_attempt_at,
          idempotency_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)`,
    ).run(
      id,
      input.companyId,
      input.documentId,
      operation,
      now.toISOString(),
      chave,
      now.toISOString(),
      now.toISOString(),
    );

    // SIGNED -> QUEUED. A máquina de estados recusa se o documento não estiver
    // no ponto certo, o que impede enfileirar um rascunho.
    if (doc.status === 'SIGNED') {
      transition({
        companyId: input.companyId,
        documentId: input.documentId,
        to: 'QUEUED',
        userId: input.userId,
      });
    }

    recordAudit({
      companyId: input.companyId,
      userId: input.userId ?? null,
      action: 'fiscal.queued',
      entityType: 'fiscal_document',
      entityId: input.documentId,
      detail: { operation },
    });

    return toItem(
      db.prepare('SELECT * FROM core_fiscal_queue WHERE id = ?').get(id) as Record<string, unknown>,
    );
  });
}

/**
 * Reivindica um item vencido DA EMPRESA.
 *
 * O `UPDATE ... WHERE` é a trava: duas instâncias disputando o mesmo item
 * produzem uma vencedora e uma que não altera nada. Sem isso, os dois
 * processos transmitiriam a mesma nota — e a segunda viraria duplicidade na
 * SEFAZ.
 *
 * ## A EMPRESA É OBRIGATÓRIA, e essa é a lição desta rodada
 *
 * A consulta filtrava só por `status IN ('pending','retry')` e ordenava por
 * `next_attempt_at`. Quem chama `processNext` é a requisição de UMA empresa, e
 * ela monta o adapter com o CERTIFICADO dela: o gerente da Gringa emitia uma
 * nota, o processo pegava o item mais antigo da fila — do Preço Justo — e o
 * transmitia assinado pela Gringa. A SEFAZ rejeita por CNPJ do certificado
 * diferente do emitente, e a nota da Gringa ficava esperando para sempre.
 *
 * O isolamento estava correto em toda a camada HTTP e furava aqui, abaixo
 * dela. O teste que existia usava uma empresa só — por isso passava.
 *
 * ## E O DOCUMENTO, quando quem chama sabe qual é (GAP-PRD-020)
 *
 * A emissão de uma venda chamava isto sem documento, e o item reivindicado era
 * o MAIS ANTIGO vencido da empresa: a venda nova transmitia a nota velha e
 * devolvia a própria como "aguardando transmissão". Com `documentId`, a
 * requisição de uma venda só toca a nota daquela venda — o resto da fila é do
 * trabalhador de fundo (`FiscalQueueWorker`).
 */
export function claimNext(
  companyId: string,
  now = new Date(),
  documentId?: string | null,
): QueueItem | null {
  ensureCoreSchema();

  /*
    ITEM PRESO VOLTA ANTES DE QUALQUER COISA.

    `recoverStaleItems` existia e não tinha chamador nenhum: um item
    reivindicado por um processo que morreu ficava `sending` para sempre,
    porque a busca só olha `pending` e `retry`. A nota daquela venda nunca era
    transmitida — e sumia também das pendências, porque a lista cobre
    `SENDING` velho e fila `dead`, não `QUEUED` com item travado.

    Aqui é o lugar natural: quem vai transmitir passa por este ponto, e a
    recuperação é da MESMA empresa que vai reivindicar.
  */
  recoverStaleItems(companyId, now);

  return withTransaction(() => {
    const db = getConnection();
    const agora = now.toISOString();

    const candidatos = db
      .prepare(
        `SELECT * FROM core_fiscal_queue
          WHERE company_id = ?
            AND status IN ('pending', 'retry')
            AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
            AND (locked_until IS NULL OR locked_until <= ?)
            ${documentId ? 'AND document_id = ?' : ''}
          ORDER BY next_attempt_at
          LIMIT 10`,
      )
      .all(
        ...(documentId ? [companyId, agora, agora, documentId] : [companyId, agora, agora]),
      ) as unknown as Record<string, unknown>[];

    for (const candidato of candidatos) {
      const r = db
        .prepare(
          `UPDATE core_fiscal_queue
              SET locked_until = ?, locked_by = ?, status = 'sending',
                  last_attempt_at = ?, updated_at = ?
            WHERE id = ?
              AND (locked_until IS NULL OR locked_until <= ?)`,
        )
        .run(
          minutesFrom(now, LOCK_MINUTES),
          PROCESS_ID,
          agora,
          agora,
          String(candidato.id),
          agora,
        );

      if (Number(r.changes) > 0) {
        return toItem(
          db.prepare('SELECT * FROM core_fiscal_queue WHERE id = ?').get(String(candidato.id)) as
            Record<string, unknown>,
        );
      }
    }
    return null;
  });
}

function releaseDone(itemId: string): void {
  getConnection()
    .prepare(
      `UPDATE core_fiscal_queue
          SET status = 'done', locked_until = NULL, locked_by = NULL, updated_at = ?
        WHERE id = ?`,
    )
    .run(new Date().toISOString(), itemId);
}

/**
 * A NFC-e OFF-LINE NÃO DESISTE (GAP-PRD-098): o cupom de contingência já foi
 * entregue ao cliente, e a nota PRECISA chegar à SEFAZ dentro do prazo. Ela
 * não vira `dead` — e a espera entre tentativas não passa de 15 min, para um
 * prazo de horas não ser comido por um backoff de quatro.
 */
const TETO_DA_ESPERA_OFFLINE_MIN = 15;

function releaseFailed(
  itemId: string,
  attempts: number,
  code: string,
  message: string,
  now: Date,
  offline = false,
): void {
  const esgotou = !offline && attempts >= MAX_ATTEMPTS;
  const passo = BACKOFF_MINUTES[Math.min(attempts, BACKOFF_MINUTES.length - 1)];
  const espera = offline ? Math.min(passo, TETO_DA_ESPERA_OFFLINE_MIN) : passo;

  getConnection()
    .prepare(
      `UPDATE core_fiscal_queue
          SET status = ?, attempts = ?, next_attempt_at = ?, error_code = ?, error_message = ?,
              locked_until = NULL, locked_by = NULL, updated_at = ?
        WHERE id = ?`,
    )
    .run(
      // 'dead' é o fim da linha automática: alguém precisa olhar. Continuar
      // tentando para sempre esconderia o problema atrás de ruído.
      esgotou ? 'dead' : 'retry',
      attempts,
      esgotou ? null : minutesFrom(now, espera),
      code,
      message,
      now.toISOString(),
      itemId,
    );
}

/** Aplica a resposta fiscal ao documento. Só aqui um documento vira AUTHORIZED. */
function applyResponse(input: {
  companyId: string;
  document: FiscalDocument;
  response: SefazResponse;
  userId?: string | null;
}): FiscalDocument {
  const { response, document } = input;

  if (response.outcome === 'AUTHORIZED') {
    // A invariante do banco exige protocolo. Autorização sem protocolo não é
    // autorização — é resposta malformada, e vira erro.
    if (!response.protocol) {
      return transition({
        companyId: input.companyId,
        documentId: document.id,
        to: 'ERROR',
        patch: {
          c_stat: response.cStat,
          x_motivo: 'Resposta indicou autorização mas não trouxe protocolo.',
        },
        userId: input.userId,
      });
    }
    const autorizado = transition({
      companyId: input.companyId,
      documentId: document.id,
      to: 'AUTHORIZED',
      patch: {
        protocol: response.protocol,
        c_stat: response.cStat,
        x_motivo: response.xMotivo,
        authorized_at: response.receivedAt,
        xml_authorized: response.rawResponse,
      },
      detail: { correlationId: response.correlationId },
      userId: input.userId,
    });
    // A NF-e do pedido online vai ao cliente (GAP-PRD-037, domínio EML). Nunca
    // lança: o aviso não desfaz a autorização.
    avisarNotaDoPedido(input.companyId, autorizado.id);
    return autorizado;
  }

  // Rejeitado, denegado ou não encontrado: o documento NÃO é autorizado, e o
  // motivo fica gravado para o operador ver o que corrigir.
  return transition({
    companyId: input.companyId,
    documentId: document.id,
    to: 'REJECTED',
    patch: {
      c_stat: response.cStat,
      x_motivo: response.xMotivo,
      xml_authorized: null,
    },
    detail: { outcome: response.outcome, correlationId: response.correlationId },
    userId: input.userId,
  });
}

export interface ProcessResult {
  processed: boolean;
  documentId?: string;
  outcome?: string;
  status?: string;
}

/**
 * Processa um item da fila.
 *
 * A sequência importa: enviar, e se a resposta não vier, CONSULTAR antes de
 * pensar em reenviar.
 */
export async function processNext(input: {
  /**
   * A empresa que está transmitindo — a mesma de quem é o certificado do
   * `adapter`. Sem ela, o processo pegava a nota de qualquer operação e a
   * assinava com o certificado errado.
   */
  companyId: string;
  adapter: SefazAdapter;
  now?: Date;
  userId?: string | null;
  /**
   * Só o item DESTE documento (GAP-PRD-020). A emissão de uma venda passa o
   * documento dela; o trabalhador de fundo passa o documento que escolheu,
   * depois de decidir o adapter pela procedência dele. Ausente: o mais antigo
   * vencido da empresa, como sempre.
   */
  documentId?: string | null;
}): Promise<ProcessResult> {
  const now = input.now ?? new Date();
  const item = claimNext(input.companyId, now, input.documentId);
  if (!item) return { processed: false };

  const doc = getDocument(item.companyId, item.documentId);
  if (!doc) {
    releaseFailed(item.id, item.attempts + 1, 'DOCUMENT_MISSING', 'Documento não encontrado.', now);
    return { processed: true, outcome: 'DOCUMENT_MISSING' };
  }

  const config = getFiscalConfig(item.companyId);
  const xml = (
    getConnection()
      .prepare('SELECT xml_signed, xml_original FROM core_fiscal_documents WHERE id = ?')
      .get(doc.id) as { xml_signed: string | null; xml_original: string | null }
  );

  // Documento não assinado não vai para transmissão real. É a última barreira
  // antes do fisco.
  if (!xml.xml_signed) {
    releaseFailed(item.id, item.attempts + 1, 'NOT_SIGNED', 'Documento não assinado.', now);
    return { processed: true, outcome: 'NOT_SIGNED' };
  }

  if (doc.status === 'QUEUED' || doc.status === 'CONTINGENCY') {
    transition({
      companyId: item.companyId,
      documentId: doc.id,
      to: 'SENDING',
      userId: input.userId,
    });
  }

  recordAudit({
    companyId: item.companyId,
    userId: input.userId ?? null,
    action: 'fiscal.sending',
    entityType: 'fiscal_document',
    entityId: doc.id,
    detail: { attempt: item.attempts + 1 },
  });

  let response: SefazResponse;
  try {
    response = await input.adapter.authorize({
      companyId: item.companyId,
      // NFC-e (65) fala com hosts próprios no RS — o adapter real precisa saber.
      model: doc.model,

      documentId: doc.id,
      accessKey: doc.accessKey!,
      signedXml: xml.xml_signed,
      uf: config.uf ?? '',
      environment: ambienteDaNota(doc.environment, config.environment),
    });
  } catch (err) {
    const transporte = err instanceof TransportFailure ? err.kind : 'NETWORK_ERROR';

    // AQUI ESTÁ O PONTO. A resposta não veio, mas a SEFAZ pode ter recebido e
    // autorizado. Reenviar produziria duas notas; consultar resolve.
    recordAudit({
      companyId: item.companyId,
      userId: input.userId ?? null,
      action: 'fiscal.timeout_uncertain',
      entityType: 'fiscal_document',
      entityId: doc.id,
      detail: { transporte },
    });

    const sinal = { consultaFalhou: false };
    const resolvido = await consultAndReconcile({
      adapter: input.adapter,
      companyId: item.companyId,
      documentId: doc.id,
      userId: input.userId,
      sinal,
    });

    if (resolvido) {
      if (doc.contingencyMode) {
        finishContingency({ companyId: item.companyId, documentId: doc.id, userId: input.userId });
      }
      encerrarPeriodoPelaResposta(item.companyId, doc.model, resolvido.cStat);
      releaseDone(item.id);
      return { processed: true, documentId: doc.id, outcome: 'RESOLVED_BY_CONSULT', status: resolvido.status };
    }

    // A consulta não achou: aí sim é seguro tentar de novo mais tarde.
    const offline = emitidaOffline(doc.accessKey);
    const mensagem = err instanceof Error ? err.message : 'Falha de transporte.';
    releaseFailed(item.id, item.attempts + 1, transporte, mensagem, now, offline);
    transition({
      companyId: item.companyId,
      documentId: doc.id,
      // A nota off-line volta a ser o que era: emitida, pendente de autorização.
      to: offline ? 'CONTINGENCY' : 'QUEUED',
      userId: input.userId,
    });
    // Rede fora E a consulta também sem resposta: indisponibilidade confirmada.
    // (Consulta que respondeu "não conheço" é SEFAZ no ar — não abre período.)
    if (sinal.consultaFalhou) {
      abrirPeriodoSeCouber({
        companyId: item.companyId,
        model: doc.model,
        motivo: 'NETWORK_UNAVAILABLE',
        codigo: transporte,
        mensagem,
        userId: input.userId,
      });
    }
    return { processed: true, documentId: doc.id, outcome: transporte };
  }

  // Duplicidade também exige consulta: a nota pode já estar autorizada.
  if (requiresConsultBeforeRetry(response.outcome)) {
    const resolvido = await consultAndReconcile({
      adapter: input.adapter,
      companyId: item.companyId,
      documentId: doc.id,
      userId: input.userId,
    });
    if (resolvido) {
      if (doc.contingencyMode) {
        finishContingency({ companyId: item.companyId, documentId: doc.id, userId: input.userId });
      }
      encerrarPeriodoPelaResposta(item.companyId, doc.model, resolvido.cStat);
      releaseDone(item.id);
      return { processed: true, documentId: doc.id, outcome: 'RESOLVED_BY_CONSULT', status: resolvido.status };
    }
  }

  if (isRetryable(response.outcome)) {
    const tentativas = item.attempts + 1;
    const offline = emitidaOffline(doc.accessKey);
    releaseFailed(
      item.id,
      tentativas,
      response.cStat ?? response.outcome,
      response.xMotivo ?? 'Serviço indisponível.',
      now,
      offline,
    );

    // Serviço paralisado é indisponibilidade confirmada pela própria SEFAZ.
    abrirPeriodoSeCouber({
      companyId: item.companyId,
      model: doc.model,
      motivo: reasonFromOutcome(response.outcome) ?? 'SEFAZ_UNAVAILABLE',
      codigo: response.cStat,
      mensagem: response.xMotivo,
      userId: input.userId,
    });

    if (offline) {
      transition({ companyId: item.companyId, documentId: doc.id, to: 'CONTINGENCY', userId: input.userId });
      return { processed: true, documentId: doc.id, outcome: response.outcome };
    }

    // Esgotadas as tentativas com indisponibilidade — não com rejeição — o
    // documento vai para contingência em vez de morrer na fila. Rejeição
    // fiscal nunca chega aqui: `isRetryable` já a excluiu.
    const motivo = reasonFromOutcome(response.outcome);
    if (tentativas >= MAX_ATTEMPTS && motivo && isEligibleForContingency(response.outcome)) {
      enterContingency({
        companyId: item.companyId,
        documentId: doc.id,
        reason: motivo,
        triggerCode: response.cStat,
        triggerMessage: response.xMotivo,
        userId: input.userId,
      });
      return { processed: true, documentId: doc.id, outcome: 'CONTINGENCY' };
    }

    transition({
      companyId: item.companyId,
      documentId: doc.id,
      to: 'QUEUED',
      userId: input.userId,
    });
    return { processed: true, documentId: doc.id, outcome: response.outcome };
  }

  const atualizado = applyResponse({
    companyId: item.companyId,
    document: doc,
    response,
    userId: input.userId,
  });

  // Alcançou desfecho: se esteve em contingência, o período se encerra. O
  // REGISTRO de que esteve permanece — apagá-lo esconderia justamente o
  // intervalo que alguém vai querer auditar.
  if (doc.contingencyMode) {
    finishContingency({
      companyId: item.companyId,
      documentId: doc.id,
      userId: input.userId,
    });
  }
  // E a SEFAZ respondeu: se a operação estava em período de contingência, ele
  // termina aqui (GAP-PRD-098) — a próxima venda volta a sair normal.
  encerrarPeriodoPelaResposta(item.companyId, doc.model, response.cStat);

  recordAudit({
    companyId: item.companyId,
    userId: input.userId ?? null,
    action: 'fiscal.response_received',
    entityType: 'fiscal_document',
    entityId: doc.id,
    detail: { cStat: response.cStat, outcome: response.outcome },
  });

  releaseDone(item.id);
  return {
    processed: true,
    documentId: doc.id,
    outcome: response.outcome,
    status: atualizado.status,
  };
}

/**
 * Consulta a chave e reconcilia o estado local.
 *
 * Devolve o documento quando a consulta foi CONCLUSIVA — autorizada ou
 * rejeitada. Devolve `null` quando o fisco não conhece a chave, que é o único
 * caso em que reenviar é seguro.
 */
export async function consultAndReconcile(input: {
  adapter: SefazAdapter;
  companyId: string;
  documentId: string;
  userId?: string | null;
  /** Preenchido quando a CONSULTA não obteve resposta (rede fora) — diferente de "não conheço a chave". */
  sinal?: { consultaFalhou: boolean };
}): Promise<FiscalDocument | null> {
  const doc = getDocument(input.companyId, input.documentId);
  if (!doc?.accessKey) return null;

  const config = getFiscalConfig(input.companyId);

  recordAudit({
    companyId: input.companyId,
    userId: input.userId ?? null,
    action: 'fiscal.consult_started',
    entityType: 'fiscal_document',
    entityId: doc.id,
  });

  let response: SefazResponse;
  try {
    response = await input.adapter.consult({
      companyId: input.companyId,
      model: doc.model,
      accessKey: doc.accessKey,
      uf: config.uf ?? '',
      environment: ambienteDaNota(doc.environment, config.environment),
    });
  } catch (err) {
    // Consulta falhou: NÃO se conclui nada. Reenviar às cegas continua
    // proibido, e o item volta para a fila.
    logError('FISCAL_CONSULT_FAILED', {
      documentId: doc.id,
      error: err instanceof Error ? err.message : String(err),
    });
    if (input.sinal) input.sinal.consultaFalhou = true;
    return null;
  }

  recordAudit({
    companyId: input.companyId,
    userId: input.userId ?? null,
    action: 'fiscal.consult_resolved',
    entityType: 'fiscal_document',
    entityId: doc.id,
    detail: { cStat: response.cStat, outcome: response.outcome },
  });

  if (response.outcome === 'NOT_FOUND') return null;

  // O documento pode ter ficado em QUEUED se o processo morreu entre
  // reivindicar o item e marcar o envio. A consulta acabou de descobrir que a
  // SEFAZ já decidiu, então ele passa por SENDING para chegar ao desfecho —
  // sem essa ponte, uma nota autorizada de verdade ficaria presa em QUEUED.
  let atual = getDocument(input.companyId, input.documentId)!;
  if (atual.status === 'QUEUED') {
    atual = transition({
      companyId: input.companyId,
      documentId: input.documentId,
      to: 'SENDING',
      detail: { motivo: 'reconciliação após interrupção' },
      userId: input.userId,
    });
  }
  return applyResponse({
    companyId: input.companyId,
    document: atual,
    response,
    userId: input.userId,
  });
}

/**
 * Recupera itens presos.
 *
 * Um processo que morre no meio do envio deixa a trava de pé. Ela vence
 * sozinha, e aqui os itens vencidos voltam para a fila — mas voltam para
 * CONSULTA, não para reenvio, porque não se sabe se a SEFAZ recebeu.
 */
export function recoverStaleItems(companyId: string, now = new Date()): QueueItem[] {
  ensureCoreSchema();

  return withTransaction(() => {
    const db = getConnection();
    const agora = now.toISOString();

    /*
      Também por empresa, pela mesma razão do `claimNext`: destravar o item da
      vizinha o devolve para uma fila que quem destravou não vai transmitir, e
      o rastro de auditoria sai com o nome de quem não tem nada com aquilo.
    */
    const presos = db
      .prepare(
        `SELECT * FROM core_fiscal_queue
          WHERE company_id = ?
            AND status = 'sending' AND locked_until IS NOT NULL AND locked_until <= ?`,
      )
      .all(companyId, agora) as unknown as Record<string, unknown>[];

    for (const item of presos) {
      db.prepare(
        `UPDATE core_fiscal_queue
            SET status = 'retry', locked_until = NULL, locked_by = NULL,
                next_attempt_at = ?, error_code = 'RECOVERED',
                error_message = 'Processo interrompido durante o envio. Estado será consultado.',
                updated_at = ?
          WHERE id = ?`,
      ).run(agora, agora, String(item.id));

      recordAudit({
        companyId: String(item.company_id),
        userId: null,
        action: 'fiscal.recovery',
        entityType: 'fiscal_document',
        entityId: String(item.document_id),
      });
    }

    return presos.map(toItem);
  });
}

export function listQueue(companyId: string): QueueItem[] {
  ensureCoreSchema();
  const rows = getConnection()
    .prepare('SELECT * FROM core_fiscal_queue WHERE company_id = ? ORDER BY created_at')
    .all(companyId) as unknown as Record<string, unknown>[];
  return rows.map(toItem);
}
