/**
 * PROMOÇÃO QUE SE EDITA, TEM HORÁRIO E TEM TETO — GAP-PRD-194.
 *
 * O que a auditoria mediu: `PUT/PATCH /core/promotions/:id` → 404 (mudar era
 * encerrar e recriar), sem faixa de horário ("happy hour") e sem limite de
 * unidades ("as 50 primeiras"). A decisão era do dono; o software agora
 * oferece o mecanismo, com o padrão que já valia (sem horário = o dia todo,
 * sem teto = sem limite).
 *
 * A PRIORIDADE ficou de fora de propósito, e isto também é cobrado: quando
 * duas promoções valem ao mesmo tempo, vale o MENOR preço — a oferta anunciada
 * obriga a loja (CDC, art. 30 e 35). A criação avisa a sobreposição.
 */
process.env.TZ = 'UTC';

import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { horaDaLoja } from '../src/services/core/CalendarioOperacional.js';
import { effectivePriceCents } from '../src/services/core/PricingService.js';
import { createSale } from '../src/services/core/SalesService.js';
import { cancelOrder, checkout } from '../src/services/core/StorefrontService.js';
import { loginForTest } from './helpers/auth.js';
import { VISITANTE } from './helpers/lojaAberta.js';

const app = createApp();
const PRECO = 10000;

let gerente: { Authorization: string };
let loja: string;

function produto(codigo = 'LIM-1', estoque = 20): string {
  const id = randomUUID();
  const agora = new Date().toISOString();
  const db = getConnection();
  db.prepare(
    `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                price_cents, category, active, publish_online, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'UN', 4000, ?, 'Vestuário', 1, 1, ?, ?)`,
  ).run(id, loja, codigo, `Produto ${codigo}`, PRECO, agora, agora);
  db.prepare(
    'INSERT INTO core_stock (company_id, product_id, quantity, reserved, updated_at) VALUES (?, ?, ?, 0, ?)',
  ).run(loja, id, estoque, agora);
  return id;
}

function criar(corpo: Record<string, unknown>) {
  return request(app).post('/api/v1/core/promotions').set(gerente).send(corpo);
}

function editar(id: string, corpo: Record<string, unknown>, quem = gerente) {
  return request(app).patch(`/api/v1/core/promotions/${id}`).set(quem).send(corpo);
}

function preco(productId: string, unidades = 1) {
  return effectivePriceCents(loja, productId, PRECO, 'Vestuário', { unidadesDaLinha: unidades })
    .priceCents;
}

let n = 0;
function comprar(productId: string, quantidade: number) {
  n += 1;
  const [pedido] = checkout({
    idempotencyKey: `lim-${n}`,
    customerName: 'Ana Visitante',
    customerDocument: VISITANTE.customerDocument,
    customerEmail: VISITANTE.customerEmail,
    paymentMethod: 'pix',
    items: [{ productId, quantity: quantidade }],
  });
  return pedido;
}

function itemDoPedido(orderId: string) {
  return getConnection()
    .prepare('SELECT unit_price_cents, promotion_id FROM core_order_items WHERE order_id = ?')
    .get(orderId) as { unit_price_cents: number; promotion_id: string | null };
}

