/**
 * ============================================================================
 * A MESMA CHAVE COM OUTRO CORPO NÃO É REENVIO — nos vizinhos da venda
 * (RES-IDEM-VIZ)
 * ============================================================================
 *
 * O item IDEM (d622b6d) ensinou a venda a recusar a mesma Idempotency-Key com
 * outra mercadoria (422 CORE_IDEMPOTENCY_KEY_REUSED). O verificador achou os
 * vizinhos com o mesmo defeito: a chave volta com OUTRO corpo e o servidor
 * devolve o resultado antigo, calado — o balcão acha que registrou o pedido
 * novo, e ele não existe.
 *
 * Cada vizinho aqui cobra as três coisas:
 *
 *   - mesma chave, outro corpo -> 422 CORE_IDEMPOTENCY_KEY_REUSED, e NADA é
 *     escrito;
 *   - mesma chave, mesmo corpo -> o resultado original, como sempre;
 *   - linha anterior à impressão digital (coluna nula) -> a regra de hoje.
 *
 * A venda e a fila offline estão em `mesma-chave-outro-dinheiro.test.ts`; a
 * maquininha, o PIX do balcão, a etiqueta, a baixa e o recebimento da OS, nos
 * arquivos do domínio de cada um.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { findRows, insertRow, resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { getConnection } from '../src/db/sqlite.js';
import { createCustomer } from '../src/services/core/CatalogService.js';
import {
  criarConsignacao,
  faturarConsignacao,
  registrarRetorno,
} from '../src/services/core/ConsignmentService.js';
import { checkout } from '../src/services/core/StorefrontService.js';
import { ApiError } from '../src/utils/errors.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();
const LOJA = 'loja-outro-corpo';
const OFICINA = 'oficina-outro-corpo';

type Auth = { Authorization: string };
let gerente: Auth;
let userId: string;

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  const res = await loginForTest(app, { userId: 'gerente-outro-corpo', companyId: LOJA, profileCodes: ['gerente_loja'] });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  gerente = { Authorization: `Bearer ${res.body.accessToken as string}` };
  userId = String(res.body.user.id);
});

// ----------------------------------------------------------------- helpers

function contar(sql: string, ...args: (string | number)[]): number {
  return (getConnection().prepare(sql).get(...args) as { n: number }).n;
}

function saldo(productId: string, empresa = LOJA): { quantity: number; reserved: number } {
  const row = getConnection()
    .prepare('SELECT quantity, reserved FROM core_stock WHERE company_id = ? AND product_id = ?')
    .get(empresa, productId) as { quantity: number; reserved: number } | undefined;
  return { quantity: row?.quantity ?? 0, reserved: row?.reserved ?? 0 };
}

async function produto(estoque: number, precoCents = 5000): Promise<string> {
  const p = await request(app)
    .post('/api/v1/core/products')
    .set(gerente)
    .send({ name: `Produto ${randomUUID().slice(0, 6)}`, priceCents: precoCents });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  if (estoque > 0) {
    const r = await request(app).post('/api/v1/core/stock/movements').set(gerente).send({
      productId: p.body.id,
      movementType: 'in',
      quantity: estoque,
      referenceType: 'entrada',
      referenceId: `carga-${randomUUID()}`,
    });
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
  }
  return p.body.id as string;
}

function tentar(fn: () => unknown): ApiError | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err as ApiError;
  }
}

function esperarChaveReusada(res: request.Response) {
  expect(res.status, JSON.stringify(res.body)).toBe(422);
  expect(res.body.error.code).toBe('CORE_IDEMPOTENCY_KEY_REUSED');
  expect(res.body.error.message).toMatch(/chave nova/i);
}

function esperarErroDeChaveReusada(erro: ApiError | null) {
  expect(erro).toBeInstanceOf(ApiError);
  expect(erro?.code).toBe('CORE_IDEMPOTENCY_KEY_REUSED');
  expect(erro?.status).toBe(422);
}

// ============================================================================

describe('o movimento manual de estoque (a referência é a chave)', () => {
  function movimentar(referenceId: string, productId: string, quantity: number) {
    return request(app).post('/api/v1/core/stock/movements').set(gerente).send({
      productId,
      movementType: 'in',
      quantity,
      referenceType: 'entrada',
      referenceId,
      unitCostCents: 1_000,
    });
  }

  it('a mesma referência com OUTRA quantidade é recusada (422), e o saldo não se mexe', async () => {
    const p = await produto(0);
    const ref = `carga-${randomUUID()}`;
    expect((await movimentar(ref, p, 5)).status).toBe(201);
    const movimentos = contar('SELECT COUNT(*) AS n FROM core_stock_movements WHERE company_id = ?', LOJA);

    const outra = await movimentar(ref, p, 8);
    esperarChaveReusada(outra);
    expect(saldo(p).quantity).toBe(5);
    expect(contar('SELECT COUNT(*) AS n FROM core_stock_movements WHERE company_id = ?', LOJA)).toBe(movimentos);
  });

  it('a mesma referência com o mesmo corpo é o reenvio: 200 duplicado', async () => {
    const p = await produto(0);
    const ref = `carga-${randomUUID()}`;
    expect((await movimentar(ref, p, 5)).status).toBe(201);
    const reenvio = await movimentar(ref, p, 5);
    expect(reenvio.status, JSON.stringify(reenvio.body)).toBe(200);
    expect(reenvio.body.duplicated).toBe(true);
    expect(saldo(p).quantity).toBe(5);
  });

  it('movimento anterior à impressão digital: a regra de hoje (200 duplicado, sem mexer no saldo)', async () => {
    const p = await produto(0);
    const ref = `carga-${randomUUID()}`;
    expect((await movimentar(ref, p, 5)).status).toBe(201);
    getConnection()
      .prepare('UPDATE core_stock_movements SET idempotency_fingerprint = NULL WHERE company_id = ? AND reference_id = ?')
      .run(LOJA, ref);
    const reenvio = await movimentar(ref, p, 8);
    expect(reenvio.status, JSON.stringify(reenvio.body)).toBe(200);
    expect(reenvio.body.duplicated).toBe(true);
    expect(saldo(p).quantity).toBe(5);
  });
});

// ============================================================================

describe('withIdempotency (api_idempotency_keys) — o CSC da NFC-e', () => {
  function gravarCsc(chave: string, corpo: Record<string, unknown>) {
    return request(app).post('/api/v1/core/fiscal/nfce/csc').set(gerente).set('Idempotency-Key', chave).send(corpo);
  }
  const CORPO = { cscId: '000001', cscToken: 'TOKEN-CSC-HOMOLOGACAO-000000000001', environment: 'homologation' };

  function cscsGravados(): number {
    return findRows('nfce_settings', (r) => r.companyId === LOJA).length;
  }

  it('a mesma chave com OUTRO corpo é recusada (422) antes de o handler rodar', async () => {
    const a = await gravarCsc('csc-1', CORPO);
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    const antes = cscsGravados();

    const b = await gravarCsc('csc-1', { ...CORPO, cscId: '000009' });
    esperarChaveReusada(b);
    expect(cscsGravados()).toBe(antes);
    const lista = await request(app).get('/api/v1/core/fiscal/nfce/csc').set(gerente);
    expect((lista.body.items as { cscId: string }[]).map((c) => c.cscId)).toEqual(['000001']);
  });

  it('a mesma chave com o mesmo corpo devolve a resposta guardada', async () => {
    const a = await gravarCsc('csc-2', CORPO);
    const b = await gravarCsc('csc-2', { ...CORPO });
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    expect(b.body).toEqual(a.body);
  });

  it('memória anterior à impressão digital: devolve a resposta guardada, como sempre', async () => {
    insertRow('api_idempotency_keys', {
      id: `${LOJA}:csc-antiga`,
      companyId: LOJA,
      idempotencyKey: 'csc-antiga',
      response: { antiga: true },
      createdAt: '2026-09-01T00:00:00.000Z',
    });
    const res = await gravarCsc('csc-antiga', { ...CORPO, cscId: '000077' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toEqual({ antiga: true });
  });
});

// ============================================================================

describe('o lead do balcão', () => {
  function criarLead(chave: string, corpo: Record<string, unknown>) {
    return request(app).post('/api/v1/core/leads').set(gerente).set('Idempotency-Key', chave).send(corpo);
  }

  it('a mesma chave com OUTRA pessoa é recusada (422), e nenhum lead nasce', async () => {
    const a = await criarLead('lead-1', { name: 'Maria Interessada', phone: '51999990000' });
    expect(a.status).toBe(201);
    const b = await criarLead('lead-1', { name: 'João Outro', phone: '51988880000' });
    esperarChaveReusada(b);
    expect(contar('SELECT COUNT(*) AS n FROM core_leads WHERE company_id = ?', LOJA)).toBe(1);
  });

  it('o mesmo corpo devolve o mesmo lead; o lead anterior à impressão segue a regra de hoje', async () => {
    const a = await criarLead('lead-2', { name: 'Maria Interessada' });
    const b = await criarLead('lead-2', { name: 'Maria Interessada' });
    expect(b.body.id).toBe(a.body.id);

    getConnection().prepare('UPDATE core_leads SET idempotency_fingerprint = NULL WHERE id = ?').run(a.body.id as string);
    const c = await criarLead('lead-2', { name: 'Outra Pessoa' });
    expect(c.status).toBe(201);
    expect(c.body.id).toBe(a.body.id);
  });
});

// ============================================================================

describe('a entrada manual de compra', () => {
  async function fornecedor(): Promise<string> {
    const res = await request(app).post('/api/v1/core/suppliers').set(gerente).send({ name: 'Seu Zé', paymentTermDays: 0 });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.id as string;
  }
  function criarEntrada(body: Record<string, unknown>) {
    return request(app).post('/api/v1/core/purchases/manual').set(gerente).send(body);
  }

  it('a mesma chave com OUTRA quantidade é recusada (422), e nenhuma nota nasce', async () => {
    const ze = await fornecedor();
    const p = await produto(0);
    const a = await criarEntrada({ supplierId: ze, idempotencyKey: 'form-1', items: [{ productId: p, quantity: 10, unitCostCents: 100 }] });
    expect(a.status, JSON.stringify(a.body)).toBe(201);

    const b = await criarEntrada({ supplierId: ze, idempotencyKey: 'form-1', items: [{ productId: p, quantity: 20, unitCostCents: 100 }] });
    esperarChaveReusada(b);
    expect(contar('SELECT COUNT(*) AS n FROM core_inbound_notes WHERE company_id = ?', LOJA)).toBe(1);
  });

  it('o mesmo corpo devolve a mesma nota; a nota anterior à impressão segue a regra de hoje', async () => {
    const ze = await fornecedor();
    const p = await produto(0);
    const corpo = { supplierId: ze, idempotencyKey: 'form-2', items: [{ productId: p, quantity: 10, unitCostCents: 100 }] };
    const a = await criarEntrada(corpo);
    const b = await criarEntrada(corpo);
    expect(b.status).toBe(200);
    expect(b.body).toMatchObject({ duplicated: true, noteId: a.body.noteId });

    getConnection().prepare('UPDATE core_inbound_notes SET idempotency_fingerprint = NULL WHERE id = ?').run(a.body.noteId as string);
    const c = await criarEntrada({ ...corpo, items: [{ productId: p, quantity: 99, unitCostCents: 100 }] });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(c.body.noteId).toBe(a.body.noteId);
  });
});

// ============================================================================

describe('o checkout da loja online', () => {
  function publicado(estoque: number): string {
    const id = `vitrine-${randomUUID().slice(0, 8)}`;
    const agora = new Date().toISOString();
    const db = getConnection();
    db.prepare(
      `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents, price_cents,
         active, publish_online, created_at, updated_at)
       VALUES (?, ?, ?, 'Mochila', 'UN', 4000, 15000, 1, 1, ?, ?)`,
    ).run(id, LOJA, id, agora, agora);
    db.prepare('INSERT INTO core_stock (company_id, product_id, quantity, reserved, updated_at) VALUES (?, ?, ?, 0, ?)').run(
      LOJA,
      id,
      estoque,
      agora,
    );
    return id;
  }

  function fechar(chave: string, extra: Partial<Parameters<typeof checkout>[0]> & { quantidade?: number; productId: string }) {
    const { quantidade = 1, productId, ...resto } = extra;
    return checkout({
      idempotencyKey: chave,
      customerName: 'Ana Compradora',
      customerDocument: '52998224725',
      customerEmail: 'ana@exemplo.com',
      paymentMethod: 'pix',
      items: [{ productId, quantity: quantidade }],
      ...resto,
    });
  }

  it('a mesma chave com OUTRO carrinho é recusada (422), e a reserva não se mexe', () => {
    const p = publicado(10);
    const [pedido] = fechar('carrinho-1', { productId: p, quantidade: 1 });
    expect(saldo(p).reserved).toBe(1);

    esperarErroDeChaveReusada(tentar(() => fechar('carrinho-1', { productId: p, quantidade: 3 })));
    esperarErroDeChaveReusada(tentar(() => fechar('carrinho-1', { productId: p, quantidade: 1, paymentMethod: 'boleto' })));
    expect(saldo(p).reserved).toBe(1);
    expect(contar('SELECT COUNT(*) AS n FROM core_orders WHERE company_id = ?', LOJA)).toBe(1);
    expect(pedido.id).toBeTruthy();
  });

  it('o mesmo carrinho devolve o mesmo pedido; o pedido anterior à impressão segue a regra de hoje', () => {
    const p = publicado(10);
    const [a] = fechar('carrinho-2', { productId: p });
    const [b] = fechar('carrinho-2', { productId: p });
    expect(b.id).toBe(a.id);

    // O pedido anterior às impressões não tem nenhuma das duas (a da loja e a
    // do carrinho inteiro, R2-IDEM).
    getConnection()
      .prepare('UPDATE core_orders SET idempotency_fingerprint = NULL, checkout_fingerprint = NULL WHERE id = ?')
      .run(a.id);
    const [c] = fechar('carrinho-2', { productId: p, quantidade: 4 });
    expect(c.id).toBe(a.id);
    expect(saldo(p).reserved).toBe(1);
  });
});

// ============================================================================

describe('a consignação: remessa, retorno e faturamento', () => {
  let cliente: string;
  let p: string;

  beforeEach(async () => {
    cliente = String(createCustomer(LOJA, { name: 'Dona Marlene' }).id);
    p = await produto(10);
  });

  function remeter(chave: string, quantidade: number) {
    return criarConsignacao({ companyId: LOJA, userId, customerId: cliente, items: [{ productId: p, quantity: quantidade }], idempotencyKey: chave });
  }

  it('remessa: a mesma chave com OUTRA mercadoria é recusada (422), e nada sai do saldo', () => {
    remeter('remessa-1', 2);
    expect(saldo(p).quantity).toBe(8);

    esperarErroDeChaveReusada(tentar(() => remeter('remessa-1', 3)));
    expect(saldo(p).quantity).toBe(8);
    expect(contar('SELECT COUNT(*) AS n FROM core_consignments WHERE company_id = ?', LOJA)).toBe(1);

    const reenvio = remeter('remessa-1', 2);
    expect(reenvio.duplicated).toBe(true);
  });

  it('retorno: a mesma chave com OUTRA quantidade é recusada, e o devolvido não muda', () => {
    const doc = remeter('remessa-2', 5);
    registrarRetorno({ companyId: LOJA, userId, consignmentId: doc.id, idempotencyKey: 'retorno-1', items: [{ productId: p, quantity: 1 }] });
    expect(saldo(p).quantity).toBe(6);

    esperarErroDeChaveReusada(
      tentar(() =>
        registrarRetorno({ companyId: LOJA, userId, consignmentId: doc.id, idempotencyKey: 'retorno-1', items: [{ productId: p, quantity: 2 }] }),
      ),
    );
    expect(saldo(p).quantity).toBe(6);
    const reenvio = registrarRetorno({ companyId: LOJA, userId, consignmentId: doc.id, idempotencyKey: 'retorno-1', items: [{ productId: p, quantity: 1 }] });
    expect(reenvio.duplicated).toBe(true);
  });

  it('a chave da remessa reusada num retorno não é o retorno "já feito"', () => {
    const doc = remeter('remessa-3', 5);
    esperarErroDeChaveReusada(
      tentar(() =>
        registrarRetorno({ companyId: LOJA, userId, consignmentId: doc.id, idempotencyKey: 'remessa-3', items: [{ productId: p, quantity: 1 }] }),
      ),
    );
    expect(saldo(p).quantity).toBe(5);
  });

  it('faturamento: a mesma chave com outra mercadoria ou outro pagamento é recusada, e nenhuma venda nasce', () => {
    const doc = remeter('remessa-4', 5);
    const base = { companyId: LOJA, userId, consignmentId: doc.id, idempotencyKey: 'fatura-1' };
    const primeira = faturarConsignacao({ ...base, items: [{ productId: p, quantity: 1 }], payments: [{ method: 'dinheiro', amountCents: 5_000 }] });
    const vendas = contar('SELECT COUNT(*) AS n FROM core_sales WHERE company_id = ?', LOJA);

    esperarErroDeChaveReusada(
      tentar(() => faturarConsignacao({ ...base, items: [{ productId: p, quantity: 2 }], payments: [{ method: 'dinheiro', amountCents: 10_000 }] })),
    );
    esperarErroDeChaveReusada(
      tentar(() => faturarConsignacao({ ...base, items: [{ productId: p, quantity: 1 }], payments: [{ method: 'debito', amountCents: 5_000 }] })),
    );
    expect(contar('SELECT COUNT(*) AS n FROM core_sales WHERE company_id = ?', LOJA)).toBe(vendas);

    const reenvio = faturarConsignacao({ ...base, items: [{ productId: p, quantity: 1 }], payments: [{ method: 'dinheiro', amountCents: 5_000 }] });
    expect(reenvio).toMatchObject({ duplicated: true, saleId: primeira.saleId });
  });

  it('evento anterior à impressão digital: o reenvio diferente devolve o de antes, como sempre', () => {
    const doc = remeter('remessa-5', 5);
    faturarConsignacao({
      companyId: LOJA, userId, consignmentId: doc.id, idempotencyKey: 'fatura-2',
      items: [{ productId: p, quantity: 1 }], payments: [{ method: 'dinheiro', amountCents: 5_000 }],
    });
    getConnection().prepare('UPDATE core_consignment_events SET idempotency_fingerprint = NULL WHERE company_id = ?').run(LOJA);

    expect(remeter('remessa-5', 1).duplicated).toBe(true);
    const outra = faturarConsignacao({
      companyId: LOJA, userId, consignmentId: doc.id, idempotencyKey: 'fatura-2',
      items: [{ productId: p, quantity: 3 }], payments: [{ method: 'dinheiro', amountCents: 15_000 }],
    });
    expect(outra.duplicated).toBe(true);
  });
});

// ============================================================================

describe('a peça de bancada: cadastro e reposição', () => {
  let oficina: Auth;
  const WK = 'wk-outro-corpo';
  const NF = { numero: 'NF 777', fornecedor: 'Voltz', valorTotalCents: 96_000 };

  beforeEach(async () => {
    const g = await loginForTest(app, { userId: 'ger-oficina-outro-corpo', companyId: OFICINA, profileCodes: ['gerente_oficina'] });
    oficina = { Authorization: `Bearer ${g.body.accessToken as string}` };
    getConnection()
      .prepare(
        `INSERT INTO core_workshops (id, company_id, slug, name, kind, active, created_at)
         VALUES (?, ?, 'mob-outro-corpo', 'Bancada', 'mobility', 1, ?)`,
      )
      .run(WK, OFICINA, new Date().toISOString());
  });

  function cadastrar(chave: string, corpo: Record<string, unknown> = {}) {
    return request(app)
      .post('/api/v1/core/workshop/parts')
      .set(oficina)
      .set('Idempotency-Key', chave)
      .send({ workshopId: WK, name: 'Controlador 48V', costCents: 32_000, markupPercent: 40, quantity: 3, documento: NF, ...corpo });
  }
  function repor(productId: string, chave: string, corpo: Record<string, unknown>) {
    return request(app)
      .post(`/api/v1/core/workshop/parts/${productId}/reposicao`)
      .set(oficina)
      .set('Idempotency-Key', chave)
      .send({ documento: NF, ...corpo });
  }
  function custo(productId: string): number {
    return (getConnection().prepare('SELECT cost_cents FROM core_products WHERE id = ?').get(productId) as { cost_cents: number }).cost_cents;
  }

  it('cadastro: a mesma chave com OUTRA quantidade é recusada (422), e nenhuma peça nasce', async () => {
    const a = await cadastrar('peca-1');
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    const b = await cadastrar('peca-1', { quantity: 5 });
    esperarChaveReusada(b);
    expect(contar("SELECT COUNT(*) AS n FROM core_products WHERE company_id = ? AND kind = 'part'", OFICINA)).toBe(1);
    expect(saldo(a.body.productId as string, OFICINA).quantity).toBe(3);

    const c = await cadastrar('peca-1');
    expect(c.body).toMatchObject({ productId: a.body.productId, duplicada: true });
  });

  it('reposição: a mesma chave com OUTRA carga é recusada ANTES de mexer no custo e no saldo', async () => {
    const nova = await cadastrar('peca-2');
    const id = nova.body.productId as string;
    const r = await repor(id, 'repor-1', { quantity: 2, costCents: 33_000 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);

    const outra = await repor(id, 'repor-1', { quantity: 4, costCents: 35_000 });
    esperarChaveReusada(outra);
    expect(saldo(id, OFICINA).quantity).toBe(5);
    expect(custo(id)).toBe(33_000);

    const reenvio = await repor(id, 'repor-1', { quantity: 2, costCents: 33_000 });
    expect(reenvio.status).toBe(200);
    expect(reenvio.body.duplicada).toBe(true);
    expect(saldo(id, OFICINA).quantity).toBe(5);
  });

  it('a chave do cadastro reusada numa reposição é recusada', async () => {
    const nova = await cadastrar('peca-3');
    const outra = await repor(nova.body.productId as string, 'peca-3', { quantity: 2 });
    esperarChaveReusada(outra);
    expect(saldo(nova.body.productId as string, OFICINA).quantity).toBe(3);
  });

  it('entrada anterior à impressão digital: a regra de hoje', async () => {
    const nova = await cadastrar('peca-4');
    const id = nova.body.productId as string;
    await repor(id, 'repor-4', { quantity: 2 });
    getConnection()
      .prepare("UPDATE core_stock_movements SET idempotency_fingerprint = NULL WHERE company_id = ? AND reference_type = 'entrada_bancada'")
      .run(OFICINA);

    const c = await cadastrar('peca-4', { quantity: 9 });
    expect(c.body).toMatchObject({ productId: id, duplicada: true });
    const r = await repor(id, 'repor-4', { quantity: 7 });
    expect(r.status).toBe(200);
    expect(r.body.duplicada).toBe(true);
    expect(saldo(id, OFICINA).quantity).toBe(5);
  });
});
