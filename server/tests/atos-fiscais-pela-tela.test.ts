/**
 * OS ATOS COM A SEFAZ PELA TELA — GAP-PRD-005 e GAP-PRD-018.
 *
 * ## GAP-PRD-005 — a tela só alcançava o simulador
 *
 * O cliente mandava `developmentMode: true` no cancelamento, na carta de
 * correção e na inutilização, e o servidor escolhia o adapter por essa
 * bandeira. Nenhum caminho de tela chegava à SEFAZ: em homologação a nota
 * real ficava CANCELLED com protocolo `TEST-` e sem procEventoNFe; em produção,
 * 500. Agora o caminho segue a PROCEDÊNCIA da nota, o A1 sai do cofre (ou da
 * senha digitada, pela política do dono) e o evento aceito deixa a prova.
 *
 * ## GAP-PRD-018 — o portão de produção furado
 *
 * Com o servidor fora de `DEVORA_API_ENV=production` (o `.env` do dono não
 * declara a variável), uma operação em PRODUÇÃO cancelava nota de produção
 * com o simulador: `adapterRealOuSimulador` devolvia o simulador sem senha e
 * `selectAdapter` não conferia `real.isReal`. Agora: produção da nota, da
 * operação ou do processo (`DEVORA_API_ENV` ou `NODE_ENV`) — só adapter real.
 *
 * O transporte do adapter real é trocado por um espião (`enviar`): o XML é
 * montado e ASSINADO de verdade, com o A1 do cofre, e nenhum byte sai daqui.
 *
 * ## Como fica vermelho
 *
 *  - volte `developmentMode: true` a valer como escolha do cliente e o caso
 *    "nota real com o corpo antigo da tela" cancela com TEST-;
 *  - volte o slot real a devolver o simulador sem senha e os casos de
 *    produção respondem 200 com protocolo TEST-;
 *  - tire a conferência de `real.isReal` do `selectAdapter` e o caso unitário
 *    fica vermelho.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import {
  linkUserToCompany,
  upsertCompany,
  upsertUser,
} from '../src/services/auth/IdentityService.js';
import { updateFiscalConfig } from '../src/services/core/FiscalConfigService.js';
import { setSeriesNextNumber } from '../src/services/core/FiscalKeyService.js';
import { upsertCertificateA1 } from '../src/services/fiscal/FiscalCertificateService.js';
import { SefazRealAdapter } from '../src/services/core/SefazRealAdapter.js';
import { adapterDoAtoFiscal } from '../src/services/core/FiscalAtosAdministrativos.js';
import { SefazTestAdapter } from '../src/services/core/SefazTestAdapter.js';
import { selectAdapter } from '../src/services/core/SefazAdapter.js';
import { getDocument } from '../src/services/core/FiscalDocumentService.js';
import { requestCancel, requestVoidRange } from '../src/services/core/FiscalEventsService.js';
import { gerarCertificado } from './helpers/certificado.js';

process.env.DEVORA_API_ENV = 'test';

const app = createApp();
const SENHA_LOGIN = 'Teste@Atos2026';
const SENHA_A1 = 'Senha@DoCofre1';
const CNPJ = '11222333000181';
const JUST = 'Venda digitada em duplicidade no caixa';

let pfx: string;
let empresa: string;
let gerente: { Authorization: string };
let dono: { Authorization: string };
let transmitidos: { url: string; servico: string; dados: string }[];

async function ator(login: string, perfil: string) {
  const id = await upsertUser({ login, displayName: login, password: SENHA_LOGIN });
  linkUserToCompany(id, empresa, perfil, true);
  const res = await request(app).post('/api/v1/auth/login').send({ login, password: SENHA_LOGIN });
  expect(res.status).toBe(200);
  return { Authorization: `Bearer ${res.body.accessToken}` };
}

function chave(modelo: '55' | '65', numero: number): string {
  const corpo = `432609${CNPJ}${modelo}001${String(numero).padStart(9, '0')}1${String(numero).padStart(8, '0')}`;
  return `${corpo}${numero % 10}`;
}

/** Nota AUTORIZADA gravada direto no banco — o que importa aqui é o ato sobre ela. */
function notaAutorizada(input: {
  modelo: '55' | '65';
  numero: number;
  protocolo: string;
  ambiente?: 'homologation' | 'production';
}): string {
  ensureCoreSchema();
  const id = `doc-${input.modelo}-${input.numero}`;
  const agora = new Date().toISOString();
  getConnection()
    .prepare(
      `INSERT INTO core_fiscal_documents
         (id, company_id, sale_id, model, serie, number, access_key, environment, status,
          protocol, c_stat, x_motivo, issued_at, authorized_at, created_at, updated_at)
       VALUES (?, ?, NULL, ?, 1, ?, ?, ?, 'AUTHORIZED', ?, '100', 'Autorizado o uso', ?, ?, ?, ?)`,
    )
    .run(
      id,
      empresa,
      input.modelo,
      input.numero,
      chave(input.modelo, input.numero),
      input.ambiente ?? 'homologation',
      input.protocolo,
      agora,
      agora,
      agora,
      agora,
    );
  return id;
}

