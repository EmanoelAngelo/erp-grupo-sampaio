/**
 * DEVOLUÇÃO DO PEDIDO ONLINE: DINHEIRO E MERCADORIA SÃO DOIS FATOS
 * (GAP-PRD-122 e GAP-PRD-031).
 *
 * GAP-PRD-122 — `refundOrder` devolvia o estoque de todo pedido devolvível,
 * inclusive o EXPEDIDO: disponível 8 → 10 com o pacote na transportadora,
 * contra o contrato escrito em `markOrderRefunded` ("o estoque NÃO retorna
 * sozinho"). Agora as duas funções contam a mesma história: o reembolso deixa
 * a mercadoria "a conferir", e o saldo volta pelo recebimento conferido — na
 * hora, quando a mercadoria está na mão (pedido que nunca saiu da loja, ou o
 * gestor dizendo que o pacote voltou).
 *
 * GAP-PRD-031 — a devolução não deixava contrapartida: a receita do pedido
 * continuava liquidada e o DRE contava dinheiro devolvido. Agora o reembolso
 * lança uma SAÍDA própria (`ecommerce_order_refund`, categoria "Devolução a
 * cliente", competência do dia da loja), quitada quando o provedor devolveu e
 * em aberto (conta a pagar ao cliente) quando o dinheiro ainda não voltou.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import {
  upsertAsaasApiKey,
  upsertAsaasWebhookToken,
} from '../src/services/integrations/AsaasCredentialService.js';
import {
  advanceFulfillment,
  checkout,
  markOrderPaid,
} from '../src/services/core/StorefrontService.js';
import { createPaymentIntent, handlePaymentWebhook } from '../src/services/core/PaymentService.js';
import { getAvailable } from '../src/services/core/InventoryService.js';
import { incomeStatement } from '../src/services/core/IncomeStatementService.js';
import { hojeNaLoja } from '../src/services/core/CalendarioOperacional.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();
const TOKEN = 'token-webhook-devolucao-e4';
let gringa: string;
let auth: { Authorization: string };
let n = 0;

const FRETE = {
  method: 'tabela_da_loja',
  label: 'Entrega pela loja',
  priceCents: 1500,
  estimatedDays: 3,
  real: false,
};

function produto(qty = 10): string {
  n += 1;
  const id = `prod-e4-${n}`;
  const agora = new Date().toISOString();
  const db = getConnection();
  db.prepare(
    `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                price_cents, active, publish_online, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'UN', 5000, 10000, 1, 1, ?, ?)`,
  ).run(id, gringa, `E4-${n}`, `Produto E4 ${n}`, agora, agora);
  db.prepare(
    'INSERT INTO core_stock (company_id, product_id, quantity, reserved, updated_at) VALUES (?, ?, ?, 0, ?)',
  ).run(gringa, id, qty, agora);
  return id;
}

function pedido(itens: { productId: string; quantity: number }[], entrega = false) {
  const [p] = checkout({
    idempotencyKey: `ck-e4-${(n += 1)}`,
    customerName: 'Cliente Devolução',
    customerEmail: 'devolve@exemplo.com',
    customerDocument: '11144477735',
    paymentMethod: 'pix',
    ...(entrega
      ? { shippingPorEmpresa: { [gringa]: FRETE }, shippingAddress: 'Rua A, 1 - São Paulo/SP' }
      : {}),
    items: itens,
  });
  return p;
}

function andarAte(orderId: string, etapas: string[]) {
  for (const etapa of etapas) advanceFulfillment({ companyId: gringa, orderId, toStatus: etapa });
}
const ATE_EXPEDIDO = ['separacao', 'conferencia', 'embalado', 'expedido'];
const ATE_ENTREGUE_RETIRADA = ['separacao', 'conferencia', 'embalado', 'pronto_para_retirada', 'entregue'];

/** Pedido pago pelo provedor: intenção com referência + webhook confirmado. */
async function pagoPeloProvedor(orderId: string, total: number, ref: string) {
  const intent = await createPaymentIntent({
    companyId: gringa,
    originType: 'ecommerce_order',
    originId: orderId,
    method: 'pix',
    amountCents: total,
    idempotencyKey: `pay-e4-${ref}`,
  });
  getConnection().prepare('UPDATE core_payment_intents SET provider_ref = ? WHERE id = ?').run(ref, intent.id);
  handlePaymentWebhook({
    provider: 'asaas',
    companyId: gringa,
    token: TOKEN,
    payload: { id: `ev-${ref}-ok`, event: 'PAYMENT_CONFIRMED', payment: { id: ref } },
  });
}

