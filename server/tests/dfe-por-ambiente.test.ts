/**
 * ============================================================================
 * A DISTRIBUIÇÃO DF-e NUMERA POR AMBIENTE — DFE-AMBIENTE (GAP-PRD-168)
 * ============================================================================
 *
 * O Ambiente Nacional numera os documentos (NSU) POR AMBIENTE: homologação e
 * produção têm sequências separadas, cada uma a partir do 1. A tabela
 * guardava UNIQUE (company_id, nsu) e o cursor era MAX(nsu) da empresa — sem
 * dizer de qual ambiente.
 *
 * O roteiro de go-live manda homologar a Distribuição com notas reais de
 * homologação (NSU 1..N) e depois virar para produção. A primeira consulta de
 * produção partia de ultNSU = N: as notas de produção de NSU ≤ N nunca eram
 * pedidas, e as que viessem com NSU igual a um de homologação eram engolidas
 * pelo INSERT OR IGNORE. Nota de fornecedor perdida, sem aviso — e a lista, a
 * importação e a manifestação misturavam os dois ambientes.
 *
 * O transporte do adapter real é trocado por um espião (`enviar`) que faz o
 * papel das DUAS SEFAZ: cada uma com as suas notas de NSU 1 a 3. Nada sai.
 *
 * ## Como fica vermelho
 *
 *  - volte o cursor a MAX(nsu) da empresa e a primeira consulta de produção
 *    parte de 3 — as três notas de produção nunca chegam;
 *  - volte o UNIQUE a (company_id, nsu) e as notas de produção de NSU 1..3
 *    são engolidas pelo INSERT OR IGNORE;
 *  - tire o filtro de ambiente da lista e a produção mostra a homologação;
 *  - tire a recusa e o documento de homologação é manifestado e importado em
 *    produção.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { gzipSync } from 'node:zlib';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { updateFiscalConfig } from '../src/services/core/FiscalConfigService.js';
import { upsertCertificateA1 } from '../src/services/fiscal/FiscalCertificateService.js';
import { SefazRealAdapter } from '../src/services/core/SefazRealAdapter.js';
import { loginForTest } from './helpers/auth.js';
import { gerarCertificado } from './helpers/certificado.js';
import { grupoTributarioPadrao } from './helpers/grupoTributario.js';

process.env.DEVORA_API_ENV = 'test';

const app = createApp();

const CNPJ = '11222333000181';
const SENHA = 'Senha@DoCofreAmb';
const FORNECEDOR = '14200166000187';

type Ambiente = 'homologation' | 'production';

/** Chave de 44 dígitos distinta por ambiente e número. */
function chave(ambiente: Ambiente, n: number): string {
  const numero = String((ambiente === 'homologation' ? 100 : 200) + n).padStart(9, '0');
  return `432609${FORNECEDOR}55001${numero}1${String(n).padStart(8, '0')}5`;
}

function nomeDoFornecedor(ambiente: Ambiente, n: number): string {
  return `${ambiente === 'homologation' ? 'Fornecedor Homologacao' : 'Fornecedor Producao'} ${n}`;
}

let pfx: string;
let empresa: string;
let auth: { Authorization: string };
let transmitidos: { url: string; servico: string; dados: string }[];

function resumo(ambiente: Ambiente, n: number): string {
  return (
    '<resNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01">'
    + `<chNFe>${chave(ambiente, n)}</chNFe><CNPJ>${FORNECEDOR}</CNPJ><xNome>${nomeDoFornecedor(ambiente, n)}</xNome>`
    + `<IE>123456789</IE><dhEmi>2026-09-0${n}T10:00:00-03:00</dhEmi><tpNF>1</tpNF><vNF>${n}00.00</vNF>`
    + '<digVal>abc=</digVal><dhRecbto>2026-09-10T10:00:05-03:00</dhRecbto>'
    + '<nProt>143260000009999</nProt><cSitNFe>1</cSitNFe></resNFe>'
  );
}

