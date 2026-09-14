/**
 * Auxiliares do catálogo: as garantias que impedem o cadastro de se contradizer.
 *
 * Executam contra o banco de verdade — o que se cobra aqui é o ESTADO depois da
 * operação, não a existência do código.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_DATABASE_PATH = ':memory:';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

const { getConnection } = await import('../src/db/sqlite.js');
const { ensureCoreSchema } = await import('../src/db/schema.js');
const { resetDbForTests } = await import('../src/db/database.js');
const { upsertCompany } = await import('../src/services/auth/IdentityService.js');
const { createProduct, getProduct, listProducts, searchProducts, updateProduct } = await import(
  '../src/services/core/CatalogService.js'
);
const {
  addProductBarcode,
  deleteUnit,
  findProductByAnyBarcode,
  kitCostCents,
  listUnits,
  priceInTable,
  setKitComponents,
  setPriceTableItem,
  upsertPriceTable,
  upsertTaxGroup,
  upsertUnit,
} = await import('../src/services/core/CatalogAuxService.js');

let empresa: string;

function criarProduto(
  companyId: string,
  nome: string,
  extras: { unit?: string; barcode?: string; costCents?: number; isKit?: boolean } = {},
): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  getConnection()
    .prepare(
      `INSERT INTO core_products
         (id, company_id, internal_code, name, unit, cost_cents, price_cents,
          min_stock, active, is_kit, barcode, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, 0, 1, ?, ?, ?, ?)`,
    )
    .run(
      id,
      companyId,
      nome.slice(0, 6).toUpperCase() + id.slice(0, 4),
      nome,
      extras.unit ?? 'UN',
      extras.costCents ?? 0,
      extras.isKit ? 1 : 0,
      extras.barcode ?? null,
      now,
      now,
    );
  return id;
}

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

describe('unidade de medida', () => {
  it('a operação nasce com as unidades do dia a dia', () => {
    const unidades = listUnits(empresa);
    expect(unidades.length).toBeGreaterThan(10);
    expect(unidades.find((u) => u.code === 'UN')?.decimals).toBe(0);
    // Peso fraciona; caixa não.
    expect(unidades.find((u) => u.code === 'KG')?.decimals).toBe(3);
    expect(unidades.find((u) => u.code === 'CX')?.decimals).toBe(0);
  });

  it('casas decimais fora de 0–3 é recusado', () => {
    expect(() => upsertUnit(empresa, { code: 'XX', name: 'Teste', decimals: 4 })).toThrow();
    expect(() => upsertUnit(empresa, { code: 'XX', name: 'Teste', decimals: -1 })).toThrow();
  });

  it('sigla repetida é recusada', () => {
    upsertUnit(empresa, { code: 'BD', name: 'Bandeja', decimals: 0 });
    expect(() => upsertUnit(empresa, { code: 'BD', name: 'Outra', decimals: 0 })).toThrow();
  });

  /**
   * A sigla é o que o produto guarda. Deixar mudar órfã silenciosamente todos
   * os produtos que a usam — e o estoque passaria a ter unidade inexistente.
   */
  it('a sigla não muda depois de criada', () => {
    const criada = upsertUnit(empresa, { code: 'BD', name: 'Bandeja', decimals: 0 });
    expect(() =>
      upsertUnit(empresa, { id: criada.id, code: 'BJ', name: 'Bandeja', decimals: 0 }),
    ).toThrow(/sigla não muda/i);
  });

  it('o nome e as casas decimais mudam normalmente', () => {
    const criada = upsertUnit(empresa, { code: 'BD', name: 'Bandeja', decimals: 0 });
    const alterada = upsertUnit(empresa, {
      id: criada.id,
      code: 'BD',
      name: 'Bandeja grande',
      decimals: 2,
    });
    expect(alterada.name).toBe('Bandeja grande');
    expect(alterada.decimals).toBe(2);
  });

  it('unidade em uso não é excluída — é desativada', () => {
    const criada = upsertUnit(empresa, { code: 'BD', name: 'Bandeja', decimals: 0 });
    criarProduto(empresa, 'Ovos', { unit: 'BD' });
    expect(() => deleteUnit(empresa, criada.id)).toThrow(/desative/i);
  });

  it('unidade sem uso é excluída', () => {
    const criada = upsertUnit(empresa, { code: 'BD', name: 'Bandeja', decimals: 0 });
    deleteUnit(empresa, criada.id);
    expect(listUnits(empresa).find((u) => u.code === 'BD')).toBeUndefined();
  });
});

