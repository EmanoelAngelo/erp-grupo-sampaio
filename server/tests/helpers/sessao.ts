/**
 * Sessão emitida direto pelo serviço — para a CONTA QUE EXISTE (GAP-PRD-053).
 *
 * Vários testes das rotas legadas fabricavam o token com
 * `issueSession({ userId: '550e…', companyId: 'company-x', … })` sem a conta
 * existir: bastava a assinatura do JWT. Desde o GAP-PRD-053, `authMiddleware`
 * confere a conta de agora a cada requisição (ativa, mesma `session_version`,
 * vínculo com a operação do token) — e a sessão de ninguém é recusada, como
 * deve ser.
 *
 * Este helper mantém a assinatura de `issueSession` e provisiona, antes de
 * emitir, exatamente o que a sessão afirma: a empresa com o id pedido, a conta
 * com o id pedido e o vínculo com o perfil pedido. Não enfraquece o guarda —
 * só faz o teste declarar a pessoa que ele já dizia ser. É síncrono, como o
 * `issueSession` que substitui, e idempotente (pode ser chamado a cada
 * requisição do teste, inclusive depois de `resetDbForTests`).
 */
import { ensureCoreSchema } from '../../src/db/schema.js';
import { getConnection } from '../../src/db/sqlite.js';
import { issueSession as emitirSessao } from '../../src/services/api/ApiAuthService.js';

type Entrada = Parameters<typeof emitirSessao>[0];

export function issueSession(input: Entrada): ReturnType<typeof emitirSessao> {
  ensureCoreSchema();
  const db = getConnection();
  const agora = new Date().toISOString();
  const perfil = input.profileCodes[0] ?? 'admin_geral';

  db.prepare(
    `INSERT OR IGNORE INTO core_companies
       (id, slug, legal_name, trade_name, tax_regime, kind, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'simples', 'retail', 1, ?, ?)`,
  ).run(input.companyId, input.companyId, `${input.companyId} Ltda`, input.companyId, agora, agora);

  db.prepare(
    `INSERT OR IGNORE INTO core_users
       (id, login, display_name, password_hash, hash_algorithm, must_rehash,
        active, session_version, created_at, updated_at)
     VALUES (?, ?, ?, 'sessao-de-teste-sem-senha', 'argon2id', 0, 1, 1, ?, ?)`,
  ).run(input.userId, `sessao-${input.userId}`, input.userId, agora, agora);

  db.prepare(
    `INSERT INTO core_user_companies (id, user_id, company_id, profile_code, is_default, created_at)
     VALUES (?, ?, ?, ?, 0, ?)
     ON CONFLICT (user_id, company_id) DO UPDATE SET profile_code = excluded.profile_code`,
  ).run(`${input.userId}:${input.companyId}`, input.userId, input.companyId, perfil, agora);

  const conta = db
    .prepare('SELECT session_version FROM core_users WHERE id = ?')
    .get(input.userId) as { session_version?: number } | undefined;

  return emitirSessao({ ...input, sessionVersion: input.sessionVersion ?? conta?.session_version ?? 1 });
}