/** A nota COMPLETA que a ciência libera — parseável pelo funil de importação. */
function notaCompleta(ambiente: Ambiente, accessKey: string): string {
  const tpAmb = ambiente === 'production' ? '1' : '2';
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<nfeProc versao="4.00" xmlns="http://www.portalfiscal.inf.br/nfe">',
    '<NFe>',
    `<infNFe Id="NFe${accessKey}" versao="4.00">`,
    `<ide><nNF>101</nNF><serie>1</serie><dhEmi>2026-09-01T09:00:00-03:00</dhEmi><tpAmb>${tpAmb}</tpAmb></ide>`,
    `<emit><CNPJ>${FORNECEDOR}</CNPJ><xNome>Fornecedor de Ensaio</xNome></emit>`,
    '<det nItem="1"><prod>',
    '<cProd>AMB-1</cProd><cEAN>SEM GTIN</cEAN><xProd>Mercadoria de homologacao</xProd>',
    '<NCM>85076000</NCM><CFOP>5102</CFOP><uCom>UN</uCom>',
    '<qCom>1</qCom><vUnCom>100.00</vUnCom><vProd>100.00</vProd>',
    '</prod></det>',
    '<total><ICMSTot><vNF>100.00</vNF></ICMSTot></total>',
    '</infNFe>',
    '</NFe>',
    /*
      O PROTOCOLO QUE A SEFAZ DEVOLVE JUNTO (B-estoque-entrada-M02).

      Este arquivo nasceu sem `protNFe`. O comportamento MUDOU de propósito:
      com a empresa em produção, a importação passou a exigir o protocolo de
      autorização (cStat 100 e a chave do protocolo igual à da nota) — e o
      procNFe que a Distribuição DF-e entrega de verdade sempre o traz. Sem
      ele, a nota de produção deste caso seria recusada pelo motivo errado.
    */
    `<protNFe><infProt><tpAmb>${tpAmb}</tpAmb><chNFe>${accessKey}</chNFe><cStat>100</cStat>`
      + '<xMotivo>Autorizado o uso da NF-e</xMotivo><nProt>143260000009999</nProt></infProt></protNFe>',
    '</nfeProc>',
  ].join('');
}

function docZip(nsu: number, schema: string, xml: string): string {
  const zip = gzipSync(Buffer.from(xml, 'utf8')).toString('base64');
  return `<docZip NSU="${String(nsu).padStart(15, '0')}" schema="${schema}_v1.01.xsd">${zip}</docZip>`;
}

/**
 * As DUAS SEFAZ do Ambiente Nacional, cada uma com a sua numeração: três
 * notas de NSU 1, 2 e 3 em homologação, e outras três de NSU 1, 2 e 3 em
 * produção. A consulta por NSU devolve o que passa do `ultNSU` pedido.
 */
function sefazDoAmbienteNacional(dados: string): string {
  const ambiente: Ambiente = /<tpAmb>1<\/tpAmb>/.test(dados) ? 'production' : 'homologation';
  const tpAmb = ambiente === 'production' ? '1' : '2';
  const cabeca = `<retDistDFeInt versao="1.01" xmlns="http://www.portalfiscal.inf.br/nfe"><tpAmb>${tpAmb}</tpAmb>`;
  const porChave = /<consChNFe><chNFe>(\d{44})<\/chNFe><\/consChNFe>/.exec(dados)?.[1];
  if (porChave) {
    return (
      `${cabeca}<cStat>138</cStat><xMotivo>Documento localizado</xMotivo>`
      + '<ultNSU>000000000000000</ultNSU><maxNSU>000000000000003</maxNSU>'
      + `<loteDistDFeInt>${docZip(9, 'procNFe', notaCompleta(ambiente, porChave))}</loteDistDFeInt></retDistDFeInt>`
    );
  }
  const ult = Number(/<ultNSU>(\d+)<\/ultNSU>/.exec(dados)?.[1] ?? '0');
  const novos = [1, 2, 3].filter((n) => n > ult);
  if (novos.length === 0) {
    return (
      `${cabeca}<cStat>137</cStat><xMotivo>Nenhum documento localizado</xMotivo>`
      + '<ultNSU>000000000000003</ultNSU><maxNSU>000000000000003</maxNSU></retDistDFeInt>'
    );
  }
  return (
    `${cabeca}<cStat>138</cStat><xMotivo>Documento localizado</xMotivo>`
    + '<ultNSU>000000000000003</ultNSU><maxNSU>000000000000003</maxNSU>'
    + `<loteDistDFeInt>${novos.map((n) => docZip(n, 'resNFe', resumo(ambiente, n))).join('')}</loteDistDFeInt>`
    + '</retDistDFeInt>'
  );
}

