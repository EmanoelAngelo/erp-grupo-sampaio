/**
 * ============================================================================
 * AS SESSÕES DE API — achadas pelo id, e podadas quando morrem (GAP-PRD-069)
 * ============================================================================
 *
 * `api_sessions` é uma coleção de documentos (`db/database.ts`: `seq`, `id`, e
 * o JSON em `data`, com índice `ix_api_sessions_id` na coluna `id`). A camada
 * genérica só oferece varredura — `findOneRow`/`updateRows` fazem `SELECT` da
 * tabela inteira e um `JSON.parse` por linha — e era assim que o refresh e o
 * logout a liam: duas varreduras por renovação, uma por saída.
 *
 * E nada apagava. Cada login e cada renovação horária inseriam uma linha para
 * sempre: 20 pessoas × 10 renovações por dia ≈ 60 mil linhas por ano. A
 * auditoria mediu 296–426 ms por refresh com 40 mil linhas — com o event loop
 * parado, porque `node:sqlite` é síncrono no mesmo processo do PDV: todo caixa
 * congelava enquanto qualquer terminal renovava a sessão.
 *
 * ## O que este módulo faz
 *
 *   - LÊ e REVOGA pelo id, com SQL sobre o índice que já existia. O custo de
 *     uma renovação deixa de depender do tamanho da tabela.
 *   - PODA o que morreu: sessão vencida (o refresh a recusaria de qualquer
 *     jeito) e sessão revogada (rotacionada, encerrada no logout ou recusada —
 *     nenhum caminho lê uma revogada a não ser para recusá-la, e "não
 *     encontrada" recusa igual). Leva junto as tentativas de login mais velhas
 *     que a janela de diagnóstico, que só o login bem-sucedido limpava.
 *
 * ## Por que a poda roda na emissão, e amortizada
 *
 * É o padrão de `createRequestLog`: `issueSession` é o ÚNICO escritor da
 * coleção, então só existe crescimento quando ele executa — quem cria o
 * problema paga a limpeza, sem agendador para esquecer de subir. A poda roda
 * na primeira emissão do processo (o boot saneia o acumulado) e depois uma vez
 * a cada `EMISSOES_ENTRE_PODAS`. O DELETE filtra em SQL (`json_extract`), sem
 * trazer linha nenhuma para o JavaScript.
 *
 * A poda nunca derruba um login: se falhar, registra e segue. Sessão velha a
 * mais é custo; login recusado por causa de faxina seria defeito.
 */
import { ensureSchema } from '../../db/database.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { logError } from '../../utils/errors.js';
import { podarTrilhaDeAuditoriaSeForAHora } from '../audit/RetencaoDaAuditoria.js';

/** Validade do refresh token. A mesma régua decide o que já pode ser podado. */
export const REFRESH_TTL_MS = 7 * 24 * 3600 * 1000;

/**
 * Validade do access token (JWT) — nunca eterno; quem chama renova.
 *
 * Mora aqui, ao lado da validade do refresh, e não em `ApiAuthService` (que a
 * reexporta com o mesmo nome): `TokensRevogados.ts` precisa dela, e
 * `ApiAuthService` passou a precisar de `TokensRevogados.ts` — a rotação
 * encerra o access anterior (RES-SESSAO). Morando aqui, nenhum dos dois
 * importa o outro em tempo de execução.
 */
export const ACCESS_TOKEN_TTL_SECONDS = 3600;

export type ApiSessionRow = {
  id: string;
  userId: string;
  companyId: string;
  storeId?: string;
  profileCodes: string[];
  sessionVersion?: number;
  /** Ausente nas sessões de antes do GAP-PRD-202 — e aí vale "não provisória". */
  senhaProvisoria?: boolean;
  createdAt?: string;
  expiresAt?: string;
  revoked: boolean;
  /**
   * A FAMÍLIA da sessão (RES-SESSAO): aleatória e NÃO secreta, a mesma do
   * claim `sid` do access token. O login abre uma; a rotação e a troca de
   * operação a mantêm; a troca e o logout encerram todas as credenciais vivas
   * dela. Dois aparelhos da mesma pessoa são duas famílias.
   *
   * Ausente = sessão gravada antes do conserto. Ela segue a regra de antes (o
   * logout só revoga o refresh que vier no corpo) até ser usada: a renovação a
   * consome e emite a sessão seguinte já numa família nova.
   *
   * Vai no JSON, e não numa coluna: `api_sessions` é coleção de documentos
   * (`db/database.ts`), sem esquema — o formato novo lê o antigo. Uma coluna
   * gerada só serviria para índice, e a tabela é pequena de propósito: a poda
   * tira as revogadas e as vencidas, e o que sobra são as sessões vivas.
   */
  sid?: string;
  /** O `jti` do access token emitido JUNTO com este refresh — a rotação e o logout o encerram. */
  accessJti?: string;
  /** O vencimento (ISO) desse access token: a linha de revogação vive até ele. */
  accessExpiresAt?: string;
};

