import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { loadEnv } from '../../config/env.js';
import { insertRow } from '../../db/database.js';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { revogarTokenDeAcesso } from '../auth/TokensRevogados.js';
import { carimboDoAcesso } from '../auth/AcessoEfetivo.js';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TTL_MS,
  lerSessaoDeApi,
  podarSessoesSeForAHora,
  revogarSessaoDeApi,
  revogarSessoesDaFamilia,
  vencimentoDaSessao,
  type ApiSessionRow,
} from './SessoesDeApi.js';

/** Access JWT TTL — not eternal; callers must refresh. Mora em `SessoesDeApi.ts` (lá, o porquê). */
export { ACCESS_TOKEN_TTL_SECONDS };

export interface AuthTokenPayload {
  sub: string;
  companyId: string;
  storeId?: string;
  profileCodes: string[];
  /** Optional claim for future forced re-auth; defaults to 1. */
  sessionVersion?: number;
  /**
   * A sessão entrou com a SENHA PROVISÓRIA — a que a gestão definiu e,
   * portanto, conhece (GAP-PRD-202). `authMiddleware` recusa este token em
   * toda rota menos nas da etapa de troca. Ausente = senha só da pessoa.
   *
   * Vai no token, e não numa consulta ao banco a cada requisição, por dois
   * motivos: a marca é da CREDENCIAL que abriu a sessão (o terminal de PDV,
   * que entra por token de dispositivo, não usou senha nenhuma), e o
   * middleware continua sem tocar o banco — a mesma semântica de todas as
   * rotas. Quem pode reemitir a sessão (refresh, troca de operação) carrega a
   * marca adiante; só um login com a senha nova a emite limpa.
   */
  senhaProvisoria?: true;
  /**
   * Identificador ALEATÓRIO e NÃO secreto deste token (claim `jti`, RFC 7519).
   * É por ele que o logout encerra o access token (`TokensRevogados.ts`). Não
   * é, e nunca pode ser, o refresh token: o payload é legível por quem tem o
   * access token. Ausente = token emitido antes do conserto, que vale até o
   * `exp` (no máximo uma hora).
   */
  jti?: string;
  /** Vencimento em segundos desde a época (claim `exp`), posto pelo `jwt.sign`. */
  exp?: number;
  /** Emissão em segundos desde a época (claim `iat`), posta pelo `jwt.sign`. */
  iat?: number;
  /**
   * A FAMÍLIA da sessão (RES-SESSAO): aleatória e NÃO secreta, a mesma gravada
   * no registro do refresh (`ApiSessionRow.sid`). O login abre uma; a rotação
   * e a troca de operação a mantêm; o logout e a troca encerram todas as
   * credenciais vivas dela. NUNCA o refresh token nem o id da linha de
   * `api_sessions` (que É o refresh token): o payload é legível por quem tem
   * o access token.
   *
   * Ausente = token emitido antes do conserto: segue a regra de antes até o
   * `exp` (no máximo uma hora) — o logout com ele encerra o próprio `jti` e o
   * refresh que vier no corpo, e só.
   */
  sid?: string;
  /**
   * O carimbo do ACESSO na emissão (RBAC granular) — um resumo NÃO secreto do
   * vínculo, do modelo e da versão de cada um. As capabilities NÃO vão no
   * token; o carimbo só serve para `authMiddleware` notar que o acesso mudou
   * desde a emissão e avisar a tela (`X-Acesso-Em-Vigor`). Ausente = token de
   * antes do conserto, ou emitido sem vínculo.
   */
  acessoCarimbo?: string;
}

/** Access tokens always carry an expiresIn; never treat JWT as eternal. */
export function isJwtEternal(): false {
  return false;
}

