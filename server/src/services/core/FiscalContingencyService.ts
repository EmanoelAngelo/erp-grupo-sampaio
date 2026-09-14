/**
 * Contingência NFC-e — INFRAESTRUTURA.
 *
 * ============================ AUDITORIA ============================
 *
 * O QUE FOI POSSÍVEL DETERMINAR AQUI:
 *
 * A NFC-e tem modalidade própria de contingência, distinta das da NF-e: a
 * CONTINGÊNCIA OFFLINE, identificada por `tpEmis = 9`. Ela entra na chave de
 * acesso (posição 35) e no campo `tpEmis` do XML — e a infraestrutura deste
 * projeto já carrega os dois, porque `buildAccessKey` e `buildNfceXml` recebem
 * `emissionType` desde o início.
 *
 * O QUE ERA "FUNDAÇÃO" E DEIXOU DE SER (GAP-PRD-098):
 *
 *  1. O PRAZO de transmissão do documento off-line — varia por UF, e o
 *     sistema não chuta: é decisão do CONTADOR, gravada pelo dono em
 *     `core_fiscal_contingency_policies` (tela em Fiscal › Documentos). Sem
 *     prazo, a modalidade off-line não liga.
 *  2. Off-line × EPEC: a NFC-e do RS (as seis operações) usa a off-line
 *     (`tpEmis = 9`); EPEC é da NF-e (e da NFC-e só em SP). A modalidade é
 *     escolhida na mesma política — o padrão seguro é AGUARDAR a SEFAZ.
 *  3. Os dizeres do DANFCE em contingência — "EMITIDA EM CONTINGÊNCIA" e
 *     "Pendente de autorização", do Manual do DANFE NFC-e — saem no
 *     `DanfceRenderer` para nota off-line ainda sem autorização.
 *  4. O QR Code off-line (dia, vNF e digVal da assinatura): `NfceQrOffline`.
 *
 * A montagem com `tpEmis = 9` desde o início, o período de contingência da
 * operação (abre na indisponibilidade confirmada, fecha pela sondagem do
 * trabalhador da fila) e a transmissão ao voltar vivem em
 * `FiscalContingenciaOffline`, `FiscalDocumentService`, `FiscalQueueService`
 * e `FiscalQueueWorker`. Este módulo continua dono do ESTADO do documento em
 * contingência, da volta à fila e das pendências.
 *
 * O que ainda depende de fora — e não de código — está em
 * `CONTINGENCY_EXTERNAL_DEPENDENCIES`.
 *
 * ===================================================================
 *
 * A REGRA QUE MAIS IMPORTA AQUI: contingência é resposta a INDISPONIBILIDADE,
 * não a erro de dado. NCM errado, CNPJ inválido ou produto incompleto não
 * entram em contingência — entrar seria empurrar para frente uma nota que
 * jamais será aceita, e o prazo correria contra ela.
 */
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { recordAudit } from '../audit/AuditService.js';
import { getDocument, transition, type FiscalDocument } from './FiscalDocumentService.js';
import type { SefazOutcome } from './SefazAdapter.js';

/**
 * Estado honesto desta implementação: a contingência off-line da NFC-e está
 * IMPLEMENTADA; ligá-la é decisão do contador, e a homologação real é da SEFAZ.
 * Não é homologação de nada.
 */
export const CONTINGENCY_STATUS = 'OFFLINE_NFCE_IMPLEMENTED_PENDING_ACCOUNTANT_DECISION' as const;

/** O que falta, e depende de fonte externa — não de mais código. */
export const CONTINGENCY_EXTERNAL_DEPENDENCIES = [
  'Modalidade (aguardar a SEFAZ ou NFC-e off-line, tpEmis 9) e prazo de transmissão da UF, '
    + 'decididos pelo contador e gravados em Fiscal › Documentos.',
  'CSC da operação, para o QR Code da NFC-e off-line.',
  'Homologação real de uma NFC-e emitida em contingência off-line na SVRS, com o A1 do grupo.',
] as const;

/** `tpEmis` da contingência offline da NFC-e. */
export const TP_EMIS_OFFLINE = '9';

