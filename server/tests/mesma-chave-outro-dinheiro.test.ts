/**
 * ============================================================================
 * A MESMA CHAVE COM OUTRO DINHEIRO NÃO É A MESMA VENDA (RES-IDEM-VIZ)
 * ============================================================================
 *
 * O item IDEM (d622b6d) fez a venda recusar a mesma Idempotency-Key com outra
 * MERCADORIA. O verificador perguntou pelo resto do pedido: a mesma chave, a
 * mesma mercadoria e OUTRO pagamento ou desconto devolviam a venda original
 * com 200. O caixa que refez em cartão o que tinha lançado em dinheiro via
 * "venda finalizada", e a gaveta esperava um dinheiro que nunca entrou nela.
 *
 * A busca por um fluxo LEGÍTIMO que reenvie a mesma chave com outro dinheiro
 * não achou nenhum (o relançamento offline usa o corpo guardado; o PIX do
 * balcão e a maquininha reenviam a MESMA linha; a pré-venda convertida é
 * recusada inteira; OS e consignação descem com o documento no nome da
 * chave). Então a receita v1 da impressão passa a incluir desconto, acréscimo
 * e crédito do cabeçalho e os pagamentos (forma e valor, sem ordem).
 *
 * E a fila do PDV: a mesma chave entregue duas vezes com corpos diferentes não
 * é a mesma pendência — a segunda venda some se o servidor responder "está
 * guardada".
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
const LOJA = 'loja-outro-dinheiro';

type Auth = { Authorization: string };
let gerente: Auth;

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  const res = await loginForTest(app, { userId: 'gerente-outro-dinheiro', companyId: LOJA, profileCodes: ['gerente_loja'] });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  gerente = { Authorization: `Bearer ${res.body.accessToken as string}` };
});

function contar(sql: string, ...args: (string | number)[]): number {
  return (getConnection().prepare(sql).get(...args) as { n: number }).n;
}

async function produto(estoque: number, precoCents = 5000): Promise<string> {
  const p = await request(app)
    .post('/api/v1/core/products')
    .set(gerente)
    .send({ name: `Produto ${randomUUID().slice(0, 6)}`, priceCents: precoCents });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  const r = await request(app).post('/api/v1/core/stock/movements').set(gerente).send({
    productId: p.body.id,
    movementType: 'in',
    quantity: estoque,
    referenceType: 'entrada',
    referenceId: `carga-${randomUUID()}`,
  });
  expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
  return p.body.id as string;
}

async function abrirCaixa(): Promise<string> {
  const res = await request(app).post('/api/v1/core/cash/open').set(gerente).send({ openingCents: 0 });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

function vender(chave: string, corpo: Record<string, unknown>) {
  return request(app).post('/api/v1/core/sales').set(gerente).set('Idempotency-Key', chave).send(corpo);
}

/** Tudo o que uma venda escreve — para provar que a recusa não escreveu nada. */
function retratoDaVenda() {
  return {
    vendas: contar('SELECT COUNT(*) AS n FROM core_sales WHERE company_id = ?', LOJA),
    pagamentos: contar(
      'SELECT COUNT(*) AS n FROM core_sale_payments WHERE sale_id IN (SELECT id FROM core_sales WHERE company_id = ?)',
      LOJA,
    ),
    lancamentos: contar('SELECT COUNT(*) AS n FROM core_finance_entries WHERE company_id = ?', LOJA),
    movimentosDeEstoque: contar('SELECT COUNT(*) AS n FROM core_stock_movements WHERE company_id = ?', LOJA),
    movimentosDeCaixa: contar(
      `SELECT COUNT(*) AS n FROM core_cash_movements
        WHERE session_id IN (SELECT id FROM core_cash_sessions WHERE company_id = ?)`,
      LOJA,
    ),
  };
}

