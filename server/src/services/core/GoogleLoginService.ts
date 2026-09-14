/**
 * ENTRAR COM GOOGLE — o fluxo inteiro (GAP-PRD-027).
 *
 * Authorization Code com PKCE, `state` e `nonce`, id_token conferido contra
 * a chave publicada do provedor, e-mail verificado exigido, vínculo com a
 * conta de mesmo e-mail, sessão do portal — e nenhuma senha nem token do
 * Google guardado em lugar nenhum.
 *
 * O CAMINHO
 *
 *   1. `iniciar` — o navegador pede; o servidor grava o pedido em voo
 *      (verificador PKCE, nonce, impressões do `state` e da CHAVE DO
 *      NAVEGADOR) e devolve o endereço do Google e a chave do navegador.
 *   2. O Google autentica a pessoa e devolve `code` + `state` para a tela
 *      `/minha-conta/google` (o endereço de retorno cadastrado).
 *   3. `concluir` — a tela manda `code`, `state` e a chave do navegador; o
 *      servidor confere o pedido em voo (existe, é deste navegador, não
 *      venceu, não foi usado), troca o código com o segredo do cliente,
 *      verifica o id_token e decide a conta.
 *
 * A CHAVE DO NAVEGADOR. `state` sozinho protege o servidor de uma volta que
 * ele não pediu — mas não protege a PESSOA de uma volta que o atacante pediu:
 * ele começa a entrada no navegador dele, pega o link de volta com o `code`
 * da conta Google DELE e manda para a vítima, que abre e fica logada na conta
 * do atacante (e compra lá, com o endereço dela). A chave aleatória fica no
 * `sessionStorage` do navegador que começou, e só ele conclui.
 *
 * DE QUEM É A CONTA — a ordem da decisão:
 *
 *   a. A identidade (emissor + sub) já está ligada a uma conta → é ela.
 *   b. Existe conta com o MESMO e-mail → a identidade se liga a ela. O Google
 *      provou a caixa; a conta, se já tinha provado, é da mesma pessoa. Se a
 *      conta NÃO tinha provado a caixa, quem a criou pode não ser o dono do
 *      e-mail (alguém cria conta com o e-mail alheio e espera): aí vale o que
 *      a recuperação de senha já faz — a caixa provada assume, a senha de
 *      quem não provou deixa de valer e todas as sessões caem.
 *   c. Não existe conta → nasce uma, sem senha, com o e-mail já provado. O
 *      aceite dos termos é exigido como no cadastro: se não veio no começo,
 *      a identidade verificada espera o aceite (ticket de uso único).
 *
 * O e-mail que o Google NÃO verificou não entra — nem para criar, nem para
 * ligar: e-mail não verificado não prova caixa de ninguém.
 */
import { randomUUID } from 'node:crypto';
import { ensureCoreSchema } from '../../db/schema.js';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ApiError, logInfo } from '../../utils/errors.js';
import { recordAudit } from '../audit/AuditService.js';
import { queueContaCriadaEmail, queueGoogleLigadoEmail } from '../notifications/EmailService.js';
import {
  abrirSessaoPorIdentidadeProvada,
  empresaParaEmailDaConta,
  exigirAceiteDosTermos,
  resolveCustomerSession,
  type CustomerSession,
} from './CustomerPortalService.js';
import {
  ENDPOINTS_DO_GOOGLE,
  clienteRegistradoParaTeste,
  configuracaoEmUso,
  googleDisponivel,
  type ConfiguracaoEmUso,
  type ModoDoProvedor,
} from './GoogleLoginConfigService.js';
import {
  CacheDeChaves,
  aleatorio,
  gerarPkce,
  impressao,
  mesmaImpressao,
  montarUrlDeAutorizacao,
  transporteHttp,
  trocarCodigoPorIdToken,
  verificarIdTokenComCache,
  type ClaimsDoIdToken,
  type TransporteOidc,
} from './OidcClient.js';
import { transporteDoProvedorDeTeste } from './ProvedorGoogleDeTeste.js';

/** Dez minutos para ir ao Google e voltar — o mesmo prazo do `code` deles. */
const PRAZO_DO_PEDIDO_MS = 10 * 60 * 1000;
/** Dez minutos para aceitar os termos depois de o Google responder. */
const PRAZO_DOS_TERMOS_MS = 10 * 60 * 1000;
/** Pedidos em voo mais velhos que isto são apagados na próxima entrada. */
const FAXINA_MS = 24 * 60 * 60 * 1000;

