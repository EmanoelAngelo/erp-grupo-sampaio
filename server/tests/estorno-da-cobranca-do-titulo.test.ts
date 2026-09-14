/**
 * ============================================================================
 * ESTORNAR A COBRANÇA PAGA DE UM TÍTULO PELO ERP (GAP-PRD-092)
 * ============================================================================
 *
 * O DEFEITO: `AsaasHttpClient.refundPayment` tinha um único chamador — o
 * pedido online. Do lado do contas a receber não havia rota nem botão: a
 * devolução ao cliente era feita no portal do Asaas e, depois, alguém tinha de
 * lembrar de estornar a baixa na tela de Contas. Até lá o título continuava
 * `settled` e a conciliação passava a acusar "lançado e não cobrado". A
 * própria ContasPage dizia que "o caminho do dinheiro que entrou é o estorno"
 * — e não oferecia o estorno.
 *
 * AGORA: `POST /core/finance/entries/:id/charges/refund` (gerência) pede o
 * estorno ao provedor e, sob confirmação explícita (`desfazerBaixa`), desfaz a
 * baixa `Asaas <cobrança>` com contrapartida e rastro. Quando o estorno já foi
 * feito no portal (o webhook `PAYMENT_REFUNDED` chegou), o mesmo gesto só
 * desfaz a baixa, sem pedir estorno de novo.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { loginForTest } from './helpers/auth.js';
import { asaasComEstado } from './helpers/asaasComEstado.js';
import {
  upsertAsaasApiKey,
  upsertAsaasWebhookToken,
} from '../src/services/integrations/AsaasCredentialService.js';
import { createEntry } from '../src/services/core/FinanceService.js';
import { chargeFinanceEntry } from '../src/services/core/FinanceChargeService.js';
import { handlePaymentWebhook, listPaymentIntents } from '../src/services/core/PaymentService.js';
import { refundFinanceEntryCharge } from '../src/services/core/FinanceChargeRefund.js';
import { reconcileAsaas } from '../src/services/core/AsaasReconciliation.js';

process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-key';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-32-chars!!';

const app = createApp();
const LOJA = 'loja-estorno';
const VIZINHA = 'loja-vizinha';
const TOKEN = 'token-webhook-loja-estorno';
let seq = 0;

async function entrar(companyId: string, perfil: string): Promise<{ Authorization: string }> {
  seq += 1;
  const login = await loginForTest(app, { userId: `u-${perfil}-${seq}`, companyId, profileCodes: [perfil] });
  expect(login.status).toBe(200);
  return { Authorization: `Bearer ${login.body.accessToken}` };
}

function titulo(companyId: string, amountCents = 30000): string {
  seq += 1;
  const cliente = `cli-${seq}`;
  const agora = new Date().toISOString();
  getConnection()
    .prepare(
      `INSERT INTO core_customers (id, company_id, name, document, email, active, created_at, updated_at)
       VALUES (?, ?, 'Dona Marlene', ?, 'marlene@exemplo.com.br', 1, ?, ?)`,
    )
    .run(cliente, companyId, String(52998224725 + seq), agora, agora);
  return createEntry({
    companyId,
    direction: 'in',
    description: 'Aluguel da sala 2',
    amountCents,
    dueDate: '2026-09-10',
    customerId: cliente,
  }).id;
}

/** Título cobrado por PIX e PAGO: o webhook baixou. Devolve a referência. */
async function tituloPago(asaas: ReturnType<typeof asaasComEstado>): Promise<{ entryId: string; ref: string }> {
  const entryId = titulo(LOJA);
  const cobranca = await chargeFinanceEntry({ companyId: LOJA, entryId, method: 'pix', fetchImpl: asaas.fetchImpl });
  const ref = String(cobranca.intent.provider_ref);
  asaas.pagar(ref);
  const r = handlePaymentWebhook({
    provider: 'asaas',
    companyId: LOJA,
    token: TOKEN,
    payload: { id: `evt-rec-${ref}`, event: 'PAYMENT_RECEIVED', payment: { id: ref, value: 300, billingType: 'PIX' } },
  });
  expect(r.detail).toMatch(/baixado/i);
  return { entryId, ref };
}

function linhaDoTitulo(entryId: string): { status: string; settled_cents: number } {
  return getConnection()
    .prepare('SELECT status, settled_cents FROM core_finance_entries WHERE id = ?')
    .get(entryId) as { status: string; settled_cents: number };
}

function intencaoDo(entryId: string): { status: string; last_error: string | null } {
  return getConnection()
    .prepare("SELECT status, last_error FROM core_payment_intents WHERE origin_type = 'finance_entry' AND origin_id = ?")
    .get(entryId) as { status: string; last_error: string | null };
}

