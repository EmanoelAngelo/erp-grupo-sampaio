/**
 * DOCUMENTOS IMPRESSOS — COMPLEMENTOS (auditoria PJ, trilha "documentos", lote 4b).
 *
 * ============================================================================
 * O QUE ESTAVA ACONTECENDO
 * ============================================================================
 *
 * C-etiquetas-11  A prontidão de impressão contava impressora de QUALQUER tipo
 *                 como "de agente". Uma etiqueta cadastrada como agente antes
 *                 da trava do cadastro, com página de teste confirmada, fazia
 *                 a prontidão dizer AGENT_READY ("impressão direta") numa loja
 *                 em que nenhum cupom sai pelo agente.
 *
 * C-etiquetas-03#avulsa  A etiqueta avulsa da fila (PRODUCT_LABEL) desenhava
 *                 só EAN-13 (`ean13Svg`): EAN-8, UPC-A e o código próprio da
 *                 loja (alfanumérico) saíam "SEM CÓDIGO DE BARRAS". Hoje a
 *                 fila usa a folha de etiquetas (`renderLabelSheet`), que
 *                 escolhe a simbologia pelo formato do código — estes casos
 *                 prendem isso.
 *
 * F-cupom-fiscal-07#danfce  `GET /fiscal/documents/:id/danfce` — o "Ver
 *                 DANFCE" do PDV — chamava `renderDanfce` sem largura: o
 *                 DANFCE saía sempre em 80 mm, mesmo com a térmica de 58 mm.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { resetEnvCacheForTests } from '../src/config/env.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { linkUserToCompany, upsertCompany, upsertUser } from '../src/services/auth/IdentityService.js';
import { ClienteDoServidor, parearComOServidor, type Buscador } from '../src/local-agent/ClienteDoServidor.js';
import { printReadiness, upsertPrinter } from '../src/services/core/PrintEngine.js';
import { renderDocument } from '../src/services/core/PrintRenderer.js';
import { createProduct } from '../src/services/core/CatalogService.js';
import { updateFiscalConfig } from '../src/services/core/FiscalConfigService.js';
import { setSeriesNextNumber } from '../src/services/core/FiscalKeyService.js';
import {
  createNfceForSale,
  getDocument,
  transition,
  validateDocument,
} from '../src/services/core/FiscalDocumentService.js';
import { enqueue, processNext } from '../src/services/core/FiscalQueueService.js';
import { SefazTestAdapter } from '../src/services/core/SefazTestAdapter.js';
import { grupoTributarioPadrao } from './helpers/grupoTributario.js';

process.env.DEVORA_JWT_SECRET = 'documentos-4b-teste-jwt-secret-bem-comprido';
process.env.DEVORA_ENCRYPTION_KEY = 'documentos-4b-teste-chave-de-cifra-bem-comprida';

const app = createApp();
const SERVIDOR = 'http://servidor-em-memoria/api/v1';
const SENHA = 'Documentos4b@2026';

const buscar: Buscador = async (url, init) => {
  const u = new URL(url);
  const caminho = `${u.pathname}${u.search}`;
  const base = init.method === 'GET' ? request(app).get(caminho) : request(app).post(caminho);
  const pedido = base.set(init.headers);
  const res = init.body === undefined ? await pedido : await pedido.send(init.body);
  return { status: res.status, json: async () => res.body as unknown };
};

type Auth = { Authorization: string };
let empresa: string;
let gerente: Auth;
let caixa: Auth;

async function login(l: string, perfil: string): Promise<Auth> {
  const userId = await upsertUser({ login: l, displayName: l, password: SENHA });
  linkUserToCompany(userId, empresa, perfil, true);
  const r = await request(app).post('/api/v1/auth/login').send({ login: l, password: SENHA, companyId: empresa });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return { Authorization: `Bearer ${r.body.accessToken as string}` };
}

function novoCaixa(id: string, nome: string): string {
  getConnection()
    .prepare(`INSERT INTO core_terminals (id, company_id, code, name, active, created_at) VALUES (?, ?, ?, ?, 1, ?)`)
    .run(id, empresa, `CX-${id}`, nome, new Date().toISOString());
  return id;
}

/** O gerente gera o código para o caixa; o PROGRAMA pareia e manda o primeiro sinal. */
async function instalarAgente(caixaId: string): Promise<void> {
  const codigo = await request(app)
    .post('/api/v1/payment-terminals/local-agent/pairing')
    .set(gerente)
    .send({ pdvTerminalId: caixaId });
  expect(codigo.status, JSON.stringify(codigo.body)).toBeLessThan(300);
  const par = await parearComOServidor(SERVIDOR, String(codigo.body.pairingCode), { version: '1.1.0', hostname: 'CAIXA' }, buscar);
  const cliente = new ClienteDoServidor({ servidor: SERVIDOR, agentId: par.agentId, segredo: par.segredo }, buscar);
  await cliente.sinal({ version: '1.1.0', hostname: 'CAIXA', health: {} });
}

