/**
 * Transportadoras — quem trouxe a mercadoria até a porta.
 *
 * Nascem sozinhas na importação do XML, com nome e documento e nada mais:
 * serve para a nota ter de quem veio, não para cobrar uma falta. Cobrar exige
 * telefone e nome de contato, e conferir crédito de ICMS sobre o frete exige a
 * inscrição estadual — nada disso vem no arquivo de forma confiável.
 *
 * NÃO CONFUNDIR com `logistics_carrier_credentials`: aquilo é cotação de frete
 * de SAÍDA do e-commerce (Melhor Envio, Correios), outro domínio inteiro. Esta
 * aqui é a transportadora fiscal da nota que a loja RECEBE.
 */
import { randomUUID } from 'node:crypto';
import { getConnection } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';

export interface Carrier {
  id: string;
  company_id: string;
  name: string;
  document: string | null;
  [coluna: string]: unknown;
}

export interface CarrierInput {
  name?: string;
  tradeName?: string | null;
  document?: string | null;
  stateRegistration?: string | null;
  email?: string | null;
  phone?: string | null;
  contactName?: string | null;
  city?: string | null;
  state?: string | null;
  notes?: string | null;
}

/**
 * Só os dígitos. CNPJ com e sem máscara têm de ser a MESMA transportadora —
 * é a regra que o fornecedor aplica no cadastro e esquece na importação,
 * produzindo duplicata.
 */
function normalizeDocument(value: unknown): string | null {
  const digitos = String(value ?? '').replace(/\D/g, '');
  return digitos.length ? digitos : null;
}

function texto(value: unknown): string | null {
  const s = String(value ?? '').trim();
  return s.length ? s : null;
}

export function loadCarrier(companyId: string, id: string): Carrier {
  ensureCoreSchema();
  const linha = getConnection()
    .prepare('SELECT * FROM core_carriers WHERE id = ? AND company_id = ?')
    .get(id, companyId) as Carrier | undefined;
  if (!linha) throw new ApiError('CORE_CARRIER_NOT_FOUND', 'Transportadora não encontrada.', 404);
  return linha;
}

