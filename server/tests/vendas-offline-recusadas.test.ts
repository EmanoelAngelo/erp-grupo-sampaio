/**
 * ============================================================================
 * A VENDA GUARDADA OFFLINE QUE O SERVIDOR RECUSOU (GAP-PRD-045 / GAP-PRD-046)
 * ============================================================================
 *
 * O PDV guarda a venda na fila do navegador quando o servidor da loja não
 * responde e reenvia quando ele volta, com a MESMA chave de idempotência. A
 * auditoria mediu (a1-concorrencia C5) que duas recusas nunca passam com nova
 * tentativa — o caixa daquele turno fechou, o estoque acabou — e que nas duas
 * o dinheiro JÁ foi recebido. A venda ficava presa no `localStorage` daquele
 * computador: sem tela para relançar, invisível ao gestor e aos outros caixas.
 *
 * Os casos cobram o caminho de regularização, sem desenvolvedor:
 *
 *   - a venda recusada é entregue ao servidor e aparece para o gestor E para
 *     outro caixa da operação (nunca para outra empresa);
 *   - relançar usa a MESMA chave na gaveta aberta: a venda nasce uma vez só,
 *     relançar de novo é recusado, e o reenvio da fila devolve a mesma venda;
 *   - estoque que acabou: o relançamento é recusado com o motivo, a pendência
 *     guarda a recusa, e depois da entrada de estoque ela passa;
 *   - descartar é da gerência, com motivo e trilha;
 *   - a venda recusada de uma gaveta AINDA ABERTA entra no fechamento: fechar
 *     com o dinheiro dela na gaveta exige ciência e motivo.
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
const LOJA = 'loja-venda-guardada';
const OUTRA = 'loja-vizinha-guardada';

type Auth = { Authorization: string };
let gerente: Auth;
let caixa: Auth;

async function entrar(empresa: string, userId: string, perfil: string): Promise<Auth> {
  const res = await loginForTest(app, { userId, companyId: empresa, profileCodes: [perfil] });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { Authorization: `Bearer ${res.body.accessToken as string}` };
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  gerente = await entrar(LOJA, 'gerente-guardada', 'gerente_loja');
  caixa = await entrar(LOJA, 'caixa-guardada', 'operador_caixa_loja');
});

async function produto(auth: Auth, estoque: number, precoCents = 5000): Promise<string> {
  const p = await request(app)
    .post('/api/v1/core/products')
    .set(auth)
    .send({ name: `Produto ${randomUUID().slice(0, 6)}`, priceCents: precoCents });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  if (estoque > 0) await entrada(auth, p.body.id as string, estoque);
  return p.body.id as string;
}

async function entrada(auth: Auth, productId: string, quantidade: number): Promise<void> {
  const r = await request(app).post('/api/v1/core/stock/movements').set(auth).send({
    productId,
    movementType: 'in',
    quantity: quantidade,
    referenceType: 'entrada',
    referenceId: `carga-${randomUUID()}`,
  });
  expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
}

async function abrirCaixa(auth: Auth): Promise<string> {
  const res = await request(app).post('/api/v1/core/cash/open').set(auth).send({ openingCents: 0 });
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

function fechar(auth: Auth, sessionId: string, extra: Record<string, unknown> = {}) {
  return request(app)
    .post(`/api/v1/core/cash/${sessionId}/close`)
    .set(auth)
    .send({ countedCents: esperadoNaGaveta(sessionId), ...extra });
}

/** O corpo que o PDV guardou na fila — exatamente o de POST /core/sales. */
function corpoDaVenda(productId: string, cashSessionId: string, quantidade = 1, precoCents = 5000) {
  return {
    items: [{ productId, quantity: quantidade, unitPriceCents: precoCents }],
    payments: [{ method: 'dinheiro', amountCents: quantidade * precoCents }],
    cashSessionId,
  };
}

/** O reenvio da fila: POST /core/sales com a chave guardada. */
function reenviar(auth: Auth, chave: string, corpo: Record<string, unknown>) {
  return request(app).post('/api/v1/core/sales').set(auth).set('Idempotency-Key', chave).send(corpo);
}

/** O que o PDV faz quando o reenvio é recusado de vez: entrega ao servidor. */
function entregar(auth: Auth, chave: string, corpo: Record<string, unknown>, recusa: { code: string; message: string }) {
  return request(app).post('/api/v1/core/offline-sales').set(auth).send({
    idempotencyKey: chave,
    label: 'venda do PDV',
    body: corpo,
    queuedAt: '2026-09-10T14:05:00.000Z',
    errorCode: recusa.code,
    errorMessage: recusa.message,
  });
}

