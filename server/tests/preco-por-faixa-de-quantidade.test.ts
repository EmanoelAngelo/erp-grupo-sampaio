/**
 * ============================================================================
 * "3 POR R$ 10" — o preço de atacado para quem não tem cadastro (GAP-V04)
 * ============================================================================
 *
 * ## O defeito
 *
 * A tabela de preço desta casa é por CLIENTE (`core_customers.price_table_id`):
 * ela exige alguém identificado, cadastrado e vinculado. Quem chega no balcão
 * levando doze não tem nada disso, e a oferta de volume — o formato mais comum
 * do varejo de bairro — não existia em estrutura nenhuma. O contorno é digitar
 * desconto na linha, e desconto digitado é CONCESSÃO: um atacadinho de fim de
 * semana pararia o caixa chamando gerente em toda venda.
 *
 * ## A DOUTRINA QUE ESTE ARQUIVO PROTEGE
 *
 * A casa tem uma regra antiga e cara: os candidatos a preço são TODOS
 * calculados sobre a BASE, nunca um sobre o outro, e vence o MENOR. 20% de
 * promoção com 10% de tabela dá 20%, e não 28%.
 *
 * A faixa entra como QUARTO candidato, e não como mais um desconto. Empilhá-la
 * seria erosão de margem invisível: não dá erro, não aparece em relatório
 * nenhum, e o preço final só é conferido quando alguém compara o cupom com o
 * cadastro à mão. O empate NÃO é dela — promoção é pública (o cliente viu o
 * anúncio) e tabela é o combinado daquele cliente; a faixa só vence quando é
 * estritamente melhor, que é quando o cliente de fato ganha algo.
 *
 * ## COMO CADA GUARDA FALHA
 *
 *  - troque o `< best` da faixa por um cálculo sobre `best` e o caso do
 *    empilhamento fica vermelho;
 *  - faça a faixa vencer o empate e o caso da promoção pública fica vermelho;
 *  - tire o `quantidade` que a VENDA passa a `effectivePriceCents` e o caso da
 *    concessão fica vermelho: o teto continuaria sendo o preço cheio e a venda
 *    de três viraria concessão de gestor.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_DATABASE_PATH = ':memory:';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

const { resetDbForTests } = await import('../src/db/database.js');
const { ensureCoreSchema } = await import('../src/db/schema.js');
const { getConnection } = await import('../src/db/sqlite.js');
const { upsertCompany } = await import('../src/services/auth/IdentityService.js');
const { createProduct } = await import('../src/services/core/CatalogService.js');
const { effectivePriceCents, priceCartForCustomer } = await import(
  '../src/services/core/PricingService.js'
);
const { listPriceTiers, removePriceTier, setPriceTier } = await import(
  '../src/services/core/CatalogAuxService.js'
);
const { applyMovement } = await import('../src/services/core/InventoryService.js');
const { createSale } = await import('../src/services/core/SalesService.js');

const PRECO = 1200; // R$ 12,00 a unidade

let loja: string;
let refri: string;

function erroDe(fn: () => unknown): { code: string; message: string } {
  try {
    fn();
  } catch (err) {
    const e = err as { code: string; message: string };
    return { code: e.code, message: e.message };
  }
  throw new Error('esperava recusa, e passou');
}

/** O preço vigente de N unidades desta linha. */
function precoDe(quantidade: number, extras: Record<string, unknown> = {}) {
  return effectivePriceCents(loja, refri, PRECO, 'Bebidas', { quantidade, ...extras });
}

function promocaoDe(percentOff: number): void {
  getConnection()
    .prepare(
      `INSERT INTO core_promotions
         (id, company_id, product_id, category, price_cents, percent_off,
          starts_at, ends_at, weekdays, active, created_by, created_at)
       VALUES (?, ?, ?, NULL, NULL, ?, ?, NULL, NULL, 1, 'u-1', ?)`,
    )
    .run(
      randomUUID(),
      loja,
      refri,
      percentOff,
      new Date(Date.now() - 3600_000).toISOString(),
      new Date().toISOString(),
    );
}

