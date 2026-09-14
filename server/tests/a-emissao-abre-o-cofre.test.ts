/**
 * P1.1 — A SENHA DO A1 NO PIPELINE FISCAL: a emissão abre o cofre.
 *
 * ============================================================================
 * O DEFEITO QUE ESTE ARQUIVO MATA
 * ============================================================================
 *
 * O cofre já selava o `.pfx` E a senha (senha-do-certificado-no-cofre.test.ts),
 * e `getCertificateA1` sem senha explícita já caía na selada. Mas o pipeline
 * (`signDocument`/`advanceDocument`) só tomava o caminho REAL quando a senha
 * vinha no CORPO da requisição — e nenhuma tela envia senha. Resultado: o
 * botão "emitir NFC-e" do PDV, que chama a rota sem corpo nenhum, morria em
 * "Informe a senha do certificado" — uma mensagem que ainda dizia que a senha
 * "não fica guardada", quando ela fica.
 *
 * A regra agora: o fluxo normal de emissão funciona EXCLUSIVAMENTE com o
 * segredo selado. Senha explícita no corpo continua ganhando (é o caminho
 * administrativo — conferir-certificado digita a senha DE PROPÓSITO); sem
 * ela, vale a do cofre; sem certificado utilizável, recusa que diz o que
 * fazer. E a senha NUNCA volta: nem em resposta, nem em log, nem em erro.
 *
 * ============================================================================
 * O QUE JÁ ESTÁ COBERTO EM OUTROS ARQUIVOS (citado, não reescrito)
 * ============================================================================
 *
 *  - selar/reabrir a senha no cofre, resposta sem segredo, banco sem senha em
 *    claro: senha-do-certificado-no-cofre.test.ts;
 *  - o teste de comunicação continua pedindo a senha DIGITADA, e ela não
 *    sobra em resposta nem auditoria: sefaz-teste-de-comunicacao.test.ts;
 *  - a fábrica do slot real (senha do corpo → SOAP real; sem senha, fora de
 *    produção, simulador; senha errada não cai no simulador em silêncio):
 *    sefaz-adapter-real.test.ts, "a fábrica do slot real";
 *  - empresa B não lê documento/certificado da A por rota: audit-tenant.test.ts
 *    (seção 5), fiscal-multiempresa.test.ts (fila/série/documento) e
 *    sefaz-teste-de-comunicacao.test.ts ("o gestor da Gringa não testa o
 *    certificado da Preço Justo");
 *  - produção nunca aceita modo de desenvolvimento, e sem certificado nenhum
 *    não assina: fiscal-pipeline.test.ts ("produção nunca aceita o modo de
 *    desenvolvimento");
 *  - o provider de teste é impossível em produção no `selectAdapter`:
 *    fiscal-queue.test.ts ("o provider de teste é IMPOSSÍVEL em produção").
 *
 * Nada aqui transmite à SEFAZ: o desfecho vem de adapter espião injetado ou
 * de spy sobre o `SefazRealAdapter` — rede nenhuma.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { getConnection } from '../src/db/sqlite.js';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import {
  linkUserToCompany,
  upsertCompany,
  upsertUser,
} from '../src/services/auth/IdentityService.js';
import { updateFiscalConfig } from '../src/services/core/FiscalConfigService.js';
import { setSeriesNextNumber } from '../src/services/core/FiscalKeyService.js';
import { upsertTaxGroup } from '../src/services/core/CatalogAuxService.js';
import { upsertNfceCsc } from '../src/services/nfce/NfceCscService.js';
import {
  FIXTURE_SIGNATURE_MARK,
  emitNfceForSale,
} from '../src/services/core/FiscalPipelineService.js';
import { getDocumentBySale } from '../src/services/core/FiscalDocumentService.js';
import { SefazTestAdapter } from '../src/services/core/SefazTestAdapter.js';
import { SefazRealAdapter } from '../src/services/core/SefazRealAdapter.js';
import { parseSefazResponse } from '../src/services/core/SefazAdapter.js';
import type {
  AuthorizeRequest,
  SefazAdapter,
  SefazResponse,
} from '../src/services/core/SefazAdapter.js';
import {
  parseCertificateA1,
  upsertCertificateA1,
} from '../src/services/fiscal/FiscalCertificateService.js';
import { encryptFiscalSecret } from '../src/services/fiscal/FiscalSecretVault.js';
import { gerarCertificado } from './helpers/certificado.js';

const app = createApp();
const SENHA_LOGIN = 'Auditoria@Cofre2026';

/** A senha selada da rodada — é ELA que as varreduras procuram e não acham. */
const SENHA_COFRE = 'Xyz@Cofre123';
/** A senha do SEGUNDO arquivo — o reenvio que troca o segredo. */
const SENHA_NOVA = 'Nova@Cofre456';

