/**
 * ============================================================================
 * A FILA DE IMPRESSÃO DO AGENTE LOCAL (GAP-PRD-082)
 * ============================================================================
 *
 * O servidor já gerava o cupom em ESC/POS (`EscPos.ts`) e já modelava a
 * impressora de agente (`core_printers.transport = 'agent'`) — e nenhum
 * programa consumia nada disso: o cupom saía pela caixa de diálogo do
 * navegador e a gaveta abria pela chave. O consumidor é o MESMO agente local
 * que fala com o PinPad (`server/src/local-agent`), pareado por caixa e
 * identificado pela assinatura HMAC do segredo do pareamento.
 *
 * O ciclo de um job de agente:
 *
 *   ready     nasceu com o documento e o transporte `agent` (`createPrintJob`).
 *   printing  o agente DAQUELE caixa retirou (long-poll) e recebeu os bytes.
 *   printed   o agente escreveu na impressora e confirmou.
 *   failed    o agente não conseguiu (sem papel, cabo, endereço), ou o prazo
 *             venceu — ver abaixo.
 *
 * ## Os prazos, e por que a gaveta tem o mais curto
 *
 *   retirar    10 min para cupom e teste: cupom da venda de uma hora atrás
 *              saindo do nada quando o agente volta confunde mais do que ajuda
 *              — a segunda via existe para isso.
 *   gaveta     1 min: o pulso que ninguém retirou NUNCA abre depois. Uma
 *              gaveta que abre sozinha minutos depois do pedido é dinheiro
 *              exposto sem ninguém olhando.
 *   confirmar  2 min depois de retirado: sem resposta, o job vai a `failed`
 *              com a frase de conferir a impressora. Uma confirmação que chega
 *              atrasada ainda é gravada — o papel saiu, e isso é o que vale.
 */
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { recordAudit } from '../audit/AuditService.js';
import { cupomEscPosDaVenda, paginaDeTesteEscPos, pulsoDaGaveta } from './EscPos.js';
import { AVISOS_DE_IMPRESSAO, DOCUMENT_LABEL, type DocumentType, type PrintJob } from './PrintEngine.js';
import { colunasDaBobina } from './PapelDaLoja.js';

export const PRAZO_PARA_RETIRAR_MS = 10 * 60_000;
export const PRAZO_DA_GAVETA_MS = 60_000;
export const PRAZO_PARA_CONFIRMAR_MS = 2 * 60_000;

export interface AgenteDaFila {
  agentId: string;
  companyId: string;
  pdvTerminalId: string | null;
}

export interface ImpressaoEntregue {
  jobId: string;
  documentType: DocumentType;
  documentLabel: string;
  copies: number;
  openDrawer: boolean;
  printer: { id: string; name: string; device: string; columns: 32 | 48 };
  /** Todas as vias juntas, prontas para escrever de uma vez na impressora. */
  escposBase64: string;
  createdAt: string;
}

const FRASE_GAVETA_VENCIDA =
  'O pulso da gaveta não foi retirado pelo agente em 1 minuto: por segurança a gaveta NÃO abre depois. Peça de novo.';
const FRASE_NAO_RETIRADO =
  'O agente não retirou esta impressão em 10 minutos (estava fora do ar?). Reimprima pela tela se ainda precisar.';
const FRASE_NAO_CONFIRMADO =
  'O agente retirou a impressão e não confirmou em 2 minutos. Confira a impressora (papel, tampa, cabo) e reimprima se não saiu.';

function antes(ms: number, agora: number): string {
  return new Date(agora - ms).toISOString();
}

/** Os prazos vencidos viram `failed` com a frase certa — antes de entregar qualquer coisa. */
export function expirarImpressoesVencidas(companyId: string, agora = Date.now()): number {
  ensureCoreSchema();
  const db = getConnection();
  let n = 0;
  n += Number(
    db
      .prepare(
        `UPDATE core_print_jobs SET status = 'failed', error = ?
          WHERE company_id = ? AND transport = 'agent' AND status = 'ready'
            AND document_type = 'DRAWER_PULSE' AND created_at < ?`,
      )
      .run(FRASE_GAVETA_VENCIDA, companyId, antes(PRAZO_DA_GAVETA_MS, agora)).changes,
  );
  n += Number(
    db
      .prepare(
        `UPDATE core_print_jobs SET status = 'failed', error = ?
          WHERE company_id = ? AND transport = 'agent' AND status = 'ready'
            AND document_type <> 'DRAWER_PULSE' AND created_at < ?`,
      )
      .run(FRASE_NAO_RETIRADO, companyId, antes(PRAZO_PARA_RETIRAR_MS, agora)).changes,
  );
  n += Number(
    db
      .prepare(
        `UPDATE core_print_jobs SET status = 'failed', error = ?
          WHERE company_id = ? AND transport = 'agent' AND status = 'printing' AND claimed_at < ?`,
      )
      .run(FRASE_NAO_CONFIRMADO, companyId, antes(PRAZO_PARA_CONFIRMAR_MS, agora)).changes,
  );
  return n;
}