/**
 * Motivos que TORNAM a contingência elegível.
 *
 * Todos são indisponibilidade — do serviço ou do caminho até ele. Nenhum é
 * problema do documento.
 */
export type ContingencyReason =
  | 'SEFAZ_UNAVAILABLE'
  | 'NETWORK_UNAVAILABLE'
  | 'TRANSPORT_ERROR';

const REASON_LABEL: Record<ContingencyReason, string> = {
  SEFAZ_UNAVAILABLE: 'SEFAZ indisponível',
  NETWORK_UNAVAILABLE: 'Sem conexão com a internet',
  TRANSPORT_ERROR: 'Falha de comunicação com a SEFAZ',
};

export function contingencyReasonLabel(reason: string | null): string {
  return REASON_LABEL[reason as ContingencyReason] ?? reason ?? 'Motivo não registrado';
}

/**
 * O desfecho justifica contingência?
 *
 * REJEIÇÃO NÃO ENTRA, e essa é a regra central. Uma nota recusada por CNPJ
 * inválido continuará recusada amanhã; colocá-la em contingência só faria o
 * prazo correr contra um documento que nunca será aceito, escondendo o erro
 * de cadastro atrás de um estado que parece transitório.
 *
 * TIMEOUT também não entra aqui: ele exige CONSULTA primeiro, porque a SEFAZ
 * pode ter autorizado. Só depois de a consulta não encontrar nada é que o
 * caminho de indisponibilidade se aplica.
 */
export function isEligibleForContingency(outcome: SefazOutcome): boolean {
  return (
    outcome === 'SERVICE_DOWN'
    || outcome === 'TRANSPORT_ERROR'
  );
}

/** Traduz o desfecho técnico no motivo que vai para o histórico. */
export function reasonFromOutcome(outcome: SefazOutcome): ContingencyReason | null {
  if (outcome === 'SERVICE_DOWN') return 'SEFAZ_UNAVAILABLE';
  if (outcome === 'TRANSPORT_ERROR') return 'NETWORK_UNAVAILABLE';
  return null;
}

function registrarEvento(input: {
  companyId: string;
  documentId: string;
  eventType: string;
  detail?: Record<string, unknown>;
  userId?: string | null;
}): void {
  getConnection()
    .prepare(
      `INSERT INTO core_fiscal_events
         (id, company_id, document_id, event_type, sequence, justification, user_id, created_at)
       VALUES (lower(hex(randomblob(16))), ?, ?, ?, 1, ?, ?, ?)`,
    )
    .run(
      input.companyId,
      input.documentId,
      input.eventType,
      input.detail ? JSON.stringify(input.detail) : null,
      input.userId ?? null,
      new Date().toISOString(),
    );

  recordAudit({
    companyId: input.companyId,
    userId: input.userId ?? null,
    action: `fiscal.${input.eventType}`,
    entityType: 'fiscal_document',
    entityId: input.documentId,
    detail: input.detail,
  });
}

/**
 * Coloca o documento em contingência.
 *
 * NÃO gera documento novo, NÃO renumera e NÃO troca a chave. O documento é o
 * mesmo — muda o estado e o motivo. Gerar outro produziria duas notas para a
 * mesma venda, que é exatamente o que a contingência não pode causar.
 *
 * O `tpEmis` NÃO é alterado no XML já assinado: mudar o tipo de emissão muda a
 * chave de acesso, e a chave já foi assinada. Um documento que precise sair
 * como offline de verdade terá que ser montado assim desde o início — o que
 * depende das regras externas ainda pendentes.
 */
