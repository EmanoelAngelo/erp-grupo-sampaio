/**
 * ============================================================================
 * AUDITORIA DO MÓDULO FISCAL — homologação SIMULADA, nunca rede
 * ============================================================================
 *
 * Este arquivo NÃO transmite nada à SEFAZ: todo desfecho vem do
 * `SefazTestAdapter`, e todo protocolo que nasce aqui começa com `TEST-` —
 * `isTestProtocol` o denuncia, e a reconciliação acusa qualquer um que
 * apareça em produção (ver fiscal-reconciliation.test.ts).
 *
 * O MUITO QUE JÁ ESTÁ COBERTO (mapeado antes de escrever, não reescrito):
 *  - dhEmi com fuso do emitente + AAMM da chave: instante-da-emissao.test.ts;
 *  - infNFeSupl/QR v2 e recusa sem CSC (unidade): tributacao-vem-do-grupo.test.ts;
 *  - CSOSN por CRT, pCredSN do 101, CFOP interno/interestadual, PIS/COFINS:
 *    tributacao-vem-do-grupo.test.ts;
 *  - desconto de rodapé fechando vNF (unidade): tributacao-vem-do-grupo.test.ts;
 *  - pipeline PDV→AUTHORIZED/REJECTED/QUEUED e invariante comercial:
 *    fiscal-pipeline.test.ts (+ pdv-emissao-nfce.test.ts para o botão);
 *  - máquina de estados (cancel só de autorizada, REJECTED com saída nomeada,
 *    CANCELLED terminal): fiscal-document.test.ts e fiscal-events.test.ts;
 *  - inutilização só de faixa não usada, sobreposição, concorrência:
 *    fiscal-events.test.ts / fiscal-events-routes.test.ts;
 *  - contingência (elegibilidade, entrar, sair, fila) NO SERVIÇO:
 *    fiscal-contingency.test.ts;
 *  - isolamento do documento fiscal entre empresas: audit-tenant.test.ts
 *    (seção 5: detalhe e XML da vizinha por id), fiscal-multiempresa.test.ts,
 *    fiscal-document.test.ts e fiscal-pipeline.test.ts;
 *  - a senha do A1 SELADA abrindo a emissão sem corpo nenhum (P1.1), com as
 *    recusas nomeadas e a varredura de vazamento: a-emissao-abre-o-cofre.test.ts.
 *
 * O QUE ESTE ARQUIVO ACRESCENTA:
 *  1. a emissão ponta a ponta PELA ROTA, com todas as marcas conferidas no
 *     XML QUE O SERVIDOR GUARDOU (não num XML montado à mão): fuso, AAMM,
 *     QR v2, CSOSN, desconto de rodapé, série da configuração e o protocolo
 *     de simulador marcado;
 *  2. recusas nomeando a pendência exata PELA ROTA (série, CSC, pCredSN, NCM);
 *  3. a prova de que NENHUMA recusa queima número — nem a de validação, nem a
 *     que nascia DENTRO de `buildNfceXml` (CSC, tributação): a auditoria achou
 *     a queima, e o conserto pôs `conferirExigenciasDaMontagem` ANTES de
 *     `reserveNextNumber`, com a MESMA régua do build;
 *  4. a rota POST /core/fiscal/documents/:id/reenfileirar — existia sem tela
 *     e sem teste HTTP — provada por HTTP, com perfil e escopo;
 *  5. os fabricadores legados restantes (cancel NFC-e/NF-e, carta de correção,
 *     inutilização legada) — achados VERMELHOS pela auditoria e NEUTRALIZADOS
 *     com a régua do authorize: recusa 409 nomeada, nada de desfecho fiscal
 *     fabricado, e o cancel deixou de atravessar empresa pelo id.
 */
import { beforeEach, describe, expect, it } from 'vitest';
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
import { emitNfceForSale, FIXTURE_SIGNATURE_MARK } from '../src/services/core/FiscalPipelineService.js';
import { getDocument, getDocumentBySale } from '../src/services/core/FiscalDocumentService.js';
import { enterContingency } from '../src/services/core/FiscalContingencyService.js';
import { processNext } from '../src/services/core/FiscalQueueService.js';
import { SefazTestAdapter, isTestProtocol } from '../src/services/core/SefazTestAdapter.js';

