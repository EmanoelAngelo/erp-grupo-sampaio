/**
 * ============================================================================
 * A RESERVA PRESA TEM PORTA — GAP-PRD-087
 * ============================================================================
 *
 * O banco da loja tem uma unidade da Conceito presa por uma reserva da loja
 * online cujo pedido não existe mais. `inventoryReconciliation` sabia dizer
 * isso (STOCK_RESERVATION_WITHOUT_SOURCE, crítico) e ninguém podia perguntar:
 * nenhuma rota, nenhuma tela. A única saída era abrir o banco.
 *
 * Cada caso daqui nasceu VERMELHO contra o HEAD anterior (as duas rotas
 * respondiam 404). O cenário da Conceito é reproduzido tal como está no banco:
 * uma reserva ECOMMERCE_RESERVATION de um pedido que não existe em core_orders.
 */
process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';

import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { reserveStock } from '../src/services/core/InventoryService.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();
const EMPRESA = 'conceito-reserva';

interface Sessao {
  auth: { Authorization: string };
  companyId: string;
}

async function entrar(userId: string, perfil: string): Promise<Sessao> {
  const res = await loginForTest(app, { userId, companyId: EMPRESA, profileCodes: [perfil] });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { auth: { Authorization: `Bearer ${res.body.accessToken}` }, companyId: res.body.company.id };
}

function produto(companyId: string, nome: string, saldo: number): string {
  const id = randomUUID();
  const agora = new Date().toISOString();
  const db = getConnection();
  db.prepare(
    `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents, price_cents,
                                active, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'UN', 1000, 2500, 1, ?, ?)`,
  ).run(id, companyId, `RS-${id.slice(0, 6)}`, nome, agora, agora);
  db.prepare(
    'INSERT INTO core_stock (company_id, product_id, quantity, reserved, updated_at) VALUES (?, ?, ?, 0, ?)',
  ).run(companyId, id, saldo, agora);
  return id;
}

/** A reserva órfã como ela está no banco da loja: pedido que não existe. */
function reservaDePedidoSumido(companyId: string, productId: string, quantidade = 1): string {
  const pedidoQueSumiu = randomUUID();
  reserveStock({
    companyId,
    productId,
    quantity: quantidade,
    kind: 'ECOMMERCE_RESERVATION',
    referenceType: 'ecommerce_order',
    referenceId: pedidoQueSumiu,
  });
  return pedidoQueSumiu;
}

/** Um pedido da loja aguardando pagamento — reserva LEGÍTIMA. */
function pedidoAberto(companyId: string, productId: string, quantidade: number): string {
  const id = randomUUID();
  const agora = new Date().toISOString();
  const db = getConnection();
  db.prepare(
    `INSERT INTO core_orders (id, company_id, number, customer_name, items_cents, total_cents,
                              status, idempotency_key, created_at, updated_at)
     VALUES (?, ?, 41, 'Cliente da Vitrine', 2500, 2500, 'aguardando_pagamento', ?, ?, ?)`,
  ).run(id, companyId, randomUUID(), agora, agora);
  db.prepare(
    `INSERT INTO core_order_items (id, order_id, company_id, product_id, description, quantity,
                                   unit_price_cents, total_cents)
     VALUES (?, ?, ?, ?, 'Item', ?, 2500, 2500)`,
  ).run(randomUUID(), id, companyId, productId, quantidade);
  reserveStock({
    companyId,
    productId,
    quantity: quantidade,
    kind: 'ECOMMERCE_RESERVATION',
    referenceType: 'ecommerce_order',
    referenceId: id,
  });
  return id;
}

function saldo(companyId: string, productId: string): { quantity: number; reserved: number } {
  return getConnection()
    .prepare('SELECT quantity, reserved FROM core_stock WHERE company_id = ? AND product_id = ?')
    .get(companyId, productId) as { quantity: number; reserved: number };
}

let gerente: Sessao;

beforeEach(async () => {
  resetDbForTests();
  gerente = await entrar('gerente-reserva', 'gerente_loja');
});

