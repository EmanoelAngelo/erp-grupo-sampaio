/**
 * ============================================================================
 * A MOTO DA PRÉ-VENDA — converter com o chassi e segurar AQUELA moto
 * (GAP-PRD-025, GAP-PRD-111)
 * ============================================================================
 *
 * ## O que a auditoria mediu
 *
 *   - GAP-PRD-025: pré-venda de produto controlado por unidade não virava venda.
 *     `convertQuote` mandava os itens a `createSale` sem `unitIds`, e o funil do
 *     estoque recusava com CORE_UNITS_REQUIRED. O sinal ficava preso numa
 *     reserva que só se soltava cancelando o documento.
 *   - GAP-PRD-111: a reserva era por QUANTIDADE. A moto vermelha negociada no
 *     balcão podia sair pelo pedido online (FIFO na captura) ou pelo caixa ao
 *     lado, porque nada no sistema dizia que "aquela" era do cliente do sinal.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { getConnection } from '../src/db/sqlite.js';
import {
  linkUserToCompany,
  upsertCompany,
  upsertUser,
} from '../src/services/auth/IdentityService.js';
import { createProduct, updateProduct } from '../src/services/core/CatalogService.js';
import {
  applyMovement,
  consumeReservation,
  reserveStock,
} from '../src/services/core/InventoryService.js';
import { createUnits } from '../src/services/core/ProductUnitService.js';
import { createSale } from '../src/services/core/SalesService.js';
import { updateQuote } from '../src/services/core/QuoteService.js';
import { createLocation, transferStock } from '../src/services/core/StockLocationService.js';
import type { ApiError } from '../src/utils/errors.js';

const app = createApp();
const SENHA = 'MotoDaPreVenda@2026';

let pj: string;
let moto: string;
let caixaId: string;
let caixa: { Authorization: string };

function recusa(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (err) {
    return err as ApiError;
  }
  throw new Error('Esperava uma recusa, e a chamada passou.');
}

async function entrar(login: string): Promise<{ Authorization: string }> {
  const res = await request(app).post('/api/v1/auth/login').send({ login, password: SENHA });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { Authorization: `Bearer ${res.body.accessToken}` };
}

/** N motos no pátio, com chassi, como a entrada de nota + identificação deixam. */
function motosNoPatio(chassis: string[]): string[] {
  const ids = createUnits(pj, moto, chassis.length, {
    entryReferenceType: 'ajuste',
    entryReferenceId: `carga-${randomUUID()}`,
  });
  applyMovement({
    companyId: pj,
    productId: moto,
    movementType: 'in',
    quantity: chassis.length,
    referenceType: 'ajuste',
    referenceId: `carga-${randomUUID()}`,
    unitIds: ids,
  });
  ids.forEach((id, i) => {
    getConnection()
      .prepare('UPDATE core_product_units SET chassis = ?, created_at = ? WHERE id = ?')
      // created_at crescente: a primeira da lista é a mais antiga (FIFO).
      .run(chassis[i], new Date(Date.UTC(2026, 0, 1 + i)).toISOString(), id);
  });
  return ids;
}

function unidade(id: string): { status: string; exit_reference_id: string | null } {
  return getConnection()
    .prepare('SELECT status, exit_reference_id FROM core_product_units WHERE id = ?')
    .get(id) as { status: string; exit_reference_id: string | null };
}

function saldo(): { quantity: number; reserved: number } {
  return getConnection()
    .prepare('SELECT quantity, reserved FROM core_stock WHERE company_id = ? AND product_id = ?')
    .get(pj, moto) as { quantity: number; reserved: number };
}

async function preVenda(quantidade = 1): Promise<{ id: string; number: number }> {
  const res = await request(app)
    .post('/api/v1/core/quotes')
    .set(caixa)
    .send({ kind: 'pre_venda', items: [{ productId: moto, quantity: quantidade }] });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

async function converter(
  quoteId: string,
  corpo: Record<string, unknown> = {},
  total = 1_800_000,
): Promise<request.Response> {
  return request(app)
    .post(`/api/v1/core/quotes/${quoteId}/convert`)
    .set(caixa)
    .set('Idempotency-Key', randomUUID())
    .send({ payments: [{ method: 'dinheiro', amountCents: total }], ...corpo });
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  pj = upsertCompany({ slug: 'pj-motors', legalName: 'PJ Motors Ltda', tradeName: 'PJ Motors' });
  caixaId = await upsertUser({ login: 'CAIXA.PJ', displayName: 'Caixa da PJ', password: SENHA });
  linkUserToCompany(caixaId, pj, 'operador_caixa_loja', true);
  caixa = await entrar('CAIXA.PJ');
  moto = String(createProduct(pj, { name: 'Honda CG 160', priceCents: 1_800_000 }).id);
  updateProduct(pj, moto, { serialized: true });
});

