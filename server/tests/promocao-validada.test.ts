/**
 * A PROMOÇÃO É CONFERIDA PELO SERVIDOR — GAP-PRD-032, GAP-PRD-033, GAP-PRD-197.
 *
 * O que a auditoria mediu (harness b8), com `POST /core/promotions`:
 *
 *   - `{priceCents: -500}` → 201, e o preço vigente continuava o de cadastro
 *     (a promoção ficava listada como ativa e não valia nada);
 *   - `{percentOff: 150}` → 201, ignorada do mesmo jeito;
 *   - `{percentOff: 100}` → 201, e o produto saía por R$ 0,00 na vitrine e no
 *     balcão — um erro de digitação dava o estoque de graça nos dois canais;
 *   - fim antes do início → 201, uma promoção que nunca vale;
 *   - `productId` com o CÓDIGO do cadastro (o que a tela pedia: "Código do
 *     produto") → 500 "Erro interno", com FOREIGN KEY no log;
 *   - `productId` de OUTRA empresa → 201, linha morta apontando para o
 *     cadastro alheio.
 *
 * O contrato agora: o alvo é UM produto desta empresa (achado pelo id, pelo
 * código interno ou pelo código de barras) OU uma categoria que existe; o
 * desconto é UM preço fixo menor que o de cadastro OU um percentual entre 0 e
 * 100; o grátis (100 % ou preço zero) exige confirmação explícita; e o fim não
 * vem antes do início. Promoção antiga que viola a regra não vale no preço e
 * aparece na lista com o problema escrito.
 */
process.env.TZ = 'UTC';

import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { effectivePriceCents } from '../src/services/core/PricingService.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();
const PRECO = 10000;

let gerente: { Authorization: string };
let gringa: string;
let gerentePj: { Authorization: string };
let pj: string;

function produto(
  companyId: string,
  opcoes: { codigo: string; barras?: string; categoria?: string | null; pai?: string } ,
): string {
  const id = randomUUID();
  const agora = new Date().toISOString();
  getConnection()
    .prepare(
      `INSERT INTO core_products (id, company_id, internal_code, barcode, name, unit, cost_cents,
                                  price_cents, category, parent_id, active, publish_online,
                                  created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'UN', 4000, ?, ?, ?, 1, 1, ?, ?)`,
    )
    .run(
      id,
      companyId,
      opcoes.codigo,
      opcoes.barras ?? null,
      `Produto ${opcoes.codigo}`,
      PRECO,
      opcoes.categoria === undefined ? 'Vestuário' : opcoes.categoria,
      opcoes.pai ?? null,
      agora,
      agora,
    );
  return id;
}

function criar(corpo: Record<string, unknown>, quem = gerente) {
  return request(app).post('/api/v1/core/promotions').set(quem).send(corpo);
}

function promocoesGravadas(companyId: string): Record<string, unknown>[] {
  return getConnection()
    .prepare('SELECT * FROM core_promotions WHERE company_id = ?')
    .all(companyId) as Record<string, unknown>[];
}

function precoVigente(companyId: string, productId: string, categoria: string | null = 'Vestuário') {
  return effectivePriceCents(companyId, productId, PRECO, categoria).priceCents;
}

/** Linha gravada por fora da API — o legado que a regra nova não pode deixar valer. */
function legado(companyId: string, campos: Record<string, unknown>): string {
  const id = randomUUID();
  getConnection()
    .prepare(
      `INSERT INTO core_promotions
         (id, company_id, product_id, category, price_cents, percent_off,
          starts_at, ends_at, active, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'legado', ?)`,
    )
    .run(
      id,
      companyId,
      (campos.product_id as string | null) ?? null,
      (campos.category as string | null) ?? null,
      (campos.price_cents as number | null) ?? null,
      (campos.percent_off as number | null) ?? null,
      (campos.starts_at as string) ?? new Date(Date.now() - 3600_000).toISOString(),
      (campos.ends_at as string | null) ?? null,
      new Date().toISOString(),
    );
  return id;
}

beforeEach(async () => {
  resetDbForTests();
  const res = await loginForTest(app, {
    userId: 'gerente-promo',
    companyId: 'gringa-promo',
    profileCodes: ['gerente_loja'],
  });
  gerente = { Authorization: `Bearer ${res.body.accessToken}` };
  gringa = res.body.company.id;
  const resPj = await loginForTest(app, {
    userId: 'gerente-pj',
    companyId: 'pj-promo',
    profileCodes: ['gerente_loja'],
  });
  gerentePj = { Authorization: `Bearer ${resPj.body.accessToken}` };
  pj = resPj.body.company.id;
});

