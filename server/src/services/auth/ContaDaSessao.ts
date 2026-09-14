/**
 * ============================================================================
 * A CONTA DE AGORA, CONFERIDA A CADA REQUISIÇÃO (GAP-PRD-053)
 * ============================================================================
 *
 * O access token é um JWT de uma hora. Até aqui `authMiddleware` só conferia
 * a assinatura e a validade — nunca o banco — e a janela estava escrita por
 * extenso em `ApiAuthService`: "desligou, a pessoa cai em no máximo uma hora".
 * Medido pela auditoria com o token emitido ANTES do gesto:
 *
 *   - desativado → 200 por até 60 minutos (funcionário desligado com o caixa
 *     aberto na mão);
 *   - rebaixado de gerente a atendente → a rota de gerente respondia 200;
 *   - removido da operação → 200;
 *   - senha trocada (inclusive o reset da gestão, o gesto de "acho que
 *     roubaram a senha dele") → 200, porque `session_version` só tinha leitor
 *     no refresh. Só o tempo cortava.
 *
 * ## A decisão, e por que não virou configuração
 *
 * A ficha deixava a escolha ao dono: aceitar a janela de uma hora ou exigir
 * corte imediato. O corte imediato é o lado seguro, e o preço dele, medido, é
 * uma consulta por chave primária num SQLite local — sem rede, sem outro
 * processo — que não aparece perto do que cada rota já faz no banco. Com o
 * custo nesse tamanho, oferecer a opção de NÃO cortar seria oferecer uma
 * janela de risco sem nada em troca. Não há alavanca a escolher: desligou,
 * caiu na requisição seguinte.
 *
 * ## O que se confere
 *
 *   1. a conta existe e está ATIVA;
 *   2. a `session_version` do token é a da conta — desativação, reset da
 *      gestão e troca da própria senha sobem esse número exatamente para
 *      derrubar as sessões abertas;
 *   3. a conta ainda tem VÍNCULO com a operação do token;
 *   4. a operação está ATIVA (D2 do RBAC granular) — antes, uma sessão aberta
 *      numa empresa desativada seguia valendo;
 *   5. o caixa do token de dispositivo continua no escopo do vínculo.
 *
 * E o perfil que vale é o do vínculo DE AGORA, não o que o token carrega:
 * rebaixamento e promoção passam a valer na requisição seguinte, e
 * `GET /auth/session` devolve o perfil em vigor.
 *
 * ## O acesso efetivo, na MESMA consulta (RBAC granular, F1)
 *
 * A mesma leitura por chave primária traz o vínculo com o modelo aplicado, e
 * dela sai o acesso efetivo (`AcessoEfetivo.ts`): as capabilities, os caixas e
 * as bancadas de agora. As capabilities NÃO vão no token — viajando nele, a
 * revogação imediata se perderia, que é exatamente o risco que esta
 * conferência existe para fechar.
 *
 * ## A senha provisória, relida do banco
 *
 * A marca `senhaProvisoria` do token é da credencial que abriu a sessão. Mas
 * a conta pode estar com a senha provisória da gestão sem que o token saiba
 * (token emitido por outro caminho). A conferência devolve a bandeira DO
 * BANCO, e `authMiddleware` recusa com 403 `API_PASSWORD_CHANGE_REQUIRED`
 * quando qualquer das duas diz "provisória".
 *
 * Qualquer recusa é 401 `API_SESSION_ENDED`. O cliente trata 401 renovando a
 * sessão — e o refresh faz as MESMAS perguntas (`refreshSession`), recusa e
 * revoga; a tela cai no login, como cairia com o token vencido.
 */
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { ensureCoreSchema } from '../../db/schema.js';
import { getConnection } from '../../db/sqlite.js';
import { ApiError } from '../../utils/errors.js';
import { tokenDeAcessoRevogado } from './TokensRevogados.js';
import {
  COLUNAS_DO_VINCULO,
  JUNCOES_DO_VINCULO,
  resolverAcesso,
  type AcessoEfetivo,
  type LinhaDoVinculo,
} from './AcessoEfetivo.js';

type LinhaDaConta = LinhaDoVinculo & {
  active: number;
  session_version: number | null;
  must_change_password: number | null;
};