/**
 * O marcador de "sem senha" em `password_hash` (a coluna é NOT NULL).
 * Não é Argon2 (`$argon2…`) nem SHA-256 hexadecimal: `verifyPassword` nunca
 * o aceita, e `has_password = 0` diz a mesma coisa em coluna própria.
 */
export const SEM_SENHA = '!sem-senha:entra-pelo-google';

// ------------------------------------------------------- o transporte

/**
 * Quem leva as chamadas ao provedor. Os testes trocam por um dublê; o
 * provedor de teste usa o seu, em processo. Nunca a rede nos testes.
 */
let transporteDoGoogle: TransporteOidc = transporteHttp;

export function definirTransporteDoGoogleParaTestes(t: TransporteOidc | null): void {
  transporteDoGoogle = t ?? transporteHttp;
  caches.clear();
}

const caches = new Map<string, CacheDeChaves>();

function transporteDe(cfg: ConfiguracaoEmUso): TransporteOidc {
  return cfg.modo === 'teste' ? transporteDoProvedorDeTeste(clienteRegistradoParaTeste()) : transporteDoGoogle;
}

function cacheDe(cfg: ConfiguracaoEmUso): CacheDeChaves {
  // Um cache por (modo, endereço): trocar de modo não herda chave do outro.
  const chave = `${cfg.modo}:${cfg.endpoints.jwks}`;
  let cache = caches.get(chave);
  if (!cache) {
    cache = new CacheDeChaves(cfg.endpoints.jwks, transporteDe(cfg));
    caches.set(chave, cache);
  }
  return cache;
}

// ---------------------------------------------------------- utilidades

function normalizarEmail(bruto: string): string {
  return String(bruto ?? '').trim().toLowerCase();
}

/** Só caminho interno: `/algo`, nunca `//outro-site` nem endereço completo. */
function voltaSegura(valor: unknown): string | null {
  if (typeof valor !== 'string' || !valor) return null;
  return /^\/(?!\/)[\w\-/]*(\?[\w=&\-%.]*)?$/.test(valor) ? valor : null;
}

function estadoInvalido(motivo: string): ApiError {
  return new ApiError(
    'PORTAL_GOOGLE_ESTADO_INVALIDO',
    'Esta volta do Google não pode ser concluída aqui (ela vale uma vez, por poucos minutos, e só no navegador que começou). Tente entrar de novo.',
    400,
    { motivo },
  );
}

interface LinhaDoPedido {
  id: string;
  browser_key_hash: string;
  nonce: string;
  code_verifier: string;
  intent: 'entrar' | 'vincular';
  account_id: string | null;
  terms_accepted: number;
  return_to: string | null;
  provider_mode: ModoDoProvedor;
  status: 'pendente' | 'aguardando_termos' | 'concluido';
  verified_issuer: string | null;
  verified_sub: string | null;
  verified_email: string | null;
  verified_name: string | null;
  expires_at: string;
  used_at: string | null;
}

// -------------------------------------------------------------- 1. iniciar

export interface InicioDoGoogle {
  authorizationUrl: string;
  /** Guardada pelo navegador que começou; só ele conclui. */
  browserKey: string;
  expiresAt: string;
  modo: ModoDoProvedor;
}

