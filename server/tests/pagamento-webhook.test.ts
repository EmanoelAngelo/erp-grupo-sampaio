/**
 * Webhook de pagamento — o único caminho que torna um pedido pago.
 *
 * Três coisas não podem falhar aqui, e cada uma já quebrou um ERP:
 *
 * 1. O mesmo evento chegando dez vezes tem UM efeito. O provedor reenvia
 *    quando não recebe 200 rápido o bastante.
 * 2. Evento atrasado não desfaz o estado atual. A internet não garante ordem:
 *    um "pendente" de dois minutos atrás pode chegar depois do "recebido".
 * 3. Token de uma operação não confirma cobrança de outra. O token prova quem
 *    chamou, não sobre o que pode agir.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import { upsertAsaasWebhookToken } from '../src/services/integrations/AsaasCredentialService.js';
import { createPaymentIntent, handlePaymentWebhook } from '../src/services/core/PaymentService.js';
import { checkout } from '../src/services/core/StorefrontService.js';

const TOKEN_GRINGA = 'token-webhook-da-gringa';
const TOKEN_PRECO_JUSTO = 'token-webhook-do-preco-justo';

let gringa: string;
let precoJusto: string;
let n = 0;

function produtoPublicado(companyId: string, id: string): string {
  n += 1;
  const agora = new Date().toISOString();
  getConnection()
    .prepare(
      `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                  price_cents, active, publish_online, created_at, updated_at)
       VALUES (?, ?, ?, 'Produto online', 'UN', 5000, 10000, 1, 1, ?, ?)`,
    )
    .run(id, companyId, `ON-${n}`, agora, agora);
  getConnection()
    .prepare(
      'INSERT INTO core_stock (company_id, product_id, quantity, reserved, updated_at) VALUES (?, ?, 50, 0, ?)',
    )
    .run(companyId, id, agora);
  return id;
}

/** Pedido online com cobrança criada — sem credencial, fica `unconfigured`. */
async function pedidoComCobranca(companyId: string, sufixo: string) {
  const produto = produtoPublicado(companyId, `prod-${sufixo}`);
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
  });

  // Sem provedor real não há `provider_ref`; o webhook casa por ele, então a
  // referência é gravada aqui para poder exercitar o caminho.
  getConnection()
    .prepare('UPDATE core_payment_intents SET provider_ref = ? WHERE id = ?')
    .run(`pay_${sufixo}`, intent.id);

  return { orderId: pedido.id, intentId: intent.id, providerRef: `pay_${sufixo}` };
}

function evento(input: {
  id: string;
  event: string;
  providerRef: string;
}): Record<string, unknown> {
  return { id: input.id, event: input.event, payment: { id: input.providerRef } };
}

function intentStatus(id: string): string {
  return (
    getConnection().prepare('SELECT status FROM core_payment_intents WHERE id = ?').get(id) as {
      status: string;
    }
  ).status;
}

function pedidoStatus(id: string): string {
  return (
    getConnection().prepare('SELECT status FROM core_orders WHERE id = ?').get(id) as {
      status: string;
    }
  ).status;
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  n = 0;
  gringa = await upsertCompany({ slug: 'gringa', tradeName: 'Gringa', legalName: 'Gringa Ltda' });
  precoJusto = await upsertCompany({
    slug: 'preco-justo',
    tradeName: 'Preço Justo',
    legalName: 'Preço Justo Ltda',
  });
  upsertAsaasWebhookToken({ companyId: gringa, webhookToken: TOKEN_GRINGA });
  upsertAsaasWebhookToken({ companyId: precoJusto, webhookToken: TOKEN_PRECO_JUSTO });
});

