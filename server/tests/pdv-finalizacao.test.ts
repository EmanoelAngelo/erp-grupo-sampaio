/**
 * Fechamento de venda no PDV: pagamento dividido, troco e autorização
 * gerencial.
 *
 * São testes de comportamento — executam a venda de verdade contra o banco e
 * conferem o estado resultante (caixa, receita, estoque, autorização
 * registrada). Nenhum deles verifica a existência de código por regex.
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
const { applyMovement, getBalance } = await import('../src/services/core/InventoryService.js');
const { createSale } = await import('../src/services/core/SalesService.js');
const { openSession } = await import('../src/services/core/CashService.js');
const { upsertCompany, upsertUser, linkUserToCompany } = await import(
  '../src/services/auth/IdentityService.js'
);
const { authorizeAction, discountNeedsAuthorization, listAuthorizations } = await import(
  '../src/services/core/AuthorizationService.js'
);
// O limite deixou de ser constante deste módulo: ele é a política da empresa,
// e o padrão de quem nunca configurou mora no SalePolicyService.
const { PADRAO_LIMITE_DESCONTO_PERCENT } = await import(
  '../src/services/core/SalePolicyService.js'
);

const MANAGER_PASSWORD = 'Gerente@GrupoSampaio2026';

let companyA: string;
let companyB: string;
let produto: string;
let operador: string;
let gerente: string;
let caixaSessao: string;

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

/** Total em dinheiro que efetivamente entrou na gaveta por esta venda. */
function drawerCash(saleId: string): number {
  const row = getConnection()
    .prepare(
      `SELECT COALESCE(SUM(amount_cents), 0) AS total
         FROM core_cash_movements
        WHERE reference_type = 'sale' AND reference_id = ?`,
    )
    .get(saleId) as { total: number };
  return row.total;
}

/** Quanto a venda liquidou no financeiro. */
function settled(saleId: string): number {
  const row = getConnection()
    .prepare(
      `SELECT COALESCE(SUM(settled_cents), 0) AS total
         FROM core_finance_entries
        WHERE origin_type = 'sale' AND origin_id = ?`,
    )
    .get(saleId) as { total: number };
  return row.total;
}

beforeEach(async () => {
  ensureCoreSchema();
  resetDbForTests();
  companyA = upsertCompany({ slug: 'preco-justo', legalName: 'Preço Justo Ltda', tradeName: 'Preço Justo' });
  companyB = upsertCompany({ slug: 'gringa', legalName: 'Gringa Ltda', tradeName: 'Gringa' });
  produto = createProduct(companyA, 'Camiseta', 5000);

  operador = await upsertUser({ login: 'CAIXA1', displayName: 'Caixa 1', password: 'senha-caixa-123' });
  linkUserToCompany(operador, companyA, 'operador_caixa_loja', true);

  gerente = await upsertUser({ login: 'GERENTE1', displayName: 'Ana Gerente', password: MANAGER_PASSWORD });
  linkUserToCompany(gerente, companyA, 'gerente_loja', true);

  applyMovement({
    companyId: companyA,
    productId: produto,
    movementType: 'in',
    quantity: 20,
    referenceType: 'entrada',
    referenceId: 'carga-inicial',
  });

  caixaSessao = openSession({ companyId: companyA, userId: operador, openingCents: 0 }).id;
});

function vender(overrides: Record<string, unknown> = {}) {
  return createSale({
    companyId: companyA,
    userId: operador,
    idempotencyKey: randomUUID(),
    items: [{ productId: produto, quantity: 1, unitPriceCents: 5000 }],
    payments: [{ method: 'dinheiro', amountCents: 5000 }],
    cashSessionId: caixaSessao,
    ...overrides,
  } as Parameters<typeof createSale>[0]);
}

describe('troco', () => {
  it('devolve o troco quando o cliente paga a mais em dinheiro', () => {
    const { sale } = vender({ payments: [{ method: 'dinheiro', amountCents: 10000 }] });
    expect(sale.total_cents).toBe(5000);
    expect(sale.change_cents).toBe(5000);
  });

  it('a gaveta recebe o valor líquido, não o valor entregue pelo cliente', () => {
    const { sale } = vender({ payments: [{ method: 'dinheiro', amountCents: 10000 }] });
    // R$ 100 na mão, R$ 50 de troco: sobram R$ 50 na gaveta.
    expect(drawerCash(sale.id)).toBe(5000);
  });

  it('troco não vira receita', () => {
    const { sale } = vender({ payments: [{ method: 'dinheiro', amountCents: 10000 }] });
    // O que é reconhecido como receita é o total da venda, nunca o valor
    // entregue no balcão.
    expect(settled(sale.id)).toBe(5000);
  });

  it('troco entregue em duas cédulas sai uma vez só da gaveta', () => {
    // R$ 30 + R$ 30 para uma venda de R$ 50: troco de R$ 10, gaveta fica
    // com R$ 50. Descontar o troco de cada cédula deixaria R$ 40.
    const { sale } = vender({
      payments: [
        { method: 'dinheiro', amountCents: 3000 },
        { method: 'dinheiro', amountCents: 3000 },
      ],
    });
    expect(sale.change_cents).toBe(1000);
    expect(drawerCash(sale.id)).toBe(5000);
  });

  it('não existe troco sobre cartão ou pix', () => {
    expect(() =>
      vender({ payments: [{ method: 'credito', amountCents: 10000 }] }),
    ).toThrowError(/troco/i);
  });

  it('pagamento dividido fecha a venda quando a soma bate', () => {
    const { sale } = vender({
      payments: [
        { method: 'pix', amountCents: 2000 },
        { method: 'credito', amountCents: 2000 },
        { method: 'dinheiro', amountCents: 1000 },
      ],
    });
    expect(sale.change_cents).toBe(0);
    expect(settled(sale.id)).toBe(5000);
  });

  it('pagamento dividido a menos não fecha a venda', () => {
    expect(() =>
      vender({
        payments: [
          { method: 'pix', amountCents: 2000 },
          { method: 'credito', amountCents: 1000 },
        ],
      }),
    ).toThrowError(/falta/i);
  });

  it('clique duplo em finalizar não duplica venda nem baixa estoque duas vezes', () => {
    const key = randomUUID();
    const args = {
      companyId: companyA,
      userId: operador,
      idempotencyKey: key,
      items: [{ productId: produto, quantity: 2, unitPriceCents: 5000 }],
      payments: [{ method: 'dinheiro', amountCents: 10000 }],
      cashSessionId: caixaSessao,
    } as Parameters<typeof createSale>[0];

    const first = createSale(args);
    const second = createSale(args);

    expect(second.duplicated).toBe(true);
    expect(second.sale.id).toBe(first.sale.id);
    expect(getBalance(companyA, produto)).toBe(18);
    expect(drawerCash(first.sale.id)).toBe(10000);
  });
});

