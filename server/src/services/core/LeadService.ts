/**
 * CRM: lead e oportunidade.
 *
 * LEAD NÃO É CLIENTE, e essa é a decisão que organiza o módulo.
 *
 * A tentação é guardar o lead no cadastro de clientes com um sinalizador. Sai
 * caro: `core_customers` passaria a conter gente que nunca comprou, e todo
 * número calculado por cliente — ticket médio, taxa de recompra, quantos
 * clientes a loja tem — passaria a dividir por uma base inflada. O erro não
 * aparece como erro; aparece como um ticket médio que caiu sem motivo.
 *
 * Então o lead vive em tabela própria e, quando compra, VIRA cliente apontando
 * para `core_customers`, que continua sendo a autoridade. Se já existir cliente
 * com o mesmo documento, o lead se liga ao que existe — a mesma pessoa não
 * passa a ter dois cadastros porque um dia entrou como lead.
 *
 * A OPORTUNIDADE NÃO É RECEITA. O valor dela é estimativa: não entra no
 * financeiro, não conta como faturamento e não aparece em caixa. Vira dinheiro
 * quando a venda acontece, e aí a oportunidade aponta para ela.
 */
import { randomUUID } from 'node:crypto';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { chaveReusada, impressaoDe, outraImpressao } from '../api/ImpressaoDaRequisicao.js';

export type LeadStatus = 'novo' | 'em_contato' | 'qualificado' | 'convertido' | 'perdido';
export type OpportunityStatus = 'aberta' | 'ganha' | 'perdida';

const STATUS_LEAD = new Set<LeadStatus>([
  'novo',
  'em_contato',
  'qualificado',
  'convertido',
  'perdido',
]);

function texto(value: unknown): string | null {
  const s = String(value ?? '').trim();
  return s === '' ? null : s;
}

/** Só dígitos: documento com e sem máscara é a mesma pessoa. */
function normalizeDocument(value: unknown): string | null {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits === '' ? null : digits;
}

export function loadLead(companyId: string, leadId: string): Record<string, unknown> {
  const row = getConnection()
    .prepare('SELECT * FROM core_leads WHERE id = ? AND company_id = ?')
    .get(leadId, companyId) as Record<string, unknown> | undefined;
  if (!row) throw new ApiError('CORE_LEAD_NOT_FOUND', 'Lead não encontrado.', 404);
  return row;
}

export function createLead(input: {
  companyId: string;
  userId?: string;
  name: string;
  phone?: string | null;
  email?: string | null;
  document?: string | null;
  source?: string | null;
  notes?: string | null;
  idempotencyKey?: string | null;
}): Record<string, unknown> {
  ensureCoreSchema();
  const nome = texto(input.name);
  if (!nome) throw new ApiError('CORE_LEAD_INVALID', 'Informe o nome do lead.', 400);

  return withTransaction(() => {
    const db = getConnection();

    // A mesma chave devolve o mesmo lead. Sem isto, um clique duplo no balcão
    // ou um reenvio da rede criaria dois contatos da mesma pessoa.
    //
    // E a mesma chave com OUTRA pessoa não é o clique duplo (RES-IDEM-VIZ): era
    // o lead antigo devolvido calado, e o novo contato nunca nascia. Agora é
    // 422, antes de qualquer escrita; lead anterior à impressão (nula) segue a
    // regra de sempre.
    const chave = texto(input.idempotencyKey);
    const impressao = impressaoDe({
      nome,
      telefone: texto(input.phone),
      email: texto(input.email),
      documento: normalizeDocument(input.document) ?? null,
      origem: texto(input.source),
      nota: texto(input.notes),
    });
    if (chave) {
      const existente = db
        .prepare('SELECT * FROM core_leads WHERE company_id = ? AND idempotency_key = ?')
        .get(input.companyId, chave) as Record<string, unknown> | undefined;
      if (existente) {
        if (outraImpressao(existente.idempotency_fingerprint, impressao)) {
          throw chaveReusada('outro lead', { leadId: existente.id });
        }
        return existente;
      }
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO core_leads
         (id, company_id, name, phone, email, document, source, status, notes,
          idempotency_key, created_by, created_at, updated_at, idempotency_fingerprint)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'novo', ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.companyId,
      nome,
      texto(input.phone),
      texto(input.email),
      normalizeDocument(input.document),
      texto(input.source),
      texto(input.notes),
      chave,
      input.userId ?? null,
      now,
      now,
      chave ? impressao : null,
    );
    return loadLead(input.companyId, id);
  });
}

