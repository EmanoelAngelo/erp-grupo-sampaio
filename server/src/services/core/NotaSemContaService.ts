/**
 * ============================================================================
 * A NOTA RECEBIDA SEM CONTA A PAGAR — o caminho da decisão (GAP-PRD-088)
 * ============================================================================
 *
 * Desde o GAP-V21, confirmar a nota cria a dívida na MESMA transação que o
 * estoque, e a varredura de `nfe-conferencia-financeiro` impede o buraco de
 * reabrir. O que ficou para trás é o passado: uma nota real (NF 9991, Preço
 * Justo, R$ 1.485,60) confirmada ANTES do conserto, recebida e sem título. O
 * código decidiu — com razão — não fabricar dívida retroativa: aquele valor
 * pode já ter sido pago por fora, e cobrá-lo de novo seria pior que a lacuna.
 *
 * O que faltava era o MECANISMO da decisão, que é do dono. Aqui:
 *
 *   1. A LISTA: toda nota recebida, com total > 0, sem título a pagar de
 *      origem própria e sem decisão registrada. Não some por silêncio.
 *
 *   2. OS TRÊS GESTOS, cada um deixando prova:
 *        lancar      cria o título em aberto (vencimento escolhido; padrão:
 *                    recebimento + prazo do fornecedor);
 *        ja_paga     cria o título e dá a baixa inteira, com a forma e a data
 *                    em que foi paga por fora na observação;
 *        sem_divida  a nota NÃO gera conta (bonificação, consignação, troca):
 *                    grava a justificativa na própria nota, com autor e data.
 *
 * O título nasce com a MESMA origem que a confirmação daria ('nfe_entrada' ou
 * 'entrada_manual', origin_id = nota) — a ficha da nota o acha de volta, e a
 * UNIQUE do financeiro impede o segundo título para a mesma nota.
 *
 * Nada disto roda sozinho: nenhuma migração, nenhum boot mexe na NF 9991. Ela
 * aparece na lista para o dono decidir.
 */
import { randomUUID } from 'node:crypto';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { diaDaLoja, hojeNaLoja, somarDias } from './CalendarioOperacional.js';
import { settleEntry } from './FinanceService.js';
import { systemCategoryId } from './FinanceSetupService.js';
import { NOTA_RECEBIDA } from './InboundNoteStatus.js';
import { recordDomainEvent } from '../sync/DomainEvents.js';

export interface NotaSemConta {
  id: string;
  number: string | null;
  docType: string;
  accessKey: string;
  supplierId: string | null;
  supplierName: string | null;
  totalCents: number;
  receivedAt: string | null;
  /** O vencimento que o gesto "lançar" usaria sem ser informado. */
  vencimentoSugerido: string;
}

const SEM_TITULO = `
  n.company_id = ? AND n.status = ? AND n.total_cents > 0
  AND n.finance_waiver_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM core_finance_entries e
     WHERE e.company_id = n.company_id AND e.origin_id = n.id AND e.direction = 'out'
       AND e.origin_type IN ('nfe_entrada', 'entrada_manual')
  )`;

function vencimentoPadrao(receivedAt: string | null, prazoDias: number | null): string {
  const base = receivedAt ? diaDaLoja(receivedAt) : hojeNaLoja();
  return somarDias(base, Math.max(0, Number(prazoDias) || 0));
}

export function notasRecebidasSemConta(companyId: string): NotaSemConta[] {
  ensureCoreSchema();
  const linhas = getConnection()
    .prepare(
      `SELECT n.id, n.number, n.doc_type, n.access_key, n.supplier_id, n.total_cents,
              n.received_at, s.name AS supplier_name, s.payment_term_days
         FROM core_inbound_notes n
         LEFT JOIN core_suppliers s ON s.id = n.supplier_id
        WHERE ${SEM_TITULO}
        ORDER BY n.received_at, n.id`,
    )
    .all(companyId, NOTA_RECEBIDA) as unknown as {
    id: string;
    number: string | null;
    doc_type: string | null;
    access_key: string;
    supplier_id: string | null;
    total_cents: number;
    received_at: string | null;
    supplier_name: string | null;
    payment_term_days: number | null;
  }[];
  return linhas.map((l) => ({
    id: l.id,
    number: l.number,
    docType: String(l.doc_type ?? 'nfe'),
    accessKey: l.access_key,
    supplierId: l.supplier_id,
    supplierName: l.supplier_name,
    totalCents: Number(l.total_cents),
    receivedAt: l.received_at,
    vencimentoSugerido: vencimentoPadrao(l.received_at, l.payment_term_days),
  }));
}

export type DecisaoDaNota = 'lancar' | 'ja_paga' | 'sem_divida';

export interface ResultadoDaDecisao {
  noteId: string;
  acao: DecisaoDaNota;
  /** O título criado (lancar/ja_paga); nulo em sem_divida. */
  entryId: string | null;
}

function dataValida(texto: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(texto) && !Number.isNaN(Date.parse(`${texto}T12:00:00Z`));
}

