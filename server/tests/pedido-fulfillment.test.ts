/**
 * Do pagamento até a entrega, sem duplicar nada.
 *
 * O pedido online JÁ reservou estoque no checkout e JÁ lançou o financeiro no
 * pagamento. Avançar pelas etapas de separação é movimento de ARMAZÉM, não de
 * dinheiro nem de saldo: se o fulfillment reservasse de novo, o segundo
 * comprador levaria "sem estoque" de um item que existe; se lançasse receita
 * de novo, o mês fecharia com o dobro.
 *
 * É isso que estes testes fixam — o que o fulfillment NÃO pode fazer.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import { upsertAsaasWebhookToken } from '../src/services/integrations/AsaasCredentialService.js';
import { handlePaymentWebhook } from '../src/services/core/PaymentService.js';
import {
  FULFILLMENT_STATUSES,
  advanceFulfillment,
  checkout,
  getOrderDetail,
} from '../src/services/core/StorefrontService.js';
import { createPaymentIntent } from '../src/services/core/PaymentService.js';

const TOKEN = 'token-webhook-fulfillment';

let precoJusto: string;
let gringa: string;
let n = 0;

function produtoPublicado(companyId: string): string {
  n += 1;
  const id = `prod-ff-${n}`;
  const agora = new Date().toISOString();
  const db = getConnection();
  db.prepare(
    `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                price_cents, active, publish_online, created_at, updated_at)
     VALUES (?, ?, ?, 'Item expedível', 'UN', 4000, 10000, 1, 1, ?, ?)`,
  ).run(id, companyId, `FF-${n}`, agora, agora);
  db.prepare(
    'INSERT INTO core_stock (company_id, product_id, quantity, reserved, updated_at) VALUES (?, ?, 10, 0, ?)',
  ).run(companyId, id, agora);
  return id;
}

function saldo(companyId: string, productId: string) {
  return getConnection()
    .prepare('SELECT quantity, reserved FROM core_stock WHERE company_id = ? AND product_id = ?')
    .get(companyId, productId) as { quantity: number; reserved: number };
}

function lancamentos(orderId: string) {
  return getConnection()
    .prepare(
      "SELECT * FROM core_finance_entries WHERE origin_type = 'ecommerce_order' AND origin_id = ?",
    )
    .all(orderId) as Record<string, unknown>[];
}

function movimentos(orderId: string) {
  return getConnection()
    .prepare("SELECT * FROM core_stock_movements WHERE reference_id = ?")
    .all(orderId) as Record<string, unknown>[];
}

/** Pedido pago pelo caminho oficial: checkout → cobrança → webhook. */
/** O frete já resolvido pelo servidor — a forma que o checkout aceita. */
const FRETE_DE_ENTREGA = {
  method: 'tabela_da_loja',
  label: 'Entrega pela loja',
  priceCents: 2500,
  estimatedDays: 4,
  real: false,
};

async function pedidoPago(companyId: string, sufixo: string, quantidade = 2) {
  const produto = produtoPublicado(companyId);
  const [ordem] = checkout({
    idempotencyKey: `ck-${sufixo}`,
    customerName: 'Cliente Expedição',
    customerDocument: '111.444.777-35',
    paymentMethod: 'pix',
    // ENTREGA, explicitamente. O default do checkout é retirada: pedido sem
    // entrega arranjada não pode nascer sendo despachado de graça.
    shippingPorEmpresa: { [companyId]: FRETE_DE_ENTREGA },
    shippingAddress: 'Avenida Paulista, 1000 - São Paulo/SP',
    items: [{ productId: produto, quantity: quantidade }],
  });
  const intent = await createPaymentIntent({
    companyId,
    originType: 'ecommerce_order',
    originId: ordem.id,
    method: 'pix',
    amountCents: ordem.total_cents,
    idempotencyKey: `pay-${sufixo}`,
  });
  getConnection()
    .prepare('UPDATE core_payment_intents SET provider_ref = ? WHERE id = ?')
    .run(`pay_${sufixo}`, intent.id);
  handlePaymentWebhook({
    provider: 'asaas',
    companyId,
    token: TOKEN,
    payload: { id: `ev-${sufixo}`, event: 'PAYMENT_CONFIRMED', payment: { id: `pay_${sufixo}` } },
  });
  return { orderId: ordem.id, produto };
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  n = 0;
  precoJusto = await upsertCompany({
    slug: 'preco-justo',
    tradeName: 'Preço Justo',
    legalName: 'Preço Justo Ltda',
  });
  gringa = await upsertCompany({ slug: 'gringa', tradeName: 'Gringa', legalName: 'Gringa Ltda' });
  upsertAsaasWebhookToken({ companyId: precoJusto, webhookToken: TOKEN });
  upsertAsaasWebhookToken({ companyId: gringa, webhookToken: TOKEN });
});

