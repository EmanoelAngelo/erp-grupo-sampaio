/**
 * ============================================================================
 * A CONSULTA E A MANIFESTAÇÃO DF-e PASSAM PELA POLÍTICA DOS ATOS — GAP-PRD-168
 * ============================================================================
 *
 * A ficha diz: "com credencial IMAP e certificado A1 configurados, notas chegam
 * sem código novo". A reauditoria mostrou que a metade DF-e não se sustentava:
 * com o A1 no cofre, a tela mandava `{}` para consultar e `{tipo}` para
 * manifestar, e o adapter da Distribuição (`adapterRealOuSimulador`) só abria
 * o certificado com `certificatePassword` no corpo — que nenhuma tela manda.
 * Resultado: em produção, 400 "informe a senha" num botão sem campo de senha;
 * em homologação, o SIMULADOR respondia mesmo com o A1 guardado, e a
 * homologação real da Distribuição era impossível pela tela.
 *
 * Agora a consulta e a manifestação decidem pela MESMA política dos atos
 * administrativos (`adapterDoAtoFiscal`, `FiscalAtosAdministrativos.ts`):
 *
 *  - política COFRE (padrão): o adapter real abre o A1 com a senha selada da
 *    empresa do token, sem pedir nada ao navegador;
 *  - política "cada ato pede a senha": sem `certificatePassword`, 400 dizendo
 *    o que fazer; com a senha certa, passa;
 *  - sem A1 no cofre: 409 dizendo onde enviá-lo — nem simulador, nem 500;
 *  - o simulador só por pedido explícito (`developmentMode`), e nunca em
 *    produção.
 *
 * O transporte do adapter real é trocado por um espião (`enviar`): o XML é
 * montado e ASSINADO de verdade com o A1 do cofre, e nenhum byte sai daqui.
 *
 * ## Como fica vermelho
 *
 *  - volte o `fiscalAdapter` da rota a `adapterRealOuSimulador` e a consulta
 *    pelo cofre vira 400 em produção (e simulador em homologação);
 *  - ignore a política no DF-e e o caso "pede a senha" responde 200 sem ela;
 *  - abra o A1 por outra empresa e o caso do tenant fica vermelho.
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
import { gravarPoliticaDosAtos } from '../src/services/core/FiscalAtosAdministrativos.js';
import { loginForTest } from './helpers/auth.js';
import { gerarCertificado } from './helpers/certificado.js';
import { grupoTributarioPadrao } from './helpers/grupoTributario.js';

process.env.DEVORA_API_ENV = 'test';

const app = createApp();

const CNPJ_A = '11222333000181';
const CNPJ_B = '11444777000161';
const SENHA_A = 'Senha@DoCofreA1';
const SENHA_B = 'Senha@DoCofreB2';
const FORNECEDOR = '14200166000187';
const CHAVE = `432609${FORNECEDOR}55001000001234100001234` + '5';

let pfxA: string;
let pfxB: string;
let empresaA: string;
let empresaB: string;
let gerenteA: { Authorization: string };
let gerenteB: { Authorization: string };
let transmitidos: { url: string; servico: string; dados: string }[];
const nodeEnvOriginal = process.env.NODE_ENV;

function configurar(companyId: string, cnpj: string, nome: string): void {
  updateFiscalConfig({
    companyId,
    patch: {
      legalName: nome,
      cnpj,
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
  grupoTributarioPadrao(companyId);
}

function selar(companyId: string, pfx: string, senha: string): void {
  upsertCertificateA1({ companyId, operationalUnitId: 'unit-default', pfxBase64: pfx, password: senha });
}

function virarProducao(companyId: string): void {
  getConnection()
    .prepare("UPDATE core_fiscal_configs SET environment = 'production' WHERE company_id = ?")
    .run(companyId);
}

function documentos(companyId: string): { access_key: string | null; manifest_status: string | null; manifest_protocol: string | null }[] {
  return getConnection()
    .prepare('SELECT access_key, manifest_status, manifest_protocol FROM core_dfe_documents WHERE company_id = ?')
    .all(companyId) as never[];
}

function eventosDfe(companyId: string): string[] {
  return (
    getConnection()
      .prepare("SELECT event_type FROM core_fiscal_events WHERE company_id = ? AND event_type LIKE 'dfe_%'")
      .all(companyId) as { event_type: string }[]
  ).map((e) => e.event_type);
}

/** O resumo que a SEFAZ entrega pela Distribuição, dentro do docZip (gzip+base64). */
function loteDaDistribuicao(dados: string): string {
  if (dados.includes('<consChNFe>')) {
    return (
      '<retDistDFeInt versao="1.01" xmlns="http://www.portalfiscal.inf.br/nfe"><tpAmb>2</tpAmb>'
      + '<cStat>137</cStat><xMotivo>Nenhum documento localizado</xMotivo>'
      + '<ultNSU>000000000000001</ultNSU><maxNSU>000000000000001</maxNSU></retDistDFeInt>'
    );
  }
  const resumo =
    '<resNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01">'
    + `<chNFe>${CHAVE}</chNFe><CNPJ>${FORNECEDOR}</CNPJ><xNome>Distribuidora Real Ltda</xNome>`
    + '<IE>123456789</IE><dhEmi>2026-09-10T10:00:00-03:00</dhEmi><tpNF>1</tpNF><vNF>150.00</vNF>'
    + '<digVal>abc=</digVal><dhRecbto>2026-09-10T10:00:05-03:00</dhRecbto>'
    + '<nProt>143260000009999</nProt><cSitNFe>1</cSitNFe></resNFe>';
  const zip = gzipSync(Buffer.from(resumo, 'utf8')).toString('base64');
  return (
    '<retDistDFeInt versao="1.01" xmlns="http://www.portalfiscal.inf.br/nfe"><tpAmb>2</tpAmb>'
    + '<cStat>138</cStat><xMotivo>Documento localizado</xMotivo>'
    + '<ultNSU>000000000000001</ultNSU><maxNSU>000000000000001</maxNSU>'
    + `<loteDistDFeInt><docZip NSU="000000000000001" schema="resNFe_v1.01.xsd">${zip}</docZip></loteDistDFeInt>`
    + '</retDistDFeInt>'
  );
}

