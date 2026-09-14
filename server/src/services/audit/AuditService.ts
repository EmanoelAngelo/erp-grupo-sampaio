/**
 * Trilha de auditoria do núcleo. Registro append-only de quem fez o quê,
 * em qual empresa. Nunca deve conter senha, token ou credencial.
 */
import { randomUUID } from 'node:crypto';
import { getConnection } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';

export interface AuditInput {
  companyId?: string | null;
  userId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  detail?: unknown;
  ip?: string | null;
}

export function recordAudit(input: AuditInput): void {
  ensureCoreSchema();
  getConnection()
    .prepare(
      `INSERT INTO core_audit_log
         (id, company_id, user_id, action, entity_type, entity_id, detail, ip, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      input.companyId ?? null,
      input.userId ?? null,
      input.action,
      input.entityType,
      input.entityId ?? null,
      input.detail === undefined ? null : JSON.stringify(input.detail),
      input.ip ?? null,
      new Date().toISOString(),
    );
}

export interface AuditEntry {
  id: string;
  company_id: string | null;
  user_id: string | null;
  /** Quem fez, pelo nome — `user_id` sozinho não responde a pergunta de quem lê. */
  user_name: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  detail: string | null;
  created_at: string;
}

export interface ListAuditOptions {
  limit?: number;
  offset?: number;
  /** Filtra por ação exata — é o seletor da tela, alimentado por `listAuditActions`. */
  action?: string;
  /** Busca livre sobre ação, entidade, id da entidade e detalhe. */
  q?: string;
}

/**
 * O trecho pedido E o total: 200 linhas fixas não são histórico, são uma
 * amostra — quem investiga "quem cancelou essa venda em março" precisa andar
 * páginas para trás, e a página só é honesta se disser quantas existem.
 */
export interface AuditPage {
  items: AuditEntry[];
  total: number;
}

/**
 * O teto por página protege quem lê e quem serve: `core_audit_log` cresce sem
 * parar (é a natureza dela), e uma tela que pedisse "tudo" arrastaria anos de
 * trilha numa resposta só. Quem quer mais, pagina.
 */
const LIMITE_MAXIMO = 200;

export function listAudit(companyId: string, opts: ListAuditOptions = {}): AuditPage {
  ensureCoreSchema();
  const db = getConnection();

  // Os filtros valem para a página E para o total — um total sem filtro
  // diria "3.412 registros" numa busca que só tem 7.
  let where = 'WHERE a.company_id = ?';
  const params: (string | number)[] = [companyId];
  if (opts.action) {
    where += ' AND a.action = ?';
    params.push(opts.action);
  }
  if (opts.q?.trim()) {
    // LIKE com escape: quem busca "100%" quer o texto "100%", não um curinga.
    where +=
      " AND (a.action LIKE ? ESCAPE '\\' OR a.entity_type LIKE ? ESCAPE '\\'"
      + " OR a.entity_id LIKE ? ESCAPE '\\' OR a.detail LIKE ? ESCAPE '\\')";
    const padrao = `%${opts.q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    params.push(padrao, padrao, padrao, padrao);
  }

  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM core_audit_log a ${where}`).get(...params) as {
      n: number;
    }
  ).n;

  /*
    `?limit=abc` chega aqui como NaN — e NaN atravessa `Math.min`/`Math.max`
    intacto até o bind do LIMIT, onde o SQLite recusa com "datatype mismatch":
    500 cru na rota que existe para traduzir ação em texto legível. O mesmo
    guarda já morava em `listSessions` (CashService), com o mesmo motivo; a
    trilha ganhou o dela quando um atacante da rodada 32 provou o 500 por rota.
  */
  const limitPedido = Number(opts.limit ?? 50);
  const offsetPedido = Number(opts.offset ?? 0);
  const limit = Number.isFinite(limitPedido)
    ? Math.min(Math.max(1, Math.floor(limitPedido)), LIMITE_MAXIMO)
    : 50;
  const offset = Number.isFinite(offsetPedido) ? Math.max(0, Math.floor(offsetPedido)) : 0;

  // O nome sai do JOIN, e o id continua na linha: o nome é para ler, o id é
  // para não mentir quando o usuário for renomeado ou removido depois.
  const items = db
    .prepare(
      `SELECT a.*, u.display_name AS user_name
         FROM core_audit_log a
         LEFT JOIN core_users u ON u.id = a.user_id
        ${where}
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as unknown as AuditEntry[];

  return { items, total };
}

/**
 * As ações que EXISTEM nesta empresa, para o seletor da tela. Uma lista fixa
 * no frontend envelheceria a cada escritor novo — e são 128.
 */
export function listAuditActions(companyId: string): string[] {
  ensureCoreSchema();
  return (
    getConnection()
      .prepare('SELECT DISTINCT action FROM core_audit_log WHERE company_id = ? ORDER BY action')
      .all(companyId) as { action: string }[]
  ).map((r) => r.action);
}
