/**
 * O ITEM FIXADO DA TABELA GANHA ESCRITOR (E LEITOR) PELA PORTA DA FRENTE.
 *
 * A tela de tabelas PROMETIA "um produto pode ter preço fixado, e aí o preço
 * fixado ganha" — e `priceInTable` cumpria. Mas as rotas de fixar
 * (`PUT/DELETE /core/catalog/price-tables/:id/items/:productId`) tinham ZERO
 * chamadores e ZERO testes: não existia como fixar um preço pela tela, e a
 * metade viva da funcionalidade certificava uma promessa que ninguém podia
 * acionar.
 *
 * Este arquivo prova a promessa INTEIRA por rota: fixa pelo PUT, lê pelo GET
 * novo, vende pela rota de venda e vê o fixado VENCER o percentual da tabela;
 * remove pelo DELETE e vê o percentual voltar a valer.
 *
 * E o buraco fechado de passagem: o PUT tinha `Number(req.body?.priceCents ??
 * 0)` — corpo sem preço fixava o produto em R$ 0,00, de graça no cupom, sem
 * erro para ninguém. Agora corpo sem preço (ou com zero) é 400 nomeado.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { loginForTest } from './helpers/auth.js';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { getConnection } from '../src/db/sqlite.js';
import { upsertPriceTable } from '../src/services/core/CatalogAuxService.js';

const app = createApp();
const LOJA = 'loja-preco-fixado';
/** R$ 200,00 de cadastro. */
const CAPACETE = 20_000;

function produto(id: string, nome: string, precoCents: number): void {
  const agora = new Date().toISOString();
  getConnection()
    .prepare(
      `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                  price_cents, category, open_price, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'UN', 0, ?, 'Geral', 0, 1, ?, ?)`,
    )
    .run(id, LOJA, id, nome, precoCents, agora, agora);
  getConnection()
    .prepare(
      'INSERT INTO core_stock (company_id, product_id, quantity, reserved, updated_at) VALUES (?, ?, 500, 0, ?)',
    )
    .run(LOJA, id, agora);
}

function cliente(nome: string, priceTableId: string | null): string {
  const id = randomUUID();
  const agora = new Date().toISOString();
  getConnection()
    .prepare(
      `INSERT INTO core_customers (id, company_id, name, active, price_table_id, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?, ?)`,
    )
    .run(id, LOJA, nome, priceTableId, agora, agora);
  return id;
}

async function token(perfil: string, userId: string): Promise<string> {
  const res = await loginForTest(app, { userId, companyId: LOJA, profileCodes: [perfil] });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

let atacado: string;
let revendedor: string;
let gerente: string;
let caixa: string;

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  // Os logins vêm PRIMEIRO: é o loginForTest que cria a empresa, e produto e
  // cliente têm FK para ela.
  gerente = await token('gerente_loja', 'gerencia');
  caixa = await token('operador_caixa_loja', 'balcao');
  produto('p-capacete', 'Capacete Integral', CAPACETE);
  // Atacado -15%: sem item fixado, o capacete sairia por R$ 170,00.
  atacado = upsertPriceTable(LOJA, { name: 'Atacado', percentOff: 15 }).id;
  revendedor = cliente('Revenda Silva', atacado);
});

function fixar(t: string, priceCents?: number) {
  return request(app)
    .put(`/api/v1/core/catalog/price-tables/${atacado}/items/p-capacete`)
    .set('Authorization', `Bearer ${t}`)
    .send(priceCents === undefined ? {} : { priceCents });
}

function listarFixados(t: string) {
  return request(app)
    .get(`/api/v1/core/catalog/price-tables/${atacado}/items`)
    .set('Authorization', `Bearer ${t}`);
}

function vender(t: string, unitPriceCents: number) {
  return request(app)
    .post('/api/v1/core/sales')
    .set('Authorization', `Bearer ${t}`)
    .set('Idempotency-Key', randomUUID())
    .send({
      customerId: revendedor,
      items: [{ productId: 'p-capacete', quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: unitPriceCents }],
    });
}

describe('fixar, listar e remover pela rota', () => {
  it('o gerente fixa, a lista mostra o produto PELO NOME, e o DELETE devolve a lista sem ele', async () => {
    const fixado = await fixar(gerente, 12_000);
    expect(fixado.status).toBe(200);
    // A resposta É a lista atualizada: a tela re-renderiza o que o servidor
    // afirma, não o que ela acha que aconteceu.
    expect(fixado.body.items).toHaveLength(1);
    expect(fixado.body.items[0].product_name).toBe('Capacete Integral');
    expect(fixado.body.items[0].price_cents).toBe(12_000);
    expect(fixado.body.items[0].base_price_cents).toBe(CAPACETE);

    const lista = await listarFixados(gerente);
    expect(lista.status).toBe(200);
    expect(lista.body.items).toHaveLength(1);

    const removido = await request(app)
      .delete(`/api/v1/core/catalog/price-tables/${atacado}/items/p-capacete`)
      .set('Authorization', `Bearer ${gerente}`);
    expect(removido.status).toBe(200);
    expect(removido.body.items).toHaveLength(0);
  });

  it('corpo SEM preço não fixa de graça: 400 nomeado, e nada foi gravado', async () => {
    const res = await fixar(gerente);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CORE_PRICE_TABLE_ITEM_PRICE');

    const zero = await fixar(gerente, 0);
    expect(zero.status).toBe(400);

    expect((await listarFixados(gerente)).body.items).toHaveLength(0);
  });

  it('o caixa não fixa preço — fixar é negociar pela loja', async () => {
    const res = await fixar(caixa, 12_000);
    expect(res.status).toBe(403);
  });
});

describe('a promessa inteira, provada na VENDA', () => {
  it('sem fixado, a tabela dá 15%: R$ 170,00; com fixado em R$ 120,00, o fixado GANHA', async () => {
    // Antes de fixar: o percentual da tabela.
    const semFixado = await vender(caixa, 17_000);
    expect(semFixado.status).toBe(201);
    expect(semFixado.body.total_cents).toBe(17_000);

    // O gerente fixa o combinado pela ROTA — o gesto que não existia.
    expect((await fixar(gerente, 12_000)).status).toBe(200);

    const comFixado = await vender(caixa, 12_000);
    expect(comFixado.status).toBe(201);
    // R$ 120,00, e não R$ 170,00: a exceção por item vence o percentual.
    expect(comFixado.body.total_cents).toBe(12_000);
  });

  it('removido o fixado pela rota, o percentual da tabela volta a valer', async () => {
    expect((await fixar(gerente, 12_000)).status).toBe(200);
    await request(app)
      .delete(`/api/v1/core/catalog/price-tables/${atacado}/items/p-capacete`)
      .set('Authorization', `Bearer ${gerente}`);

    const venda = await vender(caixa, 17_000);
    expect(venda.status).toBe(201);
    expect(venda.body.total_cents).toBe(17_000);
  });
});
