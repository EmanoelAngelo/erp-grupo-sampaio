/**
 * A razão de estoque precisa contar a história certa.
 *
 * Antes só existia `balance_after`: dava para ver onde o saldo parou, mas não
 * de onde saiu nem por quê. Sem o saldo anterior a conta não fecha, e com
 * in/out/adjust genéricos o gestor não distingue uma entrada de nota de um
 * acerto de inventário.
 *
 * Os cenários abaixo são os pedidos pelo dono do produto, na ordem em que ele
 * os descreveu.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_DATABASE_PATH = ':memory:';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

const { ensureCoreSchema } = await import('../src/db/schema.js');
const { resetDbForTests } = await import('../src/db/database.js');
const { createProduct } = await import('../src/services/core/CatalogService.js');
const { applyMovement, getAvailable, getBalance, listMovements } = await import(
  '../src/services/core/InventoryService.js'
);
const { createSale, cancelSale } = await import('../src/services/core/SalesService.js');
const { createQuote, cancelQuote } = await import('../src/services/core/QuoteService.js');
const { generateVariants } = await import('../src/services/core/VariantService.js');
const { upsertCompany, upsertUser, linkUserToCompany } = await import(
  '../src/services/auth/IdentityService.js'
);

let companyId: string;
let produto: string;
let userId: string;

beforeEach(async () => {
  ensureCoreSchema();
  resetDbForTests();
  companyId = upsertCompany({
    slug: 'preco-justo',
    legalName: 'Preço Justo Ltda',
    tradeName: 'Preço Justo',
  });
  userId = await upsertUser({
    login: 'ESTOQUISTA',
    displayName: 'Ana Estoquista',
    password: 'senha-teste-123',
  });
  linkUserToCompany(userId, companyId, 'operador_caixa_loja', true);
  produto = String(createProduct(companyId, { name: 'Camiseta Polo', priceCents: 5000 }).id);
});

/** Movimentos do mais antigo para o mais novo, que é como se lê história. */
function historico(productId = produto) {
  return listMovements(companyId, { productId }).reverse();
}

describe('a conta tem que fechar: anterior + delta = posterior', () => {
  it('cada movimento guarda o saldo anterior', () => {
    applyMovement({
      companyId,
      productId: produto,
      movementType: 'in',
      quantity: 10,
      referenceType: 'entrada',
      referenceId: 'carga',
      userId,
    });

    const [primeiro] = historico();
    expect(primeiro.quantity_before).toBe(0);
    expect(primeiro.quantity).toBe(10);
    expect(primeiro.balance_after).toBe(10);
  });

  it('a conta fecha em toda a sequência', () => {
    for (const [i, qtd] of [10, 5, 3].entries()) {
      applyMovement({
        companyId,
        productId: produto,
        movementType: 'in',
        quantity: qtd,
        referenceType: 'entrada',
        referenceId: `nf-${i}`,
        userId,
      });
    }

    for (const mov of historico()) {
      expect(Number(mov.quantity_before) + Number(mov.quantity)).toBe(Number(mov.balance_after));
    }
  });

  it('o saldo posterior de um é o anterior do próximo', () => {
    applyMovement({
      companyId,
      productId: produto,
      movementType: 'in',
      quantity: 10,
      referenceType: 'entrada',
      referenceId: 'a',
      userId,
    });
    applyMovement({
      companyId,
      productId: produto,
      movementType: 'out',
      quantity: 4,
      referenceType: 'saida',
      referenceId: 'b',
      userId,
    });

    const [um, dois] = historico();
    expect(dois.quantity_before).toBe(um.balance_after);
  });
});