export function iniciarLoginGoogle(input: {
  intent?: unknown;
  termsAccepted?: unknown;
  returnTo?: unknown;
  /** Obrigatória para ligar o Google a uma conta já aberta. */
  sessionToken?: string | null;
  /** Onde mora a tela de consentimento do provedor de teste (só modo teste). */
  enderecoDoProvedorDeTeste: string;
}): InicioDoGoogle {
  ensureCoreSchema();
  const cfg = configuracaoEmUso();
  const intent = input.intent === 'vincular' ? 'vincular' : 'entrar';

  let accountId: string | null = null;
  if (intent === 'vincular') {
    const sessao = resolveCustomerSession(input.sessionToken ?? null);
    if (!sessao) {
      throw new ApiError('PORTAL_UNAUTHENTICATED', 'Entre na sua conta para ligar o Google a ela.', 401);
    }
    accountId = sessao.account.id;
  }

  const state = aleatorio();
  const nonce = aleatorio();
  const browserKey = aleatorio();
  const pkce = gerarPkce();
  const agora = Date.now();
  const expiraEm = new Date(agora + PRAZO_DO_PEDIDO_MS).toISOString();

  const db = getConnection();
  withTransaction(() => {
    // Faxina: pedido em voo tem vida de minutos; a tabela não guarda história.
    db.prepare('DELETE FROM core_portal_google_states WHERE created_at < ?').run(
      new Date(agora - FAXINA_MS).toISOString(),
    );
    db.prepare(
      `INSERT INTO core_portal_google_states
         (id, state_hash, browser_key_hash, nonce, code_verifier, intent, account_id,
          terms_accepted, return_to, provider_mode, status, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendente', ?, ?)`,
    ).run(
      randomUUID(),
      impressao(state),
      impressao(browserKey),
      nonce,
      pkce.verificador,
      intent,
      accountId,
      // Só o booleano true é aceite (a mesma régua de `exigirAceiteDosTermos`).
      input.termsAccepted === true ? 1 : 0,
      voltaSegura(input.returnTo),
      cfg.modo,
      expiraEm,
      new Date(agora).toISOString(),
    );
  });

  return {
    authorizationUrl: montarUrlDeAutorizacao({
      endpoint: cfg.modo === 'teste' ? input.enderecoDoProvedorDeTeste : ENDPOINTS_DO_GOOGLE.autorizacao,
      clientId: cfg.clientId,
      redirectUri: cfg.redirectUri,
      state,
      nonce,
      desafioPkce: pkce.desafio,
    }),
    browserKey,
    expiresAt: expiraEm,
    modo: cfg.modo,
  };
}

// ------------------------------------------------------------- 2. concluir

export type ResultadoDoGoogle =
  | { status: 'sessao'; session: CustomerSession; returnTo: string | null; contaNova: boolean }
  | { status: 'termos_pendentes'; ticket: string; email: string; name: string | null; returnTo: string | null }
  | { status: 'vinculado'; googleEmail: string; returnTo: string | null };

/** A identidade que o id_token provou. */
interface IdentidadeProvada {
  issuer: string;
  sub: string;
  email: string;
  name: string | null;
}

function identidadeDe(claims: ClaimsDoIdToken): IdentidadeProvada {
  // SÓ o booleano true (ou o texto "true", que alguns emissores mandam).
  // Ausente, falso ou qualquer outra coisa: o provedor NÃO provou a caixa.
  const verificado = claims.email_verified === true || claims.email_verified === 'true';
  const email = normalizarEmail(claims.email ?? '');
  if (!email.includes('@') || !verificado) {
    throw new ApiError(
      'PORTAL_GOOGLE_EMAIL_NAO_VERIFICADO',
      'A conta Google não tem o e-mail verificado. Verifique o e-mail no Google, ou crie a conta com e-mail e senha.',
      403,
    );
  }
  const nome = typeof claims.name === 'string' && claims.name.trim() ? claims.name.trim() : null;
  return { issuer: claims.iss, sub: claims.sub, email, name: nome };
}

