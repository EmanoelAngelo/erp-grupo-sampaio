/**
 * GAP-PRD-027 — ENTRAR COM GOOGLE, DE PONTA A PONTA.
 *
 * A auditoria mediu: nenhuma rota, nenhum adapter, nenhum botão — e "Login
 * Google com OAuth fake: UNABLE_TO_PROVE, não há adapter para falsear". Este
 * arquivo cobra o fluxo inteiro pela API, com o PROVEDOR DE TESTE (o "Google"
 * que mora dentro da API) e com o Google de verdade dublado no transporte —
 * nenhuma chamada sai para a rede.
 *
 *   - Authorization Code + PKCE S256, `state`, `nonce` e a chave do navegador
 *     que começou (login CSRF);
 *   - id_token conferido pela chave publicada (JWKS): assinatura, emissor,
 *     audiência, validade, nonce — e `alg: none`/HS256 recusados;
 *   - e-mail verificado exigido; vínculo com a conta de mesmo e-mail; a
 *     conta que nunca provou a caixa é assumida como na recuperação de senha;
 *   - conta sem senha: o login por senha recusa igual, a troca de senha
 *     manda para a recuperação, e a recuperação dá a primeira senha;
 *   - aceite dos termos na conta nova; ligar e desligar o Google na conta;
 *   - a configuração da instalação: só os donos do grupo, segredo selado e
 *     nunca devolvido, trilha sem segredo;
 *   - o provedor de teste recusado em produção, homologação e com
 *     NODE_ENV=production — na gravação, na execução e nas rotas.
 */
process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_JWT_SECRET = 'login-google-jwt-secret-suficientemente-longo-2026';
process.env.DEVORA_ENCRYPTION_KEY = 'login-google-encryption-key-suficientemente-longa-2026';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  createHash,
  generateKeyPairSync,
  sign,
  type JsonWebKey,
  type KeyObject,
} from 'node:crypto';
import { createApp } from '../src/app.js';
import { resetEnvCacheForTests } from '../src/config/env.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import { confirmarEmail } from '../src/services/core/CustomerPortalService.js';
import { decryptFiscalSecret } from '../src/services/fiscal/FiscalSecretVault.js';
import {
  CacheDeChaves,
  desafioDoPkce,
  verificarIdToken,
  type TransporteOidc,
} from '../src/services/core/OidcClient.js';
import {
  ENDPOINTS_DO_PROVEDOR_DE_TESTE,
  provedorDeTestePermitido,
  transporteDoProvedorDeTeste,
} from '../src/services/core/ProvedorGoogleDeTeste.js';
import {
  configuracaoEmUso,
  googleDisponivel,
  salvarConfiguracaoGoogle,
} from '../src/services/core/GoogleLoginConfigService.js';
import {
  SEM_SENHA,
  definirTransporteDoGoogleParaTestes,
} from '../src/services/core/GoogleLoginService.js';
import { ApiError } from '../src/utils/errors.js';
import { loginForTest } from './helpers/auth.js';
import { textoDeEntrega } from '../src/services/notifications/EmailService.js';

const app = createApp();
const SENHA = 'senha-do-cliente-2026';
const RETORNO = 'http://localhost:19510/minha-conta/google';
const SEGREDO_DE_TESTE = 'segredo-do-cliente-de-teste-9f8e';
const BASE = '/api/v1/loja/portal';

let admin: string;

