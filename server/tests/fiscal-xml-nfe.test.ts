/**
 * XML da NF-e (modelo 55).
 *
 * O que estes testes protegem é a DIFERENÇA em relação à NFC-e. Trocar apenas
 * o número do modelo produziria um XML que a SEFAZ recusa — e a recusa viria
 * depois da venda, com a mercadoria já entregue.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDbForTests } from '../src/db/database.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import { updateFiscalConfig, type FiscalConfig } from '../src/services/core/FiscalConfigService.js';
import { isValidAccessKey } from '../src/services/core/FiscalKeyService.js';
import { validateAgainstSchema, type NfceSale } from '../src/services/core/FiscalXmlNfce.js';
import {
  PRESENCE_INTERNET,
  buildNfeXml,
  destinationIndicator,
  validateNfe,
  validateRecipient,
  type NfeRecipient,
} from '../src/services/core/FiscalXmlNfe.js';
import { grupoTributarioPadrao } from './helpers/grupoTributario.js';

let companyId: string;
let config: FiscalConfig;

const DEST_PJ: NfeRecipient = {
  document: '11.444.777/0001-61',
  name: 'Comprador Atacado Ltda',
  ieIndicator: '1',
  ie: '987654321',
  street: 'Rua do Comércio',
  number: '500',
  district: 'Industrial',
  cityName: 'Pelotas',
  cityIbge: '4314407',
  uf: 'RS',
  zip: '68900-100',
};

const DEST_PF: NfeRecipient = {
  document: '123.456.789-09',
  name: 'Maria Consumidora',
  ieIndicator: '9',
  street: 'Rua das Flores',
  number: '10',
  district: 'Centro',
  cityName: 'Belém',
  cityIbge: '1501402',
  uf: 'PA',
};

function venda(over: Partial<NfceSale> = {}): NfceSale {
  return {
    id: 'sale-1',
    number: 1,
    companyId,
    createdAt: '2026-08-13T12:00:00.000Z',
    subtotalCents: 20_000,
    discountCents: 0,
    surchargeCents: 0,
    totalCents: 20_000,
    changeCents: 0,
    customerId: null,
    customerDocument: null,
    customerName: null,
    items: [
      {
        productId: 'p1',
        description: 'Patinete Elétrico Urban 350W',
        quantity: 2,
        unitPriceCents: 10_000,
        discountCents: 0,
        surchargeCents: 0,
        totalCents: 20_000,
        ncm: '87116000',
        cest: null,
        cfop: '5102',
        origin: '0',
        unit: 'UN',
        barcode: '7891234567895',
        internalCode: 'PJ-0001',
      },
    ],
    payments: [{ method: 'pix', amountCents: 20_000 }],
    ...over,
  };
}

/**
 * A venda como a emissão a monta para OUTRA UF: o CFOP interestadual do grupo.
 *
 * Os dois testes de destino abaixo montavam a nota para o Pará com o item em
 * 5102 — CFOP de saída interna com idDest 2, a combinação que a SEFAZ recusa. A
 * montagem agora confere o alcance do CFOP contra o destino (P0 fiscal), e a
 * emissão de verdade (`completarPeloGrupo`) já troca o 5102 pelo 6102 do grupo.
 */
function vendaInterestadual(): NfceSale {
  const v = venda();
  return { ...v, items: v.items.map((i) => ({ ...i, cfop: '6102' })) };
}

beforeEach(() => {
  resetDbForTests();
  companyId = upsertCompany({
    slug: 'pj-motors',
    legalName: 'PJ Motors Ltda',
    tradeName: 'PJ Motors',
  });
  config = updateFiscalConfig({
    companyId,
    patch: {
      legalName: 'PJ Motors Comércio Ltda',
      tradeName: 'PJ Motors',
      cnpj: '11.222.333/0001-81',
      ie: '123456789',
      crt: '1',
      street: 'Av. das Motos',
      number: '1000',
      district: 'Centro',
      cityName: 'Pelotas',
      cityIbge: '4314407',
      zip: '96010000',
      uf: 'RS',
    },
  });
  grupoTributarioPadrao(companyId);
});