beforeEach(async () => {
  resetDbForTests();
  n = 0;
  const res = await loginForTest(app, {
    userId: 'gerente-limite',
    companyId: 'loja-limite',
    profileCodes: ['gerente_loja'],
  });
  gerente = { Authorization: `Bearer ${res.body.accessToken}` };
  loja = res.body.company.id;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('edição (PATCH) em vez de encerrar e recriar', () => {
  it('muda o percentual, o preço acompanha, e a trilha guarda o antes e o depois', async () => {
    const item = produto();
    const { body } = await criar({ productId: item, percentOff: 10 });
    expect(preco(item)).toBe(9000);

    const res = await editar(body.id, { percentOff: 20 });
    expect(res.status).toBe(200);
    expect(res.body.mudancas.percent_off).toEqual({ de: 10, para: 20 });
    expect(preco(item)).toBe(8000);

    const trilha = getConnection()
      .prepare("SELECT detail FROM core_audit_log WHERE action = 'promotion.update' AND entity_id = ?")
      .get(body.id) as { detail: string };
    expect(JSON.parse(trilha.detail).mudancas.percent_off).toEqual({ de: 10, para: 20 });
  });

  it('a edição passa pela MESMA conferência da criação (150 % → 400, nada muda)', async () => {
    const item = produto();
    const { body } = await criar({ productId: item, percentOff: 10 });
    const res = await editar(body.id, { percentOff: 150 });
    expect(res.status).toBe(400);
    expect(preco(item)).toBe(9000);
  });

  it('trocar o alvo para a categoria troca em bloco (o produto sai)', async () => {
    const item = produto();
    const { body } = await criar({ productId: item, percentOff: 10 });
    const res = await editar(body.id, { productId: null, category: 'vestuário' });
    expect(res.status).toBe(200);
    const linha = getConnection()
      .prepare('SELECT product_id, category FROM core_promotions WHERE id = ?')
      .get(body.id) as { product_id: string | null; category: string };
    expect(linha).toEqual({ product_id: null, category: 'Vestuário' });
  });

  it('promoção encerrada não se edita → 409', async () => {
    const item = produto();
    const { body } = await criar({ productId: item, percentOff: 10 });
    await request(app).delete(`/api/v1/core/promotions/${body.id}`).set(gerente);
    const res = await editar(body.id, { percentOff: 20 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CORE_PROMOTION_ENDED');
  });

  it('promoção de outra empresa → 404', async () => {
    const item = produto();
    const { body } = await criar({ productId: item, percentOff: 10 });
    const outra = await loginForTest(app, {
      userId: 'gerente-outra',
      companyId: 'outra-limite',
      profileCodes: ['gerente_loja'],
    });
    const res = await editar(body.id, { percentOff: 20 }, {
      Authorization: `Bearer ${outra.body.accessToken}`,
    });
    expect(res.status).toBe(404);
    expect(preco(item)).toBe(9000);
  });
});

describe('faixa de horário, no relógio da loja', () => {
  it('vale do início (inclusivo) até o fim (exclusivo), e não fora dele', async () => {
    const item = produto();
    const t0 = new Date('2026-09-09T15:00:00.000Z');
    const umaHora = 3600_000;
    const inicio = horaDaLoja(t0);
    const fim = horaDaLoja(new Date(t0.getTime() + 2 * umaHora));

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(t0);
    const res = await criar({ productId: item, percentOff: 10, startsTime: inicio, endsTime: fim });
    expect(res.status).toBe(201);

    expect(preco(item)).toBe(9000);
    vi.setSystemTime(new Date(t0.getTime() + umaHora));
    expect(preco(item)).toBe(9000);
    vi.setSystemTime(new Date(t0.getTime() + 2 * umaHora));
    expect(preco(item)).toBe(PRECO);
    vi.setSystemTime(new Date(t0.getTime() + 22 * umaHora));
    expect(preco(item)).toBe(PRECO);
  });

  it('fim antes do início, ou hora que não é hora → 400', async () => {
    const item = produto();
    const invertida = await criar({
      productId: item,
      percentOff: 10,
      startsTime: '20:00',
      endsTime: '18:00',
    });
    expect(invertida.status).toBe(400);
    expect(invertida.body.error.code).toBe('CORE_PROMOTION_HOURS');
    expect((await criar({ productId: item, percentOff: 10, startsTime: '25:00' })).status).toBe(400);
  });
});

describe('estoque promocional: as N unidades, somando loja online e balcão', () => {
  it('a linha que cabe no saldo leva a promoção; a que não cabe sai sem ela; cancelar devolve', async () => {
    const item = produto();
    const { body } = await criar({ productId: item, percentOff: 10, maxUnits: 2 });

    const primeiro = comprar(item, 1);
    expect(itemDoPedido(primeiro.id)).toEqual({ unit_price_cents: 9000, promotion_id: body.id });

    // Sobra 1: a linha de 2 NÃO cabe e sai pelo preço cheio — inteira.
    const grande = comprar(item, 2);
    expect(itemDoPedido(grande.id)).toEqual({ unit_price_cents: PRECO, promotion_id: null });

    const segundo = comprar(item, 1);
    expect(itemDoPedido(segundo.id).unit_price_cents).toBe(9000);

    // Esgotou: a vitrine já não anuncia.
    expect(preco(item)).toBe(PRECO);
    const lista = await request(app).get('/api/v1/core/promotions').set(gerente);
    expect(lista.body.items[0]).toMatchObject({ max_units: 2, units_used: 2, units_left: 0 });

    // O pedido cancelado devolve a unidade ao saldo da promoção.
    cancelOrder({ companyId: loja, orderId: primeiro.id, reason: 'teste' });
    expect(preco(item)).toBe(9000);
  });

  it('o BALCÃO consome o mesmo saldo', async () => {
    const item = produto();
    const { body } = await criar({ productId: item, percentOff: 10, maxUnits: 1 });

    const { sale } = createSale({
      companyId: loja,
      userId: 'u-1',
      idempotencyKey: 'balcao-1',
      items: [{ productId: item, quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: 9000 }],
    });
    const linha = getConnection()
      .prepare('SELECT unit_price_cents, promotion_id FROM core_sale_items WHERE sale_id = ?')
      .get(sale.id) as { unit_price_cents: number; promotion_id: string };
    expect(linha).toEqual({ unit_price_cents: 9000, promotion_id: body.id });

    // A loja online já não vê a promoção.
    expect(preco(item)).toBe(PRECO);
    const pedido = comprar(item, 1);
    expect(itemDoPedido(pedido.id).unit_price_cents).toBe(PRECO);
  });

  it('teto zero ou negativo → 400', async () => {
    const item = produto();
    expect((await criar({ productId: item, percentOff: 10, maxUnits: 0 })).status).toBe(400);
    expect((await criar({ productId: item, percentOff: 10, maxUnits: -3 })).status).toBe(400);
  });
});

describe('sobreposição: vale o menor preço, e a criação avisa', () => {
  it('a segunda promoção sobre o mesmo produto volta com o aviso; o preço é o menor', async () => {
    const item = produto();
    const primeira = await criar({ category: 'Vestuário', percentOff: 10 });
    expect(primeira.body.sobreposicoes).toEqual([]);

    const segunda = await criar({ productId: item, percentOff: 25 });
    expect(segunda.status).toBe(201);
    expect(segunda.body.sobreposicoes).toHaveLength(1);
    expect(segunda.body.sobreposicoes[0].alvo).toContain('Vestuário');
    expect(preco(item)).toBe(7500);
  });
});