describe('token por operação', () => {
  it('token errado é recusado', async () => {
    await pedidoComCobranca(gringa, 'a');

    expect(() =>
      handlePaymentWebhook({
        provider: 'asaas',
        companyId: gringa,
        token: 'token-inventado',
        payload: evento({ id: 'ev-1', event: 'PAYMENT_CONFIRMED', providerRef: 'pay_a' }),
      }),
    ).toThrow(expect.objectContaining({ code: 'API_WEBHOOK_UNAUTHORIZED' }));
  });

  it('o token de uma operação não vale na outra', async () => {
    await pedidoComCobranca(gringa, 'b');

    expect(() =>
      handlePaymentWebhook({
        provider: 'asaas',
        companyId: gringa,
        token: TOKEN_PRECO_JUSTO,
        payload: evento({ id: 'ev-2', event: 'PAYMENT_CONFIRMED', providerRef: 'pay_b' }),
      }),
    ).toThrow(expect.objectContaining({ code: 'API_WEBHOOK_UNAUTHORIZED' }));
  });

  it('token válido confirma o pedido', async () => {
    const { orderId, intentId } = await pedidoComCobranca(gringa, 'c');

    const r = handlePaymentWebhook({
      provider: 'asaas',
      companyId: gringa,
      token: TOKEN_GRINGA,
      payload: evento({ id: 'ev-3', event: 'PAYMENT_CONFIRMED', providerRef: 'pay_c' }),
    });

    expect(r.accepted).toBe(true);
    expect(intentStatus(intentId)).toBe('confirmed');
    expect(pedidoStatus(orderId)).toBe('pago');
  });

  it('cobrança de outra operação é recusada mesmo com token válido', async () => {
    await pedidoComCobranca(precoJusto, 'd');

    expect(() =>
      handlePaymentWebhook({
        provider: 'asaas',
        companyId: gringa,
        token: TOKEN_GRINGA,
        payload: evento({ id: 'ev-4', event: 'PAYMENT_CONFIRMED', providerRef: 'pay_d' }),
      }),
    ).toThrow(expect.objectContaining({ code: 'API_WEBHOOK_TENANT_MISMATCH' }));
  });
});

/**
 * Operação que ainda NÃO salvou o token.
 *
 * É o estado de toda operação recém-cadastrada: o painel do Asaas já pode
 * estar apontando para cá antes de alguém abrir a tela e colar o token. E
 * `ASAAS_WEBHOOK_AUTH_TOKEN` vem vazio no `.env.example`, então não há token de
 * ambiente para cobrir o intervalo.
 *
 * Sem token configurado não existe quem provar; então ninguém prova. O que não
 * pode acontecer é a ausência de token virar dispensa de token — isso deixaria
 * o único caminho que marca pedido como pago aberto para qualquer chamada.
 */
describe('operação sem token configurado', () => {
  it('recusa em vez de dispensar a conferência', async () => {
    const semToken = await upsertCompany({
      slug: 'sem-token',
      tradeName: 'Sem Token',
      legalName: 'Sem Token Ltda',
    });
    const { orderId, intentId } = await pedidoComCobranca(semToken, 'z');

    expect(() =>
      handlePaymentWebhook({
        provider: 'asaas',
        companyId: semToken,
        token: undefined,
        payload: evento({ id: 'ev-z', event: 'PAYMENT_CONFIRMED', providerRef: 'pay_z' }),
      }),
    ).toThrow(expect.objectContaining({ code: 'API_WEBHOOK_UNCONFIGURED' }));

    // O que a recusa protege: o pedido continua não-pago.
    expect(intentStatus(intentId)).not.toBe('confirmed');
    expect(pedidoStatus(orderId)).not.toBe('pago');
  });

  it('adivinhar o token também não passa', async () => {
    const semToken = await upsertCompany({
      slug: 'sem-token-2',
      tradeName: 'Sem Token 2',
      legalName: 'Sem Token 2 Ltda',
    });
    const { orderId } = await pedidoComCobranca(semToken, 'y');

    expect(() =>
      handlePaymentWebhook({
        provider: 'asaas',
        companyId: semToken,
        token: 'qualquer-coisa',
        payload: evento({ id: 'ev-y', event: 'PAYMENT_CONFIRMED', providerRef: 'pay_y' }),
      }),
    ).toThrow(expect.objectContaining({ code: 'API_WEBHOOK_UNCONFIGURED' }));

    expect(pedidoStatus(orderId)).not.toBe('pago');
  });
});