describe('cenário do dono: entrada XML, venda e cancelamento', () => {
  it('conta a história inteira com os tipos certos', () => {
    // estoque inicial 10
    applyMovement({
      companyId,
      productId: produto,
      movementType: 'in',
      quantity: 10,
      referenceType: 'entrada',
      referenceId: 'inicial',
      kind: 'MANUAL_ENTRY',
      userId,
    });

    // entrada por XML: +5
    applyMovement({
      companyId,
      productId: produto,
      movementType: 'in',
      quantity: 5,
      referenceType: 'nfe_entrada',
      referenceId: 'nota-1',
      kind: 'XML_RECEIPT',
      documentNumber: 'NF-e 000123',
      userId,
    });

    const { sale } = createSale({
      companyId,
      userId,
      idempotencyKey: randomUUID(),
      items: [{ productId: produto, quantity: 2 }],
      payments: [{ method: 'dinheiro', amountCents: 10000 }],
    });

    cancelSale({ companyId, userId, saleId: sale.id, reason: 'cliente desistiu' });

    const linhas = historico();
    const xml = linhas.find((m) => m.kind === 'XML_RECEIPT')!;
    const venda = linhas.find((m) => m.kind === 'SALE')!;
    const cancelamento = linhas.find((m) => m.kind === 'SALE_CANCEL')!;

    expect([xml.quantity_before, xml.quantity, xml.balance_after]).toEqual([10, 5, 15]);
    expect([venda.quantity_before, venda.quantity, venda.balance_after]).toEqual([15, -2, 13]);
    expect([cancelamento.quantity_before, cancelamento.quantity, cancelamento.balance_after]).toEqual([
      13, 2, 15,
    ]);

    expect(xml.document_number).toBe('NF-e 000123');
    expect(getBalance(companyId, produto)).toBe(15);
  });

  it('o rótulo do tipo sai pronto para a tela', () => {
    applyMovement({
      companyId,
      productId: produto,
      movementType: 'in',
      quantity: 1,
      referenceType: 'nfe_entrada',
      referenceId: 'n1',
      kind: 'XML_RECEIPT',
      userId,
    });
    expect(historico()[0].kind_label).toBe('Entrada por XML');
  });

  it('quem lançou aparece com nome, não com id', () => {
    applyMovement({
      companyId,
      productId: produto,
      movementType: 'in',
      quantity: 1,
      referenceType: 'entrada',
      referenceId: 'n1',
      userId,
    });
    expect(historico()[0].user_name).toBe('Ana Estoquista');
    expect(historico()[0].product_name).toBe('Camiseta Polo');
  });
});

describe('cenário do dono: variante', () => {
  it('o histórico aponta a variante exata, não o modelo', () => {
    const { created } = generateVariants({
      companyId,
      productId: produto,
      axes: { tamanho: ['P', 'M'], cor: ['Preto'] },
    });
    const p = created.find((v) => v.name.includes('P'))!;
    const m = created.find((v) => v.name.includes('M'))!;

    for (const [variante, qtd] of [
      [p, 3],
      [m, 4],
    ] as const) {
      applyMovement({
        companyId,
        productId: variante.id,
        movementType: 'in',
        quantity: qtd,
        referenceType: 'entrada',
        referenceId: `carga-${variante.id}`,
        userId,
      });
    }

    createSale({
      companyId,
      userId,
      idempotencyKey: randomUUID(),
      items: [{ productId: p.id, quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: 5000 }],
    });

    expect(getBalance(companyId, p.id)).toBe(2);
    expect(getBalance(companyId, m.id)).toBe(4);

    // A venda aparece SÓ no histórico do P.
    const vendasDoP = listMovements(companyId, { productId: p.id, kind: 'SALE' });
    const vendasDoM = listMovements(companyId, { productId: m.id, kind: 'SALE' });
    expect(vendasDoP).toHaveLength(1);
    expect(vendasDoM).toHaveLength(0);
    expect([vendasDoP[0].quantity_before, vendasDoP[0].balance_after]).toEqual([3, 2]);
  });
});

