/**
 * O mesmo produto em mais de uma linha da venda.
 *
 * A chave de idempotência do movimento é
 * `(company_id, reference_type, reference_id, product_id, movement_type)`.
 * Numa venda com duas linhas do mesmo produto, as duas baixas produzem a MESMA
 * chave: a segunda é lida como reenvio e devolve `duplicated: true` sem
 * debitar. O saldo cai pela primeira linha só.
 *
 * Isso não é hipótese de laboratório: acontece com produto repetido no balcão,
 * com kit e peça solta na mesma venda, e com dois kits que compartilham a mesma
 * peça. Some mercadoria da prateleira e não some do sistema.
 *
 * O caso do kit é o mais traiçoeiro, porque quem opera não vê "duas linhas do
 * mesmo produto" — vê dois kits diferentes.
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
const { setKitComponents } = await import('../src/services/core/CatalogAuxService.js');
const { applyMovement, getBalance } = await import('../src/services/core/InventoryService.js');
const { cancelSale, createSale } = await import('../src/services/core/SalesService.js');

let empresa: string;
let usuario: string;
let oleo: string;
let filtro: string;

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

/** Paga com folga: o que se cobra aqui é o ESTOQUE, não o troco. */
function vender(itens: { productId: string; quantity: number }[], chave: string) {
  return createSale({
    companyId: empresa,
    userId: usuario,
    items: itens,
    payments: [{ method: 'dinheiro', amountCents: 10_000_00 }],
    idempotencyKey: chave,
  });
}

/** Os movimentos de saída daquela venda, para conferir a soma no razão. */
function saidasDaVenda(saleId: string): { product_id: string; quantity: number }[] {
  return getConnection()
    .prepare(
      `SELECT product_id, quantity FROM core_stock_movements
        WHERE company_id = ? AND reference_id = ? AND movement_type = 'out'
        ORDER BY product_id`,
    )
    .all(empresa, saleId) as unknown as { product_id: string; quantity: number }[];
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
    login: 'CAIXA_REP',
    displayName: 'Caixa',
    password: 'Teste@Rep2026',
  });
  linkUserToCompany(usuario, empresa, 'operador_caixa_loja', true);

  oleo = createProduct(empresa, { name: 'Óleo 20W50', priceCents: 3000, costCents: 1500 }).id;
  filtro = createProduct(empresa, { name: 'Filtro de óleo', priceCents: 4000, costCents: 2000 }).id;
});

describe('produto repetido em duas linhas', () => {
  it('3 + 4 do mesmo produto baixam 7, não 3', () => {
    entrada(oleo, 10, 'e1');

    vender(
      [
        { productId: oleo, quantity: 3 },
        { productId: oleo, quantity: 4 },
      ],
      'venda-1',
    );

    expect(getBalance(empresa, oleo)).toBe(3);
  });

  /** Um movimento só, com a soma — e não dois competindo pela mesma chave. */
  it('o razão registra a saída somada num movimento só', () => {
    entrada(oleo, 10, 'e1');

    const { sale } = vender(
      [
        { productId: oleo, quantity: 3 },
        { productId: oleo, quantity: 4 },
      ],
      'venda-1',
    );

    const saidas = saidasDaVenda(sale.id);
    expect(saidas).toHaveLength(1);
    expect(saidas[0].quantity).toBe(-7);
  });

  it('cancelar devolve as 7, não 3', () => {
    entrada(oleo, 10, 'e1');

    const { sale } = vender(
      [
        { productId: oleo, quantity: 3 },
        { productId: oleo, quantity: 4 },
      ],
      'venda-1',
    );
    cancelSale({ companyId: empresa, saleId: sale.id, userId: usuario, reason: 'teste' });

    expect(getBalance(empresa, oleo)).toBe(10);
  });

  /** Faltando para o TOTAL, a venda inteira é recusada — não meia venda. */
  it('saldo que cobre só a primeira linha recusa a venda inteira', () => {
    entrada(oleo, 5, 'e1');

    expect(() =>
      vender(
        [
          { productId: oleo, quantity: 3 },
          { productId: oleo, quantity: 4 },
        ],
        'venda-1',
      ),
    ).toThrow();

    expect(getBalance(empresa, oleo)).toBe(5);
  });
});