beforeEach(() => {
  resetDbForTests();
  ensureCoreSchema();
  loja = upsertCompany({
    slug: 'preco-justo',
    legalName: 'Preço Justo Ltda',
    tradeName: 'Preço Justo',
    kind: 'store',
  });
  refri = String(
    createProduct(loja, {
      name: 'Refrigerante 350ml',
      priceCents: PRECO,
      costCents: 600,
      category: 'Bebidas',
    }).id,
  );
});

describe('a faixa vale pela quantidade da LINHA', () => {
  it('abaixo do piso, nada muda', () => {
    setPriceTier(loja, refri, 3, 1000);
    expect(precoDe(1).priceCents).toBe(PRECO);
    expect(precoDe(2).priceCents).toBe(PRECO);
    expect(precoDe(2).fonte).toBe('cadastro');
  });

  it('a partir do piso, cada unidade sai pelo preço da faixa', () => {
    setPriceTier(loja, refri, 3, 1000);
    expect(precoDe(3).priceCents).toBe(1000);
    expect(precoDe(3).fonte).toBe('faixa');
    expect(precoDe(3).onSale).toBe(true);
    expect(precoDe(10).priceCents).toBe(1000);
  });

  it('com várias faixas, vale a de MAIOR piso satisfeito', () => {
    setPriceTier(loja, refri, 3, 1000);
    setPriceTier(loja, refri, 12, 800);

    expect(precoDe(3).priceCents).toBe(1000);
    expect(precoDe(11).priceCents).toBe(1000);
    // Comprar mais nunca pode sair mais caro por unidade.
    expect(precoDe(12).priceCents).toBe(800);
  });

  it('o mesmo piso regravado TROCA o preço, não cria uma segunda resposta', () => {
    setPriceTier(loja, refri, 3, 1000);
    const faixas = setPriceTier(loja, refri, 3, 900);
    expect(faixas).toHaveLength(1);
    expect(precoDe(3).priceCents).toBe(900);
  });

  it('remover a faixa devolve o preço de cadastro', () => {
    setPriceTier(loja, refri, 3, 1000);
    removePriceTier(loja, refri, 3);
    expect(listPriceTiers(loja, refri)).toHaveLength(0);
    expect(precoDe(5).priceCents).toBe(PRECO);
  });

  it('sem quantidade declarada, a linha vale 1 — e nada muda', () => {
    setPriceTier(loja, refri, 3, 1000);
    expect(effectivePriceCents(loja, refri, PRECO, 'Bebidas').priceCents).toBe(PRECO);
  });
});

describe('a faixa NÃO empilha — vence o menor, e o empate é dos outros', () => {
  it('faixa com promoção: vale a mais barata das duas, e não a soma', () => {
    setPriceTier(loja, refri, 3, 1000); // R$ 10,00
    promocaoDe(20); // 20% sobre R$ 12,00 = R$ 9,60

    const vigente = precoDe(3);
    // Empilhar daria 20% sobre R$ 10,00 = R$ 8,00. A doutrina diz R$ 9,60.
    expect(vigente.priceCents).toBe(960);
    expect(vigente.fonte).toBe('promocao');
  });

  it('quando a faixa é a melhor, é ela que ganha — e a promoção não a rebaixa', () => {
    setPriceTier(loja, refri, 3, 800); // R$ 8,00
    promocaoDe(20); // R$ 9,60

    const vigente = precoDe(3);
    expect(vigente.priceCents).toBe(800);
    expect(vigente.fonte).toBe('faixa');
  });

  it('NO EMPATE quem explica o preço é a promoção, porque ela é pública', () => {
    // 20% sobre R$ 12,00 dá exatamente R$ 9,60 — o mesmo da faixa.
    setPriceTier(loja, refri, 3, 960);
    promocaoDe(20);

    const vigente = precoDe(3);
    expect(vigente.priceCents).toBe(960);
    // O cliente viu "20% OFF" anunciado; é esse nome que precisa sair no cupom.
    expect(vigente.fonte).toBe('promocao');
  });

  it('preço ABERTO sai antes de tudo: a faixa não reprecifica mão de obra', () => {
    const vigente = effectivePriceCents(loja, refri, 0, 'Bebidas', {
      quantidade: 10,
      openPrice: true,
    });
    expect(vigente.fonte).toBe('aberto');
    expect(vigente.priceCents).toBe(0);
  });
});

