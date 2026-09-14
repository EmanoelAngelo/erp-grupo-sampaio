/**
 * ============================================================================
 * O CADASTRO DE PRODUTO DA AUDITORIA DA PREÇO JUSTO (trilha "produto")
 * ============================================================================
 *
 * Cada bloco abaixo prende um achado da auditoria do cadastro. Todos seguem o
 * mesmo molde: o estado GRAVADO é conferido, e não só a resposta — recusa que
 * grava metade é pior que recusa.
 *
 *  - A-produto-03: na edição, esvaziar categoria, CEST, EAN, piso… não limpava;
 *  - A-produto-04: NCM/CEST/CFOP/origem sem validação no POST/PUT, EAN com
 *    espaço gravado cru e '' colidindo no índice único;
 *  - A-produto-07: o último Salvar revertia em silêncio o preço do outro;
 *  - A-produto-08: trocar o EAN principal apagava o antigo das etiquetas;
 *  - A-produto-09: grupo tributário inativo ou inexistente era aceito;
 *  - A-produto-10: fornecedor em texto livre e fora do mapa do UPDATE;
 *  - A-produto-11/12: renomear/unir categoria desligava a promoção e a
 *    subcategoria arrastava a de mesmo nome de outra mãe;
 *  - A-produto-13: a grade morria em 500 com código digitado à frente;
 *  - A-produto-14: o clone de um serviço controlava estoque;
 *  - A-produto-18: o histórico mostrava "— → —" e mentia sobre eventos novos;
 *  - A-produto-19: nome vazio no PUT, centavo fracionado, mínimo negativo;
 *  - A-produto-24/M04: código interno igual ao EAN/SKU de outro, e em outra caixa;
 *  - A-produto-26: unidade livre no cadastro pela API;
 *  - A-produto-01: os códigos adicionais nascem no MESMO POST, tudo ou nada;
 *  - A-produto-M01: a busca diz quando casou por código (inclusive adicional).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';

process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_DATABASE_PATH = ':memory:';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

const { createApp } = await import('../src/app.js');
const { loginForTest } = await import('./helpers/auth.js');
const { resetDbForTests } = await import('../src/db/database.js');
const { ensureCoreSchema } = await import('../src/db/schema.js');
const { getConnection } = await import('../src/db/sqlite.js');
const { createProduct, getProduct, productHistory, searchProducts } = await import(
  '../src/services/core/CatalogService.js'
);
const { addProductBarcode, listProductBarcodes, upsertCustomField } = await import(
  '../src/services/core/CatalogAuxService.js'
);
const { digitoVerificadorGtin } = await import('../src/services/core/Gtin.js');
const { listCategories, mergeCategory, removeCategory, upsertCategory } = await import(
  '../src/services/core/TaxonomyService.js'
);
const { effectivePriceCents } = await import('../src/services/core/PricingService.js');
const { generateVariants } = await import('../src/services/core/VariantService.js');
const { cloneProduct } = await import('../src/services/core/ProductCloneService.js');
const { createSupplier } = await import('../src/services/core/SupplierService.js');
const { setBatchControl } = await import('../src/services/core/BatchService.js');
const { upsertCompany } = await import('../src/services/auth/IdentityService.js');

const app = createApp();
const LOJA = 'loja-auditoria-pj';
let gerente: Record<string, string>;

/** Um EAN-13 com o verificador certo, a partir dos 12 primeiros dígitos. */
const ean = (doze: string) => `${doze}${digitoVerificadorGtin(doze)}`;

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  const res = await loginForTest(app, {
    userId: 'gerente',
    companyId: LOJA,
    profileCodes: ['gerente_loja'],
  });
  gerente = { Authorization: `Bearer ${res.body.accessToken}` };
});

async function criar(body: Record<string, unknown>, status = 201) {
  const res = await request(app).post('/api/v1/core/products').set(gerente).send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body as Record<string, unknown> & { id: string; error?: { code: string; message: string } };
}

async function salvar(id: string, body: Record<string, unknown>, status = 200) {
  const res = await request(app).put(`/api/v1/core/products/${id}`).set(gerente).send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body as Record<string, unknown> & { error?: { code: string; message: string } };
}

const ler = (id: string) => getProduct(LOJA, id) as Record<string, unknown>;

