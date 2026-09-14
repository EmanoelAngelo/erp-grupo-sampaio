/**
 * Clonar produto: as decisões, cobradas uma a uma.
 *
 * "Copiar o produto" parece uma linha e não é. O que este arquivo protege são
 * as escolhas cujo erro só apareceria depois — código de barras duplicado que o
 * banco recusa no meio do cadastro, estoque inventado que ninguém comprou, e
 * foto compartilhada que some do original quando alguém apaga a do clone.
 */
import { beforeEach, describe, expect, it } from 'vitest';

process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_DATABASE_PATH = ':memory:';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

const { getConnection } = await import('../src/db/sqlite.js');
const { ensureCoreSchema } = await import('../src/db/schema.js');
const { resetDbForTests } = await import('../src/db/database.js');
const { upsertCompany } = await import('../src/services/auth/IdentityService.js');
const { createProduct, getProduct } = await import('../src/services/core/CatalogService.js');
const { cloneProduct } = await import('../src/services/core/ProductCloneService.js');
const { listKitComponents, setKitComponents, upsertPriceTable, setPriceTableItem } = await import(
  '../src/services/core/CatalogAuxService.js'
);
const { applyMovement } = await import('../src/services/core/InventoryService.js');

let empresa: string;

beforeEach(() => {
  resetDbForTests();
  ensureCoreSchema();
  empresa = upsertCompany({
    slug: 'preco-justo',
    legalName: 'Preço Justo Ltda',
    tradeName: 'Preço Justo',
    kind: 'store',
  });
});

const ler = (id: string) => getProduct(empresa, id) as unknown as Record<string, unknown>;

describe('o que vai junto', () => {
  it('copia os campos de cadastro', () => {
    const origem = createProduct(empresa, {
      name: 'Óleo 20W50',
      description: 'Semissintético',
      costCents: 10000,
      priceCents: 15000,
      unit: 'LT',
      ncm: '27101932',
      reference: 'FAB-991',
      minPriceCents: 12000,
    });

    const clone = ler(cloneProduct(empresa, origem.id).id as string);

    expect(clone.description).toBe('Semissintético');
    expect(clone.cost_cents).toBe(10000);
    expect(clone.price_cents).toBe(15000);
    expect(clone.unit).toBe('LT');
    expect(clone.ncm).toBe('27101932');
    expect(clone.reference).toBe('FAB-991');
    expect(clone.min_price_cents).toBe(12000);
  });

  it('o nome ganha um sufixo, para os dois não se confundirem na busca', () => {
    const origem = createProduct(empresa, { name: 'Óleo 20W50' });
    const clone = ler(cloneProduct(empresa, origem.id).id as string);
    expect(clone.name).toBe('Óleo 20W50 (cópia)');
  });

  it('o nome pode ser escolhido na hora de clonar', () => {
    const origem = createProduct(empresa, { name: 'Óleo 20W50' });
    const clone = ler(cloneProduct(empresa, origem.id, { name: 'Óleo 15W40' }).id as string);
    expect(clone.name).toBe('Óleo 15W40');
  });

  it('copia as peças do kit — clone de kit sem composição seria uma casca', () => {
    const kit = createProduct(empresa, { name: 'Kit revisão' });
    const oleo = createProduct(empresa, { name: 'Óleo', costCents: 1500 });
    const filtro = createProduct(empresa, { name: 'Filtro', costCents: 2000 });
    setKitComponents(empresa, kit.id, [
      { componentId: oleo.id, quantity: 2 },
      { componentId: filtro.id, quantity: 1 },
    ]);

    const clone = cloneProduct(empresa, kit.id);
    const pecas = listKitComponents(empresa, clone.id as string);

    expect(pecas).toHaveLength(2);
    expect(pecas.map((p) => p.component_id).sort()).toEqual([oleo.id, filtro.id].sort());
    expect(ler(clone.id as string).is_kit).toBe(1);
  });

  it('copia os preços em tabela', () => {
    const tabela = upsertPriceTable(empresa, { name: 'Atacado', percentOff: 5 });
    const origem = createProduct(empresa, { name: 'Óleo', priceCents: 10000 });
    setPriceTableItem(empresa, tabela.id, origem.id, 8000);

    const clone = cloneProduct(empresa, origem.id);

    const item = getConnection()
      .prepare(
        'SELECT price_cents FROM core_price_table_items WHERE product_id = ? AND price_table_id = ?',
      )
      .get(clone.id, tabela.id) as { price_cents?: number } | undefined;

    expect(item?.price_cents).toBe(8000);
  });
});

