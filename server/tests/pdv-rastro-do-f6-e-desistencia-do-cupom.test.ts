/**
 * ============================================================================
 * DUAS ROTAS DO BALCÃO QUE FALTAVAM (trilha PDV, auditoria PJ)
 * ============================================================================
 *
 * D-pdv-teclado-12 — O F6 APAGAVA O CARRINHO SEM RASTRO. A confirmação existia,
 * mas o carrinho é local e o servidor só ficava sabendo da venda no Finalizar:
 * trinta itens bipados, mostrados ao cliente e apagados, e o gerente não tinha
 * como saber. `POST /core/sales/abandoned` grava na trilha de auditoria o que
 * saiu da tela, carimbando quem pelo token.
 *
 * F-cupom-fiscal-09 — DESISTIR DO CUPOM NÃO ERA ATÔMICO. A tela relia o job e,
 * ainda `ready`, mandava `cancelled` por `/status`; entre as duas idas o agente
 * pegava o cupom, e `printing → cancelled` é aceito: a tela dizia "cancelado" e o
 * papel saía. `POST /core/print/jobs/:id/desistir` cancela SÓ se o job ainda
 * está `ready`, na mesma instrução — senão 409 `CORE_PRINT_JOB_TAKEN`.
 *
 * Como fica vermelho: tire `AND status = 'ready'` do UPDATE e o caso do job já
 * pego volta 200 com o job cancelado debaixo do agente; tire o `recordAudit` da
 * rota do F6 e o carrinho cancelado volta a sumir sem registro.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { resetEnvCacheForTests } from '../src/config/env.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { loginForTest } from './helpers/auth.js';

process.env.DEVORA_JWT_SECRET = 'rastro-do-f6-teste-jwt-secret-bem-comprido-mesmo';
process.env.DEVORA_ENCRYPTION_KEY = 'rastro-do-f6-teste-chave-de-cifra-bem-comprida-mesmo';

const app = createApp();
const LOJA = 'loja-f6';
const OUTRA = 'outra-f6';

type Auth = { Authorization: string };
let caixa: Auth;
let caixaDaOutra: Auth;

async function entrar(userId: string, companyId: string, perfil: string): Promise<Auth> {
  const r = await loginForTest(app, { userId, companyId, profileCodes: [perfil] });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return { Authorization: `Bearer ${r.body.accessToken as string}` };
}

/** Um cupom na fila, como `createPrintJob` o deixa. */
function job(companyId: string, status: string, transport: 'agent' | 'browser' = 'agent'): string {
  const id = randomUUID();
  getConnection()
    .prepare(
      `INSERT INTO core_print_jobs
         (id, company_id, document_type, document_id, status, copies, attempts, created_at, transport)
       VALUES (?, ?, 'SALE_RECEIPT', 'venda-1', ?, 1, 0, ?, ?)`,
    )
    .run(id, companyId, status, new Date().toISOString(), transport);
  return id;
}

function estadoDoJob(id: string): string {
  return (getConnection().prepare('SELECT status FROM core_print_jobs WHERE id = ?').get(id) as { status: string })
    .status;
}

function trilha(action: string): { user_id: string | null; entity_type: string; entity_id: string; detail: string }[] {
  return getConnection()
    .prepare('SELECT user_id, entity_type, entity_id, detail FROM core_audit_log WHERE action = ? ORDER BY created_at')
    .all(action) as never;
}

beforeEach(async () => {
  process.env.DEVORA_API_ENV = 'test';
  resetEnvCacheForTests();
  resetDbForTests();
  caixa = await entrar('caixa-f6', LOJA, 'operador_caixa_loja');
  caixaDaOutra = await entrar('caixa-outra', OUTRA, 'operador_caixa_loja');
});

// ============================================================================