function selarCertificado(): void {
  upsertCertificateA1({ companyId: empresa, operationalUnitId: 'unit-default', pfxBase64: pfx, password: SENHA_A1 });
}

function virarProducao(): void {
  getConnection()
    .prepare("UPDATE core_fiscal_configs SET environment = 'production' WHERE company_id = ?")
    .run(empresa);
}

function eventos(documentId: string | null): { event_type: string; protocol: string | null; xml_proc: string | null }[] {
  return getConnection()
    .prepare(
      documentId
        ? 'SELECT event_type, protocol, xml_proc FROM core_fiscal_events WHERE document_id = ? ORDER BY created_at'
        : 'SELECT event_type, protocol, xml_proc FROM core_fiscal_events WHERE company_id = ? AND document_id IS NULL ORDER BY created_at',
    )
    .all(documentId ?? empresa) as never[];
}

function proximoNumero(modelo: string): number | null {
  const row = getConnection()
    .prepare('SELECT next_number FROM core_fiscal_series WHERE company_id = ? AND model = ? AND serie = 1')
    .get(empresa, modelo) as { next_number: number } | undefined;
  return row?.next_number ?? null;
}

/** O que a SEFAZ responderia — pelo serviço que o adapter chamou. */
function respostaDaSefaz(servico: string, dados: string): string {
  if (servico === 'void') {
    return (
      '<retInutNFe versao="4.00" xmlns="http://www.portalfiscal.inf.br/nfe"><infInut Id="ID143260000000777">'
      + '<tpAmb>2</tpAmb><cStat>102</cStat><xMotivo>Inutilizacao de numero homologado</xMotivo>'
      + '<nProt>143260000000777</nProt></infInut></retInutNFe>'
    );
  }
  const ch = /<chNFe>(\d{44})<\/chNFe>/.exec(dados)?.[1] ?? '';
  const tp = /<tpEvento>(\d+)<\/tpEvento>/.exec(dados)?.[1] ?? '';
  return (
    '<retEnvEvento versao="1.00" xmlns="http://www.portalfiscal.inf.br/nfe"><idLote>1</idLote>'
    + '<tpAmb>2</tpAmb><cOrgao>43</cOrgao><cStat>128</cStat><xMotivo>Lote de Evento Processado</xMotivo>'
    + '<retEvento versao="1.00"><infEvento Id="ID143260000000500"><tpAmb>2</tpAmb><cOrgao>43</cOrgao>'
    + '<cStat>135</cStat><xMotivo>Evento registrado e vinculado a NF-e</xMotivo>'
    + `<chNFe>${ch}</chNFe><tpEvento>${tp}</tpEvento><nSeqEvento>1</nSeqEvento>`
    + '<dhRegEvento>2026-09-11T10:15:40-03:00</dhRegEvento><nProt>143260000000500</nProt>'
    + '</infEvento></retEvento></retEnvEvento>'
  );
}

beforeAll(() => {
  pfx = gerarCertificado(`PJ MOTORS LTDA:${CNPJ}`, SENHA_A1);
});

