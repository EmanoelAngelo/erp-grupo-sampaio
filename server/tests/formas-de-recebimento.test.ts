/**
 * As formas de recebimento — uma fonte de verdade, no servidor.
 *
 * `method` era string livre: sem enum, sem validação na rota, sem CHECK no
 * banco. A única lista de meios de pagamento do projeto vivia no FRONTEND, e o
 * servidor nunca a lia — então qualquer coisa entrava e depois sumia dos
 * relatórios agrupados por forma de pagamento.
 *
 * O crediário fica DESLIGADO por decisão do dono do sistema, que não vende a
 * prazo. Ele era aceito e tratado como dinheiro na mão: a venda fechava, o
 * financeiro nascia quitado e não havia parcela nem cobrança. Uma venda a
 * prazo registrada assim sumia do contas a receber.
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
const { createProduct, createCustomer } = await import('../src/services/core/CatalogService.js');
const { applyMovement, getBalance } = await import('../src/services/core/InventoryService.js');
const { createSale } = await import('../src/services/core/SalesService.js');
const {
  PAYMENT_METHODS,
  activePaymentMethods,
  assertPaymentMethod,
  findPaymentMethod,
  isCashMethod,
} = await import('../src/services/core/PaymentMethods.js');

let empresa: string;
let usuario: string;
let produto: string;

function vender(
  payments: { method: string; amountCents: number; status?: 'settled' | 'pending' }[],
  chave: string,
  customerId?: string,
) {
  return createSale({
    companyId: empresa,
    userId: usuario,
    items: [{ productId: produto, quantity: 1 }],
    payments,
    customerId,
    idempotencyKey: chave,
  });
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
    login: 'CAIXA_FR',
    displayName: 'Caixa',
    password: 'Teste@Fr2026',
  });
  linkUserToCompany(usuario, empresa, 'operador_caixa_loja', true);

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

describe('o catálogo', () => {
  it('os quatro meios do balcão estão ativos', () => {
    expect(activePaymentMethods().map((m) => m.code)).toEqual([
      'dinheiro',
      'debito',
      'credito',
      'pix',
    ]);
  });

  /** Só dinheiro entra na gaveta e admite troco. */
  it('só dinheiro é espécie', () => {
    expect(isCashMethod('dinheiro')).toBe(true);
    for (const outro of ['debito', 'credito', 'pix', 'crediario']) {
      expect(isCashMethod(outro)).toBe(false);
    }
  });

  /**
   * A linha do crediário fica no código, e não some: o histórico pode ter
   * vendas antigas com este método, e elas precisam continuar legíveis.
   */
  it('o crediário continua conhecido, porém desligado', () => {
    const c = findPaymentMethod('crediario');
    expect(c).toBeDefined();
    expect(c?.active).toBe(false);
    expect(c?.deferred).toBe(true);
  });

  it('os atalhos do balcão não mudaram', () => {
    expect(PAYMENT_METHODS.map((m) => m.key)).toEqual(['1', '2', '3', '4', '5']);
  });

  it('aceita o código com espaço e em maiúscula', () => {
    expect(findPaymentMethod(' Dinheiro ')?.code).toBe('dinheiro');
  });
});

describe('a validação na entrada', () => {
  it('método desconhecido é recusado, e a mensagem lista os aceitos', () => {
    expect(() => vender([{ method: 'cheque', amountCents: 5000 }], 'v1')).toThrow(
      /desconhecida.*cheque/i,
    );
    expect(() => vender([{ method: 'cheque', amountCents: 5000 }], 'v2')).toThrow(/Dinheiro/);
  });

  /** Quem tenta usar crediário precisa saber que foi desligado, não que errou. */
  it('crediário tem mensagem própria, diferente de método inexistente', () => {
    expect(() => vender([{ method: 'crediario', amountCents: 5000 }], 'v1')).toThrow(
      /desligado/i,
    );
  });

  it('erro de digitação não chega ao banco', () => {
    expect(() => vender([{ method: 'dinehiro', amountCents: 5000 }], 'v1')).toThrow();
    const n = getConnection()
      .prepare('SELECT COUNT(*) AS n FROM core_sale_payments')
      .get() as { n: number };
    expect(n.n).toBe(0);
  });

  it('venda recusada por método inválido não baixa estoque', () => {
    expect(() => vender([{ method: 'cheque', amountCents: 5000 }], 'v1')).toThrow();
    expect(getBalance(empresa, produto)).toBe(10);
  });

  it('valor zero ou negativo é recusado', () => {
    expect(() => vender([{ method: 'dinheiro', amountCents: 0 }], 'v1')).toThrow(/inválido/i);
    expect(() => vender([{ method: 'dinheiro', amountCents: -100 }], 'v2')).toThrow(/inválido/i);
  });

  it('assertPaymentMethod devolve o método quando ele vale', () => {
    expect(assertPaymentMethod('pix').label).toBe('PIX');
  });

  it('os quatro meios ativos passam', () => {
    for (const [i, m] of activePaymentMethods().entries()) {
      expect(() => vender([{ method: m.code, amountCents: 5000 }], `v-${i}`)).not.toThrow();
    }
  });
});