describe('grupo tributário', () => {
  it('enquadramento inválido é recusado', () => {
    expect(() =>
      upsertTaxGroup(empresa, { code: 'G1', name: 'Padrão', regime: 'inventado' }),
    ).toThrow();
  });

  it('guarda o enquadramento e os códigos fiscais', () => {
    const g = upsertTaxGroup(empresa, {
      code: 'G1',
      name: 'Padrão',
      regime: 'simples',
      ncm: '23061000',
      cest: '2806200',
    });
    expect(g.regime).toBe('simples');
    expect(g.ncm).toBe('23061000');
  });

  /**
   * EDITAR O GRUPO PELO ID — a regressão que a auditoria integral pegou.
   *
   * O ramo de UPDATE montava a lista de valores SEM o pCredSN, mas o SQL
   * tinha o placeholder p_cred_sn = ? — QUALQUER edição por id estourava em
   * contagem de parâmetros, e a alíquota de crédito do Simples (o campo que a
   * emissão CSOSN 101 exige) não tinha como ser corrigida por serviço nem por
   * rota: só por SQL na mão. O grupo salvava uma vez e virava pedra.
   */
  it('editar o grupo pelo id aplica o pCredSN — e não estoura', () => {
    const g = upsertTaxGroup(empresa, {
      code: 'G101',
      name: 'Com crédito',
      regime: 'simples',
      csosn: '101',
    });
    const editado = upsertTaxGroup(empresa, {
      id: g.id,
      code: 'G101',
      name: 'Com crédito',
      regime: 'simples',
      csosn: '101',
      pCredSn: '2.80',
    });
    expect(editado.p_cred_sn).toBe('2.80');
  });
});

describe('códigos de barras adicionais', () => {
  it('o mesmo produto aceita vários códigos', () => {
    const p = criarProduto(empresa, 'Óleo', { barcode: '111' });
    addProductBarcode(empresa, p, '222');
    const codigos = addProductBarcode(empresa, p, '333');
    expect(codigos).toEqual(['222', '333']);
  });

  /**
   * O leitor do PDV precisa de UMA resposta por bipe. A checagem olha os dois
   * lugares onde código mora — o principal do produto e os adicionais —,
   * senão o mesmo código apontaria para dois produtos.
   */
  it('código que já é o principal de outro produto é recusado', () => {
    criarProduto(empresa, 'Óleo', { barcode: '111' });
    const outro = criarProduto(empresa, 'Filtro');
    expect(() => addProductBarcode(empresa, outro, '111')).toThrow(/outro produto/i);
  });

  it('código que já é adicional de outro produto é recusado', () => {
    const p1 = criarProduto(empresa, 'Óleo');
    const p2 = criarProduto(empresa, 'Filtro');
    addProductBarcode(empresa, p1, '999');
    expect(() => addProductBarcode(empresa, p2, '999')).toThrow(/outro produto/i);
  });

  it('a busca acha o produto pelo principal e pelo adicional', () => {
    const p = criarProduto(empresa, 'Óleo', { barcode: '111' });
    addProductBarcode(empresa, p, '222');
    expect(findProductByAnyBarcode(empresa, '111')).toBe(p);
    expect(findProductByAnyBarcode(empresa, '222')).toBe(p);
    expect(findProductByAnyBarcode(empresa, '000')).toBeNull();
  });
});

