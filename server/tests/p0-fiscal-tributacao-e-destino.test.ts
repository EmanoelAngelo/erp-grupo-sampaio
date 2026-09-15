/**
 * P0 FISCAL — A TRIBUTAÇÃO DO PREÇO JUSTO E O DESTINO DA NOTA (homologação SIMULADA).
 *
 * O que o contador informou (Simples, CRT 1, CSOSN 101, CFOP 5102 dentro do RS
 * e 6102 para fora, PIS/COFINS no CST 49) mora no GRUPO TRIBUTÁRIO DA EMPRESA
 * — nunca numa regra global. O que ele NÃO informou (o percentual do pCredSN,
 * entre outros) não é inventado: o percentual daqui é de TESTE e está escrito
 * como tal, e o grupo sem ele é recusado antes de numerar.
 *
 * Os defeitos presos aqui:
 *  - o CFOP do produto vencia o destino: 5102 no produto fazia a NF-e para
 *    outra UF sair com 5102 e idDest 2 (rejeição); o XML escrevia o CFOP do
 *    item e não o que a tributação resolveu;
 *  - a NFC-e aceitava CFOP de outro alcance;
 *  - o indFinal era deduzido só do indicador de IE (o contribuinte que compra
 *    para uso próprio saía como revenda);
 *  - "ISENTO" com indicador 1 passava e o XML saía com <IE></IE>.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import { getFiscalConfig, updateFiscalConfig } from '../src/services/core/FiscalConfigService.js';
import { setSeriesNextNumber } from '../src/services/core/FiscalKeyService.js';
import { createNfceForSale, createNfeForSale } from '../src/services/core/FiscalDocumentService.js';
import { buildNfceXml, loadSaleForNfce } from '../src/services/core/FiscalXmlNfce.js';
import {
  indicadorDeConsumidorFinal,
  validateRecipient,
  type NfeRecipient,
} from '../src/services/core/FiscalXmlNfe.js';
import { completarPeloGrupo, digitoDoCfopEsperado } from '../src/services/core/TributacaoDoItem.js';
import { upsertTaxGroup } from '../src/services/core/CatalogAuxService.js';
import { grupoTributarioPadrao } from './helpers/grupoTributario.js';

/** Percentual de crédito do Simples de TESTE — o real é pendência do contador. */
const P_CRED_SN_DE_TESTE = '1.25';

let empresa: string;
let n = 0;

function configurar(companyId: string): void {
  updateFiscalConfig({
    companyId,
    patch: {
      legalName: 'Preço Justo Comércio Ltda',
      cnpj: '11.222.333/0001-81',
      ie: '0960123456',
      crt: '1',
      street: 'Rua XV de Novembro',
      number: '100',
      district: 'Centro',
      cityName: 'Pelotas',
      cityIbge: '4314407',
      zip: '96015000',
      uf: 'RS',
    },
  });
  grupoTributarioPadrao(companyId);
  setSeriesNextNumber({ companyId, model: '55', serie: 1, nextNumber: 1 });
  setSeriesNextNumber({ companyId, model: '65', serie: 1, nextNumber: 1 });
}

function grupo101(companyId: string, pCredSn: string | null = P_CRED_SN_DE_TESTE, code = 'SIMPLES-101'): void {
  upsertTaxGroup(companyId, {
    code,
    name: 'Simples — CSOSN 101',
    regime: 'simples',
    csosn: '101',
    pCredSn,
    cstPis: '49',
    cstCofins: '49',
    cfopInternal: '5102',
    cfopExternal: '6102',
  });
}

