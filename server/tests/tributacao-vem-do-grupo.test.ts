/**
 * A TRIBUTAÇÃO DO ITEM VEM DA OPERAÇÃO — não do código.
 *
 * ============================================================================
 * O QUE ESTAVA CRAVADO NO XML
 * ============================================================================
 *
 *     <ICMS><ICMSSN102><orig>0</orig><CSOSN>102</CSOSN></ICMSSN102></ICMS>
 *
 * CSOSN 102 fixo, para todo item, de toda empresa. O comentário logo acima
 * dizia — corretamente — que "os valores de CSOSN/CST NÃO são inferidos aqui:
 * entram pelo perfil tributário quando ele existir". O perfil existe: a tabela
 * `core_tax_groups` guarda, por empresa, regime, CSOSN, CST de ICMS, CST de
 * PIS e de COFINS, CFOP interno e interestadual, origem, NCM e CEST. E o
 * `core_products.tax_profile` liga cada produto ao grupo.
 *
 * Só o CRUD lia essa tabela. Na hora de emitir, ninguém perguntava.
 *
 * Efeito: empresa fora do Simples emitia grupo de tributação estruturalmente
 * errado, e empresa do Simples com CSOSN 101 emitia 102 — outro imposto, outra
 * apuração, com a nota já autorizada.
 *
 * ============================================================================
 * O SEGUNDO BURACO, NO MESMO BLOCO
 * ============================================================================
 *
 * O `<imposto>` de cada item não tinha `<PIS>` nem `<COFINS>`. Os dois são
 * obrigatórios no layout, e a nota inteira falha na validação de schema da
 * SEFAZ antes de qualquer análise fiscal.
 *
 * ============================================================================
 * O QUE ESTE ARQUIVO GUARDA
 * ============================================================================
 *
 * Que a tributação sai da configuração da OPERAÇÃO, que a falta de um dado é
 * dita com o nome do dado, e que nenhuma empresa usa o grupo da vizinha.
 */
import { beforeEach, describe, expect, it } from 'vitest';

process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_DATABASE_PATH = ':memory:';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

const { resetDbForTests } = await import('../src/db/database.js');
const { ensureCoreSchema } = await import('../src/db/schema.js');
const { upsertCompany } = await import('../src/services/auth/IdentityService.js');
const { updateFiscalConfig } = await import('../src/services/core/FiscalConfigService.js');
const { upsertTaxGroup } = await import('../src/services/core/CatalogAuxService.js');
const { upsertNfceCsc } = await import('../src/services/nfce/NfceCscService.js');
const { tributacaoDoItem } = await import('../src/services/core/TributacaoDoItem.js');

let precoJusto: string;
let gringa: string;

/** O produto como o resolvedor o recebe. */
const CAMISA = {
  id: 'p1',
  description: 'Camisa Social',
  taxProfile: null as string | null,
  origin: '0',
  cfop: null as string | null,
  ncm: '62052000',
  cest: null as string | null,
  totalCents: 10_000,
};

function empresa(slug: string, nome: string, cnpj: string, crt: string): string {
  const id = upsertCompany({ slug, legalName: `${nome} Ltda`, tradeName: nome });
  updateFiscalConfig({
    companyId: id,
    patch: {
      legalName: `${nome} Ltda`,
      cnpj,
      ie: '123456789',
      crt,
      street: 'Rua Um',
      number: '1',
      district: 'Centro',
      cityName: 'Pelotas',
      cityIbge: '4314407',
      zip: '96010000',
      uf: 'RS',
    },
  });
  return id;
}

beforeEach(() => {
  resetDbForTests();
  ensureCoreSchema();
  precoJusto = empresa('preco-justo', 'Preço Justo', '11.222.333/0001-81', '1');
  gringa = empresa('gringa', 'Gringa', '99.888.777/0001-00', '1');
});

