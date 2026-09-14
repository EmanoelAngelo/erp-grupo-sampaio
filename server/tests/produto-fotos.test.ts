/**
 * Fotos do produto.
 *
 * A mesma foto alimenta o balcão e a vitrine — não existe imagem de
 * e-commerce separada, porque um dia as duas divergiriam e o cliente veria na
 * loja um produto diferente do que está na prateleira.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_DATABASE_PATH = ':memory:';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

const { ensureCoreSchema } = await import('../src/db/schema.js');
const { resetDbForTests } = await import('../src/db/database.js');
const { upsertCompany } = await import('../src/services/auth/IdentityService.js');
const { createProduct, getProduct, updateProduct } = await import(
  '../src/services/core/CatalogService.js'
);
const {
  MAX_IMAGE_BYTES,
  addProductImage,
  listProductImages,
  removeProductImage,
  reorderProductImages,
  setPrimaryImage,
  uploadsDir,
} = await import('../src/services/core/ProductImageService.js');

let companyId: string;
let produto: string;
const criados: string[] = [];

/** PNG 1x1 real, pequeno o bastante para viver no teste. */
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function dataUrl(mime = 'image/png', base64 = PNG_1X1): string {
  return `data:${mime};base64,${base64}`;
}

function enviar(overrides: Record<string, unknown> = {}) {
  const img = addProductImage({
    companyId,
    productId: produto,
    dataUrl: dataUrl(),
    fileName: 'foto.png',
    ...overrides,
  } as Parameters<typeof addProductImage>[0]);
  criados.push(img.url.split('/').pop() ?? '');
  return img;
}

beforeEach(() => {
  ensureCoreSchema();
  resetDbForTests();
  companyId = upsertCompany({
    slug: 'gringa',
    legalName: 'Gringa Ltda',
    tradeName: 'Gringa',
  });
  produto = String(createProduct(companyId, { name: 'Vestido Longo', priceCents: 12900 }).id);
});

