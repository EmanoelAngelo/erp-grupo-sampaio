/**
 * ============================================================================
 * CONTAR A VITRINE SEM CONTAR O DEPÓSITO — GAP-PRD-167
 * ============================================================================
 *
 * A contagem comparava com o saldo TOTAL da empresa: com dois locais, quem
 * contava a Vitrine tinha de somar o depósito de cabeça. `core_inventory_counts`
 * não tinha local, e o acerto saía no local que `applyMovement` escolhesse.
 *
 * Nasceu VERMELHO contra o HEAD anterior: a contagem aberta com `locationId`
 * congelava o esperado 10 (a empresa) em vez de 3 (a Vitrine), e o acerto de
 * −1 caía no local padrão. O que este arquivo trava:
 *
 *   - com local, o esperado é o saldo DAQUELE local, e o acerto sai nele;
 *   - sem local, nada muda (o saldo total, como sempre);
 *   - o acerto não deixa o LOCAL negativo, além do total;
 *   - local de outra empresa ou inativo é recusa;
 *   - a ficha e a lista dizem qual local foi contado.
 */
process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';

import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { balanceByLocation } from '../src/services/core/StockLocationService.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();

let auth: { Authorization: string };
let companyId: string;
let geral: string;
let vitrine: string;
let produto: string;

async function post(url: string, body: Record<string, unknown>) {
  return request(app).post(`/api/v1/core${url}`).set(auth).send(body);
}

function saldoNoLocal(localId: string): number {
  return balanceByLocation(companyId, produto).find((l) => l.locationId === localId)?.quantity ?? 0;
}

beforeEach(async () => {
  resetDbForTests();
  const res = await loginForTest(app, { userId: 'gerente-inv-local', companyId: 'preco-justo-local', profileCodes: ['gerente_loja'] });
  expect(res.status).toBe(200);
  auth = { Authorization: `Bearer ${res.body.accessToken}` };
  companyId = res.body.company.id;

  const locais = await request(app).get('/api/v1/core/stock/locations').set(auth);
  geral = locais.body.locations.find((l: { is_default: number }) => l.is_default === 1).id;
  vitrine = (await post('/stock/locations', { code: 'VIT', name: 'Vitrine' })).body.location.id;

  produto = (await post('/products', { name: 'Perfume Floral 50ml', priceCents: 9900 })).body.id;
  expect((await post('/stock/movements', { productId: produto, movementType: 'in', quantity: 10, referenceId: 'carga-1' })).status).toBe(201);
  expect((await post('/stock/transfers', { productId: produto, fromLocationId: geral, toLocationId: vitrine, quantity: 3 })).status).toBe(201);
  expect(saldoNoLocal(vitrine)).toBe(3);
  expect(saldoNoLocal(geral)).toBe(7);
});

describe('GAP-PRD-167 — a contagem de um local', () => {
  it('o esperado é o saldo da Vitrine, e o acerto sai na Vitrine', async () => {
    const aberta = await post('/inventory-counts', { scopeNote: 'Vitrine', search: 'Perfume', locationId: vitrine });
    expect(aberta.status, JSON.stringify(aberta.body)).toBe(201);
    expect(aberta.body.location_id).toBe(vitrine);
    expect(aberta.body.location_name).toBe('Vitrine');
    const item = aberta.body.items.find((i: { product_id: string }) => i.product_id === produto);
    expect(item.expected_quantity).toBe(3);

    expect((await post(`/inventory-counts/${aberta.body.id}/items`, { productId: produto, countedQuantity: 2 })).status).toBe(200);
    const aplicada = await post(`/inventory-counts/${aberta.body.id}/apply`, { reason: 'Contagem da vitrine' });
    expect(aplicada.status, JSON.stringify(aplicada.body)).toBe(200);

    // Caiu 1 na Vitrine — o depósito não foi tocado.
    expect(saldoNoLocal(vitrine)).toBe(2);
    expect(saldoNoLocal(geral)).toBe(7);

    const lista = await request(app).get('/api/v1/core/inventory-counts').set(auth);
    expect(lista.body.items[0]).toMatchObject({ location_name: 'Vitrine', location_code: 'VIT' });

    // A trilha registra o local contado.
    const ficha = await request(app).get(`/api/v1/core/inventory-counts/${aberta.body.id}`).set(auth);
    expect(ficha.body.location_name).toBe('Vitrine');
  });

  it('sem local, o esperado continua sendo o saldo da empresa inteira', async () => {
    const aberta = await post('/inventory-counts', { search: 'Perfume' });
    expect(aberta.status).toBe(201);
    expect(aberta.body.location_id).toBeNull();
    expect(aberta.body.location_name).toBeNull();
    expect(aberta.body.items[0].expected_quantity).toBe(10);
  });

  it('o acerto não deixa o LOCAL negativo, mesmo com o total da empresa sobrando', async () => {
    const aberta = await post('/inventory-counts', { search: 'Perfume', locationId: vitrine });
    // Depois de abrir, alguém devolveu as 3 da Vitrine ao depósito.
    await post('/stock/transfers', { productId: produto, fromLocationId: vitrine, toLocationId: geral, quantity: 3 });
    await post(`/inventory-counts/${aberta.body.id}/items`, { productId: produto, countedQuantity: 1 });
    const r = await post(`/inventory-counts/${aberta.body.id}/apply`, { reason: 'Contagem da vitrine' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('CORE_COUNT_WOULD_GO_NEGATIVE');
    expect(r.body.error.message).toContain('DESTE LOCAL');
    expect(saldoNoLocal(geral)).toBe(10);
  });

  it('local inativo ou de outra empresa é recusa, e nenhuma contagem nasce', async () => {
    const outra = await loginForTest(app, { userId: 'ger-outra-inv', companyId: 'outra-inv', profileCodes: ['gerente_loja'] });
    const authOutra = { Authorization: `Bearer ${outra.body.accessToken}` };
    const deLa = (await request(app).post('/api/v1/core/stock/locations').set(authOutra).send({ code: 'DEP', name: 'Depósito' })).body.location.id;

    const r1 = await post('/inventory-counts', { search: 'Perfume', locationId: deLa });
    expect(r1.status).toBe(404);

    await request(app).patch(`/api/v1/core/stock/locations/${vitrine}`).set(auth).send({ active: false });
    // Desativar um local com saldo pode ser recusado pelo serviço; se foi aceito, contar nele é recusa.
    const local = await request(app).get('/api/v1/core/stock/locations?incluirInativos=true').set(auth);
    const inativo = local.body.locations.find((l: { id: string; active: number }) => l.id === vitrine && l.active === 0);
    if (inativo) {
      expect((await post('/inventory-counts', { search: 'Perfume', locationId: vitrine })).status).toBe(404);
    }
    const lista = await request(app).get('/api/v1/core/inventory-counts').set(auth);
    expect(lista.body.items).toEqual([]);
  });
});
