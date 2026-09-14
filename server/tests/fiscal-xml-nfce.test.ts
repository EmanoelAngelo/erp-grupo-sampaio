/**
 * XML da NFC-e (modelo 65).
 *
 * O que estes testes protegem: que a nota REFLITA a venda. Divergência de um
 * centavo entre o cupom e o que o cliente pagou vira rejeição na SEFAZ com a
 * venda já feita — ou, pior, nota autorizada com valor errado.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import { updateFiscalConfig, type FiscalConfig } from '../src/services/core/FiscalConfigService.js';
import {
  buildNfceXml,
  loadSaleForNfce,
  validateAgainstSchema,
  validateNfce,
  xmlEscape,
  type NfceSale,
} from '../src/services/core/FiscalXmlNfce.js';
import { isValidAccessKey } from '../src/services/core/FiscalKeyService.js';
import { grupoTributarioPadrao } from './helpers/grupoTributario.js';

let companyId: string;
let config: FiscalConfig;

const CONFIG_COMPLETA = {
  legalName: 'Preço Justo Comércio Ltda',
  tradeName: 'Preço Justo',
  cnpj: '11.222.333/0001-81',
  ie: '123456789',
  crt: '1',
  zip: '68900-000',
  street: 'Av. Central',
  number: '100',
  district: 'Centro',
  cityName: 'Pelotas',
  cityIbge: '4314407',
  uf: 'RS',
};

/** Venda em memória, para exercitar o gerador sem depender do PDV. */
function vendaBase(over: Partial<NfceSale> = {}): NfceSale {
  return {
    id: 'sale-1',
    number: 1,
    companyId,
    createdAt: '2026-08-13T12:00:00.000Z',
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
        surchargeCents: 0,
        totalCents: 10_000,
        ncm: '62052000',
        cest: null,
        cfop: '5102',
        origin: '0',
        unit: 'UN',
        barcode: '7891234567895',
        internalCode: 'GS-0001',
      },
    ],
    payments: [{ method: 'dinheiro', amountCents: 10_000 }],
    ...over,
  };
}

beforeEach(() => {
  resetDbForTests();
  companyId = upsertCompany({
    slug: 'preco-justo',
    legalName: 'Preço Justo Ltda',
    tradeName: 'Preço Justo',
  });
  config = updateFiscalConfig({ companyId, patch: CONFIG_COMPLETA });
  grupoTributarioPadrao(companyId);
});

describe('estrutura do XML', () => {
  it('monta o documento com a chave no Id do infNFe', () => {
    const { xml, accessKey } = buildNfceXml({ sale: vendaBase(), config, serie: 1, number: 1 });

    expect(isValidAccessKey(accessKey)).toBe(true);
    // A assinatura referencia o documento por este Id — chave errada aqui
    // torna a assinatura inválida.
    expect(xml).toContain(`Id="NFe${accessKey}"`);
    expect(xml).toContain('<mod>65</mod>');
    expect(xml).toContain('versao="4.00"');
    expect(validateAgainstSchema(xml).wellFormed).toBe(true);
  });

  it('emite em HOMOLOGAÇÃO por padrão (tpAmb 2)', () => {
    const { xml } = buildNfceXml({ sale: vendaBase(), config, serie: 1, number: 1 });
    expect(xml).toContain('<tpAmb>2</tpAmb>');
  });

  it('o cDV do ide bate com o último dígito da chave', () => {
    const { xml, accessKey } = buildNfceXml({ sale: vendaBase(), config, serie: 3, number: 77 });
    expect(xml).toContain(`<cDV>${accessKey.slice(-1)}</cDV>`);
    expect(xml).toContain('<serie>3</serie>');
    expect(xml).toContain('<nNF>77</nNF>');
  });

  it('produto sem código de barras vira SEM GTIN, não campo vazio', () => {
    const venda = vendaBase();
    venda.items[0].barcode = null;
    const { xml } = buildNfceXml({ sale: venda, config, serie: 1, number: 1 });
    expect(xml).toContain('<cEAN>SEM GTIN</cEAN>');
    expect(xml).toContain('<cEANTrib>SEM GTIN</cEANTrib>');
    expect(xml).not.toContain('<cEAN></cEAN>');
  });

  it('escapa caracteres que quebrariam o XML', () => {
    expect(xmlEscape('Bermuda & Cia <G> "P"')).toBe(
      'Bermuda &amp; Cia &lt;G&gt; &quot;P&quot;',
    );
    const venda = vendaBase();
    venda.items[0].description = 'Camisa "P" & Cia <slim>';
    const { xml } = buildNfceXml({ sale: venda, config, serie: 1, number: 1 });
    expect(xml).toContain('Camisa &quot;P&quot; &amp; Cia &lt;slim&gt;');
    expect(validateAgainstSchema(xml).wellFormed).toBe(true);
  });

  it('CEST entra só quando o produto tem', () => {
    const semCest = buildNfceXml({ sale: vendaBase(), config, serie: 1, number: 1 });
    expect(semCest.xml).not.toContain('<CEST>');

    const venda = vendaBase();
    venda.items[0].cest = '2810400';
    const comCest = buildNfceXml({ sale: venda, config, serie: 1, number: 2 });
    expect(comCest.xml).toContain('<CEST>2810400</CEST>');
  });
});

