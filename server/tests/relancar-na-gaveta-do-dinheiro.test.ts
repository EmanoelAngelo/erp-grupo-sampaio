/**
 * ============================================================================
 * A VENDA GUARDADA SEM SERVIDOR VOLTA PARA A GAVETA ONDE O DINHEIRO ESTÁ, E A
 * ALÇADA DELA É A DE QUEM VENDEU (G-offline-sync-10 / 11 / M03 / 14)
 * ============================================================================
 *
 * G-offline-sync-10 — a tela relançava a pendência na gaveta aberta do
 * computador de QUEM CLICA, e a rota sobrescrevia gaveta e caixa sem olhar onde
 * a venda foi feita. O Caixa 1 vendia R$ 50 em dinheiro sem servidor, a
 * recusa (estoque) ia para "Regularizar", o operador do Caixa 2 relançava — e
 * a venda entrava na gaveta do Caixa 2: sobra de R$ 50 num fechamento, falta
 * no outro. Agora: a gaveta da venda ainda aberta recebe SEMPRE; fechada, a
 * aberta do mesmo caixa; e a de outro caixa só com confirmação.
 *
 * G-offline-sync-11 — a venda recusada por alçada (403) só saía com um gestor
 * logado no computador da gaveta: o relançamento ignorava a liberação do
 * pedido, e o gerente no escritório ouvia "não há gaveta aberta neste
 * computador". Agora o relançamento leva a liberação, e o gerente relança da
 * mesa dele — a venda cai na gaveta dela.
 *
 * G-offline-sync-M03 — o reenvio da fila media a alçada com o token de quem
 * estava logado NA HORA DO ENVIO: o desconto de 30% do operador passava sem
 * liberação se o gerente tivesse entrado no computador antes de a conexão
 * voltar, e a trilha dava a concessão ao gerente.
 *
 * G-offline-sync-14 (a parte do servidor que cabe aqui) — a trilha da venda
 * guardada passa a dizer quando ela aconteceu no balcão (`vendidaEm`).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { getConnection } from '../src/db/sqlite.js';
import { loginForTest, TEST_PASSWORD } from './helpers/auth.js';

const app = createApp();
const LOJA = 'loja-gaveta-do-dinheiro';

type Auth = { Authorization: string };
interface Pessoa {
  auth: Auth;
  id: string;
  login: string;
}

let gerente: Pessoa;
let caixa1: Pessoa;
let caixa2: Pessoa;

async function entrar(userId: string, perfil: string): Promise<Pessoa> {
  const res = await loginForTest(app, { userId, companyId: LOJA, profileCodes: [perfil] });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return {
    auth: { Authorization: `Bearer ${res.body.accessToken as string}` },
    id: String(res.body.user.id),
    login: `${userId}@${LOJA}`,
  };
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  gerente = await entrar('gerente-gaveta-dinheiro', 'gerente_loja');
  caixa1 = await entrar('caixa1-gaveta-dinheiro', 'operador_caixa_loja');
  caixa2 = await entrar('caixa2-gaveta-dinheiro', 'operador_caixa_loja');
});

async function produto(estoque: number, precoCents = 5000): Promise<string> {
  const p = await request(app)
    .post('/api/v1/core/products')
    .set(gerente.auth)
    .send({ name: `Camiseta ${randomUUID().slice(0, 6)}`, priceCents: precoCents });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  if (estoque > 0) await entrada(p.body.id as string, estoque);
  return p.body.id as string;
}

async function entrada(productId: string, quantidade: number): Promise<void> {
  const r = await request(app).post('/api/v1/core/stock/movements').set(gerente.auth).send({
    productId,
    movementType: 'in',
    quantity: quantidade,
    referenceType: 'entrada',
    referenceId: `carga-${randomUUID()}`,
  });
  expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
}

async function caixaRegistrado(nome: string): Promise<string> {
  const r = await request(app).post('/api/v1/core/terminals').set(gerente.auth).send({ name: nome });
  expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
  return r.body.id as string;
}

async function abrirGaveta(quem: Pessoa, terminalId: string | null = null): Promise<string> {
  const r = await request(app)
    .post('/api/v1/core/cash/open')
    .set(quem.auth)
    .send({ openingCents: 0, ...(terminalId ? { terminalId } : {}) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as string;
}

function esperadoNaGaveta(sessionId: string): number {
  return (
    getConnection()
      .prepare('SELECT COALESCE(SUM(amount_cents), 0) AS t FROM core_cash_movements WHERE session_id = ?')
      .get(sessionId) as { t: number }
  ).t;
}

async function fecharGaveta(sessionId: string): Promise<void> {
  const r = await request(app)
    .post(`/api/v1/core/cash/${sessionId}/close`)
    .set(gerente.auth)
    .send({ countedCents: esperadoNaGaveta(sessionId) });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

/** O corpo que o PDV guardou na fila — o de POST /core/sales. */
function corpoDaVenda(productId: string, cashSessionId: string, terminalId: string | null, extra: Record<string, unknown> = {}) {
  return {
    items: [{ productId, quantity: 1, unitPriceCents: 5000 }],
    payments: [{ method: 'dinheiro', amountCents: 5000 }],
    cashSessionId,
    ...(terminalId ? { terminalId } : {}),
    ...extra,
  };
}

