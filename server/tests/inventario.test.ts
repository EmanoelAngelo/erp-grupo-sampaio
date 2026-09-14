/**
 * Inventário: contagem e acerto.
 *
 * O acerto é a ÚNICA entrada de estoque sem documento por trás — não há nota,
 * venda nem OS. É alguém afirmando que o saldo é outro. Duas armadilhas, e as
 * duas custam mercadoria de verdade:
 *
 *   NULO NÃO É ZERO         produto que a contagem não alcançou não pode ser
 *                           tratado como "achei nenhum": zeraria o estoque de
 *                           tudo que ficou fora do corredor contado hoje.
 *
 *   DIFERENÇA, NÃO TROCA    entre contar e aplicar a loja continua vendendo.
 *                           Gravar o contado como saldo novo devolveria ao
 *                           estoque o que foi vendido no intervalo.
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
let companyId: string;

beforeEach(async () => {
  resetDbForTests();
  const res = await loginForTest(app, {
    userId: 'gerente-inv',
    companyId: 'loja-inventario',
    profileCodes: ['gerente_loja'],
  });
  auth = { Authorization: `Bearer ${res.body.accessToken}` };
  companyId = res.body.company.id;
});

async function produto(nome: string, qtd: number) {
  const p = await request(app)
    .post('/api/v1/core/products')
    .set(auth)
    .send({ name: nome, priceCents: 10000 });
  if (qtd > 0) {
    await request(app).post('/api/v1/core/stock/movements').set(auth).send({
      productId: p.body.id,
      movementType: 'in',
      quantity: qtd,
      referenceType: 'entrada',
      referenceId: `carga-${p.body.id}`,
    });
  }
  return p.body.id as string;
}

function saldo(productId: string): number {
  const row = getConnection()
    .prepare('SELECT quantity FROM core_stock WHERE company_id = ? AND product_id = ?')
    .get(companyId, productId) as { quantity: number } | undefined;
  return row?.quantity ?? 0;
}

async function abrir(productIds?: string[]) {
  const res = await request(app)
    .post('/api/v1/core/inventory-counts')
    .set(auth)
    .send({ scopeNote: 'Corredor 3', productIds });
  expect(res.status).toBe(201);
  return res.body;
}

async function contar(countId: string, productId: string, quantidade: number) {
  return request(app)
    .post(`/api/v1/core/inventory-counts/${countId}/items`)
    .set(auth)
    .send({ productId, countedQuantity: quantidade });
}

async function aplicar(countId: string, motivo = 'Contagem mensal') {
  return request(app)
    .post(`/api/v1/core/inventory-counts/${countId}/apply`)
    .set(auth)
    .send({ reason: motivo });
}

describe('contar não mexe em estoque', () => {
  it('registrar a contagem não altera o saldo', async () => {
    const p = await produto('Parafuso', 100);
    const c = await abrir([p]);

    await contar(c.id, p, 80);

    // Só o acerto move estoque. Contar é levantar informação.
    expect(saldo(p)).toBe(100);
  });

  it('o esperado é congelado na abertura', async () => {
    const p = await produto('Porca', 50);
    const c = await abrir([p]);
    expect(c.items[0].expected_quantity).toBe(50);
  });
});

describe('o acerto é a diferença, não o valor contado', () => {
  it('venda entre contar e aplicar não é desfeita pelo acerto', async () => {
    const p = await produto('Arruela', 100);
    const c = await abrir([p]);

    // 8h: conta 97 na prateleira. Faltam 3.
    await contar(c.id, p, 97);

    // 9h: vende 10 legitimamente. Sistema passa a 90.
    await request(app)
      .post('/api/v1/core/sales')
      .set(auth)
      .send({
        idempotencyKey: randomUUID(),
        items: [{ productId: p, quantity: 10 }],
        payments: [{ method: 'dinheiro', amountCents: 100000 }],
      });
    expect(saldo(p)).toBe(90);

    // 10h: aplica. A diferença encontrada foi -3, e é isso que se aplica.
    await aplicar(c.id);

    // Gravar 97 como saldo novo devolveria as 10 vendidas ao estoque.
    expect(saldo(p)).toBe(87);
  });

  it('sobra encontrada entra como acerto positivo', async () => {
    const p = await produto('Prego', 40);
    const c = await abrir([p]);
    await contar(c.id, p, 45);
    await aplicar(c.id);
    expect(saldo(p)).toBe(45);
  });
});

describe('nulo não é zero', () => {
  it('produto não contado NÃO é zerado', async () => {
    const contado = await produto('Contado', 30);
    const esquecido = await produto('Esquecido', 70);
    const c = await abrir([contado, esquecido]);

    // Só um foi alcançado pela contagem.
    await contar(c.id, contado, 28);
    await aplicar(c.id);

    expect(saldo(contado)).toBe(28);
    // Tratar ausência como zero apagaria o estoque de tudo que ficou de fora.
    expect(saldo(esquecido)).toBe(70);
  });

  it('o resumo separa pendente de conferido', async () => {
    const a = await produto('A', 10);
    const b = await produto('B', 10);
    const c = await abrir([a, b]);
    await contar(c.id, a, 10);

    const res = await request(app).get(`/api/v1/core/inventory-counts/${c.id}`).set(auth);
    expect(res.body.resumo.total).toBe(2);
    expect(res.body.resumo.contados).toBe(1);
    // Pendente é o que não se sabe — diferente de "conferiu e bateu".
    expect(res.body.resumo.pendentes).toBe(1);
    expect(res.body.resumo.divergentes).toBe(0);
  });
});

describe('o que vira movimento', () => {
  it('item que bateu não gera linha de histórico', async () => {
    const p = await produto('Bateu', 25);
    const c = await abrir([p]);
    await contar(c.id, p, 25);
    await aplicar(c.id);

    const movs = getConnection()
      .prepare(
        "SELECT COUNT(*) AS n FROM core_stock_movements WHERE reference_type = 'inventory_count' AND product_id = ?",
      )
      .get(p) as { n: number };
    expect(movs.n).toBe(0);
  });

  it('a diferença vira movimento com o tipo semântico certo', async () => {
    const falta = await produto('Falta', 20);
    const sobra = await produto('Sobra', 20);
    const c = await abrir([falta, sobra]);
    await contar(c.id, falta, 18);
    await contar(c.id, sobra, 23);
    await aplicar(c.id);

    const kinds = getConnection()
      .prepare(
        "SELECT product_id, kind FROM core_stock_movements WHERE reference_type = 'inventory_count'",
      )
      .all() as unknown as { product_id: string; kind: string }[];
    const porProduto = Object.fromEntries(kinds.map((k) => [k.product_id, k.kind]));
    expect(porProduto[falta]).toBe('INVENTORY_ADJUSTMENT_NEGATIVE');
    expect(porProduto[sobra]).toBe('INVENTORY_ADJUSTMENT_POSITIVE');
  });

  it('o movimento guarda o que se esperava e o que se achou', async () => {
    const p = await produto('Rastro', 30);
    const c = await abrir([p]);
    await contar(c.id, p, 27);
    await aplicar(c.id, 'Quebra identificada no corredor 3');

    const mov = getConnection()
      .prepare(
        "SELECT reason, note FROM core_stock_movements WHERE reference_type = 'inventory_count' AND product_id = ?",
      )
      .get(p) as { reason: string; note: string };
    // É o único movimento sem documento: o rastro é o que resta.
    expect(mov.reason).toBe('Quebra identificada no corredor 3');
    expect(mov.note).toContain('30');
    expect(mov.note).toContain('27');
  });
});

describe('travas', () => {
  it('aplicar exige motivo', async () => {
    const p = await produto('X', 10);
    const c = await abrir([p]);
    await contar(c.id, p, 9);
    const res = await aplicar(c.id, '');
    expect(res.status).toBe(400);
  });

  it('contagem aplicada não recebe nova contagem', async () => {
    const p = await produto('Y', 10);
    const c = await abrir([p]);
    await contar(c.id, p, 9);
    await aplicar(c.id);

    const res = await contar(c.id, p, 5);
    expect(res.status).toBe(409);
  });

  it('não se aplica duas vezes', async () => {
    const p = await produto('Z', 10);
    const c = await abrir([p]);
    await contar(c.id, p, 8);
    await aplicar(c.id);
    const segunda = await aplicar(c.id);
    expect(segunda.status).toBe(409);
    // E o saldo não caiu de novo.
    expect(saldo(p)).toBe(8);
  });

  it('acerto que deixaria saldo negativo é recusado antes de aplicar nada', async () => {
    const bom = await produto('Bom', 50);
    const problema = await produto('Problema', 5);
    const c = await abrir([bom, problema]);
    await contar(c.id, bom, 48);

    // Contagem informa 5 a mais do que existe como saída: impossível.
    getConnection()
      .prepare(
        'UPDATE core_inventory_count_items SET counted_quantity = 0, expected_quantity = 10 WHERE count_id = ? AND product_id = ?',
      )
      .run(c.id, problema);

    const res = await aplicar(c.id);
    expect(res.status).toBe(409);
  });

  it('produto encontrado fora da lista entra na contagem', async () => {
    const previsto = await produto('Previsto', 10);
    const surpresa = await produto('Surpresa', 4);
    const c = await abrir([previsto]);

    // Quem conta acha caixa que a lista não previa.
    const res = await contar(c.id, surpresa, 4);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
  });

  it('contagem de outra operação não é acessível', async () => {
    const p = await produto('Isolado', 10);
    const c = await abrir([p]);
    const outra = await loginForTest(app, {
      userId: 'gerente-outra-inv',
      companyId: 'loja-vizinha-inv',
      profileCodes: ['gerente_loja'],
    });
    const res = await request(app)
      .get(`/api/v1/core/inventory-counts/${c.id}`)
      .set({ Authorization: `Bearer ${outra.body.accessToken}` });
    expect(res.status).toBe(404);
  });

  it('cancelar impede aplicar depois', async () => {
    const p = await produto('Cancelada', 10);
    const c = await abrir([p]);
    await contar(c.id, p, 7);
    await request(app)
      .post(`/api/v1/core/inventory-counts/${c.id}/cancel`)
      .set(auth)
      .send({ reason: 'contagem errada' });

    const res = await aplicar(c.id);
    expect(res.status).toBe(409);
    expect(saldo(p)).toBe(10);
  });
});

describe('inventário geral', () => {
  it('sem lista, entra o catálogo ativo', async () => {
    await produto('Um', 5);
    await produto('Dois', 5);
    const c = await abrir();
    expect(c.items.length).toBeGreaterThanOrEqual(2);
  });
});