function emAmbiente(nome: 'development' | 'test' | 'staging' | 'production', nodeEnv?: string) {
  process.env.DEVORA_API_ENV = nome;
  if (nodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = nodeEnv;
  resetEnvCacheForTests();
}

const NODE_ENV_ORIGINAL = process.env.NODE_ENV;

async function configurarTeste(extra: Record<string, unknown> = {}) {
  const res = await request(app)
    .put('/api/v1/core/portal/login-google')
    .set('Authorization', `Bearer ${admin}`)
    .send({
      enabled: true,
      providerMode: 'teste',
      clientId: 'cliente-de-teste-loja',
      clientSecret: SEGREDO_DE_TESTE,
      redirectUri: RETORNO,
      ...extra,
    });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res;
}

interface Pessoa {
  email: string;
  name?: string;
  emailVerified?: boolean;
}

/** A dança inteira com o provedor de teste: iniciar → consentir → voltar. */
async function dancaDoGoogle(
  pessoa: Pessoa,
  opcoes: { termsAccepted?: boolean; intent?: string; token?: string; returnTo?: string } = {},
) {
  const inicio = await request(app)
    .post(`${BASE}/google/iniciar`)
    .set(opcoes.token ? { 'x-portal-token': opcoes.token } : {})
    .send({ termsAccepted: opcoes.termsAccepted, intent: opcoes.intent, returnTo: opcoes.returnTo });
  expect(inicio.status, JSON.stringify(inicio.body)).toBe(200);
  const autorizacao = new URL(inicio.body.authorizationUrl as string);

  // A tela de consentimento de teste.
  const tela = await request(app).get(autorizacao.pathname + autorizacao.search);
  expect(tela.status, tela.text).toBe(200);
  expect(tela.text).toContain('Isto NÃO é o Google');

  const confirmar = new URL(autorizacao.toString());
  confirmar.pathname += '/confirmar';
  confirmar.searchParams.set('email', pessoa.email);
  if (pessoa.name) confirmar.searchParams.set('name', pessoa.name);
  if (pessoa.emailVerified !== false) confirmar.searchParams.set('email_verified', 'true');
  confirmar.searchParams.set('decisao', 'autorizar');
  const volta = await request(app).get(confirmar.pathname + confirmar.search);
  expect(volta.status, volta.text).toBe(302);
  const destino = new URL(volta.headers.location as string);
  expect(`${destino.origin}${destino.pathname}`).toBe(RETORNO);

  return {
    code: destino.searchParams.get('code') as string,
    state: destino.searchParams.get('state') as string,
    browserKey: inicio.body.browserKey as string,
    autorizacao,
  };
}

async function concluir(v: { code: string; state: string; browserKey: string }, token?: string) {
  return request(app)
    .post(`${BASE}/google/concluir`)
    .set(token ? { 'x-portal-token': token } : {})
    .send({ code: v.code, state: v.state, browserKey: v.browserKey });
}

async function contaComSenha(email: string, document?: string) {
  const res = await request(app)
    .post(`${BASE}/registrar`)
    .send({ termsAccepted: true, email, password: SENHA, document });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { token: res.body.token as string, accountId: res.body.account.id as string };
}

function provarCaixa(accountId: string, email: string): void {
  const linha = getConnection()
    .prepare(
      `SELECT id FROM core_email_queue
        WHERE template = 'verificacao_email' AND to_address = ?
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(email) as { id: string } | undefined;
  const codigo = (linha ? textoDeEntrega(linha.id) : null)?.match(/é: (\d{6})/)?.[1];
  expect(codigo).toBeTruthy();
  confirmarEmail({ accountId, codigo: codigo! });
}

function conta(email: string) {
  return getConnection()
    .prepare('SELECT * FROM core_customer_accounts WHERE email = ?')
    .get(email) as Record<string, unknown> | undefined;
}

beforeEach(async () => {
  emAmbiente('test', NODE_ENV_ORIGINAL);
  resetDbForTests();
  ensureCoreSchema();
  definirTransporteDoGoogleParaTestes(null);
  const login = await loginForTest(app, { userId: 'dono', companyId: 'gringa', profileCodes: ['admin_geral'] });
  expect(login.status).toBe(200);
  admin = login.body.accessToken as string;
});

afterEach(() => {
  emAmbiente('test', NODE_ENV_ORIGINAL);
  definirTransporteDoGoogleParaTestes(null);
});

// ============================================================================
// O fluxo com o provedor de teste
// ============================================================================

describe('conta nova pelo Google', () => {
  it('a vitrine só vê o botão depois de ligado, e sem nada da configuração', async () => {
    const antes = await request(app).get(`${BASE}/google/disponivel`);
    expect(antes.body).toEqual({ disponivel: false, modo: null });

    const iniciarDesligado = await request(app).post(`${BASE}/google/iniciar`).send({});
    expect(iniciarDesligado.status).toBe(503);
    expect(iniciarDesligado.body.error.code).toBe('PORTAL_GOOGLE_DESLIGADO');

    await configurarTeste();
    const depois = await request(app).get(`${BASE}/google/disponivel`);
    expect(depois.body).toEqual({ disponivel: true, modo: 'teste' });
    expect(JSON.stringify(depois.body)).not.toContain('cliente-de-teste-loja');
  });

  it('o endereço de autorização leva PKCE S256, state, nonce e só o escopo de identidade', async () => {
    await configurarTeste();
    const v = await dancaDoGoogle({ email: 'ana@gmail.com', name: 'Ana Google' }, { termsAccepted: true });
    const q = v.autorizacao.searchParams;
    expect(q.get('response_type')).toBe('code');
    expect(q.get('client_id')).toBe('cliente-de-teste-loja');
    expect(q.get('redirect_uri')).toBe(RETORNO);
    expect(q.get('scope')).toBe('openid email profile');
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('code_challenge')).toMatch(/^[\w-]{43}$/);
    expect(q.get('state')).toMatch(/^[\w-]{43}$/);
    expect(q.get('nonce')).toMatch(/^[\w-]{43}$/);

    // O banco guarda a IMPRESSÃO do state, nunca o state.
    const linha = getConnection()
      .prepare('SELECT state_hash, browser_key_hash FROM core_portal_google_states')
      .get() as { state_hash: string; browser_key_hash: string };
    expect(linha.state_hash).toBe(createHash('sha256').update(v.state).digest('hex'));
    expect(linha.state_hash).not.toBe(v.state);
    expect(linha.browser_key_hash).not.toBe(v.browserKey);
  });

  it('com o aceite no começo: nasce a conta, sem senha, com o e-mail provado e o nome do Google', async () => {
    await configurarTeste();
    const v = await dancaDoGoogle({ email: 'Ana@Gmail.com', name: 'Ana Google' }, { termsAccepted: true });
    const res = await concluir(v);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe('sessao');
    expect(res.body.contaNova).toBe(true);
    expect(res.body.session.account.email).toBe('ana@gmail.com');
    expect(res.body.session.account.emailVerifiedAt).toBeTruthy();

    const c = conta('ana@gmail.com')!;
    expect(c.has_password).toBe(0);
    expect(c.password_hash).toBe(SEM_SENHA);
    expect(c.accepted_terms_at).toBeTruthy();
    expect(c.name).toBe('Ana Google');

    const perfil = await request(app).get(`${BASE}/perfil`).set('x-portal-token', res.body.session.token);
    expect(perfil.status).toBe(200);
    expect(perfil.body).toMatchObject({ name: 'Ana Google', emailVerified: true, hasPassword: false });

    // A identidade: (emissor do provedor de teste, sub) — e nenhum token do Google guardado.
    const ids = getConnection().prepare('SELECT * FROM core_customer_identities').all() as Record<string, unknown>[];
    expect(ids).toHaveLength(1);
    expect(ids[0]).toMatchObject({ provider: 'google', issuer: ENDPOINTS_DO_PROVEDOR_DE_TESTE.emissor, email: 'ana@gmail.com' });
    expect(Object.keys(ids[0]!).some((k) => /token/i.test(k))).toBe(false);

    // O pedido em voo foi consumido, e o verificador PKCE apagado.
    const pedido = getConnection()
      .prepare('SELECT used_at, code_verifier, status FROM core_portal_google_states')
      .get() as { used_at: string; code_verifier: string; status: string };
    expect(pedido.used_at).toBeTruthy();
    expect(pedido.code_verifier).toBe('');
    expect(pedido.status).toBe('concluido');

    // A trilha do cliente.
    const trilha = getConnection()
      .prepare(`SELECT action, company_id FROM core_audit_log WHERE entity_type = 'customer_account'`)
      .all() as { action: string; company_id: string | null }[];
    expect(trilha).toEqual([{ action: 'portal.google.conta_criada', company_id: null }]);
  });

  it('a mesma volta NÃO vale duas vezes', async () => {
    await configurarTeste();
    const v = await dancaDoGoogle({ email: 'ana@gmail.com' }, { termsAccepted: true });
    expect((await concluir(v)).status).toBe(200);
    const denovo = await concluir(v);
    expect(denovo.status).toBe(400);
    expect(denovo.body.error.code).toBe('PORTAL_GOOGLE_ESTADO_INVALIDO');
  });

  it('entrar de novo com o mesmo Google cai na MESMA conta', async () => {
    await configurarTeste();
    const primeira = await concluir(await dancaDoGoogle({ email: 'ana@gmail.com' }, { termsAccepted: true }));
    const segunda = await concluir(await dancaDoGoogle({ email: 'ana@gmail.com' }));
    expect(segunda.status).toBe(200);
    expect(segunda.body.contaNova).toBe(false);
    expect(segunda.body.session.account.id).toBe(primeira.body.session.account.id);
    expect(segunda.body.session.token).not.toBe(primeira.body.session.token);

    // E sair encerra a sessão como qualquer outra.
    await request(app).post(`${BASE}/sair`).set('x-portal-token', segunda.body.session.token);
    const depois = await request(app).get(`${BASE}/perfil`).set('x-portal-token', segunda.body.session.token);
    expect(depois.status).toBe(401);
  });

  it('o cadastro de balcão com o mesmo e-mail (sem documento) chega pela conta', async () => {
    await configurarTeste();
    const agora = new Date().toISOString();
    getConnection()
      .prepare(
        `INSERT INTO core_customers (id, company_id, name, email, active, origin, created_at, updated_at)
         VALUES ('cli-balcao', 'gringa', 'Ana do Balcão', 'ana@gmail.com', 1, 'balcao', ?, ?)`,
      )
      .run(agora, agora);
    const res = await concluir(await dancaDoGoogle({ email: 'ana@gmail.com' }, { termsAccepted: true }));
    expect(res.body.session.customers.map((c: { customerId: string }) => c.customerId)).toEqual(['cli-balcao']);
  });

  it('para onde voltar: só caminho interno passa', async () => {
    await configurarTeste();
    const dentro = await concluir(
      await dancaDoGoogle({ email: 'ana@gmail.com' }, { termsAccepted: true, returnTo: '/gringa?carrinho=1' }),
    );
    expect(dentro.body.returnTo).toBe('/gringa?carrinho=1');
    const fora = await concluir(
      await dancaDoGoogle({ email: 'ana@gmail.com' }, { returnTo: '//golpe.example.com/entrar' }),
    );
    expect(fora.body.returnTo).toBeNull();
  });
});

describe('os termos da conta nova', () => {
  it('sem o aceite no começo, a identidade verificada espera o aceite — e só o true vale', async () => {
    await configurarTeste();
    const v = await dancaDoGoogle({ email: 'bia@gmail.com', name: 'Bia' });
    const res = await concluir(v);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'termos_pendentes', email: 'bia@gmail.com', name: 'Bia' });
    expect(conta('bia@gmail.com')).toBeUndefined();

    const semAceite = await request(app)
      .post(`${BASE}/google/aceitar-termos`)
      .send({ ticket: res.body.ticket, browserKey: v.browserKey, termsAccepted: 'true' });
    expect(semAceite.status).toBe(400);
    expect(semAceite.body.error.code).toBe('PORTAL_TERMS_REQUIRED');

    const outroNavegador = await request(app)
      .post(`${BASE}/google/aceitar-termos`)
      .send({ ticket: res.body.ticket, browserKey: 'chave-de-outro-navegador', termsAccepted: true });
    expect(outroNavegador.status).toBe(400);
    expect(outroNavegador.body.error.details.motivo).toBe('navegador');

    const aceite = await request(app)
      .post(`${BASE}/google/aceitar-termos`)
      .send({ ticket: res.body.ticket, browserKey: v.browserKey, termsAccepted: true });
    expect(aceite.status, JSON.stringify(aceite.body)).toBe(201);
    expect(aceite.body).toMatchObject({ status: 'sessao', contaNova: true });
    expect(conta('bia@gmail.com')!.accepted_terms_at).toBeTruthy();

    const repetido = await request(app)
      .post(`${BASE}/google/aceitar-termos`)
      .send({ ticket: res.body.ticket, browserKey: v.browserKey, termsAccepted: true });
    expect(repetido.status).toBe(400);
  });
});

describe('as conferências da volta', () => {
  it('a volta aberta em OUTRO navegador não conclui — e não queima a entrada certa', async () => {
    await configurarTeste();
    const v = await dancaDoGoogle({ email: 'ana@gmail.com' }, { termsAccepted: true });
    const atacante = await concluir({ ...v, browserKey: 'a-chave-do-navegador-da-vitima-nao-e-esta' });
    expect(atacante.status).toBe(400);
    expect(atacante.body.error.details.motivo).toBe('navegador');
    expect(conta('ana@gmail.com')).toBeUndefined();

    const dono = await concluir(v);
    expect(dono.status).toBe(200);
  });

  it('state desconhecido e pedido vencido são recusados', async () => {
    await configurarTeste();
    const v = await dancaDoGoogle({ email: 'ana@gmail.com' }, { termsAccepted: true });
    const inventado = await concluir({ ...v, state: 'state-que-ninguem-pediu' });
    expect(inventado.body.error.details.motivo).toBe('desconhecido');

    getConnection()
      .prepare('UPDATE core_portal_google_states SET expires_at = ?')
      .run(new Date(Date.now() - 1000).toISOString());
    const vencido = await concluir(v);
    expect(vencido.status).toBe(400);
    expect(vencido.body.error.details.motivo).toBe('vencido');
  });

  it('PKCE: sem o verificador certo, o provedor não troca o código', async () => {
    await configurarTeste();
    const v = await dancaDoGoogle({ email: 'ana@gmail.com' }, { termsAccepted: true });
    getConnection().prepare(`UPDATE core_portal_google_states SET code_verifier = 'verificador-errado-de-outra-entrada-xxxxxxxxxxxxxxxx'`).run();
    const res = await concluir(v);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PORTAL_GOOGLE_CODIGO_RECUSADO');
    expect(conta('ana@gmail.com')).toBeUndefined();
  });

  it('nonce: o id_token de outra entrada não serve nesta', async () => {
    await configurarTeste();
    const v = await dancaDoGoogle({ email: 'ana@gmail.com' }, { termsAccepted: true });
    getConnection().prepare(`UPDATE core_portal_google_states SET nonce = 'nonce-de-outra-entrada'`).run();
    const res = await concluir(v);
    expect(res.status).toBe(401);
    expect(res.body.error).toMatchObject({ code: 'PORTAL_GOOGLE_TOKEN_INVALIDO', details: { motivo: 'nonce' } });
    expect(conta('ana@gmail.com')).toBeUndefined();
  });

  it('e-mail que o Google NÃO verificou não cria nem liga conta', async () => {
    await configurarTeste();
    await contaComSenha('cai@gmail.com');
    for (const email of ['nova@gmail.com', 'cai@gmail.com']) {
      const res = await concluir(await dancaDoGoogle({ email, emailVerified: false }, { termsAccepted: true }));
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('PORTAL_GOOGLE_EMAIL_NAO_VERIFICADO');
    }
    expect(conta('nova@gmail.com')).toBeUndefined();
    expect(getConnection().prepare('SELECT COUNT(*) c FROM core_customer_identities').get()).toEqual({ c: 0 });
  });

  it('o provedor recusa endereço de retorno diferente do cadastrado', async () => {
    await configurarTeste();
    const inicio = await request(app).post(`${BASE}/google/iniciar`).send({});
    const url = new URL(inicio.body.authorizationUrl as string);
    url.searchParams.set('redirect_uri', 'https://golpe.example.com/minha-conta/google');
    const tela = await request(app).get(url.pathname + url.search);
    expect(tela.status).toBe(400);
    expect(tela.body.error.code).toBe('PROVEDOR_TESTE_REDIRECT_DIFERENTE');
  });

  it('recusar no provedor volta com access_denied, sem código', async () => {
    await configurarTeste();
    const inicio = await request(app).post(`${BASE}/google/iniciar`).send({});
    const url = new URL(inicio.body.authorizationUrl as string);
    url.pathname += '/confirmar';
    url.searchParams.set('decisao', 'recusar');
    const volta = await request(app).get(url.pathname + url.search);
    expect(volta.status).toBe(302);
    const destino = new URL(volta.headers.location as string);
    expect(destino.searchParams.get('error')).toBe('access_denied');
    expect(destino.searchParams.get('code')).toBeNull();
  });
});

describe('a conta que já existe com o mesmo e-mail', () => {
  it('conta com a caixa PROVADA: o Google se liga a ela, a senha continua e as sessões também', async () => {
    await configurarTeste();
    const { token, accountId } = await contaComSenha('dani@gmail.com');
    provarCaixa(accountId, 'dani@gmail.com');

    const res = await concluir(await dancaDoGoogle({ email: 'dani@gmail.com' }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'sessao', contaNova: false });
    expect(res.body.session.account.id).toBe(accountId);

    // Nada de quem já provou foi derrubado.
    expect((await request(app).get(`${BASE}/perfil`).set('x-portal-token', token)).status).toBe(200);
    const senha = await request(app).post(`${BASE}/entrar`).send({ email: 'dani@gmail.com', password: SENHA });
    expect(senha.status).toBe(200);

    // O dono do e-mail fica sabendo.
    const aviso = getConnection()
      .prepare(`SELECT to_address FROM core_email_queue WHERE template = 'google_ligado'`)
      .all();
    expect(aviso).toEqual([{ to_address: 'dani@gmail.com' }]);
  });

  it('conta que NUNCA provou a caixa (a pré-criada): o Google assume, a senha dela morre e as sessões caem', async () => {
    await configurarTeste();
    // Alguém criou a conta com o e-mail da vítima e declarou um CPF.
    const golpe = await contaComSenha('vitima@gmail.com');
    const perfil = await request(app)
      .put(`${BASE}/perfil`)
      .set('x-portal-token', golpe.token)
      .send({ document: '111.444.777-35' });
    expect(perfil.status).toBe(200);

    // A vítima entra com o Google.
    const res = await concluir(await dancaDoGoogle({ email: 'vitima@gmail.com' }));
    expect(res.status).toBe(200);
    expect(res.body.session.account.id).toBe(golpe.accountId);

    // A sessão e a senha de quem não provou a caixa não valem mais.
    expect((await request(app).get(`${BASE}/perfil`).set('x-portal-token', golpe.token)).status).toBe(401);
    const senha = await request(app).post(`${BASE}/entrar`).send({ email: 'vitima@gmail.com', password: SENHA });
    expect(senha.status).toBe(401);
    expect(senha.body.error.code).toBe('PORTAL_INVALID_CREDENTIALS');

    const c = conta('vitima@gmail.com')!;
    expect(c.has_password).toBe(0);
    expect(c.document).toBeNull();
    expect(c.email_verified_at).toBeTruthy();
    const trilha = getConnection()
      .prepare(`SELECT action FROM core_audit_log WHERE entity_type = 'customer_account'`)
      .all();
    expect(trilha).toEqual([{ action: 'portal.google.assumiu_conta_nao_provada' }]);
  });
});

describe('conta sem senha', () => {
  it('senha errada e conta sem senha recebem a MESMA resposta; a troca manda para a recuperação', async () => {
    await configurarTeste();
    const res = await concluir(await dancaDoGoogle({ email: 'eva@gmail.com' }, { termsAccepted: true }));
    const token = res.body.session.token as string;

    const semSenha = await request(app).post(`${BASE}/entrar`).send({ email: 'eva@gmail.com', password: SEM_SENHA });
    const inexistente = await request(app).post(`${BASE}/entrar`).send({ email: 'ninguem@gmail.com', password: 'qualquer-coisa' });
    expect(semSenha.status).toBe(401);
    expect(inexistente.status).toBe(401);
    expect(semSenha.body.error).toEqual(inexistente.body.error);

    const troca = await request(app)
      .post(`${BASE}/senha`)
      .set('x-portal-token', token)
      .send({ currentPassword: '', newPassword: 'nova-senha-2026' });
    expect(troca.status).toBe(409);
    expect(troca.body.error.code).toBe('PORTAL_CONTA_SEM_SENHA');
  });

  it('a recuperação de senha dá a primeira senha — e daí a senha também entra', async () => {
    await configurarTeste();
    await concluir(await dancaDoGoogle({ email: 'eva@gmail.com' }, { termsAccepted: true }));
    await request(app).post(`${BASE}/recuperar-senha`).send({ email: 'eva@gmail.com' });
    const corpo = getConnection()
      .prepare(`SELECT id FROM core_email_queue WHERE template = 'recuperacao_senha'`)
      .get() as { id: string };
    const tokenDoLink = textoDeEntrega(corpo.id)?.match(/token=([\w-]+)/)?.[1];
    expect(tokenDoLink).toBeTruthy();
    const redefinir = await request(app)
      .post(`${BASE}/redefinir-senha`)
      .send({ token: tokenDoLink, password: 'primeira-senha-2026' });
    expect(redefinir.status).toBe(200);
    expect(conta('eva@gmail.com')!.has_password).toBe(1);
    const perfil = await request(app)
      .get(`${BASE}/perfil`)
      .set('x-portal-token', (await request(app).post(`${BASE}/entrar`).send({ email: 'eva@gmail.com', password: 'primeira-senha-2026' })).body.token);
    expect(perfil.body.hasPassword).toBe(true);
    const entrar = await request(app).post(`${BASE}/entrar`).send({ email: 'eva@gmail.com', password: 'primeira-senha-2026' });
    expect(entrar.status).toBe(200);
  });
});

describe('ligar e desligar o Google na conta aberta', () => {
  it('liga um Google de OUTRO e-mail à conta; depois o Google entra nela', async () => {
    await configurarTeste();
    const { token, accountId } = await contaComSenha('fabio@empresa.com.br');

    const semSessao = await request(app).post(`${BASE}/google/iniciar`).send({ intent: 'vincular' });
    expect(semSessao.status).toBe(401);

    const v = await dancaDoGoogle({ email: 'fabio.pessoal@gmail.com' }, { intent: 'vincular', token });
    const res = await concluir(v, token);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ status: 'vinculado', googleEmail: 'fabio.pessoal@gmail.com' });

    const naConta = await request(app).get(`${BASE}/google/conta`).set('x-portal-token', token);
    expect(naConta.body).toMatchObject({ disponivel: true, temSenha: true, ligado: { email: 'fabio.pessoal@gmail.com' } });

    const entrar = await concluir(await dancaDoGoogle({ email: 'fabio.pessoal@gmail.com' }));
    expect(entrar.body.session.account.id).toBe(accountId);
    // E não nasceu conta para o e-mail do Google.
    expect(conta('fabio.pessoal@gmail.com')).toBeUndefined();
  });

  it('a volta do "ligar" com a sessão de OUTRA conta não liga nada', async () => {
    await configurarTeste();
    const a = await contaComSenha('a@exemplo.com');
    const b = await contaComSenha('b@exemplo.com');
    const v = await dancaDoGoogle({ email: 'g@gmail.com' }, { intent: 'vincular', token: a.token });
    const res = await concluir(v, b.token);
    expect(res.status).toBe(401);
    expect(getConnection().prepare('SELECT COUNT(*) c FROM core_customer_identities').get()).toEqual({ c: 0 });
  });

  it('o Google que já entra em outra conta não é roubado por um "ligar"', async () => {
    await configurarTeste();
    await concluir(await dancaDoGoogle({ email: 'g@gmail.com' }, { termsAccepted: true }));
    const outra = await contaComSenha('outra@exemplo.com');
    const res = await concluir(await dancaDoGoogle({ email: 'g@gmail.com' }, { intent: 'vincular', token: outra.token }), outra.token);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PORTAL_GOOGLE_JA_LIGADO');
  });

  it('desligar: a conta sem senha não fica sem porta; a com senha desliga', async () => {
    await configurarTeste();
    const soGoogle = await concluir(await dancaDoGoogle({ email: 'h@gmail.com' }, { termsAccepted: true }));
    const recusa = await request(app).delete(`${BASE}/google/conta`).set('x-portal-token', soGoogle.body.session.token);
    expect(recusa.status).toBe(409);
    expect(recusa.body.error.code).toBe('PORTAL_GOOGLE_UNICA_ENTRADA');

    const comSenha = await contaComSenha('i@exemplo.com');
    await concluir(await dancaDoGoogle({ email: 'i.google@gmail.com' }, { intent: 'vincular', token: comSenha.token }), comSenha.token);
    const desligou = await request(app).delete(`${BASE}/google/conta`).set('x-portal-token', comSenha.token);
    expect(desligou.status).toBe(200);
    expect(desligou.body.ligado).toBeNull();
    const acoes = (getConnection()
      .prepare(`SELECT action FROM core_audit_log WHERE entity_type = 'customer_account' ORDER BY created_at`)
      .all() as { action: string }[]).map((l) => l.action);
    expect(acoes).toContain('portal.google.desligado');
  });
});

// ============================================================================
// A configuração da instalação
// ============================================================================

describe('a configuração do Google é dos donos do grupo', () => {
  it('gerente de loja e contador recebem 403', async () => {
    for (const perfil of ['gerente_loja', 'contador']) {
      const login = await loginForTest(app, { userId: `u-${perfil}`, companyId: 'gringa', profileCodes: [perfil] });
      const token = login.body.accessToken as string;
      expect((await request(app).get('/api/v1/core/portal/login-google').set('Authorization', `Bearer ${token}`)).status).toBe(403);
      expect(
        (await request(app).put('/api/v1/core/portal/login-google').set('Authorization', `Bearer ${token}`).send({ enabled: false })).status,
      ).toBe(403);
    }
  });

  it('o segredo entra selado e nunca sai — nem na resposta, nem na trilha', async () => {
    const res = await configurarTeste();
    expect(JSON.stringify(res.body)).not.toContain(SEGREDO_DE_TESTE);
    expect(res.body).toMatchObject({ secretConfigured: true, secretHint: '••••9f8e', prontidao: { estado: 'pronto_teste' } });

    const linha = getConnection()
      .prepare(`SELECT secret_cipher FROM core_portal_google_login`)
      .get() as { secret_cipher: string };
    expect(linha.secret_cipher).not.toContain(SEGREDO_DE_TESTE);
    expect(decryptFiscalSecret(linha.secret_cipher)).toBe(SEGREDO_DE_TESTE);

    const leitura = await request(app).get('/api/v1/core/portal/login-google').set('Authorization', `Bearer ${admin}`);
    expect(JSON.stringify(leitura.body)).not.toContain(SEGREDO_DE_TESTE);

    const trilha = getConnection()
      .prepare(`SELECT detail FROM core_audit_log WHERE action = 'portal.google_login_updated'`)
      .all() as { detail: string }[];
    expect(trilha).toHaveLength(1);
    expect(trilha[0]!.detail).not.toContain(SEGREDO_DE_TESTE);
    expect(JSON.parse(trilha[0]!.detail)).toMatchObject({ segredoTrocado: true, depois: { enabled: true } });

    // Salvar de novo com o segredo em branco MANTÉM o guardado.
    const semSegredo = await request(app)
      .put('/api/v1/core/portal/login-google')
      .set('Authorization', `Bearer ${admin}`)
      .send({ clientSecret: '', enabled: true });
    expect(semSegredo.status).toBe(200);
    expect(semSegredo.body.secretConfigured).toBe(true);
  });

  it('ligar sem a configuração completa é recusado dizendo o que falta', async () => {
    const res = await request(app)
      .put('/api/v1/core/portal/login-google')
      .set('Authorization', `Bearer ${admin}`)
      .send({ enabled: true, providerMode: 'google', clientId: '123-abc.apps.googleusercontent.com' });
    expect(res.status).toBe(422);
    expect(res.body.error.details.falta).toEqual(['Segredo do cliente OAuth', 'Endereço de retorno (redirect URI)']);
  });

  it('Client ID e endereço de retorno fora do formato são recusados', async () => {
    const put = (body: Record<string, unknown>) =>
      request(app).put('/api/v1/core/portal/login-google').set('Authorization', `Bearer ${admin}`).send(body);
    expect((await put({ providerMode: 'google', clientId: 'nao-e-do-google' })).body.error.code).toBe('PORTAL_GOOGLE_CLIENT_ID_INVALIDO');
    for (const redirectUri of [
      'http://loja.exemplo.com.br/minha-conta/google',
      'https://loja.exemplo.com.br/outra-tela',
      'https://loja.exemplo.com.br/minha-conta/google?x=1',
      'nao-e-endereco',
    ]) {
      const res = await put({ redirectUri });
      expect(res.status, redirectUri).toBe(400);
      expect(res.body.error.code).toBe('PORTAL_GOOGLE_REDIRECT_INVALIDO');
    }
    expect((await put({ redirectUri: 'https://loja.exemplo.com.br/minha-conta/google' })).status).toBe(200);
  });
});

// ============================================================================
// O Google DE VERDADE, com o transporte dublado
// ============================================================================

describe('modo Google: os endpoints do Google, conferidos com a chave publicada', () => {
  const CLIENT_ID = '1234567890-abcdef.apps.googleusercontent.com';
  const SEGREDO = 'GOCSPX-segredo-dublado-do-teste';
  let privada: KeyObject;
  let publica: JsonWebKey;
  let buscasDeChave = 0;
  let ultimoPost: Record<string, string> = {};

  function assinar(claims: Record<string, unknown>, kid = 'chave-google-1', chave = privada, alg = 'RS256') {
    const h = Buffer.from(JSON.stringify({ alg, kid, typ: 'JWT' })).toString('base64url');
    const c = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const s = sign('RSA-SHA256', Buffer.from(`${h}.${c}`), chave).toString('base64url');
    return `${h}.${c}.${s}`;
  }

  /** O "Google": confere o PKCE contra o desafio da URL e devolve o id_token pedido. */
  function googleDublado(fazerToken: (nonce: string) => string, desafio: () => string, kidPublicado = 'chave-google-1'): TransporteOidc {
    return {
      async postarFormulario(url, campos) {
        expect(url).toBe('https://oauth2.googleapis.com/token');
        ultimoPost = campos;
        if (desafioDoPkce(campos.code_verifier ?? '') !== desafio()) return { status: 400, corpo: { error: 'invalid_grant' } };
        return { status: 200, corpo: { id_token: fazerToken(''), access_token: 'ya29.nao-guardar' } };
      },
      async lerJson(url) {
        expect(url).toBe('https://www.googleapis.com/oauth2/v3/certs');
        buscasDeChave += 1;
        return { status: 200, corpo: { keys: [{ ...publica, kid: kidPublicado, alg: 'RS256', use: 'sig' }] }, maxAgeSeg: 3600 };
      },
    };
  }

  beforeEach(async () => {
    const par = generateKeyPairSync('rsa', { modulusLength: 2048 });
    privada = par.privateKey;
    publica = par.publicKey.export({ format: 'jwk' });
    buscasDeChave = 0;
    const res = await request(app)
      .put('/api/v1/core/portal/login-google')
      .set('Authorization', `Bearer ${admin}`)
      .send({
        enabled: true,
        providerMode: 'google',
        clientId: CLIENT_ID,
        clientSecret: SEGREDO,
        redirectUri: 'https://loja.gruposampaio.com.br/minha-conta/google',
      });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  async function iniciarNoGoogle() {
    const inicio = await request(app).post(`${BASE}/google/iniciar`).send({ termsAccepted: true });
    const url = new URL(inicio.body.authorizationUrl as string);
    return { inicio, url, nonce: url.searchParams.get('nonce')!, state: url.searchParams.get('state')!, desafio: url.searchParams.get('code_challenge')! };
  }

  function claimsDoGoogle(nonce: string, extra: Record<string, unknown> = {}) {
    const agora = Math.floor(Date.now() / 1000);
    return {
      iss: 'https://accounts.google.com',
      aud: CLIENT_ID,
      azp: CLIENT_ID,
      sub: '109876543210987654321',
      email: 'joana@gmail.com',
      email_verified: true,
      name: 'Joana',
      nonce,
      iat: agora,
      exp: agora + 3600,
      ...extra,
    };
  }

  it('manda a pessoa a accounts.google.com e troca o código com o segredo e o verificador PKCE', async () => {
    const i = await iniciarNoGoogle();
    expect(`${i.url.origin}${i.url.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    definirTransporteDoGoogleParaTestes(googleDublado(() => assinar(claimsDoGoogle(i.nonce)), () => i.desafio));

    const res = await concluir({ code: 'codigo-do-google', state: i.state, browserKey: i.inicio.body.browserKey });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.session.account.email).toBe('joana@gmail.com');
    expect(ultimoPost).toMatchObject({
      grant_type: 'authorization_code',
      code: 'codigo-do-google',
      client_id: CLIENT_ID,
      client_secret: SEGREDO,
      redirect_uri: 'https://loja.gruposampaio.com.br/minha-conta/google',
    });
    const id = getConnection().prepare('SELECT issuer, subject FROM core_customer_identities').get();
    expect(id).toEqual({ issuer: 'https://accounts.google.com', subject: '109876543210987654321' });
  });

  it.each([
    ['assinatura', () => assinar({}, 'chave-google-1', generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey)],
    ['emissor', (n: string) => assinar(claimsDoGoogle(n, { iss: ENDPOINTS_DO_PROVEDOR_DE_TESTE.emissor }))],
    ['audiencia', (n: string) => assinar(claimsDoGoogle(n, { aud: 'outro-site.apps.googleusercontent.com', azp: undefined }))],
    ['expirado', (n: string) => assinar(claimsDoGoogle(n, { exp: Math.floor(Date.now() / 1000) - 3600 }))],
    ['nonce', () => assinar(claimsDoGoogle('nonce-de-outra-pessoa'))],
    ['algoritmo', (n: string) => {
      const h = Buffer.from(JSON.stringify({ alg: 'none', kid: 'chave-google-1' })).toString('base64url');
      return `${h}.${Buffer.from(JSON.stringify(claimsDoGoogle(n))).toString('base64url')}.x`;
    }],
    ['algoritmo', (n: string) => {
      // O golpe da confusão: HS256 "assinado" com a chave pública como segredo.
      const h = Buffer.from(JSON.stringify({ alg: 'HS256', kid: 'chave-google-1' })).toString('base64url');
      const c = Buffer.from(JSON.stringify(claimsDoGoogle(n))).toString('base64url');
      const s = createHash('sha256').update(`${h}.${c}${JSON.stringify(publica)}`).digest('base64url');
      return `${h}.${c}.${s}`;
    }],
  ])('recusa id_token com %s errado — e não nasce conta', async (motivo, fazer) => {
    const i = await iniciarNoGoogle();
    definirTransporteDoGoogleParaTestes(
      googleDublado(() => (fazer as (n: string) => string)(i.nonce), () => i.desafio),
    );
    const res = await concluir({ code: 'c', state: i.state, browserKey: i.inicio.body.browserKey });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatchObject({ code: 'PORTAL_GOOGLE_TOKEN_INVALIDO', details: { motivo } });
    expect(conta('joana@gmail.com')).toBeUndefined();
  });

  it('chave girada no Google: kid novo faz reler as chaves uma vez', async () => {
    const i = await iniciarNoGoogle();
    let kid = 'chave-antiga';
    const t = googleDublado(() => assinar(claimsDoGoogle(i.nonce), 'chave-nova'), () => i.desafio);
    definirTransporteDoGoogleParaTestes({
      postarFormulario: t.postarFormulario,
      async lerJson(url) {
        const r = await t.lerJson(url);
        const keys = (r.corpo as { keys: JsonWebKey[] }).keys.map((k) => ({ ...k, kid }));
        kid = 'chave-nova';
        return { ...r, corpo: { keys } };
      },
    });
    const res = await concluir({ code: 'c', state: i.state, browserKey: i.inicio.body.browserKey });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(buscasDeChave).toBe(2);
  });

  it('o Google fora do ar vira 502 com texto para o cliente, e a entrada não fica pela metade', async () => {
    const i = await iniciarNoGoogle();
    definirTransporteDoGoogleParaTestes({
      async postarFormulario() {
        throw new TypeError('fetch failed');
      },
      async lerJson() {
        throw new TypeError('fetch failed');
      },
    });
    const res = await concluir({ code: 'c', state: i.state, browserKey: i.inicio.body.browserKey });
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('PORTAL_GOOGLE_INDISPONIVEL');
    expect(conta('joana@gmail.com')).toBeUndefined();
  });
});

