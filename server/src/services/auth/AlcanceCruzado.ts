/**
 * ============================================================================
 * ATRAVESSAR EMPRESA PELO PERFIL DE LÁ — e não só pelo vínculo (GAP-PRD-084)
 * ============================================================================
 *
 * O painel (`GET /core/dashboard?companyId=`) e o BI (`/core/insights/*`)
 * leem números de OUTRAS operações da mesma pessoa. A régua era o vínculo
 * (`core_user_companies`), e só ele: bastava a pessoa ter QUALQUER perfil na
 * operação B — mecânico, caixa, atendente — para, com a sessão de A (onde é
 * gerente), ler faturamento, ticket, margem e mais vendidos de B. Com o token
 * de B, as mesmas rotas lhe respondiam 403.
 *
 * O guarda de cada rota (`requireProfile`) só olha o perfil DA SESSÃO — ele
 * não sabe que a rota vai sair da empresa do token. Então quem atravessa
 * pergunta, para cada operação, a mesma coisa que o guarda perguntaria se a
 * sessão fosse de lá: o perfil que a pessoa tem NAQUELA operação abre esta
 * rota? A lista de perfis vem da rota (a mesma que ela passa ao guarda), e o
 * atalho dos donos é o mesmo de `requireProfile`: `admin_geral` e `gestor`
 * passam em qualquer lista.
 *
 * Perfil desconhecido não entra em lugar nenhum — falha fechada, como o guarda.
 */
import { getConnection } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';

/** O atalho de `requireProfile`: estes dois passam em qualquer rota do núcleo. */
export const PERFIS_QUE_PASSAM_EM_TUDO = ['admin_geral', 'gestor'] as const;

export interface OperacaoAlcancada {
  id: string;
  trade_name: string;
}

/**
 * As operações ATIVAS em que o perfil da pessoa abre uma rota cuja lista de
 * perfis é `perfisDaRota` — em ordem de nome, como o seletor desenha.
 */
export function operacoesOndeOPerfilAbre(
  userId: string,
  perfisDaRota: readonly string[],
): OperacaoAlcancada[] {
  ensureCoreSchema();
  const perfis = [...new Set([...PERFIS_QUE_PASSAM_EM_TUDO, ...perfisDaRota])];
  const marcadores = perfis.map(() => '?').join(', ');
  return getConnection()
    .prepare(
      `SELECT c.id, c.trade_name
         FROM core_companies c
         JOIN core_user_companies uc ON uc.company_id = c.id
        WHERE uc.user_id = ?
          AND c.active = 1
          AND uc.profile_code IN (${marcadores})
        ORDER BY c.trade_name`,
    )
    .all(userId, ...perfis) as unknown as OperacaoAlcancada[];
}