/** O grupo do Simples que o contador da Preço Justo confirmou. */
function grupo102(companyId: string) {
  upsertNfceCsc({
    companyId,
    operationalUnitId: 'unit-default',
    cscId: '000001',
    cscToken: 'CSC-DE-TESTE-NAO-E-O-REAL',
  });
  return upsertTaxGroup(companyId, {
    code: 'SIMPLES-102',
    name: 'Simples — CSOSN 102',
    regime: 'simples',
    csosn: '102',
    cstPis: '49',
    cstCofins: '49',
    cfopInternal: '5102',
    cfopExternal: '6102',
  });
}

/** Uma venda de uma camisa, pronta para virar cupom. */
function vendaSimples(companyId: string) {
  return {
    id: 'v1',
    companyId,
    number: 1,
    createdAt: '2026-08-26T17:00:00.000Z',
    subtotalCents: 10_000,
    discountCents: 0,
    surchargeCents: 0,
    totalCents: 10_000,
    changeCents: 0,
    customerId: null,
    customerDocument: null,
    customerName: null,
    items: [
      {
        productId: 'p1',
        description: 'Camisa Social',
        quantity: 2,
        unitPriceCents: 5_000,
        discountCents: 0,
        totalCents: 10_000,
        ncm: '62052000',
        cest: null,
        cfop: '5102',
        origin: '0',
        unit: 'UN',
        barcode: '7891234567895',
        internalCode: 'GS-0001',
        taxProfile: 'SIMPLES-102',
      },
    ],
    payments: [{ method: 'dinheiro', amountCents: 10_000 }],
  } as never;
}

// ============================================================================

describe('o CSOSN vem do grupo da empresa, não do código', () => {
  it('grupo com 102 emite 102 — e grupo com 101 emite 101', () => {
    grupo102(precoJusto);
    upsertTaxGroup(precoJusto, {
      code: 'SIMPLES-101',
      name: 'Simples — CSOSN 101',
      regime: 'simples',
      csosn: '101',
      pCredSn: '2.50',
      cstPis: '49',
      cstCofins: '49',
      cfopInternal: '5102',
      cfopExternal: '6102',
    });

    const com102 = tributacaoDoItem({
      companyId: precoJusto,
      produto: { ...CAMISA, taxProfile: 'SIMPLES-102' },
    });
    const com101 = tributacaoDoItem({
      companyId: precoJusto,
      produto: { ...CAMISA, taxProfile: 'SIMPLES-101' },
    });

    expect(com102.csosn).toBe('102');
    expect(com101.csosn).toBe('101');
  });

  it('CSOSN 101 sem a alíquota de crédito é recusado, com o nome do que falta', () => {
    /*
      CSOSN 101 é "tributada COM permissão de crédito", e o layout exige
      `pCredSN` e `vCredICMSSN` junto. Emitir 101 sem a alíquota produz XML que
      falha no schema — e inventar a alíquota seria inventar imposto.
    */
    upsertTaxGroup(precoJusto, {
      code: 'SIMPLES-101',
      name: 'Simples — CSOSN 101',
      regime: 'simples',
      csosn: '101',
      cstPis: '49',
      cstCofins: '49',
    });

    expect(() =>
      tributacaoDoItem({
        companyId: precoJusto,
        produto: { ...CAMISA, taxProfile: 'SIMPLES-101' },
      }),
    ).toThrow(/crédito/i);
  });

  it('a alíquota de crédito vira valor sobre o total do item', () => {
    upsertTaxGroup(precoJusto, {
      code: 'SIMPLES-101',
      name: 'Simples — CSOSN 101',
      regime: 'simples',
      csosn: '101',
      pCredSn: '2.50',
      cstPis: '49',
      cstCofins: '49',
      cfopInternal: '5102',
    });

    const t = tributacaoDoItem({
      companyId: precoJusto,
      produto: { ...CAMISA, taxProfile: 'SIMPLES-101', totalCents: 10_000 },
    });

    // 2,50% de R$ 100,00 = R$ 2,50.
    expect(t.pCredSn).toBe('2.50');
    expect(t.vCredIcmsSnCents).toBe(250);
  });
});

