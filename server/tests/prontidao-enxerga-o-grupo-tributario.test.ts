/**
 * ============================================================================
 * A PRONTIDÃO ENXERGA O GRUPO TRIBUTÁRIO (GAP-PRD-095, GAP-PRD-129)
 * ============================================================================
 *
 * ## O defeito (GAP-PRD-095)
 *
 * O banco da loja tem UM grupo tributário — `SIMPLES-101`, com CSOSN 101 e
 * SEM `pCredSN`, SEM CST de PIS, SEM CST de COFINS. Com o emitente, a série,
 * o CSC e o certificado no lugar, o checklist dizia "pode emitir" e o painel
 * do PDV mostrava o botão; TODA venda morria no clique com
 * `CORE_FISCAL_TRIBUTACAO_INCOMPLETA`. O sistema sabia o que faltava (a recusa
 * nomeia o campo) e não dizia antes: `buildReadiness` nunca olhava
 * `core_tax_groups`, e `emissionReadinessForSale` não rodava a tributação dos
 * itens.
 *
 * ## O defeito vizinho (GAP-PRD-129)
 *
 * O grupo tributário tem CFOP interno, CFOP interestadual, origem e NCM — e o
 * `TributacaoDoItem` os usa quando o produto não declara os dele. Só que a
 * validação da nota (`validateNfce`/`validateNfe`) exigia os três NO PRODUTO,
 * e o checklist também contava só o produto. Resultado: preencher o CFOP no
 * grupo — um gesto para o catálogo inteiro — não destravava nada, e o
 * checklist dizia "a origem vem do grupo" enquanto a validação recusava a
 * venda por falta de origem.
 *
 * ## O que este arquivo crava
 *
 *  - o item `product_tax_group` roda a MESMA régua da emissão sobre o catálogo
 *    e diz, por grupo, o que falta, quantos produtos trava e quem resolve;
 *  - o painel do balcão recebe o motivo ANTES do clique;
 *  - a classificação que o produto não tem vem do grupo — na contagem, na
 *    validação e no XML, com o CFOP interestadual na NF-e para fora do estado.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import forge from 'node-forge';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { getConnection } from '../src/db/sqlite.js';
import {
  linkUserToCompany,
  upsertCompany,
  upsertUser,
} from '../src/services/auth/IdentityService.js';
import { buildReadiness, updateFiscalConfig } from '../src/services/core/FiscalConfigService.js';
import { upsertTaxGroup, upsertTaxRate } from '../src/services/core/CatalogAuxService.js';
import { setSeriesNextNumber } from '../src/services/core/FiscalKeyService.js';
import { emissionReadinessForSale } from '../src/services/core/FiscalPipelineService.js';
import { createNfceForSale, createNfeForSale } from '../src/services/core/FiscalDocumentService.js';
import { upsertNfceCsc } from '../src/services/nfce/NfceCscService.js';
import { upsertCertificateA1 } from '../src/services/fiscal/FiscalCertificateService.js';

const app = createApp();
const SENHA_A1 = 'senha-do-a1-de-teste';
const SENHA_LOGIN = 'Teste@ProntidaoTributaria2026';

let pfx: string;
let loja: string;
let seq = 0;

/**
 * Um A1 de teste cujo EMISSOR não é o titular.
 *
 * O helper comum gera um autoassinado, e o checklist (corretamente) o marca
 * FAIL — o que esconderia o defeito deste arquivo, que é justamente o
 * checklist dizer "pode emitir" quando só a tributação falta.
 */
function gerarA1(): string {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '02';
  cert.validity.notBefore = new Date(Date.now() - 86_400_000);
  cert.validity.notAfter = new Date(Date.now() + 86_400_000 * 365);
  cert.setSubject([{ name: 'commonName', value: 'PJ MOTORS LTDA:11222333000181' }]);
  cert.setIssuer([{ name: 'commonName', value: 'AC CERTIFICADORA FICTICIA v5' }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], SENHA_A1, { algorithm: '3des' });
  return forge.util.encode64(forge.asn1.toDer(p12).getBytes());
}