function vendasComAChave(chave: string): number {
  return (
    getConnection()
      .prepare('SELECT COUNT(*) AS n FROM core_sales WHERE company_id = ? AND idempotency_key = ?')
      .get(LOJA, chave) as { n: number }
  ).n;
}

describe('o caixa do turno fechou antes de a venda subir', () => {
  it('a recusa vira pendência do servidor, e relançar na gaveta aberta vende UMA vez com a mesma chave', async () => {
    const produtoId = await produto(gerente, 10);
    const turnoDaVenda = await abrirCaixa(caixa);
    // A venda aconteceu no balcão com o servidor fora: nada chegou aqui.
    const chave = `pdv-${randomUUID()}`;
    const corpo = corpoDaVenda(produtoId, turnoDaVenda);
    expect((await fechar(caixa, turnoDaVenda)).status).toBe(200);

    // O servidor volta; a fila reenvia e é recusada — para sempre.
    const reenvio = await reenviar(caixa, chave, corpo);
    expect(reenvio.status).toBe(400);
    expect(reenvio.body.error.code).toBe('CORE_CASH_SESSION_CLOSED');

    const entregue = await entregar(caixa, chave, corpo, reenvio.body.error);
    expect(entregue.status, JSON.stringify(entregue.body)).toBe(201);
    expect(entregue.body.jaSubiu).toBe(false);
    const pendencia = entregue.body.pendencia;
    expect(pendencia).toMatchObject({
      status: 'pendente',
      receivedCents: 5000,
      itemsCount: 1,
      cashSessionId: turnoDaVenda,
      errorCode: 'CORE_CASH_SESSION_CLOSED',
      queuedAt: '2026-09-10T14:05:00.000Z',
    });
    expect(pendencia.items[0].name).toMatch(/Produto/);

    // Entregar de novo (o PDV repetiu) não duplica a pendência.
    expect((await entregar(caixa, chave, corpo, reenvio.body.error)).body.pendencia.id).toBe(pendencia.id);

    // O gestor enxerga — e é a pergunta que a ficha fazia.
    const doGestor = await request(app).get('/api/v1/core/offline-sales').set(gerente);
    expect(doGestor.status).toBe(200);
    expect(doGestor.body.items.map((i: { id: string }) => i.id)).toEqual([pendencia.id]);

    // Relança na gaveta aberta de agora.
    const turnoDeAgora = await abrirCaixa(caixa);
    const relancada = await request(app)
      .post(`/api/v1/core/offline-sales/${pendencia.id}/relaunch`)
      .set(caixa)
      .send({ cashSessionId: turnoDeAgora });
    expect(relancada.status, JSON.stringify(relancada.body)).toBe(201);
    expect(relancada.body.duplicated).toBe(false);
    expect(relancada.body.pendencia.status).toBe('regularizada');
    expect(relancada.body.pendencia.saleId).toBe(relancada.body.sale.id);
    expect(relancada.body.pendencia.saleNumber).toBe(relancada.body.sale.number);

    // A venda é a da chave guardada, e o dinheiro entrou na gaveta ABERTA.
    const venda = getConnection()
      .prepare('SELECT idempotency_key, cash_session_id, total_cents FROM core_sales WHERE id = ?')
      .get(relancada.body.sale.id) as { idempotency_key: string; cash_session_id: string; total_cents: number };
    expect(venda).toEqual({ idempotency_key: chave, cash_session_id: turnoDeAgora, total_cents: 5000 });
    expect(esperadoNaGaveta(turnoDeAgora)).toBe(5000);

    // Relançar de novo é recusado; a fila reenviando devolve a MESMA venda.
    const deNovo = await request(app)
      .post(`/api/v1/core/offline-sales/${pendencia.id}/relaunch`)
      .set(caixa)
      .send({ cashSessionId: turnoDeAgora });
    expect(deNovo.status).toBe(409);
    expect(deNovo.body.error.code).toBe('CORE_OFFLINE_SALE_NOT_PENDING');
    const reenvioAtrasado = await reenviar(caixa, chave, { ...corpo, cashSessionId: turnoDeAgora });
    expect(reenvioAtrasado.status).toBe(200);
    expect(reenvioAtrasado.body.id).toBe(relancada.body.sale.id);
    expect(vendasComAChave(chave)).toBe(1);

    // Trilha: quando foi feita, em que gaveta, e em qual entrou.
    const trilha = getConnection()
      .prepare(`SELECT detail FROM core_audit_log WHERE action = 'sale.offline.regularized' AND entity_id = ?`)
      .get(pendencia.id) as { detail: string };
    expect(JSON.parse(trilha.detail)).toMatchObject({
      originalCashSessionId: turnoDaVenda,
      newCashSessionId: turnoDeAgora,
      queuedAt: '2026-09-10T14:05:00.000Z',
      receivedCents: 5000,
    });
  });

  it('a venda com a chave que já subiu não vira pendência: a resposta aponta a venda', async () => {
    const produtoId = await produto(gerente, 5);
    const turno = await abrirCaixa(caixa);
    const chave = `pdv-${randomUUID()}`;
    const corpo = corpoDaVenda(produtoId, turno);
    const subiu = await reenviar(caixa, chave, corpo);
    expect(subiu.status).toBe(201);

    const entregue = await entregar(caixa, chave, corpo, { code: 'X', message: 'qualquer' });
    expect(entregue.status).toBe(200);
    expect(entregue.body).toMatchObject({ jaSubiu: true, saleId: subiu.body.id });
    expect(
      (getConnection().prepare('SELECT COUNT(*) AS n FROM core_offline_sale_pendings').get() as { n: number }).n,
    ).toBe(0);
  });
});

