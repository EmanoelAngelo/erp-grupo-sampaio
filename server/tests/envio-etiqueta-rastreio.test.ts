/**
 * ============================================================================
 * O ENVIO DO PEDIDO — etiqueta no provedor, despacho, rastreio e entrega com
 * origem (GAP-PRD-120, GAP-PRD-119)
 * ============================================================================
 *
 * O que a auditoria mediu:
 *
 *   - `POST /logistics/shipments` gravava QUALQUER corpo — `{qualquerCoisa:
 *     true, orderId:'nao-existe'}` virava um envio "quoted", sem pedido e sem
 *     provedor. Nenhuma tela chamava a rota; etiqueta e envio no provedor não
 *     existiam; `logistics_labels` e `logistics_tracking_events` não tinham
 *     escritor;
 *   - o portal mostrava só o código digitado num `window.prompt`, sem
 *     transportadora nem link; "entregue" era um clique sem origem declarada.
 *
 * O que este arquivo tranca, com o `fetch` do Melhor Envio DUBLADO (nenhuma
 * chamada sai para a rede):
 *
 *   - a rota crua recusa corpo sem pedido e não grava nada;
 *   - a prontidão diz o que falta ANTES de chamar o provedor;
 *   - a compra passa pelos três atos do provedor (carrinho → pagamento →
 *     geração), no ambiente da credencial, com remetente, destinatário, volume,
 *     nota e identificação do pedido; clique duplo não compra duas vezes;
 *     saldo que falta deixa o envio no carrinho e a compra se retoma;
 *   - o rastreio do provedor move o pedido (postado → expedido, entregue →
 *     entregue) com origem "provedor", e a falha da consulta fica VISÍVEL;
 *   - despacho sem etiqueta exige quem leva; o código dos Correios é conferido;
 *     o link público sai do servidor; entregue pelo operador tem origem e nome;
 *   - tenant, permissão e a guarda do provedor de teste em produção.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetEnvCacheForTests } from '../src/config/env.js';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { getConnection } from '../src/db/sqlite.js';
import { linkUserToCompany, upsertCompany, upsertUser } from '../src/services/auth/IdentityService.js';
import { updateFiscalConfig } from '../src/services/core/FiscalConfigService.js';
import { saveShippingSettings } from '../src/services/core/CheckoutShippingService.js';
import { advanceFulfillment, checkout, markOrderPaid } from '../src/services/core/StorefrontService.js';
import { getCustomerOrder } from '../src/services/core/CustomerPortalService.js';
import { upsertLogisticsCredentials } from '../src/services/logistics/LogisticsCredentialService.js';
import {
  salvarConfiguracaoDeEnvio,
  sincronizarEnviosPendentes,
  sugerirEndereco,
} from '../src/services/logistics/EnvioDoPedidoService.js';
import { registrarProvedorDeTeste, type ProvedorDeEnvio } from '../src/services/logistics/ProvedorDeEnvio.js';

process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-key';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-32-chars!!';

const app = createApp();
const SENHA = 'Teste@EnvioDoPedido2026';
const SANDBOX = 'https://sandbox.melhorenvio.com.br';
const TOKEN = 'me-sandbox-token-de-teste-envio-0001';
const CPF = '111.444.777-35';
const CNPJ = '11.222.333/0001-81';
const REF = 'me-ord-0001';

/** O corpo que sai para `POST /api/v2/me/cart`, do jeito que o teste o lê. */
interface CorpoDoCarrinho {
  service: number;
  agency?: unknown;
  from: Record<string, unknown>;
  to: Record<string, unknown>;
  volumes: unknown[];
  products: unknown[];
  options: {
    insurance_value: number;
    non_commercial: boolean;
    invoice?: { key: string };
    tags: { tag: string }[];
  };
}

/** O pedido como o portal o devolve — só o que o teste lê. */
/**
 * A conta do portal da compradora: o pedido feito sem conta é de quem PROVOU o
 * e-mail digitado nele (filtroDoDono, GAP-PRD-006/043).
 */
const CONTA_DA_ANA = { id: 'conta-da-ana', email: 'ana@example.com', emailVerifiedAt: '2026-09-01T12:00:00.000Z' };

interface PedidoDoPortal {
  trackingUrl: string | null;
  carrierName: string | null;
  tracking: {
    viaProvedor: boolean;
    status: string | null;
    aviso: string | null;
    lastSyncOk: boolean | null;
    events: { origin: string; description: string }[];
  };
  timeline: { status: string; origin: string | null }[];
}

let companyId: string;
let outraEmpresa: string;
let gerente: { Authorization: string };
let n = 0;

// --------------------------------------------------------------- o provedor

interface Chamada {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

let chamadas: Chamada[] = [];

interface Respostas {
  checkout?: { status: number; body: unknown };
  tracking?: { status: number; body: unknown };
  generate?: unknown;
}

function responder(corpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(corpo), { status, headers: { 'Content-Type': 'application/json' } });
}

function rastreio(status: string, extra: Record<string, unknown> = {}) {
  return {
    [REF]: {
      id: REF,
      protocol: 'ORD-2026-0001',
      status,
      tracking: 'AA123456789BR',
      melhorenvio_tracking: 'ME2600000001',
      created_at: '2026-09-10 10:00:00',
      paid_at: '2026-09-10 10:00:05',
      generated_at: '2026-09-10 10:00:09',
      posted_at: null,
      delivered_at: null,
      canceled_at: null,
      expired_at: null,
      ...extra,
    },
  };
}

let respostas: Respostas = {};

