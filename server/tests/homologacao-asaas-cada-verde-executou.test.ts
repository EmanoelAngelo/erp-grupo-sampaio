/**
 * NA HOMOLOGAÇÃO DO ASAAS, CADA PASSO VERDE É UMA VERIFICAÇÃO EXECUTADA
 * (GAP-PRD-169).
 *
 * ============================================================================
 * O DEFEITO, MEDIDO PELA AUDITORIA
 * ============================================================================
 *
 * - "Conciliação" e "E-commerce bridge" viravam `success` por atribuição, com
 *   frases fixas ("Estrutura de conciliação CP59 disponível", "Bridge
 *   e-commerce CP61 compatível"), sem executar nada;
 * - "Endpoint externo" ficava `success` porque ASAAS_WEBHOOK_PUBLIC_URL tinha
 *   texto — sem nenhuma prova de que o Asaas alcança o servidor;
 * - "Contas a Receber" rodava a fila legada (`asaas_charge_links`), que não é
 *   o caminho do título (`chargeFinanceEntry` → `requestAsaasCharge`);
 * - a tela prometia que a homologação "escreve em Contas a Receber, concilia e
 *   recebe o próprio webhook".
 *
 * E dois defeitos no caminho do resultado: a corrida nova partia dos passos
 * GRAVADOS da anterior (passo verde de ontem num passo que hoje nem rodou), e
 * o serviço não devolvia o `status: 'passed'` que a tela lê.
 *
 * ============================================================================
 * O QUE ESTE ARQUIVO COBRA, contra um Asaas de mentira que registra tudo
 * ============================================================================
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

process.env.DEVORA_API_ENV = 'test';

const { createApp } = await import('../src/app.js');
const { resetDbForTests } = await import('../src/db/database.js');
const { ensureCoreSchema } = await import('../src/db/schema.js');
const { getConnection } = await import('../src/db/sqlite.js');
const { resetEnvCacheForTests } = await import('../src/config/env.js');
const { upsertCompany, upsertUser, linkUserToCompany } = await import('../src/services/auth/IdentityService.js');
const { removeAsaasSecret, upsertAsaasApiKey, upsertAsaasWebhookToken } = await import(
  '../src/services/integrations/AsaasCredentialService.js'
);
const { upsertAsaasIntegrationState } = await import('../src/services/integrations/AsaasIntegrationStateService.js');

const app = createApp();
const SENHA = 'Teste@Homolog169';
const TOKEN = 'token-do-webhook-da-gringa-123';

let gringa: string;
let gerente: { Authorization: string };
let chamadas: { metodo: string; caminho: string; corpo: Record<string, unknown> | null }[];
let statusDaCobranca: string;
let proximo: number;

function fakeAsaas() {
  return vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const alvo = new URL(String(url));
    const caminho = alvo.pathname.replace('/api/v3', '');
    const metodo = init?.method ?? 'GET';
    const corpo = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    chamadas.push({ metodo, caminho, corpo });
    const responder = (dados: unknown) =>
      new Response(JSON.stringify(dados), { status: 200, headers: { 'Content-Type': 'application/json' } });

    if (caminho === '/finance/balance') return responder({ balance: 0 });
    if (caminho === '/customers' && metodo === 'POST') return responder({ id: 'cus_1', ...corpo });
    if (caminho.startsWith('/customers/')) return responder({ id: 'cus_1' });
    if (caminho === '/payments' && metodo === 'POST') {
      proximo += 1;
      return responder({ id: `pay_${proximo}`, status: 'PENDING', ...corpo });
    }
    if (caminho.endsWith('/pixQrCode')) return responder({ encodedImage: 'x', payload: '000201' });
    if (caminho.endsWith('/identificationField')) return responder({ identificationField: '2379...' });
    if (caminho === '/checkouts') return responder({ id: 'chk_1', url: 'https://sandbox.asaas.com/c/1' });
    if (caminho.startsWith('/payments/') && metodo === 'DELETE') return responder({ deleted: true });
    if (caminho.startsWith('/payments/')) return responder({ id: caminho.split('/')[2], status: statusDaCobranca });
    return responder({});
  });
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  process.env.ASAAS_ENABLED = 'true';
  process.env.GRUPO_SAMPAIO_PUBLIC_URL = 'https://erp.exemplo.com.br';
  resetEnvCacheForTests();
  gringa = upsertCompany({ slug: 'gringa', tradeName: 'Gringa', legalName: 'Gringa Ltda' });
  const id = await upsertUser({ login: 'gerente.hom169', displayName: 'Gerente', password: SENHA });
  linkUserToCompany(id, gringa, 'gerente_loja', true);
  const res = await request(app).post('/api/v1/auth/login').send({ login: 'gerente.hom169', password: SENHA });
  gerente = { Authorization: `Bearer ${res.body.accessToken}` };
  upsertAsaasApiKey({ companyId: gringa, environment: 'sandbox', apiKey: '$aact_hmlg_chave_teste_000000000000' });
  upsertAsaasWebhookToken({ companyId: gringa, webhookToken: TOKEN });

  chamadas = [];
  statusDaCobranca = 'PENDING';
  proximo = 0;
  vi.stubGlobal('fetch', fakeAsaas());
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ASAAS_ENABLED;
  delete process.env.GRUPO_SAMPAIO_PUBLIC_URL;
  delete process.env.ASAAS_WEBHOOK_PUBLIC_URL;
  resetEnvCacheForTests();
});

async function homologar() {
  const res = await request(app).post('/api/v1/core/integrations/asaas/homologar').set(gerente).send({});
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as {
    status: string;
    sandboxHomologated: boolean;
    steps: { key: string; status: string; message?: string }[];
  };
}

const passo = (r: { steps: { key: string; status: string; message?: string }[] }, key: string) =>
  r.steps.find((s) => s.key === key)!;

describe('GAP-PRD-169 — nenhum passo verde por atribuição', () => {
  it('as frases decorativas CP59/CP61 somem, e cada passo do ERP tem o que executou', async () => {
    const r = await homologar();
    const tudo = JSON.stringify(r.steps);
    expect(tudo).not.toContain('CP59');
    expect(tudo).not.toContain('CP61');
    expect(passo(r, 'ecommerce_bridge').status).toBe('not_applicable');
    expect(passo(r, 'reconciliation').status).toBe('success');
    expect(passo(r, 'ar_bridge').status).toBe('success');
  });

  it('"Cobrança do título": o corpo do ERP vai ao provedor, a referência volta, e a cobrança é cancelada — nenhum título nasce', async () => {
    const r = await homologar();
    const doTitulo = chamadas.find(
      (c) => c.metodo === 'POST' && c.caminho === '/payments'
        && String(c.corpo?.externalReference ?? '').startsWith('DEVORA_HOMOLOGATION-titulo-'),
    );
    expect(doTitulo?.corpo).toMatchObject({ customer: 'cus_1', billingType: 'PIX', value: 10.5 });
    const cancelou = chamadas.some((c) => c.metodo === 'DELETE' && c.caminho.startsWith('/payments/'));
    expect(cancelou).toBe(true);
    expect(passo(r, 'ar_bridge').message).toContain('Nenhum título foi criado');
    const titulos = getConnection().prepare('SELECT COUNT(*) AS n FROM core_finance_entries').get() as { n: number };
    expect(Number(titulos.n)).toBe(0);
  });

  it('"Consulta da conciliação": pergunta ao provedor pela cobrança, e status desconhecido reprova', async () => {
    const ok = await homologar();
    expect(chamadas.some((c) => c.metodo === 'GET' && /^\/payments\/pay_\d+$/.test(c.caminho))).toBe(true);
    expect(passo(ok, 'reconciliation').message).toContain('PENDING');

    statusDaCobranca = 'STATUS_QUE_NINGUEM_CONHECE';
    const ruim = await homologar();
    expect(passo(ruim, 'reconciliation').status).toBe('error');
    expect(ruim.sandboxHomologated).toBe(false);
  });

  it('"Webhook do ERP": o aviso passa pelo caminho real, com o token da operação — sem token, a homologação diz', async () => {
    const r = await homologar();
    expect(passo(r, 'webhook_local').status).toBe('success');
    const local = getConnection()
      .prepare("SELECT company_id, processed FROM core_payment_webhooks WHERE event_id LIKE 'DEVORA_HOMOLOGATION-local-%'")
      .get() as { company_id: string; processed: number };
    expect(local.company_id).toBe(gringa);
    expect(local.processed).toBe(1);
  });

  it('o aviso local NÃO conta como aviso do Asaas no card do webhook', async () => {
    await homologar();
    const painel = await request(app).get('/api/v1/core/integrations/asaas').set(gerente);
    expect(painel.body.webhook.lastEvent).toBeNull();
    expect(painel.body.webhook.eventsLast30Days).toBe(0);
  });
});

describe('GAP-PRD-169 — o endpoint externo só fica verde quando o Asaas avisa', () => {
  it('URL configurada NÃO é prova: sem aviso, o passo fica aguardando (antes: success)', async () => {
    process.env.ASAAS_WEBHOOK_PUBLIC_URL = 'https://erp.exemplo.com.br';
    resetEnvCacheForTests();
    const r = await homologar();
    expect(passo(r, 'webhook_external').status).toBe('awaiting_external');
    expect(passo(r, 'webhook_external').message).toContain('Aguardando o aviso do Asaas');
    // O selo do sandbox não depende do aviso que está a caminho.
    expect(r.status).toBe('passed');
  });

  it('o Asaas avisa sobre a cobrança de teste pela URL da operação: "conferir" deixa o passo verde', async () => {
    const r = await homologar();
    const pix = passo(r, 'pix_charge').message!.replace('PIX ', '');

    const aviso = await request(app)
      .post(`/api/v1/loja/webhooks/payments/asaas/${gringa}`)
      .set('asaas-access-token', TOKEN)
      .send({ id: 'evt_do_asaas_1', event: 'PAYMENT_CREATED', payment: { id: pix, value: 10.5 } });
    expect(aviso.status, JSON.stringify(aviso.body)).toBe(200);

    const conferido = await request(app)
      .post('/api/v1/core/integrations/asaas/homologar/conferir-aviso')
      .set(gerente)
      .send({});
    expect(conferido.status).toBe(200);
    expect(conferido.body.step.status).toBe('success');
    expect(conferido.body.step.message).toContain('O Asaas alcançou este servidor');
    expect(conferido.body.step.message).toContain(pix);
  });

  it('aviso de OUTRA cobrança não prova nada', async () => {
    await homologar();
    await request(app)
      .post(`/api/v1/loja/webhooks/payments/asaas/${gringa}`)
      .set('asaas-access-token', TOKEN)
      .send({ id: 'evt_outro', event: 'PAYMENT_CREATED', payment: { id: 'pay_de_outra_coisa', value: 1 } });

    const conferido = await request(app)
      .post('/api/v1/core/integrations/asaas/homologar/conferir-aviso')
      .set(gerente)
      .send({});
    expect(conferido.body.step.status).toBe('awaiting_external');
  });

  it('endereço local: o passo diz que o Asaas não alcança, e o que configurar', async () => {
    delete process.env.GRUPO_SAMPAIO_PUBLIC_URL;
    resetEnvCacheForTests();
    const r = await homologar();
    expect(passo(r, 'webhook_external').status).toBe('awaiting_external');
    expect(passo(r, 'webhook_external').message).toContain('não é alcançável de fora');
    // A variável que o servidor LÊ (GAP-PRD-153) — e nunca a aposentada, que não liga nada.
    expect(passo(r, 'webhook_external').message).toContain('GRUPO_SAMPAIO_PUBLIC_URL');
    expect(passo(r, 'webhook_external').message).not.toContain('DEVORA_PUBLIC_BASE_URL');
  });
});

describe('GAP-PRD-169 — o resultado que a tela lê', () => {
  it('homologação que passa devolve status "passed" (a tela procurava e nunca achava)', async () => {
    const r = await homologar();
    expect(r.sandboxHomologated).toBe(true);
    expect(r.status).toBe('passed');
  });

  it('sem token do webhook, não passa — e o motivo é o token', async () => {
    removeAsaasSecret(gringa, 'webhook_token');
    const r = await homologar();
    expect(r.status).toBe('failed');
    expect(passo(r, 'webhook_local').status).toBe('error');
    expect(passo(r, 'webhook_local').message).toContain('token do webhook');
  });

  it('corrida nova não herda verde da anterior: passo que não rodou fica pendente', async () => {
    // A corrida de ontem passou inteira.
    await homologar();
    upsertAsaasIntegrationState({ companyId: gringa }, {});
    // Hoje o provedor derruba o cliente: a sequência para no começo.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { method?: string }) => {
        const caminho = new URL(String(url)).pathname.replace('/api/v3', '');
        if (caminho === '/customers' && (init?.method ?? 'GET') === 'POST') {
          return new Response(JSON.stringify({ errors: [{ description: 'Conta suspensa' }] }), { status: 400 });
        }
        return new Response(JSON.stringify({ balance: 0 }), { status: 200 });
      }),
    );
    const hoje = await homologar();
    expect(passo(hoje, 'customer_create').status).toBe('error');
    expect(passo(hoje, 'pix_charge').status).toBe('pending');
    expect(passo(hoje, 'ar_bridge').status).toBe('pending');
    expect(hoje.status).toBe('failed');
  });
});
