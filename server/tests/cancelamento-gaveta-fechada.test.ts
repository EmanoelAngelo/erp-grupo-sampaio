/**
 * CANCELAR VENDA NÃO MEXE EM GAVETA JÁ FECHADA.
 *
 * ============================================================================
 * O QUE ACONTECIA
 * ============================================================================
 *
 * `cancelSale` lia `sale.cash_session_id` e lançava o movimento negativo NELE,
 * sem conferir se aquela sessão ainda estava aberta. Era a única das três rotas
 * de dinheiro sem essa guarda: `createSale` recusa sessão fechada e
 * `createSaleReturn` só lança quando a sessão está aberta.
 *
 * O estrago: o gerente cancela hoje uma venda de ontem, e um débito aparece no
 * turno de ontem — que já foi contado, conferido e assinado. O fechamento
 * daquele dia deixa de bater com o papel que a pessoa guardou, e ninguém
 * consegue explicar a diferença, porque o movimento nasceu depois.
 *
 * ============================================================================
 * A REGRA
 * ============================================================================
 *
 * Dinheiro que saiu numa venda de outro turno volta pela gaveta de HOJE — é de
 * onde a nota sai fisicamente para a mão do cliente:
 *
 *  1. a sessão da venda ainda aberta → é ela, como sempre foi;
 *  2. fechada, mas há caixa aberto agora → o movimento vai para o caixa de
 *     agora, com nota dizendo de qual venda e de qual turno veio;
 *  3. fechada e nenhum caixa aberto → o cancelamento é RECUSADO. Devolver
 *     espécie fora de qualquer gaveta é criar diferença de propósito, e a
 *     recusa diz o que fazer.
 *
 * Venda sem dinheiro nenhum (só cartão, só PIX) cancela sempre: não há espécie
 * para devolver, e travar isso seria inventar uma regra onde não há gaveta.
 */
import { beforeEach, describe, expect, it } from 'vitest';

process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_DATABASE_PATH = ':memory:';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

const { ensureCoreSchema } = await import('../src/db/schema.js');
const { resetDbForTests } = await import('../src/db/database.js');
const { getConnection } = await import('../src/db/sqlite.js');
const { upsertCompany, upsertUser, linkUserToCompany } = await import(
  '../src/services/auth/IdentityService.js'
);
const { createProduct } = await import('../src/services/core/CatalogService.js');
const { applyMovement } = await import('../src/services/core/InventoryService.js');
const { createSale, cancelSale } = await import('../src/services/core/SalesService.js');
const { openSession, closeSession, expectedCents } = await import(
  '../src/services/core/CashService.js'
);

let empresa: string;
let usuario: string;
let produto: string;

/** Vende R$ 50 em espécie na sessão indicada. */
function venderEmDinheiro(cashSessionId: string | null, chave: string) {
  return createSale({
    companyId: empresa,
    userId: usuario,
    cashSessionId,
    items: [{ productId: produto, quantity: 1 }],
    payments: [{ method: 'dinheiro', amountCents: 5000 }],
    idempotencyKey: chave,
  }).sale;
}

/**
 * Os movimentos de uma sessão, do jeito que o fechamento os lê.
 *
 * Sem a linha de abertura: `openSession` só a grava quando há fundo de troco,
 * e o que se mede aqui é o que entra e sai depois.
 */
function movimentos(sessionId: string) {
  return getConnection()
    .prepare(
      `SELECT movement_type, amount_cents, note FROM core_cash_movements
        WHERE session_id = ? ORDER BY created_at, rowid`,
    )
    .all(sessionId)
    .filter((m) => (m as { movement_type: string }).movement_type !== 'opening') as {
    movement_type: string;
    amount_cents: number;
    note: string | null;
  }[];
}

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
    login: 'GERENTE_CGF',
    displayName: 'Gerente',
    password: 'Teste@Cgf2026',
  });
  linkUserToCompany(usuario, empresa, 'gerente_loja', true);

  produto = createProduct(empresa, { name: 'Camiseta Polo', priceCents: 5000 }).id;
  applyMovement({
    companyId: empresa,
    productId: produto,
    movementType: 'in',
    quantity: 10,
    referenceType: 'ajuste',
    referenceId: 'e1',
  });
});

