/**
 * ============================================================================
 * CSP E HSTS NA API — E EM TODA RESPOSTA, INCLUSIVE A DOS ARQUIVOS (GAP-PRD-156)
 * ============================================================================
 *
 * A API mandava só `nosniff`, `Referrer-Policy` e `X-Frame-Options`, e mesmo
 * esses num middleware montado DEPOIS dos estáticos de `/uploads` e do
 * parser do corpo: o arquivo servido e a recusa do corpo quebrado saíam sem
 * cabeçalho nenhum. Não havia `Content-Security-Policy` nem HSTS.
 *
 * O que muda:
 *
 *   - toda resposta da API leva uma CSP de API — `default-src 'none'`,
 *     `frame-ancestors 'none'`: resposta desta origem não carrega script,
 *     estilo, imagem nem moldura, nem se deixa emoldurar. Um HTML ou SVG que
 *     um dia sair daqui aberto direto no navegador não executa nada;
 *   - HSTS quando a requisição veio por HTTPS — no próprio app ou, com
 *     `DEVORA_TRUST_PROXY`, pelo `X-Forwarded-Proto` do proxy confiável. Sem
 *     proxy declarado o cabeçalho do cliente não vale: ninguém liga HSTS no
 *     navegador dos outros escrevendo um cabeçalho;
 *   - os cabeçalhos vêm ANTES de tudo, então valem para `/uploads`, preflight
 *     de CORS, 404 e erro do parser.
 */
process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const pastaDeUploads = mkdtempSync(join(tmpdir(), 'gs-cabecalhos-'));
process.env.DEVORA_UPLOADS_DIR = pastaDeUploads;

const { resetEnvCacheForTests } = await import('../src/config/env.js');
const { createApp } = await import('../src/app.js');
const { resetDbForTests } = await import('../src/db/database.js');

const original = process.env.DEVORA_TRUST_PROXY;

function montarApp(trustProxy?: string) {
  if (trustProxy === undefined) delete process.env.DEVORA_TRUST_PROXY;
  else process.env.DEVORA_TRUST_PROXY = trustProxy;
  resetEnvCacheForTests();
  return createApp();
}

beforeAll(() => {
  resetDbForTests();
  mkdirSync(join(pastaDeUploads, 'produtos'), { recursive: true });
  writeFileSync(join(pastaDeUploads, 'produtos', 'foto-teste.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
});

afterAll(() => {
  rmSync(pastaDeUploads, { recursive: true, force: true });
});

afterEach(() => {
  if (original === undefined) delete process.env.DEVORA_TRUST_PROXY;
  else process.env.DEVORA_TRUST_PROXY = original;
  resetEnvCacheForTests();
});

function cobrarCabecalhosDeApi(headers: Record<string, string>) {
  const csp = headers['content-security-policy'] ?? '';
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("base-uri 'none'");
  expect(csp).toContain("form-action 'none'");
  // Nada de brecha: a política de API não libera script de lugar nenhum.
  expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|script-src/);
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['x-frame-options']).toBe('DENY');
  expect(headers['referrer-policy']).toBe('no-referrer');
}

describe('a CSP de API vale em toda resposta', () => {
  it('rota JSON', async () => {
    const res = await request(montarApp()).get('/api/v1/health');
    expect(res.status).toBe(200);
    cobrarCabecalhosDeApi(res.headers as Record<string, string>);
  });

  it('arquivo de /uploads — antes saía sem cabeçalho nenhum', async () => {
    const res = await request(montarApp()).get('/uploads/produtos/foto-teste.png');
    expect(res.status).toBe(200);
    cobrarCabecalhosDeApi(res.headers as Record<string, string>);
  });

  it('404 e recusa do parser do corpo', async () => {
    const app = montarApp();
    cobrarCabecalhosDeApi((await request(app).get('/api/v1/nao-existe')).headers as Record<string, string>);
    const quebrado = await request(app)
      .post('/api/v1/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"login":');
    expect(quebrado.status).toBe(400);
    cobrarCabecalhosDeApi(quebrado.headers as Record<string, string>);
  });

  it('preflight de CORS da tela continua funcionando, e também leva a CSP', async () => {
    const res = await request(montarApp())
      .options('/api/v1/core/products')
      .set('Origin', 'http://localhost:5173')
      .set('Access-Control-Request-Method', 'GET')
      .set('Access-Control-Request-Headers', 'authorization,content-type');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    cobrarCabecalhosDeApi(res.headers as Record<string, string>);
  });
});

describe('HSTS só por HTTPS, e só com a palavra de quem pode dar', () => {
  it('HTTP puro (a LAN do balcão): sem HSTS', async () => {
    const res = await request(montarApp()).get('/api/v1/health');
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });

  it('atrás do proxy declarado que terminou o TLS: HSTS de 180 dias', async () => {
    const res = await request(montarApp('1'))
      .get('/api/v1/health')
      .set('X-Forwarded-For', '203.0.113.5')
      .set('X-Forwarded-Proto', 'https');
    expect(res.headers['strict-transport-security']).toBe('max-age=15552000');
  });

  it('sem proxy declarado, X-Forwarded-Proto escrito pelo cliente não liga HSTS', async () => {
    const res = await request(montarApp())
      .get('/api/v1/health')
      .set('X-Forwarded-Proto', 'https');
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });
});