describe('venda sem pagamento precisa ter dono', () => {
  /**
   * Sem esta regra a venda era gravada como completa, o estoque baixava e
   * nascia um recebível em aberto com `customer_id` nulo — dinheiro devido por
   * pessoa nenhuma.
   */
  it('venda fiada sem cliente identificado é recusada', () => {
    expect(() => vender([], 'v1')).toThrow(/identifique o cliente/i);
  });

  it('a venda recusada não baixa estoque', () => {
    expect(() => vender([], 'v1')).toThrow();
    expect(getBalance(empresa, produto)).toBe(10);
  });

  /** Vender fiado é prática real do balcão: com dono, passa. */
  it('com cliente identificado, a venda fiada acontece e vira conta a receber', () => {
    const cliente = createCustomer(empresa, { name: 'João da Silva' }).id as string;
    const { sale } = vender([], 'v1', cliente);
    expect(sale.total_cents).toBe(5000);

    const lanc = getConnection()
      .prepare(
        `SELECT status, settled_cents, customer_id FROM core_finance_entries
          WHERE origin_type = 'sale' AND origin_id = ?`,
      )
      .get(sale.id) as { status: string; settled_cents: number; customer_id: string | null };
    expect(lanc.status).toBe('open');
    expect(lanc.settled_cents).toBe(0);
    expect(lanc.customer_id).toBe(cliente);
  });

  /**
   * Venda de valor zero (brinde, garantia) não precisa de cobrança.
   *
   * O BRINDE MUDOU DE VEÍCULO, e a regra sob teste continua a mesma.
   *
   * Antes o brinde era um produto cadastrado com preço ZERO, e a venda saía por
   * nada sem que ninguém tivesse decidido nada. A partir da rodada da política
   * do balcão, produto com preço vigente zero é RECUSADO
   * (CORE_PRODUCT_WITHOUT_PRICE) — não por causa do brinde, mas porque uma nota
   * de entrada cria dezenas de produtos sem preço, e o primeiro deles a ser
   * bipado saía de graça em silêncio.
   *
   * O brinde continua existindo, e agora deixa rastro: produto com preço, e a
   * concessão integral registrada na venda. É a mesma decisão de sempre, com a
   * diferença de que dá para saber depois que ela foi tomada.
   *
   * O que este teste protege é o que sempre protegeu: venda que não gera
   * dívida não precisa de cliente identificado.
   */
  it('venda de valor zero não exige cliente', () => {
    const gratis = createProduct(empresa, { name: 'Brinde', priceCents: 2500 }).id;
    applyMovement({
      companyId: empresa,
      productId: gratis,
      movementType: 'in',
      quantity: 1,
      referenceType: 'ajuste',
      referenceId: 'e2',
    });
    const { sale } = createSale({
      companyId: empresa,
      userId: usuario,
      items: [{ productId: gratis, quantity: 1 }],
      discountCents: 2500,
      payments: [],
      idempotencyKey: 'v-brinde',
    });
    expect(sale.total_cents).toBe(0);
  });

  /** E o produto que a nota criou sem preço não sai de graça por engano. */
  it('produto sem preço é recusado, com instrução de onde precificar', () => {
    const semPreco = createProduct(empresa, { name: 'Peça da nota', priceCents: 0 }).id;
    applyMovement({
      companyId: empresa,
      productId: semPreco,
      movementType: 'in',
      quantity: 1,
      referenceType: 'ajuste',
      referenceId: 'e3',
    });
    expect(() =>
      createSale({
        companyId: empresa,
        userId: usuario,
        items: [{ productId: semPreco, quantity: 1 }],
        payments: [],
        idempotencyKey: 'v-sem-preco',
      }),
    ).toThrow(/sem preço de venda/i);
  });
});
