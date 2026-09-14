process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

/**
 * ============================================================================
 * SAIR ENCERRA A SESSÃO INTEIRA NO SERVIDOR, QUALQUER QUE SEJA O CORPO
 * (RES-SESSAO — o que o verificador do 598c0cd achou; OWASP ASVS 3.3.1)
 * ============================================================================
 *
 * O 598c0cd fez o logout gravar o `jti` do access token que o chamou. Faltavam
 * as credenciais que a sessão deixou para trás no caminho:
 *
 *   (a) `POST /auth/switch-company` emitia sessão nova e não revogava nada: o
 *       token de antes da troca respondia 200 até o `exp`, e o refresh de
 *       antes vivia os sete dias dele — o cliente o descartava, o servidor não;
 *   (b) a rotação do refresh não revogava o access token emitido com ele;
 *   (c) linha vencida de `core_tokens_revogados` só saía na saída seguinte;
 *   (d) o cliente montava o corpo do logout ANTES da chamada: com o access
 *       vencido, renovava (R1 vira R2) e repetia o logout com o corpo velho
 *       `{refreshToken: R1}` — o servidor revogava R1 (já morto) e R2 vivia.
 *
 * O desenho: a sessão tem FAMÍLIA — um `sid` aleatório e não secreto, no JWT e
 * no registro do refresh. O login abre uma família; a rotação e a troca de
 * operação a mantêm; a troca e o logout encerram TODAS as credenciais vivas da
 * família (refresh e o access emitido com cada um), além do token que chamou.
 * O corpo do logout vira redundância, não a fonte da verdade.
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
const { podarSessoesDeApi } = await import('../src/services/api/SessoesDeApi.js');

const app = createApp();
const LOJA = 'loja-da-familia';
const OUTRA = 'outra-da-familia';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

beforeEach(() => {
  resetDbForTests();
});

type Tokens = { accessToken: string; refreshToken: string };

const portador = (token: string) => ({ Authorization: `Bearer ${token}` });

function claimsDe(token: string): Record<string, unknown> {
  return jwt.decode(token) as Record<string, unknown>;
}

/** Sessão de um aparelho, na LOJA. */
function sessaoDe(userId: string): Tokens {
  return issueSession({ userId, companyId: LOJA, profileCodes: ['gerente_loja'] });
}

/** A pessoa com vínculo nas duas operações; devolve a sessão aberta na LOJA. */
function gerenteDasDuas(userId: string): Tokens {
  issueSession({ userId, companyId: OUTRA, profileCodes: ['gerente_loja'] });
  return sessaoDe(userId);
}

async function statusDaSessao(accessToken: string): Promise<number> {
  return (await request(app).get('/api/v1/auth/session').set(portador(accessToken))).status;
}

async function renovar(refreshToken: string) {
  return request(app).post('/api/v1/auth/refresh').send({ refreshToken });
}

/** A troca leva a PROVA da sessão — o refresh atual — desde o R2-SESSAO. */
async function trocar(accessToken: string, companyId: string, refreshToken: string): Promise<Tokens> {
  const res = await request(app)
    .post('/api/v1/auth/switch-company')
    .set(portador(accessToken))
    .send({ companyId, refreshToken });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as Tokens;
}

async function sair(accessToken: string, corpo: Record<string, unknown> = {}) {
  const res = await request(app).post('/api/v1/auth/logout').set(portador(accessToken)).send(corpo);
  expect(res.status, JSON.stringify(res.body)).toBe(204);
}

function linhaDaSessao(refreshToken: string): Record<string, unknown> {
  const linha = getConnection()
    .prepare('SELECT data FROM api_sessions WHERE id = ?')
    .get(refreshToken) as { data: string };
  return JSON.parse(linha.data) as Record<string, unknown>;
}

describe('(a) a troca de operação não deixa credencial viva para trás', () => {
  it('troca e depois logout: o token de ANTES da troca responde 401, e o refresh de antes também', async () => {
    const antes = gerenteDasDuas('gerente-troca');
    const depois = await trocar(antes.accessToken, OUTRA, antes.refreshToken);

    await sair(depois.accessToken, { refreshToken: depois.refreshToken });

    // Antes: 200 até o `exp` e renovação por sete dias.
    expect(await statusDaSessao(antes.accessToken)).toBe(401);
    expect((await renovar(antes.refreshToken)).status).toBe(401);
    expect(await statusDaSessao(depois.accessToken)).toBe(401);
    expect((await renovar(depois.refreshToken)).status).toBe(401);
  });

  it('a própria troca já encerra as credenciais de antes — sem esperar o logout — e a nova vale', async () => {
    const antes = gerenteDasDuas('gerente-troca-2');
    const depois = await trocar(antes.accessToken, OUTRA, antes.refreshToken);

    const velho = await request(app).get('/api/v1/auth/session').set(portador(antes.accessToken));
    expect(velho.status).toBe(401);
    expect(velho.body.error.code).toBe('API_SESSION_ENDED');
    expect((await renovar(antes.refreshToken)).status).toBe(401);

    const nova = await request(app).get('/api/v1/auth/session').set(portador(depois.accessToken));
    expect(nova.status, JSON.stringify(nova.body)).toBe(200);
    expect(nova.body.session.companyId).toBe(OUTRA);
    // A troca MANTÉM a família: é a mesma sessão, em outra operação.
    expect(claimsDe(depois.accessToken).sid).toBe(claimsDe(antes.accessToken).sid);
    expect((await renovar(depois.refreshToken)).status).toBe(200);
  });
});

