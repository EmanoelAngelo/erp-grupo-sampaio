/**
 * CRÉDITO DE LOJA — o ciclo da troca, fechado (GAP-V10 / GAP-V47).
 *
 * ## O que estava quebrado
 *
 * A devolução já sabia devolver "em crédito na loja": gravava
 * `refund_method = 'credito'`, não lançava saída nenhuma (com razão — o
 * dinheiro não saiu do caixa) e o DRE NOMEAVA o valor numa ressalva. A outra
 * metade não existia: nenhuma tabela guardava o saldo, nenhuma tela o mostrava e
 * nenhuma venda o consumia. O operador dava o crédito pelo sistema e cobrava de
 * volta no papel — o passivo crescia a cada devolução e nenhuma consulta o
 * encontrava.
 *
 * ## COMO CADA GRUPO FALHA quando o guarda sai (verificado, um por um)
 *
 *   - tire a chamada de `grantCredit` de `createSaleReturn` e a devolução em
 *     crédito volta a não deixar saldo: o primeiro grupo fica vermelho no
 *     extrato zerado;
 *   - tire a exigência de cliente e o vale volta a nascer sem dono — dinheiro
 *     que a loja deve a ninguém;
 *   - tire a conferência de saldo de `redeemCredit` e a segunda venda gasta o
 *     crédito que a primeira já gastou: o saldo vai a negativo e o grupo da
 *     concorrência acusa;
 *   - troque `aCobrarNosMeios` de volta por `total` no cálculo do troco e a
 *     venda paga com vale devolve o vale EM ESPÉCIE — a porta dos fundos que
 *     transforma crédito em dinheiro de gaveta;
 *   - tire `returnRedeemedCredit` de `cancelSale` e o cliente paga com o vale,
 *     a venda é anulada, a mercadoria volta à prateleira e o vale evapora;
 *   - tire `revokeCreditFromSale` e sobra um vale de pé sobre uma venda que o
 *     sistema afirma nunca ter acontecido;
 *   - tire a baixa-espelho de `createSaleReturn` e a saída de dinheiro da
 *     devolução volta a ser invisível para a conciliação bancária (a pendência
 *     da onda 1).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();
let auth: { Authorization: string };
let outraAuth: { Authorization: string };
let companyId: string;
let outraCompanyId: string;

beforeEach(async () => {
  resetDbForTests();
  const res = await loginForTest(app, {
    userId: 'gerente-credito',
    companyId: 'loja-credito',
    profileCodes: ['gerente_loja'],
  });
  auth = { Authorization: `Bearer ${res.body.accessToken}` };
  companyId = res.body.company.id;

  const outra = await loginForTest(app, {
    userId: 'gerente-vizinha',
    companyId: 'loja-vizinha',
    profileCodes: ['gerente_loja'],
  });
  outraAuth = { Authorization: `Bearer ${outra.body.accessToken}` };
  outraCompanyId = outra.body.company.id;
});

async function produtoComEstoque(
  nome: string,
  preco: number,
  qtd: number,
  cabecalho = auth,
): Promise<string> {
  const p = await request(app)
    .post('/api/v1/core/products')
    .set(cabecalho)
    .send({ name: nome, priceCents: preco });
  await request(app).post('/api/v1/core/stock/movements').set(cabecalho).send({
    productId: p.body.id,
    movementType: 'in',
    quantity: qtd,
    referenceType: 'entrada',
    referenceId: `carga-${p.body.id}`,
  });
  return p.body.id as string;
}

async function cliente(nome: string, cabecalho = auth): Promise<string> {
  const res = await request(app).post('/api/v1/core/customers').set(cabecalho).send({ name: nome });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function venda(
  items: { productId: string; quantity: number }[],
  total: number,
  extra: Record<string, unknown> = {},
  cabecalho = auth,
) {
  const res = await request(app)
    .post('/api/v1/core/sales')
    .set(cabecalho)
    .send({
      idempotencyKey: randomUUID(),
      items,
      payments: total > 0 ? [{ method: 'dinheiro', amountCents: total }] : [],
      ...extra,
    });
  return res;
}

async function itensDevolviveis(saleId: string, cabecalho = auth) {
  const res = await request(app).get(`/api/v1/core/sales/${saleId}/returnable`).set(cabecalho);
  return res.body.items as { sale_item_id: string; quantity: number }[];
}

async function devolverEmCredito(saleId: string, cabecalho = auth) {
  const itens = await itensDevolviveis(saleId, cabecalho);
  return request(app)
    .post('/api/v1/core/sale-returns')
    .set(cabecalho)
    .send({
      saleId,
      reason: 'Vai escolher outro',
      refundMethod: 'credito',
      items: [{ saleItemId: itens[0].sale_item_id, quantity: 1 }],
    });
}

async function extrato(customerId: string, cabecalho = auth) {
  const res = await request(app)
    .get(`/api/v1/core/customers/${customerId}/credits`)
    .set(cabecalho);
  return res;
}

/** O saldo lido do banco, sem passar pela rota — a soma crua da razão. */
function saldoNoBanco(empresa: string, customerId: string): number {
  const row = getConnection()
    .prepare(
      `SELECT COALESCE(SUM(amount_cents), 0) AS saldo FROM core_customer_credits
        WHERE company_id = ? AND customer_id = ?`,
    )
    .get(empresa, customerId) as { saldo: number };
  return Number(row.saldo);
}