function devolver(orderId: string, body: Record<string, unknown> = { reason: 'cliente desistiu' }) {
  return request(app).post(`/api/v1/core/orders/${orderId}/devolver`).set(auth).send(body);
}

function receber(orderId: string, body: Record<string, unknown> = {}, quem = auth) {
  return request(app).post(`/api/v1/core/orders/${orderId}/devolucao/receber`).set(quem).send(body);
}

function saidas(orderId: string) {
  return getConnection()
    .prepare(
      `SELECT e.*, c.system_code FROM core_finance_entries e
         LEFT JOIN core_finance_categories c ON c.id = e.category_id
        WHERE e.origin_type = 'ecommerce_order_refund' AND e.origin_id = ?`,
    )
    .all(orderId) as Record<string, unknown>[];
}

function baixas(entryId: string) {
  return getConnection()
    .prepare('SELECT amount_cents FROM core_finance_settlements WHERE entry_id = ?')
    .all(entryId) as { amount_cents: number }[];
}

function linha(orderId: string) {
  return getConnection()
    .prepare('SELECT status, return_goods_status, return_goods_at FROM core_orders WHERE id = ?')
    .get(orderId) as { status: string; return_goods_status: string | null; return_goods_at: string | null };
}

/** O provedor de mentira: responde ao estorno com sucesso ou com falha. */
function provedor(estornoFunciona: boolean) {
  const chamadas: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request) => {
      chamadas.push(String(url));
      if (String(url).includes('/refund')) {
        return estornoFunciona
          ? new Response(JSON.stringify({ id: 'ref-ok', status: 'REFUNDED' }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            })
          : new Response(JSON.stringify({ errors: [{ description: 'fora do ar' }] }), {
              status: 500,
              headers: { 'Content-Type': 'application/json' },
            });
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }),
  );
  return chamadas;
}

