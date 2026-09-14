/**
 * A VITRINE TEM TETO E NÃO REFAZ O CATÁLOGO A CADA VISITA (GAP-PRD-071).
 *
 * O N+1 já tinha sido resolvido (vitrine-nao-congela-o-balcao): a listagem faz
 * um punhado fixo de consultas. O que sobrou era o CUSTO por requisição
 * continuar proporcional ao catálogo — ler todos os produtos publicados,
 * decorar todos (promoção, grade, saldo) e só fatiar no fim — e a rota
 * aceitar qualquer `limit`. Medido pela auditoria: `?limit=100000` devolvia
 * os 3.000 itens (1 MB) de uma vez, numa rota pública, sem sessão, no mesmo
 * processo síncrono que atende o PDV.
 *
 * A REGRA:
 *   1. Página de no máximo 60 itens, na rota e no serviço. O `total` continua
 *      dizendo quantos há, para a tela numerar.
 *   2. O catálogo decorado de cada loja fica guardado e só é refeito quando
 *      QUALQUER coisa foi gravada no banco, quando o esquema mudou, ou quando o
 *      minuto virou (promoção com horário). Sem gravação nenhuma, uma rajada de
 *      visitas custa uma consulta de conferência por visita — e não o catálogo.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { getConnection } from '../src/db/sqlite.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import { applyMovement } from '../src/services/core/InventoryService.js';
import { listStorefrontProducts } from '../src/services/core/StorefrontService.js';

const app = createApp();
let loja: string;

function publicar(quantos: number, prefixo = 'Produto'): string[] {
  const db = getConnection();
  const agora = new Date().toISOString();
  const ids: string[] = [];
  for (let i = 0; i < quantos; i += 1) {
    const id = `vt-${prefixo}-${i}`;
    db.prepare(
      `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                  price_cents, category, active, publish_online, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'UN', 500, ?, 'Geral', 1, 1, ?, ?)`,
    ).run(id, loja, `VT-${prefixo}-${i}`, `${prefixo} ${String(i).padStart(3, '0')}`, 1_000 + i, agora, agora);
    db.prepare(
      'INSERT INTO core_stock (company_id, product_id, quantity, reserved, updated_at) VALUES (?, ?, 3, 0, ?)',
    ).run(loja, id, agora);
    ids.push(id);
  }
  return ids;
}

/** Quantas vezes a listagem foi ao banco — toda leitura passa por `prepare`. */
function consultas(fn: () => void): number {
  const conexao = getConnection() as unknown as { prepare: (sql: string) => unknown };
  const original = conexao.prepare.bind(conexao);
  let contador = 0;
  conexao.prepare = (sql: string) => {
    contador += 1;
    return original(sql);
  };
  try {
    fn();
  } finally {
    conexao.prepare = original;
  }
  return contador;
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  loja = await upsertCompany({ slug: 'gringa', legalName: 'Gringa Ltda', tradeName: 'Gringa' });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('teto da página', () => {
  it('limit gigante na rota pública devolve no máximo 60, com o total verdadeiro', async () => {
    publicar(75);
    const res = await request(app).get('/api/v1/loja/products?limit=100000');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(60);
    expect(res.body.total).toBe(75);

    const resto = await request(app).get('/api/v1/loja/products?limit=100000&offset=60');
    expect(resto.body.items).toHaveLength(15);
  });

  it('limit que não é número não vira o catálogo inteiro', async () => {
    publicar(70);
    for (const limite of ['abc', '-5', '1e9', 'Infinity']) {
      const res = await request(app).get(`/api/v1/loja/products?limit=${limite}`);
      expect(res.status).toBe(200);
      expect(res.body.items.length).toBeLessThanOrEqual(60);
    }
  });

  it('as ofertas também têm teto', async () => {
    const ids = publicar(70);
    const agora = new Date().toISOString();
    for (const id of ids) {
      getConnection()
        .prepare(
          `INSERT INTO core_promotions (id, company_id, product_id, price_cents, active, starts_at, ends_at, created_at)
           VALUES (?, ?, ?, 500, 1, ?, NULL, ?)`,
        )
        .run(`promo-${id}`, loja, id, agora, agora);
    }
    const res = await request(app).get('/api/v1/loja/ofertas?limit=500');
    expect(res.body.items.length).toBeLessThanOrEqual(60);
  });

  it('o serviço também segura o teto, para nenhum chamador novo escapar dele', () => {
    publicar(65);
    expect(listStorefrontProducts({ limit: 10_000 }).items).toHaveLength(60);
  });
});

describe('o catálogo decorado não é refeito sem motivo', () => {
  it('a segunda visita, sem nada gravado, custa só a conferência', () => {
    publicar(40);
    listStorefrontProducts({ limit: 12 });
    // Busca, ordenação, categoria e página diferentes: tudo sobre o mesmo
    // catálogo guardado.
    expect(consultas(() => listStorefrontProducts({ limit: 12 }))).toBeLessThanOrEqual(1);
    expect(consultas(() => listStorefrontProducts({ search: 'produto 01', limit: 12 }))).toBeLessThanOrEqual(1);
    expect(consultas(() => listStorefrontProducts({ sort: 'menor_preco', offset: 12, limit: 12 }))).toBeLessThanOrEqual(1);
    expect(consultas(() => listStorefrontProducts({ category: 'geral', limit: 12 }))).toBeLessThanOrEqual(1);
    expect(consultas(() => listStorefrontProducts({ storeSlug: 'gringa', limit: 12 }))).toBeGreaterThan(1);
    expect(consultas(() => listStorefrontProducts({ storeSlug: 'gringa', limit: 12 }))).toBeLessThanOrEqual(1);
  });

  it('venda no balcão aparece na vitrine seguinte — o saldo não fica velho', () => {
    const [id] = publicar(5);
    expect(listStorefrontProducts({ limit: 60 }).items.find((p) => p.id === id)?.available).toBe(3);

    applyMovement({
      companyId: loja,
      productId: id,
      movementType: 'out',
      quantity: 2,
      referenceType: 'venda',
      referenceId: 'venda-balcao-1',
    });

    expect(listStorefrontProducts({ limit: 60 }).items.find((p) => p.id === id)?.available).toBe(1);
  });

  it('promoção nova aparece na vitrine seguinte', () => {
    const [id] = publicar(3);
    listStorefrontProducts({ limit: 60 });
    const agora = new Date().toISOString();
    getConnection()
      .prepare(
        `INSERT INTO core_promotions (id, company_id, product_id, price_cents, active, starts_at, ends_at, created_at)
         VALUES ('promo-nova', ?, ?, 700, 1, ?, NULL, ?)`,
      )
      .run(loja, id, agora, agora);

    const item = listStorefrontProducts({ limit: 60 }).items.find((p) => p.id === id)!;
    expect(item.onSale).toBe(true);
    expect(item.priceCents).toBe(700);
  });

  it('virou o minuto, o catálogo é refeito (promoção com horário começa na hora)', () => {
    publicar(5);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-11T15:00:10.000Z'));
    listStorefrontProducts({ limit: 12 });
    expect(consultas(() => listStorefrontProducts({ limit: 12 }))).toBeLessThanOrEqual(1);

    vi.setSystemTime(new Date('2026-09-11T15:01:00.000Z'));
    expect(consultas(() => listStorefrontProducts({ limit: 12 }))).toBeGreaterThan(1);
  });

  it('quem recebe a página não estraga o catálogo guardado', () => {
    publicar(3);
    const primeira = listStorefrontProducts({ limit: 60 }).items;
    primeira[0].name = 'ALTERADO POR QUEM LEU';
    primeira.reverse();
    const segunda = listStorefrontProducts({ limit: 60 }).items;
    expect(segunda.map((p) => p.name)).toEqual(['Produto 000', 'Produto 001', 'Produto 002']);
  });
});