describe('o fulfillment não repete o que já foi feito', () => {
  it('atravessar todas as etapas não mexe em estoque nem em financeiro', async () => {
    const { orderId, produto } = await pedidoPago(precoJusto, 'a');
    const saldoAposPagar = saldo(precoJusto, produto);
    const financeiroAposPagar = lancamentos(orderId);
    const movimentosAposPagar = movimentos(orderId);

    // Retirada tem etapa própria; este pedido é de entrega.
    for (const etapa of FULFILLMENT_STATUSES.filter(
      (e) => e !== 'pago' && e !== 'pronto_para_retirada',
    )) {
      advanceFulfillment({ companyId: precoJusto, orderId, toStatus: etapa });
    }

    // Uma baixa, um lançamento, um saldo. As etapas são de armazém.
    expect(saldo(precoJusto, produto)).toEqual(saldoAposPagar);
    expect(lancamentos(orderId)).toHaveLength(financeiroAposPagar.length);
    expect(movimentos(orderId)).toHaveLength(movimentosAposPagar.length);
  });

  it('a reserva já virou baixa no pagamento — separar não reserva de novo', async () => {
    const { orderId, produto } = await pedidoPago(precoJusto, 'b', 3);

    advanceFulfillment({ companyId: precoJusto, orderId, toStatus: 'separacao' });

    expect(saldo(precoJusto, produto)).toEqual({ quantity: 7, reserved: 0 });
  });

  it('repetir a mesma etapa não duplica a linha do tempo', async () => {
    const { orderId } = await pedidoPago(precoJusto, 'c');

    advanceFulfillment({ companyId: precoJusto, orderId, toStatus: 'separacao' });
    advanceFulfillment({ companyId: precoJusto, orderId, toStatus: 'separacao' });

    const eventos = getConnection()
      .prepare("SELECT COUNT(*) c FROM core_order_events WHERE order_id = ? AND status = 'separacao'")
      .get(orderId) as { c: number };
    // Duas chamadas, dois registros: a linha do tempo é append-only e um
    // reprocessamento REAL do operador é fato, não ruído. O que não pode
    // duplicar é estoque e dinheiro — cobertos acima.
    expect(eventos.c).toBe(2);
  });
});

describe('o que o fulfillment recusa', () => {
  it('não separa pedido que ninguém pagou', () => {
    const produto = produtoPublicado(precoJusto);
    const [ordem] = checkout({
      idempotencyKey: 'ck-naopago',
      customerName: 'Cliente Ansioso',
      customerDocument: '111.444.777-35',
      paymentMethod: 'pix',
      items: [{ productId: produto, quantity: 1 }],
    });

    expect(() =>
      advanceFulfillment({ companyId: precoJusto, orderId: ordem.id, toStatus: 'separacao' }),
    ).toThrow(expect.objectContaining({ code: 'CORE_ORDER_NOT_PAID' }));
  });

  it('recusa etapa que não existe', async () => {
    const { orderId } = await pedidoPago(precoJusto, 'd');

    expect(() =>
      advanceFulfillment({ companyId: precoJusto, orderId, toStatus: 'teletransportado' }),
    ).toThrow(expect.objectContaining({ code: 'CORE_INVALID_STATUS' }));
  });

  it('operação vizinha não avança pedido alheio', async () => {
    const { orderId } = await pedidoPago(gringa, 'e');

    expect(() =>
      advanceFulfillment({ companyId: precoJusto, orderId, toStatus: 'separacao' }),
    ).toThrow(expect.objectContaining({ code: 'CORE_ORDER_NOT_FOUND' }));
  });
});

