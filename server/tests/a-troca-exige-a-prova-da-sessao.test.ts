process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

/**
 * ============================================================================
 * A TROCA DE OPERAÇÃO EXIGE A PROVA DA SESSÃO, E O LOGOUT CHEGA PELO REFRESH
 * (R2-SESSAO — o que o verificador da família de sessão deixou como
 * "recomendação" e que causa dano real)
 * ============================================================================
 *
 * 1. `POST /auth/switch-company` só pedia o ACCESS token e devolvia um REFRESH
 *    novo — inclusive para a PRÓPRIA operação atual (o `assertMembership` só
 *    confere o vínculo). Um access furtado (vale uma hora) virava refresh
 *    (vale sete dias), e a troca ainda encerrava a família da vítima, que caía
 *    no login enquanto quem furtou ficava com a sessão.
 *
 *    Agora a troca exige a PROVA: o refresh atual no corpo, da mesma pessoa e
 *    da mesma FAMÍLIA (`sid`) do access. Sem ela, ou de outra família/pessoa,
 *    401 com código próprio, nada emitido e nada revogado. Trocar para a
 *    operação em que já se está é recusado (409) — também sem emitir nem
 *    revogar nada.
 *
 * 2. `POST /auth/logout` exigia access válido. Com o access vencido e a
 *    renovação indisponível (429 ou 5xx), o logout do cliente não alcançava o
 *    servidor, e a família ficava viva por até sete dias. Agora, sem access
 *    válido, ele encerra pela família do refresh do corpo — sempre com o mesmo
 *    204, exista ou não o refresh (nada vaza), e com teto de taxa próprio.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';

const { createApp } = await import('../src/app.js');
const { resetDbForTests } = await import('../src/db/database.js');
const { getConnection } = await import('../src/db/sqlite.js');
const { loadEnv } = await import('../src/config/env.js');
const { issueSession } = await import('./helpers/sessao.js');

const app = createApp();
const LOJA = 'loja-da-prova';
const OUTRA = 'outra-da-prova';

beforeEach(() => {
  resetDbForTests();
});

type Tokens = { accessToken: string; refreshToken: string };

const portador = (token: string) => ({ Authorization: `Bearer ${token}` });

function claimsDe(token: string): Record<string, unknown> {
  return jwt.decode(token) as Record<string, unknown>;
}

/**
 * A pessoa com vínculo nas duas operações. Devolve a sessão aberta na LOJA (o
 * balcão) e a que ficou aberta na OUTRA (outro aparelho — outra FAMÍLIA).
 */
function gerenteDasDuas(userId: string): { balcao: Tokens; outroAparelho: Tokens } {
  const outroAparelho = issueSession({ userId, companyId: OUTRA, profileCodes: ['gerente_loja'] });
  const balcao = issueSession({ userId, companyId: LOJA, profileCodes: ['gerente_loja'] });
  return { balcao, outroAparelho };
}

async function statusDaSessao(accessToken: string): Promise<number> {
  return (await request(app).get('/api/v1/auth/session').set(portador(accessToken))).status;
}

async function renovar(refreshToken: string) {
  return request(app).post('/api/v1/auth/refresh').send({ refreshToken });
}

async function trocar(accessToken: string, corpo: Record<string, unknown>) {
  return request(app).post('/api/v1/auth/switch-company').set(portador(accessToken)).send(corpo);
}

function sessoesGravadas(): number {
  return (getConnection().prepare('SELECT COUNT(*) AS n FROM api_sessions').get() as { n: number }).n;
}