beforeAll(() => {
  pfx = gerarA1();
});

/** A operação inteira no lugar, MENOS a tributação — o estado do banco da loja. */
function operacaoPronta(crt = '1') {
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
  setSeriesNextNumber({ companyId: loja, model: '65', serie: 1, nextNumber: 1 });
  setSeriesNextNumber({ companyId: loja, model: '55', serie: 1, nextNumber: 1 });
  upsertNfceCsc({
    companyId: loja,
    operationalUnitId: 'unit-default',
    cscId: '000001',
    cscToken: 'CSC-DE-TESTE-NAO-E-O-REAL',
  });
  upsertCertificateA1({
    companyId: loja,
    operationalUnitId: 'unit-default',
    pfxBase64: pfx,
    password: SENHA_A1,
  });
}

function produto(over: { ncm?: string | null; cfop?: string | null; origin?: string | null; taxProfile?: string | null } = {}): string {
  seq += 1;
  const id = `prod-${seq}`;
  const now = new Date().toISOString();
  getConnection()
    .prepare(
      `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                  price_cents, ncm, cfop, origin, tax_profile, active,
                                  created_at, updated_at)
       VALUES (?, ?, ?, ?, 'UN', 1000, 5000, ?, ?, ?, ?, 1, ?, ?)`,
    )
    .run(
      id,
      loja,
      `GS-${seq}`,
      `Peça ${seq}`,
      over.ncm === undefined ? '87083090' : over.ncm,
      over.cfop === undefined ? '5102' : over.cfop,
      over.origin === undefined ? '0' : over.origin,
      over.taxProfile ?? null,
      now,
      now,
    );
  return id;
}

function venda(productId: string): string {
  seq += 1;
  const id = `venda-${seq}`;
  const now = new Date().toISOString();
  const db = getConnection();
  db.prepare(
    `INSERT INTO core_sales (id, company_id, number, status, subtotal_cents, discount_cents,
                             surcharge_cents, total_cents, origin, idempotency_key,
                             change_cents, created_at)
     VALUES (?, ?, ?, 'completed', 10000, 0, 0, 10000, 'pdv', ?, 0, ?)`,
  ).run(id, loja, seq, `k-${id}`, now);
  db.prepare(
    `INSERT INTO core_sale_items (id, sale_id, company_id, product_id, description, quantity,
                                  unit_price_cents, discount_cents, total_cents)
     VALUES (?, ?, ?, ?, 'Peça', 2, 5000, 0, 10000)`,
  ).run(`item-${id}`, id, loja, productId);
  db.prepare(
    `INSERT INTO core_sale_payments (id, sale_id, company_id, method, amount_cents, status, created_at)
     VALUES (?, ?, ?, 'dinheiro', 10000, 'settled', ?)`,
  ).run(`pay-${id}`, id, loja, now);
  return id;
}

const item = (key = 'product_tax_group') =>
  buildReadiness(loja, '65').items.find((i) => i.key === key)!;

beforeEach(() => {
  resetDbForTests();
  ensureCoreSchema();
  seq = 0;
  loja = upsertCompany({ slug: 'pj-motors', legalName: 'PJ Motors Ltda', tradeName: 'PJ Motors' });
});

// ============================================================================

