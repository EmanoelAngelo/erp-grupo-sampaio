/**
 * ============================================================================
 * O XML DE ENTRADA DIZ MAIS DO QUE O PARSER LIA (GAP-PRD-181)
 * ============================================================================
 *
 * O parser da nota de entrada lia chave, número, emitente (nome e documento),
 * totais, transporte e a identidade de cada item — e jogava fora o resto:
 *
 *   - do EMITENTE: inscrição estadual, nome fantasia, CRT, endereço, código
 *     IBGE do município e telefone. O fornecedor nascia só com nome e CNPJ, e
 *     alguém redigitava o cadastro que estava escrito no arquivo;
 *   - o MODELO e o DESTINATÁRIO da nota;
 *   - a tributação declarada em cada item: CST/CSOSN e valores de ICMS (e ST),
 *     IPI, PIS e COFINS.
 *
 * E o banco real tinha o outro lado do mesmo buraco: produtos nascidos da
 * confirmação de uma nota, com o NCM daquela nota, apareciam "do cadastro"
 * (procedência nula), e as notas anteriores ao recurso de sugestão nunca
 * tinham gerado sugestão nenhuma — não havia retroação.
 *
 * O que NÃO muda, e é regra: a tributação de COMPRA não vira tributação de
 * VENDA. Os CST/CSOSN do fornecedor ficam guardados como o que ele declarou
 * (matéria do contador), e nenhum deles toca o produto.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { loginForTest } from './helpers/auth.js';
import { listNoteItems, parseNfeXml } from '../src/services/core/NfeImportService.js';
import { createSupplier, updateSupplier } from '../src/services/core/SupplierService.js';

const app = createApp();

const CNPJ_FORNECEDOR = '14200166000187';
const CHAVE_A = '35240114200166000187550010000000015123456789';
const CHAVE_B = '35240114200166000187550010000000025123456789';

interface ItemDoXml {
  cProd: string;
  ean: string;
  nome: string;
  ncm: string;
  imposto: string;
}

const ITEM_NORMAL: ItemDoXml = {
  cProd: 'FORN-001',
  ean: '7891234567895',
  nome: 'Pastilha de Freio Dianteira',
  ncm: '87141000',
  imposto: `
    <ICMS><ICMS10><orig>0</orig><CST>10</CST><modBC>3</modBC><vBC>455.00</vBC><pICMS>18.00</pICMS>
      <vICMS>81.90</vICMS><modBCST>4</modBCST><vBCST>500.00</vBCST><pICMSST>18.00</pICMSST>
      <vICMSST>8.10</vICMSST></ICMS10></ICMS>
    <IPI><cEnq>999</cEnq><IPITrib><CST>50</CST><vBC>455.00</vBC><pIPI>5.00</pIPI><vIPI>22.75</vIPI></IPITrib></IPI>
    <PIS><PISAliq><CST>01</CST><vBC>455.00</vBC><pPIS>1.65</pPIS><vPIS>7.51</vPIS></PISAliq></PIS>
    <COFINS><COFINSAliq><CST>01</CST><vBC>455.00</vBC><pCOFINS>7.60</pCOFINS><vCOFINS>34.58</vCOFINS></COFINSAliq></COFINS>`,
};

const ITEM_SIMPLES: ItemDoXml = {
  cProd: 'FORN-002',
  ean: '7891234567802',
  nome: 'Disco de Freio',
  ncm: '87083090',
  imposto: `
    <ICMS><ICMSSN102><orig>2</orig><CSOSN>102</CSOSN></ICMSSN102></ICMS>
    <IPI><cEnq>999</cEnq><IPINT><CST>53</CST></IPINT></IPI>
    <PIS><PISNT><CST>07</CST></PISNT></PIS>
    <COFINS><COFINSNT><CST>07</CST></COFINSNT></COFINS>`,
};

function nfeXml(options: { chave: string; itens?: ItemDoXml[] }): string {
  const dets = (options.itens ?? [ITEM_NORMAL, ITEM_SIMPLES])
    .map(
      (item, i) => `
      <det nItem="${i + 1}">
        <prod>
          <cProd>${item.cProd}</cProd><cEAN>${item.ean}</cEAN><xProd>${item.nome}</xProd>
          <NCM>${item.ncm}</NCM><CEST>0100100</CEST><CFOP>6102</CFOP>
          <uCom>UN</uCom><qCom>10.0000</qCom><vUnCom>45.5000</vUnCom><vProd>455.00</vProd>
        </prod>
        <imposto>${item.imposto}</imposto>
      </det>`,
    )
    .join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc versao="4.00" xmlns="http://www.portalfiscal.inf.br/nfe">
  <NFe>
    <infNFe Id="NFe${options.chave}" versao="4.00">
      <ide><cUF>35</cUF><mod>55</mod><serie>1</serie><nNF>1024</nNF><dhEmi>2026-08-01T10:15:00-03:00</dhEmi></ide>
      <emit>
        <CNPJ>${CNPJ_FORNECEDOR}</CNPJ>
        <xNome>Distribuidora de Pecas Ltda</xNome>
        <xFant>Distri Pecas</xFant>
        <enderEmit>
          <xLgr>Rua das Industrias</xLgr><nro>1200</nro><xCpl>Galpao 3</xCpl>
          <xBairro>Distrito Industrial</xBairro><cMun>3550308</cMun><xMun>Sao Paulo</xMun>
          <UF>SP</UF><CEP>04500000</CEP><cPais>1058</cPais><xPais>BRASIL</xPais><fone>1133334444</fone>
        </enderEmit>
        <IE>123456789110</IE>
        <CRT>3</CRT>
      </emit>
      <dest>
        <CNPJ>11222333000181</CNPJ>
        <xNome>Loja Xml Ltda</xNome>
        <IE>9876543210</IE>
      </dest>
      ${dets}
      <total><ICMSTot><vNF>910.00</vNF></ICMSTot></total>
    </infNFe>
  </NFe>
  <protNFe><infProt><nProt>135240000000001</nProt></infProt></protNFe>
</nfeProc>`;
}

let auth: { Authorization: string };
let companyId: string;

beforeEach(async () => {
  resetDbForTests();
  const res = await loginForTest(app, {
    userId: 'gerente-xml',
    companyId: 'loja-xml-181',
    profileCodes: ['gerente_loja'],
  });
  auth = { Authorization: `Bearer ${res.body.accessToken}` };
  companyId = res.body.company.id;
});

async function importar(xml: string): Promise<string> {
  const imp = await request(app).post('/api/v1/core/purchases/nfe/import').set(auth).send({ xml });
  expect([200, 201], JSON.stringify(imp.body)).toContain(imp.status);
  return String(imp.body.noteId);
}

async function confirmar(noteId: string): Promise<void> {
  const conf = await request(app)
    .post(`/api/v1/core/purchases/notes/${noteId}/confirm`)
    .set(auth)
    .send({ createMissing: true });
  expect(conf.status, JSON.stringify(conf.body)).toBe(200);
}

function fornecedor(): Record<string, unknown> {
  return getConnection()
    .prepare('SELECT * FROM core_suppliers WHERE company_id = ? AND document = ?')
    .get(companyId, CNPJ_FORNECEDOR) as Record<string, unknown>;
}

function produtoPorNome(nome: string): Record<string, unknown> {
  return getConnection()
    .prepare('SELECT * FROM core_products WHERE company_id = ? AND name = ?')
    .get(companyId, nome) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// O parser
// ---------------------------------------------------------------------------

describe('o parser lê o que o arquivo já dizia', () => {
  it('o modelo, o emitente inteiro e o destinatário', () => {
    const nota = parseNfeXml(nfeXml({ chave: CHAVE_A }));
    expect(nota.model).toBe('55');
    expect(nota.supplier).toEqual({
      tradeName: 'Distri Pecas',
      stateRegistration: '123456789110',
      crt: '3',
      street: 'Rua das Industrias',
      number: '1200',
      complement: 'Galpao 3',
      district: 'Distrito Industrial',
      cityIbge: '3550308',
      city: 'Sao Paulo',
      state: 'SP',
      zip: '04500000',
      phone: '1133334444',
    });
    expect(nota.recipient).toEqual({
      document: '11222333000181',
      name: 'Loja Xml Ltda',
      stateRegistration: '9876543210',
    });
  });

  it('a tributação declarada em cada item — regime normal com ST e Simples', () => {
    const [normal, simples] = parseNfeXml(nfeXml({ chave: CHAVE_A })).items;
    expect(normal.taxes).toEqual({
      icmsCst: '10',
      icmsCsosn: null,
      icmsCents: 8190,
      icmsStCents: 810,
      ipiCst: '50',
      ipiCents: 2275,
      pisCst: '01',
      pisCents: 751,
      cofinsCst: '01',
      cofinsCents: 3458,
    });
    // Valor AUSENTE é nulo, não zero: "não declarou" não é "declarou zero".
    expect(simples.taxes).toEqual({
      icmsCst: null,
      icmsCsosn: '102',
      icmsCents: null,
      icmsStCents: null,
      ipiCst: '53',
      ipiCents: null,
      pisCst: '07',
      pisCents: null,
      cofinsCst: '07',
      cofinsCents: null,
    });
  });

  it('nota sem os grupos novos continua sendo lida — tudo nulo, nada inventado', () => {
    const minima = nfeXml({ chave: CHAVE_A })
      .replace(/<xFant>[^<]*<\/xFant>/, '')
      .replace(/<enderEmit>[\s\S]*?<\/enderEmit>/, '')
      .replace(/<IE>123456789110<\/IE>/, '')
      .replace(/<dest>[\s\S]*?<\/dest>/, '')
      .replace(/<mod>55<\/mod>/, '');
    const nota = parseNfeXml(minima);
    expect(nota.model).toBeNull();
    expect(nota.supplier.stateRegistration).toBeNull();
    expect(nota.supplier.cityIbge).toBeNull();
    expect(nota.recipient.document).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// O que a importação grava
// ---------------------------------------------------------------------------

describe('a importação completa o cadastro — sem sobrescrever quem digitou', () => {
  it('fornecedor novo nasce com IE, endereço, IBGE, fantasia e telefone do XML', async () => {
    await importar(nfeXml({ chave: CHAVE_A }));
    expect(fornecedor()).toMatchObject({
      name: 'Distribuidora de Pecas Ltda',
      trade_name: 'Distri Pecas',
      state_registration: '123456789110',
      street: 'Rua das Industrias',
      number: '1200',
      complement: 'Galpao 3',
      district: 'Distrito Industrial',
      city: 'Sao Paulo',
      state: 'SP',
      zip: '04500000',
      phone: '1133334444',
      city_ibge: '3550308',
    });

    const trilha = getConnection()
      .prepare("SELECT detail FROM core_audit_log WHERE company_id = ? AND action = 'supplier.autofill_xml'")
      .all(companyId) as { detail: string }[];
    expect(trilha).toHaveLength(1);
    const detalhe = JSON.parse(trilha[0].detail) as { accessKey: string; campos: string[] };
    expect(detalhe.accessKey).toBe(CHAVE_A);
    expect(detalhe.campos).toEqual(expect.arrayContaining(['state_registration', 'city_ibge', 'street']));
  });

  it('fornecedor já cadastrado: só o que está EM BRANCO é preenchido', async () => {
    createSupplier(companyId, {
      name: 'Distribuidora (digitada)',
      document: '14.200.166/0001-87',
      stateRegistration: 'IE-DIGITADA',
      city: 'Guarulhos',
      state: 'SP',
    });

    await importar(nfeXml({ chave: CHAVE_A }));
    const f = fornecedor();
    // O que alguém digitou fica: digitação também é gente.
    expect(f.name).toBe('Distribuidora (digitada)');
    expect(f.state_registration).toBe('IE-DIGITADA');
    expect(f.city).toBe('Guarulhos');
    // A cidade digitada não é a do XML: o IBGE do XML não pode ser grudado nela.
    expect(f.city_ibge).toBeNull();
    // O que estava em branco vem do arquivo.
    expect(f.street).toBe('Rua das Industrias');
    expect(f.zip).toBe('04500000');
    expect(f.trade_name).toBe('Distri Pecas');
  });

  it('a segunda nota do mesmo fornecedor não reescreve nada nem enche a trilha', async () => {
    await importar(nfeXml({ chave: CHAVE_A }));
    await importar(nfeXml({ chave: CHAVE_B }));
    const trilha = getConnection()
      .prepare("SELECT COUNT(*) AS n FROM core_audit_log WHERE company_id = ? AND action = 'supplier.autofill_xml'")
      .get(companyId) as { n: number };
    expect(Number(trilha.n)).toBe(1);
  });

  it('mudar a cidade do fornecedor apaga o IBGE que era da cidade antiga', async () => {
    await importar(nfeXml({ chave: CHAVE_A }));
    const id = String(fornecedor().id);

    updateSupplier(companyId, id, { phone: '11999998888' });
    expect(fornecedor().city_ibge).toBe('3550308');

    updateSupplier(companyId, id, { city: 'Campinas' });
    expect(fornecedor().city_ibge).toBeNull();
  });

  it('a nota guarda o modelo e o destinatário; o item guarda a tributação declarada', async () => {
    const noteId = await importar(nfeXml({ chave: CHAVE_A }));
    const nota = getConnection()
      .prepare('SELECT model, recipient_document, recipient_name FROM core_inbound_notes WHERE id = ?')
      .get(noteId);
    expect(nota).toEqual({
      model: '55',
      recipient_document: '11222333000181',
      recipient_name: 'Loja Xml Ltda',
    });

    const [normal, simples] = listNoteItems(companyId, noteId);
    expect(normal.taxes).toMatchObject({ icmsCst: '10', icmsCents: 8190, icmsStCents: 810, ipiCents: 2275 });
    expect(simples.taxes).toMatchObject({ icmsCsosn: '102', pisCst: '07', cofinsCst: '07', icmsCents: null });
  });
});

// ---------------------------------------------------------------------------
// A procedência do produto nascido da nota
// ---------------------------------------------------------------------------

describe('produto nascido da nota diz que o NCM veio do XML', () => {
  it('a confirmação que cria o produto grava a procedência xml_fornecedor, sem confirmar', async () => {
    await confirmar(await importar(nfeXml({ chave: CHAVE_A, itens: [ITEM_NORMAL] })));

    const p = produtoPorNome(ITEM_NORMAL.nome);
    expect(p.ncm).toBe('87141000');
    expect(p.fiscal_classification_source).toBe('xml_fornecedor');
    expect(p.fiscal_confirmed_at).toBeNull();

    const lista = await request(app).get('/api/v1/core/fiscal/classification?all=1').set(auth);
    const produto = (lista.body.items as { productId: string; fields: { field: string; source: string }[] }[])
      .find((x) => x.productId === p.id)!;
    expect(produto.fields.find((f) => f.field === 'ncm')?.source).toBe('xml_fornecedor');
  });

  it('produto que JÁ existia, com NCM digitado, continua "do cadastro"', async () => {
    const criado = await request(app)
      .post('/api/v1/core/products')
      .set(auth)
      .send({ name: 'Pastilha (cadastro antigo)', barcode: ITEM_NORMAL.ean, priceCents: 9900, ncm: '87141000' });
    expect(criado.status).toBe(201);
    await confirmar(await importar(nfeXml({ chave: CHAVE_A, itens: [ITEM_NORMAL] })));

    expect(produtoPorNome('Pastilha (cadastro antigo)').fiscal_classification_source).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// A releitura das notas que já entraram
// ---------------------------------------------------------------------------

describe('reler as notas já recebidas (retroação)', () => {
  /**
   * Leva o banco ao estado de uma nota confirmada ANTES do recurso: sem
   * sugestão, sem CEST/origem/tributo no item, produto nascido dela com a
   * procedência nula e o fornecedor só com nome e documento.
   */
  function envelhecer(noteId: string): void {
    const db = getConnection();
    db.prepare('DELETE FROM core_product_fiscal_suggestions WHERE company_id = ?').run(companyId);
    db.prepare(
      `UPDATE core_inbound_note_items
          SET cest = NULL, origin = NULL, icms_cst = NULL, icms_csosn = NULL, icms_cents = NULL,
              icms_st_cents = NULL, ipi_cst = NULL, ipi_cents = NULL, pis_cst = NULL,
              pis_cents = NULL, cofins_cst = NULL, cofins_cents = NULL
        WHERE note_id = ?`,
    ).run(noteId);
    db.prepare(
      'UPDATE core_inbound_notes SET model = NULL, recipient_document = NULL, recipient_name = NULL WHERE id = ?',
    ).run(noteId);
    db.prepare("UPDATE core_products SET fiscal_classification_source = NULL WHERE company_id = ?").run(companyId);
    db.prepare(
      `UPDATE core_suppliers
          SET trade_name = NULL, state_registration = NULL, street = NULL, number = NULL,
              complement = NULL, district = NULL, city = NULL, state = NULL, zip = NULL,
              phone = NULL, city_ibge = NULL
        WHERE company_id = ?`,
    ).run(companyId);
  }

  it('recria as sugestões, completa item e fornecedor e reconhece a procedência', async () => {
    const noteId = await importar(nfeXml({ chave: CHAVE_A, itens: [ITEM_NORMAL] }));
    await confirmar(noteId);
    envelhecer(noteId);

    const res = await request(app).post('/api/v1/core/fiscal/classification/reler-notas').set(auth);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      notasLidas: 1,
      notasSemArquivo: 0,
      notasIlegiveis: 0,
      fornecedoresCompletados: 1,
      itensCompletados: 1,
      procedenciasCorrigidas: 1,
    });
    expect(res.body.sugestoesNovas).toBeGreaterThanOrEqual(3); // NCM, CEST e origem

    const p = produtoPorNome(ITEM_NORMAL.nome);
    expect(p.fiscal_classification_source).toBe('xml_fornecedor');
    expect(p.fiscal_confirmed_at).toBeNull();
    expect(fornecedor()).toMatchObject({ state_registration: '123456789110', city_ibge: '3550308' });
    const [item] = listNoteItems(companyId, noteId);
    expect(item.cest).toBe('0100100');
    expect(item.taxes?.icmsCst).toBe('10');

    const trilha = getConnection()
      .prepare("SELECT detail FROM core_audit_log WHERE company_id = ? AND action = 'fiscal.inbound_notes_reread'")
      .all(companyId) as { detail: string }[];
    expect(trilha).toHaveLength(1);
  });

  it('é idempotente: a segunda releitura não acha nada novo', async () => {
    const noteId = await importar(nfeXml({ chave: CHAVE_A, itens: [ITEM_NORMAL] }));
    await confirmar(noteId);
    envelhecer(noteId);
    await request(app).post('/api/v1/core/fiscal/classification/reler-notas').set(auth);

    const segunda = await request(app).post('/api/v1/core/fiscal/classification/reler-notas').set(auth);
    expect(segunda.body).toMatchObject({
      notasLidas: 1,
      fornecedoresCompletados: 0,
      itensCompletados: 0,
      sugestoesNovas: 0,
      procedenciasCorrigidas: 0,
    });
  });

  it('não dá a procedência do XML a produto que existia antes da nota', async () => {
    await request(app)
      .post('/api/v1/core/products')
      .set(auth)
      .send({ name: 'Pastilha (cadastro antigo)', barcode: ITEM_NORMAL.ean, priceCents: 9900, ncm: '87141000' });
    const noteId = await importar(nfeXml({ chave: CHAVE_A, itens: [ITEM_NORMAL] }));
    await confirmar(noteId);
    envelhecer(noteId);

    const res = await request(app).post('/api/v1/core/fiscal/classification/reler-notas').set(auth);
    expect(res.body.procedenciasCorrigidas).toBe(0);
    expect(produtoPorNome('Pastilha (cadastro antigo)').fiscal_classification_source).toBeNull();
  });

  it('nota sem arquivo e nota com XML ilegível são contadas, e a releitura segue', async () => {
    const db = getConnection();
    db.prepare(
      `INSERT INTO core_inbound_notes (id, company_id, access_key, total_cents, status, xml_original, created_at)
       VALUES ('nota-sem-xml', ?, ?, 100, 'received', NULL, '2026-08-01T12:00:00.000Z')`,
    ).run(companyId, '35240114200166000187550010000000035123456789');
    db.prepare(
      `INSERT INTO core_inbound_notes (id, company_id, access_key, total_cents, status, xml_original, created_at)
       VALUES ('nota-lixo', ?, ?, 100, 'received', '<isto nao e xml', '2026-08-01T12:00:00.000Z')`,
    ).run(companyId, '35240114200166000187550010000000045123456789');

    const res = await request(app).post('/api/v1/core/fiscal/classification/reler-notas').set(auth);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ notasLidas: 0, notasSemArquivo: 1, notasIlegiveis: 1 });
  });

  it('só a empresa do token: a vizinha relê as dela e não toca nas desta', async () => {
    const noteId = await importar(nfeXml({ chave: CHAVE_A, itens: [ITEM_NORMAL] }));
    await confirmar(noteId);
    envelhecer(noteId);

    const vizinha = await loginForTest(app, {
      userId: 'gerente-vizinha',
      companyId: 'vizinha-xml-181',
      profileCodes: ['gerente_loja'],
    });
    const res = await request(app)
      .post('/api/v1/core/fiscal/classification/reler-notas')
      .set({ Authorization: `Bearer ${vizinha.body.accessToken}` });
    expect(res.status).toBe(200);
    expect(res.body.notasLidas).toBe(0);
    expect(produtoPorNome(ITEM_NORMAL.nome).fiscal_classification_source).toBeNull();
  });

  it('é gesto da gerência: estoquista e caixa recebem 403', async () => {
    for (const perfil of ['estoquista', 'operador_caixa']) {
      const login = await loginForTest(app, {
        userId: `u-${perfil}`,
        companyId: 'loja-xml-181',
        profileCodes: [perfil],
      });
      const res = await request(app)
        .post('/api/v1/core/fiscal/classification/reler-notas')
        .set({ Authorization: `Bearer ${login.body.accessToken}` });
      expect(res.status, perfil).toBe(403);
    }
  });
});
