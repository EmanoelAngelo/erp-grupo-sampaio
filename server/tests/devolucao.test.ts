/**
 * Devolução de venda.
 *
 * A regra que este arquivo protege: A VENDA NÃO MUDA.
 *
 * Cancelar desfaz a venda — mesmo dia, antes de o dinheiro assentar. Devolver
 * é outro fato: o cliente comprou, levou, e voltou depois com parte da
 * mercadoria. A venda está no fechamento do mês e na comissão já paga;
 * reescrevê-la faria o relatório de ontem dizer outra coisa hoje.
 *
 * O segundo cuidado é o estoque: peça com defeito NÃO volta para o saldo
 * vendável. Somar mercadoria quebrada cria estoque que não existe, e a falta
 * só aparece quando alguém for vender e não achar.
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
let companyId: string;

beforeEach(async () => {
  resetDbForTests();
  const res = await loginForTest(app, {
    userId: 'gerente-dev',
    companyId: 'loja-devolucao',
    profileCodes: ['gerente_loja'],
  });
  auth = { Authorization: `Bearer ${res.body.accessToken}` };
  companyId = res.body.company.id;
});

async function produtoComEstoque(nome: string, preco: number, qtd: number) {
  const p = await request(app)
    .post('/api/v1/core/products')
    .set(auth)
    .send({ name: nome, priceCents: preco });
  await request(app).post('/api/v1/core/stock/movements').set(auth).send({
    productId: p.body.id,
    movementType: 'in',
    quantity: qtd,
    referenceType: 'entrada',
    referenceId: `carga-${p.body.id}`,
  });
  return p.body.id as string;
}

/**
 * A venda do balcão. `customerId` é opcional porque a maioria das vendas daqui
 * é anônima mesmo — só a devolução em CRÉDITO exige dono do vale.
 */
async function venda(
  items: { productId: string; quantity: number }[],
  total: number,
  customerId?: string,
) {
  const res = await request(app)
    .post('/api/v1/core/sales')
    .set(auth)
    .send({
      idempotencyKey: randomUUID(),
      items,
      payments: [{ method: 'dinheiro', amountCents: total }],
      customerId: customerId ?? null,
    });
  expect(res.status).toBe(201);
  return res.body.sale ?? res.body;
}

function saldo(productId: string): number {
  const row = getConnection()
    .prepare('SELECT quantity FROM core_stock WHERE company_id = ? AND product_id = ?')
    .get(companyId, productId) as { quantity: number } | undefined;
  return row?.quantity ?? 0;
}

async function itensDevolviveis(saleId: string) {
  const res = await request(app).get(`/api/v1/core/sales/${saleId}/returnable`).set(auth);
  return res.body.items as {
    sale_item_id: string;
    quantity: number;
    returned_quantity: number;
    total_cents: number;
  }[];
}

describe('a venda não muda', () => {
  it('devolver não altera a venda nem o lançamento original', async () => {
    const p = await produtoComEstoque('Camisa', 10000, 10);
    const v = await venda([{ productId: p, quantity: 2 }], 20000);

    const antes = await request(app).get(`/api/v1/core/sales/${v.id}`).set(auth);
    const itens = await itensDevolviveis(v.id);

    await request(app)
      .post('/api/v1/core/sale-returns')
      .set(auth)
      .send({
        saleId: v.id,
        reason: 'Cliente não gostou',
        items: [{ saleItemId: itens[0].sale_item_id, quantity: 1 }],
      });

    const depois = await request(app).get(`/api/v1/core/sales/${v.id}`).set(auth);
    // A venda continua valendo o que valeu: é ela que está no fechamento do mês.
    expect(depois.body.status).toBe(antes.body.status);
    expect(depois.body.total_cents).toBe(antes.body.total_cents);

    // E o lançamento da venda continua de pé, com o valor cheio.
    const entrada = getConnection()
      .prepare(
        "SELECT amount_cents, status FROM core_finance_entries WHERE origin_type = 'sale' AND origin_id = ?",
      )
      .get(v.id) as { amount_cents: number; status: string };
    expect(entrada.status).not.toBe('cancelled');
    expect(entrada.amount_cents).toBe(20000);
  });

  it('a devolução é lançamento próprio, na direção contrária', async () => {
    const p = await produtoComEstoque('Calça', 15000, 5);
    const v = await venda([{ productId: p, quantity: 2 }], 30000);
    const itens = await itensDevolviveis(v.id);

    const res = await request(app)
      .post('/api/v1/core/sale-returns')
      .set(auth)
      .send({
        saleId: v.id,
        reason: 'Tamanho errado',
        items: [{ saleItemId: itens[0].sale_item_id, quantity: 1 }],
      });

    const saida = getConnection()
      .prepare(
        "SELECT direction, amount_cents FROM core_finance_entries WHERE origin_type = 'sale_return' AND origin_id = ?",
      )
      .get(res.body.id) as { direction: string; amount_cents: number };
    expect(saida.direction).toBe('out');
    expect(saida.amount_cents).toBe(15000);
  });
});

