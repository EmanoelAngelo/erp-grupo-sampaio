/**
 * ============================================================================
 * O ADMINISTRADOR INICIAL — o que o bootstrap e a conferência precisam saber
 * ============================================================================
 *
 * O bootstrap de produção (`db/bootstrap.ts`) cria UMA conta — login `admin` —
 * quando o banco ainda não tem quem administre o grupo. A conferência da
 * implantação (`services/implantacao/conferenciaDaImplantacao.ts`) diz, antes
 * de subir e com a API no ar, se essa conta existe, se vai nascer, ou por que
 * não vai. As duas perguntas moram aqui para os dois responderem igual.
 *
 * Nada aqui escreve no banco, e nada aqui devolve a senha: a régua da senha
 * responde com o MOTIVO da recusa, pelo nome da variável, nunca pelo valor.
 */
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { ehValorPublicado } from '../config/env.js';
import { assertPassword } from '../services/core/TeamService.js';

export const LOGIN_DO_ADMINISTRADOR_INICIAL = 'admin';
export const NOME_DO_ADMINISTRADOR_INICIAL = 'Administrador';
export const VARIAVEL_DA_SENHA_INICIAL = 'DEVORA_BOOTSTRAP_ADMIN_PASSWORD';
/** Quando o bootstrap criou o administrador — em `core_meta`. */
export const MARCA_DO_ADMINISTRADOR_CRIADO = 'bootstrap_admin_created_at';

export interface SituacaoDoAdministrador {
  empresasAtivas: number;
  /** Contas ativas com `admin_geral` em TODAS as empresas ativas. */
  administradoresDoGrupo: number;
  /** A conta que ocupa o login `admin` (sem distinguir maiúsculas), se existe. */
  loginOcupado: string | null;
}

/**
 * A situação lida de um banco — o da API (`getConnection()`) ou o arquivo
 * aberto só para leitura pelo comando da conferência.
 *
 * "Administrador do grupo" é a MESMA definição de `listGroupAdminIds`
 * (IdentityService): `admin_geral` em todas as empresas ativas, conta ativa. A
 * consulta é repetida aqui porque aquela função só fala com a conexão da API,
 * e a conferência roda antes de a API existir; `bootstrap-de-producao.test.ts`
 * cobra que as duas contem igual.
 */
export function situacaoDoAdministrador(db: DatabaseSync): SituacaoDoAdministrador {
  const empresasAtivas = (db.prepare('SELECT COUNT(*) AS n FROM core_companies WHERE active = 1').get() as { n: number }).n;
  const administradoresDoGrupo = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT uc.user_id
             FROM core_user_companies uc
             JOIN core_companies c ON c.id = uc.company_id AND c.active = 1
             JOIN core_users u ON u.id = uc.user_id AND u.active = 1
            WHERE uc.profile_code = 'admin_geral'
            GROUP BY uc.user_id
           HAVING COUNT(DISTINCT uc.company_id) = (SELECT COUNT(*) FROM core_companies WHERE active = 1)
         )`,
      )
      .get() as { n: number }
  ).n;
  const ocupante = db
    .prepare('SELECT login FROM core_users WHERE login = ? COLLATE NOCASE ORDER BY created_at LIMIT 1')
    .get(LOGIN_DO_ADMINISTRADOR_INICIAL) as { login: string } | undefined;
  return { empresasAtivas, administradoresDoGrupo, loginOcupado: ocupante?.login ?? null };
}

/** Produção pelos dois nomes — a régua de `loadEnv` —, e homologação junto. */
export function ambienteDeProducao(env: { DEVORA_API_ENV?: string; NODE_ENV?: string }): boolean {
  const api = (env.DEVORA_API_ENV ?? '').trim();
  return api === 'production' || api === 'staging' || (env.NODE_ENV ?? '').trim() === 'production';
}

/*
  AS SENHAS DE DESENVOLVIMENTO QUE ESTE REPOSITÓRIO PUBLICOU.

  O README e as notas da 1.0.0 publicaram as duas senhas das contas de
  demonstração (a de gestão e a de balcão). Em produção e homologação elas não
  servem como senha inicial de ninguém: qualquer leitor do repositório as
  conhece. Ficam aqui pelo SHA-256 da forma minúscula — o código de produção não
  volta a escrever senha nenhuma, e "Admin" com maiúscula também é recusada.
*/
const SENHAS_PUBLICADAS_SHA256 = new Set([
  '7676aaafb027c825bd9abab78b234070e702752f625b752e55e55b48e607e358',
  'ce418a2c3a88434bc898f728548dc58f05f8c79886ae10939fe10d80ac94deff',
]);

function publicada(senha: string): boolean {
  const normal = senha.trim().toLowerCase();
  return SENHAS_PUBLICADAS_SHA256.has(createHash('sha256').update(normal, 'utf8').digest('hex'))
    || ehValorPublicado(senha.trim());
}

/**
 * Por que a senha inicial é recusada — ou `null` quando serve. A mensagem
 * nomeia a variável e o motivo; o valor nunca entra nela.
 */
export function recusaDaSenhaInicial(
  senha: string,
  producao: boolean,
  variavel: string = VARIAVEL_DA_SENHA_INICIAL,
): string | null {
  try {
    assertPassword(senha);
  } catch (err) {
    return `${variavel} recusada: ${(err as Error).message}`;
  }
  if (producao && publicada(senha)) {
    return (
      `${variavel} recusada: é uma senha de desenvolvimento publicada neste repositório. `
      + 'Em produção e homologação, use uma senha própria desta instalação.'
    );
  }
  return null;
}