/** Gerar RSA 2048 custa segundos: uma vez por arquivo, como manda o helper. */
let pfxAtual: string;
let pfxNovo: string;
let corpoCertAtual: string;
let corpoCertNovo: string;

/** O que vai no <X509Certificate> — o PEM sem molduras nem espaço. */
function corpoDoPem(pem: string): string {
  return pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
}

let precoJusto: string;
let numero = 0;

/**
 * Espião: o provider de teste de sempre, anotando o que o pipeline lhe
 * entrega. É assim que se prova que o A1 do cofre FOI aberto — o XML que
 * chega ao adapter carrega o certificado de verdade no <X509Certificate>.
 */
class AdapterEspiao extends SefazTestAdapter {
  readonly recebidos: AuthorizeRequest[] = [];

  override async authorize(input: AuthorizeRequest): Promise<SefazResponse> {
    this.recebidos.push(input);
    return super.authorize(input);
  }
}

/**
 * O mesmo espião dizendo `isReal: true` — o que um teste de PRODUÇÃO precisa
 * para exercitar o fluxo sem rede. Só um teste consegue mentir isso; o portão
 * de produção recusa qualquer adapter que se declare de teste.
 */
function comoSeFosseReal(espiao: AdapterEspiao): SefazAdapter {
  return {
    name: 'sefaz-espiao-que-se-diz-real',
    isReal: true,
    statusServico: (i) => espiao.statusServico(i),
    authorize: (i) => espiao.authorize(i),
    consult: (i) => espiao.consult(i),
    cancel: (i) => espiao.cancel(i),
    voidNumberRange: (i) => espiao.voidNumberRange(i),
  };
}

