/**
 * A VITRINE NÃO PODE CONGELAR O BALCÃO.
 *
 * ============================================================================
 * TRÊS CONSULTAS POR PRODUTO, VEZES O CATÁLOGO INTEIRO
 * ============================================================================
 *
 * `listStorefrontProducts` busca as linhas com UMA consulta e depois chama
 * `decorate` em cada uma. E `decorate` vai ao banco três vezes por produto:
 *
 *   - `effectivePriceCents` procura promoção vigente daquele produto;
 *   - `variantesVisiveis` procura os filhos da grade;
 *   - `getAvailable` (nele e em cada filho) lê o saldo.
 *
 * Com 500 produtos publicados são mais de 1.500 idas ao banco para montar uma
 * página. E `node:sqlite` é SÍNCRONO, no mesmo processo que atende
 * `/core/sales`: enquanto a home do grupo monta, o balcão não vende. Vitrine
 * lenta aqui não é vitrine lenta — é o PDV parado com o cliente na frente.
 *
 * A busca, a faixa de preço e a ordenação rodam DEPOIS de `decorate`, e é uma
 * decisão certa e documentada: promoção e grade não são coluna, e ordenar por
 * preço em SQL daria o preço errado. O defeito não é a passada em memória — é
 * a ida ao banco dentro dela.
 *
 * ============================================================================
 * A REGRA
 * ============================================================================
 *
 * As três consultas passam a ser feitas UMA vez, para o conjunto inteiro, antes
 * do laço. `decorate` recebe o que já foi lido e não fala mais com o banco.
 *
 * O número de consultas passa a não depender do tamanho do catálogo — que é o
 * que este arquivo mede. Um teste de tempo mediria a máquina; um teste de
 * CONTAGEM mede a decisão.
 */
process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_DATABASE_PATH = ':memory:';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

import { beforeEach, describe, expect, it } from 'vitest';

const { ensureCoreSchema } = await import('../src/db/schema.js');
const { resetDbForTests } = await import('../src/db/database.js');
const { getConnection } = await import('../src/db/sqlite.js');
const { upsertCompany } = await import('../src/services/auth/IdentityService.js');
const { createProduct } = await import('../src/services/core/CatalogService.js');
const { applyMovement } = await import('../src/services/core/InventoryService.js');
const { generateVariants } = await import('../src/services/core/VariantService.js');
const { listStorefrontProducts } = await import('../src/services/core/StorefrontService.js');

let loja: string;

beforeEach(() => {
  resetDbForTests();
  ensureCoreSchema();
  loja = upsertCompany({ slug: 'gringa', legalName: 'Gringa Ltda', tradeName: 'Gringa' });
});

function publicar(nome: string, precoCents: number, saldo: number): string {
  const id = String(createProduct(loja, { name: nome, priceCents: precoCents }).id);
  getConnection().prepare('UPDATE core_products SET publish_online = 1 WHERE id = ?').run(id);
  if (saldo > 0) {
    applyMovement({
      companyId: loja,
      productId: id,
      movementType: 'in',
      quantity: saldo,
      referenceType: 'entrada',
      referenceId: `carga-${id}`,
    });
  }
  return id;
}

function encher(quantos: number): void {
  for (let i = 0; i < quantos; i += 1) {
    publicar(`Produto ${String(i).padStart(3, '0')}`, 1_000 + i, 5);
  }
}

/**
 * Quantas consultas a listagem dispara.
 *
 * Conta chamadas a `prepare`, que é por onde TODA leitura deste projeto passa.
 * O número exato não interessa — o que interessa é ele não crescer com o
 * catálogo.
 */
function consultasPara(quantos: number): number {
  encher(quantos);
  const conexao = getConnection() as unknown as { prepare: (sql: string) => unknown };
  const original = conexao.prepare.bind(conexao);
  let contador = 0;
  conexao.prepare = (sql: string) => {
    contador += 1;
    return original(sql);
  };
  try {
    listStorefrontProducts({ limit: 100 });
  } finally {
    conexao.prepare = original;
  }
  return contador;
}

// ============================================================================