describe('GAP-PRD-087 — a conferência de reservas tem leitor', () => {
  it('a reserva do pedido que sumiu aparece como crítica, com o porquê', async () => {
    const p = produto(gerente.companyId, 'Bolsa Conceito', 5);
    const pedidoSumido = reservaDePedidoSumido(gerente.companyId, p);

    const res = await request(app).get('/api/v1/core/stock/reconciliation').set(gerente.auth);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.healthy).toBe(false);
    const issue = res.body.issues.find(
      (i: { check: string }) => i.check === 'STOCK_RESERVATION_WITHOUT_SOURCE',
    );
    expect(issue).toBeDefined();
    expect(issue.productName).toBe('Bolsa Conceito');
    expect(issue.semOrigem).toBe(1);
    expect(issue.referencias).toHaveLength(1);
    expect(issue.referencias[0]).toMatchObject({
      referenceType: 'ecommerce_order',
      referenceId: pedidoSumido,
      quantidade: 1,
      situacao: 'inexistente',
    });
    expect(issue.referencias[0].explicacao).toContain('não existe mais');
  });

  it('base limpa responde saudável e sem problema', async () => {
    produto(gerente.companyId, 'Sem reserva', 3);
    const res = await request(app).get('/api/v1/core/stock/reconciliation').set(gerente.auth);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ healthy: true, critical: 0, issues: [] });
  });

  it('a leitura é do escritório; a bancada fica de fora', async () => {
    const atendente = await entrar('atendente-reserva', 'atendente');
    const estoquista = await entrar('estoquista-reserva', 'estoquista');
    const mecanico = await entrar('mecanico-reserva', 'mecanico');
    for (const s of [atendente, estoquista]) {
      expect((await request(app).get('/api/v1/core/stock/reconciliation').set(s.auth)).status).toBe(200);
    }
    expect((await request(app).get('/api/v1/core/stock/reconciliation').set(mecanico.auth)).status).toBe(403);
  });

  it('a conferência é da empresa do token: a reserva da outra operação não aparece', async () => {
    const outra = await loginForTest(app, { userId: 'g-outra', companyId: 'outra-op', profileCodes: ['gerente_loja'] });
    const p = produto(gerente.companyId, 'Só da Conceito', 2);
    reservaDePedidoSumido(gerente.companyId, p);
    const res = await request(app)
      .get('/api/v1/core/stock/reconciliation')
      .set({ Authorization: `Bearer ${outra.body.accessToken}` });
    expect(res.status).toBe(200);
    expect(res.body.issues).toEqual([]);
  });
});