describe('idempotência', () => {
  it('o mesmo evento dez vezes tem um efeito', async () => {
    const { orderId, intentId } = await pedidoComCobranca(gringa, 'e');
    const payload = evento({ id: 'ev-5', event: 'PAYMENT_CONFIRMED', providerRef: 'pay_e' });

    const resultados = Array.from({ length: 10 }, () =>
      handlePaymentWebhook({ provider: 'asaas', companyId: gringa, token: TOKEN_GRINGA, payload }),
    );

    expect(resultados[0].duplicated).toBe(false);
    expect(resultados.slice(1).every((r) => r.duplicated)).toBe(true);
    expect(intentStatus(intentId)).toBe('confirmed');
    expect(pedidoStatus(orderId)).toBe('pago');

    // Um registro de recebimento por evento, não dez.
    const recebidos = getConnection()
      .prepare('SELECT COUNT(*) c FROM core_payment_webhooks WHERE event_id = ?')
      .get('ev-5') as { c: number };
    expect(recebidos.c).toBe(1);
  });
});

describe('evento fora de ordem', () => {
  it('um "pendente" atrasado não desfaz o pagamento', async () => {
    const { orderId, intentId } = await pedidoComCobranca(gringa, 'f');
    handlePaymentWebhook({
      provider: 'asaas',
      companyId: gringa,
      token: TOKEN_GRINGA,
      payload: evento({ id: 'ev-6', event: 'PAYMENT_CONFIRMED', providerRef: 'pay_f' }),
    });

    const atrasado = handlePaymentWebhook({
      provider: 'asaas',
      companyId: gringa,
      token: TOKEN_GRINGA,
      payload: evento({ id: 'ev-7', event: 'PAYMENT_CREATED', providerRef: 'pay_f' }),
    });

    expect(atrasado.detail).toContain('ignorado');
    expect(intentStatus(intentId)).toBe('confirmed');
    expect(pedidoStatus(orderId)).toBe('pago');
  });

  it('vencimento atrasado também não desfaz o pagamento', async () => {
    const { intentId } = await pedidoComCobranca(gringa, 'g');
    handlePaymentWebhook({
      provider: 'asaas',
      companyId: gringa,
      token: TOKEN_GRINGA,
      payload: evento({ id: 'ev-8', event: 'PAYMENT_CONFIRMED', providerRef: 'pay_g' }),
    });

    handlePaymentWebhook({
      provider: 'asaas',
      companyId: gringa,
      token: TOKEN_GRINGA,
      payload: evento({ id: 'ev-9', event: 'PAYMENT_OVERDUE', providerRef: 'pay_g' }),
    });

    expect(intentStatus(intentId)).toBe('confirmed');
  });

  it('estorno ANDA PARA TRÁS de propósito — é fato novo, não notícia velha', async () => {
    const { orderId, intentId } = await pedidoComCobranca(gringa, 'h');
    handlePaymentWebhook({
      provider: 'asaas',
      companyId: gringa,
      token: TOKEN_GRINGA,
      payload: evento({ id: 'ev-10', event: 'PAYMENT_CONFIRMED', providerRef: 'pay_h' }),
    });

    const estorno = handlePaymentWebhook({
      provider: 'asaas',
      companyId: gringa,
      token: TOKEN_GRINGA,
      payload: evento({ id: 'ev-11', event: 'PAYMENT_REFUNDED', providerRef: 'pay_h' }),
    });

    expect(estorno.detail).toContain('refunded');
    expect(intentStatus(intentId)).toBe('refunded');
    // O pedido sai de "pago": deixá-lo pago faria a expedição separar
    // mercadoria de um pedido desfeito.
    expect(pedidoStatus(orderId)).toBe('reembolsado');
    const eventos = getConnection()
      .prepare('SELECT status FROM core_order_events WHERE order_id = ?')
      .all(orderId) as { status: string }[];
    expect(eventos.map((e) => e.status)).toContain('reembolsado');
  });
});