describe('GAP-PRD-032 — valores que o servidor recusa', () => {
  it('preço negativo → 400, e nada é gravado', async () => {
    const item = produto(gringa, { codigo: 'B8-1' });
    const res = await criar({ productId: item, priceCents: -500 });
    expect(res.status).toBe(400);
    expect(res.body.error?.code ?? res.body.code).toBe('CORE_INVALID_PROMOTION');
    expect(promocoesGravadas(gringa)).toHaveLength(0);
  });

  it('percentual acima de 100 → 400', async () => {
    produto(gringa, { codigo: 'B8-1' });
    const res = await criar({ category: 'Vestuário', percentOff: 150 });
    expect(res.status).toBe(400);
    expect(promocoesGravadas(gringa)).toHaveLength(0);
  });

  it('percentual zero ou negativo → 400', async () => {
    produto(gringa, { codigo: 'B8-1' });
    expect((await criar({ category: 'Vestuário', percentOff: 0 })).status).toBe(400);
    expect((await criar({ category: 'Vestuário', percentOff: -10 })).status).toBe(400);
    expect(promocoesGravadas(gringa)).toHaveLength(0);
  });

  it('valor que não é número → 400 (e não NaN gravado)', async () => {
    produto(gringa, { codigo: 'B8-1' });
    expect((await criar({ category: 'Vestuário', percentOff: 'dez' })).status).toBe(400);
    expect((await criar({ category: 'Vestuário', priceCents: 12.5 })).status).toBe(400);
    expect(promocoesGravadas(gringa)).toHaveLength(0);
  });

  it('100 % sem confirmação → 400 nomeando o grátis; o produto NÃO fica de graça', async () => {
    const item = produto(gringa, { codigo: 'B8-1' });
    const res = await criar({ productId: item, percentOff: 100 });
    expect(res.status).toBe(400);
    expect(res.body.error?.code ?? res.body.code).toBe('CORE_PROMOTION_FREE_UNCONFIRMED');
    expect(precoVigente(gringa, item)).toBe(PRECO);
  });

  it('preço zero sem confirmação → 400', async () => {
    const item = produto(gringa, { codigo: 'B8-1' });
    const res = await criar({ productId: item, priceCents: 0 });
    expect(res.status).toBe(400);
    expect(res.body.error?.code ?? res.body.code).toBe('CORE_PROMOTION_FREE_UNCONFIRMED');
  });

  it('100 % COM confirmação explícita → 201, e aí sim o preço é zero', async () => {
    const item = produto(gringa, { codigo: 'B8-1' });
    const res = await criar({ productId: item, percentOff: 100, confirmarGratis: true });
    expect(res.status).toBe(201);
    expect(precoVigente(gringa, item)).toBe(0);
  });

  it('preço fixo que não é menor que o de cadastro → 400 (a promoção nunca valeria)', async () => {
    const item = produto(gringa, { codigo: 'B8-1' });
    const res = await criar({ productId: item, priceCents: PRECO });
    expect(res.status).toBe(400);
    expect(res.body.error?.code ?? res.body.code).toBe('CORE_PROMOTION_NOT_A_DISCOUNT');
  });

  it('preço fixo E percentual juntos → 400 (qual dos dois valeria?)', async () => {
    const item = produto(gringa, { codigo: 'B8-1' });
    const res = await criar({ productId: item, priceCents: 5000, percentOff: 10 });
    expect(res.status).toBe(400);
  });

  it('fim antes do início → 400 CORE_PROMOTION_PERIOD', async () => {
    produto(gringa, { codigo: 'B8-1' });
    const res = await criar({
      category: 'Vestuário',
      percentOff: 10,
      startsAt: '2026-12-31',
      endsAt: '2026-01-01',
    });
    expect(res.status).toBe(400);
    expect(res.body.error?.code ?? res.body.code).toBe('CORE_PROMOTION_PERIOD');
  });

  it('data que não é data → 400', async () => {
    produto(gringa, { codigo: 'B8-1' });
    const res = await criar({ category: 'Vestuário', percentOff: 10, endsAt: 'amanhã' });
    expect(res.status).toBe(400);
  });

  it('sem alvo → 400; produto E categoria juntos → 400', async () => {
    const item = produto(gringa, { codigo: 'B8-1' });
    expect((await criar({ percentOff: 10 })).status).toBe(400);
    expect((await criar({ productId: item, category: 'Vestuário', percentOff: 10 })).status).toBe(
      400,
    );
    expect(promocoesGravadas(gringa)).toHaveLength(0);
  });

  it('categoria sem produto nenhum → 400; a grafia diferente é normalizada para a do cadastro', async () => {
    const item = produto(gringa, { codigo: 'B8-1' });
    const vazia = await criar({ category: 'Brinquedos', percentOff: 10 });
    expect(vazia.status).toBe(400);
    expect(vazia.body.error?.code ?? vazia.body.code).toBe('CORE_PROMOTION_CATEGORY_EMPTY');

    const res = await criar({ category: '  vestuário ', percentOff: 10 });
    expect(res.status).toBe(201);
    expect(promocoesGravadas(gringa)[0].category).toBe('Vestuário');
    expect(precoVigente(gringa, item)).toBe(9000);
  });

  it('a promoção válida continua sendo criada e vale', async () => {
    const item = produto(gringa, { codigo: 'B8-1' });
    const res = await criar({ productId: item, priceCents: 8990 });
    expect(res.status).toBe(201);
    expect(precoVigente(gringa, item)).toBe(8990);
  });

  it('LEGADO inválido (gravado antes da regra) não vale no preço e aparece com o problema', async () => {
    const item = produto(gringa, { codigo: 'B8-1' });
    legado(gringa, { product_id: item, percent_off: 100 });
    legado(gringa, { product_id: item, price_cents: -500 });
    legado(gringa, {
      category: 'Vestuário',
      percent_off: 20,
      starts_at: new Date(Date.now() + 86_400_000).toISOString(),
      ends_at: new Date(Date.now() - 86_400_000).toISOString(),
    });

    // O 100 % legado, sem confirmação, NÃO dá o produto de graça.
    expect(precoVigente(gringa, item)).toBe(PRECO);

    const lista = await request(app).get('/api/v1/core/promotions').set(gerente);
    expect(lista.status).toBe(200);
    const problemas = (lista.body.items as { problemas: string[] }[]).map((p) => p.problemas);
    expect(problemas.every((p) => Array.isArray(p) && p.length > 0)).toBe(true);
  });
});

