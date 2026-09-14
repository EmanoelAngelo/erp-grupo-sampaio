import { describe, it, expect, beforeEach } from 'vitest';
import { loginForTest } from './helpers/auth.js';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetEnvCacheForTests } from '../src/config/env.js';
import { resetDbForTests } from '../src/db/database.js';

process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-key';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-32-chars!!';

describe('CP63 — Backend Logística API', () => {
  beforeEach(() => {
    resetEnvCacheForTests();
    resetDbForTests();
  });

  it('version endpoint reporta checkpoint 63', async () => {
    const app = createApp();
    const res = await request(app).get('/api/v1/version');
    expect(res.status).toBe(200);
    expect(res.body.checkpoint).toBe(73);
  });

  it('cria cotação logística autenticada', async () => {
    const app = createApp();
    const login = await loginForTest(app, {
      userId: 'user-1',
      companyId: 'company-1',
      profileCodes: ['admin_geral'],
    });
    const res = await request(app)
      .post('/api/v1/logistics/quotes')
      .set('Authorization', `Bearer ${login.body.accessToken}`)
      .set('Idempotency-Key', 'lg-quote-1')
      .send({
        originZipCode: '01310100',
        destinationZipCode: '30130000',
        // Pacote REAL. Sem isto não há cotação — ver o teste seguinte.
        weightGrams: 800,
        heightCm: 12,
        widthCm: 18,
        lengthCm: 24,
        declaredValueInCents: 15000,
      });
    expect(res.status).toBe(201);
    expect(res.body.options.length).toBeGreaterThan(0);
  });

  it('recusa cotar sem peso e dimensões, dizendo o que falta', async () => {
    // Este teste substitui a versão anterior, que mandava só os dois CEPs e
    // esperava opções. Ela cobrava um comportamento errado: o serviço assumia
    // 500 g numa caixa 10×15×20 e devolvia um preço. O transportador cobra
    // pelo pacote real, e a diferença aparecia depois da venda fechada.
    const app = createApp();
    const login = await loginForTest(app, {
      userId: 'user-1',
      companyId: 'company-1',
      profileCodes: ['admin_geral'],
    });

    const res = await request(app)
      .post('/api/v1/logistics/quotes')
      .set('Authorization', `Bearer ${login.body.accessToken}`)
      .set('Idempotency-Key', 'lg-quote-sem-dados')
      .send({ originZipCode: '01310100', destinationZipCode: '30130000' });

    expect(res.body.options).toEqual([]);
    expect(res.body.code).toBe('SHIPPING_DATA_REQUIRED');
    expect(res.body.missing).toEqual(
      expect.arrayContaining(['peso', 'altura', 'largura', 'comprimento']),
    );
  });

  it('lista envios logísticos por empresa', async () => {
    const app = createApp();
    const login = await loginForTest(app, {
      userId: 'user-1',
      companyId: 'company-1',
      profileCodes: ['admin_geral'],
    });
    const res = await request(app)
      .get('/api/v1/logistics/shipments')
      .set('Authorization', `Bearer ${login.body.accessToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
  });

  it('health logística indica produção bloqueada', async () => {
    const app = createApp();
    const res = await request(app).get('/api/v1/logistics/health');
    expect(res.status).toBe(200);
    expect(res.body.productionBlocked).toBe(true);
  });

  it('readiness logística com produção bloqueada', async () => {
    const app = createApp();
    const login = await loginForTest(app, { userId: 'user-1', companyId: 'company-1', profileCodes: ['admin_geral'] });
    const res = await request(app).get('/api/v1/logistics/readiness').set('Authorization', `Bearer ${login.body.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.productionBlocked).toBe(true);
    expect(res.body.providers.length).toBe(3);
  });

  it('credenciais ficam no backend sem expor apiKey', async () => {
    const app = createApp();
    const login = await loginForTest(app, {
      userId: 'user-1',
      companyId: 'company-1',
      profileCodes: ['admin_geral'],
    });
    const res = await request(app)
      .post('/api/v1/logistics/carriers/credentials')
      .set('Authorization', `Bearer ${login.body.accessToken}`)
      .set('Idempotency-Key', 'lg-cred-1')
      .send({ carrier: 'correios', apiKey: 'secret-key-123', token: 'secret-key-123' });
    expect(res.status).toBe(201);
    expect(res.body.hasCredentials).toBe(true);
    expect(res.body.configured).toBe(true);
    expect(res.body.apiKey).toBeUndefined();
    expect(res.body.token).toBeUndefined();
    expect(res.body.encryptedPayload).toBeUndefined();
  });

  /*
    ESTE CASO COBRAVA O DEFEITO (GAP-PRD-120): um corpo sem pedido —
    storeId, carrier e um quoteId inventado — tinha de virar um envio
    'quoted'. Envio agora é de UM pedido, e a rota recusa o corpo solto sem
    gravar nada. O fluxo inteiro (etiqueta, rastreio, despacho) está em
    envio-etiqueta-rastreio.test.ts.
  */
  it('envio sem pedido é recusado — a rota não grava corpo solto', async () => {
    const app = createApp();
    const login = await loginForTest(app, {
      userId: 'user-1',
      companyId: 'company-1',
      profileCodes: ['admin_geral'],
    });
    const res = await request(app)
      .post('/api/v1/logistics/shipments')
      .set('Authorization', `Bearer ${login.body.accessToken}`)
      .set('Idempotency-Key', 'lg-ship-1')
      .send({ storeId: 'store-1', carrier: 'correios', quoteId: 'qt-1' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('LOGISTICS_ORDER_REQUIRED');
    const lista = await request(app)
      .get('/api/v1/logistics/shipments')
      .set('Authorization', `Bearer ${login.body.accessToken}`);
    expect(lista.body.items).toEqual([]);
  });
});
