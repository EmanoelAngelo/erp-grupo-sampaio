/**
 * CUPOM DE DESCONTO DA LOJA ONLINE — GAP-PRD-123.
 *
 * A auditoria achou zero: nenhuma tabela, rota, tela ou campo de código
 * promocional (os "cupons" do repositório eram o cupom fiscal). Este arquivo
 * cobra o mecanismo inteiro, pela API:
 *
 *   - o gerente cria, lista e encerra, com as regras conferidas (código,
 *     desconto, pedido mínimo, vigência, usos no total e por cliente);
 *   - o checkout aplica o cupom da empresa dona dos itens, rateia o desconto
 *     nos itens e grava o retrato no pedido — a cobrança, a NF-e e os
 *     relatórios leem o pedido como sempre;
 *   - cada recusa diz o motivo, e o código que não existe não reserva nada;
 *   - o pedido cancelado devolve o uso; o teto por cliente vale;
 *   - a gaveta simula sem gravar, e quem varre códigos para no teto por origem.
 */
process.env.TZ = 'UTC';

import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { hojeNaLoja, somarDias } from '../src/services/core/CalendarioOperacional.js';
import { ratear } from '../src/services/core/CupomService.js';
import { orderAsFiscalOperation } from '../src/services/core/OrderInvoiceService.js';
import { cancelOrder } from '../src/services/core/StorefrontService.js';
import { loginForTest } from './helpers/auth.js';
import { abrirParaVisitante, VISITANTE } from './helpers/lojaAberta.js';

const app = createApp();

let gerente: { Authorization: string };
let gringa: string;
let pj: string;
let n = 0;

function produto(companyId: string, precoCents: number, estoque = 20): string {
  n += 1;
  const id = randomUUID();
  const agora = new Date().toISOString();
  const db = getConnection();
  db.prepare(
    `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                price_cents, category, active, publish_online, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'UN', 1000, ?, 'Vestuário', 1, 1, ?, ?)`,
  ).run(id, companyId, `CUP-${n}`, `Item ${n}`, precoCents, agora, agora);
  db.prepare(
    'INSERT INTO core_stock (company_id, product_id, quantity, reserved, updated_at) VALUES (?, ?, ?, 0, ?)',
  ).run(companyId, id, estoque, agora);
  return id;
}

function promocao(companyId: string, productId: string, percentOff: number): void {
  getConnection()
    .prepare(
      `INSERT INTO core_promotions (id, company_id, product_id, percent_off, starts_at, active, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)`,
    )
    .run(randomUUID(), companyId, productId, percentOff, new Date(Date.now() - 3600_000).toISOString(), new Date().toISOString());
}

function criarCupom(corpo: Record<string, unknown>) {
  return request(app).post('/api/v1/core/coupons').set(gerente).send(corpo);
}

function comprar(
  items: { productId: string; quantity: number }[],
  couponCode?: string,
  email: string = VISITANTE.customerEmail,
) {
  return request(app)
    .post('/api/v1/loja/checkout')
    .set('Idempotency-Key', `cup-${randomUUID()}`)
    .send({
      customerName: 'Ana Visitante',
      customerDocument: VISITANTE.customerDocument,
      customerEmail: email,
      paymentMethod: 'pix',
      items,
      couponCode,
    });
}

function pedido(orderId: string) {
  return getConnection()
    .prepare('SELECT * FROM core_orders WHERE id = ?')
    .get(orderId) as Record<string, number | string | null>;
}

function itens(orderId: string) {
  return getConnection()
    .prepare(
      'SELECT unit_price_cents, quantity, total_cents, discount_cents FROM core_order_items WHERE order_id = ? ORDER BY rowid',
    )
    .all(orderId) as { unit_price_cents: number; quantity: number; total_cents: number; discount_cents: number }[];
}

function reservado(productId: string): number {
  return (
    getConnection().prepare('SELECT reserved FROM core_stock WHERE product_id = ?').get(productId) as {
      reserved: number;
    }
  ).reserved;
}

// O dia é o DA LOJA, a mesma régua do cupom (começa às 0h e termina às 23h59
// de Brasília). Contado em UTC, "ontem" das 21h à meia-noite de Brasília já é
// o dia de hoje na loja — e o cupom de ontem ainda vale.
const diasAtras = (d: number) => somarDias(hojeNaLoja(), -d);
const diasAFrente = (d: number) => somarDias(hojeNaLoja(), d);

beforeEach(async () => {
  resetDbForTests();
  n = 0;
  const res = await loginForTest(app, {
    userId: 'gerente-cupom',
    companyId: 'gringa-cupom',
    profileCodes: ['gerente_loja'],
  });
  gerente = { Authorization: `Bearer ${res.body.accessToken}` };
  gringa = res.body.company.id;
  const outra = await loginForTest(app, {
    userId: 'gerente-pj-cupom',
    companyId: 'pj-cupom',
    profileCodes: ['gerente_loja'],
  });
  pj = outra.body.company.id;
  abrirParaVisitante(gringa, pj);
});