// ============================================================================
// O provedor de teste NUNCA em produção
// ============================================================================

describe('o provedor de teste não opera em produção', () => {
  it.each([
    ['production', undefined],
    ['staging', undefined],
    ['development', 'production'],
  ] as const)('DEVORA_API_ENV=%s NODE_ENV=%s: recusa gravar, executar e servir a tela', async (apiEnv, nodeEnv) => {
    // Gravado quando era permitido (o banco que veio do desenvolvimento).
    await configurarTeste();
    emAmbiente(apiEnv, nodeEnv);
    expect(provedorDeTestePermitido()).toBe(false);

    // 1. Gravar.
    const gravar = (() => {
      try {
        salvarConfiguracaoGoogle({ providerMode: 'teste' }, 'dono');
        return null;
      } catch (err) {
        return err;
      }
    })();
    expect(gravar).toBeInstanceOf(ApiError);
    expect((gravar as ApiError).code).toBe('PORTAL_GOOGLE_TESTE_PROIBIDO');

    // 2. Executar com o que ficou gravado.
    expect(() => configuracaoEmUso()).toThrow(/não opera em produção/);
    expect(googleDisponivel()).toEqual({ disponivel: false, modo: null });
    const iniciar = await request(app).post(`${BASE}/google/iniciar`).send({ termsAccepted: true });
    expect(iniciar.status).toBe(403);
    expect(iniciar.body.error.code).toBe('PORTAL_GOOGLE_TESTE_PROIBIDO');
    await expect(
      transporteDoProvedorDeTeste(null).lerJson(ENDPOINTS_DO_PROVEDOR_DE_TESTE.jwks),
    ).rejects.toMatchObject({ code: 'PORTAL_GOOGLE_TESTE_PROIBIDO' });

    // 3. A tela de consentimento de teste não existe.
    const tela = await request(app).get(`${BASE}/google/teste/autorizar?client_id=cliente-de-teste-loja`);
    expect(tela.status).toBe(404);
    const confirmar = await request(app).get(`${BASE}/google/teste/autorizar/confirmar?decisao=autorizar&email=x@x.com`);
    expect(confirmar.status).toBe(404);
  });
});

