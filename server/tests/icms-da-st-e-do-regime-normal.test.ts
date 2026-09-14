/**
 * ============================================================================
 * SUBSTITUIÇÃO TRIBUTÁRIA E REGIME NORMAL SAEM NA NOTA (GAP-PRD-021)
 * ============================================================================
 *
 * ## O defeito
 *
 * `impostoXml` só sabia montar os CSOSN 101, 102, 103, 300 e 400. O CSOSN 500
 * — mercadoria cuja ST o fornecedor já recolheu, que é o caso comum do varejo
 * de autopeças e de cosméticos — era recusado com "envolve substituição
 * tributária, que o cadastro ainda não descreve", embora no leiaute 4.00 o
 * grupo `ICMSSN500` só exija origem e CSOSN (os valores retidos são
 * opcionais). E o regime normal (CRT 3) não emitia nada: todo CST de ICMS caía
 * em "ainda não é emitido por este sistema", enquanto o cadastro aceitava CRT 3
 * e o checklist o marcava PASS.
 *
 * Três das seis empresas (PJ Motors, Oficina, Me Mimei) vendem mercadoria de
 * ST; qualquer uma que saia do Simples passa a precisar do ICMS por CST.
 *
 * ## O que este arquivo crava
 *
 *  - CSOSN 500 e 900 saem, e passam no XSD oficial nos dois modelos;
 *  - CST 00, 20, 40, 41, 50, 60 e 90 saem, com base, alíquota e valor quando o
 *    grupo do layout os exige — e o total da nota soma o que os itens declaram;
 *  - a alíquota de ICMS vem do cadastro (kind 'icms', ligada ao grupo pelo
 *    código), e sem ela a recusa nomeia o que falta e onde se cadastra;
 *  - o FCP (fundo de combate à pobreza) sai quando o grupo o declara;
 *  - o que o sistema continua recusando é SÓ a ST calculada pelo próprio
 *    emitente (CSOSN 201/202/203, CST 10/30/70): ela é cobrada POR FORA, soma
 *    ao vNF e o total deixaria de bater com o que o cliente pagou — a mesma
 *    razão do IPI destacado, dita por extenso na recusa;
 *  - CRT só aceita os quatro valores do leiaute, e o MEI (CRT 4) tributa pelo
 *    CSOSN como o Simples;
 *  - o código de benefício fiscal (cBenef) do grupo sai no `<prod>`.
 *
 * ## COMO CADA GUARDA FALHA (quebrando de propósito)
 *
 *  - volte o ramo do CSOSN à lista de cinco e o caso do 500 fica vermelho;
 *  - devolva `<vBC>0.00</vBC>` ao literal do total e o caso da soma fica
 *    vermelho nos dois modelos;
 *  - troque a recusa da ST "por fora" por zeros e o caso do 201 fica vermelho;
 *  - arredonde a base só na formatação e o caso da redução deixa de fechar.
 */
import { beforeEach, describe, expect, it } from 'vitest';

process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_DATABASE_PATH = ':memory:';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

const { resetDbForTests } = await import('../src/db/database.js');
const { ensureCoreSchema } = await import('../src/db/schema.js');
const { upsertCompany } = await import('../src/services/auth/IdentityService.js');
const { updateFiscalConfig, getFiscalConfig } = await import(
  '../src/services/core/FiscalConfigService.js'
);
const { upsertTaxGroup, upsertTaxRate } = await import(
  '../src/services/core/CatalogAuxService.js'
);
const { upsertNfceCsc } = await import('../src/services/nfce/NfceCscService.js');
const { impostoXml, tributacaoDoItem } = await import(
  '../src/services/core/TributacaoDoItem.js'
);
const { buildNfceXml, validateAgainstSchema } = await import(
  '../src/services/core/FiscalXmlNfce.js'
);
const { buildNfeXml } = await import('../src/services/core/FiscalXmlNfe.js');

let loja: string;

/** Uma peça de R$ 100,00 — base redonda, para a conta caber na cabeça. */
const PECA = {
  id: 'p1',
  description: 'Pastilha de freio',
  taxProfile: 'PADRAO' as string | null,
  origin: '0',
  cfop: '5405' as string | null,
  ncm: '87083090',
  cest: '0107500' as string | null,
  totalCents: 10_000,
};

