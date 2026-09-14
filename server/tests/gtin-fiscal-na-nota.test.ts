/**
 * O GTIN QUE A NOTA DECLARA (auditoria do produto, A-produto-05).
 *
 * ============================================================================
 * O QUE ESTAVA ACONTECENDO
 * ============================================================================
 *
 * A NFC-e e a NF-e montavam o <cEAN> assim:
 *
 *     digits(barcode).length >= 8 ? digits(barcode) : 'SEM GTIN'
 *
 * O botão "Gerar código de barras" do cadastro cria o EAN INTERNO da loja:
 * prefixo 2, a faixa GS1 de circulação RESTRITA (código de balança, código da
 * própria loja). Ele não é GTIN registrado — o leiaute pede "SEM GTIN" —, e a
 * SEFAZ confere o GTIN (NT 2017.001). Toda nota com esse item seria rejeitada.
 * E `digits()` arrancava as letras: o código interno "PJ12345678" virava o
 * cEAN 12345678, e 9 a 11 dígitos, ou verificador errado, também passavam.
 *
 * ============================================================================
 * O QUE ESTE TESTE NÃO DEIXA VOLTAR
 * ============================================================================
 *
 *   - o EAN interno (prefixo 2) indo para <cEAN>/<cEANTrib> na NFC-e e na NF-e;
 *   - código com letra, com comprimento que não é de GTIN, ou com verificador
 *     errado indo para a nota;
 *   - o GTIN do fabricante, válido, deixando de ir.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDbForTests } from '../src/db/database.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import { updateFiscalConfig, type FiscalConfig } from '../src/services/core/FiscalConfigService.js';
import { buildNfceXml, gtinFiscal, type NfceSale } from '../src/services/core/FiscalXmlNfce.js';
import { buildNfeXml, type NfeRecipient } from '../src/services/core/FiscalXmlNfe.js';
import { digitoVerificadorGtin } from '../src/services/core/Gtin.js';
import { grupoTributarioPadrao } from './helpers/grupoTributario.js';

/** O código com o verificador certo — a faixa é o que se testa, não a conta. */
function comDv(semVerificador: string): string {
  return `${semVerificador}${digitoVerificadorGtin(semVerificador)}`;
}

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
  zip: '96010100',
};

function venda(barcode: string | null): NfceSale {
  return {
    id: 'sale-gtin',
    number: 1,
    companyId,
    createdAt: '2026-09-14T12:00:00.000Z',
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
        barcode,
        internalCode: 'PJ-0001',
        taxProfile: null,
      },
    ],
    payments: [{ method: 'dinheiro', amountCents: 10_000 }],
  };
}

beforeEach(() => {
  resetDbForTests();
  companyId = upsertCompany({ slug: 'preco-justo', legalName: 'Preço Justo Ltda', tradeName: 'Preço Justo' });
  config = updateFiscalConfig({
    companyId,
    patch: {
      legalName: 'Preço Justo Comércio Ltda',
      tradeName: 'Preço Justo',
      cnpj: '11.222.333/0001-81',
      ie: '123456789',
      crt: '1',
      zip: '96010000',
      street: 'Av. Central',
      number: '100',
      district: 'Centro',
      cityName: 'Pelotas',
      cityIbge: '4314407',
      uf: 'RS',
    },
  });
  grupoTributarioPadrao(companyId);
});