interface JobComImpressora extends PrintJob {
  printer_name: string;
  printer_device: string | null;
  paper_width_mm: number | null;
}

/*
  57 mm É A BOBINA DE 58 (auditoria do cupom, F-17).

  Era `larguraMm === 58 ? 32 : 48`: quem cadastrasse a térmica pela API com a
  medida escrita na bobina (57) ganhava 48 colunas numa impressora de 32, e
  toda linha de hífens e todo "rótulo…valor" quebrava. A régua agora é a de
  `PapelDaLoja`: abaixo de 70 mm é a bobina estreita.
*/
export function colunasDa(larguraMm: number | null): 32 | 48 {
  return colunasDaBobina(larguraMm);
}

function juntar(partes: Uint8Array[]): Uint8Array {
  const total = partes.reduce((s, p) => s + p.length, 0);
  const saida = new Uint8Array(total);
  let pos = 0;
  for (const p of partes) {
    saida.set(p, pos);
    pos += p.length;
  }
  return saida;
}

/** Os bytes do job, TODAS as vias — o pulso da gaveta só na primeira. */
export function bytesDoJob(companyId: string, job: PrintJob, colunas: 32 | 48, impressora: string): Uint8Array {
  const vias = Math.max(1, Number(job.copies ?? 1));
  switch (job.document_type) {
    case 'PDV_RECEIPT':
    case 'SALE_RECEIPT': {
      const partes: Uint8Array[] = [];
      for (let i = 0; i < vias; i += 1) {
        partes.push(
          cupomEscPosDaVenda(companyId, job.document_id, { abrirGaveta: i === 0 && job.open_drawer === 1, colunas }),
        );
      }
      return juntar(partes);
    }
    case 'PRINTER_TEST': {
      const empresa = getConnection()
        .prepare('SELECT trade_name FROM core_companies WHERE id = ?')
        .get(companyId) as { trade_name?: string } | undefined;
      return paginaDeTesteEscPos({
        loja: empresa?.trade_name ?? 'Loja',
        impressora,
        quando: new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
        colunas,
      });
    }
    case 'DRAWER_PULSE':
      return pulsoDaGaveta();
    default:
      throw new ApiError(
        'CORE_PRINT_ESCPOS_UNSUPPORTED',
        `Não há cupom térmico para ${job.document_type}.`,
        400,
      );
  }
}

/**
 * Retira os jobs deste agente: da operação dele, do caixa dele (sem caixa com
 * sem caixa), prontos, pelo agente. Cada retirada é atômica — dois agentes do
 * mesmo caixa nunca imprimem o mesmo job.
 */
export function retirarImpressoes(agente: AgenteDaFila, agora = Date.now()): ImpressaoEntregue[] {
  ensureCoreSchema();
  expirarImpressoesVencidas(agente.companyId, agora);
  const db = getConnection();
  const candidatos = db
    .prepare(
      `SELECT j.*, p.name AS printer_name, p.agent_device AS printer_device, p.paper_width_mm AS paper_width_mm
         FROM core_print_jobs j
         JOIN core_printers p ON p.id = j.printer_id
        WHERE j.company_id = ? AND j.transport = 'agent' AND j.status = 'ready'
          AND j.pdv_terminal_id IS ?
        ORDER BY j.created_at LIMIT 10`,
    )
    .all(agente.companyId, agente.pdvTerminalId) as unknown as JobComImpressora[];

  const entregues: ImpressaoEntregue[] = [];
  for (const job of candidatos) {
    const claimed = new Date(agora).toISOString();
    const pegou = withTransaction(
      () =>
        Number(
          db
            .prepare(
              `UPDATE core_print_jobs
                  SET status = 'printing', attempts = attempts + 1, agent_id = ?, claimed_at = ?
                WHERE id = ? AND status = 'ready'`,
            )
            .run(agente.agentId, claimed, job.id).changes,
        ) === 1,
    );
    if (!pegou) continue;
    const colunas = colunasDa(job.paper_width_mm);
    let bytes: Uint8Array;
    try {
      bytes = bytesDoJob(agente.companyId, job, colunas, job.printer_name);
    } catch (err) {
      db.prepare(`UPDATE core_print_jobs SET status = 'failed', error = ? WHERE id = ?`).run(
        `Não foi possível montar o cupom: ${err instanceof Error ? err.message : String(err)}`,
        job.id,
      );
      continue;
    }
    entregues.push({
      jobId: job.id,
      documentType: job.document_type,
      documentLabel: DOCUMENT_LABEL[job.document_type] ?? job.document_type,
      copies: Number(job.copies ?? 1),
      openDrawer: job.open_drawer === 1,
      printer: { id: String(job.printer_id), name: job.printer_name, device: String(job.printer_device ?? ''), columns: colunas },
      escposBase64: Buffer.from(bytes).toString('base64'),
      createdAt: job.created_at,
    });
  }
  return entregues;
}