// ============================================================================

describe('a gaveta do turno que já fechou não recebe movimento novo', () => {
  it('cancelar no MESMO turno debita a própria sessão — como sempre foi', () => {
    const caixa = openSession({ companyId: empresa, userId: usuario, openingCents: 0 });
    const venda = venderEmDinheiro(caixa.id, 'v1');

    cancelSale({ companyId: empresa, userId: usuario, saleId: venda.id, reason: 'erro' });

    // R$ 50 entraram e R$ 50 saíram: a gaveta volta ao fundo de abertura.
    expect(expectedCents(caixa.id)).toBe(0);
    expect(movimentos(caixa.id).map((m) => m.movement_type)).toEqual(['sale', 'sale_cancel']);
  });

  it('turno fechado: o débito vai para a gaveta de HOJE, e não para a de ontem', () => {
    const ontem = openSession({ companyId: empresa, userId: usuario, openingCents: 0 });
    const venda = venderEmDinheiro(ontem.id, 'v1');
    closeSession({ companyId: empresa, userId: usuario, sessionId: ontem.id, countedCents: 5000 });

    const hoje = openSession({ companyId: empresa, userId: usuario, openingCents: 10000 });
    cancelSale({ companyId: empresa, userId: usuario, saleId: venda.id, reason: 'devolvido' });

    /*
      O turno de ontem fica exatamente como foi contado e assinado. Um débito
      aparecendo lá depois faria o fechamento daquele dia deixar de bater com o
      papel guardado — e a diferença seria inexplicável, porque o movimento
      nasceu depois da assinatura.
    */
    expect(movimentos(ontem.id).map((m) => m.movement_type)).toEqual(['sale']);
    expect(expectedCents(ontem.id)).toBe(5000);

    // E a nota sai da gaveta de hoje, que é de onde ela sai de verdade.
    const deHoje = movimentos(hoje.id);
    expect(deHoje.map((m) => m.movement_type)).toEqual(['sale_cancel']);
    expect(deHoje[0].amount_cents).toBe(-5000);
    expect(deHoje[0].note ?? '').toMatch(/turno|caixa/i);
    expect(expectedCents(hoje.id)).toBe(5000);
  });

  it('turno fechado e nenhum caixa aberto: o cancelamento é recusado', () => {
    const ontem = openSession({ companyId: empresa, userId: usuario, openingCents: 0 });
    const venda = venderEmDinheiro(ontem.id, 'v1');
    closeSession({ companyId: empresa, userId: usuario, sessionId: ontem.id, countedCents: 5000 });

    /*
      Sem gaveta aberta, devolver espécie é criar a diferença de propósito: o
      dinheiro sai da mão de alguém e não sai de lugar nenhum no sistema.
    */
    expect(() =>
      cancelSale({ companyId: empresa, userId: usuario, saleId: venda.id, reason: 'devolvido' }),
    ).toThrow(/caixa/i);

    // E a venda continua de pé: recusa que cancela pela metade é pior que recusa.
    const depois = getConnection()
      .prepare('SELECT status FROM core_sales WHERE id = ?')
      .get(venda.id) as { status: string };
    expect(depois.status).not.toBe('cancelled');
  });

  it('venda sem espécie cancela com tudo fechado — não há nota para devolver', () => {
    const caixa = openSession({ companyId: empresa, userId: usuario, openingCents: 0 });
    const venda = createSale({
      companyId: empresa,
      userId: usuario,
      cashSessionId: caixa.id,
      items: [{ productId: produto, quantity: 1 }],
      payments: [{ method: 'credito', amountCents: 5000 }],
      idempotencyKey: 'v2',
    }).sale;
    closeSession({ companyId: empresa, userId: usuario, sessionId: caixa.id, countedCents: 0 });

    const cancelada = cancelSale({
      companyId: empresa,
      userId: usuario,
      saleId: venda.id,
      reason: 'estorno pela operadora',
    });
    expect(cancelada.status).toBe('cancelled');
  });
});
