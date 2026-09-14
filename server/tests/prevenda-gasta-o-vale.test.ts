/**
 * ============================================================================
 * A CONVERSÃO DO DOCUMENTO GASTA O VALE — a costura que faltava (GAP-V10/V47)
 * ============================================================================
 *
 * ## O DEFEITO, medido antes de existir conserto
 *
 * `POST /core/sales` aceita `customerCreditCents` desde a rodada do crédito de
 * loja: o vale abate o total, vira baixa própria no financeiro e sai da razão
 * amarrado ao id da venda. `POST /core/quotes/:id/convert` NÃO aceitava — e não
 * recusava: o campo simplesmente não era lido. Quem mandasse o crédito na
 * conversão via a venda fechar pelo total CHEIO, com o saldo do cliente
 * intacto, sem erro em lugar nenhum.
 *
 * O balcão descobria isso de dois jeitos, e os dois são caros:
 *
 *   1. Pela tela, que preferiu ser honesta e RECUSAR ("Pré-venda ainda não
 *      aceita crédito de loja"). Custo: o cliente que devolveu uma peça de
 *      manhã e volta à tarde com a pré-venda aprovada ouve que o vale dele não
 *      vale hoje. A loja cobra o valor inteiro e continua devendo.
 *   2. Por qualquer outro cliente HTTP — o app, um script, a próxima tela —, e
 *      aí não há aviso nenhum: o número viaja e some.
 *
 * ## O CONSERTO, em uma frase
 *
 * A conversão passa o crédito adiante para `createSale`, que já sabe gastá-lo.
 * NÃO existe segundo caminho de resgate: a trava de concorrência
 * (`BEGIN IMMEDIATE` desde a abertura da transação da conversão), o teto do
 * total, a exigência de cliente e a amarra do `redeem` ao id da venda são
 * exatamente os mesmos de `CustomerCreditService`, porque é a mesma chamada.
 *
 * ## COMO CADA GRUPO FALHA quando o guarda sai (verificado, um por um)
 *
 *   - pare de repassar `customerCreditCents` de `convertQuote` para `createSale`
 *     e o primeiro grupo fica vermelho: a venda sai pelo total cheio e o saldo
 *     do cliente continua lá — o defeito original, de volta;
 *   - deixe a conversão aceitar um "creditCustomerId" do corpo (em vez de usar
 *     o cliente DO DOCUMENTO) e o grupo do dono do crédito acusa: o vale da
 *     Marta paga a pré-venda do João;
 *   - tire a conferência de saldo de `redeemCredit` e a conversão com saldo
 *     insuficiente passa, deixando o saldo negativo — e, pior, a pré-venda
 *     convertida com a reserva já solta;
 *   - deixe o resgate FORA da transação da conversão e a recusa por saldo
 *     insuficiente deixa de devolver a reserva: o documento fica aberto e a
 *     mercadoria, solta;
 *   - troque `quote.seller_id` por `userId` no repasse e a comissão da venda
 *     com vale nasce para quem estava no caixa (a mordida da onda 5, refeita
 *     agora pelo caminho do crédito).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { loginForTest, TEST_PASSWORD } from './helpers/auth.js';
import {
  linkUserToCompany,
  upsertUser,
} from '../src/services/auth/IdentityService.js';
import {
  createGroup,
  setMemberGroup,
  setTier,
} from '../src/services/core/CommissionService.js';

const app = createApp();

let auth: { Authorization: string };
let companyId: string;
/** A vendedora do salão — quem assina o documento e recebe a comissão. */
let vendedora: string;

beforeEach(async () => {
  resetDbForTests();
  const res = await loginForTest(app, {
    userId: 'gerente-vale',
    companyId: 'loja-do-vale',
    profileCodes: ['gerente_loja'],
  });
  auth = { Authorization: `Bearer ${res.body.accessToken}` };
  companyId = res.body.company.id;

  vendedora = await upsertUser({
    login: 'VENDEDORA_VALE',
    displayName: 'Fernanda Vendas',
    password: TEST_PASSWORD,
  });
  linkUserToCompany(vendedora, companyId, 'atendente', true);
});

async function produtoComEstoque(nome: string, preco: number, qtd: number): Promise<string> {
  const p = await request(app)
    .post('/api/v1/core/products')
    .set(auth)
    .send({ name: nome, priceCents: preco });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  await request(app).post('/api/v1/core/stock/movements').set(auth).send({
    productId: p.body.id,
    movementType: 'in',
    quantity: qtd,
    referenceType: 'entrada',
    referenceId: `carga-${p.body.id}`,
  });
  return p.body.id as string;
}