export async function concluirLoginGoogle(input: {
  code?: unknown;
  state?: unknown;
  browserKey?: unknown;
  sessionToken?: string | null;
  ip?: string | null;
}): Promise<ResultadoDoGoogle> {
  ensureCoreSchema();
  const cfg = configuracaoEmUso();
  const code = typeof input.code === 'string' ? input.code : '';
  const state = typeof input.state === 'string' ? input.state : '';
  const browserKey = typeof input.browserKey === 'string' ? input.browserKey : '';
  if (!code || !state || !browserKey) throw estadoInvalido('campos');

  const db = getConnection();
  const pedido = db
    .prepare('SELECT * FROM core_portal_google_states WHERE state_hash = ?')
    .get(impressao(state)) as LinhaDoPedido | undefined;
  if (!pedido) throw estadoInvalido('desconhecido');
  // O navegador que volta tem de ser o que começou. Conferido ANTES de
  // consumir: o link aberto no navegador errado não queima a entrada certa.
  if (!mesmaImpressao(pedido.browser_key_hash, impressao(browserKey))) throw estadoInvalido('navegador');
  if (pedido.used_at || pedido.status !== 'pendente') throw estadoInvalido('usado');
  if (new Date(pedido.expires_at).getTime() < Date.now()) throw estadoInvalido('vencido');
  if (pedido.provider_mode !== cfg.modo) throw estadoInvalido('configuracao_trocada');

  // USO ÚNICO, atômico: duas abas mandando a mesma volta — só uma passa.
  const consumido = db
    .prepare(
      `UPDATE core_portal_google_states SET used_at = ?, code_verifier = ''
        WHERE id = ? AND used_at IS NULL`,
    )
    .run(new Date().toISOString(), pedido.id);
  if (Number(consumido.changes) !== 1) throw estadoInvalido('usado');

  const transporte = transporteDe(cfg);
  const idToken = await trocarCodigoPorIdToken({
    endpoint: cfg.endpoints.token,
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
    code,
    verificadorPkce: pedido.code_verifier,
    redirectUri: cfg.redirectUri,
    transporte,
  });
  const claims = await verificarIdTokenComCache(cacheDe(cfg), {
    idToken,
    emissores: cfg.endpoints.emissores,
    clientId: cfg.clientId,
    nonce: pedido.nonce,
  });
  const identidade = identidadeDe(claims);

  if (pedido.intent === 'vincular') {
    return vincularAContaAberta(pedido, identidade, input.sessionToken ?? null, input.ip ?? null);
  }

  const existente = contaPorIdentidade(identidade) ?? contaPorEmail(identidade.email);
  if (existente) {
    const session = entrarNaContaExistente(existente, identidade, input.ip ?? null);
    marcarConcluido(pedido.id);
    return { status: 'sessao', session, returnTo: pedido.return_to, contaNova: false };
  }

  if (pedido.terms_accepted === 1) {
    const session = criarContaPeloGoogle(identidade, input.ip ?? null);
    marcarConcluido(pedido.id);
    return { status: 'sessao', session, returnTo: pedido.return_to, contaNova: true };
  }

  // Conta nova sem aceite: a identidade verificada espera o aceite.
  const ticket = aleatorio();
  db.prepare(
    `UPDATE core_portal_google_states
        SET status = 'aguardando_termos', ticket_hash = ?, verified_issuer = ?, verified_sub = ?,
            verified_email = ?, verified_name = ?, expires_at = ?
      WHERE id = ?`,
  ).run(
    impressao(ticket),
    identidade.issuer,
    identidade.sub,
    identidade.email,
    identidade.name,
    new Date(Date.now() + PRAZO_DOS_TERMOS_MS).toISOString(),
    pedido.id,
  );
  return {
    status: 'termos_pendentes',
    ticket,
    email: identidade.email,
    name: identidade.name,
    returnTo: pedido.return_to,
  };
}

function marcarConcluido(id: string): void {
  getConnection()
    .prepare(`UPDATE core_portal_google_states SET status = 'concluido' WHERE id = ?`)
    .run(id);
}

// --------------------------------------------------- 3. aceitar os termos

export function aceitarTermosDoGoogle(input: {
  ticket?: unknown;
  browserKey?: unknown;
  termsAccepted?: unknown;
  ip?: string | null;
}): { session: CustomerSession; returnTo: string | null; contaNova: boolean } {
  ensureCoreSchema();
  exigirAceiteDosTermos(input.termsAccepted);
  // O modo pode ter sido desligado entre a volta e o aceite: vale o de agora.
  configuracaoEmUso();
  const ticket = typeof input.ticket === 'string' ? input.ticket : '';
  const browserKey = typeof input.browserKey === 'string' ? input.browserKey : '';
  if (!ticket || !browserKey) throw estadoInvalido('campos');

  const db = getConnection();
  const pedido = db
    .prepare(`SELECT * FROM core_portal_google_states WHERE ticket_hash = ?`)
    .get(impressao(ticket)) as LinhaDoPedido | undefined;
  if (!pedido) throw estadoInvalido('desconhecido');
  if (!mesmaImpressao(pedido.browser_key_hash, impressao(browserKey))) throw estadoInvalido('navegador');
  if (pedido.status !== 'aguardando_termos') throw estadoInvalido('usado');
  if (new Date(pedido.expires_at).getTime() < Date.now()) throw estadoInvalido('vencido');

  const concluido = db
    .prepare(
      `UPDATE core_portal_google_states SET status = 'concluido'
        WHERE id = ? AND status = 'aguardando_termos'`,
    )
    .run(pedido.id);
  if (Number(concluido.changes) !== 1) throw estadoInvalido('usado');

  const identidade: IdentidadeProvada = {
    issuer: String(pedido.verified_issuer),
    sub: String(pedido.verified_sub),
    email: String(pedido.verified_email),
    name: pedido.verified_name,
  };
  // Entre a volta e o aceite, a conta pode ter nascido por outro caminho.
  const existente = contaPorIdentidade(identidade) ?? contaPorEmail(identidade.email);
  if (existente) {
    return {
      session: entrarNaContaExistente(existente, identidade, input.ip ?? null),
      returnTo: pedido.return_to,
      contaNova: false,
    };
  }
  return {
    session: criarContaPeloGoogle(identidade, input.ip ?? null),
    returnTo: pedido.return_to,
    contaNova: true,
  };
}