/** Implantação fiscal completa de uma operação, como a do audit-fiscal. */
function implantar(slug: string): string {
  const companyId = upsertCompany({
    slug,
    legalName: `${slug} Comércio Ltda`,
    tradeName: slug,
    kind: 'retail',
  });
  updateFiscalConfig({
    companyId,
    patch: {
      legalName: 'Preço Justo Comércio Ltda',
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
  upsertTaxGroup(companyId, {
    code: 'SIMPLES-102',
    name: 'Simples — CSOSN 102',
    regime: 'simples',
    csosn: '102',
    cstPis: '49',
    cstCofins: '49',
    cfopInternal: '5102',
    cfopExternal: '6102',
  });
  upsertNfceCsc({
    companyId,
    operationalUnitId: 'unit-default',
    cscId: '000001',
    cscToken: 'CSC-DE-TESTE-NAO-E-O-REAL',
  });
  setSeriesNextNumber({ companyId, model: '65', serie: 1, nextNumber: 1 });
  return companyId;
}

/** Venda completa de PDV, pronta para virar cupom. */
function criarVenda(id: string, empresa = precoJusto): string {
  ensureCoreSchema();
  numero += 1;
  const db = getConnection();
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                price_cents, ncm, cfop, origin, active, created_at, updated_at)
     VALUES (?, ?, ?, 'Camisa Cofre', 'UN', 1000, 5000, '62052000', '5102', '0', 1, ?, ?)`,
  ).run(`p-${id}`, empresa, `COF-${numero}`, now, now);

  db.prepare(
    `INSERT INTO core_sales (id, company_id, number, status, subtotal_cents, discount_cents,
                             surcharge_cents, total_cents, origin, idempotency_key, change_cents, created_at)
     VALUES (?, ?, ?, 'completed', 10000, 0, 0, 10000, 'pdv', ?, 0, ?)`,
  ).run(id, empresa, numero, `k-${id}`, now);

  db.prepare(
    `INSERT INTO core_sale_items (id, sale_id, company_id, product_id, description, quantity,
                                  unit_price_cents, discount_cents, total_cents)
     VALUES (?, ?, ?, ?, 'Camisa Cofre', 2, 5000, 0, 10000)`,
  ).run(`i-${id}`, id, empresa, `p-${id}`);

  db.prepare(
    `INSERT INTO core_sale_payments (id, sale_id, company_id, method, amount_cents, status, created_at)
     VALUES (?, ?, ?, 'dinheiro', 10000, 'settled', ?)`,
  ).run(`pay-${id}`, id, empresa, now);

  return id;
}

async function ator(login: string, companyId: string, profile = 'gerente_loja') {
  const userId = await upsertUser({ login, displayName: login, password: SENHA_LOGIN });
  linkUserToCompany(userId, companyId, profile, true);
  const res = await request(app)
    .post('/api/v1/auth/login')
    .send({ login, password: SENHA_LOGIN, companyId });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { Authorization: `Bearer ${res.body.accessToken}` };
}

function selarCertificado(companyId: string, pfx = pfxAtual, senha = SENHA_COFRE) {
  return upsertCertificateA1({
    companyId,
    operationalUnitId: 'unit-default',
    pfxBase64: pfx,
    password: senha,
  });
}

/** Põe a operação em produção como os testes do pipeline fazem: pelo banco. */
function virarProducao(companyId: string): void {
  getConnection()
    .prepare("UPDATE core_fiscal_configs SET environment = 'production' WHERE company_id = ?")
    .run(companyId);
  /*
    PRODUÇÃO TEM O CSC DELA (GAP-PRD-022). A SEFAZ emite um código para cada
    ambiente, e a NFC-e em produção agora recusa o de homologação em vez de
    montar um QR que o portal não confere — então a virada dos testes grava o
    de produção junto, como o dono faria.
  */
  upsertNfceCsc({
    companyId,
    operationalUnitId: 'unit-default',
    cscId: '000002',
    cscToken: 'CSC-DE-PRODUCAO-DE-TESTE',
    environment: 'production',
  });
}

beforeAll(() => {
  pfxAtual = gerarCertificado('PRECO JUSTO:11222333000181', SENHA_COFRE);
  pfxNovo = gerarCertificado('PRECO JUSTO RENOVADO:11222333000181', SENHA_NOVA);
  corpoCertAtual = corpoDoPem(parseCertificateA1(pfxAtual, SENHA_COFRE).certPem);
  corpoCertNovo = corpoDoPem(parseCertificateA1(pfxNovo, SENHA_NOVA).certPem);
});

beforeEach(() => {
  resetDbForTests();
  numero = 0;
  precoJusto = implantar('preco-justo');
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ============================================================================
// 1. O CAMINHO NOVO: SEM SENHA NO CORPO, O PIPELINE ABRE O COFRE
// ============================================================================

describe('a emissão assina com o segredo selado — sem pedir senha a ninguém', () => {
  it('sem senha no corpo, o A1 do cofre assina, e o adapter recebe o certificado de verdade', async () => {
    selarCertificado(precoJusto);
    const venda = criarVenda('v-cofre');
    const espiao = new AdapterEspiao();

    // A MESMA chamada que a rota do PDV faz: nem senha, nem developmentMode.
    const r = await emitNfceForSale({ companyId: precoJusto, saleId: venda, adapter: espiao });

    expect(r.document.status).toBe('AUTHORIZED');
    // Assinatura REAL não é teste: o rótulo de fixture não pode aparecer.
    expect(r.isTest).toBe(false);

    // O adapter recebeu UM authorize, e o XML que chegou nele carrega o
    // certificado DO COFRE no <X509Certificate> — prova de que o .pfx abriu.
    expect(espiao.recebidos).toHaveLength(1);
    const xmlEnviado = espiao.recebidos[0].signedXml;
    expect(xmlEnviado).toContain(corpoCertAtual);
    expect(xmlEnviado).not.toContain(FIXTURE_SIGNATURE_MARK);

    // E é o mesmo XML que ficou guardado no documento.
    const row = getConnection()
      .prepare('SELECT xml_signed FROM core_fiscal_documents WHERE id = ?')
      .get(r.document.id) as { xml_signed: string };
    expect(row.xml_signed).toContain(corpoCertAtual);
    expect(row.xml_signed).not.toContain(FIXTURE_SIGNATURE_MARK);
  });

  it('a senha do corpo GANHA do cofre: senha digitada errada é recusada, não salva pela selada', async () => {
    selarCertificado(precoJusto);
    const venda = criarVenda('v-digitada');
    const espiao = new AdapterEspiao();

    /*
      Quem digita a senha está afirmando qual é — o caminho administrativo
      (conferir-certificado). Cair no cofre aqui esconderia do operador que
      ele digitou errado, exatamente o que getCertificateA1 já recusa.
    */
    await expect(
      emitNfceForSale({
        companyId: precoJusto,
        saleId: venda,
        certificatePassword: 'digitada-errada',
        adapter: espiao,
      }),
    ).rejects.toMatchObject({ code: 'FISCAL_CERTIFICATE_PASSWORD_INVALID' });
    expect(espiao.recebidos).toHaveLength(0);

    // Com a senha certa digitada, o mesmo documento segue e autoriza — o
    // caminho interativo não quebrou, e a recusa não queimou número.
    const r = await emitNfceForSale({
      companyId: precoJusto,
      saleId: venda,
      certificatePassword: SENHA_COFRE,
      adapter: espiao,
    });
    expect(r.document.status).toBe('AUTHORIZED');
    expect(r.document.number).toBe(1);
    expect(espiao.recebidos[0].signedXml).toContain(corpoCertAtual);
  });
});

// ============================================================================
// 2. AS RECUSAS DIZEM O QUE FAZER — E NÃO VAZAM NADA
// ============================================================================

describe('certificado sem senha utilizável: recusa nomeada, sem vazamento, sem número queimado', () => {
  it('senha ausente no cofre: a recusa manda reenviar o arquivo — e a emissão seguinte usa o MESMO número', async () => {
    selarCertificado(precoJusto);
    // Certificado de uma instalação antiga, gravado antes de a senha ser selada.
    getConnection()
      .prepare("UPDATE fiscal_certificate_references SET data = json_remove(data, '$.encryptedPassword')")
      .run();

    const gerente = await ator('GER.SEMSENHA', precoJusto);
    const venda = criarVenda('v-sem-senha');

    const res = await request(app)
      .post(`/api/v1/core/fiscal/sales/${venda}/emit`)
      .set(gerente)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error.code).toBe('FISCAL_CERTIFICATE_PASSWORD_REQUIRED');
    expect(res.body.error.message).toMatch(/[Rr]eenvie/);
    expect(res.body.error.message).toMatch(/senha/i);

    // O documento existe e espera — o PDV não perde a venda — mas nada assinou.
    const doc = getDocumentBySale(precoJusto, venda)!;
    const row = getConnection()
      .prepare('SELECT xml_signed FROM core_fiscal_documents WHERE id = ?')
      .get(doc.id) as { xml_signed: string | null };
    expect(row.xml_signed).toBeNull();

    // Reenviado o arquivo com a senha, a emissão sai com o número que já era dela.
    selarCertificado(precoJusto);
    const espiao = new AdapterEspiao();
    const r = await emitNfceForSale({ companyId: precoJusto, saleId: venda, adapter: espiao });
    expect(r.document.status).toBe('AUTHORIZED');
    expect(r.document.number).toBe(1);
  });

  it('senha selada que NÃO abre o arquivo: erro claro, e a senha não aparece em lugar nenhum do corpo', async () => {
    selarCertificado(precoJusto);
    /*
      O upsert valida a senha antes de selar, então este estado só nasce por
      fora — rotação de chave malfeita, banco mexido na mão. O sistema não
      pode responder "senha incorreta" como se alguém tivesse digitado algo:
      a recusa nomeia o cofre e manda reenviar o arquivo.
    */
    const senhaTrocada = 'senha-trocada-por-fora-9';
    getConnection()
      .prepare("UPDATE fiscal_certificate_references SET data = json_set(data, '$.encryptedPassword', ?)")
      .run(encryptFiscalSecret(senhaTrocada));

    const gerente = await ator('GER.TROCADA', precoJusto);
    const venda = criarVenda('v-senha-trocada');

    const res = await request(app)
      .post(`/api/v1/core/fiscal/sales/${venda}/emit`)
      .set(gerente)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error.code).toBe('FISCAL_CERTIFICATE_PASSWORD_INVALID');
    expect(res.body.error.message).toMatch(/cofre|[Rr]eenvie/);

    const corpo = JSON.stringify(res.body);
    expect(corpo).not.toContain(senhaTrocada);
    expect(corpo).not.toContain(SENHA_COFRE);
  });
});

// ============================================================================
// 3. A SENHA SELADA NÃO APARECE EM RESPOSTA, AUDITORIA NEM ERRO
// ============================================================================

describe('varredura: a senha selada não sai por porta nenhuma', () => {
  it('a rota do PDV emite pelo adapter REAL com o segredo do cofre — e a senha não aparece em nada que o servidor devolve ou grava', async () => {
    /*
      O desfecho da SEFAZ é encenado NO adapter real (spy no authorize): assim
      a rota percorre exatamente o caminho de produção — cofre aberto, XML
      assinado de verdade, SefazRealAdapter escolhido — sem tocar rede.
    */
    const authorize = vi
      .spyOn(SefazRealAdapter.prototype, 'authorize')
      .mockImplementation(async (input) =>
        parseSefazResponse({
          body:
            '<retEnviNFe xmlns="http://www.portalfiscal.inf.br/nfe"><protNFe><infProt>'
            + `<chNFe>${input.accessKey}</chNFe><cStat>100</cStat>`
            + '<xMotivo>Autorizado o uso da NF-e</xMotivo><nProt>143260000000001</nProt>'
            + '</infProt></protNFe></retEnviNFe>',
          correlationId: input.accessKey,
        }),
      );

    // Admin geral: é quem alcança TODAS as rotas varridas — do upload do
    // certificado à emissão do balcão.
    const gerente = await ator('ADM.VARRE', precoJusto, 'admin_geral');

    // O upload PELA ROTA, como o dono faz — a resposta dele também é varrida.
    const upload = await request(app)
      .post('/api/v1/core/fiscal/certificate')
      .set(gerente)
      .send({ pfxBase64: pfxAtual, certificatePassword: SENHA_COFRE });
    expect(upload.status, JSON.stringify(upload.body)).toBe(201);

    const venda = criarVenda('v-varredura');
    const emitida = await request(app)
      .post(`/api/v1/core/fiscal/sales/${venda}/emit`)
      .set(gerente)
      .send({});

    expect(emitida.status, JSON.stringify(emitida.body)).toBe(200);
    expect(emitida.body.document.status).toBe('AUTHORIZED');
    expect(emitida.body.isTest).toBe(false);
    // O adapter REAL foi o escolhido — e recebeu o XML assinado pelo A1.
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(authorize.mock.calls[0][0].signedXml).toContain(corpoCertAtual);

    // Um erro capturado de verdade: senha digitada errada numa segunda venda.
    const outraVenda = criarVenda('v-varredura-erro');
    const comErro = await request(app)
      .post(`/api/v1/core/fiscal/sales/${outraVenda}/emit`)
      .set(gerente)
      .send({ certificatePassword: 'errada-de-proposito' });
    expect(comErro.status).toBe(400);

    // As respostas das rotas fiscais que um gestor consegue abrir.
    const docId = String(emitida.body.document.id);
    const respostas = await Promise.all([
      request(app).get(`/api/v1/core/fiscal/sales/${venda}/status`).set(gerente),
      request(app).get('/api/v1/core/fiscal/documents').set(gerente),
      request(app).get(`/api/v1/core/fiscal/documents/${docId}`).set(gerente),
      request(app).get(`/api/v1/core/fiscal/documents/${docId}/xml`).set(gerente),
      request(app).get('/api/v1/core/fiscal/certificate').set(gerente),
      request(app).get('/api/v1/core/fiscal/config').set(gerente),
      request(app).get('/api/v1/core/fiscal/readiness').set(gerente),
      request(app).get('/api/v1/core/fiscal/pdv-summary').set(gerente),
    ]);

    const varridos = [
      JSON.stringify(upload.body),
      JSON.stringify(emitida.body),
      JSON.stringify(comErro.body),
      ...respostas.map((r) => `${JSON.stringify(r.body)}${r.text ?? ''}`),
    ];
    for (const texto of varridos) {
      expect(texto).not.toContain(SENHA_COFRE);
      expect(texto).not.toContain('errada-de-proposito');
    }

    // E o que o servidor GRAVOU: trilha de auditoria, eventos do documento e
    // a própria linha do cofre — a senha não está em claro em nenhum deles.
    const db = getConnection();
    const trilha = db.prepare('SELECT * FROM core_audit_log').all();
    expect(trilha.length).toBeGreaterThan(0);
    expect(JSON.stringify(trilha)).not.toContain(SENHA_COFRE);

    const eventos = db.prepare('SELECT * FROM core_fiscal_events').all();
    expect(eventos.length).toBeGreaterThan(0);
    expect(JSON.stringify(eventos)).not.toContain(SENHA_COFRE);

    const cofre = db.prepare('SELECT data FROM fiscal_certificate_references').all();
    expect(JSON.stringify(cofre)).not.toContain(SENHA_COFRE);
  });
});

// ============================================================================
// 4. O COFRE É DA EMPRESA — A VIZINHA NÃO O ABRE
// ============================================================================

describe('a empresa B não alcança o certificado selado da A', () => {
  it('B sem certificado é recusada — nada assina com o A1 da vizinha', async () => {
    selarCertificado(precoJusto);
    const gringa = implantar('gringa-cofre');
    const venda = criarVenda('v-da-gringa', gringa);
    const espiao = new AdapterEspiao();

    await expect(
      emitNfceForSale({ companyId: gringa, saleId: venda, adapter: espiao }),
    ).rejects.toThrow(/[Cc]ertificado/);

    // O documento da B ficou esperando SEM assinatura nenhuma — em especial,
    // sem o certificado da A dentro dele.
    const doc = getDocumentBySale(gringa, venda)!;
    const row = getConnection()
      .prepare('SELECT xml_signed FROM core_fiscal_documents WHERE id = ?')
      .get(doc.id) as { xml_signed: string | null };
    expect(row.xml_signed).toBeNull();
    expect(espiao.recebidos).toHaveLength(0);
  });
});

// ============================================================================
// 5. REENVIAR O .pfx COM SENHA NOVA TROCA O SEGREDO
// ============================================================================

describe('o reenvio re-sela: a emissão seguinte usa o certificado e a senha novos', () => {
  it('depois do upsert com o arquivo novo, é o A1 novo que assina', async () => {
    selarCertificado(precoJusto);
    const espiao1 = new AdapterEspiao();
    const r1 = await emitNfceForSale({
      companyId: precoJusto,
      saleId: criarVenda('v-antes-da-troca'),
      adapter: espiao1,
    });
    expect(r1.document.status).toBe('AUTHORIZED');
    expect(espiao1.recebidos[0].signedXml).toContain(corpoCertAtual);

    // O dono renova o certificado: arquivo NOVO, senha NOVA, mesmo upsert.
    selarCertificado(precoJusto, pfxNovo, SENHA_NOVA);

    const espiao2 = new AdapterEspiao();
    const r2 = await emitNfceForSale({
      companyId: precoJusto,
      saleId: criarVenda('v-depois-da-troca'),
      adapter: espiao2,
    });
    expect(r2.document.status).toBe('AUTHORIZED');
    // O cert novo só abre com a senha nova — se isto assina, o segredo trocou.
    expect(espiao2.recebidos[0].signedXml).toContain(corpoCertNovo);
    expect(espiao2.recebidos[0].signedXml).not.toContain(corpoCertAtual);
  });
});

// ============================================================================
// 6. PRODUÇÃO: O COFRE EMITE; O SIMULADOR CONTINUA IMPOSSÍVEL
// ============================================================================
//
// Os três portões já cobertos continuam de pé, cada um no seu arquivo:
// modo de desenvolvimento recusado em produção e produção sem certificado não
// assina (fiscal-pipeline.test.ts), `selectAdapter` recusando o provider de
// teste (fiscal-queue.test.ts), e a fábrica do slot real sem cair no simulador
// com senha errada (sefaz-adapter-real.test.ts). Aqui entra o que faltava: o
// caminho NOVO — cofre em produção — e o portão novo que ele exigiu.

describe('produção emite com o segredo selado, e só por adapter real', () => {
  it('em produção, o cofre assina e transmite — sem fixture e sem pedir senha', async () => {
    selarCertificado(precoJusto);
    virarProducao(precoJusto);
    const venda = criarVenda('v-producao');
    const espiao = new AdapterEspiao();

    const r = await emitNfceForSale({
      companyId: precoJusto,
      saleId: venda,
      adapter: comoSeFosseReal(espiao),
    });

    expect(r.document.status).toBe('AUTHORIZED');
    expect(r.isTest).toBe(false);
    expect(espiao.recebidos[0].signedXml).toContain(corpoCertAtual);
    expect(espiao.recebidos[0].signedXml).not.toContain(FIXTURE_SIGNATURE_MARK);
  });

  it('adapter que se declara de teste não transmite em produção — nem injetado por dentro', async () => {
    selarCertificado(precoJusto);
    virarProducao(precoJusto);
    const venda = criarVenda('v-producao-fake');
    const espiao = new AdapterEspiao(); // isReal: false, como todo provider de teste

    await expect(
      emitNfceForSale({ companyId: precoJusto, saleId: venda, adapter: espiao }),
    ).rejects.toMatchObject({ code: 'CORE_SEFAZ_TEST_PROVIDER_IN_PRODUCTION' });

    // Nada chegou ao provider de teste, e a nota NÃO consta como autorizada.
    expect(espiao.recebidos).toHaveLength(0);
    const doc = getDocumentBySale(precoJusto, venda)!;
    expect(doc.status).not.toBe('AUTHORIZED');
  });
});