function respostaDoEvento(dados: string): string {
  const ch = /<chNFe>(\d{44})<\/chNFe>/.exec(dados)?.[1] ?? '';
  const tp = /<tpEvento>(\d+)<\/tpEvento>/.exec(dados)?.[1] ?? '';
  return (
    '<retEnvEvento versao="1.00" xmlns="http://www.portalfiscal.inf.br/nfe"><idLote>1</idLote>'
    + '<tpAmb>2</tpAmb><cOrgao>91</cOrgao><cStat>128</cStat><xMotivo>Lote de Evento Processado</xMotivo>'
    + '<retEvento versao="1.00"><infEvento Id="ID191260000000500"><tpAmb>2</tpAmb><cOrgao>91</cOrgao>'
    + '<cStat>135</cStat><xMotivo>Evento registrado e vinculado a NF-e</xMotivo>'
    + `<chNFe>${ch}</chNFe><tpEvento>${tp}</tpEvento><nSeqEvento>1</nSeqEvento>`
    + '<dhRegEvento>2026-09-11T10:15:40-03:00</dhRegEvento><nProt>191260000000500</nProt>'
    + '</infEvento></retEvento></retEnvEvento>'
  );
}

async function gerente(companyId: string, userId: string) {
  const res = await loginForTest(app, { userId, companyId, profileCodes: ['gerente_loja'] });
  expect(res.status).toBe(200);
  return { auth: { Authorization: `Bearer ${res.body.accessToken}` }, id: res.body.company.id as string };
}