/**
 * A sessão com este refresh token, ou `null`.
 *
 * Linha cujo JSON não abre é tratada como inexistente — é o que ela é para
 * quem tenta renovar com aquele token; o resto da tabela nem é lido.
 */
export function lerSessaoDeApi(refreshToken: string): ApiSessionRow | null {
  if (!refreshToken) return null;
  ensureSchema();
  const linha = getConnection()
    .prepare('SELECT data FROM api_sessions WHERE id = ? ORDER BY seq DESC LIMIT 1')
    .get(refreshToken) as { data?: string } | undefined;
  if (!linha?.data) return null;
  try {
    return JSON.parse(linha.data) as ApiSessionRow;
  } catch {
    return null;
  }
}

/**
 * Quando esta sessão vence. `expiresAt` quando existe; senão, a criação mais a
 * validade do refresh — sessão gravada sem o campo não pode valer para sempre.
 * Sem nenhum dos dois, não há data: `null`, e quem pergunta a trata como vencida.
 */
export function vencimentoDaSessao(sessao: Pick<ApiSessionRow, 'expiresAt' | 'createdAt'>): number | null {
  if (typeof sessao.expiresAt === 'string') {
    const t = new Date(sessao.expiresAt).getTime();
    return Number.isFinite(t) ? t : null;
  }
  if (typeof sessao.createdAt === 'string') {
    const t = new Date(sessao.createdAt).getTime();
    return Number.isFinite(t) ? t + REFRESH_TTL_MS : null;
  }
  return null;
}

/** Marca revogada a sessão deste refresh token. Devolve quantas linhas mudaram. */
export function revogarSessaoDeApi(refreshToken: string): number {
  if (!refreshToken) return 0;
  ensureSchema();
  const resultado = getConnection()
    .prepare(
      `UPDATE api_sessions
          SET data = json_set(data, '$.revoked', json('true'))
        WHERE id = ? AND json_valid(data)`,
    )
    .run(refreshToken);
  return Number(resultado.changes ?? 0);
}

/** O access token emitido junto com um refresh da família — para encerrá-lo pelo `jti`. */
export type AcessoDaFamilia = { jti: string; companyId: string; expiresAt: string | null };

/**
 * Revoga TODOS os refresh vivos da família `sid` desta pessoa e devolve o
 * access emitido com cada um, para quem chama encerrá-los pelo `jti`
 * (RES-SESSAO). É o que o logout e a troca de operação fazem com a sessão
 * inteira — qualquer que seja o refresh que o cliente mandou (ou não) no corpo.
 *
 * O predicado leva a PESSOA do token, e não só o `sid`: a família é de quem a
 * abriu. A empresa não entra, de propósito — a troca de operação mantém a
 * família em outra empresa da mesma pessoa, e sair tem que levar as duas.
 *
 * Varre a coleção com `json_extract` (não há índice sobre o `sid`) e é barato
 * por construção: a poda tira as revogadas e as vencidas a cada ciclo de
 * emissões, e o que sobra são as sessões vivas — uma por aparelho. Roda só
 * no logout e na troca de operação, nunca por requisição.
 */
export function revogarSessoesDaFamilia(userId: string, sid: string): AcessoDaFamilia[] {
  if (!userId || !sid) return [];
  ensureSchema();
  return withTransaction(() => {
    const db = getConnection();
    // `revoked` ausente conta como viva, como em `refreshSession`.
    const daFamiliaViva = `json_valid(data)
          AND json_extract(data, '$.sid') = ?
          AND json_extract(data, '$.userId') = ?
          AND json_extract(data, '$.revoked') IS NOT 1`;
    const vivas = db
      .prepare(
        `SELECT json_extract(data, '$.accessJti') AS jti,
                json_extract(data, '$.companyId') AS companyId,
                json_extract(data, '$.accessExpiresAt') AS expiresAt
           FROM api_sessions
          WHERE ${daFamiliaViva}`,
      )
      .all(sid, userId) as { jti: unknown; companyId: unknown; expiresAt: unknown }[];
    db.prepare(
      `UPDATE api_sessions
          SET data = json_set(data, '$.revoked', json('true'))
        WHERE ${daFamiliaViva}`,
    ).run(sid, userId);
    return vivas.flatMap((v) =>
      typeof v.jti === 'string' && v.jti !== '' && typeof v.companyId === 'string'
        ? [{ jti: v.jti, companyId: v.companyId, expiresAt: typeof v.expiresAt === 'string' ? v.expiresAt : null }]
        : [],
    );
  });
}

