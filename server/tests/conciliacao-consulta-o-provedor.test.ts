/**
 * ============================================================================
 * A CONCILIAÇÃO PERGUNTA AO PROVEDOR (GAP-PRD-016)
 * ============================================================================
 *
 * O DEFEITO: `reconcileAsaas` só comparava o que o WEBHOOK trouxe. A intenção
 * saía de `pending` só por webhook, e `AsaasHttpClient.getPayment` não tinha
 * nenhum chamador. Webhook perdido (URL errada, 503 sem token, servidor
 * desligado além da janela de reenvio) → dinheiro na conta do Asaas, título em
 * aberto, e a conciliação dizendo "tudo confere". Pior: a cobrança CANCELADA
 * no ERP e paga depois (boleto compensado no dia do cancelamento) tinha o
 * `PAYMENT_RECEIVED` descartado como "notícia velha" — `reconcileAsaas().rows`
 * vazio com dinheiro real na conta.
 *
 * AGORA: a passada de sincronização consulta `GET /payments/:id` das cobranças
 * em aberto e aplica o que o provedor disser pelo MESMO caminho do webhook; o
 * webhook de pagamento sobre cobrança cancelada vira `paid_after_cancel`
 * (dinheiro a regularizar, visível na conciliação); a tela recebe a data da
 * última consulta e o botão "Consultar o provedor agora".
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
import { cancelFinanceEntryCharges, chargeFinanceEntry } from '../src/services/core/FinanceChargeService.js';
import { handlePaymentWebhook } from '../src/services/core/PaymentService.js';
import { reconcileAsaas } from '../src/services/core/AsaasReconciliation.js';
import {
  contarCobrancasAConsultar,
  sincronizarCobrancasComProvedor,
  sincronizarTodasAsOperacoes,
  ultimaSincronizacao,
} from '../src/services/core/AsaasSincronizacao.js';
import { createOrderCharge } from '../src/services/core/OrderChargeService.js';
import { checkout } from '../src/services/core/StorefrontService.js';

process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-key';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-32-chars!!';

const app = createApp();
const LOJA = 'loja-sync';
const VIZINHA = 'vizinha-sync';
const SEM_CHAVE = 'loja-sem-chave';
const TOKEN = 'token-webhook-loja-sync';
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
    description: `Aluguel ${seq}`,
    amountCents,
    dueDate: '2026-09-10',
    customerId: cliente,
  }).id;
}

async function tituloCobrado(companyId: string, asaas: ReturnType<typeof asaasComEstado>, amountCents = 30000) {
  const entryId = titulo(companyId, amountCents);
  const c = await chargeFinanceEntry({ companyId, entryId, method: 'pix', fetchImpl: asaas.fetchImpl });
  return { entryId, ref: String(c.intent.provider_ref), intentId: c.intent.id };
}

function statusDoTitulo(entryId: string): string {
  return (getConnection().prepare('SELECT status FROM core_finance_entries WHERE id = ?').get(entryId) as { status: string }).status;
}

function intencao(id: string): { status: string; last_error: string | null; provider_checked_at: string | null } {
  return getConnection().prepare('SELECT status, last_error, provider_checked_at FROM core_payment_intents WHERE id = ?').get(id) as never;
}

function pedidoCobrado(companyId: string, sufixo: string): string {
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
    .prepare('INSERT INTO core_stock (company_id, product_id, quantity, reserved, updated_at) VALUES (?, ?, 50, 0, ?)')
    .run(companyId, produto, agora);
  seq += 1;
  const cliente = `cli-ped-${seq}`;
  getConnection()
    .prepare(
      `INSERT INTO core_customers (id, company_id, name, document, email, active, created_at, updated_at)
       VALUES (?, ?, 'Comprador', ?, 'comprador@exemplo.com.br', 1, ?, ?)`,
    )
    .run(cliente, companyId, String(11144477735 + seq), agora, agora);
  const [pedido] = checkout({
    idempotencyKey: `ck-${sufixo}`,
    customerName: 'Comprador',
    paymentMethod: 'pix',
    items: [{ productId: produto, quantity: 1 }],
  });
  getConnection()
    .prepare('UPDATE core_orders SET customer_id = ?, customer_document = ?, company_id = ? WHERE id = ?')
    .run(cliente, String(11144477735 + seq), companyId, pedido.id);
  return pedido.id;
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  seq = 0;
  await entrar(LOJA, 'gerente_loja');
  await entrar(VIZINHA, 'gerente_loja');
  await entrar(SEM_CHAVE, 'gerente_loja');
  upsertAsaasApiKey({ companyId: LOJA, environment: 'sandbox', apiKey: '$aact_sandbox_loja_sync_0000000000' });
  upsertAsaasApiKey({ companyId: VIZINHA, environment: 'sandbox', apiKey: '$aact_sandbox_vizinha_sync_111111' });
  upsertAsaasWebhookToken({ companyId: LOJA, webhookToken: TOKEN });
  vi.stubGlobal('fetch', async () => {
    throw new TypeError('rede bloqueada neste teste');
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ============================================================================
describe('GAP-PRD-016 — o webhook perdido não some mais', () => {
  it('pago no provedor SEM webhook: a passada consulta, baixa o título, e a conciliação passa a ver', async () => {
    const asaas = asaasComEstado();
    const { entryId, ref, intentId } = await tituloCobrado(LOJA, asaas);
    asaas.pagar(ref);

    // O retrato do defeito: dinheiro lá, nada aqui, e o relatório calado.
    expect(statusDoTitulo(entryId)).toBe('open');
    expect(reconcileAsaas({ companyId: LOJA }).providerCents).toBe(0);
    expect(contarCobrancasAConsultar(LOJA)).toBe(1);

    const passada = await sincronizarCobrancasComProvedor({ companyId: LOJA, trigger: 'manual', fetchImpl: asaas.fetchImpl });

    expect(asaas.consultas().map((c) => c.url)).toEqual([expect.stringContaining(`/payments/${ref}`)]);
    expect(passada).toMatchObject({ checked: 1, changed: 1, failed: 0, unconfigured: false });
    expect(passada.changes[0]).toMatchObject({ intentId, antes: 'pending', depois: 'confirmed', statusNoProvedor: 'RECEIVED' });
    expect(intencao(intentId).status).toBe('confirmed');
    expect(statusDoTitulo(entryId)).toBe('settled');
    const relatorio = reconcileAsaas({ companyId: LOJA });
    expect(relatorio.providerCents).toBe(30000);
    expect(relatorio.matched).toBe(1);
    expect(relatorio.rows).toEqual([]);
    expect(contarCobrancasAConsultar(LOJA)).toBe(0);
  });

  it('o webhook que chega DEPOIS da passada não baixa de novo', async () => {
    const asaas = asaasComEstado();
    const { entryId, ref } = await tituloCobrado(LOJA, asaas);
    asaas.pagar(ref);
    await sincronizarCobrancasComProvedor({ companyId: LOJA, trigger: 'manual', fetchImpl: asaas.fetchImpl });

    const tardio = handlePaymentWebhook({
      provider: 'asaas',
      companyId: LOJA,
      token: TOKEN,
      payload: { id: `evt-${ref}`, event: 'PAYMENT_RECEIVED', payment: { id: ref, value: 300, billingType: 'PIX' } },
    });

    expect(tardio.detail).toMatch(/já foi baixado/);
    const baixas = getConnection().prepare('SELECT COUNT(*) AS n FROM core_finance_settlements WHERE entry_id = ?').get(entryId) as { n: number };
    expect(baixas.n).toBe(1);
  });

  it('pedido online pago sem webhook vira PAGO na passada', async () => {
    const asaas = asaasComEstado();
    const orderId = pedidoCobrado(LOJA, 'p1');
    const cobranca = await createOrderCharge({ companyId: LOJA, orderId, method: 'pix', fetchImpl: asaas.fetchImpl });
    asaas.pagar(String(cobranca.intent.provider_ref), 'RECEIVED', cobranca.intent.amount_cents / 100);

    await sincronizarCobrancasComProvedor({ companyId: LOJA, trigger: 'automatico', fetchImpl: asaas.fetchImpl });

    const pedido = getConnection().prepare('SELECT status FROM core_orders WHERE id = ?').get(orderId) as { status: string };
    expect(pedido.status).toBe('pago');
  });

  it('vencida lá vira vencida aqui; valor divergente lá vira divergência aqui (sem baixar)', async () => {
    const asaas = asaasComEstado();
    const vencida = await tituloCobrado(LOJA, asaas);
    const aMenos = await tituloCobrado(LOJA, asaas);
    asaas.cobrancas.find((c) => c.id === vencida.ref)!.status = 'OVERDUE';
    asaas.pagar(aMenos.ref, 'RECEIVED', 1);

    const passada = await sincronizarCobrancasComProvedor({ companyId: LOJA, trigger: 'manual', fetchImpl: asaas.fetchImpl });

    expect(passada.changed).toBe(2);
    expect(intencao(vencida.intentId).status).toBe('overdue');
    expect(intencao(aMenos.intentId).status).toBe('amount_mismatch');
    expect(statusDoTitulo(aMenos.entryId)).toBe('open');
    // O dinheiro que entrou diferente APARECE no relatório.
    expect(reconcileAsaas({ companyId: LOJA }).rows.map((r) => r.kind)).toEqual(['cobrado_nao_lancado']);
  });

  it('consulta que falha não muda nada — e a falha fica contada e nomeada', async () => {
    const asaas = asaasComEstado({ consultaFora: true });
    const { intentId, ref } = await tituloCobrado(LOJA, asaas);

    const passada = await sincronizarCobrancasComProvedor({ companyId: LOJA, trigger: 'manual', fetchImpl: asaas.fetchImpl });

    expect(passada).toMatchObject({ checked: 0, changed: 0, failed: 1 });
    expect(passada.errors[0]).toMatchObject({ intentId, providerRef: ref });
    expect(passada.errors[0].error).toMatch(/Falha de conexão/);
    expect(intencao(intentId).status).toBe('pending');
  });

  it('sem credencial: nada é consultado, e a passada DIZ que não consultou', async () => {
    getConnection()
      .prepare(
        `INSERT INTO core_payment_intents (id, company_id, provider, environment, origin_type, origin_id, method,
           amount_cents, status, provider_ref, idempotency_key, created_at, updated_at)
         VALUES ('int-sem', ?, 'asaas', 'sandbox', 'finance_entry', 'x', 'pix', 100, 'pending', 'pay_sem', 'k-sem', ?, ?)`,
      )
      .run(SEM_CHAVE, new Date().toISOString(), new Date().toISOString());
    const asaas = asaasComEstado();

    const passada = await sincronizarCobrancasComProvedor({ companyId: SEM_CHAVE, trigger: 'manual', fetchImpl: asaas.fetchImpl });

    expect(passada.unconfigured).toBe(true);
    expect(passada.skipped).toBe(1);
    expect(asaas.chamadas).toHaveLength(0);
    expect(ultimaSincronizacao(SEM_CHAVE)?.unconfigured).toBe(true);
  });

  it('a passada de uma operação não pergunta pelas cobranças da outra', async () => {
    const daLoja = asaasComEstado({ prefixo: 'LOJA' });
    const daVizinha = asaasComEstado({ prefixo: 'VIZ' });
    await tituloCobrado(LOJA, daLoja);
    const vizinha = await tituloCobrado(VIZINHA, daVizinha);
    daVizinha.pagar(vizinha.ref);

    await sincronizarCobrancasComProvedor({ companyId: LOJA, trigger: 'manual', fetchImpl: daLoja.fetchImpl });

    expect(daLoja.consultas()).toHaveLength(1);
    expect(daLoja.consultas()[0].url).not.toContain(vizinha.ref);
    expect(intencao(vizinha.intentId).status).toBe('pending');
  });

  it('o teto da passada: as mais tempo sem pergunta vão primeiro, e a próxima pega as que sobraram', async () => {
    const asaas = asaasComEstado();
    const a = await tituloCobrado(LOJA, asaas);
    const b = await tituloCobrado(LOJA, asaas);

    const primeira = await sincronizarCobrancasComProvedor({ companyId: LOJA, trigger: 'manual', limite: 1, fetchImpl: asaas.fetchImpl });
    const segunda = await sincronizarCobrancasComProvedor({ companyId: LOJA, trigger: 'manual', limite: 1, fetchImpl: asaas.fetchImpl });

    expect(primeira).toMatchObject({ checked: 1, skipped: 1 });
    expect(segunda).toMatchObject({ checked: 1, skipped: 1 });
    const perguntadas = asaas.consultas().map((c) => c.url.split('/payments/')[1]);
    expect(new Set(perguntadas)).toEqual(new Set([a.ref, b.ref]));
    expect(intencao(a.intentId).provider_checked_at).toBeTruthy();
    expect(intencao(b.intentId).provider_checked_at).toBeTruthy();
  });

  it('a passada automática roda nas operações COM credencial e com cobrança em aberto', async () => {
    const asaas = asaasComEstado();
    const { ref } = await tituloCobrado(LOJA, asaas);
    asaas.pagar(ref);

    const r = await sincronizarTodasAsOperacoes({ fetchImpl: asaas.fetchImpl });

    expect(r).toMatchObject({ operacoes: 1, changed: 1 });
    expect(ultimaSincronizacao(LOJA)?.trigger).toBe('automatico');
  });
});

// ============================================================================
describe('GAP-PRD-016 — pago depois de cancelada no ERP', () => {
  it('o webhook de pagamento sobre cobrança cancelada NÃO é descartado: vira dinheiro a regularizar', async () => {
    const asaas = asaasComEstado();
    const { entryId, ref, intentId } = await tituloCobrado(LOJA, asaas);
    await cancelFinanceEntryCharges({ companyId: LOJA, entryId, fetchImpl: asaas.fetchImpl });
    expect(intencao(intentId).status).toBe('cancelled');

    const r = handlePaymentWebhook({
      provider: 'asaas',
      companyId: LOJA,
      token: TOKEN,
      payload: { id: `evt-pac-${ref}`, event: 'PAYMENT_RECEIVED', payment: { id: ref, value: 300, billingType: 'PIX' } },
    });

    // Antes: "anterior ao estado atual (cancelled) — ignorado" e rows = [].
    expect(r.detail).toMatch(/CANCELADA/);
    expect(intencao(intentId).status).toBe('paid_after_cancel');
    expect(intencao(intentId).last_error).toMatch(/já cancelada/);
    const relatorio = reconcileAsaas({ companyId: LOJA });
    expect(relatorio.rows.map((l) => l.kind)).toEqual(['cobrado_nao_lancado']);
    expect(relatorio.rows[0].providerCents).toBe(30000);
  });

  it('a passada também acha a cancelada que foi paga lá — e não mexe na cancelada que continua apagada', async () => {
    const asaas = asaasComEstado();
    const paga = await tituloCobrado(LOJA, asaas);
    const quieta = await tituloCobrado(LOJA, asaas);
    await cancelFinanceEntryCharges({ companyId: LOJA, entryId: paga.entryId, fetchImpl: asaas.fetchImpl });
    await cancelFinanceEntryCharges({ companyId: LOJA, entryId: quieta.entryId, fetchImpl: asaas.fetchImpl });
    // O boleto compensado no dia do cancelamento: lá ele virou RECEIVED.
    const remota = asaas.pagar(paga.ref);
    remota.deleted = false;

    const passada = await sincronizarCobrancasComProvedor({ companyId: LOJA, trigger: 'manual', fetchImpl: asaas.fetchImpl });

    expect(passada.checked).toBe(2);
    expect(passada.changed).toBe(1);
    expect(intencao(paga.intentId).status).toBe('paid_after_cancel');
    expect(intencao(quieta.intentId).status).toBe('cancelled');
  });

  it('pedido cancelado e depois pago lá: a passada registra o pagamento após o cancelamento, sem ressuscitar o pedido', async () => {
    const asaas = asaasComEstado();
    const orderId = pedidoCobrado(LOJA, 'p2');
    const cobranca = await createOrderCharge({ companyId: LOJA, orderId, method: 'pix', fetchImpl: asaas.fetchImpl });
    const ref = String(cobranca.intent.provider_ref);
    getConnection().prepare("UPDATE core_payment_intents SET status = 'cancelled' WHERE id = ?").run(cobranca.intent.id);
    getConnection().prepare("UPDATE core_orders SET status = 'cancelado' WHERE id = ?").run(orderId);
    asaas.pagar(ref, 'RECEIVED', cobranca.intent.amount_cents / 100);

    await sincronizarCobrancasComProvedor({ companyId: LOJA, trigger: 'manual', fetchImpl: asaas.fetchImpl });

    const pedido = getConnection().prepare('SELECT status FROM core_orders WHERE id = ?').get(orderId) as { status: string };
    expect(pedido.status).toBe('cancelado');
    const aviso = getConnection()
      .prepare("SELECT COUNT(*) AS n FROM core_order_events WHERE order_id = ? AND status = 'pagamento_apos_cancelamento'")
      .get(orderId) as { n: number };
    expect(aviso.n).toBe(1);
  });
});

// ============================================================================
describe('GAP-PRD-016 — a rota e a tela', () => {
  it('gerente aperta "consultar agora": 200 com a passada, auditoria, e a conciliação diz de quando é', async () => {
    const asaas = asaasComEstado();
    const { ref } = await tituloCobrado(LOJA, asaas);
    asaas.pagar(ref);
    vi.stubGlobal('fetch', asaas.fetchImpl);
    const gerente = await entrar(LOJA, 'gerente_loja');

    const antes = await request(app).get('/api/v1/core/asaas/conciliacao').set(gerente);
    expect(antes.body.sincronizacao).toEqual({ last: null, pendingWithRef: 1 });

    const res = await request(app).post('/api/v1/core/asaas/conciliacao/sincronizar').set(gerente).send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ checked: 1, changed: 1, trigger: 'manual' });

    const depois = await request(app).get('/api/v1/core/asaas/conciliacao').set(gerente);
    expect(depois.body.providerCents).toBe(30000);
    expect(depois.body.sincronizacao.pendingWithRef).toBe(0);
    expect(depois.body.sincronizacao.last.id).toBe(res.body.id);

    const auditoria = getConnection()
      .prepare("SELECT detail FROM core_audit_log WHERE action = 'asaas.sync' AND company_id = ?")
      .get(LOJA) as { detail: string };
    expect(JSON.parse(auditoria.detail)).toMatchObject({ checked: 1, changed: 1 });
  });

  it('o caixa não sincroniza: a conciliação é da gerência (403)', async () => {
    const caixa = await entrar(LOJA, 'operador_caixa_loja');
    const res = await request(app).post('/api/v1/core/asaas/conciliacao/sincronizar').set(caixa).send({});
    expect(res.status).toBe(403);
  });
});

// ============================================================================
describe('GAP-PRD-016 — a passada automática liga pelo ambiente', () => {
  it('ASAAS_SYNC_INTERVAL_MINUTES=0 desliga; o padrão liga a cada 30 minutos', async () => {
    const { resetEnvCacheForTests } = await import('../src/config/env.js');
    const { startAsaasSync, stopAsaasSync } = await import('../src/services/core/AsaasSincronizacaoScheduler.js');
    const antes = process.env.ASAAS_SYNC_INTERVAL_MINUTES;
    try {
      process.env.ASAAS_SYNC_INTERVAL_MINUTES = '0';
      resetEnvCacheForTests();
      expect(startAsaasSync()).toBe(0);
      stopAsaasSync();

      delete process.env.ASAAS_SYNC_INTERVAL_MINUTES;
      resetEnvCacheForTests();
      expect(startAsaasSync()).toBe(30);
    } finally {
      stopAsaasSync();
      if (antes === undefined) delete process.env.ASAAS_SYNC_INTERVAL_MINUTES;
      else process.env.ASAAS_SYNC_INTERVAL_MINUTES = antes;
      resetEnvCacheForTests();
    }
  });
});
