/**
 * A SITUAÇÃO FISCAL DE UMA DEVOLUÇÃO — a ponte entre o registro da devolução e
 * a NF-e de devolução dela (P0 fiscal).
 *
 * Mora à parte de `FiscalDevolucao` de propósito: quem lê isto é a fila (logo
 * depois da autorização) e as fichas das devoluções, e nenhum dos dois pode
 * puxar o pipeline de emissão — seria import circular, e a ficha da devolução
 * não tem nada que saber de assinatura.
 */
import { getConnection } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { logError } from '../../utils/errors.js';

export type OrigemDeDevolucao = 'devolucao_venda' | 'devolucao_compra';

export interface NotaDeDevolucao {
  documentId: string;
  model: string;
  serie: number;
  number: number;
  accessKey: string | null;
  /** O estado do DOCUMENTO — só AUTHORIZED é nota que vale. */
  status: string;
  protocol: string | null;
  /** A chave da nota devolvida (o NFref). */
  referencedAccessKey: string | null;
}

/** A NF-e de devolução deste registro, quando existe (a mais recente). */
export function notaDeDevolucaoDoRegistro(
  companyId: string,
  origem: OrigemDeDevolucao,
  returnId: string,
): NotaDeDevolucao | null {
  ensureCoreSchema();
  const row = getConnection()
    .prepare(
      `SELECT id, model, serie, number, access_key, status, protocol, referenced_access_key
         FROM core_fiscal_documents
        WHERE company_id = ? AND origin_type = ? AND origin_id = ?
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(companyId, origem, returnId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    documentId: String(row.id),
    model: String(row.model),
    serie: Number(row.serie),
    number: Number(row.number),
    accessKey: (row.access_key as string | null) ?? null,
    status: String(row.status),
    protocol: (row.protocol as string | null) ?? null,
    referencedAccessKey: (row.referenced_access_key as string | null) ?? null,
  };
}

/**
 * Depois da AUTORIZAÇÃO: a devolução de compra passa a "emitida" com a chave
 * da nota — o mesmo registro que a tela fazia à mão (`registrarSituacaoFiscal`),
 * agora feito pelo fato que o justifica. Só sai de "pendente": uma decisão já
 * registrada à mão não é sobrescrita.
 *
 * NUNCA lança: o registro não desfaz a autorização — falha vira log.
 */
export function aoAutorizarNotaDeDevolucao(companyId: string, documentId: string): void {
  try {
    const db = getConnection();
    const row = db
      .prepare(
        `SELECT origin_type, origin_id, access_key, status FROM core_fiscal_documents
          WHERE id = ? AND company_id = ?`,
      )
      .get(documentId, companyId) as
      | { origin_type: string | null; origin_id: string | null; access_key: string | null; status: string }
      | undefined;
    if (!row || row.status !== 'AUTHORIZED' || row.origin_type !== 'devolucao_compra' || !row.origin_id) return;
    db.prepare(
      `UPDATE core_supplier_returns
          SET fiscal_status = 'emitida', fiscal_access_key = ?,
              fiscal_note = COALESCE(fiscal_note, 'NF-e de devolução emitida pelo DEVORA.'),
              fiscal_updated_at = ?
        WHERE id = ? AND company_id = ? AND fiscal_status = 'pendente'`,
    ).run(row.access_key, new Date().toISOString(), row.origin_id, companyId);
  } catch (err) {
    logError('FISCAL_DEVOLUCAO_SITUACAO_FALHOU', {
      companyId,
      documentId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