/** A página de teste que o agente confirmou como impressa, gravada como o agente a deixaria. */
function testeConfirmado(printerId: string): void {
  const agora = new Date().toISOString();
  getConnection()
    .prepare(
      `INSERT INTO core_print_jobs (id, company_id, document_type, document_id, printer_id, status, created_at, printed_at, transport)
       VALUES (?, ?, 'PRINTER_TEST', ?, ?, 'printed', ?, ?, 'agent')`,
    )
    .run(randomUUID(), empresa, printerId, printerId, agora, agora);
}

beforeEach(async () => {
  process.env.DEVORA_API_ENV = 'test';
  resetEnvCacheForTests();
  resetDbForTests();
  ensureCoreSchema();
  empresa = upsertCompany({ slug: 'preco-justo-4b', legalName: 'Preço Justo Ltda', tradeName: 'Preço Justo' });
  gerente = await login('GERENTE.4B', 'gerente_loja');
  caixa = await login('CAIXA.4B', 'operador_caixa_loja');
});

// ============================================================================

describe('C-etiquetas-11 — a prontidão só conta a impressora de CUPOM como impressão direta', () => {
  it('etiqueta antiga "de agente", com agente no ar e teste confirmado, NÃO torna a prontidão AGENT_READY', async () => {
    const cx = novoCaixa('cx-etq', 'Caixa 1');
    await instalarAgente(cx);
    // Cadastrada antes da trava da rota: o serviço ainda grava, a rota recusa.
    const argox = upsertPrinter({
      companyId: empresa,
      name: 'Argox antiga',
      kind: 'etiqueta',
      transport: 'agent',
      agentDevice: 'COM3',
      pdvTerminalId: cx,
    });
    testeConfirmado(argox.id);

    const r = await request(app).get('/api/v1/core/print/readiness').set(gerente);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    // Antes: AGENT_READY — "1 impressora(s) com página de teste confirmada".
    expect(r.body.readiness).toBe('BROWSER_ONLY');
    expect(r.body.message).not.toMatch(/página de teste confirmada/);
    // E a lista diz o que fazer com ela, em vez de mostrá-la como pronta.
    expect(r.body.message).toMatch(/o agente só imprime cupom/);
    const situacao = r.body.printers.find((p: { printerId: string }) => p.printerId === argox.id);
    expect(situacao).toMatchObject({ ready: false, kind: 'etiqueta' });
    expect(situacao.problem).toMatch(/escolha "Navegador"/);
  });

  it('cupom de agente SEM teste + etiqueta com teste: continua faltando confirmar o cupom', async () => {
    const cx = novoCaixa('cx-mix', 'Caixa 1');
    await instalarAgente(cx);
    upsertPrinter({
      companyId: empresa,
      name: 'Térmica do balcão',
      kind: 'cupom',
      transport: 'agent',
      paperWidthMm: 80,
      agentDevice: 'tcp:192.168.0.50:9100',
      pdvTerminalId: cx,
    });
    const argox = upsertPrinter({
      companyId: empresa,
      name: 'Argox antiga',
      kind: 'etiqueta',
      transport: 'agent',
      agentDevice: 'COM3',
      pdvTerminalId: cx,
    });
    testeConfirmado(argox.id);

    const prontidao = printReadiness(empresa);
    // Antes: a etiqueta entrava em `homologadas` e a prontidão dizia AGENT_READY.
    expect(prontidao.readiness).toBe('READY_FOR_HARDWARE');
    expect(prontidao.message).toMatch(/imprima a página de teste/);
  });

  it('a de cupom com teste confirmado continua AGENT_READY, e a conta não inclui a etiqueta', async () => {
    const cx = novoCaixa('cx-ok', 'Caixa 1');
    await instalarAgente(cx);
    const termica = upsertPrinter({
      companyId: empresa,
      name: 'Térmica do balcão',
      kind: 'cupom',
      transport: 'agent',
      paperWidthMm: 80,
      agentDevice: 'tcp:192.168.0.50:9100',
      pdvTerminalId: cx,
    });
    testeConfirmado(termica.id);
    const argox = upsertPrinter({
      companyId: empresa,
      name: 'Argox antiga',
      kind: 'etiqueta',
      transport: 'agent',
      agentDevice: 'COM3',
      pdvTerminalId: cx,
    });
    testeConfirmado(argox.id);

    const prontidao = printReadiness(empresa);
    expect(prontidao.readiness).toBe('AGENT_READY');
    // Antes: "2 impressora(s)" — a etiqueta contada como impressão direta.
    expect(prontidao.message).toMatch(/: 1 impressora\(s\) com página de teste confirmada\.$/);
  });
});