function baixasDo(entryId: string): { amount_cents: number; reversed_at: string | null; reverses_id: string | null; note: string | null }[] {
  return getConnection()
    .prepare('SELECT amount_cents, reversed_at, reverses_id, note FROM core_finance_settlements WHERE entry_id = ? ORDER BY settled_at, amount_cents DESC')
    .all(entryId) as never;
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  seq = 0;
  await entrar(LOJA, 'gerente_loja');
  await entrar(VIZINHA, 'gerente_loja');
  upsertAsaasApiKey({ companyId: LOJA, environment: 'sandbox', apiKey: '$aact_sandbox_loja_estorno_000000000' });
  upsertAsaasApiKey({ companyId: VIZINHA, environment: 'sandbox', apiKey: '$aact_sandbox_vizinha_1111111111111' });
  upsertAsaasWebhookToken({ companyId: LOJA, webhookToken: TOKEN });
  vi.stubGlobal('fetch', async () => {
    throw new TypeError('rede bloqueada neste teste');
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ============================================================================
describe('GAP-PRD-092 — o estorno pelo ERP', () => {
  it('estorna no provedor E desfaz a baixa, com contrapartida — e a conciliação fica limpa', async () => {
    const asaas = asaasComEstado();
    const { entryId, ref } = await tituloPago(asaas);
    expect(linhaDoTitulo(entryId).status).toBe('settled');

    const r = await refundFinanceEntryCharge({
      companyId: LOJA,
      entryId,
      desfazerBaixa: true,
      motivo: 'cliente desistiu do aluguel',
      fetchImpl: asaas.fetchImpl,
    });

    expect(asaas.estornos()).toHaveLength(1);
    expect(asaas.estornos()[0].url).toContain(`/payments/${ref}/refund`);
    expect(r.estornadoNoProvedor).toBe(true);
    expect(r.baixaDesfeita).toBe(true);
    expect(intencaoDo(entryId).status).toBe('refunded');
    // A baixa original fica, marcada; entra a linha negativa apontando para ela.
    const baixas = baixasDo(entryId);
    expect(baixas).toHaveLength(2);
    expect(baixas[0].reversed_at).toBeTruthy();
    expect(baixas[1].amount_cents).toBe(-30000);
    expect(baixas[1].note).toContain(`Estorno Asaas ${ref}`);
    expect(baixas[1].note).toContain('cliente desistiu');
    expect(linhaDoTitulo(entryId)).toMatchObject({ status: 'open', settled_cents: 0 });
    // Antes: título settled + intenção refunded = "lançado e não cobrado".
    expect(reconcileAsaas({ companyId: LOJA }).rows).toEqual([]);
  });

  it('sem desfazer a baixa: estorna lá, a baixa fica — e a resposta diz que ela ficou', async () => {
    const asaas = asaasComEstado();
    const { entryId } = await tituloPago(asaas);

    const r = await refundFinanceEntryCharge({ companyId: LOJA, entryId, desfazerBaixa: false, fetchImpl: asaas.fetchImpl });

    expect(r.estornadoNoProvedor).toBe(true);
    expect(r.baixaDesfeita).toBe(false);
    expect(r.detail).toMatch(/baixa.*continua/i);
    expect(linhaDoTitulo(entryId).status).toBe('settled');
    // A divergência É verdadeira enquanto a baixa estiver de pé.
    expect(reconcileAsaas({ companyId: LOJA }).rows.map((l) => l.kind)).toEqual(['lancado_nao_cobrado']);

    // O segundo gesto só desfaz a baixa: estorno de novo cobraria o provedor à toa.
    const segundo = await refundFinanceEntryCharge({ companyId: LOJA, entryId, desfazerBaixa: true, fetchImpl: asaas.fetchImpl });
    expect(asaas.estornos()).toHaveLength(1);
    expect(segundo.estornadoNoProvedor).toBe(false);
    expect(segundo.baixaDesfeita).toBe(true);
    expect(linhaDoTitulo(entryId).status).toBe('open');
  });

  it('estorno feito no PORTAL: o webhook avisa que a baixa ficou, e o gesto do ERP só a desfaz', async () => {
    const asaas = asaasComEstado();
    const { entryId, ref } = await tituloPago(asaas);

    const aviso = handlePaymentWebhook({
      provider: 'asaas',
      companyId: LOJA,
      token: TOKEN,
      payload: { id: `evt-ref-${ref}`, event: 'PAYMENT_REFUNDED', payment: { id: ref, value: 300 } },
    });
    expect(aviso.detail).toMatch(/Estornar cobrança/);
    expect(intencaoDo(entryId).status).toBe('refunded');
    // A lista da tela sabe que a baixa ficou de pé — é o que desenha o botão.
    expect(listPaymentIntents({ companyId: LOJA })[0].settlementStanding).toBe(true);

    const r = await refundFinanceEntryCharge({ companyId: LOJA, entryId, desfazerBaixa: true, fetchImpl: asaas.fetchImpl });
    expect(asaas.estornos()).toHaveLength(0);
    expect(r.baixaDesfeita).toBe(true);
    expect(linhaDoTitulo(entryId).status).toBe('open');
    expect(listPaymentIntents({ companyId: LOJA })[0].settlementStanding).toBe(false);
  });

  it('o webhook PAYMENT_REFUNDED que chega DEPOIS do estorno do ERP não desfaz nada duas vezes', async () => {
    const asaas = asaasComEstado();
    const { entryId, ref } = await tituloPago(asaas);
    await refundFinanceEntryCharge({ companyId: LOJA, entryId, desfazerBaixa: true, fetchImpl: asaas.fetchImpl });

    const aviso = handlePaymentWebhook({
      provider: 'asaas',
      companyId: LOJA,
      token: TOKEN,
      payload: { id: `evt-ref2-${ref}`, event: 'PAYMENT_REFUNDED', payment: { id: ref, value: 300 } },
    });

    expect(aviso.accepted).toBe(true);
    expect(aviso.detail).toMatch(/já foi desfeita/i);
    expect(baixasDo(entryId)).toHaveLength(2);
    expect(linhaDoTitulo(entryId).status).toBe('open');
  });

  it('o provedor recusa: nada muda no ERP, e a recusa vem com a frase dele', async () => {
    const asaas = asaasComEstado({ recusarEstorno: 'Não é possível estornar cobranças de boleto.' });
    const { entryId } = await tituloPago(asaas);

    await expect(
      refundFinanceEntryCharge({ companyId: LOJA, entryId, desfazerBaixa: true, fetchImpl: asaas.fetchImpl }),
    ).rejects.toMatchObject({ code: 'CORE_CHARGE_REFUND_REFUSED', message: expect.stringContaining('boleto') });

    expect(intencaoDo(entryId).status).toBe('confirmed');
    expect(intencaoDo(entryId).last_error).toContain('boleto');
    expect(linhaDoTitulo(entryId).status).toBe('settled');
    expect(baixasDo(entryId)).toHaveLength(1);
  });

  it('título sem cobrança paga: 409, e o provedor nem é chamado', async () => {
    const asaas = asaasComEstado();
    const entryId = titulo(LOJA);
    await chargeFinanceEntry({ companyId: LOJA, entryId, method: 'pix', fetchImpl: asaas.fetchImpl });

    await expect(
      refundFinanceEntryCharge({ companyId: LOJA, entryId, desfazerBaixa: true, fetchImpl: asaas.fetchImpl }),
    ).rejects.toMatchObject({ code: 'CORE_CHARGE_NOT_REFUNDABLE', status: 409 });
    expect(asaas.estornos()).toHaveLength(0);
  });

  it('título de outra operação: 404, e nada é estornado', async () => {
    const asaas = asaasComEstado();
    const { entryId } = await tituloPago(asaas);

    await expect(
      refundFinanceEntryCharge({ companyId: VIZINHA, entryId, desfazerBaixa: true, fetchImpl: asaas.fetchImpl }),
    ).rejects.toMatchObject({ status: 404 });
    expect(asaas.estornos()).toHaveLength(0);
    expect(intencaoDo(entryId).status).toBe('confirmed');
  });
});

// ============================================================================
describe('GAP-PRD-092 — a rota', () => {
  it('gerente estorna pela rota: 200, provedor chamado, auditoria com quem e por quê', async () => {
    const asaas = asaasComEstado();
    const { entryId } = await tituloPago(asaas);
    vi.stubGlobal('fetch', asaas.fetchImpl);
    const gerente = await entrar(LOJA, 'gerente_loja');

    const res = await request(app)
      .post(`/api/v1/core/finance/entries/${entryId}/charges/refund`)
      .set(gerente)
      .send({ desfazerBaixa: true, motivo: 'devolução do sinal' });

    expect(res.status).toBe(200);
    expect(res.body.estornadoNoProvedor).toBe(true);
    expect(res.body.baixaDesfeita).toBe(true);
    expect(res.body.entry.status).toBe('open');
    const auditoria = getConnection()
      .prepare("SELECT user_id, detail FROM core_audit_log WHERE action = 'finance.charge_refunded' AND entity_id = ?")
      .get(entryId) as { user_id: string; detail: string };
    expect(auditoria.user_id).toBeTruthy();
    expect(JSON.parse(auditoria.detail)).toMatchObject({ baixaDesfeita: true, motivo: 'devolução do sinal' });
  });

  it('confirmação é obrigatória: sem `desfazerBaixa` explícito, 400 e nada acontece', async () => {
    const asaas = asaasComEstado();
    const { entryId } = await tituloPago(asaas);
    vi.stubGlobal('fetch', asaas.fetchImpl);
    const gerente = await entrar(LOJA, 'gerente_loja');

    const res = await request(app).post(`/api/v1/core/finance/entries/${entryId}/charges/refund`).set(gerente).send({});

    expect(res.status).toBe(400);
    expect(asaas.estornos()).toHaveLength(0);
  });

  it('o caixa não estorna: devolver dinheiro é da gerência (403)', async () => {
    const asaas = asaasComEstado();
    const { entryId } = await tituloPago(asaas);
    vi.stubGlobal('fetch', asaas.fetchImpl);
    const caixa = await entrar(LOJA, 'operador_caixa_loja');

    const res = await request(app)
      .post(`/api/v1/core/finance/entries/${entryId}/charges/refund`)
      .set(caixa)
      .send({ desfazerBaixa: true });

    expect(res.status).toBe(403);
    expect(asaas.estornos()).toHaveLength(0);
  });
});
