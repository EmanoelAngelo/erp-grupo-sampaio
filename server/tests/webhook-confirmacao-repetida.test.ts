/**
 * ============================================================================
 * A SEGUNDA CONFIRMAÇÃO DA MESMA COBRANÇA NÃO É ERRO (GAP-PRD-091)
 * ============================================================================
 *
 * Boleto e cartão no Asaas emitem DOIS eventos de confirmação para a mesma
 * cobrança, com ids diferentes: `PAYMENT_CONFIRMED` (o pagamento foi aceito) e,
 * dias depois, `PAYMENT_RECEIVED` (o dinheiro caiu). Os dois têm o mesmo posto
 * na régua de eventos, então o segundo não é "notícia velha" — e o
 * processamento chamava `settleEntry` de novo. A baixa recusava ("já está
 * quitado"), e o catch gravava `baixa recusada: …` na intenção e respondia
 * "Pagamento confirmado, título NÃO baixado". Uma baixa só, dinheiro certo —
 * e um alerta falso em TODA cobrança por boleto ou cartão, que ensina o gestor
 * a ignorar o `last_error`.
 *
 * Junto, a mesma família de defeito — evento repetido ou fora de ordem que
 * apaga um fato:
 *
 *   - evento no formato antigo do Asaas, SEM `id` próprio: o identificador caía
 *     no id da COBRANÇA, e o `PAYMENT_RECEIVED` chegava como "já recebido"
 *     porque o `PAYMENT_CREATED` da mesma cobrança tinha usado o mesmo número;
 *   - `amount_mismatch` e `paid_after_cancel` não tinham posto na régua (valiam
 *     zero), então um `PAYMENT_OVERDUE` atrasado os reescrevia como "vencida" e
 *     o sinal de dinheiro a conferir sumia.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import {
  upsertAsaasApiKey,
  upsertAsaasWebhookToken,
} from '../src/services/integrations/AsaasCredentialService.js';
import { createEntry } from '../src/services/core/FinanceService.js';
import { chargeFinanceEntry } from '../src/services/core/FinanceChargeService.js';
import {
  createPaymentIntent,
  handlePaymentWebhook,
  listPaymentIntents,
} from '../src/services/core/PaymentService.js';
import { cancelOrder, checkout } from '../src/services/core/StorefrontService.js';

const TOKEN_PJ = 'token-webhook-preco-justo';

let precoJusto: string;
let seq = 0;

function asaasDeTeste() {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const endereco = String(url);
    const metodo = init?.method ?? 'GET';
    const responder = (data: unknown) =>
      new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (endereco.endsWith('/customers') && metodo === 'POST') {
      seq += 1;
      return responder({ id: `cus_TEST_${seq}` });
    }
    if (endereco.endsWith('/payments') && metodo === 'POST') {
      seq += 1;
      return responder({ id: `pay_TEST_${seq}`, invoiceUrl: `https://sandbox.asaas.com/i/${seq}` });
    }
    if (endereco.includes('/identificationField')) return responder({ identificationField: '34191.7' });
    if (endereco.includes('/pixQrCode')) return responder({ payload: '000201-TESTE' });
    return responder({});
  }) as unknown as typeof fetch;
}

async function tituloCobrado(method: 'pix' | 'boleto' | 'cartao' = 'boleto') {
  seq += 1;
  const cliente = `cli-${seq}`;
  const agora = new Date().toISOString();
  getConnection()
    .prepare(
      `INSERT INTO core_customers (id, company_id, name, document, email, active, created_at, updated_at)
       VALUES (?, ?, 'Dona Marlene', ?, 'marlene@exemplo.com.br', 1, ?, ?)`,
    )
    .run(cliente, precoJusto, String(52998224725 + seq), agora, agora);
  const titulo = createEntry({
    companyId: precoJusto,
    direction: 'in',
    description: 'Aluguel da sala 2',
    amountCents: 30000,
    dueDate: '2026-09-10',
    customerId: cliente,
  });
  const cobranca = await chargeFinanceEntry({
    companyId: precoJusto,
    entryId: titulo.id,
    method,
    fetchImpl: asaasDeTeste(),
  });
  return { entryId: titulo.id, providerRef: String(cobranca.intent.provider_ref), intentId: cobranca.intent.id };
}

async function pedidoCobrado(sufixo: string) {
  const agora = new Date().toISOString();
  const produto = `prod-${sufixo}`;
  getConnection()
    .prepare(
      `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                  price_cents, active, publish_online, created_at, updated_at)
       VALUES (?, ?, ?, 'Produto online', 'UN', 5000, 10000, 1, 1, ?, ?)`,
    )
    .run(produto, precoJusto, `ON-${sufixo}`, agora, agora);
  getConnection()
    .prepare('INSERT INTO core_stock (company_id, product_id, quantity, reserved, updated_at) VALUES (?, ?, 50, 0, ?)')
    .run(precoJusto, produto, agora);
  const [pedido] = checkout({
    idempotencyKey: `ck-${sufixo}`,
    customerName: 'Cliente de teste',
    paymentMethod: 'pix',
    items: [{ productId: produto, quantity: 1 }],
  });
  const intent = await createPaymentIntent({
    companyId: precoJusto,
    originType: 'ecommerce_order',
    originId: pedido.id,
    method: 'pix',
    amountCents: 10000,
    idempotencyKey: `pay-${sufixo}`,
    fetchImpl: asaasDeTeste(),
  });
  getConnection()
    .prepare('UPDATE core_payment_intents SET provider_ref = ? WHERE id = ?')
    .run(`pay_${sufixo}`, intent.id);
  return { orderId: pedido.id, intentId: intent.id, providerRef: `pay_${sufixo}` };
}

function webhook(payload: Record<string, unknown>) {
  return handlePaymentWebhook({ provider: 'asaas', companyId: precoJusto, token: TOKEN_PJ, payload });
}

function intent(id: string): { status: string; last_error: string | null; confirmed_at: string | null } {
  return getConnection()
    .prepare('SELECT status, last_error, confirmed_at FROM core_payment_intents WHERE id = ?')
    .get(id) as { status: string; last_error: string | null; confirmed_at: string | null };
}

function baixas(entryId: string): number {
  return (
    getConnection()
      .prepare('SELECT COUNT(*) AS n FROM core_finance_settlements WHERE entry_id = ?')
      .get(entryId) as { n: number }
  ).n;
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  seq = 0;
  precoJusto = await upsertCompany({ slug: 'preco-justo', tradeName: 'Preço Justo', legalName: 'Preço Justo Ltda' });
  upsertAsaasApiKey({ companyId: precoJusto, environment: 'sandbox', apiKey: '$aact_sandbox_pj_000000000000' });
  upsertAsaasWebhookToken({ companyId: precoJusto, webhookToken: TOKEN_PJ });
  // Nenhuma chamada sai deste processo: o que não passar pelo dublê explícito
  // cai aqui e falha como rede ausente, em vez de alcançar o sandbox real.
  vi.stubGlobal('fetch', async () => {
    throw new TypeError('rede bloqueada neste teste');
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ============================================================================
describe('GAP-PRD-091 — CONFIRMED e depois RECEIVED, ids distintos', () => {
  it('uma baixa, nenhum erro, e a segunda resposta diz que já estava feito', async () => {
    const { entryId, providerRef, intentId } = await tituloCobrado('boleto');

    const primeira = webhook({ id: 'evt_conf', event: 'PAYMENT_CONFIRMED', payment: { id: providerRef, value: 300 } });
    expect(primeira.detail).toContain('Título baixado');
    const confirmadaEm = intent(intentId).confirmed_at;

    const segunda = webhook({ id: 'evt_rec', event: 'PAYMENT_RECEIVED', payment: { id: providerRef, value: 300 } });

    expect(segunda.accepted).toBe(true);
    expect(segunda.duplicated).toBe(false);
    // Antes: "Pagamento confirmado, título NÃO baixado (Este lançamento já está quitado.)"
    expect(segunda.detail).not.toMatch(/NÃO baixado/);
    expect(segunda.detail).toMatch(/já/i);
    expect(intent(intentId).last_error).toBeNull();
    expect(intent(intentId).status).toBe('confirmed');
    // A hora da confirmação é a da PRIMEIRA — a segunda não reescreve a história.
    expect(intent(intentId).confirmed_at).toBe(confirmadaEm);
    expect(baixas(entryId)).toBe(1);

    // A tela de cobranças (GAP-V75) não mostra alerta em cobrança paga.
    const vista = listPaymentIntents({ companyId: precoJusto }).find((i) => i.id === intentId)!;
    expect(vista.lastError).toBeNull();
  });

  it('a ordem inversa (RECEIVED antes de CONFIRMED) também é uma baixa só e sem erro', async () => {
    const { entryId, providerRef, intentId } = await tituloCobrado('cartao');

    webhook({ id: 'evt_rec_2', event: 'PAYMENT_RECEIVED', payment: { id: providerRef, value: 300 } });
    const segunda = webhook({ id: 'evt_conf_2', event: 'PAYMENT_CONFIRMED', payment: { id: providerRef, value: 300 } });

    expect(segunda.detail).not.toMatch(/NÃO baixado/);
    expect(intent(intentId).last_error).toBeNull();
    expect(baixas(entryId)).toBe(1);
  });

  it('o alerta verdadeiro continua: título baixado À MÃO antes do webhook ainda acusa', async () => {
    const { entryId, providerRef, intentId } = await tituloCobrado('pix');
    getConnection()
      .prepare(`UPDATE core_finance_entries SET settled_cents = amount_cents, status = 'settled' WHERE id = ?`)
      .run(entryId);

    const r = webhook({ id: 'evt_manual', event: 'PAYMENT_RECEIVED', payment: { id: providerRef, value: 300 } });

    // Aqui NÃO houve baixa por esta cobrança: a divergência é real e fica.
    expect(r.detail).toMatch(/NÃO baixado/);
    expect(intent(intentId).last_error).toMatch(/baixa recusada/);
  });

  it('pedido online: a segunda confirmação não gera erro nem segundo evento de pago', async () => {
    const { orderId, providerRef, intentId } = await pedidoCobrado('dupla');

    webhook({ id: 'evt_p1', event: 'PAYMENT_CONFIRMED', payment: { id: providerRef, value: 100 } });
    const segunda = webhook({ id: 'evt_p2', event: 'PAYMENT_RECEIVED', payment: { id: providerRef, value: 100 } });

    expect(segunda.accepted).toBe(true);
    expect(intent(intentId).last_error).toBeNull();
    const pagos = getConnection()
      .prepare(`SELECT COUNT(*) AS n FROM core_order_events WHERE order_id = ? AND status = 'pago'`)
      .get(orderId) as { n: number };
    expect(pagos.n).toBe(1);
  });
});

// ============================================================================
describe('evento repetido ou fora de ordem não apaga um fato', () => {
  it('formato antigo, sem id do evento: CREATED e depois RECEIVED da mesma cobrança não se confundem', async () => {
    const { entryId, providerRef } = await tituloCobrado('pix');

    webhook({ event: 'PAYMENT_CREATED', payment: { id: providerRef } });
    const recebido = webhook({ event: 'PAYMENT_RECEIVED', payment: { id: providerRef, value: 300 } });

    // Antes: "Evento já recebido." — o id caía no da COBRANÇA, o mesmo nos dois.
    expect(recebido.duplicated).toBe(false);
    expect(baixas(entryId)).toBe(1);

    // E o mesmo evento repetido no formato antigo continua sendo um só.
    const repetido = webhook({ event: 'PAYMENT_RECEIVED', payment: { id: providerRef, value: 300 } });
    expect(repetido.duplicated).toBe(true);
  });

  it('valor divergente não é desfeito por um vencimento atrasado', async () => {
    const { entryId, providerRef, intentId } = await tituloCobrado('pix');

    webhook({ id: 'evt_div', event: 'PAYMENT_RECEIVED', payment: { id: providerRef, value: 1 } });
    expect(intent(intentId).status).toBe('amount_mismatch');

    webhook({ id: 'evt_venc', event: 'PAYMENT_OVERDUE', payment: { id: providerRef } });
    webhook({ id: 'evt_upd', event: 'PAYMENT_UPDATED', payment: { id: providerRef } });

    // Antes: 'overdue' — o dinheiro a conferir sumia da conciliação.
    expect(intent(intentId).status).toBe('amount_mismatch');
    expect(intent(intentId).last_error).toMatch(/difere/);
    expect(baixas(entryId)).toBe(0);
  });

  it('pagamento depois do cancelamento não volta a "pendente" com evento atrasado', async () => {
    const { orderId, providerRef, intentId } = await pedidoCobrado('apos-cancel');
    cancelOrder({ companyId: precoJusto, orderId, reason: 'cliente desistiu' });

    webhook({ id: 'evt_ac1', event: 'PAYMENT_RECEIVED', payment: { id: providerRef, value: 100 } });
    expect(intent(intentId).status).toBe('paid_after_cancel');

    webhook({ id: 'evt_ac2', event: 'PAYMENT_UPDATED', payment: { id: providerRef } });
    // Antes: 'pending' — o dinheiro recebido depois do cancelamento sumia da lista.
    expect(intent(intentId).status).toBe('paid_after_cancel');
    webhook({ id: 'evt_ac3', event: 'PAYMENT_CONFIRMED', payment: { id: providerRef, value: 100 } });

    expect(intent(intentId).status).toBe('paid_after_cancel');
    const avisos = getConnection()
      .prepare(`SELECT COUNT(*) AS n FROM core_order_events WHERE order_id = ? AND status = 'pagamento_apos_cancelamento'`)
      .get(orderId) as { n: number };
    expect(avisos.n).toBe(1);
  });
});
