/**
 * ============================================================================
 * ATRÁS DO PROXY, O BLOQUEIO POR PAR CONTINUA SENDO POR PAR (GAP-PRD-074)
 * ============================================================================
 *
 * O bloqueio de login conta falhas por PAR (login + origem) desde a rodada 34
 * — é o que impede quem sabe o login do gerente (está no cupom) de trancá-lo
 * para fora do próprio caixa com cinco senhas erradas de um celular. Ver
 * `bloqueio-de-login-nao-e-arma.test.ts`.
 *
 * Mas a origem vinha SEMPRE do socket. Atrás de um proxy reverso — que é como
 * este ERP é publicado — o socket é o proxy, o mesmo para todo mundo: o par
 * virava (gerente, IP-do-proxy), e cinco erros de qualquer celular trancavam o
 * gerente de novo, em todos os caixas. O limite de taxa já honrava
 * `DEVORA_TRUST_PROXY`; o par do bloqueio não.
 *
 * Agora, com `DEVORA_TRUST_PROXY > 0`, a origem é o endereço que o salto
 * confiável viu (`req.ip`); sem proxy declarado, continua o socket. O que
 * impede "trocar de aparelho" forjando `X-Forwarded-For` é o próprio Express:
 * com N saltos confiáveis ele descarta o que o cliente escreveu à esquerda e
 * fica com o endereço que o proxy acrescentou.
 */
process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';

const { resetEnvCacheForTests } = await import('../src/config/env.js');
const { createApp } = await import('../src/app.js');
const { resetDbForTests } = await import('../src/db/database.js');
const { getConnection } = await import('../src/db/sqlite.js');
const { linkUserToCompany, upsertCompany, upsertUser } = await import('../src/services/auth/IdentityService.js');

const SENHA = 'Senha@Forte123';
/** O endereço do proxy reverso: é o que o socket vê para TODO mundo. */
const PROXY = '10.0.0.2';
const original = process.env.DEVORA_TRUST_PROXY;

function montarApp(trustProxy: string | undefined) {
  if (trustProxy === undefined) delete process.env.DEVORA_TRUST_PROXY;
  else process.env.DEVORA_TRUST_PROXY = trustProxy;
  resetEnvCacheForTests();
  return createApp();
}

/** O app visto como o proxy o vê: toda conexão chega do mesmo socket. */
function atrasDoProxy(app: ReturnType<typeof createApp>) {
  const casca = express();
  casca.use((req, _res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: PROXY, configurable: true });
    next();
  });
  casca.use(app);
  return casca;
}

/**
 * Uma tentativa de login vinda de `cliente`, passando pelo proxy — que
 * ACRESCENTA o endereço do cliente ao `X-Forwarded-For` (o que nginx e Caddy
 * fazem). `forjado` é o que o próprio cliente escreveu no cabeçalho, se algo.
 */
function tentar(
  app: ReturnType<typeof createApp>,
  cliente: string,
  senha: string,
  forjado?: string,
) {
  const xff = forjado ? `${forjado}, ${cliente}` : cliente;
  return request(atrasDoProxy(app))
    .post('/api/v1/auth/login')
    .set('X-Forwarded-For', xff)
    .send({ login: 'GERENTE', password: senha });
}

beforeEach(async () => {
  resetDbForTests();
  const companyId = upsertCompany({ slug: 'preco-justo', legalName: 'Preço Justo Ltda', tradeName: 'Preço Justo' });
  const userId = await upsertUser({ login: 'GERENTE', displayName: 'Gerente', password: SENHA });
  linkUserToCompany(userId, companyId, 'gerente_loja', true);
});

afterEach(() => {
  if (original === undefined) delete process.env.DEVORA_TRUST_PROXY;
  else process.env.DEVORA_TRUST_PROXY = original;
  resetEnvCacheForTests();
});

describe('com DEVORA_TRUST_PROXY=1 (um proxy reverso na frente)', () => {
  it('cinco erros de UM celular trancam aquele celular — e o gerente, do caixa, continua entrando', async () => {
    const app = montarApp('1');
    for (let i = 0; i < 5; i += 1) await tentar(app, '203.0.113.50', 'errada');

    const doAtacante = await tentar(app, '203.0.113.50', SENHA);
    expect(doAtacante.status).toBe(429);

    // Era aqui a arma: o caixa do gerente chega pelo MESMO proxy.
    const doCaixa = await tentar(app, '198.51.100.10', SENHA);
    expect(doCaixa.status, JSON.stringify(doCaixa.body)).toBe(200);
  });

  it('forjar X-Forwarded-For não troca de aparelho: vale o endereço que o proxy acrescentou', async () => {
    const app = montarApp('1');
    for (let i = 0; i < 5; i += 1) {
      await tentar(app, '203.0.113.50', 'errada', `192.0.2.${i + 1}`);
    }
    const sextaForjada = await tentar(app, '203.0.113.50', SENHA, '192.0.2.99');
    expect(sextaForjada.status).toBe(429);
  });

  it('o teto por login continua valendo contra força bruta distribuída', async () => {
    const app = montarApp('1');
    for (let i = 1; i <= 13; i += 1) {
      for (let j = 0; j < 4; j += 1) await tentar(app, `203.0.113.${i}`, 'errada');
    }
    expect((await tentar(app, '198.51.100.10', SENHA)).status).toBe(429);
  });

  it('a tentativa e a trilha de auditoria gravam o endereço do cliente, não o do proxy', async () => {
    const app = montarApp('1');
    await tentar(app, '203.0.113.77', 'errada');
    const ips = (getConnection().prepare('SELECT ip FROM core_login_attempts').all() as { ip: string }[]).map((r) => r.ip);
    expect(ips).toEqual(['203.0.113.77']);

    // (O login certo limpa as tentativas do login — por isso a leitura acima vem antes.)
    await tentar(app, '198.51.100.10', SENHA);

    const auditoria = getConnection()
      .prepare("SELECT ip FROM core_audit_log WHERE action = 'auth.login'")
      .all() as { ip: string }[];
    expect(auditoria.map((a) => a.ip)).toEqual(['198.51.100.10']);
  });
});

describe('sem proxy declarado (o padrão), nada muda', () => {
  it('o X-Forwarded-For é ignorado: a origem é o socket, e forjar o cabeçalho não escapa do par', async () => {
    const app = montarApp(undefined);
    for (let i = 0; i < 5; i += 1) {
      // Cada tentativa "diz" vir de um lugar diferente; o socket é o mesmo.
      await tentar(app, `192.0.2.${i + 1}`, 'errada');
    }
    expect((await tentar(app, '192.0.2.200', SENHA)).status).toBe(429);
  });
});