// ============================================================================

describe('C-etiquetas-03#avulsa — a etiqueta da fila desenha o código que o produto tem', () => {
  const casos: [string, string][] = [
    ['EAN-13', '7891234567895'],
    ['EAN-8', '96385074'],
    ['UPC-A', '036000291452'],
    ['Code128', 'PJ-ABC-001'],
  ];

  for (const [simbologia, codigo] of casos) {
    it(`${simbologia} (${codigo}) vira barras, com o número embaixo`, () => {
      const id = String(createProduct(empresa, { name: `Peça ${simbologia}`, priceCents: 1990, barcode: codigo }).id);

      const html = renderDocument(empresa, 'PRODUCT_LABEL', id);

      // Antes (ean13Svg): só o EAN-13 virava desenho; os outros saíam "SEM CÓDIGO DE BARRAS".
      expect(html).toContain(`data-simbologia="${simbologia}"`);
      expect(html).toContain('<rect');
      expect(html).not.toContain('SEM CÓDIGO DE BARRAS');
      expect(html).toContain(`<div class="ean">${codigo}</div>`);
    });
  }

  it('código antigo com verificador errado não vira barra, mas o número sai para o caixa digitar', () => {
    const id = String(createProduct(empresa, { name: 'Peça antiga', priceCents: 1990 }).id);
    // O cadastro de hoje recusa; o do sistema antigo gravou.
    getConnection().prepare('UPDATE core_products SET barcode = ? WHERE id = ?').run('7891234567890', id);

    const html = renderDocument(empresa, 'PRODUCT_LABEL', id);

    expect(html).not.toContain('data-simbologia');
    expect(html).toContain('CÓDIGO INVÁLIDO: 7891234567890');
    expect(html).toContain('<div class="ean">7891234567890</div>');
  });
});

// ============================================================================

