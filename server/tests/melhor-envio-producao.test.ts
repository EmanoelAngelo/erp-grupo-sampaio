/**
 * ============================================================================
 * O TOKEN DE PRODUÇÃO DO MELHOR ENVIO BASTA — sem variável de teste no meio
 * ============================================================================
 *
 * GAP-PRD-030 · GAP-PRD-126 · GAP-PRD-117 (lado do servidor)
 *
 * O que a auditoria mediu, com `fetch` interceptado:
 *
 *   - token do Melhor Envio gravado + LOGISTICS_PRODUCTION_ENABLED=true → o
 *     checkout fazia ZERO chamadas. `canRunRealCalls` devolvia false justamente
 *     quando a produção estava ligada, e o adapter só conhecia a URL de sandbox;
 *   - sem LOGISTICS_HOMOLOGATION_TESTS (o padrão de qualquer instalação) → zero
 *     chamadas também. Uma variável de TESTE decidia se a loja cotava frete, e a
 *     tela dizia "Conexão: Real" para a mesma credencial.
 *
 * A regra que este arquivo tranca:
 *
 *   - quem decide para onde a cotação vai é o AMBIENTE DA CREDENCIAL guardada
 *     pela tela: sandbox vai para o sandbox, produção vai para a produção;
 *   - só a cotação de PRODUÇÃO vira preço cobrado no checkout. A de sandbox é
 *     real, mas de um ambiente de teste — serve para conferir, não para cobrar;
 *   - a produção depende da trava de processo `LOGISTICS_PRODUCTION_ENABLED`
 *     (a mesma régua do Asaas), e a trava aparece na prontidão pelo nome;
 *   - serviço que o Melhor Envio devolve com `error` (trecho não atendido) não
 *     vira frete R$ 0,00.
 *
 * Nenhuma chamada sai para a rede: o `fetch` é dublado em todos os casos.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetEnvCacheForTests } from '../src/config/env.js';
import { resetDbForTests, findRows } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { getConnection } from '../src/db/sqlite.js';
import {
  linkUserToCompany,
  upsertCompany,
  upsertUser,
} from '../src/services/auth/IdentityService.js';
import { updateFiscalConfig } from '../src/services/core/FiscalConfigService.js';
import {
  listCheckoutShipping,
  saveShippingSettings,
} from '../src/services/core/CheckoutShippingService.js';
import {
  getLogisticsCredentials,
  upsertLogisticsCredentials,
} from '../src/services/logistics/LogisticsCredentialService.js';
import { backendLogisticsQuote } from '../src/services/logistics/LogisticsService.js';

process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-key';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-32-chars!!';

const app = createApp();
const SENHA = 'Teste@MelhorEnvio2026';
const PRODUCAO = 'https://melhorenvio.com.br';
const SANDBOX = 'https://sandbox.melhorenvio.com.br';
const TOKEN_PRODUCAO = 'me-prod-token-de-teste-0001';
const TOKEN_SANDBOX = 'me-sandbox-token-de-teste-0002';

let companyId: string;
let gerente: { Authorization: string };
let n = 0;

interface Chamada {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

let chamadas: Chamada[] = [];

/** A resposta de cotação do Melhor Envio, no formato que a API devolve. */
const COTACAO_ME = [
  {
    id: 1,
    name: 'PAC',
    price: '21.50',
    custom_price: '23.90',
    delivery_time: 7,
    custom_delivery_time: 8,
    company: { id: 1, name: 'Correios' },
  },
  {
    id: 2,
    name: 'SEDEX',
    price: '38.10',
    custom_price: '38.10',
    delivery_time: 3,
    custom_delivery_time: 3,
    company: { id: 1, name: 'Correios' },
  },
  // Trecho não atendido: o Melhor Envio manda o serviço SEM preço e com
  // `error`. Mapear isso para R$ 0,00 era oferecer frete grátis que ninguém
  // prometeu.
  { id: 3, name: '.Package', error: 'Transportadora não atende este trecho.', company: { id: 2, name: 'Jadlog' } },
];

