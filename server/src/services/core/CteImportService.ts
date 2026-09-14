/**
 * Entrada de CT-e — o documento do TRANSPORTE (modelo 57), rodada 44.
 *
 * ## Por que ele não existia
 *
 * O funil de entrada só conhecia NF-e: `parseNfeXml` recusa qualquer XML sem
 * `infNFe`. A transportadora emite o conhecimento contra quem paga o frete, e
 * esse documento não tinha onde morar — o frete ficava sem registro próprio.
 *
 * ## O desenho
 *
 * - Parser próprio, mesma biblioteca (fast-xml-parser), exigindo `infCte`:
 *   um XML de NF-e aqui é recusa clara, não confusão.
 * - Idempotência igual à da nota: UNIQUE (company_id, access_key).
 * - O vínculo com as NF-e transportadas é DERIVADO: o CT-e guarda as chaves
 *   que referencia (tabela filha) e o join com `core_inbound_notes` resolve
 *   na leitura. Derivado não se mantém à mão.
 * - `xml_original` VERBATIM, pelo mesmo princípio da nota: a assinatura
 *   cobre os bytes, nunca reserializar.
 */
import { randomUUID } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';

export interface ParsedCte {
  accessKey: string;
  number: string | null;
  series: string | null;
  issuedAt: string | null;
  carrierCnpj: string | null;
  carrierName: string | null;
  freightCents: number;
  nfeKeys: string[];
}

function asArray<T>(valor: T | T[] | undefined | null): T[] {
  if (valor === undefined || valor === null) return [];
  return Array.isArray(valor) ? valor : [valor];
}

function texto(valor: unknown): string | null {
  if (valor === undefined || valor === null) return null;
  const s = String(valor).trim();
  return s.length ? s : null;
}

function toCents(valor: unknown): number {
  const numero = Number(String(valor ?? '').trim());
  return Number.isFinite(numero) ? Math.round(numero * 100) : 0;
}

export function parseCteXml(xml: string): ParsedCte {
  const corpo = String(xml ?? '').trim();
  if (!corpo) {
    throw new ApiError('CORE_XML_EMPTY', 'Envie o conteúdo do XML do CT-e.', 400);
  }
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@',
    parseTagValue: false,
    trimValues: true,
  });
  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(corpo) as Record<string, unknown>;
  } catch {
    throw new ApiError('CORE_XML_INVALID', 'O arquivo não é um XML válido.', 400);
  }

  const proc = doc.cteProc as Record<string, unknown> | undefined;
  const cte = (proc?.CTe ?? doc.CTe) as Record<string, unknown> | undefined;
  const info = cte?.infCte as Record<string, unknown> | undefined;
  if (!info) {
    throw new ApiError(
      'CORE_XML_NOT_CTE',
      'O arquivo não parece ser um CT-e (elemento infCte ausente).',
      400,
    );
  }

  const accessKey = String((info['@Id'] as string) ?? '')
    .replace(/^CTe/i, '')
    .replace(/\D/g, '');
  if (accessKey.length !== 44) {
    throw new ApiError('CORE_CTE_NO_KEY', 'Chave de acesso do CT-e ausente ou inválida.', 400);
  }

  const ide = (info.ide ?? {}) as Record<string, unknown>;
  const emit = (info.emit ?? {}) as Record<string, unknown>;
  const vPrest = (info.vPrest ?? {}) as Record<string, unknown>;

  /*
    As chaves das NF-e transportadas: infCTeNorm > infDoc > infNFe[] > chave.
    É o elo com o funil de entrada — sem elas o frete não se amarra a carga
    nenhuma, e o CT-e vira um número solto.
  */
  const norm = (info.infCTeNorm ?? {}) as Record<string, unknown>;
  const infDoc = (norm.infDoc ?? {}) as Record<string, unknown>;
  const nfeKeys = asArray(infDoc.infNFe as Record<string, unknown> | Record<string, unknown>[])
    .map((ref) => String((ref as Record<string, unknown>).chave ?? '').replace(/\D/g, ''))
    .filter((chave) => chave.length === 44);

  return {
    accessKey,
    number: texto(ide.nCT),
    series: texto(ide.serie),
    issuedAt: texto(ide.dhEmi),
    carrierCnpj: texto(emit.CNPJ),
    carrierName: texto(emit.xNome),
    freightCents: toCents(vPrest.vTPrest),
    nfeKeys,
  };
}