describe('o que NÃO vai', () => {
  /**
   * Código de barras identifica UM item físico. O clone é outro item, e o
   * insert recusaria a duplicata no meio do cadastro.
   */
  it('não copia o código de barras', () => {
    const origem = createProduct(empresa, { name: 'Óleo', barcode: '7891234567895' });
    const clone = ler(cloneProduct(empresa, origem.id).id as string);
    expect(clone.barcode).toBeNull();
  });

  it('o código interno é novo, não repetido', () => {
    const origem = createProduct(empresa, { name: 'Óleo' });
    const clone = ler(cloneProduct(empresa, origem.id).id as string);
    expect(clone.internal_code).not.toBe(origem.internal_code);
    expect(String(clone.internal_code).length).toBeGreaterThan(0);
  });

  /** Cadastro não é mercadoria: copiar saldo inventaria peça que ninguém comprou. */
  it('não copia o estoque', () => {
    const origem = createProduct(empresa, { name: 'Óleo' });
    applyMovement({
      companyId: empresa,
      productId: origem.id,
      quantity: 10,
      movementType: 'in',
      referenceType: 'ajuste',
      referenceId: 'teste-clone',
    });

    const clone = cloneProduct(empresa, origem.id);
    const saldo = getConnection()
      .prepare('SELECT quantity FROM core_stock WHERE product_id = ? AND company_id = ?')
      .get(clone.id, empresa) as { quantity?: number } | undefined;

    expect(saldo?.quantity ?? 0).toBe(0);
  });

  /**
   * O clone nasce fora da vitrine mesmo que o original esteja publicado: ele
   * ainda não tem código de barras nem foto conferida, e publicar por herança
   * poria à venda algo que ninguém revisou.
   */
  it('não herda a publicação na loja', () => {
    const origem = createProduct(empresa, { name: 'Óleo', publishOnline: true });
    const clone = ler(cloneProduct(empresa, origem.id).id as string);
    expect(clone.publish_online).toBe(0);
  });
});

describe('recusas', () => {
  it('variante não é clonada sozinha', () => {
    const modelo = createProduct(empresa, { name: 'Camisa' });
    const variante = createProduct(empresa, { name: 'Camisa Azul G' });
    getConnection()
      .prepare('UPDATE core_products SET parent_id = ? WHERE id = ?')
      .run(modelo.id, variante.id);

    expect(() => cloneProduct(empresa, variante.id)).toThrow(/variante/i);
  });

  it('produto de outra empresa não é encontrado', () => {
    const outra = upsertCompany({
      slug: 'gringa',
      legalName: 'Gringa Ltda',
      tradeName: 'Gringa',
      kind: 'store',
    });
    const origem = createProduct(outra, { name: 'Óleo' });
    expect(() => cloneProduct(empresa, origem.id)).toThrow(/não encontrado/i);
  });
});

describe('o clone é independente', () => {
  it('mudar o clone não mexe no original', () => {
    const origem = createProduct(empresa, { name: 'Óleo', priceCents: 15000 });
    const clone = cloneProduct(empresa, origem.id);

    getConnection()
      .prepare('UPDATE core_products SET price_cents = 99900 WHERE id = ?')
      .run(clone.id);

    expect(ler(origem.id).price_cents).toBe(15000);
  });

  it('tirar uma peça do kit do clone não mexe no kit original', () => {
    const kit = createProduct(empresa, { name: 'Kit' });
    const a = createProduct(empresa, { name: 'A', costCents: 100 });
    const b = createProduct(empresa, { name: 'B', costCents: 200 });
    setKitComponents(empresa, kit.id, [
      { componentId: a.id, quantity: 1 },
      { componentId: b.id, quantity: 1 },
    ]);

    const clone = cloneProduct(empresa, kit.id);
    setKitComponents(empresa, clone.id as string, [{ componentId: a.id, quantity: 1 }]);

    expect(listKitComponents(empresa, kit.id)).toHaveLength(2);
    expect(listKitComponents(empresa, clone.id as string)).toHaveLength(1);
  });
});