describe('(d) no servidor: o logout com o corpo velho não deixa o refresh novo vivo', () => {
  it('rotação R1 → R2, logout com T2 e corpo {refreshToken: R1}: R2 responde 401 pela família', async () => {
    const primeira = sessaoDe('caixa-corpo-velho');
    const renovada = await renovar(primeira.refreshToken);
    expect(renovada.status, JSON.stringify(renovada.body)).toBe(200);
    const segunda = renovada.body as Tokens;

    await sair(segunda.accessToken, { refreshToken: primeira.refreshToken });

    const r2 = await renovar(segunda.refreshToken);
    expect(r2.status, JSON.stringify(r2.body)).toBe(401);
    expect(r2.body.accessToken).toBeUndefined();
    expect(await statusDaSessao(segunda.accessToken)).toBe(401);
  });

  it('e sem corpo nenhum também: a família inteira sai', async () => {
    const sessao = sessaoDe('caixa-sem-corpo');
    await sair(sessao.accessToken);
    expect((await renovar(sessao.refreshToken)).status).toBe(401);
  });
});

describe('(b) a rotação do refresh encerra o access token emitido com ele', () => {
  it('depois de renovar, o access de antes responde 401; o novo vale e fica na mesma família', async () => {
    const primeira = sessaoDe('caixa-rotacao');
    const renovada = await renovar(primeira.refreshToken);
    expect(renovada.status).toBe(200);

    const velho = await request(app).get('/api/v1/auth/session').set(portador(primeira.accessToken));
    expect(velho.status, JSON.stringify(velho.body)).toBe(401);
    expect(velho.body.error.code).toBe('API_SESSION_ENDED');
    expect(await statusDaSessao(renovada.body.accessToken)).toBe(200);
    expect(claimsDe(renovada.body.accessToken).sid).toBe(claimsDe(primeira.accessToken).sid);
  });
});

describe('dois aparelhos da mesma pessoa continuam independentes', () => {
  it('o balcão renova, troca de operação e sai; o celular segue com access e refresh vivos', async () => {
    const balcao = gerenteDasDuas('gerente-dois-aparelhos');
    const celular = sessaoDe('gerente-dois-aparelhos');
    expect(claimsDe(balcao.accessToken).sid).toEqual(expect.stringMatching(UUID));
    expect(claimsDe(celular.accessToken).sid).toEqual(expect.stringMatching(UUID));
    expect(claimsDe(balcao.accessToken).sid).not.toBe(claimsDe(celular.accessToken).sid);

    const renovado = (await renovar(balcao.refreshToken)).body as Tokens;
    const trocado = await trocar(renovado.accessToken, OUTRA, renovado.refreshToken);
    await sair(trocado.accessToken, { refreshToken: trocado.refreshToken });

    expect(await statusDaSessao(celular.accessToken)).toBe(200);
    expect((await renovar(celular.refreshToken)).status).toBe(200);
  });
});

describe('a família é da PESSOA do token', () => {
  it('uma linha de outra pessoa com o mesmo sid não é tocada pelo logout', async () => {
    const sessao = sessaoDe('caixa-dono-da-familia');
    const sid = claimsDe(sessao.accessToken).sid as string;
    const alheia = randomUUID();
    getConnection()
      .prepare('INSERT INTO api_sessions (id, data) VALUES (?, ?)')
      .run(
        alheia,
        JSON.stringify({
          id: alheia,
          userId: 'outra-pessoa',
          companyId: LOJA,
          profileCodes: ['atendente'],
          sid,
          revoked: false,
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        }),
      );

    await sair(sessao.accessToken);

    expect(linhaDaSessao(alheia).revoked).toBe(false);
    expect(linhaDaSessao(sessao.refreshToken).revoked).toBe(true);
  });
});