export function issueSession(input: {
  userId: string;
  companyId: string;
  storeId?: string;
  profileCodes: string[];
  sessionVersion?: number;
  /** A credencial que abriu a sessão foi a senha provisória — ver `AuthTokenPayload`. */
  senhaProvisoria?: boolean;
  /**
   * A família em que esta emissão entra (RES-SESSAO). Ausente = família NOVA:
   * é o login (senha, terminal, atalho de DEV). A rotação do refresh e a troca
   * de operação passam a família da sessão que continuam.
   */
  sid?: string;
}): { accessToken: string; refreshToken: string; expiresIn: number } {
  const env = loadEnv();
  const expiresIn = ACCESS_TOKEN_TTL_SECONDS;
  const sessionVersion = input.sessionVersion ?? 1;
  // O carimbo do acesso de AGORA no vínculo desta emissão (ver AuthTokenPayload).
  const acessoCarimbo = carimboDoAcesso(input.userId, input.companyId);
  const payload: AuthTokenPayload = {
    sub: input.userId,
    companyId: input.companyId,
    storeId: input.storeId,
    profileCodes: input.profileCodes,
    sessionVersion,
    ...(input.senhaProvisoria ? { senhaProvisoria: true as const } : {}),
    ...(acessoCarimbo ? { acessoCarimbo } : {}),
    /*
      Aleatório e NÃO secreto: é o nome deste token, para o logout encerrá-lo
      (`TokensRevogados.ts`). NUNCA o refresh token — o payload é legível por
      quem tem o access token, e o refresh aqui dentro renovaria para sempre.
    */
    jti: randomUUID(),
    /*
      A FAMÍLIA da sessão (RES-SESSAO): aleatória e NÃO secreta, como o `jti`.
      Nova no login; herdada na rotação e na troca de operação. É por ela que
      o logout encerra a sessão inteira, e não só o refresh do corpo.
    */
    sid: typeof input.sid === 'string' && input.sid !== '' ? input.sid : randomUUID(),
  };
  const accessToken = jwt.sign(payload, env.DEVORA_JWT_SECRET, { expiresIn });
  // O vencimento que o `jwt.sign` gravou: a revogação do access emitido junto
  // (na rotação ou no logout) não pode sair da tabela antes dele.
  const { exp } = jwt.decode(accessToken) as { exp: number };
  const refreshToken = randomUUID();
  // Único escritor da coleção: quem cria sessão paga a faxina das mortas
  // (GAP-PRD-069 — ver `SessoesDeApi.ts`).
  podarSessoesSeForAHora();
  const sessao: ApiSessionRow = {
    id: refreshToken,
    userId: input.userId,
    companyId: input.companyId,
    storeId: input.storeId,
    profileCodes: input.profileCodes,
    sessionVersion,
    senhaProvisoria: input.senhaProvisoria === true,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + REFRESH_TTL_MS).toISOString(),
    revoked: false,
    // O registro do refresh sabe a família e o access que nasceu com ele —
    // é o que a rotação e o logout encerram. Nada disso vai para o JWT.
    sid: payload.sid,
    accessJti: payload.jti,
    accessExpiresAt: new Date(exp * 1000).toISOString(),
  };
  insertRow('api_sessions', sessao);
  return { accessToken, refreshToken, expiresIn };
}

export function verifyAccessToken(token: string): AuthTokenPayload {
  try {
    return jwt.verify(token, loadEnv().DEVORA_JWT_SECRET) as AuthTokenPayload;
  } catch {
    throw new ApiError('API_INVALID_TOKEN', 'Token inválido.', 401);
  }
}

/**
 * Troca o refresh token por uma sessão nova — perguntando à PESSOA DE HOJE.
 *
 * ## O que estava errado, medido com supertest
 *
 * Esta função lia só a linha da sessão e reemitia o que estava gravado nela:
 * perfil antigo, versão antiga, sem nunca abrir `core_users`. Três
 * consequências, todas provadas:
 *
 *   - DESLIGADO RENOVAVA PARA SEMPRE. `active = 0` barra o LOGIN, mas o
 *     refresh não olhava o campo: quem já estava dentro trocava de token a
 *     cada hora, indefinidamente. Para um contador desligado — pessoa de FORA
 *     da empresa, com acesso ao pacote fiscal — isso não era janela, era porta.
 *   - `session_version` ERA ESCRITOR SEM LEITOR. Desativação e troca de senha
 *     incrementam o campo exatamente para derrubar sessões antigas, e nenhum
 *     caminho o comparava com nada. O gesto de segurança existia e não fazia
 *     efeito — a forma de defeito mais recusada deste projeto, numa credencial.
 *   - REBAIXADO CONTINUAVA COM O PERFIL ANTIGO. O perfil vinha da sessão, não
 *     do vínculo: um gestor rebaixado a estoquista renovava como gestor até
 *     alguém notar.
 *
 * Agora o refresh espelha o LOGIN (`auth.ts`): usuário ativo, versão de sessão
 * conferida, e o perfil relido do vínculo — promoção e rebaixamento passam a
 * valer na próxima renovação, como já valiam no próximo login.
 *
 * ## A janela de uma hora — fechada (GAP-PRD-053)
 *
 * Aqui estava escrito que o ACCESS token já emitido continuava valendo até
 * expirar (1 hora): desligou, a pessoa caía "em no máximo uma hora". Não cai
 * mais assim: `authMiddleware` confere a conta a cada requisição
 * (`services/auth/ContaDaSessao.ts`) com as mesmas três perguntas deste
 * refresh — ativa, mesma `session_version`, ainda vinculada — e o perfil que
 * vale é o do vínculo de agora. Desligou, cai na requisição seguinte.
 */