afterEach(() => {
  delete process.env.DEVORA_PORTAL_CUPONS_ERRADOS_POR_ORIGEM_HORA;
});

describe('a gestão cria, confere e encerra', () => {
  it('cria com o código normalizado e os padrões seguros', async () => {
    const res = await criarCupom({ code: ' bemvindo10 ', percentOff: 10, description: 'Boas-vindas' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      code: 'BEMVINDO10',
      percent_off: 10,
      max_uses_per_customer: 1,
      accumulates_with_promotions: 0,
      active: 1,
    });
    const trilha = getConnection()
      .prepare("SELECT 1 AS n FROM core_audit_log WHERE action = 'coupon.create' AND entity_id = ?")
      .get(res.body.id);
    expect(trilha).toBeTruthy();
  });

  it('recusa o que não é cupom', async () => {
    expect((await criarCupom({ code: 'A', percentOff: 10 })).status).toBe(400);
    expect((await criarCupom({ code: 'CEM', percentOff: 100 })).status).toBe(400);
    expect((await criarCupom({ code: 'ZERO', percentOff: 0 })).status).toBe(400);
    expect((await criarCupom({ code: 'DOIS', percentOff: 10, amountCents: 500 })).status).toBe(400);
    expect((await criarCupom({ code: 'NADA' })).status).toBe(400);
    // Valor fixo precisa de pedido mínimo acima dele: senão pagaria o pedido.
    expect((await criarCupom({ code: 'TRINTA', amountCents: 3000, minOrderCents: 3000 })).status).toBe(400);
    expect(
      (await criarCupom({ code: 'AVESSO', percentOff: 10, startsAt: diasAFrente(5), endsAt: diasAFrente(1) }))
        .status,
    ).toBe(400);
  });

  it('código repetido na empresa → 409; na OUTRA empresa pode', async () => {
    await criarCupom({ code: 'VERAO', percentOff: 10 });
    const repetido = await criarCupom({ code: 'verao', percentOff: 5 });
    expect(repetido.status).toBe(409);
    expect(repetido.body.error.code).toBe('CORE_COUPON_CODE_TAKEN');
  });

  it('lista com os usos, e encerrar desliga na hora', async () => {
    const { body } = await criarCupom({ code: 'LISTA', percentOff: 10 });
    const item = produto(gringa, 10000);
    await comprar([{ productId: item, quantity: 1 }], 'LISTA');

    const lista = await request(app).get('/api/v1/core/coupons').set(gerente);
    expect(lista.body.items[0]).toMatchObject({ code: 'LISTA', uses: 1, discount_total_cents: 1000 });

    const fim = await request(app).delete(`/api/v1/core/coupons/${body.id}`).set(gerente);
    expect(fim.status).toBe(200);
    expect(fim.body.active).toBe(0);

    const depois = await comprar([{ productId: item, quantity: 1 }], 'LISTA', 'outra@exemplo.com');
    expect(depois.status).toBe(400);
    expect(depois.body.error.code).toBe('CHECKOUT_CUPOM_INVALIDO');
  });
});