describe('autorização gerencial', () => {
  const LIMITE = PADRAO_LIMITE_DESCONTO_PERCENT;

  it('desconto dentro do limite do operador não pede gestor', () => {
    expect(discountNeedsAuthorization(10000, 500, ['operador_caixa_loja'], LIMITE)).toBe(false);
  });

  it('desconto acima do limite pede gestor', () => {
    const acima = Math.ceil(10000 * (LIMITE / 100)) + 1;
    expect(discountNeedsAuthorization(10000, acima, ['operador_caixa_loja'], LIMITE)).toBe(true);
  });

  it('quem já tem alçada não precisa pedir autorização a si mesmo', () => {
    expect(discountNeedsAuthorization(10000, 9000, ['gerente_loja'], LIMITE)).toBe(false);
  });

  // O limite passou a vir de fora, então ele tem que MUDAR o resultado. Sem
  // este caso, trocar o parâmetro por uma constante de novo passaria verde.
  it('o limite da operação é quem decide, e não um número fixo', () => {
    expect(discountNeedsAuthorization(10000, 1500, ['operador_caixa_loja'], 10)).toBe(true);
    expect(discountNeedsAuthorization(10000, 1500, ['operador_caixa_loja'], 20)).toBe(false);
  });

  it('registra quem autorizou', async () => {
    const result = await authorizeAction({
      companyId: companyA,
      requestedBy: operador,
      action: 'desconto_acima_limite',
      login: 'GERENTE1',
      password: MANAGER_PASSWORD,
      reason: 'cliente antigo',
    });
    expect(result.authorizedBy).toBe(gerente);
    expect(result.authorizedByName).toBe('Ana Gerente');

    const registros = listAuthorizations(companyA);
    expect(registros).toHaveLength(1);
    expect(registros[0].requested_by).toBe(operador);
    expect(registros[0].authorized_by).toBe(gerente);
  });

  it('senha errada não autoriza', async () => {
    await expect(
      authorizeAction({
        companyId: companyA,
        requestedBy: operador,
        action: 'desconto_acima_limite',
        login: 'GERENTE1',
        password: 'senha-errada',
      }),
    ).rejects.toThrowError(/não autorizada/i);
    expect(listAuthorizations(companyA)).toHaveLength(0);
  });

  it('operador sem alçada não autoriza mesmo com a própria senha correta', async () => {
    await expect(
      authorizeAction({
        companyId: companyA,
        requestedBy: gerente,
        action: 'desconto_acima_limite',
        login: 'CAIXA1',
        password: 'senha-caixa-123',
      }),
    ).rejects.toThrowError(/alçada/i);
  });

  it('gerente de outra operação não libera desconto nesta', async () => {
    const outro = await upsertUser({
      login: 'GERENTE2',
      displayName: 'Gerente Gringa',
      password: MANAGER_PASSWORD,
    });
    linkUserToCompany(outro, companyB, 'gerente_loja', true);

    await expect(
      authorizeAction({
        companyId: companyA,
        requestedBy: operador,
        action: 'desconto_acima_limite',
        login: 'GERENTE2',
        password: MANAGER_PASSWORD,
      }),
    ).rejects.toThrowError(/alçada/i);
  });

  it('ninguém autoriza a própria ação', async () => {
    await expect(
      authorizeAction({
        companyId: companyA,
        requestedBy: gerente,
        action: 'desconto_acima_limite',
        login: 'GERENTE1',
        password: MANAGER_PASSWORD,
      }),
    ).rejects.toThrowError(/outro usuário/i);
  });

  it('login inexistente não revela que não existe', async () => {
    await expect(
      authorizeAction({
        companyId: companyA,
        requestedBy: operador,
        action: 'desconto_acima_limite',
        login: 'NAO-EXISTE',
        password: MANAGER_PASSWORD,
      }),
      // Mesma mensagem do caso "senha errada": quem está no balcão não
      // descobre quais logins de gestor existem.
    ).rejects.toThrowError(/não autorizada/i);
  });

  it('ação desconhecida é recusada', async () => {
    await expect(
      authorizeAction({
        companyId: companyA,
        requestedBy: operador,
        action: 'liberar_tudo',
        login: 'GERENTE1',
        password: MANAGER_PASSWORD,
      }),
    ).rejects.toThrowError(/não reconhecida/i);
  });
});
