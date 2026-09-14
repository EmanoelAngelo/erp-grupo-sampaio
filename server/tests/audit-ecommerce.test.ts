/**
 * ============================================================================
 * AUDITORIA FASE 12 — A LOJA COMO CLIENTE REAL
 * ============================================================================
 *
 * O que JÁ ESTÁ coberto pela suíte existente (conferido arquivo a arquivo, e
 * por isso NÃO repetido aqui):
 *
 *   - vitrine só lista publicado, estoque real, filtro por loja ..... ecommerce-core.test.ts
 *   - busca sem acento, paginação, destaque, grade num card ......... vitrine-robusta.test.ts
 *   - preço promocional na vitrine, no PDV e no pedido .............. ecommerce-core.test.ts
 *   - cliente NÃO dita preço (unitPriceCents ignorado) .............. ecommerce-core.test.ts
 *   - cancelamento antes do pagamento devolve a reserva ............. ecommerce-jornada.test.ts, portal-cancelamento.test.ts
 *   - frete de TABELA cobrado exato, frete grátis acima de X ........ loja-frete-checkout.test.ts, frete-de-cada-loja.test.ts
 *   - retirada vs entrega: etapas, recusas e rótulos ................ pedido-de-retirada-chega-ao-cliente.test.ts, pedido-fulfillment.test.ts
 *   - webhook: idempotência, cross-tenant, fora de ordem ............ pagamento-webhook.test.ts, ecommerce-jornada.test.ts
 *   - pedido de A invisível para o cliente B no portal .............. portal-cliente.test.ts, portal-cancelamento.test.ts
 *   - reserva de pedido não pago expira e volta à vitrine ........... reserva-de-pedido-expira.test.ts
 *   - carrinho congelado descongela (cotação devolve preço de agora)  carrinho-congelado-descongela.test.ts
 *
 * O que FALTAVA — e é o que este arquivo prova:
 *
 * 1. O FLUXO INTEIRO DA RETIRADA PELA PORTA HTTP, com matemática exata em
 *    centavos: vitrine → checkout (retirada) → reserva → webhook POR OPERAÇÃO
 *    (rota, não serviço) → pago → baixa definitiva → financeiro → fulfillment
 *    até 'entregue'. Cada pedaço existia em um arquivo; a travessia inteira,
 *    emendada, não existia em nenhum.
 * 2. CONCORRÊNCIA no último item: dois checkouts simultâneos, um ganha e o
 *    outro é recusado com honestidade — nunca dois pedidos para um item.
 * 3. PREÇO ALTERADO entre o carrinho e o fechamento: a REGRA (provada aqui) é
 *    que o servidor cobra o preço ATUAL do banco — nem o congelado no
 *    navegador, nem o que o cliente mandou. A cotação de carrinho
 *    (`/checkout/frete`) é o instrumento que mostra o preço novo ANTES do
 *    clique; o checkout cobra exatamente esse.
 * 4. PRODUTO DESPUBLICADO no meio do caminho: o checkout do carrinho antigo é
 *    recusado com 404 nomeando o item — e a recusa é ATÔMICA: nada do resto
 *    do carrinho fica reservado.
 * 5. COTAÇÃO SIMULADA NUNCA VIRA FRETE COBRADO. O caso existente
 *    (loja-frete-checkout.test.ts) prova o caminho em que a cotação nem roda
 *    (sem CEP de origem). Aqui a cotação RODA — origem cadastrada, produto com
 *    medidas, adapter devolvendo opções `simulated: true` — e o descarte do
 *    `CheckoutShippingService` (linha `if (o.simulated ...) continue`) é
 *    exercitado de verdade: nenhuma opção de transportadora é oferecida, e
 *    tentar comprá-la mesmo assim é 400.
 *
 * Sem rede: o Asaas não é configurado (cobrança nasce 'unconfigured', que é o
 * comportamento honesto já provado em ecommerce-core), e o webhook usa o
 * idioma de pagamento-webhook.test.ts — `provider_ref` gravado na intenção que
 * o PRÓPRIO checkout criou, token da operação no cofre, e o POST na rota
 * pública por operação.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { loginForTest } from './helpers/auth.js';
import { abrirParaVisitante, VISITANTE } from './helpers/lojaAberta.js';
import { upsertAsaasWebhookToken } from '../src/services/integrations/AsaasCredentialService.js';
import { saveShippingSettings } from '../src/services/core/CheckoutShippingService.js';

const app = createApp();
const LOJA = '/api/v1/loja';
const TOKEN_WEBHOOK = 'token-webhook-auditoria-fase12';

let auth: { Authorization: string };
let companyId: string;
let n = 0;

/** Produto publicado com saldo, criado pela MESMA porta que o gestor usa. */
async function publicado(
  nome: string,
  priceCents: number,
  qty: number,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const criado = await request(app)
    .post('/api/v1/core/products')
    .set(auth)
    .send({ name: nome, priceCents, category: 'Auditoria', publishOnline: true, ...extra });
  expect(criado.status, JSON.stringify(criado.body)).toBe(201);
  if (qty > 0) {
    const mov = await request(app).post('/api/v1/core/stock/movements').set(auth).send({
      productId: criado.body.id,
      movementType: 'in',
      quantity: qty,
      referenceType: 'entrada',
      referenceId: `nf-audit-${(n += 1)}`,
    });
    expect(mov.status, JSON.stringify(mov.body)).toBe(201);
  }
  return criado.body.id as string;
}