export function createCarrier(companyId: string, input: CarrierInput): Carrier {
  ensureCoreSchema();
  const nome = texto(input.name);
  if (!nome) throw new ApiError('CORE_CARRIER_INVALID', 'Informe o nome da transportadora.', 400);

  const documento = normalizeDocument(input.document);
  if (documento) {
    // Conferido à mão ANTES do INSERT, para a mensagem dizer o que houve em
    // vez de deixar o SQLite estourar a UNIQUE com texto técnico.
    const existente = getConnection()
      .prepare('SELECT id FROM core_carriers WHERE company_id = ? AND document = ?')
      .get(companyId, documento) as { id: string } | undefined;
    if (existente) {
      throw new ApiError(
        'CORE_CARRIER_DUPLICATE',
        'Já existe transportadora com este documento.',
        409,
      );
    }
  }

  const id = randomUUID();
  const agora = new Date().toISOString();
  getConnection()
    .prepare(
      `INSERT INTO core_carriers
         (id, company_id, name, trade_name, document, state_registration, email,
          phone, contact_name, city, state, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      companyId,
      nome,
      texto(input.tradeName),
      documento,
      texto(input.stateRegistration),
      texto(input.email),
      texto(input.phone),
      texto(input.contactName),
      texto(input.city),
      texto(input.state),
      texto(input.notes),
      agora,
    );
  return loadCarrier(companyId, id);
}

export function updateCarrier(companyId: string, id: string, input: CarrierInput): Carrier {
  ensureCoreSchema();
  const atual = loadCarrier(companyId, id);

  /** Ausente no corpo mantém o valor atual; presente passa pelo saneamento. */
  function campo(enviado: string | null | undefined, atualValor: unknown): string | null {
    return enviado === undefined ? ((atualValor as string | null) ?? null) : texto(enviado);
  }

  const nome = input.name === undefined ? (atual.name as string) : texto(input.name);
  if (!nome) throw new ApiError('CORE_CARRIER_INVALID', 'Informe o nome da transportadora.', 400);

  const documento =
    input.document === undefined
      ? (atual.document as string | null)
      : normalizeDocument(input.document);
  if (documento && documento !== atual.document) {
    const existente = getConnection()
      .prepare('SELECT id FROM core_carriers WHERE company_id = ? AND document = ? AND id <> ?')
      .get(companyId, documento, id) as { id: string } | undefined;
    if (existente) {
      throw new ApiError(
        'CORE_CARRIER_DUPLICATE',
        'Já existe transportadora com este documento.',
        409,
      );
    }
  }

  getConnection()
    .prepare(
      `UPDATE core_carriers SET
         name = ?, trade_name = ?, document = ?, state_registration = ?, email = ?,
         phone = ?, contact_name = ?, city = ?, state = ?, notes = ?, updated_at = ?
       WHERE id = ? AND company_id = ?`,
    )
    .run(
      nome,
      campo(input.tradeName, atual.trade_name),
      documento,
      campo(input.stateRegistration, atual.state_registration),
      campo(input.email, atual.email),
      campo(input.phone, atual.phone),
      campo(input.contactName, atual.contact_name),
      campo(input.city, atual.city),
      campo(input.state, atual.state),
      campo(input.notes, atual.notes),
      new Date().toISOString(),
      id,
      companyId,
    );
  return loadCarrier(companyId, id);
}

/**
 * Desativar em vez de apagar: a transportadora está citada em notas que já
 * aconteceram, e apagá-la deixaria a nota sem quem a trouxe.
 */
export function setCarrierActive(companyId: string, id: string, active: boolean): Carrier {
  ensureCoreSchema();
  loadCarrier(companyId, id);
  getConnection()
    .prepare('UPDATE core_carriers SET active = ?, updated_at = ? WHERE id = ? AND company_id = ?')
    .run(active ? 1 : 0, new Date().toISOString(), id, companyId);
  return loadCarrier(companyId, id);
}

export function listCarriers(
  companyId: string,
  options: { search?: string; includeInactive?: boolean } = {},
): Carrier[] {
  ensureCoreSchema();
  const filtros = ['company_id = ?'];
  const params: unknown[] = [companyId];

  if (!options.includeInactive) filtros.push('active = 1');
  if (options.search?.trim()) {
    // A busca por documento ignora máscara: quem digita o CNPJ do papel o
    // digita com pontos, e o banco guarda só dígitos.
    const termo = `%${options.search.trim()}%`;
    const digitos = `%${options.search.replace(/\D/g, '')}%`;
    filtros.push(
      options.search.replace(/\D/g, '').length >= 3
        ? '(name LIKE ? COLLATE NOCASE OR document LIKE ?)'
        : '(name LIKE ? COLLATE NOCASE OR trade_name LIKE ? COLLATE NOCASE)',
    );
    params.push(termo, options.search.replace(/\D/g, '').length >= 3 ? digitos : termo);
  }

  return getConnection()
    .prepare(
      `SELECT * FROM core_carriers WHERE ${filtros.join(' AND ')}
        ORDER BY name COLLATE NOCASE LIMIT 300`,
    )
    .all(...(params as never[])) as unknown as Carrier[];
}

/**
 * O que esta transportadora trouxe. É a resposta que falta quando alguém
 * pergunta "de quem é a culpa dessa avaria?" — e a que justifica manter o
 * cadastro em vez de guardar só o nome no papel.
 */
export function carrierNoteHistory(
  companyId: string,
  carrierId: string,
): { noteCount: number; volumesQty: number; notes: Record<string, unknown>[] } {
  ensureCoreSchema();
  const notes = getConnection()
    .prepare(
      `SELECT n.id, n.number, n.series, n.issued_at, n.total_cents, n.status,
              n.freight_mode, n.volumes_qty, n.gross_weight_grams, n.vehicle_plate,
              s.name AS supplier_name
         FROM core_inbound_notes n
         LEFT JOIN core_suppliers s ON s.id = n.supplier_id
        WHERE n.company_id = ? AND n.carrier_id = ?
        ORDER BY n.created_at DESC LIMIT 100`,
    )
    .all(companyId, carrierId) as unknown as Record<string, unknown>[];

  return {
    noteCount: notes.length,
    volumesQty: notes.reduce((t, n) => t + Number(n.volumes_qty ?? 0), 0),
    notes,
  };
}