/**
 * Por quanto tempo uma tentativa de login fica guardada.
 *
 * O bloqueio só olha 15 minutos (`IdentityService.LOCKOUT_WINDOW_MS`); um dia
 * inteiro sobra para quem investiga "quem tentou entrar como o gerente ontem à
 * tarde". Mais do que isso a tabela só cresce — sob força bruta, a 300
 * requisições por minuto, seriam 400 mil linhas por dia.
 */
export const RETENCAO_DAS_TENTATIVAS_MS = 24 * 3600 * 1000;

/**
 * Apaga as sessões mortas, as tentativas de login velhas e as linhas vencidas
 * de `core_tokens_revogados` (RES-SESSAO: antes, estas só saíam na saída
 * seguinte — um dia parado deixava a última na tabela).
 */
export function podarSessoesDeApi(agora: number = Date.now()): {
  sessoes: number;
  tentativasDeLogin: number;
  tokensRevogados: number;
} {
  ensureSchema();
  ensureCoreSchema();
  const vencimento = new Date(agora).toISOString();
  const criadaAntesDe = new Date(agora - REFRESH_TTL_MS).toISOString();
  const tentativasAntesDe = new Date(agora - RETENCAO_DAS_TENTATIVAS_MS).toISOString();

  return withTransaction(() => {
    const db = getConnection();
    /*
      ISO-8601 em UTC ordena como texto. Linha cujo JSON não abre fica: não
      há idade que se leia nela, e apagar o que não se sabe datar seria
      esconder, não podar (o mesmo critério de `api_request_logs`).
    */
    const sessoes = db
      .prepare(
        `DELETE FROM api_sessions
          WHERE json_valid(data)
            AND (
              json_extract(data, '$.revoked') = 1
              OR (json_type(data, '$.expiresAt') = 'text'
                  AND json_extract(data, '$.expiresAt') <= ?)
              OR (json_type(data, '$.expiresAt') IS NULL
                  AND json_type(data, '$.createdAt') = 'text'
                  AND json_extract(data, '$.createdAt') <= ?)
            )`,
      )
      .run(vencimento, criadaAntesDe);
    const tentativas = db
      .prepare('DELETE FROM core_login_attempts WHERE attempted_at < ?')
      .run(tentativasAntesDe);
    /*
      Acesso encerrado cujo token já venceu: o próprio `jwt.verify` o recusa,
      e a linha não autoriza nem recusa mais nada (`TokensRevogados.ts`).
    */
    const tokensRevogados = db
      .prepare('DELETE FROM core_tokens_revogados WHERE expires_at <= ?')
      .run(vencimento);
    return {
      sessoes: Number(sessoes.changes ?? 0),
      tentativasDeLogin: Number(tentativas.changes ?? 0),
      tokensRevogados: Number(tokensRevogados.changes ?? 0),
    };
  });
}

const EMISSOES_ENTRE_PODAS = 50;
// Começa no teto: a primeira emissão do processo já poda o que o boot herdou.
let emissoesDesdeAPoda = EMISSOES_ENTRE_PODAS;

/** Chamado por `issueSession` a cada emissão; poda uma vez por ciclo. */
export function podarSessoesSeForAHora(): void {
  emissoesDesdeAPoda += 1;
  if (emissoesDesdeAPoda <= EMISSOES_ENTRE_PODAS) return;
  emissoesDesdeAPoda = 0;
  try {
    podarSessoesDeApi();
    // A trilha de auditoria pega carona, no máximo uma vez por dia (GAP-PRD-073).
    podarTrilhaDeAuditoriaSeForAHora();
  } catch (err) {
    logError('poda_de_sessoes_falhou', {
      erro: err instanceof Error ? err.message : String(err),
    });
  }
}