describe('GAP-PRD-087 — liberar a reserva sem origem, com motivo e só pela gerência', () => {
  const liberar = (s: Sessao, productId: string, body: Record<string, unknown>) =>
    request(app)
      .post(`/api/v1/core/stock/reservations/${productId}/liberar-sem-origem`)
      .set(s.auth)
      .send(body);

  it('o gerente solta a unidade presa: disponível volta, razão e trilha registram quem e por quê', async () => {
    const p = produto(gerente.companyId, 'Bolsa Conceito', 5);
    reservaDePedidoSumido(gerente.companyId, p);
    expect(saldo(gerente.companyId, p)).toEqual({ quantity: 5, reserved: 1 });

    const res = await liberar(gerente, p, { reason: 'Pedido online apagado sem soltar a reserva' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ liberado: 1, reservadoAntes: 1, reservadoDepois: 0 });

    // O físico não mexe; só a reserva.
    expect(saldo(gerente.companyId, p)).toEqual({ quantity: 5, reserved: 0 });

    const mov = getConnection()
      .prepare(
        `SELECT movement_type, kind, quantity, reserved_delta, reason, user_id, reference_type
           FROM core_stock_movements WHERE product_id = ? AND kind = 'ORPHAN_RESERVATION_RELEASE'`,
      )
      .get(p) as Record<string, unknown>;
    expect(mov).toMatchObject({
      movement_type: 'release',
      quantity: 0,
      reserved_delta: -1,
      reason: 'Pedido online apagado sem soltar a reserva',
      reference_type: 'reserva_sem_origem',
    });
    expect(mov.user_id).toBeTruthy();

    const trilha = getConnection()
      .prepare("SELECT action, entity_id, detail FROM core_audit_log WHERE action = 'stock.reservation.orphan_released'")
      .get() as { entity_id: string; detail: string };
    expect(trilha.entity_id).toBe(p);
    expect(JSON.parse(trilha.detail)).toMatchObject({ liberado: 1 });

    // E a conferência volta a dizer saudável — sem acusar de novo o pedido já resolvido.
    const depois = await request(app).get('/api/v1/core/stock/reconciliation').set(gerente.auth);
    expect(depois.body.healthy).toBe(true);
    expect(depois.body.issues).toEqual([]);

    // O histórico nomeia o fato em português.
    const kinds = await request(app).get('/api/v1/core/stock/movement-kinds').set(gerente.auth);
    expect(kinds.body.items).toContainEqual({
      kind: 'ORPHAN_RESERVATION_RELEASE',
      label: 'Reserva sem origem liberada',
    });
  });

  it('sem motivo é recusa, e nada muda', async () => {
    const p = produto(gerente.companyId, 'Bolsa', 5);
    reservaDePedidoSumido(gerente.companyId, p);
    const res = await liberar(gerente, p, { reason: '  ' });
    expect(res.status).toBe(400);
    expect(res.body.error?.code ?? res.body.code).toBe('CORE_RESERVATION_RELEASE_REASON_REQUIRED');
    expect(saldo(gerente.companyId, p).reserved).toBe(1);
  });

  it('estoquista e atendente não soltam reserva (403); a reserva continua', async () => {
    const p = produto(gerente.companyId, 'Bolsa', 5);
    reservaDePedidoSumido(gerente.companyId, p);
    for (const perfil of ['estoquista', 'atendente']) {
      const s = await entrar(`${perfil}-libera`, perfil);
      expect((await liberar(s, p, { reason: 'tentativa' })).status).toBe(403);
    }
    expect(saldo(gerente.companyId, p).reserved).toBe(1);
  });

  it('com pedido aberto E reserva órfã, só a parte sem origem é solta', async () => {
    const p = produto(gerente.companyId, 'Tênis', 10);
    pedidoAberto(gerente.companyId, p, 2);
    reservaDePedidoSumido(gerente.companyId, p, 1);
    expect(saldo(gerente.companyId, p).reserved).toBe(3);

    // Pedir mais do que o que está sem origem é recusa nomeada.
    const demais = await liberar(gerente, p, { reason: 'Conferência', quantity: 2 });
    expect(demais.status).toBe(409);
    expect(demais.body.error?.code ?? demais.body.code).toBe('CORE_RESERVATION_RELEASE_EXCEEDS');
    expect(saldo(gerente.companyId, p).reserved).toBe(3);

    // Sem quantidade, solta exatamente a parte sem origem.
    const ok = await liberar(gerente, p, { reason: 'Conferência' });
    expect(ok.status).toBe(200);
    expect(ok.body.liberado).toBe(1);
    expect(saldo(gerente.companyId, p).reserved).toBe(2);

    // A parte do pedido aberto não sai por aqui.
    const deNovo = await liberar(gerente, p, { reason: 'Conferência' });
    expect(deNovo.status).toBe(409);
    expect(deNovo.body.error?.code ?? deNovo.body.code).toBe('CORE_RESERVATION_HAS_SOURCE');
    expect(saldo(gerente.companyId, p).reserved).toBe(2);
  });

  it('produto de outra empresa é 404, e não solta nada', async () => {
    const outra = await loginForTest(app, { userId: 'g-outra2', companyId: 'outra-op2', profileCodes: ['gerente_loja'] });
    const p = produto(gerente.companyId, 'Bolsa', 5);
    reservaDePedidoSumido(gerente.companyId, p);
    const res = await request(app)
      .post(`/api/v1/core/stock/reservations/${p}/liberar-sem-origem`)
      .set({ Authorization: `Bearer ${outra.body.accessToken}` })
      .send({ reason: 'invasão' });
    expect(res.status).toBe(404);
    expect(saldo(gerente.companyId, p).reserved).toBe(1);
  });
});