function configurar(crt: string) {
  updateFiscalConfig({
    companyId: loja,
    patch: {
      legalName: 'PJ Motors Ltda',
      cnpj: '11.222.333/0001-81',
      ie: '0960012345',
      crt,
      street: 'Av. Central',
      number: '100',
      district: 'Centro',
      cityName: 'Pelotas',
      cityIbge: '4314407',
      zip: '96010-000',
      uf: 'RS',
    },
  });
}

beforeEach(() => {
  resetDbForTests();
  ensureCoreSchema();
  loja = upsertCompany({ slug: 'pj-motors', legalName: 'PJ Motors Ltda', tradeName: 'PJ Motors' });
  configurar('1');
  upsertNfceCsc({
    companyId: loja,
    operationalUnitId: 'unit-default',
    cscId: '000001',
    cscToken: 'CSC-DE-TESTE-NAO-E-O-REAL',
  });
});

function grupo(extras: Record<string, unknown>) {
  return upsertTaxGroup(loja, {
    code: 'PADRAO',
    name: 'Padrão da loja',
    regime: 'simples',
    cfopInternal: '5405',
    cfopExternal: '6404',
    cstPis: '49',
    cstCofins: '49',
    ...extras,
  });
}

function aliquotaIcms(code = 'ICMS17', percent = 17) {
  upsertTaxRate(loja, { code, name: `ICMS ${percent}%`, kind: 'icms', percent });
}

function erroDe(fn: () => unknown): { code: string; message: string } {
  try {
    fn();
  } catch (err) {
    const e = err as { code: string; message: string };
    return { code: e.code, message: e.message };
  }
  throw new Error('esperava recusa, e passou');
}

/** Os campos do `<ICMSTot>` — o total como a SEFAZ o lê. */
function totalDe(xml: string): Record<string, string> {
  const bloco = /<ICMSTot>([\s\S]*?)<\/ICMSTot>/.exec(xml)?.[1] ?? '';
  const out: Record<string, string> = {};
  for (const m of bloco.matchAll(/<(\w+)>([^<]*)<\/\1>/g)) out[m[1]] = m[2];
  return out;
}

/** O `<ICMS>` do primeiro item, compactado, para comparar sem indentação. */
function icmsDe(xml: string): string {
  return (/<ICMS>([\s\S]*?)<\/ICMS>/.exec(xml)?.[1] ?? '').replace(/\s+/g, '');
}

function venda(over: Record<string, unknown> = {}) {
  return {
    id: 'v1',
    companyId: loja,
    number: 1,
    createdAt: '2026-09-11T12:00:00.000Z',
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
        description: 'Pastilha de freio',
        quantity: 2,
        unitPriceCents: 5_000,
        discountCents: 0,
        totalCents: 10_000,
        ncm: '87083090',
        cest: '0107500',
        cfop: '5405',
        origin: '0',
        unit: 'UN',
        barcode: '7891234567895',
        internalCode: 'GS-0001',
        taxProfile: 'PADRAO',
      },
    ],
    payments: [{ method: 'dinheiro', amountCents: 10_000 }],
    ...over,
  } as never;
}

const DESTINATARIO = {
  document: '11.444.777/0001-61',
  name: 'Oficina Parceira Ltda',
  ieIndicator: '1' as const,
  ie: '987654321',
  street: 'Rua do Comércio',
  number: '500',
  district: 'Industrial',
  cityName: 'Pelotas',
  cityIbge: '4314407',
  uf: 'RS',
  zip: '96010-100',
};

/** Os dois modelos montados da mesma venda, cada um conferido pelo XSD oficial. */
function osDoisModelos(): { nfce: string; nfe: string } {
  const nfce = buildNfceXml({ sale: venda(), config: getFiscalConfig(loja), serie: 1, number: 1 }).xml;
  const nfe = buildNfeXml({
    sale: venda(),
    config: getFiscalConfig(loja),
    recipient: DESTINATARIO as never,
    serie: 1,
    number: 1,
  }).xml;
  for (const xml of [nfce, nfe]) {
    expect(validateAgainstSchema(xml)).toMatchObject({ validated: true, problems: [] });
  }
  return { nfce, nfe };
}