/*
  A consulta é preparada uma vez por conexão: ela roda em TODA requisição
  autenticada. A conexão pode ser trocada (os testes reabrem o banco), e o
  WeakMap deixa a declaração morrer junto com a conexão que a preparou.
*/
const consultaPorConexao = new WeakMap<DatabaseSync, StatementSync>();

function consultaDaConta(): StatementSync {
  const db = getConnection();
  let consulta = consultaPorConexao.get(db);
  if (!consulta) {
    consulta = db.prepare(
      `SELECT u.active, u.session_version, u.must_change_password,
              ${COLUNAS_DO_VINCULO}
         FROM core_users u
         LEFT JOIN core_user_companies uc
           ON uc.user_id = u.id AND uc.company_id = ?
         ${JUNCOES_DO_VINCULO}
        WHERE u.id = ?`,
    );
    consultaPorConexao.set(db, consulta);
  }
  return consulta;
}

const SESSAO_ENCERRADA =
  'Sessão encerrada: o acesso desta conta mudou (desativado, senha trocada ou '
  + 'removido desta operação). Entre novamente.';

const SESSAO_SAIU = 'Sessão encerrada: esta sessão saiu do sistema. Entre novamente.';

const EMPRESA_DESATIVADA =
  'Sessão encerrada: esta operação foi desativada. Entre novamente em outra operação.';

const CAIXA_FORA_DO_ESCOPO =
  'Sessão encerrada: o caixa deste computador saiu do seu acesso nesta operação. Entre novamente.';

/** O que a conferência devolve: o perfil (modelo aplicado), o acesso efetivo e a bandeira da senha. */
export interface ContaEmVigor {
  profileCodes: string[];
  acesso: AcessoEfetivo;
  /** A conta está com a senha provisória da gestão — lida DO BANCO, agora. */
  senhaProvisoria: boolean;
}

/**
 * Confere a sessão do token contra a conta de agora e devolve o perfil e o
 * acesso em vigor no vínculo. Lança 401 `API_SESSION_ENDED` quando a sessão
 * não vale mais.
 *
 * Antes da conta, o PRÓPRIO token: se o logout o encerrou (`jti` gravado em
 * `core_tokens_revogados`), ele não vale mais — mesmo com a conta intacta
 * (item SESSAO, ASVS 3.3.1). Token sem `jti` foi emitido antes do conserto e
 * vale até o `exp`, no máximo uma hora (ver `TokensRevogados.ts`).
 */
export function conferirContaDaSessao(sessao: {
  sub: string;
  companyId: string;
  sessionVersion?: number;
  jti?: string;
  storeId?: string;
}): ContaEmVigor {
  ensureCoreSchema();
  if (typeof sessao.jti === 'string' && tokenDeAcessoRevogado(sessao.jti)) {
    throw new ApiError('API_SESSION_ENDED', SESSAO_SAIU, 401);
  }
  const conta = consultaDaConta().get(sessao.companyId, sessao.sub) as LinhaDaConta | undefined;

  if (!conta || conta.active !== 1) {
    throw new ApiError('API_SESSION_ENDED', SESSAO_ENCERRADA, 401);
  }
  if ((sessao.sessionVersion ?? 1) !== (conta.session_version ?? 1)) {
    throw new ApiError('API_SESSION_ENDED', SESSAO_ENCERRADA, 401);
  }
  if (!conta.profile_code) {
    throw new ApiError('API_SESSION_ENDED', SESSAO_ENCERRADA, 401);
  }
  if (conta.company_active !== 1) {
    throw new ApiError('API_SESSION_ENDED', EMPRESA_DESATIVADA, 401);
  }
  const acesso = resolverAcesso(conta, sessao.sub, sessao.companyId);
  if (!acesso) {
    throw new ApiError('API_SESSION_ENDED', SESSAO_ENCERRADA, 401);
  }
  // O computador do caixa entra no caixa do token; se esse caixa saiu do
  // escopo do vínculo, a máquina cai na requisição seguinte (desenho §6.2).
  if (typeof sessao.storeId === 'string' && sessao.storeId !== ''
    && acesso.terminais !== 'todos' && !acesso.terminais.includes(sessao.storeId)) {
    throw new ApiError('API_SESSION_ENDED', CAIXA_FORA_DO_ESCOPO, 401);
  }
  return {
    profileCodes: [conta.profile_code],
    acesso,
    senhaProvisoria: conta.must_change_password === 1,
  };
}