// ============================================================================

describe('produto sem perfil tributário', () => {
  it('com um único grupo ativo, ele é o da operação', () => {
    /*
      Um grupo só é a operação declarando "é assim que eu tributo". Usá-lo não
      é adivinhar — é ler o que a empresa cadastrou. Com dois, adivinhar seria.
    */
    grupo102(precoJusto);

    const t = tributacaoDoItem({ companyId: precoJusto, produto: CAMISA });
    expect(t.csosn).toBe('102');
    expect(t.origemDoGrupo).toBe('SIMPLES-102');
  });

  it('sem nenhum grupo, a recusa nomeia o produto e o que falta', () => {
    expect(() => tributacaoDoItem({ companyId: precoJusto, produto: CAMISA }))
      .toThrow(/Camisa Social/);
  });

  it('com dois grupos ativos, recusa em vez de escolher', () => {
    grupo102(precoJusto);
    upsertTaxGroup(precoJusto, {
      code: 'SIMPLES-101',
      name: 'Simples — CSOSN 101',
      regime: 'simples',
      csosn: '101',
      pCredSn: '2.50',
      cstPis: '49',
      cstCofins: '49',
    });

    expect(() => tributacaoDoItem({ companyId: precoJusto, produto: CAMISA }))
      .toThrow(/perfil/i);
  });
});

// ============================================================================

describe('o grupo de uma empresa não serve a outra', () => {
  it('perfil cadastrado só na vizinha é recusado', () => {
    grupo102(gringa);

    /*
      `tax_profile` é um CÓDIGO, e código se repete entre empresas. Buscar o
      grupo sem a empresa faria a nota do Preço Justo sair com a tributação da
      Gringa — do jeito mais silencioso possível, porque o código bate.
    */
    expect(() =>
      tributacaoDoItem({
        companyId: precoJusto,
        produto: { ...CAMISA, taxProfile: 'SIMPLES-102' },
      }),
    ).toThrow(/SIMPLES-102/);
  });
});

// ============================================================================

describe('PIS e COFINS saem do grupo', () => {
  it('CST 49 com alíquota zero — o que o contador confirmou', () => {
    grupo102(precoJusto);
    const t = tributacaoDoItem({
      companyId: precoJusto,
      produto: { ...CAMISA, taxProfile: 'SIMPLES-102' },
    });

    expect(t.cstPis).toBe('49');
    expect(t.cstCofins).toBe('49');
  });

  it('grupo sem CST de PIS/COFINS é recusado — os dois são obrigatórios no layout', () => {
    upsertTaxGroup(precoJusto, {
      code: 'INCOMPLETO',
      name: 'Sem PIS',
      regime: 'simples',
      csosn: '102',
    });

    expect(() =>
      tributacaoDoItem({
        companyId: precoJusto,
        produto: { ...CAMISA, taxProfile: 'INCOMPLETO' },
      }),
    ).toThrow(/PIS|COFINS/);
  });
});

// ============================================================================

describe('o CFOP depende de para onde a mercadoria vai', () => {
  it('venda dentro do RS usa o CFOP interno; para fora, o interestadual', () => {
    grupo102(precoJusto);

    const dentro = tributacaoDoItem({
      companyId: precoJusto,
      produto: { ...CAMISA, taxProfile: 'SIMPLES-102' },
      ufDestinatario: 'RS',
    });
    const fora = tributacaoDoItem({
      companyId: precoJusto,
      produto: { ...CAMISA, taxProfile: 'SIMPLES-102' },
      ufDestinatario: 'SC',
    });

    expect(dentro.cfop).toBe('5102');
    expect(fora.cfop).toBe('6102');
  });

  it('o CFOP do próprio produto vence o do grupo — ele é mais específico', () => {
    grupo102(precoJusto);

    const t = tributacaoDoItem({
      companyId: precoJusto,
      produto: { ...CAMISA, taxProfile: 'SIMPLES-102', cfop: '5405' },
      ufDestinatario: 'RS',
    });

    expect(t.cfop).toBe('5405');
  });

  it('sem destinatário — o cupom do balcão — o CFOP é o interno', () => {
    grupo102(precoJusto);
    const t = tributacaoDoItem({
      companyId: precoJusto,
      produto: { ...CAMISA, taxProfile: 'SIMPLES-102' },
    });
    expect(t.cfop).toBe('5102');
  });
});