describe('valores e totais', () => {
  it('quantidade com 4 casas e valores com 2, como o layout exige', () => {
    const venda = vendaBase();
    venda.items[0].quantity = 1.5;
    venda.items[0].unitPriceCents = 3_333;
    venda.items[0].totalCents = 5_000;
    venda.totalCents = 5_000;
    venda.subtotalCents = 5_000;
    venda.payments = [{ method: 'pix', amountCents: 5_000 }];

    const { xml } = buildNfceXml({ sale: venda, config, serie: 1, number: 1 });
    expect(xml).toContain('<qCom>1.5000</qCom>');
    expect(xml).toContain('<vUnCom>33.33</vUnCom>');
    expect(xml).toContain('<vNF>50.00</vNF>');
  });

  it('desconto aparece no item e no total', () => {
    const venda = vendaBase();
    venda.items[0].discountCents = 1_000;
    venda.items[0].totalCents = 9_000;
    venda.totalCents = 9_000;
    venda.payments = [{ method: 'dinheiro', amountCents: 9_000 }];

    const { xml } = buildNfceXml({ sale: venda, config, serie: 1, number: 1 });
    expect(xml).toContain('<vDesc>10.00</vDesc>');
    // vProd é o bruto: total + desconto.
    expect(xml).toContain('<vProd>100.00</vProd>');
    expect(xml).toContain('<vNF>90.00</vNF>');
  });

  /**
   * O troco vem da venda oficial. Se o cliente deu R$ 100 numa compra de R$ 90,
   * o pagamento é 100 e o troco é 10 — a nota continua sendo de 90.
   */
  it('troco reflete a venda e não altera o total da nota', () => {
    const venda = vendaBase({
      totalCents: 9_000,
      changeCents: 1_000,
      payments: [{ method: 'dinheiro', amountCents: 10_000 }],
    });
    venda.items[0].totalCents = 9_000;
    venda.items[0].unitPriceCents = 4_500;

    const { xml } = buildNfceXml({ sale: venda, config, serie: 1, number: 1 });
    expect(xml).toContain('<vPag>100.00</vPag>');
    expect(xml).toContain('<vTroco>10.00</vTroco>');
    expect(xml).toContain('<vNF>90.00</vNF>');
  });

  it('sem troco, a tag não aparece', () => {
    const { xml } = buildNfceXml({ sale: vendaBase(), config, serie: 1, number: 1 });
    expect(xml).not.toContain('<vTroco>');
  });

  it('vários pagamentos viram vários detPag', () => {
    const venda = vendaBase({
      payments: [
        { method: 'dinheiro', amountCents: 4_000 },
        { method: 'pix', amountCents: 6_000 },
      ],
    });
    const { xml } = buildNfceXml({ sale: venda, config, serie: 1, number: 1 });
    expect((xml.match(/<detPag>/g) ?? []).length).toBe(2);
    expect(xml).toContain('<tPag>01</tPag>');
    expect(xml).toContain('<tPag>17</tPag>');
  });

  it('forma de pagamento desconhecida vira 99, sem travar a venda', () => {
    const venda = vendaBase({ payments: [{ method: 'cripto_moeda', amountCents: 10_000 }] });
    const { xml } = buildNfceXml({ sale: venda, config, serie: 1, number: 1 });
    expect(xml).toContain('<tPag>99</tPag>');
  });
});