describe('estrutura do modelo 55', () => {
  it('gera modelo 55, não 65', () => {
    const { xml, accessKey } = buildNfeXml({
      sale: venda(),
      config,
      recipient: DEST_PJ,
      serie: 1,
      number: 1,
    });

    expect(xml).toContain('<mod>55</mod>');
    expect(xml).not.toContain('<mod>65</mod>');
    // O modelo entra na chave, nas posições 20-22.
    expect(accessKey.slice(20, 22)).toBe('55');
    expect(isValidAccessKey(accessKey)).toBe(true);
    expect(validateAgainstSchema(xml).wellFormed).toBe(true);
  });

  /** Impressão retrato, não formato de cupom. */
  it('usa tpImp 1 (retrato), não 4', () => {
    const { xml } = buildNfeXml({ sale: venda(), config, recipient: DEST_PJ, serie: 1, number: 1 });
    expect(xml).toContain('<tpImp>1</tpImp>');
  });

  it('a chave carrega série e número corretos', () => {
    const { xml, accessKey } = buildNfeXml({
      sale: venda(),
      config,
      recipient: DEST_PJ,
      serie: 4,
      number: 987,
    });
    expect(accessKey.slice(22, 25)).toBe('004');
    expect(accessKey.slice(25, 34)).toBe('000000987');
    expect(xml).toContain(`<cDV>${accessKey.slice(-1)}</cDV>`);
  });
});

describe('destinatário — a diferença que mais importa', () => {
  it('NF-e SEM destinatário é recusada', () => {
    const problemas = validateNfe({ sale: venda(), config, recipient: null });
    expect(problemas.some((p) => p.field === 'dest')).toBe(true);

    expect(() =>
      buildNfeXml({
        sale: venda(),
        config,
        recipient: null as unknown as NfeRecipient,
        serie: 1,
        number: 1,
      }),
    ).toThrow(/destinatário/i);
  });

  it('destinatário pessoa jurídica sai com CNPJ e IE', () => {
    const { xml } = buildNfeXml({ sale: venda(), config, recipient: DEST_PJ, serie: 1, number: 1 });
    expect(xml).toContain('<CNPJ>11444777000161</CNPJ>');
    expect(xml).toContain('<indIEDest>1</indIEDest>');
    expect(xml).toContain('<IE>987654321</IE>');
    expect(xml).toContain('Comprador Atacado Ltda');
  });

  it('destinatário pessoa física sai com CPF e sem IE', () => {
    const { xml } = buildNfeXml({ sale: vendaInterestadual(), config, recipient: DEST_PF, serie: 1, number: 1 });
    expect(xml).toContain('<CPF>12345678909</CPF>');
    expect(xml).toContain('<indIEDest>9</indIEDest>');
    // Não contribuinte não tem inscrição — o bloco não pode aparecer.
    expect(xml).not.toMatch(/<dest>[\s\S]*<IE>[\s\S]*<\/dest>/);
  });

  it('documento com tamanho errado é recusado', () => {
    expect(
      validateRecipient({ ...DEST_PJ, document: '1144477700016' }).some((p) =>
        p.field.includes('CPF/CNPJ'),
      ),
    ).toBe(true);
  });

  /** Contribuinte sem IE é contradição. */
  it('contribuinte sem inscrição estadual é recusado', () => {
    const problemas = validateRecipient({ ...DEST_PJ, ie: null });
    expect(problemas.some((p) => p.field === 'dest.IE')).toBe(true);
  });

  it('endereço incompleto e IBGE inválido são apontados', () => {
    const problemas = validateRecipient({ ...DEST_PJ, street: '', cityIbge: '160' });
    expect(problemas.some((p) => p.field === 'dest.enderDest')).toBe(true);
    expect(problemas.some((p) => p.field === 'dest.cMun')).toBe(true);
  });
});

describe('destino da operação', () => {
  /** Interestadual declarada como interna é imposto recolhido a menor. */
  it('mesma UF é interna (1); UF diferente é interestadual (2)', () => {
    expect(destinationIndicator('AP', 'AP')).toBe('1');
    expect(destinationIndicator('AP', 'PA')).toBe('2');
    expect(destinationIndicator('AP', 'XX')).toBe('3');
  });

  it('o XML reflete o destino calculado', () => {
    const interna = buildNfeXml({ sale: venda(), config, recipient: DEST_PJ, serie: 1, number: 1 });
    const fora = buildNfeXml({ sale: vendaInterestadual(), config, recipient: DEST_PF, serie: 1, number: 2 });

    expect(interna.xml).toContain('<idDest>1</idDest>');
    expect(fora.xml).toContain('<idDest>2</idDest>');
    // E o CFOP acompanha o destino.
    expect(interna.xml).toContain('<CFOP>5102</CFOP>');
    expect(fora.xml).toContain('<CFOP>6102</CFOP>');
  });
});