describe('não se devolve mais do que se vendeu', () => {
  it('recusa quantidade maior que a vendida', async () => {
    const p = await produtoComEstoque('Boné', 5000, 10);
    const v = await venda([{ productId: p, quantity: 2 }], 10000);
    const itens = await itensDevolviveis(v.id);

    const res = await request(app)
      .post('/api/v1/core/sale-returns')
      .set(auth)
      .send({
        saleId: v.id,
        reason: 'Quer devolver mais do que levou',
        items: [{ saleItemId: itens[0].sale_item_id, quantity: 3 }],
      });
    expect(res.status).toBe(409);
  });

  it('soma as devoluções anteriores — duas parciais não viram o dobro', async () => {
    const p = await produtoComEstoque('Meia', 2000, 20);
    const v = await venda([{ productId: p, quantity: 3 }], 6000);
    const itens = await itensDevolviveis(v.id);
    const item = itens[0].sale_item_id;

    await request(app)
      .post('/api/v1/core/sale-returns')
      .set(auth)
      .send({ saleId: v.id, reason: 'Primeira parcial', items: [{ saleItemId: item, quantity: 2 }] });

    // Sobrou 1. Pedir 2 na segunda vez tem de ser recusado.
    const segunda = await request(app)
      .post('/api/v1/core/sale-returns')
      .set(auth)
      .send({ saleId: v.id, reason: 'Segunda parcial', items: [{ saleItemId: item, quantity: 2 }] });
    expect(segunda.status).toBe(409);

    const terceira = await request(app)
      .post('/api/v1/core/sale-returns')
      .set(auth)
      .send({ saleId: v.id, reason: 'Resto', items: [{ saleItemId: item, quantity: 1 }] });
    expect(terceira.status).toBe(201);
  });

  it('a consulta mostra o que já voltou', async () => {
    const p = await produtoComEstoque('Cinto', 8000, 10);
    const v = await venda([{ productId: p, quantity: 4 }], 32000);
    const itens = await itensDevolviveis(v.id);

    await request(app)
      .post('/api/v1/core/sale-returns')
      .set(auth)
      .send({
        saleId: v.id,
        reason: 'Parcial',
        items: [{ saleItemId: itens[0].sale_item_id, quantity: 1 }],
      });

    const depois = await itensDevolviveis(v.id);
    expect(depois[0].returned_quantity).toBe(1);
    expect(depois[0].quantity).toBe(4);
  });

  it('item de outra venda é recusado', async () => {
    const p = await produtoComEstoque('Bermuda', 7000, 10);
    const v1 = await venda([{ productId: p, quantity: 1 }], 7000);
    const v2 = await venda([{ productId: p, quantity: 1 }], 7000);
    const itensV2 = await itensDevolviveis(v2.id);

    // Deixar passar devolveria mercadoria que ESTE cliente nunca levou, com
    // dinheiro saindo do caixa por isso.
    const res = await request(app)
      .post('/api/v1/core/sale-returns')
      .set(auth)
      .send({
        saleId: v1.id,
        reason: 'Item de outra venda',
        items: [{ saleItemId: itensV2[0].sale_item_id, quantity: 1 }],
      });
    expect(res.status).toBe(404);
  });
});