/** Long-poll: devolve na hora se houver, senão espera um aviso (até 25 s). */
export async function aguardarImpressoes(agente: AgenteDaFila, esperaMs: number): Promise<ImpressaoEntregue[]> {
  const agora = retirarImpressoes(agente);
  const espera = Math.max(0, Math.min(25_000, Number.isFinite(esperaMs) ? esperaMs : 0));
  if (agora.length > 0 || espera === 0) return agora;
  await new Promise<void>((resolve) => {
    const fim = setTimeout(pronto, espera);
    function pronto() {
      clearTimeout(fim);
      AVISOS_DE_IMPRESSAO.off(agente.companyId, pronto);
      resolve();
    }
    AVISOS_DE_IMPRESSAO.on(agente.companyId, pronto);
  });
  return retirarImpressoes(agente);
}

/**
 * O agente conta o que aconteceu com o job. Só o agente que o retirou pode
 * contar — de outro, a resposta é a mesma de job inexistente. Repetir o mesmo
 * resultado (rede que falhou na volta) devolve `duplicate`.
 */
export function registrarResultadoDaImpressao(
  agente: AgenteDaFila,
  jobId: string,
  corpo: { status?: unknown; message?: unknown },
): { jobId: string; status: 'printed' | 'failed'; duplicate: boolean } {
  ensureCoreSchema();
  const status = corpo?.status === 'printed' ? 'printed' : corpo?.status === 'failed' ? 'failed' : null;
  if (!status) {
    throw new ApiError('CORE_PRINT_RESULT_INVALID', 'O resultado da impressão é "printed" ou "failed".', 400);
  }
  const mensagem = corpo?.message == null ? null : String(corpo.message).slice(0, 500);
  const db = getConnection();
  const job = db
    .prepare('SELECT * FROM core_print_jobs WHERE id = ? AND company_id = ?')
    .get(jobId, agente.companyId) as PrintJob | undefined;
  if (!job || job.transport !== 'agent' || job.agent_id !== agente.agentId) {
    throw new ApiError('CORE_PRINT_JOB_NOT_FOUND', 'Job de impressão não encontrado para este agente.', 404);
  }
  if (job.status === status) return { jobId, status, duplicate: true };

  const agoraIso = new Date().toISOString();
  if (job.status === 'printing' || (job.status === 'failed' && status === 'printed')) {
    // A confirmação atrasada (depois do prazo) ainda vale: o papel saiu.
    db.prepare(
      `UPDATE core_print_jobs SET status = ?, error = ?, printed_at = ? WHERE id = ?`,
    ).run(status, status === 'failed' ? (mensagem ?? 'O agente não conseguiu imprimir.') : null, status === 'printed' ? agoraIso : null, jobId);
  } else {
    throw new ApiError(
      'CORE_PRINT_TRANSITION_INVALID',
      `Job em "${job.status}" não pode ir para "${status}".`,
      409,
      { from: job.status, to: status },
    );
  }

  if (job.document_type === 'DRAWER_PULSE' && status === 'printed') {
    // A gaveta abriu SEM venda: quem pediu, por quê, em que caixa, por qual agente.
    recordAudit({
      companyId: agente.companyId,
      userId: job.created_by,
      action: 'cash.drawer.opened_by_command',
      entityType: 'print_job',
      entityId: jobId,
      detail: { reason: job.reason, pdvTerminalId: job.pdv_terminal_id, agentId: agente.agentId },
    });
  } else if (status === 'failed') {
    recordAudit({
      companyId: agente.companyId,
      userId: null,
      action: 'print.job.agent_failed',
      entityType: 'print_job',
      entityId: jobId,
      detail: { documentType: job.document_type, message: mensagem, agentId: agente.agentId },
    });
  }
  return { jobId, status, duplicate: false };
}