describe('a troca de operação exige a prova da sessão', () => {
  it('só com o access (o token furtado): 401 API_SESSION_PROOF_REQUIRED — nada emitido, nada revogado', async () => {
    const { balcao } = gerenteDasDuas('gerente-sem-prova');
    const antes = sessoesGravadas();

    const res = await trocar(balcao.accessToken, { companyId: OUTRA });

    expect(res.status, JSON.stringify(res.body)).toBe(401);
    expect(res.body.error.code).toBe('API_SESSION_PROOF_REQUIRED');
    // Antes: 200 com um refresh de sete dias para quem só tinha o access.
    expect(res.body.refreshToken).toBeUndefined();
    expect(res.body.accessToken).toBeUndefined();
    expect(sessoesGravadas()).toBe(antes);
    // E a vítima não cai: o access e o refresh dela seguem.
    expect(await statusDaSessao(balcao.accessToken)).toBe(200);
    expect((await renovar(balcao.refreshToken)).status).toBe(200);
  });

  it('refresh de OUTRA família da mesma pessoa (outro aparelho): 401 API_SESSION_PROOF_INVALID, e as duas seguem', async () => {
    const { balcao, outroAparelho } = gerenteDasDuas('gerente-outra-familia');

    const res = await trocar(balcao.accessToken, { companyId: OUTRA, refreshToken: outroAparelho.refreshToken });

    expect(res.status, JSON.stringify(res.body)).toBe(401);
    expect(res.body.error.code).toBe('API_SESSION_PROOF_INVALID');
    expect(res.body.refreshToken).toBeUndefined();
    expect(await statusDaSessao(balcao.accessToken)).toBe(200);
    expect(await statusDaSessao(outroAparelho.accessToken)).toBe(200);
    expect((await renovar(outroAparelho.refreshToken)).status).toBe(200);
  });

  it('refresh de OUTRA pessoa: 401 API_SESSION_PROOF_INVALID', async () => {
    const { balcao } = gerenteDasDuas('gerente-dono-do-access');
    const alheia = issueSession({ userId: 'outra-pessoa', companyId: LOJA, profileCodes: ['atendente'] });

    const res = await trocar(balcao.accessToken, { companyId: OUTRA, refreshToken: alheia.refreshToken });

    expect(res.status, JSON.stringify(res.body)).toBe(401);
    expect(res.body.error.code).toBe('API_SESSION_PROOF_INVALID');
    expect((await renovar(alheia.refreshToken)).status).toBe(200);
  });

  it('refresh já rotacionado (o de antes da renovação): 401 API_SESSION_PROOF_INVALID', async () => {
    const { balcao } = gerenteDasDuas('gerente-refresh-velho');
    const renovada = (await renovar(balcao.refreshToken)).body as Tokens;

    const res = await trocar(renovada.accessToken, { companyId: OUTRA, refreshToken: balcao.refreshToken });

    expect(res.status, JSON.stringify(res.body)).toBe(401);
    expect(res.body.error.code).toBe('API_SESSION_PROOF_INVALID');
    expect(await statusDaSessao(renovada.accessToken)).toBe(200);
  });

  it('para a operação em que já se está, com a prova certa: recusada (409), nada emitido, nada revogado', async () => {
    const { balcao } = gerenteDasDuas('gerente-mesma-operacao');
    const antes = sessoesGravadas();

    const res = await trocar(balcao.accessToken, { companyId: LOJA, refreshToken: balcao.refreshToken });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe('API_SWITCH_SAME_COMPANY');
    expect(res.body.error.message).toMatch(/já é a operação/);
    expect(res.body.refreshToken).toBeUndefined();
    expect(sessoesGravadas()).toBe(antes);
    expect(await statusDaSessao(balcao.accessToken)).toBe(200);
    expect((await renovar(balcao.refreshToken)).status).toBe(200);
  });

  it('com a prova certa: 200 na operação nova, na mesma família — e a família de antes encerrada', async () => {
    const { balcao, outroAparelho } = gerenteDasDuas('gerente-com-prova');

    const res = await trocar(balcao.accessToken, { companyId: OUTRA, refreshToken: balcao.refreshToken });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const depois = res.body as Tokens;
    expect(claimsDe(depois.accessToken).companyId).toBe(OUTRA);
    expect(claimsDe(depois.accessToken).sid).toBe(claimsDe(balcao.accessToken).sid);
    expect(await statusDaSessao(balcao.accessToken)).toBe(401);
    expect((await renovar(balcao.refreshToken)).status).toBe(401);
    expect(await statusDaSessao(depois.accessToken)).toBe(200);
    // O outro aparelho é outra família: não é tocado.
    expect(await statusDaSessao(outroAparelho.accessToken)).toBe(200);
    expect((await renovar(depois.refreshToken)).status).toBe(200);
  });

  it('empresa fora do vínculo, com a prova certa: 403 como antes — e nada revogado', async () => {
    const { balcao } = gerenteDasDuas('gerente-fora-do-vinculo');
    const res = await trocar(balcao.accessToken, { companyId: 'empresa-alheia', refreshToken: balcao.refreshToken });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(await statusDaSessao(balcao.accessToken)).toBe(200);
  });

  describe('token emitido antes da família (sem sid)', () => {
    function tokenAntigo(userId: string): string {
      return jwt.sign(
        { sub: userId, companyId: LOJA, profileCodes: ['gerente_loja'], sessionVersion: 1, jti: randomUUID() },
        loadEnv().DEVORA_JWT_SECRET,
        { expiresIn: 3600 },
      );
    }

    it('sem refresh: 401 API_SESSION_PROOF_REQUIRED', async () => {
      gerenteDasDuas('gerente-antigo-sem-prova');
      const res = await trocar(tokenAntigo('gerente-antigo-sem-prova'), { companyId: OUTRA });
      expect(res.status, JSON.stringify(res.body)).toBe(401);
      expect(res.body.error.code).toBe('API_SESSION_PROOF_REQUIRED');
    });

    it('com o refresh de outra pessoa: 401', async () => {
      gerenteDasDuas('gerente-antigo-alheio');
      const alheia = issueSession({ userId: 'outra-pessoa-antiga', companyId: LOJA, profileCodes: ['atendente'] });
      const res = await trocar(tokenAntigo('gerente-antigo-alheio'), { companyId: OUTRA, refreshToken: alheia.refreshToken });
      expect(res.status, JSON.stringify(res.body)).toBe(401);
      expect(res.body.error.code).toBe('API_SESSION_PROOF_INVALID');
    });

    it('com o refresh da mesma pessoa: troca, e o refresh da prova morre (antes ele vivia sete dias)', async () => {
      const { balcao } = gerenteDasDuas('gerente-antigo-com-prova');
      const antigo = tokenAntigo('gerente-antigo-com-prova');
      const res = await trocar(antigo, { companyId: OUTRA, refreshToken: balcao.refreshToken });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(await statusDaSessao(antigo)).toBe(401);
      expect((await renovar(balcao.refreshToken)).status).toBe(401);
      expect(await statusDaSessao((res.body as Tokens).accessToken)).toBe(200);
    });
  });
});