function dublarMelhorEnvio() {
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
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
    });
    const caminho = url.replace(SANDBOX, '');
    if (caminho === '/api/v2/me/cart' && init?.method === 'POST') {
      return responder({ id: REF, protocol: 'ORD-2026-0001', price: 23.9, status: 'pending' });
    }
    if (caminho === '/api/v2/me/shipment/checkout') {
      const r = respostas.checkout ?? { status: 200, body: { purchase: { id: 'pur-1', status: 'paid' } } };
      return responder(r.body, r.status);
    }
    if (caminho === '/api/v2/me/shipment/generate') {
      return responder(respostas.generate ?? { [REF]: { status: true, message: 'Envio gerado com sucesso' } });
    }
    if (caminho === '/api/v2/me/shipment/tracking') {
      const r = respostas.tracking ?? { status: 200, body: rastreio('generated') };
      return responder(r.body, r.status);
    }
    if (caminho === '/api/v2/me/shipment/print') {
      return responder({ url: 'https://sandbox.melhorenvio.com.br/imprimir/abc123' });
    }
    if (caminho === '/api/v2/me/shipment/cancel') {
      return responder({ [REF]: { canceled: true } });
    }
    if (caminho === `/api/v2/me/cart/${REF}` && init?.method === 'DELETE') {
      return responder({});
    }
    return responder({ message: 'rota não dublada' }, 404);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function chamadasA(caminho: string) {
  return chamadas.filter((c) => c.url === `${SANDBOX}${caminho}`);
}

// --------------------------------------------------------------- o cenário

async function sessao(login: string, perfil: string, empresa = companyId) {
  const userId = await upsertUser({ login, displayName: `Pessoa ${login}`, password: SENHA });
  linkUserToCompany(userId, empresa, perfil, true);
  const res = await request(app).post('/api/v1/auth/login').send({ login, password: SENHA });
  return { headers: { Authorization: `Bearer ${res.body.accessToken}` }, userId };
}

function remetenteCompleto(empresa = companyId) {
  updateFiscalConfig({
    companyId: empresa,
    patch: {
      legalName: 'Gringa Comércio Ltda',
      cnpj: CNPJ,
      ie: '0240000000',
      zip: '68900-000',
      street: 'Rua Cândido Mendes',
      number: '100',
      district: 'Centro',
      cityName: 'Macapá',
      uf: 'AP',
      phone: '(96) 3222-0000',
    },
  });
}

function produto(empresa = companyId): string {
  n += 1;
  const id = `envio-prod-${n}`;
  const agora = new Date().toISOString();
  const db = getConnection();
  db.prepare(
    `INSERT INTO core_products
       (id, company_id, internal_code, name, unit, cost_cents, price_cents,
        weight_grams, height_cm, width_cm, length_cm, active, publish_online, created_at, updated_at)
     VALUES (?, ?, ?, 'Jaqueta jeans', 'UN', 4000, 20000, 800, 10, 30, 40, 1, 1, ?, ?)`,
  ).run(id, empresa, `ENV-${n}`, agora, agora);
  db.prepare(
    'INSERT INTO core_stock (company_id, product_id, quantity, reserved, updated_at) VALUES (?, ?, 50, 0, ?)',
  ).run(empresa, id, agora);
  return id;
}

function pedidoPago(opts: { empresa?: string; metodo?: string; servico?: string } = {}) {
  const empresa = opts.empresa ?? companyId;
  const p = produto(empresa);
  const [pedido] = checkout({
    idempotencyKey: `ck-envio-${n}-${Math.random().toString(36).slice(2, 8)}`,
    customerName: 'Ana Compradora',
    customerDocument: CPF,
    customerEmail: 'ana@example.com',
    customerPhone: '(96) 99999-0000',
    shippingZip: '01310-100',
    shippingAddress: 'Avenida Paulista, 1000 - Bela Vista, São Paulo/SP',
    paymentMethod: 'pix',
    items: [{ productId: p, quantity: 1 }],
    shippingPorEmpresa: {
      [empresa]: {
        method: opts.metodo ?? 'transportadora:melhor_envio:1',
        label: opts.servico ?? 'Correios PAC',
        priceCents: 2_390,
        estimatedDays: 8,
        real: true,
      },
    },
  });
  markOrderPaid({ companyId: empresa, orderId: pedido.id });
  return pedido;
}

/**
 * O pedido pronto para sair: pago e percorrido pela loja até "embalado", uma
 * etapa por vez (GAP-PRD-121) — é de "embalado" que o operador despacha. O
 * fato da TRANSPORTADORA não precisa disso: ele anda o pedido de onde estiver.
 */
function pedidoEmbalado(opts: { empresa?: string; metodo?: string; servico?: string } = {}) {
  const pedido = pedidoPago(opts);
  for (const etapa of ['separacao', 'conferencia', 'embalado']) {
    advanceFulfillment({ companyId: opts.empresa ?? companyId, orderId: pedido.id, toStatus: etapa, origin: 'operador' });
  }
  return pedido;
}

function notaAutorizada(orderId: string, empresa = companyId) {
  const agora = new Date().toISOString();
  getConnection()
    .prepare(
      `INSERT INTO core_fiscal_documents
         (id, company_id, order_id, model, serie, number, access_key, environment, status,
          protocol, authorized_at, created_at, updated_at)
       VALUES (?, ?, ?, '55', 1, ?, ?, 'homologation', 'AUTHORIZED', '135260000000001', ?, ?, ?)`,
    )
    .run(`nfe-${orderId}`, empresa, orderId, 100 + n, `1626091122233300018155001000000${String(100 + n).padStart(3, '0')}1000000010`, agora, agora, agora);
}

function guardarToken(empresa = companyId) {
  upsertLogisticsCredentials({
    companyId: empresa,
    carrier: 'melhor_envio',
    environment: 'homologation',
    contactEmail: 'ti@gringa.example',
    credentials: { token: TOKEN },
  });
}

const DESTINATARIO = {
  nome: 'Ana Compradora',
  documento: CPF,
  telefone: '(96) 99999-0000',
  email: 'ana@example.com',
  logradouro: 'Avenida Paulista',
  numero: '1000',
  complemento: 'Apto 12',
  bairro: 'Bela Vista',
  cidade: 'São Paulo',
  uf: 'SP',
  cep: '01310-100',
};