export function enterContingency(input: {
  companyId: string;
  documentId: string;
  reason: ContingencyReason;
  triggerCode?: string | null;
  triggerMessage?: string | null;
  userId?: string | null;
}): FiscalDocument {
  ensureCoreSchema();

  const doc = getDocument(input.companyId, input.documentId);
  if (!doc) {
    throw new ApiError('CORE_FISCAL_DOCUMENT_NOT_FOUND', 'Documento fiscal não encontrado.', 404);
  }
  if (!REASON_LABEL[input.reason]) {
    throw new ApiError(
      'CORE_CONTINGENCY_REASON_INVALID',
      'Contingência exige um motivo de indisponibilidade. Erro de dado fiscal não é contingência.',
      400,
    );
  }

  const now = new Date().toISOString();
  const atualizado = transition({
    companyId: input.companyId,
    documentId: input.documentId,
    to: 'CONTINGENCY',
    patch: {
      contingency_mode: 'OFFLINE',
      contingency_reason: input.reason,
      contingency_started_at: now,
      contingency_ended_at: null,
      pending_transmission: 1,
      trigger_code: input.triggerCode ?? null,
      x_motivo: input.triggerMessage ?? REASON_LABEL[input.reason],
    },
    detail: { reason: input.reason, triggerCode: input.triggerCode },
    userId: input.userId,
  });

  registrarEvento({
    companyId: input.companyId,
    documentId: input.documentId,
    eventType: 'contingency_started',
    detail: {
      reason: input.reason,
      label: REASON_LABEL[input.reason],
      triggerCode: input.triggerCode,
      // Deixa explícito no histórico que a regra legal está pendente.
      status: CONTINGENCY_STATUS,
    },
    userId: input.userId,
  });

  return atualizado;
}

/**
 * Devolve o documento à fila quando a condição melhora.
 *
 * O documento é o MESMO: mesmo número, mesma chave, mesmo id. Só volta a ser
 * transmitido. Substituí-lo por outro seria gerar uma segunda NFC-e para a
 * mesma venda — silenciosamente.
 */
export function requeueFromContingency(input: {
  companyId: string;
  documentId: string;
  userId?: string | null;
}): FiscalDocument {
  ensureCoreSchema();

  const doc = getDocument(input.companyId, input.documentId);
  if (!doc) {
    throw new ApiError('CORE_FISCAL_DOCUMENT_NOT_FOUND', 'Documento fiscal não encontrado.', 404);
  }
  if (doc.status !== 'CONTINGENCY') {
    throw new ApiError(
      'CORE_CONTINGENCY_NOT_ACTIVE',
      `Só documento em contingência volta para a fila. Este está como ${doc.status}.`,
      409,
    );
  }

  registrarEvento({
    companyId: input.companyId,
    documentId: input.documentId,
    eventType: 'connection_restored',
    userId: input.userId,
  });

  /*
    O ITEM DA FILA TAMBÉM VOLTA — senão a volta não é volta.

    O documento ia para QUEUED e o item continuava `dead`, que é o estado de
    quem não é mais reivindicado. A nota entrava em contingência e ficava
    esperando um worker que nunca ia pegá-la: transição sem fila é promessa
    sem entrega.

    As tentativas voltam a zero de propósito: a contingência aconteceu porque
    a SEFAZ estava fora, e reabrir com o contador esgotado faria a nota morrer
    na primeira tentativa depois de a conexão voltar.
  */
  getConnection()
    .prepare(
      `UPDATE core_fiscal_queue
          SET status = 'pending', attempts = 0, locked_until = NULL, locked_by = NULL,
              next_attempt_at = ?, error_code = NULL, error_message = NULL, updated_at = ?
        WHERE company_id = ? AND document_id = ?`,
    )
    .run(new Date().toISOString(), new Date().toISOString(), input.companyId, input.documentId);

  const atualizado = transition({
    companyId: input.companyId,
    documentId: input.documentId,
    to: 'QUEUED',
    userId: input.userId,
  });

  registrarEvento({
    companyId: input.companyId,
    documentId: input.documentId,
    eventType: 'requeue',
    detail: { number: doc.number, accessKey: doc.accessKey },
    userId: input.userId,
  });

  return atualizado;
}

/**
 * Encerra a contingência.
 *
 * Chamado quando o documento alcança desfecho — autorizado ou rejeitado. O
 * registro de que ESTEVE em contingência permanece: apagar o histórico
 * esconderia justamente o período que alguém vai querer auditar.
 */
