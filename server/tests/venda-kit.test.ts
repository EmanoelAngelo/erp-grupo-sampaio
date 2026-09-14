/**
 * Vender um kit tira as PEÇAS da prateleira.
 *
 * Antes disto a venda de kit tentava baixar o estoque do próprio kit. Kit
 * montado na hora não tem saldo: ou o `CHECK (quantity >= 0)` recusava a venda
 * inteira, ou alguém dava entrada fictícia no kit e as peças seguiam contadas
 * depois de vendidas — o inventário fechava errado e ninguém sabia por quê.
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
const { createProduct, updateProduct } = await import('../src/services/core/CatalogService.js');
const { setKitComponents } = await import('../src/services/core/CatalogAuxService.js');
const { applyMovement, getBalance, reserveStock } = await import(
  '../src/services/core/InventoryService.js'
);
const { cancelSale, createSale } = await import('../src/services/core/SalesService.js');

let empresa: string;
let usuario: string;
let kit: string;
let oleo: string;
let filtro: string;

/** Dá entrada de estoque sem passar por compra — é o ponto de partida do teste. */
function entrada(produto: string, quantidade: number, ref: string): void {
  applyMovement({
    companyId: empresa,
    productId: produto,
    movementType: 'in',
    quantity: quantidade,
    referenceType: 'ajuste',
    referenceId: ref,
  });
}

/**
 * Paga com folga de propósito: o que se cobra aqui é o ESTOQUE, e amarrar o
 * teste ao valor exato faria mudar preço no cadastro quebrar teste de baixa.
 * A diferença vira troco, que é caminho normal do balcão.
 */
function vender(produto: string, quantidade: number, chave: string) {
  return createSale({
    companyId: empresa,
    userId: usuario,
    items: [{ productId: produto, quantity: quantidade }],
    payments: [{ method: 'dinheiro', amountCents: 1_000_00 }],
    idempotencyKey: chave,
  });
}

/** Os itens gravados na venda, para checar que a LINHA é o kit. */
function itensDaVenda(saleId: string): { product_id: string | null }[] {
  return getConnection()
    .prepare('SELECT product_id FROM core_sale_items WHERE sale_id = ?')
    .all(saleId) as unknown as { product_id: string | null }[];
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
    login: 'CAIXA_KIT',
    displayName: 'Caixa',
    password: 'Teste@Kit2026',
  });
  linkUserToCompany(usuario, empresa, 'operador_caixa_loja', true);

  oleo = createProduct(empresa, { name: 'Óleo 20W50', priceCents: 3000, costCents: 1500 }).id;
  filtro = createProduct(empresa, { name: 'Filtro de óleo', priceCents: 4000, costCents: 2000 }).id;
  kit = createProduct(empresa, { name: 'Kit revisão', priceCents: 6000 }).id;

  // 2 óleos e 1 filtro por kit.
  setKitComponents(empresa, kit, [
    { componentId: oleo, quantity: 2 },
    { componentId: filtro, quantity: 1 },
  ]);
});

describe('o kit desmembra na venda', () => {
  it('vender um kit tira as peças, na quantidade da composição', () => {
    entrada(oleo, 10, 'e1');
    entrada(filtro, 10, 'e2');

    vender(kit, 1, 'venda-1');

    expect(getBalance(empresa, oleo)).toBe(8);
    expect(getBalance(empresa, filtro)).toBe(9);
  });

  it('o kit em si não fica com saldo negativo — ele nem se move', () => {
    entrada(oleo, 10, 'e1');
    entrada(filtro, 10, 'e2');

    vender(kit, 1, 'venda-1');

    expect(getBalance(empresa, kit)).toBe(0);
  });

  it('dois kits tiram o dobro', () => {
    entrada(oleo, 10, 'e1');
    entrada(filtro, 10, 'e2');

    vender(kit, 2, 'venda-1');

    expect(getBalance(empresa, oleo)).toBe(6);
    expect(getBalance(empresa, filtro)).toBe(8);
  });

  /**
   * O item da venda continua sendo o KIT — é o que o cliente comprou, é o que
   * sai no cupom e é por ele que o preço foi cobrado. Só o movimento de estoque
   * é que fala das peças.
   */
  it('a linha da venda continua sendo o kit, não as peças', () => {
    entrada(oleo, 10, 'e1');
    entrada(filtro, 10, 'e2');

    const { sale } = vender(kit, 1, 'venda-1');
    const itens = itensDaVenda(sale.id);

    expect(itens.some((i) => i.product_id === kit)).toBe(true);
    expect(itens.some((i) => i.product_id === oleo)).toBe(false);
    expect(itens.some((i) => i.product_id === filtro)).toBe(false);
  });

  it('falta de peça recusa a venda inteira, sem baixar a outra peça', () => {
    entrada(oleo, 1, 'e1'); // precisa de 2
    entrada(filtro, 10, 'e2');

    expect(() => vender(kit, 1, 'venda-1')).toThrow();

    // A transação reverteu: o filtro não pode ter saído.
    expect(getBalance(empresa, filtro)).toBe(10);
    expect(getBalance(empresa, oleo)).toBe(1);
  });

  /** A mensagem tem de dizer QUAL peça e de que kit — senão ninguém acha. */
  it('peça reservada explica que é peça, e de qual kit', () => {
    entrada(oleo, 2, 'e1');
    entrada(filtro, 10, 'e2');
    reserveStock({
      companyId: empresa,
      productId: oleo,
      quantity: 2,
      referenceType: 'pedido',
      referenceId: 'p1',
    });

    expect(() => vender(kit, 1, 'venda-1')).toThrow(/peça do kit "Kit revisão"/);
  });
});

