/**
 * ============================================================================
 * CANCELAR, ESTORNAR E MOSTRAR COMPROVANTE SÓ COM O QUE ACONTECEU DE FATO
 * (GAP-PRD-079 e GAP-PRD-162)
 * ============================================================================
 *
 * ## GAP-PRD-079 — o estado gravado pela ausência de resposta
 *
 * `POST /payment-terminals/transactions/:id/cancel` fazia
 * `status: result.status ?? 'cancelled'`. Para provedor real o adaptador
 * responde `{ ok: false, pending: true }` SEM status — e o `??` transformava
 * "o provedor não fez nada" em `cancelled`. O estorno, idem, em `refunded`. E
 * nenhum dos dois olhava `saleId`: a cobrança que pagou uma venda podia ser
 * "estornada" sem a venda saber.
 *
 * ## GAP-PRD-162 — comprovante fabricado
 *
 * `GET /transactions/:id/receipt` e `POST /transactions/:id/reprint`
 * respondiam 200 com um objeto montado na hora — sem consultar nada, sem
 * texto de comprovante, sem conferir empresa, e até para id inexistente.
 *
 * ## O que estes casos cobram
 *
 * - O estado só muda com confirmação do provedor; "pendente" é 409 e a
 *   transação fica como estava (a tentativa fica registrada).
 * - Cobrança amarrada a venda não se cancela por aqui: 409 dizendo qual venda
 *   tratar.
 * - Estado de origem é conferido (não se estorna o que foi recusado).
 * - Id de outra empresa, ou inexistente, é 404 nas quatro rotas.
 * - O comprovante é o texto que a adquirente devolveu na cobrança, guardado;
 *   sem comprovante guardado a resposta diz isso, em vez de inventar um. A
 *   reimpressão devolve o MESMO texto e conta quantas vezes saiu.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';

process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_JWT_SECRET = 'estorno-e-comprovante-jwt-secret-bem-comprido';
process.env.DEVORA_ENCRYPTION_KEY = 'estorno-e-comprovante-chave-de-cifra-bem-comprida';

const { createApp } = await import('../src/app.js');
const { resetEnvCacheForTests } = await import('../src/config/env.js');
const { resetDbForTests, insertRow, findOneRow, findRows } = await import('../src/db/database.js');
// Sessão da conta que EXISTE: authMiddleware confere a conta a cada requisição (GAP-PRD-053).
const { issueSession } = await import('./helpers/sessao.js');
const { createAndProcessPaymentTerminalTransactionBackend } = await import(
  '../src/services/payment-terminal/PaymentTerminalService.js'
);
const { listAudit } = await import('../src/services/audit/AuditService.js');

const app = createApp();
const LOJA = 'company-estorno-loja';
const VIZINHA = 'company-estorno-vizinha';

function auth(companyId: string) {
  const s = issueSession({
    userId: '550e8400-e29b-41d4-a716-446655440077',
    companyId,
    storeId: 'store-estorno',
    profileCodes: ['admin_geral'],
  });
  return { Authorization: `Bearer ${s.accessToken}` };
}

function emAmbiente(apiEnv: 'test' | 'production') {
  process.env.DEVORA_API_ENV = apiEnv;
  resetEnvCacheForTests();
}

function tx(id: string) {
  return findOneRow<Record<string, unknown>>('payment_terminal_transactions', (r) => r.id === id);
}

/** Cobrança aprovada de verdade pelo fluxo (mock, em teste) — com comprovante. */
async function cobrancaAprovada(companyId = LOJA, amountInCents = 10_000) {
  return (await createAndProcessPaymentTerminalTransactionBackend({
    companyId,
    provider: 'mock',
    paymentMethod: 'credit',
    amountInCents,
    installments: 1,
    idempotencyKey: randomUUID(),
  })) as Record<string, unknown>;
}