describe('a devolução em crédito vira saldo', () => {
  it('concede o valor devolvido ao cliente da venda', async () => {
    const c = await cliente('Marta Compradora');
    const p = await produtoComEstoque('Relógio', 25_000, 5);
    const v = await venda([{ productId: p, quantity: 1 }], 25_000, { customerId: c });
    expect(v.status).toBe(201);

    const dev = await devolverEmCredito(v.body.id);
    expect(dev.status).toBe(201);

    const ext = await extrato(c);
    expect(ext.status).toBe(200);
    expect(ext.body.balance).toBe(25_000);
    expect(ext.body.entries).toHaveLength(1);
    expect(ext.body.entries[0].kind).toBe('grant');
    expect(ext.body.entries[0].amount_cents).toBe(25_000);
    // A origem é NAVEGÁVEL: o número da devolução vem junto, senão "R$ 250,00
    // concedidos" manda quem lê procurar no histórico inteiro.
    expect(ext.body.entries[0].return_number).toBe(dev.body.number);
  });

  it('e continua SEM lançamento financeiro — o dinheiro não saiu do caixa', async () => {
    const c = await cliente('Marta Compradora');
    const p = await produtoComEstoque('Relógio', 25_000, 5);
    const v = await venda([{ productId: p, quantity: 1 }], 25_000, { customerId: c });
    const dev = await devolverEmCredito(v.body.id);

    const saida = getConnection()
      .prepare(
        "SELECT COUNT(*) AS n FROM core_finance_entries WHERE origin_type = 'sale_return' AND origin_id = ?",
      )
      .get(dev.body.id) as { n: number };
    expect(saida.n).toBe(0);
  });

  it('venda sem cliente não admite devolução em crédito, e a recusa diz o que fazer', async () => {
    const p = await produtoComEstoque('Relógio', 25_000, 5);
    const v = await venda([{ productId: p, quantity: 1 }], 25_000);
    const dev = await devolverEmCredito(v.body.id);

    expect(dev.status).toBe(409);
    expect(dev.body.error.code).toBe('CORE_RETURN_CREDIT_NEEDS_CUSTOMER');
    expect(dev.body.error.message).toMatch(/cliente/i);
    expect(dev.body.error.message).toMatch(/dinheiro|PIX|cart/i);

    // E a devolução inteira foi recusada: nada de estoque devolvido pela metade.
    const devolucoes = getConnection()
      .prepare('SELECT COUNT(*) AS n FROM core_sale_returns WHERE company_id = ?')
      .get(companyId) as { n: number };
    expect(devolucoes.n).toBe(0);
  });

  it('a mesma devolução não concede duas vezes', async () => {
    const c = await cliente('Marta Compradora');
    const p = await produtoComEstoque('Relógio', 25_000, 5);
    const v = await venda([{ productId: p, quantity: 1 }], 25_000, { customerId: c });
    const dev = await devolverEmCredito(v.body.id);

    // A idempotência é da ORIGEM, não da requisição: chamar de novo pela mesma
    // devolução devolve a linha que já existe em vez de somar de novo.
    const { grantCredit } = await import('../src/services/core/CustomerCreditService.js');
    const repetido = grantCredit({
      companyId,
      customerId: c,
      amountCents: 25_000,
      originType: 'sale_return',
      originId: String(dev.body.id),
      description: 'tentativa repetida',
    });
    expect(repetido.granted).toBe(0);
    expect(saldoNoBanco(companyId, c)).toBe(25_000);
  });
});

