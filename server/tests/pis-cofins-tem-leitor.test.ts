/**
 * ============================================================================
 * A ALÍQUOTA DE PIS/COFINS TEM CADASTRO — e agora tem LEITOR
 * ============================================================================
 *
 * ## O defeito
 *
 * `core_tax_rates` aceita `kind = 'pis'` e `kind = 'cofins'` desde sempre: a
 * tela de Catálogo › Alíquotas grava, o CRUD lê, o contador cadastra. Na hora
 * de emitir, NINGUÉM perguntava. Com CST TRIBUTADO (01 ou 02) o item saía com
 *
 *     <PISOutr><CST>01</CST><vBC>0.00</vBC><pPIS>0.00</pPIS><vPIS>0.00</vPIS>
 *
 * — três zeros CRAVADOS no código, e o grupo errado do layout por cima (CST 01
 * pertence a `PISAliq`, não a `PISOutr`). E os totais `<vPIS>` e `<vCOFINS>`
 * eram literais nos dois montadores.
 *
 * É a doença que esta casa nomeia "coluna gravada tem leitor": o contador
 * cadastra a alíquota, a tela aceita, e a nota sai dizendo que o tributo é
 * zero. O IPI perdeu essa doença na rodada passada; PIS e COFINS não.
 *
 * ## Por que aqui o valor SAI, e no IPI ele é recusado
 *
 * A regra é a mesma nos dois: NUNCA emitir um total que não fecha com o que o
 * cliente pagou. O que muda é a natureza do imposto.
 *
 *  - IPI é cobrado POR FORA: o layout soma `vIPI` ao `vNF`. Numa venda de
 *    balcão cujo total já está fechado, destacar IPI faria `vNF` divergir dos
 *    `<pag>` — por isso `tributacaoDoItem` RECUSA o destaque.
 *  - PIS e COFINS são cobrados POR DENTRO: já estão no preço, e `vPIS`/
 *    `vCOFINS` do `ICMSTot` são INFORMATIVOS — não entram na soma do `vNF`.
 *    Emitir o valor de verdade não move o total em um centavo.
 *
 * Onde a conta NÃO fecharia, a recusa continua: CST 03 é tributação por
 * UNIDADE DE MEDIDA (reais por unidade), e o cadastro guarda PERCENTUAL —
 * usar um pelo outro seria inventar imposto.
 *
 * ## COMO CADA GUARDA FALHA (quebrado de propósito — conferido)
 *
 *  - devolva `<pPIS>0.00</pPIS>` ao literal e o caso do `PISAliq` fica vermelho;
 *  - devolva `<vPIS>0.00</vPIS>` ao literal no total e os dois casos de total
 *    ficam vermelhos, num modelo e no outro;
 *  - devolva `<vIPI>0.00</vIPI>` ao literal na NF-e e o caso da simetria fica
 *    vermelho — ele lê o CÓDIGO dos dois montadores, porque o destaque de IPI
 *    é recusado por desenho e nenhum valor conseguiria distinguir os dois;
 *  - tire a recusa do CST 03 e a nota sai com um percentual no lugar de reais
 *    por unidade.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_DATABASE_PATH = ':memory:';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

const { resetDbForTests } = await import('../src/db/database.js');
const { ensureCoreSchema } = await import('../src/db/schema.js');
const { getConnection } = await import('../src/db/sqlite.js');
const { upsertCompany } = await import('../src/services/auth/IdentityService.js');
const { updateFiscalConfig, getFiscalConfig } = await import(
  '../src/services/core/FiscalConfigService.js'
);
const { upsertTaxGroup, upsertTaxRate } = await import(
  '../src/services/core/CatalogAuxService.js'
);
const { upsertNfceCsc } = await import('../src/services/nfce/NfceCscService.js');
const { setSeriesNextNumber } = await import('../src/services/core/FiscalKeyService.js');
const { impostoXml, tributacaoDoItem } = await import(
  '../src/services/core/TributacaoDoItem.js'
);
const { buildNfceXml } = await import('../src/services/core/FiscalXmlNfce.js');
const { buildNfeXml } = await import('../src/services/core/FiscalXmlNfe.js');

let loja: string;

/** Uma camisa de R$ 100,00 — base redonda, para a conta caber na cabeça. */
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

