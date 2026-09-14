/**
 * ============================================================================
 * A SESSÃO SE ACHA PELO ID, E A SESSÃO MORTA SAI DA TABELA (GAP-PRD-069)
 * ============================================================================
 *
 * `api_sessions` é uma coleção de documentos (`db/database.ts`): `seq`, `id` e
 * o JSON em `data`. O `refreshSession` a lia com `findOneRow` + `updateRows`,
 * que são VARREDURAS COMPLETAS em JavaScript — `SELECT seq, data` da tabela
 * inteira e um `JSON.parse` por linha — duas vezes por renovação, e o logout
 * mais uma. E nada apagava linha nenhuma: cada login e cada renovação horária
 * inseria uma, para sempre.
 *
 * Medido pela auditoria: com 40 mil sessões vencidas, `POST /auth/refresh`
 * levava 296–426 ms e o logout 183 ms — com o event loop parado, porque
 * `node:sqlite` é síncrono no mesmo processo do PDV. Todo caixa congela
 * enquanto qualquer terminal renova a sessão. O banco operacional tinha 434
 * linhas, todas vencidas, em um mês.
 *
 * ## Como este arquivo prova "não varre" sem cronômetro
 *
 * Cronômetro em teste muda de cor com a carga da máquina. A prova aqui é
 * estrutural: uma linha com JSON CORROMPIDO é plantada na coleção. Quem varre
 * a tabela faz `JSON.parse` nela e estoura (500); quem busca pelo id nunca a
 * lê. O vermelho do código antigo é exatamente esse 500.
 */
process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';

const { createApp } = await import('../src/app.js');
const { resetDbForTests, ensureSchema } = await import('../src/db/database.js');
const { getConnection } = await import('../src/db/sqlite.js');
const { ensureCoreSchema } = await import('../src/db/schema.js');
const { loginForTest } = await import('./helpers/auth.js');
const { issueSession } = await import('../src/services/api/ApiAuthService.js');

const app = createApp();

beforeEach(() => {
  resetDbForTests();
  ensureSchema();
  ensureCoreSchema();
});

async function entrar(userId: string) {
  const res = await loginForTest(app, {
    userId,
    companyId: 'loja-sessoes',
    profileCodes: ['operador_caixa_loja'],
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as { accessToken: string; refreshToken: string; user: { id: string } };
}

/**
 * Uma linha que ninguém consegue ler como JSON — a mina de quem varre.
 *
 * Desde a coluna gerada da empresa (DEP, GAP-PRD-147), o banco RECUSA gravar
 * documento que não é JSON: o `json_extract` da coluna estoura no INSERT. A
 * linha corrompida só existe em banco ANTIGO — entrou antes da coluna, e o boot
 * a acrescentou por ALTER sem reescrever linha nenhuma. É esse banco que o
 * teste monta: a tabela na forma de antes (com as linhas que já tinha), a linha
 * plantada, e a coluna acrescentada pelo MESMO ALTER do `ensureSchema`.
 */
function plantarLinhaCorrompida(): void {
  const db = getConnection();
  db.exec(`
    CREATE TABLE api_sessions_antes AS SELECT seq, id, data FROM api_sessions;
    DROP TABLE api_sessions;
    CREATE TABLE api_sessions (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT, data TEXT NOT NULL);
    INSERT INTO api_sessions (seq, id, data) SELECT seq, id, data FROM api_sessions_antes;
    DROP TABLE api_sessions_antes;
    CREATE INDEX IF NOT EXISTS "ix_api_sessions_id" ON api_sessions (id);
  `);
  db.prepare('INSERT INTO api_sessions (id, data) VALUES (?, ?)').run(`corrompida-${randomUUID()}`, '{isto nao e json');
  db.exec(
    "ALTER TABLE api_sessions ADD COLUMN company_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.companyId')) VIRTUAL",
  );
}

function plantarSessao(dados: Record<string, unknown>): string {
  const id = randomUUID();
  getConnection()
    .prepare('INSERT INTO api_sessions (id, data) VALUES (?, ?)')
    .run(id, JSON.stringify({ id, userId: 'fantasma', companyId: 'x', profileCodes: ['atendente'], ...dados }));
  return id;
}

function existe(id: string): boolean {
  return Boolean(getConnection().prepare('SELECT 1 AS n FROM api_sessions WHERE id = ?').get(id));
}

function contarSessoes(): number {
  return (getConnection().prepare('SELECT COUNT(*) AS n FROM api_sessions').get() as { n: number }).n;
}

describe('refresh e logout acham a sessão pelo id — não leem a coleção inteira', () => {
  it('o banco de hoje RECUSA gravar documento que não é JSON (a coluna gerada da empresa, GAP-PRD-147)', () => {
    expect(() =>
      getConnection()
        .prepare('INSERT INTO api_sessions (id, data) VALUES (?, ?)')
        .run(`nova-${randomUUID()}`, '{isto nao e json'),
    ).toThrow(/malformed JSON/);
  });

  it('uma linha corrompida em OUTRA sessão não derruba a renovação desta', async () => {
    const sessao = await entrar('caixa-por-id');
    plantarLinhaCorrompida();

    const res = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: sessao.refreshToken });

    // Quem varre faz JSON.parse na linha plantada e responde 500.
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
  });

  it('a rotação continua: o refresh usado morre, o novo vale', async () => {
    const sessao = await entrar('caixa-rotacao');
    plantarLinhaCorrompida();

    const primeira = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: sessao.refreshToken });
    expect(primeira.status).toBe(200);
    expect((await request(app).post('/api/v1/auth/refresh').send({ refreshToken: sessao.refreshToken })).status).toBe(401);
    expect(
      (await request(app).post('/api/v1/auth/refresh').send({ refreshToken: primeira.body.refreshToken })).status,
    ).toBe(200);
  });

  it('o logout também acha pelo id — e a sessão encerrada não renova', async () => {
    const sessao = await entrar('caixa-saida');
    plantarLinhaCorrompida();

    const saida = await request(app)
      .post('/api/v1/auth/logout')
      .set({ Authorization: `Bearer ${sessao.accessToken}` })
      .send({ refreshToken: sessao.refreshToken });
    expect(saida.status).toBe(204);

    const depois = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: sessao.refreshToken });
    expect(depois.status).toBe(401);
  });

  it('refresh token desconhecido e vazio seguem sendo 401, sem estourar', async () => {
    plantarLinhaCorrompida();
    expect((await request(app).post('/api/v1/auth/refresh').send({ refreshToken: randomUUID() })).status).toBe(401);
    expect((await request(app).post('/api/v1/auth/refresh').send({})).status).toBe(401);
  });

  it('sessão gravada sem expiresAt vence pela data de criação — não vale para sempre', async () => {
    const sessao = await entrar('caixa-legado');
    // Reescreve a linha como uma sessão antiga, de antes do campo, criada há 8 dias.
    const linha = getConnection()
      .prepare('SELECT data FROM api_sessions WHERE id = ?')
      .get(sessao.refreshToken) as { data: string };
    const antiga = JSON.parse(linha.data) as Record<string, unknown>;
    delete antiga.expiresAt;
    antiga.createdAt = new Date(Date.now() - 8 * 86_400_000).toISOString();
    getConnection()
      .prepare('UPDATE api_sessions SET data = ? WHERE id = ?')
      .run(JSON.stringify(antiga), sessao.refreshToken);

    const res = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: sessao.refreshToken });
    expect(res.status).toBe(401);
  });
});

