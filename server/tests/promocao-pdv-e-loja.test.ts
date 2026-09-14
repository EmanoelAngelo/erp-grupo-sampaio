/**
 * Uma promoção, dois canais, o mesmo preço.
 *
 * Já divergiu uma vez: a loja mostrava a promoção e o PDV cobrava cheio.
 * O cliente vê o preço na internet e chega ao balcão com o print. Este teste
 * existe para que a próxima mudança em preço não desfaça a correção.
 *
 * O que se cobra NÃO é a fórmula do desconto — isso tem teste próprio. É que
 * vitrine, carrinho fechado e venda de balcão cheguem ao MESMO número, saindo
 * da mesma função.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import { effectivePriceCents } from '../src/services/core/PricingService.js';
import {
  checkout,
  getStorefrontProduct,
  listStorefrontProducts,
} from '../src/services/core/StorefrontService.js';

let precoJusto: string;
let produto: string;

function criarProduto(companyId: string, precoCents: number, categoria: string | null): string {
  const id = `prod-promocao`;
  const agora = new Date().toISOString();
  const db = getConnection();
  db.prepare(
    `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                price_cents, category, active, publish_online, created_at, updated_at)
     VALUES (?, ?, 'PROMO-1', 'Produto em promoção', 'UN', 4000, ?, ?, 1, 1, ?, ?)`,
  ).run(id, companyId, precoCents, categoria, agora, agora);
  db.prepare(
    'INSERT INTO core_stock (company_id, product_id, quantity, reserved, updated_at) VALUES (?, ?, 20, 0, ?)',
  ).run(companyId, id, agora);
  return id;
}

/** Promoção como o gestor cria: vigente hoje, na operação dele. */
function criarPromocao(input: {
  companyId: string;
  productId?: string;
  category?: string;
  priceCents?: number;
  percentOff?: number;
}): void {
  const agora = new Date();
  const ontem = new Date(agora.getTime() - 86_400_000).toISOString();
  const amanha = new Date(agora.getTime() + 86_400_000).toISOString();
  getConnection()
    .prepare(
      `INSERT INTO core_promotions
         (id, company_id, product_id, category, price_cents, percent_off,
          starts_at, ends_at, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    )
    .run(
      `promo-${Math.random().toString(36).slice(2, 10)}`,
      input.companyId,
      input.productId ?? null,
      input.category ?? null,
      input.priceCents ?? null,
      input.percentOff ?? null,
      ontem,
      amanha,
      agora.toISOString(),
    );
}

/** O preço que o PDV usaria — a mesma função que `SalesService` chama. */
function precoDoBalcao(companyId: string, productId: string): number {
  const p = getConnection()
    .prepare('SELECT price_cents, category FROM core_products WHERE id = ?')
    .get(productId) as { price_cents: number; category: string | null };
  return effectivePriceCents(companyId, productId, p.price_cents, p.category).priceCents;
}

function precoDaVitrine(productId: string): number {
  return getStorefrontProduct(productId)!.priceCents;
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  precoJusto = await upsertCompany({
    slug: 'preco-justo',
    tradeName: 'Preço Justo',
    legalName: 'Preço Justo Ltda',
  });
  produto = criarProduto(precoJusto, 20000, 'Acessórios');
});

describe('promoção por produto', () => {
  it('o mesmo preço no balcão e na vitrine', () => {
    criarPromocao({ companyId: precoJusto, productId: produto, priceCents: 15000 });

    expect(precoDoBalcao(precoJusto, produto)).toBe(15000);
    expect(precoDaVitrine(produto)).toBe(15000);
  });

  it('a vitrine marca que está em promoção', () => {
    criarPromocao({ companyId: precoJusto, productId: produto, priceCents: 15000 });

    const daVitrine = getStorefrontProduct(produto)!;

    expect(daVitrine.onSale).toBe(true);
    // O preço-base continua visível: é o "de/por" que o cliente compara.
    expect(daVitrine.basePriceCents).toBe(20000);
  });
});

describe('promoção por categoria', () => {
  it('vale nos dois canais', () => {
    criarPromocao({ companyId: precoJusto, category: 'Acessórios', percentOff: 25 });

    expect(precoDoBalcao(precoJusto, produto)).toBe(15000);
    expect(precoDaVitrine(produto)).toBe(15000);
  });
});

describe('o carrinho fechado cobra o preço promocional', () => {
  it('o pedido sai com o preço da promoção, não com o cheio', () => {
    criarPromocao({ companyId: precoJusto, productId: produto, priceCents: 15000 });

    const [pedido] = checkout({
      idempotencyKey: 'ck-promo',
      customerName: 'Cliente Atento',
      customerDocument: '111.444.777-35',
      paymentMethod: 'pix',
      items: [{ productId: produto, quantity: 2 }],
    });

    // O preço vem do SERVIDOR, não do que o navegador mandou.
    expect(pedido.total_cents).toBe(30000);
    const item = getConnection()
      .prepare('SELECT unit_price_cents FROM core_order_items WHERE order_id = ?')
      .get(pedido.id) as { unit_price_cents: number };
    expect(item.unit_price_cents).toBe(15000);
  });
});

describe('promoção é da operação', () => {
  it('não vaza para a loja da empresa vizinha', async () => {
    const gringa = await upsertCompany({
      slug: 'gringa',
      tradeName: 'Gringa',
      legalName: 'Gringa Ltda',
    });
    const agora = new Date().toISOString();
    getConnection()
      .prepare(
        `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                    price_cents, category, active, publish_online, created_at, updated_at)
         VALUES ('prod-gringa', ?, 'G-1', 'Mesmo item na Gringa', 'UN', 4000, 20000, 'Acessórios', 1, 1, ?, ?)`,
      )
      .run(gringa, agora, agora);

    criarPromocao({ companyId: precoJusto, category: 'Acessórios', percentOff: 25 });

    expect(precoDaVitrine(produto)).toBe(15000);
    // A Gringa não fez promoção nenhuma; o preço dela não muda.
    expect(precoDaVitrine('prod-gringa')).toBe(20000);
    expect(precoDoBalcao(gringa, 'prod-gringa')).toBe(20000);
  });
});

describe('sem promoção', () => {
  it('os dois canais mostram o preço cheio', () => {
    expect(precoDoBalcao(precoJusto, produto)).toBe(20000);
    expect(precoDaVitrine(produto)).toBe(20000);
    expect(listStorefrontProducts({}).items[0].onSale).toBe(false);
  });
});
