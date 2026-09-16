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

/** Quem a loja já sabe que comprou: o destinatário da nota, ou o cliente da venda. */
export interface DestinatarioSugerido {
  name: string;
  /** CPF ou CNPJ, só dígitos. Vazio quando a venda saiu sem documento do cliente. */
  document: string;
}

/**
 * O DESTINATÁRIO SUGERIDO DA DEVOLUÇÃO DE VENDA (P0 fiscal).
 *
 * ## Por que sugerir, e não montar
 *
 * A NF-e de devolução de venda é uma nota de ENTRADA cujo destinatário é o
 * cliente que devolveu — e o leiaute exige o ENDEREÇO dele com código IBGE do
 * município. Esse endereço a loja não tem: `core_customers` guarda endereço
 * como texto livre, sem município separado nem IBGE, e a NFC-e do balcão
 * costuma sair só com o CPF. Montar o destinatário sozinho aqui poria endereço
 * inventado numa nota fiscal.
 *
 * O que a loja TEM é quem comprou: o nome e o CPF/CNPJ que foram para a NFC-e
 * (ou, na falta deles, o cliente vinculado à venda). Isso a tela usa para
 * preencher o formulário — o resto quem digita é quem está com o cliente na
 * frente, uma vez, em vez de o sistema adivinhar.
 *
 * Nulo quando não se sabe nem o nome: aí o formulário nasce vazio, e é honesto.
 */
export function destinatarioSugeridoDaDevolucaoDeVenda(
  companyId: string,
  returnId: string,
): DestinatarioSugerido | null {
  ensureCoreSchema();
  const row = getConnection()
    .prepare(
      `SELECT COALESCE(NULLIF(TRIM(d.recipient_name), ''), NULLIF(TRIM(c.name), '')) AS nome,
              COALESCE(NULLIF(TRIM(d.recipient_document), ''), NULLIF(TRIM(c.document), '')) AS documento
         FROM core_sale_returns r
         JOIN core_sales s ON s.id = r.sale_id AND s.company_id = r.company_id
         LEFT JOIN core_customers c ON c.id = s.customer_id AND c.company_id = r.company_id
         LEFT JOIN core_fiscal_documents d
                ON d.sale_id = s.id AND d.company_id = r.company_id AND d.status = 'AUTHORIZED'
        WHERE r.id = ? AND r.company_id = ?
        ORDER BY d.created_at DESC LIMIT 1`,
    )
    .get(returnId, companyId) as { nome: string | null; documento: string | null } | undefined;
  const nome = String(row?.nome ?? '').trim();
  if (!nome) return null;
  return { name: nome, document: String(row?.documento ?? '').replace(/\D/g, '') };
}
