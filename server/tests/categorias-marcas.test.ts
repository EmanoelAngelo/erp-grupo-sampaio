/**
 * Vocabulário do catálogo: categorias, subcategorias e marcas.
 *
 * O problema real: categoria e marca eram texto livre, e "Masculino" com
 * "masculino" viravam duas — o filtro da vitrine mostrava metade das peças em
 * cada uma.
 *
 * Criar a lista impede o erro NOVO. O que conserta o que já está torto é a
 * FUSÃO, e é ela que estes testes cobrem com mais cuidado.
 */
import { beforeEach, describe, expect, it } from 'vitest';

process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_DATABASE_PATH = ':memory:';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

const { ensureCoreSchema } = await import('../src/db/schema.js');
const { resetDbForTests } = await import('../src/db/database.js');
const { upsertCompany } = await import('../src/services/auth/IdentityService.js');
const { createProduct, getProduct } = await import('../src/services/core/CatalogService.js');
const {
  listBrands,
  listCategories,
  listOrphanValues,
  mergeBrand,
  mergeCategory,
  removeBrand,
  removeCategory,
  upsertBrand,
  upsertCategory,
} = await import('../src/services/core/TaxonomyService.js');

let companyId: string;

beforeEach(() => {
  ensureCoreSchema();
  resetDbForTests();
  companyId = upsertCompany({
    slug: 'gringa',
    legalName: 'Gringa Ltda',
    tradeName: 'Gringa',
  });
});

function produto(overrides: Record<string, unknown> = {}) {
  return createProduct(companyId, {
    name: `Peça ${Math.random().toString(36).slice(2, 8)}`,
    priceCents: 9900,
    ...overrides,
  } as Parameters<typeof createProduct>[1]);
}

describe('categorias', () => {
  it('cria categoria e subcategoria em dois níveis', () => {
    const pai = upsertCategory({ companyId, name: 'Masculino' });
    upsertCategory({ companyId, name: 'Camisas', parentId: pai.id });

    const arvore = listCategories(companyId);
    expect(arvore).toHaveLength(1);
    expect(arvore[0].name).toBe('Masculino');
    expect(arvore[0].children?.[0].name).toBe('Camisas');
  });

  it('recusa nome repetido ignorando maiúsculas', () => {
    upsertCategory({ companyId, name: 'Masculino' });
    // Sem isto, a UNIQUE do banco (sensível a caixa) deixaria passar as duas —
    // que é exatamente o problema que a tela veio resolver.
    expect(() => upsertCategory({ companyId, name: 'masculino' })).toThrowError(/já existe/i);
    expect(() => upsertCategory({ companyId, name: '  MASCULINO ' })).toThrowError(/já existe/i);
  });

  it('o mesmo nome pode existir em categorias diferentes', () => {
    const masculino = upsertCategory({ companyId, name: 'Masculino' });
    const feminino = upsertCategory({ companyId, name: 'Feminino' });
    upsertCategory({ companyId, name: 'Camisas', parentId: masculino.id });
    // "Camisas" em Feminino é outra coisa, e deve ser aceito.
    expect(() =>
      upsertCategory({ companyId, name: 'Camisas', parentId: feminino.id }),
    ).not.toThrow();
  });

  it('subcategoria não tem subcategoria', () => {
    const pai = upsertCategory({ companyId, name: 'Masculino' });
    const filho = upsertCategory({ companyId, name: 'Camisas', parentId: pai.id });
    expect(() =>
      upsertCategory({ companyId, name: 'Sociais', parentId: filho.id }),
    ).toThrowError(/não pode ter subcategoria/i);
  });

  it('nome em branco é recusado', () => {
    expect(() => upsertCategory({ companyId, name: '   ' })).toThrowError(/informe o nome/i);
  });

  it('conta quantos produtos usam a categoria', () => {
    upsertCategory({ companyId, name: 'Masculino' });
    produto({ category: 'Masculino' });
    produto({ category: 'Masculino' });
    produto({ category: 'Feminino' });

    const [masculino] = listCategories(companyId);
    expect(masculino.usage).toBe(2);
  });
});

describe('renomear leva os produtos junto', () => {
  it('produto passa a apontar para o nome novo', () => {
    const cat = upsertCategory({ companyId, name: 'Masculino' });
    const p = produto({ category: 'Masculino' });

    upsertCategory({ companyId, id: cat.id, name: 'Moda Masculina' });

    // Sem isto o produto ficaria apontando para um nome fora da lista.
    expect(getProduct(companyId, String(p.id))?.category).toBe('Moda Masculina');
  });

  it('renomear subcategoria mexe na coluna certa', () => {
    const pai = upsertCategory({ companyId, name: 'Masculino' });
    const sub = upsertCategory({ companyId, name: 'Camisas', parentId: pai.id });
    const p = produto({ category: 'Masculino', subcategory: 'Camisas' });

    upsertCategory({ companyId, id: sub.id, name: 'Camisaria', parentId: pai.id });

    const atualizado = getProduct(companyId, String(p.id));
    expect(atualizado?.subcategory).toBe('Camisaria');
    // A categoria não pode ter sido tocada.
    expect(atualizado?.category).toBe('Masculino');
  });
});