describe('a sessão morta sai da tabela', () => {
  it('a poda apaga as vencidas e as revogadas, e deixa as vivas', async () => {
    const { podarSessoesDeApi } = await import('../src/services/api/SessoesDeApi.js');

    const vencida = plantarSessao({
      revoked: false,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const revogada = plantarSessao({
      revoked: true,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const semValidadeAntiga = plantarSessao({
      revoked: false,
      createdAt: new Date(Date.now() - 8 * 86_400_000).toISOString(),
    });
    const viva = plantarSessao({
      revoked: false,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    plantarLinhaCorrompida();

    const resultado = podarSessoesDeApi();

    expect(existe(vencida)).toBe(false);
    expect(existe(revogada)).toBe(false);
    expect(existe(semValidadeAntiga)).toBe(false);
    expect(existe(viva)).toBe(true);
    expect(resultado.sessoes).toBe(3);
    // A linha corrompida não tem idade que se possa ler: fica, e não estoura
    // a poda — apagar o que não se sabe datar seria esconder, não podar.
    expect(contarSessoes()).toBe(2);
  });

  it('a poda roda sozinha, amortizada, dentro da emissão de sessão — quem cria paga a limpeza', async () => {
    for (let i = 0; i < 300; i += 1) {
      plantarSessao({ revoked: false, expiresAt: new Date(Date.now() - 1000 - i).toISOString() });
    }
    expect(contarSessoes()).toBe(300);

    // Qualquer janela de emissões do tamanho de um ciclo contém uma poda.
    for (let i = 0; i < 51; i += 1) {
      issueSession({ userId: 'u-poda', companyId: 'c-poda', profileCodes: ['atendente'] });
    }

    // Sobram só as 51 sessões vivas que acabaram de nascer.
    expect(contarSessoes()).toBe(51);
  });

  it('a poda leva junto as tentativas de login velhas — e só as velhas', async () => {
    const { podarSessoesDeApi } = await import('../src/services/api/SessoesDeApi.js');
    const insere = getConnection().prepare(
      'INSERT INTO core_login_attempts (login, ip, succeeded, attempted_at) VALUES (?, ?, 0, ?)',
    );
    for (let i = 0; i < 20; i += 1) {
      insere.run('gerente', '10.0.0.9', new Date(Date.now() - 3 * 86_400_000 - i).toISOString());
    }
    // As recentes são a matéria do bloqueio de 15 minutos: não podem sumir.
    for (let i = 0; i < 4; i += 1) {
      insere.run('gerente', '10.0.0.9', new Date(Date.now() - i * 1000).toISOString());
    }

    const resultado = podarSessoesDeApi();
    const sobram = (getConnection().prepare('SELECT COUNT(*) AS n FROM core_login_attempts').get() as { n: number }).n;
    expect(resultado.tentativasDeLogin).toBe(20);
    expect(sobram).toBe(4);
  });

  it('com a tabela cheia de sessões mortas, o login seguinte já a deixa enxuta', async () => {
    const insere = getConnection().prepare('INSERT INTO api_sessions (id, data) VALUES (?, ?)');
    const vencida = new Date(Date.now() - 3600_000).toISOString();
    getConnection().exec('BEGIN');
    for (let i = 0; i < 5000; i += 1) {
      const id = randomUUID();
      insere.run(id, JSON.stringify({ id, userId: 'x', companyId: 'x', profileCodes: [], revoked: i % 2 === 0, expiresAt: vencida }));
    }
    getConnection().exec('COMMIT');

    const { podarSessoesDeApi } = await import('../src/services/api/SessoesDeApi.js');
    podarSessoesDeApi();
    await entrar('caixa-depois-da-poda');
    expect(contarSessoes()).toBe(1);
  });
});