// ============================================================================

describe('regime normal', () => {
  it('empresa fora do Simples exige CST de ICMS, e a recusa diz isso', () => {
    /*
      As seis operações do grupo são Simples hoje. Se uma sair, o CSOSN deixa
      de valer e o item passa a exigir CST de ICMS com base e alíquota — e o
      certo é recusar dizendo o que falta, não emitir CSOSN para quem não tem.
    */
    const normal = empresa('conceito', 'Conceito', '11.444.777/0001-61', '3');
    upsertTaxGroup(normal, {
      code: 'NORMAL',
      name: 'Regime normal',
      regime: 'normal',
      cstPis: '49',
      cstCofins: '49',
    });

    expect(() =>
      tributacaoDoItem({ companyId: normal, produto: { ...CAMISA, taxProfile: 'NORMAL' } }),
    ).toThrow(/CST/i);
  });
});

// ============================================================================

describe('o XML que sai carrega o bloco de imposto inteiro', () => {
  it('ICMS do grupo, PIS e COFINS — os três, como o layout exige', async () => {
    const { setSeriesNextNumber } = await import('../src/services/core/FiscalKeyService.js');
    const { buildNfceXml } = await import('../src/services/core/FiscalXmlNfce.js');
    grupo102(precoJusto);
    setSeriesNextNumber({ companyId: precoJusto, model: '65', serie: 1, nextNumber: 1 });

    const { xml } = buildNfceXml({
      sale: {
        id: 'v1',
        companyId: precoJusto,
        number: 1,
        createdAt: '2026-08-26T17:00:00.000Z',
        subtotalCents: 10_000,
        discountCents: 0,
        surchargeCents: 0,
        totalCents: 10_000,
        changeCents: 0,
        customerId: null,
        customerDocument: null,
        customerName: null,
        items: [
          {
            productId: 'p1',
            description: 'Camisa Social',
            quantity: 2,
            unitPriceCents: 5_000,
            discountCents: 0,
            totalCents: 10_000,
            ncm: '62052000',
            cest: null,
            cfop: '5102',
            origin: '0',
            unit: 'UN',
            barcode: '7891234567895',
            internalCode: 'GS-0001',
            taxProfile: 'SIMPLES-102',
          },
        ],
        payments: [{ method: 'dinheiro', amountCents: 10_000 }],
      } as never,
      config: (await import('../src/services/core/FiscalConfigService.js')).getFiscalConfig(precoJusto),
      serie: 1,
      number: 1,
    });

    /*
      O `<imposto>` não tinha PIS nem COFINS. Os dois são obrigatórios no
      layout, e a nota inteira falha na validação de schema da SEFAZ antes de
      qualquer análise fiscal — nenhum cupom sairia.
    */
    expect(xml).toContain('<CSOSN>102</CSOSN>');
    expect(xml).toContain('<PISOutr>');
    expect(xml).toContain('<CST>49</CST>');
    expect(xml).toContain('<COFINSOutr>');
    expect(xml).toContain('<pCOFINS>0.00</pCOFINS>');
  });
});

// ============================================================================

