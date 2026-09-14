/**
 * Pipeline fiscal completo, do PDV ao desfecho.
 *
 * Os três cenários que importam — autorizada, rejeitada e resposta perdida —
 * e a invariante que atravessa todos: a venda continua UMA, o estoque continua
 * baixado UMA vez, a receita continua UMA. Fiscal é consequência da venda,
 * nunca uma segunda venda.
 */
import { beforeEach, describe, expect, it } from 'vitest';
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
import {
  FIXTURE_SIGNATURE_MARK,
  emitNfceForSale,
  fiscalStatusForSale,
} from '../src/services/core/FiscalPipelineService.js';
import { getDocumentBySale } from '../src/services/core/FiscalDocumentService.js';
import { SefazTestAdapter } from '../src/services/core/SefazTestAdapter.js';
import { renderDanfce } from '../src/services/core/DanfceRenderer.js';
import { grupoTributarioPadrao } from './helpers/grupoTributario.js';

const app = createApp();
const PASSWORD = 'Teste@Pipeline2026';

let companyId: string;
let caixa: { Authorization: string };
let numero = 0;

function criarVenda(id: string): string {
  ensureCoreSchema();
  numero += 1;
  const db = getConnection();
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                price_cents, ncm, cfop, origin, active, created_at, updated_at)
     VALUES (?, ?, ?, 'Camisa Fixture', 'UN', 1000, 5000, '62052000', '5102', '0', 1, ?, ?)`,
  ).run(`prod-${id}`, companyId, `FIX-${numero}`, now, now);

  db.prepare(
    `INSERT INTO core_sales (id, company_id, number, status, subtotal_cents, discount_cents,
                             surcharge_cents, total_cents, origin, idempotency_key, change_cents, created_at)
     VALUES (?, ?, ?, 'completed', 10000, 0, 0, 10000, 'pdv', ?, 0, ?)`,
  ).run(id, companyId, numero, `k-${id}`, now);

  db.prepare(
    `INSERT INTO core_sale_items (id, sale_id, company_id, product_id, description, quantity,
                                  unit_price_cents, discount_cents, total_cents)
     VALUES (?, ?, ?, ?, 'Camisa Fixture', 2, 5000, 0, 10000)`,
  ).run(`item-${id}`, id, companyId, `prod-${id}`);

  db.prepare(
    `INSERT INTO core_sale_payments (id, sale_id, company_id, method, amount_cents, status, created_at)
     VALUES (?, ?, ?, 'dinheiro', 10000, 'settled', ?)`,
  ).run(`pay-${id}`, id, companyId, now);

  // Uma baixa de estoque e um lançamento financeiro, como a venda real produz.
  db.prepare(
    `INSERT INTO core_stock_movements (id, company_id, product_id, movement_type, kind, quantity,
                                       quantity_before, balance_after, reference_type,
                                       reference_id, created_at)
     VALUES (?, ?, ?, 'out', 'SALE', 2, 10, 8, 'sale', ?, ?)`,
  ).run(`mov-${id}`, companyId, `prod-${id}`, id, now);

  db.prepare(
    `INSERT INTO core_finance_entries (id, company_id, direction, amount_cents, status,
                                       settled_cents, description, origin_type, origin_id, created_at)
     VALUES (?, ?, 'in', 10000, 'settled', 10000, 'Venda', 'sale', ?, ?)`,
  ).run(`fin-${id}`, companyId, id, now);

  return id;
}

function contagens() {
  const db = getConnection();
  const n = (t: string) => Number((db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c);
  return {
    vendas: n('core_sales'),
    itens: n('core_sale_items'),
    pagamentos: n('core_sale_payments'),
    estoque: n('core_stock_movements'),
    financeiro: n('core_finance_entries'),
    documentos: n('core_fiscal_documents'),
  };
}

beforeEach(async () => {
  resetDbForTests();
  numero = 0;
  companyId = upsertCompany({
    slug: 'preco-justo',
    legalName: 'Preço Justo Ltda',
    tradeName: 'Preço Justo',
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
  grupoTributarioPadrao(companyId);
  setSeriesNextNumber({ companyId, model: '65', serie: 1, nextNumber: 1 });

  const userId = await upsertUser({ login: 'CAIXA1', displayName: 'Caixa', password: PASSWORD });
  linkUserToCompany(userId, companyId, 'operador_caixa_loja', true);
  const res = await request(app).post('/api/v1/auth/login').send({ login: 'CAIXA1', password: PASSWORD });
  caixa = { Authorization: `Bearer ${res.body.accessToken}` };
});

describe('CENÁRIO 1 — autorizada (provider de teste)', () => {
  it('percorre o pipeline inteiro e chega a AUTHORIZED', async () => {
    const saleId = criarVenda('v1');
    const antes = contagens();

    const r = await emitNfceForSale({ companyId, saleId, developmentMode: true });

    expect(r.document.status).toBe('AUTHORIZED');
    expect(r.statusLabel).toBe('NFC-e autorizada');
    expect(r.terminal).toBe(true);
    expect(r.isTest).toBe(true);
    expect(r.document.protocol).toMatch(/^TEST-/);
    expect(r.document.accessKey).toMatch(/^\d{44}$/);

    // A INVARIANTE: nada comercial foi recriado.
    const depois = contagens();
    expect(depois.vendas).toBe(antes.vendas);
    expect(depois.itens).toBe(antes.itens);
    expect(depois.pagamentos).toBe(antes.pagamentos);
    expect(depois.estoque).toBe(antes.estoque);
    expect(depois.financeiro).toBe(antes.financeiro);
    expect(depois.documentos).toBe(antes.documentos + 1);
  });

  it('o DANFCE fica disponível e sai marcado como teste', async () => {
    const saleId = criarVenda('v2');
    const r = await emitNfceForSale({ companyId, saleId, developmentMode: true });

    const html = renderDanfce(companyId, r.document.id);
    expect(html).toContain('AMBIENTE DE TESTE');
    expect(html).toContain('Camisa Fixture');
    expect(html).toContain(r.document.protocol!);
  });

  it('chamar duas vezes não gera segundo documento nem segundo número', async () => {
    const saleId = criarVenda('v3');
    const a = await emitNfceForSale({ companyId, saleId, developmentMode: true });
    const b = await emitNfceForSale({ companyId, saleId, developmentMode: true });

    expect(b.document.id).toBe(a.document.id);
    expect(b.document.number).toBe(a.document.number);
    expect(b.document.accessKey).toBe(a.document.accessKey);
    expect(contagens().documentos).toBe(1);
  });

  it('o XML assinado carrega a marca de fixture', async () => {
    const saleId = criarVenda('v4');
    const r = await emitNfceForSale({ companyId, saleId, developmentMode: true });
    const row = getConnection()
      .prepare('SELECT xml_signed FROM core_fiscal_documents WHERE id = ?')
      .get(r.document.id) as { xml_signed: string };
    expect(row.xml_signed).toContain(FIXTURE_SIGNATURE_MARK);
  });
});

describe('CENÁRIO 2 — rejeitada', () => {
  it('venda permanece única e íntegra; documento fica REJECTED', async () => {
    const saleId = criarVenda('v5');
    const antes = contagens();

    const adapter = new SefazTestAdapter();
    adapter.setScenario('REJECTED');
    adapter.setConsultScenario('CONSULT_NOT_FOUND');
    const r = await emitNfceForSale({ companyId, saleId, developmentMode: true, adapter });

    expect(r.document.status).toBe('REJECTED');
    expect(r.statusLabel).toBe('NFC-e rejeitada');
    expect(r.document.cStat).toBeTruthy();
    expect(r.document.xMotivo).toBeTruthy();
    expect(r.document.protocol).toBeNull();

    const depois = contagens();
    expect(depois.vendas).toBe(antes.vendas);
    expect(depois.estoque).toBe(antes.estoque);
    expect(depois.financeiro).toBe(antes.financeiro);
  });

  it('rejeitada NÃO imprime DANFCE autorizado', async () => {
    const saleId = criarVenda('v6');
    const adapter = new SefazTestAdapter();
    adapter.setScenario('REJECTED');
    adapter.setConsultScenario('CONSULT_NOT_FOUND');
    const r = await emitNfceForSale({ companyId, saleId, developmentMode: true, adapter });

    expect(() => renderDanfce(companyId, r.document.id)).toThrow(/autorizado/i);

    // O preview técnico existe, mas sai marcado.
    const preview = renderDanfce(companyId, r.document.id, { allowUnauthorized: true });
    expect(preview).toContain('DOCUMENTO NÃO AUTORIZADO');
  });
});

describe('CENÁRIO 3 — resposta não confirmada', () => {
  it('timeout leva a consulta e a nota é reconciliada como autorizada', async () => {
    const saleId = criarVenda('v7');
    const antes = contagens();

    const adapter = new SefazTestAdapter();
    adapter.setScenario('TIMEOUT'); // a SEFAZ recebeu; a resposta se perdeu
    const r = await emitNfceForSale({ companyId, saleId, developmentMode: true, adapter });

    expect(r.document.status).toBe('AUTHORIZED');
    expect(r.document.protocol).toBeTruthy();

    // E, mesmo com a incerteza, nada foi duplicado.
    const depois = contagens();
    expect(depois.documentos).toBe(antes.documentos + 1);
    expect(depois.vendas).toBe(antes.vendas);
  });

  it('rede fora e chave desconhecida deixam a nota pendente, não perdida', async () => {
    const saleId = criarVenda('v8');
    const adapter = new SefazTestAdapter();
    adapter.setScenario('NETWORK_ERROR');
    adapter.setConsultScenario('CONSULT_NOT_FOUND');
    const r = await emitNfceForSale({ companyId, saleId, developmentMode: true, adapter });

    expect(r.document.status).toBe('QUEUED');
    expect(r.statusLabel).toBe('Aguardando transmissão');
    expect(r.terminal).toBe(false);

    const status = fiscalStatusForSale(companyId, saleId)!;
    expect(status.queue?.attempts).toBe(1);
    expect(status.queue?.nextAttemptAt).toBeTruthy();
  });
});

describe('produção nunca aceita o modo de desenvolvimento', () => {
  it('recusa mesmo quando pedido explicitamente', async () => {
    getConnection()
      .prepare("UPDATE core_fiscal_configs SET environment = 'production' WHERE company_id = ?")
      .run(companyId);
    const saleId = criarVenda('v9');

    await expect(
      emitNfceForSale({ companyId, saleId, developmentMode: true }),
    ).rejects.toThrow(/não é permitido em produção/i);

    expect(getDocumentBySale(companyId, saleId)).toBeNull();
  });

  it('produção sem senha de certificado não assina', async () => {
    getConnection()
      .prepare("UPDATE core_fiscal_configs SET environment = 'production' WHERE company_id = ?")
      .run(companyId);
    const saleId = criarVenda('v10');

    await expect(
      emitNfceForSale({ companyId, saleId, developmentMode: false }),
    ).rejects.toThrow();
  });
});

describe('rotas', () => {
  it('o caixa consegue emitir a nota da própria venda', async () => {
    const saleId = criarVenda('v11');
    const res = await request(app)
      .post(`/api/v1/core/fiscal/sales/${saleId}/emit`)
      .set(caixa)
      .send({ developmentMode: true });

    expect(res.status).toBe(200);
    expect(res.body.document.status).toBe('AUTHORIZED');
    expect(res.body.statusLabel).toBe('NFC-e autorizada');
  });

  it('a consulta de status responde sem recarregar a venda', async () => {
    const saleId = criarVenda('v12');
    await emitNfceForSale({ companyId, saleId, developmentMode: true });

    const res = await request(app).get(`/api/v1/core/fiscal/sales/${saleId}/status`).set(caixa);
    expect(res.status).toBe(200);
    expect(res.body.terminal).toBe(true);
    expect(res.body.statusLabel).toBe('NFC-e autorizada');
  });

  it('venda sem nota devolve nulo, não erro', async () => {
    const saleId = criarVenda('v13');
    const res = await request(app).get(`/api/v1/core/fiscal/sales/${saleId}/status`).set(caixa);
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
  });

  it('a listagem traz venda, cliente e valor por junção', async () => {
    const saleId = criarVenda('v14');
    await emitNfceForSale({ companyId, saleId, developmentMode: true });

    const res = await request(app).get('/api/v1/core/fiscal/documents').set(caixa);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].totalCents).toBe(10000);
    expect(res.body.items[0].saleNumber).toBeTruthy();
  });

  it('filtro por status funciona', async () => {
    await emitNfceForSale({ companyId, saleId: criarVenda('v15'), developmentMode: true });

    const autorizadas = await request(app)
      .get('/api/v1/core/fiscal/documents?status=AUTHORIZED')
      .set(caixa);
    const rejeitadas = await request(app)
      .get('/api/v1/core/fiscal/documents?status=REJECTED')
      .set(caixa);

    expect(autorizadas.body.items).toHaveLength(1);
    expect(rejeitadas.body.items).toHaveLength(0);
  });

  it('o detalhe traz a linha do tempo append-only', async () => {
    const saleId = criarVenda('v16');
    const r = await emitNfceForSale({ companyId, saleId, developmentMode: true });

    const res = await request(app)
      .get(`/api/v1/core/fiscal/documents/${r.document.id}`)
      .set(caixa);

    expect(res.status).toBe(200);
    const tipos = (res.body.events as { eventType: string }[]).map((e) => e.eventType);
    expect(tipos).toContain('status:DRAFT->VALIDATED');
    expect(tipos).toContain('status:VALIDATED->SIGNED');
    expect(tipos).toContain('status:SENDING->AUTHORIZED');
  });

  it('o DANFCE é servido como HTML', async () => {
    const saleId = criarVenda('v17');
    const r = await emitNfceForSale({ companyId, saleId, developmentMode: true });

    const res = await request(app)
      .get(`/api/v1/core/fiscal/documents/${r.document.id}/danfce`)
      .set(caixa);

    expect(res.status).toBe(200);
    expect(res.text).toContain('AMBIENTE DE TESTE');
  });

  it('mecânico não acessa documentos fiscais', async () => {
    const mecId = await upsertUser({ login: 'MECPIPE', displayName: 'Mec', password: PASSWORD });
    linkUserToCompany(mecId, companyId, 'mecanico', true);
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ login: 'MECPIPE', password: PASSWORD });
    const auth = { Authorization: `Bearer ${login.body.accessToken}` };

    expect((await request(app).get('/api/v1/core/fiscal/documents').set(auth)).status).toBe(403);
    expect((await request(app).get('/api/v1/core/fiscal/reconciliation').set(auth)).status).toBe(403);
  });
});

describe('isolamento entre operações', () => {
  it('documento de uma operação não aparece na outra', async () => {
    const saleId = criarVenda('v18');
    await emitNfceForSale({ companyId, saleId, developmentMode: true });

    const outraCo = upsertCompany({ slug: 'gringa', legalName: 'Gringa', tradeName: 'Gringa' });
    const outroId = await upsertUser({
      login: 'CAIXAGRINGA',
      displayName: 'Caixa Gringa',
      password: PASSWORD,
    });
    linkUserToCompany(outroId, outraCo, 'operador_caixa_loja', true);
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ login: 'CAIXAGRINGA', password: PASSWORD });

    const res = await request(app)
      .get('/api/v1/core/fiscal/documents')
      .set({ Authorization: `Bearer ${login.body.accessToken}` });

    expect(res.body.items).toHaveLength(0);
  });
});
