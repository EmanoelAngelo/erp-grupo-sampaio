/**
 * Grade de produto (tamanho/cor).
 *
 * Quatro das seis operações vendem roupa. Sem grade, "Camiseta Polo" tem um
 * saldo só e o balcão vende o P quando restava GG. Os testes abaixo cobrem a
 * consequência prática disso: cada variante tem estoque, código e EAN
 * próprios, e o modelo não é vendável.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_DATABASE_PATH = ':memory:';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

const { ensureCoreSchema } = await import('../src/db/schema.js');
const { resetDbForTests } = await import('../src/db/database.js');
const { createProduct, searchProducts } = await import('../src/services/core/CatalogService.js');
const { applyMovement, getBalance } = await import('../src/services/core/InventoryService.js');
const { createSale } = await import('../src/services/core/SalesService.js');
const { upsertCompany, upsertUser, linkUserToCompany } = await import(
  '../src/services/auth/IdentityService.js'
);
const { combinations, generateVariants, hasVariants, listVariants, variantStock } = await import(
  '../src/services/core/VariantService.js'
);
const { isValidEan13 } = await import('../src/services/core/BarcodeService.js');

let companyId: string;
let modelo: string;
let userId: string;

beforeEach(async () => {
  ensureCoreSchema();
  resetDbForTests();
  companyId = upsertCompany({ slug: 'gringa', legalName: 'Gringa Ltda', tradeName: 'Gringa' });
  userId = await upsertUser({ login: 'CAIXA', displayName: 'Caixa', password: 'senha-teste-123' });
  linkUserToCompany(userId, companyId, 'operador_caixa_loja', true);
  modelo = String(
    createProduct(companyId, { name: 'Camiseta Polo', priceCents: 8900, costCents: 4000 }).id,
  );
});

describe('combinações da grade', () => {
  it('faz o produto cartesiano dos eixos', () => {
    const combos = combinations({ tamanho: ['P', 'M'], cor: ['Azul', 'Preto'] });
    expect(combos).toHaveLength(4);
    expect(combos).toContainEqual({ cor: 'Azul', tamanho: 'P' });
    expect(combos).toContainEqual({ cor: 'Preto', tamanho: 'M' });
  });

  it('a ordem é estável entre execuções', () => {
    const axes = { cor: ['Azul', 'Preto'], tamanho: ['P', 'M', 'G'] };
    expect(combinations(axes)).toEqual(combinations(axes));
  });

  it('eixo vazio é recusado', () => {
    expect(() => combinations({ tamanho: [] })).toThrowError(/vazio/i);
  });
});

describe('geração da grade', () => {
  it('cria uma variante por combinação, com código e EAN próprios', () => {
    const { created } = generateVariants({
      companyId,
      productId: modelo,
      axes: { tamanho: ['P', 'M', 'G'] },
    });

    expect(created).toHaveLength(3);
    const codigos = new Set(created.map((v) => v.internal_code));
    expect(codigos.size).toBe(3);

    for (const variante of created) {
      expect(variante.barcode).toBeTruthy();
      expect(isValidEan13(String(variante.barcode))).toBe(true);
    }
    // EAN repetido faria duas peças diferentes lerem igual no PDV.
    expect(new Set(created.map((v) => v.barcode)).size).toBe(3);
  });

  it('a variante herda preço e dados do modelo', () => {
    const { created } = generateVariants({
      companyId,
      productId: modelo,
      axes: { tamanho: ['M'] },
    });
    expect(created[0].price_cents).toBe(8900);
    expect(created[0].name).toContain('Camiseta Polo');
    expect(created[0].name).toContain('M');
  });

  it('preço específico por combinação sobrepõe o do modelo', () => {
    const { created } = generateVariants({
      companyId,
      productId: modelo,
      axes: { tamanho: ['M', 'GG'] },
      priceByCombo: { 'tamanho=GG': 9900 },
    });
    const gg = created.find((v) => v.name.includes('GG'));
    const m = created.find((v) => v.name.endsWith('M'));
    expect(gg?.price_cents).toBe(9900);
    expect(m?.price_cents).toBe(8900);
  });

  it('rodar de novo acrescenta só o que falta e não recria o que existe', () => {
    const primeira = generateVariants({
      companyId,
      productId: modelo,
      axes: { tamanho: ['P', 'M'] },
    });
    const eanOriginal = primeira.created.map((v) => v.barcode).sort();

    const segunda = generateVariants({
      companyId,
      productId: modelo,
      axes: { tamanho: ['P', 'M', 'G'] },
    });

    expect(segunda.created).toHaveLength(1);
    expect(segunda.existing).toHaveLength(2);
    expect(listVariants(companyId, modelo)).toHaveLength(3);
    // Etiqueta já impressa não pode mudar de código.
    expect(segunda.existing.map((v) => v.barcode).sort()).toEqual(eanOriginal);
  });

  it('variante não tem grade própria', () => {
    const { created } = generateVariants({
      companyId,
      productId: modelo,
      axes: { tamanho: ['M'] },
    });
    expect(() =>
      generateVariants({ companyId, productId: created[0].id, axes: { cor: ['Azul'] } }),
    ).toThrowError(/não pode ter grade/i);
  });

  it('produto de outra empresa não é alcançável', () => {
    const outra = upsertCompany({
      slug: 'me-mimei',
      legalName: 'Me Mimei Ltda',
      tradeName: 'Me Mimei',
    });
    expect(() =>
      generateVariants({ companyId: outra, productId: modelo, axes: { tamanho: ['M'] } }),
    ).toThrowError(/não encontrado/i);
  });
});

describe('estoque por variante', () => {
  it('cada tamanho tem saldo próprio', () => {
    const { created } = generateVariants({
      companyId,
      productId: modelo,
      axes: { tamanho: ['P', 'M', 'G'] },
    });
    const p = created.find((v) => v.name.endsWith('P'))!;
    const g = created.find((v) => v.name.endsWith('G'))!;

    applyMovement({
      companyId,
      productId: p.id,
      movementType: 'in',
      quantity: 2,
      referenceType: 'entrada',
      referenceId: 'nf-1',
    });
    applyMovement({
      companyId,
      productId: g.id,
      movementType: 'in',
      quantity: 7,
      referenceType: 'entrada',
      referenceId: 'nf-1',
    });

    expect(getBalance(companyId, p.id)).toBe(2);
    expect(getBalance(companyId, g.id)).toBe(7);

    const resumo = variantStock(companyId, modelo);
    expect(resumo.totalQuantity).toBe(9);
    expect(resumo.items).toHaveLength(3);
  });

  it('vender o P não consome o saldo do G', () => {
    const { created } = generateVariants({
      companyId,
      productId: modelo,
      axes: { tamanho: ['P', 'G'] },
    });
    const p = created.find((v) => v.name.endsWith('P'))!;
    const g = created.find((v) => v.name.endsWith('G'))!;

    for (const v of [p, g]) {
      applyMovement({
        companyId,
        productId: v.id,
        movementType: 'in',
        quantity: 5,
        referenceType: 'entrada',
        referenceId: `nf-${v.id}`,
      });
    }

    createSale({
      companyId,
      userId,
      idempotencyKey: randomUUID(),
      items: [{ productId: p.id, quantity: 2 }],
      payments: [{ method: 'dinheiro', amountCents: 17800 }],
    });

    expect(getBalance(companyId, p.id)).toBe(3);
    expect(getBalance(companyId, g.id)).toBe(5);
  });

  it('acabar o P não impede vender o G', () => {
    const { created } = generateVariants({
      companyId,
      productId: modelo,
      axes: { tamanho: ['P', 'G'] },
    });
    const g = created.find((v) => v.name.endsWith('G'))!;
    applyMovement({
      companyId,
      productId: g.id,
      movementType: 'in',
      quantity: 1,
      referenceType: 'entrada',
      referenceId: 'nf-g',
    });

    const { sale } = createSale({
      companyId,
      userId,
      idempotencyKey: randomUUID(),
      items: [{ productId: g.id, quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: 8900 }],
    });
    expect(sale.total_cents).toBe(8900);
  });
});

describe('busca do PDV', () => {
  it('não oferece o modelo, oferece os tamanhos', () => {
    generateVariants({ companyId, productId: modelo, axes: { tamanho: ['P', 'M'] } });
    const achados = searchProducts(companyId, 'Camiseta');

    expect(achados.map((p) => p.id)).not.toContain(modelo);
    expect(achados).toHaveLength(2);
    expect(achados.every((p) => String(p.name).startsWith('Camiseta Polo ·'))).toBe(true);
  });

  it('ler o código de barras da variante cai na peça exata', () => {
    const { created } = generateVariants({
      companyId,
      productId: modelo,
      axes: { tamanho: ['P', 'M'] },
    });
    const m = created.find((v) => v.name.endsWith('M'))!;
    const achados = searchProducts(companyId, String(m.barcode));

    expect(achados).toHaveLength(1);
    expect(achados[0].id).toBe(m.id);
  });

  it('produto sem grade continua aparecendo', () => {
    const solto = String(createProduct(companyId, { name: 'Boné Aba Reta', priceCents: 4000 }).id);
    expect(searchProducts(companyId, 'Boné').map((p) => p.id)).toContain(solto);
  });
});

describe('modelo com grade não é vendável', () => {
  /*
    O SALDO NEM CHEGA MAIS AO MODELO.

    Este teste dava entrada de 10 no modelo para depois provar que a venda
    recusava. O funil de estoque passou a recusar antes: modelo de grade não
    recebe saldo, porque mercadoria presa nele some do PDV e escapa da contagem
    de inventário. A guarda da venda continua de pé e é conferida logo abaixo,
    agora sem precisar criar o estado que não deveria existir.
  */
  it('dar entrada no modelo é recusado — o saldo é da variante', () => {
    generateVariants({ companyId, productId: modelo, axes: { tamanho: ['P', 'M'] } });

    expect(() =>
      applyMovement({
        companyId,
        productId: modelo,
        movementType: 'in',
        quantity: 10,
        referenceType: 'entrada',
        referenceId: 'nf-modelo',
      }),
    ).toThrowError(/modelo de grade/i);
  });

  it('vender o modelo é recusado com a razão certa', () => {
    generateVariants({ companyId, productId: modelo, axes: { tamanho: ['P', 'M'] } });

    expect(() =>
      createSale({
        companyId,
        userId,
        idempotencyKey: randomUUID(),
        items: [{ productId: modelo, quantity: 1 }],
        payments: [{ method: 'dinheiro', amountCents: 8900 }],
      }),
    ).toThrowError(/tem grade/i);
  });

  it('produto sem grade continua vendável normalmente', () => {
    const solto = String(createProduct(companyId, { name: 'Boné', priceCents: 4000 }).id);
    applyMovement({
      companyId,
      productId: solto,
      movementType: 'in',
      quantity: 3,
      referenceType: 'entrada',
      referenceId: 'nf-bone',
    });

    expect(hasVariants(companyId, solto)).toBe(false);
    const { sale } = createSale({
      companyId,
      userId,
      idempotencyKey: randomUUID(),
      items: [{ productId: solto, quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: 4000 }],
    });
    expect(sale.total_cents).toBe(4000);
    expect(getBalance(companyId, solto)).toBe(2);
  });
});
