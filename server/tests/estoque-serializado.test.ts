/**
 * Estoque serializado — QUAL peça, e não quantas.
 *
 * O que este arquivo mais precisa provar é a decisão de desenho: `core_stock`
 * continua sendo o saldo autoritativo, e a unidade é identidade ao lado. Se a
 * contagem de unidades em estoque puder divergir do saldo, o acoplamento está
 * furado — e é a primeira coisa cobrada aqui, em todos os caminhos.
 *
 * O guard vive dentro de `applyMovement`, que é o único escritor do saldo.
 * Portanto nenhum caminho — venda, cancelamento, devolução, transferência, OS,
 * entrada de nota, rota manual — consegue mover estoque de produto serializado
 * sem dizer quais peças se moveram.
 */
import { beforeEach, describe, expect, it } from 'vitest';

process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_DATABASE_PATH = ':memory:';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

const { ensureCoreSchema } = await import('../src/db/schema.js');
const { resetDbForTests } = await import('../src/db/database.js');
const { upsertCompany, upsertUser, linkUserToCompany } = await import(
  '../src/services/auth/IdentityService.js'
);
const { createProduct, updateProduct } = await import('../src/services/core/CatalogService.js');
const { applyMovement, getBalance } = await import('../src/services/core/InventoryService.js');
const { getConnection } = await import('../src/db/sqlite.js');
const { cancelSale, createSale } = await import('../src/services/core/SalesService.js');
const { createLocation, transferStock } = await import(
  '../src/services/core/StockLocationService.js'
);
const {
  countInStock,
  createUnits,
  getUnit,
  identifyUnit,
  isSerialized,
  listUnits,
  pickUnitsFifo,
  searchUnit,
} = await import('../src/services/core/ProductUnitService.js');

let empresa: string;
let usuario: string;
let moto: string;
let camiseta: string;

/** Cria N unidades E o saldo correspondente, que é como a entrada de nota faz. */
function entrarComUnidades(produto: string, quantidade: number, ref: string): string[] {
  const ids = createUnits(empresa, produto, quantidade, {
    entryReferenceType: 'ajuste',
    entryReferenceId: ref,
  });
  applyMovement({
    companyId: empresa,
    productId: produto,
    movementType: 'in',
    quantity: quantidade,
    referenceType: 'ajuste',
    referenceId: ref,
    unitIds: ids,
  });
  return ids;
}

/*
  PAGA O QUE A VENDA CUSTA. O auxiliar pagava R$ 100.000,00 em qualquer venda;
  a venda passou a recusar soma de pagamentos absurda para o total
  (CORE_PAYMENT_TOO_LARGE, auditoria da Preço Justo — é o código de barras lido
  no campo de valor). O total sai do preço de tabela, que é o que estes
  produtos cobram (sem promoção nem desconto neste arquivo).
*/
function vender(itens: { productId: string; quantity: number; unitIds?: string[] }[], chave: string) {
  const total = itens.reduce((soma, i) => {
    const p = getConnection().prepare('SELECT price_cents FROM core_products WHERE id = ?').get(i.productId) as
      | { price_cents: number }
      | undefined;
    return soma + (p?.price_cents ?? 0) * i.quantity;
  }, 0);
  return createSale({
    companyId: empresa,
    userId: usuario,
    items: itens,
    payments: [{ method: 'dinheiro', amountCents: total }],
    idempotencyKey: chave,
  });
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  empresa = upsertCompany({
    slug: 'pj-motors',
    legalName: 'PJ Motors Ltda',
    tradeName: 'PJ Motors',
    kind: 'store',
  });
  usuario = await upsertUser({
    login: 'CAIXA_SER',
    displayName: 'Caixa',
    password: 'Teste@Ser2026',
  });
  linkUserToCompany(usuario, empresa, 'operador_caixa_loja', true);

  moto = createProduct(empresa, { name: 'Honda CG 160', priceCents: 1_800_000 }).id;
  updateProduct(empresa, moto, { serialized: true });
  camiseta = createProduct(empresa, { name: 'Camiseta Polo', priceCents: 8990 }).id;
});

