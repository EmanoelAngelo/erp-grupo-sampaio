import { describe, it, expect, beforeEach, vi } from 'vitest';
import { loginForTest } from './helpers/auth.js';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetEnvCacheForTests } from '../src/config/env.js';
import { resetDbForTests } from '../src/db/database.js';

process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-key';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-32-chars!!';
process.env.ASAAS_ENABLED = 'false';
process.env.ASAAS_PRODUCTION_ENABLED = 'false';

describe('CP60 — Backend API', () => {
  beforeEach(() => {
    resetEnvCacheForTests();
    resetDbForTests();
  });

  it('health responde ok', async () => {
    const app = createApp();
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  /*
    A SONDA DEIXOU DE FALAR DE CONFIGURAÇÃO.

    Ela devolvia `asaasEnabled` e `asaasProductionEnabled` — e respondia
    `ready: true` cravado, sem consultar nada. Uma sonda que sempre diz sim é
    pior que nenhuma: o orquestrador manda a fila da loja para um processo
    cujo banco não abre.

    Agora ela consulta o banco e responde só o que é prontidão. O estado das
    integrações não é prontidão — o ERP serve tráfego com ou sem Asaas — e
    numa rota SEM SESSÃO ele é detalhe de configuração dito ao mundo sem
    motivo. Quem precisa dele tem a tela de integrações, autenticada.
  */
  it('readiness consulta o banco e não fala de configuração', async () => {
    const app = createApp();
    const res = await request(app).get('/api/v1/readiness');
    expect(res.status).toBe(200);
    expect(res.body.ready).toBe(true);
    expect(res.body.database).toBe(true);
    expect(res.body.checkedAt).toBeTruthy();
    expect(res.body.asaasEnabled).toBeUndefined();
  });

  it('login emite tokens', async () => {
    const app = createApp();
    const res = await loginForTest(app, {
      userId: 'user-1',
      companyId: 'company-1',
      profileCodes: ['admin_geral'],
    });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
  });

  it('asaas status não expõe api key', async () => {
    process.env.ASAAS_ENABLED = 'true';
    process.env.ASAAS_API_KEY = '$aact_sandbox_secret123456';
    resetEnvCacheForTests();
    const app = createApp();
    const login = await loginForTest(app, {
      userId: 'user-1',
      companyId: 'company-1',
      profileCodes: ['admin_geral'],
    });
    const res = await request(app)
      .get('/api/v1/asaas/status')
      .set('Authorization', `Bearer ${login.body.accessToken}`);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('$aact_sandbox_secret123456');
    expect(res.body.sandbox.maskedHint).toMatch(/\*\*\*\*/);
  });

  it('webhook rejeita token inválido', async () => {
    process.env.ASAAS_WEBHOOK_AUTH_TOKEN = 'expected-token';
    resetEnvCacheForTests();
    const app = createApp();
    const res = await request(app)
      .post('/api/v1/webhooks/asaas')
      .set('asaas-access-token', 'wrong')
      .send({ id: 'evt-1', event: 'PAYMENT_RECEIVED' });
    expect(res.status).toBe(401);
  });

  it('webhook idempotente ignora duplicado', async () => {
    process.env.ASAAS_WEBHOOK_AUTH_TOKEN = 'expected-token';
    resetEnvCacheForTests();
    const app = createApp();
    const payload = { id: 'evt-dup', event: 'PAYMENT_RECEIVED' };
    const first = await request(app)
      .post('/api/v1/webhooks/asaas')
      .set('asaas-access-token', 'expected-token')
      .send(payload);
    const second = await request(app)
      .post('/api/v1/webhooks/asaas')
      .set('asaas-access-token', 'expected-token')
      .send(payload);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);
  });

  /*
    A FILA PARALELA SAIU (GAP-PRD-093). `POST /asaas/charges` enfileirava a
    cobrança numa coleção que nunca virava título nem baixa, e
    `/asaas/production/activate` respondia "activated: false" sem fazer nada.
    As duas respondem 410 com a rota que faz o serviço de verdade; os casos
    completos estão em `asaas-rotas-legadas.test.ts`.
  */
  it('cobrança pela rota legada responde 410 apontando a do núcleo', async () => {
    const app = createApp();
    const login = await loginForTest(app, {
      userId: 'user-1',
      companyId: 'company-1',
      profileCodes: ['admin_geral'],
    });
    const res = await request(app)
      .post('/api/v1/asaas/charges')
      .set('Authorization', `Bearer ${login.body.accessToken}`)
      .send({ billingType: 'PIX', value: 10 });
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe('API_ROUTE_GONE');
    expect(res.body.error.details.substituta).toContain('/core/finance/entries/:id/charge');
  });

  // A substituta era `/integrations/asaas/activate`, que saiu com o roteador
  // `/integrations` (GAP-PRD-075); produção se pede pela tela do Asaas.
  it('ativação de produção pela rota legada responde 410 apontando a da tela do Asaas', async () => {
    const app = createApp();
    const login = await loginForTest(app, {
      userId: 'user-1',
      companyId: 'company-1',
      profileCodes: ['admin_geral'],
    });
    const res = await request(app)
      .post('/api/v1/asaas/production/activate')
      .set('Authorization', `Bearer ${login.body.accessToken}`)
      .send({});
    expect(res.status).toBe(410);
    expect(res.body.error.details.substituta).toContain('PATCH /api/v1/core/integrations/asaas');
  });

  it('test-connection retorna ASAAS_CREDENTIAL_MISSING sem chave', async () => {
    process.env.ASAAS_ENABLED = 'true';
    process.env.ASAAS_API_KEY = '';
    resetEnvCacheForTests();
    const app = createApp();
    const login = await loginForTest(app, {
      userId: 'user-1',
      companyId: 'company-1',
      profileCodes: ['admin_geral'],
    });
    const res = await request(app)
      .post('/api/v1/asaas/test-connection')
      .set('Authorization', `Bearer ${login.body.accessToken}`)
      .send({ environment: 'sandbox' });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('ASAAS_CREDENTIAL_MISSING');
  });
});

describe('CP60 — AsaasHttpClient mock', () => {
  it('não registra api key nos logs', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    process.env.ASAAS_ENABLED = 'true';
    process.env.ASAAS_API_KEY = '$aact_sandbox_key1234';
    resetEnvCacheForTests();
    const { AsaasHttpClient } = await import('../src/services/asaas/AsaasHttpClient.js');
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ balance: 0 }),
    })) as unknown as typeof fetch;
    const client = new AsaasHttpClient({ environment: 'sandbox', fetchImpl });
    await client.testConnection();
    const logs = logSpy.mock.calls.flat().join(' ');
    expect(logs).not.toContain('$aact_sandbox_key1234');
    logSpy.mockRestore();
  });
});
