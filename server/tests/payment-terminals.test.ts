import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
// Sessão da conta que EXISTE: authMiddleware confere a conta a cada requisição (GAP-PRD-053).
import { issueSession } from './helpers/sessao.js';
import { runMigrations } from '../src/db/migrate.js';
import { loadDb } from '../src/db/database.js';

const app = createApp();

function authHeaders(idempotencyKey?: string) {
  const tokens = issueSession({
    userId: '550e8400-e29b-41d4-a716-446655440005',
    companyId: 'company-pt-api',
    storeId: 'store-pt-api',
    profileCodes: ['admin_geral'],
  });
  const headers: Record<string, string> = { Authorization: `Bearer ${tokens.accessToken}` };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  return headers;
}

beforeAll(() => {
  runMigrations();
});

describe('Payment Terminals API — Checkpoint 72', () => {
  it('GET /payment-terminals/health', async () => {
    const res = await request(app).get('/api/v1/payment-terminals/health');
    expect(res.status).toBe(200);
    expect(res.body.checkpoint).toBe(72);
  });

  it('GET /version checkpoint 73', async () => {
    const res = await request(app).get('/api/v1/version');
    expect(res.body.checkpoint).toBe(73);
  });

  it('migration v14', () => {
    expect(loadDb().version).toBeGreaterThanOrEqual(14);
  });

  it('GET /payment-terminals/providers', async () => {
    const res = await request(app).get('/api/v1/payment-terminals/providers').set(authHeaders());
    expect(res.status).toBe(200);
    expect(res.body.items).toContain('mock');
    expect(res.body.items).toContain('stone');
  });

  it('POST /payment-terminals/configurations idempotente', async () => {
    const key = `ptcfg-${Date.now()}`;
    const res1 = await request(app)
      .post('/api/v1/payment-terminals/configurations')
      .set(authHeaders(key))
      .send({ displayName: 'Terminal API', provider: 'mock' });
    expect(res1.status).toBe(201);
    const res2 = await request(app)
      .post('/api/v1/payment-terminals/configurations')
      .set(authHeaders(key))
      .send({ displayName: 'Terminal API', provider: 'mock' });
    expect(res2.body.id).toBe(res1.body.id);
  });

  it('GET /payment-terminals/readiness', async () => {
    const res = await request(app).get('/api/v1/payment-terminals/readiness').set(authHeaders());
    expect(res.status).toBe(200);
    expect(res.body.productionBlocked).toBe(true);
    expect(res.body.providers.length).toBeGreaterThanOrEqual(8);
  });

  it('GET /payment-terminals/providers-status', async () => {
    const res = await request(app).get('/api/v1/payment-terminals/providers-status').set(authHeaders());
    expect(res.status).toBe(200);
    expect(res.body.items.some((i: { provider: string }) => i.provider === 'mock')).toBe(true);
    expect(res.body.productionBlocked).toBe(true);
  });

  it('POST /payment-terminals/homologation/run mock', async () => {
    const res = await request(app)
      .post('/api/v1/payment-terminals/homologation/run')
      .set(authHeaders(`pthom-${Date.now()}`))
      .send({ provider: 'mock' });
    expect(res.status).toBe(202);
    expect(res.body.stepsCompleted.length).toBeGreaterThan(5);
  });

  it('GET /payment-terminals/dashboard', async () => {
    const res = await request(app).get('/api/v1/payment-terminals/dashboard').set(authHeaders());
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('transactionsTotal');
  });

  it('POST /payment-terminals/transactions idempotente', async () => {
    const key = `pttx-${Date.now()}`;
    const res1 = await request(app)
      .post('/api/v1/payment-terminals/transactions')
      .set(authHeaders(key))
      .send({ amountInCents: 1000, paymentMethod: 'credit' });
    expect(res1.status).toBe(201);
    const res2 = await request(app)
      .post('/api/v1/payment-terminals/transactions')
      .set(authHeaders(key))
      .send({ amountInCents: 1000, paymentMethod: 'credit' });
    expect(res2.body.id).toBe(res1.body.id);
  });
});