export function finishContingency(input: {
  companyId: string;
  documentId: string;
  userId?: string | null;
}): void {
  ensureCoreSchema();

  withTransaction(() => {
    getConnection()
      .prepare(
        `UPDATE core_fiscal_documents
            SET contingency_ended_at = ?, pending_transmission = 0, updated_at = ?
          WHERE id = ? AND company_id = ? AND contingency_started_at IS NOT NULL`,
      )
      .run(new Date().toISOString(), new Date().toISOString(), input.documentId, input.companyId);
  });

  registrarEvento({
    companyId: input.companyId,
    documentId: input.documentId,
    eventType: 'contingency_finished',
    userId: input.userId,
  });
}

export interface ContingencyView {
  active: boolean;
  mode: string | null;
  reason: string | null;
  reasonLabel: string;
  startedAt: string | null;
  endedAt: string | null;
  pendingTransmission: boolean;
  /** Estado honesto: infraestrutura pronta, regra legal pendente. */
  legalStatus: typeof CONTINGENCY_STATUS;
  externalDependencies: readonly string[];
}

export function contingencyView(companyId: string, documentId: string): ContingencyView | null {
  ensureCoreSchema();
  const row = getConnection()
    .prepare(
      `SELECT status, contingency_mode, contingency_reason, contingency_started_at,
              contingency_ended_at, pending_transmission
         FROM core_fiscal_documents WHERE company_id = ? AND id = ?`,
    )
    .get(companyId, documentId) as Record<string, unknown> | undefined;

  if (!row || !row.contingency_started_at) return null;

  return {
    active: String(row.status) === 'CONTINGENCY',
    mode: (row.contingency_mode as string | null) ?? null,
    reason: (row.contingency_reason as string | null) ?? null,
    reasonLabel: contingencyReasonLabel((row.contingency_reason as string | null) ?? null),
    startedAt: (row.contingency_started_at as string | null) ?? null,
    endedAt: (row.contingency_ended_at as string | null) ?? null,
    pendingTransmission: row.pending_transmission === 1,
    legalStatus: CONTINGENCY_STATUS,
    externalDependencies: CONTINGENCY_EXTERNAL_DEPENDENCIES,
  };
}

// ------------------------------------------------- pendências fiscais

export interface FiscalPendency {
  documentId: string;
  saleId: string | null;
  number: number;
  status: string;
  kind:
    | 'REJECTED'
    | 'ERROR'
    | 'SENDING_TOO_LONG'
    | 'CONTINGENCY_PENDING'
    | 'QUEUE_DEAD'
    /** Na fila há mais de meia hora — a fila tenta sozinha, mas alguém precisa saber (GAP-PRD-020). */
    | 'TRANSMISSION_DELAYED'
    /** NFC-e off-line que passou do prazo de transmissão decidido pelo contador (GAP-PRD-098). */
    | 'CONTINGENCY_OVERDUE';
  label: string;
  since: string;
  /** Até quando a NFC-e off-line precisa chegar à SEFAZ. Só nas notas off-line com prazo decidido. */
  deadline?: string | null;
}