describe('estoque', () => {
  it('mercadoria boa volta para o saldo', async () => {
    const p = await produtoComEstoque('Jaqueta', 20000, 10);
    const v = await venda([{ productId: p, quantity: 3 }], 60000);
    const depoisDaVenda = saldo(p);
    const itens = await itensDevolviveis(v.id);

    await request(app)
      .post('/api/v1/core/sale-returns')
      .set(auth)
      .send({
        saleId: v.id,
        reason: 'Arrependimento',
        items: [{ saleItemId: itens[0].sale_item_id, quantity: 2, restock: true }],
      });

    expect(saldo(p)).toBe(depoisDaVenda + 2);
  });

  it('mercadoria com defeito NÃO volta — estoque fantasma é pior que falta', async () => {
    const p = await produtoComEstoque('Tênis', 30000, 10);
    const v = await venda([{ productId: p, quantity: 2 }], 60000);
    const depoisDaVenda = saldo(p);
    const itens = await itensDevolviveis(v.id);

    const res = await request(app)
      .post('/api/v1/core/sale-returns')
      .set(auth)
      .send({
        saleId: v.id,
        reason: 'Solado descolando',
        items: [{ saleItemId: itens[0].sale_item_id, quantity: 1, restock: false }],
      });

    expect(res.status).toBe(201);
    // O dinheiro voltou para o cliente, mas a peça não entrou no vendável.
    expect(saldo(p)).toBe(depoisDaVenda);
    expect(res.body.total_cents).toBe(30000);
  });

  it('o movimento é registrado como devolução, não como entrada genérica', async () => {
    const p = await produtoComEstoque('Mochila', 12000, 10);
    const v = await venda([{ productId: p, quantity: 1 }], 12000);
    const itens = await itensDevolviveis(v.id);

    const res = await request(app)
      .post('/api/v1/core/sale-returns')
      .set(auth)
      .send({
        saleId: v.id,
        reason: 'Devolveu',
        items: [{ saleItemId: itens[0].sale_item_id, quantity: 1 }],
      });

    const mov = getConnection()
      .prepare(
        "SELECT kind FROM core_stock_movements WHERE reference_type = 'sale_return' AND reference_id = ?",
      )
      .get(res.body.id) as { kind: string };
    // Auditoria de estoque só conta a história certa se o tipo disser o que foi.
    expect(mov.kind).toBe('SALE_RETURN');
  });
});