beforeEach(async () => {
  resetDbForTests();
  n = 0;
  const login = await loginForTest(app, { userId: 'ger-e4', companyId: 'gringa', profileCodes: ['gerente_loja'] });
  auth = { Authorization: `Bearer ${login.body.accessToken}` };
  gringa = (getConnection().prepare("SELECT id FROM core_companies WHERE slug = 'gringa'").get() as { id: string }).id;
  upsertAsaasWebhookToken({ companyId: gringa, webhookToken: TOKEN });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ============================================================================

describe('GAP-PRD-122: o estoque volta quando a mercadoria é conferida', () => {
  it('pedido EXPEDIDO devolvido NÃO devolve o estoque: fica a conferir', async () => {
    const p1 = produto(10);
    const ordem = pedido([{ productId: p1, quantity: 2 }], true);
    markOrderPaid({ companyId: gringa, orderId: ordem.id });
    andarAte(ordem.id, ATE_EXPEDIDO);
    expect(getAvailable(gringa, p1)).toBe(8);

    const res = await devolver(ordem.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ status: 'reembolsado', mercadoria: 'aguardando' });

    // O pacote está com a transportadora: vender de novo seria vender o que
    // não está na prateleira.
    expect(getAvailable(gringa, p1)).toBe(8);
    expect(linha(ordem.id)).toMatchObject({ status: 'reembolsado', return_goods_status: 'aguardando' });
  });

  it('o recebimento conferido devolve SÓ o que voltou vendável, e diz o que não voltou', async () => {
    const p1 = produto(10);
    const p2 = produto(10);
    const ordem = pedido(
      [
        { productId: p1, quantity: 2 },
        { productId: p2, quantity: 1 },
      ],
      true,
    );
    markOrderPaid({ companyId: gringa, orderId: ordem.id });
    andarAte(ordem.id, ATE_EXPEDIDO);
    await devolver(ordem.id);

    const res = await receber(ordem.id, {
      itens: [
        { productId: p1, quantidade: 1 },
        { productId: p2, quantidade: 1 },
      ],
      nota: 'Uma unidade voltou amassada',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ unidadesDeVolta: 2, unidadesQueNaoVoltaram: 1 });

    expect(getAvailable(gringa, p1)).toBe(9);
    expect(getAvailable(gringa, p2)).toBe(10);
    const agora = linha(ordem.id);
    expect(agora.return_goods_status).toBe('recebida');
    expect(agora.return_goods_at).toBeTruthy();

    const ultimo = getConnection()
      .prepare('SELECT note FROM core_order_events WHERE order_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
      .get(ordem.id) as { note: string };
    expect(ultimo.note).toMatch(/2 unidade\(s\) de volta/);
    expect(ultimo.note).toMatch(/Não voltaram ao estoque.*1 × Produto E4/);
    expect(ultimo.note).toMatch(/amassada/);

    // Receber de novo não dobra o saldo: é recusado.
    const denovo = await receber(ordem.id);
    expect(denovo.status).toBe(409);
    expect(denovo.body.error.code).toBe('CORE_ORDER_RETURN_ALREADY_RECEIVED');
    expect(getAvailable(gringa, p1)).toBe(9);

    const trilha = getConnection()
      .prepare("SELECT COUNT(*) AS n FROM core_audit_log WHERE action = 'order.return_received' AND entity_id = ?")
      .get(ordem.id) as { n: number };
    expect(trilha.n).toBe(1);
  });

  it('pedido que nunca saiu da loja (pago) devolve o estoque na hora — a mercadoria está na mão', async () => {
    const p1 = produto(10);
    const ordem = pedido([{ productId: p1, quantity: 2 }]);
    markOrderPaid({ companyId: gringa, orderId: ordem.id });
    expect(getAvailable(gringa, p1)).toBe(8);

    const res = await devolver(ordem.id);
    expect(res.body).toMatchObject({ status: 'reembolsado', mercadoria: 'recebida' });
    expect(getAvailable(gringa, p1)).toBe(10);
  });

  it('entregue com a mercadoria de volta no balcão: mercadoriaNaMao=true devolve na hora', async () => {
    const p1 = produto(10);
    const ordem = pedido([{ productId: p1, quantity: 1 }]);
    markOrderPaid({ companyId: gringa, orderId: ordem.id });
    andarAte(ordem.id, ATE_ENTREGUE_RETIRADA);

    const res = await devolver(ordem.id, { reason: 'trouxe de volta na loja', mercadoriaNaMao: true });
    expect(res.body.mercadoria).toBe('recebida');
    expect(getAvailable(gringa, p1)).toBe(10);
  });

  it('pago mas a mercadoria não está conferida (mercadoriaNaMao=false): fica a conferir', async () => {
    const p1 = produto(10);
    const ordem = pedido([{ productId: p1, quantity: 1 }]);
    markOrderPaid({ companyId: gringa, orderId: ordem.id });
    const res = await devolver(ordem.id, { reason: 'separado e sumiu', mercadoriaNaMao: false });
    expect(res.body.mercadoria).toBe('aguardando');
    expect(getAvailable(gringa, p1)).toBe(9);
  });

  it('o estorno que chega pelo provedor (webhook) conta a MESMA história: estoque a conferir', async () => {
    const p1 = produto(10);
    const ordem = pedido([{ productId: p1, quantity: 3 }]);
    await pagoPeloProvedor(ordem.id, ordem.total_cents, 'pay_e4_wh');
    expect(getAvailable(gringa, p1)).toBe(7);

    handlePaymentWebhook({
      provider: 'asaas',
      companyId: gringa,
      token: TOKEN,
      payload: { id: 'ev-e4-wh-ref', event: 'PAYMENT_REFUNDED', payment: { id: 'pay_e4_wh' } },
    });
    expect(linha(ordem.id)).toMatchObject({ status: 'reembolsado', return_goods_status: 'aguardando' });
    expect(getAvailable(gringa, p1)).toBe(7);

    expect((await receber(ordem.id)).status).toBe(200);
    expect(getAvailable(gringa, p1)).toBe(10);
  });

  it('as recusas do recebimento: sem devolução, item alheio, quantidade demais, perfil, empresa', async () => {
    const p1 = produto(10);
    const outro = produto(10);
    const ordem = pedido([{ productId: p1, quantity: 2 }], true);
    markOrderPaid({ companyId: gringa, orderId: ordem.id });
    andarAte(ordem.id, ATE_EXPEDIDO);

    // Ainda não devolvido: não há mercadoria a receber.
    const cedo = await receber(ordem.id);
    expect(cedo.status).toBe(409);
    expect(cedo.body.error.code).toBe('CORE_ORDER_RETURN_NOT_PENDING');

    await devolver(ordem.id);
    const alheio = await receber(ordem.id, { itens: [{ productId: outro, quantidade: 1 }] });
    expect(alheio.status).toBe(400);
    expect(alheio.body.error.code).toBe('CORE_ORDER_RETURN_ITEM');
    const demais = await receber(ordem.id, { itens: [{ productId: p1, quantidade: 3 }] });
    expect(demais.status).toBe(400);

    const atendente = await loginForTest(app, { userId: 'atd-e4', companyId: 'gringa', profileCodes: ['atendente'] });
    expect(
      (await receber(ordem.id, {}, { Authorization: `Bearer ${atendente.body.accessToken}` })).status,
    ).toBe(403);

    const vizinho = await loginForTest(app, { userId: 'ger-viz', companyId: 'vizinha', profileCodes: ['gerente_loja'] });
    expect(
      (await receber(ordem.id, {}, { Authorization: `Bearer ${vizinho.body.accessToken}` })).status,
    ).toBe(404);

    // Nada disso mexeu no estoque.
    expect(getAvailable(gringa, p1)).toBe(8);

    // O estoquista recebe mercadoria.
    const estoquista = await loginForTest(app, { userId: 'est-e4', companyId: 'gringa', profileCodes: ['estoquista'] });
    const ok = await receber(ordem.id, {}, { Authorization: `Bearer ${estoquista.body.accessToken}` });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(getAvailable(gringa, p1)).toBe(10);
  });
});

// ============================================================================

describe('GAP-PRD-031: o dinheiro que volta tem lançamento próprio', () => {
  it('pagamento manual devolvido: saída "Devolução a cliente" EM ABERTO, no dia da loja', async () => {
    const p1 = produto(10);
    const ordem = pedido([{ productId: p1, quantity: 2 }]);
    markOrderPaid({ companyId: gringa, orderId: ordem.id, provider: 'manual' });

    const res = await devolver(ordem.id);
    expect(res.body).toMatchObject({ providerRefund: 'not_applicable', dinheiro: 'a_devolver' });

    const [saida] = saidas(ordem.id);
    expect(saida).toMatchObject({
      direction: 'out',
      amount_cents: ordem.total_cents,
      settled_cents: 0,
      status: 'open',
      system_code: 'devolucao',
      competence_date: hojeNaLoja(),
      due_date: hojeNaLoja(),
    });
    expect(String(saida.description)).toMatch(/Reembolso a pagar ao cliente — pedido online #/);

    // A receita do mês do pagamento continua lá: a devolução não a reescreve.
    const receita = getConnection()
      .prepare("SELECT status FROM core_finance_entries WHERE origin_type = 'ecommerce_order' AND origin_id = ?")
      .all(ordem.id) as { status: string }[];
    expect(receita).toEqual([{ status: 'settled' }]);

    // A ficha do pedido mostra os dois lados, com rótulo navegável.
    const ficha = await request(app).get(`/api/v1/core/orders/${ordem.id}`).set(auth);
    const tipos = (ficha.body.financeEntries as { originType: string; originLabel: string }[]).map(
      (e) => e.originType,
    );
    expect(tipos.sort()).toEqual(['ecommerce_order', 'ecommerce_order_refund']);
    const reembolso = (ficha.body.financeEntries as { originType: string; originLabel: string }[]).find(
      (e) => e.originType === 'ecommerce_order_refund',
    )!;
    expect(reembolso.originLabel).toBe(`Reembolso do pedido online #${ordem.number}`);
  });

  it('o DRE do dia deixa de contar a receita devolvida', async () => {
    const p1 = produto(10);
    const ordem = pedido([{ productId: p1, quantity: 2 }]);
    markOrderPaid({ companyId: gringa, orderId: ordem.id });
    const hoje = hojeNaLoja();
    const antes = incomeStatement(gringa, hoje, hoje);

    await devolver(ordem.id);
    const depois = incomeStatement(gringa, hoje, hoje);
    expect(depois.revenue.totalCents).toBe(antes.revenue.totalCents);
    expect(depois.expense.totalCents - antes.expense.totalCents).toBe(ordem.total_cents);
    expect(depois.resultCents).toBe(antes.resultCents - ordem.total_cents);
  });

  it('estorno feito pelo provedor: a saída nasce QUITADA, com a baixa espelho', async () => {
    const chamadas = provedor(true);
    upsertAsaasApiKey({ companyId: gringa, environment: 'sandbox', apiKey: 'chave-sandbox-e4' });
    const p1 = produto(10);
    const ordem = pedido([{ productId: p1, quantity: 1 }]);
    await pagoPeloProvedor(ordem.id, ordem.total_cents, 'pay_e4_ok');

    const res = await devolver(ordem.id);
    expect(res.body).toMatchObject({ providerRefund: 'done', dinheiro: 'devolvido_pelo_provedor' });
    expect(chamadas.some((u) => u.includes('/payments/pay_e4_ok/refund'))).toBe(true);

    const [saida] = saidas(ordem.id);
    expect(saida).toMatchObject({ status: 'settled', settled_cents: ordem.total_cents });
    expect(baixas(String(saida.id))).toEqual([{ amount_cents: ordem.total_cents }]);
  });

  it('estorno no provedor falhou: fica a pagar — e o aviso posterior do provedor quita, uma vez', async () => {
    provedor(false);
    upsertAsaasApiKey({ companyId: gringa, environment: 'sandbox', apiKey: 'chave-sandbox-e4' });
    const p1 = produto(10);
    const ordem = pedido([{ productId: p1, quantity: 1 }]);
    await pagoPeloProvedor(ordem.id, ordem.total_cents, 'pay_e4_falha');

    const res = await devolver(ordem.id);
    expect(res.body).toMatchObject({ providerRefund: 'failed', dinheiro: 'a_devolver' });
    const [aberta] = saidas(ordem.id);
    expect(aberta.status).toBe('open');

    // Alguém estornou pelo painel do provedor; o aviso chega depois — duas vezes.
    for (const id of ['ev-e4-late-1', 'ev-e4-late-2']) {
      handlePaymentWebhook({
        provider: 'asaas',
        companyId: gringa,
        token: TOKEN,
        payload: { id, event: 'PAYMENT_REFUNDED', payment: { id: 'pay_e4_falha' } },
      });
    }
    const todas = saidas(ordem.id);
    expect(todas).toHaveLength(1);
    expect(todas[0]).toMatchObject({ status: 'settled', settled_cents: ordem.total_cents });
    expect(baixas(String(todas[0].id))).toEqual([{ amount_cents: ordem.total_cents }]);
  });

  it('estorno pelo webhook lança a saída quitada; o webhook repetido não duplica', async () => {
    const p1 = produto(10);
    const ordem = pedido([{ productId: p1, quantity: 1 }]);
    await pagoPeloProvedor(ordem.id, ordem.total_cents, 'pay_e4_dup');
    for (const id of ['ev-e4-dup-1', 'ev-e4-dup-2']) {
      handlePaymentWebhook({
        provider: 'asaas',
        companyId: gringa,
        token: TOKEN,
        payload: { id, event: 'PAYMENT_CHARGEBACK_REQUESTED', payment: { id: 'pay_e4_dup' } },
      });
    }
    const todas = saidas(ordem.id);
    expect(todas).toHaveLength(1);
    expect(todas[0]).toMatchObject({ status: 'settled', system_code: 'devolucao' });
  });

  it('devolver duas vezes não lança duas saídas', async () => {
    const p1 = produto(10);
    const ordem = pedido([{ productId: p1, quantity: 1 }]);
    markOrderPaid({ companyId: gringa, orderId: ordem.id });
    await devolver(ordem.id);
    const segunda = await devolver(ordem.id);
    expect(segunda.status).toBe(200);
    expect(segunda.body).toMatchObject({ status: 'reembolsado', dinheiro: 'a_devolver' });
    expect(saidas(ordem.id)).toHaveLength(1);
  });

  it('pedido com NF-e autorizada: a devolução diz o que o fiscal precisa fazer', async () => {
    const p1 = produto(10);
    const ordem = pedido([{ productId: p1, quantity: 1 }]);
    markOrderPaid({ companyId: gringa, orderId: ordem.id });
    const agora = new Date().toISOString();
    getConnection()
      .prepare(
        `INSERT INTO core_fiscal_documents
           (id, company_id, order_id, model, serie, number, environment, status, created_at, updated_at)
         VALUES (?, ?, ?, '55', 1, 321, 'homologacao', 'AUTHORIZED', ?, ?)`,
      )
      .run(randomUUID(), gringa, ordem.id, agora, agora);

    const res = await devolver(ordem.id);
    expect(res.body.pendenciaFiscal).toMatch(/NF-e nº 321/);
    const notas = getConnection()
      .prepare('SELECT note FROM core_order_events WHERE order_id = ?')
      .all(ordem.id) as { note: string | null }[];
    expect(notas.some((e) => /NF-e nº 321/.test(e.note ?? ''))).toBe(true);
  });
});
