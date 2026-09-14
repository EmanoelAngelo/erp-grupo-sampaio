/**
 * O frete do checkout — quem define, e quanto.
 *
 * DUAS FALHAS DE DINHEIRO ESTAVAM NO MESMO TRECHO
 *
 * 1. `shipping_cents` vinha do CORPO DA REQUISIÇÃO. Três linhas abaixo do
 *    comentário que garante que "o cliente não define valor", o preço do frete
 *    era o que o navegador mandasse.
 *
 * 2. Ninguém escolhia entrega ou retirada e nada era cobrado. Como
 *    `shipping_method` ficava NULO, e nulo não é retirada, todo pedido online
 *    nascia "entrega" com frete R$ 0,00 — a operação pagava o envio de cada
 *    venda e o valor não aparecia em lugar nenhum.
 *
 * As invariantes que este arquivo tranca:
 *
 *  - o cliente manda a CHAVE da opção, nunca o preço;
 *  - sem entrega escolhida, o pedido é de RETIRADA (o default não gasta
 *    dinheiro de ninguém);
 *  - cotação SIMULADA — a que o adapter inventa sem credencial — nunca vira
 *    opção de compra;
 *  - entrega exige endereço, não só CEP.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { getConnection } from '../src/db/sqlite.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import { loginForTest } from './helpers/auth.js';
import { abrirParaVisitante, VISITANTE } from './helpers/lojaAberta.js';
import { checkout, isPickup } from '../src/services/core/StorefrontService.js';
import {
  getShippingSettings,
  listCheckoutShipping,
  saveShippingSettings,
} from '../src/services/core/CheckoutShippingService.js';

const app = createApp();
const BASE = '/api/v1/loja';
const ENDERECO = 'Avenida Paulista, 1000 - São Paulo/SP';

let gringa: string;
let n = 0;

function produto(precoCents = 10000, comMedidas = true): string {
  n += 1;
  const id = `frete-${n}`;
  const agora = new Date().toISOString();
  const db = getConnection();
  db.prepare(
    `INSERT INTO core_products
       (id, company_id, internal_code, name, unit, cost_cents, price_cents,
        weight_grams, height_cm, width_cm, length_cm,
        active, publish_online, created_at, updated_at)
     VALUES (?, ?, ?, 'Jaqueta', 'UN', 4000, ?, ?, ?, ?, ?, 1, 1, ?, ?)`,
  ).run(
    id,
    gringa,
    `FR-${n}`,
    precoCents,
    comMedidas ? 800 : null,
    comMedidas ? 10 : null,
    comMedidas ? 30 : null,
    comMedidas ? 40 : null,
    agora,
    agora,
  );
  db.prepare(
    'INSERT INTO core_stock (company_id, product_id, quantity, reserved, updated_at) VALUES (?, ?, 50, 0, ?)',
  ).run(gringa, id, agora);
  return id;
}

function ligarEntrega(over: Partial<Parameters<typeof saveShippingSettings>[0]> = {}) {
  saveShippingSettings({
    companyId: gringa,
    pickupEnabled: true,
    deliveryEnabled: true,
    flatRateCents: 2500,
    estimatedDays: 4,
    ...over,
  });
}

async function comprar(corpo: Record<string, unknown>) {
  n += 1;
  return request(app)
    .post(`${BASE}/checkout`)
    .set('Idempotency-Key', `frete-ck-${n}`)
    .send({ customerName: 'Ana Compradora', ...VISITANTE, paymentMethod: 'pix', ...corpo });
}

function pedido(id: string) {
  return getConnection()
    .prepare(
      `SELECT shipping_method, shipping_cents, shipping_service_name,
              shipping_estimated_days, shipping_quote_real, items_cents, total_cents
         FROM core_orders WHERE id = ?`,
    )
    .get(id) as Record<string, number | string | null>;
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  n = 0;
  gringa = await upsertCompany({ slug: 'gringa', tradeName: 'Gringa', legalName: 'Gringa Ltda' });
  // O checkout de VISITANTE exige a loja aberta para ele (GAP-PRD-028).
  abrirParaVisitante(gringa);
});

describe('o cliente NÃO define o frete', () => {
  it('shippingCents no corpo é ignorado — o preço é o da tabela da loja', async () => {
    const p = produto(10000);
    ligarEntrega({ flatRateCents: 2500 });

    const res = await comprar({
      items: [{ productId: p, quantity: 1 }],
      shippingMethod: 'tabela_da_loja',
      shippingZip: '01310-100',
      shippingAddress: ENDERECO,
      // O navegador tentando pagar um frete que ele mesmo escolheu.
      shippingCents: 1,
    });
    expect(res.status).toBe(201);

    const o = pedido(res.body.orders[0].id);
    expect(o.shipping_cents).toBe(2500);
    expect(o.total_cents).toBe(12500);
  });

  it('shippingCents zero também é ignorado', async () => {
    const p = produto(10000);
    ligarEntrega({ flatRateCents: 3000 });

    const res = await comprar({
      items: [{ productId: p, quantity: 1 }],
      shippingMethod: 'tabela_da_loja',
      shippingZip: '01310-100',
      shippingAddress: ENDERECO,
      shippingCents: 0,
    });

    // Frete grátis é decisão do dono, não do comprador.
    expect(pedido(res.body.orders[0].id).shipping_cents).toBe(3000);
  });

  it('método que a loja não oferece é recusado', async () => {
    const p = produto();
    // Entrega desligada: só existe retirada.
    const res = await comprar({
      items: [{ productId: p, quantity: 1 }],
      shippingMethod: 'tabela_da_loja',
      shippingZip: '01310-100',
      shippingAddress: ENDERECO,
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('SHIPPING_OPTION_UNAVAILABLE');
  });
});

describe('sem entrega escolhida, é retirada', () => {
  it('o pedido nasce RETIRADA e não entrega grátis', async () => {
    const p = produto(10000);
    const res = await comprar({ items: [{ productId: p, quantity: 1 }] });
    expect(res.status).toBe(201);

    const o = pedido(res.body.orders[0].id);
    // O default precisa ser o que não gasta dinheiro de ninguém.
    expect(o.shipping_method).toBe('retirada');
    expect(o.shipping_cents).toBe(0);
    expect(o.total_cents).toBe(10000);
  });

  it('o SERVIÇO, chamado direto e sem frete, também assume retirada', () => {
    // A rota sempre resolve o frete antes de chamar o checkout, então ela
    // esconde este caso. O buraco original era aqui: `shipping_method` ficava
    // NULO, e nulo não é retirada — `isPickup(null)` é falso. Qualquer código
    // que chame `checkout` sem passar frete (importador, migração, um teste)
    // criaria de novo um pedido de entrega grátis.
    const p = produto(10000);
    const [ordem] = checkout({
      idempotencyKey: 'servico-direto',
      customerName: 'Ana Compradora',
      customerDocument: '111.444.777-35',
      paymentMethod: 'pix',
      items: [{ productId: p, quantity: 1 }],
    });

    const o = pedido(ordem.id);
    expect(o.shipping_method).toBe('retirada');
    expect(isPickup(o.shipping_method as string)).toBe(true);
    expect(o.shipping_cents).toBe(0);
  });

  it('operação nova não entrega por omissão', () => {
    // Ligar entrega por padrão repetiria o frete grátis involuntário.
    const config = getShippingSettings(gringa);
    expect(config.delivery_enabled).toBe(0);
    expect(config.pickup_enabled).toBe(1);
  });

  it('ligar entrega sem valor é recusado', () => {
    expect(() =>
      saveShippingSettings({
        companyId: gringa,
        pickupEnabled: true,
        deliveryEnabled: true,
        flatRateCents: null,
      }),
    ).toThrow(/valor do frete/i);
  });
});

describe('simulação não vira preço de venda', () => {
  it('sem transportadora conectada, nenhuma opção de transportadora é oferecida', async () => {
    const p = produto();
    ligarEntrega();
    // Sem CEP de origem cadastrado e sem credencial, o adapter só teria
    // simulação para dar. Cobrar por ela seria inventar preço de transporte.
    const r = await listCheckoutShipping({
      companyId: gringa,
      items: [{ productId: p, quantity: 1 }],
      destinationZip: '01310-100',
      itemsCents: 10000,
    });

    expect(r.options.some((o) => o.source === 'transportadora')).toBe(false);
    // A tabela do dono é preço de gente: essa pode ser cobrada hoje.
    expect(r.options.some((o) => o.source === 'tabela_da_loja')).toBe(true);
  });

  it('o pedido guarda que o prazo NÃO veio de transportadora', async () => {
    const p = produto();
    ligarEntrega({ estimatedDays: 4 });

    const res = await comprar({
      items: [{ productId: p, quantity: 1 }],
      shippingMethod: 'tabela_da_loja',
      shippingZip: '01310-100',
      shippingAddress: ENDERECO,
    });

    const o = pedido(res.body.orders[0].id);
    expect(o.shipping_estimated_days).toBe(4);
    // Sem esta marca não haveria como distinguir, depois, prazo cotado de
    // prazo declarado — e a tela prometeria data como se fosse do Correios.
    expect(o.shipping_quote_real).toBe(0);
    expect(o.shipping_service_name).toBe('Entrega pela loja');
  });
});

describe('entrega exige endereço', () => {
  it('só o CEP não basta', async () => {
    const p = produto();
    ligarEntrega();

    const res = await comprar({
      items: [{ productId: p, quantity: 1 }],
      shippingMethod: 'tabela_da_loja',
      shippingZip: '01310-100',
    });

    // Pedido com CEP e sem rua chega na separação sem para onde ir — depois de
    // já ter sido cobrado.
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CORE_SHIPPING_ADDRESS_REQUIRED');
  });

  it('retirada não exige endereço', async () => {
    const p = produto();
    const res = await comprar({ items: [{ productId: p, quantity: 1 }] });
    expect(res.status).toBe(201);
  });
});

describe('frete grátis acima de um valor', () => {
  it('vale a partir do limite, pelo preço do SERVIDOR', async () => {
    const p = produto(30000);
    ligarEntrega({ flatRateCents: 2500, freeAboveCents: 25000 });

    const res = await comprar({
      items: [{ productId: p, quantity: 1 }],
      shippingMethod: 'tabela_da_loja',
      shippingZip: '01310-100',
      shippingAddress: ENDERECO,
    });

    expect(pedido(res.body.orders[0].id).shipping_cents).toBe(0);
  });

  it('abaixo do limite, cobra', async () => {
    const p = produto(10000);
    ligarEntrega({ flatRateCents: 2500, freeAboveCents: 25000 });

    const res = await comprar({
      items: [{ productId: p, quantity: 1 }],
      shippingMethod: 'tabela_da_loja',
      shippingZip: '01310-100',
      shippingAddress: ENDERECO,
    });

    expect(pedido(res.body.orders[0].id).shipping_cents).toBe(2500);
  });
});

describe('a rota que lista as opções', () => {
  it('devolve retirada e diz por que a entrega não está disponível', async () => {
    const p = produto();
    const res = await request(app)
      .post(`${BASE}/checkout/frete`)
      .send({ items: [{ productId: p, quantity: 1 }], zip: '01310-100' })
      .expect(200);

    expect(res.body.options).toHaveLength(1);
    expect(res.body.options[0].method).toBe('retirada');
    expect(res.body.deliveryUnavailable.code).toBe('DELIVERY_DISABLED');
  });

  it('com entrega ligada, devolve as duas com preço do servidor', async () => {
    const p = produto();
    ligarEntrega({ flatRateCents: 1990 });

    const res = await request(app)
      .post(`${BASE}/checkout/frete`)
      .send({ items: [{ productId: p, quantity: 1 }], zip: '01310-100' })
      .expect(200);

    const entrega = res.body.options.find((o: { method: string }) => o.method !== 'retirada');
    expect(entrega.priceCents).toBe(1990);
    expect(res.body.deliveryUnavailable).toBeNull();
  });
});

/**
 * A tela do gestor, pela porta HTTP.
 *
 * Ligar entrega é decisão de dinheiro: quem pode fazer isso, e o que o
 * servidor recusa.
 */