describe('o checkout aplica, rateia e grava o retrato', () => {
  it('10 % sobre os itens: pedido líquido, itens rateados, uso gravado, NF-e com vDesc', async () => {
    await criarCupom({ code: 'DEZ', percentOff: 10 });
    const a = produto(gringa, 10000);
    const b = produto(gringa, 5000);

    const res = await comprar(
      [
        { productId: a, quantity: 1 },
        { productId: b, quantity: 2 },
      ],
      'dez',
    );
    expect(res.status).toBe(201);
    const id = res.body.orders[0].id as string;
    const p = pedido(id);
    expect(p).toMatchObject({ coupon_code: 'DEZ', discount_cents: 2000, items_cents: 18000 });
    expect(Number(p.total_cents)).toBe(18000 + Number(p.shipping_cents));

    const linhas = itens(id);
    expect(linhas.reduce((s, l) => s + l.discount_cents, 0)).toBe(2000);
    expect(linhas.reduce((s, l) => s + l.total_cents, 0)).toBe(18000);
    for (const l of linhas) {
      expect(l.total_cents).toBe(l.unit_price_cents * l.quantity - l.discount_cents);
    }

    const uso = getConnection()
      .prepare('SELECT status, discount_cents, customer_email FROM core_coupon_redemptions WHERE order_id = ?')
      .get(id);
    expect(uso).toEqual({ status: 'ativo', discount_cents: 2000, customer_email: VISITANTE.customerEmail });

    const fiscal = orderAsFiscalOperation(gringa, id);
    expect(fiscal).toMatchObject({ subtotalCents: 20000, discountCents: 2000, totalCents: 18000 });
    expect(fiscal.items.reduce((s, i) => s + i.discountCents, 0)).toBe(2000);
    expect(fiscal.items.reduce((s, i) => s + i.totalCents, 0)).toBe(18000);

    // A ficha do pedido no ERP diz o cupom.
    const ficha = await request(app).get(`/api/v1/core/orders/${id}`).set(gerente);
    expect(ficha.body).toMatchObject({ coupon_code: 'DEZ', discount_cents: 2000 });
  });

  it('valor fixo com pedido mínimo', async () => {
    await criarCupom({ code: 'TRINTA', amountCents: 3000, minOrderCents: 5000 });
    const item = produto(gringa, 6000);
    const res = await comprar([{ productId: item, quantity: 1 }], 'TRINTA');
    expect(res.status).toBe(201);
    expect(pedido(res.body.orders[0].id)).toMatchObject({ discount_cents: 3000, items_cents: 3000 });
  });

  it('código que não existe → 400 com o código, e NADA é reservado ou numerado', async () => {
    const item = produto(gringa, 10000);
    const res = await comprar([{ productId: item, quantity: 1 }], 'NAOEXISTE');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CHECKOUT_CUPOM_INVALIDO');
    expect(res.body.error.message).toContain('NAOEXISTE');
    expect(reservado(item)).toBe(0);
    expect(getConnection().prepare('SELECT COUNT(*) AS n FROM core_orders').get()).toEqual({ n: 0 });
  });

  it('pedido mínimo não atingido → 400 dizendo quanto falta', async () => {
    await criarCupom({ code: 'MINIMO', percentOff: 10, minOrderCents: 30000 });
    const item = produto(gringa, 10000);
    const res = await comprar([{ productId: item, quantity: 1 }], 'MINIMO');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CHECKOUT_CUPOM_PEDIDO_MINIMO');
    expect(res.body.error.message).toContain('Faltam R$ 200,00');
    expect(reservado(item)).toBe(0);
  });

  it('vencido e ainda não começado → recusa com a data', async () => {
    await criarCupom({ code: 'VELHO', percentOff: 10, startsAt: diasAtras(5), endsAt: diasAtras(1) });
    await criarCupom({ code: 'NOVO', percentOff: 10, startsAt: diasAFrente(2) });
    const item = produto(gringa, 10000);
    expect((await comprar([{ productId: item, quantity: 1 }], 'VELHO')).body.error.code).toBe(
      'CHECKOUT_CUPOM_VENCIDO',
    );
    expect((await comprar([{ productId: item, quantity: 1 }], 'NOVO')).body.error.code).toBe(
      'CHECKOUT_CUPOM_AINDA_NAO_VALE',
    );
  });

  it('uma vez por cliente; o pedido cancelado devolve o uso', async () => {
    await criarCupom({ code: 'UNICO', percentOff: 10 });
    const item = produto(gringa, 10000);
    const primeiro = await comprar([{ productId: item, quantity: 1 }], 'UNICO');
    expect(primeiro.status).toBe(201);

    const segundo = await comprar([{ productId: item, quantity: 1 }], 'UNICO');
    expect(segundo.status).toBe(409);
    expect(segundo.body.error.code).toBe('CHECKOUT_CUPOM_JA_USADO');

    cancelOrder({ companyId: gringa, orderId: primeiro.body.orders[0].id, reason: 'desistiu' });
    const denovo = await comprar([{ productId: item, quantity: 1 }], 'UNICO');
    expect(denovo.status).toBe(201);
  });

  it('teto de usos no total → esgotado para o próximo cliente', async () => {
    await criarCupom({ code: 'PRIMEIROS', percentOff: 10, maxUses: 1, maxUsesPerCustomer: null });
    const item = produto(gringa, 10000);
    expect((await comprar([{ productId: item, quantity: 1 }], 'PRIMEIROS', 'a@exemplo.com')).status).toBe(201);
    const outro = await comprar([{ productId: item, quantity: 1 }], 'PRIMEIROS', 'b@exemplo.com');
    expect(outro.status).toBe(409);
    expect(outro.body.error.code).toBe('CHECKOUT_CUPOM_ESGOTADO');
  });

  it('NÃO cumulativo (padrão): item em promoção fica fora; cumulativo alcança os dois', async () => {
    await criarCupom({ code: 'SOCHEIO', percentOff: 10, maxUsesPerCustomer: null });
    await criarCupom({ code: 'TUDO', percentOff: 10, accumulatesWithPromotions: true, maxUsesPerCustomer: null });
    const emPromocao = produto(gringa, 10000);
    promocao(gringa, emPromocao, 20);
    const cheio = produto(gringa, 5000);

    const so = await comprar([{ productId: emPromocao, quantity: 1 }], 'SOCHEIO');
    expect(so.status).toBe(400);
    expect(so.body.error.code).toBe('CHECKOUT_CUPOM_SO_PRECO_CHEIO');

    const misto = await comprar(
      [
        { productId: emPromocao, quantity: 1 },
        { productId: cheio, quantity: 1 },
      ],
      'SOCHEIO',
    );
    expect(pedido(misto.body.orders[0].id).discount_cents).toBe(500);
    expect(itens(misto.body.orders[0].id)[0].discount_cents).toBe(0);

    const tudo = await comprar(
      [
        { productId: emPromocao, quantity: 1 },
        { productId: cheio, quantity: 1 },
      ],
      'TUDO',
    );
    // 10 % de (8000 + 5000).
    expect(pedido(tudo.body.orders[0].id).discount_cents).toBe(1300);
  });

  it('carrinho de duas lojas: o cupom da Gringa desconta só o pedido da Gringa', async () => {
    await criarCupom({ code: 'GRINGA10', percentOff: 10 });
    const daGringa = produto(gringa, 10000);
    const doPj = produto(pj, 10000);
    const res = await comprar(
      [
        { productId: daGringa, quantity: 1 },
        { productId: doPj, quantity: 1 },
      ],
      'GRINGA10',
    );
    expect(res.status).toBe(201);
    const porEmpresa = Object.fromEntries(
      (res.body.orders as { id: string; company_id: string }[]).map((o) => [
        o.company_id,
        pedido(o.id).discount_cents,
      ]),
    );
    expect(porEmpresa).toEqual({ [gringa]: 1000, [pj]: 0 });
  });
});

