/**
 * DINHEIRO É INTEIRO — e a soma tem de fechar no centavo.
 *
 * ============================================================================
 * O QUE ESTE ARQUIVO É
 * ============================================================================
 *
 * Não é teste de um defeito: é a rede que impede a próxima divisão a dividir
 * mal. Os defeitos monetários deste sistema — o extrato multiplicado por cem, o
 * resíduo da comissão em devolução parcelada, o estorno somando com o sinal
 * trocado — têm todos a mesma assinatura: **o número sai plausível**. Ninguém
 * abre o banco para conferir R$ 594,00.
 *
 * Por isso cada conta aqui está escrita À MÃO, parcela por parcela. Se o valor
 * esperado viesse da mesma função que o produz, o teste provaria só que ela é
 * igual a si mesma.
 *
 * ============================================================================
 * OS CASOS
 * ============================================================================
 *
 * R$ 0,01 (o menor valor que existe), parcelamento com resto, desconto,
 * acréscimo, e a baixa em duplicidade — a única forma de o mesmo dinheiro
 * entrar duas vezes.
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
const { upsertCompany, upsertUser, linkUserToCompany } = await import(
  '../src/services/auth/IdentityService.js'
);
const { createProduct } = await import('../src/services/core/CatalogService.js');
const { applyMovement } = await import('../src/services/core/InventoryService.js');
const { createSale } = await import('../src/services/core/SalesService.js');
const { createEntry, settleEntry, listEntries, summarize } = await import(
  '../src/services/core/FinanceService.js'
);
const { createAcquirer, setRate, planForPayment } = await import(
  '../src/services/core/AcquirerService.js'
);

let empresa: string;
let usuario: string;

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  empresa = upsertCompany({
    slug: 'preco-justo',
    legalName: 'Preço Justo Ltda',
    tradeName: 'Preço Justo',
    kind: 'store',
  });
  usuario = await upsertUser({
    login: 'CAIXA_CENT',
    displayName: 'Caixa',
    password: 'Teste@Cent2026',
  });
  linkUserToCompany(usuario, empresa, 'operador_caixa_loja', true);
});

/** Um produto com preço em centavos exatos, e estoque para vender. */
function produtoDe(priceCents: number, nome = 'Item'): string {
  const id = createProduct(empresa, { name: nome, priceCents }).id;
  applyMovement({
    companyId: empresa,
    productId: id,
    movementType: 'in',
    quantity: 100,
    referenceType: 'ajuste',
    referenceId: `e-${id}`,
  });
  return id;
}

// ============================================================================

describe('um centavo', () => {
  it('a venda de R$ 0,01 acontece, e vale um centavo', () => {
    const produto = produtoDe(1, 'Bala');
    const { sale } = createSale({
      companyId: empresa,
      userId: usuario,
      items: [{ productId: produto, quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: 1 }],
      idempotencyKey: 'v-centavo',
    });

    expect(sale.total_cents).toBe(1);
    expect(sale.change_cents).toBe(0);
  });

  it('cem itens de um centavo somam exatamente um real', () => {
    const produto = produtoDe(1, 'Bala');
    const { sale } = createSale({
      companyId: empresa,
      userId: usuario,
      items: [{ productId: produto, quantity: 100 }],
      payments: [{ method: 'dinheiro', amountCents: 100 }],
      idempotencyKey: 'v-cem-balas',
    });

    // Cem vezes um centavo é R$ 1,00 — e não 0,9999999999999999.
    expect(sale.total_cents).toBe(100);
  });

  it('a conta de um centavo é lançada e baixada sem sobrar nada', () => {
    const conta = createEntry({
      companyId: empresa,
      direction: 'in',
      amountCents: 1,
      description: 'Diferença de caixa',
      dueDate: '2026-08-31',
    });

    settleEntry({ companyId: empresa, entryId: conta.id, amountCents: 1, method: 'dinheiro' });

    expect(summarize(empresa, 'in').openCents).toBe(0);
  });
});

// ============================================================================