describe('o PDV gasta o crédito', () => {
  async function clienteComCredito(valor: number): Promise<string> {
    const c = await cliente('Marta Compradora');
    const p = await produtoComEstoque('Relógio devolvido', valor, 5);
    const v = await venda([{ productId: p, quantity: 1 }], valor, { customerId: c });
    const dev = await devolverEmCredito(v.body.id);
    expect(dev.status).toBe(201);
    return c;
  }

  it('paga a venda inteira com o vale, sem pagamento nenhum', async () => {
    const c = await clienteComCredito(25_000);
    const p = await produtoComEstoque('Bolsa', 25_000, 5);

    const v = await request(app)
      .post('/api/v1/core/sales')
      .set(auth)
      .send({
        idempotencyKey: randomUUID(),
        items: [{ productId: p, quantity: 1 }],
        payments: [],
        customerId: c,
        customerCreditCents: 25_000,
      });
    expect(v.status).toBe(201);
    expect(v.body.total_cents).toBe(25_000);
    expect(v.body.change_cents).toBe(0);
    expect(saldoNoBanco(companyId, c)).toBe(0);

    // O recebível nasce QUITADO: a dívida do cliente foi extinta pelo vale, e
    // deixá-la em aberto faria alguém cobrar o que ele não deve.
    const lanc = getConnection()
      .prepare(
        `SELECT status, settled_cents FROM core_finance_entries
          WHERE origin_type = 'sale' AND origin_id = ?`,
      )
      .get(v.body.id) as { status: string; settled_cents: number };
    expect(lanc.status).toBe('settled');
    expect(lanc.settled_cents).toBe(25_000);
  });

  it('a baixa do vale tem método próprio e não se mistura com dinheiro', async () => {
    const c = await clienteComCredito(25_000);
    const p = await produtoComEstoque('Bolsa', 40_000, 5);

    const v = await request(app)
      .post('/api/v1/core/sales')
      .set(auth)
      .send({
        idempotencyKey: randomUUID(),
        items: [{ productId: p, quantity: 1 }],
        payments: [{ method: 'dinheiro', amountCents: 15_000 }],
        customerId: c,
        customerCreditCents: 25_000,
      });
    expect(v.status).toBe(201);

    const baixas = getConnection()
      .prepare(
        `SELECT s.amount_cents, s.method FROM core_finance_settlements s
           JOIN core_finance_entries e ON e.id = s.entry_id
          WHERE e.origin_type = 'sale' AND e.origin_id = ?
          ORDER BY s.method`,
      )
      .all(v.body.id) as unknown as { amount_cents: number; method: string }[];

    expect(baixas).toHaveLength(2);
    expect(baixas.find((b) => b.method === 'credito_loja')?.amount_cents).toBe(25_000);
    expect(baixas.find((b) => b.method === 'dinheiro')?.amount_cents).toBe(15_000);
    // A soma continua sendo o que liquidou — a identidade que
    // `fatia-a-vista-nasce-com-baixa` cobra vale aqui também.
    expect(baixas.reduce((acc, b) => acc + b.amount_cents, 0)).toBe(40_000);
  });

  it('saldo insuficiente recusa a venda inteira — o estoque não baixa', async () => {
    const c = await clienteComCredito(25_000);
    const p = await produtoComEstoque('Bolsa', 90_000, 5);

    const v = await request(app)
      .post('/api/v1/core/sales')
      .set(auth)
      .send({
        idempotencyKey: randomUUID(),
        items: [{ productId: p, quantity: 1 }],
        payments: [{ method: 'dinheiro', amountCents: 30_000 }],
        customerId: c,
        customerCreditCents: 60_000,
      });
    expect(v.status).toBe(409);
    expect(v.body.error.code).toBe('CORE_CREDIT_INSUFFICIENT');
    expect(v.body.error.message).toMatch(/250,00/);

    const saldo = getConnection()
      .prepare('SELECT quantity FROM core_stock WHERE company_id = ? AND product_id = ?')
      .get(companyId, p) as { quantity: number };
    expect(saldo.quantity).toBe(5);
    expect(saldoNoBanco(companyId, c)).toBe(25_000);
  });

  it('crédito acima do total é recusado: vale não vira troco', async () => {
    const c = await clienteComCredito(25_000);
    const p = await produtoComEstoque('Chaveiro', 5_000, 5);

    const v = await request(app)
      .post('/api/v1/core/sales')
      .set(auth)
      .send({
        idempotencyKey: randomUUID(),
        items: [{ productId: p, quantity: 1 }],
        payments: [],
        customerId: c,
        customerCreditCents: 25_000,
      });
    expect(v.status).toBe(400);
    expect(v.body.error.code).toBe('CORE_CREDIT_EXCEEDS_TOTAL');
    expect(saldoNoBanco(companyId, c)).toBe(25_000);
  });

  it('o troco é medido contra o que sobrou para os meios, não contra o total', async () => {
    const c = await clienteComCredito(25_000);
    const p = await produtoComEstoque('Bolsa', 40_000, 5);

    // R$ 400,00 de venda, R$ 250,00 de vale: sobram R$ 150,00 para os meios. O
    // cliente entrega uma nota de R$ 200,00 e tem R$ 50,00 a receber de volta.
    const v = await request(app)
      .post('/api/v1/core/sales')
      .set(auth)
      .send({
        idempotencyKey: randomUUID(),
        items: [{ productId: p, quantity: 1 }],
        payments: [{ method: 'dinheiro', amountCents: 20_000 }],
        customerId: c,
        customerCreditCents: 25_000,
      });
    expect(v.status).toBe(201);
    /*
      O ponto do caso: com o troco medido contra o TOTAL, `20.000 - 40.000` é
      negativo e o troco sai ZERO — o cliente vai embora sem os R$ 50,00 dele, e
      a gaveta fecha com uma sobra que ninguém explica.
    */
    expect(v.body.change_cents).toBe(5_000);
  });

  it('e o vale não sai pela porta do troco: sobra em meio eletrônico é recusada', async () => {
    const c = await clienteComCredito(25_000);
    const p = await produtoComEstoque('Bolsa', 25_000, 5);

    // A venda inteira já está paga pelo vale, e ainda assim entra um PIX. Se o
    // troco fosse liberado, o cliente sairia com dinheiro na conta contra um
    // vale — crédito de loja virando espécie pela porta dos fundos.
    const v = await request(app)
      .post('/api/v1/core/sales')
      .set(auth)
      .send({
        idempotencyKey: randomUUID(),
        items: [{ productId: p, quantity: 1 }],
        payments: [{ method: 'pix', amountCents: 5_000 }],
        customerId: c,
        customerCreditCents: 25_000,
      });
    expect(v.status).toBe(400);
    expect(v.body.error.code).toBe('CORE_CHANGE_NOT_CASH');
    expect(saldoNoBanco(companyId, c)).toBe(25_000);
  });

  it('sem cliente na venda o crédito é recusado', async () => {
    const p = await produtoComEstoque('Bolsa', 25_000, 5);
    const v = await request(app)
      .post('/api/v1/core/sales')
      .set(auth)
      .send({
        idempotencyKey: randomUUID(),
        items: [{ productId: p, quantity: 1 }],
        payments: [{ method: 'dinheiro', amountCents: 25_000 }],
        customerCreditCents: 1_000,
      });
    expect(v.status).toBe(400);
    expect(v.body.error.code).toBe('CORE_CREDIT_CUSTOMER_REQUIRED');
  });

  it('a venda paga com vale NÃO vira crediário de trinta dias', async () => {
    const c = await clienteComCredito(25_000);
    const p = await produtoComEstoque('Bolsa', 25_000, 5);
    const v = await request(app)
      .post('/api/v1/core/sales')
      .set(auth)
      .send({
        idempotencyKey: randomUUID(),
        items: [{ productId: p, quantity: 1 }],
        payments: [],
        customerId: c,
        customerCreditCents: 25_000,
      });
    expect(v.status).toBe(201);

    // Venda sem `payments` é venda fiada — menos quando o vale já a pagou. Sem
    // esta distinção, uma venda quitada nasceria com vencimento de crediário.
    const lanc = getConnection()
      .prepare(
        `SELECT due_date, competence_date FROM core_finance_entries
          WHERE origin_type = 'sale' AND origin_id = ?`,
      )
      .get(v.body.id) as { due_date: string; competence_date: string };
    expect(lanc.due_date).toBe(lanc.competence_date);
  });

  it('com operadora cadastrada, o vale vira uma fatia quitada e o cartão segue em aberto', async () => {
    /*
      O SEGUNDO CAMINHO DO FINANCEIRO — o das fatias.

      Com operadora cadastrada, a venda deixa de ter UM lançamento e passa a ter
      um por fatia. O vale precisa entrar ali como fatia JÁ QUITADA de método
      próprio, senão ele sumiria: o caminho das fatias é montado a partir de
      `payments`, e crédito de loja não é pagamento.

      Sem isto, uma venda de R$ 400 com R$ 250 de vale nasceria com R$ 150 de
      fatia de cartão e mais nada — R$ 250 de receita reconhecida sem nenhum
      título, e o total da venda deixaria de bater com a soma dos lançamentos.
    */
    const op = await request(app).post('/api/v1/core/acquirers').set(auth).send({ name: 'Cielo' });
    expect(op.status).toBe(201);
    await request(app)
      .put(`/api/v1/core/acquirers/${op.body.acquirer.id}/rates`)
      .set(auth)
      .send({ paymentMethod: 'credito', installments: 1, feeBps: 350, settlementDays: 30 });

    const c = await clienteComCredito(25_000);
    const p = await produtoComEstoque('Bolsa', 40_000, 5);
    const v = await request(app)
      .post('/api/v1/core/sales')
      .set(auth)
      .send({
        idempotencyKey: randomUUID(),
        items: [{ productId: p, quantity: 1 }],
        payments: [{ method: 'credito', amountCents: 15_000 }],
        customerId: c,
        customerCreditCents: 25_000,
      });
    expect(v.status).toBe(201);

    const fatias = getConnection()
      .prepare(
        `SELECT amount_cents, status, payment_method FROM core_finance_entries
          WHERE origin_type = 'sale' AND origin_id = ? AND direction = 'in'
          ORDER BY installment_number`,
      )
      .all(v.body.id) as unknown as {
      amount_cents: number;
      status: string;
      payment_method: string | null;
    }[];

    const doVale = fatias.find((f) => f.payment_method === 'credito_loja')!;
    expect(doVale.amount_cents).toBe(25_000);
    expect(doVale.status).toBe('settled');

    const daOperadora = fatias.find((f) => f.payment_method === 'credito')!;
    expect(daOperadora.amount_cents).toBe(15_000);
    // O dinheiro do cartão ainda não caiu — a fatia dela nasce em aberto.
    expect(daOperadora.status).toBe('open');

    // E o total da venda continua batendo com a soma dos títulos a receber.
    expect(fatias.reduce((acc, f) => acc + f.amount_cents, 0)).toBe(40_000);
    expect(saldoNoBanco(companyId, c)).toBe(0);
  });

  it('a ficha da venda diz quanto do vale foi usado', async () => {
    const c = await clienteComCredito(25_000);
    const p = await produtoComEstoque('Bolsa', 40_000, 5);
    const v = await request(app)
      .post('/api/v1/core/sales')
      .set(auth)
      .send({
        idempotencyKey: randomUUID(),
        items: [{ productId: p, quantity: 1 }],
        payments: [{ method: 'dinheiro', amountCents: 15_000 }],
        customerId: c,
        customerCreditCents: 25_000,
      });

    const ficha = await request(app).get(`/api/v1/core/sales/${v.body.id}`).set(auth);
    expect(ficha.body.customerCreditCents).toBe(25_000);
    // O vale NÃO entra em `payments`: ali mora o que o cliente pagou, e aqui
    // ele cobrou uma dívida que a loja já tinha com ele.
    expect(ficha.body.payments).toHaveLength(1);
  });
});