describe('a venda com desconto de rodapé emite', () => {
  it('desconto no total: a soma fecha e o XML declara vDesc', async () => {
    const { validateNfce, buildNfceXml } = await import('../src/services/core/FiscalXmlNfce.js');
    const { getFiscalConfig } = await import('../src/services/core/FiscalConfigService.js');
    const { setSeriesNextNumber } = await import('../src/services/core/FiscalKeyService.js');
    grupo102(precoJusto);
    setSeriesNextNumber({ companyId: precoJusto, model: '65', serie: 1, nextNumber: 1 });

    /*
      `validateNfce` exigia `soma(itens) === total`. Mas o total é
      `subtotal − desconto + acréscimo`: QUALQUER venda com desconto de rodapé
      — e o balcão dá desconto de rodapé o dia inteiro — morria com
      "A soma dos itens não bate com o total da venda", sem que nada dissesse
      que a causa era o desconto.
    */
    const venda = {
      id: 'v-desconto',
      companyId: precoJusto,
      number: 1,
      createdAt: '2026-08-26T17:00:00.000Z',
      subtotalCents: 10_000,
      discountCents: 1_000,
      surchargeCents: 0,
      totalCents: 9_000,
      changeCents: 0,
      customerId: null,
      customerDocument: null,
      customerName: null,
      items: [
        {
          productId: 'p1',
          description: 'Camisa Social',
          quantity: 2,
          unitPriceCents: 5_000,
          discountCents: 0,
          totalCents: 10_000,
          ncm: '62052000',
          cest: null,
          cfop: '5102',
          origin: '0',
          unit: 'UN',
          barcode: '7891234567895',
          internalCode: 'GS-0001',
          taxProfile: 'SIMPLES-102',
        },
      ],
      payments: [{ method: 'dinheiro', amountCents: 9_000 }],
    } as never;

    expect(validateNfce(venda, getFiscalConfig(precoJusto))).toEqual([]);

    const { xml } = buildNfceXml({
      sale: venda,
      config: getFiscalConfig(precoJusto),
      serie: 1,
      number: 1,
    });
    expect(xml).toContain('<vDesc>10.00</vDesc>');
    expect(xml).toContain('<vNF>90.00</vNF>');
    expect(xml).toContain('<vProd>100.00</vProd>');
  });

  it('acréscimo no total: entra como vOutro e fecha a conta', async () => {
    const { validateNfce, buildNfceXml } = await import('../src/services/core/FiscalXmlNfce.js');
    const { getFiscalConfig } = await import('../src/services/core/FiscalConfigService.js');
    const { setSeriesNextNumber } = await import('../src/services/core/FiscalKeyService.js');
    grupo102(precoJusto);
    setSeriesNextNumber({ companyId: precoJusto, model: '65', serie: 1, nextNumber: 1 });

    const venda = {
      id: 'v-acrescimo',
      companyId: precoJusto,
      number: 1,
      createdAt: '2026-08-26T17:00:00.000Z',
      subtotalCents: 10_000,
      discountCents: 0,
      surchargeCents: 1_500,
      totalCents: 11_500,
      changeCents: 0,
      customerId: null,
      customerDocument: null,
      customerName: null,
      items: [
        {
          productId: 'p1',
          description: 'Camisa Social',
          quantity: 2,
          unitPriceCents: 5_000,
          discountCents: 0,
          totalCents: 10_000,
          ncm: '62052000',
          cest: null,
          cfop: '5102',
          origin: '0',
          unit: 'UN',
          barcode: '7891234567895',
          internalCode: 'GS-0001',
          taxProfile: 'SIMPLES-102',
        },
      ],
      payments: [{ method: 'dinheiro', amountCents: 11_500 }],
    } as never;

    expect(validateNfce(venda, getFiscalConfig(precoJusto))).toEqual([]);

    const { xml } = buildNfceXml({
      sale: venda,
      config: getFiscalConfig(precoJusto),
      serie: 1,
      number: 1,
    });
    // Juros e frete do pagamento entram em "outras despesas acessórias".
    expect(xml).toContain('<vOutro>15.00</vOutro>');
    expect(xml).toContain('<vNF>115.00</vNF>');
  });

  it('total que não fecha continua sendo recusado — a trava não afrouxou', async () => {
    const { validateNfce } = await import('../src/services/core/FiscalXmlNfce.js');
    const { getFiscalConfig } = await import('../src/services/core/FiscalConfigService.js');
    grupo102(precoJusto);

    const problemas = validateNfce(
      {
        id: 'v-torta',
        companyId: precoJusto,
        number: 1,
        createdAt: '2026-08-26T17:00:00.000Z',
        subtotalCents: 10_000,
        discountCents: 0,
        surchargeCents: 0,
        totalCents: 7_777,
        changeCents: 0,
        customerId: null,
        customerDocument: null,
        customerName: null,
        items: [
          {
            productId: 'p1',
            description: 'Camisa',
            quantity: 1,
            unitPriceCents: 10_000,
            discountCents: 0,
            totalCents: 10_000,
            ncm: '62052000',
            cest: null,
            cfop: '5102',
            origin: '0',
            unit: 'UN',
            barcode: '7891234567895',
            internalCode: 'GS-1',
            taxProfile: 'SIMPLES-102',
          },
        ],
        payments: [{ method: 'dinheiro', amountCents: 7_777 }],
      } as never,
      getFiscalConfig(precoJusto),
    );

    expect(problemas.some((p) => p.field === 'total.vNF')).toBe(true);
  });
});

