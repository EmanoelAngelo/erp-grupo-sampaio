/**
 * A HOME DO GRUPO — rodada 41.
 *
 * A entrada da loja vira um portal: as lojas com capa e chamada, os destaques
 * do grupo, e as OFERTAS — o que está em promoção agora, entre todas as lojas.
 * Tudo vem do que o gestor já controla no painel (capa/logo, "Destacar",
 * promoções); a home só REFLETE, não tem lista própria para divergir.
 *
 * O bloco de ofertas cobra o novo caminho `onlyOnSale`: só produto com
 * promoção VIGENTE entra — promoção vencida ou futura não é oferta.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();
let auth: { Authorization: string };
let n = 0;

async function publicar(nome: string, precoCents: number): Promise<string> {
  const r = await request(app)
    .post('/api/v1/core/products')
    .set(auth)
    .send({ name: nome, priceCents: precoCents, category: 'Geral', publishOnline: true });
  await request(app).post('/api/v1/core/stock/movements').set(auth).send({
    productId: r.body.id,
    movementType: 'in',
    quantity: 5,
    referenceType: 'entrada',
    referenceId: `nf-${(n += 1)}`,
  });
  return r.body.id as string;
}

function promocao(productId: string, precoCents: number, opts: { vencida?: boolean; futura?: boolean } = {}) {
  const db = getConnection();
  const empresa = db.prepare("SELECT id FROM core_companies WHERE slug = 'gringa'").get() as { id: string };
  const agora = Date.now();
  const inicio = opts.futura ? new Date(agora + 3600_000) : new Date(agora - 3600_000);
  const fim = opts.vencida ? new Date(agora - 60_000) : opts.futura ? null : null;
  db.prepare(
    `INSERT INTO core_promotions (id, company_id, product_id, price_cents, starts_at, ends_at, active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
  ).run(
    `promo-${(n += 1)}`,
    empresa.id,
    productId,
    precoCents,
    inicio.toISOString(),
    fim ? fim.toISOString() : null,
    new Date().toISOString(),
  );
}

beforeEach(async () => {
  resetDbForTests();
  n = 0;
  const login = await loginForTest(app, { userId: 'ger', companyId: 'gringa', profileCodes: ['gerente_loja'] });
  auth = { Authorization: `Bearer ${login.body.accessToken}` };
});

describe('as ofertas do grupo', () => {
  it('devolve só o que está em promoção VIGENTE', async () => {
    const comum = await publicar('Sem Promoção', 10000);
    const oferta = await publicar('Em Oferta', 20000);
    promocao(oferta, 15000);

    const r = await request(app).get('/api/v1/loja/ofertas');
    expect(r.status).toBe(200);
    const nomes = r.body.items.map((i: { name: string }) => i.name);
    expect(nomes).toContain('Em Oferta');
    expect(nomes).not.toContain('Sem Promoção');
    const item = r.body.items.find((i: { id: string }) => i.id === oferta)!;
    expect(item.onSale).toBe(true);
    expect(item.priceCents).toBe(15000);
    expect(item.basePriceCents).toBe(20000);
    void comum;
  });

  it('promoção vencida não é oferta', async () => {
    const p = await publicar('Promo Vencida', 20000);
    promocao(p, 15000, { vencida: true });
    const r = await request(app).get('/api/v1/loja/ofertas');
    expect(r.body.items.map((i: { name: string }) => i.name)).not.toContain('Promo Vencida');
  });

  it('promoção que ainda não começou não é oferta', async () => {
    const p = await publicar('Promo Futura', 20000);
    promocao(p, 15000, { futura: true });
    const r = await request(app).get('/api/v1/loja/ofertas');
    expect(r.body.items.map((i: { name: string }) => i.name)).not.toContain('Promo Futura');
  });
});