function comprar(orderId: string, chave: string, corpo: Record<string, unknown> = {}, quem = gerente) {
  return request(app)
    .post(`/api/v1/logistics/orders/${orderId}/label`)
    .set(quem)
    .set('Idempotency-Key', chave)
    .send({ destinatario: DESTINATARIO, ...corpo });
}

function eventosDoPedido(orderId: string) {
  return getConnection()
    .prepare('SELECT status, note, user_id, origin FROM core_order_events WHERE order_id = ? ORDER BY created_at')
    .all(orderId) as { status: string; note: string | null; user_id: string | null; origin: string | null }[];
}

function statusDoPedido(orderId: string) {
  return getConnection()
    .prepare('SELECT status, tracking_code, shipping_carrier FROM core_orders WHERE id = ?')
    .get(orderId) as { status: string; tracking_code: string | null; shipping_carrier: string | null };
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  chamadas = [];
  respostas = {};
  n = 0;
  resetEnvCacheForTests();
  companyId = upsertCompany({ slug: 'gringa', legalName: 'Gringa Comércio Ltda', tradeName: 'Gringa' });
  outraEmpresa = upsertCompany({ slug: 'me-mimei', legalName: 'Me Mimei Ltda', tradeName: 'Me Mimei' });
  saveShippingSettings({ companyId, pickupEnabled: true, deliveryEnabled: true, flatRateCents: 2_500, estimatedDays: 4 });
  gerente = (await sessao('GERENTE_ENVIO', 'gerente_loja')).headers;
});

afterEach(() => {
  vi.unstubAllGlobals();
  registrarProvedorDeTeste(null);
  delete process.env.DEVORA_API_ENV;
  resetEnvCacheForTests();
});

// ============================================================================

