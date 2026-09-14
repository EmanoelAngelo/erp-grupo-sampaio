/**
 * Prompt 27 — Backend security / identity
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { loginForTest } from './helpers/auth.js';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetEnvCacheForTests, loadEnv } from '../src/config/env.js';
import {
  refreshSession,
  revokeSession,
  ACCESS_TOKEN_TTL_SECONDS,
  isJwtEternal,
} from '../src/services/api/ApiAuthService.js';
// Sessão da conta que EXISTE: authMiddleware confere a conta a cada requisição (GAP-PRD-053).
import { issueSession } from './helpers/sessao.js';

function sanitizeLocal(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === 'string') return value.replace(/Bearer\s+\S+/g, '[REDACTED]');
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = /password|token|secret|apiKey|pfx|csc|authorization/i.test(k) ? '[REDACTED]' : sanitizeLocal(v);
    }
    return out;
  }
  return value;
}

describe('Prompt 27 BE — auth / session / security', () => {
  const app = createApp();

  beforeEach(() => {
    resetEnvCacheForTests();
  });

  it('JWT TTL not eternal + refresh rotation', async () => {
    expect(ACCESS_TOKEN_TTL_SECONDS).toBe(3600);
    expect(isJwtEternal()).toBe(false);
    /*
      A SESSÃO PERTENCE A UMA PESSOA DE VERDADE — a rodada 31 fez o refresh
      abrir `core_users` e recusar sessão de usuário inexistente ou desativado.
      Este caso fabricava a sessão com `issueSession({userId: 'u1'})`, sem
      criar o usuário, e rotacionava assim mesmo: exatamente o comportamento
      que deixou de existir. O login real provisiona usuário, vínculo e senha,
      e o que se mede aqui — TTL e rotação — continua sendo o mesmo.
    */
    const login = await loginForTest(app, {
      userId: 'u1',
      companyId: 'company-gringa',
      profileCodes: ['gerente_loja'],
    });
    expect(login.status).toBe(200);
    expect(login.body.expiresIn).toBe(3600);

    const refreshed = refreshSession(String(login.body.refreshToken));
    expect(refreshed.accessToken).toBeTruthy();
    // Rotação: o token antigo morre no primeiro uso.
    expect(() => refreshSession(String(login.body.refreshToken))).toThrow();
    revokeSession(refreshed.refreshToken);
  });

  it('login rejects grupo companyId', async () => {
    const res = await loginForTest(app, {
      userId: 'u1',
      companyId: 'grupo-sampaio',
      profileCodes: ['admin_geral'],
    });
    expect(res.status).toBe(400);
  });

  it('login issues token in test/dev bridge', async () => {
    const res = await loginForTest(app, {
      userId: 'u1',
      companyId: 'company-gringa',
      storeId: 'store-gringa-matriz',
      profileCodes: ['gerente_loja'],
      bridgeToken: 'devora-local-session-bridge',
    });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.expiresIn).toBe(3600);
  });

  it('cross-tenant: a porta que aceitava a empresa pela query saiu do ar', async () => {
    /*
      Este caso cobrava o 403 de `GET /system/audit?companyId=<outra>`. A rota
      saiu na verificação do GAP-PRD-075: sem tela, lia uma lista em memória
      que só os testes preenchiam e, vazia, inventava a linha `audit-stub-scan`.
      Sem a porta, não há o que atravessar — e o caso passa a cobrar que ela
      não volta calada. A trilha de verdade (`GET /core/audit`) tira a empresa
      do token e é cobrada em prompt29 e em auditoria-tem-leitor.
    */
    const tokens = issueSession({
      userId: 'u-g',
      companyId: 'company-gringa',
      profileCodes: ['gerente_loja'],
    });
    const res = await request(app)
      .get('/api/v1/system/audit?companyId=company-preco-justo')
      .set('Authorization', `Bearer ${tokens.accessToken}`);
    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe('API_NOT_FOUND');
  });

  it('security headers present', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
  });

  it('sanitize never leaks secrets', () => {
    const clean = JSON.stringify(sanitizeLocal({
      password: 'x',
      token: 'y',
      apiKey: 'z',
      pfxBase64: 'p',
      cscToken: 'c',
      Authorization: 'Bearer abc',
    }));
    expect(clean).not.toMatch(/"x"|"y"|"z"|"p"|"c"|Bearer abc/);
  });

  it('env defaults readiness signals', () => {
    const env = loadEnv();
    expect(env.DEVORA_JWT_SECRET.length).toBeGreaterThanOrEqual(8);
    expect(ACCESS_TOKEN_TTL_SECONDS).toBeLessThan(86_400 * 30);
  });

  it('MFA not claimed active in openapi/auth', async () => {
    const res = await request(app).get('/api/v1/openapi.json');
    expect(res.status).toBe(200);
    const text = JSON.stringify(res.body).toLowerCase();
    expect(text).not.toContain('mfa enabled');
    expect(text).not.toContain('mfa ativo');
  });
});