// ------------------------------------------------------ as contas

interface ContaAchada {
  id: string;
  email: string;
  active: number;
  email_verified_at: string | null;
  has_password: number;
  /** Achada pela identidade (true) ou pelo e-mail (false). */
  pelaIdentidade: boolean;
}

function contaPorIdentidade(i: IdentidadeProvada): ContaAchada | null {
  const linha = getConnection()
    .prepare(
      `SELECT a.id, a.email, a.active, a.email_verified_at, a.has_password
         FROM core_customer_identities x
         JOIN core_customer_accounts a ON a.id = x.account_id
        WHERE x.issuer = ? AND x.subject = ?`,
    )
    .get(i.issuer, i.sub) as Omit<ContaAchada, 'pelaIdentidade'> | undefined;
  return linha ? { ...linha, pelaIdentidade: true } : null;
}

function contaPorEmail(email: string): ContaAchada | null {
  const linha = getConnection()
    .prepare(
      `SELECT id, email, active, email_verified_at, has_password
         FROM core_customer_accounts WHERE email = ?`,
    )
    .get(email) as Omit<ContaAchada, 'pelaIdentidade'> | undefined;
  return linha ? { ...linha, pelaIdentidade: false } : null;
}

function contaInativa(): ApiError {
  return new ApiError('PORTAL_CONTA_INATIVA', 'Esta conta está desativada. Fale com a loja.', 403);
}

function auditar(accountId: string, action: string, detail: Record<string, unknown>, ip: string | null): void {
  // Evento do CLIENTE, não de uma operação: `company_id` nulo é o honesto.
  recordAudit({
    companyId: null,
    userId: null,
    action,
    entityType: 'customer_account',
    entityId: accountId,
    detail,
    ip,
  });
}

function entrarNaContaExistente(
  conta: ContaAchada,
  identidade: IdentidadeProvada,
  ip: string | null,
): CustomerSession {
  if (conta.active !== 1) throw contaInativa();
  const db = getConnection();
  const agora = new Date().toISOString();

  if (conta.pelaIdentidade) {
    db.prepare(
      `UPDATE core_customer_identities SET last_login_at = ?, email = ?
        WHERE issuer = ? AND subject = ?`,
    ).run(agora, identidade.email, identidade.issuer, identidade.sub);
    logInfo('PORTAL_GOOGLE_ENTROU', { accountId: conta.id });
    return abrirSessaoPorIdentidadeProvada(conta.id);
  }

  // Pelo e-mail: a conta ainda não tem esta identidade.
  const outraGoogle = db
    .prepare(`SELECT email FROM core_customer_identities WHERE account_id = ? AND provider = 'google'`)
    .get(conta.id) as { email: string | null } | undefined;
  if (outraGoogle) {
    // A conta já entra por OUTRA conta Google. Trocar em silêncio daria a
    // conta a quem tem a segunda; quem é dono das duas desliga e liga.
    throw new ApiError(
      'PORTAL_GOOGLE_OUTRA_IDENTIDADE',
      'Esta conta já está ligada a outra conta Google. Entre por ela, ou entre com a senha e desligue o Google em "Minha conta" antes de trocar.',
      409,
    );
  }

  const assumiu = !conta.email_verified_at;
  withTransaction(() => {
    if (assumiu) {
      /*
        A CAIXA PROVADA ASSUME A CONTA QUE NUNCA PROVOU. Quem criou esta
        conta não provou ser dono do e-mail — pode ter sido o próprio dono,
        pode ter sido alguém à espera (o golpe da conta pré-criada). É o que
        a recuperação de senha já faz quando o link volta: a senha de quem
        não provou deixa de valer, todas as sessões caem, e o CPF/CNPJ que
        foi declarado sem prova sai (ele se declara uma vez e trava — não
        pode ficar travado pelo que outra pessoa digitou). Nome e telefone
        ficam: a pessoa vê e corrige.
      */
      db.prepare(
        `UPDATE core_customer_accounts
            SET email_verified_at = ?, password_hash = ?, has_password = 0, document = NULL,
                updated_at = ?
          WHERE id = ?`,
      ).run(agora, SEM_SENHA, agora, conta.id);
      db.prepare('UPDATE core_customer_sessions SET revoked = 1 WHERE account_id = ?').run(conta.id);
      db.prepare(
        'UPDATE core_customer_password_resets SET used_at = ? WHERE account_id = ? AND used_at IS NULL',
      ).run(agora, conta.id);
    }
    db.prepare(
      `INSERT INTO core_customer_identities
         (id, account_id, provider, issuer, subject, email, created_at, last_login_at)
       VALUES (?, ?, 'google', ?, ?, ?, ?, ?)`,
    ).run(randomUUID(), conta.id, identidade.issuer, identidade.sub, identidade.email, agora, agora);
    avisarLigacao(conta.id, conta.email, identidade.email);
    auditar(
      conta.id,
      assumiu ? 'portal.google.assumiu_conta_nao_provada' : 'portal.google.ligado_por_email',
      { googleEmail: identidade.email, issuer: identidade.issuer },
      ip,
    );
  });
  logInfo('PORTAL_GOOGLE_LIGADO', { accountId: conta.id, assumiu });
  return abrirSessaoPorIdentidadeProvada(conta.id);
}