describe('o estoque acabou antes de a venda subir', () => {
  it('relançar é recusado com o motivo, a pendência guarda a recusa, e depois da entrada de estoque passa', async () => {
    const produtoId = await produto(gerente, 1);
    const turno = await abrirCaixa(caixa);
    const chave = `pdv-${randomUUID()}`;
    const corpo = corpoDaVenda(produtoId, turno);

    // Outro caixa vendeu a última peça enquanto esta venda esperava na fila.
    expect((await reenviar(gerente, `outra-${randomUUID()}`, corpoDaVenda(produtoId, turno))).status).toBe(201);
    const reenvio = await reenviar(caixa, chave, corpo);
    expect(reenvio.status).toBe(409);
    expect(reenvio.body.error.code).toBe('CORE_INSUFFICIENT_STOCK');

    const pendencia = (await entregar(caixa, chave, corpo, reenvio.body.error)).body.pendencia;
    const semSaldo = await request(app)
      .post(`/api/v1/core/offline-sales/${pendencia.id}/relaunch`)
      .set(caixa)
      .send({ cashSessionId: turno });
    expect(semSaldo.status).toBe(409);
    expect(semSaldo.body.error.code).toBe('CORE_INSUFFICIENT_STOCK');
    const lida = (await request(app).get('/api/v1/core/offline-sales').set(caixa)).body.items[0];
    expect(lida).toMatchObject({ status: 'pendente', errorCode: 'CORE_INSUFFICIENT_STOCK', attempts: 2 });
    expect(vendasComAChave(chave)).toBe(0);

    // A mercadoria já saiu com o cliente: o gestor lança a entrada que faltou.
    await entrada(gerente, produtoId, 1);
    const relancada = await request(app)
      .post(`/api/v1/core/offline-sales/${pendencia.id}/relaunch`)
      .set(caixa)
      .send({ cashSessionId: turno });
    expect(relancada.status, JSON.stringify(relancada.body)).toBe(201);
    expect(vendasComAChave(chave)).toBe(1);
  });
});