describe('presença do comprador', () => {
  /** É o que permite a mesma NF-e servir ao balcão e ao e-commerce. */
  it('presencial e internet produzem indPres diferentes', () => {
    const balcao = buildNfeXml({ sale: venda(), config, recipient: DEST_PJ, serie: 1, number: 1 });
    const site = buildNfeXml({
      sale: venda(),
      config,
      recipient: DEST_PJ,
      serie: 1,
      number: 2,
      presence: PRESENCE_INTERNET,
    });

    expect(balcao.xml).toContain('<indPres>1</indPres>');
    expect(site.xml).toContain('<indPres>2</indPres>');
  });
});

describe('transporte', () => {
  it('sem frete declarado, modFrete 9 e sem transportadora', () => {
    const { xml } = buildNfeXml({ sale: venda(), config, recipient: DEST_PJ, serie: 1, number: 1 });
    expect(xml).toContain('<modFrete>9</modFrete>');
    expect(xml).not.toContain('<transporta>');
  });

  it('com transportadora, o bloco aparece e o frete entra no total', () => {
    const { xml } = buildNfeXml({
      sale: venda(),
      config,
      recipient: DEST_PJ,
      serie: 1,
      number: 1,
      transport: {
        modFrete: '0',
        carrierName: 'Transportes Norte Ltda',
        carrierDocument: '11.444.777/0001-61',
        freightCents: 5_000,
      },
    });

    expect(xml).toContain('<modFrete>0</modFrete>');
    expect(xml).toContain('Transportes Norte Ltda');
    expect(xml).toContain('<vFrete>50.00</vFrete>');
    // O frete soma ao total da nota.
    expect(xml).toContain('<vNF>250.00</vNF>');
  });
});

describe('itens e totais', () => {
  it('produto da PJ Motors sai com NCM, CFOP e origem do cadastro', () => {
    const { xml } = buildNfeXml({ sale: venda(), config, recipient: DEST_PJ, serie: 1, number: 1 });
    expect(xml).toContain('<NCM>87116000</NCM>');
    expect(xml).toContain('<CFOP>5102</CFOP>');
    expect(xml).toContain('<orig>0</orig>');
    expect(xml).toContain('Patinete Elétrico Urban 350W');
  });

  it('desconto aparece no item e no total', () => {
    const v = venda();
    v.items[0].discountCents = 2_000;
    v.items[0].totalCents = 18_000;
    v.totalCents = 18_000;
    v.payments = [{ method: 'pix', amountCents: 18_000 }];

    const { xml } = buildNfeXml({ sale: v, config, recipient: DEST_PJ, serie: 1, number: 1 });
    expect(xml).toContain('<vDesc>20.00</vDesc>');
    expect(xml).toContain('<vNF>180.00</vNF>');
  });

  it('item sem NCM bloqueia, apontando o item', () => {
    const v = venda();
    v.items[0].ncm = null;
    const problemas = validateNfe({ sale: v, config, recipient: DEST_PJ });
    const falha = problemas.find((p) => p.field.includes('NCM'))!;
    expect(falha).toBeTruthy();
    expect(falha.itemIndex).toBe(0);
  });

  it('total divergente da soma dos itens bloqueia', () => {
    const problemas = validateNfe({
      sale: venda({ totalCents: 19_999 }),
      config,
      recipient: DEST_PJ,
    });
    expect(problemas.some((p) => p.field === 'total.vNF')).toBe(true);
  });

  it('operação sem itens bloqueia', () => {
    const problemas = validateNfe({
      sale: venda({ items: [], totalCents: 0 }),
      config,
      recipient: DEST_PJ,
    });
    expect(problemas.some((p) => p.field === 'det')).toBe(true);
  });
});

describe('emitente', () => {
  it('cada operação emite com o próprio CNPJ — sem fallback', () => {
    const semCnpj = { ...config, cnpj: null };
    expect(
      validateNfe({ sale: venda(), config: semCnpj, recipient: DEST_PJ }).some(
        (p) => p.field === 'emit.CNPJ',
      ),
    ).toBe(true);
  });
});

describe('informações adicionais', () => {
  it('entram quando informadas, e ficam escapadas', () => {
    const { xml } = buildNfeXml({
      sale: venda(),
      config,
      recipient: DEST_PJ,
      serie: 1,
      number: 1,
      additionalInfo: 'Pedido #12 & entrega <urgente>',
    });
    expect(xml).toContain('Pedido #12 &amp; entrega &lt;urgente&gt;');
    expect(validateAgainstSchema(xml).wellFormed).toBe(true);
  });
});