describe('concorrência: duas vendas não gastam o mesmo vale', () => {
  it('a segunda é recusada e o saldo nunca fica negativo', async () => {
    const c = await cliente('Marta Compradora');
    const devolvido = await produtoComEstoque('Relógio devolvido', 25_000, 5);
    const v0 = await venda([{ productId: devolvido, quantity: 1 }], 25_000, { customerId: c });
    await devolverEmCredito(v0.body.id);

    const p = await produtoComEstoque('Bolsa', 25_000, 5);
    const corpo = () => ({
      idempotencyKey: randomUUID(),
      items: [{ productId: p, quantity: 1 }],
      payments: [],
      customerId: c,
      customerCreditCents: 25_000,
    });

    /*
      As duas partem JUNTAS. `withTransaction` abre `BEGIN IMMEDIATE`, então a
      segunda espera o lock de escrita da primeira, lê o saldo JÁ debitado e é
      recusada — é a mesma proteção que impede dois caixas de venderem a última
      peça do estoque.
    */
    const [a, b] = await Promise.all([
      request(app).post('/api/v1/core/sales').set(auth).send(corpo()),
      request(app).post('/api/v1/core/sales').set(auth).send(corpo()),
    ]);

    const status = [a.status, b.status].sort();
    expect(status).toEqual([201, 409]);
    const recusada = a.status === 409 ? a : b;
    expect(recusada.body.error.code).toBe('CORE_CREDIT_INSUFFICIENT');

    expect(saldoNoBanco(companyId, c)).toBe(0);
    const resgates = getConnection()
      .prepare(
        "SELECT COUNT(*) AS n FROM core_customer_credits WHERE company_id = ? AND kind = 'redeem'",
      )
      .get(companyId) as { n: number };
    expect(resgates.n).toBe(1);
  });
});