// ============================================================================

describe('Simples com substituição tributária — o varejo de peças e cosméticos', () => {
  it('CSOSN 500 (ST retida antes) sai em ICMSSN500 e passa no XSD, nos dois modelos', () => {
    grupo({ csosn: '500' });
    const { nfce, nfe } = osDoisModelos();

    for (const xml of [nfce, nfe]) {
      expect(icmsDe(xml)).toBe('<ICMSSN500><orig>0</orig><CSOSN>500</CSOSN></ICMSSN500>');
      // ST retida antes não é ICMS desta nota: nada soma no total.
      expect(totalDe(xml)).toMatchObject({ vBC: '0.00', vICMS: '0.00', vST: '0.00', vNF: '100.00' });
    }
  });

  it('CSOSN 900 sai em ICMSSN900, só com origem e CSOSN quando o grupo não declara crédito', () => {
    grupo({ csosn: '900' });
    expect(icmsDe(osDoisModelos().nfce)).toBe(
      '<ICMSSN900><orig>0</orig><CSOSN>900</CSOSN></ICMSSN900>',
    );
  });

  it('CSOSN 900 com pCredSN: pCredSN e vCredICMSSN no fim do grupo', () => {
    const g = grupo({ csosn: '900' });
    grupo({ id: g.id, csosn: '900', pCredSn: '2.50' });
    expect(icmsDe(osDoisModelos().nfce)).toBe(
      '<ICMSSN900><orig>0</orig><CSOSN>900</CSOSN>'
        + '<pCredSN>2.50</pCredSN><vCredICMSSN>2.50</vCredICMSSN></ICMSSN900>',
    );
  });

  it('CSOSN 201, 202 e 203: a ST calculada pelo emitente é cobrada POR FORA — recusa dizendo isso', () => {
    for (const [i, csosn] of ['201', '202', '203'].entries()) {
      resetDbForTests();
      ensureCoreSchema();
      loja = upsertCompany({ slug: `pj-${i}`, legalName: 'PJ Motors Ltda', tradeName: 'PJ' });
      configurar('1');
      grupo({ csosn, pCredSn: '2.50' });
      const erro = erroDe(() =>
        impostoXml(tributacaoDoItem({ companyId: loja, produto: PECA }), PECA),
      );
      expect(erro.code).toBe('CORE_FISCAL_TRIBUTACAO_INCOMPLETA');
      expect(erro.message).toMatch(/por fora/i);
      expect(erro.message).toContain(csosn);
      // A frase antiga mandava "falar com o contador" sobre um cadastro que
      // nenhum contador consegue preencher: não é cadastro, é cobrança.
      expect(erro.message).not.toMatch(/cadastro ainda não descreve/);
    }
  });

  it('CSOSN fora da tabela é recusado no CADASTRO, e não na venda', () => {
    const erro = erroDe(() => grupo({ csosn: '999' }));
    expect(erro.code).toBe('CORE_TAX_GROUP_CSOSN');
    expect(erro.message).toContain('999');
  });
});

// ============================================================================