/** Transação de provedor REAL (o adaptador dele ainda é estrutural). */
function transacaoStone(status: string, extra: Record<string, unknown> = {}) {
  const id = `pttx-stone-${randomUUID()}`;
  insertRow('payment_terminal_transactions', {
    id,
    companyId: LOJA,
    provider: 'stone',
    paymentMethod: 'credit',
    amountInCents: 8_000,
    status,
    idempotencyKey: randomUUID(),
    ...extra,
  });
  return id;
}

beforeEach(() => {
  emAmbiente('test');
  resetDbForTests();
});

afterEach(() => emAmbiente('test'));

describe('GAP-PRD-079 — cancelar/estornar só com a confirmação do provedor', () => {
  it('provedor real sem resposta: cancelar é 409, e a transação continua como estava', async () => {
    const id = transacaoStone('authorized');
    const res = await request(app)
      .post(`/api/v1/payment-terminals/transactions/${id}/cancel`)
      .set(auth(LOJA))
      .send({ reason: 'cliente desistiu' });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe('PAYMENT_TERMINAL_PROVIDER_PENDING');
    expect(tx(id)?.status).toBe('authorized');
    expect(tx(id)?.cancelledAt).toBeUndefined();

    // A tentativa fica registrada, com o que o provedor respondeu.
    const tentativas = findRows('payment_terminal_cancellations', (r) => r.transactionId === id);
    expect(tentativas).toHaveLength(1);
    expect(tentativas[0]).toMatchObject({ companyId: LOJA, outcome: 'pending_provider' });
  });

  it('provedor real sem resposta: estornar é 409, e nada vira "refunded"', async () => {
    const id = transacaoStone('authorized');
    const res = await request(app)
      .post(`/api/v1/payment-terminals/transactions/${id}/refund`)
      .set(auth(LOJA))
      .send({ reason: 'devolução', amountInCents: 8_000 });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe('PAYMENT_TERMINAL_PROVIDER_PENDING');
    expect(tx(id)?.status).toBe('authorized');
    expect(tx(id)?.refundedAt).toBeUndefined();
    expect(findRows('payment_terminal_refunds', (r) => r.transactionId === id)[0]).toMatchObject({
      outcome: 'pending_provider',
    });
  });

  it('o caso exato da auditoria: transação stone "failed" não vira "cancelled" nem "refunded"', async () => {
    const id = transacaoStone('failed');
    const cancel = await request(app)
      .post(`/api/v1/payment-terminals/transactions/${id}/cancel`)
      .set(auth(LOJA))
      .send({ reason: 'x' });
    expect(cancel.status).toBe(409);
    const refund = await request(app)
      .post(`/api/v1/payment-terminals/transactions/${id}/refund`)
      .set(auth(LOJA))
      .send({ reason: 'x' });
    expect(refund.status).toBe(409);
    expect(tx(id)?.status).toBe('failed');
  });

  it('cobrança amarrada a venda: recusa e diz qual venda tratar', async () => {
    const aprovada = await cobrancaAprovada();
    const { updateRows } = await import('../src/db/database.js');
    updateRows('payment_terminal_transactions', (r) => r.id === aprovada.id, (r) => ({
      ...r,
      saleId: 'sale-42',
      saleNumber: 42,
    }));

    for (const acao of ['cancel', 'refund'] as const) {
      const res = await request(app)
        .post(`/api/v1/payment-terminals/transactions/${aprovada.id}/${acao}`)
        .set(auth(LOJA))
        .send({ reason: 'tentativa' });
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.error.code).toBe('PAYMENT_TERMINAL_TRANSACTION_BOUND_TO_SALE');
      expect(res.body.error.message).toMatch(/42/);
    }
    expect(tx(String(aprovada.id))?.status).toBe('authorized');
  });

  it('mock em teste, cobrança sem venda: cancelar confirma, registra e audita', async () => {
    const aprovada = await cobrancaAprovada();
    const res = await request(app)
      .post(`/api/v1/payment-terminals/transactions/${aprovada.id}/cancel`)
      .set(auth(LOJA))
      .send({ reason: 'cliente desistiu antes de fechar a venda' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe('cancelled');
    expect(res.body.cancelledAt).toBeTruthy();
    expect(res.body.simulated).toBe(true);
    expect(
      findRows('payment_terminal_cancellations', (r) => r.transactionId === aprovada.id)[0],
    ).toMatchObject({ outcome: 'confirmed', reason: 'cliente desistiu antes de fechar a venda' });
    const trilha = listAudit(LOJA, { limit: 10 }).items as unknown as Record<string, unknown>[];
    expect(trilha.some((a) => a.action === 'payment_terminal.transaction.cancelled')).toBe(true);

    // Cancelada não se cancela de novo nem se estorna.
    const denovo = await request(app)
      .post(`/api/v1/payment-terminals/transactions/${aprovada.id}/refund`)
      .set(auth(LOJA))
      .send({ reason: 'x' });
    expect(denovo.status).toBe(409);
    expect(denovo.body.error.code).toBe('PAYMENT_TERMINAL_TRANSACTION_STATE_INVALID');
  });

  it('estorno parcial e depois o resto: parcial primeiro, estornado no fim, nunca acima do valor', async () => {
    const aprovada = await cobrancaAprovada(LOJA, 10_000);
    const parcial = await request(app)
      .post(`/api/v1/payment-terminals/transactions/${aprovada.id}/refund`)
      .set(auth(LOJA))
      .send({ reason: 'devolveu uma peça', amountInCents: 4_000 });
    expect(parcial.status, JSON.stringify(parcial.body)).toBe(200);
    expect(parcial.body.status).toBe('partially_refunded');
    expect(parcial.body.refundedAmountInCents).toBe(4_000);

    const demais = await request(app)
      .post(`/api/v1/payment-terminals/transactions/${aprovada.id}/refund`)
      .set(auth(LOJA))
      .send({ reason: 'acima do que sobrou', amountInCents: 7_000 });
    expect(demais.status).toBe(400);
    expect(demais.body.error.code).toBe('PAYMENT_TERMINAL_REFUND_AMOUNT_INVALID');

    const resto = await request(app)
      .post(`/api/v1/payment-terminals/transactions/${aprovada.id}/refund`)
      .set(auth(LOJA))
      .send({ reason: 'devolveu o resto' });
    expect(resto.status, JSON.stringify(resto.body)).toBe(200);
    expect(resto.body.status).toBe('refunded');
    expect(resto.body.refundedAmountInCents).toBe(10_000);
  });

  it('não se cancela nem se estorna o que a operadora recusou', async () => {
    const recusada = (await createAndProcessPaymentTerminalTransactionBackend({
      companyId: LOJA,
      provider: 'mock',
      paymentMethod: 'credit',
      amountInCents: 5_000,
      scenario: 'decline',
      idempotencyKey: randomUUID(),
    })) as Record<string, unknown>;
    const res = await request(app)
      .post(`/api/v1/payment-terminals/transactions/${recusada.id}/cancel`)
      .set(auth(LOJA))
      .send({ reason: 'x' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PAYMENT_TERMINAL_TRANSACTION_STATE_INVALID');
    expect(tx(String(recusada.id))?.status).toBe('declined');
  });

  it('transação de outra empresa é 404 — e continua intacta', async () => {
    const daVizinha = await cobrancaAprovada(VIZINHA);
    for (const acao of ['cancel', 'refund'] as const) {
      const res = await request(app)
        .post(`/api/v1/payment-terminals/transactions/${daVizinha.id}/${acao}`)
        .set(auth(LOJA))
        .send({ reason: 'x' });
      expect(res.status).toBe(404);
    }
    expect(tx(String(daVizinha.id))?.status).toBe('authorized');
  });

  it('cancelar cobrança mock em produção cai na trava do mock', async () => {
    const aprovada = await cobrancaAprovada();
    emAmbiente('production');
    const res = await request(app)
      .post(`/api/v1/payment-terminals/transactions/${aprovada.id}/cancel`)
      .set(auth(LOJA))
      .send({ reason: 'x' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PAYMENT_TERMINAL_MOCK_IN_PRODUCTION');
    expect(tx(String(aprovada.id))?.status).toBe('authorized');
  });
});

describe('GAP-PRD-162 — comprovante e reimpressão reais', () => {
  it('id inexistente é 404 nas duas rotas', async () => {
    const recibo = await request(app)
      .get('/api/v1/payment-terminals/transactions/nao-existe/receipt')
      .set(auth(LOJA));
    expect(recibo.status).toBe(404);
    expect(recibo.body.error.code).toBe('PAYMENT_TERMINAL_TRANSACTION_NOT_FOUND');
    const reimp = await request(app)
      .post('/api/v1/payment-terminals/transactions/nao-existe/reprint')
      .set(auth(LOJA));
    expect(reimp.status).toBe(404);
  });

  it('transação de outra empresa é 404 — o comprovante tem cartão e valor', async () => {
    const daVizinha = await cobrancaAprovada(VIZINHA);
    const res = await request(app)
      .get(`/api/v1/payment-terminals/transactions/${daVizinha.id}/receipt`)
      .set(auth(LOJA));
    expect(res.status).toBe(404);
  });

  it('o comprovante é o texto que a adquirente devolveu, guardado na cobrança', async () => {
    const aprovada = await cobrancaAprovada(LOJA, 12_345);
    const res = await request(app)
      .get(`/api/v1/payment-terminals/transactions/${aprovada.id}/receipt`)
      .set(auth(LOJA));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.transactionId).toBe(aprovada.id);
    expect(res.body.receiptType).toBe('merchant');
    expect(res.body.receiptText).toMatch(/123,45|123\.45/);
    expect(res.body.simulated).toBe(true);
    expect(res.body.reprintCount).toBe(0);
    const guardado = findRows('payment_terminal_receipts', (r) => r.transactionId === aprovada.id);
    expect(guardado.length).toBeGreaterThan(0);

    const cliente = await request(app)
      .get(`/api/v1/payment-terminals/transactions/${aprovada.id}/receipt?via=customer`)
      .set(auth(LOJA));
    expect(cliente.status).toBe(200);
    expect(cliente.body.receiptType).toBe('customer');
  });

  it('sem comprovante guardado (cobrança recusada, linha antiga), diz isso em vez de inventar', async () => {
    const id = transacaoStone('failed');
    const res = await request(app)
      .get(`/api/v1/payment-terminals/transactions/${id}/receipt`)
      .set(auth(LOJA));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('PAYMENT_TERMINAL_RECEIPT_NOT_AVAILABLE');
    const reimp = await request(app)
      .post(`/api/v1/payment-terminals/transactions/${id}/reprint`)
      .set(auth(LOJA));
    expect(reimp.status).toBe(404);
    expect(reimp.body.error.code).toBe('PAYMENT_TERMINAL_RECEIPT_NOT_AVAILABLE');
  });

  it('a reimpressão devolve o MESMO texto, conta as vias e fica no histórico', async () => {
    const aprovada = await cobrancaAprovada();
    const original = await request(app)
      .get(`/api/v1/payment-terminals/transactions/${aprovada.id}/receipt`)
      .set(auth(LOJA));
    const r1 = await request(app)
      .post(`/api/v1/payment-terminals/transactions/${aprovada.id}/reprint`)
      .set(auth(LOJA));
    const r2 = await request(app)
      .post(`/api/v1/payment-terminals/transactions/${aprovada.id}/reprint`)
      .set(auth(LOJA));
    expect(r1.status, JSON.stringify(r1.body)).toBe(200);
    expect(r1.body.receiptText).toBe(original.body.receiptText);
    expect(r1.body.reprint).toBe(true);
    expect(r1.body.newTransaction).toBe(false);
    expect(r1.body.reprintCount).toBe(1);
    expect(r2.body.reprintCount).toBe(2);
    const historico = findRows(
      'payment_terminal_history',
      (r) => r.transactionId === aprovada.id && r.action === 'receipt_reprinted',
    );
    expect(historico).toHaveLength(2);
  });
});