/** "11/09 14:30" no relógio da loja — a tela e o selo do PDV mostram a frase pronta. */
function horaDaLoja(iso: string): string {
  return new Date(iso).toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Depois disto, um envio parado deixa de ser normal. */
const SENDING_STALE_MINUTES = 30;

/**
 * O que o operador precisa resolver.
 *
 * NÃO conta nota autorizada, nem documento andando normalmente pela fila —
 * contá-los transformaria o alerta em ruído, e um alerta que está sempre aceso
 * deixa de ser lido.
 */
export function listFiscalPendencies(companyId: string): FiscalPendency[] {
  ensureCoreSchema();
  const limite = new Date(Date.now() - SENDING_STALE_MINUTES * 60_000).toISOString();

  const rows = getConnection()
    .prepare(
      `SELECT d.id, d.sale_id, d.number, d.status, d.updated_at, d.contingency_started_at,
              d.pending_transmission, d.access_key, d.issued_at,
              (SELECT q.status FROM core_fiscal_queue q WHERE q.document_id = d.id LIMIT 1) AS queue_status,
              (SELECT q.error_message FROM core_fiscal_queue q WHERE q.document_id = d.id LIMIT 1) AS queue_error
         FROM core_fiscal_documents d
        WHERE d.company_id = ?
          AND (
            d.status IN ('REJECTED', 'ERROR')
            OR (d.status = 'SENDING' AND d.updated_at < ?)
            OR (d.status = 'CONTINGENCY' AND d.pending_transmission = 1)
            OR EXISTS (SELECT 1 FROM core_fiscal_queue q
                        WHERE q.document_id = d.id AND q.status = 'dead')
            /*
              A NOTA QUE ESPERA HÁ MEIA HORA (GAP-PRD-020). "Andando normalmente
              pela fila" é minuto, não hora: depois disso é SEFAZ fora, rede
              caída ou A1 fora do cofre — a fila tenta sozinha, mas o caixa que
              entregou o cupom e o gestor precisam saber antes do "desistiu".
            */
            OR (d.status = 'QUEUED' AND EXISTS (
                  SELECT 1 FROM core_fiscal_queue q
                   WHERE q.document_id = d.id AND q.status IN ('pending', 'retry', 'sending')
                     AND q.created_at < ?))
          )
        ORDER BY d.updated_at DESC
        LIMIT 200`,
    )
    .all(companyId, limite, limite) as unknown as Record<string, unknown>[];

  // O prazo da nota off-line é o que o contador decidiu (GAP-PRD-098).
  const politica = getConnection()
    .prepare('SELECT mode, deadline_hours FROM core_fiscal_contingency_policies WHERE company_id = ?')
    .get(companyId) as { mode: string; deadline_hours: number | null } | undefined;
  const prazoHoras = Number(politica?.deadline_hours ?? 0);
  const agora = Date.now();

  return rows.map((r) => {
    const status = String(r.status);
    let kind: FiscalPendency['kind'] = 'ERROR';
    let label = 'Erro fiscal';
    let deadline: string | null = null;
    const offline = String(r.access_key ?? '').charAt(34) === '9';

    if (String(r.queue_status) === 'dead') {
      kind = 'QUEUE_DEAD';
      label = 'Transmissão desistiu após várias tentativas';
    } else if (status === 'REJECTED') {
      kind = 'REJECTED';
      label = 'NFC-e rejeitada';
    } else if (status === 'CONTINGENCY' && offline) {
      // A NFC-e off-line: o cupom foi entregue e o prazo corre (GAP-PRD-098).
      deadline = prazoHoras > 0 && r.issued_at
        ? new Date(new Date(String(r.issued_at)).getTime() + prazoHoras * 3_600_000).toISOString()
        : null;
      if (deadline && new Date(deadline).getTime() < agora) {
        kind = 'CONTINGENCY_OVERDUE';
        label = `NFC-e off-line FORA DO PRAZO de transmissão (venceu ${horaDaLoja(deadline)}) — `
          + 'transmita agora e avise o contador';
      } else {
        kind = 'CONTINGENCY_PENDING';
        label = deadline
          ? `Emitida em contingência off-line — transmitir até ${horaDaLoja(deadline)}`
          : 'Emitida em contingência off-line, aguardando transmissão';
      }
    } else if (status === 'CONTINGENCY') {
      kind = 'CONTINGENCY_PENDING';
      label = 'Em contingência, aguardando transmissão';
    } else if (status === 'SENDING') {
      kind = 'SENDING_TOO_LONG';
      label = 'Enviando há tempo demais — precisa ser consultada';
    } else if (status === 'QUEUED') {
      kind = 'TRANSMISSION_DELAYED';
      label = r.queue_error
        ? `Aguardando transmissão há mais de ${SENDING_STALE_MINUTES} min: ${String(r.queue_error)}`
        : `Aguardando transmissão há mais de ${SENDING_STALE_MINUTES} min — a fila tenta sozinha`;
    }

    return {
      documentId: String(r.id),
      saleId: (r.sale_id as string | null) ?? null,
      number: Number(r.number),
      status,
      kind,
      label,
      since: String(r.contingency_started_at ?? r.updated_at),
      deadline,
    };
  });
}