describe('kit de produtos', () => {
  it('monta o kit e soma o custo das peças', () => {
    const kit = criarProduto(empresa, 'Kit revisão');
    const oleo = criarProduto(empresa, 'Óleo', { costCents: 1500 });
    const filtro = criarProduto(empresa, 'Filtro', { costCents: 2000 });

    setKitComponents(empresa, kit, [
      { componentId: oleo, quantity: 2 },
      { componentId: filtro, quantity: 1 },
    ]);

    expect(kitCostCents(empresa, kit)).toBe(5000);
  });

  it('montar o kit marca o produto como kit', () => {
    const kit = criarProduto(empresa, 'Kit');
    const peca = criarProduto(empresa, 'Peça', { costCents: 100 });
    setKitComponents(empresa, kit, [{ componentId: peca, quantity: 1 }]);

    const linha = getConnection()
      .prepare('SELECT is_kit FROM core_products WHERE id = ?')
      .get(kit) as { is_kit: number };
    expect(linha.is_kit).toBe(1);
  });

  it('esvaziar a composição desmarca o kit', () => {
    const kit = criarProduto(empresa, 'Kit');
    const peca = criarProduto(empresa, 'Peça', { costCents: 100 });
    setKitComponents(empresa, kit, [{ componentId: peca, quantity: 1 }]);
    setKitComponents(empresa, kit, []);

    const linha = getConnection()
      .prepare('SELECT is_kit FROM core_products WHERE id = ?')
      .get(kit) as { is_kit: number };
    expect(linha.is_kit).toBe(0);
  });

  /** Definir substitui: peça removida na tela não pode voltar do banco. */
  it('definir a composição substitui a anterior, não acumula', () => {
    const kit = criarProduto(empresa, 'Kit');
    const a = criarProduto(empresa, 'A', { costCents: 100 });
    const b = criarProduto(empresa, 'B', { costCents: 200 });

    setKitComponents(empresa, kit, [{ componentId: a, quantity: 1 }]);
    const depois = setKitComponents(empresa, kit, [{ componentId: b, quantity: 1 }]);

    expect(depois).toHaveLength(1);
    expect(depois[0].component_id).toBe(b);
  });

  it('kit que contém a si mesmo é recusado', () => {
    const kit = criarProduto(empresa, 'Kit');
    expect(() => setKitComponents(empresa, kit, [{ componentId: kit, quantity: 1 }])).toThrow(
      /a si mesmo/i,
    );
  });

  /** Kit dentro de kit faria a baixa de estoque descer níveis — e ciclar. */
  it('kit dentro de kit é recusado', () => {
    const externo = criarProduto(empresa, 'Kit externo');
    const interno = criarProduto(empresa, 'Kit interno', { isKit: true });
    expect(() => setKitComponents(empresa, externo, [{ componentId: interno, quantity: 1 }])).toThrow(
      /laço/i,
    );
  });

  it('quantidade zero ou negativa é recusada', () => {
    const kit = criarProduto(empresa, 'Kit');
    const peca = criarProduto(empresa, 'Peça');
    expect(() => setKitComponents(empresa, kit, [{ componentId: peca, quantity: 0 }])).toThrow();
    expect(() => setKitComponents(empresa, kit, [{ componentId: peca, quantity: -1 }])).toThrow();
  });
});

/**
 * O formulário manda; o servidor tem de gravar.
 *
 * Este bloco existe por um defeito real: as colunas novas foram criadas na
 * migration e o formulário passou a enviá-las, mas o `CatalogService` não as
 * conhecia — o INSERT não as listava e o UPDATE não as montava. O cadastro
 * salvava com sucesso e os campos sumiam, sem erro nenhum na tela.
 */