describe('evento desconhecido', () => {
  it('fica registrado e sem efeito — não se inventa equivalência', async () => {
    const { intentId } = await pedidoComCobranca(gringa, 'i');

    const r = handlePaymentWebhook({
      provider: 'asaas',
      companyId: gringa,
      token: TOKEN_GRINGA,
      payload: evento({ id: 'ev-12', event: 'PAYMENT_ANTECIPADO_SEI_LA', providerRef: 'pay_i' }),
    });

    expect(r.accepted).toBe(true);
    expect(r.detail).toContain('sem efeito');
    expect(intentStatus(intentId)).not.toBe('confirmed');

    const guardado = getConnection()
      .prepare('SELECT COUNT(*) c FROM core_payment_webhooks WHERE event_id = ?')
      .get('ev-12') as { c: number };
    expect(guardado.c).toBe(1);
  });
});

describe('falha no meio do processamento (rodada 34)', () => {
  /*
    O DEFEITO MEDIDO: o evento era gravado em core_payment_webhooks ANTES de
    ser processado, fora de transação. Se `markOrderPaid` falhasse — banco
    ocupado, disco cheio, qualquer exceção —, a linha ficava lá com
    processed = 0, e a PRÓXIMA entrega do provedor recebia "Evento já
    recebido" e era descartada. O cliente pagou; o pedido nunca virou pago;
    e nenhuma tentativa seguinte conseguia consertar.

    A tabela sempre teve `processed` e `error` — o desenho previa retomar.
    A implementação não retomava.
  */
  it('um evento que falhou no meio é RETOMADO na próxima entrega, não descartado', async () => {
    const { orderId, intentId, providerRef } = await pedidoComCobranca(gringa, 'retoma');
    const payload = evento({ id: 'evt-retoma', event: 'PAYMENT_CONFIRMED', providerRef });

    // Simula a falha: a linha do webhook existe, não processada, com erro.
    // É exatamente o estado que o processamento interrompido deixava.
    getConnection()
      .prepare(
        `INSERT INTO core_payment_webhooks
           (id, provider, event_id, event_type, payload, processed, error, received_at)
         VALUES ('wh-travado', 'asaas', 'evt-retoma', 'PAYMENT_CONFIRMED', ?, 0, 'SQLITE_BUSY: database is locked', ?)`,
      )
      .run(JSON.stringify(payload), new Date().toISOString());
    expect(pedidoStatus(orderId)).toBe('aguardando_pagamento');

    // O provedor reenvia. Antes: "Evento já recebido" e nada acontece.
    const segunda = handlePaymentWebhook({
      provider: 'asaas',
      companyId: gringa,
      token: TOKEN_GRINGA,
      payload,
    });

    expect(segunda.duplicated).toBe(false);
    expect(pedidoStatus(orderId)).toBe('pago');
    expect(intentStatus(intentId)).toBe('confirmed');

    const linha = getConnection()
      .prepare('SELECT processed, error FROM core_payment_webhooks WHERE event_id = ?')
      .get('evt-retoma') as { processed: number; error: string | null };
    expect(linha.processed).toBe(1);
    expect(linha.error).toBeNull();
  });

  it('um evento JÁ PROCESSADO continua sendo descartado como duplicado', async () => {
    const { orderId, providerRef } = await pedidoComCobranca(gringa, 'dup');
    const payload = evento({ id: 'evt-dup', event: 'PAYMENT_CONFIRMED', providerRef });

    const primeira = handlePaymentWebhook({ provider: 'asaas', companyId: gringa, token: TOKEN_GRINGA, payload });
    expect(primeira.duplicated).toBe(false);
    expect(pedidoStatus(orderId)).toBe('pago');

    const segunda = handlePaymentWebhook({ provider: 'asaas', companyId: gringa, token: TOKEN_GRINGA, payload });
    expect(segunda.duplicated).toBe(true);
  });

  it('quando o processamento falha, o erro fica gravado na linha e a resposta não é 200', async () => {
    const { providerRef } = await pedidoComCobranca(gringa, 'falha');
    const payload = evento({ id: 'evt-falha', event: 'PAYMENT_CONFIRMED', providerRef });

    // Força a falha no meio: a tabela de pedidos some da frente do UPDATE.
    // É grosseiro de propósito — o que se prova é o REGISTRO da falha, não
    // a causa. Depois o teste restaura.
    const db = getConnection();
    db.exec('ALTER TABLE core_orders RENAME TO core_orders__sumiu');
    let erro: unknown = null;
    try {
      handlePaymentWebhook({ provider: 'asaas', companyId: gringa, token: TOKEN_GRINGA, payload });
    } catch (err) {
      erro = err;
    } finally {
      db.exec('ALTER TABLE core_orders__sumiu RENAME TO core_orders');
    }

    // A falha não pode ser engolida: o provedor só reenvia se NÃO receber 2xx.
    expect(erro).not.toBeNull();

    const linha = db
      .prepare('SELECT processed, error FROM core_payment_webhooks WHERE event_id = ?')
      .get('evt-falha') as { processed: number; error: string | null } | undefined;
    expect(linha).toBeDefined();
    expect(linha!.processed).toBe(0);
    expect(linha!.error ?? '').not.toBe('');
  });
});