describe('GAP-PRD-033 — o produto é achado pelo código que a pessoa tem na mão', () => {
  it('código INTERNO do cadastro → 201, grava o id do produto e vale', async () => {
    const item = produto(gringa, { codigo: 'B8-1' });
    const res = await criar({ productId: 'B8-1', percentOff: 10 });
    expect(res.status).toBe(201);
    expect(promocoesGravadas(gringa)[0].product_id).toBe(item);
    expect(precoVigente(gringa, item)).toBe(9000);
  });

  it('código de BARRAS → 201', async () => {
    const item = produto(gringa, { codigo: 'B8-2', barras: '7891234567895' });
    const res = await criar({ productId: '7891234567895', percentOff: 10 });
    expect(res.status).toBe(201);
    expect(promocoesGravadas(gringa)[0].product_id).toBe(item);
  });

  it('código que não existe → 404 nomeando o código (e não 500 "Erro interno")', async () => {
    const res = await criar({ productId: 'NAO-EXISTE', percentOff: 10 });
    expect(res.status).toBe(404);
    expect(res.body.error?.code ?? res.body.code).toBe('CORE_PROMOTION_PRODUCT_NOT_FOUND');
    expect(JSON.stringify(res.body)).toContain('NAO-EXISTE');
  });

  it('modelo com grade → 400 (a variante é que é vendida; a promoção no modelo não valeria)', async () => {
    const modelo = produto(gringa, { codigo: 'GR-1' });
    produto(gringa, { codigo: 'GR-1-P', pai: modelo });
    const res = await criar({ productId: 'GR-1', percentOff: 10 });
    expect(res.status).toBe(400);
    expect(res.body.error?.code ?? res.body.code).toBe('CORE_PRODUCT_HAS_VARIANTS');
  });

  it('a lista diz QUAL produto, pelo nome e pelo código', async () => {
    produto(gringa, { codigo: 'B8-1' });
    await criar({ productId: 'B8-1', percentOff: 10 });
    const lista = await request(app).get('/api/v1/core/promotions').set(gerente);
    expect(lista.body.items[0]).toMatchObject({ product_name: 'Produto B8-1', product_code: 'B8-1' });
  });
});

describe('GAP-PRD-197 — produto de outra empresa não entra', () => {
  it('id do produto do PJ na promoção da Gringa → 404, nada gravado', async () => {
    const doPj = produto(pj, { codigo: 'PJ-1' });
    const res = await criar({ productId: doPj, percentOff: 10 });
    expect(res.status).toBe(404);
    expect(res.body.error?.code ?? res.body.code).toBe('CORE_PROMOTION_PRODUCT_NOT_FOUND');
    expect(promocoesGravadas(gringa)).toHaveLength(0);
  });

  it('código do produto do PJ também não acha nada na Gringa', async () => {
    produto(pj, { codigo: 'PJ-1' });
    const res = await criar({ productId: 'PJ-1', percentOff: 10 });
    expect(res.status).toBe(404);
  });

  it('o PJ cria a mesma promoção no PRÓPRIO produto normalmente', async () => {
    const doPj = produto(pj, { codigo: 'PJ-1' });
    const res = await criar({ productId: 'PJ-1', percentOff: 10 }, gerentePj);
    expect(res.status).toBe(201);
    expect(precoVigente(pj, doPj)).toBe(9000);
  });

  it('linha LEGADA com produto alheio aparece na lista com o problema escrito', async () => {
    const doPj = produto(pj, { codigo: 'PJ-1' });
    legado(gringa, { product_id: doPj, percent_off: 10 });
    const lista = await request(app).get('/api/v1/core/promotions').set(gerente);
    const [linha] = lista.body.items as { problemas: string[]; product_name: string | null }[];
    expect(linha.product_name).toBeNull();
    expect(linha.problemas.join(' ')).toMatch(/outra empresa|removido/);
  });
});