describe('regime normal (CRT 3) — ICMS por CST', () => {
  beforeEach(() => configurar('3'));

  it('CST 00 com alíquota de 17%: ICMS00 com base, alíquota e valor — e o total soma', () => {
    aliquotaIcms();
    grupo({ regime: 'normal', cstIcms: '00', icmsRateCode: 'ICMS17' });
    const { nfce, nfe } = osDoisModelos();

    for (const xml of [nfce, nfe]) {
      expect(icmsDe(xml)).toBe(
        '<ICMS00><orig>0</orig><CST>00</CST><modBC>3</modBC><vBC>100.00</vBC>'
          + '<pICMS>17.00</pICMS><vICMS>17.00</vICMS></ICMS00>',
      );
      /*
        O ICMS é POR DENTRO: já está no preço. O total declara a base e o
        imposto, e o vNF não se move um centavo — é o que o cliente pagou.
      */
      expect(totalDe(xml)).toMatchObject({ vBC: '100.00', vICMS: '17.00', vNF: '100.00' });
    }
  });

  it('CST 00 sem alíquota de ICMS: a recusa nomeia a alíquota e onde cadastrá-la', () => {
    grupo({ regime: 'normal', cstIcms: '00' });
    const erro = erroDe(() => tributacaoDoItem({ companyId: loja, produto: PECA }));
    expect(erro.code).toBe('CORE_FISCAL_TRIBUTACAO_INCOMPLETA');
    expect(erro.message).toMatch(/alíquota de ICMS/i);
    expect(erro.message).toMatch(/Catálogo › Alíquotas/);
    // E a frase antiga — "ainda não é emitido" — morreu com a emissão feita.
    expect(erro.message).not.toMatch(/ainda não é emitido/);
  });

  it('CST 20 com redução de base: a base cai, e o valor sai da base reduzida', () => {
    aliquotaIcms();
    grupo({ regime: 'normal', cstIcms: '20', icmsRateCode: 'ICMS17', pRedBc: '41.18' });
    const { nfce } = osDoisModelos();
    // 100,00 × (1 − 41,18%) = 58,82; 58,82 × 17% = 9,9994 → 10,00 (centavo por item).
    expect(icmsDe(nfce)).toBe(
      '<ICMS20><orig>0</orig><CST>20</CST><modBC>3</modBC><pRedBC>41.18</pRedBC>'
        + '<vBC>58.82</vBC><pICMS>17.00</pICMS><vICMS>10.00</vICMS></ICMS20>',
    );
    expect(totalDe(nfce)).toMatchObject({ vBC: '58.82', vICMS: '10.00', vNF: '100.00' });
  });

  it('CST 20 sem o percentual de redução é recusado — sem ele o CST 20 é o 00', () => {
    aliquotaIcms();
    grupo({ regime: 'normal', cstIcms: '20', icmsRateCode: 'ICMS17' });
    const erro = erroDe(() => tributacaoDoItem({ companyId: loja, produto: PECA }));
    expect(erro.message).toMatch(/redução/i);
  });

  it('CST 40, 41 e 50 saem em ICMS40, só com origem e CST', () => {
    const g = grupo({ regime: 'normal', cstIcms: '40' });
    for (const cst of ['40', '41', '50']) {
      grupo({ id: g.id, regime: 'normal', cstIcms: cst });
      expect(icmsDe(osDoisModelos().nfce)).toBe(
        `<ICMS40><orig>0</orig><CST>${cst}</CST></ICMS40>`,
      );
    }
  });

  it('CST 60 (ST cobrada antes) sai em ICMS60 — o caso da peça comprada com ST', () => {
    grupo({ regime: 'normal', cstIcms: '60' });
    const { nfce, nfe } = osDoisModelos();
    for (const xml of [nfce, nfe]) {
      expect(icmsDe(xml)).toBe('<ICMS60><orig>0</orig><CST>60</CST></ICMS60>');
      expect(totalDe(xml)).toMatchObject({ vBC: '0.00', vICMS: '0.00', vNF: '100.00' });
    }
  });

  it('CST 90: sem alíquota, só origem e CST; com alíquota, base e valor', () => {
    const g = grupo({ regime: 'normal', cstIcms: '90' });
    expect(icmsDe(osDoisModelos().nfce)).toBe('<ICMS90><orig>0</orig><CST>90</CST></ICMS90>');

    aliquotaIcms('ICMS12', 12);
    grupo({ id: g.id, regime: 'normal', cstIcms: '90', icmsRateCode: 'ICMS12' });
    const { nfce } = osDoisModelos();
    expect(icmsDe(nfce)).toBe(
      '<ICMS90><orig>0</orig><CST>90</CST><modBC>3</modBC><vBC>100.00</vBC>'
        + '<pICMS>12.00</pICMS><vICMS>12.00</vICMS></ICMS90>',
    );
    expect(totalDe(nfce)).toMatchObject({ vBC: '100.00', vICMS: '12.00' });
  });

  it('CST 10, 30 e 70: ST cobrada POR FORA pelo emitente — recusa com a razão', () => {
    const g = grupo({ regime: 'normal', cstIcms: '10' });
    for (const cst of ['10', '30', '70']) {
      grupo({ id: g.id, regime: 'normal', cstIcms: cst });
      const erro = erroDe(() =>
        impostoXml(tributacaoDoItem({ companyId: loja, produto: PECA }), PECA),
      );
      expect(erro.code).toBe('CORE_FISCAL_TRIBUTACAO_INCOMPLETA');
      expect(erro.message).toMatch(/por fora/i);
    }
  });

  it('FCP: com alíquota de FCP no grupo, pFCP e vFCP no item e vFCP no total', () => {
    aliquotaIcms();
    upsertTaxRate(loja, { code: 'FCP2', name: 'FCP 2%', kind: 'fcp', percent: 2 });
    grupo({ regime: 'normal', cstIcms: '00', icmsRateCode: 'ICMS17', fcpRateCode: 'FCP2' });
    const { nfce, nfe } = osDoisModelos();
    for (const xml of [nfce, nfe]) {
      expect(icmsDe(xml)).toBe(
        '<ICMS00><orig>0</orig><CST>00</CST><modBC>3</modBC><vBC>100.00</vBC>'
          + '<pICMS>17.00</pICMS><vICMS>17.00</vICMS><pFCP>2.00</pFCP><vFCP>2.00</vFCP></ICMS00>',
      );
      expect(totalDe(xml)).toMatchObject({ vFCP: '2.00', vNF: '100.00' });
    }
  });

  it('CST de ICMS fora da tabela é recusado no CADASTRO', () => {
    const erro = erroDe(() => grupo({ regime: 'normal', cstIcms: '99' }));
    expect(erro.code).toBe('CORE_TAX_GROUP_CST_ICMS');
  });

  it('alíquota de ICMS escolhida no grupo precisa existir, ativa e do tipo icms', () => {
    const erro = erroDe(() => grupo({ regime: 'normal', cstIcms: '00', icmsRateCode: 'NAOEXISTE' }));
    expect(erro.code).toBe('CORE_TAX_GROUP_ICMS_RATE_NOT_FOUND');
  });
});