function grupoTributario(code: string, ativo: boolean) {
  const agora = new Date().toISOString();
  getConnection()
    .prepare(
      `INSERT INTO core_tax_groups (id, company_id, code, name, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(randomUUID(), LOJA, code, `Grupo ${code}`, ativo ? 1 : 0, agora, agora);
}

function promocaoNaCategoria(categoria: string, percentual: number) {
  const agora = new Date().toISOString();
  const ontem = new Date(Date.now() - 86_400_000).toISOString();
  getConnection()
    .prepare(
      `INSERT INTO core_promotions
         (id, company_id, product_id, category, percent_off, starts_at, active, created_at, free_confirmed)
       VALUES (?, ?, NULL, ?, ?, ?, 1, ?, 0)`,
    )
    .run(randomUUID(), LOJA, categoria, percentual, ontem, agora);
}

// --------------------------------------------------------------- A-produto-03
describe('na edição, VAZIO LIMPA (A-produto-03)', () => {
  it('categoria, marca, subcategoria, fiscais, descrições, EAN, referência e pisos voltam a nulo', async () => {
    const p = await criar({
      name: 'Perfume 100ml',
      priceCents: 3990,
      category: 'Liquidação',
      subcategory: 'Masculino',
      brand: 'Marca X',
      description: 'interna',
      onlineDescription: 'vitrine',
      reference: 'REF-1',
      ncm: '33030010',
      cest: '2800100',
      cfop: '5102',
      origin: '0',
      barcode: ean('789100010010'),
      minPriceCents: 2500,
      minMarkupPercent: 30,
      minMarginPercent: 20,
    });

    await salvar(p.id, {
      category: '',
      subcategory: '',
      brand: '',
      description: '',
      onlineDescription: '',
      reference: '',
      ncm: '',
      cest: '',
      cfop: '',
      origin: '',
      barcode: '',
      minPriceCents: null,
      minMarkupPercent: null,
      minMarginPercent: null,
    });

    const lido = ler(p.id);
    for (const coluna of [
      'category',
      'subcategory',
      'brand',
      'description',
      'online_description',
      'reference',
      'ncm',
      'cest',
      'cfop',
      'origin',
      'barcode',
      'min_markup_percent',
      'min_margin_percent',
    ]) {
      expect(lido[coluna], coluna).toBeNull();
    }
    // Preço mínimo sem piso é zero, como na criação.
    expect(lido.min_price_cents).toBe(0);
  });

  it('tirar da categoria "Liquidação" tira a promoção da categoria no PDV', async () => {
    promocaoNaCategoria('Liquidação', 30);
    const p = await criar({ name: 'Perfume 100ml', priceCents: 10000, category: 'Liquidação' });
    expect(searchProducts(LOJA, 'Perfume')[0].on_sale).toBe(true);

    await salvar(p.id, { category: '' });

    // Antes, o valor antigo voltava e o balcão continuava cobrando 30% a menos.
    const [linha] = searchProducts(LOJA, 'Perfume');
    expect(linha.category).toBeNull();
    expect(linha.on_sale).toBe(false);
  });

  it('AUSENTE continua preservando: corrigir o preço não apaga a categoria', async () => {
    const p = await criar({ name: 'Perfume', priceCents: 1000, category: 'Perfumaria', cest: '2800100' });
    await salvar(p.id, { priceCents: 1200 });
    expect(ler(p.id).category).toBe('Perfumaria');
    expect(ler(p.id).cest).toBe('2800100');
  });
});

// --------------------------------------------------------------- A-produto-04
describe('a classificação fiscal é conferida no cadastro (A-produto-04)', () => {
  for (const [campo, valor, codigo] of [
    ['ncm', '330300', 'CORE_FISCAL_NCM_INVALID'],
    ['cest', '2800', 'CORE_FISCAL_CEST_INVALID'],
    ['cfop', '1102', 'CORE_FISCAL_CFOP_INVALID'],
    ['origin', 'nacional', 'CORE_FISCAL_ORIGIN_INVALID'],
  ] as const) {
    it(`POST com ${campo} "${valor}" é recusado, e nada nasce`, async () => {
      const res = await criar({ name: 'Perfume', [campo]: valor }, 400);
      expect(res.error?.code).toBe(codigo);
      const total = getConnection()
        .prepare('SELECT COUNT(*) AS n FROM core_products WHERE company_id = ?')
        .get(LOJA) as { n: number };
      expect(total.n).toBe(0);
    });
  }

  it('PUT com NCM de 6 dígitos também é recusado, e o NCM gravado fica', async () => {
    const p = await criar({ name: 'Perfume', ncm: '33030010' });
    const res = await salvar(p.id, { ncm: '3303.00' }, 400);
    expect(res.error?.code).toBe('CORE_FISCAL_NCM_INVALID');
    expect(ler(p.id).ncm).toBe('33030010');
  });

  it('o NCM digitado com pontos é gravado só com dígitos', async () => {
    const p = await criar({ name: 'Perfume', ncm: '3303.00.10', cest: '28.001.00', cfop: '5.102' });
    expect(ler(p.id).ncm).toBe('33030010');
    expect(ler(p.id).cest).toBe('2800100');
    expect(ler(p.id).cfop).toBe('5102');
  });

  it('cadastro antigo com CEST fora do formato não trava a correção do preço', async () => {
    const p = await criar({ name: 'Perfume', priceCents: 1000 });
    getConnection().prepare("UPDATE core_products SET cest = '2800' WHERE id = ?").run(p.id);
    // O formulário antigo reenviava o CEST de sempre junto: não é gravar nada novo.
    await salvar(p.id, { priceCents: 1500, cest: '2800' });
    expect(ler(p.id).price_cents).toBe(1500);
  });

  it('o EAN colado com espaço é gravado aparado — e o mesmo código sem espaço colide', async () => {
    const codigo = ean('789100010022');
    const p = await criar({ name: 'Perfume', barcode: ` ${codigo} ` });
    expect(ler(p.id).barcode).toBe(codigo);
    expect(searchProducts(LOJA, codigo).map((r) => r.id)).toEqual([p.id]);

    const dup = await criar({ name: 'Outro', barcode: codigo }, 409);
    expect(dup.error?.code).toBe('CORE_BARCODE_DUPLICATE');
  });

  it("barcode '' pela API em dois produtos: os dois nascem, sem código (não 500)", async () => {
    const a = await criar({ name: 'A', barcode: '' });
    const b = await criar({ name: 'B', barcode: '' });
    expect(ler(a.id).barcode).toBeNull();
    expect(ler(b.id).barcode).toBeNull();
  });
});

// --------------------------------------------------------------- A-produto-07
describe('dois gestores no mesmo produto (A-produto-07)', () => {
  it('o Salvar de A, que só mexeu na descrição, NÃO reverte o preço que B gravou', async () => {
    const p = await criar({ name: 'Perfume', priceCents: 3990 });
    // 10:05 — B baixa o preço na Alteração rápida.
    await salvar(p.id, { priceCents: 2990 });
    // 10:10 — A salva o formulário aberto às 10:00: só o que ele mudou vai.
    await salvar(p.id, { description: 'Nova descrição', expected: { description: null } });

    expect(ler(p.id).price_cents).toBe(2990);
    expect(ler(p.id).description).toBe('Nova descrição');
  });

  it('os dois no MESMO campo: o segundo leva 409 e nada do PUT dele é gravado', async () => {
    const p = await criar({ name: 'Perfume', priceCents: 3990 });
    await salvar(p.id, { priceCents: 2990 });

    const res = await salvar(
      p.id,
      { priceCents: 3500, description: 'x', expected: { priceCents: 3990, description: null } },
      409,
    );
    expect(res.error?.code).toBe('CORE_PRODUCT_STALE');
    expect(res.error?.message).toContain('Preço de venda');
    expect(res.error?.message).toContain('29,90');
    expect(ler(p.id).price_cents).toBe(2990);
    expect(ler(p.id).description).toBeNull();
  });

  /*
    A OUTRA METADE: a Alteração rápida salvando por último. Ela passou a mandar
    só o campo que mudou e, em `expected`, o par custo/venda que a linha
    mostrava. Estes dois casos prendem o contrato de que a tela depende.
  */
  it('Alteração rápida muda só o custo depois de B baixar o preço: 409, e o preço de B fica', async () => {
    const p = await criar({ name: 'Perfume', priceCents: 3990, costCents: 2000 });
    // 10:05 — B baixa o preço no formulário.
    await salvar(p.id, { priceCents: 2990, expected: { priceCents: 3990 } });
    // 10:10 — A, com a grade aberta desde as 10:00, muda só o custo.
    const res = await salvar(
      p.id,
      { costCents: 1500, expected: { costCents: 2000, priceCents: 3990 } },
      409,
    );
    expect(res.error?.code).toBe('CORE_PRODUCT_STALE');
    expect(ler(p.id).price_cents).toBe(2990);
    expect(ler(p.id).cost_cents).toBe(2000);
  });

  it('Alteração rápida sem conflito grava só o custo, e o preço não é tocado', async () => {
    const p = await criar({ name: 'Perfume', priceCents: 3990, costCents: 2000 });
    await salvar(p.id, { costCents: 1500, expected: { costCents: 2000, priceCents: 3990 } });
    expect(ler(p.id).cost_cents).toBe(1500);
    expect(ler(p.id).price_cents).toBe(3990);
  });

  it('o que a tela viu confere com o banco: grava normalmente', async () => {
    const p = await criar({ name: 'Perfume', priceCents: 3990, category: 'Perfumaria' });
    await salvar(p.id, {
      priceCents: 3500,
      category: '',
      expected: { priceCents: 3990, category: 'Perfumaria' },
    });
    expect(ler(p.id).price_cents).toBe(3500);
    expect(ler(p.id).category).toBeNull();
  });
});

// --------------------------------------------------------------- A-produto-08
describe('trocar o EAN principal (A-produto-08)', () => {
  it('o antigo vira adicional: a etiqueta já colada continua bipando', async () => {
    const antigo = ean('200000000001');
    const novo = ean('789100010011');
    const p = await criar({ name: 'Camiseta', priceCents: 1000, barcode: antigo });

    await salvar(p.id, { barcode: novo });

    expect(ler(p.id).barcode).toBe(novo);
    expect(listProductBarcodes(LOJA, p.id)).toContain(antigo);
    expect(searchProducts(LOJA, antigo).map((r) => r.id)).toEqual([p.id]);
    expect(searchProducts(LOJA, novo).map((r) => r.id)).toEqual([p.id]);
  });

  it('promover um adicional a principal tira ele da lista de adicionais', async () => {
    const principal = ean('789100010012');
    const adicional = ean('789100010013');
    const p = await criar({ name: 'Camiseta', barcode: principal, extraBarcodes: [adicional] });

    await salvar(p.id, { barcode: adicional });

    expect(ler(p.id).barcode).toBe(adicional);
    expect(listProductBarcodes(LOJA, p.id)).toEqual([principal]);
  });
});

// --------------------------------------------------------------- A-produto-09
describe('grupo tributário escolhido no cadastro (A-produto-09)', () => {
  beforeEach(() => {
    grupoTributario('PADRAO', true);
    grupoTributario('ST', false);
  });

  it('grupo INATIVO é recusado — a emissão recusaria toda venda', async () => {
    const p = await criar({ name: 'Perfume' });
    const res = await salvar(p.id, { taxProfile: 'ST' }, 400);
    expect(res.error?.code).toBe('CORE_TAX_GROUP_INACTIVE');
    expect(ler(p.id).tax_profile).toBeNull();
  });

  it('grupo que não existe é recusado, na criação e na edição', async () => {
    expect((await criar({ name: 'Perfume', taxProfile: 'NAOEXISTE' }, 400)).error?.code).toBe(
      'CORE_TAX_GROUP_NOT_FOUND',
    );
    const p = await criar({ name: 'Perfume' });
    expect((await salvar(p.id, { taxProfile: 'NAOEXISTE' }, 400)).error?.code).toBe(
      'CORE_TAX_GROUP_NOT_FOUND',
    );
  });

  it('o grupo ativo é gravado em maiúsculas, e vazio limpa', async () => {
    const p = await criar({ name: 'Perfume', taxProfile: ' padrao ' });
    expect(ler(p.id).tax_profile).toBe('PADRAO');
    await salvar(p.id, { taxProfile: '' });
    expect(ler(p.id).tax_profile).toBeNull();
  });

  it('produto que JÁ tinha um grupo depois desativado continua editável', async () => {
    const p = await criar({ name: 'Perfume', priceCents: 1000 });
    getConnection().prepare("UPDATE core_products SET tax_profile = 'ST' WHERE id = ?").run(p.id);
    await salvar(p.id, { priceCents: 2000, taxProfile: 'ST' });
    expect(ler(p.id).price_cents).toBe(2000);
  });
});

// --------------------------------------------------------------- A-produto-10
describe('fornecedor é cadastro, não texto (A-produto-10)', () => {
  it('a edição GRAVA o fornecedor (antes ele nem estava no mapa do UPDATE)', async () => {
    const a = createSupplier(LOJA, { name: 'Distribuidora A' }) as { id: string };
    const b = createSupplier(LOJA, { name: 'Distribuidora B' }) as { id: string };
    const p = await criar({ name: 'Perfume', supplierId: a.id });
    expect(ler(p.id).supplier_id).toBe(a.id);

    await salvar(p.id, { supplierId: b.id });
    expect(ler(p.id).supplier_id).toBe(b.id);

    await salvar(p.id, { supplierId: '' });
    expect(ler(p.id).supplier_id).toBeNull();
  });

  it('nome digitado no lugar do id, ou fornecedor de outra empresa, é recusado', async () => {
    const outra = upsertCompany({ slug: 'outra-loja', legalName: 'Outra Ltda', tradeName: 'Outra' });
    const alheio = createSupplier(outra, { name: 'Fornecedor alheio' }) as { id: string };

    expect((await criar({ name: 'Perfume', supplierId: 'Distribuidora Beleza' }, 400)).error?.code).toBe(
      'CORE_SUPPLIER_NOT_FOUND',
    );
    expect((await criar({ name: 'Perfume', supplierId: alheio.id }, 400)).error?.code).toBe(
      'CORE_SUPPLIER_NOT_FOUND',
    );
  });
});

// ------------------------------------------------------------ A-produto-11/12
describe('renomear e unir categoria (A-produto-11 e A-produto-12)', () => {
  it('renomear a categoria leva a promoção junto: o PDV continua dando o desconto', () => {
    const cat = upsertCategory({ companyId: LOJA, name: 'Perfumaria' });
    const p = createProduct(LOJA, { name: 'Perfume', priceCents: 10000, category: 'Perfumaria' });
    promocaoNaCategoria('Perfumaria', 20);
    expect(effectivePriceCents(LOJA, String(p.id), 10000, 'Perfumaria').priceCents).toBe(8000);

    upsertCategory({ companyId: LOJA, id: cat.id, name: 'Perfumes' });

    expect(ler(String(p.id)).category).toBe('Perfumes');
    // Antes: a promoção ficava em "Perfumaria", que nenhum produto tem mais.
    expect(effectivePriceCents(LOJA, String(p.id), 10000, 'Perfumes').priceCents).toBe(8000);
  });

  it('unir a categoria leva a promoção da origem para o destino', () => {
    const certa = upsertCategory({ companyId: LOJA, name: 'Perfumes' });
    const errada = upsertCategory({ companyId: LOJA, name: 'Perfumaria' });
    const p = createProduct(LOJA, { name: 'Perfume', priceCents: 10000, category: 'Perfumaria' });
    promocaoNaCategoria('Perfumaria', 20);

    mergeCategory({ companyId: LOJA, sourceId: errada.id, targetId: certa.id });

    expect(effectivePriceCents(LOJA, String(p.id), 10000, 'Perfumes').priceCents).toBe(8000);
  });

  it('renomear "Calçados › Infantil" não arrasta os produtos de "Roupas › Infantil"', () => {
    const roupas = upsertCategory({ companyId: LOJA, name: 'Roupas' });
    const calcados = upsertCategory({ companyId: LOJA, name: 'Calçados' });
    upsertCategory({ companyId: LOJA, name: 'Infantil', parentId: roupas.id });
    const subCalcados = upsertCategory({ companyId: LOJA, name: 'Infantil', parentId: calcados.id });
    const camiseta = createProduct(LOJA, { name: 'Camiseta', category: 'Roupas', subcategory: 'Infantil' });
    const tenis = createProduct(LOJA, { name: 'Tênis', category: 'Calçados', subcategory: 'Infantil' });

    upsertCategory({ companyId: LOJA, id: subCalcados.id, name: 'Kids', parentId: calcados.id });

    expect(ler(String(camiseta.id)).subcategory).toBe('Infantil');
    expect(ler(String(tenis.id)).subcategory).toBe('Kids');
  });

  it('cada subcategoria conta só os produtos da própria mãe — e a remoção obedece', () => {
    const roupas = upsertCategory({ companyId: LOJA, name: 'Roupas' });
    const calcados = upsertCategory({ companyId: LOJA, name: 'Calçados' });
    upsertCategory({ companyId: LOJA, name: 'Infantil', parentId: roupas.id });
    const subCalcados = upsertCategory({ companyId: LOJA, name: 'Infantil', parentId: calcados.id });
    createProduct(LOJA, { name: 'Camiseta', category: 'Roupas', subcategory: 'Infantil' });

    const arvore = listCategories(LOJA);
    const usoDe = (mae: string) =>
      arvore.find((c) => c.name === mae)?.children?.find((s) => s.name === 'Infantil')?.usage;
    expect(usoDe('Roupas')).toBe(1);
    expect(usoDe('Calçados')).toBe(0);
    // Antes era recusada "porque está em 1 produto" — o da OUTRA categoria.
    expect(() => removeCategory(LOJA, subCalcados.id)).not.toThrow();
  });

  it('unir subcategorias de mães diferentes leva o produto para a mãe do destino', () => {
    const roupas = upsertCategory({ companyId: LOJA, name: 'Roupas' });
    const calcados = upsertCategory({ companyId: LOJA, name: 'Calçados' });
    upsertCategory({ companyId: LOJA, name: 'Infantil', parentId: roupas.id });
    const origem = upsertCategory({ companyId: LOJA, name: 'Infantil', parentId: calcados.id });
    const destino = upsertCategory({ companyId: LOJA, name: 'Kids', parentId: roupas.id });
    const camiseta = createProduct(LOJA, { name: 'Camiseta', category: 'Roupas', subcategory: 'Infantil' });
    const tenis = createProduct(LOJA, { name: 'Tênis', category: 'Calçados', subcategory: 'Infantil' });

    mergeCategory({ companyId: LOJA, sourceId: origem.id, targetId: destino.id });

    expect(ler(String(tenis.id))).toMatchObject({ category: 'Roupas', subcategory: 'Kids' });
    // A "Infantil" de Roupas é outra subcategoria e não é tocada.
    expect(ler(String(camiseta.id))).toMatchObject({ category: 'Roupas', subcategory: 'Infantil' });
  });
});

// --------------------------------------------------------------- A-produto-13
describe('a grade pula o código interno digitado à mão (A-produto-13)', () => {
  it('com GS-000002 e GS-000003 já digitados, a grade nasce inteira, sem 500', () => {
    const modelo = createProduct(LOJA, { name: 'Camiseta', priceCents: 5000 });
    expect(modelo.internal_code).toBe('GS-000001');
    createProduct(LOJA, { name: 'Migrado 2', internalCode: 'GS-000002' });
    createProduct(LOJA, { name: 'Migrado 3', internalCode: 'GS-000003' });

    const { created } = generateVariants({
      companyId: LOJA,
      productId: String(modelo.id),
      axes: { tamanho: ['P', 'M', 'G'] },
    });

    expect(created).toHaveLength(3);
    const codigos = created.map((v) => v.internal_code);
    expect(codigos).not.toContain('GS-000002');
    expect(codigos).not.toContain('GS-000003');
    expect(new Set(codigos).size).toBe(3);
  });
});

// --------------------------------------------------------------- A-produto-14
describe('o clone copia como a mercadoria sai da prateleira (A-produto-14)', () => {
  it('clonar um serviço de balcão gera outro serviço, que não controla estoque', () => {
    const servico = createProduct(LOJA, { name: 'Aplicação de película', priceCents: 3000, stockControl: false });
    const clone = cloneProduct(LOJA, String(servico.id));
    expect(ler(String(clone.id)).stock_control).toBe(0);
  });

  it('embalagem, endereço e lote vão junto; o PLU não (é único)', () => {
    const agua = createProduct(LOJA, {
      name: 'Água 500ml',
      packFactor: 12,
      packUnit: 'FD',
      storageLocation: 'Prateleira A3',
    });
    setBatchControl({ companyId: LOJA, productId: String(agua.id), tracksBatches: true });

    const clone = ler(String(cloneProduct(LOJA, String(agua.id)).id));
    expect(clone.pack_factor).toBe(12);
    expect(clone.pack_unit).toBe('FD');
    expect(clone.storage_location).toBe('Prateleira A3');
    expect(clone.tracks_batches).toBe(1);
  });

  it('o fornecedor em texto de um cadastro antigo não derruba o clone', () => {
    const antigo = createProduct(LOJA, { name: 'Perfume antigo' });
    getConnection()
      .prepare("UPDATE core_products SET supplier_id = 'Distribuidora Beleza' WHERE id = ?")
      .run(String(antigo.id));
    const clone = ler(String(cloneProduct(LOJA, String(antigo.id)).id));
    expect(clone.supplier_id).toBeNull();
  });
});

// --------------------------------------------------------------- A-produto-18
describe('o histórico diz o que aconteceu (A-produto-18)', () => {
  it('campo próprio: de → para com rótulo, e salvar sem mudar não grava nada', async () => {
    upsertCustomField(LOJA, { code: 'ARO', label: 'Aro', kind: 'number' });
    const p = await criar({ name: 'Bicicleta', priceCents: 100 });

    for (let i = 0; i < 2; i += 1) {
      await request(app)
        .put(`/api/v1/core/products/${p.id}/custom-fields`)
        .set(gerente)
        .send({ values: { ARO: '26' } })
        .expect(200);
    }

    const linhas = getConnection()
      .prepare(
        `SELECT detail FROM core_audit_log
          WHERE company_id = ? AND action = 'product.custom_fields.set' AND entity_id = ?`,
      )
      .all(LOJA, p.id) as { detail: string }[];
    expect(linhas).toHaveLength(1);
    expect(JSON.parse(linhas[0].detail).fields).toEqual([
      { field: 'custom:ARO', label: 'Aro', from: null, to: '26' },
    ]);

    const historico = productHistory(LOJA, p.id);
    const doCampo = historico.find((h) => h.action === 'product.custom_fields.set')!;
    expect((doCampo.fields as { label: string }[])[0].label).toBe('Aro');
  });

  it('a criação diz "Produto cadastrado." — e não "registro anterior ao detalhamento"', async () => {
    const p = await criar({ name: 'Bicicleta' });
    const [criacao] = productHistory(LOJA, p.id);
    expect(criacao.action).toBe('product.create');
    expect(criacao.resumo).toBe('Produto cadastrado.');
  });

  it('registro antigo com CÓDIGOS soltos não vira "— → —": sai no resumo', async () => {
    const p = await criar({ name: 'Bicicleta' });
    getConnection()
      .prepare(
        `INSERT INTO core_audit_log (id, company_id, user_id, action, entity_type, entity_id, detail, created_at)
         VALUES ('a-codigos', ?, NULL, 'product.custom_fields.set', 'product', ?, ?, ?)`,
      )
      .run(LOJA, p.id, JSON.stringify({ fields: ['VOLTAGEM'] }), new Date().toISOString());

    const velho = productHistory(LOJA, p.id).find((h) => h.id === 'a-codigos')!;
    expect(velho.fields).toEqual([]);
    expect(String(velho.resumo)).toContain('VOLTAGEM');
  });
});

// --------------------------------------------------------------- A-produto-19
describe('nome, centavos e estoque mínimo (A-produto-19)', () => {
  it('PUT com nome em branco é recusado, e o nome fica', async () => {
    const p = await criar({ name: 'Perfume' });
    const res = await salvar(p.id, { name: '   ' }, 400);
    expect(res.error?.code).toBe('CORE_INVALID_PAYLOAD');
    expect(ler(p.id).name).toBe('Perfume');
  });

  it('centavo fracionado é recusado na criação e na edição', async () => {
    expect((await criar({ name: 'Perfume', priceCents: 1990.5 }, 400)).error?.code).toBe('CORE_PRICE_INVALID');
    const p = await criar({ name: 'Perfume', priceCents: 1990 });
    expect((await salvar(p.id, { costCents: 10.25 }, 400)).error?.code).toBe('CORE_PRICE_INVALID');
  });

  it('estoque mínimo fracionado é gravado; negativo é recusado', async () => {
    const p = await criar({ name: 'Queijo a granel' });
    await salvar(p.id, { minStock: 2.5 });
    expect(ler(p.id).min_stock).toBe(2.5);
    expect((await salvar(p.id, { minStock: -1 }, 400)).error?.code).toBe('CORE_MIN_STOCK_INVALID');
    expect(ler(p.id).min_stock).toBe(2.5);
  });
});

// ------------------------------------------------------- A-produto-24 e M04
describe('o mesmo código não responde por dois produtos no bipe (A-produto-24 e M04)', () => {
  it('código interno igual ao EAN de outro produto é recusado', async () => {
    const codigo = ean('789100010099');
    await criar({ name: 'A', barcode: codigo });
    expect((await criar({ name: 'B', internalCode: codigo }, 409)).error?.code).toBe(
      'CORE_CODE_CLASHES_BARCODE',
    );
  });

  it('EAN igual ao código interno de outro produto é recusado', async () => {
    const codigo = ean('789100010098');
    await criar({ name: 'A', internalCode: codigo });
    expect((await criar({ name: 'B', barcode: codigo }, 409)).error?.code).toBe(
      'CORE_CODE_CLASHES_BARCODE',
    );
  });

  it('SKU é único (em qualquer caixa) e não pode ser o código interno de outro', async () => {
    await criar({ name: 'A', internalCode: 'LOJA-77' });
    expect((await criar({ name: 'B', sku: 'LOJA-77' }, 409)).error?.code).toBe('CORE_SKU_DUPLICATE');
    await criar({ name: 'C', sku: 'SKU-1' });
    expect((await criar({ name: 'D', sku: 'sku-1' }, 409)).error?.code).toBe('CORE_SKU_DUPLICATE');
  });

  it('código ADICIONAL igual ao código interno de outro produto é recusado', async () => {
    await criar({ name: 'A', internalCode: 'LOJA-77' });
    const b = await criar({ name: 'B' });
    expect(() => addProductBarcode(LOJA, b.id, 'LOJA-77')).toThrowError(/código interno/);
  });

  it('código interno digitado em minúsculas é gravado em MAIÚSCULAS, e o outro "igual" colide', async () => {
    const a = await criar({ name: 'Perfume', internalCode: ' pj-0105 ' });
    expect(ler(a.id).internal_code).toBe('PJ-0105');
    expect((await criar({ name: 'Outro', internalCode: 'PJ-0105' }, 409)).error?.code).toBe(
      'CORE_DUPLICATE_CODE',
    );
    // O balcão que digita em outra caixa acha o item como EXATO.
    const [linha] = searchProducts(LOJA, 'pj-0105');
    expect(linha.id).toBe(a.id);
    expect(linha.matched_exact).toBe(1);
  });
});

// --------------------------------------------------------------- A-produto-26
describe('a unidade vem do vocabulário da loja (A-produto-26)', () => {
  it('pela API, unidade fora da lista é recusada; a da lista é gravada em maiúsculas', async () => {
    expect((await criar({ name: 'Perfume', unit: 'XYZ' }, 400)).error?.code).toBe('CORE_UNIT_NOT_FOUND');
    const p = await criar({ name: 'Queijo', unit: 'kg' });
    expect(ler(p.id).unit).toBe('KG');
    expect((await salvar(p.id, { unit: 'CX12' }, 400)).error?.code).toBe('CORE_UNIT_NOT_FOUND');
    expect(ler(p.id).unit).toBe('KG');
  });

  it('a importação (serviço direto) segue com a unidade do fornecedor', () => {
    const p = createProduct(LOJA, { name: 'Da nota do fornecedor', unit: 'PCT' });
    expect(ler(String(p.id)).unit).toBe('PCT');
  });
});

// --------------------------------------------------------------- A-produto-01
describe('os códigos adicionais nascem no MESMO POST (A-produto-01)', () => {
  it('um adicional recusado desfaz o produto inteiro: o segundo Salvar não duplica', async () => {
    const deOutro = ean('789100010055');
    await criar({ name: 'Outro', barcode: deOutro });

    const res = await criar({ name: 'Novo', extraBarcodes: [ean('789100010066'), deOutro] }, 409);
    expect(res.error?.code).toBe('CORE_BARCODE_DUPLICATE');
    expect(res.error?.message).toContain(deOutro);
    const novos = getConnection()
      .prepare("SELECT COUNT(*) AS n FROM core_products WHERE company_id = ? AND name = 'Novo'")
      .get(LOJA) as { n: number };
    expect(novos.n).toBe(0);
  });

  it('os adicionais válidos entram, sem repetir o principal nem a si mesmos', async () => {
    const principal = ean('789100010077');
    const extra = ean('789100010088');
    const p = await criar({ name: 'Novo', barcode: principal, extraBarcodes: [extra, extra, principal] });
    expect(listProductBarcodes(LOJA, p.id)).toEqual([extra]);
  });
});

// -------------------------------------------------------------- A-produto-M01
describe('a busca diz quando casou por código (A-produto-M01)', () => {
  it('bipar um código ADICIONAL devolve a linha marcada como casamento exato', () => {
    const p = createProduct(LOJA, { name: 'Perfume', barcode: ean('789100010044') });
    const adicional = ean('789100010033');
    addProductBarcode(LOJA, String(p.id), adicional);

    const [linha] = searchProducts(LOJA, adicional);
    expect(linha.id).toBe(p.id);
    expect(linha.matched_exact).toBe(1);
    // Busca por nome não é casamento exato.
    expect(searchProducts(LOJA, 'Perf')[0].matched_exact).toBe(0);
  });
});