export function decidirContaDaNota(input: {
  companyId: string;
  noteId: string;
  userId: string;
  acao: DecisaoDaNota;
  /** lancar: vencimento (padrão: recebimento + prazo do fornecedor). */
  dueDate?: string | null;
  /** ja_paga: quando foi paga, e como. */
  paidOn?: string | null;
  method?: string | null;
  /** sem_divida (obrigatório) e observação livre nos outros dois. */
  reason?: string | null;
}): ResultadoDaDecisao {
  ensureCoreSchema();
  if (!['lancar', 'ja_paga', 'sem_divida'].includes(input.acao)) {
    throw new ApiError(
      'CORE_NOTE_FINANCE_DECISION_INVALID',
      'Escolha o que fazer: lançar a conta, lançar já paga, ou declarar que a nota não gera conta.',
      400,
    );
  }
  const motivo = String(input.reason ?? '').trim();

  return withTransaction(() => {
    const db = getConnection();
    const nota = db
      .prepare(
        `SELECT n.id, n.number, n.doc_type, n.access_key, n.supplier_id, n.total_cents,
                n.received_at, n.status, s.payment_term_days
           FROM core_inbound_notes n
           LEFT JOIN core_suppliers s ON s.id = n.supplier_id
          WHERE n.id = ? AND n.company_id = ?`,
      )
      .get(input.noteId, input.companyId) as
      | {
          id: string;
          number: string | null;
          doc_type: string | null;
          access_key: string;
          supplier_id: string | null;
          total_cents: number;
          received_at: string | null;
          status: string;
          payment_term_days: number | null;
        }
      | undefined;
    if (!nota) throw new ApiError('CORE_INBOUND_NOTE_NOT_FOUND', 'Nota não encontrada.', 404);

    // Só a nota que ESTÁ na lista admite decisão: recebida, total > 0, sem
    // título e sem decisão anterior. Qualquer outra já tem a sua resposta.
    const pendente = db
      .prepare(`SELECT 1 FROM core_inbound_notes n WHERE n.id = ? AND ${SEM_TITULO}`)
      .get(input.noteId, input.companyId, NOTA_RECEBIDA);
    if (!pendente) {
      throw new ApiError(
        'CORE_NOTE_FINANCE_ALREADY_DECIDED',
        'Esta nota não está pendente: ou ainda não foi recebida, ou tem total zero, ou já tem conta '
          + 'a pagar, ou a decisão já foi registrada.',
        409,
      );
    }

    const agora = new Date().toISOString();
    if (input.acao === 'sem_divida') {
      if (motivo.length < 5) {
        throw new ApiError(
          'CORE_NOTE_FINANCE_WAIVER_REASON',
          'Diga por que esta nota não gera conta a pagar (bonificação, consignação, troca em '
            + 'garantia…) — é essa frase que o contador vai ler.',
          400,
        );
      }
      db.prepare(
        `UPDATE core_inbound_notes
            SET finance_waiver_reason = ?, finance_waiver_by = ?, finance_waiver_at = ?
          WHERE id = ? AND company_id = ?`,
      ).run(motivo, input.userId, agora, input.noteId, input.companyId);
      return { noteId: input.noteId, acao: input.acao, entryId: null };
    }

    const manual = String(nota.doc_type ?? 'nfe') === 'manual';
    const vencimento =
      input.acao === 'ja_paga'
        ? String(input.paidOn ?? '').trim()
        : String(input.dueDate ?? '').trim() || vencimentoPadrao(nota.received_at, nota.payment_term_days);
    if (!dataValida(vencimento)) {
      throw new ApiError(
        'CORE_NOTE_FINANCE_DATE_INVALID',
        input.acao === 'ja_paga'
          ? 'Informe a data em que a nota foi paga (AAAA-MM-DD).'
          : 'Vencimento inválido (use AAAA-MM-DD).',
        400,
      );
    }

    const id = randomUUID();
    const recebidaEm = nota.received_at ? diaDaLoja(nota.received_at) : hojeNaLoja();
    const observacao = [
      'Lançada depois do recebimento (a nota entrou antes de o financeiro nascer junto).',
      input.acao === 'ja_paga'
        ? `Paga fora do sistema em ${vencimento}${input.method ? ` (${String(input.method).trim()})` : ''}.`
        : null,
      motivo || null,
    ]
      .filter(Boolean)
      .join(' ');
    db.prepare(
      `INSERT INTO core_finance_entries
         (id, company_id, direction, amount_cents, status, due_date, settled_cents,
          supplier_id, description, origin_type, origin_id, category_id, competence_date,
          note, created_at)
       VALUES (?, ?, 'out', ?, 'open', ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.companyId,
      Number(nota.total_cents),
      vencimento,
      nota.supplier_id,
      manual
        ? `Entrada manual ${nota.number ?? nota.id.slice(0, 8)}`
        : `NF-e ${nota.number ?? nota.access_key.slice(25, 34)}`,
      manual ? 'entrada_manual' : 'nfe_entrada',
      input.noteId,
      systemCategoryId(input.companyId, 'fornecedor'),
      // Competência no dia em que a mercadoria ENTROU — é o mês da compra.
      recebidaEm,
      observacao,
      agora,
    );
    // O título é fato para a central, como os que nascem pelo caminho normal.
    recordDomainEvent({
      eventType: 'finance.entry_recorded',
      aggregateType: 'finance_entry',
      aggregateId: id,
      companyId: input.companyId,
      payload: {
        id,
        direction: 'out',
        amount_cents: Number(nota.total_cents),
        status: 'open',
        due_date: vencimento,
        supplier_id: nota.supplier_id,
        description: manual
          ? `Entrada manual ${nota.number ?? nota.id.slice(0, 8)}`
          : `NF-e ${nota.number ?? nota.access_key.slice(25, 34)}`,
        origin_type: manual ? 'entrada_manual' : 'nfe_entrada',
        origin_id: input.noteId,
      },
    });

    if (input.acao === 'ja_paga') {
      settleEntry({
        companyId: input.companyId,
        entryId: id,
        amountCents: Number(nota.total_cents),
        method: input.method ? String(input.method).trim() : null,
        note: `Paga fora do sistema em ${vencimento} — registrada na decisão da nota sem conta.`,
        userId: input.userId,
      });
    }
    return { noteId: input.noteId, acao: input.acao, entryId: id };
  });
}