// ============================================================================

describe('CRT — os quatro valores do leiaute', () => {
  it('CRT 4 (MEI) tributa pelo CSOSN, como o Simples', () => {
    configurar('4');
    grupo({ csosn: '102' });
    const t = tributacaoDoItem({ companyId: loja, produto: PECA });
    expect(t.csosn).toBe('102');
    expect(t.cstIcms).toBeNull();
  });

  it('CRT fora de 1 a 4 é recusado na configuração — antes da primeira venda', () => {
    for (const crt of ['5', '0', 'simples', '13']) {
      const erro = erroDe(() => updateFiscalConfig({ companyId: loja, patch: { crt } }));
      expect(erro.code).toBe('CORE_FISCAL_CRT_INVALID');
    }
    // E o que é válido continua entrando — inclusive limpar o campo.
    for (const crt of ['1', '2', '3', '4']) {
      expect(updateFiscalConfig({ companyId: loja, patch: { crt } }).crt).toBe(crt);
    }
  });
});

// ============================================================================

describe('o código de benefício fiscal (cBenef) sai do grupo', () => {
  it('sai no <prod>, antes do CFOP, e passa no XSD', () => {
    configurar('3');
    grupo({ regime: 'normal', cstIcms: '40', cBenef: 'RS801001' });
    const { nfce, nfe } = osDoisModelos();
    for (const xml of [nfce, nfe]) {
      expect(xml.replace(/\s+/g, '')).toContain('<CEST>0107500</CEST><cBenef>RS801001</cBenef><CFOP>');
    }
  });

  it('fora do formato do leiaute (8 ou 10 caracteres) é recusado no cadastro', () => {
    const erro = erroDe(() => grupo({ csosn: '102', cBenef: 'RS80' }));
    expect(erro.code).toBe('CORE_TAX_GROUP_CBENEF');
  });
});

// ============================================================================

describe('os tipos de alíquota que agora têm leitor', () => {
  it("'icms' e 'fcp' entram no cadastro — a emissão os lê", () => {
    expect(() => aliquotaIcms()).not.toThrow();
    expect(() =>
      upsertTaxRate(loja, { code: 'FCP2', name: 'FCP 2%', kind: 'fcp', percent: 2 }),
    ).not.toThrow();
  });
});