describe('gtinFiscal — a régua', () => {
  it('o EAN interno que o botão "Gerar código de barras" cria (prefixo 2) é SEM GTIN', () => {
    // 2 + sequência + DV: o formato do BarcodeService. O verificador está CERTO;
    // o que o tira da nota é a faixa, de circulação restrita à loja.
    expect(gtinFiscal('2000000000015')).toBe('SEM GTIN');
    expect(gtinFiscal(comDv('200000001234'))).toBe('SEM GTIN');
  });

  it('o GTIN do fabricante, com o verificador certo, vai como veio', () => {
    expect(gtinFiscal('7891000100103')).toBe('7891000100103');
    expect(gtinFiscal('7891234567895')).toBe('7891234567895');
    // GTIN-8, UPC-A (GTIN-12) e GTIN-14 também são GTIN.
    expect(gtinFiscal(comDv('9638507'))).toBe(comDv('9638507'));
    expect(gtinFiscal(comDv('03600029145'))).toBe(comDv('03600029145'));
    expect(gtinFiscal(comDv('1789100010010'))).toBe(comDv('1789100010010'));
    // Espaço em volta (leitor que manda o Enter junto) não tira o GTIN da nota.
    expect(gtinFiscal(' 7891000100103 ')).toBe('7891000100103');
  });

  it('verificador errado é SEM GTIN — a SEFAZ confere a conta', () => {
    expect(gtinFiscal('7891000100104')).toBe('SEM GTIN');
  });

  it('código com letra não vira o GTIN de ninguém (digits() arrancava as letras)', () => {
    // Antes: "PJ12345678" saía como cEAN 12345678.
    expect(gtinFiscal('PJ12345678')).toBe('SEM GTIN');
    // Comprimento que não é de GTIN (9 a 11 dígitos) também passava.
    expect(gtinFiscal('123456789')).toBe('SEM GTIN');
    expect(gtinFiscal('12345678901')).toBe('SEM GTIN');
    expect(gtinFiscal(null)).toBe('SEM GTIN');
    expect(gtinFiscal('')).toBe('SEM GTIN');
  });

  it('as faixas restritas em cada comprimento', () => {
    // UPC-A: número 2 (peso variável) e 4 (uso interno).
    expect(gtinFiscal(comDv('21234567890'))).toBe('SEM GTIN');
    expect(gtinFiscal(comDv('41234567890'))).toBe('SEM GTIN');
    // GTIN-8: prefixos 0 e 2 são RCN-8.
    expect(gtinFiscal(comDv('0123456'))).toBe('SEM GTIN');
    expect(gtinFiscal(comDv('2123456'))).toBe('SEM GTIN');
    // GTIN-14 cujo miolo começa com 2.
    expect(gtinFiscal(comDv('1200000000001'))).toBe('SEM GTIN');
    // Cupom (99x) não é produto.
    expect(gtinFiscal(comDv('990000000001'))).toBe('SEM GTIN');
    // Tudo zero não é GTIN de nada.
    expect(gtinFiscal('0000000000000')).toBe('SEM GTIN');
  });
});

describe('a nota', () => {
  it('NFC-e: o item com o EAN interno sai SEM GTIN em <cEAN> e em <cEANTrib>', () => {
    const { xml } = buildNfceXml({ sale: venda('2000000000015'), config, serie: 1, number: 1 });
    expect(xml).toContain('<cEAN>SEM GTIN</cEAN>');
    expect(xml).toContain('<cEANTrib>SEM GTIN</cEANTrib>');
    expect(xml).not.toContain('2000000000015');
  });

  it('NFC-e: o código alfanumérico não vira cEAN', () => {
    const { xml } = buildNfceXml({ sale: venda('PJ12345678'), config, serie: 1, number: 1 });
    expect(xml).toContain('<cEAN>SEM GTIN</cEAN>');
    expect(xml).not.toContain('<cEAN>12345678</cEAN>');
  });

  it('NFC-e: o GTIN válido do fabricante continua indo', () => {
    const { xml } = buildNfceXml({ sale: venda('7891000100103'), config, serie: 1, number: 1 });
    expect(xml).toContain('<cEAN>7891000100103</cEAN>');
    expect(xml).toContain('<cEANTrib>7891000100103</cEANTrib>');
  });

  it('NF-e: a mesma régua — EAN interno e verificador errado saem SEM GTIN', () => {
    const interno = buildNfeXml({ sale: venda('2000000000015'), config, recipient: DEST_PJ, serie: 1, number: 1 });
    expect(interno.xml).toContain('<cEAN>SEM GTIN</cEAN>');
    expect(interno.xml).toContain('<cEANTrib>SEM GTIN</cEANTrib>');

    const errado = buildNfeXml({ sale: venda('7891000100104'), config, recipient: DEST_PJ, serie: 1, number: 2 });
    expect(errado.xml).toContain('<cEAN>SEM GTIN</cEAN>');

    const valido = buildNfeXml({ sale: venda('7891000100103'), config, recipient: DEST_PJ, serie: 1, number: 3 });
    expect(valido.xml).toContain('<cEAN>7891000100103</cEAN>');
  });
});