describe('validação bloqueia antes de montar', () => {
  it('item sem NCM impede a emissão e diz qual item', () => {
    const venda = vendaBase();
    venda.items[0].ncm = null;

    const problemas = validateNfce(venda, config);
    expect(problemas.some((p) => p.field.includes('NCM'))).toBe(true);
    expect(problemas.find((p) => p.field.includes('NCM'))!.itemIndex).toBe(0);

    expect(() => buildNfceXml({ sale: venda, config, serie: 1, number: 1 })).toThrow(/NCM/);
  });

  it('item sem CFOP e sem origem também bloqueia', () => {
    const venda = vendaBase();
    venda.items[0].cfop = null;
    venda.items[0].origin = null;
    const problemas = validateNfce(venda, config);
    expect(problemas.some((p) => p.field.includes('CFOP'))).toBe(true);
    expect(problemas.some((p) => p.field.includes('origem'))).toBe(true);
  });

  it('origem fora da faixa 0-8 é recusada', () => {
    const venda = vendaBase();
    venda.items[0].origin = '9';
    expect(validateNfce(venda, config).some((p) => p.field.includes('origem'))).toBe(true);
  });

  it('soma dos itens diferente do total bloqueia', () => {
    const venda = vendaBase({ totalCents: 9_999 });
    const problemas = validateNfce(venda, config);
    expect(problemas.some((p) => p.field === 'total.vNF')).toBe(true);
  });

  it('pagamento que não fecha com o total bloqueia', () => {
    const venda = vendaBase({ payments: [{ method: 'dinheiro', amountCents: 5_000 }] });
    expect(validateNfce(venda, config).some((p) => p.field === 'pag')).toBe(true);
  });

  it('emitente incompleto bloqueia, apontando o campo', () => {
    const semCnpj = { ...config, cnpj: null };
    const problemas = validateNfce(vendaBase(), semCnpj);
    expect(problemas.some((p) => p.field === 'emit.CNPJ')).toBe(true);
  });

  it('UF desconhecida bloqueia — sem ela não há como montar a chave', () => {
    const semUf = { ...config, uf: 'ZZ' };
    expect(validateNfce(vendaBase(), semUf).some((p) => p.field === 'emit.UF')).toBe(true);
  });

  it('venda sem itens bloqueia', () => {
    expect(
      validateNfce(vendaBase({ items: [], totalCents: 0 }), config).some((p) => p.field === 'det'),
    ).toBe(true);
  });
});

describe('consumidor', () => {
  it('sem CPF, não inventa destinatário', () => {
    const { xml } = buildNfceXml({ sale: vendaBase(), config, serie: 1, number: 1 });
    expect(xml).not.toContain('<dest>');
  });

  it('com CPF, identifica o consumidor', () => {
    const venda = vendaBase({
      customerId: 'c1',
      customerDocument: '123.456.789-09',
      customerName: 'Maria',
    });
    const { xml } = buildNfceXml({ sale: venda, config, serie: 1, number: 1 });
    expect(xml).toContain('<CPF>12345678909</CPF>');
    expect(xml).toContain('<xNome>Maria</xNome>');
  });
});

describe('XSD — honestidade sobre o que foi validado', () => {
  /**
   * "XML bem formado" e "XML válido conforme o layout" são coisas diferentes.
   * Desde o GAP-PRD-097 os XSDs oficiais estão no projeto: `validated` só é
   * `true` porque o XSD real foi aplicado — e o pacote que aprovou é dito.
   * (O caso "pacote ausente → validated false" está em
   * fiscal-leiaute-sem-pacote.test.ts.)
   */
  it('reporta validado porque o XSD real foi aplicado, e diz qual pacote', () => {
    const { xml } = buildNfceXml({ sale: vendaBase(), config, serie: 1, number: 1 });
    const r = validateAgainstSchema(xml);
    expect(r.wellFormed).toBe(true);
    expect(r.validated).toBe(true);
    expect(r.schemaPackage).toBe('PL_010b_V1.30');
    expect(r.problems).toEqual([]);
  });

  it('detecta XML mal formado', () => {
    const r = validateAgainstSchema('<a><b></a>');
    expect(r.wellFormed).toBe(false);
    expect(r.problems.length).toBeGreaterThan(0);
  });
});

describe('leitura da venda oficial', () => {
  it('recusa venda que não está concluída — e não cria venda nenhuma', () => {
    ensureCoreSchema();
    const db = getConnection();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO core_sales (id, company_id, number, status, subtotal_cents, discount_cents,
                               surcharge_cents, total_cents, origin, idempotency_key, created_at)
       VALUES ('s-cancel', ?, 1, 'cancelled', 1000, 0, 0, 1000, 'pdv', 'k-cancel', ?)`,
    ).run(companyId, now);

    expect(() => loadSaleForNfce(companyId, 's-cancel')).toThrow(/concluída/i);

    const total = db.prepare('SELECT COUNT(*) AS c FROM core_sales').get() as { c: number };
    expect(Number(total.c)).toBe(1);
  });

  it('venda de outra operação não é encontrada', () => {
    const outra = upsertCompany({ slug: 'gringa', legalName: 'Gringa', tradeName: 'Gringa' });
    expect(() => loadSaleForNfce(outra, 'sale-inexistente')).toThrow(/não encontrada/i);
  });
});