function respostaDoEvento(dados: string): string {
  const ch = /<chNFe>(\d{44})<\/chNFe>/.exec(dados)?.[1] ?? '';
  const tp = /<tpEvento>(\d+)<\/tpEvento>/.exec(dados)?.[1] ?? '';
  const tpAmb = /<tpAmb>(\d)<\/tpAmb>/.exec(dados)?.[1] ?? '2';
  return (
    '<retEnvEvento versao="1.00" xmlns="http://www.portalfiscal.inf.br/nfe"><idLote>1</idLote>'
    + `<tpAmb>${tpAmb}</tpAmb><cOrgao>91</cOrgao><cStat>128</cStat><xMotivo>Lote de Evento Processado</xMotivo>`
    + `<retEvento versao="1.00"><infEvento Id="ID191260000000700"><tpAmb>${tpAmb}</tpAmb><cOrgao>91</cOrgao>`
    + '<cStat>135</cStat><xMotivo>Evento registrado e vinculado a NF-e</xMotivo>'
    + `<chNFe>${ch}</chNFe><tpEvento>${tp}</tpEvento><nSeqEvento>1</nSeqEvento>`
    + '<dhRegEvento>2026-09-11T10:15:40-03:00</dhRegEvento><nProt>191260000000700</nProt>'
    + '</infEvento></retEvento></retEnvEvento>'
  );
}

function virar(ambiente: Ambiente): void {
  getConnection()
    .prepare('UPDATE core_fiscal_configs SET environment = ? WHERE company_id = ?')
    .run(ambiente, empresa);
}

function consultar() {
  return request(app).post('/api/v1/core/purchases/dfe/consultar').set(auth).send({});
}

/** A hora de espera da SEFAZ passou (R3-DFE): o relógio do teste não anda. */
function passarAHora(): void {
  getConnection()
    .prepare('UPDATE core_dfe_cursors SET next_query_at = ? WHERE company_id = ?')
    .run(new Date(Date.now() - 60_000).toISOString(), empresa);
}

function listar() {
  return request(app).get('/api/v1/core/purchases/dfe').set(auth);
}

function manifestar(accessKey: string, tipo = 'ciencia') {
  return request(app).post(`/api/v1/core/purchases/dfe/${accessKey}/manifestar`).set(auth).send({ tipo });
}

function importar(accessKey: string) {
  return request(app).post(`/api/v1/core/purchases/dfe/${accessKey}/importar`).set(auth).send({});
}

function documentos(): { nsu: string; access_key: string; environment?: string }[] {
  return getConnection()
    .prepare('SELECT * FROM core_dfe_documents WHERE company_id = ? ORDER BY access_key')
    .all(empresa) as never[];
}

function ultNsuPedido(t: { dados: string }): string | null {
  return /<ultNSU>(\d+)<\/ultNSU>/.exec(t.dados)?.[1] ?? null;
}

function eventosDfe(): string[] {
  return (
    getConnection()
      .prepare("SELECT event_type FROM core_fiscal_events WHERE company_id = ? AND event_type LIKE 'dfe_%'")
      .all(empresa) as { event_type: string }[]
  ).map((e) => e.event_type);
}

function notasNoFunil(): number {
  return (
    getConnection().prepare('SELECT COUNT(*) AS n FROM core_inbound_notes WHERE company_id = ?').get(empresa) as {
      n: number;
    }
  ).n;
}

/** A homologação que o roteiro de go-live manda fazer: NSU 1..3, e a ciência da primeira. */
async function homologar(): Promise<void> {
  const r = await consultar();
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(r.body.novos).toBe(3);
  const c = await manifestar(chave('homologation', 1));
  expect(c.status, JSON.stringify(c.body)).toBe(200);
}