describe('quanto volta de dinheiro', () => {
  it('devolve o preço PRATICADO, não o do cadastro hoje', async () => {
    const p = await produtoComEstoque('Camiseta', 10000, 10);
    const v = await venda([{ productId: p, quantity: 1 }], 10000);

    // O preço sobe depois da venda.
    await request(app).patch(`/api/v1/core/products/${p}`).set(auth).send({ priceCents: 18000 });

    const itens = await itensDevolviveis(v.id);
    const res = await request(app)
      .post('/api/v1/core/sale-returns')
      .set(auth)
      .send({
        saleId: v.id,
        reason: 'Devolução após aumento',
        items: [{ saleItemId: itens[0].sale_item_id, quantity: 1 }],
      });

    // Devolver 180 por uma peça vendida a 100 seria dinheiro real a mais.
    expect(res.body.total_cents).toBe(10000);
  });

  it('devolução parcial é proporcional à linha', async () => {
    const p = await produtoComEstoque('Bolsa', 9000, 10);
    const v = await venda([{ productId: p, quantity: 3 }], 27000);
    const itens = await itensDevolviveis(v.id);

    const res = await request(app)
      .post('/api/v1/core/sale-returns')
      .set(auth)
      .send({
        saleId: v.id,
        reason: 'Devolveu uma',
        items: [{ saleItemId: itens[0].sale_item_id, quantity: 1 }],
      });
    expect(res.body.total_cents).toBe(9000);
  });

  /*
    O CRÉDITO PASSOU A EXIGIR DONO — e este caso foi ajustado por causa disso
    (GAP-V10/V47).

    Ele nasceu com a venda ANÔNIMA, e passava: "crédito na loja" era só um
    rótulo gravado na devolução, sem saldo em lugar nenhum. Agora ele vira vale
    de verdade, e vale sem dono é dinheiro que a loja deve a ninguém — nenhum
    extrato o mostra, nenhuma venda o consome. A venda deste caso ganhou
    cliente; a REGRA sob teste continua a mesma e é a que importa aqui: crédito
    não tira dinheiro do caixa agora.

    A recusa da venda anônima tem caso próprio em `credito-de-loja.test.ts`.
  */
  it('crédito na loja não tira dinheiro do caixa agora', async () => {
    const cliente = await request(app)
      .post('/api/v1/core/customers')
      .set(auth)
      .send({ name: 'Dona do vale' });
    const p = await produtoComEstoque('Relógio', 25000, 10);
    const v = await venda([{ productId: p, quantity: 1 }], 25000, cliente.body.id);
    const itens = await itensDevolviveis(v.id);

    const res = await request(app)
      .post('/api/v1/core/sale-returns')
      .set(auth)
      .send({
        saleId: v.id,
        reason: 'Vai escolher outro',
        refundMethod: 'credito',
        items: [{ saleItemId: itens[0].sale_item_id, quantity: 1 }],
      });
    expect(res.status).toBe(201);

    // Crédito vira saldo do cliente; o dinheiro só se move quando ele usar.
    // Lançar saída agora contaria a mesma devolução duas vezes.
    const saida = getConnection()
      .prepare(
        "SELECT COUNT(*) AS n FROM core_finance_entries WHERE origin_type = 'sale_return' AND origin_id = ?",
      )
      .get(res.body.id) as { n: number };
    expect(saida.n).toBe(0);
    expect(res.body.refund_method).toBe('credito');

    // E o vale EXISTE, que é a metade que faltava do ciclo: até esta rodada o
    // rótulo era gravado e o saldo do cliente vivia no papel do balcão.
    const saldo = getConnection()
      .prepare(
        `SELECT COALESCE(SUM(amount_cents), 0) AS saldo FROM core_customer_credits
          WHERE company_id = ? AND customer_id = ?`,
      )
      .get(companyId, cliente.body.id) as { saldo: number };
    expect(saldo.saldo).toBe(25000);
  });
});

describe('recusas', () => {
  it('venda cancelada não admite devolução', async () => {
    const p = await produtoComEstoque('Óculos', 15000, 10);
    const v = await venda([{ productId: p, quantity: 1 }], 15000);
    await request(app)
      .post(`/api/v1/core/sales/${v.id}/cancel`)
      .set(auth)
      .send({ reason: 'erro de digitação' });

    const itens = await itensDevolviveis(v.id);
    const res = await request(app)
      .post('/api/v1/core/sale-returns')
      .set(auth)
      .send({
        saleId: v.id,
        reason: 'tentando devolver o que já foi cancelado',
        items: [{ saleItemId: itens[0].sale_item_id, quantity: 1 }],
      });

    // O cancelamento já repôs o estoque; aceitar aqui reporia de novo.
    expect(res.status).toBe(409);
  });

  it('devolução sem motivo é recusada', async () => {
    const p = await produtoComEstoque('Chinelo', 3000, 10);
    const v = await venda([{ productId: p, quantity: 1 }], 3000);
    const itens = await itensDevolviveis(v.id);

    const res = await request(app)
      .post('/api/v1/core/sale-returns')
      .set(auth)
      .send({ saleId: v.id, reason: '', items: [{ saleItemId: itens[0].sale_item_id, quantity: 1 }] });
    expect(res.status).toBe(400);
  });

  it('devolução sem item é recusada', async () => {
    const p = await produtoComEstoque('Toalha', 4000, 10);
    const v = await venda([{ productId: p, quantity: 1 }], 4000);

    const res = await request(app)
      .post('/api/v1/core/sale-returns')
      .set(auth)
      .send({ saleId: v.id, reason: 'sem itens', items: [] });
    expect(res.status).toBe(400);
  });

  it('venda de outra operação não é acessível', async () => {
    const p = await produtoComEstoque('Guarda-chuva', 6000, 10);
    const v = await venda([{ productId: p, quantity: 1 }], 6000);

    const outra = await loginForTest(app, {
      userId: 'gerente-vizinha',
      companyId: 'loja-vizinha-dev',
      profileCodes: ['gerente_loja'],
    });
    const res = await request(app)
      .get(`/api/v1/core/sales/${v.id}/returnable`)
      .set({ Authorization: `Bearer ${outra.body.accessToken}` });
    expect(res.status).toBe(404);
  });
});