function consultar(auth: { Authorization: string }, corpo: Record<string, unknown> = {}) {
  return request(app).post('/api/v1/core/purchases/dfe/consultar').set(auth).send(corpo);
}

function manifestar(auth: { Authorization: string }, corpo: Record<string, unknown>) {
  return request(app).post(`/api/v1/core/purchases/dfe/${CHAVE}/manifestar`).set(auth).send(corpo);
}

beforeAll(() => {
  pfxA = gerarCertificado(`LOJA A LTDA:${CNPJ_A}`, SENHA_A);
  pfxB = gerarCertificado(`LOJA B LTDA:${CNPJ_B}`, SENHA_B);
});

beforeEach(async () => {
  resetDbForTests();
  const a = await gerente('loja-a', 'gerente-a');
  const b = await gerente('loja-b', 'gerente-b');
  gerenteA = a.auth;
  gerenteB = b.auth;
  empresaA = a.id;
  empresaB = b.id;
  configurar(empresaA, '11.222.333/0001-81', 'Loja A Ltda');
  configurar(empresaB, '11.444.777/0001-61', 'Loja B Ltda');

  transmitidos = [];
  vi.spyOn(
    SefazRealAdapter.prototype as unknown as {
      enviar: (url: string, servico: string, dados: string) => Promise<string>;
    },
    'enviar',
  ).mockImplementation(async (url: string, servico: string, dados: string) => {
    transmitidos.push({ url, servico, dados });
    return servico === 'dist' ? loteDaDistribuicao(dados) : respostaDoEvento(dados);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env.DEVORA_API_ENV = 'test';
  if (nodeEnvOriginal === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = nodeEnvOriginal;
});

describe('política COFRE (padrão): o A1 selado da empresa, sem pedir nada', () => {
  it('em PRODUÇÃO, a consulta vai ao Ambiente Nacional de produção com o corpo que a tela manda ({})', async () => {
    selar(empresaA, pfxA, SENHA_A);
    virarProducao(empresaA);

    const res = await consultar(gerenteA);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.novos).toBe(1);
    expect(transmitidos).toHaveLength(1);
    expect(transmitidos[0].servico).toBe('dist');
    expect(transmitidos[0].url).toBe('https://www1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx');
    expect(transmitidos[0].dados).toContain('<tpAmb>1</tpAmb>');
    expect(transmitidos[0].dados).toContain(`<CNPJ>${CNPJ_A}</CNPJ>`);
    expect(documentos(empresaA).map((d) => d.access_key)).toEqual([CHAVE]);
  });

  it('em PRODUÇÃO, a manifestação sai ASSINADA pelo A1 do cofre, com o protocolo da SEFAZ', async () => {
    selar(empresaA, pfxA, SENHA_A);
    virarProducao(empresaA);
    expect((await consultar(gerenteA)).status).toBe(200);

    const res = await manifestar(gerenteA, { tipo: 'ciencia' });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.protocol).toBe('191260000000500');
    const evento = transmitidos.find((t) => t.servico === 'evento')!;
    expect(evento.url).toBe('https://www1.nfe.fazenda.gov.br/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx');
    expect(evento.dados).toContain('<tpEvento>210210</tpEvento>');
    expect(evento.dados).toContain('<tpAmb>1</tpAmb>');
    expect(evento.dados).toContain('<Signature');
    // Na manifestação o autor é o destinatário — a empresa do token, dona do A1.
    expect(evento.dados).toContain(`<CNPJ>${CNPJ_A}</CNPJ>`);
    expect(documentos(empresaA)[0]).toMatchObject({ manifest_status: 'ciencia', manifest_protocol: '191260000000500' });
  });

  it('com NODE_ENV=production no processo, o caminho é o mesmo: o cofre, e não o simulador', async () => {
    selar(empresaA, pfxA, SENHA_A);
    process.env.NODE_ENV = 'production';

    const res = await consultar(gerenteA);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(transmitidos).toHaveLength(1);
    expect(transmitidos[0].url).toContain('https://hom1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/');
  });

  it('em homologação, com o A1 guardado, é a SEFAZ de homologação — não mais o simulador', async () => {
    selar(empresaA, pfxA, SENHA_A);
    const res = await consultar(gerenteA);
    expect(res.status).toBe(200);
    expect(transmitidos).toHaveLength(1);
    expect(transmitidos[0].url).toBe('https://hom1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx');
    expect(transmitidos[0].dados).toContain('<tpAmb>2</tpAmb>');
  });

  it('a lista do radar diz à tela o caminho: SEFAZ pelo cofre, senha dispensada', async () => {
    selar(empresaA, pfxA, SENHA_A);
    const res = await request(app).get('/api/v1/core/purchases/dfe').set(gerenteA);
    expect(res.status).toBe(200);
    expect(res.body.plano).toMatchObject({
      caminho: 'SEFAZ',
      senha: 'OPCIONAL',
      cofre: 'SELADO',
      politica: { exigirSenhaDigitada: false },
    });
  });

  it('sem A1 no cofre: 409 dizendo onde enviá-lo — nem simulador, nem 500, e nada gravado', async () => {
    const res = await consultar(gerenteA);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CORE_SEFAZ_CERTIFICATE_MISSING');
    expect(res.body.error.message).toMatch(/Fiscal › Certificado/);
    expect(documentos(empresaA)).toHaveLength(0);
    expect(transmitidos).toHaveLength(0);

    const lista = await request(app).get('/api/v1/core/purchases/dfe').set(gerenteA);
    expect(lista.body.plano).toMatchObject({ caminho: 'BLOQUEADO', codigo: 'CORE_SEFAZ_CERTIFICATE_MISSING' });
  });
});

describe('política "cada ato pede a senha"', () => {
  beforeEach(() => {
    selar(empresaA, pfxA, SENHA_A);
    gravarPoliticaDosAtos({ companyId: empresaA, exigirSenhaDigitada: true, userId: null });
  });

  it('consultar sem a senha: 400 dizendo o que fazer; com a senha certa, vai à SEFAZ', async () => {
    const lista = await request(app).get('/api/v1/core/purchases/dfe').set(gerenteA);
    expect(lista.body.plano).toMatchObject({ caminho: 'SEFAZ', senha: 'OBRIGATORIA' });

    const sem = await consultar(gerenteA);
    expect(sem.status).toBe(400);
    expect(sem.body.error.code).toBe('CORE_SEFAZ_CERTIFICATE_PASSWORD_REQUIRED');
    expect(sem.body.error.message).toMatch(/Digite a senha do certificado/);
    expect(sem.body.error.message).toMatch(/consulta e manifesta/);
    expect(transmitidos).toHaveLength(0);
    expect(documentos(empresaA)).toHaveLength(0);

    const errada = await consultar(gerenteA, { certificatePassword: 'nao-e-esta' });
    expect(errada.status).toBeGreaterThanOrEqual(400);
    expect(transmitidos).toHaveLength(0);

    const com = await consultar(gerenteA, { certificatePassword: SENHA_A });
    expect(com.status, JSON.stringify(com.body)).toBe(200);
    expect(com.body.novos).toBe(1);
    expect(transmitidos).toHaveLength(1);
  });

  it('manifestar sem a senha: 400 e NENHUM evento; com a senha, o evento assinado e o protocolo', async () => {
    expect((await consultar(gerenteA, { certificatePassword: SENHA_A })).status).toBe(200);

    const sem = await manifestar(gerenteA, { tipo: 'confirmacao' });
    expect(sem.status).toBe(400);
    expect(sem.body.error.code).toBe('CORE_SEFAZ_CERTIFICATE_PASSWORD_REQUIRED');
    expect(eventosDfe(empresaA)).toEqual([]);
    expect(documentos(empresaA)[0].manifest_status).toBeNull();

    const com = await manifestar(gerenteA, { tipo: 'confirmacao', certificatePassword: SENHA_A });
    expect(com.status, JSON.stringify(com.body)).toBe(200);
    expect(transmitidos.find((t) => t.servico === 'evento')!.dados).toContain('<tpEvento>210200</tpEvento>');
    expect(documentos(empresaA)[0].manifest_status).toBe('confirmacao');
  });

  it('as validações da manifestação respondem ANTES de pedir o certificado', async () => {
    expect((await consultar(gerenteA, { certificatePassword: SENHA_A })).status).toBe(200);
    const curta = await manifestar(gerenteA, { tipo: 'nao_realizada', justification: 'curta' });
    expect(curta.status).toBe(400);
    expect(curta.body.error.code).toBe('CORE_DFE_JUSTIFICATION_REQUIRED');
  });
});

describe('o A1, a senha e a política são os da empresa do TOKEN', () => {
  it('o A1 de outra empresa não serve, e a política de uma não vale para a outra', async () => {
    // Só a B tem certificado — e a B pede a senha a cada ato.
    selar(empresaB, pfxB, SENHA_B);
    gravarPoliticaDosAtos({ companyId: empresaB, exigirSenhaDigitada: true, userId: null });

    const semA1 = await consultar(gerenteA);
    expect(semA1.status).toBe(409);
    expect(semA1.body.error.code).toBe('CORE_SEFAZ_CERTIFICATE_MISSING');
    expect(transmitidos).toHaveLength(0);

    // A senha da B no corpo da A não abre certificado nenhum: a A não tem A1.
    const comSenhaDaOutra = await consultar(gerenteA, { certificatePassword: SENHA_B });
    expect(comSenhaDaOutra.status).toBe(409);
    expect(transmitidos).toHaveLength(0);

    // A A ganha o dela: política cofre (a da A), sem senha.
    selar(empresaA, pfxA, SENHA_A);
    expect((await consultar(gerenteA)).status).toBe(200);
    const manifesto = await manifestar(gerenteA, { tipo: 'ciencia' });
    expect(manifesto.status, JSON.stringify(manifesto.body)).toBe(200);
    const evento = transmitidos.find((t) => t.servico === 'evento')!;
    expect(evento.dados).toContain(`<CNPJ>${CNPJ_A}</CNPJ>`);
    expect(evento.dados).not.toContain(CNPJ_B);

    // E a B continua pedindo a senha — a dela, não a da A.
    const bSem = await consultar(gerenteB);
    expect(bSem.status).toBe(400);
    expect(bSem.body.error.code).toBe('CORE_SEFAZ_CERTIFICATE_PASSWORD_REQUIRED');
    const bComSenhaDaA = await consultar(gerenteB, { certificatePassword: SENHA_A });
    expect(bComSenhaDaA.status).toBeGreaterThanOrEqual(400);
    const bCerta = await consultar(gerenteB, { certificatePassword: SENHA_B });
    expect(bCerta.status, JSON.stringify(bCerta.body)).toBe(200);
    expect(transmitidos.at(-1)!.dados).toContain(`<CNPJ>${CNPJ_B}</CNPJ>`);
  });
});

describe('o simulador continua fora de produção', () => {
  it('pedir o simulador numa empresa em produção é 409, e nada entra', async () => {
    virarProducao(empresaA);
    const res = await consultar(gerenteA, { developmentMode: true });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CORE_SEFAZ_TEST_PROVIDER_IN_PRODUCTION');
    expect(documentos(empresaA)).toHaveLength(0);
  });

  it('com NODE_ENV=production, nem pedido o simulador responde', async () => {
    process.env.NODE_ENV = 'production';
    const res = await consultar(gerenteA, { developmentMode: true });
    expect(res.status).toBe(409);
    expect(documentos(empresaA)).toHaveLength(0);
  });

  it('em homologação, o simulador só vem por pedido EXPLÍCITO — e não toca a SEFAZ', async () => {
    const res = await consultar(gerenteA, { developmentMode: true });
    expect(res.status).toBe(200);
    expect(res.body.novos).toBeGreaterThan(0);
    expect(transmitidos).toHaveLength(0);
  });
});

/*
  O ENSAIO ANTIGO NÃO SEGURA A SEFAZ DE VERDADE (GAP-PRD-168, verificação).

  Antes deste conserto, "Buscar agora" em homologação falava com o SIMULADOR
  mesmo com o A1 guardado — a instalação que clicou guarda os dois resumos
  inventados (NSU 1 e 2, "Fornecedor Simulado"). Com o A1 no cofre, a primeira
  consulta de verdade partia do NSU 2 do ensaio, o UNIQUE (company_id, nsu)
  engolia calado as notas reais de NSU 1 e 2, e a lista seguia oferecendo
  manifestar e importar notas que a SEFAZ nunca emitiu.
*/
describe('o ensaio antigo do simulador não segura a SEFAZ de verdade', () => {
  /** O que a tela de antes deixava no banco: a consulta pelo simulador em homologação. */
  async function ensaioAntigo(): Promise<string> {
    expect((await consultar(gerenteA, { developmentMode: true })).status).toBe(200);
    const inventadas = documentos(empresaA).map((d) => d.access_key!);
    expect(inventadas).toHaveLength(2);
    return inventadas[0];
  }

  function notasNoFunil(companyId: string): number {
    return (
      getConnection().prepare('SELECT COUNT(*) AS n FROM core_inbound_notes WHERE company_id = ?').get(companyId) as {
        n: number;
      }
    ).n;
  }

  it('a primeira consulta real parte do começo, a nota real de NSU 1 entra e o ensaio sai da lista', async () => {
    await ensaioAntigo();
    selar(empresaA, pfxA, SENHA_A);

    const res = await consultar(gerenteA);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(transmitidos).toHaveLength(1);
    expect(transmitidos[0].dados).toContain('<ultNSU>000000000000000</ultNSU>');
    expect(documentos(empresaA).map((d) => d.access_key)).toEqual([CHAVE]);
    const lista = await request(app).get('/api/v1/core/purchases/dfe').set(gerenteA);
    expect(lista.body.items.map((d: { supplierName: string }) => d.supplierName)).toEqual(['Distribuidora Real Ltda']);
  });

  it('a manifestação de verdade não sai para uma chave que o simulador inventou', async () => {
    const inventada = await ensaioAntigo();
    selar(empresaA, pfxA, SENHA_A);

    const res = await request(app)
      .post(`/api/v1/core/purchases/dfe/${inventada}/manifestar`)
      .set(gerenteA)
      .send({ tipo: 'ciencia' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CORE_DFE_DOCUMENTO_DO_SIMULADOR');
    expect(res.body.error.message).toMatch(/Buscar agora/);
    expect(transmitidos).toHaveLength(0);
    expect(eventosDfe(empresaA)).toEqual([]);
  });

  it('em produção, a nota completa que o simulador entregou não entra no funil de conferência', async () => {
    const inventada = await ensaioAntigo();
    const ciencia = await request(app)
      .post(`/api/v1/core/purchases/dfe/${inventada}/manifestar`)
      .set(gerenteA)
      .send({ developmentMode: true, tipo: 'ciencia' });
    expect(ciencia.status, JSON.stringify(ciencia.body)).toBe(200);
    virarProducao(empresaA);

    const res = await request(app).post(`/api/v1/core/purchases/dfe/${inventada}/importar`).set(gerenteA).send({});

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CORE_DFE_DOCUMENTO_DO_SIMULADOR');
    expect(notasNoFunil(empresaA)).toBe(0);
  });
});