const app = createApp();
const SENHA = 'Auditoria@Fiscal2026';

let precoJusto: string;
let numero = 0;

interface Ator {
  auth: { Authorization: string };
  userId: string;
}

async function ator(login: string, companyId: string, profile: string): Promise<Ator> {
  const userId = await upsertUser({ login, displayName: login, password: SENHA });
  linkUserToCompany(userId, companyId, profile, true);
  const res = await request(app)
    .post('/api/v1/auth/login')
    .send({ login, password: SENHA, companyId });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { auth: { Authorization: `Bearer ${res.body.accessToken}` }, userId };
}

/**
 * Implantação fiscal de uma operação, parametrizada para os cenários de
 * recusa: dá para nascer SEM série, SEM CSC ou com o grupo 101 sem pCredSN.
 */
function implantar(
  slug: string,
  opts: { serie?: number | null; csc?: boolean; grupo?: '102' | '101-sem-credito' | null } = {},
): string {
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
  const grupo = opts.grupo === undefined ? '102' : opts.grupo;
  if (grupo === '102') {
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
  } else if (grupo === '101-sem-credito') {
    upsertTaxGroup(companyId, {
      code: 'SIMPLES-101',
      name: 'Simples — CSOSN 101 sem pCredSN',
      regime: 'simples',
      csosn: '101',
      // pCredSn ausente DE PROPÓSITO: é a pendência que a recusa deve nomear.
      cstPis: '49',
      cstCofins: '49',
      cfopInternal: '5102',
      cfopExternal: '6102',
    });
  }
  if (opts.csc !== false) {
    upsertNfceCsc({
      companyId,
      operationalUnitId: 'unit-default',
      cscId: '000001',
      cscToken: 'CSC-DE-TESTE-NAO-E-O-REAL',
    });
  }
  if (opts.serie !== null) {
    setSeriesNextNumber({ companyId, model: '65', serie: opts.serie ?? 7, nextNumber: 1 });
  }
  return companyId;
}

