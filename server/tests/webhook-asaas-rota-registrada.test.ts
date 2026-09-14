/**
 * ============================================================================
 * A URL QUE O ASAAS JÁ TEM CADASTRADA PASSA A BAIXAR (GAP-PRD-002)
 * E O TOKEN DO AMBIENTE PARA DE VALER ONDE NÃO DEVE (GAP-PRD-113)
 * ============================================================================
 *
 * O DEFEITO, MEDIDO NO BANCO DA LOJA: o painel do Asaas aponta para
 * `POST /api/v1/webhooks/asaas` — a única URL que o OpenAPI anunciava e a que
 * a prova por túnel exercitou. Essa rota gravava o evento numa coleção legada,
 * devolvia 200 e parava ali: `core_payment_webhooks` tinha ZERO linhas, o
 * título continuava em aberto e o pedido continuava "aguardando pagamento",
 * com o dinheiro já na conta. Como o Asaas recebeu 2xx, não reenvia nunca.
 *
 * A rota que baixava de verdade era outra
 * (`/loja/webhooks/payments/asaas/:companyId`), e nenhuma tela dizia qual era.
 *
 * O que este arquivo cobra:
 *
 *   1. a rota antiga entra no MESMO processamento da nova — a empresa sai do
 *      token, a conferência de tenant é a mesma, a idempotência é a mesma;
 *   2. a tela de Integrações diz a URL desta operação e o último aviso que
 *      chegou por ela;
 *   3. o token do `.env` não vale em produção (pelos dois nomes de produção),
 *      nem fora dela para empresa que já tem o token dela.
 *
 * O provedor é um dublê (`asaasDeTeste`): nada sai deste processo.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { createApp } from '../src/app.js';
import { loginForTest } from './helpers/auth.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import {
  getAsaasCredentialStatus,
  upsertAsaasApiKey,
  upsertAsaasWebhookToken,
} from '../src/services/integrations/AsaasCredentialService.js';
import { createEntry } from '../src/services/core/FinanceService.js';
import { chargeFinanceEntry } from '../src/services/core/FinanceChargeService.js';
import { createPaymentIntent } from '../src/services/core/PaymentService.js';
import { checkout } from '../src/services/core/StorefrontService.js';
import * as envModule from '../src/config/env.js';
import { secretProvider } from '../src/secrets/SecretProvider.js';

const TOKEN_PJ = 'token-webhook-preco-justo';
const TOKEN_GRINGA = 'token-webhook-gringa';

let precoJusto: string;
let gringa: string;
let seq = 0;

function asaasDeTeste() {
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const endereco = String(url);
    const metodo = init?.method ?? 'GET';
    const responder = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    if (endereco.endsWith('/customers') && metodo === 'POST') {
      seq += 1;
      return responder({ id: `cus_TEST_${seq}` });
    }
    if (endereco.endsWith('/payments') && metodo === 'POST') {
      seq += 1;
      return responder({ id: `pay_TEST_${seq}`, invoiceUrl: `https://sandbox.asaas.com/i/${seq}` });
    }
    if (endereco.includes('/pixQrCode')) return responder({ payload: '000201-TESTE' });
    return responder({});
  }) as unknown as typeof fetch;
  return { fetchImpl };
}

function cliente(companyId: string): string {
  seq += 1;
  const id = `cli-${companyId.slice(0, 4)}-${seq}`;
  const agora = new Date().toISOString();
  getConnection()
    .prepare(
      `INSERT INTO core_customers (id, company_id, name, document, email, active, created_at, updated_at)
       VALUES (?, ?, 'Dona Marlene', ?, 'marlene@exemplo.com.br', 1, ?, ?)`,
    )
    .run(id, companyId, String(52998224725 + seq), agora, agora);
  return id;
}

async function tituloCobrado(companyId: string, amountCents = 30000) {
  const titulo = createEntry({
    companyId,
    direction: 'in',
    description: 'Aluguel da sala 2',
    amountCents,
    dueDate: '2026-09-10',
    customerId: cliente(companyId),
  });
  const cobranca = await chargeFinanceEntry({
    companyId,
    entryId: titulo.id,
    method: 'pix',
    fetchImpl: asaasDeTeste().fetchImpl,
  });
  return { entryId: titulo.id, providerRef: String(cobranca.intent.provider_ref), intentId: cobranca.intent.id };
}

/** Pedido online com cobrança — `provider_ref` gravado à mão, como no teste do webhook. */
async function pedidoCobrado(companyId: string, sufixo: string) {
  const agora = new Date().toISOString();
  const produto = `prod-${sufixo}`;
  getConnection()
    .prepare(
      `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                  price_cents, active, publish_online, created_at, updated_at)
       VALUES (?, ?, ?, 'Produto online', 'UN', 5000, 10000, 1, 1, ?, ?)`,
    )
    .run(produto, companyId, `ON-${sufixo}`, agora, agora);
  getConnection()
    .prepare(
      'INSERT INTO core_stock (company_id, product_id, quantity, reserved, updated_at) VALUES (?, ?, 50, 0, ?)',
    )
    .run(companyId, produto, agora);
  const [pedido] = checkout({
    idempotencyKey: `ck-${sufixo}`,
    customerName: 'Cliente de teste',
    paymentMethod: 'pix',
    items: [{ productId: produto, quantity: 1 }],
  });
  const intent = await createPaymentIntent({
    companyId,
    originType: 'ecommerce_order',
    originId: pedido.id,
    method: 'pix',
    amountCents: 10000,
    idempotencyKey: `pay-${sufixo}`,
    fetchImpl: asaasDeTeste().fetchImpl,
  });
  getConnection()
    .prepare('UPDATE core_payment_intents SET provider_ref = ? WHERE id = ?')
    .run(`pay_${sufixo}`, intent.id);
  return { orderId: pedido.id, providerRef: `pay_${sufixo}` };
}

