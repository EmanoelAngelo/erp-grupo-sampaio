/**
 * ============================================================================
 * A OS NA CENTRAL E NO CMV — o status sai do nó, e a peça leva o custo até a
 * margem (GAP-PRD-100, GAP-PRD-101)
 * ============================================================================
 *
 * ## O que a auditoria mediu
 *
 *   - GAP-PRD-100: depois de assumir, lançar, concluir e receber a OS, o
 *     `core_outbox` dela tinha UM evento — `service_order.opened`. O catálogo
 *     e o projetor conheciam `service_order.status_changed`, e ninguém o
 *     emitia: o consolidado via toda OS "em aberto" com total zero.
 *   - GAP-PRD-101: a peça com custo 900,00 no cadastro saía da gaveta com
 *     `unit_cost_cents` nulo, e a venda da OS era UMA linha com custo nulo. O
 *     CMV lê só `core_sale_items.cost_cents`: a margem da oficina não existia.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import type { OutboxRow } from '../src/services/sync/OutboxService.js';
import { InMemoryCentral, projectBatch } from '../src/services/sync/Projector.js';
import { incomeStatement } from '../src/services/core/IncomeStatementService.js';
import { hojeNaLoja } from '../src/services/core/CalendarioOperacional.js';
import { createSale } from '../src/services/core/SalesService.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();
const OFICINA = 'oficina-cmv';
const CPF_VALIDO = '529.982.247-25';

interface Ator {
  auth: { Authorization: string };
  userId: string;
}

let gerente: Ator;
let mecanico: Ator;
let caixa: Ator;
let workshopId: string;

async function entrar(userId: string, perfil: string): Promise<Ator> {
  const res = await loginForTest(app, { userId, companyId: OFICINA, profileCodes: [perfil] });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return {
    auth: { Authorization: `Bearer ${res.body.accessToken as string}` },
    userId: String(res.body.user.id),
  };
}

beforeEach(async () => {
  resetDbForTests();
  gerente = await entrar('ger-cmv', 'gerente_oficina');
  mecanico = await entrar('mec-cmv', 'mecanico');
  caixa = await entrar('cx-cmv', 'operador_caixa_oficina');
  workshopId = 'wk-cmv';
  getConnection()
    .prepare(
      `INSERT INTO core_workshops (id, company_id, slug, name, kind, active, created_at)
       VALUES (?, ?, 'mob-cmv', 'Bancada CMV', 'mobility', 1, ?)`,
    )
    .run(workshopId, OFICINA, new Date().toISOString());
  getConnection()
    .prepare(
      `INSERT INTO core_workshop_members (id, workshop_id, user_id, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(randomUUID(), workshopId, mecanico.userId, new Date().toISOString());
});

async function peca(nome: string, qtd: number, precoCents: number, custoCents: number): Promise<string> {
  const p = await request(app)
    .post('/api/v1/core/products')
    .set(gerente.auth)
    .send({ name: nome, priceCents: precoCents, costCents: custoCents });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  getConnection()
    .prepare("UPDATE core_products SET kind = 'part', workshop_id = ? WHERE id = ?")
    .run(workshopId, p.body.id);
  const entrada = await request(app).post('/api/v1/core/stock/movements').set(gerente.auth).send({
    productId: p.body.id,
    movementType: 'in',
    quantity: qtd,
    referenceType: 'entrada',
    referenceId: `carga-${p.body.id as string}`,
  });
  expect(entrada.status, JSON.stringify(entrada.body)).toBeLessThan(300);
  return String(p.body.id);
}

async function abrirOs(customerId?: string): Promise<string> {
  const os = await request(app)
    .post('/api/v1/core/workshop/orders')
    .set(gerente.auth)
    .send({ workshopId, customerId, customerName: customerId ? undefined : 'Cliente CMV', complaint: 'Não liga' });
  expect(os.status, JSON.stringify(os.body)).toBe(201);
  return String(os.body.id);
}

async function assumir(osId: string): Promise<void> {
  const r = await request(app)
    .post(`/api/v1/core/workshop/orders/${osId}/assume`)
    .set(mecanico.auth)
    .send({ status: 'em_andamento', comment: 'assumindo' });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

async function lancar(osId: string, productId: string, quantity: number): Promise<void> {
  const r = await request(app)
    .post(`/api/v1/core/workshop/orders/${osId}/parts`)
    .set(mecanico.auth)
    .send({ productId, quantity });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
}

async function maoDeObra(osId: string, laborCents: number): Promise<void> {
  await request(app)
    .post(`/api/v1/core/workshop/orders/${osId}/labor`)
    .set(mecanico.auth)
    .send({ laborCents })
    .expect(200);
}

async function concluir(osId: string): Promise<void> {
  const r = await request(app)
    .post(`/api/v1/core/workshop/orders/${osId}/complete`)
    .set(mecanico.auth)
    .send({ diagnosis: 'Trocado', hasCost: true, forcarChecklist: true });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(r.body.status).toBe('aguardando_pagamento');
}

async function receber(osId: string, totalCents: number): Promise<string> {
  const gaveta = await request(app).post('/api/v1/core/cash/open').set(caixa.auth).send({ openingCents: 0 });
  expect(gaveta.status, JSON.stringify(gaveta.body)).toBe(201);
  const r = await request(app)
    .post(`/api/v1/core/workshop/orders/${osId}/checkout`)
    .set(caixa.auth)
    .set('Idempotency-Key', `rec-${osId}`)
    .send({ payments: [{ method: 'pix', amountCents: totalCents }], cashSessionId: gaveta.body.id });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return String(r.body.sale.id);
}

function eventosDaOs(osId: string): OutboxRow[] {
  return getConnection()
    .prepare("SELECT * FROM core_outbox WHERE aggregate_type = 'service_order' AND aggregate_id = ? ORDER BY seq")
    .all(osId) as unknown as OutboxRow[];
}

function itensDaVenda(saleId: string) {
  return getConnection()
    .prepare(
      `SELECT product_id, description, quantity, unit_price_cents, total_cents, cost_cents
         FROM core_sale_items WHERE sale_id = ? ORDER BY rowid`,
    )
    .all(saleId) as unknown as {
    product_id: string | null;
    description: string;
    quantity: number;
    unit_price_cents: number;
    total_cents: number;
    cost_cents: number | null;
  }[];
}

function saidasDaOs(osId: string) {
  return getConnection()
    .prepare(
      `SELECT movement_type, kind, quantity, unit_cost_cents, reference_type
         FROM core_stock_movements
        WHERE (reference_type = 'service_order' AND reference_id LIKE ?)
           OR reference_type = 'workshop_part_return'
        ORDER BY created_at, rowid`,
    )
    .all(`${osId}:%`) as unknown as {
    movement_type: string;
    kind: string;
    quantity: number;
    unit_cost_cents: number | null;
    reference_type: string;
  }[];
}

// ============================================================================

describe('GAP-PRD-100 — cada mudança de situação da OS sai para a central', () => {
  it('abrir, assumir, concluir e receber: um evento por passo, e a projeção termina finalizada com os totais', async () => {
    const productId = await peca('Controlador', 5, 90000, 60000);
    const osId = await abrirOs();
    await assumir(osId);
    await lancar(osId, productId, 1);
    await maoDeObra(osId, 15000);
    await concluir(osId);
    await receber(osId, 105000);

    const eventos = eventosDaOs(osId);
    expect(eventos.map((e) => e.event_type)).toEqual([
      'service_order.opened',
      'service_order.status_changed', // assumiu
      'service_order.status_changed', // concluiu
      'service_order.status_changed', // recebeu
    ]);
    expect(eventos.map((e) => (JSON.parse(e.payload) as { status: string }).status)).toEqual([
      'em_aberto',
      'em_andamento',
      'aguardando_pagamento',
      'finalizada',
    ]);
    // A oficina é a unidade operacional em todos.
    expect(new Set(eventos.map((e) => e.operational_unit_id))).toEqual(new Set([workshopId]));

    // O projetor (que já sabia consumir o evento) chega ao retrato final.
    const central = new InMemoryCentral();
    projectBatch(eventos, central);
    const [linha] = central.rows('erp_service_orders');
    expect(linha.status).toBe('finalizada');
    expect(linha.total_cents).toBe(105000);
    expect(linha.parts_cents).toBe(90000);
    expect(linha.labor_cents).toBe(15000);
  });

  it('mover, largar e o estorno do recebimento também saem', async () => {
    const osId = await abrirOs();
    await assumir(osId);
    const mover = await request(app)
      .post(`/api/v1/core/workshop/orders/${osId}/move`)
      .set(mecanico.auth)
      .send({ status: 'aguardando_peca', comment: 'esperando o conector' });
    expect(mover.status, JSON.stringify(mover.body)).toBe(200);
    const largar = await request(app)
      .post(`/api/v1/core/workshop/orders/${osId}/release`)
      .set(mecanico.auth)
      .send({ reason: 'vou sair de férias' });
    expect(largar.status, JSON.stringify(largar.body)).toBe(200);
    await assumir(osId);
    await maoDeObra(osId, 20000);
    await concluir(osId);
    await receber(osId, 20000);
    const estorno = await request(app)
      .post(`/api/v1/core/workshop/orders/${osId}/estorno`)
      .set(gerente.auth)
      .send({ reason: 'cobrado errado' });
    expect(estorno.status, JSON.stringify(estorno.body)).toBe(200);

    const status = eventosDaOs(osId).map((e) => (JSON.parse(e.payload) as { status: string }).status);
    expect(status).toEqual([
      'em_aberto',
      'em_andamento',
      'aguardando_peca',
      'em_aberto',
      'em_andamento',
      'aguardando_pagamento',
      'finalizada',
      'aguardando_pagamento',
    ]);
    const central = new InMemoryCentral();
    projectBatch(eventosDaOs(osId), central);
    expect(central.rows('erp_service_orders')[0].status).toBe('aguardando_pagamento');
  });

  it('a OS encerrada sem custo (garantia) também sai como finalizada', async () => {
    const osId = await abrirOs();
    await assumir(osId);
    const r = await request(app)
      .post(`/api/v1/core/workshop/orders/${osId}/complete`)
      .set(mecanico.auth)
      .send({ diagnosis: 'Garantia', hasCost: false, noCostReason: 'garantia', forcarChecklist: true });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const ultimo = eventosDaOs(osId).at(-1)!;
    expect(ultimo.event_type).toBe('service_order.status_changed');
    expect((JSON.parse(ultimo.payload) as { status: string }).status).toBe('finalizada');
  });

  it('movimento recusado não deixa evento na fila', async () => {
    const osId = await abrirOs();
    const r = await request(app)
      .post(`/api/v1/core/workshop/orders/${osId}/move`)
      .set(mecanico.auth)
      .send({ status: 'em_andamento', comment: 'sem assumir' });
    expect(r.status).toBe(409);
    expect(eventosDaOs(osId).map((e) => e.event_type)).toEqual(['service_order.opened']);
  });
});

describe('GAP-PRD-101 — a peça da OS leva o custo da baixa até o CMV', () => {
  it('a saída fotografa o custo, e a venda itemiza peça (com custo) e mão de obra (sem)', async () => {
    const productId = await peca('Controlador', 5, 90000, 60000);
    const osId = await abrirOs();
    await assumir(osId);
    await lancar(osId, productId, 2);
    await maoDeObra(osId, 15000);
    await concluir(osId);

    const saida = saidasDaOs(osId).filter((m) => m.movement_type === 'out');
    expect(saida).toHaveLength(1);
    expect(saida[0].kind).toBe('WORKSHOP_PART_CONSUMPTION');
    expect(saida[0].unit_cost_cents).toBe(60000);

    // O cadastro muda DEPOIS da baixa: o conserto feito não muda de margem.
    getConnection().prepare('UPDATE core_products SET cost_cents = 99999 WHERE id = ?').run(productId);

    const saleId = await receber(osId, 195000);
    const itens = itensDaVenda(saleId);
    /*
      Desde a junção com a frente fiscal (GAP-PRD-024) a peça é linha COM
      produto — mercadoria, com NCM para a nota — e a mão de obra tem a
      descrição que a NFS-e usa. O que este caso cobra continua igual: o custo
      é o da BAIXA (60.000), não o do cadastro que mudou depois (99.999).
    */
    expect(itens).toEqual([
      {
        product_id: productId,
        description: 'Controlador',
        quantity: 2,
        unit_price_cents: 90000,
        total_cents: 180000,
        cost_cents: 60000,
      },
      {
        product_id: null,
        description: expect.stringMatching(/^Mão de obra — OS #\d+$/),
        quantity: 1,
        unit_price_cents: 15000,
        total_cents: 15000,
        cost_cents: null,
      },
    ]);
    // A venda não repetiu a baixa: o saldo é o de depois da OS.
    const saldo = getConnection()
      .prepare('SELECT quantity FROM core_stock WHERE product_id = ?')
      .get(productId) as { quantity: number };
    expect(saldo.quantity).toBe(3);

    // O DRE passa a ver a margem da oficina.
    const hoje = hojeNaLoja();
    const dre = incomeStatement(OFICINA, hoje, hoje);
    expect(dre.cogs.costCents).toBe(120000);
    expect(dre.cogs.revenueCents).toBe(180000);
    expect(dre.cogs.marginCents).toBe(60000);
    expect(dre.cogs.itemsWithCost).toBe(1);
    // A mão de obra é contada como linha sem retrato, não como custo zero.
    expect(dre.cogs.itemsBeforeSnapshot).toBe(1);
  });

  it('a peça devolvida depois da baixa volta com o MESMO custo, e sai da venda', async () => {
    const productId = await peca('Pastilha', 10, 5000, 2000);
    const osId = await abrirOs();
    await assumir(osId);
    await lancar(osId, productId, 3);
    await concluir(osId);
    const partId = (
      getConnection().prepare('SELECT id FROM core_service_order_parts WHERE order_id = ?').get(osId) as {
        id: string;
      }
    ).id;
    const devolveu = await request(app)
      .post(`/api/v1/core/workshop/orders/${osId}/parts/${partId}/return`)
      .set(mecanico.auth)
      .send({ quantity: 1 });
    expect(devolveu.status, JSON.stringify(devolveu.body)).toBe(200);

    const volta = saidasDaOs(osId).filter((m) => m.kind === 'WORKSHOP_PART_RETURN');
    expect(volta).toHaveLength(1);
    expect(volta[0].unit_cost_cents).toBe(2000);

    const saleId = await receber(osId, 10000);
    const itens = itensDaVenda(saleId);
    expect(itens).toHaveLength(1);
    expect(itens[0]).toMatchObject({ quantity: 2, total_cents: 10000, cost_cents: 2000 });
  });

  it('a peça que o cliente aprovou (baixa na aprovação) também leva o custo', async () => {
    const cliente = await request(app)
      .post('/api/v1/core/customers')
      .set(gerente.auth)
      .send({ name: 'Dona Aprovada', document: CPF_VALIDO, phone: '53 97777-0000' });
    expect(cliente.status, JSON.stringify(cliente.body)).toBe(201);
    const productId = await peca('Bateria', 4, 30000, 21000);
    const osId = await abrirOs(String(cliente.body.id));
    await assumir(osId);
    await lancar(osId, productId, 1);
    await request(app).post(`/api/v1/core/workshop/orders/${osId}/pedir-aprovacao`).set(mecanico.auth).send({}).expect(200);
    await request(app)
      .post(`/api/v1/core/workshop/orders/${osId}/decidir-orcamento`)
      .set(gerente.auth)
      .send({ approved: true })
      .expect(200);
    // A baixa aconteceu na aprovação, com o custo.
    const saida = saidasDaOs(osId).filter((m) => m.movement_type === 'out');
    expect(saida.map((m) => m.unit_cost_cents)).toEqual([21000]);
    await concluir(osId);
    const saleId = await receber(osId, 30000);
    expect(itensDaVenda(saleId)).toEqual([
      expect.objectContaining({ product_id: productId, description: 'Bateria', cost_cents: 21000, total_cents: 30000 }),
    ]);
  });

  it('peça que saiu antes do retrato não inventa custo: a linha fica sem retrato', async () => {
    const productId = await peca('Cabo', 5, 4000, 1500);
    const osId = await abrirOs();
    await assumir(osId);
    await lancar(osId, productId, 1);
    await maoDeObra(osId, 6000);
    await concluir(osId);
    // O razão como o código antigo o deixava: saída sem custo.
    getConnection()
      .prepare(
        "UPDATE core_stock_movements SET unit_cost_cents = NULL WHERE reference_type = 'service_order' AND movement_type = 'out'",
      )
      .run();
    const saleId = await receber(osId, 10000);
    const itens = itensDaVenda(saleId);
    expect(itens.map((i) => i.cost_cents)).toEqual([null, null]);
    expect(itens.reduce((a, i) => a + i.total_cents, 0)).toBe(10000);
  });

  it('OS cujo total não fecha com as linhas é recusada, sem venda nenhuma', async () => {
    /*
      Era "cai na linha única de sempre". A junção com a frente fiscal
      (GAP-PRD-024) mudou a saída: com a nota das peças e a NFS-e da mão de
      obra lendo a venda, uma linha só com o total faria a NFS-e declarar peça
      como serviço. A intenção desta frente continua de pé — nunca uma venda
      cujos itens contam uma história e o total outra —, agora pela recusa.
    */
    const osId = await abrirOs();
    await assumir(osId);
    await maoDeObra(osId, 7000);
    await concluir(osId);
    // OS antiga com total gravado por outra régua.
    getConnection().prepare('UPDATE core_service_orders SET total_cents = 7500 WHERE id = ?').run(osId);
    const gaveta = await request(app).post('/api/v1/core/cash/open').set(caixa.auth).send({ openingCents: 0 });
    expect(gaveta.status, JSON.stringify(gaveta.body)).toBe(201);
    const r = await request(app)
      .post(`/api/v1/core/workshop/orders/${osId}/checkout`)
      .set(caixa.auth)
      .set('Idempotency-Key', `rec-${osId}`)
      .send({ payments: [{ method: 'pix', amountCents: 7500 }], cashSessionId: gaveta.body.id });
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(r.body.error.code).toBe('CORE_ORDER_TOTAL_MISMATCH');
    const vendas = getConnection()
      .prepare('SELECT COUNT(*) AS n FROM core_sales WHERE company_id = ?')
      .get(OFICINA) as { n: number };
    expect(vendas.n).toBe(0);
  });

  it('createSale recusa linhas de serviço que não fecham com o total', () => {
    expect(() =>
      createSale({
        companyId: OFICINA,
        userId: gerente.userId,
        idempotencyKey: 'linhas-tortas',
        items: [],
        payments: [{ method: 'pix', amountCents: 1000 }],
        serviceTotalCents: 1000,
        serviceLines: [
          { description: 'Peça: x', quantity: 1, unitPriceCents: 400, totalCents: 400, costCents: 100 },
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: 'CORE_SERVICE_LINES_MISMATCH' }));
  });
});
