/**
 * A FILA FISCAL NA TELA — GAP-PRD-020.
 *
 * O trabalhador de fundo (`FiscalQueueWorker`) transmite sozinho; este módulo
 * é o que o GESTOR vê e o que ele pode fazer:
 *
 *  - o PAINEL: o trabalhador está ligado e quando passou por último, quantas
 *    notas esperam (e por quê), a última resposta da SEFAZ à sondagem, e as
 *    pendências que só uma pessoa resolve;
 *  - TRANSMITIR AGORA uma nota: o botão que faltava. A contingência era beco
 *    sem saída pela tela (a rota de reenfileirar existia sem chamador), e a
 *    nota em espera só andava na próxima venda da mesma empresa.
 *
 * Quem decide é gestão — o caixa vê a situação da nota no PDV, mas não
 * atropela o backoff.
 */
import { getConnection } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { recordAudit } from '../audit/AuditService.js';
import { getDocument, type FiscalDocument } from './FiscalDocumentService.js';
import { STATUS_LABEL } from './FiscalPipelineService.js';
import { processNext } from './FiscalQueueService.js';
import {
  listFiscalPendencies,
  requeueFromContingency,
  type FiscalPendency,
} from './FiscalContingencyService.js';
import {
  adapterDaFila,
  estadoDoTrabalhador,
  ultimaSondagem,
  type EscolhedorDeAdapter,
  type EstadoDoTrabalhador,
  type SondagemDaSefaz,
} from './FiscalQueueWorker.js';

export interface ItemDoPainel {
  documentId: string;
  model: string;
  serie: number;
  number: number;
  documentStatus: string;
  queueStatus: string;
  attempts: number;
  nextAttemptAt: string | null;
  lastAttemptAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
}

export interface PainelDaFila {
  trabalhador: EstadoDoTrabalhador;
  sefaz: SondagemDaSefaz | null;
  contagem: {
    /** Na fila, esperando a primeira tentativa. */
    aguardando: number;
    /** Falhou por indisponibilidade e tem nova tentativa marcada. */
    novaTentativa: number;
    /** Desistiu depois das tentativas — precisa de alguém. */
    desistiu: number;
    /** Em envio agora (ou travado por processo que morreu). */
    enviando: number;
  };
  /** O que não terminou, do mais antigo para o mais novo. */
  itens: ItemDoPainel[];
  pendencias: FiscalPendency[];
}

/** O painel da fila de UMA empresa — só dela. */
export function painelDaFila(companyId: string): PainelDaFila {
  ensureCoreSchema();
  const db = getConnection();
  const contagens = db
    .prepare(
      `SELECT status, COUNT(*) AS c FROM core_fiscal_queue
        WHERE company_id = ? AND status IN ('pending', 'retry', 'dead', 'sending')
        GROUP BY status`,
    )
    .all(companyId) as unknown as { status: string; c: number }[];
  const conta = (s: string) => Number(contagens.find((r) => r.status === s)?.c ?? 0);

  const itens = (
    db
      .prepare(
        `SELECT q.document_id, d.model, d.serie, d.number, d.status AS document_status,
                q.status AS queue_status, q.attempts, q.next_attempt_at, q.last_attempt_at,
                q.error_code, q.error_message, q.created_at
           FROM core_fiscal_queue q
           JOIN core_fiscal_documents d ON d.id = q.document_id AND d.company_id = q.company_id
          WHERE q.company_id = ? AND q.status IN ('pending', 'retry', 'dead', 'sending')
          ORDER BY q.created_at
          LIMIT 100`,
      )
      .all(companyId) as unknown as Record<string, unknown>[]
  ).map((r) => ({
    documentId: String(r.document_id),
    model: String(r.model),
    serie: Number(r.serie),
    number: Number(r.number),
    documentStatus: String(r.document_status),
    queueStatus: String(r.queue_status),
    attempts: Number(r.attempts ?? 0),
    nextAttemptAt: (r.next_attempt_at as string | null) ?? null,
    lastAttemptAt: (r.last_attempt_at as string | null) ?? null,
    errorCode: (r.error_code as string | null) ?? null,
    errorMessage: (r.error_message as string | null) ?? null,
    createdAt: String(r.created_at),
  }));

  return {
    trabalhador: estadoDoTrabalhador(),
    sefaz: ultimaSondagem(companyId),
    contagem: {
      aguardando: conta('pending'),
      novaTentativa: conta('retry'),
      desistiu: conta('dead'),
      enviando: conta('sending'),
    },
    itens,
    pendencias: listFiscalPendencies(companyId),
  };
}