/** Venda concluída de R$ 100,00 (2 × R$ 50,00), paga em dinheiro. */
function venda(opcoes: { companyId?: string; cfop?: string | null; perfil?: string } = {}): string {
  ensureCoreSchema();
  n += 1;
  const companyId = opcoes.companyId ?? empresa;
  const id = `venda-${n}`;
  const db = getConnection();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents, price_cents,
                                ncm, cfop, origin, tax_profile, active, created_at, updated_at)
     VALUES (?, ?, ?, 'Camisa', 'UN', 1000, 5000, '62052000', ?, '0', ?, 1, ?, ?)`,
  ).run(`p-${id}`, companyId, `PJ-${n}`, opcoes.cfop === undefined ? '5102' : opcoes.cfop, opcoes.perfil ?? 'SIMPLES-102', now, now);
  db.prepare(
    `INSERT INTO core_sales (id, company_id, number, status, subtotal_cents, discount_cents,
                             surcharge_cents, total_cents, origin, idempotency_key, change_cents, created_at)
     VALUES (?, ?, ?, 'completed', 10000, 0, 0, 10000, 'pdv', ?, 0, ?)`,
  ).run(id, companyId, n, `k-${id}`, now);
  db.prepare(
    `INSERT INTO core_sale_items (id, sale_id, company_id, product_id, description, quantity,
                                  unit_price_cents, discount_cents, total_cents)
     VALUES (?, ?, ?, ?, 'Camisa', 2, 5000, 0, 10000)`,
  ).run(`i-${id}`, id, companyId, `p-${id}`);
  db.prepare(
    `INSERT INTO core_sale_payments (id, sale_id, company_id, method, amount_cents, status, created_at)
     VALUES (?, ?, ?, 'dinheiro', 10000, 'settled', ?)`,
  ).run(`pay-${id}`, id, companyId, now);
  return id;
}

function xmlDe(documentId: string): string {
  return String(
    (getConnection().prepare('SELECT xml_original FROM core_fiscal_documents WHERE id = ?').get(documentId) as {
      xml_original: string;
    }).xml_original,
  );
}

function proximoNumero(model: '55' | '65', companyId = empresa): number {
  return Number(
    (getConnection()
      .prepare('SELECT next_number FROM core_fiscal_series WHERE company_id = ? AND model = ? AND serie = 1')
      .get(companyId, model) as { next_number: number }).next_number,
  );
}

function blocoDest(xml: string): string {
  return /<dest>[\s\S]*?<\/dest>/.exec(xml)?.[0] ?? '';
}

const CONTRIBUINTE_RS: NfeRecipient = {
  document: '11.444.777/0001-61',
  name: 'Oficina Parceira Ltda',
  ieIndicator: '1',
  // O CGC/TE como aparece no cartão: com barra. Na nota, só dígitos.
  ie: '096/0123456',
  street: 'Rua do Comércio',
  number: '500',
  district: 'Fragata',
  cityName: 'Pelotas',
  cityIbge: '4314407',
  uf: 'RS',
  zip: '96040000',
};

const CONSUMIDOR_SC: NfeRecipient = {
  document: '123.456.789-09',
  name: 'Maria Consumidora',
  ieIndicator: '9',
  street: 'Rua das Flores',
  number: '10',
  district: 'Centro',
  cityName: 'Florianópolis',
  cityIbge: '4205407',
  uf: 'SC',
  zip: '88010000',
};

beforeEach(() => {
  resetDbForTests();
  n = 0;
  empresa = upsertCompany({ slug: 'preco-justo', legalName: 'Preço Justo Ltda', tradeName: 'Preço Justo' });
  configurar(empresa);
});

describe('o que o contador do Preço Justo informou — no grupo da empresa', () => {
  it('CSOSN 101 sai com pCredSN e vCredICMSSN do grupo (percentual de TESTE)', () => {
    grupo101(empresa);
    const { document } = createNfceForSale({ companyId: empresa, saleId: venda({ perfil: 'SIMPLES-101' }) });
    const xml = xmlDe(document.id);
    expect(xml).toMatch(
      /<ICMSSN101>\s*<orig>0<\/orig>\s*<CSOSN>101<\/CSOSN>\s*<pCredSN>1\.25<\/pCredSN>\s*<vCredICMSSN>1\.25<\/vCredICMSSN>\s*<\/ICMSSN101>/,
    );
    expect(xml).toContain('<CRT>1</CRT>');
  });

  it('CSOSN 101 SEM o pCredSN é recusado ANTES de numerar — o percentual não é inventado', () => {
    grupo101(empresa, null);
    expect(() => createNfceForSale({ companyId: empresa, saleId: venda({ perfil: 'SIMPLES-101' }) })).toThrow(
      /pCredSN/,
    );
    expect(proximoNumero('65')).toBe(1);
  });

  it('PIS e COFINS no CST 49 saem em PISOutr/COFINSOutr com base, alíquota e valor zerados', () => {
    grupo101(empresa);
    const { document } = createNfceForSale({ companyId: empresa, saleId: venda({ perfil: 'SIMPLES-101' }) });
    const xml = xmlDe(document.id);
    expect(xml).toMatch(
      /<PISOutr>\s*<CST>49<\/CST>\s*<vBC>0\.00<\/vBC>\s*<pPIS>0\.00<\/pPIS>\s*<vPIS>0\.00<\/vPIS>\s*<\/PISOutr>/,
    );
    expect(xml).toMatch(
      /<COFINSOutr>\s*<CST>49<\/CST>\s*<vBC>0\.00<\/vBC>\s*<pCOFINS>0\.00<\/pCOFINS>\s*<vCOFINS>0\.00<\/vCOFINS>\s*<\/COFINSOutr>/,
    );
  });

  it('a regra é da EMPRESA: o mesmo código de grupo em outra operação tributa como ela decidiu', () => {
    grupo101(empresa);
    const outra = upsertCompany({ slug: 'gringa', legalName: 'Gringa Ltda', tradeName: 'Gringa' });
    configurar(outra);
    // Na outra operação, o grupo de mesmo código é CSOSN 102.
    upsertTaxGroup(outra, {
      code: 'SIMPLES-101',
      name: 'Mesmo código, outra decisão',
      regime: 'simples',
      csosn: '102',
      cstPis: '49',
      cstCofins: '49',
      cfopInternal: '5102',
      cfopExternal: '6102',
    });

    const daPrecoJusto = createNfceForSale({ companyId: empresa, saleId: venda({ perfil: 'SIMPLES-101' }) });
    const daOutra = createNfceForSale({ companyId: outra, saleId: venda({ companyId: outra, perfil: 'SIMPLES-101' }) });

    expect(xmlDe(daPrecoJusto.document.id)).toContain('<CSOSN>101</CSOSN>');
    expect(xmlDe(daOutra.document.id)).toContain('<CSOSN>102</CSOSN>');
    expect(xmlDe(daOutra.document.id)).not.toContain('<pCredSN>');
  });
});

describe('o CFOP acompanha o destino (5102 no RS, 6102 fora)', () => {
  it('o alcance esperado sai da UF do emitente e da do destinatário', () => {
    expect(digitoDoCfopEsperado('RS', null)).toBe('5');
    expect(digitoDoCfopEsperado('RS', 'RS')).toBe('5');
    expect(digitoDoCfopEsperado('RS', 'SC')).toBe('6');
    expect(digitoDoCfopEsperado('RS', 'EX')).toBe('7');
    expect(digitoDoCfopEsperado('RS', 'RS', 'entrada')).toBe('1');
    expect(digitoDoCfopEsperado('RS', 'SC', 'entrada')).toBe('2');
  });

  it('NF-e interna sai com 5102 e idDest 1', () => {
    const { document } = createNfeForSale({ companyId: empresa, saleId: venda(), recipient: CONTRIBUINTE_RS });
    const xml = xmlDe(document.id);
    expect(xml).toContain('<idDest>1</idDest>');
    expect(xml).toContain('<CFOP>5102</CFOP>');
  });

  it('NF-e para outra UF sai com o 6102 do grupo mesmo com o 5102 copiado no produto — idDest 2', () => {
    const { document } = createNfeForSale({ companyId: empresa, saleId: venda({ cfop: '5102' }), recipient: CONSUMIDOR_SC });
    const xml = xmlDe(document.id);
    expect(xml).toContain('<idDest>2</idDest>');
    expect(xml).toContain('<CFOP>6102</CFOP>');
    expect(xml).not.toContain('<CFOP>5102</CFOP>');
  });

  it('exceção do produto (5405) numa nota interestadual é recusada ANTES de numerar, nomeando o CFOP', () => {
    expect(() =>
      createNfeForSale({ companyId: empresa, saleId: venda({ cfop: '5405' }), recipient: CONSUMIDOR_SC }),
    ).toThrow(/5405.*saída interna.*saída interestadual/);
    expect(proximoNumero('55')).toBe(1);
  });

  it('NFC-e nunca é interestadual: idDest 1, indFinal 1 e CFOP 5xxx — mesmo com o 6102 do grupo no produto', () => {
    const { document } = createNfceForSale({ companyId: empresa, saleId: venda({ cfop: '6102' }) });
    const xml = xmlDe(document.id);
    expect(xml).toContain('<mod>65</mod>');
    expect(xml).toContain('<idDest>1</idDest>');
    expect(xml).toContain('<indFinal>1</indFinal>');
    expect(xml).toContain('<CFOP>5102</CFOP>');
  });

  it('NFC-e com CFOP de outro alcance que o grupo não explica é recusada antes de numerar', () => {
    expect(() => createNfceForSale({ companyId: empresa, saleId: venda({ cfop: '6405' }) })).toThrow(
      /NFC-e é sempre operação interna/,
    );
    expect(proximoNumero('65')).toBe(1);
  });

  it('NFC-e com CPF do consumidor: indIEDest 9 e nenhuma IE', () => {
    const saleId = venda();
    const base = completarPeloGrupo(loadSaleForNfce(empresa, saleId), null);
    const { xml } = buildNfceXml({
      sale: { ...base, customerDocument: '123.456.789-09', customerName: 'Maria' },
      config: getFiscalConfig(empresa),
      serie: 1,
      number: 1,
    });
    const dest = blocoDest(xml);
    expect(dest).toContain('<CPF>12345678909</CPF>');
    expect(dest).toContain('<indIEDest>9</indIEDest>');
    expect(dest).not.toContain('<IE>');
  });
});

describe('contribuinte do ICMS × consumidor final', () => {
  it('contribuinte do RS: indIEDest 1, IE só com dígitos (o CGC/TE) e indFinal 0', () => {
    const { document } = createNfeForSale({ companyId: empresa, saleId: venda(), recipient: CONTRIBUINTE_RS });
    const xml = xmlDe(document.id);
    const dest = blocoDest(xml);
    expect(dest).toContain('<indIEDest>1</indIEDest>');
    expect(dest).toContain('<IE>0960123456</IE>');
    expect(xml).toContain('<indFinal>0</indFinal>');
  });

  it('contribuinte comprando para USO PRÓPRIO sai com indFinal 1 quando declarado', () => {
    const { document } = createNfeForSale({
      companyId: empresa,
      saleId: venda(),
      recipient: { ...CONTRIBUINTE_RS, consumidorFinal: true },
    });
    expect(xmlDe(document.id)).toContain('<indFinal>1</indFinal>');
  });

  it('não contribuinte: indIEDest 9, sem IE, indFinal 1', () => {
    const { document } = createNfeForSale({
      companyId: empresa,
      saleId: venda(),
      recipient: { ...CONSUMIDOR_SC, cityName: 'Pelotas', cityIbge: '4314407', uf: 'RS', zip: '96015000' },
    });
    const xml = xmlDe(document.id);
    expect(blocoDest(xml)).toContain('<indIEDest>9</indIEDest>');
    expect(blocoDest(xml)).not.toContain('<IE>');
    expect(xml).toContain('<indFinal>1</indFinal>');
  });

  it('"ISENTO" com indicador 1 é recusado — isento usa o indicador 2', () => {
    const problemas = validateRecipient({ ...CONTRIBUINTE_RS, ie: 'ISENTO' });
    expect(problemas.some((p) => p.field === 'dest.IE' && /ISENTO/.test(p.message))).toBe(true);
    expect(() =>
      createNfeForSale({ companyId: empresa, saleId: venda(), recipient: { ...CONTRIBUINTE_RS, ie: 'ISENTO' } }),
    ).toThrow(/dest\.IE/);
    expect(proximoNumero('55')).toBe(1);
  });

  it('não contribuinte marcado como revenda é recusado', () => {
    const problemas = validateRecipient({ ...CONSUMIDOR_SC, consumidorFinal: false });
    expect(problemas.some((p) => p.field === 'ide.indFinal')).toBe(true);
    expect(indicadorDeConsumidorFinal({ ieIndicator: '9', consumidorFinal: false })).toBe('1');
    expect(indicadorDeConsumidorFinal({ ieIndicator: '1' })).toBe('0');
    expect(indicadorDeConsumidorFinal({ ieIndicator: '2' })).toBe('1');
  });
});
