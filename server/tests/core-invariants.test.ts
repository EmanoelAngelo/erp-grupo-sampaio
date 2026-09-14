/**
 * Testes comportamentais dos invariantes do núcleo.
 *
 * Não verificam a existência de código (regex/readSrc) — executam as
 * operações reais contra o banco e checam o estado resultante.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_DATABASE_PATH = ':memory:';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

const { getConnection } = await import('../src/db/sqlite.js');
const { ensureCoreSchema } = await import('../src/db/schema.js');
const { resetDbForTests } = await import('../src/db/database.js');
const { applyMovement, getBalance, listStock } = await import(
  '../src/services/core/InventoryService.js'
);
const { createSale, cancelSale, getSaleDetail } = await import(
  '../src/services/core/SalesService.js'
);
const { upsertCompany, upsertUser, linkUserToCompany, listMemberships, assertMembership } =
  await import('../src/services/auth/IdentityService.js');
const { hashPassword, verifyPassword } = await import('../src/services/auth/PasswordService.js');

let companyA: string;
let companyB: string;
let productA: string;
let userId: string;

function createProduct(companyId: string, name: string, priceCents: number): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  getConnection()
    .prepare(
      `INSERT INTO core_products
         (id, company_id, internal_code, name, unit, cost_cents, price_cents,
          min_stock, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'UN', 0, ?, 0, 1, ?, ?)`,
    )
    .run(id, companyId, `COD-${id.slice(0, 6)}`, name, priceCents, now, now);
  return id;
}

beforeEach(async () => {
  ensureCoreSchema();
  resetDbForTests();
  companyA = upsertCompany({ slug: 'preco-justo', legalName: 'Preço Justo Ltda', tradeName: 'Preço Justo' });
  companyB = upsertCompany({ slug: 'gringa', legalName: 'Gringa Ltda', tradeName: 'Gringa' });
  productA = createProduct(companyA, 'Camiseta', 5000);
  userId = await upsertUser({ login: 'TESTE', displayName: 'Teste', password: 'senha-teste-123' });
  linkUserToCompany(userId, companyA, 'operador_caixa_loja', true);
});

describe('estoque', () => {
  it('não permite saldo negativo', () => {
    applyMovement({
      companyId: companyA,
      productId: productA,
      movementType: 'in',
      quantity: 3,
      referenceType: 'entrada',
      referenceId: 'nf-1',
    });
    expect(getBalance(companyA, productA)).toBe(3);

    expect(() =>
      applyMovement({
        companyId: companyA,
        productId: productA,
        movementType: 'out',
        quantity: 5,
        referenceType: 'ajuste',
        referenceId: 'aj-1',
      }),
    ).toThrow(/Estoque insuficiente/);

    // O saldo permanece intacto após a tentativa rejeitada.
    expect(getBalance(companyA, productA)).toBe(3);
  });

  it('é idempotente: a mesma referência não baixa duas vezes', () => {
    applyMovement({
      companyId: companyA,
      productId: productA,
      movementType: 'in',
      quantity: 10,
      referenceType: 'entrada',
      referenceId: 'nf-2',
    });
    const first = applyMovement({
      companyId: companyA,
      productId: productA,
      movementType: 'out',
      quantity: 4,
      referenceType: 'venda',
      referenceId: 'venda-x',
    });
    const second = applyMovement({
      companyId: companyA,
      productId: productA,
      movementType: 'out',
      quantity: 4,
      referenceType: 'venda',
      referenceId: 'venda-x',
    });

    expect(first.duplicated).toBe(false);
    expect(second.duplicated).toBe(true);
    expect(getBalance(companyA, productA)).toBe(6);
  });

  it('mantém o estoque isolado entre empresas', () => {
    const productB = createProduct(companyB, 'Camiseta Gringa', 7000);
    applyMovement({
      companyId: companyA,
      productId: productA,
      movementType: 'in',
      quantity: 5,
      referenceType: 'entrada',
      referenceId: 'nf-a',
    });
    applyMovement({
      companyId: companyB,
      productId: productB,
      movementType: 'in',
      quantity: 9,
      referenceType: 'entrada',
      referenceId: 'nf-b',
    });

    expect(getBalance(companyA, productA)).toBe(5);
    expect(getBalance(companyB, productB)).toBe(9);

    const stockA = listStock(companyA);
    expect(stockA).toHaveLength(1);
    expect(stockA[0]!.name).toBe('Camiseta');
  });
});

describe('vendas', () => {
  beforeEach(() => {
    applyMovement({
      companyId: companyA,
      productId: productA,
      movementType: 'in',
      quantity: 10,
      referenceType: 'entrada',
      referenceId: 'nf-inicial',
    });
  });

  it('baixa o estoque uma vez e gera um único lançamento financeiro', () => {
    const { sale } = createSale({
      companyId: companyA,
      userId,
      idempotencyKey: 'venda-1',
      items: [{ productId: productA, quantity: 2 }],
      payments: [{ method: 'dinheiro', amountCents: 10000 }],
    });

    expect(sale.total_cents).toBe(10000);
    expect(getBalance(companyA, productA)).toBe(8);

    const entries = getConnection()
      .prepare("SELECT * FROM core_finance_entries WHERE origin_type = 'sale' AND origin_id = ?")
      .all(sale.id) as unknown[];
    expect(entries).toHaveLength(1);
  });

  it('reenviar a mesma venda não duplica nada', () => {
    const first = createSale({
      companyId: companyA,
      userId,
      idempotencyKey: 'venda-repetida',
      items: [{ productId: productA, quantity: 3 }],
      payments: [{ method: 'dinheiro', amountCents: 15000 }],
    });
    const second = createSale({
      companyId: companyA,
      userId,
      idempotencyKey: 'venda-repetida',
      items: [{ productId: productA, quantity: 3 }],
      payments: [{ method: 'dinheiro', amountCents: 15000 }],
    });

    expect(second.duplicated).toBe(true);
    expect(second.sale.id).toBe(first.sale.id);
    expect(getBalance(companyA, productA)).toBe(7);

    const sales = getConnection()
      .prepare('SELECT COUNT(*) AS n FROM core_sales WHERE company_id = ?')
      .get(companyA) as { n: number };
    expect(sales.n).toBe(1);
  });

  it('rejeita a venda quando o pagamento não fecha com o total', () => {
    expect(() =>
      createSale({
        companyId: companyA,
        userId,
        idempotencyKey: 'venda-errada',
        items: [{ productId: productA, quantity: 1 }],
        payments: [{ method: 'dinheiro', amountCents: 100 }],
      }),
      // A mensagem diz ao operador quanto ainda falta, em reais — e em REAIS
      // de verdade (E-venda-servidor-15): antes saía "Falta 49.00", sem R$ e
      // com ponto decimal, o único valor do arquivo fora de `emReais`.
    ).toThrow(/Falta R\$ 49,00/);

    // A transação inteira reverteu: o estoque não foi tocado.
    expect(getBalance(companyA, productA)).toBe(10);
  });

  it('não deixa a venda ser feita com produto de outra empresa', () => {
    const productB = createProduct(companyB, 'Item Gringa', 3000);
    expect(() =>
      createSale({
        companyId: companyA,
        userId,
        idempotencyKey: 'venda-cross-tenant',
        items: [{ productId: productB, quantity: 1 }],
        payments: [{ method: 'dinheiro', amountCents: 3000 }],
      }),
    ).toThrow(/não encontrado/);
  });

  it('cancelamento repõe o estoque exatamente uma vez', () => {
    const { sale } = createSale({
      companyId: companyA,
      userId,
      idempotencyKey: 'venda-cancelar',
      items: [{ productId: productA, quantity: 4 }],
      payments: [{ method: 'dinheiro', amountCents: 20000 }],
    });
    expect(getBalance(companyA, productA)).toBe(6);

    // O motivo passou a ser obrigatório (E-venda-servidor-M01): o
    // cancelamento tira dinheiro da gaveta e desfaz estoque e comissão, e a
    // trilha sem motivo não respondia "por que esta venda sumiu?".
    cancelSale({ companyId: companyA, saleId: sale.id, userId, reason: 'erro de digitação' });
    expect(getBalance(companyA, productA)).toBe(10);

    // Cancelar de novo é inofensivo.
    cancelSale({ companyId: companyA, saleId: sale.id, userId, reason: 'de novo' });
    expect(getBalance(companyA, productA)).toBe(10);

    const detail = getSaleDetail(companyA, sale.id)!;
    expect(detail.status).toBe('cancelled');
  });

  it('usa o preço do cadastro, ignorando preço arbitrário do cliente', () => {
    const { sale } = createSale({
      companyId: companyA,
      userId,
      idempotencyKey: 'venda-preco',
      items: [{ productId: productA, quantity: 1 }],
      // Paga de verdade. Este teste é sobre PREÇO; a lista vazia era só
      // conveniência, e desde que venda sem pagamento exige cliente
      // identificado ela deixou de ser um atalho inofensivo.
      payments: [{ method: 'dinheiro', amountCents: 5000 }],
    });
    // Produto cadastrado a R$ 50,00.
    expect(sale.total_cents).toBe(5000);
  });
});

describe('concorrência entre dois PDVs', () => {
  it('dois caixas vendendo o último item: apenas um conclui', () => {
    applyMovement({
      companyId: companyA,
      productId: productA,
      movementType: 'in',
      quantity: 1,
      referenceType: 'entrada',
      referenceId: 'nf-ultimo',
    });

    const attempt = (key: string) =>
      createSale({
        companyId: companyA,
        userId,
        idempotencyKey: key,
        items: [{ productId: productA, quantity: 1 }],
        payments: [{ method: 'dinheiro', amountCents: 5000 }],
      });

    const results = [attempt('pdv-1'), null] as unknown[];
    let failed = 0;
    try {
      attempt('pdv-2');
    } catch (err) {
      failed += 1;
      expect(String(err)).toMatch(/Estoque insuficiente/);
    }

    expect(results[0]).toBeTruthy();
    expect(failed).toBe(1);
    expect(getBalance(companyA, productA)).toBe(0);

    const sales = getConnection()
      .prepare("SELECT COUNT(*) AS n FROM core_sales WHERE company_id = ? AND status = 'completed'")
      .get(companyA) as { n: number };
    expect(sales.n).toBe(1);
  });
});

describe('identidade e escopo', () => {
  it('não vaza empresa à qual o usuário não pertence', () => {
    const memberships = listMemberships(userId);
    expect(memberships).toHaveLength(1);
    expect(memberships[0]!.company_id).toBe(companyA);
    expect(assertMembership(userId, companyB)).toBeNull();
    expect(assertMembership(userId, companyA)).not.toBeNull();
  });

  it('senha é verificada com Argon2id', async () => {
    const hash = await hashPassword('minha-senha-forte');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect((await verifyPassword('minha-senha-forte', hash)).valid).toBe(true);
    expect((await verifyPassword('senha-errada', hash)).valid).toBe(false);
  });

  it('aceita hash legado SHA-256 uma vez e sinaliza reescrita', async () => {
    const { createHash } = await import('node:crypto');
    const legacy = createHash('sha256').update('senha-antiga', 'utf8').digest('hex');
    const result = await verifyPassword('senha-antiga', legacy);
    expect(result.valid).toBe(true);
    expect(result.needsRehash).toBe(true);
  });
});
