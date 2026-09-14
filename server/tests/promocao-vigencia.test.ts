/**
 * Vigência da promoção, nos dois canais.
 *
 * O preço promocional é a única regra do sistema que o cliente vê ANTES de
 * comprar e confere DEPOIS, no cupom. Se a vitrine anuncia R$ 80 e o balcão
 * cobra R$ 100, a loja perde a venda e a confiança — e o contrário custa
 * margem em toda venda do dia.
 *
 * `effectivePriceCents` é a função única dos dois canais, e é ela que este
 * arquivo cerca: promoção que ainda não começou, que já venceu, que foi
 * desativada, e o caso de duas valendo ao mesmo tempo.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { getConnection } from '../src/db/sqlite.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import { effectivePriceCents } from '../src/services/core/PricingService.js';

const PRECO_BASE = 10000;
let gringa: string;

function produto(id: string, categoria: string | null = 'Vestuário'): string {
  const agora = new Date().toISOString();
  getConnection()
    .prepare(
      `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                  price_cents, category, active, publish_online, created_at, updated_at)
       VALUES (?, ?, ?, 'Camiseta', 'UN', 4000, ?, ?, 1, 1, ?, ?)`,
    )
    .run(id, gringa, `PV-${id}`, PRECO_BASE, categoria, agora, agora);
  return id;
}

function promocao(input: {
  productId?: string | null;
  category?: string | null;
  percentOff?: number | null;
  priceCents?: number | null;
  startsAt?: string;
  endsAt?: string | null;
  active?: boolean;
}): string {
  const id = randomUUID();
  getConnection()
    .prepare(
      `INSERT INTO core_promotions
         (id, company_id, product_id, category, price_cents, percent_off,
          starts_at, ends_at, active, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'u-1', ?)`,
    )
    .run(
      id,
      gringa,
      input.productId ?? null,
      input.category ?? null,
      input.priceCents ?? null,
      input.percentOff ?? null,
      input.startsAt ?? new Date(Date.now() - 3600_000).toISOString(),
      input.endsAt ?? null,
      input.active === false ? 0 : 1,
      new Date().toISOString(),
    );
  return id;
}

function preco(productId: string, categoria: string | null = 'Vestuário') {
  return effectivePriceCents(gringa, productId, PRECO_BASE, categoria);
}

const emDias = (dias: number) =>
  new Date(Date.now() + dias * 86_400_000).toISOString();

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  gringa = await upsertCompany({ slug: 'gringa', tradeName: 'Gringa', legalName: 'Gringa Ltda' });
});

describe('período', () => {
  it('promoção que ainda NÃO começou não vale', () => {
    produto('p-1');
    promocao({ productId: 'p-1', percentOff: 20, startsAt: emDias(3) });

    // Agendar a promoção da semana que vem não pode baixar o preço hoje.
    expect(preco('p-1').priceCents).toBe(PRECO_BASE);
    expect(preco('p-1').onSale).toBe(false);
  });

  it('promoção VENCIDA não vale', () => {
    produto('p-1');
    promocao({
      productId: 'p-1',
      percentOff: 20,
      startsAt: emDias(-10),
      endsAt: emDias(-1),
    });

    // Promoção de ontem cobrada hoje é margem perdida em toda venda.
    expect(preco('p-1').priceCents).toBe(PRECO_BASE);
  });

  it('promoção sem data de fim continua valendo', () => {
    produto('p-1');
    promocao({ productId: 'p-1', percentOff: 20, endsAt: null });
    expect(preco('p-1').priceCents).toBe(8000);
  });

  it('promoção dentro do período vale', () => {
    produto('p-1');
    promocao({ productId: 'p-1', percentOff: 20, startsAt: emDias(-1), endsAt: emDias(1) });
    expect(preco('p-1').priceCents).toBe(8000);
  });

  it('promoção DESATIVADA não vale, mesmo dentro do período', () => {
    produto('p-1');
    promocao({ productId: 'p-1', percentOff: 20, active: false });

    // Desativar é a única forma de encerrar antes do prazo; se não valesse,
    // o gerente não teria como parar uma promoção errada.
    expect(preco('p-1').priceCents).toBe(PRECO_BASE);
  });
});

describe('duas promoções ao mesmo tempo', () => {
  it('vale a mais vantajosa para o cliente', () => {
    produto('p-1');
    promocao({ productId: 'p-1', percentOff: 10 });
    promocao({ category: 'Vestuário', percentOff: 30 });

    // Anunciar 30% e cobrar 10% seria propaganda enganosa; cobrar 30% quando
    // só a de produto valia seria margem jogada fora. A regra precisa ser uma.
    expect(preco('p-1').priceCents).toBe(7000);
  });

  it('preço fixo compete com percentual pelo mesmo critério', () => {
    produto('p-1');
    promocao({ productId: 'p-1', percentOff: 10 });
    promocao({ productId: 'p-1', priceCents: 6500 });
    expect(preco('p-1').priceCents).toBe(6500);
  });

  it('promoção pior que o preço de tabela é ignorada', () => {
    produto('p-1');
    promocao({ productId: 'p-1', priceCents: 15000 });

    // "Promoção" que aumenta o preço não é promoção.
    expect(preco('p-1').priceCents).toBe(PRECO_BASE);
    expect(preco('p-1').onSale).toBe(false);
  });
});

describe('alvo da promoção', () => {
  it('promoção de categoria não alcança produto de outra categoria', () => {
    produto('p-1', 'Vestuário');
    produto('p-2', 'Acessórios');
    promocao({ category: 'Vestuário', percentOff: 20 });

    expect(preco('p-1', 'Vestuário').priceCents).toBe(8000);
    expect(preco('p-2', 'Acessórios').priceCents).toBe(PRECO_BASE);
  });

  it('promoção de produto não vaza para os vizinhos da mesma categoria', () => {
    produto('p-1');
    produto('p-2');
    promocao({ productId: 'p-1', percentOff: 20 });

    expect(preco('p-1').priceCents).toBe(8000);
    expect(preco('p-2').priceCents).toBe(PRECO_BASE);
  });

  it('produto sem categoria não é pego por promoção de categoria', () => {
    produto('p-1', null);
    promocao({ category: 'Vestuário', percentOff: 20 });
    expect(preco('p-1', null).priceCents).toBe(PRECO_BASE);
  });
});

describe('o preço de tabela NUNCA é sobrescrito', () => {
  it('a promoção não altera o cadastro do produto', () => {
    produto('p-1');
    promocao({ productId: 'p-1', percentOff: 40 });

    // Preço promocional é um cálculo, não uma edição. Se a promoção gravasse
    // no cadastro, encerrá-la deixaria o produto barato para sempre — e
    // ninguém saberia qual era o preço original.
    preco('p-1');
    const cadastro = getConnection()
      .prepare('SELECT price_cents FROM core_products WHERE id = ?')
      .get('p-1') as { price_cents: number };
    expect(cadastro.price_cents).toBe(PRECO_BASE);
  });

  it('encerrada a promoção, o preço volta sozinho ao de tabela', () => {
    produto('p-1');
    const id = promocao({ productId: 'p-1', percentOff: 40 });
    expect(preco('p-1').priceCents).toBe(6000);

    getConnection().prepare('UPDATE core_promotions SET active = 0 WHERE id = ?').run(id);
    expect(preco('p-1').priceCents).toBe(PRECO_BASE);
  });
});