describe('a gaveta simula, e o teto por origem para quem varre códigos', () => {
  it('simular devolve o desconto por loja e não grava nada', async () => {
    await criarCupom({ code: 'SIMULA', percentOff: 10 });
    const item = produto(gringa, 10000);
    const res = await request(app)
      .post('/api/v1/loja/checkout/cupom')
      .send({ code: 'simula', items: [{ productId: item, quantity: 2 }] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      code: 'SIMULA',
      discountCents: 2000,
      lojas: [{ companyId: gringa, discountCents: 2000 }],
    });
    expect(
      getConnection().prepare('SELECT COUNT(*) AS n FROM core_coupon_redemptions').get(),
    ).toEqual({ n: 0 });
    expect(reservado(item)).toBe(0);
  });

  it('no teto de códigos errados, a origem recebe 429 — até o código certo', async () => {
    process.env.DEVORA_PORTAL_CUPONS_ERRADOS_POR_ORIGEM_HORA = '3';
    await criarCupom({ code: 'CERTO', percentOff: 10 });
    const item = produto(gringa, 10000);
    const tentar = (code: string) =>
      request(app)
        .post('/api/v1/loja/checkout/cupom')
        .send({ code, items: [{ productId: item, quantity: 1 }] });

    for (const code of ['AAA1', 'AAA2', 'AAA3']) {
      expect((await tentar(code)).status).toBe(400);
    }
    const bloqueada = await tentar('AAA4');
    expect(bloqueada.status).toBe(429);
    expect(bloqueada.body.error.code).toBe('PORTAL_LIMITE_CUPOM');
    expect((await tentar('CERTO')).status).toBe(429);
  });

  it('acertar o código não gasta a vaga', async () => {
    process.env.DEVORA_PORTAL_CUPONS_ERRADOS_POR_ORIGEM_HORA = '2';
    await criarCupom({ code: 'CERTO', percentOff: 10 });
    const item = produto(gringa, 10000);
    for (let i = 0; i < 5; i += 1) {
      const r = await request(app)
        .post('/api/v1/loja/checkout/cupom')
        .send({ code: 'CERTO', items: [{ productId: item, quantity: 1 }] });
      expect(r.status).toBe(200);
    }
  });
});

describe('o rateio', () => {
  it('soma exata, e nenhuma linha fica com zero', () => {
    // O chamador (`aplicarCupom`) garante desconto <= soma - linhas: é o teto
    // que deixa um centavo em cada linha. Os casos respeitam esse contrato —
    // [6, [3, 3, 3]] é o limite exato.
    const casos: [number, number[]][] = [
      [100, [1, 999]],
      [998, [1, 999]],
      [2000, [10000, 10000]],
      [6, [3, 3, 3]],
      [5, [3, 3, 3]],
      [1, [5000, 0, 5000]],
    ];
    for (const [desconto, valores] of casos) {
      const partes = ratear(desconto, valores);
      expect(partes.reduce((s, p) => s + p, 0)).toBe(desconto);
      partes.forEach((p, i) => {
        if (valores[i] > 0) expect(p).toBeLessThanOrEqual(valores[i] - 1);
        else expect(p).toBe(0);
      });
    }
  });
});
