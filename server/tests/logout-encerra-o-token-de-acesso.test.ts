process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

/**
 * ============================================================================
 * O LOGOUT ENCERRA O TOKEN DE ACESSO, NÃO SÓ O REFRESH (item SESSAO)
 * ============================================================================
 *
 * O E2E de API da pilha descartável (verificação A.15) mediu: depois de
 * `POST /auth/logout`, o ACCESS token de antes continuava valendo até vencer
 * (uma hora) — `GET /auth/session` com ele respondia 200. O logout só revogava
 * o refresh; a conferência de toda requisição olhava a CONTA (ativa, versão de
 * sessão, vínculo), nunca a sessão. OWASP ASVS 3.3.1 (L1): o logout invalida o
 * token da sessão.
 *
 * O desenho: todo access token ganha um `jti` aleatório e NÃO secreto; o logout
 * grava o `jti` de quem o chamou numa tabela de revogados, com o vencimento do
 * próprio token; a conferência de toda requisição recusa `jti` revogado com 401
 * `API_SESSION_ENDED`. O refresh token NÃO entra no JWT — o payload é legível
 * por quem tem o access token, e ganharia o poder de renovar para sempre.
 *
 * Token SEM `jti` (emitido antes do conserto) continua valendo até vencer — no
 * máximo uma hora depois da atualização. O caso de compatibilidade prova isso.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const { createApp } = await import('../src/app.js');
const { resetDbForTests } = await import('../src/db/database.js');
const { getConnection } = await import('../src/db/sqlite.js');
const { loadEnv } = await import('../src/config/env.js');
const { issueSession } = await import('./helpers/sessao.js');
const { linkUserToCompany, upsertCompany, upsertUser } = await import('../src/services/auth/IdentityService.js');

const app = createApp();
const EMPRESA = 'loja-do-logout';
const TABELA = 'core_tokens_revogados';

beforeEach(() => {
  resetDbForTests();
});

const portador = (token: string) => ({ Authorization: `Bearer ${token}` });

function sessaoDe(userId: string) {
  return issueSession({ userId, companyId: EMPRESA, profileCodes: ['operador_caixa_loja'] });
}

async function sair(accessToken: string, refreshToken?: string) {
  const res = await request(app)
    .post('/api/v1/auth/logout')
    .set(portador(accessToken))
    .send(refreshToken ? { refreshToken } : {});
  expect(res.status, JSON.stringify(res.body)).toBe(204);
}

function claimsDe(token: string): Record<string, unknown> {
  return jwt.decode(token) as Record<string, unknown>;
}

describe('o logout encerra o token de acesso que o chamou', () => {
  it('login → logout → o token de antes responde 401 API_SESSION_ENDED (antes: 200 por até uma hora)', async () => {
    const { accessToken, refreshToken } = sessaoDe('caixa-que-sai');

    const antes = await request(app).get('/api/v1/auth/session').set(portador(accessToken));
    expect(antes.status, JSON.stringify(antes.body)).toBe(200);

    await sair(accessToken, refreshToken);

    const depois = await request(app).get('/api/v1/auth/session').set(portador(accessToken));
    expect(depois.status, JSON.stringify(depois.body)).toBe(401);
    expect(depois.body.error.code).toBe('API_SESSION_ENDED');

    // Não é só a rota da etapa de troca: `authMiddleware` recusa igual.
    const navegar = await request(app)
      .post('/api/v1/auth/switch-company')
      .set(portador(accessToken))
      .send({ companyId: EMPRESA });
    expect(navegar.status, JSON.stringify(navegar.body)).toBe(401);
    expect(navegar.body.error.code).toBe('API_SESSION_ENDED');

    // E o refresh continua morto, como já estava.
    const renovar = await request(app).post('/api/v1/auth/refresh').send({ refreshToken });
    expect(renovar.status).toBe(401);
  });

  it('também pelo login de verdade, com senha', async () => {
    const userId = await upsertUser({ login: 'GERENTE.SAI', displayName: 'Gerente', password: 'Gerente@Sai2026' });
    upsertCompany({ id: EMPRESA, slug: EMPRESA, legalName: 'Loja Ltda', tradeName: 'Loja' });
    linkUserToCompany(userId, EMPRESA, 'gerente_loja', true);
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ login: 'GERENTE.SAI', password: 'Gerente@Sai2026', companyId: EMPRESA });
    expect(login.status, JSON.stringify(login.body)).toBe(200);

    await sair(login.body.accessToken, login.body.refreshToken);

    const depois = await request(app).get('/api/v1/auth/session').set(portador(login.body.accessToken));
    expect(depois.status).toBe(401);
    expect(depois.body.error.code).toBe('API_SESSION_ENDED');
  });

  it('dois aparelhos da mesma pessoa: sair de um não derruba o outro', async () => {
    const balcao = sessaoDe('caixa-dois-aparelhos');
    const celular = sessaoDe('caixa-dois-aparelhos');
    expect(claimsDe(balcao.accessToken).jti).not.toBe(claimsDe(celular.accessToken).jti);

    await sair(balcao.accessToken, balcao.refreshToken);

    expect((await request(app).get('/api/v1/auth/session').set(portador(balcao.accessToken))).status).toBe(401);
    const noCelular = await request(app).get('/api/v1/auth/session').set(portador(celular.accessToken));
    expect(noCelular.status, JSON.stringify(noCelular.body)).toBe(200);
  });

  it('o refresh de quem não saiu continua renovando; o de quem saiu continua 401', async () => {
    const saiu = sessaoDe('caixa-refresh');
    const ficou = sessaoDe('caixa-refresh');

    await sair(saiu.accessToken, saiu.refreshToken);

    const renovada = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: ficou.refreshToken });
    expect(renovada.status, JSON.stringify(renovada.body)).toBe(200);
    // O token renovado nasce com jti PRÓPRIO, e vale.
    expect(claimsDe(renovada.body.accessToken).jti).toEqual(expect.any(String));
    expect(claimsDe(renovada.body.accessToken).jti).not.toBe(claimsDe(ficou.accessToken).jti);
    expect((await request(app).get('/api/v1/auth/session').set(portador(renovada.body.accessToken))).status).toBe(200);

    const morta = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: saiu.refreshToken });
    expect(morta.status).toBe(401);
    expect(morta.body.accessToken).toBeUndefined();
  });

  it('o logout da etapa da senha provisória também revoga o token', async () => {
    const loja = upsertCompany({ slug: 'loja-provisoria', legalName: 'Provisória Ltda', tradeName: 'Provisória' });
    const gestoraId = await upsertUser({ login: 'GESTORA.SAI', displayName: 'Gestora', password: 'Gestora@Sai2026' });
    linkUserToCompany(gestoraId, loja, 'gestor', true);
    const gestora = await request(app)
      .post('/api/v1/auth/login')
      .send({ login: 'GESTORA.SAI', password: 'Gestora@Sai2026', companyId: loja });
    expect(gestora.status).toBe(200);
    const criado = await request(app).post('/api/v1/core/team').set(portador(gestora.body.accessToken)).send({
      login: 'NOVATO.SAI',
      displayName: 'Novato',
      profileCode: 'gerente_loja',
      password: 'Provisoria@2026',
    });
    expect(criado.status, JSON.stringify(criado.body)).toBe(201);
    const provisorio = await request(app)
      .post('/api/v1/auth/login')
      .send({ login: 'NOVATO.SAI', password: 'Provisoria@2026', companyId: loja });
    expect(provisorio.status).toBe(200);
    expect(provisorio.body.user.mustChangePassword).toBe(true);

    await sair(provisorio.body.accessToken, provisorio.body.refreshToken);

    const depois = await request(app).get('/api/v1/auth/session').set(portador(provisorio.body.accessToken));
    expect(depois.status, JSON.stringify(depois.body)).toBe(401);
    expect(depois.body.error.code).toBe('API_SESSION_ENDED');
  });
});

describe('o jti é aleatório, não secreto, e o refresh não entra no token', () => {
  it('todo access token tem jti UUID, e nenhum claim carrega o refresh token', () => {
    const { accessToken, refreshToken } = sessaoDe('caixa-claims');
    const claims = claimsDe(accessToken);
    expect(claims.jti).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(claims.jti).not.toBe(refreshToken);
    expect(Object.values(claims)).not.toContain(refreshToken);
    expect(JSON.stringify(claims)).not.toContain(refreshToken);
  });
});

describe('compatibilidade: token sem jti, emitido antes do conserto', () => {
  it('continua aceito até vencer — a janela de no máximo uma hora da atualização', async () => {
    // Conta, empresa e vínculo de verdade: token de ninguém toma 401 pela SEG.
    sessaoDe('caixa-token-antigo');
    const antigo = jwt.sign(
      { sub: 'caixa-token-antigo', companyId: EMPRESA, profileCodes: ['operador_caixa_loja'], sessionVersion: 1 },
      loadEnv().DEVORA_JWT_SECRET,
      { expiresIn: 3600 },
    );
    expect(claimsDe(antigo).jti).toBeUndefined();

    const res = await request(app).get('/api/v1/auth/session').set(portador(antigo));
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    // O logout com ele não quebra: revoga o refresh, e não há jti a gravar.
    await sair(antigo);
    expect((getConnection().prepare(`SELECT COUNT(*) AS n FROM ${TABELA}`).get() as { n: number }).n).toBe(0);
  });
});

describe('a faxina: quem grava apaga as linhas já vencidas', () => {
  it('a linha de token vencido sai no logout seguinte; a de token ainda vivo fica', async () => {
    const db = getConnection();
    const agora = Date.now();
    const insere = db.prepare(
      `INSERT INTO ${TABELA} (jti, user_id, company_id, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?)`,
    );
    insere.run('jti-vencido', 'alguem', EMPRESA, new Date(agora - 60_000).toISOString(), new Date(agora - 3_700_000).toISOString());
    insere.run('jti-vivo', 'alguem', EMPRESA, new Date(agora + 600_000).toISOString(), new Date(agora - 60_000).toISOString());

    const { accessToken, refreshToken } = sessaoDe('caixa-faxina');
    await sair(accessToken, refreshToken);

    const linhas = db.prepare(`SELECT jti, user_id, company_id, expires_at FROM ${TABELA} ORDER BY jti`).all() as {
      jti: string;
      user_id: string;
      company_id: string;
      expires_at: string;
    }[];
    const claims = claimsDe(accessToken) as { jti: string; exp: number };
    expect(linhas.map((l) => l.jti).sort()).toEqual([claims.jti, 'jti-vivo'].sort());
    const gravada = linhas.find((l) => l.jti === claims.jti)!;
    expect(gravada.user_id).toBe('caixa-faxina');
    expect(gravada.company_id).toBe(EMPRESA);
    // O vencimento gravado é o do PRÓPRIO token (claim exp), não um prazo inventado.
    expect(gravada.expires_at).toBe(new Date(claims.exp * 1000).toISOString());
  });
});