/** O caminho do cancelamento, num lugar só — é ele que os três casos exercem. */
function rotaDeCancelar(saleId: string): string {
  return `/api/v1/core/sales/${saleId}/cancel`;
}

describe('cancelar depois de devolver nao devolve duas vezes', () => {
  /**
   * O CENARIO MEDIDO, e ele so aparece quando os dois desfazimentos se cruzam.
   *
   * Cancelar lia as SAIDAS da venda e devolvia tudo. Devolver ja tinha
   * devolvido parte. Cada um dos dois movimentos esta certo isolado, e juntos
   * a prateleira ganha mais do que saiu: vender 5, devolver 2 e cancelar
   * creditava os 5 inteiros de novo — 7 de volta para 5 que sairam.
   *
   * Nada acusava, porque o saldo nunca fica negativo e ninguem confere o
   * total contra a soma dos documentos.
   */
  it('vender 5, devolver 2 e cancelar deixa o saldo como comecou', async () => {
    const p = await produtoComEstoque('Camisa', 10000, 10);
    expect(saldo(p)).toBe(10);

    const v = await venda([{ productId: p, quantity: 5 }], 50000);
    expect(saldo(p)).toBe(5);

    const itens = await itensDevolviveis(v.id);
    const dev = await request(app)
      .post('/api/v1/core/sale-returns')
      .set(auth)
      .send({ saleId: v.id, reason: 'Duas nao serviram', items: [{ saleItemId: itens[0].sale_item_id, quantity: 2 }] });
    expect(dev.status).toBeLessThan(300);
    expect(saldo(p)).toBe(7);

    const cancelou = await request(app)
      .post(rotaDeCancelar(v.id))
      .set(auth)
      .send({ reason: 'Cliente desistiu do resto' });
    expect(cancelou.status).toBeLessThan(300);

    // As tres que ainda estavam com o cliente voltam. As duas que ja tinham
    // voltado NAO voltam de novo.
    expect(saldo(p)).toBe(10);
  });

  it('devolver TUDO e depois cancelar nao mexe no estoque', async () => {
    const p = await produtoComEstoque('Bone', 5000, 4);
    const v = await venda([{ productId: p, quantity: 4 }], 20000);
    const itens = await itensDevolviveis(v.id);
    await request(app)
      .post('/api/v1/core/sale-returns')
      .set(auth)
      .send({ saleId: v.id, reason: 'Devolveu tudo', items: [{ saleItemId: itens[0].sale_item_id, quantity: 4 }] });
    expect(saldo(p)).toBe(4);

    // Nada sobrou para estornar: o cancelamento nao pode inventar entrada.
    const cancelou = await request(app)
      .post(rotaDeCancelar(v.id))
      .set(auth)
      .send({ reason: 'Formalizar o cancelamento' });
    expect(cancelou.status).toBeLessThan(300);
    expect(saldo(p)).toBe(4);
  });

  it('sem devolucao no meio, cancelar continua devolvendo tudo', async () => {
    const p = await produtoComEstoque('Meia', 2000, 6);
    const v = await venda([{ productId: p, quantity: 6 }], 12000);
    expect(saldo(p)).toBe(0);
    await request(app).post(rotaDeCancelar(v.id)).set(auth).send({ reason: 'Erro de digitacao' });
    expect(saldo(p)).toBe(6);
  });
});