describe('campos novos do produto persistem', () => {
  it('cria com referência, pisos e preço aberto', () => {
    const p = createProduct(empresa, {
      name: 'Óleo 20W50',
      costCents: 10000,
      priceCents: 15000,
      reference: 'FAB-991',
      minPriceCents: 12000,
      minMarkupPercent: 20,
      minMarginPercent: 15,
      openPrice: true,
    });

    const lido = getProduct(empresa, p.id) as unknown as Record<string, unknown>;
    expect(lido.reference).toBe('FAB-991');
    expect(lido.min_price_cents).toBe(12000);
    expect(lido.min_markup_percent).toBe(20);
    expect(lido.min_margin_percent).toBe(15);
    expect(lido.open_price).toBe(1);
  });

  it('atualiza os pisos sem tocar no resto', () => {
    const p = createProduct(empresa, { name: 'Filtro', costCents: 5000, priceCents: 8000 });
    updateProduct(empresa, p.id, { minPriceCents: 6000, reference: 'REF-1' });

    const lido = getProduct(empresa, p.id) as unknown as Record<string, unknown>;
    expect(lido.min_price_cents).toBe(6000);
    expect(lido.reference).toBe('REF-1');
    // O que não foi enviado continua como estava.
    expect(lido.price_cents).toBe(8000);
    expect(lido.name).toBe('Filtro');
  });

  /**
   * Piso ausente preserva o que estava — como já acontece com as medidas de
   * envio. Zerar um piso sem querer liberaria venda abaixo do que alguém
   * decidiu, e ninguém veria.
   */
  it('salvar sem enviar o piso não apaga o piso', () => {
    const p = createProduct(empresa, {
      name: 'Pneu',
      costCents: 20000,
      priceCents: 30000,
      minPriceCents: 25000,
    });
    updateProduct(empresa, p.id, { name: 'Pneu Aro 17' });

    const lido = getProduct(empresa, p.id) as unknown as Record<string, unknown>;
    expect(lido.name).toBe('Pneu Aro 17');
    expect(lido.min_price_cents).toBe(25000);
  });

  it('preço aberto desliga quando enviado como falso', () => {
    const p = createProduct(empresa, { name: 'Serviço', openPrice: true });
    updateProduct(empresa, p.id, { openPrice: false });
    const lido = getProduct(empresa, p.id) as unknown as Record<string, unknown>;
    expect(lido.open_price).toBe(0);
  });
});

/**
 * De nada adianta guardar o segundo código se a BUSCA não o enxerga.
 *
 * O cadastro de códigos adicionais existia, com rota e teste, e nenhum
 * consumidor: `findProductByAnyBarcode` não tinha um único chamador em todo o
 * servidor, e a busca do PDV comparava apenas `p.barcode`. Cadastrar o código
 * do fardo era decorativo — bipar não achava nada.
 */
describe('a busca enxerga os códigos adicionais', () => {
  it('acha o produto pelo código principal, como sempre', () => {
    criarProduto(empresa, 'Óleo 20W50', { barcode: '111' });
    expect(searchProducts(empresa, '111')).toHaveLength(1);
  });

  it('acha o produto pelo código adicional', () => {
    const p = criarProduto(empresa, 'Óleo 20W50', { barcode: '111' });
    addProductBarcode(empresa, p, '222');
    const achados = searchProducts(empresa, '222');
    expect(achados).toHaveLength(1);
    expect(achados[0]!.id).toBe(p);
  });

  /** EXISTS e não JOIN: junção multiplicaria a linha por código cadastrado. */
  it('produto com três códigos aparece UMA vez, não três', () => {
    const p = criarProduto(empresa, 'Óleo 20W50', { barcode: '111' });
    addProductBarcode(empresa, p, '222');
    addProductBarcode(empresa, p, '333');
    expect(searchProducts(empresa, 'Óleo')).toHaveLength(1);
  });

  /**
   * Quem bipa espera o item bipado em primeiro — não importa por qual dos
   * códigos dele o leitor acertou.
   */
  it('o casamento por código adicional vem antes do casamento por nome', () => {
    criarProduto(empresa, 'Filtro 222 especial');
    const alvo = criarProduto(empresa, 'Óleo 20W50');
    addProductBarcode(empresa, alvo, '222');

    const achados = searchProducts(empresa, '222');
    expect(achados.length).toBeGreaterThanOrEqual(1);
    expect(achados[0]!.id).toBe(alvo);
  });

  it('a listagem do cadastro também acha pelo código adicional', () => {
    const p = criarProduto(empresa, 'Óleo 20W50', { barcode: '111' });
    addProductBarcode(empresa, p, '222');
    expect(listProducts(empresa, { search: '222' })).toHaveLength(1);
  });

  it('código que não existe não acha nada', () => {
    criarProduto(empresa, 'Óleo', { barcode: '111' });
    expect(searchProducts(empresa, '999')).toHaveLength(0);
  });
});