describe('GAP-PRD-120 — a rota crua saiu', () => {
  it('POST /logistics/shipments com corpo qualquer é recusado e não grava nada', async () => {
    dublarMelhorEnvio();
    const res = await request(app)
      .post('/api/v1/logistics/shipments')
      .set(gerente)
      .set('Idempotency-Key', 'cru-1')
      .send({ qualquerCoisa: true, companyId: 'gringa', status: 'quoted' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('LOGISTICS_ORDER_REQUIRED');
    expect(getConnection().prepare('SELECT COUNT(*) AS n FROM core_shipments').get()).toEqual({ n: 0 });
    // A coleção crua (`logistics_shipments`) foi aposentada na junção do
    // GAP-PRD-075: a instalação nova nem a cria, e o envio só existe em core_shipments.
    expect(
      getConnection().prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'logistics_shipments'").get(),
    ).toEqual({ n: 0 });
    expect(chamadas).toHaveLength(0);
  });

  it('pedido que não existe (ou de outra empresa) é 404, sem chamar o provedor', async () => {
    dublarMelhorEnvio();
    guardarToken(outraEmpresa);
    remetenteCompleto(outraEmpresa);
    saveShippingSettings({ companyId: outraEmpresa, pickupEnabled: true, deliveryEnabled: true, flatRateCents: 1 });
    const alheio = pedidoPago({ empresa: outraEmpresa });

    for (const orderId of ['nao-existe', alheio.id]) {
      const res = await request(app)
        .post('/api/v1/logistics/shipments')
        .set(gerente)
        .set('Idempotency-Key', `cru-${orderId}`)
        .send({ orderId, destinatario: DESTINATARIO });
      expect(res.status).toBe(404);
    }
    expect(chamadas).toHaveLength(0);
  });
});

describe('GAP-PRD-120 — a prontidão diz o que falta antes de chamar o provedor', () => {
  it('sem token, sem remetente e sem nota: lista as três coisas, e a compra é recusada sem HTTP', async () => {
    dublarMelhorEnvio();
    const pedido = pedidoPago();

    const pronto = await request(app).get(`/api/v1/logistics/orders/${pedido.id}/shipments`).set(gerente);
    expect(pronto.status).toBe(200);
    const chaves = pronto.body.readiness.faltando.map((f: { chave: string }) => f.chave);
    expect(chaves).toEqual(expect.arrayContaining(['transportadora', 'remetente', 'nota']));
    expect(pronto.body.readiness.podeComprar).toBe(false);
    // O remetente diz QUAIS campos faltam, e onde se resolve.
    const remetente = pronto.body.readiness.faltando.find((f: { chave: string }) => f.chave === 'remetente');
    expect(remetente.mensagem).toMatch(/CNPJ/);
    expect(remetente.onde).toBe('/sistema/fiscal/configuracao');
    // O serviço vendido no checkout vem do pedido; o destinatário vem sugerido.
    expect(pronto.body.readiness.servico).toEqual({ code: '1', name: 'Correios PAC' });
    expect(pronto.body.readiness.destinatarioSugerido).toMatchObject({
      logradouro: 'Avenida Paulista',
      numero: '1000',
      bairro: 'Bela Vista',
      cidade: 'São Paulo',
      uf: 'SP',
      cep: '01310100',
    });

    const compra = await comprar(pedido.id, 'k-sem-nada');
    expect(compra.status).toBe(409);
    expect(compra.body.error.code).toBe('LOGISTICS_LABEL_NOT_READY');
    expect(chamadas).toHaveLength(0);
  });

  it('pedido de retirada e pedido não pago não compram etiqueta', async () => {
    dublarMelhorEnvio();
    guardarToken();
    remetenteCompleto();
    salvarConfiguracaoDeEnvio(companyId, { permitirDeclaracaoDeConteudo: true }, null);
    const retirada = pedidoPago({ metodo: 'retirada' });
    const r = await request(app).get(`/api/v1/logistics/orders/${retirada.id}/shipments`).set(gerente);
    expect(r.body.readiness.faltando.map((f: { chave: string }) => f.chave)).toContain('retirada');
    expect((await comprar(retirada.id, 'k-ret')).status).toBe(409);
    expect(chamadas).toHaveLength(0);
  });
});

describe('GAP-PRD-120 — a etiqueta é comprada no provedor, ligada ao pedido', () => {
  beforeEach(() => {
    guardarToken();
    remetenteCompleto();
  });

  it('carrinho → pagamento → geração no SANDBOX do token, com o pedido inteiro no corpo', async () => {
    dublarMelhorEnvio();
    const pedido = pedidoPago();
    notaAutorizada(pedido.id);

    const res = await comprar(pedido.id, 'k-compra-1');

    expect(res.status).toBe(201);
    expect(res.body.aviso).toBeNull();
    expect(res.body.envio).toMatchObject({
      orderId: pedido.id,
      channel: 'melhor_envio',
      carrier: 'melhor_envio',
      environment: 'sandbox',
      status: 'etiqueta_gerada',
      serviceCode: '1',
      priceCents: 2_390,
      trackingCode: 'AA123456789BR',
      trackingUrl: 'https://www.melhorrastreio.com.br/rastreio/AA123456789BR',
      contentDeclaration: false,
    });
    expect(res.body.envio.actions).toMatchObject({ imprimir: true, cancelar: true, pagarEGerar: false });

    // Os três atos, nessa ordem, no endereço do ambiente da credencial.
    const ordem = chamadas.map((c) => `${c.method} ${c.url.replace(SANDBOX, '')}`);
    expect(ordem.slice(0, 3)).toEqual([
      'POST /api/v2/me/cart',
      'POST /api/v2/me/shipment/checkout',
      'POST /api/v2/me/shipment/generate',
    ]);
    const [carrinho] = chamadasA('/api/v2/me/cart');
    expect(carrinho.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(carrinho.headers['user-agent']).toBe('DEVORA ERP (ti@gringa.example)');
    const corpo = carrinho.body as unknown as CorpoDoCarrinho;
    expect(corpo.service).toBe(1);
    expect(corpo.from).toMatchObject({
      name: 'Gringa Comércio Ltda',
      company_document: '11222333000181',
      postal_code: '68900000',
      state_abbr: 'AP',
      phone: '9632220000',
    });
    expect(corpo.to).toMatchObject({
      name: 'Ana Compradora',
      document: '11144477735',
      address: 'Avenida Paulista',
      number: '1000',
      district: 'Bela Vista',
      city: 'São Paulo',
      state_abbr: 'SP',
      postal_code: '01310100',
    });
    // Peso em quilos, seguro em reais — as unidades do provedor.
    expect(corpo.volumes).toEqual([{ height: 10, width: 30, length: 40, weight: 0.8 }]);
    expect(corpo.products).toEqual([{ name: 'Jaqueta jeans', quantity: 1, unitary_value: 200 }]);
    expect(corpo.options.insurance_value).toBe(200);
    // Com nota autorizada, vai a chave — e não a declaração de conteúdo.
    expect(corpo.options.invoice.key).toMatch(/^\d{44}$/);
    expect(corpo.options.non_commercial).toBe(false);
    expect(corpo.options.tags[0].tag).toBe(`Pedido #${pedido.number} — Gringa`);

    // A auditoria registra o ato, e o token não aparece nela.
    const auditoria = getConnection()
      .prepare("SELECT detail FROM core_audit_log WHERE action = 'logistics.label_created'")
      .all() as { detail: string }[];
    expect(auditoria).toHaveLength(1);
    expect(auditoria[0].detail).not.toContain(TOKEN);

    // O pedido não sai sozinho por ter etiqueta: despachar é outro ato.
    expect(statusDoPedido(pedido.id).status).toBe('pago');
  });

  it('clique duplo com a mesma chave compra UMA vez', async () => {
    dublarMelhorEnvio();
    const pedido = pedidoPago();
    salvarConfiguracaoDeEnvio(companyId, { permitirDeclaracaoDeConteudo: true }, null);

    const a = await comprar(pedido.id, 'k-duplo');
    const b = await comprar(pedido.id, 'k-duplo');
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.body.envio.id).toBe(a.body.envio.id);
    expect(chamadasA('/api/v2/me/cart')).toHaveLength(1);

    // Chave nova, mesmo pedido: o envio vivo já existe, e a recusa vem antes do provedor.
    const c = await comprar(pedido.id, 'k-outra');
    expect(c.status).toBe(409);
    expect(chamadasA('/api/v2/me/cart')).toHaveLength(1);
  });

  /*
    A MESMA CHAVE COM OUTRA ETIQUETA NÃO É O CLIQUE DUPLO (RES-IDEM-VIZ): o
    reenvio devolvia o envio da chave sem olhar o pedido, o serviço nem o
    destinatário — a etiqueta do pedido A respondia pelo pedido B.
  */
  it('a mesma chave com OUTRO destinatário, serviço ou pedido é recusada (422), sem chamar o provedor', async () => {
    dublarMelhorEnvio();
    const pedido = pedidoPago();
    const outroPedido = pedidoPago();
    salvarConfiguracaoDeEnvio(companyId, { permitirDeclaracaoDeConteudo: true }, null);

    const a = await comprar(pedido.id, 'k-outro-corpo');
    expect(a.status, JSON.stringify(a.body)).toBe(201);

    for (const tentativa of [
      comprar(pedido.id, 'k-outro-corpo', { destinatario: { ...DESTINATARIO, numero: '2000' } }),
      comprar(pedido.id, 'k-outro-corpo', { servico: { code: '2', name: 'Correios SEDEX' } }),
      comprar(outroPedido.id, 'k-outro-corpo'),
    ]) {
      const r = await tentativa;
      expect(r.status, JSON.stringify(r.body)).toBe(422);
      expect(r.body.error.code).toBe('CORE_IDEMPOTENCY_KEY_REUSED');
    }
    expect(chamadasA('/api/v2/me/cart')).toHaveLength(1);
    expect(
      (getConnection().prepare('SELECT COUNT(*) AS n FROM core_shipments WHERE company_id = ?').get(companyId) as { n: number }).n,
    ).toBe(1);
  });

  it('envio anterior à impressão digital: a mesma chave devolve o envio, como sempre', async () => {
    dublarMelhorEnvio();
    const pedido = pedidoPago();
    salvarConfiguracaoDeEnvio(companyId, { permitirDeclaracaoDeConteudo: true }, null);
    const a = await comprar(pedido.id, 'k-antiga');
    expect(a.status).toBe(201);
    getConnection().prepare('UPDATE core_shipments SET idempotency_fingerprint = NULL WHERE id = ?').run(a.body.envio.id as string);
    const b = await comprar(pedido.id, 'k-antiga', { destinatario: { ...DESTINATARIO, numero: '2000' } });
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    expect(b.body.envio.id).toBe(a.body.envio.id);
  });

  it('declaração de conteúdo só com a decisão ligada — e aí vai non_commercial', async () => {
    dublarMelhorEnvio();
    const pedido = pedidoPago();

    const semDecisao = await comprar(pedido.id, 'k-decl-0');
    expect(semDecisao.status).toBe(409);
    expect(JSON.stringify(semDecisao.body.error.details)).toMatch(/NF-e/);

    salvarConfiguracaoDeEnvio(companyId, { permitirDeclaracaoDeConteudo: true }, null);
    const comDecisao = await comprar(pedido.id, 'k-decl-1');
    expect(comDecisao.status).toBe(201);
    expect(comDecisao.body.envio.contentDeclaration).toBe(true);
    const corpo = chamadasA('/api/v2/me/cart')[0].body as unknown as CorpoDoCarrinho;
    expect(corpo.options.non_commercial).toBe(true);
    expect(corpo.options.invoice).toBeUndefined();
  });

  it('saldo que falta deixa o envio no carrinho, com a frase do provedor — e a compra se retoma', async () => {
    dublarMelhorEnvio();
    respostas.checkout = { status: 422, body: { error: 'Saldo insuficiente para realizar a compra.' } };
    const pedido = pedidoPago();
    salvarConfiguracaoDeEnvio(companyId, { permitirDeclaracaoDeConteudo: true }, null);

    const res = await comprar(pedido.id, 'k-saldo');
    expect(res.status).toBe(201);
    expect(res.body.envio.status).toBe('pendente');
    expect(res.body.aviso).toMatch(/Saldo insuficiente/);
    expect(res.body.envio.lastError).toMatch(/Saldo insuficiente/);
    expect(res.body.envio.actions.pagarEGerar).toBe(true);
    expect(chamadasA('/api/v2/me/shipment/generate')).toHaveLength(0);

    respostas.checkout = undefined;
    const retomada = await request(app)
      .post(`/api/v1/logistics/shipments/${res.body.envio.id}/continue`)
      .set(gerente)
      .send({});
    expect(retomada.status).toBe(200);
    expect(retomada.body.envio.status).toBe('etiqueta_gerada');
    expect(retomada.body.envio.lastError).toBeNull();
    // Retomar NÃO cria um segundo envio no provedor.
    expect(chamadasA('/api/v2/me/cart')).toHaveLength(1);
  });

  it('o link de impressão é pedido na hora, e o cancelamento devolve o pedido à fila de etiqueta', async () => {
    dublarMelhorEnvio();
    const pedido = pedidoPago();
    salvarConfiguracaoDeEnvio(companyId, { permitirDeclaracaoDeConteudo: true }, null);
    const { body } = await comprar(pedido.id, 'k-imprimir');

    const link = await request(app).get(`/api/v1/logistics/shipments/${body.envio.id}/label`).set(gerente);
    expect(link.status).toBe(200);
    expect(link.body.url).toBe('https://sandbox.melhorenvio.com.br/imprimir/abc123');
    expect(chamadasA('/api/v2/me/shipment/print')[0].body).toEqual({ mode: 'public', orders: [REF] });

    const semMotivo = await request(app).post(`/api/v1/logistics/shipments/${body.envio.id}/cancel`).set(gerente).send({});
    expect(semMotivo.status).toBe(400);

    const cancelado = await request(app)
      .post(`/api/v1/logistics/shipments/${body.envio.id}/cancel`)
      .set(gerente)
      .send({ motivo: 'Cliente trocou o endereço' });
    expect(cancelado.status).toBe(200);
    expect(cancelado.body.status).toBe('cancelado');
    expect(chamadasA('/api/v2/me/shipment/cancel')[0].body).toMatchObject({ order: { id: REF } });

    // Cancelado sai da conta do envio vivo: pode comprar outra.
    const pronto = await request(app).get(`/api/v1/logistics/orders/${pedido.id}/shipments`).set(gerente);
    expect(pronto.body.readiness.envioVivo).toBeNull();
    expect(pronto.body.items[0].status).toBe('cancelado');
  });

  it('destinatário incompleto e CEP diferente do cotado são recusados antes do provedor', async () => {
    dublarMelhorEnvio();
    const pedido = pedidoPago();
    salvarConfiguracaoDeEnvio(companyId, { permitirDeclaracaoDeConteudo: true }, null);

    const incompleto = await comprar(pedido.id, 'k-dest-1', {
      destinatario: { ...DESTINATARIO, documento: '123', bairro: '', uf: 'XX' },
    });
    expect(incompleto.status).toBe(400);
    expect(incompleto.body.error.details.campos).toEqual(expect.arrayContaining(['CPF ou CNPJ válido', 'bairro', 'UF']));

    const outroCep = await comprar(pedido.id, 'k-dest-2', { destinatario: { ...DESTINATARIO, cep: '20040-000' } });
    expect(outroCep.status).toBe(409);
    expect(outroCep.body.error.code).toBe('LOGISTICS_RECIPIENT_ZIP_MISMATCH');
    expect(chamadas).toHaveLength(0);
  });

  it('serviço Jadlog exige a agência — e ela vai no corpo quando existe', async () => {
    dublarMelhorEnvio();
    const pedido = pedidoPago({ metodo: 'transportadora:melhor_envio:3', servico: 'Jadlog .Package' });
    salvarConfiguracaoDeEnvio(companyId, { permitirDeclaracaoDeConteudo: true }, null);

    const sem = await comprar(pedido.id, 'k-jad-0');
    expect(sem.status).toBe(409);
    expect(JSON.stringify(sem.body.error)).toMatch(/agência/);

    salvarConfiguracaoDeEnvio(companyId, { agenciaJadlog: '4321' }, null);
    const com = await comprar(pedido.id, 'k-jad-1');
    expect(com.status).toBe(201);
    expect((chamadasA('/api/v2/me/cart')[0].body as Record<string, unknown>).agency).toBe(4321);
  });

  it('token recusado no carrinho vira 502 com a frase do provedor, e nada é gravado', async () => {
    const fn = vi.fn(async () => responder({ message: 'Unauthenticated.' }, 401));
    vi.stubGlobal('fetch', fn);
    const pedido = pedidoPago();
    salvarConfiguracaoDeEnvio(companyId, { permitirDeclaracaoDeConteudo: true }, null);

    const res = await comprar(pedido.id, 'k-401');
    expect(res.status).toBe(502);
    expect(res.body.error.message).toMatch(/recusou o token/);
    expect(res.body.error.message).not.toContain(TOKEN);
    expect(getConnection().prepare('SELECT COUNT(*) AS n FROM core_shipments').get()).toEqual({ n: 0 });
  });
});

describe('GAP-PRD-119 — o rastreio do provedor move o pedido, com origem', () => {
  let envioId: string;
  let pedidoId: string;

  beforeEach(async () => {
    guardarToken();
    remetenteCompleto();
    salvarConfiguracaoDeEnvio(companyId, { permitirDeclaracaoDeConteudo: true }, null);
    dublarMelhorEnvio();
    const pedido = pedidoPago();
    pedidoId = pedido.id;
    envioId = (await comprar(pedido.id, 'k-rastreio')).body.envio.id;
    chamadas = [];
  });

  it('postado pela transportadora → pedido "expedido" com origem provedor, e o e-mail leva o link', async () => {
    respostas.tracking = { status: 200, body: rastreio('posted', { posted_at: '2026-09-11 09:30:00' }) };

    const res = await request(app).post(`/api/v1/logistics/shipments/${envioId}/sync`).set(gerente).send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('postado');
    expect(res.body.lastSync).toMatchObject({ ok: true });
    // A hora do provedor vem sem fuso: é Brasília, e não UTC.
    const postado = res.body.events.find((e: { description: string }) => /postada/.test(e.description));
    expect(postado).toMatchObject({ origin: 'provedor', occurredAt: '2026-09-11T12:30:00.000Z' });

    expect(statusDoPedido(pedidoId)).toMatchObject({
      status: 'expedido',
      tracking_code: 'AA123456789BR',
      shipping_carrier: 'melhor_envio',
    });
    const expedido = eventosDoPedido(pedidoId).find((e) => e.status === 'expedido');
    expect(expedido).toMatchObject({ origin: 'provedor', user_id: null });

    const email = getConnection()
      .prepare("SELECT body_text FROM core_email_queue WHERE template = 'pedido_expedido'")
      .get() as { body_text: string };
    expect(email.body_text).toContain('https://www.melhorrastreio.com.br/rastreio/AA123456789BR');
    expect(email.body_text).toContain('(Melhor Envio)');

    // Consultar de novo não duplica os eventos.
    await request(app).post(`/api/v1/logistics/shipments/${envioId}/sync`).set(gerente).send({});
    const denovo = await request(app).get(`/api/v1/logistics/orders/${pedidoId}/shipments`).set(gerente);
    const postagens = denovo.body.items[0].events.filter((e: { description: string }) => /postada/.test(e.description));
    expect(postagens).toHaveLength(1);
  });

  it('entregue pela transportadora → pedido "entregue" com origem provedor (e o portal mostra)', async () => {
    respostas.tracking = {
      status: 200,
      body: rastreio('delivered', { posted_at: '2026-09-11 09:30:00', delivered_at: '2026-09-12 15:00:00' }),
    };
    const r = await sincronizarEnviosPendentes();
    expect(r).toEqual({ ok: 1, falhas: 0 });

    expect(statusDoPedido(pedidoId).status).toBe('entregue');
    const entregue = eventosDoPedido(pedidoId).find((e) => e.status === 'entregue');
    expect(entregue).toMatchObject({ origin: 'provedor', user_id: null });
    expect(entregue?.note).toMatch(/confirmada pela transportadora/);

    const portal = getCustomerOrder(CONTA_DA_ANA, pedidoId) as unknown as PedidoDoPortal;
    expect(portal.trackingUrl).toBe('https://www.melhorrastreio.com.br/rastreio/AA123456789BR');
    expect(portal.carrierName).toBe('Melhor Envio');
    expect(portal.tracking).toMatchObject({ viaProvedor: true, status: 'entregue', aviso: null });
    expect(portal.tracking.events.some((e) => e.origin === 'provedor' && /Entrega confirmada/.test(e.description))).toBe(true);
    expect(portal.timeline.find((e) => e.status === 'entregue')?.origin).toBe('provedor');

    // Entregue não é mais consultado pela agenda.
    chamadas = [];
    expect(await sincronizarEnviosPendentes()).toEqual({ ok: 0, falhas: 0 });
    expect(chamadas).toHaveLength(0);
  });

  it('a falha do provedor fica gravada e VISÍVEL — no ERP e no portal', async () => {
    respostas.tracking = { status: 503, body: { message: 'Service Unavailable' } };

    const res = await request(app).post(`/api/v1/logistics/shipments/${envioId}/sync`).set(gerente).send({});
    expect(res.status).toBe(200);
    expect(res.body.lastSync.ok).toBe(false);
    expect(res.body.lastSync.message).toMatch(/fora do ar/);
    // O pedido não se move por uma consulta que falhou.
    expect(statusDoPedido(pedidoId).status).toBe('pago');

    const portal = getCustomerOrder(CONTA_DA_ANA, pedidoId) as unknown as PedidoDoPortal;
    expect(portal.tracking.aviso).toMatch(/Não conseguimos atualizar o rastreio/);
    expect(portal.tracking.lastSyncOk).toBe(false);
  });
});

describe('GAP-PRD-119 — despacho e entrega pela loja, com quem leva e quem disse', () => {
  let estoquista: { headers: { Authorization: string }; userId: string };

  beforeEach(async () => {
    estoquista = await sessao('ESTOQUISTA_ENVIO', 'estoquista');
  });

  function avancar(orderId: string, corpo: Record<string, unknown>, quem = estoquista.headers) {
    return request(app).post(`/api/v1/core/orders/${orderId}/fulfillment`).set(quem).send(corpo);
  }

  it('sem etiqueta, despachar exige QUEM leva — e o código dos Correios é conferido', async () => {
    const pedido = pedidoEmbalado();

    const semQuem = await avancar(pedido.id, { status: 'expedido', trackingCode: 'AA123456789BR' });
    expect(semQuem.status).toBe(400);
    expect(semQuem.body.error.code).toBe('LOGISTICS_CARRIER_REQUIRED');

    const torto = await avancar(pedido.id, { status: 'expedido', carrier: 'correios', trackingCode: 'AA12345BR' });
    expect(torto.status).toBe(400);
    expect(torto.body.error.code).toBe('LOGISTICS_TRACKING_CODE_INVALID');
    // A recusa não mexe no pedido: ele continua embalado, esperando quem leva.
    expect(statusDoPedido(pedido.id).status).toBe('embalado');

    const ok = await avancar(pedido.id, { status: 'expedido', carrier: 'correios', trackingCode: ' aa123456789br ' });
    expect(ok.status).toBe(200);
    expect(statusDoPedido(pedido.id)).toEqual({
      status: 'expedido',
      tracking_code: 'AA123456789BR',
      shipping_carrier: 'correios',
    });
    const expedido = eventosDoPedido(pedido.id).find((e) => e.status === 'expedido');
    expect(expedido).toMatchObject({ origin: 'operador', user_id: estoquista.userId });

    // O link público sai do SERVIDOR, na lista de pedidos.
    const lista = await request(app).get('/api/v1/core/orders').set(gerente);
    const linha = lista.body.items.find((o: { id: string }) => o.id === pedido.id);
    expect(linha.tracking_url).toBe('https://rastreamento.correios.com.br/app/index.php?objetos=AA123456789BR');

    // E o envio manual fica registrado, com data e operador.
    const envios = await request(app).get(`/api/v1/logistics/orders/${pedido.id}/shipments`).set(gerente);
    expect(envios.body.items[0]).toMatchObject({ channel: 'manual', carrier: 'correios', status: 'postado' });
    expect(envios.body.items[0].dispatchedBy).toBe(estoquista.userId);
    expect(envios.body.items[0].events[0]).toMatchObject({ origin: 'operador', userName: 'Pessoa ESTOQUISTA_ENVIO' });
  });

  it('entrega própria despacha sem código e sem link', async () => {
    const pedido = pedidoEmbalado();
    const ok = await avancar(pedido.id, { status: 'expedido', carrier: 'propria' });
    expect(ok.status).toBe(200);
    const lista = await request(app).get('/api/v1/core/orders').set(gerente);
    expect(lista.body.items.find((o: { id: string }) => o.id === pedido.id).tracking_url).toBeNull();
  });

  it('com etiqueta gerada, o código vem DELA; com etiqueta pendente, não despacha', async () => {
    guardarToken();
    remetenteCompleto();
    salvarConfiguracaoDeEnvio(companyId, { permitirDeclaracaoDeConteudo: true }, null);
    dublarMelhorEnvio();

    respostas.checkout = { status: 422, body: { error: 'Saldo insuficiente.' } };
    const pedido = pedidoEmbalado();
    const { body } = await comprar(pedido.id, 'k-desp');
    const pendente = await avancar(pedido.id, { status: 'expedido', carrier: 'correios' });
    expect(pendente.status).toBe(409);
    expect(pendente.body.error.code).toBe('LOGISTICS_LABEL_NOT_GENERATED');

    respostas.checkout = undefined;
    await request(app).post(`/api/v1/logistics/shipments/${body.envio.id}/continue`).set(gerente).send({});
    const ok = await avancar(pedido.id, { status: 'expedido' });
    expect(ok.status).toBe(200);
    expect(statusDoPedido(pedido.id)).toEqual({
      status: 'expedido',
      tracking_code: 'AA123456789BR',
      shipping_carrier: 'melhor_envio',
    });
  });

  it('"entregue" pela loja tem origem operador e nome — e o envio registra quem disse', async () => {
    const pedido = pedidoEmbalado();
    await avancar(pedido.id, { status: 'expedido', carrier: 'jadlog', trackingCode: '10083912345678' });
    const ok = await avancar(pedido.id, { status: 'entregue' });
    expect(ok.status).toBe(200);

    const entregue = eventosDoPedido(pedido.id).find((e) => e.status === 'entregue');
    expect(entregue).toMatchObject({ origin: 'operador', user_id: estoquista.userId });
    const envios = await request(app).get(`/api/v1/logistics/orders/${pedido.id}/shipments`).set(gerente);
    expect(envios.body.items[0]).toMatchObject({ status: 'entregue', deliveredOrigin: 'operador' });
  });

  it('as outras etapas também registram a origem do operador', async () => {
    const pedido = pedidoPago();
    await avancar(pedido.id, { status: 'separacao' });
    expect(eventosDoPedido(pedido.id).find((e) => e.status === 'separacao')).toMatchObject({
      origin: 'operador',
      user_id: estoquista.userId,
    });
  });
});

describe('tenant e permissão', () => {
  it('envio e pedido de outra empresa respondem 404', async () => {
    guardarToken(outraEmpresa);
    remetenteCompleto(outraEmpresa);
    salvarConfiguracaoDeEnvio(outraEmpresa, { permitirDeclaracaoDeConteudo: true }, null);
    saveShippingSettings({ companyId: outraEmpresa, pickupEnabled: true, deliveryEnabled: true, flatRateCents: 1 });
    dublarMelhorEnvio();
    const alheio = pedidoPago({ empresa: outraEmpresa });
    const gerenteDeLa = (await sessao('GERENTE_LA', 'gerente_loja', outraEmpresa)).headers;
    const envio = (await comprar(alheio.id, 'k-alheio', {}, gerenteDeLa)).body.envio;
    expect(envio.status).toBe('etiqueta_gerada');

    expect((await request(app).get(`/api/v1/logistics/orders/${alheio.id}/shipments`).set(gerente)).status).toBe(404);
    expect((await request(app).get(`/api/v1/logistics/shipments/${envio.id}/label`).set(gerente)).status).toBe(404);
    const cancelar = await request(app)
      .post(`/api/v1/logistics/shipments/${envio.id}/cancel`)
      .set(gerente)
      .send({ motivo: 'tentativa alheia' });
    expect(cancelar.status).toBe(404);
    expect((await request(app).get('/api/v1/logistics/shipments').set(gerente)).body.items).toHaveLength(0);
  });

  it('o atendente vê o envio, mas não compra etiqueta (gasta saldo)', async () => {
    const atendente = (await sessao('ATENDENTE_ENVIO', 'atendente')).headers;
    const pedido = pedidoPago();
    expect((await request(app).get(`/api/v1/logistics/orders/${pedido.id}/shipments`).set(atendente)).status).toBe(200);
    const compra = await comprar(pedido.id, 'k-atendente', {}, atendente);
    expect(compra.status).toBe(403);
  });

  it('a configuração de envio nasce no padrão seguro e é gravada com auditoria', async () => {
    const lida = await request(app).get('/api/v1/logistics/settings/shipping').set(gerente);
    expect(lida.body).toMatchObject({ permitirDeclaracaoDeConteudo: false, agenciaJadlog: null });

    const torta = await request(app).put('/api/v1/logistics/settings/shipping').set(gerente).send({ agenciaJadlog: 'abc' });
    expect(torta.status).toBe(400);

    const salva = await request(app)
      .put('/api/v1/logistics/settings/shipping')
      .set(gerente)
      .send({ permitirDeclaracaoDeConteudo: true, agenciaJadlog: '4321' });
    expect(salva.body).toMatchObject({ permitirDeclaracaoDeConteudo: true, agenciaJadlog: '4321' });
    const auditoria = getConnection()
      .prepare("SELECT COUNT(*) AS n FROM core_audit_log WHERE action = 'logistics.shipping_settings_saved'")
      .get();
    expect(auditoria).toEqual({ n: 1 });
  });
});

describe('o provedor de TESTE não opera em servidor de produção', () => {
  const fake: ProvedorDeEnvio = {
    id: 'teste',
    ambiente: 'sandbox',
    colocarNoCarrinho: async () => ({ id: 'fake-1', protocolo: null, precoCents: 1000, status: 'pending' }),
    pagar: async () => undefined,
    gerar: async () => undefined,
    linkDaEtiqueta: async () => 'https://exemplo.invalid/etiqueta',
    consultar: async () => ({}),
    removerDoCarrinho: async () => undefined,
    cancelar: async () => undefined,
  };

  it('o registro é recusado com NODE_ENV=production e com DEVORA_API_ENV=production', () => {
    const antes = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      expect(() => registrarProvedorDeTeste(fake)).toThrow(/não opera em servidor de produção/);
    } finally {
      process.env.NODE_ENV = antes;
    }
    process.env.DEVORA_API_ENV = 'production';
    expect(() => registrarProvedorDeTeste(fake)).toThrow(/não opera em servidor de produção/);
  });

  it('registrado fora de produção, ele compra; se o processo virar produção, a compra é recusada', async () => {
    remetenteCompleto();
    guardarToken();
    salvarConfiguracaoDeEnvio(companyId, { permitirDeclaracaoDeConteudo: true }, null);
    registrarProvedorDeTeste(fake);
    const pedido = pedidoPago();
    const ok = await comprar(pedido.id, 'k-fake-1');
    expect(ok.status).toBe(201);
    expect(ok.body.envio.status).toBe('etiqueta_gerada');

    process.env.DEVORA_API_ENV = 'production';
    const link = await request(app).get(`/api/v1/logistics/shipments/${ok.body.envio.id}/label`).set(gerente);
    expect(link.status).toBe(500);
    expect(link.body.error.code).toBe('LOGISTICS_TEST_PROVIDER_IN_PRODUCTION');
  });
});

describe('a sugestão de endereço a partir do texto livre do pedido', () => {
  it('separa rua, número, bairro, cidade e UF nos formatos comuns', () => {
    expect(sugerirEndereco('Rua das Flores, 123 - Centro, Porto Alegre/RS')).toMatchObject({
      logradouro: 'Rua das Flores',
      numero: '123',
      bairro: 'Centro',
      cidade: 'Porto Alegre',
      uf: 'RS',
    });
    expect(sugerirEndereco('Av. Brasil 500, Jardim América, Canoas - RS')).toMatchObject({
      logradouro: 'Av. Brasil',
      numero: '500',
      bairro: 'Jardim América',
      cidade: 'Canoas',
      uf: 'RS',
    });
    // Sem nada reconhecível, só a rua: o operador completa.
    expect(sugerirEndereco('Sítio Boa Vista')).toEqual({ logradouro: 'Sítio Boa Vista' });
    expect(sugerirEndereco(null)).toEqual({});
  });
});
