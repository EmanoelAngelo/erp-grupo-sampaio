import { describe, it, expect, beforeEach } from 'vitest';
import { loginForTest } from './helpers/auth.js';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetEnvCacheForTests } from '../src/config/env.js';
import { resetDbForTests } from '../src/db/database.js';

process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-key';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-32-chars!!';

/*
  CP66 cobrava o roteador `/api/v1/fiscal/nfce` inteiro. O GAP-PRD-096 deixou
  nele só o CSC, e a junção do GAP-PRD-075 levou o CSC ao núcleo
  (`/core/fiscal/nfce/csc`) e apagou o roteador. A lista completa das rotas
  que respondem 404 está em `rotas-fiscais-legadas-fora-do-ar.test.ts`.
*/
describe('CP66 — Backend NFC-e API', () => {
  beforeEach(() => {
    resetEnvCacheForTests();
    resetDbForTests();
  });

  it('version endpoint reporta checkpoint 66', async () => {
    const app = createApp();
    const res = await request(app).get('/api/v1/version');
    expect(res.status).toBe(200);
    expect(res.body.checkpoint).toBe(73);
  });

  it('a sonda cravada e os documentos legados saíram: 404', async () => {
    const app = createApp();
    const login = await loginForTest(app, { userId: 'user-1', companyId: 'company-1', profileCodes: ['admin_geral'] });
    const auth = { Authorization: `Bearer ${login.body.accessToken}` };
    expect((await request(app).get('/api/v1/fiscal/nfce/health')).status).toBe(404);
    expect((await request(app).get('/api/v1/fiscal/nfce/readiness').set(auth)).status).toBe(404);
    const criar = await request(app)
      .post('/api/v1/fiscal/nfce/documents')
      .set(auth)
      .set('Idempotency-Key', 'nfce-doc-1')
      .send({ paymentMethod: 'pix' });
    expect(criar.status).toBe(404);
  });

  it('CSC endpoint não expõe token', async () => {
    const app = createApp();
    const login = await loginForTest(app, { userId: 'user-1', companyId: 'company-1', profileCodes: ['admin_geral'] });
    const res = await request(app).get('/api/v1/core/fiscal/nfce/csc').set('Authorization', `Bearer ${login.body.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.cscToken).toBeUndefined();
  });
});