export function refreshSession(refreshToken: string): ReturnType<typeof issueSession> {
  /*
    PELO ID, e não por varredura (GAP-PRD-069): `findOneRow` lia a coleção
    inteira e fazia JSON.parse de cada linha — duas vezes por renovação, com
    o event loop do PDV parado.
  */
  const session = lerSessaoDeApi(refreshToken);
  if (!session || session.revoked) {
    throw new ApiError('API_INVALID_TOKEN', 'Refresh token inválido.', 401);
  }
  // Sem data de vencimento legível, a sessão não vale: "para sempre" não é
  // um prazo (sessão antiga sem `expiresAt` vence pela criação).
  const vence = vencimentoDaSessao(session);
  if (vence === null || vence <= Date.now()) {
    throw new ApiError('API_INVALID_TOKEN', 'Refresh token expirado.', 401);
  }

  /*
    A recusa também REVOGA: um refresh que bateu aqui e falhou não pode ficar
    vivo esperando a conta ser reativada para funcionar de novo. Reativar cria
    credencial nova pelo login; não ressuscita a antiga.
  */
  const recusar = (motivo: string): never => {
    revogarSessaoDeApi(refreshToken);
    throw new ApiError('API_INVALID_TOKEN', motivo, 401);
  };

  ensureCoreSchema();
  const db = getConnection();
  const user = db
    .prepare('SELECT active, session_version FROM core_users WHERE id = ?')
    .get(session.userId) as { active?: number; session_version?: number } | undefined;

  if (!user || user.active !== 1) {
    recusar('Sessão encerrada. Entre novamente.');
  }
  if ((session.sessionVersion ?? 1) !== (user!.session_version ?? 1)) {
    // Senha trocada ou acesso desativado e reativado: as sessões anteriores ao
    // gesto morrem aqui, que é o efeito que o incremento sempre quis ter.
    recusar('Sessão encerrada. Entre novamente.');
  }

  const vinculo = db
    .prepare(
      `SELECT uc.profile_code, c.active AS company_active
         FROM core_user_companies uc
         JOIN core_companies c ON c.id = uc.company_id
        WHERE uc.user_id = ? AND uc.company_id = ?`,
    )
    .get(session.userId, session.companyId) as { profile_code?: string; company_active?: number } | undefined;
  if (!vinculo?.profile_code) {
    // Desvinculado da operação: o refresh não pode reemitir acesso a uma
    // empresa da qual a pessoa foi removida.
    recusar('Sessão encerrada. Entre novamente.');
  }
  if (vinculo!.company_active !== 1) {
    // A operação foi desativada (D2 do RBAC granular): a sessão nela não se
    // renova — a mesma recusa da conferência por requisição.
    recusar('Sessão encerrada: esta operação foi desativada. Entre novamente.');
  }

  /*
    Rotação: o refresh usado morre antes de o novo nascer — e, desde o
    RES-SESSAO, o ACCESS emitido junto com ele também. Antes, o token de antes
    da renovação seguia valendo até o `exp`. Sessão gravada antes do conserto
    não tem `accessJti`: não há o que encerrar, e o token dela cai no próprio
    `exp` (no máximo uma hora).
  */
  revogarSessaoDeApi(refreshToken);
  if (typeof session.accessJti === 'string') {
    encerrarAcessoRegistrado(session.accessJti, session.accessExpiresAt, session.userId, session.companyId);
  }
  return issueSession({
    userId: session.userId,
    companyId: session.companyId,
    storeId: session.storeId,
    // O perfil DE AGORA, relido do vínculo — o mesmo que o login emitiria.
    profileCodes: [vinculo!.profile_code as string],
    sessionVersion: user!.session_version ?? 1,
    /*
      A marca da senha provisória ATRAVESSA a renovação. Sem isto, bastava
      renovar o token provisório para receber um limpo — a etapa de troca
      viraria uma espera de uma hora. A marca só some com um login feito com
      a senha nova (a troca sobe `session_version`, e este refresh morre).
    */
    senhaProvisoria: session.senhaProvisoria === true,
    /*
      A rotação MANTÉM a família. Sessão gravada antes do conserto (sem `sid`)
      entra aqui numa família nova: o primeiro uso a traz para a regra de agora.
    */
    sid: session.sid,
  });
}