// ---------------------------------------------------------------- GAP-PRD-025

describe('GAP-PRD-025 — a pré-venda de moto vira venda', () => {
  it('sem escolher, sai a mais antiga do pátio (FIFO à vista) e a reserva se consome', async () => {
    const [antiga, nova] = motosNoPatio(['CH-ANTIGA', 'CH-NOVA']);
    const doc = await preVenda();
    expect(saldo()).toEqual({ quantity: 2, reserved: 1 });

    const res = await converter(doc.id);
    // Antes: 400 CORE_UNITS_REQUIRED, "Vieram 0".
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    expect(unidade(antiga)).toEqual({ status: 'sold', exit_reference_id: res.body.saleId });
    expect(unidade(nova).status).toBe('in_stock');
    expect(saldo()).toEqual({ quantity: 1, reserved: 0 });
    const quote = getConnection()
      .prepare('SELECT status, converted_sale_id FROM core_quotes WHERE id = ?')
      .get(doc.id) as { status: string; converted_sale_id: string };
    expect(quote).toEqual({ status: 'convertido', converted_sale_id: res.body.saleId });
  });

  it('o caixa bipa o chassi na conversão e sai a moto que ele escolheu', async () => {
    const [antiga, nova] = motosNoPatio(['CH-ANTIGA', 'CH-NOVA']);
    const doc = await preVenda();

    const res = await converter(doc.id, { unidades: [{ productId: moto, unitIds: [nova] }] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(unidade(nova).status).toBe('sold');
    expect(unidade(antiga).status).toBe('in_stock');
  });

  it('a escolha errada é recusada inteira — quantidade, produto e peça que já saiu', async () => {
    const [antiga, nova] = motosNoPatio(['CH-ANTIGA', 'CH-NOVA']);
    const doc = await preVenda();

    const demais = await converter(doc.id, { unidades: [{ productId: moto, unitIds: [antiga, nova] }] });
    expect(demais.status).toBe(400);
    expect(demais.body.error.code).toBe('CORE_UNITS_REQUIRED');

    const outroProduto = await converter(doc.id, {
      unidades: [{ productId: 'produto-que-nao-esta-no-documento', unitIds: [antiga] }],
    });
    expect(outroProduto.status).toBe(400);
    expect(outroProduto.body.error.code).toBe('CORE_QUOTE_UNITS_WRONG_PRODUCT');

    getConnection().prepare("UPDATE core_product_units SET status = 'sold' WHERE id = ?").run(nova);
    const jaVendida = await converter(doc.id, { unidades: [{ productId: moto, unitIds: [nova] }] });
    expect(jaVendida.status).toBe(409);
    expect(jaVendida.body.error.code).toBe('CORE_UNIT_NOT_AVAILABLE');

    // Nada andou: o documento continua aberto e segurando a moto.
    expect(saldo()).toEqual({ quantity: 2, reserved: 1 });
    const quote = getConnection().prepare('SELECT status FROM core_quotes WHERE id = ?').get(doc.id) as {
      status: string;
    };
    expect(quote.status).toBe('aberto');
  });

  it('o orçamento de moto (que não segura nada) também converte', async () => {
    const [antiga] = motosNoPatio(['CH-ANTIGA']);
    const orc = await request(app)
      .post('/api/v1/core/quotes')
      .set(caixa)
      .send({ kind: 'orcamento', items: [{ productId: moto, quantity: 1 }] });
    expect(orc.status).toBe(201);

    const res = await converter(orc.body.id);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(unidade(antiga).status).toBe('sold');
  });
});

// ---------------------------------------------------------------- GAP-PRD-111

async function segurar(quoteId: string, unitIds: string[]): Promise<request.Response> {
  return request(app)
    .put(`/api/v1/core/quotes/${quoteId}/unidades`)
    .set(caixa)
    .send({ productId: moto, unitIds });
}

function vender(unitId: string): { saleId: string } {
  const { sale } = createSale({
    companyId: pj,
    userId: caixaId,
    items: [{ productId: moto, quantity: 1, unitIds: [unitId] }],
    payments: [{ method: 'dinheiro', amountCents: 1_800_000 }],
    idempotencyKey: randomUUID(),
  });
  return { saleId: sale.id };
}

function reservasNoBanco(): number {
  return (getConnection().prepare('SELECT COUNT(*) AS n FROM core_product_unit_holds').get() as { n: number }).n;
}

describe('GAP-PRD-111 — a pré-venda segura AQUELA moto', () => {
  it('segura o chassi escolhido; o documento, a lista de unidades e a trilha dizem para quem', async () => {
    const [preta, vermelha] = motosNoPatio(['CH-PRETA', 'CH-VERMELHA']);
    const doc = await preVenda();

    const res = await segurar(doc.id, [vermelha]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.unidadesReservadas).toEqual([
      expect.objectContaining({ unitId: vermelha, rotulo: 'CH-VERMELHA', quoteNumber: doc.number }),
    ]);

    const detalhe = await request(app).get(`/api/v1/core/quotes/${doc.id}`).set(caixa);
    expect(detalhe.body.unidadesReservadas.map((r: { unitId: string }) => r.unitId)).toEqual([vermelha]);
    expect(detalhe.body.items[0].serialized).toBe(1);

    const lista = await request(app).get(`/api/v1/core/units/${moto}?status=in_stock`).set(caixa);
    const porId = new Map(
      (lista.body.items as { id: string; reserva: unknown }[]).map((u) => [u.id, u.reserva]),
    );
    expect(porId.get(vermelha)).toMatchObject({ quoteId: doc.id, quoteNumber: doc.number });
    expect(porId.get(preta)).toBeNull();

    const trilha = getConnection()
      .prepare("SELECT COUNT(*) AS n FROM core_audit_log WHERE action = 'quote.units.hold' AND entity_id = ?")
      .get(doc.id) as { n: number };
    expect(trilha.n).toBe(1);
  });

  it('a conversão sem bipe leva a moto segurada — não a mais antiga — e a reserva morre com o documento', async () => {
    const [preta, vermelha] = motosNoPatio(['CH-PRETA', 'CH-VERMELHA']);
    const doc = await preVenda();
    await segurar(doc.id, [vermelha]);

    const res = await converter(doc.id);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(unidade(vermelha).status).toBe('sold');
    expect(unidade(preta).status).toBe('in_stock');
    expect(reservasNoBanco()).toBe(0);
  });

  it('o balcão não vende a moto segurada para outro cliente, e a recusa diz qual pré-venda a segura', async () => {
    const [preta, vermelha] = motosNoPatio(['CH-PRETA', 'CH-VERMELHA']);
    const doc = await preVenda();
    await segurar(doc.id, [vermelha]);

    const err = recusa(() => vender(vermelha));
    expect(err.code).toBe('CORE_UNIT_HELD');
    expect(err.status).toBe(409);
    expect(err.message).toContain(`pré-venda #${doc.number}`);
    expect(unidade(vermelha).status).toBe('in_stock');

    // A outra moto sai normalmente.
    vender(preta);
    expect(unidade(preta).status).toBe('sold');

    // Nem a conversão de OUTRA pré-venda leva a vermelha no bipe.
    motosNoPatio(['CH-AZUL']);
    const outra = await preVenda();
    const conversao = await converter(outra.id, { unidades: [{ productId: moto, unitIds: [vermelha] }] });
    expect(conversao.status).toBe(409);
    expect(conversao.body.error.code).toBe('CORE_UNIT_HELD');
  });

  it('o pedido online capturado pula a moto segurada: o FIFO só escolhe entre as livres', async () => {
    const [preta, vermelha] = motosNoPatio(['CH-PRETA', 'CH-VERMELHA']);
    const doc = await preVenda();
    // A segurada é justamente a MAIS ANTIGA — a que o FIFO pegaria.
    await segurar(doc.id, [preta]);

    reserveStock({
      companyId: pj,
      productId: moto,
      quantity: 1,
      referenceType: 'ecommerce_order',
      referenceId: 'pedido-1',
    });
    consumeReservation({
      companyId: pj,
      productId: moto,
      quantity: 1,
      referenceType: 'ecommerce_order',
      referenceId: 'pedido-1',
    });

    expect(unidade(vermelha).status).toBe('sold');
    expect(unidade(preta).status).toBe('in_stock');
  });

  it('cancelar a pré-venda solta a moto na hora; vencer também, sem esperar a varredura', async () => {
    const [preta, vermelha] = motosNoPatio(['CH-PRETA', 'CH-VERMELHA']);

    const cancelada = await preVenda();
    await segurar(cancelada.id, [vermelha]);
    const cancel = await request(app).post(`/api/v1/core/quotes/${cancelada.id}/cancel`).set(caixa).send({});
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
    expect(reservasNoBanco()).toBe(0);

    const vencida = await preVenda();
    await segurar(vencida.id, [preta]);
    getConnection()
      .prepare('UPDATE core_quotes SET valid_until = ? WHERE id = ?')
      .run(new Date(Date.now() - 60_000).toISOString(), vencida.id);

    // A reserva morta não aparece para ninguém e é trocada por uma viva.
    const lista = await request(app).get(`/api/v1/core/units/${moto}?status=in_stock`).set(caixa);
    expect((lista.body.items as { reserva: unknown }[]).every((u) => u.reserva === null)).toBe(true);
    const nova = await preVenda();
    const res = await segurar(nova.id, [preta]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it('recusas: orçamento não segura, moto de outra pré-venda, mais motos que o documento leva', async () => {
    const [preta, vermelha] = motosNoPatio(['CH-PRETA', 'CH-VERMELHA']);

    const orc = await request(app)
      .post('/api/v1/core/quotes')
      .set(caixa)
      .send({ kind: 'orcamento', items: [{ productId: moto, quantity: 1 }] });
    const doOrcamento = await segurar(orc.body.id, [preta]);
    expect(doOrcamento.status).toBe(409);
    expect(doOrcamento.body.error.code).toBe('CORE_QUOTE_UNITS_ONLY_PRE_SALE');

    const a = await preVenda();
    await segurar(a.id, [vermelha]);
    const b = await preVenda();
    const daOutra = await segurar(b.id, [vermelha]);
    expect(daOutra.status).toBe(409);
    expect(daOutra.body.error.code).toBe('CORE_UNIT_HELD');
    expect(daOutra.body.error.message).toContain(`#${a.number}`);

    const demais = await segurar(b.id, [preta, vermelha]);
    expect(demais.status).toBe(400);
    expect(demais.body.error.code).toBe('CORE_QUOTE_UNITS_TOO_MANY');
  });

  it('a edição que baixa a quantidade solta a moto que sobrou; a transferência ainda move a segurada', async () => {
    const [primeira, segunda] = motosNoPatio(['CH-1', 'CH-2', 'CH-3']);
    const doc = await preVenda(2);
    expect((await segurar(doc.id, [primeira, segunda])).status).toBe(200);

    updateQuote({ companyId: pj, userId: caixaId, quoteId: doc.id, items: [{ productId: moto, quantity: 1 }] });
    const detalhe = await request(app).get(`/api/v1/core/quotes/${doc.id}`).set(caixa);
    expect(detalhe.body.unidadesReservadas.map((r: { unitId: string }) => r.unitId)).toEqual([primeira]);

    // Mudar de prateleira não entrega a moto a ninguém: a segurada anda.
    const patio = createLocation(pj, { code: 'PATIO', name: 'Pátio' });
    const loja = getConnection()
      .prepare('SELECT id FROM core_stock_locations WHERE company_id = ? AND is_default = 1')
      .get(pj) as { id: string };
    transferStock({ companyId: pj, productId: moto, fromLocationId: loja.id, toLocationId: patio.id, quantity: 3 });
    const noPatio = getConnection()
      .prepare('SELECT COUNT(*) AS n FROM core_product_units WHERE location_id = ?')
      .get(patio.id) as { n: number };
    expect(noPatio.n).toBe(3);
  });
});
