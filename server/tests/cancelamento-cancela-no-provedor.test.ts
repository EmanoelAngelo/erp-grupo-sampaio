/**
 * ============================================================================
 * OS TRÊS CAMINHOS DO CANCELAMENTO CANCELAM NO PROVEDOR (GAP-V72)
 * ============================================================================
 *
 * O DEFEITO: `cancelOrderCharges` existia, era tolerante a falha do provedor
 * por construção, e tinha UM chamador — o portal do cliente. Os outros dois
 * caminhos que cancelam pedido (o gerente pelo ERP e a rotina de expiração da
 * reserva) largavam o PIX/boleto VIVO no Asaas: o cliente ainda podia pagar um
 * pedido que não existe mais. O dinheiro não sumia (vira `paid_after_cancel` e
 * aparece na conciliação), mas gerava regularização manual evitável.
 *
 * Os três caminhos passam a fazer a mesma coisa, e este arquivo cobra os dois
 * que faltavam. O dublê do provedor é explícito — nada sai deste processo.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { createApp } from '../src/app.js';
import { loginForTest } from './helpers/auth.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import {
  upsertAsaasApiKey,
  upsertAsaasWebhookToken,
} from '../src/services/integrations/AsaasCredentialService.js';
import { checkout } from '../src/services/core/StorefrontService.js';
import { createOrderCharge } from '../src/services/core/OrderChargeService.js';
import { expirarPedidosNaoPagos } from '../src/services/core/OrderReservationExpiry.js';

const CHAVE = '$aact_sandbox_company_1_000000000000000';
const TOKEN = 'token-webhook-company-1';
const EMPRESA = 'company-1';

let n = 0;

function asaasDeTeste(opcoes: { falharCancelamento?: boolean } = {}) {
  const chamadas: { method: string; url: string }[] = [];
  let sequencia = 0;

  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const endereco = String(url);
    const metodo = init?.method ?? 'GET';
    chamadas.push({ method: metodo, url: endereco });

    const responder = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });

    if (endereco.endsWith('/customers') && metodo === 'POST') {
      sequencia += 1;
      return responder({ id: `cus_TEST_${sequencia}` });
    }
    if (endereco.endsWith('/payments') && metodo === 'POST') {
      sequencia += 1;
      return responder({
        id: `pay_TEST_${sequencia}`,
        invoiceUrl: `https://sandbox.asaas.com/i/TEST_${sequencia}`,
      });
    }
    if (endereco.includes('/pixQrCode')) {
      return responder({ payload: '00020126TESTE', encodedImage: 'iVBORTESTE' });
    }
    // Remover a cobrança é DELETE /payments/:id no Asaas (GAP-PRD-169).
    if (metodo === 'DELETE' && /[/]payments[/][^/?]+$/.test(endereco)) {
      if (opcoes.falharCancelamento) return responder({ errors: [{ description: 'fora' }] }, 500);
      return responder({ id: 'pay_TEST_cancelado', status: 'CANCELLED' });
    }
    return responder({});
  }) as unknown as typeof fetch;

  const cancelamentos = () =>
    chamadas.filter((c) => c.method === 'DELETE' && /[/]payments[/][^/?]+$/.test(c.url));
  return { fetchImpl, chamadas, cancelamentos };
}

function produtoPublicado(companyId: string): string {
  n += 1;
  const id = `prod-cancel-${n}`;
  const agora = new Date().toISOString();
  const db = getConnection();
  db.prepare(
    `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                price_cents, active, publish_online, created_at, updated_at)
     VALUES (?, ?, ?, 'Produto online', 'UN', 5000, 10000, 1, 1, ?, ?)`,
  ).run(id, companyId, `CANC-${n}`, agora, agora);
  db.prepare(
    'INSERT INTO core_stock (company_id, product_id, quantity, reserved, updated_at) VALUES (?, ?, 10, 0, ?)',
  ).run(companyId, id, agora);
  return id;
}

async function pedidoComCobranca(fetchImpl: typeof fetch, chave: string) {
  const produto = produtoPublicado(EMPRESA);
  const [ordem] = checkout({
    idempotencyKey: chave,
    customerName: 'Maria Compradora',
    customerDocument: '111.444.777-35',
    customerEmail: 'maria@exemplo.com',
    paymentMethod: 'pix',
    items: [{ productId: produto, quantity: 1 }],
  });
  const cobranca = await createOrderCharge({
    companyId: EMPRESA,
    orderId: ordem.id,
    method: 'pix',
    fetchImpl,
  });
  return { ordem, cobranca };
}

function intencoes(orderId: string): Record<string, unknown>[] {
  return getConnection()
    .prepare(
      "SELECT * FROM core_payment_intents WHERE origin_type = 'ecommerce_order' AND origin_id = ?",
    )
    .all(orderId) as Record<string, unknown>[];
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  n = 0;
  await upsertCompany({
    id: EMPRESA,
    slug: EMPRESA,
    tradeName: EMPRESA,
    legalName: `${EMPRESA} Ltda`,
  });
  vi.stubEnv('ASAAS_ENABLED', 'true');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('caminho 2: o gerente cancela pelo ERP', () => {
  it('a cobrança é cancelada no provedor antes de o pedido morrer', async () => {
    const asaas = asaasDeTeste();
    vi.stubGlobal('fetch', asaas.fetchImpl);

    const app = createApp();
    const gerente = await loginForTest(app, {
      userId: 'gerente',
      companyId: EMPRESA,
      profileCodes: ['gerente_loja'],
    });
    upsertAsaasApiKey({ companyId: EMPRESA, environment: 'sandbox', apiKey: CHAVE });
    upsertAsaasWebhookToken({ companyId: EMPRESA, webhookToken: TOKEN });

    const { ordem } = await pedidoComCobranca(asaas.fetchImpl, 'ck-erp-1');
    expect(intencoes(ordem.id)[0].status).toBe('pending');

    const res = await request(app)
      .post(`/api/v1/core/orders/${ordem.id}/cancel`)
      .set('Authorization', `Bearer ${gerente.body.accessToken as string}`)
      .send({ reason: 'Cliente desistiu' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelado');
    expect(asaas.cancelamentos()).toHaveLength(1);
    expect(intencoes(ordem.id)[0].status).toBe('cancelled');
  });

  it('provedor fora do ar NÃO segura o cancelamento — o erro fica na intenção', async () => {
    const asaas = asaasDeTeste({ falharCancelamento: true });
    vi.stubGlobal('fetch', asaas.fetchImpl);

    const app = createApp();
    const gerente = await loginForTest(app, {
      userId: 'gerente',
      companyId: EMPRESA,
      profileCodes: ['gerente_loja'],
    });
    upsertAsaasApiKey({ companyId: EMPRESA, environment: 'sandbox', apiKey: CHAVE });

    const { ordem } = await pedidoComCobranca(asaas.fetchImpl, 'ck-erp-2');

    const res = await request(app)
      .post(`/api/v1/core/orders/${ordem.id}/cancel`)
      .set('Authorization', `Bearer ${gerente.body.accessToken as string}`)
      .send({ reason: 'Cliente desistiu' });

    // O pedido cancela do mesmo jeito: manter estoque preso por causa do
    // provedor seria trocar um problema pequeno por um grande.
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelado');
    const intencao = intencoes(ordem.id)[0];
    expect(intencao.status).toBe('pending');
    expect(String(intencao.last_error)).toContain('cancelamento');
  });
});

describe('caminho 3: a reserva expira sozinha', () => {
  it('a rotina de expiração cancela a cobrança antes de soltar o estoque', async () => {
    const asaas = asaasDeTeste();
    upsertAsaasApiKey({ companyId: EMPRESA, environment: 'sandbox', apiKey: CHAVE });

    const { ordem } = await pedidoComCobranca(asaas.fetchImpl, 'ck-exp-1');
    // O pedido envelhece: 26 horas depois, a reserva não se sustenta mais.
    const velho = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString();
    getConnection()
      .prepare('UPDATE core_orders SET created_at = ? WHERE id = ?')
      .run(velho, ordem.id);

    const resultado = await expirarPedidosNaoPagos(new Date(), { fetchImpl: asaas.fetchImpl });

    expect(resultado.cancelados).toBe(1);
    expect(asaas.cancelamentos()).toHaveLength(1);
    expect(intencoes(ordem.id)[0].status).toBe('cancelled');
    const pedidoDepois = getConnection()
      .prepare('SELECT status FROM core_orders WHERE id = ?')
      .get(ordem.id) as { status: string };
    expect(pedidoDepois.status).toBe('cancelado');
  });

  it('sem pedido vencido, ninguém liga para o provedor', async () => {
    const asaas = asaasDeTeste();
    upsertAsaasApiKey({ companyId: EMPRESA, environment: 'sandbox', apiKey: CHAVE });
    await pedidoComCobranca(asaas.fetchImpl, 'ck-exp-2');

    const resultado = await expirarPedidosNaoPagos(new Date(), { fetchImpl: asaas.fetchImpl });

    expect(resultado.cancelados).toBe(0);
    expect(asaas.cancelamentos()).toHaveLength(0);
  });
});