function esperarChaveReusada(res: request.Response) {
  expect(res.status, JSON.stringify(res.body)).toBe(422);
  expect(res.body.error.code).toBe('CORE_IDEMPOTENCY_KEY_REUSED');
  expect(res.body.error.message).toMatch(/chave nova/i);
}

// ============================================================================

describe('a venda: o dinheiro do pedido entra na impressão digital', () => {
  it('a mesma chave com OUTRO valor pago é recusada (422), e nada muda', async () => {
    const p = await produto(10);
    const gaveta = await abrirCaixa();
    const chave = `pdv-${randomUUID()}`;
    const primeira = await vender(chave, {
      cashSessionId: gaveta,
      items: [{ productId: p, quantity: 2 }],
      payments: [{ method: 'dinheiro', amountCents: 10_000 }],
    });
    expect(primeira.status, JSON.stringify(primeira.body)).toBe(201);
    const antes = retratoDaVenda();

    const outra = await vender(chave, {
      cashSessionId: gaveta,
      items: [{ productId: p, quantity: 2 }],
      payments: [{ method: 'dinheiro', amountCents: 20_000 }],
    });
    esperarChaveReusada(outra);
    expect(outra.body.error.message).toContain(`#${primeira.body.number as number}`);
    expect(retratoDaVenda()).toEqual(antes);
  });

  it('a mesma chave com OUTRA forma de pagamento é recusada', async () => {
    const p = await produto(10);
    const gaveta = await abrirCaixa();
    const chave = `pdv-${randomUUID()}`;
    expect(
      (await vender(chave, {
        cashSessionId: gaveta,
        items: [{ productId: p, quantity: 2 }],
        payments: [{ method: 'dinheiro', amountCents: 10_000 }],
      })).status,
    ).toBe(201);
    const antes = retratoDaVenda();

    const outra = await vender(chave, {
      cashSessionId: gaveta,
      items: [{ productId: p, quantity: 2 }],
      payments: [{ method: 'debito', amountCents: 10_000 }],
    });
    esperarChaveReusada(outra);
    expect(retratoDaVenda()).toEqual(antes);
  });

  it('a mesma chave com OUTRO desconto do cabeçalho é recusada', async () => {
    const p = await produto(10);
    const gaveta = await abrirCaixa();
    const chave = `pdv-${randomUUID()}`;
    expect(
      (await vender(chave, {
        cashSessionId: gaveta,
        items: [{ productId: p, quantity: 2 }],
        payments: [{ method: 'dinheiro', amountCents: 10_000 }],
      })).status,
    ).toBe(201);
    const antes = retratoDaVenda();

    const outra = await vender(chave, {
      cashSessionId: gaveta,
      items: [{ productId: p, quantity: 2 }],
      discountCents: 100,
      payments: [{ method: 'dinheiro', amountCents: 10_000 }],
    });
    esperarChaveReusada(outra);
    expect(retratoDaVenda()).toEqual(antes);
  });

  it('o mesmo pedido, com os pagamentos em outra ordem, é o mesmo pedido: 200', async () => {
    const p = await produto(10);
    const gaveta = await abrirCaixa();
    const chave = `pdv-${randomUUID()}`;
    const primeira = await vender(chave, {
      cashSessionId: gaveta,
      items: [{ productId: p, quantity: 2 }],
      payments: [
        { method: 'dinheiro', amountCents: 4_000 },
        { method: 'debito', amountCents: 6_000 },
      ],
    });
    expect(primeira.status, JSON.stringify(primeira.body)).toBe(201);

    const reenvio = await vender(chave, {
      cashSessionId: gaveta,
      items: [{ productId: p, quantity: 2 }],
      payments: [
        { method: 'debito', amountCents: 6_000 },
        { method: 'dinheiro', amountCents: 4_000 },
      ],
    });
    expect(reenvio.status, JSON.stringify(reenvio.body)).toBe(200);
    expect(reenvio.body.id).toBe(primeira.body.id);
  });

  it('venda anterior à impressão digital: outro pagamento com a mesma chave devolve a original, como sempre', async () => {
    const p = await produto(10);
    const gaveta = await abrirCaixa();
    const chave = `pdv-${randomUUID()}`;
    const primeira = await vender(chave, {
      cashSessionId: gaveta,
      items: [{ productId: p, quantity: 2 }],
      payments: [{ method: 'dinheiro', amountCents: 10_000 }],
    });
    expect(primeira.status).toBe(201);
    getConnection()
      .prepare('UPDATE core_sales SET idempotency_fingerprint = NULL WHERE id = ?')
      .run(primeira.body.id as string);

    const reenvio = await vender(chave, {
      cashSessionId: gaveta,
      items: [{ productId: p, quantity: 2 }],
      payments: [{ method: 'dinheiro', amountCents: 20_000 }],
    });
    expect(reenvio.status, JSON.stringify(reenvio.body)).toBe(200);
    expect(reenvio.body.id).toBe(primeira.body.id);
  });
});