export function revokeSession(refreshToken: string): void {
  revogarSessaoDeApi(refreshToken);
}

/**
 * Encerra, pelo `jti`, um access token que o registro do refresh conhece — o
 * emitido junto com ele. O vencimento gravado é o do próprio token; sem ele
 * legível, `revogarTokenDeAcesso` usa o teto do access a partir de agora.
 */
function encerrarAcessoRegistrado(
  jti: string,
  venceEmIso: string | null | undefined,
  sub: string,
  companyId: string,
): void {
  if (jti === '') return;
  const vence = typeof venceEmIso === 'string' ? Date.parse(venceEmIso) : Number.NaN;
  revogarTokenDeAcesso({
    jti,
    sub,
    companyId,
    ...(Number.isFinite(vence) ? { exp: Math.ceil(vence / 1000) } : {}),
  });
}

/**
 * Encerra no servidor TODAS as credenciais da sessão deste token (RES-SESSAO):
 * cada refresh vivo da família, com o access emitido junto, e o próprio token
 * que chamou. É o miolo do logout e da troca de operação. Tudo pela PESSOA do
 * token (`sub`): a família de outra pessoa não é tocada.
 *
 * Token sem `sid` (emitido antes do conserto) não tem família a encerrar: sai
 * só o próprio `jti` — e, no logout, o refresh do corpo.
 */
function encerrarCredenciaisDaSessao(auth: AuthTokenPayload): void {
  if (typeof auth.sid === 'string' && auth.sid !== '') {
    for (const acesso of revogarSessoesDaFamilia(auth.sub, auth.sid)) {
      encerrarAcessoRegistrado(acesso.jti, acesso.expiresAt, auth.sub, acesso.companyId);
    }
  }
  revogarTokenDeAcesso(auth);
}

/**
 * Encerra a sessão a que este REFRESH pertence (R2-SESSAO): o próprio refresh,
 * o access emitido com ele e — quando ele tem família — todos os refresh vivos
 * da família, com o access de cada um. Tudo pela PESSOA gravada na linha.
 *
 * Vale para o refresh já rotacionado (revogado) também, de propósito: quem o
 * tem é a mesma sessão pedindo para SAIR — a aba que ficou com o refresh de
 * antes, enquanto a vizinha renovou. Encerrar só a linha morta deixaria a
 * família viva por sete dias, que é o defeito que este caminho fecha. O pior
 * que um refresh velho alheio consegue aqui é encerrar a sessão (nunca
 * renová-la) — o mesmo remédio que a detecção de reuso do OAuth aplica.
 *
 * Refresh que não existe não faz nada, e quem chama responde igual: nada diz
 * se a sessão existia.
 */
function encerrarSessaoDoRefresh(refreshToken: string): void {
  const sessao = lerSessaoDeApi(refreshToken);
  if (!sessao) return;
  revogarSessaoDeApi(refreshToken);
  if (typeof sessao.accessJti === 'string') {
    encerrarAcessoRegistrado(sessao.accessJti, sessao.accessExpiresAt, sessao.userId, sessao.companyId);
  }
  if (typeof sessao.sid === 'string' && sessao.sid !== '' && typeof sessao.userId === 'string') {
    for (const acesso of revogarSessoesDaFamilia(sessao.userId, sessao.sid)) {
      encerrarAcessoRegistrado(acesso.jti, acesso.expiresAt, sessao.userId, acesso.companyId);
    }
  }
}