describe('o saldo continua sendo o saldo', () => {
  it('a contagem de unidades em estoque bate com o saldo', () => {
    entrarComUnidades(moto, 3, 'e1');
    expect(getBalance(empresa, moto)).toBe(3);
    expect(countInStock(empresa, moto)).toBe(3);
  });

  it('vender uma unidade derruba os dois juntos', () => {
    const ids = entrarComUnidades(moto, 3, 'e1');
    vender([{ productId: moto, quantity: 1, unitIds: [ids[0]] }], 'v1');

    expect(getBalance(empresa, moto)).toBe(2);
    expect(countInStock(empresa, moto)).toBe(2);
    expect(getUnit(empresa, ids[0])?.status).toBe('sold');
  });

  /**
   * O rollback que desfaz o saldo tem de desfazer o status. Se não desfizesse,
   * a unidade ficaria vendida sem venda.
   */
  it('venda recusada não deixa unidade marcada como vendida', () => {
    const ids = entrarComUnidades(moto, 1, 'e1');

    // Duas unidades pedidas, uma existe: o guard recusa antes de qualquer coisa.
    expect(() =>
      vender([{ productId: moto, quantity: 2, unitIds: [ids[0], 'inexistente'] }], 'v1'),
    ).toThrow();

    expect(getBalance(empresa, moto)).toBe(1);
    expect(getUnit(empresa, ids[0])?.status).toBe('in_stock');
  });
});

describe('o funil recusa movimento sem unidade', () => {
  it('vender serializado sem escolher a peça é recusado', () => {
    entrarComUnidades(moto, 2, 'e1');
    expect(() => vender([{ productId: moto, quantity: 1 }], 'v1')).toThrow(/unidade/i);
  });

  it('a recusa diz quantas faltaram', () => {
    const ids = entrarComUnidades(moto, 3, 'e1');
    expect(() =>
      vender([{ productId: moto, quantity: 2, unitIds: [ids[0]] }], 'v1'),
    ).toThrow(/exatamente 2/);
  });

  it('quantidade fracionada é recusada', () => {
    entrarComUnidades(moto, 2, 'e1');
    expect(() =>
      applyMovement({
        companyId: empresa,
        productId: moto,
        movementType: 'out',
        quantity: 0.5,
        referenceType: 'ajuste',
        referenceId: 'x',
        unitIds: ['qualquer'],
      }),
    ).toThrow(/fracionada/i);
  });

  /** Chamada que parece funcionar e não faz nada é pior que erro. */
  it('mandar unidade para produto comum é recusado', () => {
    expect(() =>
      applyMovement({
        companyId: empresa,
        productId: camiseta,
        movementType: 'in',
        quantity: 1,
        referenceType: 'ajuste',
        referenceId: 'x',
        unitIds: ['alguma'],
      }),
    ).toThrow(/não é controlado por unidade/i);
  });

  it('a mesma unidade duas vezes na mesma venda é recusada', () => {
    const ids = entrarComUnidades(moto, 2, 'e1');
    expect(() =>
      vender([{ productId: moto, quantity: 2, unitIds: [ids[0], ids[0]] }], 'v1'),
    ).toThrow(/duas vezes/i);
  });

  it('unidade já vendida não vende de novo', () => {
    const ids = entrarComUnidades(moto, 2, 'e1');
    vender([{ productId: moto, quantity: 1, unitIds: [ids[0]] }], 'v1');
    expect(() =>
      vender([{ productId: moto, quantity: 1, unitIds: [ids[0]] }], 'v2'),
    ).toThrow(/já foi vendida/i);
  });

  it('unidade de outro produto é recusada', () => {
    const outra = createProduct(empresa, { name: 'Honda Biz', priceCents: 1_500_000 }).id;
    updateProduct(empresa, outra, { serialized: true });
    const idsBiz = entrarComUnidades(outra, 1, 'e2');
    entrarComUnidades(moto, 1, 'e1');

    expect(() =>
      vender([{ productId: moto, quantity: 1, unitIds: [idsBiz[0]] }], 'v1'),
    ).toThrow(/outro produto/i);
  });
});

