/**
 * A CONTINGÊNCIA OFF-LINE DA NFC-e, DE PONTA A PONTA — GAP-PRD-098.
 *
 * ## O que a auditoria mediu
 *
 * "Contingência é só fundação": o tpEmis não mudava (a nota em CONTINGENCY
 * era o mesmo XML tpEmis=1), não havia DANFCE nem dizeres de contingência, a
 * entrada só acontecia depois de cinco tentativas (e só se houvesse emissões),
 * e a saída era uma rota sem botão.
 *
 * ## O que este arquivo cobra
 *
 *  - a MODALIDADE é decisão do contador, gravada pelo dono: padrão AGUARDAR;
 *    off-line só com prazo; o gerente não decide;
 *  - com a modalidade off-line, a primeira indisponibilidade CONFIRMADA abre o
 *    período — a nota que disparou continua a mesma, na fila — e a PRÓXIMA
 *    NFC-e nasce off-line: tpEmis 9 na chave e no XML, dhCont e xJust, QR da
 *    versão off-line com o digVal da assinatura REAL (A1 de teste), assinatura
 *    e XSD conferidos, e sem esperar a SEFAZ no balcão;
 *  - o DANFCE dela sai sem prévia, com "EMITIDA EM CONTINGÊNCIA" e "Pendente
 *    de autorização";
 *  - a volta: com o período aberto o trabalhador não gasta tentativa; a
 *    sondagem 107 fecha o período e transmite as notas off-line na mesma
 *    passada; a nota off-line nunca "desiste";
 *  - o gerente abre (com justificativa) e fecha o período pela rota; o prazo
 *    vira pendência; a prontidão pergunta ao contador;
 *  - a nota antiga que desistiu (regra das cinco tentativas) volta sozinha
 *    quando a SEFAZ responde.
 *
 * ## Como fica vermelho
 *
 *  - tire `emissaoEmContingencia` de `createNfceForSale` e a nota do período
 *    sai com tpEmis 1;
 *  - tire `aplicarQrOffline` da assinatura e o XSD recusa o QR (a nota vai
 *    para ERROR), ou o digVal não bate com a assinatura;
 *  - tire a sondagem do período no trabalhador e ele nunca fecha sozinho.
 *
 * Nenhuma chamada sai daqui: simulador, dublês e o A1 gerado no teste.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
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
import { buildReadiness, updateFiscalConfig } from '../src/services/core/FiscalConfigService.js';
import { setSeriesNextNumber } from '../src/services/core/FiscalKeyService.js';
import { getDocument, getDocumentBySale, transition } from '../src/services/core/FiscalDocumentService.js';
import { emitNfceForSale, fiscalStatusForSale } from '../src/services/core/FiscalPipelineService.js';
import { processNext } from '../src/services/core/FiscalQueueService.js';
import {
  CONTINGENCY_STATUS,
  enterContingency,
  listFiscalPendencies,
} from '../src/services/core/FiscalContingencyService.js';
import {
  abrirPeriodo,
  gravarPoliticaDeContingencia,
  lerPoliticaDeContingencia,
  periodoAtivo,
} from '../src/services/core/FiscalContingenciaOffline.js';
import {
  reiniciarEstadoDoTrabalhadorParaTeste,
  runFiscalQueueTick,
  type EscolhaDoAdapter,
} from '../src/services/core/FiscalQueueWorker.js';
import { renderDanfce } from '../src/services/core/DanfceRenderer.js';
import { verifyNfceSignature } from '../src/services/core/FiscalSigner.js';
import { validarLeiauteNfe } from '../src/services/core/FiscalXsdValidator.js';
import { qrCodeDoXml } from '../src/services/core/NfceQrOffline.js';
import { SefazTestAdapter } from '../src/services/core/SefazTestAdapter.js';
import type {
  AuthorizeRequest,
  SefazAdapter,
  SefazResponse,
  ServiceStatus,
} from '../src/services/core/SefazAdapter.js';
import { upsertCertificateA1 } from '../src/services/fiscal/FiscalCertificateService.js';
import { grupoTributarioPadrao } from './helpers/grupoTributario.js';
import { gerarCertificado } from './helpers/certificado.js';

process.env.DEVORA_API_ENV = 'test';

const app = createApp();
const SENHA_LOGIN = 'Teste@Offline2026';
const SENHA_A1 = 'Senha@Offline1';
/** O CSC de teste do helper — é com ele que o portal refaria o hash. */
const CSC_TOKEN = 'CSC-DE-TESTE-NAO-E-O-REAL';