describe('o estado do banco da loja: SIMPLES-101 sem pCredSN e sem CST de PIS/COFINS', () => {
  function grupoDaLoja(extras: Record<string, unknown> = {}) {
    return upsertTaxGroup(loja, {
      code: 'SIMPLES-101',
      name: 'Simples — CSOSN 101',
      regime: 'simples',
      csosn: '101',
      cfopInternal: '5102',
      ...extras,
    });
  }

  it('o checklist deixa de dizer "pode emitir": só a tributação falta, e ela é nomeada', () => {
    operacaoPronta();
    grupoDaLoja();
    for (let i = 0; i < 12; i += 1) produto();

    const r = buildReadiness(loja, '65');
    const tributacao = r.items.find((i) => i.key === 'product_tax_group');
    expect(tributacao, 'o checklist não tem item de tributação').toBeTruthy();
    expect(tributacao!.status).toBe('FAIL');
    expect(tributacao!.owner).toBe('contador');
    expect(tributacao!.state).toBe('PENDENTE');
    expect(tributacao!.counts).toEqual({ done: 0, total: 12, percent: 0 });
    expect(tributacao!.detail).toContain('SIMPLES-101');
    expect(tributacao!.detail).toContain('pCredSN');
    expect(tributacao!.detail).toContain('12 produto');

    /*
      A PROVA DE QUE ERA SÓ ISTO: o único bloqueio do relatório é o item novo.
      Antes deste conserto, `canEmit` era `true` com exatamente este banco.
    */
    expect(r.canEmit).toBe(false);
    expect(r.blockingReasons).toHaveLength(1);
    expect(r.blockingReasons[0]).toContain('pCredSN');
  });

  it('o contador informa pCredSN e os CST — o item vira PASS, 12 de 12, e a operação emite', () => {
    operacaoPronta();
    const g = grupoDaLoja();
    for (let i = 0; i < 12; i += 1) produto();
    grupoDaLoja({ id: g.id, pCredSn: '2.80', cstPis: '49', cstCofins: '49' });

    const tributacao = item();
    expect(tributacao.status).toBe('PASS');
    expect(tributacao.state).toBe('CONFIRMADO');
    expect(tributacao.counts).toEqual({ done: 12, total: 12, percent: 100 });
    expect(tributacao.known).toContain('SIMPLES-101');
    expect(buildReadiness(loja, '65').canEmit).toBe(true);
  });

  it('o painel do balcão recebe o motivo ANTES do clique — e o número não anda', () => {
    operacaoPronta();
    grupoDaLoja();
    const saleId = venda(produto());

    const antes = emissionReadinessForSale(loja, saleId);
    expect(antes.canEmit).toBe(false);
    expect(antes.reasons.join(' | ')).toContain('pCredSN');

    const g = getConnection()
      .prepare("SELECT id FROM core_tax_groups WHERE company_id = ? AND code = 'SIMPLES-101'")
      .get(loja) as { id: string };
    grupoDaLoja({ id: g.id, pCredSn: '2.80', cstPis: '49', cstCofins: '49' });
    const depois = emissionReadinessForSale(loja, saleId);
    expect(depois.reasons).toEqual([]);
    expect(depois.canEmit).toBe(true);
  });

  it('a lista para o contador vem inteira: todos os campos que faltam, não só o primeiro', () => {
    operacaoPronta();
    grupoDaLoja({ pCredSn: '2.80' });
    produto();
    const tributacao = item();
    expect(tributacao.detail).toMatch(/PIS/);
    expect(tributacao.detail).toMatch(/COFINS/);
  });
});

// ============================================================================

