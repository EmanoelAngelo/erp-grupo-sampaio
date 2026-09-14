/**
 * DINHEIRO EM ESPÉCIE SÓ ENTRA OU SAI POR UMA GAVETA ABERTA (GAP-PRD-134,
 * GAP-PRD-161).
 *
 * ============================================================================
 * O QUE ACONTECIA
 * ============================================================================
 *
 *   GAP-PRD-134  `POST /core/sales` em dinheiro sem `cashSessionId`, com o
 *                caixa ABERTO: 201, e a gaveta sem movimento nenhum. O PDV
 *                sempre manda o id; a regra morava só nele — a tela de
 *                consignação, por exemplo, nunca mandou.
 *
 *   GAP-PRD-161  `POST /core/sale-returns` em dinheiro apontando uma gaveta
 *                FECHADA (ou nenhuma): 201, a despesa no financeiro e nenhum
 *                movimento de gaveta. O dinheiro saía da mão do operador e o
 *                fechamento acusava falta.
 *
 * ============================================================================
 * A REGRA — a mesma régua do cancelamento, agora num lugar só
 * (`GavetaDoDinheiro.gavetaDoDinheiro`)
 * ============================================================================
 *
 *  1. a gaveta informada, se é desta operação e está aberta;
 *  2. sem gaveta informada (ou, na devolução e no cancelamento, com a informada
 *     já fechada): a gaveta aberta DO CAIXA do pedido; sem caixa no pedido, a
 *     ÚNICA gaveta aberta da operação;
 *  3. mais de uma gaveta aberta e nenhum caixa no pedido: recusa nomeada —
 *     escolher uma seria pôr o dinheiro na gaveta do colega;
 *  4. nenhuma gaveta aberta numa operação que trabalha com gaveta: recusa
 *     nomeada (409 CORE_CASH_SESSION_REQUIRED), antes de gravar qualquer coisa.
 *
 * A operação que nunca abriu gaveta não tem fechamento nenhum a desmentir:
 * segue aceitando, e o teste diz isso por escrito.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { getConnection } from '../src/db/sqlite.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();
const LOJA = 'loja-gaveta-sempre';
const OUTRA = 'loja-gaveta-vizinha';

type Auth = { Authorization: string };
let gerente: Auth;

async function entrar(empresa: string, userId: string): Promise<Auth> {
  const res = await loginForTest(app, { userId, companyId: empresa, profileCodes: ['gerente_loja'] });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { Authorization: `Bearer ${res.body.accessToken as string}` };
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  gerente = await entrar(LOJA, 'gerente-gaveta');
});

async function produto(auth: Auth, precoCents = 5000): Promise<string> {
  const p = await request(app)
    .post('/api/v1/core/products')
    .set(auth)
    .send({ name: `Produto ${randomUUID().slice(0, 6)}`, priceCents: precoCents });
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

async function abrirCaixa(auth: Auth, corpo: Record<string, unknown> = {}): Promise<string> {
  const res = await request(app)
    .post('/api/v1/core/cash/open')
    .set(auth)
    .send({ openingCents: 0, ...corpo });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

function esperadoNaGaveta(sessionId: string): number {
  return (
    getConnection()
      .prepare('SELECT COALESCE(SUM(amount_cents), 0) AS t FROM core_cash_movements WHERE session_id = ?')
      .get(sessionId) as { t: number }
  ).t;
}

async function fecharCaixa(auth: Auth, sessionId: string) {
  const res = await request(app)
    .post(`/api/v1/core/cash/${sessionId}/close`)
    .set(auth)
    .send({ countedCents: esperadoNaGaveta(sessionId) });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

async function criarCaixa(auth: Auth, nome: string): Promise<string> {
  const res = await request(app).post('/api/v1/core/terminals').set(auth).send({ name: nome });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

function vender(auth: Auth, corpo: Record<string, unknown>) {
  return request(app)
    .post('/api/v1/core/sales')
    .set(auth)
    .set('Idempotency-Key', randomUUID())
    .send(corpo);
}

function movimentos(sessionId: string) {
  return getConnection()
    .prepare(
      `SELECT movement_type, amount_cents, reference_id, note FROM core_cash_movements
        WHERE session_id = ? AND movement_type <> 'opening' ORDER BY created_at, rowid`,
    )
    .all(sessionId) as unknown as {
    movement_type: string;
    amount_cents: number;
    reference_id: string;
    note: string | null;
  }[];
}

function daVenda(id: string) {
  return getConnection()
    .prepare('SELECT cash_session_id, terminal_id FROM core_sales WHERE id = ?')
    .get(id) as { cash_session_id: string | null; terminal_id: string | null };
}

function contar(sql: string, ...params: string[]): number {
  return (getConnection().prepare(sql).get(...params) as { n: number }).n;
}

// ============================================================================
// GAP-PRD-134 — a venda em dinheiro sem gaveta informada
// ============================================================================

describe('GAP-PRD-134 — venda em dinheiro sem cashSessionId', () => {
  it('com o caixa aberto, a venda cai nele: gaveta com o líquido (troco descontado)', async () => {
    const p = await produto(gerente);
    const caixa = await abrirCaixa(gerente);

    // Paga R$ 60 por R$ 50: R$ 10 de troco saem da mesma gaveta.
    const res = await vender(gerente, {
      items: [{ productId: p, quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: 6000 }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(daVenda(res.body.id).cash_session_id).toBe(caixa);

    const mov = movimentos(caixa);
    expect(mov).toHaveLength(1);
    expect(mov[0].movement_type).toBe('sale');
    expect(mov[0].amount_cents).toBe(5000);
    expect(mov[0].reference_id).toBe(res.body.id);
  });

  it('operação que trabalha com gaveta, nenhuma aberta: 409 CORE_CASH_SESSION_REQUIRED e nada gravado', async () => {
    const p = await produto(gerente);
    const caixa = await abrirCaixa(gerente);
    await fecharCaixa(gerente, caixa);

    const res = await vender(gerente, {
      items: [{ productId: p, quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: 5000 }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe('CORE_CASH_SESSION_REQUIRED');
    expect(res.body.error.message).toMatch(/R\$ 50,00/);
    expect(contar('SELECT COUNT(*) AS n FROM core_sales WHERE company_id = ?', LOJA)).toBe(0);
  });

  it('venda só no cartão ou no PIX TAMBÉM precisa de turno — com tudo fechado, é recusada', async () => {
    /*
      O COMPORTAMENTO MUDOU (E-venda-servidor-08 / H-caixa-seguranca-05).
      Este caso provava o contrário: "cartão e PIX não precisam de gaveta, nem
      com tudo fechado". A venda nascia com `cash_session_id` NULO e sumia do
      "recebido no turno, por meio" — o fechamento soma por
      `cash_session_id = ?` —, e a conferência da maquininha com o turno nunca
      batia. Na operação que trabalha com gaveta, a venda de balcão agora cai
      num turno qualquer que seja a forma de pagamento; sem turno aberto, é a
      mesma recusa nomeada da espécie. A operação que nunca abriu gaveta segue
      vendendo sem turno (ver `venda-entrada-conferida`).
    */
    const p = await produto(gerente);
    const caixa = await abrirCaixa(gerente);
    await fecharCaixa(gerente, caixa);

    const res = await vender(gerente, {
      items: [{ productId: p, quantity: 1 }],
      payments: [{ method: 'pix', amountCents: 5000 }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe('CORE_CASH_SESSION_REQUIRED');
    expect(contar('SELECT COUNT(*) AS n FROM core_sales WHERE company_id = ?', LOJA)).toBe(0);

    // Com o turno aberto, a mesma venda entra nele.
    const novo = await abrirCaixa(gerente);
    const ok = await vender(gerente, {
      items: [{ productId: p, quantity: 1 }],
      payments: [{ method: 'pix', amountCents: 5000 }],
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(daVenda(ok.body.id).cash_session_id).toBe(novo);
  });

  it('dois caixas com gaveta aberta e o pedido sem caixa: recusa nomeando as duas', async () => {
    const p = await produto(gerente);
    const cx1 = await criarCaixa(gerente, 'Caixa 1');
    const cx2 = await criarCaixa(gerente, 'Caixa 2');
    await abrirCaixa(gerente, { terminalId: cx1 });
    await abrirCaixa(gerente, { terminalId: cx2 });

    const res = await vender(gerente, {
      items: [{ productId: p, quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: 5000 }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe('CORE_CASH_SESSION_REQUIRED');
    expect(res.body.error.message).toMatch(/Caixa 1/);
    expect(res.body.error.message).toMatch(/Caixa 2/);
  });

  it('com o caixa no pedido, a venda cai na gaveta DELE', async () => {
    const p = await produto(gerente);
    const cx1 = await criarCaixa(gerente, 'Caixa 1');
    const cx2 = await criarCaixa(gerente, 'Caixa 2');
    const g1 = await abrirCaixa(gerente, { terminalId: cx1 });
    const g2 = await abrirCaixa(gerente, { terminalId: cx2 });

    const res = await vender(gerente, {
      items: [{ productId: p, quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: 5000 }],
      terminalId: cx2,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(daVenda(res.body.id).cash_session_id).toBe(g2);
    expect(daVenda(res.body.id).terminal_id).toBe(cx2);
    expect(movimentos(g2).map((m) => m.amount_cents)).toEqual([5000]);
    expect(movimentos(g1)).toHaveLength(0);
  });

  it('o caixa do pedido sem gaveta aberta não empresta a do colega', async () => {
    const p = await produto(gerente);
    const cx1 = await criarCaixa(gerente, 'Caixa 1');
    const cx2 = await criarCaixa(gerente, 'Caixa 2');
    const g1 = await abrirCaixa(gerente, { terminalId: cx1 });

    const res = await vender(gerente, {
      items: [{ productId: p, quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: 5000 }],
      terminalId: cx2,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe('CORE_CASH_SESSION_REQUIRED');
    expect(res.body.error.message).toMatch(/Caixa 2/);
    expect(movimentos(g1)).toHaveLength(0);
  });

  it('a gaveta informada continua valendo — e fechada continua recusada (400 CORE_CASH_SESSION_CLOSED)', async () => {
    const p = await produto(gerente);
    const caixa = await abrirCaixa(gerente);
    await fecharCaixa(gerente, caixa);
    await abrirCaixa(gerente);

    const res = await vender(gerente, {
      items: [{ productId: p, quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: 5000 }],
      cashSessionId: caixa,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error.code).toBe('CORE_CASH_SESSION_CLOSED');
  });

  it('a transição, dita por escrito: operação que nunca abriu gaveta segue aceitando', async () => {
    /*
      Sem gaveta nenhuma não há fechamento a desmentir. O PDV já exige abrir
      o caixa antes da primeira venda; a partir da primeira abertura, a regra
      acima vale para sempre nesta operação.
    */
    const p = await produto(gerente);
    const res = await vender(gerente, {
      items: [{ productId: p, quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: 5000 }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(daVenda(res.body.id).cash_session_id).toBeNull();
  });

  it('a pré-venda convertida sem gaveta informada também cai no caixa aberto', async () => {
    const p = await produto(gerente);
    const caixa = await abrirCaixa(gerente);
    const doc = await request(app)
      .post('/api/v1/core/quotes')
      .set(gerente)
      .send({ kind: 'pre_venda', items: [{ productId: p, quantity: 1 }] });
    expect(doc.status, JSON.stringify(doc.body)).toBe(201);

    const res = await request(app)
      .post(`/api/v1/core/quotes/${doc.body.id}/convert`)
      .set(gerente)
      .set('Idempotency-Key', randomUUID())
      .send({ payments: [{ method: 'dinheiro', amountCents: 5000 }] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(movimentos(caixa).map((m) => m.amount_cents)).toEqual([5000]);
  });
});

// ============================================================================
// GAP-PRD-161 — a devolução em dinheiro
// ============================================================================

async function vendaEmDinheiro(caixa: string, valor = 5000) {
  const p = await produto(gerente, valor);
  const res = await vender(gerente, {
    items: [{ productId: p, quantity: 1 }],
    payments: [{ method: 'dinheiro', amountCents: valor }],
    cashSessionId: caixa,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const itens = await request(app).get(`/api/v1/core/sales/${res.body.id}/returnable`).set(gerente);
  return { saleId: res.body.id as string, saleItemId: itens.body.items[0].sale_item_id as string, produto: p };
}

function devolver(auth: Auth, corpo: Record<string, unknown>) {
  return request(app).post('/api/v1/core/sale-returns').set(auth).send({ reason: 'Cliente devolveu', ...corpo });
}

describe('GAP-PRD-161 — devolução em dinheiro', () => {
  it('apontando a gaveta FECHADA, o dinheiro sai da gaveta aberta de hoje — com a nota dizendo', async () => {
    const ontem = await abrirCaixa(gerente);
    const venda = await vendaEmDinheiro(ontem);
    await fecharCaixa(gerente, ontem);
    const hoje = await abrirCaixa(gerente, { openingCents: 10000 });

    const res = await devolver(gerente, {
      saleId: venda.saleId,
      refundMethod: 'dinheiro',
      cashSessionId: ontem,
      items: [{ saleItemId: venda.saleItemId, quantity: 1 }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.cash_session_id).toBe(hoje);

    // O turno de ontem fica como foi contado e assinado.
    expect(movimentos(ontem).map((m) => m.movement_type)).toEqual(['sale']);
    const deHoje = movimentos(hoje);
    expect(deHoje).toHaveLength(1);
    expect(deHoje[0].movement_type).toBe('sale_return');
    expect(deHoje[0].amount_cents).toBe(-5000);
    expect(deHoje[0].note ?? '').toMatch(/turno já fechado/);
    expect(esperadoNaGaveta(hoje)).toBe(5000);
  });

  it('gaveta fechada e nenhuma aberta: 409 CORE_CASH_SESSION_REQUIRED, e nada da devolução fica', async () => {
    const ontem = await abrirCaixa(gerente);
    const venda = await vendaEmDinheiro(ontem);
    await fecharCaixa(gerente, ontem);

    const saldoAntes = (
      getConnection()
        .prepare('SELECT quantity FROM core_stock WHERE company_id = ? AND product_id = ?')
        .get(LOJA, venda.produto) as { quantity: number }
    ).quantity;

    const res = await devolver(gerente, {
      saleId: venda.saleId,
      refundMethod: 'dinheiro',
      cashSessionId: ontem,
      items: [{ saleItemId: venda.saleItemId, quantity: 1 }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe('CORE_CASH_SESSION_REQUIRED');
    expect(res.body.error.message).toMatch(/R\$ 50,00/);

    expect(contar('SELECT COUNT(*) AS n FROM core_sale_returns WHERE sale_id = ?', venda.saleId)).toBe(0);
    expect(
      contar("SELECT COUNT(*) AS n FROM core_finance_entries WHERE origin_type = 'sale_return' AND company_id = ?", LOJA),
    ).toBe(0);
    const saldoDepois = (
      getConnection()
        .prepare('SELECT quantity FROM core_stock WHERE company_id = ? AND product_id = ?')
        .get(LOJA, venda.produto) as { quantity: number }
    ).quantity;
    expect(saldoDepois).toBe(saldoAntes);
  });

  it('sem cashSessionId e com caixa aberto: sai dele', async () => {
    const caixa = await abrirCaixa(gerente, { openingCents: 10000 });
    const venda = await vendaEmDinheiro(caixa);

    const res = await devolver(gerente, {
      saleId: venda.saleId,
      refundMethod: 'dinheiro',
      items: [{ saleItemId: venda.saleItemId, quantity: 1 }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.cash_session_id).toBe(caixa);
    expect(movimentos(caixa).map((m) => m.movement_type)).toEqual(['sale', 'sale_return']);
    expect(esperadoNaGaveta(caixa)).toBe(10000);
  });

  it('gaveta de OUTRA operação no corpo: 400 CORE_CASH_SESSION_INVALID', async () => {
    const vizinho = await entrar(OUTRA, 'gerente-vizinho');
    const gavetaDaVizinha = await abrirCaixa(vizinho);
    const caixa = await abrirCaixa(gerente);
    const venda = await vendaEmDinheiro(caixa);

    const res = await devolver(gerente, {
      saleId: venda.saleId,
      refundMethod: 'dinheiro',
      cashSessionId: gavetaDaVizinha,
      items: [{ saleItemId: venda.saleItemId, quantity: 1 }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error.code).toBe('CORE_CASH_SESSION_INVALID');
    expect(movimentos(gavetaDaVizinha)).toHaveLength(0);
  });

  it('PIX, estorno no cartão e crédito não passam pela gaveta — devolvem com tudo fechado', async () => {
    const caixa = await abrirCaixa(gerente);
    const venda = await vendaEmDinheiro(caixa);
    await fecharCaixa(gerente, caixa);

    const res = await devolver(gerente, {
      saleId: venda.saleId,
      refundMethod: 'pix',
      items: [{ saleItemId: venda.saleItemId, quantity: 1 }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.cash_session_id).toBeNull();
  });

  it('com dois caixas, a devolução sai da gaveta do caixa do pedido', async () => {
    const cx1 = await criarCaixa(gerente, 'Caixa 1');
    const cx2 = await criarCaixa(gerente, 'Caixa 2');
    const g1 = await abrirCaixa(gerente, { terminalId: cx1 });
    const g2 = await abrirCaixa(gerente, { terminalId: cx2, openingCents: 10000 });
    const venda = await vendaEmDinheiro(g1);

    const semCaixa = await devolver(gerente, {
      saleId: venda.saleId,
      refundMethod: 'dinheiro',
      items: [{ saleItemId: venda.saleItemId, quantity: 1 }],
    });
    expect(semCaixa.status, JSON.stringify(semCaixa.body)).toBe(409);
    expect(semCaixa.body.error.code).toBe('CORE_CASH_SESSION_REQUIRED');

    const res = await devolver(gerente, {
      saleId: venda.saleId,
      refundMethod: 'dinheiro',
      terminalId: cx2,
      items: [{ saleItemId: venda.saleItemId, quantity: 1 }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.cash_session_id).toBe(g2);
    expect(movimentos(g2).map((m) => m.amount_cents)).toEqual([-5000]);
  });
});

// ============================================================================
// O cancelamento usa a mesma régua (dependência registrada no lote P2)
// ============================================================================

describe('cancelamento de venda de turno fechado, com vários caixas', () => {
  it('o débito vai para a gaveta do caixa de quem cancela, e não para a aberta mais recente', async () => {
    const cx1 = await criarCaixa(gerente, 'Caixa 1');
    const cx2 = await criarCaixa(gerente, 'Caixa 2');
    const turno1 = await abrirCaixa(gerente, { terminalId: cx1 });
    const venda = await vendaEmDinheiro(turno1);
    await fecharCaixa(gerente, turno1);

    const novoTurno1 = await abrirCaixa(gerente, { terminalId: cx1, openingCents: 10000 });
    // A mais recente é a do Caixa 2 — a régua antiga escolheria esta.
    const turno2 = await abrirCaixa(gerente, { terminalId: cx2, openingCents: 10000 });

    const semCaixa = await request(app)
      .post(`/api/v1/core/sales/${venda.saleId}/cancel`)
      .set(gerente)
      .send({ reason: 'cliente desistiu' });
    expect(semCaixa.status, JSON.stringify(semCaixa.body)).toBe(409);
    expect(semCaixa.body.error.code).toBe('CORE_CASH_SESSION_REQUIRED');

    const res = await request(app)
      .post(`/api/v1/core/sales/${venda.saleId}/cancel`)
      .set(gerente)
      .send({ reason: 'cliente desistiu', terminalId: cx1 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(movimentos(novoTurno1).map((m) => m.amount_cents)).toEqual([-5000]);
    expect(movimentos(turno2)).toHaveLength(0);
  });
});

describe('cancelar depois de devolver em dinheiro não tira da gaveta duas vezes', () => {
  it('venda de R$ 100, devolução de R$ 50 pela gaveta, cancelamento: sai só o resto, e a gaveta volta a zero', async () => {
    /*
      Medido antes da correção: a gaveta terminava em -R$ 50,00. O cancelamento
      debitava os R$ 100 da venda inteira, sem descontar os R$ 50 que a
      devolução já tinha tirado da MESMA gaveta — o cliente recebia R$ 150 por
      R$ 100 pagos, e o fechamento acusava a falta.
    */
    const caixa = await abrirCaixa(gerente);
    const p = await produto(gerente, 5000);
    const venda = await vender(gerente, {
      items: [{ productId: p, quantity: 2 }],
      payments: [{ method: 'dinheiro', amountCents: 10000 }],
      cashSessionId: caixa,
    });
    expect(venda.status, JSON.stringify(venda.body)).toBe(201);
    const itens = await request(app).get(`/api/v1/core/sales/${venda.body.id}/returnable`).set(gerente);

    const devolucao = await devolver(gerente, {
      saleId: venda.body.id,
      refundMethod: 'dinheiro',
      cashSessionId: caixa,
      items: [{ saleItemId: itens.body.items[0].sale_item_id, quantity: 1 }],
    });
    expect(devolucao.status, JSON.stringify(devolucao.body)).toBe(201);

    const cancelada = await request(app)
      .post(`/api/v1/core/sales/${venda.body.id}/cancel`)
      .set(gerente)
      .send({ reason: 'desistiu do resto' });
    expect(cancelada.status, JSON.stringify(cancelada.body)).toBe(200);

    expect(movimentos(caixa).map((m) => [m.movement_type, m.amount_cents])).toEqual([
      ['sale', 10000],
      ['sale_return', -5000],
      ['sale_cancel', -5000],
    ]);
    expect(esperadoNaGaveta(caixa)).toBe(0);
  });
});