describe('dois kits que compartilham a mesma peça', () => {
  /**
   * Aqui ninguém vê "duas linhas do mesmo produto": vê dois kits diferentes.
   * A colisão acontece uma camada abaixo, no desmembramento.
   */
  it('kit de 2 óleos + kit de 3 óleos baixam 5 óleos', () => {
    const kitA = createProduct(empresa, { name: 'Kit revisão simples', priceCents: 6000 }).id;
    const kitB = createProduct(empresa, { name: 'Kit revisão completa', priceCents: 9000 }).id;
    setKitComponents(empresa, kitA, [{ componentId: oleo, quantity: 2 }]);
    setKitComponents(empresa, kitB, [
      { componentId: oleo, quantity: 3 },
      { componentId: filtro, quantity: 1 },
    ]);

    entrada(oleo, 10, 'e1');
    entrada(filtro, 10, 'e2');

    vender(
      [
        { productId: kitA, quantity: 1 },
        { productId: kitB, quantity: 1 },
      ],
      'venda-1',
    );

    expect(getBalance(empresa, oleo)).toBe(5);
    expect(getBalance(empresa, filtro)).toBe(9);
  });

  it('kit com 2 óleos + 5 óleos avulsos baixam 7', () => {
    const kit = createProduct(empresa, { name: 'Kit revisão', priceCents: 6000 }).id;
    setKitComponents(empresa, kit, [{ componentId: oleo, quantity: 2 }]);

    entrada(oleo, 10, 'e1');

    vender(
      [
        { productId: kit, quantity: 1 },
        { productId: oleo, quantity: 5 },
      ],
      'venda-1',
    );

    expect(getBalance(empresa, oleo)).toBe(3);
  });

  it('cancelar a venda de dois kits devolve tudo', () => {
    const kitA = createProduct(empresa, { name: 'Kit A', priceCents: 6000 }).id;
    const kitB = createProduct(empresa, { name: 'Kit B', priceCents: 9000 }).id;
    setKitComponents(empresa, kitA, [{ componentId: oleo, quantity: 2 }]);
    setKitComponents(empresa, kitB, [{ componentId: oleo, quantity: 3 }]);

    entrada(oleo, 10, 'e1');
    const { sale } = vender(
      [
        { productId: kitA, quantity: 1 },
        { productId: kitB, quantity: 1 },
      ],
      'venda-1',
    );
    expect(getBalance(empresa, oleo)).toBe(5);

    cancelSale({ companyId: empresa, saleId: sale.id, userId: usuario, reason: 'teste' });
    expect(getBalance(empresa, oleo)).toBe(10);
  });
});

describe('o que já funcionava continua funcionando', () => {
  it('produtos diferentes em linhas diferentes baixam cada um o seu', () => {
    entrada(oleo, 10, 'e1');
    entrada(filtro, 10, 'e2');

    vender(
      [
        { productId: oleo, quantity: 2 },
        { productId: filtro, quantity: 3 },
      ],
      'venda-1',
    );

    expect(getBalance(empresa, oleo)).toBe(8);
    expect(getBalance(empresa, filtro)).toBe(7);
  });

  /** A idempotência de VERDADE — reenviar a mesma venda — não pode quebrar. */
  it('reenviar a mesma venda continua não baixando de novo', () => {
    entrada(oleo, 10, 'e1');

    vender(
      [
        { productId: oleo, quantity: 3 },
        { productId: oleo, quantity: 4 },
      ],
      'mesma-chave',
    );
    vender(
      [
        { productId: oleo, quantity: 3 },
        { productId: oleo, quantity: 4 },
      ],
      'mesma-chave',
    );

    expect(getBalance(empresa, oleo)).toBe(3);
  });
});