beforeAll(() => {
  pfx = gerarCertificado(`LOJA AMBIENTE LTDA:${CNPJ}`, SENHA);
});

beforeEach(async () => {
  resetDbForTests();
  const res = await loginForTest(app, { userId: 'gerente-amb', companyId: 'loja-amb', profileCodes: ['gerente_loja'] });
  expect(res.status).toBe(200);
  auth = { Authorization: `Bearer ${res.body.accessToken}` };
  empresa = res.body.company.id;
  updateFiscalConfig({
    companyId: empresa,
    patch: {
      legalName: 'Loja Ambiente Ltda',
      cnpj: '11.222.333/0001-81',
      ie: '123456789',
      crt: '1',
      street: 'Av. Central',
      number: '100',
      district: 'Centro',
      cityName: 'Pelotas',
      cityIbge: '4314407',
      zip: '96010000',
      uf: 'RS',
    },
  });
  grupoTributarioPadrao(empresa);
  upsertCertificateA1({ companyId: empresa, operationalUnitId: 'unit-default', pfxBase64: pfx, password: SENHA });

  transmitidos = [];
  vi.spyOn(
    SefazRealAdapter.prototype as unknown as {
      enviar: (url: string, servico: string, dados: string) => Promise<string>;
    },
    'enviar',
  ).mockImplementation(async (url: string, servico: string, dados: string) => {
    transmitidos.push({ url, servico, dados });
    return servico === 'dist' ? sefazDoAmbienteNacional(dados) : respostaDoEvento(dados);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('o cursor NSU é por (empresa, ambiente)', () => {
  it('homologação com NSU 1..3, virada para produção: a primeira consulta de produção parte de 0 e grava as notas de produção de NSU 1..3', async () => {
    await homologar();
    virar('production');
    transmitidos = [];

    const res = await consultar();

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const pedido = transmitidos.find((t) => t.servico === 'dist')!;
    expect(pedido.url).toBe('https://www1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx');
    expect(pedido.dados).toContain('<tpAmb>1</tpAmb>');
    // O cursor de produção não herda o NSU 3 da homologação.
    expect(ultNsuPedido(pedido)).toBe('000000000000000');
    expect(res.body.novos).toBe(3);

    // As seis notas convivem: NSU 1..3 em cada ambiente, cada uma com o seu.
    const todos = documentos();
    expect(todos).toHaveLength(6);
    const producao = todos.filter((d) => d.environment === 'production');
    expect(producao.map((d) => d.access_key).sort()).toEqual([1, 2, 3].map((n) => chave('production', n)).sort());
    expect(producao.map((d) => d.nsu).sort()).toEqual(['1', '2', '3']);
    expect(todos.filter((d) => d.environment === 'homologation').map((d) => d.access_key).sort()).toEqual(
      [1, 2, 3].map((n) => chave('homologation', n)).sort(),
    );
  });

  it('reconsultar em produção é idempotente, e a volta para homologação continua do cursor DELA', async () => {
    await homologar();
    virar('production');
    expect((await consultar()).body.novos).toBe(3);
    transmitidos = [];

    /*
      A SEFAZ devolveu ultNSU = maxNSU: em dia. Pela NT 2014.002, a próxima
      consulta só depois de uma hora — a imediata é recusada sem sair (R3-DFE,
      `dfe-cursor-da-sefaz`). Passada a hora, reconsultar é idempotente.
    */
    const cedo = await consultar();
    expect(cedo.status).toBe(409);
    expect(cedo.body.error.code).toBe('CORE_DFE_AGUARDE_A_SEFAZ');
    expect(transmitidos).toEqual([]);
    passarAHora();

    const denovo = await consultar();
    expect(denovo.status).toBe(200);
    expect(denovo.body.novos).toBe(0);
    expect(ultNsuPedido(transmitidos[0])).toBe('000000000000003');

    virar('homologation');
    passarAHora();
    transmitidos = [];
    const naHomologacao = await consultar();
    expect(naHomologacao.status).toBe(200);
    expect(naHomologacao.body.novos).toBe(0);
    expect(transmitidos[0].dados).toContain('<tpAmb>2</tpAmb>');
    expect(ultNsuPedido(transmitidos[0])).toBe('000000000000003');
    expect(documentos()).toHaveLength(6);
  });
});

describe('a Entrada de Notas mostra o ambiente atual — o outro não se mistura', () => {
  it('em produção a lista não traz as notas de homologação, e diz quantas ficaram fora', async () => {
    await homologar();
    virar('production');
    expect((await consultar()).status).toBe(200);

    const res = await listar();

    expect(res.status).toBe(200);
    const nomes = (res.body.items as { supplierName: string }[]).map((d) => d.supplierName).sort();
    expect(nomes).toEqual([1, 2, 3].map((n) => nomeDoFornecedor('production', n)).sort());
    expect((res.body.items as { ambiente: string }[]).every((d) => d.ambiente === 'production')).toBe(true);
    expect(res.body.ambiente).toBe('production');
    expect(res.body.outroAmbiente).toEqual({ ambiente: 'homologation', total: 3 });
  });

  it('virando para produção antes de consultar, a lista fica vazia — a homologação não aparece como se fosse produção', async () => {
    await homologar();
    virar('production');

    const res = await listar();

    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.outroAmbiente).toEqual({ ambiente: 'homologation', total: 3 });
  });
});

describe('manifestar ou importar documento de OUTRO ambiente é recusado', () => {
  it('manifestar em produção a nota de homologação: 409 com o porquê, e nada transmitido nem gravado', async () => {
    await homologar();
    virar('production');
    transmitidos = [];
    const eventosAntes = eventosDfe();

    const res = await manifestar(chave('homologation', 2), 'confirmacao');

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe('CORE_DFE_OUTRO_AMBIENTE');
    expect(res.body.error.message).toMatch(/homologação/);
    expect(res.body.error.message).toMatch(/produção/);
    expect(transmitidos).toEqual([]);
    expect(eventosDfe()).toEqual(eventosAntes);
    const doc = documentos().find((d) => d.access_key === chave('homologation', 2)) as unknown as {
      manifest_status: string | null;
    };
    expect(doc.manifest_status).toBeNull();
  });

  it('o clique repetido numa nota de homologação já manifestada também é recusado em produção — não finge sucesso', async () => {
    await homologar();
    virar('production');
    transmitidos = [];

    const res = await manifestar(chave('homologation', 1), 'ciencia');

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CORE_DFE_OUTRO_AMBIENTE');
    expect(transmitidos).toEqual([]);
  });

  it('importar em produção a nota COMPLETA de homologação: 409, e nada entra no funil de conferência', async () => {
    await homologar();
    const completo = documentos().find((d) => d.access_key === chave('homologation', 1)) as unknown as {
      schema_type: string;
    };
    expect(completo.schema_type).toBe('procNFe');
    virar('production');

    const res = await importar(chave('homologation', 1));

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe('CORE_DFE_OUTRO_AMBIENTE');
    expect(res.body.error.message).toMatch(/homologação/);
    expect(notasNoFunil()).toBe(0);
  });

  it('o inverso também: nota de produção com a empresa de volta em homologação não se manifesta nem se importa', async () => {
    virar('production');
    expect((await consultar()).body.novos).toBe(3);
    expect((await manifestar(chave('production', 1))).status).toBe(200);
    virar('homologation');
    transmitidos = [];

    const m = await manifestar(chave('production', 2), 'confirmacao');
    expect(m.status).toBe(409);
    expect(m.body.error.code).toBe('CORE_DFE_OUTRO_AMBIENTE');
    const i = await importar(chave('production', 1));
    expect(i.status).toBe(409);
    expect(i.body.error.code).toBe('CORE_DFE_OUTRO_AMBIENTE');
    expect(transmitidos).toEqual([]);
    expect(notasNoFunil()).toBe(0);
  });

  it('no MESMO ambiente, o caminho continua: a nota de produção se importa em produção', async () => {
    virar('production');
    expect((await consultar()).body.novos).toBe(3);
    expect((await manifestar(chave('production', 1))).status).toBe(200);

    const res = await importar(chave('production', 1));

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(notasNoFunil()).toBe(1);
  });
});