function criarContaPeloGoogle(identidade: IdentidadeProvada, ip: string | null): CustomerSession {
  const db = getConnection();
  const id = randomUUID();
  const agora = new Date().toISOString();
  withTransaction(() => {
    db.prepare(
      `INSERT INTO core_customer_accounts
         (id, email, password_hash, has_password, accepted_terms_at, email_verified_at, name,
          active, created_at, updated_at)
       VALUES (?, ?, ?, 0, ?, ?, ?, 1, ?, ?)`,
      // O MOMENTO do aceite é a prova que a LGPD pede. O e-mail nasce
      // provado: foi o Google que o verificou. O nome é o do Google — a
      // pessoa corrige em "Meus dados".
    ).run(id, identidade.email, SEM_SENHA, agora, agora, identidade.name, agora, agora);
    db.prepare(
      `INSERT INTO core_customer_identities
         (id, account_id, provider, issuer, subject, email, created_at, last_login_at)
       VALUES (?, ?, 'google', ?, ?, ?, ?, ?)`,
    ).run(randomUUID(), id, identidade.issuer, identidade.sub, identidade.email, agora, agora);
    const companyId = empresaParaEmailDaConta(id);
    if (companyId) {
      queueContaCriadaEmail({ companyId, toAddress: identidade.email, dedupeKey: `conta_criada:${id}` });
    }
    auditar(id, 'portal.google.conta_criada', { googleEmail: identidade.email, issuer: identidade.issuer }, ip);
  });
  logInfo('PORTAL_GOOGLE_CONTA_CRIADA', { accountId: id });
  return abrirSessaoPorIdentidadeProvada(id);
}

function avisarLigacao(accountId: string, emailDaConta: string, googleEmail: string): void {
  const companyId = empresaParaEmailDaConta(accountId);
  if (!companyId) return;
  queueGoogleLigadoEmail({
    companyId,
    toAddress: emailDaConta,
    googleEmail,
    dedupeKey: `google_ligado:${accountId}:${impressao(googleEmail).slice(0, 16)}:${Date.now()}`,
  });
}

// ------------------------------------------- ligar à conta já aberta

