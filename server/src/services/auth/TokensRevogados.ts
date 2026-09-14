/**
 * ============================================================================
 * O LOGOUT ENCERRA O TOKEN DE ACESSO, NÃO SÓ O REFRESH (item SESSAO)
 * ============================================================================
 *
 * Medido no E2E de API da pilha descartável (verificação A.15): depois de
 * `POST /auth/logout`, o ACCESS token de antes continuava valendo até vencer —
 * `GET /auth/session` com ele respondia 200 por até uma hora. O logout só
 * revogava o refresh (`revogarSessaoDeApi`), e a conferência de toda
 * requisição (`ContaDaSessao.ts`) olhava a CONTA, nunca a sessão. OWASP ASVS
 * 3.3.1 (L1) pede que o logout invalide o token da sessão.
 *
 * ## O desenho
 *
 *   - Todo access token nasce com um `jti` ALEATÓRIO e NÃO secreto
 *     (`randomUUID`, em `issueSession` — o único `jwt.sign` do servidor). Ele
 *     identifica o token; não autoriza nada sozinho.
 *   - O logout grava aqui o `jti` do token que o chamou, com o vencimento do
 *     PRÓPRIO token (claim `exp`), além de revogar o refresh como já fazia.
 *   - A conferência de toda requisição recusa `jti` revogado com 401
 *     `API_SESSION_ENDED` — uma consulta por chave primária, preparada uma vez
 *     por conexão.
 *
 * O refresh token NÃO vai no JWT, nem o id da linha de `api_sessions` (que É o
 * refresh token): o payload é legível por quem tem o access token, e o refresh
 * dentro dele daria a esse portador o poder de renovar para sempre.
 *
 * ## Quem grava aqui (RES-SESSAO)
 *
 * Não só o logout: toda credencial que a sessão deixa para trás no caminho.
 * O token que chamou o logout ou a troca de operação; o access emitido junto
 * com o refresh que a rotação consome; e o access de cada refresh vivo da
 * FAMÍLIA que o logout ou a troca encerram (`ApiAuthService.ts`).
 *
 * ## A faxina
 *
 * Duas, e nenhuma com agendador novo. Quem grava apaga as linhas já vencidas,
 * na mesma transação; e a poda periódica das sessões (`podarSessoesDeApi`, na
 * primeira emissão do processo e depois a cada ciclo de emissões) leva as
 * vencidas junto — sem ela, a última saída de um dia parado ficava na tabela
 * até a saída seguinte (RES-SESSAO). Uma linha só importa enquanto o token
 * dela ainda passaria no `jwt.verify`: depois do `exp` o próprio JWT já é
 * recusado, e a linha vencida não autoriza nem recusa nada.
 *
 * ## A janela de compatibilidade
 *
 * Token SEM `jti` foi emitido antes deste conserto. Ele continua valendo até
 * vencer — no máximo uma hora (`ACCESS_TOKEN_TTL_SECONDS`) depois da
 * atualização — porque não há o que gravar para ele: o logout com um token
 * desses revoga o refresh, como antes, e o token cai sozinho no `exp`. Recusar
 * todo token sem `jti` derrubaria no meio da venda cada caixa que estava
 * logado na hora da atualização.
 */
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { ensureCoreSchema } from '../../db/schema.js';
import { getConnection, withTransaction } from '../../db/sqlite.js';
// Só o TIPO vem de `ApiAuthService`, que importa este módulo em execução.
import type { AuthTokenPayload } from '../api/ApiAuthService.js';
import { ACCESS_TOKEN_TTL_SECONDS } from '../api/SessoesDeApi.js';

/*
  Preparada uma vez por conexão: ela roda em TODA requisição autenticada. A
  conexão pode ser trocada (os testes reabrem o banco), e o WeakMap deixa a
  declaração morrer junto com a conexão que a preparou — o mesmo padrão da
  consulta da conta em `ContaDaSessao.ts`.
*/
const consultaPorConexao = new WeakMap<DatabaseSync, StatementSync>();

function consultaDoRevogado(): StatementSync {
  const db = getConnection();
  let consulta = consultaPorConexao.get(db);
  if (!consulta) {
    consulta = db.prepare('SELECT 1 AS revogado FROM core_tokens_revogados WHERE jti = ?');
    consultaPorConexao.set(db, consulta);
  }
  return consulta;
}

/** O token com este `jti` foi encerrado por um logout? */
export function tokenDeAcessoRevogado(jti: string): boolean {
  ensureCoreSchema();
  return consultaDoRevogado().get(jti) !== undefined;
}

/**
 * Encerra o access token que chamou o logout. Devolve `false` quando o token
 * não tem `jti` (emitido antes do conserto — ver "A janela de compatibilidade").
 */
export function revogarTokenDeAcesso(
  token: Pick<AuthTokenPayload, 'jti' | 'exp' | 'sub' | 'companyId'>,
  agora: number = Date.now(),
): boolean {
  if (typeof token.jti !== 'string' || token.jti === '') return false;
  ensureCoreSchema();
  /*
    O vencimento é o do PRÓPRIO token. Sem `exp` legível (não acontece com o
    que `issueSession` assina), vale o teto do access token a partir de agora:
    a linha nunca pode sair antes de o token deixar de valer.
  */
  const venceEm = typeof token.exp === 'number' && Number.isFinite(token.exp)
    ? token.exp * 1000
    : agora + ACCESS_TOKEN_TTL_SECONDS * 1000;
  const agoraIso = new Date(agora).toISOString();

  withTransaction(() => {
    const db = getConnection();
    // ISO-8601 em UTC ordena como texto.
    db.prepare('DELETE FROM core_tokens_revogados WHERE expires_at <= ?').run(agoraIso);
    db.prepare(
      `INSERT OR IGNORE INTO core_tokens_revogados (jti, user_id, company_id, expires_at, revoked_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(token.jti!, token.sub, token.companyId, new Date(venceEm).toISOString(), agoraIso);
  });
  return true;
}