describe('o carrinho e a venda usam a MESMA conta', () => {
  it('POST /pricing/cart devolve o preço da faixa pela quantidade da linha', () => {
    setPriceTier(loja, refri, 3, 1000);

    const carrinho = priceCartForCustomer(loja, null, [{ productId: refri, quantity: 3 }]);
    expect(carrinho.items[0].priceCents).toBe(1000);
    expect(carrinho.items[0].fonte).toBe('faixa');
    // O preço de cadastro continua vindo, para a tela mostrar o "de/por".
    expect(carrinho.items[0].listPriceCents).toBe(PRECO);

    const uma = priceCartForCustomer(loja, null, [{ productId: refri, quantity: 1 }]);
    expect(uma.items[0].priceCents).toBe(PRECO);
  });

  it('A VENDA COBRA A FAIXA, e ela NÃO vira concessão de gestor', () => {
    setPriceTier(loja, refri, 3, 1000);
    applyMovement({
      companyId: loja,
      productId: refri,
      movementType: 'in',
      quantity: 50,
      kind: 'MANUAL_ENTRY',
      referenceType: 'carga',
      referenceId: 'carga-refri',
      reason: 'carga do teste',
    });

    const { sale, concessao } = createSale({
      companyId: loja,
      userId: 'u-caixa',
      idempotencyKey: randomUUID(),
      items: [{ productId: refri, quantity: 3 }],
      payments: [{ method: 'dinheiro', amountCents: 3000 }],
    });

    // 3 × R$ 10,00, e não 3 × R$ 12,00.
    expect(sale.total_cents).toBe(3000);
    /*
      O PONTO QUE DECIDE SE A FUNCIONALIDADE NASCE USÁVEL.

      Sem a faixa dentro do preço vigente, o teto da linha continuaria sendo
      R$ 12,00, os R$ 2,00 de diferença seriam medidos como concessão, e o
      atacadinho pararia o caixa chamando gerente a cada venda de três. É o
      mesmo raciocínio que pôs a tabela de preço no denominador.
    */
    expect(concessao?.concedidoCents).toBe(0);
  });
});

describe('o cadastro da faixa recusa o que não é oferta', () => {
  it('faixa a partir de 1 é o preço de venda com outro nome', () => {
    const erro = erroDe(() => setPriceTier(loja, refri, 1, 1000));
    expect(erro.code).toBe('CORE_PRICE_TIER_QUANTITY');
    expect(erro.message).toContain('a partir de 2');
  });

  it('quantidade zero ou negativa não é faixa', () => {
    expect(erroDe(() => setPriceTier(loja, refri, 0, 1000)).code).toBe('CORE_PRICE_TIER_QUANTITY');
    expect(erroDe(() => setPriceTier(loja, refri, -3, 1000)).code).toBe(
      'CORE_PRICE_TIER_QUANTITY',
    );
  });

  it('preço zero, negativo ou fracionado é recusado — dinheiro é centavo inteiro', () => {
    expect(erroDe(() => setPriceTier(loja, refri, 3, 0)).code).toBe('CORE_PRICE_TIER_PRICE');
    expect(erroDe(() => setPriceTier(loja, refri, 3, -100)).code).toBe('CORE_PRICE_TIER_PRICE');
    expect(erroDe(() => setPriceTier(loja, refri, 3, 999.5)).code).toBe('CORE_PRICE_TIER_PRICE');
  });

  it('faixa MAIS CARA que o preço de venda é armadilha, e é recusada', () => {
    const erro = erroDe(() => setPriceTier(loja, refri, 3, PRECO + 1));
    expect(erro.code).toBe('CORE_PRICE_TIER_ABOVE_LIST');
    // Ela nunca venceria a disputa do menor preço: ficaria gravada, visível e
    // sem nenhum efeito — a definição do campo decorativo.
    expect(listPriceTiers(loja, refri)).toHaveLength(0);
  });

  it('produto de outra empresa não recebe faixa', () => {
    const gringa = upsertCompany({
      slug: 'gringa',
      legalName: 'Gringa Ltda',
      tradeName: 'Gringa',
      kind: 'store',
    });
    expect(erroDe(() => setPriceTier(gringa, refri, 3, 1000)).code).toBe('CORE_PRODUCT_NOT_FOUND');
  });
});
