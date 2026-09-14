/**
 * A DEVOLUÇÃO DEVOLVE O QUE ENTROU — nem um centavo a mais (GAP-PRD-009,
 * GAP-PRD-050).
 *
 * ============================================================================
 * O QUE ACONTECIA
 * ============================================================================
 *
 * O valor de cada linha devolvida era `round(item.total_cents × qtd / vendida)`.
 * Duas falhas na mesma conta:
 *
 *   GAP-PRD-009  `item.total_cents` é líquido só do desconto DA LINHA. O
 *                desconto do RODAPÉ (cabeçalho) ficava de fora: a venda de
 *                2 × R$ 100 com R$ 20 de desconto (R$ 180 pagos) devolvia
 *                R$ 200 — R$ 20 saíam do caixa a mais, com 201.
 *
 *   GAP-PRD-050  cada devolução parcial arredondava sozinha, sem olhar o que já
 *                tinha voltado: a linha de 3 un. que custou R$ 29,99 devolvida
 *                1 + 1 + 1 somava R$ 30,00.
 *
 * ============================================================================
 * A REGRA
 * ============================================================================
 *
 *  - O desconto do rodapé é rateado nas linhas pela proporção de cada uma no
 *    subtotal; o resto de centavos vai, um por linha, para as maiores frações
 *    (e, no empate, para a primeira). A soma dos líquidos é o subtotal menos o
 *    desconto — exatamente.
 *  - Cada devolução parcial vale o ACUMULADO proporcional menos o que já voltou;
 *    a que esgota a linha devolve exatamente o que resta.
 *  - E a soma de todas as devoluções de uma venda nunca passa do total dela:
 *    passar é recusado com código nomeado.
 *
 * Todo número esperado aqui está escrito à mão.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();
let auth: { Authorization: string };

beforeEach(async () => {
  resetDbForTests();
  const res = await loginForTest(app, {
    userId: 'gerente-centavos',
    companyId: 'loja-centavos',
    profileCodes: ['gerente_loja'],
  });
  auth = { Authorization: `Bearer ${res.body.accessToken}` };
});

async function produto(nome: string, precoCents: number): Promise<string> {
  const p = await request(app)
    .post('/api/v1/core/products')
    .set(auth)
    .send({ name: nome, priceCents: precoCents });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  await request(app).post('/api/v1/core/stock/movements').set(auth).send({
    productId: p.body.id,
    movementType: 'in',
    quantity: 50,
    referenceType: 'entrada',
    referenceId: `carga-${p.body.id}`,
  });
  return p.body.id as string;
}

async function vender(corpo: {
  items: { productId: string; quantity: number; discountCents?: number }[];
  discountCents?: number;
  pagoCents: number;
}) {
  const res = await request(app)
    .post('/api/v1/core/sales')
    .set(auth)
    .set('Idempotency-Key', randomUUID())
    .send({
      items: corpo.items,
      discountCents: corpo.discountCents,
      payments: [{ method: 'dinheiro', amountCents: corpo.pagoCents }],
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; total_cents: number };
}

interface Devolvivel {
  sale_item_id: string;
  product_id: string;
  quantity: number;
  total_cents: number;
  net_total_cents: number;
  returned_cents: number;
}

async function devolviveis(saleId: string): Promise<Devolvivel[]> {
  const res = await request(app).get(`/api/v1/core/sales/${saleId}/returnable`).set(auth);
  expect(res.status).toBe(200);
  return res.body.items as Devolvivel[];
}

function devolver(saleId: string, items: { saleItemId: string; quantity: number }[]) {
  return request(app)
    .post('/api/v1/core/sale-returns')
    .set(auth)
    .send({ saleId, reason: 'Cliente devolveu', refundMethod: 'pix', items });
}

/** Tudo o que saiu do financeiro por devoluções desta venda. */
function saidasDaVenda(saleId: string): number {
  const linha = getConnection()
    .prepare(
      `SELECT COALESCE(SUM(e.amount_cents), 0) AS total
         FROM core_finance_entries e
         JOIN core_sale_returns r ON r.id = e.origin_id
        WHERE e.origin_type = 'sale_return' AND e.direction = 'out' AND r.sale_id = ?`,
    )
    .get(saleId) as { total: number };
  return linha.total;
}

// ============================================================================

