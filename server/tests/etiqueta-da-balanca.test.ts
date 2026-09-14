/**
 * A ETIQUETA DA BALANÇA É LIDA PELA BUSCA DO BALCÃO (D-pdv-teclado-16).
 *
 * A balança imprime um EAN-13 próprio — prefixo, PLU e o peso (ou o preço)
 * embutido. O produto já tinha o PLU, mas a busca só casava código cadastrado:
 * bipar a etiqueta do tomate dava "nenhum produto encontrado".
 *
 * O sistema gera EAN interno com prefixo 2 ("20…"), então a leitura só existe
 * na subfaixa que a operação DECLARA. Sem declaração, nada muda.
 */
import { beforeEach, describe, expect, it } from 'vitest';

process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_DATABASE_PATH = ':memory:';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

const { ensureCoreSchema } = await import('../src/db/schema.js');
const { resetDbForTests } = await import('../src/db/database.js');
const { upsertCompany } = await import('../src/services/auth/IdentityService.js');
const { createProduct, updateProduct, searchProducts } = await import(
  '../src/services/core/CatalogService.js'
);
const {
  addProductBarcode,
  codigoNaFaixaDaBalanca,
  gravarConfigDaEtiquetaDaBalanca,
  lerConfigDaEtiquetaDaBalanca,
  lerEtiquetaDaBalanca,
} = await import('../src/services/core/CatalogAuxService.js');
const { ensureBarcode } = await import('../src/services/core/BarcodeService.js');
const { digitoVerificadorGtin } = await import('../src/services/core/Gtin.js');

let empresa: string;
let tomate: string;

/** Os 12 primeiros dígitos viram uma etiqueta com o verificador certo. */
function etiqueta(corpo12: string): string {
  return `${corpo12}${digitoVerificadorGtin(corpo12)}`;
}

function recusa(fn: () => unknown): { code?: string; message?: string } {
  try {
    fn();
  } catch (err) {
    return err as { code?: string; message?: string };
  }
  throw new Error('era para recusar');
}

beforeEach(() => {
  resetDbForTests();
  ensureCoreSchema();
  empresa = upsertCompany({
    slug: 'hortifruti',
    legalName: 'Hortifruti Ltda',
    tradeName: 'Hortifruti',
    kind: 'store',
  });
  // A tabela da declaração não está na lista do reset: começa cada teste sem ela.
  gravarConfigDaEtiquetaDaBalanca(empresa, null);
  tomate = String(createProduct(empresa, { name: 'Tomate', unit: 'KG', priceCents: 899 }).id);
  updateProduct(empresa, tomate, { weighable: true, pluCode: '105' });
});

describe('sem declaração, a busca é a de sempre', () => {
  it('a etiqueta da balança não acha nada, e nenhum peso é inventado', () => {
    expect(lerConfigDaEtiquetaDaBalanca(empresa)).toBeNull();
    expect(searchProducts(empresa, etiqueta('230105000352'))).toEqual([]);
  });
});