describe('a listagem não fala com o banco dentro do laço', () => {
  it('o número de consultas não cresce com o catálogo', () => {
    const com10 = consultasPara(10);

    resetDbForTests();
    ensureCoreSchema();
    loja = upsertCompany({ slug: 'gringa', legalName: 'Gringa Ltda', tradeName: 'Gringa' });
    const com100 = consultasPara(100);

    /*
      Antes: 10 produtos custavam ~30 consultas e 100 custavam ~300 — três por
      produto, direto. Agora as três são feitas uma vez para o conjunto, então
      dez vezes mais produtos não custam dez vezes mais idas ao banco.
    */
    expect(com100).toBeLessThanOrEqual(com10 + 2);
  });

  it('e são poucas: a listagem inteira cabe num punhado de consultas', () => {
    expect(consultasPara(50)).toBeLessThanOrEqual(10);
  });
});

// ============================================================================

describe('e o que a vitrine mostra continua igual', () => {
  it('preço, promoção e disponível saem como sempre saíram', () => {
    const camisa = publicar('Camisa Polo', 12_000, 7);
    const agora = new Date().toISOString();
    getConnection()
      .prepare(
        `INSERT INTO core_promotions (id, company_id, product_id, price_cents, active,
                                      starts_at, ends_at, created_at)
         VALUES ('promo-1', ?, ?, 9000, 1, ?, NULL, ?)`,
      )
      .run(loja, camisa, agora, agora);

    const { items } = listStorefrontProducts({ limit: 100 });
    const item = items.find((p) => p.id === camisa)!;

    expect(item.priceCents).toBe(9_000);
    expect(item.onSale).toBe(true);
    expect(item.basePriceCents).toBe(12_000);
    expect(item.available).toBe(7);
  });

  it('a grade continua num card só, com o menor preço e a soma dos tamanhos', () => {
    const modelo = publicar('Camisa Social', 15_000, 0);
    const { created } = generateVariants({
      companyId: loja,
      productId: modelo,
      axes: { tamanho: ['P', 'M'] },
    });
    for (const [i, v] of created.entries()) {
      getConnection()
        .prepare('UPDATE core_products SET publish_online = 1, price_cents = ? WHERE id = ?')
        .run(14_000 + i * 1_000, v.id);
      applyMovement({
        companyId: loja,
        productId: String(v.id),
        movementType: 'in',
        quantity: 3,
        referenceType: 'entrada',
        referenceId: `carga-${v.id}`,
      });
    }

    const { items } = listStorefrontProducts({ limit: 100 });
    const card = items.find((p) => p.id === modelo)!;

    expect(card.hasVariants).toBe(true);
    // O "a partir de": o menor dos tamanhos.
    expect(card.fromPriceCents).toBe(14_000);
    expect(card.priceCents).toBe(14_000);
    // A soma dos tamanhos — senão o card diria "Indisponível" para uma camisa
    // que tem P e M na prateleira.
    expect(card.available).toBe(6);
  });

  it('produto sem saldo aparece com zero, e não some', () => {
    const esgotado = publicar('Boné Esgotado', 4_000, 0);
    const { items } = listStorefrontProducts({ limit: 100 });
    expect(items.find((p) => p.id === esgotado)?.available).toBe(0);
  });

  it('a ordenação por menor preço continua olhando o preço COM promoção', () => {
    const caro = publicar('Item Caro', 20_000, 1);
    const barato = publicar('Item Barato', 21_000, 1);
    const agora = new Date().toISOString();
    getConnection()
      .prepare(
        `INSERT INTO core_promotions (id, company_id, product_id, price_cents, active,
                                      starts_at, ends_at, created_at)
         VALUES ('promo-2', ?, ?, 5000, 1, ?, NULL, ?)`,
      )
      .run(loja, barato, agora, agora);

    const { items } = listStorefrontProducts({ sort: 'menor_preco', limit: 100 });
    // O de cadastro mais caro sai na frente porque está em promoção — é o que
    // ordenar em SQL não conseguiria.
    expect(items[0].id).toBe(barato);
    expect(items[1].id).toBe(caro);
  });
});
