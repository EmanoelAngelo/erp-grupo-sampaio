/**
 * ============================================================================
 * O DINHEIRO ELETRÔNICO QUE FICAVA SEM DONO (GAP-PRD-078, GAP-PRD-080, GAP-PRD-081)
 * ============================================================================
 *
 * ## GAP-PRD-078 — PIX abandonado na tela e pago depois
 *
 * "Desistir desta cobrança" só limpava a tela, e `/pdv/terminal/uncertain`
 * mostrava só o não confirmado. O PIX que o cliente pagava depois do
 * "desistir" virava cobrança aprovada SEM VENDA, fora de qualquer fila — e o
 * PIX que PAGAVA uma venda nunca era carimbado nela (só o cartão era), então
 * nem dava para separar um do outro.
 *
 * ## GAP-PRD-080 — cancelar/devolver venda paga no cartão integrado
 *
 * `cancelSale` e a devolução `estorno_cartao` não tocavam a cobrança da
 * maquininha: ela continuava `authorized`, amarrada a uma venda cancelada, sem
 * estorno pedido nem rastro de "estorno a fazer".
 *
 * ## GAP-PRD-081 — fechar o turno com dinheiro eletrônico indefinido
 *
 * `closeSession` fechava em silêncio com cobrança não confirmada, cobrança em
 * andamento, cobrança aprovada sem venda ou PIX pendente numa venda do turno.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { findOneRow, findRows, insertRow, resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { getConnection } from '../src/db/sqlite.js';
import { createPaymentTerminalConfigurationBackend } from '../src/services/payment-terminal/PaymentTerminalService.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();
const LOJA = 'loja-pendencias-eletronicas';
const VIZINHA = 'loja-pendencias-vizinha';

type Auth = { Authorization: string };
let gerente: Auth;
let operador: Auth;
let outroOperador: Auth;
let configId: string;

async function entrar(empresa: string, userId: string, perfil: string): Promise<Auth> {
  const res = await loginForTest(app, { userId, companyId: empresa, profileCodes: [perfil] });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { Authorization: `Bearer ${res.body.accessToken as string}` };
}

type Linha = Record<string, unknown>;

function tx(id: string): Linha {
  return findOneRow<Linha>('payment_terminal_transactions', (r) => r.id === id)!;
}

function auditoria(acao: string): { detail: string }[] {
  return getConnection()
    .prepare('SELECT detail FROM core_audit_log WHERE company_id = ? AND action = ?')
    .all(LOJA, acao) as unknown as { detail: string }[];
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  gerente = await entrar(LOJA, 'gerente-pend', 'gerente_loja');
  operador = await entrar(LOJA, 'caixa-pend', 'operador_caixa_loja');
  outroOperador = await entrar(LOJA, 'caixa-pend-2', 'operador_caixa_loja');
  const cfg = createPaymentTerminalConfigurationBackend({
    companyId: LOJA,
    provider: 'mock',
    active: true,
    name: 'Maquininha do balcão',
  }) as Linha;
  configId = String(cfg.id);
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

async function cobrar(auth: Auth, corpo: Record<string, unknown>) {
  const res = await request(app)
    .post('/api/v1/core/pdv/terminal/charge')
    .set(auth)
    .set('Idempotency-Key', randomUUID())
    .send(corpo);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as { transactionId: string; state: string; settled: boolean };
}

function vender(auth: Auth, corpo: Record<string, unknown>) {
  return request(app)
    .post('/api/v1/core/sales')
    .set(auth)
    .set('Idempotency-Key', randomUUID())
    .send(corpo);
}

async function abrirCaixa(auth: Auth, corpo: Record<string, unknown> = {}): Promise<string> {
  const res = await request(app).post('/api/v1/core/cash/open').set(auth).send({ openingCents: 0, ...corpo });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

async function pendencias(auth: Auth, minutos = 0) {
  const res = await request(app).get(`/api/v1/core/pdv/terminal/pendencias?minutos=${minutos}`).set(auth);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as {
    semVenda: { transactionId: string; state: string; amountInCents: number }[];
    aEstornar: { transactionId: string; aEstornarCents: number; saleId: string | null }[];
  };
}

// ============================================================================
describe('GAP-PRD-078 — PIX abandonado vira pendência conciliável', () => {
  it('PIX deixado na tela aparece em "cobranças sem venda" — e continua lá depois de pago', async () => {
    const pix = await cobrar(operador, { method: 'pix', amountInCents: 5000 });
    expect(pix.settled).toBe(false);

    let fila = await pendencias(gerente);
    expect(fila.semVenda.map((i) => i.transactionId)).toContain(pix.transactionId);
    expect(fila.semVenda.find((i) => i.transactionId === pix.transactionId)?.state).toBe('processando');

    // O cliente pagou DEPOIS de o operador desistir da tela.
    const confirmado = await request(app)
      .post(`/api/v1/core/pdv/terminal/${pix.transactionId}/confirmar-teste`)
      .set(operador);
    expect(confirmado.status).toBe(200);

    fila = await pendencias(gerente);
    const item = fila.semVenda.find((i) => i.transactionId === pix.transactionId);
    expect(item?.state).toBe('aprovado');
    expect(item?.amountInCents).toBe(5000);
  });

  it('a fila respeita o prazo: cobrança de agora não entra com o padrão de minutos', async () => {
    const pix = await cobrar(operador, { method: 'pix', amountInCents: 5000 });
    const res = await request(app).get('/api/v1/core/pdv/terminal/pendencias').set(gerente);
    expect(res.status).toBe(200);
    expect(res.body.minutos).toBeGreaterThan(0);
    expect(res.body.semVenda.map((i: { transactionId: string }) => i.transactionId)).not.toContain(pix.transactionId);
  });

  it('a fila é do gestor: o caixa não lista', async () => {
    const res = await request(app).get('/api/v1/core/pdv/terminal/pendencias?minutos=0').set(operador);
    expect(res.status).toBe(403);
  });

  it('o PIX que PAGA a venda é carimbado nela e sai da fila', async () => {
    const p = await produto(gerente);
    const pix = await cobrar(operador, { method: 'pix', amountInCents: 5000 });
    await request(app).post(`/api/v1/core/pdv/terminal/${pix.transactionId}/confirmar-teste`).set(operador);

    const venda = await vender(operador, {
      items: [{ productId: p, quantity: 1 }],
      payments: [{ method: 'pix', amountCents: 5000, providerRef: pix.transactionId }],
    });
    expect(venda.status, JSON.stringify(venda.body)).toBe(201);
    expect(tx(pix.transactionId).saleId).toBe(venda.body.id);

    const fila = await pendencias(gerente);
    expect(fila.semVenda.map((i) => i.transactionId)).not.toContain(pix.transactionId);
  });

  it('PIX ainda pendente não paga venda — nem pela API', async () => {
    const p = await produto(gerente);
    const pix = await cobrar(operador, { method: 'pix', amountInCents: 5000 });
    const venda = await vender(operador, {
      items: [{ productId: p, quantity: 1 }],
      payments: [{ method: 'pix', amountCents: 5000, providerRef: pix.transactionId }],
    });
    expect(venda.status, JSON.stringify(venda.body)).toBe(409);
    expect(venda.body.error.code).toBe('CORE_SALE_TERMINAL_TX_NOT_APPROVED');
  });

  it('o mesmo PIX não paga duas vendas', async () => {
    const p = await produto(gerente);
    const pix = await cobrar(operador, { method: 'pix', amountInCents: 5000 });
    await request(app).post(`/api/v1/core/pdv/terminal/${pix.transactionId}/confirmar-teste`).set(operador);
    const corpo = {
      items: [{ productId: p, quantity: 1 }],
      payments: [{ method: 'pix', amountCents: 5000, providerRef: pix.transactionId }],
    };
    expect((await vender(operador, corpo)).status).toBe(201);
    const segunda = await vender(operador, corpo);
    expect(segunda.status).toBe(409);
    expect(segunda.body.error.code).toBe('CORE_SALE_TERMINAL_TX_ALREADY_USED');
  });

  it('PIX de provedor de cobrança (referência que não é da maquininha) segue como sempre', async () => {
    const p = await produto(gerente);
    const venda = await vender(operador, {
      items: [{ productId: p, quantity: 1 }],
      payments: [{ method: 'pix', amountCents: 5000, providerRef: 'pay_asaas_123' }],
    });
    expect(venda.status, JSON.stringify(venda.body)).toBe(201);
  });

  it('desistir no balcão CANCELA a cobrança no provedor, com rastro', async () => {
    const pix = await cobrar(operador, { method: 'pix', amountInCents: 5000 });
    const res = await request(app)
      .post(`/api/v1/core/pdv/terminal/${pix.transactionId}/desistir`)
      .set(operador)
      .send({ reason: 'Cliente desistiu do PIX' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.state).toBe('cancelado');
    expect(tx(pix.transactionId).status).toBe('cancelled');
    const tentativas = findRows<Linha>(
      'payment_terminal_cancellations',
      (r) => r.transactionId === pix.transactionId,
    );
    expect(tentativas.map((t) => t.outcome)).toContain('confirmed');

    const fila = await pendencias(gerente);
    expect(fila.semVenda.map((i) => i.transactionId)).not.toContain(pix.transactionId);
  });

  it('desistir sem motivo usa o motivo do balcão; o cartão aprovado e removido da venda também se desfaz', async () => {
    const cartao = await cobrar(operador, { method: 'credito', amountInCents: 3000 });
    expect(cartao.settled).toBe(true);
    const res = await request(app).post(`/api/v1/core/pdv/terminal/${cartao.transactionId}/desistir`).set(operador).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(tx(cartao.transactionId).status).toBe('cancelled');
    expect(String(tx(cartao.transactionId).cancellationReason)).toMatch(/balc/i);
  });

  it('o caixa só desiste da cobrança que ELE fez; a do colega vai para o gestor', async () => {
    const pix = await cobrar(operador, { method: 'pix', amountInCents: 5000 });
    const res = await request(app)
      .post(`/api/v1/core/pdv/terminal/${pix.transactionId}/desistir`)
      .set(outroOperador)
      .send({ reason: 'x' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CORE_TERMINAL_DESISTIR_NOT_OWNER');
    expect(tx(pix.transactionId).status).toBe('in_progress');

    // O gestor pode.
    const doGestor = await request(app)
      .post(`/api/v1/core/pdv/terminal/${pix.transactionId}/desistir`)
      .set(gerente)
      .send({ reason: 'Conferido: cliente foi embora' });
    expect(doGestor.status, JSON.stringify(doGestor.body)).toBe(200);
  });

  it('cobrança que já pagou venda não se desiste — desfaz-se a venda', async () => {
    const p = await produto(gerente);
    const cartao = await cobrar(operador, { method: 'credito', amountInCents: 5000 });
    const venda = await vender(operador, {
      items: [{ productId: p, quantity: 1 }],
      payments: [{ method: 'credito', amountCents: 5000, providerRef: cartao.transactionId }],
    });
    expect(venda.status).toBe(201);
    const res = await request(app)
      .post(`/api/v1/core/pdv/terminal/${cartao.transactionId}/desistir`)
      .set(operador)
      .send({ reason: 'x' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PAYMENT_TERMINAL_TRANSACTION_BOUND_TO_SALE');
  });

  it('o gestor registra a tratativa: sai da fila, com motivo, nome e auditoria', async () => {
    const pix = await cobrar(operador, { method: 'pix', amountInCents: 5000 });
    await request(app).post(`/api/v1/core/pdv/terminal/${pix.transactionId}/confirmar-teste`).set(operador);

    const semMotivo = await request(app)
      .post(`/api/v1/core/pdv/terminal/${pix.transactionId}/tratativa`)
      .set(gerente)
      .send({ reason: '' });
    expect(semMotivo.status).toBe(400);

    const doCaixa = await request(app)
      .post(`/api/v1/core/pdv/terminal/${pix.transactionId}/tratativa`)
      .set(operador)
      .send({ reason: 'Tentando esconder' });
    expect(doCaixa.status).toBe(403);

    const ok = await request(app)
      .post(`/api/v1/core/pdv/terminal/${pix.transactionId}/tratativa`)
      .set(gerente)
      .send({ reason: 'Cliente pagou em dinheiro também; PIX devolvido pelo app do banco' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(tx(pix.transactionId).semVendaTratadaAt).toBeTruthy();

    const fila = await pendencias(gerente);
    expect(fila.semVenda.map((i) => i.transactionId)).not.toContain(pix.transactionId);
    expect(auditoria('pdv.terminal.sem_venda.tratada')).toHaveLength(1);
  });

  it('o gestor amarra a cobrança aprovada à venda que foi lançada à mão', async () => {
    const p = await produto(gerente);
    const cartao = await cobrar(operador, { method: 'credito', amountInCents: 5000 });
    // A maquininha caiu e o gerente a desligou: a venda saiu com o cartão lançado à mão.
    const desligou = await request(app)
      .post(`/api/v1/core/pdv/terminal/configurations/${configId}/deactivate`)
      .set(gerente)
      .send({ reason: 'Aparelho sem sinal' });
    expect(desligou.status, JSON.stringify(desligou.body)).toBe(200);
    const venda = await vender(operador, {
      items: [{ productId: p, quantity: 1 }],
      payments: [{ method: 'credito', amountCents: 5000 }],
    });
    expect(venda.status, JSON.stringify(venda.body)).toBe(201);

    const errado = await request(app)
      .post(`/api/v1/core/pdv/terminal/${cartao.transactionId}/vincular-venda`)
      .set(gerente)
      .send({ saleId: randomUUID(), reason: 'x' });
    expect(errado.status).toBe(404);

    // Pelo NÚMERO da venda — é o que o gestor tem no comprovante.
    const res = await request(app)
      .post(`/api/v1/core/pdv/terminal/${cartao.transactionId}/vincular-venda`)
      .set(gerente)
      .send({ saleNumber: venda.body.number, reason: 'NSU confere com o comprovante da venda' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(tx(cartao.transactionId).saleId).toBe(venda.body.id);
    const linha = getConnection()
      .prepare('SELECT provider_ref FROM core_sale_payments WHERE sale_id = ?')
      .get(venda.body.id) as { provider_ref: string | null };
    expect(linha.provider_ref).toBe(cartao.transactionId);
    expect(auditoria('pdv.terminal.sem_venda.vinculada')).toHaveLength(1);

    const fila = await pendencias(gerente);
    expect(fila.semVenda.map((i) => i.transactionId)).not.toContain(cartao.transactionId);
  });

  it('amarrar exige linha do mesmo meio e valor, ainda sem cobrança', async () => {
    const p = await produto(gerente, 7000);
    const cartao = await cobrar(operador, { method: 'credito', amountInCents: 5000 });
    await request(app)
      .post(`/api/v1/core/pdv/terminal/configurations/${configId}/deactivate`)
      .set(gerente)
      .send({ reason: 'Aparelho sem sinal' });
    const venda = await vender(operador, {
      items: [{ productId: p, quantity: 1 }],
      payments: [{ method: 'credito', amountCents: 7000 }],
    });
    expect(venda.status).toBe(201);
    const res = await request(app)
      .post(`/api/v1/core/pdv/terminal/${cartao.transactionId}/vincular-venda`)
      .set(gerente)
      .send({ saleId: venda.body.id, reason: 'x' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CORE_TERMINAL_BIND_NO_MATCHING_LINE');
    expect(tx(cartao.transactionId).saleId ?? null).toBeNull();
  });

  it('outra empresa não enxerga nem mexe', async () => {
    const vizinho = await entrar(VIZINHA, 'gerente-vizinha', 'gerente_loja');
    const pix = await cobrar(operador, { method: 'pix', amountInCents: 5000 });
    const fila = await request(app).get('/api/v1/core/pdv/terminal/pendencias?minutos=0').set(vizinho);
    expect(fila.status).toBe(200);
    expect(fila.body.semVenda).toHaveLength(0);
    for (const acao of ['desistir', 'tratativa']) {
      const res = await request(app)
        .post(`/api/v1/core/pdv/terminal/${pix.transactionId}/${acao}`)
        .set(vizinho)
        .send({ reason: 'invasão' });
      expect(res.status, acao).toBe(404);
    }
    expect(tx(pix.transactionId).status).toBe('in_progress');
  });
});

// ============================================================================
describe('GAP-PRD-080 — cancelar/devolver venda paga na maquininha pede o estorno', () => {
  it('cancelar a venda estorna a cobrança no provedor e diz o que aconteceu', async () => {
    const p = await produto(gerente);
    const cartao = await cobrar(operador, { method: 'credito', amountInCents: 5000 });
    const venda = await vender(operador, {
      items: [{ productId: p, quantity: 1 }],
      payments: [{ method: 'credito', amountCents: 5000, providerRef: cartao.transactionId }],
    });
    expect(venda.status).toBe(201);

    const res = await request(app)
      .post(`/api/v1/core/sales/${venda.body.id}/cancel`)
      .set(gerente)
      .send({ reason: 'Cliente desistiu da compra' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe('cancelled');
    expect(res.body.estornosNaMaquininha).toHaveLength(1);
    expect(res.body.estornosNaMaquininha[0]).toMatchObject({
      transactionId: cartao.transactionId,
      resultado: 'estornado',
      amountInCents: 5000,
    });

    const depois = tx(cartao.transactionId);
    expect(depois.status).toBe('refunded');
    expect(depois.refundedAmountInCents).toBe(5000);
    expect(Number(depois.aEstornarCents ?? 0)).toBe(0);
    const pedidos = findRows<Linha>('payment_terminal_refunds', (r) => r.transactionId === cartao.transactionId);
    expect(pedidos.map((r) => r.outcome)).toContain('confirmed');
    expect(auditoria('pdv.terminal.estorno_a_fazer')).toHaveLength(1);
  });

  it('devolução "estorno no cartão" estorna só o valor devolvido', async () => {
    const p = await produto(gerente);
    const cartao = await cobrar(operador, { method: 'credito', amountInCents: 10000 });
    const venda = await vender(operador, {
      items: [{ productId: p, quantity: 2 }],
      payments: [{ method: 'credito', amountCents: 10000, providerRef: cartao.transactionId }],
    });
    expect(venda.status, JSON.stringify(venda.body)).toBe(201);
    const item = getConnection()
      .prepare('SELECT id FROM core_sale_items WHERE sale_id = ?')
      .get(venda.body.id) as { id: string };

    const res = await request(app)
      .post('/api/v1/core/sale-returns')
      .set(gerente)
      .send({
        saleId: venda.body.id,
        reason: 'Uma unidade com defeito',
        refundMethod: 'estorno_cartao',
        items: [{ saleItemId: item.id, quantity: 1, restock: true }],
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.estornosNaMaquininha[0]).toMatchObject({ resultado: 'estornado', amountInCents: 5000 });
    const depois = tx(cartao.transactionId);
    expect(depois.status).toBe('partially_refunded');
    expect(depois.refundedAmountInCents).toBe(5000);

    // Depois, o cancelamento estorna só o que sobrou.
    const cancel = await request(app)
      .post(`/api/v1/core/sales/${venda.body.id}/cancel`)
      .set(gerente)
      .send({ reason: 'Desistiu do resto' });
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
    expect(cancel.body.estornosNaMaquininha[0]).toMatchObject({ resultado: 'estornado', amountInCents: 5000 });
    expect(tx(cartao.transactionId).status).toBe('refunded');
    expect(tx(cartao.transactionId).refundedAmountInCents).toBe(10000);
  });

  it('estorno no cartão maior que o cartão integrado pagou é recusado antes de gravar', async () => {
    const p = await produto(gerente);
    const cartao = await cobrar(operador, { method: 'credito', amountInCents: 4000 });
    const venda = await vender(operador, {
      items: [{ productId: p, quantity: 2 }],
      payments: [
        { method: 'credito', amountCents: 4000, providerRef: cartao.transactionId },
        { method: 'pix', amountCents: 6000 },
      ],
    });
    expect(venda.status, JSON.stringify(venda.body)).toBe(201);
    const item = getConnection()
      .prepare('SELECT id FROM core_sale_items WHERE sale_id = ?')
      .get(venda.body.id) as { id: string };
    const res = await request(app)
      .post('/api/v1/core/sale-returns')
      .set(gerente)
      .send({
        saleId: venda.body.id,
        reason: 'Devolveu tudo',
        refundMethod: 'estorno_cartao',
        items: [{ saleItemId: item.id, quantity: 2, restock: true }],
      });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe('CORE_RETURN_CARD_EXCEEDS_TERMINAL');
    expect(res.body.error.message).toMatch(/R\$ 40,00/);
    const n = getConnection()
      .prepare('SELECT COUNT(*) AS n FROM core_sale_returns WHERE sale_id = ?')
      .get(venda.body.id) as { n: number };
    expect(n.n).toBe(0);
    expect(tx(cartao.transactionId).status).toBe('authorized');
  });

  it('sem cobrança integrada (maquininha avulsa), a devolução no cartão segue e diz que é no aparelho', async () => {
    const desligou = await request(app)
      .post(`/api/v1/core/pdv/terminal/configurations/${configId}/deactivate`)
      .set(gerente)
      .send({ reason: 'Loja usa a avulsa' });
    expect(desligou.status).toBe(200);
    const p = await produto(gerente);
    const venda = await vender(operador, {
      items: [{ productId: p, quantity: 1 }],
      payments: [{ method: 'credito', amountCents: 5000 }],
    });
    expect(venda.status).toBe(201);
    const item = getConnection()
      .prepare('SELECT id FROM core_sale_items WHERE sale_id = ?')
      .get(venda.body.id) as { id: string };
    const res = await request(app)
      .post('/api/v1/core/sale-returns')
      .set(gerente)
      .send({
        saleId: venda.body.id,
        reason: 'Defeito',
        refundMethod: 'estorno_cartao',
        items: [{ saleItemId: item.id, quantity: 1, restock: true }],
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.estornosNaMaquininha).toEqual([]);
  });

  it('operadora sem confirmação: a venda cancela, o estorno fica "a fazer" na fila e o gestor o registra', async () => {
    const p = await produto(gerente);
    const stone = `pttx-stone-${randomUUID()}`;
    insertRow('payment_terminal_transactions', {
      id: stone,
      companyId: LOJA,
      provider: 'stone',
      paymentMethod: 'credit',
      amountInCents: 5000,
      status: 'authorized',
      idempotencyKey: randomUUID(),
      startedAt: new Date().toISOString(),
    });
    const venda = await vender(operador, {
      items: [{ productId: p, quantity: 1 }],
      payments: [{ method: 'credito', amountCents: 5000, providerRef: stone }],
    });
    expect(venda.status, JSON.stringify(venda.body)).toBe(201);

    const res = await request(app)
      .post(`/api/v1/core/sales/${venda.body.id}/cancel`)
      .set(gerente)
      .send({ reason: 'Cliente desistiu' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe('cancelled');
    expect(res.body.estornosNaMaquininha[0]).toMatchObject({ transactionId: stone, resultado: 'pendente' });
    expect(res.body.estornosNaMaquininha[0].message).toMatch(/operadora/i);
    expect(tx(stone).status).toBe('authorized');
    expect(tx(stone).aEstornarCents).toBe(5000);

    const fila = await pendencias(gerente);
    expect(fila.aEstornar).toEqual([
      expect.objectContaining({ transactionId: stone, aEstornarCents: 5000, saleId: venda.body.id }),
    ]);

    // A porta do módulo deixa de dizer "amarrada a venda": agora pede à operadora (que não confirma).
    const deNovo = await request(app)
      .post(`/api/v1/payment-terminals/transactions/${stone}/refund`)
      .set(gerente)
      .send({ reason: 'Tentando de novo' });
    expect(deNovo.status).toBe(409);
    expect(deNovo.body.error.code).toBe('PAYMENT_TERMINAL_PROVIDER_PENDING');

    // Mais do que o que está a estornar é recusado.
    const aMais = await request(app)
      .post(`/api/v1/payment-terminals/transactions/${stone}/refund`)
      .set(gerente)
      .send({ reason: 'x', amountInCents: 6000 });
    expect(aMais.status).toBe(400);

    const semMotivo = await request(app)
      .post(`/api/v1/core/pdv/terminal/${stone}/estorno-manual`)
      .set(gerente)
      .send({ reason: '' });
    expect(semMotivo.status).toBe(400);
    const manual = await request(app)
      .post(`/api/v1/core/pdv/terminal/${stone}/estorno-manual`)
      .set(gerente)
      .send({ reason: 'Estornado no aparelho, NSU 991122' });
    expect(manual.status, JSON.stringify(manual.body)).toBe(200);
    expect(tx(stone).status).toBe('refunded');
    expect(tx(stone).refundVia).toBe('manual');
    expect(Number(tx(stone).aEstornarCents)).toBe(0);
    expect((await pendencias(gerente)).aEstornar).toHaveLength(0);
  });

  it('estorno manual só existe para o que está a estornar, e é do gestor', async () => {
    const cartao = await cobrar(operador, { method: 'credito', amountInCents: 3000 });
    const res = await request(app)
      .post(`/api/v1/core/pdv/terminal/${cartao.transactionId}/estorno-manual`)
      .set(gerente)
      .send({ reason: 'x x x' });
    expect(res.status).toBe(409);
    const doCaixa = await request(app)
      .post(`/api/v1/core/pdv/terminal/${cartao.transactionId}/estorno-manual`)
      .set(operador)
      .send({ reason: 'x x x' });
    expect(doCaixa.status).toBe(403);
  });

  it('cobrança de venda VIVA continua recusando estorno avulso pelo módulo', async () => {
    const p = await produto(gerente);
    const cartao = await cobrar(operador, { method: 'credito', amountInCents: 5000 });
    await vender(operador, {
      items: [{ productId: p, quantity: 1 }],
      payments: [{ method: 'credito', amountCents: 5000, providerRef: cartao.transactionId }],
    });
    const res = await request(app)
      .post(`/api/v1/payment-terminals/transactions/${cartao.transactionId}/refund`)
      .set(gerente)
      .send({ reason: 'por fora' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PAYMENT_TERMINAL_TRANSACTION_BOUND_TO_SALE');
  });
});

// ============================================================================
describe('GAP-PRD-081 — o turno não fecha em silêncio com dinheiro eletrônico indefinido', () => {
  async function fechar(auth: Auth, sessionId: string, extra: Record<string, unknown> = {}) {
    return request(app)
      .post(`/api/v1/core/cash/${sessionId}/close`)
      .set(auth)
      .send({ countedCents: 0, ...extra });
  }

  it('cobrança NÃO CONFIRMADA do turno trava o fechamento, e o resumo já avisa', async () => {
    const caixa = await abrirCaixa(operador);
    const incerta = await cobrar(operador, { method: 'credito', amountInCents: 7000, scenario: 'timeout_uncertain' });
    expect(tx(incerta.transactionId).cashSessionId).toBe(caixa);

    const resumo = await request(app).get(`/api/v1/core/cash/${caixa}/summary`).set(operador);
    expect(resumo.status).toBe(200);
    expect(resumo.body.pendenciasEletronicas.cobrancas).toEqual([
      expect.objectContaining({ transactionId: incerta.transactionId, tipo: 'nao_confirmada', amountInCents: 7000 }),
    ]);

    const res = await fechar(operador, caixa);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe('CORE_CASH_CLOSE_ELECTRONIC_PENDING');
    expect(res.body.error.message).toMatch(/R\$ 70,00/);
    expect(res.body.error.details.pendencias.cobrancas).toHaveLength(1);
    const s = getConnection().prepare('SELECT status FROM core_cash_sessions WHERE id = ?').get(caixa) as { status: string };
    expect(s.status).toBe('open');
  });

  it('PIX pendente numa venda do turno trava o fechamento', async () => {
    const caixa = await abrirCaixa(operador);
    const p = await produto(gerente);
    const venda = await vender(operador, {
      items: [{ productId: p, quantity: 1 }],
      payments: [{ method: 'pix', amountCents: 5000, status: 'pending' }],
      cashSessionId: caixa,
    });
    expect(venda.status, JSON.stringify(venda.body)).toBe(201);
    const res = await fechar(operador, caixa);
    expect(res.status).toBe(409);
    expect(res.body.error.details.pendencias.pagamentosPendentes).toEqual([
      expect.objectContaining({ saleId: venda.body.id, method: 'pix', amountCents: 5000 }),
    ]);
  });

  it('cobrança aprovada sem venda e cobrança ainda andando também contam', async () => {
    const caixa = await abrirCaixa(operador);
    const aprovada = await cobrar(operador, { method: 'debito', amountInCents: 2000 });
    const pix = await cobrar(operador, { method: 'pix', amountInCents: 1500 });
    const res = await fechar(operador, caixa);
    expect(res.status).toBe(409);
    const tipos = (res.body.error.details.pendencias.cobrancas as { transactionId: string; tipo: string }[])
      .map((c) => [c.transactionId, c.tipo]);
    expect(tipos).toEqual(
      expect.arrayContaining([
        [aprovada.transactionId, 'aprovada_sem_venda'],
        [pix.transactionId, 'em_andamento'],
      ]),
    );
  });

  it('ciente sem motivo não fecha; ciente com motivo fecha e o turno guarda o que ficou pendente', async () => {
    const caixa = await abrirCaixa(operador);
    const incerta = await cobrar(operador, { method: 'credito', amountInCents: 7000, scenario: 'timeout_uncertain' });

    const semMotivo = await fechar(operador, caixa, { pendenciasCiente: true, pendenciasMotivo: ' ' });
    expect(semMotivo.status).toBe(400);
    expect(semMotivo.body.error.code).toBe('CORE_CASH_CLOSE_PENDING_REASON_REQUIRED');

    const ok = await fechar(operador, caixa, {
      pendenciasCiente: true,
      pendenciasMotivo: 'Gerente vai conferir o extrato amanhã cedo',
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.status).toBe('closed');
    const gravado = JSON.parse(String(ok.body.closed_with_pending)) as {
      motivo: string;
      cobrancas: { transactionId: string }[];
    };
    expect(gravado.motivo).toMatch(/extrato/);
    expect(gravado.cobrancas.map((c) => c.transactionId)).toEqual([incerta.transactionId]);
    const audit = auditoria('cash.close');
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0].detail).pendencias.cobrancas).toBe(1);

    // A pendência NÃO some com o fechamento: continua na fila do gestor.
    const fila = await request(app).get('/api/v1/core/pdv/terminal/uncertain').set(gerente);
    expect(fila.body.items.map((i: { transactionId: string }) => i.transactionId)).toContain(incerta.transactionId);
  });

  it('cobrança já resolvida pelo gestor não trava', async () => {
    const caixa = await abrirCaixa(operador);
    const incerta = await cobrar(operador, { method: 'credito', amountInCents: 7000, scenario: 'timeout_uncertain' });
    const rec = await request(app)
      .post(`/api/v1/core/pdv/terminal/${incerta.transactionId}/reconcile`)
      .set(gerente)
      .send({ outcome: 'recusado', reason: 'Extrato sem a transação' });
    expect(rec.status).toBe(200);
    const res = await fechar(operador, caixa);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.closed_with_pending ?? null).toBeNull();
  });

  it('cobrança sem o carimbo do turno (anterior a esta versão) entra pela janela do turno', async () => {
    const caixa = await abrirCaixa(operador);
    const antiga = `pttx-antiga-${randomUUID()}`;
    insertRow('payment_terminal_transactions', {
      id: antiga,
      companyId: LOJA,
      provider: 'mock',
      paymentMethod: 'credit',
      amountInCents: 1000,
      status: 'timeout_uncertain',
      idempotencyKey: randomUUID(),
      startedAt: new Date(Date.now() + 1000).toISOString(),
    });
    const res = await fechar(operador, caixa);
    expect(res.status).toBe(409);
    expect(res.body.error.details.pendencias.cobrancas[0].transactionId).toBe(antiga);
  });

  it('pendência do caixa ao lado não trava este caixa', async () => {
    const cx1 = (await request(app).post('/api/v1/core/terminals').set(gerente).send({ name: 'Caixa 1' })).body.id;
    const cx2 = (await request(app).post('/api/v1/core/terminals').set(gerente).send({ name: 'Caixa 2' })).body.id;
    const gaveta1 = await abrirCaixa(operador, { terminalId: cx1 });
    await abrirCaixa(outroOperador, { terminalId: cx2 });
    await cobrar(outroOperador, { method: 'credito', amountInCents: 7000, scenario: 'timeout_uncertain', terminalId: cx2 });
    const res = await fechar(operador, gaveta1);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it('reabrir o turno limpa o registro de pendências do fechamento desfeito', async () => {
    const caixa = await abrirCaixa(gerente);
    await cobrar(gerente, { method: 'credito', amountInCents: 7000, scenario: 'timeout_uncertain' });
    const ok = await fechar(gerente, caixa, { pendenciasCiente: true, pendenciasMotivo: 'Confiro depois' });
    expect(ok.status).toBe(200);
    const reaberto = await request(app)
      .post(`/api/v1/core/cash/${caixa}/reopen`)
      .set(gerente)
      .send({ reason: 'Esqueci uma sangria' });
    expect(reaberto.status, JSON.stringify(reaberto.body)).toBe(200);
    expect(reaberto.body.closed_with_pending ?? null).toBeNull();
    const trilha = JSON.parse(String(reaberto.body.closing_trail)) as { closed_with_pending?: string | null }[];
    expect(trilha[0].closed_with_pending).toBeTruthy();
  });
});