describe('as outras formas de a tributação não fechar', () => {
  const COMPLETO = { regime: 'simples', csosn: '102', cstPis: '49', cstCofins: '49', cfopInternal: '5102' };

  it('produto sem perfil com dois grupos ativos: FAIL, e o detalhe manda escolher o perfil', () => {
    operacaoPronta();
    upsertTaxGroup(loja, { code: 'A', name: 'A', ...COMPLETO });
    upsertTaxGroup(loja, { code: 'B', name: 'B', ...COMPLETO });
    produto();
    const tributacao = item();
    expect(tributacao.status).toBe('FAIL');
    expect(tributacao.detail).toMatch(/2 grupos ativos/);
  });

  it('perfil que não existe nesta operação: FAIL nomeando o perfil', () => {
    operacaoPronta();
    upsertTaxGroup(loja, { code: 'PADRAO', name: 'Padrão', ...COMPLETO });
    produto({ taxProfile: 'DA-VIZINHA' });
    produto({ taxProfile: 'PADRAO' });
    const tributacao = item();
    expect(tributacao.status).toBe('FAIL');
    expect(tributacao.detail).toContain('DA-VIZINHA');
    expect(tributacao.counts).toEqual({ done: 1, total: 2, percent: 50 });
  });

  it('grupo quebrado que nenhum produto usa: aviso (PENDING), não bloqueio', () => {
    operacaoPronta();
    upsertTaxGroup(loja, { code: 'PADRAO', name: 'Padrão', ...COMPLETO });
    upsertTaxGroup(loja, { code: 'RASCUNHO', name: 'Rascunho', regime: 'simples', csosn: '101' });
    produto({ taxProfile: 'PADRAO' });
    const tributacao = item();
    expect(tributacao.status).toBe('PENDING');
    expect(tributacao.detail).toContain('RASCUNHO');
    expect(buildReadiness(loja, '65').canEmit).toBe(true);
  });

  it('regime normal sem alíquota de ICMS: o item diz, antes da venda', () => {
    operacaoPronta('3');
    upsertTaxGroup(loja, { code: 'NORMAL', name: 'Normal', regime: 'normal', cstIcms: '00', cstPis: '01', cstCofins: '01', cfopInternal: '5102' });
    upsertTaxRate(loja, { code: 'PIS', name: 'PIS', kind: 'pis', percent: 1.65 });
    upsertTaxRate(loja, { code: 'COFINS', name: 'COFINS', kind: 'cofins', percent: 7.6 });
    produto();
    const tributacao = item();
    expect(tributacao.status).toBe('FAIL');
    expect(tributacao.detail).toMatch(/alíquota de ICMS/i);
  });

  it('ST cobrada por fora (CSOSN 201): o item diz que o sistema não cobra por fora', () => {
    operacaoPronta();
    upsertTaxGroup(loja, { code: 'ST', name: 'ST', ...COMPLETO, csosn: '201', pCredSn: '2.80' });
    produto();
    expect(item().detail).toMatch(/por fora/i);
  });

  it('catálogo vazio e nenhum grupo: não bloqueia, mas avisa que a primeira venda será recusada', () => {
    operacaoPronta();
    const tributacao = item();
    expect(tributacao.status).toBe('PENDING');
    expect(tributacao.state).toBe('PENDENTE');
    expect(tributacao.detail).toMatch(/grupo tributário/i);
  });
});

// ============================================================================