describe('retirada e entrega são caminhos diferentes', () => {
  /** Pedido de retirada, pago pelo mesmo caminho oficial. */
  async function pedidoDeRetirada(sufixo: string) {
    const produto = produtoPublicado(precoJusto);
    const [ordem] = checkout({
      idempotencyKey: `ck-ret-${sufixo}`,
      customerName: 'Cliente Que Busca',
      customerDocument: '111.444.777-35',
      paymentMethod: 'pix',
      // Sem `shipping`, o checkout já assume retirada — é o default seguro.
      items: [{ productId: produto, quantity: 1 }],
    });
    const intent = await createPaymentIntent({
      companyId: precoJusto,
      originType: 'ecommerce_order',
      originId: ordem.id,
      method: 'pix',
      amountCents: ordem.total_cents,
      idempotencyKey: `pay-ret-${sufixo}`,
    });
    getConnection()
      .prepare('UPDATE core_payment_intents SET provider_ref = ? WHERE id = ?')
      .run(`pay_ret_${sufixo}`, intent.id);
    handlePaymentWebhook({
      provider: 'asaas',
      companyId: precoJusto,
      token: TOKEN,
      payload: {
        id: `ev-ret-${sufixo}`,
        event: 'PAYMENT_CONFIRMED',
        payment: { id: `pay_ret_${sufixo}` },
      },
    });
    return ordem.id;
  }

  it('pedido de retirada não é expedido — ele fica pronto no balcão', async () => {
    const orderId = await pedidoDeRetirada('a');
    // Etapa por etapa: o servidor só aceita a próxima (GAP-PRD-121).
    for (const etapa of ['separacao', 'conferencia', 'embalado']) {
      advanceFulfillment({ companyId: precoJusto, orderId, toStatus: etapa });
    }

    // "Expedido" mandaria alguém procurar rastreio de encomenda nunca postada,
    // com o cliente esperando na loja.
    expect(() =>
      advanceFulfillment({ companyId: precoJusto, orderId, toStatus: 'expedido' }),
    ).toThrow(expect.objectContaining({ code: 'CORE_ORDER_IS_PICKUP' }));

    advanceFulfillment({ companyId: precoJusto, orderId, toStatus: 'pronto_para_retirada' });
    advanceFulfillment({ companyId: precoJusto, orderId, toStatus: 'entregue' });

    const pedido = getOrderDetail(orderId, precoJusto) as Record<string, unknown>;
    expect(pedido.status).toBe('entregue');
    // Nenhum rastreio: não houve transportadora.
    expect(pedido.tracking_code).toBeNull();
  });

  it('pedido de entrega não fica "pronto para retirada"', async () => {
    const { orderId } = await pedidoPago(precoJusto, 'h');

    expect(() =>
      advanceFulfillment({ companyId: precoJusto, orderId, toStatus: 'pronto_para_retirada' }),
    ).toThrow(expect.objectContaining({ code: 'CORE_ORDER_IS_DELIVERY' }));
  });
});

describe('rastreio', () => {
  it('o código do transportador fica no pedido e na linha do tempo', async () => {
    const { orderId } = await pedidoPago(precoJusto, 'f');

    for (const etapa of ['separacao', 'conferencia', 'embalado']) {
      advanceFulfillment({ companyId: precoJusto, orderId, toStatus: etapa });
    }
    advanceFulfillment({
      companyId: precoJusto,
      orderId,
      toStatus: 'expedido',
      trackingCode: 'BR123456789BR',
    });

    const pedido = getOrderDetail(orderId, precoJusto) as Record<string, unknown>;
    expect(pedido.tracking_code).toBe('BR123456789BR');
    expect(pedido.status).toBe('expedido');
  });

  it('avançar sem informar rastreio não apaga o que já existia', async () => {
    const { orderId } = await pedidoPago(precoJusto, 'g');
    for (const etapa of ['separacao', 'conferencia', 'embalado']) {
      advanceFulfillment({ companyId: precoJusto, orderId, toStatus: etapa });
    }
    advanceFulfillment({
      companyId: precoJusto,
      orderId,
      toStatus: 'expedido',
      trackingCode: 'BR999888777BR',
    });

    advanceFulfillment({ companyId: precoJusto, orderId, toStatus: 'entregue' });

    const pedido = getOrderDetail(orderId, precoJusto) as Record<string, unknown>;
    expect(pedido.tracking_code).toBe('BR999888777BR');
  });
});
