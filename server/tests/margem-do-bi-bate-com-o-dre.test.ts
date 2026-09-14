/**
 * UMA RÉGUA DE CUSTO: A MARGEM DO BI E O CMV DO DRE CONCORDAM (GAP-PRD-086).
 *
 * ============================================================================
 * O DEFEITO
 * ============================================================================
 *
 * O DRE calcula o CMV com o custo FOTOGRAFADO na venda
 * (`core_sale_items.cost_cents`). O cartão de margem do BI
 * (`GroupInsights.marginWhereReliable`) multiplicava a quantidade vendida pelo
 * custo ATUAL do cadastro (`core_products.cost_cents`). A mesma venda dava
 * duas margens:
 *
 *   venda de 2 un. com custo 8.000 fotografado; depois o cadastro passa a
 *   custar 12.000 → BI: custo 24.000, margem 40%; DRE: custo 16.000, margem
 *   60%.
 *
 * A margem de março mudava quando entrava a nota de agosto, e o gestor lia 40%
 * numa tela e 60% na outra para as mesmas vendas.
 *
 * ============================================================================
 * O CONSERTO
 * ============================================================================
 *
 * O BI passa a somar o snapshot, com as MESMAS três populações do DRE:
 * `cost_cents > 0` entra; `= 0` (produto vendido sem custo no cadastro) fica
 * fora e é contado em `skippedNoCost`; `IS NULL` (venda anterior ao snapshot,
 * ou linha de serviço) fica fora e é contado em `skippedBeforeSnapshot`.
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { linkUserToCompany, upsertCompany, upsertUser } from '../src/services/auth/IdentityService.js';

const app = createApp();
const SENHA = 'Margem@UmaRegua2026';

/** 15:00Z é meio-dia na loja (UTC-3): longe de qualquer borda de dia. */
const DIA = '2026-03-10';
const MEIO_DIA = '2026-03-10T15:00:00.000Z';

let empresa: string;
let auth: { Authorization: string };

beforeEach(async () => {
  resetDbForTests();
  empresa = upsertCompany({
    slug: 'gringa',
    legalName: 'Gringa Ltda',
    tradeName: 'Gringa',
    kind: 'retail',
  });
  const login = 'GERENTE.MARGEM';
  const userId = await upsertUser({ login, displayName: login, password: SENHA });
  linkUserToCompany(userId, empresa, 'gerente_loja', true);
  const res = await request(app).post('/api/v1/auth/login').send({ login, password: SENHA, companyId: empresa });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  auth = { Authorization: `Bearer ${res.body.accessToken}` };
});

async function produto(nome: string, preco: number, custo: number): Promise<string> {
  const p = await request(app).post('/api/v1/core/products').set(auth).send({ name: nome, priceCents: preco, costCents: custo });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  const carga = await request(app).post('/api/v1/core/stock/movements').set(auth).send({
    productId: p.body.id,
    movementType: 'in',
    quantity: 50,
    referenceType: 'entrada',
    referenceId: `carga-${p.body.id}`,
  });
  expect(carga.status, JSON.stringify(carga.body)).toBe(201);
  return p.body.id as string;
}

async function vender(productId: string, quantidade: number, total: number): Promise<string> {
  const res = await request(app)
    .post('/api/v1/core/sales')
    .set(auth)
    .set('Idempotency-Key', randomUUID())
    .send({ items: [{ productId, quantity: quantidade }], payments: [{ method: 'dinheiro', amountCents: total }] });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const id = (res.body.sale ?? res.body).id as string;
  getConnection().prepare('UPDATE core_sales SET created_at = ? WHERE id = ?').run(MEIO_DIA, id);
  return id;
}

async function margemDoBi() {
  const res = await request(app).get(`/api/v1/core/insights/margin?from=${DIA}&to=${DIA}`).set(auth);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as {
    consideredItems: number;
    skippedNoCost: number;
    skippedBeforeSnapshot: number;
    revenueCents: number;
    costCents: number;
    marginCents: number;
    marginPercent: number | null;
  };
}

async function cmvDoDre() {
  const res = await request(app).get(`/api/v1/core/finance/income-statement?from=${DIA}&to=${DIA}`).set(auth);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.cogs as {
    costCents: number;
    revenueCents: number;
    marginCents: number;
    marginPercent: number | null;
    itemsWithCost: number;
    itemsWithoutCost: number;
    itemsBeforeSnapshot: number;
  };
}

describe('GAP-PRD-086 — o BI e o DRE medem a margem com o mesmo custo', () => {
  it('A MORDIDA: o custo do cadastro sobe depois da venda, e as duas telas continuam em 60%', async () => {
    const bike = await produto('Bicicleta Aro 29', 20_000, 8_000);
    await vender(bike, 2, 40_000);

    // A nota de agosto encarece o produto. O passado não muda por isso.
    const alterou = await request(app).put(`/api/v1/core/products/${bike}`).set(auth).send({ costCents: 12_000 });
    expect(alterou.status, JSON.stringify(alterou.body)).toBe(200);

    const bi = await margemDoBi();
    const dre = await cmvDoDre();

    expect(dre.costCents).toBe(16_000);
    expect(dre.marginPercent).toBe(60);
    // Antes: custo 24.000 e 40% — o custo de hoje sobre a venda de março.
    expect(bi.costCents).toBe(16_000);
    expect(bi.marginPercent).toBe(60);
  });

  it('as três populações são as mesmas nas duas telas, contadas do mesmo jeito', async () => {
    const comCusto = await produto('Com custo', 10_000, 6_000);
    const semCusto = await produto('Sem custo', 5_000, 0);
    await vender(comCusto, 1, 10_000);
    await vender(semCusto, 1, 5_000);
    const antiga = await vender(comCusto, 1, 10_000);
    // A venda anterior ao snapshot: a linha sem custo gravado.
    getConnection().prepare('UPDATE core_sale_items SET cost_cents = NULL WHERE sale_id = ?').run(antiga);

    const bi = await margemDoBi();
    const dre = await cmvDoDre();

    expect(bi.consideredItems).toBe(dre.itemsWithCost);
    expect(bi.skippedNoCost).toBe(dre.itemsWithoutCost);
    expect(bi.skippedBeforeSnapshot).toBe(dre.itemsBeforeSnapshot);
    expect(bi.revenueCents).toBe(dre.revenueCents);
    expect(bi.costCents).toBe(dre.costCents);
    expect(bi.marginCents).toBe(dre.marginCents);
    expect(bi.marginPercent).toBe(dre.marginPercent);

    expect(bi.consideredItems).toBe(1);
    expect(bi.skippedNoCost).toBe(1);
    expect(bi.skippedBeforeSnapshot).toBe(1);
    expect(bi.marginPercent).toBe(40);
  });

  it('linha antiga SEM retrato não herda o custo de hoje do cadastro', async () => {
    const bike = await produto('Bicicleta Aro 29', 10_000, 6_000);
    const antiga = await vender(bike, 1, 10_000);
    getConnection().prepare('UPDATE core_sale_items SET cost_cents = NULL WHERE sale_id = ?').run(antiga);

    const bi = await margemDoBi();
    // Usar o cadastro inventaria um custo que ninguém fotografou.
    expect(bi.consideredItems).toBe(0);
    expect(bi.skippedBeforeSnapshot).toBe(1);
    expect(bi.marginPercent).toBeNull();
  });
});