describe('parcelamento com resto', () => {
  beforeEach(() => {
    const adquirente = createAcquirer(empresa, { name: 'Operadora' });
    // Sem taxa, para o resto aparecer sozinho no número.
    setRate(empresa, {
      acquirerId: adquirente.id,
      paymentMethod: 'credito',
      installments: 3,
      feeBps: 0,
      settlementDays: 30,
    });
  });

  it('R$ 100,00 em 3× soma R$ 100,00 — e o centavo sobrando vai na primeira', () => {
    const plano = planForPayment(empresa, {
      paymentMethod: 'credito',
      amountCents: 10_000,
      installments: 3,
      saleDate: '2026-08-31',
    });

    expect(plano).toBeTruthy();
    // 10000 / 3 = 3333,33... → 3334 + 3333 + 3333.
    expect(plano!.installments.map((p) => p.grossCents)).toEqual([3_334, 3_333, 3_333]);
    expect(plano!.installments.reduce((s, p) => s + p.grossCents, 0)).toBe(10_000);
  });

  it('R$ 0,02 em 3× não cria parcela negativa nem perde o centavo', () => {
    const plano = planForPayment(empresa, {
      paymentMethod: 'credito',
      amountCents: 2,
      installments: 3,
      saleDate: '2026-08-31',
    });

    expect(plano!.installments.map((p) => p.grossCents)).toEqual([2, 0, 0]);
    expect(plano!.installments.reduce((s, p) => s + p.grossCents, 0)).toBe(2);
  });

  it('cada parcela vence um período depois da anterior', () => {
    const plano = planForPayment(empresa, {
      paymentMethod: 'credito',
      amountCents: 10_000,
      installments: 3,
      saleDate: '2026-08-31',
    });

    expect(plano!.installments.map((p) => p.dueDate)).toEqual([
      '2026-09-30',
      '2026-10-30',
      '2026-11-29',
    ]);
  });

  it('a taxa é calculada por parcela e somada, sem arredondar duas vezes', () => {
    const adquirente = createAcquirer(empresa, { name: 'Outra' });
    // 2,99% — a taxa que produz dízima em quase todo valor.
    setRate(empresa, {
      acquirerId: adquirente.id,
      paymentMethod: 'debito',
      installments: 1,
      feeBps: 299,
      settlementDays: 1,
    });

    const plano = planForPayment(empresa, {
      paymentMethod: 'debito',
      amountCents: 10_000,
      installments: 1,
      saleDate: '2026-08-31',
    });

    // 2,99% de R$ 100,00 = R$ 2,99, exatos.
    expect(plano!.installments[0].feeCents).toBe(299);
    expect(plano!.totalFeeCents).toBe(299);
  });
});

// ============================================================================

/** O subtotal não vem no retorno de `createSale`: ele mora na linha. */
function subtotalDe(saleId: string): number {
  return Number(
    (
      getConnection()
        .prepare('SELECT subtotal_cents FROM core_sales WHERE id = ?')
        .get(saleId) as { subtotal_cents: number }
    ).subtotal_cents,
  );
}

describe('desconto e acréscimo fecham a conta', () => {
  it('subtotal − desconto = total, no centavo', () => {
    const produto = produtoDe(3_333, 'Peça');
    const { sale } = createSale({
      companyId: empresa,
      userId: usuario,
      items: [{ productId: produto, quantity: 3 }],
      discountCents: 999,
      payments: [{ method: 'dinheiro', amountCents: 9_000 }],
      idempotencyKey: 'v-desconto',
    });

    // 3 × 3333 = 9999; 9999 − 999 = 9000.
    expect([subtotalDe(sale.id), sale.total_cents]).toEqual([9_999, 9_000]);
    expect(sale.change_cents).toBe(0);
  });

  it('o acréscimo entra no total, e não no subtotal', () => {
    const produto = produtoDe(5_000, 'Peça');
    const { sale } = createSale({
      companyId: empresa,
      userId: usuario,
      items: [{ productId: produto, quantity: 1 }],
      surchargeCents: 137,
      payments: [{ method: 'dinheiro', amountCents: 5_137 }],
      idempotencyKey: 'v-acrescimo',
    });

    expect([subtotalDe(sale.id), sale.total_cents]).toEqual([5_000, 5_137]);
  });

  it('desconto e acréscimo juntos fecham na mesma linha', () => {
    const produto = produtoDe(5_000, 'Peça');
    const { sale } = createSale({
      companyId: empresa,
      userId: usuario,
      items: [{ productId: produto, quantity: 2 }],
      discountCents: 1_000,
      surchargeCents: 250,
      payments: [{ method: 'dinheiro', amountCents: 9_250 }],
      idempotencyKey: 'v-dois',
    });

    // 10000 − 1000 + 250 = 9250.
    expect(sale.total_cents).toBe(9_250);
  });
});

// ============================================================================