describe('etiqueta de PESO (prefixo 23, PLU de 4 dígitos)', () => {
  beforeEach(() => {
    gravarConfigDaEtiquetaDaBalanca(empresa, { prefixo: '23', digitosDoPlu: 4, valorEmbutido: 'peso' });
  });

  it('o PLU acha o produto e o peso vem em kg', () => {
    const achados = searchProducts(empresa, etiqueta('230105000352'));
    expect(achados).toHaveLength(1);
    expect(achados[0].id).toBe(tomate);
    expect(achados[0].balanca).toEqual({
      codigo: etiqueta('230105000352'),
      plu: '0105',
      tipo: 'peso',
      quantidade: 0.352,
      precoTotalCents: null,
    });
    // Zero de propósito: a tela que ainda não lê `balanca` manda para a lista
    // (onde se digita o peso), e não põe "1 kg" no carrinho.
    expect(Number(achados[0].matched_exact)).toBe(0);
    expect(achados[0].effective_price_cents).toBe(899);
  });

  it('verificador errado, outro prefixo ou peso zero: não é etiqueta desta balança', () => {
    const certo = etiqueta('230105000352');
    const errado = `${certo.slice(0, 12)}${(Number(certo[12]) + 1) % 10}`;
    expect(searchProducts(empresa, errado)).toEqual([]);
    expect(searchProducts(empresa, etiqueta('240105000352'))).toEqual([]);
    expect(searchProducts(empresa, etiqueta('230105000000'))).toEqual([]);
  });

  it('etiqueta de peso não vale para produto vendido por unidade com o mesmo PLU', () => {
    updateProduct(empresa, tomate, { weighable: false });
    expect(searchProducts(empresa, etiqueta('230105000352'))).toEqual([]);
  });

  it('produto inativo não volta pela etiqueta', () => {
    updateProduct(empresa, tomate, { active: false });
    expect(searchProducts(empresa, etiqueta('230105000352'))).toEqual([]);
  });

  it('o código CADASTRADO vence: se a etiqueta é o código de um produto, é esse produto', () => {
    const outro = String(createProduct(empresa, { name: 'Caixa de tomate', priceCents: 4500 }).id);
    addProductBarcode(empresa, outro, etiqueta('230105000352'));
    const achados = searchProducts(empresa, etiqueta('230105000352'));
    expect(achados.map((a) => a.id)).toEqual([outro]);
    expect(achados[0].balanca).toBeUndefined();
  });
});

describe('etiqueta de PREÇO', () => {
  it('o total impresso vem em centavos, e a quantidade é o total sobre o preço vigente', () => {
    gravarConfigDaEtiquetaDaBalanca(empresa, { prefixo: '23', digitosDoPlu: 4, valorEmbutido: 'preco' });
    const achados = searchProducts(empresa, etiqueta('230105001990'));
    expect(achados).toHaveLength(1);
    expect(achados[0].balanca).toMatchObject({ tipo: 'preco', precoTotalCents: 1990, plu: '0105' });
    // R$ 19,90 ÷ R$ 8,99/kg = 2,2135… kg → 2,214.
    expect((achados[0].balanca as { quantidade: number }).quantidade).toBe(2.214);
  });

  it('etiqueta de preço também só vale para produto pesável: o PLU que sobrou num produto por unidade não vira 2,214 UN (revisão)', () => {
    gravarConfigDaEtiquetaDaBalanca(empresa, { prefixo: '23', digitosDoPlu: 4, valorEmbutido: 'preco' });
    // Desmarcado "pesável", o PLU fica — e a exportação para a balança já não o manda.
    updateProduct(empresa, tomate, { weighable: false, unit: 'UN' });
    // Antes: voltava a linha com quantidade 2,214 de um produto vendido por
    // unidade, que a venda recusa (CORE_QUANTITY_MUST_BE_INTEGER).
    expect(searchProducts(empresa, etiqueta('230105001990'))).toEqual([]);
  });
});

describe('PLU de 5 dígitos', () => {
  it('prefixo 21 + PLU 00105 + 5 dígitos de peso', () => {
    gravarConfigDaEtiquetaDaBalanca(empresa, { prefixo: '21', digitosDoPlu: 5, valorEmbutido: 'peso' });
    const achados = searchProducts(empresa, etiqueta('210010500352'));
    expect(achados.map((a) => a.id)).toEqual([tomate]);
    expect((achados[0].balanca as { quantidade: number }).quantidade).toBe(0.352);
  });

  it('a leitura pura corta nos lugares declarados', () => {
    expect(
      lerEtiquetaDaBalanca({ prefixo: '21', digitosDoPlu: 5, valorEmbutido: 'peso' }, etiqueta('210010500352')),
    ).toEqual({ plu: '00105', pluSemZeros: '105', valor: 352 });
  });
});

