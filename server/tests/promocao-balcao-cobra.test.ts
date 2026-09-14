/**
 * O balcão cobra o preço anunciado.
 *
 * O DEFEITO
 *
 * A vitrine mostrava a Jaqueta por R$ 246,75 (25% de desconto) e o PDV cobrava
 * R$ 329,00. Três coisas somadas:
 *
 *   1. `/products/search` devolvia o preço de TABELA, sem promoção;
 *   2. o PDV punha esse preço no carrinho e mandava como `unitPriceCents`;
 *   3. `createSale` fazia `item.unitPriceCents ?? priceCents` — o preço vindo
 *      da tela ganhava, e a promoção era ignorada.
 *
 * O cabeçalho do `SalesService` já dizia "o frontend não define quanto custa" e
 * "a vitrine não pode anunciar um desconto que o PDV não cobra". O código não
 * entregava nenhuma das duas.
 *
 * A REGRA
 *
 * O preço vigente é o TETO. O operador pode vender por menos — desconto existe,
 * é registrado e passa por autorização quando é grande. O que não pode é
 * cobrar MAIS do que a loja anunciou.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { getConnection } from '../src/db/sqlite.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import { createSale } from '../src/services/core/SalesService.js';
import { searchProducts } from '../src/services/core/CatalogService.js';
import { effectivePriceCents } from '../src/services/core/PricingService.js';
import { getStorefrontProduct } from '../src/services/core/StorefrontService.js';

const TABELA = 32900;
const COM_DESCONTO = 24675; // 25% de 329,00

let gringa: string;

function jaqueta(): string {
  const agora = new Date().toISOString();
  getConnection()
    .prepare(
      `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                  price_cents, category, active, publish_online, created_at, updated_at)
       VALUES ('p-jaq', ?, 'GS-000002', 'Jaqueta Corta-Vento', 'UN', 15000, ?, 'Vestuário', 1, 1, ?, ?)`,
    )
    .run(gringa, TABELA, agora, agora);
  getConnection()
    .prepare(
      'INSERT INTO core_stock (company_id, product_id, quantity, reserved, updated_at) VALUES (?, ?, 10, 0, ?)',
    )
    .run(gringa, 'p-jaq', agora);
  return 'p-jaq';
}

function promocao25(): void {
  getConnection()
    .prepare(
      `INSERT INTO core_promotions
         (id, company_id, product_id, category, price_cents, percent_off,
          starts_at, ends_at, active, created_by, created_at)
       VALUES (?, ?, 'p-jaq', NULL, NULL, 25, ?, NULL, 1, 'u-1', ?)`,
    )
    .run(randomUUID(), gringa, new Date(Date.now() - 3600_000).toISOString(), new Date().toISOString());
}

function totalDaVenda(saleId: string): number {
  return (
    getConnection().prepare('SELECT total_cents FROM core_sales WHERE id = ?').get(saleId) as {
      total_cents: number;
    }
  ).total_cents;
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  gringa = await upsertCompany({ slug: 'gringa', tradeName: 'Gringa', legalName: 'Gringa Ltda' });
  jaqueta();
  promocao25();
});

describe('os dois canais anunciam o mesmo', () => {
  it('a vitrine mostra o preço promocional', () => {
    const vitrine = getStorefrontProduct('p-jaq')!;
    expect(vitrine.priceCents).toBe(COM_DESCONTO);
    expect(vitrine.onSale).toBe(true);
  });

  it('a BUSCA DO PDV também mostra o preço promocional', () => {
    // Era aqui que o balcão perdia a promoção: a busca devolvia só o preço de
    // tabela, e o operador punha esse valor no carrinho.
    const [encontrado] = searchProducts(gringa, 'Jaqueta') as unknown as Record<string, unknown>[];
    expect(encontrado.effective_price_cents).toBe(COM_DESCONTO);
    expect(encontrado.on_sale).toBe(true);
    // O preço de tabela continua visível, para o operador ver o "de/por".
    expect(encontrado.price_cents).toBe(TABELA);
  });
});

describe('o balcão COBRA o preço anunciado', () => {
  it('sem preço informado, a venda sai pelo promocional', () => {
    const { sale } = createSale({
      companyId: gringa,
      userId: 'u-1',
      idempotencyKey: 'v-1',
      items: [{ productId: 'p-jaq', quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: COM_DESCONTO }],
    });
    expect(totalDaVenda(sale.id)).toBe(COM_DESCONTO);
  });

  it('a tela mandando o preço de TABELA não desfaz a promoção', () => {
    // Este é o caso real: o PDV enviava 32900 e o cliente pagava a mais.
    const { sale } = createSale({
      companyId: gringa,
      userId: 'u-1',
      idempotencyKey: 'v-2',
      items: [{ productId: 'p-jaq', quantity: 1, unitPriceCents: TABELA }],
      payments: [{ method: 'dinheiro', amountCents: COM_DESCONTO }],
    });
    expect(totalDaVenda(sale.id)).toBe(COM_DESCONTO);
  });

  it('preço acima do anunciado é recusado — vira o preço anunciado', () => {
    const { sale } = createSale({
      companyId: gringa,
      userId: 'u-1',
      idempotencyKey: 'v-3',
      items: [{ productId: 'p-jaq', quantity: 1, unitPriceCents: 99900 }],
      payments: [{ method: 'dinheiro', amountCents: COM_DESCONTO }],
    });
    expect(totalDaVenda(sale.id)).toBe(COM_DESCONTO);
  });

  it('vender por MENOS continua possível — desconto é do balcão', () => {
    // O teto é o preço anunciado; abaixo dele o operador decide, e o desconto
    // fica registrado na venda.
    const { sale } = createSale({
      companyId: gringa,
      userId: 'u-1',
      idempotencyKey: 'v-4',
      items: [{ productId: 'p-jaq', quantity: 1, unitPriceCents: 20000 }],
      payments: [{ method: 'dinheiro', amountCents: 20000 }],
    });
    expect(totalDaVenda(sale.id)).toBe(20000);
  });

  it('sem promoção, o preço de tabela vale nos dois canais', () => {
    getConnection().prepare('UPDATE core_promotions SET active = 0').run();

    expect(getStorefrontProduct('p-jaq')!.priceCents).toBe(TABELA);
    const { sale } = createSale({
      companyId: gringa,
      userId: 'u-1',
      idempotencyKey: 'v-5',
      items: [{ productId: 'p-jaq', quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: TABELA }],
    });
    expect(totalDaVenda(sale.id)).toBe(TABELA);
  });

  it('a venda e a vitrine batem exatamente, seja qual for a promoção', () => {
    const vigente = effectivePriceCents(gringa, 'p-jaq', TABELA, 'Vestuário').priceCents;
    const vitrine = getStorefrontProduct('p-jaq')!.priceCents;
    const { sale } = createSale({
      companyId: gringa,
      userId: 'u-1',
      idempotencyKey: 'v-6',
      items: [{ productId: 'p-jaq', quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: vigente }],
    });

    expect(vitrine).toBe(vigente);
    expect(totalDaVenda(sale.id)).toBe(vigente);
  });
});