// ============================================================================
// As primitivas do OIDC, isoladas
// ============================================================================

describe('primitivas', () => {
  it('o desafio PKCE é o do exemplo da RFC 7636', () => {
    expect(desafioDoPkce('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('várias audiências exigem azp deste cliente', () => {
    const par = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = { ...par.publicKey.export({ format: 'jwk' }), kid: 'k' };
    const agora = Math.floor(Date.now() / 1000);
    const token = (claims: Record<string, unknown>) => {
      const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k' })).toString('base64url');
      const c = Buffer.from(JSON.stringify(claims)).toString('base64url');
      return `${h}.${c}.${sign('RSA-SHA256', Buffer.from(`${h}.${c}`), par.privateKey).toString('base64url')}`;
    };
    const base = { iss: 'https://accounts.google.com', sub: 's', nonce: 'n', iat: agora, exp: agora + 60 };
    const p = { chaves: [jwk], emissores: ['https://accounts.google.com'], clientId: 'eu', nonce: 'n' };
    expect(() => verificarIdToken({ ...p, idToken: token({ ...base, aud: ['eu', 'outro'] }) })).toThrow(ApiError);
    expect(verificarIdToken({ ...p, idToken: token({ ...base, aud: ['eu', 'outro'], azp: 'eu' }) }).sub).toBe('s');
    // O relógio do provedor adiantado dois minutos ainda passa; cinco não.
    expect(verificarIdToken({ ...p, idToken: token({ ...base, aud: 'eu', iat: agora + 100 }) }).sub).toBe('s');
    expect(() => verificarIdToken({ ...p, idToken: token({ ...base, aud: 'eu', iat: agora + 300 }) })).toThrow(ApiError);
  });

  it('o cache das chaves não relê a cada kid inventado', async () => {
    let buscas = 0;
    let agora = 0;
    const cache = new CacheDeChaves(
      'https://chaves',
      {
        async postarFormulario() {
          return { status: 500, corpo: null };
        },
        async lerJson() {
          buscas += 1;
          return { status: 200, corpo: { keys: [{ kty: 'RSA', kid: 'a' }] }, maxAgeSeg: 600 };
        },
      },
      () => agora,
    );
    await cache.obter();
    await cache.obter();
    expect(buscas).toBe(1);
    // O kid desconhecido relê uma vez — e a segunda, no mesmo minuto, não.
    await cache.obter(true);
    await cache.obter(true);
    await cache.obter(true);
    expect(buscas).toBe(2);
    agora += 61_000;
    await cache.obter(true);
    expect(buscas).toBe(3);
    // Vencido o max-age, a leitura normal relê.
    agora += 601_000;
    await cache.obter();
    expect(buscas).toBe(4);
  });
});

describe('a instalação de várias operações', () => {
  it('a conta criada pelo Google é do grupo: o aviso sai por uma operação ativa', async () => {
    await upsertCompany({ slug: 'preco-justo', tradeName: 'Preço Justo', legalName: 'PJ Ltda' });
    await configurarTeste();
    await concluir(await dancaDoGoogle({ email: 'grupo@gmail.com' }, { termsAccepted: true }));
    const aviso = getConnection()
      .prepare(`SELECT COUNT(*) c FROM core_email_queue WHERE template = 'conta_criada' AND to_address = 'grupo@gmail.com'`)
      .get();
    expect(aviso).toEqual({ c: 1 });
  });
});