describe('cancelar devolve o vale', () => {
  it('cancelar a venda que gastou o crédito devolve o saldo — e só uma vez', async () => {
    const c = await cliente('Marta Compradora');
    const devolvido = await produtoComEstoque('Relógio devolvido', 25_000, 5);
    const v0 = await venda([{ productId: devolvido, quantity: 1 }], 25_000, { customerId: c });
    await devolverEmCredito(v0.body.id);

    const p = await produtoComEstoque('Bolsa', 25_000, 5);
    const v = await request(app)
      .post('/api/v1/core/sales')
      .set(auth)
      .send({
        idempotencyKey: randomUUID(),
        items: [{ productId: p, quantity: 1 }],
        payments: [],
        customerId: c,
        customerCreditCents: 25_000,
      });
    expect(saldoNoBanco(companyId, c)).toBe(0);

    const cancel = await request(app)
      .post(`/api/v1/core/sales/${v.body.id}/cancel`)
      .set(auth)
      .send({ reason: 'cliente desistiu' });
    expect(cancel.status).toBe(200);
    expect(saldoNoBanco(companyId, c)).toBe(25_000);

    // Cancelar de novo não devolve em dobro.
    await request(app)
      .post(`/api/v1/core/sales/${v.body.id}/cancel`)
      .set(auth)
      .send({ reason: 'de novo' });
    expect(saldoNoBanco(companyId, c)).toBe(25_000);
  });

  it('cancelar a venda que originou a devolução REVOGA o crédito concedido', async () => {
    const c = await cliente('Marta Compradora');
    const p = await produtoComEstoque('Relógio', 25_000, 5);
    const v = await venda([{ productId: p, quantity: 1 }], 25_000, { customerId: c });
    await devolverEmCredito(v.body.id);
    expect(saldoNoBanco(companyId, c)).toBe(25_000);

    const cancel = await request(app)
      .post(`/api/v1/core/sales/${v.body.id}/cancel`)
      .set(auth)
      .send({ reason: 'venda não valeu' });
    expect(cancel.status).toBe(200);

    // Vale de pé sobre uma venda que o sistema afirma nunca ter acontecido
    // seria dinheiro do nada.
    expect(saldoNoBanco(companyId, c)).toBe(0);
    const ext = await extrato(c);
    expect(ext.body.entries.some((e: { kind: string }) => e.kind === 'reversal')).toBe(true);
  });
});