function statusDoTitulo(id: string): { status: string; settled: number } {
  const r = getConnection()
    .prepare('SELECT status, settled_cents FROM core_finance_entries WHERE id = ?')
    .get(id) as { status: string; settled_cents: number };
  return { status: r.status, settled: Number(r.settled_cents) };
}

function statusDoPedido(id: string): string {
  return (
    getConnection().prepare('SELECT status FROM core_orders WHERE id = ?').get(id) as { status: string }
  ).status;
}

function baixas(entryId: string): number {
  return (
    getConnection()
      .prepare('SELECT COUNT(*) AS n FROM core_finance_settlements WHERE entry_id = ?')
      .get(entryId) as { n: number }
  ).n;
}

/** Simula o processo em produção pelo `DEVORA_API_ENV` (o `loadEnv` guarda cache). */
function emProducao() {
  const cfg = envModule.loadEnv();
  return vi.spyOn(envModule, 'loadEnv').mockReturnValue({
    ...cfg,
    DEVORA_API_ENV: 'production',
  } as ReturnType<typeof envModule.loadEnv>);
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  seq = 0;
  precoJusto = await upsertCompany({
    slug: 'preco-justo',
    tradeName: 'Preço Justo',
    legalName: 'Preço Justo Ltda',
  });
  gringa = await upsertCompany({ slug: 'gringa', tradeName: 'Gringa', legalName: 'Gringa Ltda' });
  upsertAsaasApiKey({ companyId: precoJusto, environment: 'sandbox', apiKey: '$aact_sandbox_pj_000000000000' });
  upsertAsaasApiKey({ companyId: gringa, environment: 'sandbox', apiKey: '$aact_sandbox_gr_111111111111' });
  upsertAsaasWebhookToken({ companyId: precoJusto, webhookToken: TOKEN_PJ });
  upsertAsaasWebhookToken({ companyId: gringa, webhookToken: TOKEN_GRINGA });
  // Nenhuma chamada sai deste processo: o que não passar pelo dublê explícito
  // cai aqui e falha como rede ausente, em vez de alcançar o sandbox real.
  vi.stubGlobal('fetch', async () => {
    throw new TypeError('rede bloqueada neste teste');
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// ============================================================================
describe('GAP-PRD-002 — a rota que o Asaas tem cadastrada baixa de verdade', () => {
  it('PAYMENT_RECEIVED na rota antiga BAIXA o título da empresa dona do token', async () => {
    const app = createApp();
    const { entryId, providerRef } = await tituloCobrado(gringa);

    const res = await request(app)
      .post('/api/v1/webhooks/asaas')
      .set('asaas-access-token', TOKEN_GRINGA)
      .send({ id: 'evt_legado_1', event: 'PAYMENT_RECEIVED', payment: { id: providerRef, value: 300 } });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.accepted).toBe(true);
    // Antes: 200 ok:true e NADA baixado — o evento morria numa coleção legada.
    expect(statusDoTitulo(entryId)).toEqual({ status: 'settled', settled: 30000 });
    expect(baixas(entryId)).toBe(1);

    // O evento está no livro do núcleo, com a empresa que o token provou.
    const linha = getConnection()
      .prepare('SELECT processed, company_id FROM core_payment_webhooks WHERE event_id = ?')
      .get('evt_legado_1') as { processed: number; company_id: string | null };
    expect(linha.processed).toBe(1);
    expect(linha.company_id).toBe(gringa);
  });

  it('e marca PAGO o pedido online', async () => {
    const app = createApp();
    const { orderId, providerRef } = await pedidoCobrado(precoJusto, 'legado-pedido');

    const res = await request(app)
      .post('/api/v1/webhooks/asaas')
      .set('asaas-access-token', TOKEN_PJ)
      .send({ id: 'evt_legado_2', event: 'PAYMENT_CONFIRMED', payment: { id: providerRef, value: 100 } });

    expect(res.status).toBe(200);
    expect(statusDoPedido(orderId)).toBe('pago');
  });

  it('o token da Gringa não baixa título do Preço Justo pela rota antiga', async () => {
    const app = createApp();
    const { entryId, providerRef } = await tituloCobrado(precoJusto);

    const res = await request(app)
      .post('/api/v1/webhooks/asaas')
      .set('asaas-access-token', TOKEN_GRINGA)
      .send({ id: 'evt_legado_3', event: 'PAYMENT_RECEIVED', payment: { id: providerRef, value: 300 } });

    expect(res.status).toBe(403);
    expect(statusDoTitulo(entryId).settled).toBe(0);
  });

  it('o mesmo evento duas vezes pela rota antiga: uma baixa, e o segundo diz duplicado', async () => {
    const app = createApp();
    const { entryId, providerRef } = await tituloCobrado(gringa);
    const evento = { id: 'evt_legado_4', event: 'PAYMENT_RECEIVED', payment: { id: providerRef, value: 300 } };

    const primeira = await request(app).post('/api/v1/webhooks/asaas').set('asaas-access-token', TOKEN_GRINGA).send(evento);
    const segunda = await request(app).post('/api/v1/webhooks/asaas').set('asaas-access-token', TOKEN_GRINGA).send(evento);

    expect(primeira.status).toBe(200);
    expect(segunda.status).toBe(200);
    expect(segunda.body.duplicate).toBe(true);
    expect(segunda.body.duplicated).toBe(true);
    expect(baixas(entryId)).toBe(1);
  });

  it('token errado continua 401; nenhum token cadastrado continua 503', async () => {
    const app = createApp();
    const errado = await request(app)
      .post('/api/v1/webhooks/asaas')
      .set('asaas-access-token', 'token-de-ninguem')
      .send({ id: 'evt_legado_5', event: 'PAYMENT_RECEIVED', payment: { id: 'pay_x' } });
    expect(errado.status).toBe(401);

    // Sem token em lugar nenhum: "nada a conferir", e o gestor sabe que é salvar.
    resetDbForTests();
    ensureCoreSchema();
    const vazio = await request(createApp())
      .post('/api/v1/webhooks/asaas')
      .set('asaas-access-token', 'token-de-ninguem')
      .send({ id: 'evt_legado_6', event: 'PAYMENT_RECEIVED', payment: { id: 'pay_x' } });
    expect(vazio.status).toBe(503);
  });
});

// ============================================================================
describe('GAP-PRD-002 — a tela diz qual URL cadastrar e se o aviso está chegando', () => {
  it('GET /core/integrations/asaas traz a URL da operação, a antiga e o último aviso', async () => {
    const app = createApp();
    const gerente = await loginForTest(app, {
      userId: 'gerente',
      companyId: 'company-1',
      profileCodes: ['gerente_loja'],
    });
    const auth = { Authorization: `Bearer ${gerente.body.accessToken as string}` };

    const antes = await request(app).get('/api/v1/core/integrations/asaas').set(auth);
    expect(antes.status).toBe(200);
    const webhook = antes.body.webhook;
    expect(webhook.url).toMatch(/\/api\/v1\/loja\/webhooks\/payments\/asaas\/company-1$/);
    expect(webhook.legacyUrl).toMatch(/\/api\/v1\/webhooks\/asaas$/);
    expect(webhook.lastEvent).toBeNull();
    // A origem padrão é local: o Asaas não alcança, e a tela precisa dizer isso.
    expect(webhook.publiclyReachable).toBe(false);
    expect(String(webhook.warning)).toMatch(/GRUPO_SAMPAIO_PUBLIC_URL/);

    upsertAsaasWebhookToken({ companyId: 'company-1', webhookToken: 'token-da-company-1' });
    const aviso = await request(app)
      .post('/api/v1/loja/webhooks/payments/asaas/company-1')
      .set('asaas-access-token', 'token-da-company-1')
      .send({ id: 'evt_tela_1', event: 'PAYMENT_CREATED', payment: { id: 'pay_qualquer' } });
    expect(aviso.status).toBe(200);

    const depois = await request(app).get('/api/v1/core/integrations/asaas').set(auth);
    expect(depois.body.webhook.lastEvent).toMatchObject({
      eventType: 'PAYMENT_CREATED',
      processed: true,
      error: null,
    });
    expect(depois.body.webhook.lastEvent.receivedAt).toBeTruthy();
    // O aviso de OUTRA empresa não aparece no painel desta.
    expect(depois.body.webhook.eventsLast30Days).toBe(1);
  });

  it('com a origem pública configurada, a URL é a HTTPS dela', async () => {
    const cfg = envModule.loadEnv();
    vi.spyOn(envModule, 'loadEnv').mockReturnValue({
      ...cfg,
      ASAAS_WEBHOOK_PUBLIC_URL: 'https://erp.exemplo.com.br/qualquer/caminho',
    } as ReturnType<typeof envModule.loadEnv>);
    const { describeAsaasWebhook } = await import('../src/services/core/AsaasWebhookInfo.js');

    const info = describeAsaasWebhook(gringa);
    expect(info.url).toBe(`https://erp.exemplo.com.br/api/v1/loja/webhooks/payments/asaas/${gringa}`);
    expect(info.publiclyReachable).toBe(true);
    expect(info.warning).toBeNull();
  });

  it('o contrato público anuncia a rota por operação e diz o que a antiga faz', async () => {
    const res = await request(createApp()).get('/api/v1/openapi.json');
    const caminhos = res.body.paths as Record<string, { post?: { summary?: string; description?: string } }>;
    expect(caminhos['/loja/webhooks/payments/{provider}/{companyId}']?.post).toBeTruthy();
    expect(String(caminhos['/webhooks/asaas']?.post?.description ?? '')).toMatch(/mesmo processamento/i);
  });
});

// ============================================================================
describe('GAP-PRD-113 — o token do ambiente não vale onde não deve', () => {
  it('em produção, a rota sem empresa recusa o token do .env (401 com cofre, 503 sem)', async () => {
    const app = createApp();
    vi.spyOn(secretProvider, 'getAsaasWebhookToken').mockReturnValue('token-do-env');
    const { orderId, providerRef } = await pedidoCobrado(gringa, 'prod-1');
    emProducao();

    const res = await request(app)
      .post('/api/v1/loja/webhooks/payments/asaas')
      .set('asaas-access-token', 'token-do-env')
      .send({ id: 'evt_prod_1', event: 'PAYMENT_CONFIRMED', payment: { id: providerRef } });

    expect(res.status).toBe(401);
    expect(statusDoPedido(orderId)).toBe('aguardando_pagamento');
  });

  it('em produção, a rota POR EMPRESA também recusa o .env quando a empresa não tem o token dela', async () => {
    const app = createApp();
    const semToken = await upsertCompany({ slug: 'sem-token', tradeName: 'Sem Token', legalName: 'Sem Token Ltda' });
    vi.spyOn(secretProvider, 'getAsaasWebhookToken').mockReturnValue('token-do-env');
    const { orderId, providerRef } = await pedidoCobrado(semToken, 'prod-2');
    emProducao();

    const res = await request(app)
      .post(`/api/v1/loja/webhooks/payments/asaas/${semToken}`)
      .set('asaas-access-token', 'token-do-env')
      .send({ id: 'evt_prod_2', event: 'PAYMENT_CONFIRMED', payment: { id: providerRef } });

    // Antes: 200 "Pedido confirmado." — o fallback do .env não tinha guarda.
    expect(res.status).toBe(503);
    expect(statusDoPedido(orderId)).toBe('aguardando_pagamento');
  });

  it('NODE_ENV=production também é produção', async () => {
    const app = createApp();
    const semToken = await upsertCompany({ slug: 'sem-token-3', tradeName: 'Sem Token 3', legalName: 'Sem Token 3 Ltda' });
    vi.spyOn(secretProvider, 'getAsaasWebhookToken').mockReturnValue('token-do-env');
    const { orderId, providerRef } = await pedidoCobrado(semToken, 'prod-3');
    vi.stubEnv('NODE_ENV', 'production');

    const res = await request(app)
      .post(`/api/v1/loja/webhooks/payments/asaas/${semToken}`)
      .set('asaas-access-token', 'token-do-env')
      .send({ id: 'evt_prod_3', event: 'PAYMENT_CONFIRMED', payment: { id: providerRef } });

    expect(res.status).toBe(503);
    expect(statusDoPedido(orderId)).toBe('aguardando_pagamento');
  });

  it('fora de produção, o .env NÃO atravessa para empresa que já tem o token dela', async () => {
    const app = createApp();
    vi.spyOn(secretProvider, 'getAsaasWebhookToken').mockReturnValue('token-do-env');
    const { orderId, providerRef } = await pedidoCobrado(gringa, 'dev-1');

    const res = await request(app)
      .post('/api/v1/loja/webhooks/payments/asaas')
      .set('asaas-access-token', 'token-do-env')
      .send({ id: 'evt_dev_1', event: 'PAYMENT_CONFIRMED', payment: { id: providerRef } });

    // Antes: 200 "Pedido confirmado." para a Gringa com o token de ninguém.
    expect(res.status).toBe(403);
    expect(statusDoPedido(orderId)).toBe('aguardando_pagamento');
  });

  it('fora de produção, o atalho do .env ainda serve a empresa sem token próprio', async () => {
    const app = createApp();
    const semToken = await upsertCompany({ slug: 'sem-token-4', tradeName: 'Sem Token 4', legalName: 'Sem Token 4 Ltda' });
    vi.spyOn(secretProvider, 'getAsaasWebhookToken').mockReturnValue('token-do-env');
    const { orderId, providerRef } = await pedidoCobrado(semToken, 'dev-2');

    const res = await request(app)
      .post('/api/v1/loja/webhooks/payments/asaas')
      .set('asaas-access-token', 'token-do-env')
      .send({ id: 'evt_dev_2', event: 'PAYMENT_CONFIRMED', payment: { id: providerRef } });

    expect(res.status).toBe(200);
    expect(statusDoPedido(orderId)).toBe('pago');
  });

  it('a tela não diz "configurado" para um token de ambiente que o servidor recusa', async () => {
    const semToken = await upsertCompany({ slug: 'sem-token-5', tradeName: 'Sem Token 5', legalName: 'Sem Token 5 Ltda' });
    vi.spyOn(secretProvider, 'getAsaasWebhookToken').mockReturnValue('token-do-env');

    expect(getAsaasCredentialStatus(semToken).webhook).toMatchObject({ configured: true, source: 'env' });
    emProducao();
    expect(getAsaasCredentialStatus(semToken).webhook).toMatchObject({ configured: false, source: 'none' });
  });
});