describe('kit com estoque próprio não desmembra', () => {
  it('com desmembrar desligado, quem baixa é o kit', () => {
    updateProduct(empresa, kit, { kitExplodeOnSale: false });
    entrada(kit, 5, 'e-kit');
    entrada(oleo, 10, 'e1');
    entrada(filtro, 10, 'e2');

    vender(kit, 1, 'venda-1');

    expect(getBalance(empresa, kit)).toBe(4);
    // As peças ficam intactas: elas já foram consumidas na montagem.
    expect(getBalance(empresa, oleo)).toBe(10);
    expect(getBalance(empresa, filtro)).toBe(10);
  });
});

describe('produto comum não muda de comportamento', () => {
  it('vender item solto baixa ele mesmo', () => {
    entrada(oleo, 10, 'e1');
    vender(oleo, 3, 'venda-1');
    expect(getBalance(empresa, oleo)).toBe(7);
  });
});

/**
 * O cancelamento tem de desfazer EXATAMENTE o que a venda fez.
 *
 * Este bloco existe por um defeito que só apareceu ao cancelar uma venda de
 * verdade: o estorno lia `core_sale_items` — onde a linha é o KIT — e creditava
 * 2 unidades a um kit que não tem estoque próprio, deixando as peças em falta
 * permanente. Vender 2 kits e cancelar resultava em "Kit 2, Peça A 6, Peça B 8"
 * onde o certo é "Kit 0, Peça A 10, Peça B 10".
 */
describe('cancelar devolve as peças, não o kit', () => {
  it('o estorno recompõe o estoque exatamente como estava', () => {
    entrada(oleo, 10, 'e1');
    entrada(filtro, 10, 'e2');

    const { sale } = vender(kit, 2, 'venda-1');
    expect(getBalance(empresa, oleo)).toBe(6);

    cancelSale({ companyId: empresa, saleId: sale.id, userId: usuario, reason: 'teste' });

    expect(getBalance(empresa, oleo)).toBe(10);
    expect(getBalance(empresa, filtro)).toBe(10);
    // O kit não ganha saldo fantasma.
    expect(getBalance(empresa, kit)).toBe(0);
  });

  /**
   * A composição pode mudar entre a venda e o cancelamento. O estorno segue o
   * MOVIMENTO — o que de fato saiu —, e não a receita de hoje.
   */
  it('mudar a composição depois da venda não corrompe o estorno', () => {
    entrada(oleo, 10, 'e1');
    entrada(filtro, 10, 'e2');

    const { sale } = vender(kit, 1, 'venda-1');

    // Alguém reformula o kit: agora leva 5 óleos e nenhum filtro.
    setKitComponents(empresa, kit, [{ componentId: oleo, quantity: 5 }]);

    cancelSale({ companyId: empresa, saleId: sale.id, userId: usuario, reason: 'teste' });

    // Devolveu o que saiu (2 óleos e 1 filtro), não o que a receita nova diz.
    expect(getBalance(empresa, oleo)).toBe(10);
    expect(getBalance(empresa, filtro)).toBe(10);
  });

  it('cancelar venda de item solto continua funcionando', () => {
    entrada(oleo, 10, 'e1');
    const { sale } = vender(oleo, 3, 'venda-1');
    expect(getBalance(empresa, oleo)).toBe(7);

    cancelSale({ companyId: empresa, saleId: sale.id, userId: usuario, reason: 'teste' });
    expect(getBalance(empresa, oleo)).toBe(10);
  });
});

describe('idempotência sobrevive ao desmembramento', () => {
  /**
   * A chave do movimento é (empresa, tipo, referência, PRODUTO, movimento), e
   * cada peça é um produto diferente — então reenviar a mesma venda não pode
   * baixar duas vezes.
   */
  it('reenviar a mesma venda não tira as peças de novo', () => {
    entrada(oleo, 10, 'e1');
    entrada(filtro, 10, 'e2');

    vender(kit, 1, 'mesma-chave');
    vender(kit, 1, 'mesma-chave');

    expect(getBalance(empresa, oleo)).toBe(8);
    expect(getBalance(empresa, filtro)).toBe(9);
  });
});