describe('F-cupom-fiscal-09 — desistir do cupom é um passo só', () => {
  it('o cupom ainda na fila do agente é CANCELADO, com o motivo, e fica na trilha', async () => {
    const id = job(LOJA, 'ready');
    const r = await request(app)
      .post(`/api/v1/core/print/jobs/${id}/desistir`)
      .set(caixa)
      .send({ motivo: 'O agente não pegou a tempo.' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.status).toBe('cancelled');
    expect(r.body.error).toBe('O agente não pegou a tempo.');
    expect(estadoDoJob(id)).toBe('cancelled');
    expect(trilha('print.job.desistir').map((t) => t.entity_id)).toEqual([id]);
  });

  it('o agente JÁ PEGOU (printing): 409 CORE_PRINT_JOB_TAKEN, e o job segue imprimindo', async () => {
    const id = job(LOJA, 'printing');
    const r = await request(app).post(`/api/v1/core/print/jobs/${id}/desistir`).set(caixa).send({});
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('CORE_PRINT_JOB_TAKEN');
    expect(r.body.error.message).toMatch(/aguarde o papel/);
    expect(estadoDoJob(id)).toBe('printing');
    expect(trilha('print.job.desistir')).toHaveLength(0);
  });

  it('o cupom já saiu (printed): 409, e nada muda', async () => {
    const id = job(LOJA, 'printed');
    const r = await request(app).post(`/api/v1/core/print/jobs/${id}/desistir`).set(caixa).send({});
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('CORE_PRINT_JOB_TAKEN');
    expect(estadoDoJob(id)).toBe('printed');
  });

  it('cupom do NAVEGADOR não é desistido por esta rota', async () => {
    const id = job(LOJA, 'ready', 'browser');
    const r = await request(app).post(`/api/v1/core/print/jobs/${id}/desistir`).set(caixa).send({});
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/navegador/);
    expect(estadoDoJob(id)).toBe('ready');
  });

  it('o cupom de OUTRA empresa não é tocado', async () => {
    const id = job(LOJA, 'ready');
    const r = await request(app).post(`/api/v1/core/print/jobs/${id}/desistir`).set(caixaDaOutra).send({});
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).not.toBe(200);
    expect(estadoDoJob(id)).toBe('ready');
  });
});

// ============================================================================

describe('D-pdv-teclado-12 — o carrinho que o F6 apagou deixa rastro', () => {
  it('grava na trilha QUEM cancelou, os itens, o total e o caixa', async () => {
    const r = await request(app)
      .post('/api/v1/core/sales/abandoned')
      .set(caixa)
      .send({
        saleKey: 'pdv-chave-do-carrinho',
        terminalId: 'cx-1',
        customerId: null,
        items: [
          { productId: 'p-arroz', name: 'ARROZ 5kg', quantity: 2, unitPriceCents: 2190 },
          { productId: 'p-feijao', name: 'FEIJÃO 1kg', quantity: 1, unitPriceCents: 890 },
        ],
      });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toEqual({ ok: true, totalCents: 5270 });

    const [registro] = trilha('pdv.cart.abandoned');
    expect(registro.entity_type).toBe('sale_key');
    expect(registro.entity_id).toBe('pdv-chave-do-carrinho');
    const quem = getConnection()
      .prepare('SELECT id FROM core_users WHERE login = ?')
      .get(`caixa-f6@${LOJA}`) as { id: string };
    // O operador vem do TOKEN, e não do corpo.
    expect(registro.user_id).toBe(quem.id);
    const detalhe = JSON.parse(registro.detail) as {
      itens: { productId: string; quantity: number }[];
      totalCents: number;
      terminalId: string | null;
    };
    expect(detalhe.totalCents).toBe(5270);
    expect(detalhe.terminalId).toBe('cx-1');
    expect(detalhe.itens.map((i) => i.productId)).toEqual(['p-arroz', 'p-feijao']);
  });

  it('sem itens: 400, e nada é gravado', async () => {
    const r = await request(app)
      .post('/api/v1/core/sales/abandoned')
      .set(caixa)
      .send({ saleKey: 'pdv-vazio', items: [] });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('CORE_ABANDONED_CART_EMPTY');
    expect(trilha('pdv.cart.abandoned')).toHaveLength(0);
  });

  it('sem a chave da venda: 400', async () => {
    const r = await request(app)
      .post('/api/v1/core/sales/abandoned')
      .set(caixa)
      .send({ items: [{ productId: 'p-1', name: 'X', quantity: 1, unitPriceCents: 100 }] });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('CORE_ABANDONED_CART_KEY_REQUIRED');
  });

  it('linha com quantidade zero: 400, dizendo qual linha', async () => {
    const r = await request(app)
      .post('/api/v1/core/sales/abandoned')
      .set(caixa)
      .send({ saleKey: 'pdv-q0', items: [{ productId: 'p-1', name: 'X', quantity: 0, unitPriceCents: 100 }] });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('CORE_ABANDONED_CART_INVALID_ITEM');
    expect(r.body.error.message).toMatch(/linha 1/);
  });

  it('sem sessão: 401', async () => {
    const r = await request(app)
      .post('/api/v1/core/sales/abandoned')
      .send({ saleKey: 'pdv-x', items: [{ productId: 'p-1', name: 'X', quantity: 1, unitPriceCents: 100 }] });
    expect(r.status).toBe(401);
  });
});