export interface ResultadoDaTransmissao {
  document: FiscalDocument;
  statusLabel: string;
  outcome: string | null;
}

/**
 * TRANSMITIR AGORA — o gesto do gestor sobre UMA nota.
 *
 * Vale para a nota na fila (antecipa a nova tentativa, e a que desistiu volta
 * a ser tentada uma vez) e para a que entrou em contingência (volta à fila com
 * o mesmo número, a mesma chave e o mesmo id — `requeueFromContingency`). A
 * transmissão é a de sempre: `processNext`, que CONSULTA antes de reenviar
 * depois de timeout. O adapter é o da procedência da nota, como no
 * trabalhador — o gestor não escolhe provider.
 */
export async function transmitirAgora(input: {
  companyId: string;
  documentId: string;
  userId: string | null;
  escolher?: EscolhedorDeAdapter;
}): Promise<ResultadoDaTransmissao> {
  ensureCoreSchema();
  const db = getConnection();
  let doc = getDocument(input.companyId, input.documentId);
  if (!doc) {
    throw new ApiError('CORE_FISCAL_DOCUMENT_NOT_FOUND', 'Documento fiscal não encontrado.', 404);
  }
  if (doc.status !== 'QUEUED' && doc.status !== 'CONTINGENCY') {
    throw new ApiError(
      'CORE_FISCAL_NOT_IN_QUEUE',
      `Só nota na fila ou em contingência é transmitida por aqui. Esta está como ${doc.status}.`,
      409,
      { status: doc.status },
    );
  }

  const item = db
    .prepare('SELECT * FROM core_fiscal_queue WHERE company_id = ? AND document_id = ?')
    .get(input.companyId, doc.id) as Record<string, unknown> | undefined;
  if (!item) {
    throw new ApiError(
      'CORE_FISCAL_NOT_IN_QUEUE',
      'Esta nota não tem item na fila de transmissão.',
      409,
    );
  }
  const agora = new Date();
  if (
    String(item.status) === 'sending'
    && item.locked_until
    && String(item.locked_until) > agora.toISOString()
  ) {
    throw new ApiError(
      'CORE_FISCAL_ALREADY_SENDING',
      'Esta nota está sendo transmitida agora. Aguarde o retorno antes de tentar de novo.',
      409,
    );
  }

  // A escolha do adapter vem ANTES de mexer em qualquer coisa: sem A1 no
  // cofre, a recusa diz o que falta e a fila fica como estava.
  const escolha = (input.escolher ?? adapterDaFila)(input.companyId, doc, new Map());
  if (escolha.tipo !== 'adapter') {
    throw new ApiError(escolha.codigo, escolha.motivo, 409, { tipo: escolha.tipo });
  }

  if (doc.status === 'CONTINGENCY' && String(item.status) === 'dead') {
    // A volta da contingência: o documento é o MESMO, e o item volta a zero.
    doc = requeueFromContingency({
      companyId: input.companyId,
      documentId: doc.id,
      userId: input.userId,
    });
  } else {
    db.prepare(
      `UPDATE core_fiscal_queue
          SET status = CASE WHEN status IN ('dead', 'sending') THEN 'retry' ELSE status END,
              next_attempt_at = ?, locked_until = NULL, locked_by = NULL, updated_at = ?
        WHERE id = ?`,
    ).run(agora.toISOString(), agora.toISOString(), String(item.id));
  }

  recordAudit({
    companyId: input.companyId,
    userId: input.userId,
    action: 'fiscal.transmit_now',
    entityType: 'fiscal_document',
    entityId: doc.id,
    detail: { queueStatus: String(item.status), attempts: Number(item.attempts ?? 0) },
  });

  // O relógio da transmissão é o de AGORA — depois do reenfileiramento, que
  // marca a nova tentativa para o instante em que roda.
  const r = await processNext({
    companyId: input.companyId,
    adapter: escolha.adapter,
    documentId: doc.id,
    userId: input.userId,
    now: new Date(),
  });

  const atual = getDocument(input.companyId, doc.id)!;
  return {
    document: atual,
    statusLabel: STATUS_LABEL[atual.status] ?? atual.status,
    outcome: r.outcome ?? null,
  };
}
