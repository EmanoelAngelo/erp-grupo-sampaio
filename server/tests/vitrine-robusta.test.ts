/**
 * VITRINE ROBUSTA — rodada 39.
 *
 * A auditoria mediu quatro coisas que faziam a loja parecer amadora:
 *
 *   - o "Destacar" do gestor era gravado e a vitrine NUNCA o lia;
 *   - um produto com grade (tamanho/cor) virava N cards, e o card do
 *     produto-modelo dizia "Indisponível" porque o estoque está nas variantes;
 *   - a busca não achava "acucar" quando o produto é "Açúcar";
 *   - a vitrine cortava em 60 e não havia próxima página nem total.
 *
 * Cada bloco cobra um desses.
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

async function publicar(nome: string, precoCents: number, qty: number, category = 'Geral'): Promise<string> {
  const r = await request(app)
    .post('/api/v1/core/products')
    .set(auth)
    .send({ name: nome, priceCents: precoCents, category, publishOnline: true });
  expect(r.status).toBe(201);
  if (qty > 0) {
    await request(app).post('/api/v1/core/stock/movements').set(auth).send({
      productId: r.body.id,
      movementType: 'in',
      quantity: qty,
      referenceType: 'entrada',
      referenceId: `nf-${nome}-${(n += 1)}`,
    });
  }
  return r.body.id as string;
}

function destacar(productId: string) {
  getConnection().prepare('UPDATE core_products SET featured_online = 1 WHERE id = ?').run(productId);
}

/** Cria um produto-modelo publicado com variantes, cada uma com estoque. */
function modeloComVariantes(nomeModelo: string, variantes: { attr: string; preco: number; qty: number }[]): string {
  const db = getConnection();
  const empresa = db.prepare("SELECT id FROM core_companies WHERE slug = 'gringa'").get() as { id: string };
  const agora = new Date().toISOString();
  const modeloId = `mod-${(n += 1)}`;
  db.prepare(
    `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents, price_cents,
                                active, publish_online, kind, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'UN', 0, ?, 1, 1, 'product', ?, ?)`,
  ).run(modeloId, empresa.id, `MOD-${n}`, nomeModelo, variantes[0].preco, agora, agora);
  variantes.forEach((v, i) => {
    const vid = `${modeloId}-v${i}`;
    db.prepare(
      `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents, price_cents,
                                  active, publish_online, kind, parent_id, variant_attributes, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'UN', 0, ?, 1, 1, 'product', ?, ?, ?, ?)`,
    ).run(vid, empresa.id, `MOD-${n}-${i}`, `${nomeModelo} ${v.attr}`, v.preco, modeloId, JSON.stringify({ opcao: v.attr }), agora, agora);
    db.prepare(
      'INSERT INTO core_stock (company_id, product_id, quantity, reserved, updated_at) VALUES (?, ?, ?, 0, ?)',
    ).run(empresa.id, vid, v.qty, agora);
  });
  return modeloId;
}

async function vitrine(query = ''): Promise<{ status: number; items: Record<string, unknown>[]; total: number }> {
  const r = await request(app).get(`/api/v1/loja/products${query}`);
  return { status: r.status, items: r.body.items ?? [], total: r.body.total ?? r.body.items?.length ?? 0 };
}

beforeEach(async () => {
  resetDbForTests();
  n = 0;
  const login = await loginForTest(app, { userId: 'ger', companyId: 'gringa', profileCodes: ['gerente_loja'] });
  auth = { Authorization: `Bearer ${login.body.accessToken}` };
});

describe('destaque do gestor vale na vitrine', () => {
  it('produto destacado vem antes dos outros por padrão', async () => {
    await publicar('Camiseta Comum', 5000, 3);
    const destaque = await publicar('Tênis Destaque', 9000, 3);
    destacar(destaque);

    const { items } = await vitrine();
    expect(items[0].id).toBe(destaque);
    expect(items[0].featured).toBe(true);
  });

  it('há um caminho para pedir só os destaques', async () => {
    await publicar('Comum', 5000, 3);
    const d = await publicar('Destacado', 9000, 3);
    destacar(d);

    const r = await request(app).get('/api/v1/loja/destaques');
    expect(r.status).toBe(200);
    expect(r.body.items.length).toBe(1);
    expect(r.body.items[0].id).toBe(d);
  });
});

describe('grade num card só', () => {
  it('um produto-modelo com 3 variantes aparece como UM card, não quatro', async () => {
    await publicar('Solto', 5000, 2);
    modeloComVariantes('Camisa Polo', [
      { attr: 'P', preco: 8000, qty: 1 },
      { attr: 'M', preco: 8000, qty: 2 },
      { attr: 'G', preco: 9000, qty: 0 },
    ]);

    const { items } = await vitrine();
    // Solto + o modelo = 2 cards. As variantes NÃO viram cards próprios.
    expect(items.length).toBe(2);
    const modelo = items.find((i) => i.name === 'Camisa Polo')!;
    expect(modelo).toBeDefined();
    // Disponível é a SOMA das variantes (1+2+0 = 3), não o estoque do modelo (0).
    expect(modelo.available).toBe(3);
    // O card diz "a partir de" o menor preço das variantes.
    expect(modelo.fromPriceCents ?? modelo.priceCents).toBe(8000);
    expect(modelo.hasVariants).toBe(true);
  });

  it('modelo com todas as variantes zeradas aparece como indisponível, mas ainda UM card', async () => {
    modeloComVariantes('Bota', [
      { attr: '38', preco: 12000, qty: 0 },
      { attr: '39', preco: 12000, qty: 0 },
    ]);
    const { items } = await vitrine();
    expect(items.length).toBe(1);
    expect(items[0].available).toBe(0);
  });
});

describe('busca sem acento', () => {
  it('"acucar" encontra "Açúcar"; "cafe" encontra "Café"', async () => {
    await publicar('Açúcar Cristal', 500, 10);
    await publicar('Café Torrado', 1500, 10);
    await publicar('Sabão em Pó', 800, 10);

    const acucar = await vitrine('?q=acucar');
    expect(acucar.items.map((i) => i.name)).toEqual(['Açúcar Cristal']);

    const cafe = await vitrine('?q=CAFE');
    expect(cafe.items.map((i) => i.name)).toEqual(['Café Torrado']);
  });

  it('sem acento na busca acha o produto acentuado, e vice-versa', async () => {
    await publicar('Pão de Mel', 700, 5);
    const comAcento = await vitrine('?q=Pão');
    const semAcento = await vitrine('?q=pao');
    expect(comAcento.items.length).toBe(1);
    expect(semAcento.items.length).toBe(1);
  });
});

describe('paginação', () => {
  it('respeita limit e offset, e devolve o total real', async () => {
    for (let i = 0; i < 7; i += 1) await publicar(`Produto ${String(i).padStart(2, '0')}`, 1000 + i, 2);

    const pag1 = await vitrine('?limit=3&offset=0');
    expect(pag1.items.length).toBe(3);
    expect(pag1.total).toBe(7);

    const pag2 = await vitrine('?limit=3&offset=3');
    expect(pag2.items.length).toBe(3);
    expect(pag2.total).toBe(7);

    const pag3 = await vitrine('?limit=3&offset=6');
    expect(pag3.items.length).toBe(1);

    // Sem sobreposição entre as páginas.
    const ids = new Set([...pag1.items, ...pag2.items, ...pag3.items].map((i) => i.id));
    expect(ids.size).toBe(7);
  });
});