describe('cancelar devolve as MESMAS peças', () => {
  it('a unidade vendida volta para o estoque', () => {
    const ids = entrarComUnidades(moto, 3, 'e1');
    const { sale } = vender([{ productId: moto, quantity: 2, unitIds: [ids[0], ids[1]] }], 'v1');
    expect(countInStock(empresa, moto)).toBe(1);

    cancelSale({ companyId: empresa, saleId: sale.id, userId: usuario, reason: 'teste' });

    expect(getBalance(empresa, moto)).toBe(3);
    expect(countInStock(empresa, moto)).toBe(3);
    expect(getUnit(empresa, ids[0])?.status).toBe('in_stock');
    expect(getUnit(empresa, ids[1])?.status).toBe('in_stock');
  });

  /**
   * A referência de saída é limpa ao voltar. Se ficasse, o próximo estorno
   * acharia a mesma unidade de novo.
   */
  it('a unidade devolvida perde o carimbo da venda cancelada', () => {
    const ids = entrarComUnidades(moto, 1, 'e1');
    const { sale } = vender([{ productId: moto, quantity: 1, unitIds: [ids[0]] }], 'v1');
    cancelSale({ companyId: empresa, saleId: sale.id, userId: usuario, reason: 'teste' });

    const u = getUnit(empresa, ids[0])!;
    expect(u.exit_reference_id).toBeNull();
    expect(u.sale_item_id).toBeNull();
  });

  it('vender de novo depois de cancelar funciona', () => {
    const ids = entrarComUnidades(moto, 1, 'e1');
    const { sale } = vender([{ productId: moto, quantity: 1, unitIds: [ids[0]] }], 'v1');
    cancelSale({ companyId: empresa, saleId: sale.id, userId: usuario, reason: 'teste' });

    expect(() =>
      vender([{ productId: moto, quantity: 1, unitIds: [ids[0]] }], 'v2'),
    ).not.toThrow();
    expect(getBalance(empresa, moto)).toBe(0);
  });
});

describe('transferência move a MESMA peça de lugar', () => {
  it('a unidade troca de local, e não vira outra unidade', () => {
    const deposito = createLocation(empresa, { code: 'DEP', name: 'Depósito' }).id;
    const loja = createLocation(empresa, { code: 'LOJA', name: 'Loja' }).id;

    const ids = createUnits(empresa, moto, 2, {
      entryReferenceType: 'ajuste',
      entryReferenceId: 'e1',
      locationId: deposito,
    });
    applyMovement({
      companyId: empresa,
      productId: moto,
      movementType: 'in',
      quantity: 2,
      referenceType: 'ajuste',
      referenceId: 'e1',
      locationId: deposito,
      unitIds: ids,
    });

    transferStock({
      companyId: empresa,
      productId: moto,
      fromLocationId: deposito,
      toLocationId: loja,
      quantity: 1,
    });

    // O total não mudou, e continuam sendo DUAS unidades — não três.
    expect(getBalance(empresa, moto)).toBe(2);
    expect(countInStock(empresa, moto)).toBe(2);
    expect(listUnits(empresa, moto).filter((u) => u.location_id === loja)).toHaveLength(1);
  });
});

describe('ligar o controle num produto que já tem saldo', () => {
  /**
   * O saldo diz 3 e não há unidade nenhuma. Sem regularizar, a próxima venda
   * seria recusada com o estoque dizendo que há três — e ninguém entenderia.
   */
  it('as unidades que faltavam são criadas na hora', () => {
    const bike = createProduct(empresa, { name: 'Bicicleta', priceCents: 90000 }).id;
    applyMovement({
      companyId: empresa,
      productId: bike,
      movementType: 'in',
      quantity: 3,
      referenceType: 'ajuste',
      referenceId: 'e1',
    });

    updateProduct(empresa, bike, { serialized: true });

    expect(countInStock(empresa, bike)).toBe(3);
    expect(getBalance(empresa, bike)).toBe(3);
  });

  it('elas nascem sem identidade, para aparecerem pedindo o chassi', () => {
    const bike = createProduct(empresa, { name: 'Bicicleta', priceCents: 90000 }).id;
    applyMovement({
      companyId: empresa,
      productId: bike,
      movementType: 'in',
      quantity: 2,
      referenceType: 'ajuste',
      referenceId: 'e1',
    });
    updateProduct(empresa, bike, { serialized: true });

    const unidades = listUnits(empresa, bike);
    expect(unidades.every((u) => u.chassis === null && u.serial_number === null)).toBe(true);
    expect(unidades[0].entry_reference_type).toBe('regularizacao');
  });

  it('desligar e religar não duplica as unidades', () => {
    const bike = createProduct(empresa, { name: 'Bicicleta', priceCents: 90000 }).id;
    applyMovement({
      companyId: empresa,
      productId: bike,
      movementType: 'in',
      quantity: 2,
      referenceType: 'ajuste',
      referenceId: 'e1',
    });

    updateProduct(empresa, bike, { serialized: true });
    updateProduct(empresa, bike, { serialized: false });
    updateProduct(empresa, bike, { serialized: true });

    expect(countInStock(empresa, bike)).toBe(2);
  });

  it('saldo fracionado não vira controle por unidade', () => {
    const granel = createProduct(empresa, { name: 'Corrente a metro', priceCents: 1500 }).id;
    applyMovement({
      companyId: empresa,
      productId: granel,
      movementType: 'in',
      quantity: 2.5,
      referenceType: 'ajuste',
      referenceId: 'e1',
    });

    expect(() => updateProduct(empresa, granel, { serialized: true })).toThrow(/fracionado/i);
  });

  /** O que se pesa não se conta uma a uma. */
  it('serializado e pesável não convivem', () => {
    expect(() => updateProduct(empresa, moto, { weighable: true })).toThrow(/ao mesmo tempo/i);
  });
});