describe('GAP-PRD-009 — o desconto do rodapé é rateado nas linhas devolvidas', () => {
  it('venda de R$ 200 com R$ 20 de desconto: devolver tudo devolve R$ 180, e não R$ 200', async () => {
    const camisa = await produto('Camisa', 10000);
    const venda = await vender({
      items: [{ productId: camisa, quantity: 2 }],
      discountCents: 2000,
      pagoCents: 18000,
    });
    expect(venda.total_cents).toBe(18000);

    const [linha] = await devolviveis(venda.id);
    // A tela lê o líquido daqui: R$ 200 da linha menos os R$ 20 do rodapé.
    expect(linha.total_cents).toBe(20000);
    expect(linha.net_total_cents).toBe(18000);
    expect(linha.returned_cents).toBe(0);

    const res = await devolver(venda.id, [{ saleItemId: linha.sale_item_id, quantity: 2 }]);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.total_cents).toBe(18000);
    expect(res.body.items[0].total_cents).toBe(18000);
    expect(res.body.items[0].unit_price_cents).toBe(9000);
    expect(saidasDaVenda(venda.id)).toBe(18000);
  });

  it('devolução parcial leva a parte proporcional do desconto: 9.000 + 9.000', async () => {
    const camisa = await produto('Camisa', 10000);
    const venda = await vender({
      items: [{ productId: camisa, quantity: 2 }],
      discountCents: 2000,
      pagoCents: 18000,
    });
    const [linha] = await devolviveis(venda.id);

    const primeira = await devolver(venda.id, [{ saleItemId: linha.sale_item_id, quantity: 1 }]);
    expect(primeira.status, JSON.stringify(primeira.body)).toBe(201);
    expect(primeira.body.total_cents).toBe(9000);

    const [depois] = await devolviveis(venda.id);
    expect(depois.returned_cents).toBe(9000);

    const segunda = await devolver(venda.id, [{ saleItemId: linha.sale_item_id, quantity: 1 }]);
    expect(segunda.status, JSON.stringify(segunda.body)).toBe(201);
    expect(segunda.body.total_cents).toBe(9000);
    expect(saidasDaVenda(venda.id)).toBe(18000);
  });

  it('três linhas e R$ 1,00 de desconto: o centavo que sobra vai para a maior fração', async () => {
    /*
      Subtotal R$ 70,00 (10 + 20 + 40), desconto R$ 1,00 = 100 centavos.
        linha 1: 100 × 1000/7000 = 14,2857 → 14
        linha 2: 100 × 2000/7000 = 28,5714 → 28 (+1: maior fração) = 29
        linha 3: 100 × 4000/7000 = 57,1428 → 57
      14 + 29 + 57 = 100. Líquidos: 986, 1971, 3943 — somam 6900 = total.
    */
    const a = await produto('Meia', 1000);
    const b = await produto('Cinto', 2000);
    const c = await produto('Bolsa', 4000);
    const venda = await vender({
      items: [
        { productId: a, quantity: 1 },
        { productId: b, quantity: 1 },
        { productId: c, quantity: 1 },
      ],
      discountCents: 100,
      pagoCents: 6900,
    });
    expect(venda.total_cents).toBe(6900);

    const linhas = await devolviveis(venda.id);
    const porProduto = new Map(linhas.map((l) => [l.product_id, l]));
    expect(porProduto.get(a)!.net_total_cents).toBe(986);
    expect(porProduto.get(b)!.net_total_cents).toBe(1971);
    expect(porProduto.get(c)!.net_total_cents).toBe(3943);

    const valores: number[] = [];
    for (const produtoId of [a, b, c]) {
      const res = await devolver(venda.id, [
        { saleItemId: porProduto.get(produtoId)!.sale_item_id, quantity: 1 },
      ]);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      valores.push(res.body.total_cents as number);
    }
    expect(valores).toEqual([986, 1971, 3943]);
    expect(saidasDaVenda(venda.id)).toBe(6900);
  });

  it('a soma das devoluções nunca passa do total da venda — o excesso é recusado com nome', async () => {
    /*
      Uma devolução gravada pela conta antiga (bruta do desconto) já devolveu
      R$ 100 da linha A. Devolver a linha B pelo líquido (R$ 90) somaria
      R$ 190 contra R$ 180 pagos: recusado, dizendo quanto ainda resta.
    */
    const a = await produto('Tênis A', 10000);
    const b = await produto('Tênis B', 10000);
    const venda = await vender({
      items: [
        { productId: a, quantity: 1 },
        { productId: b, quantity: 1 },
      ],
      discountCents: 2000,
      pagoCents: 18000,
    });
    const linhas = await devolviveis(venda.id);
    const linhaA = linhas.find((l) => l.product_id === a)!;
    const linhaB = linhas.find((l) => l.product_id === b)!;

    const db = getConnection();
    const antiga = randomUUID();
    const agora = new Date().toISOString();
    db.prepare(
      `INSERT INTO core_sale_returns
         (id, company_id, number, sale_id, reason, total_cents, refund_method, created_by, created_at)
       VALUES (?, 'loja-centavos', 900, ?, 'conta antiga', 10000, 'pix', NULL, ?)`,
    ).run(antiga, venda.id, agora);
    db.prepare(
      `INSERT INTO core_sale_return_items
         (id, return_id, company_id, sale_item_id, product_id, quantity, unit_price_cents,
          total_cents, restock, created_at)
       VALUES (?, ?, 'loja-centavos', ?, ?, 1, 10000, 10000, 1, ?)`,
    ).run(randomUUID(), antiga, linhaA.sale_item_id, a, agora);

    const res = await devolver(venda.id, [{ saleItemId: linhaB.sale_item_id, quantity: 1 }]);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe('CORE_RETURN_EXCEEDS_PAID');
    expect(res.body.error.message).toMatch(/R\$ 80,00/);

    // Nada da recusa ficou gravado.
    const devolucoes = db
      .prepare('SELECT COUNT(*) AS n FROM core_sale_returns WHERE sale_id = ?')
      .get(venda.id) as { n: number };
    expect(devolucoes.n).toBe(1);
  });
});