describe('F-cupom-fiscal-07#danfce — o DANFCE aberto pela rota da nota sai na bobina da impressora', () => {
  let numeroVenda = 0;

  function configurarFiscal(): void {
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
  }

  function venda(id: string, terminalId: string | null): string {
    numeroVenda += 1;
    const db = getConnection();
    const agora = new Date().toISOString();
    db.prepare(
      `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                  price_cents, ncm, cfop, origin, active, created_at, updated_at)
       VALUES (?, ?, ?, 'Camisa Social', 'UN', 1000, 5000, '62052000', '5102', '0', 1, ?, ?)`,
    ).run(`prod-${id}`, empresa, `GS-${numeroVenda}`, agora, agora);
    db.prepare(
      `INSERT INTO core_sales (id, company_id, number, status, subtotal_cents, discount_cents,
                               surcharge_cents, total_cents, origin, idempotency_key, change_cents, created_at, terminal_id)
       VALUES (?, ?, ?, 'completed', 5000, 0, 0, 5000, 'pdv', ?, 0, ?, ?)`,
    ).run(id, empresa, numeroVenda, `k-${id}`, agora, terminalId);
    db.prepare(
      `INSERT INTO core_sale_items (id, sale_id, company_id, product_id, description, quantity,
                                    unit_price_cents, discount_cents, total_cents)
       VALUES (?, ?, ?, ?, 'Camisa Social', 1, 5000, 0, 5000)`,
    ).run(`item-${id}`, id, empresa, `prod-${id}`);
    db.prepare(
      `INSERT INTO core_sale_payments (id, sale_id, company_id, method, amount_cents, status, created_at)
       VALUES (?, ?, ?, 'dinheiro', 5000, 'settled', ?)`,
    ).run(`pay-${id}`, id, empresa, agora);
    return id;
  }

  async function notaAutorizada(saleId: string): Promise<string> {
    const { document } = createNfceForSale({ companyId: empresa, saleId });
    validateDocument({ companyId: empresa, documentId: document.id });
    getConnection().prepare("UPDATE core_fiscal_documents SET xml_signed = '<assinado/>' WHERE id = ?").run(document.id);
    transition({ companyId: empresa, documentId: document.id, to: 'SIGNED' });
    enqueue({ companyId: empresa, documentId: document.id });
    await processNext({ companyId: empresa, adapter: new SefazTestAdapter() });
    const doc = getDocument(empresa, document.id)!;
    expect(doc.status).toBe('AUTHORIZED');
    return doc.id;
  }

  const danfce = (docId: string, query = '') =>
    request(app).get(`/api/v1/core/fiscal/documents/${docId}/danfce${query}`).set(caixa);

  beforeEach(() => {
    numeroVenda = 0;
    configurarFiscal();
  });

  it('com a térmica de 58 mm da operação, o DANFCE sai com a página de 58 mm', async () => {
    const doc = await notaAutorizada(venda('v-58', null));
    upsertPrinter({ companyId: empresa, name: 'Térmica 58', kind: 'cupom', paperWidthMm: 58, isDefault: true });

    const r = await danfce(doc);
    expect(r.status, r.text).toBe(200);
    // Antes: `size: 80mm auto` e corpo de 74 mm, cortado pela bobina de 58.
    expect(r.text).toContain('size: 58mm auto');
    expect(r.text).toContain('width: 48mm');
    expect(r.text).not.toContain('size: 80mm auto');
  });

  it('sem impressora de cupom, continua a página de 80 mm', async () => {
    const doc = await notaAutorizada(venda('v-80', null));
    // Uma impressora de etiqueta não é a do DANFCE.
    upsertPrinter({ companyId: empresa, name: 'Etiquetas', kind: 'etiqueta', paperWidthMm: 40, isDefault: true });

    const r = await danfce(doc);
    expect(r.status, r.text).toBe(200);
    expect(r.text).toContain('size: 80mm auto');
  });

  it('a do caixa: sem caixa informado vale o da venda; com ?terminalId= vale o de quem pede', async () => {
    const cx1 = novoCaixa('cx-d1', 'Caixa 1');
    const cx2 = novoCaixa('cx-d2', 'Caixa 2');
    upsertPrinter({ companyId: empresa, name: 'Térmica 80 da loja', kind: 'cupom', paperWidthMm: 80, isDefault: true });
    upsertPrinter({ companyId: empresa, name: 'Térmica 58 do Caixa 1', kind: 'cupom', paperWidthMm: 58, pdvTerminalId: cx1 });
    const doc = await notaAutorizada(venda('v-cx1', cx1));

    // A venda foi no Caixa 1: a bobina dele.
    const doCaixaDaVenda = await danfce(doc);
    expect(doCaixaDaVenda.status, doCaixaDaVenda.text).toBe(200);
    expect(doCaixaDaVenda.text).toContain('size: 58mm auto');

    // Quem abre no Caixa 2 imprime na impressora que serve ao Caixa 2 (a da loja, 80 mm).
    const doCaixa2 = await danfce(doc, `?terminalId=${cx2}`);
    expect(doCaixa2.status, doCaixa2.text).toBe(200);
    expect(doCaixa2.text).toContain('size: 80mm auto');

    const doCaixa1 = await danfce(doc, `?terminalId=${cx1}`);
    expect(doCaixa1.text).toContain('size: 58mm auto');
  });

  it('caixa que não é da operação é recusado com a frase que manda conferir', async () => {
    const doc = await notaAutorizada(venda('v-x', null));
    const r = await danfce(doc, '?terminalId=caixa-de-outra-loja');
    expect(r.status).toBe(400);
    expect(r.body.error?.code).toBe('CORE_TERMINAL_NOT_REGISTERED');
    expect(r.body.error?.message).toMatch(/Caixas e terminais/);
  });
});