describe('a busca do montar-kit não oferece o que o servidor recusa', () => {
  it('sem excludeKits, o kit aparece', () => {
    const kit = criarProduto(empresa, 'Kit revisao');
    const peca = criarProduto(empresa, 'Peca de kit');
    setKitComponents(empresa, kit, [{ componentId: peca, quantity: 1 }]);
    expect(searchProducts(empresa, 'Kit').some((p) => p.id === kit)).toBe(true);
  });

  it('com excludeKits, o kit some e a peça fica', () => {
    const kit = criarProduto(empresa, 'Kit revisao');
    const peca = criarProduto(empresa, 'Kit peca avulsa');
    setKitComponents(empresa, kit, [{ componentId: peca, quantity: 1 }]);

    const achados = searchProducts(empresa, 'Kit', 30, { excludeKits: true });
    expect(achados.some((p) => p.id === kit)).toBe(false);
    expect(achados.some((p) => p.id === peca)).toBe(true);
  });
});

describe('os interruptores do kit persistem', () => {
  it('desmembrar na venda vem ligado por padrão', () => {
    const p = createProduct(empresa, { name: 'Kit' });
    const lido = getProduct(empresa, p.id) as unknown as Record<string, unknown>;
    expect(lido.kit_explode_on_sale).toBe(1);
    expect(lido.kit_cost_from_components).toBe(0);
  });

  it('os dois mudam pela API', () => {
    const p = createProduct(empresa, { name: 'Kit' });
    updateProduct(empresa, p.id, { kitExplodeOnSale: false, kitCostFromComponents: true });
    const lido = getProduct(empresa, p.id) as unknown as Record<string, unknown>;
    expect(lido.kit_explode_on_sale).toBe(0);
    expect(lido.kit_cost_from_components).toBe(1);
  });

  it('salvar sem enviar os interruptores não os altera', () => {
    const p = createProduct(empresa, { name: 'Kit' });
    updateProduct(empresa, p.id, { kitExplodeOnSale: false });
    updateProduct(empresa, p.id, { name: 'Kit revisao' });
    const lido = getProduct(empresa, p.id) as unknown as Record<string, unknown>;
    expect(lido.name).toBe('Kit revisao');
    expect(lido.kit_explode_on_sale).toBe(0);
  });
});

describe('tabela de preços', () => {
  it('o percentual da tabela vale para quem não tem preço fixado', () => {
    const tabela = upsertPriceTable(empresa, { name: 'Atacado', percentOff: 5 });
    const p = criarProduto(empresa, 'Óleo');
    expect(priceInTable(empresa, tabela.id, p, 10000)).toBe(9500);
  });

  /** É assim que se negocia: 5% em tudo, MENOS naquele item combinado. */
  it('o preço fixado no item ganha do percentual da tabela', () => {
    const tabela = upsertPriceTable(empresa, { name: 'Atacado', percentOff: 5 });
    const p = criarProduto(empresa, 'Óleo');
    setPriceTableItem(empresa, tabela.id, p, 8000);
    expect(priceInTable(empresa, tabela.id, p, 10000)).toBe(8000);
  });

  it('desconto de 100% ou mais é recusado', () => {
    expect(() => upsertPriceTable(empresa, { name: 'X', percentOff: 100 })).toThrow();
    expect(() => upsertPriceTable(empresa, { name: 'Y', percentOff: -1 })).toThrow();
  });
});