// ============================================================================

describe('o cupom sai com QR Code', () => {
  it('infNFeSupl com o QR do CSC e a URL do portal do estado', async () => {
    const { buildNfceXml } = await import('../src/services/core/FiscalXmlNfce.js');
    const { getFiscalConfig } = await import('../src/services/core/FiscalConfigService.js');
    const { setSeriesNextNumber } = await import('../src/services/core/FiscalKeyService.js');
    grupo102(precoJusto);
    setSeriesNextNumber({ companyId: precoJusto, model: '65', serie: 1, nextNumber: 1 });

    const { xml, accessKey } = buildNfceXml({
      sale: vendaSimples(precoJusto),
      config: getFiscalConfig(precoJusto),
      serie: 1,
      number: 1,
    });

    /*
      O XML saía de `<ide>` a `<pag>` sem `<infNFeSupl>`. Modelo 65 sem QR é
      recusado pela SEFAZ e, mesmo que passasse, o consumidor não teria como
      conferir o cupom. O gerador existia e só era chamado pelo módulo legado.
    */
    expect(xml).toContain('<infNFeSupl>');
    expect(xml).toContain('<qrCode>');
    expect(xml).toContain('dfe-portal.svrs.rs.gov.br');
    // O payload da versão 2: chave|versão|ambiente|idToken|hash.
    // O idToken vai sem os zeros não significativos — é o que o XSD aceita (GAP-PRD-097).
    expect(xml).toContain(`p=${accessKey}|2|2|1|`);
    // E o bloco vem DEPOIS do infNFe — a ordem que o schema exige.
    expect(xml.indexOf('</infNFe>')).toBeLessThan(xml.indexOf('<infNFeSupl>'));
  });

  it('sem CSC cadastrado, a recusa diz que ele vem do portal da SEFAZ', async () => {
    const { buildNfceXml } = await import('../src/services/core/FiscalXmlNfce.js');
    const { getFiscalConfig } = await import('../src/services/core/FiscalConfigService.js');
    const { upsertTaxGroup: grupo } = await import('../src/services/core/CatalogAuxService.js');
    const { setSeriesNextNumber } = await import('../src/services/core/FiscalKeyService.js');

    // Grupo tributário sim, CSC não: é o estado real da Preço Justo hoje.
    grupo(precoJusto, {
      code: 'SIMPLES-102',
      name: 'Simples — CSOSN 102',
      regime: 'simples',
      csosn: '102',
      cstPis: '49',
      cstCofins: '49',
      cfopInternal: '5102',
    });
    setSeriesNextNumber({ companyId: precoJusto, model: '65', serie: 1, nextNumber: 1 });

    expect(() =>
      buildNfceXml({
        sale: vendaSimples(precoJusto),
        config: getFiscalConfig(precoJusto),
        serie: 1,
        number: 1,
      }),
    ).toThrow(/CSC/);
  });
});