export interface CteImportResult {
  cteId: string;
  duplicated: boolean;
  accessKey: string;
  carrierName: string | null;
  freightCents: number;
  nfeKeys: string[];
}

export function importCte(input: {
  companyId: string;
  userId: string;
  xml: string;
}): CteImportResult {
  ensureCoreSchema();
  const parsed = parseCteXml(input.xml);
  const db = getConnection();

  const existente = db
    .prepare('SELECT id FROM core_cte_documents WHERE company_id = ? AND access_key = ?')
    .get(input.companyId, parsed.accessKey) as { id: string } | undefined;
  if (existente) {
    return {
      cteId: existente.id,
      duplicated: true,
      accessKey: parsed.accessKey,
      carrierName: parsed.carrierName,
      freightCents: parsed.freightCents,
      nfeKeys: parsed.nfeKeys,
    };
  }

  const cteId = randomUUID();
  const agora = new Date().toISOString();
  withTransaction(() => {
    db.prepare(
      `INSERT INTO core_cte_documents
         (id, company_id, access_key, number, series, carrier_cnpj, carrier_name,
          freight_cents, issued_at, xml_original, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      cteId,
      input.companyId,
      parsed.accessKey,
      parsed.number,
      parsed.series,
      parsed.carrierCnpj,
      parsed.carrierName,
      parsed.freightCents,
      parsed.issuedAt,
      input.xml,
      input.userId,
      agora,
    );
    const ref = db.prepare(
      `INSERT INTO core_cte_referenced_notes (id, cte_id, company_id, nfe_access_key)
       VALUES (?, ?, ?, ?)`,
    );
    for (const chave of parsed.nfeKeys) {
      ref.run(randomUUID(), cteId, input.companyId, chave);
    }
  });

  return {
    cteId,
    duplicated: false,
    accessKey: parsed.accessKey,
    carrierName: parsed.carrierName,
    freightCents: parsed.freightCents,
    nfeKeys: parsed.nfeKeys,
  };
}

export interface CteListado {
  id: string;
  accessKey: string;
  number: string | null;
  series: string | null;
  carrierCnpj: string | null;
  carrierName: string | null;
  freightCents: number;
  issuedAt: string | null;
  createdAt: string;
  /** Cada NF-e transportada, com a nota do funil quando a chave já entrou. */
  notas: { accessKey: string; noteId: string | null; noteStatus: string | null }[];
}

export function listCtes(companyId: string): CteListado[] {
  ensureCoreSchema();
  const db = getConnection();
  const ctes = db
    .prepare(
      `SELECT id, access_key, number, series, carrier_cnpj, carrier_name,
              freight_cents, issued_at, created_at
         FROM core_cte_documents
        WHERE company_id = ?
        ORDER BY created_at DESC
        LIMIT 200`,
    )
    .all(companyId) as unknown as Record<string, unknown>[];

  const refs = db.prepare(
    `SELECT r.nfe_access_key, n.id AS note_id, n.status AS note_status
       FROM core_cte_referenced_notes r
       LEFT JOIN core_inbound_notes n
         ON n.company_id = r.company_id AND n.access_key = r.nfe_access_key
      WHERE r.cte_id = ?
      ORDER BY r.nfe_access_key`,
  );

  return ctes.map((c) => ({
    id: String(c.id),
    accessKey: String(c.access_key),
    number: (c.number as string) ?? null,
    series: (c.series as string) ?? null,
    carrierCnpj: (c.carrier_cnpj as string) ?? null,
    carrierName: (c.carrier_name as string) ?? null,
    freightCents: Number(c.freight_cents ?? 0),
    issuedAt: (c.issued_at as string) ?? null,
    createdAt: String(c.created_at),
    notas: (refs.all(String(c.id)) as unknown as Record<string, unknown>[]).map((r) => ({
      accessKey: String(r.nfe_access_key),
      noteId: (r.note_id as string) ?? null,
      noteStatus: (r.note_status as string) ?? null,
    })),
  }));
}