function responder(corpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function dublarMelhorEnvio(opts: { status?: number; me?: unknown } = {}) {
  const fn = vi.fn(async (entrada: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof entrada === 'string' ? entrada : entrada instanceof URL ? entrada.href : entrada.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    chamadas.push({
      url,
      method: String(init?.method ?? 'GET'),
      headers,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (opts.status && opts.status !== 200) return responder({ message: 'Unauthenticated.' }, opts.status);
    if (url.endsWith('/api/v2/me')) return responder(opts.me ?? { id: 'u1', firstname: 'Loja', lastname: 'Gringa' });
    if (url.endsWith('/api/v2/me/shipment/calculate')) return responder(COTACAO_ME);
    return responder({ message: 'rota não dublada' }, 404);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

async function sessao(login: string, perfil: string) {
  const userId = await upsertUser({ login, displayName: login, password: SENHA });
  linkUserToCompany(userId, companyId, perfil, true);
  const res = await request(app).post('/api/v1/auth/login').send({ login, password: SENHA });
  return { Authorization: `Bearer ${res.body.accessToken}` };
}

function produtoComMedidas(empresa = companyId): string {
  n += 1;
  const id = `me-prod-${n}`;
  const agora = new Date().toISOString();
  const db = getConnection();
  db.prepare(
    `INSERT INTO core_products
       (id, company_id, internal_code, name, unit, cost_cents, price_cents,
        weight_grams, height_cm, width_cm, length_cm,
        active, publish_online, created_at, updated_at)
     VALUES (?, ?, ?, 'Jaqueta', 'UN', 4000, 20000, 800, 10, 30, 40, 1, 1, ?, ?)`,
  ).run(id, empresa, `ME-${n}`, agora, agora);
  db.prepare(
    'INSERT INTO core_stock (company_id, product_id, quantity, reserved, updated_at) VALUES (?, ?, 50, 0, ?)',
  ).run(empresa, id, agora);
  return id;
}

function lojaQueEntrega(empresa = companyId) {
  updateFiscalConfig({ companyId: empresa, patch: { zip: '68900-000' } });
  saveShippingSettings({
    companyId: empresa,
    pickupEnabled: true,
    deliveryEnabled: true,
    flatRateCents: 2_500,
    estimatedDays: 4,
  });
}

async function freteDoCarrinho(empresa = companyId) {
  const p = produtoComMedidas(empresa);
  return listCheckoutShipping({
    companyId: empresa,
    items: [{ productId: p, quantity: 1 }],
    destinationZip: '01310-100',
    itemsCents: 20_000,
  });
}

function guardar(environment: 'homologation' | 'production', token: string, empresa = companyId) {
  return upsertLogisticsCredentials({
    companyId: empresa,
    carrier: 'melhor_envio',
    environment,
    credentials: { token },
  });
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  chamadas = [];
  n = 0;
  delete process.env.LOGISTICS_HOMOLOGATION_TESTS;
  process.env.LOGISTICS_PRODUCTION_ENABLED = 'true';
  resetEnvCacheForTests();
  companyId = upsertCompany({ slug: 'gringa', legalName: 'Gringa Comércio Ltda', tradeName: 'Gringa' });
  gerente = await sessao('GERENTE_ME', 'gerente_loja');
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.LOGISTICS_PRODUCTION_ENABLED;
  delete process.env.LOGISTICS_HOMOLOGATION_TESTS;
  resetEnvCacheForTests();
});

// ============================================================================

describe('GAP-PRD-030 — com token de PRODUÇÃO, o checkout cota a API de produção', () => {
  it('chama melhorenvio.com.br (não o sandbox) e oferece a opção real ao cliente', async () => {
    dublarMelhorEnvio();
    lojaQueEntrega();
    guardar('production', TOKEN_PRODUCAO);

    const r = await freteDoCarrinho();

    const cotacoes = chamadas.filter((c) => c.url.endsWith('/api/v2/me/shipment/calculate'));
    expect(cotacoes.length, 'o checkout precisa chamar a transportadora').toBe(1);
    expect(cotacoes[0].url).toBe(`${PRODUCAO}/api/v2/me/shipment/calculate`);
    expect(cotacoes[0].method).toBe('POST');
    expect(cotacoes[0].headers.authorization).toBe(`Bearer ${TOKEN_PRODUCAO}`);
    // O Melhor Envio pede que a aplicação se identifique no User-Agent.
    expect(cotacoes[0].headers['user-agent']).toMatch(/DEVORA/);

    const transportadora = r.options.filter((o) => o.source === 'transportadora');
    expect(transportadora.map((o) => o.method)).toEqual([
      'transportadora:melhor_envio:1',
      'transportadora:melhor_envio:2',
    ]);
    // O preço personalizado da conta (custom_price) é o que a loja configurou
    // para cobrar; o prazo personalizado idem.
    expect(transportadora[0]).toMatchObject({ priceCents: 2_390, estimatedDays: 8, label: 'Correios PAC' });
    // Com transportadora real, a tabela da loja sai — como já era no sandbox.
    expect(r.options.some((o) => o.source === 'tabela_da_loja')).toBe(false);
    expect(r.deliveryUnavailable).toBeNull();
  });

  it('variável de URL em branco (como no .env.production.example) cai no endereço público', async () => {
    process.env.LOGISTICS_MELHOR_ENVIO_PRODUCTION_URL = '';
    process.env.LOGISTICS_MELHOR_ENVIO_SANDBOX_URL = '  ';
    resetEnvCacheForTests();
    try {
      dublarMelhorEnvio();
      guardar('production', TOKEN_PRODUCAO);
      const teste = await request(app)
        .post('/api/v1/logistics/carriers/melhor_envio/test-connection')
        .set(gerente)
        .send({});
      expect(teste.body.ok).toBe(true);
      expect(chamadas[0].url).toBe(`${PRODUCAO}/api/v2/me`);
    } finally {
      delete process.env.LOGISTICS_MELHOR_ENVIO_PRODUCTION_URL;
      delete process.env.LOGISTICS_MELHOR_ENVIO_SANDBOX_URL;
    }
  });

  it('serviço devolvido com `error` não vira frete de R$ 0,00', async () => {
    dublarMelhorEnvio();
    lojaQueEntrega();
    guardar('production', TOKEN_PRODUCAO);

    const r = await freteDoCarrinho();

    expect(r.options.some((o) => o.method === 'transportadora:melhor_envio:3')).toBe(false);
    expect(r.options.every((o) => o.source === 'retirada' || o.priceCents > 0)).toBe(true);
  });

  it('a cotação de conferência vem marcada como real e de produção', async () => {
    dublarMelhorEnvio();
    guardar('production', TOKEN_PRODUCAO);

    const q = await backendLogisticsQuote(companyId, {
      originZipCode: '68900000',
      destinationZipCode: '01310100',
      weightGrams: 800,
      heightCm: 10,
      widthCm: 30,
      lengthCm: 40,
      declaredValueInCents: 20_000,
    });

    expect(q.real).toBe(true);
    expect(q.simulated).toBe(false);
    expect(q.options.every((o) => o.environment === 'production' && o.simulated === false)).toBe(true);
    // Corpo no formato do Melhor Envio: peso em kg, seguro em reais.
    const corpo = chamadas[0].body as { products: { weight: number; insurance_value: number }[] };
    expect(corpo.products[0].weight).toBe(0.8);
    expect(corpo.products[0].insurance_value).toBe(200);
  });

  it('token de SANDBOX cota o sandbox — e o checkout NÃO cobra por esse preço', async () => {
    dublarMelhorEnvio();
    lojaQueEntrega();
    guardar('homologation', TOKEN_SANDBOX);

    const r = await freteDoCarrinho();

    const cotacoes = chamadas.filter((c) => c.url.endsWith('/shipment/calculate'));
    expect(cotacoes.length).toBe(1);
    expect(cotacoes[0].url).toBe(`${SANDBOX}/api/v2/me/shipment/calculate`);
    // Preço de ambiente de teste não é preço de contrato: a loja cai na tabela.
    expect(r.options.some((o) => o.source === 'transportadora')).toBe(false);
    expect(r.options.find((o) => o.source === 'tabela_da_loja')?.priceCents).toBe(2_500);
  });

  it('produção desligada no processo: nenhuma chamada, e a trava tem nome', async () => {
    process.env.LOGISTICS_PRODUCTION_ENABLED = 'false';
    resetEnvCacheForTests();
    dublarMelhorEnvio();
    lojaQueEntrega();
    guardar('production', TOKEN_PRODUCAO);

    const r = await freteDoCarrinho();
    expect(chamadas.length).toBe(0);
    expect(r.options.some((o) => o.source === 'transportadora')).toBe(false);

    const pr = await request(app).get('/api/v1/core/logistics/readiness').set(gerente);
    const me = pr.body.providers.find((p: { carrier: string }) => p.carrier === 'melhor_envio');
    expect(me.access.locks).toContain('PRODUCAO_DESABILITADA_NO_PROCESSO');
    const ambiente = me.items.find((i: { key: string }) => i.key === 'ambiente');
    expect(ambiente.status).toBe('blocked');
    expect(ambiente.message).toMatch(/LOGISTICS_PRODUCTION_ENABLED/);
    expect(pr.body.checkoutCarrier.active).toBe(false);
  });

  it('token recusado (401): o checkout segue na tabela e a prontidão diz por quê', async () => {
    dublarMelhorEnvio({ status: 401 });
    lojaQueEntrega();
    guardar('production', TOKEN_PRODUCAO);

    const r = await freteDoCarrinho();
    expect(r.options.find((o) => o.source === 'tabela_da_loja')?.priceCents).toBe(2_500);

    const pr = await request(app).get('/api/v1/core/logistics/readiness').set(gerente);
    const me = pr.body.providers.find((p: { carrier: string }) => p.carrier === 'melhor_envio');
    const cotacao = me.items.find((i: { key: string }) => i.key === 'cotacao');
    expect(cotacao.status).toBe('pending');
    expect(cotacao.message).toMatch(/recusou o token/);
  });
});

// ============================================================================

describe('GAP-PRD-126 — variável de teste não decide o checkout', () => {
  it('sem LOGISTICS_HOMOLOGATION_TESTS (o padrão), o checkout chama a transportadora', async () => {
    expect(process.env.LOGISTICS_HOMOLOGATION_TESTS).toBeUndefined();
    dublarMelhorEnvio();
    lojaQueEntrega();
    guardar('production', TOKEN_PRODUCAO);

    const r = await freteDoCarrinho();
    expect(chamadas.length).toBeGreaterThan(0);
    expect(r.options.some((o) => o.source === 'transportadora')).toBe(true);
  });

  it('LOGISTICS_HOMOLOGATION_TESTS=true não muda nada — nem liga sandbox no checkout', async () => {
    process.env.LOGISTICS_HOMOLOGATION_TESTS = 'true';
    resetEnvCacheForTests();
    dublarMelhorEnvio();
    lojaQueEntrega();
    guardar('homologation', TOKEN_SANDBOX);

    const r = await freteDoCarrinho();
    expect(r.options.some((o) => o.source === 'transportadora')).toBe(false);
  });

  it('abrir a tela NÃO chama o provedor: a coluna Conexão vem do último teste guardado', async () => {
    dublarMelhorEnvio();
    guardar('production', TOKEN_PRODUCAO);

    const lista = await request(app).get('/api/v1/core/logistics/carriers').set(gerente);
    expect(lista.status).toBe(200);
    expect(chamadas.length).toBe(0);
    const me = lista.body.items.find((i: { carrier: string }) => i.carrier === 'melhor_envio');
    expect(me.connection.tested).toBe(false);
    expect(me.environment).toBe('production');
    expect(me.access.mode).toBe('production');
    expect(me.access.chargeable).toBe(true);

    // Depois do teste pedido pelo gestor, a coluna reflete o resultado.
    const teste = await request(app)
      .post('/api/v1/logistics/carriers/melhor_envio/test-connection')
      .set(gerente)
      .send({});
    expect(teste.status).toBe(200);
    expect(teste.body.ok).toBe(true);
    expect(teste.body.environment).toBe('production');
    expect(chamadas.map((c) => c.url)).toEqual([`${PRODUCAO}/api/v2/me`]);

    const depois = await request(app).get('/api/v1/core/logistics/carriers').set(gerente);
    const me2 = depois.body.items.find((i: { carrier: string }) => i.carrier === 'melhor_envio');
    expect(me2.connection).toMatchObject({ tested: true, ok: true, real: true });
  });

  it('a prontidão diz, pelo contrato, se o checkout está cobrando transportadora', async () => {
    dublarMelhorEnvio();
    const antes = await request(app).get('/api/v1/core/logistics/readiness').set(gerente);
    expect(antes.body.checkoutCarrier.active).toBe(false);
    expect(antes.body.productionBlocked).toBe(true);

    guardar('production', TOKEN_PRODUCAO);
    const depois = await request(app).get('/api/v1/core/logistics/readiness').set(gerente);
    expect(depois.body.checkoutCarrier).toMatchObject({ active: true, carriers: ['melhor_envio'] });
    expect(depois.body.productionBlocked).toBe(false);
    expect(depois.body.readyForProduction).toBe(true);
  });
});

// ============================================================================

describe('GAP-PRD-117 — a credencial entra pela tela (rotas que a tela usa)', () => {
  it('guarda token de produção mesmo com a trava de processo desligada, e diz o que falta', async () => {
    process.env.LOGISTICS_PRODUCTION_ENABLED = 'false';
    resetEnvCacheForTests();

    const res = await request(app)
      .post('/api/v1/logistics/carriers/credentials')
      .set(gerente)
      .set('Idempotency-Key', 'me-cred-prod-1')
      .send({ carrier: 'melhor_envio', environment: 'production', token: TOKEN_PRODUCAO });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.environment).toBe('production');
    expect(res.body.maskedHint).toBe('••••0001');
    expect(JSON.stringify(res.body)).not.toContain(TOKEN_PRODUCAO);
    expect(res.body.access.locks).toEqual(['PRODUCAO_DESABILITADA_NO_PROCESSO']);
  });

  it('trocar o token substitui o anterior — a cotação usa o NOVO', async () => {
    dublarMelhorEnvio();
    for (const [chave, env, token] of [
      ['me-cred-a', 'homologation', TOKEN_SANDBOX],
      ['me-cred-b', 'production', TOKEN_PRODUCAO],
    ] as const) {
      const res = await request(app)
        .post('/api/v1/logistics/carriers/credentials')
        .set(gerente)
        .set('Idempotency-Key', chave)
        .send({ carrier: 'melhor_envio', environment: env, token });
      expect(res.status).toBe(201);
    }

    const linhas = findRows('logistics_carrier_credentials', (r) => r.companyId === companyId);
    expect(linhas.length, 'uma linha por transportadora, não uma por gravação').toBe(1);
    expect(getLogisticsCredentials(companyId, 'melhor_envio')?.token).toBe(TOKEN_PRODUCAO);

    lojaQueEntrega();
    await freteDoCarrinho();
    expect(chamadas[0].headers.authorization).toBe(`Bearer ${TOKEN_PRODUCAO}`);
    expect(chamadas[0].url.startsWith(PRODUCAO)).toBe(true);
  });

  it('recusa transportadora desconhecida e token curto, sem gravar nada', async () => {
    const semNome = await request(app)
      .post('/api/v1/logistics/carriers/credentials')
      .set(gerente)
      .set('Idempotency-Key', 'me-cred-x')
      .send({ carrier: 'transportadora-inventada', token: TOKEN_PRODUCAO });
    expect(semNome.status).toBe(400);
    expect(semNome.body.error.code).toBe('LOGISTICS_CARRIER_INVALID');

    const curto = await request(app)
      .post('/api/v1/logistics/carriers/credentials')
      .set(gerente)
      .set('Idempotency-Key', 'me-cred-y')
      .send({ carrier: 'melhor_envio', token: 'abc' });
    expect(curto.status).toBe(400);
    expect(curto.body.error.code).toBe('LOGISTICS_CREDENTIALS_REQUIRED');

    expect(findRows('logistics_carrier_credentials', () => true).length).toBe(0);
  });

  it('gravar e remover ficam na auditoria — com o ambiente, nunca com o token', async () => {
    await request(app)
      .post('/api/v1/logistics/carriers/credentials')
      .set(gerente)
      .set('Idempotency-Key', 'me-cred-aud')
      .send({ carrier: 'melhor_envio', environment: 'production', token: TOKEN_PRODUCAO });

    const del = await request(app)
      .delete('/api/v1/logistics/carriers/melhor_envio/credentials')
      .set(gerente);
    expect(del.status, JSON.stringify(del.body)).toBe(200);
    expect(del.body.removed).toBe(1);
    expect(getLogisticsCredentials(companyId, 'melhor_envio')).toBeNull();

    const auditoria = getConnection()
      .prepare(
        `SELECT action, detail FROM core_audit_log
          WHERE company_id = ? AND action LIKE 'logistics.credential_%' ORDER BY created_at`,
      )
      .all(companyId) as { action: string; detail: string }[];
    expect(auditoria.map((a) => a.action)).toEqual([
      'logistics.credential_saved',
      'logistics.credential_removed',
    ]);
    expect(JSON.parse(auditoria[0].detail)).toEqual({ carrier: 'melhor_envio', environment: 'production' });
    expect(auditoria.map((a) => a.detail).join(' ')).not.toContain(TOKEN_PRODUCAO);
  });

  it('o caixa não grava credencial', async () => {
    const caixa = await sessao('CAIXA_ME', 'operador_caixa_loja');
    const res = await request(app)
      .post('/api/v1/logistics/carriers/credentials')
      .set(caixa)
      .set('Idempotency-Key', 'me-cred-caixa')
      .send({ carrier: 'melhor_envio', token: TOKEN_PRODUCAO });
    expect(res.status).toBe(403);
  });

  it('a credencial de uma operação não cota para a outra', async () => {
    dublarMelhorEnvio();
    guardar('production', TOKEN_PRODUCAO);
    const vizinha = upsertCompany({ slug: 'preco-justo', legalName: 'PJ Ltda', tradeName: 'Preço Justo' });
    lojaQueEntrega(vizinha);

    const r = await freteDoCarrinho(vizinha);
    expect(chamadas.length).toBe(0);
    expect(r.options.some((o) => o.source === 'transportadora')).toBe(false);
  });

  it('teste de conexão com token recusado grava a falha com a razão', async () => {
    dublarMelhorEnvio({ status: 401 });
    guardar('production', TOKEN_PRODUCAO);

    const teste = await request(app)
      .post('/api/v1/logistics/carriers/melhor_envio/test-connection')
      .set(gerente)
      .send({});
    expect(teste.body.ok).toBe(false);
    expect(teste.body.message).toMatch(/recusou o token/);

    const lista = await request(app).get('/api/v1/core/logistics/carriers').set(gerente);
    const me = lista.body.items.find((i: { carrier: string }) => i.carrier === 'melhor_envio');
    expect(me.connection).toMatchObject({ tested: true, ok: false });
    expect(me.connection.message).toMatch(/recusou o token/);
  });
});

// ============================================================================

describe('guarda de processo: servidor de PRODUÇÃO não inventa nem usa sandbox', () => {
  const nodeEnvOriginal = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = nodeEnvOriginal;
  });

  it('com NODE_ENV=production, a cotação simulada não é produzida', async () => {
    dublarMelhorEnvio();
    process.env.NODE_ENV = 'production';

    const q = await backendLogisticsQuote(companyId, {
      originZipCode: '68900000',
      destinationZipCode: '01310100',
      weightGrams: 800,
      heightCm: 10,
      widthCm: 30,
      lengthCm: 40,
    });
    expect(q.options).toEqual([]);
    expect(q.code).toBe('NO_CARRIER_CONFIGURED');
  });

  it('com NODE_ENV=production, token de sandbox não chama o sandbox', async () => {
    dublarMelhorEnvio();
    guardar('homologation', TOKEN_SANDBOX);
    process.env.NODE_ENV = 'production';

    const q = await backendLogisticsQuote(companyId, {
      originZipCode: '68900000',
      destinationZipCode: '01310100',
      weightGrams: 800,
      heightCm: 10,
      widthCm: 30,
      lengthCm: 40,
    });
    expect(chamadas.length).toBe(0);
    expect(q.options).toEqual([]);
  });

  it('com NODE_ENV=production, o token de produção continua valendo', async () => {
    dublarMelhorEnvio();
    guardar('production', TOKEN_PRODUCAO);
    process.env.NODE_ENV = 'production';

    const q = await backendLogisticsQuote(companyId, {
      originZipCode: '68900000',
      destinationZipCode: '01310100',
      weightGrams: 800,
      heightCm: 10,
      widthCm: 30,
      lengthCm: 40,
    });
    expect(chamadas[0].url.startsWith(PRODUCAO)).toBe(true);
    expect(q.options.length).toBe(2);
  });
});