describe('o extrato e o cerco da empresa', () => {
  it('mostra grants e redeems com a origem navegável e o saldo atual', async () => {
    const c = await cliente('Marta Compradora');
    const devolvido = await produtoComEstoque('Relógio devolvido', 25_000, 5);
    const v0 = await venda([{ productId: devolvido, quantity: 1 }], 25_000, { customerId: c });
    const dev = await devolverEmCredito(v0.body.id);

    const p = await produtoComEstoque('Bolsa', 10_000, 5);
    const v = await request(app)
      .post('/api/v1/core/sales')
      .set(auth)
      .send({
        idempotencyKey: randomUUID(),
        items: [{ productId: p, quantity: 1 }],
        payments: [],
        customerId: c,
        customerCreditCents: 10_000,
      });

    const ext = await extrato(c);
    expect(ext.body.balance).toBe(15_000);

    const linhas = ext.body.entries as {
      kind: string;
      amount_cents: number;
      return_number: number | null;
      sale_number: number | null;
    }[];
    const concessao = linhas.find((l) => l.kind === 'grant')!;
    const resgate = linhas.find((l) => l.kind === 'redeem')!;
    expect(concessao.return_number).toBe(dev.body.number);
    expect(resgate.sale_number).toBe(v.body.number);
    expect(resgate.amount_cents).toBe(-10_000);
  });

  it('cliente da outra empresa é invisível: o extrato dele não vaza para cá', async () => {
    const daVizinha = await cliente('Cliente da vizinha', outraAuth);
    const p = await produtoComEstoque('Relógio', 25_000, 5, outraAuth);
    const v = await venda([{ productId: p, quantity: 1 }], 25_000, { customerId: daVizinha }, outraAuth);
    await devolverEmCredito(v.body.id, outraAuth);
    expect(saldoNoBanco(outraCompanyId, daVizinha)).toBe(25_000);

    // A loja A pergunta pelo cliente da B: o extrato volta VAZIO, e não com o
    // saldo dela. Zero é a verdade daqui — não existe crédito deste cliente
    // nesta operação.
    const ext = await extrato(daVizinha);
    expect(ext.status).toBe(200);
    expect(ext.body.balance).toBe(0);
    expect(ext.body.entries).toEqual([]);
  });

  it('e o crédito da outra empresa não é gastável aqui', async () => {
    const daVizinha = await cliente('Cliente da vizinha', outraAuth);
    const p = await produtoComEstoque('Relógio', 25_000, 5, outraAuth);
    const v = await venda([{ productId: p, quantity: 1 }], 25_000, { customerId: daVizinha }, outraAuth);
    await devolverEmCredito(v.body.id, outraAuth);

    const aqui = await produtoComEstoque('Bolsa', 25_000, 5);
    const tentativa = await request(app)
      .post('/api/v1/core/sales')
      .set(auth)
      .send({
        idempotencyKey: randomUUID(),
        items: [{ productId: aqui, quantity: 1 }],
        payments: [],
        customerId: daVizinha,
        customerCreditCents: 25_000,
      });
    // `createSale` recusa o cliente de outra operação antes mesmo do crédito —
    // é o cerco que já existia, e ele continua sendo a primeira porta.
    expect(tentativa.status).toBe(400);
    expect(saldoNoBanco(outraCompanyId, daVizinha)).toBe(25_000);
  });
});