describe('configuração da entrega', () => {
  it('exige perfil de gerente', async () => {
    await request(app).get('/api/v1/core/shipping-settings').expect(401);
  });

  it('gerente lê o padrão e liga a entrega com valor', async () => {
    const gerente = await loginForTest(app, {
      userId: 'ger-frete',
      companyId: 'op-frete',
      profileCodes: ['gerente_loja'],
    });
    const auth = { Authorization: `Bearer ${gerente.body.accessToken}` };

    const antes = await request(app).get('/api/v1/core/shipping-settings').set(auth).expect(200);
    expect(antes.body.deliveryEnabled).toBe(false);
    expect(antes.body.pickupEnabled).toBe(true);

    const salvo = await request(app)
      .put('/api/v1/core/shipping-settings')
      .set(auth)
      .send({ pickupEnabled: true, deliveryEnabled: true, flatRateCents: 1990, estimatedDays: 5 })
      .expect(200);
    expect(salvo.body.deliveryEnabled).toBe(true);
    expect(salvo.body.flatRateCents).toBe(1990);
  });

  it('ligar entrega sem valor é 400, não uma loja despachando de graça', async () => {
    const gerente = await loginForTest(app, {
      userId: 'ger-frete-2',
      companyId: 'op-frete',
      profileCodes: ['gerente_loja'],
    });

    const res = await request(app)
      .put('/api/v1/core/shipping-settings')
      .set({ Authorization: `Bearer ${gerente.body.accessToken}` })
      .send({ pickupEnabled: true, deliveryEnabled: true })
      .expect(400);
    expect(res.body.error.code).toBe('SHIPPING_FLAT_RATE_REQUIRED');
  });
});