describe('o logout sem access válido encerra pela família do refresh do corpo', () => {
  async function sairSemAccess(corpo: Record<string, unknown>, cabecalho?: Record<string, string>) {
    const req = request(app).post('/api/v1/auth/logout');
    if (cabecalho) req.set(cabecalho);
    return req.send(corpo);
  }

  it('sem Authorization, só o refresh: 204 — e a família INTEIRA sai (o refresh e o access de agora)', async () => {
    const { balcao, outroAparelho } = gerenteDasDuas('caixa-sai-pelo-refresh');
    const renovada = (await renovar(balcao.refreshToken)).body as Tokens;

    const res = await sairSemAccess({ refreshToken: renovada.refreshToken });

    expect(res.status, JSON.stringify(res.body)).toBe(204);
    expect((await renovar(renovada.refreshToken)).status).toBe(401);
    const acesso = await request(app).get('/api/v1/auth/session').set(portador(renovada.accessToken));
    expect(acesso.status).toBe(401);
    expect(acesso.body.error.code).toBe('API_SESSION_ENDED');
    // O outro aparelho da mesma pessoa não cai.
    expect(await statusDaSessao(outroAparelho.accessToken)).toBe(200);
  });

  it('access vencido no cabeçalho e o refresh no corpo: 204, e a família sai (antes: 401, e ela vivia sete dias)', async () => {
    const { balcao } = gerenteDasDuas('caixa-access-vencido');
    const claims = claimsDe(balcao.accessToken);
    const vencido = jwt.sign(
      { ...claims, iat: Math.floor(Date.now() / 1000) - 7200, exp: Math.floor(Date.now() / 1000) - 3600 },
      loadEnv().DEVORA_JWT_SECRET,
    );

    const res = await sairSemAccess({ refreshToken: balcao.refreshToken }, portador(vencido));

    expect(res.status, JSON.stringify(res.body)).toBe(204);
    expect((await renovar(balcao.refreshToken)).status).toBe(401);
    expect(await statusDaSessao(balcao.accessToken)).toBe(401);
  });

  it('o refresh antigo, já rotacionado, também encerra a família — é a mesma sessão, e o pedido é sair', async () => {
    const { balcao } = gerenteDasDuas('caixa-refresh-rotacionado');
    const renovada = (await renovar(balcao.refreshToken)).body as Tokens;

    expect((await sairSemAccess({ refreshToken: balcao.refreshToken })).status).toBe(204);

    expect((await renovar(renovada.refreshToken)).status).toBe(401);
    expect(await statusDaSessao(renovada.accessToken)).toBe(401);
  });

  it('refresh que não existe: o MESMO 204, sem corpo — nada diz se a sessão existia', async () => {
    const { balcao } = gerenteDasDuas('caixa-que-fica');
    const inexistente = await sairSemAccess({ refreshToken: randomUUID() });
    const existente = await sairSemAccess({ refreshToken: balcao.refreshToken });
    expect(inexistente.status).toBe(204);
    expect(existente.status).toBe(204);
    expect(inexistente.text).toBe(existente.text);
  });

  it('sem access válido e sem refresh: 401, como antes', async () => {
    const res = await sairSemAccess({});
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('API_AUTHENTICATION_REQUIRED');
  });

  it('com access válido, o caminho de sempre: a família do token sai (mesmo com refresh alheio no corpo)', async () => {
    const { balcao } = gerenteDasDuas('caixa-com-access');
    const res = await request(app).post('/api/v1/auth/logout').set(portador(balcao.accessToken)).send({});
    expect(res.status).toBe(204);
    expect((await renovar(balcao.refreshToken)).status).toBe(401);
  });
});

describe('o logout pelo refresh tem teto de taxa próprio', () => {
  it('passado o teto, 429 API_RATE_LIMITED; o logout com access válido não entra na conta', async () => {
    let ultimo: request.Response | null = null;
    for (let i = 0; i < 40; i += 1) {
      ultimo = await request(app).post('/api/v1/auth/logout').send({ refreshToken: randomUUID() });
      if (ultimo.status === 429) break;
    }
    expect(ultimo?.status).toBe(429);
    expect(ultimo?.body.error.code).toBe('API_RATE_LIMITED');

    const { balcao } = gerenteDasDuas('caixa-fora-do-teto');
    const comAccess = await request(app).post('/api/v1/auth/logout').set(portador(balcao.accessToken)).send({});
    expect(comAccess.status, JSON.stringify(comAccess.body)).toBe(204);
  });
});