/*
  O MESMO BIPE NÃO PODE ACHAR DOIS PRODUTOS.

  O código de barras mora em DUAS tabelas: o principal em `core_products` e os
  extras em `core_product_barcodes`. `addProductBarcode` sempre consultou as
  duas; `createProduct` consultava só a primeira, e o índice único do banco
  também cobre só a primeira.

  A consequência não era um erro — era o silêncio. Um código que já vivia na
  tabela de extras passava pela checagem, passava pelo índice, e o produto
  nascia. Ficavam dois produtos respondendo ao mesmo bipe: no PDV a leitora
  encontra um dos dois, a venda sai do errado, e o saldo do certo nunca baixa.

  Por isso o teste central abaixo é sobre a CONTAGEM. Cobrar só o 409 deixaria
  passar uma versão que recusa por acaso; o que prova o conserto é que o
  segundo produto NÃO EXISTE.
*/
describe('código de barras duplicado entre as duas tabelas', () => {
  it('cadastrar produto com código que já é EXTRA de outro é recusado', () => {
    const dono = criarProduto(empresa, 'Fonte 12V');
    addProductBarcode(empresa, dono, '7891234567895');

    expect(() =>
      createProduct(empresa, { name: 'Fonte genérica', barcode: '7891234567895' }),
    ).toThrowError(/já pertence a outro produto/i);
  });

  it('e o produto não chega a existir — é o silêncio que se está fechando', () => {
    const dono = criarProduto(empresa, 'Fonte 12V');
    addProductBarcode(empresa, dono, '7891234567895');

    try {
      createProduct(empresa, { name: 'Fonte genérica', barcode: '7891234567895' });
    } catch {
      // A recusa é o assunto do teste acima; aqui interessa o estado.
    }

    const quantos = getConnection()
      .prepare('SELECT COUNT(*) AS n FROM core_products WHERE company_id = ? AND name = ?')
      .get(empresa, 'Fonte genérica') as { n: number };
    expect(quantos.n).toBe(0);

    // E o bipe continua achando UM produto só: o dono original.
    expect(findProductByAnyBarcode(empresa, '7891234567895')).toBe(dono);
  });

  it('o código principal de outro produto continua sendo recusado', () => {
    criarProduto(empresa, 'Cabo HDMI', { barcode: '7899999999999' });
    expect(() =>
      createProduct(empresa, { name: 'Cabo paralelo', barcode: '7899999999999' }),
    ).toThrowError(/já pertence a outro produto/i);
  });

  it('código de barras livre cadastra normalmente', () => {
    const p = createProduct(empresa, { name: 'Mouse', barcode: '7890000000000' });
    expect(findProductByAnyBarcode(empresa, '7890000000000')).toBe(p.id);
  });

  /*
    O código de barras é único POR EMPRESA, e não no grupo inteiro. Duas lojas
    do mesmo dono vendem o mesmo produto de fábrica, com o mesmo código na
    caixa — travar isso impediria a operação real.
  */
  it('o mesmo código em outra empresa é livre', () => {
    const outra = upsertCompany({
      slug: 'outra-loja',
      legalName: 'Outra Loja Ltda',
      tradeName: 'Outra',
      kind: 'store',
    });

    const aqui = createProduct(empresa, { name: 'Mouse', barcode: '7890000000000' });
    const la = createProduct(outra, { name: 'Mouse', barcode: '7890000000000' });

    expect(findProductByAnyBarcode(empresa, '7890000000000')).toBe(aqui.id);
    expect(findProductByAnyBarcode(outra, '7890000000000')).toBe(la.id);
  });
});
