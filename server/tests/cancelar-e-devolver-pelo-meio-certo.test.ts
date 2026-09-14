/**
 * ============================================================================
 * CANCELAR E DEVOLVER PELO MEIO CERTO — a trilha "venda" da auditoria do
 * Preço Justo
 * ============================================================================
 *
 * O que cada bloco prende, e o defeito que ele reabre se a guarda sair:
 *
 *   E-venda-servidor-01  cancelar depois de uma devolução por PIX tirava a
 *                        venda INTEIRA da gaveta (o cliente recebia R$ 150 por
 *                        R$ 100 pagos) e cancelava o lançamento do PIX; a peça
 *                        devolvida COM DEFEITO voltava ao vendável no
 *                        cancelamento.
 *   E-venda-servidor-03  a devolução aceitava qualquer forma: a venda paga com
 *                        vale ou no cartão saía em dinheiro da gaveta.
 *   E-venda-servidor-04  devolver kit em bom estado dava 400
 *                        (CORE_PRODUCT_IS_KIT); devolver serviço de balcão
 *                        criava saldo fantasma.
 *   E-venda-servidor-05  a venda com NFC-e autorizada era cancelada e a nota
 *                        seguia valendo.
 *   E-venda-servidor-06  a tela dizia "não há o que devolver" até na venda do
 *                        cartão avulso — o servidor passa a dizer, por meio.
 *   E-venda-servidor-14  cancelar de novo respondia 200, auditava de novo e
 *                        gastava a liberação do gestor.
 *   E-venda-servidor-M01 cancelar sem motivo era aceito.
 *
 * Tudo sobe por HTTP com token real e confere o banco — gaveta, estoque,
 * lançamentos, liberação.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { getConnection } from '../src/db/sqlite.js';
import { setKitComponents } from '../src/services/core/CatalogAuxService.js';
import { loginForTest, TEST_PASSWORD } from './helpers/auth.js';

const app = createApp();
const LOJA = 'loja-meio-certo';

type Auth = { Authorization: string };
let gerente: Auth;
let companyId: string;

async function entrar(userId: string, perfil: string): Promise<Auth> {
  const res = await loginForTest(app, { userId, companyId: LOJA, profileCodes: [perfil] });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { Authorization: `Bearer ${res.body.accessToken as string}` };
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  const res = await loginForTest(app, {
    userId: 'gerente-meio',
    companyId: LOJA,
    profileCodes: ['gerente_loja'],
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  gerente = { Authorization: `Bearer ${res.body.accessToken as string}` };
  companyId = String(res.body.company.id);
});

async function produto(precoCents: number, quantidade = 10): Promise<string> {
  const p = await request(app)
    .post('/api/v1/core/products')
    .set(gerente)
    .send({ name: `Produto ${randomUUID().slice(0, 6)}`, priceCents: precoCents });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  if (quantidade > 0) {
    const m = await request(app).post('/api/v1/core/stock/movements').set(gerente).send({
      productId: p.body.id,
      movementType: 'in',
      quantity: quantidade,
      referenceType: 'entrada',
      referenceId: `carga-${p.body.id as string}`,
    });
    expect(m.status, JSON.stringify(m.body)).toBeLessThan(300);
  }
  return String(p.body.id);
}

async function cliente(nome: string): Promise<string> {
  const res = await request(app).post('/api/v1/core/customers').set(gerente).send({ name: nome });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return String(res.body.id);
}

function vender(corpo: Record<string, unknown>) {
  return request(app)
    .post('/api/v1/core/sales')
    .set(gerente)
    .set('Idempotency-Key', randomUUID())
    .send(corpo);
}

async function venderOk(corpo: Record<string, unknown>): Promise<{ id: string; number: number }> {
  const res = await vender(corpo);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; number: number };
}

async function itens(saleId: string) {
  const res = await request(app).get(`/api/v1/core/sales/${saleId}/returnable`).set(gerente);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.items as { sale_item_id: string; product_id: string | null; quantity: number }[];
}

function devolver(corpo: Record<string, unknown>, auth: Auth = gerente) {
  return request(app)
    .post('/api/v1/core/sale-returns')
    .set(auth)
    .send({ reason: 'Cliente devolveu', ...corpo });
}

function cancelar(
  saleId: string,
  corpo: Record<string, unknown> = { reason: 'Cliente desistiu' },
  auth: Auth = gerente,
) {
  return request(app).post(`/api/v1/core/sales/${saleId}/cancel`).set(auth).send(corpo);
}

function saldo(productId: string): number {
  const row = getConnection()
    .prepare('SELECT quantity FROM core_stock WHERE company_id = ? AND product_id = ?')
    .get(companyId, productId) as { quantity: number } | undefined;
  return Number(row?.quantity ?? 0);
}

function statusDaVenda(saleId: string): string {
  return (
    getConnection().prepare('SELECT status FROM core_sales WHERE id = ?').get(saleId) as {
      status: string;
    }
  ).status;
}

function contar(sql: string, ...params: unknown[]): number {
  return Number(
    (getConnection().prepare(sql).get(...(params as never[])) as { n: number }).n,
  );
}

async function abrirCaixa(): Promise<string> {
  const res = await request(app).post('/api/v1/core/cash/open').set(gerente).send({ openingCents: 0 });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return String(res.body.id);
}

function movimentosDaGaveta(sessionId: string): [string, number][] {
  return (
    getConnection()
      .prepare(
        `SELECT movement_type, amount_cents FROM core_cash_movements
          WHERE session_id = ? AND movement_type <> 'opening' ORDER BY created_at, rowid`,
      )
      .all(sessionId) as unknown as { movement_type: string; amount_cents: number }[]
  ).map((m) => [m.movement_type, m.amount_cents]);
}

function saldoDeVale(customerId: string): number {
  return contar(
    'SELECT COALESCE(SUM(amount_cents), 0) AS n FROM core_customer_credits WHERE company_id = ? AND customer_id = ?',
    companyId,
    customerId,
  );
}

// ============================================================================
describe('E-venda-servidor-01 — cancelar depois de devolver não devolve de novo', () => {
  it('venda em dinheiro devolvida em parte por PIX: o cancelamento é recusado, a gaveta fica intacta e o PIX mantém o par', async () => {
    const caixa = await abrirCaixa();
    const p = await produto(5000);
    const v = await venderOk({
      items: [{ productId: p, quantity: 2 }],
      payments: [{ method: 'dinheiro', amountCents: 10000 }],
      cashSessionId: caixa,
    });
    const [linha] = await itens(v.id);
    const dev = await devolver({
      saleId: v.id,
      refundMethod: 'pix',
      items: [{ saleItemId: linha.sale_item_id, quantity: 1 }],
    });
    expect(dev.status, JSON.stringify(dev.body)).toBe(201);

    /*
      Medido antes do conserto: 200, a gaveta levava -R$ 100,00 (a venda
      inteira) e o cliente saía com R$ 150 por R$ 100 pagos; o lançamento de
      saída do PIX era marcado cancelado, e o extrato do banco perdia o par.
    */
    const res = await cancelar(v.id);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe('CORE_SALE_RETURN_OTHER_MEANS');
    expect(res.body.error.message).toMatch(/PIX/);
    expect(statusDaVenda(v.id)).toBe('completed');
    expect(movimentosDaGaveta(caixa)).toEqual([['sale', 10000]]);
    const saida = getConnection()
      .prepare("SELECT status FROM core_finance_entries WHERE origin_type = 'sale_return' AND origin_id = ?")
      .get(dev.body.id) as { status: string };
    expect(saida.status).toBe('settled');

    // O resto volta pela Devolução, que devolve pelo meio certo.
    const resto = await devolver({
      saleId: v.id,
      refundMethod: 'dinheiro',
      cashSessionId: caixa,
      items: [{ saleItemId: linha.sale_item_id, quantity: 1 }],
    });
    expect(resto.status, JSON.stringify(resto.body)).toBe(201);
    expect(movimentosDaGaveta(caixa)).toEqual([
      ['sale', 10000],
      ['sale_return', -5000],
    ]);
  });

  it('a peça devolvida COM DEFEITO não volta ao saldo vendável quando a venda é cancelada', async () => {
    const p = await produto(5000, 10);
    const v = await venderOk({
      items: [{ productId: p, quantity: 2 }],
      payments: [{ method: 'dinheiro', amountCents: 10000 }],
    });
    expect(saldo(p)).toBe(8);
    const [linha] = await itens(v.id);
    const dev = await devolver({
      saleId: v.id,
      items: [{ saleItemId: linha.sale_item_id, quantity: 1, restock: false }],
    });
    expect(dev.status, JSON.stringify(dev.body)).toBe(201);
    expect(saldo(p)).toBe(8);

    const res = await cancelar(v.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // Volta só a peça que ainda estava com o cliente. Antes: 10 — a quebrada
    // entrava no vendável.
    expect(saldo(p)).toBe(9);
  });
});