function grupo(extras: Record<string, unknown> = {}) {
  return upsertTaxGroup(loja, {
    code: 'PADRAO',
    name: 'Padrão da loja',
    regime: 'simples',
    csosn: '102',
    cfopInternal: '5102',
    cfopExternal: '6102',
    cstPis: '49',
    cstCofins: '49',
    ...extras,
  });
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

function venda(over: Record<string, unknown> = {}) {
  return {
    id: 'v1',
    companyId: loja,
    number: 1,
    createdAt: '2026-08-31T12:00:00.000Z',
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
        taxProfile: 'PADRAO',
      },
    ],
    payments: [{ method: 'dinheiro', amountCents: 10_000 }],
    ...over,
  } as never;
}

const DESTINATARIO = {
  document: '11.444.777/0001-61',
  name: 'Comprador Atacado Ltda',
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

beforeEach(() => {
  resetDbForTests();
  ensureCoreSchema();
  loja = upsertCompany({
    slug: 'preco-justo',
    legalName: 'Preço Justo Ltda',
    tradeName: 'Preço Justo',
  });
  updateFiscalConfig({
    companyId: loja,
    patch: {
      legalName: 'Preço Justo Ltda',
      tradeName: 'Preço Justo',
      cnpj: '11.222.333/0001-81',
      ie: '123456789',
      crt: '1',
      street: 'Rua Um',
      number: '1',
      district: 'Centro',
      cityName: 'Pelotas',
      cityIbge: '4314407',
      zip: '96010000',
      uf: 'RS',
    },
  });
  upsertNfceCsc({
    companyId: loja,
    operationalUnitId: 'unit-default',
    cscId: '000001',
    cscToken: 'CSC-DE-TESTE-NAO-E-O-REAL',
  });
  setSeriesNextNumber({ companyId: loja, model: '65', serie: 1, nextNumber: 1 });
  setSeriesNextNumber({ companyId: loja, model: '55', serie: 1, nextNumber: 1 });
});

// ===========================================================================

describe('a alíquota kind=pis/cofins ganha o leitor que faltava', () => {
  it('CST 01 lê o cadastro e emite PISAliq/COFINSAliq com valor de verdade', () => {
    upsertTaxRate(loja, { code: 'PIS165', name: 'PIS 1,65%', kind: 'pis', percent: 1.65 });
    upsertTaxRate(loja, { code: 'COF760', name: 'COFINS 7,6%', kind: 'cofins', percent: 7.6 });
    grupo({ cstPis: '01', cstCofins: '01' });

    const t = tributacaoDoItem({ companyId: loja, produto: CAMISA });

    // 1,65% de R$ 100,00 = R$ 1,65. 7,60% = R$ 7,60. Centavos INTEIROS.
    expect(t.pPis).toBe('1.65');
    expect(t.vPisCents).toBe(165);
    expect(t.pCofins).toBe('7.60');
    expect(t.vCofinsCents).toBe(760);
    expect(t.bcPisCents).toBe(10_000);
    expect(t.bcCofinsCents).toBe(10_000);

    const xml = impostoXml(t, CAMISA);
    /*
      O GRUPO DO LAYOUT TAMBÉM ESTAVA ERRADO: CST 01 pertence a `PISAliq`, e
      saía em `PISOutr`. A SEFAZ recusa por schema antes de olhar o valor.
    */
    expect(xml).toContain('<PISAliq>');
    expect(xml).toContain('<pPIS>1.65</pPIS>');
    expect(xml).toContain('<vPIS>1.65</vPIS>');
    expect(xml).toContain('<vBC>100.00</vBC>');
    expect(xml).toContain('<COFINSAliq>');
    expect(xml).toContain('<pCOFINS>7.60</pCOFINS>');
    expect(xml).toContain('<vCOFINS>7.60</vCOFINS>');
    expect(xml).not.toContain('<pPIS>0.00</pPIS>');
  });

  it('CST 01 SEM alíquota cadastrada é recusado, dizendo o nome do dado', () => {
    grupo({ cstPis: '01', cstCofins: '01' });

    const erro = erroDe(() => tributacaoDoItem({ companyId: loja, produto: CAMISA }));
    expect(erro.code).toBe('CORE_FISCAL_TRIBUTACAO_INCOMPLETA');
    expect(erro.message).toContain('Camisa Social');
    expect(erro.message).toContain('alíquota de PIS');
    expect(erro.message).toContain('Catálogo › Alíquotas');
  });

  it('a alíquota DESATIVADA depois de cadastrada é dita com o nome do dado', () => {
    upsertTaxRate(loja, { code: 'PIS165', name: 'PIS 1,65%', kind: 'pis', percent: 1.65 });
    upsertTaxRate(loja, { code: 'COF760', name: 'COFINS 7,6%', kind: 'cofins', percent: 7.6 });
    grupo({ cstPis: '01', cstCofins: '01' });

    getConnection()
      .prepare("UPDATE core_tax_rates SET active = 0 WHERE company_id = ? AND kind = 'cofins'")
      .run(loja);

    const erro = erroDe(() => tributacaoDoItem({ companyId: loja, produto: CAMISA }));
    expect(erro.message).toContain('alíquota de COFINS');
  });

  it('DUAS alíquotas ativas do mesmo tipo: escolher seria adivinhar imposto', () => {
    upsertTaxRate(loja, { code: 'PIS065', name: 'PIS 0,65%', kind: 'pis', percent: 0.65 });
    upsertTaxRate(loja, { code: 'PIS165', name: 'PIS 1,65%', kind: 'pis', percent: 1.65 });
    upsertTaxRate(loja, { code: 'COF760', name: 'COFINS 7,6%', kind: 'cofins', percent: 7.6 });
    grupo({ cstPis: '01', cstCofins: '01' });

    const erro = erroDe(() => tributacaoDoItem({ companyId: loja, produto: CAMISA }));
    expect(erro.code).toBe('CORE_FISCAL_TRIBUTACAO_INCOMPLETA');
    // A recusa nomeia as duas, para o contador saber qual desativar.
    expect(erro.message).toContain('PIS065');
    expect(erro.message).toContain('PIS165');
    expect(erro.message).toContain('Catálogo › Alíquotas');
  });

  it('a alíquota é POR EMPRESA — a da vizinha não entra nesta nota', () => {
    const gringa = upsertCompany({ slug: 'gringa', legalName: 'Gringa Ltda', tradeName: 'Gringa' });
    upsertTaxRate(gringa, { code: 'PIS165', name: 'PIS 1,65%', kind: 'pis', percent: 1.65 });
    upsertTaxRate(gringa, { code: 'COF760', name: 'COFINS 7,6%', kind: 'cofins', percent: 7.6 });
    grupo({ cstPis: '01', cstCofins: '01' });

    const erro = erroDe(() => tributacaoDoItem({ companyId: loja, produto: CAMISA }));
    expect(erro.message).toContain('alíquota de PIS');
  });

  it('os centavos são INTEIROS, e a soma dos itens é a soma dos arredondamentos', () => {
    upsertTaxRate(loja, { code: 'PIS165', name: 'PIS 1,65%', kind: 'pis', percent: 1.65 });
    upsertTaxRate(loja, { code: 'COF760', name: 'COFINS 7,6%', kind: 'cofins', percent: 7.6 });
    grupo({ cstPis: '01', cstCofins: '01' });

    // R$ 33,33 → 1,65% = 55,0 centavos; e 7,60% = 253,3 centavos.
    const t = tributacaoDoItem({
      companyId: loja,
      produto: { ...CAMISA, totalCents: 3_333 },
    });
    expect(Number.isInteger(t.vPisCents)).toBe(true);
    expect(Number.isInteger(t.vCofinsCents)).toBe(true);
    expect(t.vPisCents).toBe(Math.round((3_333 * 1.65) / 100));
    expect(t.vCofinsCents).toBe(Math.round((3_333 * 7.6) / 100));
  });
});

// ===========================================================================

describe('o que continua recusado, e o que continua igual', () => {
  it('CST 03 (por UNIDADE DE MEDIDA) é recusado: o cadastro guarda percentual', () => {
    upsertTaxRate(loja, { code: 'PIS165', name: 'PIS 1,65%', kind: 'pis', percent: 1.65 });
    upsertTaxRate(loja, { code: 'COF760', name: 'COFINS 7,6%', kind: 'cofins', percent: 7.6 });
    grupo({ cstPis: '03', cstCofins: '01' });

    const erro = erroDe(() => tributacaoDoItem({ companyId: loja, produto: CAMISA }));
    expect(erro.code).toBe('CORE_FISCAL_TRIBUTACAO_INCOMPLETA');
    expect(erro.message).toContain('unidade de medida');
    // Percentual usado como reais por unidade seria imposto inventado.
    expect(erro.message).toContain('percentual');
  });

  it('CST de ENTRADA numa nota de SAÍDA é recusado, dizendo quais valem', () => {
    grupo({ cstPis: '50', cstCofins: '49' });

    const erro = erroDe(() => tributacaoDoItem({ companyId: loja, produto: CAMISA }));
    expect(erro.code).toBe('CORE_FISCAL_TRIBUTACAO_INCOMPLETA');
    expect(erro.message).toContain('entrada');
  });

  it('CST desconhecido é recusado — e não vira PISOutr calado', () => {
    grupo({ cstPis: '77', cstCofins: '49' });

    const erro = erroDe(() => tributacaoDoItem({ companyId: loja, produto: CAMISA }));
    expect(erro.code).toBe('CORE_FISCAL_TRIBUTACAO_INCOMPLETA');
    expect(erro.message).toContain('77');
  });

  it('CST 49 (outras saídas) continua com o zero que o Simples declara', () => {
    // Este é o cadastro real do grupo: quem paga PIS/COFINS dentro do DAS não
    // destaca nada. O zero AQUI é declaração fiscal, não literal esquecido.
    grupo();
    const t = tributacaoDoItem({ companyId: loja, produto: CAMISA });

    expect(t.pPis).toBeNull();
    expect(t.vPisCents).toBe(0);

    const xml = impostoXml(t, CAMISA);
    expect(xml).toContain('<PISOutr>');
    expect(xml).toContain('<COFINSOutr>');
    expect(xml).toContain('<pCOFINS>0.00</pCOFINS>');
  });

  it('CST 04 a 09 continuam em PISNT, sem base e sem percentual', () => {
    grupo({ cstPis: '06', cstCofins: '06' });
    const xml = impostoXml(tributacaoDoItem({ companyId: loja, produto: CAMISA }), CAMISA);

    expect(xml).toContain('<PISNT><CST>06</CST></PISNT>');
    expect(xml).toContain('<COFINSNT><CST>06</CST></COFINSNT>');
  });
});

// ===========================================================================

describe('a VARREDURA dos quatro kinds de core_tax_rates', () => {
  /*
    O cadastro aceita quatro tipos de alíquota: icms, pis, cofins e ipi.
    Depois desta rodada, TRÊS têm leitor na emissão — 'ipi' (pelo
    `ipi_rate_code` do grupo) e agora 'pis' e 'cofins' (pelo tipo, porque a
    alíquota das contribuições é do REGIME e não do produto).

    'icms' ficou sem leitor até o GAP-PRD-021, e este caso PRENDIA a recusa do
    ICMS por CST para que ninguém a "consertasse" com zeros. O conserto veio do
    jeito certo — base, modalidade de base, os grupos ICMS00/20/40/60/90 e o
    vínculo alíquota↔grupo (`icms_rate_code`) — e o caso passa a prender a
    outra metade: sem a alíquota, a recusa manda cadastrá-la e escolhê-la,
    porque AGORA isso destrava. Zero calado continua proibido.
  */
  it('ICMS por CST: sem a alíquota, a recusa manda escolhê-la — e escolhida, ela sai', () => {
    updateFiscalConfig({ companyId: loja, patch: { crt: '3' } });
    const g = grupo({ csosn: null, cstIcms: '00' });

    const erro = erroDe(() => tributacaoDoItem({ companyId: loja, produto: CAMISA }));
    expect(erro.code).toBe('CORE_FISCAL_TRIBUTACAO_INCOMPLETA');
    expect(erro.message).toMatch(/alíquota de ICMS/);
    expect(erro.message).toMatch(/Cadastre a alíquota/i);
    expect(erro.message).not.toContain('ainda não é emitido');

    upsertTaxRate(loja, { code: 'ICMS18', name: 'ICMS 18%', kind: 'icms', percent: 18 });
    grupo({ id: g.id, csosn: null, cstIcms: '00', icmsRateCode: 'ICMS18' });
    const t = tributacaoDoItem({ companyId: loja, produto: CAMISA });
    expect(t.icms).toMatchObject({ vBcCents: 10_000, pIcms: '18.00', vIcmsCents: 1_800 });
    expect(impostoXml(t, CAMISA).replace(/\s+/g, '')).toContain(
      '<ICMS00><orig>0</orig><CST>00</CST><modBC>3</modBC><vBC>100.00</vBC>',
    );
  });

  /*
    O TIPO VOLTOU À LISTA do lado certo da ordem: 'icms' tem leitor (o grupo o
    lê pelo código), e 'fcp' entrou com ele. Um tipo que ninguém lê continua
    fora.
  */
  it('os cinco tipos com leitor entram; tipo sem leitor continua recusado', () => {
    for (const kind of ['pis', 'cofins', 'ipi', 'icms', 'fcp']) {
      expect(() =>
        upsertTaxRate(loja, { code: `K-${kind}`, name: kind, kind, percent: 1 }),
      ).not.toThrow();
    }
    const erro = erroDe(() =>
      upsertTaxRate(loja, { code: 'ISS5', name: 'ISS 5%', kind: 'iss', percent: 5 }),
    );
    expect(erro.code).toBe('CORE_TAX_RATE_KIND');
  });
});

// ===========================================================================

describe('o TOTAL da nota soma o que os itens declaram — nos dois modelos', () => {
  function comAliquotaTributada() {
    upsertTaxRate(loja, { code: 'PIS165', name: 'PIS 1,65%', kind: 'pis', percent: 1.65 });
    upsertTaxRate(loja, { code: 'COF760', name: 'COFINS 7,6%', kind: 'cofins', percent: 7.6 });
    grupo({ cstPis: '01', cstCofins: '01' });
  }

  it('NFC-e: vPIS e vCOFINS do ICMSTot deixam de ser literais', () => {
    comAliquotaTributada();
    const { xml } = buildNfceXml({
      sale: venda(),
      config: getFiscalConfig(loja),
      serie: 1,
      number: 1,
    });

    const total = totalDe(xml);
    expect(total.vPIS).toBe('1.65');
    expect(total.vCOFINS).toBe('7.60');
    /*
      E O `vNF` NÃO SE MEXE. PIS e COFINS são por dentro: `vPIS`/`vCOFINS` do
      total são informativos e não entram na soma do `vNF`. Se um dia entrarem,
      este caso fica vermelho — e é exatamente o que ele existe para impedir.
    */
    expect(total.vNF).toBe('100.00');
    expect(total.vProd).toBe('100.00');
  });

  it('NF-e: vPIS e vCOFINS do ICMSTot deixam de ser literais', () => {
    comAliquotaTributada();
    const { xml } = buildNfeXml({
      sale: venda(),
      config: getFiscalConfig(loja),
      recipient: DESTINATARIO,
      serie: 1,
      number: 1,
    });

    const total = totalDe(xml);
    expect(total.vPIS).toBe('1.65');
    expect(total.vCOFINS).toBe('7.60');
    expect(total.vNF).toBe('100.00');
  });

  it('o XML com PISAliq/COFINSAliq continua bem formado nos dois modelos', async () => {
    const { validateAgainstSchema } = await import('../src/services/core/FiscalXmlNfce.js');
    comAliquotaTributada();

    for (const xml of [
      buildNfceXml({ sale: venda(), config: getFiscalConfig(loja), serie: 1, number: 1 }).xml,
      buildNfeXml({
        sale: venda(),
        config: getFiscalConfig(loja),
        recipient: DESTINATARIO,
        serie: 1,
        number: 1,
      }).xml,
    ]) {
      const r = validateAgainstSchema(xml);
      expect(r.problems).toEqual([]);
      expect(r.wellFormed).toBe(true);
    }
  });

  it('os DOIS modelos declaram o MESMO total, item por item', () => {
    comAliquotaTributada();
    const nfce = totalDe(
      buildNfceXml({ sale: venda(), config: getFiscalConfig(loja), serie: 1, number: 1 }).xml,
    );
    const nfe = totalDe(
      buildNfeXml({
        sale: venda(),
        config: getFiscalConfig(loja),
        recipient: DESTINATARIO,
        serie: 1,
        number: 1,
      }).xml,
    );

    // Mesma venda, mesmo `tributacaoDoItem`: divergir aqui é contradição.
    for (const campo of ['vPIS', 'vCOFINS', 'vIPI', 'vProd', 'vNF']) {
      expect(nfe[campo], campo).toBe(nfce[campo]);
    }
  });
});

// ===========================================================================

describe('o vIPI do total não é literal em modelo nenhum (GAP-V08, a outra metade)', () => {
  /*
    ESTE CASO LÊ O CÓDIGO, e não o XML, POR NECESSIDADE.

    O destaque de IPI é RECUSADO por desenho (imposto por fora somaria ao vNF
    de uma venda cujo total já está fechado), então `vIpiCents` é sempre zero e
    nenhum XML consegue distinguir `money(vIpi)` do literal `0.00`. Foi por
    essa fresta que a NFC-e ganhou o conserto e a NF-e ficou para trás — e a
    contradição só apareceria no dia em que a cobrança por fora existisse.

    Ler a fonte é o único jeito de a guarda morder HOJE.
  */
  const fonte = (arquivo: string) =>
    readFileSync(fileURLToPath(new URL(`../src/services/core/${arquivo}`, import.meta.url)), 'utf8');

  for (const arquivo of ['FiscalXmlNfe.ts', 'FiscalXmlNfce.ts']) {
    it(`${arquivo}: o total interpola o valor somado, e não o zero cravado`, () => {
      const texto = fonte(arquivo);
      /*
        Ancorado em `<vBC>` de propósito: os comentários destes arquivos citam
        `<ICMSTot>` por escrito, e um recorte solto pegaria a citação em vez do
        bloco — a guarda mediria o comentário, não o código.
      */
      const total = /<ICMSTot>\s*<vBC>[\s\S]*?<\/ICMSTot>/.exec(texto)?.[0] ?? '';
      expect(total, `${arquivo} não tem bloco <ICMSTot>`).not.toBe('');

      for (const tag of ['vIPI', 'vPIS', 'vCOFINS']) {
        expect(total, `${arquivo}: <${tag}> voltou ao literal`).not.toContain(
          `<${tag}>0.00</${tag}>`,
        );
        expect(total, `${arquivo}: <${tag}> não soma nada`).toMatch(
          new RegExp(`<${tag}>\\$\\{money\\(`),
        );
      }
    });
  }
});