async function cliente(nome: string): Promise<string> {
  const res = await request(app).post('/api/v1/core/customers').set(auth).send({ name: nome });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

/**
 * Um cliente com vale no bolso — pela porta de sempre: venda, devolução em
 * crédito. Nada de INSERT à mão na razão: o saldo tem de nascer do fato que a
 * loja de fato registra, senão o teste prova um caminho que ninguém percorre.
 */
async function clienteComVale(nome: string, valor: number): Promise<string> {
  const c = await cliente(nome);
  const p = await produtoComEstoque(`Peça devolvida de ${nome}`, valor, 3);
  const v = await request(app)
    .post('/api/v1/core/sales')
    .set(auth)
    .send({
      idempotencyKey: randomUUID(),
      items: [{ productId: p, quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: valor }],
      customerId: c,
    });
  expect(v.status, JSON.stringify(v.body)).toBe(201);

  const devolviveis = await request(app)
    .get(`/api/v1/core/sales/${v.body.id}/returnable`)
    .set(auth);
  const dev = await request(app)
    .post('/api/v1/core/sale-returns')
    .set(auth)
    .send({
      saleId: v.body.id,
      reason: 'Vai escolher outra',
      refundMethod: 'credito',
      items: [{ saleItemId: devolviveis.body.items[0].sale_item_id, quantity: 1 }],
    });
  expect(dev.status, JSON.stringify(dev.body)).toBe(201);
  return c;
}

async function preVenda(input: {
  productId: string;
  quantity: number;
  customerId?: string | null;
  sellerId?: string | null;
  discountCents?: number;
}): Promise<{ id: string; number: number; total_cents: number }> {
  const res = await request(app)
    .post('/api/v1/core/quotes')
    .set(auth)
    .send({
      kind: 'pre_venda',
      items: [{ productId: input.productId, quantity: input.quantity }],
      customerId: input.customerId ?? null,
      sellerId: input.sellerId ?? null,
      discountCents: input.discountCents ?? 0,
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

function converter(
  quoteId: string,
  corpo: Record<string, unknown>,
  chave = randomUUID(),
) {
  return request(app)
    .post(`/api/v1/core/quotes/${quoteId}/convert`)
    .set(auth)
    .set('Idempotency-Key', chave)
    .send(corpo);
}

/** O saldo lido da razão crua — a soma, que é a única verdade do crédito. */
function saldo(customerId: string): number {
  const row = getConnection()
    .prepare(
      `SELECT COALESCE(SUM(amount_cents), 0) AS saldo FROM core_customer_credits
        WHERE company_id = ? AND customer_id = ?`,
    )
    .get(companyId, customerId) as { saldo: number };
  return Number(row.saldo);
}

function linhasDeResgate(saleId: string): { amount_cents: number; customer_id: string }[] {
  return getConnection()
    .prepare(
      `SELECT amount_cents, customer_id FROM core_customer_credits
        WHERE company_id = ? AND kind = 'redeem' AND origin_type = 'sale' AND origin_id = ?`,
    )
    .all(companyId, saleId) as never;
}

function documento(quoteId: string): { status: string; converted_sale_id: string | null } {
  return getConnection()
    .prepare('SELECT status, converted_sale_id FROM core_quotes WHERE id = ?')
    .get(quoteId) as never;
}

function reservado(productId: string): number {
  const row = getConnection()
    .prepare('SELECT reserved FROM core_stock WHERE company_id = ? AND product_id = ?')
    .get(companyId, productId) as { reserved: number } | undefined;
  return Number(row?.reserved ?? 0);
}

describe('a conversão gasta o vale', () => {
  it('a pré-venda inteira sai pelo vale, sem pagamento nenhum', async () => {
    const c = await clienteComVale('Marta Compradora', 25_000);
    const p = await produtoComEstoque('Bolsa de couro', 25_000, 5);
    const doc = await preVenda({ productId: p, quantity: 1, customerId: c });

    const conv = await converter(doc.id, { payments: [], customerCreditCents: 25_000 });
    expect(conv.status, JSON.stringify(conv.body)).toBe(201);

    // O VALE SAIU DO SALDO — e saiu UMA vez, amarrado à venda que a conversão
    // gerou. Sem o repasse, esta linha é a que fica vermelha: saldo cheio.
    expect(saldo(c)).toBe(0);
    const resgates = linhasDeResgate(conv.body.saleId);
    expect(resgates).toHaveLength(1);
    expect(resgates[0].amount_cents).toBe(-25_000);
    expect(resgates[0].customer_id).toBe(c);

    // E a ficha da venda diz quanto o vale cobriu, do jeito que a ficha do PDV
    // já dizia: positivo, porque aqui a pergunta é "quanto cobriu?".
    const ficha = await request(app).get(`/api/v1/core/sales/${conv.body.saleId}`).set(auth);
    expect(ficha.status).toBe(200);
    expect(ficha.body.customerCreditCents).toBe(25_000);
    expect(ficha.body.payments).toHaveLength(0);
    expect(ficha.body.total_cents).toBe(25_000);
  });

  it('o vale abate a parte dele e os meios cobram só o resto', async () => {
    const c = await clienteComVale('Marta Compradora', 10_000);
    const p = await produtoComEstoque('Bota', 30_000, 5);
    const doc = await preVenda({ productId: p, quantity: 1, customerId: c });

    // R$ 300,00 de pré-venda, R$ 100,00 de vale: o dinheiro cobre R$ 200,00.
    // Mandar o total cheio em dinheiro faria a venda acusar troco de R$ 100 —
    // que é exatamente a porta dos fundos que transforma vale em espécie.
    const conv = await converter(doc.id, {
      payments: [{ method: 'dinheiro', amountCents: 20_000 }],
      customerCreditCents: 10_000,
    });
    expect(conv.status, JSON.stringify(conv.body)).toBe(201);
    expect(saldo(c)).toBe(0);

    const ficha = await request(app).get(`/api/v1/core/sales/${conv.body.saleId}`).set(auth);
    expect(ficha.body.customerCreditCents).toBe(10_000);
    expect(ficha.body.change_cents).toBe(0);

    // O recebível nasce QUITADO: o vale liquidou a parte dele com método
    // próprio, e o dinheiro a outra. Sem a baixa do vale a venda ficaria em
    // aberto e alguém cobraria do cliente o que ele não deve.
    const emAberto = getConnection()
      .prepare(
        `SELECT COALESCE(SUM(amount_cents - settled_cents), 0) AS falta
           FROM core_finance_entries
          WHERE company_id = ? AND origin_type = 'sale' AND origin_id = ? AND direction = 'in'`,
      )
      .get(companyId, conv.body.saleId) as { falta: number };
    expect(emAberto.falta).toBe(0);

    const baixas = getConnection()
      .prepare(
        `SELECT s.method, s.amount_cents FROM core_finance_settlements s
           JOIN core_finance_entries e ON e.id = s.entry_id
          WHERE e.origin_type = 'sale' AND e.origin_id = ?`,
      )
      .all(conv.body.saleId) as { method: string; amount_cents: number }[];
    const doVale = baixas.filter((b) => b.method === 'credito_loja');
    expect(doVale).toHaveLength(1);
    expect(doVale[0].amount_cents).toBe(10_000);
  });

  it('a trilha registra QUEM gastou o vale na conversão', async () => {
    const c = await clienteComVale('Marta Compradora', 25_000);
    const p = await produtoComEstoque('Bolsa de couro', 25_000, 5);
    const doc = await preVenda({ productId: p, quantity: 1, customerId: c });
    const conv = await converter(doc.id, { payments: [], customerCreditCents: 25_000 });
    expect(conv.status).toBe(201);

    const linha = getConnection()
      .prepare(
        `SELECT detail FROM core_audit_log
          WHERE company_id = ? AND action = 'quote.convert' AND entity_id = ?`,
      )
      .get(companyId, doc.id) as { detail: string } | undefined;
    expect(linha).toBeTruthy();
    // A razão guarda o FATO; a trilha guarda quem o fez — que é a pergunta que
    // se faz quando um saldo some sem o cliente reconhecer a compra.
    expect(JSON.parse(linha!.detail).creditoDeLojaCents).toBe(25_000);
  });

  it('a conversão SEM vale continua exatamente como era', async () => {
    const c = await cliente('João Sem Vale');
    const p = await produtoComEstoque('Cinto', 8_000, 5);
    const doc = await preVenda({ productId: p, quantity: 1, customerId: c });

    const conv = await converter(doc.id, {
      payments: [{ method: 'dinheiro', amountCents: 8_000 }],
    });
    expect(conv.status, JSON.stringify(conv.body)).toBe(201);
    expect(linhasDeResgate(conv.body.saleId)).toHaveLength(0);

    const ficha = await request(app).get(`/api/v1/core/sales/${conv.body.saleId}`).set(auth);
    expect(ficha.body.customerCreditCents).toBe(0);
  });
});

describe('as recusas da conversão com vale', () => {
  it('saldo insuficiente recusa, e a pré-venda continua de pé com a mercadoria segurada', async () => {
    const c = await clienteComVale('Marta Compradora', 5_000);
    const p = await produtoComEstoque('Mochila', 40_000, 5);
    const doc = await preVenda({ productId: p, quantity: 1, customerId: c });
    expect(reservado(p)).toBe(1);

    const conv = await converter(doc.id, { payments: [], customerCreditCents: 40_000 });
    expect(conv.status, JSON.stringify(conv.body)).toBe(409);
    expect(conv.body.error.code).toBe('CORE_CREDIT_INSUFFICIENT');
    expect(conv.body.error.message).toMatch(/saldo/i);

    // NADA aconteceu: nem venda, nem baixa, nem resgate. E a reserva — que a
    // conversão solta ANTES de criar a venda — voltou ao lugar com o rollback.
    // Sem isso a peça ficaria solta na prateleira com o documento ainda aberto
    // prometendo-a a este cliente.
    expect(saldo(c)).toBe(5_000);
    expect(documento(doc.id).status).toBe('aberto');
    expect(reservado(p)).toBe(1);
    const vendas = getConnection()
      .prepare('SELECT COUNT(*) AS n FROM core_sales WHERE company_id = ?')
      .get(companyId) as { n: number };
    // A única venda da empresa é a que gerou o vale (em `clienteComVale`).
    expect(vendas.n).toBe(1);
  });

  it('o vale é do CLIENTE DO DOCUMENTO — o de outra pessoa não paga esta pré-venda', async () => {
    const marta = await clienteComVale('Marta Compradora', 25_000);
    const joao = await cliente('João Sem Vale');
    const p = await produtoComEstoque('Bolsa de couro', 25_000, 5);
    // O documento é do João. O saldo é da Marta.
    const doc = await preVenda({ productId: p, quantity: 1, customerId: joao });

    const conv = await converter(doc.id, {
      payments: [],
      customerCreditCents: 25_000,
      // O corpo TENTA apontar o dono do saldo. A conversão não lê dono nenhum
      // do corpo: de quem é o vale já está dito pelo documento.
      customerId: marta,
      creditCustomerId: marta,
    });

    expect(conv.status, JSON.stringify(conv.body)).toBe(409);
    expect(conv.body.error.code).toBe('CORE_CREDIT_INSUFFICIENT');
    // O saldo da Marta não foi tocado — e é esta linha que fica vermelha no dia
    // em que alguém aceitar o dono do crédito pelo corpo da requisição.
    expect(saldo(marta)).toBe(25_000);
    expect(saldo(joao)).toBe(0);
    expect(documento(doc.id).status).toBe('aberto');
  });

  it('documento sem cliente não gasta vale nenhum, e a recusa manda identificar', async () => {
    const p = await produtoComEstoque('Boné', 5_000, 5);
    const doc = await preVenda({ productId: p, quantity: 1, customerId: null });

    const conv = await converter(doc.id, { payments: [], customerCreditCents: 5_000 });
    expect(conv.status, JSON.stringify(conv.body)).toBe(400);
    expect(conv.body.error.code).toBe('CORE_CREDIT_CUSTOMER_REQUIRED');
    expect(conv.body.error.message).toMatch(/cliente/i);
    expect(documento(doc.id).status).toBe('aberto');
  });

  it('vale acima do total da pré-venda é recusado — crédito não vira troco', async () => {
    const c = await clienteComVale('Marta Compradora', 25_000);
    const p = await produtoComEstoque('Carteira', 9_000, 5);
    const doc = await preVenda({ productId: p, quantity: 1, customerId: c });

    const conv = await converter(doc.id, { payments: [], customerCreditCents: 25_000 });
    expect(conv.status, JSON.stringify(conv.body)).toBe(400);
    expect(conv.body.error.code).toBe('CORE_CREDIT_EXCEEDS_TOTAL');
    expect(saldo(c)).toBe(25_000);
  });

  it('converter de novo NÃO gasta o vale duas vezes', async () => {
    const c = await clienteComVale('Marta Compradora', 25_000);
    const p = await produtoComEstoque('Bolsa de couro', 25_000, 5);
    const doc = await preVenda({ productId: p, quantity: 1, customerId: c });

    const primeira = await converter(doc.id, { payments: [], customerCreditCents: 25_000 });
    expect(primeira.status).toBe(201);
    expect(saldo(c)).toBe(0);

    // Segunda tentativa, chave NOVA (o reenvio de rede manda a mesma; este é o
    // clique repetido, que é o caso perigoso): o documento já está convertido e
    // a recusa vem antes de qualquer escrita.
    const segunda = await converter(doc.id, { payments: [], customerCreditCents: 25_000 });
    expect(segunda.status).toBe(409);
    expect(segunda.body.error.code).toBe('CORE_QUOTE_ALREADY_CONVERTED');

    expect(saldo(c)).toBe(0);
    expect(
      getConnection()
        .prepare(
          `SELECT COUNT(*) AS n FROM core_customer_credits
            WHERE company_id = ? AND kind = 'redeem'`,
        )
        .get(companyId) as { n: number },
    ).toEqual({ n: 1 });
  });

  it('cancelar a venda convertida devolve o vale ao cliente', async () => {
    const c = await clienteComVale('Marta Compradora', 25_000);
    const p = await produtoComEstoque('Bolsa de couro', 25_000, 5);
    const doc = await preVenda({ productId: p, quantity: 1, customerId: c });
    const conv = await converter(doc.id, { payments: [], customerCreditCents: 25_000 });
    expect(saldo(c)).toBe(0);

    const cancel = await request(app)
      .post(`/api/v1/core/sales/${conv.body.saleId}/cancel`)
      .set(auth)
      .send({ reason: 'Cliente desistiu' });
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);

    // O ciclo do vale fecha pelo caminho da conversão igual ao do PDV: venda
    // anulada é venda que não aconteceu, e o cliente não pode perder o vale com
    // que pagou uma compra que o sistema afirma nunca ter existido.
    expect(saldo(c)).toBe(25_000);
  });
});

describe('o documento sobrevive ao caminho do crédito', () => {
  it('o vendedor, o desconto e a comissão continuam os do documento', async () => {
    const grupo = createGroup(companyId, 'Salão').id;
    setTier(companyId, grupo, 0, 200); // 2% a partir de zero
    setMemberGroup(companyId, vendedora, grupo);

    const c = await clienteComVale('Marta Compradora', 10_000);
    const p = await produtoComEstoque('Vestido longo', 50_000, 5);
    // R$ 500,00 com R$ 50,00 de desconto de rodapé = R$ 450,00 a pagar.
    const doc = await preVenda({
      productId: p,
      quantity: 1,
      customerId: c,
      sellerId: vendedora,
      discountCents: 5_000,
    });
    expect(doc.total_cents).toBe(45_000);

    const conv = await converter(doc.id, {
      payments: [{ method: 'dinheiro', amountCents: 35_000 }],
      customerCreditCents: 10_000,
    });
    expect(conv.status, JSON.stringify(conv.body)).toBe(201);

    const venda = getConnection()
      .prepare(
        'SELECT seller_id, discount_cents, subtotal_cents, total_cents FROM core_sales WHERE id = ?',
      )
      .get(conv.body.saleId) as {
      seller_id: string;
      discount_cents: number;
      subtotal_cents: number;
      total_cents: number;
    };
    // O VENDEDOR É O DO DOCUMENTO, e não quem estava no caixa faturando. É a
    // mordida da onda 5 refeita pelo caminho do vale: `sellerId ?? userId`
    // faria a comissão da vendedora do salão nascer para o operador.
    expect(venda.seller_id).toBe(vendedora);
    expect(venda.discount_cents).toBe(5_000);
    expect(venda.total_cents).toBe(45_000);

    // A COMISSÃO SAI SOBRE O QUE A LOJA VENDEU, e o vale não a reduz: a loja
    // entregou mercadoria de R$ 450,00 e se livrou de uma dívida do mesmo
    // tamanho. Base = subtotal - desconto = R$ 450,00; 2% = R$ 9,00.
    const comissao = getConnection()
      .prepare(
        `SELECT seller_id, base_cents, amount_cents FROM core_commission_entries
          WHERE sale_id = ?`,
      )
      .all(conv.body.saleId) as { seller_id: string; base_cents: number; amount_cents: number }[];
    expect(comissao).toHaveLength(1);
    expect(comissao[0].seller_id).toBe(vendedora);
    expect(comissao[0].base_cents).toBe(45_000);
    expect(comissao[0].amount_cents).toBe(900);
  });
});