describe('a declaração é conferida antes de gravar', () => {
  it('o prefixo 20 é do gerador de EAN interno e é recusado, dizendo o que fazer', () => {
    const e = recusa(() =>
      gravarConfigDaEtiquetaDaBalanca(empresa, { prefixo: '20', digitosDoPlu: 4, valorEmbutido: 'peso' }),
    );
    expect(e.code).toBe('CORE_SCALE_PREFIX_RESERVED');
    expect(e.message).toMatch(/21 a 29/);
  });

  it.each([['2'], ['30'], ['2a'], ['']])('prefixo "%s" não é prefixo de balança', (prefixo) => {
    const e = recusa(() =>
      gravarConfigDaEtiquetaDaBalanca(empresa, { prefixo, digitosDoPlu: 4, valorEmbutido: 'peso' }),
    );
    expect(e.code).toBe('CORE_SCALE_PREFIX_INVALID');
  });

  it('PLU só de 4 ou 5 dígitos, e o valor só peso ou preço', () => {
    expect(
      recusa(() => gravarConfigDaEtiquetaDaBalanca(empresa, { prefixo: '23', digitosDoPlu: 6, valorEmbutido: 'peso' }))
        .code,
    ).toBe('CORE_SCALE_PLU_DIGITS_INVALID');
    expect(
      recusa(() => gravarConfigDaEtiquetaDaBalanca(empresa, { prefixo: '23', digitosDoPlu: 4, valorEmbutido: 'kg' }))
        .code,
    ).toBe('CORE_SCALE_EMBEDDED_VALUE_INVALID');
    expect(lerConfigDaEtiquetaDaBalanca(empresa)).toBeNull();
  });

  it('faixa que já tem código de barras cadastrado não é declarada', () => {
    const antigo = String(createProduct(empresa, { name: 'Linguiça', priceCents: 2990 }).id);
    addProductBarcode(empresa, antigo, etiqueta('250000000017'));
    const e = recusa(() =>
      gravarConfigDaEtiquetaDaBalanca(empresa, { prefixo: '25', digitosDoPlu: 4, valorEmbutido: 'peso' }),
    );
    expect(e.code).toBe('CORE_SCALE_PREFIX_IN_USE');
    expect(e.message).toMatch(/Linguiça/);
    // Outra faixa, livre, é aceita.
    expect(
      gravarConfigDaEtiquetaDaBalanca(empresa, { prefixo: '26', digitosDoPlu: 4, valorEmbutido: 'peso' }),
    ).toEqual({ prefixo: '26', digitosDoPlu: 4, valorEmbutido: 'peso' });
  });

  it('desligar (nulo) volta a busca de sempre', () => {
    gravarConfigDaEtiquetaDaBalanca(empresa, { prefixo: '23', digitosDoPlu: 4, valorEmbutido: 'peso' });
    expect(searchProducts(empresa, etiqueta('230105000352'))).toHaveLength(1);
    gravarConfigDaEtiquetaDaBalanca(empresa, null);
    expect(searchProducts(empresa, etiqueta('230105000352'))).toEqual([]);
  });
});

describe('o EAN interno gerado fica fora da faixa da balança', () => {
  it('o gerador usa o 20, que nenhuma declaração pode ocupar', () => {
    gravarConfigDaEtiquetaDaBalanca(empresa, { prefixo: '21', digitosDoPlu: 4, valorEmbutido: 'peso' });
    const semEan = String(createProduct(empresa, { name: 'Camiseta', priceCents: 3990 }).id);
    const gerado = ensureBarcode(empresa, semEan).barcode;
    expect(gerado.startsWith('20')).toBe(true);
    expect(codigoNaFaixaDaBalanca(empresa, gerado)).toBe(false);
    expect(codigoNaFaixaDaBalanca(empresa, etiqueta('210105000352'))).toBe(true);
  });
});
