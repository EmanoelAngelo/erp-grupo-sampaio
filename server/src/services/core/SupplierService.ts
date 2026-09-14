/**
 * Fornecedores.
 *
 * O cadastro já existia, mas nascia sozinho: importar um XML criava o
 * fornecedor com nome e documento, o bastante para a nota ter origem. Serve
 * para saber DE QUEM veio; não serve para COMPRAR.
 *
 * Comprar exige duas informações que ninguém tinha onde guardar:
 *
 *   PRAZO DE ENTREGA    quantos dias entre pedir e receber. É o que decide
 *                       quando repor: sem ele, ou se compra cedo demais e o
 *                       dinheiro fica parado em estoque, ou tarde demais e a
 *                       prateleira esvazia.
 *   PRAZO DE PAGAMENTO  quantos dias para pagar depois de receber. É o que
 *                       decide o vencimento da dívida — e, portanto, o caixa.
 *
 * O documento continua sendo a identidade: `UNIQUE (company_id, document)`
 * impede o mesmo CNPJ virar dois cadastros e partir o histórico de compras em
 * dois. Fornecedor sem documento é aceito (feira, autônomo), e aí a
 * responsabilidade de não duplicar é de quem cadastra.
 */
import { randomUUID } from 'node:crypto';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { NOTA_RECEBIDA } from './InboundNoteStatus.js';

export interface SupplierInput {
  name: string;
  tradeName?: string | null;
  document?: string | null;
  stateRegistration?: string | null;
  email?: string | null;
  phone?: string | null;
  contactName?: string | null;
  zip?: string | null;
  street?: string | null;
  number?: string | null;
  complement?: string | null;
  district?: string | null;
  city?: string | null;
  state?: string | null;
  paymentTermDays?: number;
  deliveryDays?: number;
  notes?: string | null;
}

/** Só dígitos: CNPJ digitado com e sem máscara é o MESMO fornecedor. */
function normalizeDocument(value: unknown): string | null {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits === '' ? null : digits;
}

function texto(value: unknown): string | null {
  const s = String(value ?? '').trim();
  return s === '' ? null : s;
}

/** Prazo é dia inteiro e não negativo — "entrega em -3 dias" não existe. */
function dias(value: unknown): number {
  const n = Math.round(Number(value ?? 0));
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, 3650);
}

export function loadSupplier(companyId: string, supplierId: string): Record<string, unknown> {
  const row = getConnection()
    .prepare('SELECT * FROM core_suppliers WHERE id = ? AND company_id = ?')
    .get(supplierId, companyId) as Record<string, unknown> | undefined;
  if (!row) throw new ApiError('CORE_SUPPLIER_NOT_FOUND', 'Fornecedor não encontrado.', 404);
  return row;
}