describe('fusão — o que conserta o catálogo já sujo', () => {
  it('os produtos da origem passam para o destino e a origem some', () => {
    // O caso real: dois nomes diferentes que significam a mesma coisa. Um
    // veio da semeadura do catálogo antigo, o outro alguém cadastrou depois.
    const certa = upsertCategory({ companyId, name: 'Masculino' });
    const errada = upsertCategory({ companyId, name: 'Moda Masculina' });
    const p1 = produto({ category: 'Masculino' });
    const p2 = produto({ category: 'Moda Masculina' });

    mergeCategory({ companyId, sourceId: errada.id, targetId: certa.id });

    expect(getProduct(companyId, String(p1.id))?.category).toBe('Masculino');
    expect(getProduct(companyId, String(p2.id))?.category).toBe('Masculino');
    expect(listCategories(companyId)).toHaveLength(1);
    expect(listCategories(companyId)[0].usage).toBe(2);
  });

  it('as subcategorias da origem sobrevivem à fusão', () => {
    const destino = upsertCategory({ companyId, name: 'Masculino' });
    const origem = upsertCategory({ companyId, name: 'Masculinos' });
    upsertCategory({ companyId, name: 'Bermudas', parentId: origem.id });

    mergeCategory({ companyId, sourceId: origem.id, targetId: destino.id });

    // Sem repassar o pai antes de apagar, o CASCADE levaria a subcategoria.
    const [cat] = listCategories(companyId);
    expect(cat.children?.map((c) => c.name)).toContain('Bermudas');
  });

  it('não une categoria com subcategoria', () => {
    const pai = upsertCategory({ companyId, name: 'Masculino' });
    const sub = upsertCategory({ companyId, name: 'Camisas', parentId: pai.id });
    expect(() =>
      mergeCategory({ companyId, sourceId: sub.id, targetId: pai.id }),
    ).toThrowError(/categoria com categoria/i);
  });

  it('não une uma categoria com ela mesma', () => {
    const cat = upsertCategory({ companyId, name: 'Masculino' });
    expect(() =>
      mergeCategory({ companyId, sourceId: cat.id, targetId: cat.id }),
    ).toThrowError(/diferentes/i);
  });
});

describe('remoção', () => {
  it('categoria em uso NÃO é removida', () => {
    const cat = upsertCategory({ companyId, name: 'Masculino' });
    produto({ category: 'Masculino' });
    // Apagar deixaria o produto apontando para um nome fora da lista.
    expect(() => removeCategory(companyId, cat.id)).toThrowError(/está em 1 produto/i);
  });

  it('categoria sem uso é removida', () => {
    const cat = upsertCategory({ companyId, name: 'Temporada Antiga' });
    removeCategory(companyId, cat.id);
    expect(listCategories(companyId)).toHaveLength(0);
  });
});

describe('marcas', () => {
  it('cria, conta uso e recusa repetição por caixa', () => {
    upsertBrand({ companyId, name: 'Nike' });
    produto({ brand: 'Nike' });

    expect(listBrands(companyId)[0].usage).toBe(1);
    expect(() => upsertBrand({ companyId, name: 'nike' })).toThrowError(/já existe/i);
  });

  it('renomear leva os produtos junto', () => {
    const marca = upsertBrand({ companyId, name: 'Adidas' });
    const p = produto({ brand: 'Adidas' });
    upsertBrand({ companyId, id: marca.id, name: 'Adidas Originals' });
    expect(getProduct(companyId, String(p.id))?.brand).toBe('Adidas Originals');
  });

  it('fusão migra os produtos e apaga a origem', () => {
    const certa = upsertBrand({ companyId, name: 'Nike' });
    const errada = upsertBrand({ companyId, name: 'Nike Brasil' });
    const p = produto({ brand: 'Nike Brasil' });

    mergeBrand({ companyId, sourceId: errada.id, targetId: certa.id });

    expect(getProduct(companyId, String(p.id))?.brand).toBe('Nike');
    expect(listBrands(companyId)).toHaveLength(1);
  });

  it('marca em uso não é removida', () => {
    const marca = upsertBrand({ companyId, name: 'Puma' });
    produto({ brand: 'Puma' });
    expect(() => removeBrand(companyId, marca.id)).toThrowError(/está em 1 produto/i);
  });
});

describe('valores soltos', () => {
  it('mostra o que está escrito nos produtos mas não na lista', () => {
    // Entraram por importação de XML, antes de o vocabulário existir.
    produto({ category: 'Acessórios', subcategory: 'Bonés', brand: 'Oakley' });

    const soltos = listOrphanValues(companyId);
    expect(soltos.categories).toContain('Acessórios');
    expect(soltos.subcategories).toContain('Bonés');
    expect(soltos.brands).toContain('Oakley');
  });

  it('o que já está na lista não aparece como solto', () => {
    upsertCategory({ companyId, name: 'Acessórios' });
    produto({ category: 'Acessórios' });
    expect(listOrphanValues(companyId).categories).not.toContain('Acessórios');
  });

  it('a comparação ignora maiúsculas e espaços', () => {
    upsertBrand({ companyId, name: 'Nike' });
    produto({ brand: ' nike ' });
    expect(listOrphanValues(companyId).brands).toHaveLength(0);
  });
});

describe('isolamento por operação', () => {
  it('a lista de uma empresa não aparece na outra', () => {
    upsertCategory({ companyId, name: 'Masculino' });
    upsertBrand({ companyId, name: 'Nike' });

    const outra = upsertCompany({
      slug: 'conceito',
      legalName: 'Conceito Ltda',
      tradeName: 'Conceito',
    });
    expect(listCategories(outra)).toHaveLength(0);
    expect(listBrands(outra)).toHaveLength(0);
  });

  it('a contagem de uso não atravessa empresas', () => {
    upsertCategory({ companyId, name: 'Masculino' });
    const outra = upsertCompany({
      slug: 'me-mimei',
      legalName: 'Me Mimei Ltda',
      tradeName: 'Me Mimei',
    });
    createProduct(outra, { name: 'Peça da outra', priceCents: 100, category: 'Masculino' });

    expect(listCategories(companyId)[0].usage).toBe(0);
  });
});