function vincularAContaAberta(
  pedido: LinhaDoPedido,
  identidade: IdentidadeProvada,
  sessionToken: string | null,
  ip: string | null,
): ResultadoDoGoogle {
  const sessao = resolveCustomerSession(sessionToken);
  // A sessão que volta tem de ser a que pediu: outra conta no mesmo
  // navegador (alguém saiu e outro entrou no meio) não herda o Google.
  if (!sessao || sessao.account.id !== pedido.account_id) {
    marcarConcluido(pedido.id);
    throw new ApiError(
      'PORTAL_UNAUTHENTICATED',
      'A sessão que pediu para ligar o Google não é mais esta. Entre na conta e tente de novo.',
      401,
    );
  }
  const db = getConnection();
  const dona = contaPorIdentidade(identidade);
  if (dona && dona.id !== sessao.account.id) {
    marcarConcluido(pedido.id);
    throw new ApiError(
      'PORTAL_GOOGLE_JA_LIGADO',
      'Esta conta Google já entra em outra conta da loja. Entre por ela e desligue o Google lá antes.',
      409,
    );
  }
  if (!dona) {
    const jaTem = db
      .prepare(`SELECT 1 FROM core_customer_identities WHERE account_id = ? AND provider = 'google'`)
      .get(sessao.account.id);
    if (jaTem) {
      marcarConcluido(pedido.id);
      throw new ApiError(
        'PORTAL_GOOGLE_OUTRA_IDENTIDADE',
        'Sua conta já está ligada a outra conta Google. Desligue a atual antes de ligar esta.',
        409,
      );
    }
    const agora = new Date().toISOString();
    withTransaction(() => {
      db.prepare(
        `INSERT INTO core_customer_identities
           (id, account_id, provider, issuer, subject, email, created_at, last_login_at)
         VALUES (?, ?, 'google', ?, ?, ?, ?, NULL)`,
      ).run(randomUUID(), sessao.account.id, identidade.issuer, identidade.sub, identidade.email, agora);
      avisarLigacao(sessao.account.id, sessao.account.email, identidade.email);
      auditar(
        sessao.account.id,
        'portal.google.ligado_pela_conta',
        { googleEmail: identidade.email, issuer: identidade.issuer },
        ip,
      );
    });
  }
  marcarConcluido(pedido.id);
  return { status: 'vinculado', googleEmail: identidade.email, returnTo: pedido.return_to };
}

// --------------------------------------------- o Google na conta aberta

export interface GoogleNaConta {
  /** A loja oferece a entrada pelo Google agora? */
  disponivel: boolean;
  modo: ModoDoProvedor | null;
  ligado: { email: string | null; desde: string; ultimaEntrada: string | null } | null;
  temSenha: boolean;
}

export function googleNaConta(accountId: string): GoogleNaConta {
  ensureCoreSchema();
  const db = getConnection();
  const conta = db
    .prepare('SELECT has_password FROM core_customer_accounts WHERE id = ?')
    .get(accountId) as { has_password: number } | undefined;
  const identidade = db
    .prepare(
      `SELECT email, created_at, last_login_at FROM core_customer_identities
        WHERE account_id = ? AND provider = 'google'`,
    )
    .get(accountId) as { email: string | null; created_at: string; last_login_at: string | null } | undefined;
  const disp = googleDisponivel();
  return {
    disponivel: disp.disponivel,
    modo: disp.modo,
    ligado: identidade
      ? { email: identidade.email, desde: identidade.created_at, ultimaEntrada: identidade.last_login_at }
      : null,
    temSenha: Number(conta?.has_password ?? 1) === 1,
  };
}

/**
 * Desliga o Google da conta. Não deixa a conta sem porta: sem senha, o
 * Google é a única entrada, e desligá-lo trancaria a pessoa do lado de fora.
 */
export function desligarGoogle(accountId: string, ip: string | null): GoogleNaConta {
  ensureCoreSchema();
  const db = getConnection();
  const atual = googleNaConta(accountId);
  if (!atual.ligado) {
    throw new ApiError('PORTAL_GOOGLE_NAO_LIGADO', 'Esta conta não está ligada ao Google.', 404);
  }
  if (!atual.temSenha) {
    throw new ApiError(
      'PORTAL_GOOGLE_UNICA_ENTRADA',
      'O Google é a única forma de entrar nesta conta. Crie uma senha antes ("Esqueci minha senha" na tela de entrar) e depois desligue.',
      409,
    );
  }
  withTransaction(() => {
    db.prepare(`DELETE FROM core_customer_identities WHERE account_id = ? AND provider = 'google'`).run(accountId);
    auditar(accountId, 'portal.google.desligado', { googleEmail: atual.ligado?.email ?? null }, ip);
  });
  return googleNaConta(accountId);
}