function reenviar(quem: Pessoa, chave: string, corpo: Record<string, unknown>) {
  return request(app).post('/api/v1/core/sales').set(quem.auth).set('Idempotency-Key', chave).send(corpo);
}

async function pendencia(quem: Pessoa, chave: string, corpo: Record<string, unknown>, recusa: { code: string; message: string }) {
  const r = await request(app).post('/api/v1/core/offline-sales').set(quem.auth).send({
    idempotencyKey: chave,
    label: 'venda do PDV',
    body: corpo,
    queuedAt: '2026-09-13T21:40:00.000Z',
    errorCode: recusa.code,
    errorMessage: recusa.message,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.pendencia as { id: string; gavetaDeDestino: unknown };
}

function relancar(quem: Pessoa, id: string, corpo: Record<string, unknown>) {
  return request(app).post(`/api/v1/core/offline-sales/${id}/relaunch`).set(quem.auth).send(corpo);
}

function vendaGravada(id: string) {
  return getConnection()
    .prepare('SELECT cash_session_id, terminal_id, total_cents FROM core_sales WHERE id = ?')
    .get(id) as { cash_session_id: string | null; terminal_id: string | null; total_cents: number };
}

function vendas(): number {
  return (getConnection().prepare('SELECT COUNT(*) AS n FROM core_sales WHERE company_id = ?').get(LOJA) as { n: number }).n;
}

/** A venda do Caixa 1 recusada por estoque, com a gaveta dele ainda aberta. */
async function recusadaPorEstoqueNoCaixa1() {
  const p = await produto(1);
  const t1 = await caixaRegistrado('Caixa 1');
  const t2 = await caixaRegistrado('Caixa 2');
  const s1 = await abrirGaveta(caixa1, t1);
  const s2 = await abrirGaveta(caixa2, t2);
  // O Caixa 2 vende a última peça enquanto a venda do Caixa 1 espera na fila.
  expect((await reenviar(caixa2, `outra-${randomUUID()}`, corpoDaVenda(p, s2, t2))).status).toBe(201);
  const chave = `pdv-${randomUUID()}`;
  const corpo = corpoDaVenda(p, s1, t1);
  const reenvio = await reenviar(caixa1, chave, corpo);
  expect(reenvio.status).toBe(409);
  expect(reenvio.body.error.code).toBe('CORE_INSUFFICIENT_STOCK');
  const pend = await pendencia(caixa1, chave, corpo, reenvio.body.error);
  await entrada(p, 1);
  return { p, t1, t2, s1, s2, chave, pend };
}

// ============================================================================

describe('G-offline-sync-10 — o relançamento entra na gaveta onde o dinheiro está', () => {
  it('a gaveta da venda ainda aberta recebe o relançamento, mesmo pedido pelo Caixa 2 com a gaveta dele', async () => {
    const c = await recusadaPorEstoqueNoCaixa1();
    expect(c.pend.gavetaDeDestino).toMatchObject({
      cashSessionId: c.s1,
      terminalId: c.t1,
      terminalName: 'Caixa 1',
      motivo: 'a_da_venda',
    });
    const antesNoCaixa2 = esperadoNaGaveta(c.s2);

    const r = await relancar(caixa2, c.pend.id, { cashSessionId: c.s2, terminalId: c.t2 });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(vendaGravada(r.body.sale.id as string)).toMatchObject({ cash_session_id: c.s1, terminal_id: c.t1 });
    // O dinheiro está na gaveta do Caixa 1, e a venda também; a do Caixa 2 não mexe.
    expect(esperadoNaGaveta(c.s1)).toBe(5000);
    expect(esperadoNaGaveta(c.s2)).toBe(antesNoCaixa2);
    const trilha = getConnection()
      .prepare(`SELECT detail FROM core_audit_log WHERE action = 'sale.offline.regularized' AND entity_id = ?`)
      .get(c.pend.id) as { detail: string };
    expect(JSON.parse(trilha.detail)).toMatchObject({ originalCashSessionId: c.s1, newCashSessionId: c.s1 });
  });

  it('o gerente relança do escritório, sem gaveta no computador dele: a venda cai na gaveta dela', async () => {
    const c = await recusadaPorEstoqueNoCaixa1();
    const r = await relancar(gerente, c.pend.id, { cashSessionId: null, terminalId: null });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(vendaGravada(r.body.sale.id as string).cash_session_id).toBe(c.s1);
  });

  it('a gaveta da venda fechou e o MESMO caixa abriu outra: entra na gaveta nova do mesmo caixa', async () => {
    const p = await produto(5);
    const t1 = await caixaRegistrado('Caixa 1');
    const t2 = await caixaRegistrado('Caixa 2');
    const s1 = await abrirGaveta(caixa1, t1);
    const s2 = await abrirGaveta(caixa2, t2);
    const chave = `pdv-${randomUUID()}`;
    const corpo = corpoDaVenda(p, s1, t1);
    await fecharGaveta(s1);
    const reenvio = await reenviar(caixa1, chave, corpo);
    expect(reenvio.body.error?.code).toBe('CORE_CASH_SESSION_CLOSED');
    const pend = await pendencia(caixa1, chave, corpo, reenvio.body.error);
    expect(pend.gavetaDeDestino).toBeNull();

    const s3 = await abrirGaveta(caixa1, t1);
    const lida = (await request(app).get('/api/v1/core/offline-sales').set(caixa2.auth)).body.items[0];
    expect(lida.gavetaDeDestino).toMatchObject({ cashSessionId: s3, terminalId: t1, motivo: 'mesmo_caixa' });

    const r = await relancar(caixa2, pend.id, { cashSessionId: s2, terminalId: t2 });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(vendaGravada(r.body.sale.id as string)).toMatchObject({ cash_session_id: s3, terminal_id: t1 });
  });

  it('sem gaveta do caixa da venda aberta, a gaveta de OUTRO caixa só entra com confirmação', async () => {
    const p = await produto(5);
    const t1 = await caixaRegistrado('Caixa 1');
    const t2 = await caixaRegistrado('Caixa 2');
    const s1 = await abrirGaveta(caixa1, t1);
    const s2 = await abrirGaveta(caixa2, t2);
    const chave = `pdv-${randomUUID()}`;
    const corpo = corpoDaVenda(p, s1, t1);
    await fecharGaveta(s1);
    const reenvio = await reenviar(caixa1, chave, corpo);
    const pend = await pendencia(caixa1, chave, corpo, reenvio.body.error);
    const antes = vendas();

    const semConfirmar = await relancar(caixa2, pend.id, { cashSessionId: s2, terminalId: t2 });
    expect(semConfirmar.status).toBe(409);
    expect(semConfirmar.body.error.code).toBe('CORE_OFFLINE_SALE_OTHER_DRAWER');
    expect(semConfirmar.body.error.details).toMatchObject({ confirmavel: true, terminalDaVenda: t1, caixaDaVenda: 'Caixa 1' });
    expect(semConfirmar.body.error.message).toMatch(/Caixa 1/);
    expect(vendas()).toBe(antes);
    // A recusa é de quem relança, e não da venda: a pendência segue com o motivo dela.
    const guardada = getConnection()
      .prepare('SELECT status, error_code FROM core_offline_sale_pendings WHERE id = ?')
      .get(pend.id) as { status: string; error_code: string };
    expect(guardada).toEqual({ status: 'pendente', error_code: 'CORE_CASH_SESSION_CLOSED' });

    const confirmado = await relancar(caixa2, pend.id, { cashSessionId: s2, terminalId: t2, confirmarOutraGaveta: true });
    expect(confirmado.status, JSON.stringify(confirmado.body)).toBe(201);
    expect(vendaGravada(confirmado.body.sale.id as string).cash_session_id).toBe(s2);
  });
});

describe('G-offline-sync-11 — a pendência recusada por alçada sai com a liberação do gestor', () => {
  async function recusadaPorAlcada() {
    const p = await produto(10);
    const s1 = await abrirGaveta(caixa1);
    const chave = `pdv-${randomUUID()}`;
    // 30% de desconto de rodapé, com o servidor fora: a tela não tinha como pedir liberação.
    const corpo = {
      items: [{ productId: p, quantity: 1, unitPriceCents: 5000 }],
      payments: [{ method: 'dinheiro', amountCents: 3500 }],
      discountCents: 1500,
      cashSessionId: s1,
    };
    const reenvio = await reenviar(caixa1, chave, corpo);
    expect(reenvio.status, JSON.stringify(reenvio.body)).toBe(403);
    expect(reenvio.body.error.code).toBe('CORE_DISCOUNT_NEEDS_AUTHORIZATION');
    const pend = await pendencia(caixa1, chave, corpo, reenvio.body.error);
    return { p, s1, chave, pend };
  }

  it('o operador pede a liberação do gestor e relança com ela, na gaveta da venda', async () => {
    const c = await recusadaPorAlcada();
    const semLiberacao = await relancar(caixa1, c.pend.id, {});
    expect(semLiberacao.status).toBe(403);
    expect(semLiberacao.body.error.code).toBe('CORE_DISCOUNT_NEEDS_AUTHORIZATION');

    const liberacao = await request(app)
      .post('/api/v1/core/authorizations')
      .set(caixa1.auth)
      .send({
        action: 'desconto_acima_limite',
        login: gerente.login,
        password: TEST_PASSWORD,
        concedidoCents: 1500,
        brutoCents: 5000,
        reason: 'venda guardada sem servidor',
      });
    expect(liberacao.status, JSON.stringify(liberacao.body)).toBe(201);

    const r = await relancar(caixa1, c.pend.id, { authorizationId: liberacao.body.id });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(vendaGravada(r.body.sale.id as string)).toMatchObject({ cash_session_id: c.s1, total_cents: 3500 });
  });

  it('o gerente no escritório relança sem gaveta no computador dele, com a alçada dele', async () => {
    const c = await recusadaPorAlcada();
    const r = await relancar(gerente, c.pend.id, { cashSessionId: null, terminalId: null });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(vendaGravada(r.body.sale.id as string).cash_session_id).toBe(c.s1);
  });
});

describe('G-offline-sync-M03 — o reenvio da fila mede a alçada de quem vendeu', () => {
  const HORA_DA_VENDA = '2026-09-13T21:40:00.000Z';

  async function cenario() {
    const p = await produto(10);
    const s1 = await abrirGaveta(caixa1);
    const corpo = {
      items: [{ productId: p, quantity: 1, unitPriceCents: 5000 }],
      payments: [{ method: 'dinheiro', amountCents: 3500 }],
      discountCents: 1500,
      cashSessionId: s1,
    };
    return { p, s1, corpo };
  }

  it('a venda do operador reenviada com o token do gerente NÃO passa sem liberação', async () => {
    const c = await cenario();
    const reenvio = await reenviar(gerente, `pdv-${randomUUID()}`, {
      ...c.corpo,
      vendaGuardada: { userId: caixa1.id, queuedAt: HORA_DA_VENDA },
    });
    expect(reenvio.status, JSON.stringify(reenvio.body)).toBe(403);
    expect(reenvio.body.error.code).toBe('CORE_DISCOUNT_NEEDS_AUTHORIZATION');

    // A MESMA venda feita pelo próprio gerente passa: o que mudou foi quem vendeu.
    const doGerente = await reenviar(gerente, `pdv-${randomUUID()}`, c.corpo);
    expect(doGerente.status, JSON.stringify(doGerente.body)).toBe(201);
  });

  it('declarar o gerente como vendedor não abre alçada para o operador', async () => {
    const c = await cenario();
    const r = await reenviar(caixa1, `pdv-${randomUUID()}`, {
      ...c.corpo,
      vendaGuardada: { userId: gerente.id, queuedAt: HORA_DA_VENDA },
    });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('CORE_DISCOUNT_NEEDS_AUTHORIZATION');
  });

  it('vendedor que não é desta operação não tem alçada', async () => {
    const c = await cenario();
    const r = await reenviar(gerente, `pdv-${randomUUID()}`, {
      ...c.corpo,
      vendaGuardada: { userId: 'ninguem-desta-loja', queuedAt: HORA_DA_VENDA },
    });
    expect(r.status).toBe(403);
  });

  it('sem concessão acima do limite, passa — e a trilha diz quem vendeu, quem enviou e quando foi a venda', async () => {
    const c = await cenario();
    const r = await reenviar(gerente, `pdv-${randomUUID()}`, {
      items: [{ productId: c.p, quantity: 1, unitPriceCents: 5000 }],
      payments: [{ method: 'dinheiro', amountCents: 5000 }],
      cashSessionId: c.s1,
      vendaGuardada: { userId: caixa1.id, queuedAt: HORA_DA_VENDA },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const trilha = getConnection()
      .prepare(`SELECT user_id, detail FROM core_audit_log WHERE action = 'sale.create' AND entity_id = ?`)
      .get(r.body.id as string) as { user_id: string; detail: string };
    /*
      A trilha ganhou dois campos com a G-offline-sync-14: com que hora a venda
      ENTROU (`registradaEm`) e por que não foi a do PDV quando não foi
      (`motivoDaHora`). Neste cenário a gaveta foi aberta agora, DEPOIS da hora
      da venda guardada, então a venda entra com a hora de agora e o motivo vem
      preenchido — o texto exato depende do relógio de quando o teste roda (a
      abertura da gaveta ou as 72 horas), e quem o prova é
      `venda-complementos-auditoria-pj.test.ts`.
    */
    expect(JSON.parse(trilha.detail).vendaGuardada).toEqual({
      vendidaPor: caixa1.id,
      enviadaPor: gerente.id,
      vendidaEm: HORA_DA_VENDA,
      registradaEm: expect.any(String),
      motivoDaHora: expect.any(String),
    });
  });
});