export function createSupplier(companyId: string, input: SupplierInput): Record<string, unknown> {
  ensureCoreSchema();
  const name = texto(input.name);
  if (!name) throw new ApiError('CORE_SUPPLIER_INVALID', 'Informe a razão social.', 400);

  const document = normalizeDocument(input.document);

  return withTransaction(() => {
    const db = getConnection();
    if (document) {
      const clash = db
        .prepare('SELECT id FROM core_suppliers WHERE company_id = ? AND document = ?')
        .get(companyId, document) as { id: string } | undefined;
      // Deixar passar partiria o histórico de compras do mesmo fornecedor em
      // dois cadastros, e nenhum dos dois mostraria o total certo.
      if (clash) {
        throw new ApiError('CORE_SUPPLIER_DUPLICATE', 'Já existe fornecedor com este documento.', 409);
      }
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO core_suppliers
         (id, company_id, name, trade_name, document, state_registration, email, phone,
          contact_name, zip, street, number, complement, district, city, state,
          payment_term_days, delivery_days, notes, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(
      id,
      companyId,
      name,
      texto(input.tradeName),
      document,
      texto(input.stateRegistration),
      texto(input.email),
      texto(input.phone),
      texto(input.contactName),
      texto(input.zip),
      texto(input.street),
      texto(input.number),
      texto(input.complement),
      texto(input.district),
      texto(input.city),
      texto(input.state),
      dias(input.paymentTermDays),
      dias(input.deliveryDays),
      texto(input.notes),
      now,
      now,
    );
    return loadSupplier(companyId, id);
  });
}

export function updateSupplier(
  companyId: string,
  supplierId: string,
  input: Partial<SupplierInput>,
): Record<string, unknown> {
  ensureCoreSchema();
  return withTransaction(() => {
    const atual = loadSupplier(companyId, supplierId);
    const db = getConnection();

    const document =
      input.document === undefined ? (atual.document as string | null) : normalizeDocument(input.document);
    if (document && document !== atual.document) {
      const clash = db
        .prepare('SELECT id FROM core_suppliers WHERE company_id = ? AND document = ? AND id <> ?')
        .get(companyId, document, supplierId) as { id: string } | undefined;
      if (clash) {
        throw new ApiError('CORE_SUPPLIER_DUPLICATE', 'Já existe fornecedor com este documento.', 409);
      }
    }

    const name = input.name === undefined ? String(atual.name) : texto(input.name);
    if (!name) throw new ApiError('CORE_SUPPLIER_INVALID', 'Informe a razão social.', 400);

    /** Campo ausente no corpo mantém o valor atual; presente passa pelo saneamento. */
    const campo = <T>(
      novo: T | undefined,
      anterior: unknown,
      transforma: (v: unknown) => string | number | null,
    ): string | number | null =>
      novo === undefined ? (anterior as string | number | null) : transforma(novo);

    db.prepare(
      `UPDATE core_suppliers
          SET name = ?, trade_name = ?, document = ?, state_registration = ?, email = ?,
              phone = ?, contact_name = ?, zip = ?, street = ?, number = ?, complement = ?,
              district = ?, city = ?, state = ?, payment_term_days = ?, delivery_days = ?,
              notes = ?, updated_at = ?
        WHERE id = ? AND company_id = ?`,
    ).run(
      name,
      campo(input.tradeName, atual.trade_name, texto),
      document,
      campo(input.stateRegistration, atual.state_registration, texto),
      campo(input.email, atual.email, texto),
      campo(input.phone, atual.phone, texto),
      campo(input.contactName, atual.contact_name, texto),
      campo(input.zip, atual.zip, texto),
      campo(input.street, atual.street, texto),
      campo(input.number, atual.number, texto),
      campo(input.complement, atual.complement, texto),
      campo(input.district, atual.district, texto),
      campo(input.city, atual.city, texto),
      campo(input.state, atual.state, texto),
      campo(input.paymentTermDays, atual.payment_term_days, dias),
      campo(input.deliveryDays, atual.delivery_days, dias),
      campo(input.notes, atual.notes, texto),
      new Date().toISOString(),
      supplierId,
      companyId,
    );
    /*
      O IBGE ANDA COM A CIDADE (GAP-PRD-181). Ele veio do XML do emitente para
      aquela cidade; se alguém muda a cidade ou a UF aqui, o código antigo
      passaria a descrever outro município. Apagar é o honesto — a próxima
      nota do fornecedor o traz de novo, se for o caso.
    */
    const cidadeMudou =
      (input.city !== undefined && texto(input.city) !== (atual.city ?? null))
      || (input.state !== undefined && texto(input.state) !== (atual.state ?? null));
    if (cidadeMudou) {
      db.prepare('UPDATE core_suppliers SET city_ibge = NULL WHERE id = ? AND company_id = ?').run(
        supplierId,
        companyId,
      );
    }
    return loadSupplier(companyId, supplierId);
  });
}

/**
 * Desativa em vez de apagar.
 *
 * Apagar levaria junto a origem das notas já recebidas e das dívidas já
 * lançadas — o histórico ficaria apontando para o vazio. Desativado some das
 * buscas de quem vai comprar e continua respondendo por onde já passou.
 */
export function setSupplierActive(
  companyId: string,
  supplierId: string,
  active: boolean,
): Record<string, unknown> {
  ensureCoreSchema();
  loadSupplier(companyId, supplierId);
  getConnection()
    .prepare('UPDATE core_suppliers SET active = ?, updated_at = ? WHERE id = ? AND company_id = ?')
    .run(active ? 1 : 0, new Date().toISOString(), supplierId, companyId);
  return loadSupplier(companyId, supplierId);
}

export function listSuppliers(
  companyId: string,
  filters: { search?: string; includeInactive?: boolean } = {},
): Record<string, unknown>[] {
  ensureCoreSchema();
  let sql = 'SELECT * FROM core_suppliers WHERE company_id = ?';
  const params: (string | number)[] = [companyId];

  if (!filters.includeInactive) sql += ' AND active = 1';

  const busca = texto(filters.search);
  if (busca) {
    // O documento é procurado só por dígitos: quem digita com máscara acha.
    sql += ' AND (name LIKE ? OR trade_name LIKE ? OR document LIKE ?)';
    params.push(`%${busca}%`, `%${busca}%`, `%${normalizeDocument(busca) ?? busca}%`);
  }

  sql += ' ORDER BY name LIMIT 300';
  return getConnection().prepare(sql).all(...params) as unknown as Record<string, unknown>[];
}

/**
 * Histórico de compras.
 *
 * Sai das notas JÁ CONFIRMADAS, não dos pedidos: pedido é intenção, nota é o
 * que entrou. Somar pedido aqui inflaria o quanto se comprou de alguém que
 * talvez não tenha entregue nada.
 */
export function supplierPurchaseHistory(
  companyId: string,
  supplierId: string,
): {
  notes: Record<string, unknown>[];
  totalCents: number;
  noteCount: number;
  lastPurchaseAt: string | null;
  openPayableCents: number;
} {
  ensureCoreSchema();
  loadSupplier(companyId, supplierId);
  const db = getConnection();

  const notes = db
    .prepare(
      // O status é `'recebida'`, em português — ver InboundNoteStatus. Aqui
      // procurava-se `'received'`, e o histórico de compras do fornecedor
      // vinha SEMPRE vazio, mesmo com nota confirmada.
      `SELECT id, access_key, number, series, issued_at, total_cents, status, received_at
         FROM core_inbound_notes
        WHERE company_id = ? AND supplier_id = ? AND status = ?
        ORDER BY COALESCE(received_at, created_at) DESC
        LIMIT 100`,
    )
    .all(companyId, supplierId, NOTA_RECEBIDA) as unknown as Record<string, unknown>[];

  const resumo = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(total_cents), 0) AS total,
              MAX(COALESCE(received_at, created_at)) AS ultimo
         FROM core_inbound_notes
        WHERE company_id = ? AND supplier_id = ? AND status = ?`,
    )
    .get(companyId, supplierId, NOTA_RECEBIDA) as {
    n: number;
    total: number;
    ultimo: string | null;
  };

  /*
    O que ainda se deve a ele. Sai do financeiro, que é a autoridade da dívida.

    O DEFEITO QUE ESTA CONSULTA TINHA: faltava `cancelled_at IS NULL`, e ela
    era a ÚNICA soma do financeiro sem ele (FinanceService filtra cancelado na
    lista, no resumo, na régua de atraso e no DRE). O estorno da entrada
    carimba `status='cancelled', cancelled_at=?` na dívida SEM mexer em
    `amount_cents` nem em `settled_cents` — de propósito, porque a dívida
    existiu e o histórico conta os dois fatos. Consequência: na MESMA tela em
    que `noteCount` e `totalCents` iam a zero, o cartão "Em aberto" seguia
    exibindo o valor estornado como devido. O mesmo valia para qualquer conta a
    pagar cancelada à mão.

    O critério é o CARIMBO e não o `status`, pelo motivo que `FinanceService`
    já documenta: `aplicarStatus` recalcula o status a cada baixa e a cada
    estorno, então uma baixa lançada depois do cancelamento devolveria a linha
    para 'open'. Carimbo de data não se recalcula.
  */
  const aberto = db
    .prepare(
      `SELECT COALESCE(SUM(amount_cents - settled_cents), 0) AS aberto
         FROM core_finance_entries
        WHERE company_id = ? AND supplier_id = ? AND direction = 'out'
          AND cancelled_at IS NULL
          AND settled_cents < amount_cents`,
    )
    .get(companyId, supplierId) as { aberto: number };

  return {
    notes,
    totalCents: resumo.total,
    noteCount: resumo.n,
    lastPurchaseAt: resumo.ultimo,
    openPayableCents: aberto.aberto,
  };
}