async function saldo(productId: string): Promise<{ quantity: number; reserved: number }> {
  const res = await request(app).get('/api/v1/core/stock').set(auth);
  expect(res.status).toBe(200);
  const linha = res.body.items.find((i: { product_id: string }) => i.product_id === productId);
  return { quantity: linha?.quantity ?? 0, reserved: linha?.reserved ?? 0 };
}

async function vitrine(): Promise<Record<string, unknown>[]> {
  const res = await request(app).get(`${LOJA}/products`);
  expect(res.status).toBe(200);
  return res.body.items as Record<string, unknown>[];
}

function fechar(idem: string, corpo: Record<string, unknown>) {
  return request(app)
    .post(`${LOJA}/checkout`)
    .set('Idempotency-Key', idem)
    .send({ customerName: 'Cliente da Auditoria', ...VISITANTE, paymentMethod: 'pix', ...corpo });
}

function pedidoNoBanco(id: string): Record<string, unknown> {
  return getConnection()
    .prepare(
      `SELECT status, shipping_method, shipping_cents, items_cents, total_cents, customer_id
         FROM core_orders WHERE id = ?`,
    )
    .get(id) as Record<string, unknown>;
}

function quantosPedidos(): number {
  return (
    getConnection().prepare('SELECT COUNT(*) c FROM core_orders WHERE company_id = ?').get(companyId) as {
      c: number;
    }
  ).c;
}

beforeEach(async () => {
  resetDbForTests();
  n = 0;
  const login = await loginForTest(app, {
    userId: 'auditor-ecom',
    companyId: 'auditoria-ecom',
    profileCodes: ['gerente_loja'],
  });
  auth = { Authorization: `Bearer ${login.body.accessToken}` };
  companyId = login.body.company.id as string;
  // O checkout de VISITANTE exige a loja aberta para ele (GAP-PRD-028).
  abrirParaVisitante(companyId);
});

// ============================================================================