describe('a devolução em dinheiro nasce com a baixa-espelho', () => {
  it('reembolso em dinheiro deixa linha em core_finance_settlements', async () => {
    const p = await produtoComEstoque('Relógio', 25_000, 5);
    const v = await venda([{ productId: p, quantity: 1 }], 25_000);
    const itens = await itensDevolviveis(v.body.id);

    const dev = await request(app)
      .post('/api/v1/core/sale-returns')
      .set(auth)
      .send({
        saleId: v.body.id,
        reason: 'defeito',
        refundMethod: 'dinheiro',
        items: [{ saleItemId: itens[0].sale_item_id, quantity: 1 }],
      });
    expect(dev.status).toBe(201);

    /*
      A PENDÊNCIA DA ONDA 1. O lançamento nascia `settled` com `settled_cents`
      cheio e NENHUMA linha de baixa — a conciliação bancária compara extrato
      contra BAIXAS, e a devolução em PIX (que sai da conta e aparece no
      extrato) não existia para ela. É a mesma doença que a V29 curou na venda
      à vista, na ponta em que o dinheiro SAI.
    */
    const baixas = getConnection()
      .prepare(
        `SELECT s.amount_cents, s.method FROM core_finance_settlements s
           JOIN core_finance_entries e ON e.id = s.entry_id
          WHERE e.origin_type = 'sale_return' AND e.origin_id = ?`,
      )
      .all(dev.body.id) as unknown as { amount_cents: number; method: string }[];
    expect(baixas).toHaveLength(1);
    expect(baixas[0].amount_cents).toBe(25_000);
    expect(baixas[0].method).toBe('dinheiro');
  });

  it('reembolso em PIX também, com o método de verdade', async () => {
    const p = await produtoComEstoque('Relógio', 25_000, 5);
    const v = await venda([{ productId: p, quantity: 1 }], 25_000);
    const itens = await itensDevolviveis(v.body.id);

    const dev = await request(app)
      .post('/api/v1/core/sale-returns')
      .set(auth)
      .send({
        saleId: v.body.id,
        reason: 'arrependimento',
        refundMethod: 'pix',
        items: [{ saleItemId: itens[0].sale_item_id, quantity: 1 }],
      });

    const baixa = getConnection()
      .prepare(
        `SELECT s.method FROM core_finance_settlements s
           JOIN core_finance_entries e ON e.id = s.entry_id
          WHERE e.origin_type = 'sale_return' AND e.origin_id = ?`,
      )
      .get(dev.body.id) as { method: string };
    expect(baixa.method).toBe('pix');
  });

  it('devolução em crédito não cria lançamento nem baixa — nada saiu', async () => {
    const c = await cliente('Marta Compradora');
    const p = await produtoComEstoque('Relógio', 25_000, 5);
    const v = await venda([{ productId: p, quantity: 1 }], 25_000, { customerId: c });
    const dev = await devolverEmCredito(v.body.id);

    const baixas = getConnection()
      .prepare(
        `SELECT COUNT(*) AS n FROM core_finance_settlements s
           JOIN core_finance_entries e ON e.id = s.entry_id
          WHERE e.origin_type = 'sale_return' AND e.origin_id = ?`,
      )
      .get(dev.body.id) as { n: number };
    expect(baixas.n).toBe(0);
  });
});

describe('o passivo tem soma', () => {
  it('o vale devido pela operação aparece somado, e só o saldo positivo conta', async () => {
    const c = await cliente('Marta Compradora');
    const p = await produtoComEstoque('Relógio', 25_000, 5);
    const v = await venda([{ productId: p, quantity: 1 }], 25_000, { customerId: c });
    await devolverEmCredito(v.body.id);

    const res = await request(app).get('/api/v1/core/customer-credits/liability').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.cents).toBe(25_000);
    expect(res.body.customers).toBe(1);
  });
});