beforeEach(async () => {
  resetDbForTests();
  empresa = upsertCompany({ slug: 'pj-motors', legalName: 'PJ Motors Ltda', tradeName: 'PJ Motors' });
  updateFiscalConfig({
    companyId: empresa,
    patch: {
      legalName: 'PJ Motors Ltda',
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
  setSeriesNextNumber({ companyId: empresa, model: '65', serie: 1, nextNumber: 100 });
  setSeriesNextNumber({ companyId: empresa, model: '55', serie: 1, nextNumber: 100 });
  gerente = await ator('GERENTEPJ', 'gerente_loja');
  dono = await ator('DONOPJ', 'admin_geral');

  transmitidos = [];
  vi.spyOn(
    SefazRealAdapter.prototype as unknown as {
      enviar: (url: string, servico: string, dados: string) => Promise<string>;
    },
    'enviar',
  ).mockImplementation(async (url: string, servico: string, dados: string) => {
    transmitidos.push({ url, servico, dados });
    return respostaDaSefaz(servico, dados);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env.DEVORA_API_ENV = 'test';
});

// ============================================================================
// GAP-PRD-005 — o caminho da tela chega à SEFAZ
// ============================================================================

describe('o corpo que a tela manda agora chega à SEFAZ, com o A1 do cofre', () => {
  it('cancelamento de NFC-e real: vai ao host da NFC-e, assinado, e o evento aceito guarda o procEventoNFe', async () => {
    selarCertificado();
    const id = notaAutorizada({ modelo: '65', numero: 7, protocolo: '143260000000071' });

    const res = await request(app)
      .post(`/api/v1/core/fiscal/documents/${id}/cancel`)
      .set(gerente)
      .send({ justification: JUST });

    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(true);
    expect(res.body.protocol).toBe('143260000000500');
    expect(res.body.protocol).not.toMatch(/^TEST-/);
    expect(res.body.document.status).toBe('CANCELLED');

    expect(transmitidos).toHaveLength(1);
    expect(transmitidos[0].url).toContain('https://nfce-homologacao.sefazrs.rs.gov.br/');
    expect(transmitidos[0].dados).toContain('<tpEvento>110111</tpEvento>');
    expect(transmitidos[0].dados).toContain('<Signature');

    const aceito = eventos(id).find((e) => e.event_type === 'cancelled')!;
    expect(aceito.protocol).toBe('143260000000500');
    expect(aceito.xml_proc).toContain('<procEventoNFe');
  });

  it('o corpo ANTIGO da tela (developmentMode) sobre nota REAL é recusado — nada é marcado cancelado', async () => {
    selarCertificado();
    const id = notaAutorizada({ modelo: '65', numero: 8, protocolo: '143260000000081' });

    const res = await request(app)
      .post(`/api/v1/core/fiscal/documents/${id}/cancel`)
      .set(gerente)
      .send({ justification: JUST, developmentMode: true });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CORE_SEFAZ_TEST_PROVIDER_REAL_DOCUMENT');
    expect(getDocument(empresa, id)!.status).toBe('AUTHORIZED');
    expect(eventos(id)).toHaveLength(0);
    expect(transmitidos).toHaveLength(0);
  });

  it('carta de correção de NF-e real vai ao host da NF-e e ganha o arquivamento', async () => {
    selarCertificado();
    const id = notaAutorizada({ modelo: '55', numero: 9, protocolo: '143260000000091' });

    const res = await request(app)
      .post(`/api/v1/core/fiscal/documents/${id}/correction-letter`)
      .set(gerente)
      .send({ text: 'Corrigir o complemento do endereco de entrega' });

    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(true);
    expect(res.body.sequence).toBe(1);
    expect(transmitidos[0].url).toContain('https://nfe-homologacao.sefazrs.rs.gov.br/');
    expect(transmitidos[0].dados).toContain('<tpEvento>110110</tpEvento>');
    const aceito = eventos(id).find((e) => e.event_type === 'cce_authorized')!;
    expect(aceito.xml_proc).toContain('<procEventoNFe');
  });

  it('inutilização pela tela vai à SEFAZ com o ano pedido e deixa o procInutNFe', async () => {
    selarCertificado();
    const res = await request(app)
      .post('/api/v1/core/fiscal/void-ranges')
      .set(gerente)
      .send({ model: '65', serie: 1, year: 2026, from: 200, to: 203, justification: 'Queda de energia no meio da emissao' });

    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(true);
    expect(res.body.protocol).toBe('143260000000777');
    expect(transmitidos[0].servico).toBe('void');
    expect(transmitidos[0].url).toContain('https://nfce-homologacao.sefazrs.rs.gov.br/');
    expect(transmitidos[0].dados).toContain('<ano>26</ano>');
    expect(transmitidos[0].dados).toContain(`<CNPJ>${CNPJ}</CNPJ>`);
    const aceito = eventos(null).find((e) => e.event_type === 'void_authorized')!;
    expect(aceito.xml_proc).toContain('<procInutNFe');
  });

  it('nota do SIMULADOR (TEST-) continua sendo tocada pelo simulador em homologação', async () => {
    const id = notaAutorizada({ modelo: '65', numero: 10, protocolo: 'TEST-abcdef123456' });
    const res = await request(app)
      .post(`/api/v1/core/fiscal/documents/${id}/cancel`)
      .set(gerente)
      .send({ justification: JUST });
    expect(res.status).toBe(200);
    expect(res.body.protocol).toMatch(/^TEST-/);
    expect(transmitidos).toHaveLength(0);
  });

  it('sem certificado no cofre, a nota real NÃO cai no simulador: 409 dizendo o que falta', async () => {
    const id = notaAutorizada({ modelo: '65', numero: 11, protocolo: '143260000000111' });
    const res = await request(app)
      .post(`/api/v1/core/fiscal/documents/${id}/cancel`)
      .set(gerente)
      .send({ justification: JUST });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CORE_SEFAZ_CERTIFICATE_MISSING');
    expect(res.body.error.message).toMatch(/Fiscal › Certificado/);
    expect(getDocument(empresa, id)!.status).toBe('AUTHORIZED');
    expect(eventos(id)).toHaveLength(0);
  });

  it('as validações da nota continuam respondendo antes do certificado', async () => {
    const id = notaAutorizada({ modelo: '65', numero: 12, protocolo: '143260000000121' });
    const curta = await request(app)
      .post(`/api/v1/core/fiscal/documents/${id}/cancel`)
      .set(gerente)
      .send({ justification: 'erro' });
    expect(curta.status).toBe(400);
    expect(curta.body.error.code).toBe('CORE_FISCAL_JUSTIFICATION_TOO_SHORT');
  });
});

describe('a decisão do dono: cofre ou senha digitada', () => {
  it('só os donos gravam a política; com ela ligada, o ato pede a senha — e a senha certa passa', async () => {
    selarCertificado();
    const id = notaAutorizada({ modelo: '65', numero: 20, protocolo: '143260000000201' });

    const negado = await request(app)
      .put('/api/v1/core/fiscal/acts/policy')
      .set(gerente)
      .send({ exigirSenhaDigitada: true });
    expect(negado.status).toBe(403);

    const invalido = await request(app)
      .put('/api/v1/core/fiscal/acts/policy')
      .set(dono)
      .send({ exigirSenhaDigitada: 'sim' });
    expect(invalido.status).toBe(400);

    const gravado = await request(app)
      .put('/api/v1/core/fiscal/acts/policy')
      .set(dono)
      .send({ exigirSenhaDigitada: true });
    expect(gravado.status).toBe(200);
    expect(gravado.body.exigirSenhaDigitada).toBe(true);

    const plano = await request(app)
      .get(`/api/v1/core/fiscal/acts/plan?documentId=${id}`)
      .set(gerente);
    expect(plano.body).toMatchObject({ caminho: 'SEFAZ', senha: 'OBRIGATORIA' });

    const semSenha = await request(app)
      .post(`/api/v1/core/fiscal/documents/${id}/cancel`)
      .set(gerente)
      .send({ justification: JUST });
    expect(semSenha.status).toBe(400);
    expect(semSenha.body.error.code).toBe('CORE_SEFAZ_CERTIFICATE_PASSWORD_REQUIRED');
    expect(eventos(id)).toHaveLength(0);

    const senhaErrada = await request(app)
      .post(`/api/v1/core/fiscal/documents/${id}/cancel`)
      .set(gerente)
      .send({ justification: JUST, certificatePassword: 'nao-e-esta' });
    expect(senhaErrada.status).toBeGreaterThanOrEqual(400);
    expect(getDocument(empresa, id)!.status).toBe('AUTHORIZED');

    const comSenha = await request(app)
      .post(`/api/v1/core/fiscal/documents/${id}/cancel`)
      .set(gerente)
      .send({ justification: JUST, certificatePassword: SENHA_A1 });
    expect(comSenha.status).toBe(200);
    expect(comSenha.body.accepted).toBe(true);

    // A decisão do dono deixa trilha: quem mudou, de quê para quê.
    const trilha = getConnection()
      .prepare("SELECT COUNT(*) AS n FROM core_audit_log WHERE company_id = ? AND action = 'fiscal.act_policy_updated'")
      .get(empresa) as { n: number };
    expect(Number(trilha.n)).toBe(1);
  });

  it('o plano diz o caminho: SEFAZ pelo cofre, simulador para nota de ensaio, bloqueio sem A1', async () => {
    const real = notaAutorizada({ modelo: '65', numero: 30, protocolo: '143260000000301' });
    const ensaio = notaAutorizada({ modelo: '65', numero: 31, protocolo: 'TEST-000000000031' });

    const semA1 = await request(app).get('/api/v1/core/fiscal/acts/plan').set(gerente);
    expect(semA1.body).toMatchObject({ caminho: 'BLOQUEADO', codigo: 'CORE_SEFAZ_CERTIFICATE_MISSING', cofre: 'AUSENTE' });

    selarCertificado();
    const pelaNota = await request(app).get(`/api/v1/core/fiscal/acts/plan?documentId=${real}`).set(gerente);
    expect(pelaNota.body).toMatchObject({
      caminho: 'SEFAZ',
      ambiente: 'homologation',
      senha: 'OPCIONAL',
      cofre: 'SELADO',
      politica: { exigirSenhaDigitada: false },
    });

    const deEnsaio = await request(app).get(`/api/v1/core/fiscal/acts/plan?documentId=${ensaio}`).set(gerente);
    expect(deEnsaio.body).toMatchObject({ caminho: 'SIMULADOR' });

    const caixa = await ator('CAIXAPJ', 'operador_caixa_loja');
    expect((await request(app).get('/api/v1/core/fiscal/acts/plan').set(caixa)).status).toBe(403);
  });
});

// ============================================================================
// GAP-PRD-018 — em produção, só adapter real
// ============================================================================

describe('operação em PRODUÇÃO com o servidor fora de produção', () => {
  it('cancelar nota de produção sem A1 não vira TEST-: 409, e a nota continua autorizada', async () => {
    virarProducao();
    const id = notaAutorizada({ modelo: '65', numero: 40, protocolo: '143260000000401', ambiente: 'production' });

    const res = await request(app)
      .post(`/api/v1/core/fiscal/documents/${id}/cancel`)
      .set(gerente)
      .send({ justification: JUST });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CORE_SEFAZ_CERTIFICATE_MISSING');
    expect(getDocument(empresa, id)!.status).toBe('AUTHORIZED');
    expect(eventos(id).some((e) => String(e.protocol ?? '').startsWith('TEST-'))).toBe(false);
  });

  it('pedir o simulador em produção é 409 (não 500), e nada muda', async () => {
    virarProducao();
    const id = notaAutorizada({ modelo: '65', numero: 41, protocolo: '143260000000411', ambiente: 'production' });
    const res = await request(app)
      .post(`/api/v1/core/fiscal/documents/${id}/cancel`)
      .set(gerente)
      .send({ justification: JUST, developmentMode: true });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CORE_SEFAZ_TEST_PROVIDER_IN_PRODUCTION');
    expect(getDocument(empresa, id)!.status).toBe('AUTHORIZED');
  });

  it('nota de ENSAIO numa operação em produção não é "cancelada" pelo simulador', async () => {
    virarProducao();
    const id = notaAutorizada({ modelo: '65', numero: 42, protocolo: 'TEST-000000000042' });
    const res = await request(app)
      .post(`/api/v1/core/fiscal/documents/${id}/cancel`)
      .set(gerente)
      .send({ justification: JUST });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CORE_SEFAZ_TEST_DOCUMENT_IN_PRODUCTION');
  });

  it('inutilização em produção sem A1: recusada ANTES de reservar — a numeração não salta', async () => {
    virarProducao();
    const antes = proximoNumero('65');
    for (const corpo of [{}, { developmentMode: true }]) {
      const res = await request(app)
        .post('/api/v1/core/fiscal/void-ranges')
        .set(gerente)
        .send({ model: '65', serie: 1, from: 300, to: 305, justification: 'Queda de energia no meio da emissao', ...corpo });
      expect(res.status).toBe(409);
    }
    expect(proximoNumero('65')).toBe(antes);
    expect(eventos(null)).toHaveLength(0);
  });

  it('com o A1 no cofre, o cancelamento de produção vai ao host de PRODUÇÃO da NFC-e, tpAmb 1', async () => {
    selarCertificado();
    virarProducao();
    const id = notaAutorizada({ modelo: '65', numero: 43, protocolo: '143260000000431', ambiente: 'production' });
    const res = await request(app)
      .post(`/api/v1/core/fiscal/documents/${id}/cancel`)
      .set(gerente)
      .send({ justification: JUST });
    expect(res.status).toBe(200);
    expect(transmitidos[0].url).toContain('https://nfce.sefazrs.rs.gov.br/');
    expect(transmitidos[0].dados).toContain('<tpAmb>1</tpAmb>');
  });
});

describe('o portão no domínio e no seletor', () => {
  it('selectAdapter recusa o slot REAL ocupado por adapter de teste em produção', () => {
    expect(() =>
      selectAdapter({
        environment: 'production',
        useTestProvider: false,
        real: new SefazTestAdapter(),
        test: new SefazTestAdapter(),
      }),
    ).toThrow(expect.objectContaining({ code: 'CORE_SEFAZ_TEST_PROVIDER_IN_PRODUCTION' }));
  });

  /*
    `adapterRealOuSimulador` (o slot à parte do DF-e) saiu no GAP-PRD-168: o
    ato sem nota — inutilização, consulta e manifestação DF-e — decide em
    `adapterDoAtoFiscal`. Os dois casos que o cobravam passam a cobrar ele.
  */
  it('ato sem nota nunca devolve o simulador para operação em produção', () => {
    virarProducao();
    expect(() => adapterDoAtoFiscal({ companyId: empresa })).toThrow(
      expect.objectContaining({ code: 'CORE_SEFAZ_CERTIFICATE_MISSING' }),
    );
    expect(() => adapterDoAtoFiscal({ companyId: empresa, developmentMode: true })).toThrow(
      expect.objectContaining({ code: 'CORE_SEFAZ_TEST_PROVIDER_IN_PRODUCTION' }),
    );
  });

  it('fora de produção, o simulador do ato sem nota só vem por pedido explícito', () => {
    expect(adapterDoAtoFiscal({ companyId: empresa, developmentMode: true }).isReal).toBe(false);
    expect(() => adapterDoAtoFiscal({ companyId: empresa })).toThrow(
      expect.objectContaining({ code: 'CORE_SEFAZ_CERTIFICATE_MISSING' }),
    );
  });

  it('NODE_ENV=production também é produção: nada de simulador, nem pedido', () => {
    const anterior = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() =>
        selectAdapter({
          environment: 'homologation',
          useTestProvider: true,
          real: new SefazTestAdapter(),
          test: new SefazTestAdapter(),
        }),
      ).toThrow(expect.objectContaining({ code: 'CORE_SEFAZ_TEST_PROVIDER_IN_PRODUCTION' }));
      expect(() => adapterDoAtoFiscal({ companyId: empresa, developmentMode: true })).toThrow(
        expect.objectContaining({ code: 'CORE_SEFAZ_TEST_PROVIDER_IN_PRODUCTION' }),
      );
    } finally {
      process.env.NODE_ENV = anterior;
    }
  });

  it('o serviço recusa adapter de teste sobre nota REAL, mesmo em homologação', async () => {
    const id = notaAutorizada({ modelo: '65', numero: 50, protocolo: '143260000000501' });
    await expect(
      requestCancel({ companyId: empresa, documentId: id, justification: JUST, adapter: new SefazTestAdapter() }),
    ).rejects.toMatchObject({ code: 'CORE_SEFAZ_TEST_PROVIDER_REAL_DOCUMENT' });
    expect(getDocument(empresa, id)!.status).toBe('AUTHORIZED');
  });

  it('o serviço recusa adapter de teste numa operação em produção — pela rota ou não', async () => {
    virarProducao();
    await expect(
      requestVoidRange({
        companyId: empresa,
        model: '55',
        serie: 1,
        from: 500,
        to: 501,
        justification: 'Queda de energia no meio da emissao',
        adapter: new SefazTestAdapter(),
      }),
    ).rejects.toMatchObject({ code: 'CORE_SEFAZ_TEST_PROVIDER_IN_PRODUCTION' });
  });
});