describe('a jornada de retirada, do clique à sacola na mão do cliente', () => {
  it('vitrine → checkout → reserva → webhook da operação → pago → baixa → financeiro → entregue', async () => {
    // R$ 123,45 a unidade; duas unidades = R$ 246,90 exatos, sem arredondar.
    const produto = await publicado('Tênis da Jornada', 12_345, 5);

    // 1. A vitrine pública mostra o preço público e o disponível real.
    const antes = await vitrine();
    expect(antes).toHaveLength(1);
    expect(antes[0].priceCents).toBe(12_345);
    expect(antes[0].available).toBe(5);

    // 2. Checkout SEM forma de entrega: nasce RETIRADA, frete zero.
    const res = await fechar('fluxo-retirada-1', {
      customerDocument: '111.444.777-35',
      customerEmail: 'cliente@auditoria.local',
      items: [{ productId: produto, quantity: 2 }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.orders).toHaveLength(1);
    const orderId = res.body.orders[0].id as string;

    const nascido = pedidoNoBanco(orderId);
    expect(nascido.status).toBe('aguardando_pagamento');
    expect(nascido.shipping_method).toBe('retirada');
    expect(nascido.shipping_cents).toBe(0);
    expect(nascido.items_cents).toBe(24_690);
    expect(nascido.total_cents).toBe(24_690);
    expect(nascido.customer_id).toBeTruthy();

    // 3. Sem provedor configurado, a cobrança diz a verdade: unconfigured.
    //    Nem "pago", nem QR inventado.
    expect(res.body.payments[0].status).toBe('unconfigured');

    // 4. Reserva na criação: físico intacto, disponível reduzido.
    expect(await saldo(produto)).toEqual({ quantity: 5, reserved: 2 });
    expect((await vitrine())[0].available).toBe(3);

    // 5. O provedor confirma — PELA ROTA por operação, com o token do cofre.
    //    O provider_ref é gravado na intenção que o PRÓPRIO checkout criou
    //    (idioma de pagamento-webhook.test.ts: sem provedor real não há ref).
    upsertAsaasWebhookToken({ companyId, webhookToken: TOKEN_WEBHOOK });
    const intent = getConnection()
      .prepare("SELECT id, amount_cents FROM core_payment_intents WHERE origin_id = ?")
      .get(orderId) as { id: string; amount_cents: number };
    expect(intent.amount_cents).toBe(24_690);
    getConnection()
      .prepare('UPDATE core_payment_intents SET provider_ref = ? WHERE id = ?')
      .run('pay_fluxo_1', intent.id);

    const webhook = await request(app)
      .post(`${LOJA}/webhooks/payments/asaas/${companyId}`)
      .set('asaas-access-token', TOKEN_WEBHOOK)
      .send({
        id: 'ev-fluxo-1',
        event: 'PAYMENT_CONFIRMED',
        // O valor vai junto e tem de BATER com o pedido (guarda da rodada 42).
        payment: { id: 'pay_fluxo_1', value: 246.9 },
      });
    expect(webhook.status, JSON.stringify(webhook.body)).toBe(200);
    expect(webhook.body.accepted).toBe(true);

    // 6. Pago: a reserva virou baixa DEFINITIVA — 5 - 2 = 3, nada preso.
    expect(pedidoNoBanco(orderId).status).toBe('pago');
    expect(await saldo(produto)).toEqual({ quantity: 3, reserved: 0 });

    // 7. UM fato econômico, no valor exato do pedido.
    const financeiro = getConnection()
      .prepare(
        `SELECT direction, amount_cents, status FROM core_finance_entries
          WHERE origin_type = 'ecommerce_order' AND origin_id = ?`,
      )
      .all(orderId) as { direction: string; amount_cents: number; status: string }[];
    expect(financeiro).toHaveLength(1);
    expect(financeiro[0]).toEqual({ direction: 'in', amount_cents: 24_690, status: 'settled' });

    // 8. O balcão leva o pedido até o cliente — caminho da RETIRADA, inteiro.
    for (const etapa of ['separacao', 'conferencia', 'embalado', 'pronto_para_retirada', 'entregue']) {
      const passo = await request(app)
        .post(`/api/v1/core/orders/${orderId}/fulfillment`)
        .set(auth)
        .send({ status: etapa });
      expect([etapa, passo.status], JSON.stringify(passo.body)).toEqual([etapa, 200]);
      expect(passo.body.status).toBe(etapa);
    }
    expect(pedidoNoBanco(orderId).status).toBe('entregue');

    // 9. Entregar NÃO baixa de novo: a baixa aconteceu no pagamento, uma vez.
    expect(await saldo(produto)).toEqual({ quantity: 3, reserved: 0 });

    // 10. A linha do tempo conta a história completa, na ordem.
    const eventos = getConnection()
      .prepare('SELECT status FROM core_order_events WHERE order_id = ? ORDER BY created_at')
      .all(orderId) as { status: string }[];
    const vistos = eventos.map((e) => e.status);
    for (const esperado of ['pago', 'separacao', 'conferencia', 'embalado', 'pronto_para_retirada', 'entregue']) {
      expect(vistos).toContain(esperado);
    }
  });
});

// ============================================================================

describe('o último item não vira dois pedidos', () => {
  it('dois checkouts SIMULTÂNEOS do último item: um ganha, o outro é recusado com honestidade', async () => {
    const produto = await publicado('Peça Única', 50_000, 1);

    // Disparados juntos, sem esperar um pelo outro — é o clique de duas
    // pessoas no mesmo segundo.
    const [a, b] = await Promise.all([
      fechar('corrida-a', { items: [{ productId: produto, quantity: 1 }] }),
      fechar('corrida-b', { items: [{ productId: produto, quantity: 1 }] }),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses, JSON.stringify([a.body, b.body])).toEqual([201, 409]);

    const perdedor = a.status === 409 ? a : b;
    expect(perdedor.body.error.code).toBe('CORE_INSUFFICIENT_STOCK');

    // Um pedido só, uma reserva só — o físico nunca foi prometido duas vezes.
    expect(quantosPedidos()).toBe(1);
    expect(await saldo(produto)).toEqual({ quantity: 1, reserved: 1 });
  });
});

// ============================================================================

describe('preço alterado entre o carrinho e o fechamento', () => {
  it('a REGRA: o servidor cobra o preço ATUAL do banco — e a cotação mostra esse preço antes do clique', async () => {
    const produto = await publicado('Jaqueta que Subiu', 10_000, 5);

    // O cliente montou o carrinho vendo R$ 100,00 — e a cotação confirma.
    const cotacaoAntes = await request(app)
      .post(`${LOJA}/checkout/frete`)
      .send({ items: [{ productId: produto, quantity: 1 }] });
    expect(cotacaoAntes.status).toBe(200);
    expect(cotacaoAntes.body.itens[0].priceCents).toBe(10_000);

    // Enquanto a aba ficava aberta, o gestor reprecificou para R$ 125,00.
    const sobe = await request(app)
      .put(`/api/v1/core/products/${produto}`)
      .set(auth)
      .send({ priceCents: 12_500 });
    expect(sobe.status, JSON.stringify(sobe.body)).toBe(200);

    // A MESMA cotação, reconsultada, já descongela o preço novo — é o que a
    // tela mostra ao cliente ANTES de fechar (carrinho-congelado-descongela).
    const cotacaoDepois = await request(app)
      .post(`${LOJA}/checkout/frete`)
      .send({ items: [{ productId: produto, quantity: 1 }] });
    expect(cotacaoDepois.body.itens[0].priceCents).toBe(12_500);

    // O navegador tenta fechar com o preço velho. O servidor não negocia:
    // cobra o ATUAL — nem o congelado, nem o enviado.
    const res = await fechar('preco-subiu-1', {
      items: [{ productId: produto, quantity: 1, unitPriceCents: 10_000 }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const pedido = pedidoNoBanco(res.body.orders[0].id as string);
    expect(pedido.items_cents).toBe(12_500);
    expect(pedido.total_cents).toBe(12_500);

    const item = getConnection()
      .prepare('SELECT unit_price_cents, total_cents FROM core_order_items WHERE order_id = ?')
      .get(String(res.body.orders[0].id)) as { unit_price_cents: number; total_cents: number };
    expect(item).toEqual({ unit_price_cents: 12_500, total_cents: 12_500 });
  });
});

// ============================================================================

describe('carrinho antigo com produto despublicado', () => {
  it('o checkout é recusado nomeando o item — e NADA do resto do carrinho fica reservado', async () => {
    const continua = await publicado('Continua à Venda', 8_000, 5);
    const saiu = await publicado('Saiu de Linha', 6_000, 5);

    // O gestor despublica pela mesma porta que publicou.
    const tira = await request(app)
      .put(`/api/v1/core/products/${saiu}`)
      .set(auth)
      .send({ publishOnline: false });
    expect(tira.status, JSON.stringify(tira.body)).toBe(200);

    // O carrinho foi montado ontem, com os dois. Hoje um deles não existe
    // mais para a loja.
    const res = await fechar('carrinho-velho-1', {
      items: [
        { productId: continua, quantity: 2 },
        { productId: saiu, quantity: 1 },
      ],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(res.body.error.code).toBe('CORE_PRODUCT_NOT_AVAILABLE');

    // Atomicidade: o item bom do carrinho NÃO ficou preso numa reserva órfã.
    expect(quantosPedidos()).toBe(0);
    expect(await saldo(continua)).toEqual({ quantity: 5, reserved: 0 });
    expect(await saldo(saiu)).toEqual({ quantity: 5, reserved: 0 });

    /*
      ACHADO CONSERTADO pela auditoria integral (nasceu vermelho aqui):

      A recusa deve apontar QUAL item saiu de linha. O checkout do serviço
      (StorefrontService, "A ÚLTIMA PORTA") sempre lançou o código COM
      `details: { productId }` — mas a rota resolve o frete ANTES
      (`resolverFretesDoCarrinho` → `dividirCarrinho`, storefront.ts), e ali
      o mesmo 404 saía SEM details, e era o que o cliente recebia. O
      lançador de `dividirCarrinho` agora carrega o mesmo envelope, e a
      asserção abaixo trava o contrato: recusa nomeando o produto.
      Num carrinho de 8 itens, a tela não tem como marcar o item morto.
    */
    expect(res.body.error.details?.productId).toBe(saiu);
  });

  it('e o produto despublicado também some da vitrine na hora', async () => {
    const produto = await publicado('Efêmero', 5_000, 3);
    expect(await vitrine()).toHaveLength(1);

    await request(app)
      .put(`/api/v1/core/products/${produto}`)
      .set(auth)
      .send({ publishOnline: false });

    expect(await vitrine()).toHaveLength(0);
  });
});

// ============================================================================

describe('cotação simulada nunca vira frete cobrado', () => {
  /**
   * Aqui a cotação de transportadora RODA de verdade: CEP de origem no
   * cadastro fiscal, produto com as quatro medidas, e o adapter — sem
   * credencial — devolve opções `simulated: true` (o simulador de correios
   * responde SEMPRE que é chamado). O `CheckoutShippingService` tem de
   * descartá-las uma a uma. O teste existente (loja-frete-checkout) cobre o
   * caminho em que a cotação nem chega a rodar; este cobre o descarte.
   */
  async function lojaQueEntrega(): Promise<string> {
    // Origem: sem ela, a cotação nem rodaria e o descarte não seria testado.
    getConnection()
      .prepare(
        `INSERT INTO core_fiscal_configs (company_id, zip, updated_at)
         VALUES (?, '96010-900', ?)`,
      )
      .run(companyId, new Date().toISOString());
    saveShippingSettings({
      companyId,
      pickupEnabled: true,
      deliveryEnabled: true,
      flatRateCents: 2_500,
      estimatedDays: 3,
    });
    return publicado('Caixa Medida', 20_000, 5, {
      weightGrams: 800,
      heightCm: 10,
      widthCm: 30,
      lengthCm: 40,
    });
  }

  it('a lista de opções não oferece transportadora nenhuma — só retirada e a tabela do dono', async () => {
    const produto = await lojaQueEntrega();

    const r = await request(app)
      .post(`${LOJA}/checkout/frete`)
      .send({ items: [{ productId: produto, quantity: 1 }], zip: '01310-100' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);

    const metodos = (r.body.options as { method: string; priceCents: number }[]).map((o) => o.method);
    // O simulador devolveu PAC e SEDEX inventados; nenhum pode estar aqui.
    expect(metodos.some((m) => m.startsWith('transportadora:'))).toBe(false);
    expect(metodos).toContain('retirada');

    const tabela = (r.body.options as { method: string; priceCents: number }[]).find(
      (o) => o.method === 'tabela_da_loja',
    );
    // A tabela do dono é preço declarado por gente — essa sim, exata.
    expect(tabela?.priceCents).toBe(2_500);
  });

  it('tentar COMPRAR a opção simulada é 400 — e nenhum pedido nasce', async () => {
    const produto = await lojaQueEntrega();

    const res = await fechar('frete-simulado-1', {
      items: [{ productId: produto, quantity: 1 }],
      shippingMethod: 'transportadora:correios:PAC',
      shippingZip: '01310-100',
      shippingAddress: 'Avenida Paulista, 1000 - São Paulo/SP',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error.code).toBe('SHIPPING_OPTION_UNAVAILABLE');
    expect(quantosPedidos()).toBe(0);
  });

  it('e a tabela do dono, essa fecha — no preço exato dela', async () => {
    const produto = await lojaQueEntrega();

    const res = await fechar('frete-tabela-1', {
      items: [{ productId: produto, quantity: 1 }],
      shippingMethod: 'tabela_da_loja',
      shippingZip: '01310-100',
      shippingAddress: 'Avenida Paulista, 1000 - São Paulo/SP',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const pedido = pedidoNoBanco(res.body.orders[0].id as string);
    expect(pedido.shipping_method).toBe('tabela_da_loja');
    expect(pedido.shipping_cents).toBe(2_500);
    expect(pedido.items_cents).toBe(20_000);
    expect(pedido.total_cents).toBe(22_500);
  });
});