describe('o sid é aleatório e não secreto; nem ele é o refresh, nem o refresh vai no token', () => {
  it('cada login abre uma família nova; o registro do refresh guarda a família e o access emitido junto', () => {
    const a = sessaoDe('caixa-claims');
    const b = sessaoDe('caixa-claims');
    const claims = claimsDe(a.accessToken);
    expect(claims.sid).toEqual(expect.stringMatching(UUID));
    expect(claims.sid).not.toBe(claims.jti);
    expect(claims.sid).not.toBe(claimsDe(b.accessToken).sid);
    expect(JSON.stringify(claims)).not.toContain(a.refreshToken);

    const linha = linhaDaSessao(a.refreshToken);
    expect(linha.sid).toBe(claims.sid);
    expect(linha.accessJti).toBe(claims.jti);
    expect(linha.accessExpiresAt).toBe(new Date((claims.exp as number) * 1000).toISOString());
  });
});

describe('compatibilidade: token e sessão sem sid, emitidos antes, seguem a regra de antes até vencer', () => {
  function tokenAntigo(userId: string, extra: Record<string, unknown> = {}): string {
    return jwt.sign(
      { sub: userId, companyId: LOJA, profileCodes: ['gerente_loja'], sessionVersion: 1, ...extra },
      loadEnv().DEVORA_JWT_SECRET,
      { expiresIn: 3600 },
    );
  }

  it('token sem sid continua aceito; o logout com ele revoga o jti e o refresh do corpo, como antes', async () => {
    const provisionada = sessaoDe('caixa-antigo');
    const antigo = tokenAntigo('caixa-antigo', { jti: randomUUID() });
    expect(claimsDe(antigo).sid).toBeUndefined();
    expect(await statusDaSessao(antigo)).toBe(200);

    await sair(antigo, { refreshToken: provisionada.refreshToken });

    expect(await statusDaSessao(antigo)).toBe(401);
    expect((await renovar(provisionada.refreshToken)).status).toBe(401);
  });

  it('token sem sid nem jti: aceito, e o logout com ele não quebra', async () => {
    sessaoDe('caixa-mais-antigo');
    const antigo = tokenAntigo('caixa-mais-antigo');
    expect(await statusDaSessao(antigo)).toBe(200);
    await sair(antigo);
  });

  it('a troca com token sem sid funciona e a sessão nova já nasce numa família', async () => {
    const provisionada = gerenteDasDuas('gerente-antigo');
    const antigo = tokenAntigo('gerente-antigo', { jti: randomUUID() });
    // A prova do token sem família é um refresh vivo da MESMA pessoa (R2-SESSAO).
    const nova = await trocar(antigo, OUTRA, provisionada.refreshToken);
    expect(claimsDe(nova.accessToken).sid).toEqual(expect.stringMatching(UUID));
    // O token que chamou a troca sai, como no logout — e o refresh da prova também.
    expect(await statusDaSessao(antigo)).toBe(401);
    expect((await renovar(provisionada.refreshToken)).status).toBe(401);
  });

  it('refresh gravado sem família renova para uma família nova; o access de antes cai no próprio exp', async () => {
    const sessao = sessaoDe('caixa-refresh-antigo');
    const linha = linhaDaSessao(sessao.refreshToken);
    delete linha.sid;
    delete linha.accessJti;
    delete linha.accessExpiresAt;
    getConnection()
      .prepare('UPDATE api_sessions SET data = ? WHERE id = ?')
      .run(JSON.stringify(linha), sessao.refreshToken);

    const renovada = await renovar(sessao.refreshToken);
    expect(renovada.status, JSON.stringify(renovada.body)).toBe(200);
    expect(claimsDe(renovada.body.accessToken).sid).toEqual(expect.stringMatching(UUID));
    // Sem registro do access emitido junto, não há o que revogar: vale até o exp.
    expect(await statusDaSessao(sessao.accessToken)).toBe(200);
  });
});

describe('(c) a poda periódica leva as linhas vencidas de core_tokens_revogados', () => {
  it('a vencida sai na poda das sessões, sem esperar a próxima saída; a viva fica', () => {
    const db = getConnection();
    const agora = Date.now();
    const insere = db.prepare(
      'INSERT INTO core_tokens_revogados (jti, user_id, company_id, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?)',
    );
    insere.run('jti-vencido', 'alguem', LOJA, new Date(agora - 60_000).toISOString(), new Date(agora - 3_700_000).toISOString());
    insere.run('jti-vivo', 'alguem', LOJA, new Date(agora + 600_000).toISOString(), new Date(agora - 60_000).toISOString());

    const resultado = podarSessoesDeApi(agora) as { tokensRevogados?: number };

    const sobram = (db.prepare('SELECT jti FROM core_tokens_revogados ORDER BY jti').all() as { jti: string }[]).map(
      (l) => l.jti,
    );
    expect(sobram).toEqual(['jti-vivo']);
    expect(resultado.tokensRevogados).toBe(1);
  });
});