export function updateLeadStatus(input: {
  companyId: string;
  leadId: string;
  status: LeadStatus;
  lostReason?: string | null;
}): Record<string, unknown> {
  ensureCoreSchema();
  if (!STATUS_LEAD.has(input.status)) {
    throw new ApiError('CORE_LEAD_STATUS_INVALID', 'Situação inválida.', 400);
  }
  const lead = loadLead(input.companyId, input.leadId);

  // Converter é ato próprio, com cliente do outro lado. Deixar marcar
  // "convertido" na mão criaria lead convertido sem cliente nenhum.
  if (input.status === 'convertido') {
    throw new ApiError(
      'CORE_LEAD_CONVERT_ROUTE',
      'Conversão acontece ao virar cliente, não pela mudança de situação.',
      400,
    );
  }
  if (lead.status === 'convertido') {
    throw new ApiError('CORE_LEAD_ALREADY_CONVERTED', 'Lead já convertido.', 409);
  }

  const motivo = texto(input.lostReason);
  if (input.status === 'perdido' && !motivo) {
    throw new ApiError('CORE_LEAD_LOST_REASON', 'Informe por que o lead foi perdido.', 400);
  }

  getConnection()
    .prepare('UPDATE core_leads SET status = ?, lost_reason = ?, updated_at = ? WHERE id = ?')
    .run(input.status, input.status === 'perdido' ? motivo : null, new Date().toISOString(), input.leadId);
  return loadLead(input.companyId, input.leadId);
}

/**
 * O lead comprou: vira cliente.
 *
 * Se já existe cliente com o mesmo documento, LIGA ao que existe. Criar outro
 * faria a mesma pessoa ter dois cadastros — e o histórico de compras dela
 * ficaria partido entre os dois, sem que nenhum mostrasse o total.
 */