// ============================================================================

describe('a rota legada, sem empresa na URL', () => {
  /**
   * O ATALHO QUE ATRAVESSAVA AS SEIS.
   *
   * Existem duas rotas de webhook: `/webhooks/payments/:provider/:companyId` e
   * `/webhooks/payments/:provider`. A segunda é a legada — o Asaas de uma
   * instalação antiga ainda aponta para ela.
   *
   * Sem `companyId`, o handler comparava o token com o do AMBIENTE, e a
   * conferência de tenant era curto-circuitada por `input.companyId && ...`.
   * Quem tivesse o token do `.env` marcava como pago o pedido de QUALQUER uma
   * das seis operações.
   *
   * A saída não é adivinhar a empresa: é PERGUNTAR AO TOKEN.
   * `findCompanyByAsaasWebhookToken` já existia — escrita, testada e sem
   * chamador — e faz exatamente isso: conhecer o token prova de quem é o
   * evento, que é para isso que ele serve.
   */
  it('o token da Gringa, sem empresa na URL, confirma o pedido DA GRINGA', async () => {
    const daGringa = await pedidoComCobranca(gringa, 'legada-1');

    const r = handlePaymentWebhook({
      provider: 'asaas',
      token: TOKEN_GRINGA,
      payload: evento({ id: 'ev-legada-1', event: 'PAYMENT_RECEIVED', providerRef: daGringa.providerRef }),
    });

    expect(r.accepted).toBe(true);
    expect(pedidoStatus(daGringa.orderId)).toBe('pago');
  });

  it('e NÃO confirma o pedido da vizinha', async () => {
    const doPrecoJusto = await pedidoComCobranca(precoJusto, 'legada-2');

    expect(() =>
      handlePaymentWebhook({
        provider: 'asaas',
        token: TOKEN_GRINGA,
        payload: evento({
          id: 'ev-legada-2',
          event: 'PAYMENT_RECEIVED',
          providerRef: doPrecoJusto.providerRef,
        }),
      }),
    ).toThrow(/outra operação/i);

    expect(pedidoStatus(doPrecoJusto.orderId)).toBe('aguardando_pagamento');
  });

  it('token que não é de ninguém é recusado', async () => {
    const daGringa = await pedidoComCobranca(gringa, 'legada-3');

    expect(() =>
      handlePaymentWebhook({
        provider: 'asaas',
        token: 'token-que-nao-existe',
        payload: evento({
          id: 'ev-legada-3',
          event: 'PAYMENT_RECEIVED',
          providerRef: daGringa.providerRef,
        }),
      }),
    ).toThrow();

    expect(pedidoStatus(daGringa.orderId)).toBe('aguardando_pagamento');
  });

  it('e o token do Preço Justo confirma o dele — a recusa é do dono, não da rota', async () => {
    const doPrecoJusto = await pedidoComCobranca(precoJusto, 'legada-4');

    const r = handlePaymentWebhook({
      provider: 'asaas',
      token: TOKEN_PRECO_JUSTO,
      payload: evento({
        id: 'ev-legada-4',
        event: 'PAYMENT_RECEIVED',
        providerRef: doPrecoJusto.providerRef,
      }),
    });

    expect(r.accepted).toBe(true);
    expect(pedidoStatus(doPrecoJusto.orderId)).toBe('pago');
  });
});