/** O padrão QRCODE V2 OFFLINE do XSD embutido (leiauteNFe_v4.00, PL_010b). */
const PADRAO_QR_OFFLINE =
  /^((HTTPS?|https?):\/\/.*\?p=([0-9]{34}9[0-9]{9})\|[2]\|[1-2]\|([0]{1}[1-9]{1}|[1-2]{1}[0-9]{1}|[3]{1}[0-1]{1})\|(0|0\.[0-9]{2}|[1-9]{1}[0-9]{0,12}(\.[0-9]{2})?)\|[A-Fa-f0-9]{56}\|(0|[1-9]{1}([0-9]{1,5})?)\|[A-Fa-f0-9]{40})$/;

let empresa: string;
let pfx: string;
let numeroVenda = 0;

function criarVenda(id: string): string {
  ensureCoreSchema();
  numeroVenda += 1;
  const db = getConnection();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                price_cents, ncm, cfop, origin, active, created_at, updated_at)
     VALUES (?, ?, ?, 'Camisa', 'UN', 1000, 5000, '62052000', '5102', '0', 1, ?, ?)`,
  ).run(`p-${id}`, empresa, `OFF-${numeroVenda}`, now, now);
  db.prepare(
    `INSERT INTO core_sales (id, company_id, number, status, subtotal_cents, discount_cents,
                             surcharge_cents, total_cents, origin, idempotency_key, change_cents, created_at)
     VALUES (?, ?, ?, 'completed', 10000, 0, 0, 10000, 'pdv', ?, 0, ?)`,
  ).run(id, empresa, numeroVenda, `k-${id}`, now);
  db.prepare(
    `INSERT INTO core_sale_items (id, sale_id, company_id, product_id, description, quantity,
                                  unit_price_cents, discount_cents, total_cents)
     VALUES (?, ?, ?, ?, 'Camisa', 2, 5000, 0, 10000)`,
  ).run(`i-${id}`, id, empresa, `p-${id}`);
  db.prepare(
    `INSERT INTO core_sale_payments (id, sale_id, company_id, method, amount_cents, status, created_at)
     VALUES (?, ?, ?, 'dinheiro', 10000, 'settled', ?)`,
  ).run(`pay-${id}`, id, empresa, now);
  return id;
}

function xmlAssinado(documentId: string): string {
  return String(
    (getConnection().prepare('SELECT xml_signed FROM core_fiscal_documents WHERE id = ?').get(documentId) as {
      xml_signed: string | null;
    }).xml_signed,
  );
}

function xmlOriginal(documentId: string): string {
  return String(
    (getConnection().prepare('SELECT xml_original FROM core_fiscal_documents WHERE id = ?').get(documentId) as {
      xml_original: string | null;
    }).xml_original,
  );
}

function item(documentId: string) {
  return getConnection().prepare('SELECT * FROM core_fiscal_queue WHERE document_id = ?').get(documentId) as {
    status: string;
    attempts: number;
    next_attempt_at: string | null;
  };
}

function ligarOffline(prazoHoras = 24): void {
  gravarPoliticaDeContingencia({ companyId: empresa, modo: 'OFFLINE_NFCE', prazoHoras, userId: 'dono' });
}

/** A SEFAZ cai na autorização da venda: 108, serviço paralisado. */
async function vendaQueDerrubaASefaz(id: string): Promise<string> {
  const adapter = new SefazTestAdapter();
  adapter.setScenario('SERVICE_UNAVAILABLE');
  adapter.setConsultScenario('CONSULT_NOT_FOUND');
  const saleId = criarVenda(id);
  await emitNfceForSale({ companyId: empresa, saleId, developmentMode: true, adapter });
  return getDocumentBySale(empresa, saleId, '65')!.id;
}

/** Venda emitida pelo fluxo normal do balcão: A1 do cofre, sem senha digitada. */
async function vendaNoBalcao(id: string) {
  const saleId = criarVenda(id);
  const r = await emitNfceForSale({ companyId: empresa, saleId });
  return { saleId, doc: r.document, resultado: r };
}

class Dubla implements SefazAdapter {
  readonly name = 'dubla';
  readonly isReal = true;
  readonly autorizacoes: AuthorizeRequest[] = [];
  sondagens = 0;
  private readonly teste = new SefazTestAdapter();
  constructor(private readonly online: boolean, cenario: Parameters<SefazTestAdapter['setScenario']>[0] = 'AUTHORIZED') {
    this.teste.setScenario(cenario);
    this.teste.setConsultScenario('CONSULT_NOT_FOUND');
  }
  async statusServico(): Promise<ServiceStatus> {
    this.sondagens += 1;
    return {
      online: this.online,
      cStat: this.online ? '107' : '108',
      xMotivo: this.online ? 'Servico em Operacao' : 'Servico Paralisado Momentaneamente',
      source: 'sefaz',
      checkedAt: new Date().toISOString(),
    };
  }
  async authorize(input: AuthorizeRequest): Promise<SefazResponse> {
    this.autorizacoes.push(input);
    return this.teste.authorize(input);
  }
  consult: SefazAdapter['consult'] = (i) => this.teste.consult(i);
  cancel: SefazAdapter['cancel'] = (i) => this.teste.cancel(i);
  voidNumberRange: SefazAdapter['voidNumberRange'] = (i) => this.teste.voidNumberRange(i);
}

async function login(loginName: string, perfil: string) {
  const id = await upsertUser({ login: loginName, displayName: loginName, password: SENHA_LOGIN });
  linkUserToCompany(id, empresa, perfil, true);
  const res = await request(app).post('/api/v1/auth/login').send({ login: loginName, password: SENHA_LOGIN });
  expect(res.status).toBe(200);
  return { Authorization: `Bearer ${res.body.accessToken}` };
}

beforeAll(() => {
  pfx = gerarCertificado('PRECO JUSTO LTDA:11222333000181', SENHA_A1);
});

beforeEach(() => {
  resetDbForTests();
  reiniciarEstadoDoTrabalhadorParaTeste();
  numeroVenda = 0;
  empresa = upsertCompany({ slug: 'preco-justo', legalName: 'Preço Justo Ltda', tradeName: 'Preço Justo' });
  updateFiscalConfig({
    companyId: empresa,
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
  grupoTributarioPadrao(empresa);
  setSeriesNextNumber({ companyId: empresa, model: '65', serie: 1, nextNumber: 1 });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env.DEVORA_API_ENV = 'test';
});

// ============================================================================

describe('a modalidade é decisão do contador, com padrão seguro', () => {
  it('sem decisão, vale AGUARDAR — e a prontidão pergunta ao contador, sem bloquear', () => {
    expect(lerPoliticaDeContingencia(empresa)).toMatchObject({ modo: 'AGUARDAR', prazoHoras: null });
    const r = buildReadiness(empresa, '65');
    const item = r.items.find((i) => i.key === 'contingency')!;
    expect(item).toMatchObject({ status: 'PENDING', owner: 'contador', state: 'PENDENTE' });
    expect(r.blockingReasons.join(' ')).not.toMatch(/Contingência/);
  });

  it('off-line sem prazo não liga; com prazo liga e a prontidão fica verde', () => {
    expect(() => gravarPoliticaDeContingencia({ companyId: empresa, modo: 'OFFLINE_NFCE' })).toThrow(/prazo/);
    expect(() => gravarPoliticaDeContingencia({ companyId: empresa, modo: 'CHUTE' })).toThrow(/Modalidade inválida/);
    ligarOffline(24);
    expect(lerPoliticaDeContingencia(empresa)).toMatchObject({ modo: 'OFFLINE_NFCE', prazoHoras: 24 });
    const item = buildReadiness(empresa, '65').items.find((i) => i.key === 'contingency')!;
    expect(item).toMatchObject({ status: 'PASS', state: 'CONFIRMADO' });
  });

  it('pela rota: o gerente não decide; o dono decide, com trilha', async () => {
    const gerente = await login('GEROFF', 'gerente_loja');
    const dono = await login('DONOOFF', 'admin_geral');
    const negado = await request(app)
      .put('/api/v1/core/fiscal/contingency/policy')
      .set(gerente)
      .send({ modo: 'OFFLINE_NFCE', prazoHoras: 24 });
    expect(negado.status).toBe(403);

    const ok = await request(app)
      .put('/api/v1/core/fiscal/contingency/policy')
      .set(dono)
      .send({ modo: 'OFFLINE_NFCE', prazoHoras: 24, observacao: 'Confirmado pelo contador em 10/09' });
    expect(ok.status).toBe(200);
    expect(ok.body.politica).toMatchObject({ modo: 'OFFLINE_NFCE', prazoHoras: 24 });
    const trilha = getConnection()
      .prepare("SELECT COUNT(*) AS c FROM core_audit_log WHERE action = 'fiscal.contingency_policy_updated'")
      .get() as { c: number };
    expect(Number(trilha.c)).toBe(1);
  });

  it('o estado declarado deixou de ser "fundação"', () => {
    expect(CONTINGENCY_STATUS).not.toBe('CONTINGENCY_FOUNDATION_READY');
  });
});

describe('com AGUARDAR, a SEFAZ fora não muda o tipo de emissão', () => {
  it('não abre período, e a próxima NFC-e sai normal (tpEmis 1) e espera na fila', async () => {
    await vendaQueDerrubaASefaz('aguardar-1');
    expect(periodoAtivo(empresa)).toBeNull();

    const adapter = new SefazTestAdapter();
    adapter.setScenario('SERVICE_UNAVAILABLE');
    const saleId = criarVenda('aguardar-2');
    const r = await emitNfceForSale({ companyId: empresa, saleId, developmentMode: true, adapter });
    expect(r.document.accessKey!.charAt(34)).toBe('1');
    expect(r.document.status).toBe('QUEUED');
  });
});

describe('com a modalidade off-line: a indisponibilidade abre o período, e a próxima NFC-e nasce off-line', () => {
  it('108 na autorização abre o período AUTOMÁTICO — e a nota que disparou continua a mesma, na fila', async () => {
    ligarOffline();
    const primeira = await vendaQueDerrubaASefaz('off-1');

    const p = periodoAtivo(empresa)!;
    expect(p).toMatchObject({ origem: 'AUTOMATICA', motivo: 'SEFAZ_UNAVAILABLE', codigoDoGatilho: '108' });
    expect(p.justificativa.length).toBeGreaterThanOrEqual(15);
    const doc = getDocument(empresa, primeira)!;
    expect(doc.accessKey!.charAt(34)).toBe('1');
    expect(doc.status).toBe('QUEUED');
  });

  it('rede fora com a consulta RESPONDENDO "não conheço" não abre período; com a consulta também fora, abre', async () => {
    ligarOffline();
    const semPeriodo = new SefazTestAdapter();
    semPeriodo.setScenario('NETWORK_ERROR');
    semPeriodo.setConsultScenario('CONSULT_NOT_FOUND');
    await emitNfceForSale({ companyId: empresa, saleId: criarVenda('rede-1'), developmentMode: true, adapter: semPeriodo });
    expect(periodoAtivo(empresa)).toBeNull();

    const tudoFora = new SefazTestAdapter();
    tudoFora.setScenario('NETWORK_ERROR');
    tudoFora.setConsultScenario('NETWORK_ERROR');
    await emitNfceForSale({ companyId: empresa, saleId: criarVenda('rede-2'), developmentMode: true, adapter: tudoFora });
    expect(periodoAtivo(empresa)).toMatchObject({ motivo: 'NETWORK_UNAVAILABLE', origem: 'AUTOMATICA' });
  });

  it('a NFC-e do período: tpEmis 9, dhCont e xJust, QR off-line com o digVal da assinatura REAL — e o balcão não espera a SEFAZ', async () => {
    upsertCertificateA1({ companyId: empresa, operationalUnitId: 'unit-default', pfxBase64: pfx, password: SENHA_A1 });
    ligarOffline(24);
    await vendaQueDerrubaASefaz('off-gatilho');
    const periodo = periodoAtivo(empresa)!;

    const { doc, resultado } = await vendaNoBalcao('off-cliente');

    // A chave e o XML dizem off-line.
    expect(doc.accessKey!.charAt(34)).toBe('9');
    expect(resultado.document.status).toBe('CONTINGENCY');
    expect(resultado.statusLabel).toMatch(/Emitida em contingência/);
    const xml = xmlAssinado(doc.id);
    expect(xml).toContain('<tpEmis>9</tpEmis>');
    const dhCont = /<dhCont>([^<]+)<\/dhCont>/.exec(xml)?.[1];
    expect(dhCont).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}-03:00$/);
    // dhCont é a ENTRADA em contingência (o início do período), não a emissão.
    expect(new Date(dhCont!).getTime()).toBe(Math.floor(new Date(periodo.iniciadoEm).getTime() / 1000) * 1000);
    expect(/<xJust>([^<]+)<\/xJust>/.exec(xml)?.[1]).toBe(periodo.justificativa);

    // A assinatura confere DEPOIS da troca do QR (ele fica fora do infNFe).
    expect(verifyNfceSignature(xml).valid).toBe(true);

    // O QR é o da versão off-line, no padrão do XSD, com o digVal DESTA assinatura.
    const qr = qrCodeDoXml(xml)!;
    expect(qr).toMatch(PADRAO_QR_OFFLINE);
    const digest = /<DigestValue>([^<]+)<\/DigestValue>/.exec(xml)![1];
    const partes = qr.split('?p=')[1].split('|');
    expect(partes[5]).toBe(Buffer.from(digest, 'utf8').toString('hex'));
    expect(partes[4]).toBe('100.00');
    // O hash confere com o CSC — é a conta que o portal refaz.
    const hash = createHash('sha1')
      .update(`${partes.slice(0, 7).join('|')}${CSC_TOKEN}`)
      .digest('hex')
      .toUpperCase();
    expect(partes[7]).toBe(hash);

    // Nada foi transmitido no balcão: o item espera, sem tentativa gasta.
    expect(item(doc.id)).toMatchObject({ status: 'pending', attempts: 0 });

    // E o PDV lê que é off-line, com o prazo que o contador decidiu.
    const s = fiscalStatusForSale(empresa, getDocument(empresa, doc.id)!.saleId!)!;
    expect(s.contingencia).toMatchObject({ offline: true, pendente: true });
    expect(new Date(s.contingencia!.prazoDeTransmissao!).getTime()).toBeGreaterThan(Date.now() + 23 * 3_600_000);
  });

  it('a montagem off-line passa pelo XSD oficial antes de numerar (QR provisório no padrão off-line)', async () => {
    ligarOffline();
    await vendaQueDerrubaASefaz('xsd-gatilho');
    const saleId = criarVenda('xsd-cliente');
    const r = await emitNfceForSale({ companyId: empresa, saleId, developmentMode: true, adapter: new SefazTestAdapter() });
    const original = xmlOriginal(r.document.id);
    expect(original).toContain('<tpEmis>9</tpEmis>');
    const leiaute = validarLeiauteNfe(original);
    expect(leiaute.validated).toBe(true);
    expect(leiaute.problems).toEqual([]);
  });
});

describe('o DANFCE de contingência', () => {
  it('sai sem prévia, com os dizeres "EMITIDA EM CONTINGÊNCIA" e "Pendente de autorização" e o QR da nota', async () => {
    ligarOffline();
    await vendaQueDerrubaASefaz('danfce-gatilho');
    const saleId = criarVenda('danfce-cliente');
    const r = await emitNfceForSale({ companyId: empresa, saleId, developmentMode: true, adapter: new SefazTestAdapter() });

    const html = renderDanfce(empresa, r.document.id);
    expect(html).toContain('EMITIDA EM CONTINGÊNCIA');
    expect(html).toContain('Pendente de autorização');
    expect(html).not.toContain('DOCUMENTO NÃO AUTORIZADO');
    expect(html).toContain('<svg');
    expect(html).not.toContain('QR de conferência interna');
    // A tarja vem antes do emitente.
    expect(html.indexOf('EMITIDA EM CONTINGÊNCIA')).toBeLessThan(html.indexOf('Preço Justo Comércio Ltda'));
  });

  it('a nota tpEmis 1 que só espera na fila continua sem DANFCE (não é contingência off-line)', async () => {
    const id = await vendaQueDerrubaASefaz('danfce-normal');
    expect(() => renderDanfce(empresa, id)).toThrow(/só existe para documento autorizado/);
  });
});

describe('a volta: o período fecha sozinho e as notas off-line saem', () => {
  async function cenarioComNotaOffline() {
    ligarOffline(24);
    const gatilho = await vendaQueDerrubaASefaz('volta-gatilho');
    const saleId = criarVenda('volta-cliente');
    const r = await emitNfceForSale({ companyId: empresa, saleId, developmentMode: true, adapter: new SefazTestAdapter() });
    return { gatilho, offline: r.document.id };
  }

  it('com o período aberto, o trabalhador NÃO gasta tentativa de NFC-e; a sondagem fora mantém o período', async () => {
    const { gatilho, offline } = await cenarioComNotaOffline();
    getConnection().prepare('UPDATE core_fiscal_queue SET next_attempt_at = ?').run(new Date(Date.now() - 60_000).toISOString());

    const fora = new Dubla(false);
    await runFiscalQueueTick({ escolher: (): EscolhaDoAdapter => ({ tipo: 'adapter', adapter: fora }) });

    expect(fora.sondagens).toBe(1);
    expect(fora.autorizacoes).toHaveLength(0);
    expect(periodoAtivo(empresa)).toMatchObject({ ultimaSondagemCStat: '108' });
    expect(item(offline).attempts).toBe(0);
    expect(item(gatilho).attempts).toBe(1);
  });

  it('a sondagem 107 fecha o período e transmite, na mesma passada, a nota off-line e a que disparou', async () => {
    const { gatilho, offline } = await cenarioComNotaOffline();
    getConnection().prepare('UPDATE core_fiscal_queue SET next_attempt_at = ? WHERE document_id = ?').run(
      new Date(Date.now() + 30 * 60_000).toISOString(),
      gatilho,
    );

    const noAr = new Dubla(true);
    await runFiscalQueueTick({ escolher: (): EscolhaDoAdapter => ({ tipo: 'adapter', adapter: noAr }) });

    expect(periodoAtivo(empresa)).toBeNull();
    const encerrado = getConnection()
      .prepare('SELECT ended_origin FROM core_fiscal_contingency_periods WHERE company_id = ?')
      .get(empresa) as { ended_origin: string };
    expect(encerrado.ended_origin).toBe('AUTOMATICA');
    expect(getDocument(empresa, offline)!.status).toBe('AUTHORIZED');
    expect(getDocument(empresa, gatilho)!.status).toBe('AUTHORIZED');

    // A contingência da nota se encerra — o registro fica.
    const linha = getConnection()
      .prepare('SELECT pending_transmission, contingency_started_at, contingency_ended_at FROM core_fiscal_documents WHERE id = ?')
      .get(offline) as { pending_transmission: number; contingency_started_at: string | null; contingency_ended_at: string | null };
    expect(linha.pending_transmission).toBe(0);
    expect(linha.contingency_started_at).toBeTruthy();
    expect(linha.contingency_ended_at).toBeTruthy();

    // O DANFCE da autorizada continua dizendo que foi emitida em contingência,
    // mas não mais "pendente".
    const html = renderDanfce(empresa, offline);
    expect(html).toContain('EMITIDA EM CONTINGÊNCIA');
    expect(html).not.toContain('Pendente de autorização');
  });

  it('a nota off-line nunca desiste: falha após falha volta para CONTINGENCY, com espera de no máximo 15 min', async () => {
    const { offline } = await cenarioComNotaOffline();
    const fora = new SefazTestAdapter();
    fora.setScenario('SERVICE_UNAVAILABLE');
    for (let i = 0; i < 7; i += 1) {
      getConnection().prepare('UPDATE core_fiscal_queue SET next_attempt_at = ? WHERE document_id = ?').run(
        new Date(Date.now() - 1_000).toISOString(),
        offline,
      );
      await processNext({ companyId: empresa, adapter: fora, documentId: offline });
    }
    const i = item(offline);
    expect(i.attempts).toBe(7);
    expect(i.status).toBe('retry');
    expect(new Date(i.next_attempt_at!).getTime() - Date.now()).toBeLessThanOrEqual(15 * 60_000 + 5_000);
    expect(getDocument(empresa, offline)!.status).toBe('CONTINGENCY');
  });

  it('qualquer autorização da operação também fecha o período', async () => {
    const { offline } = await cenarioComNotaOffline();
    getConnection().prepare('UPDATE core_fiscal_queue SET next_attempt_at = ? WHERE document_id = ?').run(
      new Date(Date.now() - 1_000).toISOString(),
      offline,
    );
    await processNext({ companyId: empresa, adapter: new SefazTestAdapter(), documentId: offline });
    expect(getDocument(empresa, offline)!.status).toBe('AUTHORIZED');
    expect(periodoAtivo(empresa)).toBeNull();
  });

  it('com AGUARDAR, a nota que desistiu (regra das cinco tentativas) volta SOZINHA quando a SEFAZ responde', async () => {
    const id = await vendaQueDerrubaASefaz('legado');
    getConnection()
      .prepare("UPDATE core_fiscal_queue SET status = 'dead', attempts = 5, error_code = '108' WHERE document_id = ?")
      .run(id);
    transition({ companyId: empresa, documentId: id, to: 'SENDING' });
    enterContingency({ companyId: empresa, documentId: id, reason: 'SEFAZ_UNAVAILABLE', triggerCode: '108' });

    const noAr = new Dubla(true);
    await runFiscalQueueTick({ escolher: (): EscolhaDoAdapter => ({ tipo: 'adapter', adapter: noAr }) });

    expect(noAr.sondagens).toBe(1);
    expect(getDocument(empresa, id)!.status).toBe('AUTHORIZED');
  });
});

describe('o gerente abre e fecha o período pela tela', () => {
  it('abrir exige a modalidade off-line e a justificativa; fechar devolve a emissão normal', async () => {
    const gerente = await login('GERPER', 'gerente_loja');
    const caixa = await login('CXPER', 'operador_caixa_loja');

    const desligada = await request(app)
      .post('/api/v1/core/fiscal/contingency/enter')
      .set(gerente)
      .send({ justificativa: 'Internet da loja caiu no temporal' });
    expect(desligada.status).toBe(409);
    expect(JSON.stringify(desligada.body)).toContain('CORE_CONTINGENCY_POLICY_OFF');

    ligarOffline(24);
    const curta = await request(app).post('/api/v1/core/fiscal/contingency/enter').set(gerente).send({ justificativa: 'caiu' });
    expect(curta.status).toBe(400);

    expect((await request(app).post('/api/v1/core/fiscal/contingency/enter').set(caixa).send({})).status).toBe(403);

    const aberto = await request(app)
      .post('/api/v1/core/fiscal/contingency/enter')
      .set(gerente)
      .send({ justificativa: 'Internet da loja caiu no temporal — operadora sem previsão' });
    expect(aberto.status).toBe(200);
    expect(aberto.body.periodo).toMatchObject({ origem: 'MANUAL' });
    // O travessão não cabe no TString do leiaute: vira hífen no xJust.
    expect(aberto.body.periodo.justificativa).toBe('Internet da loja caiu no temporal - operadora sem previsão');

    const saleId = criarVenda('manual-1');
    const r = await emitNfceForSale({ companyId: empresa, saleId, developmentMode: true, adapter: new SefazTestAdapter() });
    expect(r.document.accessKey!.charAt(34)).toBe('9');

    const painel = await request(app).get('/api/v1/core/fiscal/contingency').set(gerente);
    expect(painel.body.notasOffline.pendentes).toBe(1);

    const resumo = await request(app).get('/api/v1/core/fiscal/pdv-summary').set(caixa);
    expect(resumo.body.contingencia).toMatchObject({ origem: 'MANUAL' });

    const fechado = await request(app).post('/api/v1/core/fiscal/contingency/exit').set(gerente);
    expect(fechado.status).toBe(200);
    expect(fechado.body.periodo).toBeNull();
    expect(fechado.body.historico[0]).toMatchObject({ origemDoEncerramento: 'MANUAL' });

    const depois = await emitNfceForSale({
      companyId: empresa,
      saleId: criarVenda('manual-2'),
      developmentMode: true,
      adapter: new SefazTestAdapter(),
    });
    expect(depois.document.accessKey!.charAt(34)).toBe('1');
    expect(depois.document.status).toBe('AUTHORIZED');
  });

  it('desligar a modalidade encerra o período aberto', () => {
    ligarOffline();
    abrirPeriodo({ companyId: empresa, motivo: 'NETWORK_UNAVAILABLE', origem: 'MANUAL', justificativa: 'Sem internet desde as 10h' });
    gravarPoliticaDeContingencia({ companyId: empresa, modo: 'AGUARDAR' });
    expect(periodoAtivo(empresa)).toBeNull();
  });
});

describe('o prazo vira pendência', () => {
  it('dentro do prazo: "transmitir até"; fora: CONTINGENCY_OVERDUE', async () => {
    ligarOffline(24);
    await vendaQueDerrubaASefaz('prazo-gatilho');
    const saleId = criarVenda('prazo-cliente');
    const r = await emitNfceForSale({ companyId: empresa, saleId, developmentMode: true, adapter: new SefazTestAdapter() });

    const dentro = listFiscalPendencies(empresa).find((p) => p.documentId === r.document.id)!;
    expect(dentro.kind).toBe('CONTINGENCY_PENDING');
    expect(dentro.label).toMatch(/transmitir até/);
    expect(dentro.deadline).toBeTruthy();

    getConnection()
      .prepare('UPDATE core_fiscal_documents SET issued_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 30 * 3_600_000).toISOString(), r.document.id);
    const fora = listFiscalPendencies(empresa).find((p) => p.documentId === r.document.id)!;
    expect(fora.kind).toBe('CONTINGENCY_OVERDUE');
    expect(fora.label).toMatch(/FORA DO PRAZO/);
  });
});