/**
 * O logout (RES-SESSAO; ASVS 3.3.1): a sessão INTEIRA sai no servidor,
 * qualquer que seja o corpo. O refresh do corpo sai também, com a família dele
 * (R2-SESSAO) — cobre o token emitido antes do conserto (sem família) e a aba
 * que mandou um refresh de antes da rotação. Numa transação: ou sai tudo, ou
 * nada muda.
 */
export function encerrarSessao(auth: AuthTokenPayload, refreshDoCorpo?: string): void {
  withTransaction(() => {
    if (refreshDoCorpo) encerrarSessaoDoRefresh(refreshDoCorpo);
    encerrarCredenciaisDaSessao(auth);
  });
}

/**
 * O logout SEM access válido (R2-SESSAO): o access venceu e a renovação não
 * pôde ser atendida (429, 5xx) — ou o cliente nem tentou. Antes a rota exigia
 * access válido, o logout não chegava, e a família vivia até sete dias.
 * Encerra pela família do refresh do corpo; quem chama responde sempre o mesmo
 * 204, exista o refresh ou não.
 */
export function encerrarSessaoPeloRefresh(refreshToken: string): void {
  if (!refreshToken) return;
  withTransaction(() => encerrarSessaoDoRefresh(refreshToken));
}

/**
 * A PROVA da sessão que a troca de operação exige (R2-SESSAO).
 *
 * A troca emite um REFRESH novo (sete dias). Pedindo só o access (uma hora),
 * ela transformava um access furtado em refresh — e ainda encerrava a família
 * da vítima, que caía no login enquanto quem furtou ficava. Agora quem troca
 * mostra o refresh atual desta sessão: da MESMA pessoa e da MESMA família
 * (`sid`) do access. Token emitido antes da família (sem `sid`) prova com um
 * refresh vivo da mesma pessoa.
 *
 * Só confere; não revoga nada — a recusa não pode derrubar ninguém.
 */
export function conferirProvaDaSessao(auth: AuthTokenPayload, refreshToken: string): ApiSessionRow {
  if (!refreshToken) {
    throw new ApiError(
      'API_SESSION_PROOF_REQUIRED',
      'Para trocar de operação, a sessão precisa se provar: envie o refresh token atual desta sessão.',
      401,
    );
  }
  const sessao = lerSessaoDeApi(refreshToken);
  const vence = sessao ? vencimentoDaSessao(sessao) : null;
  const tokenTemFamilia = typeof auth.sid === 'string' && auth.sid !== '';
  const valeComoProva =
    sessao !== null
    && sessao.revoked !== true
    && vence !== null
    && vence > Date.now()
    && sessao.userId === auth.sub
    && (!tokenTemFamilia || sessao.sid === auth.sid);
  if (!valeComoProva) {
    throw new ApiError(
      'API_SESSION_PROOF_INVALID',
      'O refresh token enviado não é o desta sessão. Entre novamente para trocar de operação.',
      401,
    );
  }
  return sessao!;
}

/**
 * A troca de operação (RES-SESSAO): a MESMA sessão, em outra operação da mesma
 * pessoa. Encerra as credenciais de antes e só depois emite as novas, na mesma
 * família — nessa ordem, senão a revogação da família levaria junto o refresh
 * que acabou de nascer.
 *
 * Só depois da PROVA (`conferirProvaDaSessao`, R2-SESSAO): o refresh da prova
 * sai junto com a família. Token sem `sid` (emitido antes do conserto) sai com
 * o próprio `jti`, a sessão nova já nasce numa família — e o refresh de antes
 * dele, que antes vivia os sete dias, sai pela prova.
 */
export function trocarOperacaoDaSessao(
  auth: AuthTokenPayload,
  refreshDaProva: string,
  destino: { companyId: string; profileCodes: string[]; sessionVersion: number; senhaProvisoria: boolean },
): ReturnType<typeof issueSession> {
  withTransaction(() => {
    encerrarSessaoDoRefresh(refreshDaProva);
    encerrarCredenciaisDaSessao(auth);
  });
  return issueSession({
    userId: auth.sub,
    companyId: destino.companyId,
    profileCodes: destino.profileCodes,
    sessionVersion: destino.sessionVersion,
    senhaProvisoria: destino.senhaProvisoria,
    sid: auth.sid,
  });
}