/** Venda completa de PDV, com desconto de rodapé opcional. */
function criarVenda(
  id: string,
  opcoes: { empresa?: string; ncm?: string | null; descontoRodapeCents?: number } = {},
): string {
  ensureCoreSchema();
  numero += 1;
  const empresa = opcoes.empresa ?? precoJusto;
  const desconto = opcoes.descontoRodapeCents ?? 0;
  const subtotal = 10_000;
  const total = subtotal - desconto;
  const db = getConnection();
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                price_cents, ncm, cfop, origin, active, created_at, updated_at)
     VALUES (?, ?, ?, 'Camisa Auditoria', 'UN', 1000, 5000, ?, '5102', '0', 1, ?, ?)`,
  ).run(`p-${id}`, empresa, `AUD-${numero}`, opcoes.ncm === undefined ? '62052000' : opcoes.ncm, now, now);

  db.prepare(
    `INSERT INTO core_sales (id, company_id, number, status, subtotal_cents, discount_cents,
                             surcharge_cents, total_cents, origin, idempotency_key, change_cents, created_at)
     VALUES (?, ?, ?, 'completed', ?, ?, 0, ?, 'pdv', ?, 0, ?)`,
  ).run(id, empresa, numero, subtotal, desconto, total, `k-${id}`, now);

  db.prepare(
    `INSERT INTO core_sale_items (id, sale_id, company_id, product_id, description, quantity,
                                  unit_price_cents, discount_cents, total_cents)
     VALUES (?, ?, ?, ?, 'Camisa Auditoria', 2, 5000, 0, 10000)`,
  ).run(`i-${id}`, id, empresa, `p-${id}`);

  db.prepare(
    `INSERT INTO core_sale_payments (id, sale_id, company_id, method, amount_cents, status, created_at)
     VALUES (?, ?, ?, 'dinheiro', ?, 'settled', ?)`,
  ).run(`pay-${id}`, id, empresa, total, now);

  return id;
}

function proximoNumero(companyId: string, serie: number): number {
  const row = getConnection()
    .prepare(
      "SELECT next_number FROM core_fiscal_series WHERE company_id = ? AND model = '65' AND serie = ?",
    )
    .get(companyId, serie) as { next_number: number } | undefined;
  return Number(row?.next_number ?? -1);
}

beforeEach(() => {
  resetDbForTests();
  numero = 0;
  // Série 7 DE PROPÓSITO: se algum caminho regredir para `serie ?? 1`, os
  // casos abaixo ficam vermelhos — é a regressão que resolveSerie documenta.
  precoJusto = implantar('preco-justo', { serie: 7 });
});

// ============================================================================
// 1. PDV → NFC-e SIMULADA, PONTA A PONTA, PELA ROTA
// ============================================================================

describe('a venda do PDV vira NFC-e simulada com todas as marcas no XML guardado', () => {
  it('emite pela rota e o XML do servidor carrega fuso, AAMM, QR v2, CSOSN, desconto e série', async () => {
    const gerente = await ator('GER.PJ', precoJusto, 'gerente_loja');
    const venda = criarVenda('v-ponta-a-ponta', { descontoRodapeCents: 1_000 });

    const emitida = await request(app)
      .post(`/api/v1/core/fiscal/sales/${venda}/emit`)
      .set(gerente.auth)
      .send({ developmentMode: true });

    expect(emitida.status, JSON.stringify(emitida.body)).toBe(200);
    expect(emitida.body.document.status).toBe('AUTHORIZED');
    expect(emitida.body.statusLabel).toBe('NFC-e autorizada');

    // O PROTOCOLO É DO SIMULADOR E ESTÁ MARCADO COMO TAL — nunca vale para o
    // fisco: `isTest` na resposta, prefixo TEST- no protocolo, ambiente de
    // homologação no documento. A reconciliação acusa TEST- em produção
    // (fiscal-reconciliation.test.ts).
    expect(emitida.body.isTest).toBe(true);
    const protocolo = emitida.body.document.protocol as string;
    expect(protocolo).toMatch(/^TEST-/);
    expect(isTestProtocol(protocolo)).toBe(true);
    expect(emitida.body.document.environment).toBe('homologation');

    const accessKey = emitida.body.document.accessKey as string;
    expect(accessKey).toMatch(/^\d{44}$/);
    expect(accessKey.startsWith('43'), 'cUF 43 = RS').toBe(true);

    // A SÉRIE VEM DA CONFIGURAÇÃO (7), não de um `?? 1` cravado.
    expect(emitida.body.document.serie).toBe(7);
    expect(accessKey.slice(22, 25)).toBe('007');
    expect(emitida.body.document.number).toBe(1);

    const xmlRes = await request(app)
      .get(`/api/v1/core/fiscal/documents/${emitida.body.document.id}/xml`)
      .set(gerente.auth);
    expect(xmlRes.status).toBe(200);
    const xml = xmlRes.text;

    // dhEmi com o deslocamento do RS, e a chave contando a MESMA data (AAMM).
    const dhEmi = /<dhEmi>([^<]+)<\/dhEmi>/.exec(xml)?.[1] ?? '';
    expect(dhEmi).toMatch(/-03:00$/);
    const aammDoDhEmi = `${dhEmi.slice(2, 4)}${dhEmi.slice(5, 7)}`;
    expect(accessKey.slice(2, 6)).toBe(aammDoDhEmi);

    // infNFeSupl com QR VERSÃO 2 do portal do RS: chNFe|2|tpAmb|cIdToken|hash.
    expect(xml).toContain('<infNFeSupl>');
    expect(xml).toContain('https://dfe-portal.svrs.rs.gov.br/nfce/consulta?p=');
    // cIdToken SEM zeros à esquerda: o XSD do qrCode (PL_010b) só aceita
    // 0|[1-9][0-9]{0,5} ali — "000001" era cupom fora do leiaute (GAP-PRD-097).
    expect(xml).toContain(`?p=${accessKey}|2|2|1|`);
    expect(xml).toContain('<urlChave>https://dfe-portal.svrs.rs.gov.br/nfce/consulta</urlChave>');

    // CSOSN do grupo tributário da operação, não cravado no código.
    expect(xml).toContain('<CSOSN>102</CSOSN>');

    // O DESCONTO DE RODAPÉ FECHA A CONTA: vProd − vDesc = vNF.
    expect(xml).toContain('<vProd>100.00</vProd>');
    expect(xml).toContain('<vDesc>10.00</vDesc>');
    expect(xml).toContain('<vNF>90.00</vNF>');

    // Série e ambiente no corpo do XML, coerentes com o documento.
    expect(xml).toContain('<serie>7</serie>');
    expect(xml).toContain('<nNF>1</nNF>');
    expect(xml).toContain('<tpAmb>2</tpAmb>');

    // O XML GUARDADO é o assinado — e a assinatura é a de FIXTURE, marcada.
    // Nada disso vale para o fisco, e o servidor não finge que vale.
    expect(xml).toContain('<Signature');
    expect(xml).toContain(FIXTURE_SIGNATURE_MARK);
  });

  it('a rejeição simulada pela rota tem saída nomeada, sem protocolo', async () => {
    const gerente = await ator('GER.REJ', precoJusto, 'gerente_loja');
    const venda = criarVenda('v-rejeitada');

    const res = await request(app)
      .post(`/api/v1/core/fiscal/sales/${venda}/emit`)
      .set(gerente.auth)
      .send({ developmentMode: true, testScenario: 'REJECTED' });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.document.status).toBe('REJECTED');
    expect(res.body.statusLabel).toBe('NFC-e rejeitada');
    expect(res.body.terminal).toBe(true);
    expect(res.body.document.cStat).toBeTruthy();
    expect(res.body.document.xMotivo).toBeTruthy();
    expect(res.body.document.protocol).toBeNull();
  });
});

// ============================================================================
// 2. RECUSAS NOMEIAM A PENDÊNCIA EXATA, PELA ROTA
// ============================================================================

describe('a recusa diz exatamente o que falta', () => {
  it('sem série ativa: a recusa nomeia a série e onde cadastrar', async () => {
    const semSerie = implantar('sem-serie', { serie: null });
    const gerente = await ator('GER.SEMSERIE', semSerie, 'gerente_loja');
    const venda = criarVenda('v-sem-serie', { empresa: semSerie });

    const res = await request(app)
      .post(`/api/v1/core/fiscal/sales/${venda}/emit`)
      .set(gerente.auth)
      .send({ developmentMode: true });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe('CORE_FISCAL_NOT_READY');
    expect(res.body.error.message).toMatch(/série/i);
    expect(res.body.error.message).toContain('Nenhuma série configurada');
  });

  it('sem CSC: a recusa nomeia o CSC e diz que ele vem do portal da SEFAZ', async () => {
    const semCsc = implantar('sem-csc', { csc: false });
    const gerente = await ator('GER.SEMCSC', semCsc, 'gerente_loja');
    const venda = criarVenda('v-sem-csc', { empresa: semCsc });

    const res = await request(app)
      .post(`/api/v1/core/fiscal/sales/${venda}/emit`)
      .set(gerente.auth)
      .send({ developmentMode: true });

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error.code).toBe('NFCE_CSC_REQUIRED');
    expect(res.body.error.message).toContain('CSC');
    expect(res.body.error.message).toMatch(/portal da SEFAZ/i);
  });

  it('CSOSN 101 sem pCredSN: a recusa nomeia o campo e o grupo', async () => {
    const cemUm = implantar('cento-e-um', { grupo: '101-sem-credito' });
    const gerente = await ator('GER.101', cemUm, 'gerente_loja');
    const venda = criarVenda('v-101', { empresa: cemUm });

    const res = await request(app)
      .post(`/api/v1/core/fiscal/sales/${venda}/emit`)
      .set(gerente.auth)
      .send({ developmentMode: true });

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error.code).toBe('CORE_FISCAL_TRIBUTACAO_INCOMPLETA');
    expect(res.body.error.message).toContain('pCredSN');
    expect(res.body.error.message).toContain('SIMPLES-101');
  });

  it('item sem NCM: a recusa nomeia o campo e o item', async () => {
    const gerente = await ator('GER.NCM', precoJusto, 'gerente_loja');
    const venda = criarVenda('v-sem-ncm', { ncm: null });

    const res = await request(app)
      .post(`/api/v1/core/fiscal/sales/${venda}/emit`)
      .set(gerente.auth)
      .send({ developmentMode: true });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe('CORE_FISCAL_DOCUMENT_INVALID');
    expect(res.body.error.message).toContain('NCM');
  });
});

// ============================================================================
// 3. NUMERAÇÃO: RECUSA DE VALIDAÇÃO NÃO QUEIMA NÚMERO (P2 antigo — PROVADO)
// ============================================================================

describe('a numeração sobrevive à recusa', () => {
  it('recusa por item sem NCM NÃO queima número: corrigido o cadastro, a nota sai com nNF 1', async () => {
    const gerente = await ator('GER.NUM', precoJusto, 'gerente_loja');
    const venda = criarVenda('v-num', { ncm: null });

    const recusada = await request(app)
      .post(`/api/v1/core/fiscal/sales/${venda}/emit`)
      .set(gerente.auth)
      .send({ developmentMode: true });
    expect(recusada.status).toBe(409);

    // O número NÃO andou e nenhum documento nasceu.
    expect(proximoNumero(precoJusto, 7)).toBe(1);
    expect(getDocumentBySale(precoJusto, venda)).toBeNull();

    // Corrige o cadastro e emite: a nota sai com o MESMO primeiro número.
    getConnection()
      .prepare("UPDATE core_products SET ncm = '62052000' WHERE id = ?")
      .run('p-v-num');

    const emitida = await request(app)
      .post(`/api/v1/core/fiscal/sales/${venda}/emit`)
      .set(gerente.auth)
      .send({ developmentMode: true });
    expect(emitida.status, JSON.stringify(emitida.body)).toBe(200);
    expect(emitida.body.document.number).toBe(1);
    expect(proximoNumero(precoJusto, 7)).toBe(2);
  });

  /*
    ERA VERMELHO DOCUMENTADO, HOJE É A REGRA.

    `createNfceForSale` reservava o número e SÓ DEPOIS chamava `buildNfceXml`
    — e era lá dentro que a falta de CSC nascia (`NFCE_CSC_REQUIRED`). A
    recusa por CSC queimava um número por erro de CONFIGURAÇÃO, exatamente o
    que o comentário do próprio serviço prometeu evitar. O conserto:
    `conferirExigenciasDaMontagem` roda ANTES de `reserveNextNumber` e cobra,
    com a MESMA régua do build (nada duplicado), o que a montagem vai exigir.
    A chave depende do nNF, então o build continua depois da reserva — só o
    momento das RECUSAS mudou.
  */
  it('recusa por falta de CSC não queima número: cadastrado o CSC, a nota sai com nNF 1', async () => {
    const semCsc = implantar('queima-csc', { csc: false });
    const gerente = await ator('GER.QCSC', semCsc, 'gerente_loja');
    const venda = criarVenda('v-queima-csc', { empresa: semCsc });

    const res = await request(app)
      .post(`/api/v1/core/fiscal/sales/${venda}/emit`)
      .set(gerente.auth)
      .send({ developmentMode: true });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('NFCE_CSC_REQUIRED');

    // Número intacto e nenhum documento nasceu.
    expect(proximoNumero(semCsc, 7)).toBe(1);
    expect(getDocumentBySale(semCsc, venda)).toBeNull();

    // Cadastrado o CSC, a nota sai com o MESMO primeiro número.
    upsertNfceCsc({
      companyId: semCsc,
      operationalUnitId: 'unit-default',
      cscId: '000001',
      cscToken: 'CSC-DE-TESTE-NAO-E-O-REAL',
    });
    const emitida = await request(app)
      .post(`/api/v1/core/fiscal/sales/${venda}/emit`)
      .set(gerente.auth)
      .send({ developmentMode: true });
    expect(emitida.status, JSON.stringify(emitida.body)).toBe(200);
    expect(emitida.body.document.number).toBe(1);
    expect(proximoNumero(semCsc, 7)).toBe(2);
  });

  /*
    A mesma doença por outra porta, o mesmo conserto: a tributação
    (`tributacaoDoItem`) também rodava só dentro de `buildNfceXml`, depois da
    reserva. Agora a pré-validação a roda por item, antes do número — CSOSN
    101 sem pCredSN recusa SEM queimar.
  */
  it('recusa por pCredSN ausente não queima número: preenchido o grupo, a nota sai com nNF 1', async () => {
    const cemUm = implantar('queima-101', { grupo: '101-sem-credito' });
    const gerente = await ator('GER.Q101', cemUm, 'gerente_loja');
    const venda = criarVenda('v-queima-101', { empresa: cemUm });

    const res = await request(app)
      .post(`/api/v1/core/fiscal/sales/${venda}/emit`)
      .set(gerente.auth)
      .send({ developmentMode: true });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CORE_FISCAL_TRIBUTACAO_INCOMPLETA');

    expect(proximoNumero(cemUm, 7)).toBe(1);
    expect(getDocumentBySale(cemUm, venda)).toBeNull();

    // O contador informou o percentual: o grupo ganha o pCredSN e a nota sai.
    // O ajuste vai por SQL direto, como o do NCM lá em cima — `upsertTaxGroup`
    // sem id recusa o código repetido, e o que este caso prova é a numeração,
    // não a tela de grupos.
    getConnection()
      .prepare("UPDATE core_tax_groups SET p_cred_sn = '2.50' WHERE company_id = ? AND code = 'SIMPLES-101'")
      .run(cemUm);
    const emitida = await request(app)
      .post(`/api/v1/core/fiscal/sales/${venda}/emit`)
      .set(gerente.auth)
      .send({ developmentMode: true });
    expect(emitida.status, JSON.stringify(emitida.body)).toBe(200);
    expect(emitida.body.document.number).toBe(1);
    expect(proximoNumero(cemUm, 7)).toBe(2);
  });
});

// ============================================================================
// 4. CONTINGÊNCIA: A VOLTA PELA ROTA — POST /fiscal/documents/:id/reenfileirar
// ============================================================================

describe('a rota de reenfileirar funciona por HTTP — existia sem tela e sem teste', () => {
  async function documentoEmContingencia(): Promise<string> {
    const venda = criarVenda(`v-cont-${numero + 1}`);
    const adapter = new SefazTestAdapter();
    adapter.setScenario('NETWORK_ERROR');
    adapter.setConsultScenario('CONSULT_NOT_FOUND');
    const r = await emitNfceForSale({
      companyId: precoJusto,
      saleId: venda,
      developmentMode: true,
      adapter,
    });
    expect(r.document.status).toBe('QUEUED');
    enterContingency({
      companyId: precoJusto,
      documentId: r.document.id,
      reason: 'SEFAZ_UNAVAILABLE',
    });
    expect(getDocument(precoJusto, r.document.id)!.status).toBe('CONTINGENCY');
    return r.document.id;
  }

  it('gerente reenfileira: 200, QUEUED, mesmo número e mesma chave — e a fila conclui', async () => {
    const gerente = await ator('GER.CONT', precoJusto, 'gerente_loja');
    const docId = await documentoEmContingencia();
    const antes = getDocument(precoJusto, docId)!;

    const res = await request(app)
      .post(`/api/v1/core/fiscal/documents/${docId}/reenfileirar`)
      .set(gerente.auth)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe('QUEUED');
    expect(res.body.number).toBe(antes.number);
    expect(res.body.accessKey).toBe(antes.accessKey);
    expect(res.body.id).toBe(docId);

    // A SEFAZ "voltou": o worker processa e a nota chega a AUTHORIZED — sem
    // documento novo, sem número novo.
    const adapter = new SefazTestAdapter();
    adapter.setScenario('AUTHORIZED');
    await processNext({
      companyId: precoJusto,
      adapter,
      now: new Date(Date.now() + 24 * 3600_000),
    });
    const final = getDocument(precoJusto, docId)!;
    expect(final.status).toBe('AUTHORIZED');
    expect(final.number).toBe(antes.number);
    expect(isTestProtocol(final.protocol)).toBe(true);
  });

  it('caixa não reenfileira — contingência é decisão de gestão', async () => {
    const caixa = await ator('CX.CONT', precoJusto, 'operador_caixa_loja');
    const docId = await documentoEmContingencia();

    const res = await request(app)
      .post(`/api/v1/core/fiscal/documents/${docId}/reenfileirar`)
      .set(caixa.auth)
      .send({});
    expect(res.status).toBe(403);
    expect(getDocument(precoJusto, docId)!.status).toBe('CONTINGENCY');
  });

  it('documento que não está em contingência responde 409 nomeado', async () => {
    const gerente = await ator('GER.CONT2', precoJusto, 'gerente_loja');
    const venda = criarVenda('v-autorizada');
    const r = await emitNfceForSale({ companyId: precoJusto, saleId: venda, developmentMode: true });

    const res = await request(app)
      .post(`/api/v1/core/fiscal/documents/${r.document.id}/reenfileirar`)
      .set(gerente.auth)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CORE_CONTINGENCY_NOT_ACTIVE');
  });

  it('gerente de OUTRA empresa não reenfileira nem descobre que o documento existe', async () => {
    const outra = implantar('gringa-audit');
    const gerenteOutra = await ator('GER.OUTRA', outra, 'gerente_loja');
    const docId = await documentoEmContingencia();

    const res = await request(app)
      .post(`/api/v1/core/fiscal/documents/${docId}/reenfileirar`)
      .set(gerenteOutra.auth)
      .send({});
    expect(res.status).toBe(404);
    expect(getDocument(precoJusto, docId)!.status).toBe('CONTINGENCY');
  });
});

// ============================================================================
// 5. FABRICADORES LEGADOS — ACHADOS PELA AUDITORIA, NEUTRALIZADOS
// ============================================================================
//
// O authorize legado foi neutralizado primeiro (nfce.test.ts cobra o 409).
// Estas quatro rotas irmãs tinham ficado, marcando desfecho fiscal sem SEFAZ
// nenhuma — a auditoria as documentou como casos VERMELHOS, e a neutralização
// veio com a MESMA régua: recusa 409 `CORE_FISCAL_NOT_AUTHORIZED`, nomeando o
// que exige o fisco. O caminho REAL desses eventos vive no core
// (FiscalEventsService: requestCancel, requestCorrectionLetter,
// requestVoidRange) — fiscal-events.test.ts e fiscal-events-routes.test.ts.

/*
  DA NEUTRALIZAÇÃO À REMOÇÃO (GAP-PRD-096).

  As cinco rotas legadas que este bloco cobrava — cancel da NFC-e e da NF-e,
  carta de correção, inutilização e a travessia de empresa pelo id — tinham
  sido neutralizadas com 409. O roteador inteiro saiu depois: era camada JSON
  sem tela, e as irmãs que ficaram de pé (`number`, `validate`, `xml`, `sign`)
  ainda atravessavam empresa. Hoje nenhuma responde; o caminho real dos três
  eventos é o do core (fiscal-events.test.ts, atos-fiscais-pela-tela.test.ts),
  e a lista completa das rotas que morreram está em
  rotas-fiscais-legadas-fora-do-ar.test.ts.
*/
describe('fabricadores legados — o roteador saiu, nenhuma rota responde', () => {
  const ROTAS: [metodo: 'get' | 'post', caminho: string][] = [
    ['post', '/api/v1/fiscal/nfce/documents'],
    ['post', '/api/v1/fiscal/nfce/documents/qualquer/cancel'],
    ['post', '/api/v1/fiscal/nfe/documents'],
    ['post', '/api/v1/fiscal/nfe/documents/qualquer/cancel'],
    ['post', '/api/v1/fiscal/nfe/documents/qualquer/correction-letter'],
    ['post', '/api/v1/fiscal/nfe/number-invalidation'],
    ['post', '/api/v1/fiscal/nfce/number-invalidation'],
  ];

  for (const [metodo, caminho] of ROTAS) {
    it(`${metodo.toUpperCase()} ${caminho} responde 404 sem protocolo nenhum`, async () => {
      const adm = await ator(`ADM.LEG.${caminho.length}.${metodo}`, precoJusto, 'admin_geral');
      const res = await request(app)[metodo](caminho)
        .set(adm.auth)
        .set('Idempotency-Key', `aud-legado-${caminho}`)
        .send({ text: 'corrigir endereço do transportador', serie: 1, from: 10, to: 20 });
      expect(res.status).toBe(404);
      expect(res.body.protocolNumber).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toContain('cancelled');
    });
  }
});