describe('o mesmo dinheiro não entra duas vezes', () => {
  it('duas baixas não passam do valor devido', () => {
    const conta = createEntry({
      companyId: empresa,
      direction: 'in',
      amountCents: 10_000,
      description: 'Parcela',
      dueDate: '2026-08-31',
    });

    settleEntry({ companyId: empresa, entryId: conta.id, amountCents: 10_000, method: 'pix' });

    /*
      A segunda baixa do mesmo valor é o clique repetido, ou dois caixas na
      mesma conta. A trava é o UPDATE CONDICIONAL do próprio serviço: conferir
      antes e gravar depois deixaria uma janela entre as duas coisas.
    */
    expect(() =>
      settleEntry({ companyId: empresa, entryId: conta.id, amountCents: 10_000, method: 'pix' }),
    ).toThrow();

    const [entrada] = listEntries(empresa, { direction: 'in' });
    expect([entrada.settledCents, entrada.balanceCents]).toEqual([10_000, 0]);
  });

  it('baixa parcial soma até fechar, e nem um centavo além', () => {
    const conta = createEntry({
      companyId: empresa,
      direction: 'in',
      amountCents: 10_000,
      description: 'Parcela',
      dueDate: '2026-08-31',
    });

    settleEntry({ companyId: empresa, entryId: conta.id, amountCents: 3_333, method: 'dinheiro' });
    settleEntry({ companyId: empresa, entryId: conta.id, amountCents: 3_333, method: 'dinheiro' });
    settleEntry({ companyId: empresa, entryId: conta.id, amountCents: 3_334, method: 'dinheiro' });

    expect(summarize(empresa, 'in').openCents).toBe(0);
    expect(() =>
      settleEntry({ companyId: empresa, entryId: conta.id, amountCents: 1, method: 'dinheiro' }),
    ).toThrow();
  });

  it('a venda reenviada com a mesma chave não vira duas vendas', () => {
    const produto = produtoDe(5_000, 'Peça');
    const primeira = createSale({
      companyId: empresa,
      userId: usuario,
      items: [{ productId: produto, quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: 5_000 }],
      idempotencyKey: 'v-repetida',
    });
    const segunda = createSale({
      companyId: empresa,
      userId: usuario,
      items: [{ productId: produto, quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: 5_000 }],
      idempotencyKey: 'v-repetida',
    });

    expect(segunda.duplicated).toBe(true);
    expect(segunda.sale.id).toBe(primeira.sale.id);

    const total = getConnection()
      .prepare('SELECT COUNT(*) AS n FROM core_sales WHERE company_id = ?')
      .get(empresa) as { n: number };
    expect(total.n).toBe(1);
  });
});

// ============================================================================

describe('a devolução devolve o que entrou, no centavo (GAP-PRD-009, GAP-PRD-050)', () => {
  it('3 un. por R$ 29,99 devolvidas 1 + 1 + 1: 1000 + 999 + 1000 = 2999, e não 3000', async () => {
    const { createSaleReturn } = await import('../src/services/core/SaleReturnService.js');
    const produto = produtoDe(1_000, 'Pacote');
    const { sale } = createSale({
      companyId: empresa,
      userId: usuario,
      items: [{ productId: produto, quantity: 3, discountCents: 1 }],
      payments: [{ method: 'dinheiro', amountCents: 2_999 }],
      idempotencyKey: 'v-tres-parciais',
    });
    const linha = getConnection()
      .prepare('SELECT id FROM core_sale_items WHERE sale_id = ?')
      .get(sale.id) as { id: string };

    const valores = [1, 2, 3].map(
      () =>
        createSaleReturn({
          companyId: empresa,
          userId: usuario,
          saleId: sale.id,
          reason: 'Devolução parcial',
          refundMethod: 'pix',
          items: [{ saleItemId: linha.id, quantity: 1 }],
        }).total_cents,
    );
    expect(valores).toEqual([1_000, 999, 1_000]);
  });

  it('R$ 200 com R$ 10 de desconto no rodapé: devolver tudo devolve R$ 190, o que entrou', async () => {
    const { createSaleReturn } = await import('../src/services/core/SaleReturnService.js');
    const produto = produtoDe(10_000, 'Camisa');
    const { sale } = createSale({
      companyId: empresa,
      userId: usuario,
      items: [{ productId: produto, quantity: 2 }],
      discountCents: 1_000,
      payments: [{ method: 'dinheiro', amountCents: 19_000 }],
      idempotencyKey: 'v-desconto-rodape',
    });
    expect(sale.total_cents).toBe(19_000);
    const linha = getConnection()
      .prepare('SELECT id FROM core_sale_items WHERE sale_id = ?')
      .get(sale.id) as { id: string };

    const devolucao = createSaleReturn({
      companyId: empresa,
      userId: usuario,
      saleId: sale.id,
      reason: 'Devolução total',
      refundMethod: 'pix',
      items: [{ saleItemId: linha.id, quantity: 2 }],
    });
    expect(devolucao.total_cents).toBe(19_000);
  });
});