describe('reserva não é saldo físico', () => {
  it('reservar entra no histórico sem mexer no que está na prateleira', () => {
    applyMovement({
      companyId,
      productId: produto,
      movementType: 'in',
      quantity: 10,
      referenceType: 'entrada',
      referenceId: 'carga',
      userId,
    });

    createQuote({
      companyId,
      userId,
      kind: 'pre_venda',
      items: [{ productId: produto, quantity: 3 }],
    });

    // Físico intacto; disponível reduzido.
    expect(getBalance(companyId, produto)).toBe(10);
    expect(getAvailable(companyId, produto)).toBe(7);

    const reserva = historico().find((m) => m.kind === 'PRE_SALE_RESERVATION')!;
    expect(reserva.quantity).toBe(0);
    expect(reserva.balance_after).toBe(10);
    expect(reserva.reserved_delta).toBe(3);
    expect(reserva.reserved_after).toBe(3);
  });

  it('cancelar a pré-venda registra a liberação', () => {
    applyMovement({
      companyId,
      productId: produto,
      movementType: 'in',
      quantity: 10,
      referenceType: 'entrada',
      referenceId: 'carga',
      userId,
    });
    const doc = createQuote({
      companyId,
      userId,
      kind: 'pre_venda',
      items: [{ productId: produto, quantity: 3 }],
    });
    cancelQuote({ companyId, quoteId: doc.id, reason: 'desistiu' });

    const liberacao = historico().find((m) => m.kind === 'PRE_SALE_RELEASE')!;
    expect(liberacao.reserved_delta).toBe(-3);
    expect(liberacao.reserved_after).toBe(0);
    // O físico nunca se moveu.
    expect(liberacao.balance_after).toBe(10);
    expect(getBalance(companyId, produto)).toBe(10);
  });
});

describe('filtros da tela do gestor', () => {
  beforeEach(() => {
    applyMovement({
      companyId,
      productId: produto,
      movementType: 'in',
      quantity: 10,
      referenceType: 'nfe_entrada',
      referenceId: 'n1',
      kind: 'XML_RECEIPT',
      documentNumber: 'NF-e 555',
      unitCostCents: 2000,
      userId,
    });
    applyMovement({
      companyId,
      productId: produto,
      movementType: 'out',
      quantity: 1,
      referenceType: 'saida',
      referenceId: 's1',
      kind: 'MANUAL_EXIT',
      userId,
    });
  });

  it('filtra por tipo', () => {
    expect(listMovements(companyId, { kind: 'XML_RECEIPT' })).toHaveLength(1);
    expect(listMovements(companyId, { kind: ['XML_RECEIPT', 'MANUAL_EXIT'] })).toHaveLength(2);
  });

  it('filtra por documento', () => {
    expect(listMovements(companyId, { documentNumber: 'NF-e 555' })).toHaveLength(1);
  });

  it('filtra por usuário e por produto', () => {
    expect(listMovements(companyId, { userId })).toHaveLength(2);
    expect(listMovements(companyId, { productId: produto })).toHaveLength(2);
  });

  it('filtra por período', () => {
    const amanha = new Date(Date.now() + 86400000).toISOString();
    expect(listMovements(companyId, { from: amanha })).toHaveLength(0);
    expect(listMovements(companyId, { to: amanha })).toHaveLength(2);
  });

  it('busca por nome do produto', () => {
    expect(listMovements(companyId, { search: 'Camiseta' })).toHaveLength(2);
    expect(listMovements(companyId, { search: 'Bicicleta' })).toHaveLength(0);
  });
});

describe('mecânico não vê custo', () => {
  it('o custo é removido do resultado, não apenas escondido na tela', () => {
    applyMovement({
      companyId,
      productId: produto,
      movementType: 'in',
      quantity: 5,
      referenceType: 'nfe_entrada',
      referenceId: 'n1',
      unitCostCents: 2500,
      userId,
    });

    expect(listMovements(companyId, {})[0].unit_cost_cents).toBe(2500);
    expect(listMovements(companyId, { hideCost: true })[0].unit_cost_cents).toBeNull();
  });
});

describe('isolamento por operação', () => {
  it('o histórico de uma empresa não aparece na outra', () => {
    applyMovement({
      companyId,
      productId: produto,
      movementType: 'in',
      quantity: 5,
      referenceType: 'entrada',
      referenceId: 'n1',
      userId,
    });
    const outra = upsertCompany({
      slug: 'gringa',
      legalName: 'Gringa Ltda',
      tradeName: 'Gringa',
    });
    expect(listMovements(outra, {})).toHaveLength(0);
    expect(listMovements(companyId, {})).toHaveLength(1);
  });
});