describe('descartar', () => {
  it('é da gerência, com motivo, e fica na trilha', async () => {
    const produtoId = await produto(gerente, 3);
    const turno = await abrirCaixa(caixa);
    const chave = `pdv-${randomUUID()}`;
    const corpo = corpoDaVenda(produtoId, turno);
    await fechar(caixa, turno);
    const pendencia = (
      await entregar(caixa, chave, corpo, { code: 'CORE_CASH_SESSION_CLOSED', message: 'fechado' })
    ).body.pendencia;

    const doCaixa = await request(app)
      .post(`/api/v1/core/offline-sales/${pendencia.id}/discard`)
      .set(caixa)
      .send({ reason: 'cliente desistiu e levou o dinheiro de volta' });
    expect(doCaixa.status).toBe(403);

    const semMotivo = await request(app)
      .post(`/api/v1/core/offline-sales/${pendencia.id}/discard`)
      .set(gerente)
      .send({ reason: 'x' });
    expect(semMotivo.status).toBe(400);
    expect(semMotivo.body.error.code).toBe('CORE_OFFLINE_SALE_REASON_REQUIRED');

    const descartada = await request(app)
      .post(`/api/v1/core/offline-sales/${pendencia.id}/discard`)
      .set(gerente)
      .send({ reason: 'relançada à mão como venda #12 antes desta tela' });
    expect(descartada.status).toBe(200);
    expect(descartada.body.status).toBe('descartada');
    expect(descartada.body.resolutionNote).toMatch(/venda #12/);
    expect((await request(app).get('/api/v1/core/offline-sales').set(gerente)).body.items).toHaveLength(0);
    const todas = await request(app).get('/api/v1/core/offline-sales?status=todas').set(gerente);
    expect(todas.body.items).toHaveLength(1);

    const trilha = getConnection()
      .prepare(`SELECT COUNT(*) AS n FROM core_audit_log WHERE action = 'sale.offline.discarded' AND entity_id = ?`)
      .get(pendencia.id) as { n: number };
    expect(trilha.n).toBe(1);
    expect(vendasComAChave(chave)).toBe(0);
  });
});

describe('a pendência é da operação — e só dela', () => {
  it('outro caixa da mesma empresa vê; outra empresa não vê nem relança', async () => {
    const produtoId = await produto(gerente, 3);
    const turno = await abrirCaixa(caixa);
    await fechar(caixa, turno);
    const pendencia = (
      await entregar(caixa, `pdv-${randomUUID()}`, corpoDaVenda(produtoId, turno), {
        code: 'CORE_CASH_SESSION_CLOSED',
        message: 'fechado',
      })
    ).body.pendencia;

    const outroCaixa = await entrar(LOJA, 'caixa-dois-guardada', 'operador_caixa_loja');
    const visto = await request(app).get('/api/v1/core/offline-sales').set(outroCaixa);
    expect(visto.body.items.map((i: { id: string }) => i.id)).toEqual([pendencia.id]);

    const vizinha = await entrar(OUTRA, 'gerente-vizinha-guardada', 'gerente_loja');
    expect((await request(app).get('/api/v1/core/offline-sales').set(vizinha)).body.items).toHaveLength(0);
    const alheia = await request(app)
      .post(`/api/v1/core/offline-sales/${pendencia.id}/relaunch`)
      .set(vizinha)
      .send({});
    expect(alheia.status).toBe(404);
    const descarteAlheio = await request(app)
      .post(`/api/v1/core/offline-sales/${pendencia.id}/discard`)
      .set(vizinha)
      .send({ reason: 'tentando apagar a venda da outra loja' });
    expect(descarteAlheio.status).toBe(404);
  });

  it('o mecânico não entrega nem lê', async () => {
    const mecanico = await entrar(LOJA, 'mecanico-guardada', 'mecanico');
    expect((await request(app).get('/api/v1/core/offline-sales').set(mecanico)).status).toBe(403);
    expect(
      (await request(app).post('/api/v1/core/offline-sales').set(mecanico).send({ idempotencyKey: 'k', body: { items: [] } }))
        .status,
    ).toBe(403);
  });

  it('corpo que não é venda e chave vazia são recusados', async () => {
    const semChave = await request(app).post('/api/v1/core/offline-sales').set(caixa).send({ body: { items: [] } });
    expect(semChave.status).toBe(400);
    const semVenda = await request(app)
      .post('/api/v1/core/offline-sales')
      .set(caixa)
      .send({ idempotencyKey: 'k-1', body: { nada: true } });
    expect(semVenda.status).toBe(400);
    expect(semVenda.body.error.code).toBe('CORE_OFFLINE_SALE_BODY_INVALID');
  });
});

describe('o turno não fecha calado com o dinheiro da venda recusada na gaveta', () => {
  it('fechar a gaveta aberta com venda recusada dela pede ciência e motivo, e a lista a nomeia', async () => {
    const produtoId = await produto(gerente, 1);
    const turno = await abrirCaixa(caixa);
    // Recusada por estoque com a gaveta AINDA aberta.
    expect((await reenviar(gerente, `outra-${randomUUID()}`, corpoDaVenda(produtoId, turno))).status).toBe(201);
    const chave = `pdv-${randomUUID()}`;
    const reenvio = await reenviar(caixa, chave, corpoDaVenda(produtoId, turno));
    await entregar(caixa, chave, corpoDaVenda(produtoId, turno), reenvio.body.error);

    // O resumo que a tela mostra ANTES de fechar já nomeia a venda recusada.
    const resumo = await request(app).get(`/api/v1/core/cash/${turno}/summary`).set(caixa);
    expect(resumo.status).toBe(200);
    expect(resumo.body.pendenciasEletronicas.vendasOffline).toHaveLength(1);
    expect(resumo.body.pendenciasEletronicas.vendasOffline[0]).toMatchObject({ receivedCents: 5000 });

    const calado = await fechar(caixa, turno);
    expect(calado.status).toBe(409);
    expect(calado.body.error.code).toBe('CORE_CASH_CLOSE_ELECTRONIC_PENDING');
    expect(calado.body.error.message).toMatch(/venda guardada sem servidor e recusada, de R\$ 50,00/);
    expect(calado.body.error.details.pendencias.vendasOffline).toHaveLength(1);
    expect(calado.body.error.details.pendencias.totalCents).toBe(5000);

    const ciente = await fechar(caixa, turno, {
      pendenciasCiente: true,
      pendenciasMotivo: 'o gerente relança amanhã depois da entrada de estoque',
    });
    expect(ciente.status, JSON.stringify(ciente.body)).toBe(200);
  });
});