describe('a classificação que o produto não tem vem do grupo (GAP-PRD-129)', () => {
  function grupoComClassificacao() {
    upsertTaxGroup(loja, {
      code: 'PECAS',
      name: 'Peças',
      regime: 'simples',
      csosn: '500',
      cstPis: '49',
      cstCofins: '49',
      cfopInternal: '5405',
      cfopExternal: '6404',
      origin: '0',
      ncm: '87083090',
    });
  }

  it('produto sem NCM, CFOP e origem próprios, grupo com os três: conta como classificado', () => {
    operacaoPronta();
    grupoComClassificacao();
    produto({ ncm: null, cfop: null, origin: null });

    expect(item('product_ncm')).toMatchObject({ status: 'PASS', counts: { done: 1, total: 1, percent: 100 } });
    expect(item('product_cfop')).toMatchObject({ status: 'PASS', counts: { done: 1, total: 1, percent: 100 } });
    expect(item('product_origin')).toMatchObject({ status: 'PASS', counts: { done: 1, total: 1, percent: 100 } });
    expect(buildReadiness(loja, '65').canEmit).toBe(true);
  });

  it('e a NFC-e SAI com o que o grupo declara — o que o checklist promete, a emissão cumpre', () => {
    operacaoPronta();
    grupoComClassificacao();
    const saleId = venda(produto({ ncm: null, cfop: null, origin: null }));

    expect(emissionReadinessForSale(loja, saleId)).toMatchObject({ canEmit: true, reasons: [] });
    const { document } = createNfceForSale({ companyId: loja, saleId });
    const xml = (getConnection()
      .prepare('SELECT xml_original FROM core_fiscal_documents WHERE id = ?')
      .get(document.id) as { xml_original: string }).xml_original;
    expect(xml).toContain('<NCM>87083090</NCM>');
    expect(xml).toContain('<CFOP>5405</CFOP>');
    expect(xml.replace(/\s+/g, '')).toContain('<ICMSSN500><orig>0</orig><CSOSN>500</CSOSN>');
  });

  it('NF-e para outro estado: o CFOP INTERESTADUAL do grupo, e não o interno', () => {
    operacaoPronta();
    grupoComClassificacao();
    const saleId = venda(produto({ ncm: null, cfop: null, origin: null }));
    const { document } = createNfeForSale({
      companyId: loja,
      saleId,
      recipient: {
        document: '11.444.777/0001-61',
        name: 'Distribuidora Paulista Ltda',
        ieIndicator: '9',
        ie: null,
        street: 'Rua Augusta',
        number: '1000',
        district: 'Consolação',
        cityIbge: '3550308',
        cityName: 'São Paulo',
        uf: 'SP',
        zip: '01305-100',
      } as never,
    });
    const xml = (getConnection()
      .prepare('SELECT xml_original FROM core_fiscal_documents WHERE id = ?')
      .get(document.id) as { xml_original: string }).xml_original;
    expect(xml).toContain('<CFOP>6404</CFOP>');
  });

  it('o CFOP do próprio produto continua vencendo o do grupo', () => {
    operacaoPronta();
    grupoComClassificacao();
    const saleId = venda(produto({ cfop: '5102' }));
    const { document } = createNfceForSale({ companyId: loja, saleId });
    const xml = (getConnection()
      .prepare('SELECT xml_original FROM core_fiscal_documents WHERE id = ?')
      .get(document.id) as { xml_original: string }).xml_original;
    expect(xml).toContain('<CFOP>5102</CFOP>');
  });

  it('sem CFOP no produto nem no grupo: continua recusado, e o checklist conta o produto como pendente', () => {
    operacaoPronta();
    upsertTaxGroup(loja, { code: 'SEMCFOP', name: 'Sem CFOP', regime: 'simples', csosn: '102', cstPis: '49', cstCofins: '49' });
    const saleId = venda(produto({ cfop: null }));
    expect(item('product_cfop')).toMatchObject({ status: 'FAIL', counts: { done: 0, total: 1, percent: 0 } });
    expect(emissionReadinessForSale(loja, saleId).canEmit).toBe(false);
  });
});

// ============================================================================

describe('a rota do balcão', () => {
  it('pdv-summary: pendência de tributação é pendência de catálogo, e aparece nomeada', async () => {
    operacaoPronta();
    upsertTaxGroup(loja, { code: 'SIMPLES-101', name: 'Simples', regime: 'simples', csosn: '101', cfopInternal: '5102' });
    produto();

    const userId = await upsertUser({ login: 'CAIXAPRONT', displayName: 'Caixa', password: SENHA_LOGIN });
    linkUserToCompany(userId, loja, 'gerente_loja', true);
    const login = await request(app).post('/api/v1/auth/login').send({ login: 'CAIXAPRONT', password: SENHA_LOGIN });
    expect(login.status).toBe(200);

    const res = await request(app)
      .get('/api/v1/core/fiscal/pdv-summary')
      .set({ Authorization: `Bearer ${login.body.accessToken}` });
    expect(res.status).toBe(200);
    expect(res.body.canEmit).toBe(false);
    expect(res.body.situacao).toBe('PENDING');
    expect(res.body.blocking.map((b: { key: string }) => b.key)).toEqual(['product_tax_group']);
  });
});