/*
  ================================================================
  O MESMO PRODUTO EM DUAS LINHAS DA DEVOLUÇÃO — e aqui sai DINHEIRO
  ================================================================

  A venda registra o mesmo produto em duas linhas sempre que o operador o bipa
  duas vezes, e o sistema já lida com isso na SAÍDA: as baixas são somadas por
  produto. A devolução é montada a partir dessas linhas, então herda as duas.

  Aplicar um movimento POR LINHA produzia duas chamadas com a MESMA chave de
  idempotência — `applyMovement` distingue por (empresa, referência, id da
  referência, produto, tipo), e aqui a referência é a DEVOLUÇÃO. A segunda
  voltava como repetida e a quantidade dela era descartada.

  O que torna este caso pior que o da entrada de nota: O DINHEIRO JÁ SAIU. O
  total é calculado sobre as duas linhas e devolvido ao cliente; só o estoque
  ficava com uma. A loja pagava por mercadoria que nunca voltou ao saldo, uma
  vez por devolução, sem erro em lugar nenhum.
*/
describe('devolução com o mesmo produto em duas linhas', () => {
  it('o estoque volta com a SOMA das duas, e não com uma', async () => {
    const p = await produtoComEstoque('Camiseta', 5000, 10);
    // Duas linhas do MESMO produto, como o PDV grava quando se bipa duas vezes.
    const v = await venda(
      [
        { productId: p, quantity: 2 },
        { productId: p, quantity: 3 },
      ],
      25000,
    );

    // Saiu 5 dos 10.
    expect(saldo(p)).toBe(5);

    const itens = await itensDevolviveis(v.id);
    expect(itens).toHaveLength(2);

    const res = await request(app)
      .post('/api/v1/core/sale-returns')
      .set(auth)
      .send({
        saleId: v.id,
        reason: 'Cliente desistiu',
        items: [
          { saleItemId: itens[0].sale_item_id, quantity: 2 },
          { saleItemId: itens[1].sale_item_id, quantity: 3 },
        ],
      });
    expect(res.status).toBe(201);

    // 5 + 5. Sem o agrupamento, a segunda linha some e o saldo para em 7.
    expect(saldo(p)).toBe(10);
  });

  /*
    A PROVA DE QUE O PREJUÍZO ERA REAL: o valor devolvido conta as duas linhas.
    Se o estoque só recebe uma, a diferença é dinheiro que saiu por mercadoria
    que não voltou.
  */
  it('e o valor devolvido corresponde às duas linhas', async () => {
    const p = await produtoComEstoque('Camiseta', 5000, 10);
    const v = await venda(
      [
        { productId: p, quantity: 2 },
        { productId: p, quantity: 3 },
      ],
      25000,
    );
    const itens = await itensDevolviveis(v.id);

    const res = await request(app)
      .post('/api/v1/core/sale-returns')
      .set(auth)
      .send({
        saleId: v.id,
        reason: 'Cliente desistiu',
        items: [
          { saleItemId: itens[0].sale_item_id, quantity: 2 },
          { saleItemId: itens[1].sale_item_id, quantity: 3 },
        ],
      });

    expect(res.body.total_cents).toBe(25000);
    // O saldo tem de acompanhar o que foi pago de volta.
    expect(saldo(p)).toBe(10);
  });

  it('o razão registra UM movimento de devolução para o produto, com a soma', async () => {
    const p = await produtoComEstoque('Camiseta', 5000, 10);
    const v = await venda(
      [
        { productId: p, quantity: 2 },
        { productId: p, quantity: 3 },
      ],
      25000,
    );
    const itens = await itensDevolviveis(v.id);

    await request(app)
      .post('/api/v1/core/sale-returns')
      .set(auth)
      .send({
        saleId: v.id,
        reason: 'Cliente desistiu',
        items: [
          { saleItemId: itens[0].sale_item_id, quantity: 2 },
          { saleItemId: itens[1].sale_item_id, quantity: 3 },
        ],
      });

    const movs = getConnection()
      .prepare(
        `SELECT quantity FROM core_stock_movements
          WHERE reference_type = 'sale_return' AND product_id = ?`,
      )
      .all(p) as { quantity: number }[];

    expect(movs).toHaveLength(1);
    expect(Math.abs(movs[0].quantity)).toBe(5);
  });
});