// ============================================================================

describe('a venda guardada offline entregue duas vezes com a mesma chave', () => {
  function entregar(chave: string, corpo: Record<string, unknown>) {
    return request(app).post('/api/v1/core/offline-sales').set(gerente).send({
      idempotencyKey: chave,
      label: 'venda do PDV',
      body: corpo,
      queuedAt: '2026-09-12T10:00:00.000Z',
      errorCode: 'CORE_CASH_SESSION_CLOSED',
      errorMessage: 'O caixa informado já foi fechado.',
    });
  }

  it('outro corpo com a chave de uma pendência é recusado (422) — a pendência guarda o primeiro', async () => {
    const p = await produto(10);
    const chave = `pdv-${randomUUID()}`;
    const primeiro = { items: [{ productId: p, quantity: 2 }], payments: [{ method: 'dinheiro', amountCents: 10_000 }] };
    const a = await entregar(chave, primeiro);
    expect(a.status, JSON.stringify(a.body)).toBe(201);

    const outro = { items: [{ productId: p, quantity: 3 }], payments: [{ method: 'dinheiro', amountCents: 15_000 }] };
    const b = await entregar(chave, outro);
    esperarChaveReusada(b);

    const guardada = getConnection()
      .prepare('SELECT request_body, attempts FROM core_offline_sale_pendings WHERE company_id = ? AND idempotency_key = ?')
      .get(LOJA, chave) as { request_body: string; attempts: number };
    expect(JSON.parse(guardada.request_body)).toEqual(primeiro);
    expect(guardada.attempts).toBe(1);
  });

  it('o mesmo corpo entregue de novo continua sendo a mesma pendência', async () => {
    const p = await produto(10);
    const chave = `pdv-${randomUUID()}`;
    const corpo = { items: [{ productId: p, quantity: 2 }], payments: [{ method: 'dinheiro', amountCents: 10_000 }] };
    const a = await entregar(chave, corpo);
    const b = await entregar(chave, corpo);
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    expect(b.body.pendencia.id).toBe(a.body.pendencia.id);
  });

  it('a venda que já subiu com OUTRO pagamento não é "já subiu": vira pendência', async () => {
    const p = await produto(10);
    const gaveta = await abrirCaixa();
    const chave = `pdv-${randomUUID()}`;
    const subiu = await vender(chave, {
      cashSessionId: gaveta,
      items: [{ productId: p, quantity: 2 }],
      payments: [{ method: 'dinheiro', amountCents: 10_000 }],
    });
    expect(subiu.status).toBe(201);

    const entregue = await entregar(chave, {
      items: [{ productId: p, quantity: 2 }],
      payments: [{ method: 'debito', amountCents: 10_000 }],
    });
    expect(entregue.status, JSON.stringify(entregue.body)).toBe(201);
    expect(entregue.body.jaSubiu).toBe(false);
    expect(entregue.body.pendencia.status).toBe('pendente');
  });
});