describe('envio', () => {
  it('grava o arquivo no disco e registra o caminho público', () => {
    const img = enviar();
    expect(img.url).toMatch(/^\/uploads\/produtos\//);
    expect(existsSync(join(uploadsDir(), img.url.split('/').pop()!))).toBe(true);
    expect(img.byte_size).toBeGreaterThan(0);
  });

  it('a primeira foto vira a principal sozinha', () => {
    const img = enviar();
    expect(img.is_primary).toBe(1);
    // O produto passa a apontar para ela: vitrine e PDV já leem esse campo.
    expect(getProduct(companyId, produto)?.image_url).toBe(img.url);
  });

  it('a segunda foto entra na galeria sem virar principal', () => {
    enviar();
    const segunda = enviar();
    expect(segunda.is_primary).toBe(0);
    expect(listProductImages(companyId, produto)).toHaveLength(2);
  });

  it('formato não aceito é recusado', () => {
    expect(() => enviar({ dataUrl: dataUrl('application/pdf') })).toThrowError(/JPEG, PNG ou WebP/i);
    expect(() => enviar({ dataUrl: dataUrl('image/gif') })).toThrowError(/JPEG, PNG ou WebP/i);
  });

  it('arquivo vazio é recusado', () => {
    expect(() => enviar({ dataUrl: dataUrl('image/png', '') })).toThrowError(/vazio/i);
  });

  it('arquivo acima do limite é recusado', () => {
    const gigante = Buffer.alloc(MAX_IMAGE_BYTES + 1).toString('base64');
    expect(() => enviar({ dataUrl: dataUrl('image/png', gigante) })).toThrowError(/acima de/i);
  });

  it('o nome do arquivo do cliente não decide o caminho no disco', () => {
    // Sem isto, "../../..." escreveria fora da pasta de uploads.
    const img = enviar({ fileName: '../../../etc/passwd.png' });
    const noDisco = img.url.split('/').pop()!;
    expect(noDisco).not.toContain('..');
    expect(noDisco).toMatch(/^[0-9a-f-]+\.png$/);
    // O nome original fica só como rótulo.
    expect(img.file_name).toBe('../../../etc/passwd.png');
  });

  it('produto de outra empresa não recebe foto', () => {
    const outra = upsertCompany({
      slug: 'conceito',
      legalName: 'Conceito Ltda',
      tradeName: 'Conceito',
    });
    expect(() =>
      addProductImage({ companyId: outra, productId: produto, dataUrl: dataUrl() }),
    ).toThrowError(/não encontrado/i);
  });
});

describe('galeria', () => {
  it('trocar a principal atualiza o produto', () => {
    const primeira = enviar();
    const segunda = enviar();

    setPrimaryImage(companyId, produto, segunda.id);

    const lista = listProductImages(companyId, produto);
    expect(lista[0].id).toBe(segunda.id);
    expect(lista.find((i) => i.id === primeira.id)?.is_primary).toBe(0);
    expect(getProduct(companyId, produto)?.image_url).toBe(segunda.url);
  });

  it('remover apaga o arquivo do disco', () => {
    const img = enviar();
    const caminho = join(uploadsDir(), img.url.split('/').pop()!);
    expect(existsSync(caminho)).toBe(true);

    removeProductImage(companyId, produto, img.id);
    expect(existsSync(caminho)).toBe(false);
    expect(listProductImages(companyId, produto)).toHaveLength(0);
  });

  it('removida a principal, a próxima assume', () => {
    const primeira = enviar();
    const segunda = enviar();
    removeProductImage(companyId, produto, primeira.id);

    const lista = listProductImages(companyId, produto);
    expect(lista).toHaveLength(1);
    expect(lista[0].id).toBe(segunda.id);
    expect(lista[0].is_primary).toBe(1);
    expect(getProduct(companyId, produto)?.image_url).toBe(segunda.url);
  });

  it('sem fotos, o produto fica sem imagem — não recebe uma genérica', () => {
    const img = enviar();
    removeProductImage(companyId, produto, img.id);
    // Imagem falsa no lugar enganaria o cliente sobre o que ele compra.
    expect(getProduct(companyId, produto)?.image_url).toBeNull();
  });

  it('reordenar muda a ordem da galeria', () => {
    const a = enviar();
    const b = enviar();
    const c = enviar();

    reorderProductImages(companyId, produto, [c.id, b.id, a.id]);

    // A principal continua em primeiro; a ordem vale para o resto.
    const posicoes = listProductImages(companyId, produto).map((i) => i.id);
    expect(posicoes[0]).toBe(a.id); // ainda é a principal
    expect(posicoes.slice(1)).toEqual([c.id, b.id]);
  });

  it('imagem de outro produto não é removida por engano', () => {
    const img = enviar();
    const outro = String(createProduct(companyId, { name: 'Saia', priceCents: 8900 }).id);
    expect(() => removeProductImage(companyId, outro, img.id)).toThrowError(/não encontrada/i);
  });
});

describe('campos novos do cadastro', () => {
  it('subcategoria e descrição da vitrine são gravadas', () => {
    const p = createProduct(companyId, {
      name: 'Blusa',
      priceCents: 7900,
      category: 'Feminino',
      subcategory: 'Blusas',
      onlineDescription: 'Blusa de viscose, caimento solto.',
    });
    expect(p.subcategory).toBe('Blusas');
    expect(p.online_description).toBe('Blusa de viscose, caimento solto.');
  });

  it('atualizar um campo não embaralha os outros', () => {
    const p = createProduct(companyId, {
      name: 'Calça',
      priceCents: 15900,
      costCents: 7000,
      category: 'Feminino',
      subcategory: 'Calças',
      ncm: '62046200',
    });

    const atualizado = updateProduct(companyId, String(p.id), {
      name: 'Calça Jeans',
      subcategory: 'Jeans',
    });

    // O UPDATE monta as colunas a partir das chaves; antes a lista era fixa e
    // acrescentar um campo gravava valor na coluna errada, em silêncio.
    expect(atualizado.name).toBe('Calça Jeans');
    expect(atualizado.subcategory).toBe('Jeans');
    expect(atualizado.price_cents).toBe(15900);
    expect(atualizado.cost_cents).toBe(7000);
    expect(atualizado.ncm).toBe('62046200');
    expect(atualizado.category).toBe('Feminino');
  });
});

// Limpa os arquivos que os testes escreveram.
afterAll(() => {
  for (const nome of criados) {
    try {
      rmSync(join(uploadsDir(), nome), { force: true });
    } catch {
      // já removido
    }
  }
});
