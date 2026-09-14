/**
 * Busca da loja: categoria, faixa de preço e ordenação.
 *
 * A SUTILEZA QUE ESTE ARQUIVO PROTEGE
 *
 * Filtro e ordenação trabalham sobre o preço que o cliente PAGA, não sobre o
 * de tabela. A diferença não é cosmética: um produto de R$ 120 em promoção por
 * R$ 80 precisa aparecer no filtro "até R$ 100" — é exatamente onde o cliente
 * está procurando, e escondê-lo perde a venda que a promoção existe para
 * fazer.
 *
 * O mesmo vale para "menor preço": ordenar pela coluna do banco colocaria esse
 * produto depois de um de R$ 100, e a primeira tela mentiria.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { getConnection } from '../src/db/sqlite.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import { listStorefrontProducts } from '../src/services/core/StorefrontService.js';

let gringa: string;

function produto(nome: string, precoCents: number, categoria = 'Vestuário'): string {
  const id = `p-${nome.toLowerCase().replace(/\s/g, '-')}`;
  const agora = new Date().toISOString();
  const db = getConnection();
  db.prepare(
    `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                price_cents, category, active, publish_online, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'UN', 1000, ?, ?, 1, 1, ?, ?)`,
  ).run(id, gringa, `BF-${id}`, nome, precoCents, categoria, agora, agora);
  db.prepare(
    'INSERT INTO core_stock (company_id, product_id, quantity, reserved, updated_at) VALUES (?, ?, 5, 0, ?)',
  ).run(gringa, id, agora);
  return id;
}

function promocao(productId: string, precoPromocional: number): void {
  getConnection()
    .prepare(
      `INSERT INTO core_promotions
         (id, company_id, product_id, category, price_cents, percent_off,
          starts_at, ends_at, active, created_by, created_at)
       VALUES (?, ?, ?, NULL, ?, NULL, ?, NULL, 1, 'u-1', ?)`,
    )
    .run(
      randomUUID(),
      gringa,
      productId,
      precoPromocional,
      new Date(Date.now() - 3600_000).toISOString(),
      new Date().toISOString(),
    );
}

const nomes = (r: { name: string }[]) => r.map((p) => p.name);

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  gringa = await upsertCompany({ slug: 'gringa', tradeName: 'Gringa', legalName: 'Gringa Ltda' });
});

describe('faixa de preço', () => {
  it('usa o preço PROMOCIONAL, não o de tabela', () => {
    produto('Barata', 5000);
    const cara = produto('Cara em promoção', 12000);
    promocao(cara, 8000);
    produto('Fora da faixa', 15000);

    const ate100 = listStorefrontProducts({ maxPriceCents: 10000 }).items;

    // Sem isto, a loja esconderia justamente o produto que a promoção existe
    // para vender.
    expect(nomes(ate100)).toContain('Cara em promoção');
    expect(nomes(ate100)).toContain('Barata');
    expect(nomes(ate100)).not.toContain('Fora da faixa');
  });

  it('o piso também respeita a promoção', () => {
    const p = produto('Promocional', 20000);
    promocao(p, 3000);

    // Com o desconto o produto custa R$ 30 e não pode aparecer num filtro de
    // "a partir de R$ 100" só porque a etiqueta dizia R$ 200.
    expect(nomes(listStorefrontProducts({ minPriceCents: 10000 }).items)).not.toContain('Promocional');
  });

  it('faixa fechada devolve só o que está dentro', () => {
    produto('Barato', 3000);
    produto('Medio', 8000);
    produto('Caro', 20000);

    const faixa = listStorefrontProducts({ minPriceCents: 5000, maxPriceCents: 10000 }).items;
    expect(nomes(faixa)).toEqual(['Medio']);
  });

  it('sem faixa, tudo aparece', () => {
    produto('A', 3000);
    produto('B', 20000);
    expect(listStorefrontProducts({}).items).toHaveLength(2);
  });
});

describe('ordenação', () => {
  it('menor preço usa o preço promocional', () => {
    produto('Cem reais', 10000);
    const promocional = produto('Cento e vinte com desconto', 12000);
    promocao(promocional, 5000);

    // Ordenar pela coluna do banco poria "Cem reais" na frente, e a primeira
    // tela mentiria sobre qual é o mais barato.
    expect(nomes(listStorefrontProducts({ sort: 'menor_preco' }).items)[0]).toBe(
      'Cento e vinte com desconto',
    );
  });

  it('maior preço inverte', () => {
    produto('Barato', 3000);
    produto('Caro', 20000);
    expect(nomes(listStorefrontProducts({ sort: 'maior_preco' }).items)[0]).toBe('Caro');
  });

  it('promoções primeiro, e dentro delas o mais barato na frente', () => {
    produto('Sem desconto', 4000);
    const a = produto('Promo cara', 30000);
    const b = produto('Promo barata', 20000);
    promocao(a, 25000);
    promocao(b, 9000);

    expect(nomes(listStorefrontProducts({ sort: 'promocoes' }).items)).toEqual([
      'Promo barata',
      'Promo cara',
      'Sem desconto',
    ]);
  });

  it('sem ordenação pedida, vem por nome', () => {
    produto('Zebra', 5000);
    produto('Abacate', 9000);
    expect(nomes(listStorefrontProducts({}).items)).toEqual(['Abacate', 'Zebra']);
  });
});

describe('categoria e busca convivem com os filtros', () => {
  it('categoria mais faixa de preço', () => {
    produto('Camisa barata', 5000, 'Vestuário');
    produto('Camisa cara', 30000, 'Vestuário');
    produto('Boné barato', 4000, 'Acessórios');

    const r = listStorefrontProducts({ category: 'Vestuário', maxPriceCents: 10000 }).items;
    expect(nomes(r)).toEqual(['Camisa barata']);
  });

  it('busca por texto mais ordenação', () => {
    produto('Camisa azul', 9000);
    produto('Camisa preta', 3000);
    produto('Calça jeans', 1000);

    const r = listStorefrontProducts({ search: 'Camisa', sort: 'menor_preco' }).items;
    expect(nomes(r)).toEqual(['Camisa preta', 'Camisa azul']);
  });

  it('o limite é aplicado DEPOIS de ordenar', () => {
    produto('Caro', 30000);
    produto('Medio', 20000);
    produto('Barato', 1000);

    // Cortar antes de ordenar devolveria uma página que não é a mais barata —
    // seria "os três primeiros por nome, ordenados por preço".
    const r = listStorefrontProducts({ sort: 'menor_preco', limit: 1 }).items;
    expect(nomes(r)).toEqual(['Barato']);
  });
});