// ============================================================================

describe('GAP-PRD-050 — a devolução parcial não acumula resíduo', () => {
  it('linha de 3 un. que custou R$ 29,99, devolvida 1 + 1 + 1: 1.000 + 999 + 1.000 = 2.999', async () => {
    /*
      R$ 10,00 × 3 com R$ 0,01 de desconto na linha = 2999.
        1ª: acumulado 1/3 → round(999,67)  = 1000; já voltou 0    → 1000
        2ª: acumulado 2/3 → round(1999,33) = 1999; já voltou 1000 →  999
        3ª: esgota a linha → 2999;               já voltou 1999 → 1000
    */
    const bala = await produto('Pacote de bala', 1000);
    const venda = await vender({
      items: [{ productId: bala, quantity: 3, discountCents: 1 }],
      pagoCents: 2999,
    });
    expect(venda.total_cents).toBe(2999);
    const [linha] = await devolviveis(venda.id);
    expect(linha.total_cents).toBe(2999);

    const valores: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const res = await devolver(venda.id, [{ saleItemId: linha.sale_item_id, quantity: 1 }]);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      valores.push(res.body.total_cents as number);
    }
    expect(valores).toEqual([1000, 999, 1000]);
    expect(saidasDaVenda(venda.id)).toBe(2999);

    const soma = getConnection()
      .prepare(
        'SELECT COALESCE(SUM(total_cents), 0) AS t FROM core_sale_return_items WHERE sale_item_id = ?',
      )
      .get(linha.sale_item_id) as { t: number };
    expect(soma.t).toBe(2999);
  });

  it('3 + 3 da linha de 6 un. por R$ 10,01: 501 + 500, e não 501 + 501', async () => {
    /*
      R$ 1,67 × 6 com R$ 0,01 de desconto na linha = 1001.
        1ª: acumulado 3/6 → round(500,5) = 501; já voltou 0   → 501
        2ª: esgota a linha → 1001;              já voltou 501 → 500
      A conta antiga arredondava as duas metades sozinhas: 501 + 501 = 1002.
    */
    const bala = await produto('Bala avulsa', 167);
    const venda = await vender({
      items: [{ productId: bala, quantity: 6, discountCents: 1 }],
      pagoCents: 1001,
    });
    expect(venda.total_cents).toBe(1001);
    const [linha] = await devolviveis(venda.id);

    const primeira = await devolver(venda.id, [{ saleItemId: linha.sale_item_id, quantity: 3 }]);
    expect(primeira.status, JSON.stringify(primeira.body)).toBe(201);
    expect(primeira.body.total_cents).toBe(501);
    const resto = await devolver(venda.id, [{ saleItemId: linha.sale_item_id, quantity: 3 }]);
    expect(resto.status, JSON.stringify(resto.body)).toBe(201);
    expect(resto.body.total_cents).toBe(500);
    expect(saidasDaVenda(venda.id)).toBe(1001);
  });

  it('a mesma linha duas vezes no MESMO pedido também soma certo: 501 + 500', async () => {
    const bala = await produto('Bala avulsa', 167);
    const venda = await vender({
      items: [{ productId: bala, quantity: 6, discountCents: 1 }],
      pagoCents: 1001,
    });
    const [linha] = await devolviveis(venda.id);

    const res = await devolver(venda.id, [
      { saleItemId: linha.sale_item_id, quantity: 3 },
      { saleItemId: linha.sale_item_id, quantity: 3 },
    ]);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.total_cents).toBe(1001);
    const valores = (res.body.items as { total_cents: number }[]).map((i) => i.total_cents).sort();
    expect(valores).toEqual([500, 501]);
  });
});
