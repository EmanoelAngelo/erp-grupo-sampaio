/**
 * ============================================================================
 * O PROXY QUE NINGUÉM DECLAROU APARECE NA PRONTIDÃO (GAP-PRD-055)
 * ============================================================================
 *
 * `DEVORA_TRUST_PROXY` é configuração do dono — só ele sabe quantos saltos há
 * na frente da API. O que é software é não deixar o erro ser mudo: deixar o
 * valor em 0 atrás de um proxy faz as seis operações dividirem UM balde de 300
 * requisições por minuto (e, até o GAP-PRD-074, o bloqueio de login do IP do
 * proxy). Nada avisava.
 *
 * Um proxy reverso acrescenta `X-Forwarded-For` a cada requisição. O servidor
 * agora observa esse sinal (e o contrário: proxy declarado, mas requisição de
 * fora chegando sem ele), avisa UMA vez no log e devolve o estado em
 * `/core/system/secrets-readiness`, campo `publicacao`. Não liga nem desliga
 * `trust proxy` por conta própria.
 */
process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const { resetEnvCacheForTests } = await import('../src/config/env.js');
const { createApp } = await import('../src/app.js');
const { resetDbForTests } = await import('../src/db/database.js');
const { estadoDaPublicacao, esquecerObservacoesDoProxy } = await import('../src/middleware/observarProxy.js');
const { loginForTest } = await import('./helpers/auth.js');

const original = process.env.DEVORA_TRUST_PROXY;

function montarApp(trustProxy: string | undefined) {
  if (trustProxy === undefined) delete process.env.DEVORA_TRUST_PROXY;
  else process.env.DEVORA_TRUST_PROXY = trustProxy;
  resetEnvCacheForTests();
  return createApp();
}

function vistoDe(app: ReturnType<typeof createApp>, endereco: string) {
  const casca = express();
  casca.use((req, _res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: endereco, configurable: true });
    next();
  });
  casca.use(app);
  return casca;
}

function espiarAvisos() {
  const avisos: string[] = [];
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    avisos.push(args.map(String).join(' '));
  });
  return avisos;
}

beforeEach(() => {
  resetDbForTests();
  esquecerObservacoesDoProxy();
});

afterEach(() => {
  vi.restoreAllMocks();
  if (original === undefined) delete process.env.DEVORA_TRUST_PROXY;
  else process.env.DEVORA_TRUST_PROXY = original;
  resetEnvCacheForTests();
});

describe('DEVORA_TRUST_PROXY=0 (o padrão)', () => {
  it('servido direto, sem X-Forwarded-For: nada a avisar', async () => {
    const avisos = espiarAvisos();
    const app = montarApp(undefined);
    await request(vistoDe(app, '192.168.0.20')).get('/api/v1/health');
    expect(estadoDaPublicacao().estado).toBe('SERVIDO_DIRETO');
    expect(avisos).toEqual([]);
  });

  it('chegou X-Forwarded-For: vira PROXY_NAO_DECLARADO, e o log avisa UMA vez dizendo o que fazer', async () => {
    const avisos = espiarAvisos();
    const app = montarApp('0');
    for (let i = 0; i < 3; i += 1) {
      await request(vistoDe(app, '10.0.0.2')).get('/api/v1/health').set('X-Forwarded-For', `203.0.113.${i}`);
    }

    const estado = estadoDaPublicacao();
    expect(estado.estado).toBe('PROXY_NAO_DECLARADO');
    expect(estado.proxyNaoDeclarado?.vezes).toBe(3);
    const doProxy = avisos.filter((a) => a.includes('publicacao_proxy_nao_declarado'));
    expect(doProxy).toHaveLength(1);
    expect(doProxy[0]).toContain('DEVORA_TRUST_PROXY');
  });

  it('observar não muda comportamento: o X-Forwarded-For continua sem valer (trust proxy desligado)', () => {
    const app = montarApp('0');
    expect(app.get('trust proxy')).toBe(false);
  });
});

describe('DEVORA_TRUST_PROXY=1', () => {
  it('requisições com X-Forwarded-For: PROXY_DECLARADO, sem aviso', async () => {
    const avisos = espiarAvisos();
    const app = montarApp('1');
    await request(vistoDe(app, '10.0.0.2')).get('/api/v1/health').set('X-Forwarded-For', '203.0.113.9');
    expect(estadoDaPublicacao().estado).toBe('PROXY_DECLARADO');
    expect(avisos).toEqual([]);
  });

  it('requisição de FORA sem X-Forwarded-For: há um caminho que contorna o proxy — avisa', async () => {
    const avisos = espiarAvisos();
    const app = montarApp('1');
    await request(vistoDe(app, '192.168.0.77')).get('/api/v1/health');
    expect(estadoDaPublicacao().estado).toBe('PROXY_DECLARADO_MAS_ACESSO_DIRETO');
    expect(avisos.filter((a) => a.includes('publicacao_proxy_contornado'))).toHaveLength(1);
  });

  it('a sonda de saúde do próprio host (loopback) não é alarme', async () => {
    const avisos = espiarAvisos();
    const app = montarApp('1');
    await request(vistoDe(app, '127.0.0.1')).get('/api/v1/health');
    await request(vistoDe(app, '::1')).get('/api/v1/health');
    expect(estadoDaPublicacao().estado).toBe('PROXY_DECLARADO');
    expect(avisos).toEqual([]);
  });
});

describe('a prontidão da instalação devolve o estado', () => {
  it('/core/system/secrets-readiness traz `publicacao`, sem valor sensível', async () => {
    espiarAvisos();
    const app = montarApp('0');
    await request(vistoDe(app, '10.0.0.2')).get('/api/v1/health').set('X-Forwarded-For', '203.0.113.1');

    const dono = await loginForTest(app, { userId: 'dono-publicacao', companyId: 'loja-publicacao', profileCodes: ['gestor'] });
    const res = await request(app)
      .get('/api/v1/core/system/secrets-readiness')
      .set({ Authorization: `Bearer ${dono.body.accessToken}` });

    expect(res.status).toBe(200);
    expect(res.body.publicacao.trustProxy).toBe(0);
    expect(res.body.publicacao.estado).toBe('PROXY_NAO_DECLARADO');
  });
});