// ============================================================================
describe('E-venda-servidor-03 — a devolução só devolve, em cada meio, o que entrou nele', () => {
  it('venda paga só com vale: dinheiro é recusado, e o crédito de loja volta ao saldo', async () => {
    const c = await cliente('Marta do Vale');
    const primeira = await produto(20000);
    const v0 = await venderOk({
      items: [{ productId: primeira, quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: 20000 }],
      customerId: c,
    });
    const [l0] = await itens(v0.id);
    const vale = await devolver({
      saleId: v0.id,
      refundMethod: 'credito',
      items: [{ saleItemId: l0.sale_item_id, quantity: 1 }],
    });
    expect(vale.status, JSON.stringify(vale.body)).toBe(201);
    expect(saldoDeVale(c)).toBe(20000);

    const segunda = await produto(20000);
    const v = await venderOk({
      items: [{ productId: segunda, quantity: 1 }],
      payments: [],
      customerId: c,
      customerCreditCents: 20000,
    });
    expect(saldoDeVale(c)).toBe(0);
    const [l] = await itens(v.id);

    const emDinheiro = await devolver({
      saleId: v.id,
      refundMethod: 'dinheiro',
      items: [{ saleItemId: l.sale_item_id, quantity: 1 }],
    });
    // Antes: 201, e o vale virava espécie da gaveta.
    expect(emDinheiro.status, JSON.stringify(emDinheiro.body)).toBe(409);
    expect(emDinheiro.body.error.code).toBe('CORE_RETURN_METHOD_EXCEEDS_RECEIVED');
    expect(emDinheiro.body.error.message).toMatch(/crédito de loja/);
    expect(contar('SELECT COUNT(*) AS n FROM core_sale_returns WHERE sale_id = ?', v.id)).toBe(0);

    const emCredito = await devolver({
      saleId: v.id,
      refundMethod: 'credito',
      items: [{ saleItemId: l.sale_item_id, quantity: 1 }],
    });
    expect(emCredito.status, JSON.stringify(emCredito.body)).toBe(201);
    expect(saldoDeVale(c)).toBe(20000);
  });

  it('venda no cartão não volta em dinheiro da gaveta; volta por estorno no cartão', async () => {
    const p = await produto(10000);
    const v = await venderOk({
      items: [{ productId: p, quantity: 1 }],
      payments: [{ method: 'credito', amountCents: 10000 }],
    });
    const [l] = await itens(v.id);
    const emDinheiro = await devolver({
      saleId: v.id,
      refundMethod: 'dinheiro',
      items: [{ saleItemId: l.sale_item_id, quantity: 1 }],
    });
    expect(emDinheiro.status, JSON.stringify(emDinheiro.body)).toBe(409);
    expect(emDinheiro.body.error.code).toBe('CORE_RETURN_METHOD_EXCEEDS_RECEIVED');
    expect(emDinheiro.body.error.message).toMatch(/estorno no cartão/);

    const noCartao = await devolver({
      saleId: v.id,
      refundMethod: 'estorno_cartao',
      items: [{ saleItemId: l.sale_item_id, quantity: 1 }],
    });
    expect(noCartao.status, JSON.stringify(noCartao.body)).toBe(201);
  });

  it('venda meio dinheiro, meio cartão: em dinheiro volta no máximo a metade que entrou em dinheiro', async () => {
    const p = await produto(5000);
    const v = await venderOk({
      items: [{ productId: p, quantity: 2 }],
      payments: [
        { method: 'dinheiro', amountCents: 5000 },
        { method: 'credito', amountCents: 5000 },
      ],
    });
    const [l] = await itens(v.id);
    const tudo = await devolver({
      saleId: v.id,
      refundMethod: 'dinheiro',
      items: [{ saleItemId: l.sale_item_id, quantity: 2 }],
    });
    expect(tudo.status, JSON.stringify(tudo.body)).toBe(409);
    expect(tudo.body.error.details.tetoCents).toBe(5000);
    expect(tudo.body.error.message).toMatch(/R\$ 50,00/);

    const metade = await devolver({
      saleId: v.id,
      refundMethod: 'dinheiro',
      items: [{ saleItemId: l.sale_item_id, quantity: 1 }],
    });
    expect(metade.status, JSON.stringify(metade.body)).toBe(201);
  });

  it('venda a prazo ainda não recebida não devolve dinheiro que nunca entrou', async () => {
    const c = await cliente('João do Fiado');
    const p = await produto(8000);
    const v = await venderOk({ items: [{ productId: p, quantity: 1 }], payments: [], customerId: c });
    const [l] = await itens(v.id);
    const res = await devolver({
      saleId: v.id,
      refundMethod: 'dinheiro',
      items: [{ saleItemId: l.sale_item_id, quantity: 1 }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe('CORE_RETURN_METHOD_EXCEEDS_RECEIVED');
    expect(res.body.error.message).toMatch(/em aberto/);
  });
});

// ============================================================================
describe('E-venda-servidor-04 — kit desmembrado e serviço de balcão na devolução', () => {
  async function kitDeRevisao() {
    const oleo = await produto(3000, 10);
    const filtro = await produto(4000, 10);
    const kit = await produto(6000, 0);
    setKitComponents(companyId, kit, [
      { componentId: oleo, quantity: 2 },
      { componentId: filtro, quantity: 1 },
    ]);
    return { oleo, filtro, kit };
  }

  it('devolver o kit em bom estado devolve as PEÇAS, e o kit não se move', async () => {
    const { oleo, filtro, kit } = await kitDeRevisao();
    const v = await venderOk({
      items: [{ productId: kit, quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: 6000 }],
    });
    expect(saldo(oleo)).toBe(8);
    expect(saldo(filtro)).toBe(9);

    const [l] = await itens(v.id);
    // Antes: 400 CORE_PRODUCT_IS_KIT — e a tela nasce com "volta ao estoque".
    const dev = await devolver({
      saleId: v.id,
      items: [{ saleItemId: l.sale_item_id, quantity: 1, restock: true }],
    });
    expect(dev.status, JSON.stringify(dev.body)).toBe(201);
    expect(saldo(oleo)).toBe(10);
    expect(saldo(filtro)).toBe(10);
    expect(
      contar('SELECT COUNT(*) AS n FROM core_stock_movements WHERE product_id = ?', kit),
    ).toBe(0);
  });

  it('kit devolvido com defeito e venda cancelada: voltam só as peças do kit que ainda estava com o cliente', async () => {
    const { oleo, filtro, kit } = await kitDeRevisao();
    const v = await venderOk({
      items: [{ productId: kit, quantity: 2 }],
      payments: [{ method: 'dinheiro', amountCents: 12000 }],
    });
    expect(saldo(oleo)).toBe(6);
    expect(saldo(filtro)).toBe(8);
    const [l] = await itens(v.id);
    const dev = await devolver({
      saleId: v.id,
      items: [{ saleItemId: l.sale_item_id, quantity: 1, restock: false }],
    });
    expect(dev.status, JSON.stringify(dev.body)).toBe(201);

    const res = await cancelar(v.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // Antes: 10 e 10 — as peças do kit quebrado entravam no vendável.
    expect(saldo(oleo)).toBe(8);
    expect(saldo(filtro)).toBe(9);
  });

  it('serviço de balcão (sem controle de estoque) devolvido não cria saldo', async () => {
    const servico = await produto(2000, 0);
    getConnection().prepare('UPDATE core_products SET stock_control = 0 WHERE id = ?').run(servico);
    const v = await venderOk({
      items: [{ productId: servico, quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: 2000 }],
    });
    const [l] = await itens(v.id);
    const dev = await devolver({
      saleId: v.id,
      items: [{ saleItemId: l.sale_item_id, quantity: 1, restock: true }],
    });
    expect(dev.status, JSON.stringify(dev.body)).toBe(201);
    expect(saldo(servico)).toBe(0);
    expect(
      contar('SELECT COUNT(*) AS n FROM core_stock_movements WHERE product_id = ?', servico),
    ).toBe(0);
  });
});

// ============================================================================
describe('E-venda-servidor-05 — nota fiscal viva trava o cancelamento da venda', () => {
  function notaDaVenda(saleId: string, status: string): string {
    const id = randomUUID();
    const agora = new Date().toISOString();
    getConnection()
      .prepare(
        `INSERT INTO core_fiscal_documents
           (id, company_id, sale_id, model, serie, number, access_key, environment, status,
            created_at, updated_at)
         VALUES (?, ?, ?, '65', 1, 321, ?, 'homologation', ?, ?, ?)`,
      )
      .run(id, companyId, saleId, `4326${'0'.repeat(40)}`, status, agora, agora);
    return id;
  }

  it('NFC-e autorizada: 409 com o número da nota, e a venda continua valendo', async () => {
    const p = await produto(5000);
    const v = await venderOk({
      items: [{ productId: p, quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: 5000 }],
    });
    const nota = notaDaVenda(v.id, 'AUTHORIZED');

    const res = await cancelar(v.id);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe('CORE_SALE_HAS_FISCAL_DOCUMENT');
    expect(res.body.error.message).toMatch(/NFC-e nº 321/);
    expect(res.body.error.details.documentId).toBe(nota);
    expect(statusDaVenda(v.id)).toBe('completed');
    expect(saldo(p)).toBe(9);

    // Cancelada a nota no painel fiscal, a venda pode ser cancelada.
    getConnection().prepare("UPDATE core_fiscal_documents SET status = 'CANCELLED' WHERE id = ?").run(nota);
    const depois = await cancelar(v.id);
    expect(depois.status, JSON.stringify(depois.body)).toBe(200);
    expect(saldo(p)).toBe(10);
  });

  it('nota rejeitada não trava nada — ela não vale como documento', async () => {
    const p = await produto(5000);
    const v = await venderOk({
      items: [{ productId: p, quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: 5000 }],
    });
    notaDaVenda(v.id, 'REJECTED');
    expect((await cancelar(v.id)).status).toBe(200);
  });
});

// ============================================================================
describe('E-venda-servidor-06 — o cancelamento diz o que devolveu e o que precisa de uma mão', () => {
  it('cartão sem maquininha integrada: o resumo manda estornar no aparelho', async () => {
    const p = await produto(25000);
    const v = await venderOk({
      items: [{ productId: p, quantity: 1 }],
      payments: [{ method: 'credito', amountCents: 25000 }],
    });
    const res = await cancelar(v.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.reembolso).toMatchObject({
      gavetaCents: 0,
      aDevolverAMao: { dinheiro: 0, credito: 25000, debito: 0, pix: 0 },
      maquininhaCents: 0,
      jaDevolvidoCents: 0,
    });
  });

  it('dinheiro com gaveta e devolução no meio: o resumo diz quanto saiu da gaveta agora', async () => {
    const caixa = await abrirCaixa();
    const p = await produto(5000);
    const v = await venderOk({
      items: [{ productId: p, quantity: 2 }],
      payments: [{ method: 'dinheiro', amountCents: 10000 }],
      cashSessionId: caixa,
    });
    const [l] = await itens(v.id);
    const dev = await devolver({
      saleId: v.id,
      refundMethod: 'dinheiro',
      cashSessionId: caixa,
      items: [{ saleItemId: l.sale_item_id, quantity: 1 }],
    });
    expect(dev.status, JSON.stringify(dev.body)).toBe(201);
    const res = await cancelar(v.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.reembolso.gavetaCents).toBe(5000);
    expect(res.body.reembolso.jaDevolvidoCents).toBe(5000);
    expect(res.body.reembolso.aDevolverAMao).toEqual({ dinheiro: 0, credito: 0, debito: 0, pix: 0 });
  });
});

// ============================================================================
describe('E-venda-servidor-14 — cancelar de novo é recusado e não gasta a liberação', () => {
  it('a segunda vez é 409, e a auditoria tem uma linha de cancelamento só', async () => {
    const p = await produto(5000);
    const v = await venderOk({
      items: [{ productId: p, quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: 5000 }],
    });
    expect((await cancelar(v.id)).status).toBe(200);
    const deNovo = await cancelar(v.id, { reason: 'Aba esquecida aberta' });
    expect(deNovo.status, JSON.stringify(deNovo.body)).toBe(409);
    expect(deNovo.body.error.code).toBe('CORE_SALE_ALREADY_CANCELLED');
    expect(
      contar(
        "SELECT COUNT(*) AS n FROM core_audit_log WHERE company_id = ? AND action = 'sale.cancel' AND entity_id = ?",
        companyId,
        v.id,
      ),
    ).toBe(1);
  });

  it('o bilhete do gestor pedido para a venda que já estava cancelada continua intacto', async () => {
    const estoquista = await entrar('estoque-meio', 'estoquista');
    const p = await produto(5000);
    const v = await venderOk({
      items: [{ productId: p, quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: 5000 }],
    });
    expect((await cancelar(v.id)).status).toBe(200);

    const lib = await request(app)
      .post('/api/v1/core/authorizations')
      .set(estoquista)
      .send({
        action: 'cancelar_venda',
        referenceId: v.id,
        login: `gerente-meio@${LOJA}`,
        password: TEST_PASSWORD,
      });
    expect(lib.status, JSON.stringify(lib.body)).toBe(201);

    const res = await cancelar(
      v.id,
      { reason: 'Outra aba', authorizationId: lib.body.id },
      estoquista,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe('CORE_SALE_ALREADY_CANCELLED');
    const bilhete = getConnection()
      .prepare('SELECT consumed_ref_id FROM core_authorizations WHERE id = ?')
      .get(lib.body.id) as { consumed_ref_id: string | null };
    expect(bilhete.consumed_ref_id).toBeNull();
  });
});

// ============================================================================
describe('E-venda-servidor-M01 — o motivo do cancelamento é obrigatório', () => {
  it('sem motivo (ou com uma letra) é 400, e nada é desfeito', async () => {
    const p = await produto(5000, 10);
    const v = await venderOk({
      items: [{ productId: p, quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: 5000 }],
    });
    for (const corpo of [{}, { reason: '  a ' }]) {
      const res = await cancelar(v.id, corpo);
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(res.body.error.code).toBe('CORE_CANCEL_REASON_REQUIRED');
    }
    expect(statusDaVenda(v.id)).toBe('completed');
    expect(saldo(p)).toBe(9);
  });
});