describe('identidade', () => {
  it('nasce nula e é preenchida depois', () => {
    const ids = entrarComUnidades(moto, 1, 'e1');
    expect(getUnit(empresa, ids[0])?.chassis).toBeNull();

    identifyUnit(empresa, ids[0], { chassis: '9C2KC1670PR000001', plate: 'ABC1D23' });
    expect(getUnit(empresa, ids[0])?.chassis).toBe('9C2KC1670PR000001');
  });

  /**
   * Ao contrário de `core_equipment`, que é write-once, aqui a correção é
   * permitida: chassi digitado errado sem conserto faz alguém criar uma
   * segunda unidade, e o estoque dobra.
   */
  it('pode ser corrigida enquanto a peça está em estoque', () => {
    const ids = entrarComUnidades(moto, 1, 'e1');
    identifyUnit(empresa, ids[0], { chassis: 'ERRADO' });
    identifyUnit(empresa, ids[0], { chassis: 'CERTO' });
    expect(getUnit(empresa, ids[0])?.chassis).toBe('CERTO');
  });

  /** Depois de vendida, o chassi já está no documento do cliente. */
  it('não muda depois que a peça saiu', () => {
    const ids = entrarComUnidades(moto, 1, 'e1');
    identifyUnit(empresa, ids[0], { chassis: '9C2KC1670PR000001' });
    vender([{ productId: moto, quantity: 1, unitIds: [ids[0]] }], 'v1');

    expect(() => identifyUnit(empresa, ids[0], { chassis: 'OUTRO' })).toThrow(/não muda mais/i);
  });

  it('identidade repetida na empresa é recusada', () => {
    const ids = entrarComUnidades(moto, 2, 'e1');
    identifyUnit(empresa, ids[0], { chassis: '9C2KC1670PR000001' });
    expect(() => identifyUnit(empresa, ids[1], { chassis: '9C2KC1670PR000001' })).toThrow(
      /já existe/i,
    );
  });

  it('texto em branco não vira identidade', () => {
    const ids = entrarComUnidades(moto, 2, 'e1');
    identifyUnit(empresa, ids[0], { chassis: '   ' });
    // Se o branco virasse string vazia, o segundo colidiria no índice único.
    expect(() => identifyUnit(empresa, ids[1], { chassis: '' })).not.toThrow();
    expect(getUnit(empresa, ids[0])?.chassis).toBeNull();
  });

  it('acha a peça por qualquer uma das identidades', () => {
    const ids = entrarComUnidades(moto, 1, 'e1');
    identifyUnit(empresa, ids[0], { chassis: '9C2KC1670PR000001', motorNumber: 'KC16E0000001' });

    expect(searchUnit(empresa, '9C2KC1670PR000001').map((u) => u.id)).toEqual([ids[0]]);
    expect(searchUnit(empresa, 'KC16E0000001').map((u) => u.id)).toEqual([ids[0]]);
  });
});

describe('escolha automática, onde não há operador', () => {
  it('FIFO devolve as mais antigas primeiro', () => {
    const ids = entrarComUnidades(moto, 3, 'e1');
    expect(pickUnitsFifo(empresa, moto, 2)).toEqual([ids[0], ids[1]]);
  });

  it('pedir mais do que há é recusado com o número na mensagem', () => {
    entrarComUnidades(moto, 2, 'e1');
    expect(() => pickUnitsFifo(empresa, moto, 5)).toThrow(/2 unidade\(s\)/);
  });
});

describe('produto comum não muda de comportamento', () => {
  it('vender camiseta continua não pedindo unidade', () => {
    applyMovement({
      companyId: empresa,
      productId: camiseta,
      movementType: 'in',
      quantity: 10,
      referenceType: 'ajuste',
      referenceId: 'e1',
    });
    vender([{ productId: camiseta, quantity: 3 }], 'v1');
    expect(getBalance(empresa, camiseta)).toBe(7);
  });

  it('isSerialized só é verdade para quem foi marcado', () => {
    expect(isSerialized(empresa, moto)).toBe(true);
    expect(isSerialized(empresa, camiseta)).toBe(false);
  });
});
