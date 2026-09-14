/**
 * ============================================================================
 * "PARCELE EM ATÉ 6x" PASSA A SER VERDADE (GAP-PRD-114)
 * ============================================================================
 *
 * O DEFEITO: com `installments_max = 6`, a vitrine publicava o selo "Parcele em
 * até 6x" e a cobrança de cartão ia ao provedor À VISTA — o corpo do
 * `POST /payments` era `{customer, billingType: 'CREDIT_CARD', value, dueDate,
 * description, externalReference}`, sem `installmentCount`. O checkout nem
 * aceitava o número de parcelas, e a LojaPage não oferecia a escolha.
 *
 * AGORA: o checkout aceita `installments` (só no cartão, até o teto de CADA
 * loja do carrinho, com parcela mínima de R$ 5,00); a cobrança vai ao provedor
 * com `installmentCount` + `totalValue`; a intenção guarda o plano
 * (`installment_count`, `provider_installment_ref`); o webhook de QUALQUER
 * parcela do plano confirma o pedido, com a conferência de valor feita pela
 * parcela; e estorno/cancelamento de pedido parcelado vão ao PLANO inteiro
 * (`/installments/:id`), não só à primeira parcela.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import {
  upsertAsaasApiKey,
  upsertAsaasWebhookToken,
} from '../src/services/integrations/AsaasCredentialService.js';
import { updateStorefrontSettings } from '../src/services/core/StorefrontSettingsService.js';
import { handlePaymentWebhook } from '../src/services/core/PaymentService.js';
import { cancelOrderCharges, refundOrder } from '../src/services/core/OrderChargeService.js';
import { sincronizarCobrancasComProvedor } from '../src/services/core/AsaasSincronizacao.js';
import { asaasComEstado } from './helpers/asaasComEstado.js';
import { abrirParaVisitante } from './helpers/lojaAberta.js';

const app = createApp();
const BASE = '/api/v1/loja';
const TOKEN = 'token-webhook-gringa-parcelas';
let gringa: string;
let preco: string;
let n = 0;
let asaas: ReturnType<typeof asaasComEstado>;

function produto(companyId: string, precoCents: number): string {
  n += 1;
  const id = `parc-${n}`;
  const agora = new Date().toISOString();
  const db = getConnection();
  db.prepare(
    `INSERT INTO core_products
       (id, company_id, internal_code, name, unit, cost_cents, price_cents, active, publish_online, created_at, updated_at)
     VALUES (?, ?, ?, 'Jaqueta de couro', 'UN', 4000, ?, 1, 1, ?, ?)`,
  ).run(id, companyId, `PC-${n}`, precoCents, agora, agora);
  db.prepare('INSERT INTO core_stock (company_id, product_id, quantity, reserved, updated_at) VALUES (?, ?, 50, 0, ?)').run(
    companyId,
    id,
    agora,
  );
  return id;
}

async function comprar(corpo: Record<string, unknown>, itens: { productId: string; quantity: number }[]) {
  n += 1;
  return request(app)
    .post(`${BASE}/checkout`)
    .set('Idempotency-Key', `parc-ck-${n}`)
    .send({
      customerName: 'Ana Compradora',
      customerDocument: '52998224725',
      customerEmail: 'ana@exemplo.com.br',
      paymentMethod: 'cartao',
      items: itens,
      ...corpo,
    });
}

function criacoesDeCobranca(): Record<string, unknown>[] {
  return asaas.criacoes().map((c) => c.body ?? {});
}

function intencaoDoPedido(orderId: string): Record<string, unknown> {
  return getConnection()
    .prepare("SELECT * FROM core_payment_intents WHERE origin_type = 'ecommerce_order' AND origin_id = ?")
    .get(orderId) as Record<string, unknown>;
}

function statusDoPedido(orderId: string): string {
  return (getConnection().prepare('SELECT status FROM core_orders WHERE id = ?').get(orderId) as { status: string }).status;
}

function quantosPedidos(): number {
  return (getConnection().prepare('SELECT COUNT(*) AS n FROM core_orders').get() as { n: number }).n;
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  n = 0;
  gringa = await upsertCompany({ slug: 'gringa', tradeName: 'Gringa', legalName: 'Gringa Ltda' });
  preco = await upsertCompany({ slug: 'preco-justo', tradeName: 'Preço Justo', legalName: 'Preço Justo Ltda' });
  upsertAsaasApiKey({ companyId: gringa, environment: 'sandbox', apiKey: '$aact_sandbox_gringa_parc_000000000' });
  upsertAsaasApiKey({ companyId: preco, environment: 'sandbox', apiKey: '$aact_sandbox_preco_parc_111111111' });
  upsertAsaasWebhookToken({ companyId: gringa, webhookToken: TOKEN });
  updateStorefrontSettings(gringa, { installmentsMax: 6 });
  // Este arquivo testa parcelas, não identidade: as duas lojas abrem a compra
  // para visitante, a decisão que o dono pode tomar (GAP-PRD-028). O corpo de
  // `comprar` já leva CPF válido e e-mail (GAP-PRD-191).
  abrirParaVisitante(gringa, preco);
  asaas = asaasComEstado();
  // O checkout chama o cliente HTTP real sem porta de teste: o `fetch` global
  // é o dublê, e só ele.
  vi.stubGlobal('fetch', asaas.fetchImpl);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ============================================================================
describe('GAP-PRD-114 — a cobrança vai parcelada ao provedor', () => {
  it('6x no cartão: installmentCount + totalValue no corpo, o plano guardado, e o pedido diz em quantas vezes', async () => {
    const jaqueta = produto(gringa, 60000);

    const res = await comprar({ installments: 6 }, [{ productId: jaqueta, quantity: 1 }]);

    expect(res.status).toBe(201);
    const corpo = criacoesDeCobranca()[0];
    // Antes: {customer, billingType, value: 600, dueDate, description, externalReference}.
    expect(corpo).toMatchObject({ billingType: 'CREDIT_CARD', installmentCount: 6, totalValue: 600 });
    expect(corpo.value).toBeUndefined();
    const orderId = res.body.orders[0].id as string;
    const intent = intencaoDoPedido(orderId);
    expect(intent.installment_count).toBe(6);
    expect(String(intent.provider_installment_ref)).toMatch(/^ins_/);
    expect(res.body.payments[0]).toMatchObject({ method: 'cartao', installments: 6 });
    const evento = getConnection()
      .prepare("SELECT note FROM core_order_events WHERE order_id = ? AND note LIKE 'Cobrança CARTAO%'")
      .get(orderId) as { note: string };
    expect(evento.note).toMatch(/6x de R\$ 100,00/);
  });

  it('sem parcelas (ou 1x): à vista como sempre — value, sem installmentCount', async () => {
    const jaqueta = produto(gringa, 60000);

    await comprar({}, [{ productId: jaqueta, quantity: 1 }]);
    await comprar({ installments: 1 }, [{ productId: jaqueta, quantity: 1 }]);

    for (const corpo of criacoesDeCobranca()) {
      expect(corpo.value).toBe(600);
      expect(corpo.installmentCount).toBeUndefined();
    }
  });

  it('acima do teto da loja: 400 dizendo o teto — e nenhum pedido nasce', async () => {
    const jaqueta = produto(gringa, 60000);

    const res = await comprar({ installments: 7 }, [{ productId: jaqueta, quantity: 1 }]);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CORE_CHECKOUT_INSTALLMENTS_INVALID');
    expect(res.body.error.message).toMatch(/Gringa.*até 6x/);
    expect(quantosPedidos()).toBe(0);
    expect(asaas.criacoes()).toHaveLength(0);
  });

  it('carrinho com uma loja que não parcela: a recusa nomeia a loja', async () => {
    const jaqueta = produto(gringa, 60000);
    const panela = produto(preco, 20000);

    const res = await comprar({ installments: 2 }, [
      { productId: jaqueta, quantity: 1 },
      { productId: panela, quantity: 1 },
    ]);

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/Preço Justo.*à vista/);
    expect(quantosPedidos()).toBe(0);
  });

  it('parcela no PIX ou no boleto: 400 — parcelamento é do cartão', async () => {
    const jaqueta = produto(gringa, 60000);
    const res = await comprar({ installments: 3, paymentMethod: 'pix' }, [{ productId: jaqueta, quantity: 1 }]);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/cartão/);
  });

  it('parcela abaixo de R$ 5,00: 400 com o máximo que cabe', async () => {
    const chaveiro = produto(gringa, 2000);
    const res = await comprar({ installments: 6 }, [{ productId: chaveiro, quantity: 1 }]);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/R\$ 5,00.*até 4x/);
  });

  it('número de parcelas que não é inteiro: 400', async () => {
    const jaqueta = produto(gringa, 60000);
    const res = await comprar({ installments: 'seis' }, [{ productId: jaqueta, quantity: 1 }]);
    expect(res.status).toBe(400);
  });

  it('a vitrine publica o teto de parcelas junto do selo', async () => {
    const res = await request(app).get(`${BASE}/stores`);
    const loja = (res.body.stores as { slug: string; cardInstallmentsMax: number | null }[]).find((s) => s.slug === 'gringa');
    expect(loja?.cardInstallmentsMax).toBe(6);
    const outra = (res.body.stores as { slug: string; cardInstallmentsMax: number | null }[]).find((s) => s.slug === 'preco-justo');
    expect(outra?.cardInstallmentsMax).toBeNull();
  });
});

// ============================================================================
describe('GAP-PRD-114 — o que o provedor devolve de um plano de parcelas', () => {
  async function pedidoParcelado(parcelas: number, precoCents = 60000): Promise<{ orderId: string; plano: string; ids: string[] }> {
    const item = produto(gringa, precoCents);
    const res = await comprar({ installments: parcelas }, [{ productId: item, quantity: 1 }]);
    expect(res.status).toBe(201);
    const orderId = res.body.orders[0].id as string;
    const intent = intencaoDoPedido(orderId);
    const plano = String(intent.provider_installment_ref);
    return { orderId, plano, ids: asaas.cobrancas.filter((c) => c.installment === plano).map((c) => c.id) };
  }

  function confirmar(paymentId: string, plano: string, valor: number, id = `evt-${paymentId}`) {
    return handlePaymentWebhook({
      provider: 'asaas',
      companyId: gringa,
      token: TOKEN,
      payload: { id, event: 'PAYMENT_CONFIRMED', payment: { id: paymentId, installment: plano, value: valor, billingType: 'CREDIT_CARD' } },
    });
  }

  it('a confirmação de QUALQUER parcela confirma o pedido — e as outras não repetem nada', async () => {
    const { orderId, plano, ids } = await pedidoParcelado(3, 10000);
    const [primeira, segunda, terceira] = asaas.cobrancas.filter((c) => c.installment === plano);
    expect(ids).toHaveLength(3);
    // 100,00 / 3: 33,34 + 33,33 + 33,33 — a sobra na primeira.
    expect([primeira.value, segunda.value, terceira.value]).toEqual([33.34, 33.33, 33.33]);

    // A segunda parcela chega primeiro: antes, "Cobrança não encontrada no ERP".
    const r = confirmar(segunda.id, plano, segunda.value);
    expect(r.detail).toBe('Pedido confirmado.');
    expect(statusDoPedido(orderId)).toBe('pago');

    const outra = confirmar(primeira.id, plano, primeira.value);
    expect(outra.accepted).toBe(true);
    expect(intencaoDoPedido(orderId).status).toBe('confirmed');
    const lancamentos = getConnection()
      .prepare("SELECT COUNT(*) AS n FROM core_finance_entries WHERE origin_type = 'ecommerce_order' AND origin_id = ?")
      .get(orderId) as { n: number };
    expect(lancamentos.n).toBe(1);
  });

  it('parcela com valor que não cabe no plano: divergência, pedido NÃO pago', async () => {
    const { orderId, plano } = await pedidoParcelado(3, 10000);
    const [, segunda] = asaas.cobrancas.filter((c) => c.installment === plano);

    confirmar(segunda.id, plano, 1);

    expect(intencaoDoPedido(orderId).status).toBe('amount_mismatch');
    expect(statusDoPedido(orderId)).toBe('aguardando_pagamento');
  });

  it('o plano de OUTRA operação não confirma o pedido desta (mesmo token válido)', async () => {
    const { orderId, plano, ids } = await pedidoParcelado(2);
    upsertAsaasWebhookToken({ companyId: preco, webhookToken: 'token-preco' });

    expect(() =>
      handlePaymentWebhook({
        provider: 'asaas',
        companyId: preco,
        token: 'token-preco',
        payload: { id: 'evt-x', event: 'PAYMENT_CONFIRMED', payment: { id: `${ids[1]}-nao-existe`, installment: plano, value: 300 } },
      }),
    ).toThrow(/outra operação/);
    expect(statusDoPedido(orderId)).toBe('aguardando_pagamento');
  });

  it('a consulta ao provedor (GAP-PRD-016) também entende a parcela', async () => {
    const { orderId, plano } = await pedidoParcelado(3, 10000);
    const [primeira] = asaas.cobrancas.filter((c) => c.installment === plano);
    asaas.pagar(primeira.id, 'CONFIRMED');

    await sincronizarCobrancasComProvedor({ companyId: gringa, trigger: 'manual', fetchImpl: asaas.fetchImpl });

    expect(statusDoPedido(orderId)).toBe('pago');
  });

  it('devolução de pedido parcelado estorna o PLANO inteiro, não só a primeira parcela', async () => {
    const { orderId, plano, ids } = await pedidoParcelado(3, 10000);
    confirmar(ids[0], plano, 33.34);

    const r = await refundOrder({ companyId: gringa, orderId, reason: 'arrependimento', fetchImpl: asaas.fetchImpl });

    expect(r.providerRefund).toBe('done');
    expect(asaas.estornos().map((c) => new URL(c.url).pathname)).toEqual([expect.stringContaining(`/installments/${plano}/refund`)]);
    expect(asaas.cobrancas.filter((c) => c.installment === plano).every((c) => c.status === 'REFUNDED')).toBe(true);
  });

  it('cancelamento de pedido parcelado derruba o PLANO inteiro', async () => {
    const { orderId, plano } = await pedidoParcelado(3, 10000);

    const r = await cancelOrderCharges({ companyId: gringa, orderId, fetchImpl: asaas.fetchImpl });

    expect(r).toMatchObject({ cancelled: 1, failed: 0 });
    const exclusoes = asaas.chamadas.filter((c) => c.method === 'DELETE').map((c) => new URL(c.url).pathname);
    expect(exclusoes).toEqual([expect.stringContaining(`/installments/${plano}`)]);
    expect(asaas.cobrancas.filter((c) => c.installment === plano).every((c) => c.deleted)).toBe(true);
  });
});

// ============================================================================
describe('GAP-PRD-114 — timeout na criação do plano (a regra do GAP-PRD-049 vale para o parcelado)', () => {
  it('a retentativa ADOTA o plano que o provedor criou — e as parcelas irmãs não viram "órfãs a mais"', async () => {
    asaas = asaasComEstado({ perderRespostas: 1 });
    vi.stubGlobal('fetch', asaas.fetchImpl);
    const jaqueta = produto(gringa, 9000);

    const res = await comprar({ installments: 3 }, [{ productId: jaqueta, quantity: 1 }]);
    expect(res.status).toBe(201);
    expect(res.body.payments[0].status).toBe('failed');
    const orderId = res.body.orders[0].id as string;
    // 90,00 / 3 = 30,00 cada: as três parcelas batem no valor — o caso em que
    // a procura veria "três cobranças" se não soubesse de planos.
    expect(asaas.cobrancas).toHaveLength(3);

    const { createOrderCharge } = await import('../src/services/core/OrderChargeService.js');
    const r = await createOrderCharge({ companyId: gringa, orderId, method: 'cartao', fetchImpl: asaas.fetchImpl });

    expect(asaas.criacoes()).toHaveLength(1);
    const intent = intencaoDoPedido(orderId);
    expect(intent.provider_ref).toBe(asaas.cobrancas[0].id);
    expect(intent.provider_installment_ref).toBe(asaas.cobrancas[0].installment);
    expect(intent.last_error).toBeNull();
    expect(r.status).toBe('pending');
  });
});