export function convertLead(input: {
  companyId: string;
  leadId: string;
  userId?: string;
}): { lead: Record<string, unknown>; customerId: string; reusedExisting: boolean } {
  ensureCoreSchema();
  return withTransaction(() => {
    const lead = loadLead(input.companyId, input.leadId);
    if (lead.status === 'convertido' && lead.customer_id) {
      return {
        lead,
        customerId: String(lead.customer_id),
        reusedExisting: true,
      };
    }

    const db = getConnection();
    const documento = lead.document ? String(lead.document) : null;

    let customerId: string | null = null;
    let reaproveitou = false;

    if (documento) {
      const existente = db
        .prepare('SELECT id FROM core_customers WHERE company_id = ? AND document = ?')
        .get(input.companyId, documento) as { id: string } | undefined;
      if (existente) {
        customerId = existente.id;
        reaproveitou = true;
      }
    }

    const now = new Date().toISOString();
    if (!customerId) {
      customerId = randomUUID();
      db.prepare(
        `INSERT INTO core_customers
           (id, company_id, name, document, email, phone, notes, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      ).run(
        customerId,
        input.companyId,
        String(lead.name),
        documento,
        texto(lead.email),
        texto(lead.phone),
        texto(lead.notes),
        now,
        now,
      );
    }

    db.prepare(
      `UPDATE core_leads SET status = 'convertido', customer_id = ?, converted_at = ?,
              updated_at = ? WHERE id = ?`,
    ).run(customerId, now, now, input.leadId);

    // Oportunidades abertas deste lead passam a apontar para o cliente: a
    // negociação é a mesma, o que mudou foi o nome de quem está do outro lado.
    db.prepare(
      "UPDATE core_opportunities SET customer_id = ?, updated_at = ? WHERE lead_id = ? AND status = 'aberta'",
    ).run(customerId, now, input.leadId);

    return {
      lead: loadLead(input.companyId, input.leadId),
      customerId,
      reusedExisting: reaproveitou,
    };
  });
}

export function listLeads(
  companyId: string,
  filters: { status?: string; search?: string } = {},
): Record<string, unknown>[] {
  ensureCoreSchema();
  let sql = `SELECT l.*, c.name AS customer_name
               FROM core_leads l
               LEFT JOIN core_customers c ON c.id = l.customer_id
              WHERE l.company_id = ?`;
  const params: (string | number)[] = [companyId];

  if (filters.status) {
    sql += ' AND l.status = ?';
    params.push(filters.status);
  }
  const busca = texto(filters.search);
  if (busca) {
    sql += ' AND (l.name LIKE ? OR l.phone LIKE ? OR l.email LIKE ?)';
    params.push(`%${busca}%`, `%${busca}%`, `%${busca}%`);
  }

  sql += ' ORDER BY l.created_at DESC LIMIT 300';
  return getConnection().prepare(sql).all(...params) as unknown as Record<string, unknown>[];
}

// ------------------------------------------------------------- oportunidades

export function createOpportunity(input: {
  companyId: string;
  userId?: string;
  title: string;
  amountCents?: number;
  leadId?: string | null;
  customerId?: string | null;
  expectedCloseAt?: string | null;
}): Record<string, unknown> {
  ensureCoreSchema();
  const titulo = texto(input.title);
  if (!titulo) throw new ApiError('CORE_OPPORTUNITY_INVALID', 'Descreva a oportunidade.', 400);

  const valor = Math.round(Number(input.amountCents ?? 0));
  if (!Number.isFinite(valor) || valor < 0) {
    throw new ApiError('CORE_OPPORTUNITY_INVALID', 'Valor estimado inválido.', 400);
  }

  return withTransaction(() => {
    const db = getConnection();

    // Sem os dois, a oportunidade não tem de quem é — e vira previsão sem dono.
    if (!input.leadId && !input.customerId) {
      throw new ApiError(
        'CORE_OPPORTUNITY_NO_PARTY',
        'A oportunidade precisa de um lead ou de um cliente.',
        400,
      );
    }

    let customerId = input.customerId ? String(input.customerId) : null;
    if (input.leadId) {
      const lead = loadLead(input.companyId, String(input.leadId));
      // Lead já convertido: a oportunidade nasce ligada ao cliente também.
      if (!customerId && lead.customer_id) customerId = String(lead.customer_id);
    }
    if (customerId) {
      const cliente = db
        .prepare('SELECT id FROM core_customers WHERE id = ? AND company_id = ?')
        .get(customerId, input.companyId) as { id: string } | undefined;
      if (!cliente) throw new ApiError('CORE_CUSTOMER_NOT_FOUND', 'Cliente não encontrado.', 404);
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO core_opportunities
         (id, company_id, lead_id, customer_id, title, amount_cents, status,
          expected_close_at, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'aberta', ?, ?, ?, ?)`,
    ).run(
      id,
      input.companyId,
      input.leadId ?? null,
      customerId,
      titulo,
      valor,
      input.expectedCloseAt ?? null,
      input.userId ?? null,
      now,
      now,
    );
    return getOpportunity(input.companyId, id);
  });
}

export function closeOpportunity(input: {
  companyId: string;
  opportunityId: string;
  status: 'ganha' | 'perdida';
  lostReason?: string | null;
  saleId?: string | null;
}): Record<string, unknown> {
  ensureCoreSchema();
  return withTransaction(() => {
    const db = getConnection();
    const opp = db
      .prepare('SELECT * FROM core_opportunities WHERE id = ? AND company_id = ?')
      .get(input.opportunityId, input.companyId) as Record<string, unknown> | undefined;
    if (!opp) throw new ApiError('CORE_OPPORTUNITY_NOT_FOUND', 'Oportunidade não encontrada.', 404);
    if (opp.status !== 'aberta') {
      throw new ApiError('CORE_OPPORTUNITY_CLOSED', 'Oportunidade já encerrada.', 409);
    }

    const motivo = texto(input.lostReason);
    if (input.status === 'perdida' && !motivo) {
      // Perda sem motivo não ensina nada a quem vai vender amanhã.
      throw new ApiError('CORE_OPPORTUNITY_LOST_REASON', 'Informe por que foi perdida.', 400);
    }

    let saleId: string | null = null;
    if (input.status === 'ganha' && input.saleId) {
      const venda = db
        .prepare('SELECT id FROM core_sales WHERE id = ? AND company_id = ?')
        .get(String(input.saleId), input.companyId) as { id: string } | undefined;
      if (!venda) throw new ApiError('CORE_SALE_NOT_FOUND', 'Venda não encontrada.', 404);
      saleId = venda.id;
    }

    db.prepare(
      `UPDATE core_opportunities
          SET status = ?, lost_reason = ?, won_sale_id = ?, closed_at = ?, updated_at = ?
        WHERE id = ?`,
    ).run(
      input.status,
      input.status === 'perdida' ? motivo : null,
      saleId,
      new Date().toISOString(),
      new Date().toISOString(),
      input.opportunityId,
    );
    return getOpportunity(input.companyId, input.opportunityId);
  });
}

export function getOpportunity(companyId: string, id: string): Record<string, unknown> {
  ensureCoreSchema();
  const row = getConnection()
    .prepare(
      `SELECT o.*, l.name AS lead_name, c.name AS customer_name, s.number AS sale_number
         FROM core_opportunities o
         LEFT JOIN core_leads l ON l.id = o.lead_id
         LEFT JOIN core_customers c ON c.id = o.customer_id
         LEFT JOIN core_sales s ON s.id = o.won_sale_id
        WHERE o.id = ? AND o.company_id = ?`,
    )
    .get(id, companyId) as Record<string, unknown> | undefined;
  if (!row) throw new ApiError('CORE_OPPORTUNITY_NOT_FOUND', 'Oportunidade não encontrada.', 404);
  return row;
}

export function listOpportunities(
  companyId: string,
  filters: { status?: string } = {},
): Record<string, unknown>[] {
  ensureCoreSchema();
  let sql = `SELECT o.*, l.name AS lead_name, c.name AS customer_name, s.number AS sale_number
               FROM core_opportunities o
               LEFT JOIN core_leads l ON l.id = o.lead_id
               LEFT JOIN core_customers c ON c.id = o.customer_id
               LEFT JOIN core_sales s ON s.id = o.won_sale_id
              WHERE o.company_id = ?`;
  const params: (string | number)[] = [companyId];
  if (filters.status) {
    sql += ' AND o.status = ?';
    params.push(filters.status);
  }
  sql += ' ORDER BY o.created_at DESC LIMIT 300';
  return getConnection().prepare(sql).all(...params) as unknown as Record<string, unknown>[];
}

/**
 * Resumo do funil.
 *
 * O valor em aberto é ESTIMATIVA e vem rotulado assim em todo lugar que
 * aparece. Somá-lo ao faturamento seria contar como dinheiro o que ainda é
 * conversa.
 */
export function crmSummary(companyId: string): Record<string, unknown> {
  ensureCoreSchema();
  const db = getConnection();
  const leads = db
    .prepare(
      `SELECT status, COUNT(*) AS n FROM core_leads WHERE company_id = ? GROUP BY status`,
    )
    .all(companyId) as unknown as { status: string; n: number }[];
  const opp = db
    .prepare(
      `SELECT status, COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS total
         FROM core_opportunities WHERE company_id = ? GROUP BY status`,
    )
    .all(companyId) as unknown as { status: string; n: number; total: number }[];

  const porStatus = Object.fromEntries(leads.map((l) => [l.status, l.n]));
  const abertas = opp.find((o) => o.status === 'aberta');
  const ganhas = opp.find((o) => o.status === 'ganha');

  return {
    leads: {
      novo: porStatus.novo ?? 0,
      em_contato: porStatus.em_contato ?? 0,
      qualificado: porStatus.qualificado ?? 0,
      convertido: porStatus.convertido ?? 0,
      perdido: porStatus.perdido ?? 0,
    },
    opportunities: {
      abertas: abertas?.n ?? 0,
      /** Estimado. NÃO é receita e não entra em faturamento. */
      abertoEstimadoCents: abertas?.total ?? 0,
      ganhas: ganhas?.n ?? 0,
      ganhoCents: ganhas?.total ?? 0,
    },
  };
}
