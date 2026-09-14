/**
 * PRAZO DE ENTREGA É UM NÚMERO INTEIRO DE DIAS, ZERO OU MAIS (GAP-PRD-195).
 *
 * O DEFEITO: `PUT /core/shipping-settings` conferia só os valores em
 * dinheiro. `estimatedDays: -3` era gravado com 200, e a loja perdia o selo de
 * prazo sem aviso (a vitrine e o portal tratam <= 0 como "sem prazo"). Meio
 * dia (2,5) também passava — prazo de transportadora é contado em dias úteis
 * inteiros.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();
let auth: { Authorization: string };

const BASE = { pickupEnabled: true, deliveryEnabled: true, flatRateCents: 1000 };

beforeEach(async () => {
  resetDbForTests();
  const login = await loginForTest(app, {
    userId: 'ger-gringa',
    companyId: 'gringa',
    profileCodes: ['gerente_loja'],
  });
  auth = { Authorization: `Bearer ${login.body.accessToken}` };
});

describe('o servidor recusa prazo que não é prazo', () => {
  it('negativo, fracionado, texto e absurdo: 400, e nada é gravado', async () => {
    const antes = await request(app)
      .put('/api/v1/core/shipping-settings')
      .set(auth)
      .send({ ...BASE, estimatedDays: 4 });
    expect(antes.status).toBe(200);

    for (const errado of [-3, -1, 2.5, '3', 'amanhã', 366, Number.MAX_SAFE_INTEGER, true]) {
      const res = await request(app)
        .put('/api/v1/core/shipping-settings')
        .set(auth)
        .send({ ...BASE, estimatedDays: errado });
      expect(res.status, `estimatedDays=${String(errado)}`).toBe(400);
      expect(res.body.error.code).toBe('SHIPPING_INVALID_DAYS');
      expect(res.body.error.message).toMatch(/dias úteis/);
    }

    const depois = await request(app).get('/api/v1/core/shipping-settings').set(auth);
    expect(depois.body.estimatedDays).toBe(4);
  });

  it('zero, inteiros e vazio continuam aceitos', async () => {
    for (const certo of [0, 1, 7, 365, null]) {
      const res = await request(app)
        .put('/api/v1/core/shipping-settings')
        .set(auth)
        .send({ ...BASE, estimatedDays: certo });
      expect(res.status, `estimatedDays=${String(certo)}`).toBe(200);
      expect(res.body.estimatedDays).toBe(certo);
    }
  });
});
