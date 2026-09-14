/**
 * GAP-PRD-006 — O CPF DE OUTRA PESSOA NÃO SEQUESTRA O CADASTRO DELA.
 *
 * O cenário que a auditoria reproduziu em harness, passo a passo:
 *
 *   1. a vítima compra na loja (cadastro com o CPF e o e-mail dela);
 *   2. o atacante fecha um checkout público com o CPF da vítima e o PRÓPRIO
 *      e-mail — e `findOrCreateCustomer` reescrevia e-mail, telefone e
 *      endereço do cadastro dela;
 *   3. o atacante cria conta com o próprio e-mail + o CPF da vítima, prova a
 *      PRÓPRIA caixa, e a "co-prova" (e-mail + documento no mesmo cadastro)
 *      estava fabricada: a conta dele recebia o vínculo ao cadastro dela, em
 *      todas as operações do grupo;
 *   4. com o vínculo ele via o histórico e CANCELAVA os pedidos não pagos dela.
 *
 * Os casos abaixo cobram cada elo, com o cadastro da vítima lido do banco.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import { checkout } from '../src/services/core/StorefrontService.js';
import { confirmarEmail, resolveCustomerSession } from '../src/services/core/CustomerPortalService.js';
import { textoDeEntrega } from '../src/services/notifications/EmailService.js';

const app = createApp();
const SENHA = 'senha-do-cliente-2026';
const CPF_DA_VITIMA = '111.444.777-35';

let gringa: string;
let precoJusto: string;
let n = 0;

function produto(companyId: string): string {
  n += 1;
  const id = `prod-sequestro-${n}`;
  const agora = new Date().toISOString();
  const db = getConnection();
  db.prepare(
    `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                price_cents, active, publish_online, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'UN', 4000, 10000, 1, 1, ?, ?)`,
  ).run(id, companyId, `SQ-${n}`, `Item ${n}`, agora, agora);
  db.prepare(
    'INSERT INTO core_stock (company_id, product_id, quantity, reserved, updated_at) VALUES (?, ?, 20, 0, ?)',
  ).run(companyId, id, agora);
  return id;
}

/**
 * A loja aberta para visitante — a decisão que o DONO pode tomar na tela.
 * É o cenário mais exposto: quem não tem conta nenhuma fecha pedido.
 */
function abrirParaVisitante(companyId: string): void {
  const db = getConnection();
  const agora = new Date().toISOString();
  db.prepare(
    `INSERT INTO core_storefront_settings (company_id, banner_active, checkout_mode, updated_at)
     VALUES (?, 0, 'visitante', ?)
     ON CONFLICT (company_id) DO UPDATE SET checkout_mode = 'visitante'`,
  ).run(companyId, agora);
}

/** A compra da vítima, feita antes de tudo — é ela que cria o cadastro. */
function compraDaVitima(companyId: string, chave: string): string {
  const [pedido] = checkout({
    idempotencyKey: chave,
    customerName: 'Vítima',
    customerEmail: 'vitima@example.com',
    customerDocument: CPF_DA_VITIMA,
    customerPhone: '11999990000',
    shippingAddress: 'Rua da Vítima, 10',
    paymentMethod: 'pix',
    items: [{ productId: produto(companyId), quantity: 1 }],
  });
  return pedido.id;
}

async function checkoutPublicoDoAtacante(companyId: string, chave: string) {
  return request(app)
    .post('/api/v1/loja/checkout')
    .set('Idempotency-Key', chave)
    .send({
      customerName: 'Atacante',
      customerEmail: 'atacante@example.com',
      customerDocument: CPF_DA_VITIMA,
      customerPhone: '11888880000',
      shippingAddress: 'Rua do Atacante, 1',
      paymentMethod: 'pix',
      items: [{ productId: produto(companyId), quantity: 1 }],
    });
}

function cadastroDaVitima(companyId: string) {
  return getConnection()
    .prepare(
      `SELECT id, name, email, phone, address FROM core_customers
        WHERE company_id = ? AND document = '11144477735'`,
    )
    .get(companyId) as { id: string; name: string; email: string; phone: string; address: string };
}

/** Lê o código do e-mail enfileirado e confirma — o gesto do dono da caixa. */
function provarCaixa(accountId: string, email: string): void {
  const linha = getConnection()
    .prepare(
      `SELECT id FROM core_email_queue
        WHERE template = 'verificacao_email' AND to_address = ?
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(email) as { id: string } | undefined;
  const codigo = (linha ? textoDeEntrega(linha.id) : null)?.match(/é: (\d{6})/)?.[1];
  expect(codigo, 'codigo de verificacao ausente na fila').toBeTruthy();
  confirmarEmail({ accountId, codigo: codigo! });
}

/** O atacante cria a conta com o PRÓPRIO e-mail e o CPF da vítima. */
async function contaDoAtacante(): Promise<string> {
  const res = await request(app)
    .post('/api/v1/loja/portal/registrar')
    .send({
      termsAccepted: true,
      email: 'atacante@example.com',
      document: CPF_DA_VITIMA,
      password: SENHA,
    });
  expect(res.status).toBe(201);
  // Ele prova a caixa DELE — é o que qualquer um consegue fazer.
  provarCaixa(res.body.account.id as string, 'atacante@example.com');
  return res.body.token as string;
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  n = 0;
  gringa = await upsertCompany({ slug: 'gringa', tradeName: 'Gringa', legalName: 'Gringa Ltda' });
  precoJusto = await upsertCompany({
    slug: 'preco-justo',
    tradeName: 'Preço Justo',
    legalName: 'PJ Ltda',
  });
  abrirParaVisitante(gringa);
  abrirParaVisitante(precoJusto);
});

describe('o checkout não reescreve o cadastro de ninguém', () => {
  it('checkout público com o CPF da vítima NÃO troca e-mail, telefone nem endereço dela', async () => {
    compraDaVitima(gringa, 'v1');

    const res = await checkoutPublicoDoAtacante(gringa, 'a1');
    expect(res.status).toBe(201);

    // O pedido do atacante existe — mas o cadastro da vítima é o que era.
    expect(cadastroDaVitima(gringa)).toMatchObject({
      name: 'Vítima',
      email: 'vitima@example.com',
      phone: '11999990000',
      address: 'Rua da Vítima, 10',
    });
  });

  it('o pedido do atacante guarda o que ELE digitou — é a cópia do pedido, não o cadastro', async () => {
    compraDaVitima(gringa, 'v2');

    const res = await checkoutPublicoDoAtacante(gringa, 'a2');
    const pedido = getConnection()
      .prepare('SELECT customer_email, shipping_address FROM core_orders WHERE id = ?')
      .get(res.body.orders[0].id) as { customer_email: string; shipping_address: string };

    // A entrega e o aviso do pedido vão para quem comprou; o cadastro fica.
    expect(pedido).toEqual({
      customer_email: 'atacante@example.com',
      shipping_address: 'Rua do Atacante, 1',
    });
  });
});

describe('a co-prova não se fabrica com o CPF alheio', () => {
  it('a conta do atacante NÃO vê o pedido da vítima — nem pela lista, nem pelo id', async () => {
    const daVitima = compraDaVitima(gringa, 'v3');
    await checkoutPublicoDoAtacante(gringa, 'a3');
    const token = await contaDoAtacante();

    const lista = await request(app).get('/api/v1/loja/portal/pedidos').set('x-portal-token', token);
    expect(lista.status).toBe(200);
    const ids = (lista.body.items as { id: string }[]).map((i) => i.id);
    expect(ids).not.toContain(daVitima);

    const detalhe = await request(app)
      .get(`/api/v1/loja/portal/pedidos/${daVitima}`)
      .set('x-portal-token', token);
    expect(detalhe.status).toBe(404);
  });

  it('a conta do atacante NÃO cancela o pedido não pago da vítima', async () => {
    const daVitima = compraDaVitima(gringa, 'v4');
    await checkoutPublicoDoAtacante(gringa, 'a4');
    const token = await contaDoAtacante();

    const res = await request(app)
      .post(`/api/v1/loja/portal/pedidos/${daVitima}/cancelar`)
      .set('x-portal-token', token);

    expect(res.status).toBe(404);
    const pedido = getConnection()
      .prepare('SELECT status FROM core_orders WHERE id = ?')
      .get(daVitima) as { status: string };
    expect(pedido.status).toBe('aguardando_pagamento');
  });

  it('a conta do atacante não fica ligada ao cadastro da vítima', async () => {
    compraDaVitima(gringa, 'v5');
    await checkoutPublicoDoAtacante(gringa, 'a5');
    const token = await contaDoAtacante();

    const sessao = resolveCustomerSession(token)!;
    expect(sessao.customerIds).not.toContain(cadastroDaVitima(gringa).id);
  });
});

describe('o CPF digitado não atravessa o grupo', () => {
  /*
    A variante sem sobrescrita: na Gringa a vítima NÃO tem cadastro, então o
    checkout do atacante cria um cadastro NOVO com o e-mail dele e o CPF dela
    — e esse cadastro co-prova de verdade. O furo estava no passo seguinte:
    `syncLinks` pegava o documento desse cadastro e ligava a conta a TODO
    cadastro com o mesmo CPF no grupo — o da vítima no Preço Justo incluso.
  */
  it('co-provar um cadastro que o próprio atacante criou não liga o cadastro da vítima em outra loja', async () => {
    const daVitima = compraDaVitima(precoJusto, 'v6');
    await checkoutPublicoDoAtacante(gringa, 'a6');
    const token = await contaDoAtacante();

    const sessao = resolveCustomerSession(token)!;
    expect(sessao.customerIds).not.toContain(cadastroDaVitima(precoJusto).id);

    const detalhe = await request(app)
      .get(`/api/v1/loja/portal/pedidos/${daVitima}`)
      .set('x-portal-token', token);
    expect(detalhe.status).toBe(404);
  });

  it('e o "Salvar dados" do atacante não renomeia o cadastro da vítima em outra loja', async () => {
    compraDaVitima(precoJusto, 'v7');
    await checkoutPublicoDoAtacante(gringa, 'a7');
    const token = await contaDoAtacante();

    await request(app)
      .put('/api/v1/loja/portal/perfil')
      .set('x-portal-token', token)
      .send({ name: 'Nome Trocado', phone: '11000000000' });

    expect(cadastroDaVitima(precoJusto)).toMatchObject({
      name: 'Vítima',
      phone: '11999990000',
    });
  });

  it('o login seguinte também não propaga — o vínculo é recalculado a cada entrada', async () => {
    compraDaVitima(precoJusto, 'v8');
    await checkoutPublicoDoAtacante(gringa, 'a8');
    await contaDoAtacante();

    const entrar = await request(app)
      .post('/api/v1/loja/portal/entrar')
      .send({ email: 'atacante@example.com', password: SENHA });
    expect(entrar.status).toBe(200);

    const sessao = resolveCustomerSession(entrar.body.token as string)!;
    expect(sessao.customerIds).not.toContain(cadastroDaVitima(precoJusto).id);
  });
});

describe('o dono de verdade continua achando o que é dele', () => {
  it('a vítima, com a conta dela, vê o próprio pedido e não vê o do atacante', async () => {
    const daVitima = compraDaVitima(gringa, 'v9');
    const doAtacante = await checkoutPublicoDoAtacante(gringa, 'a9');

    const reg = await request(app)
      .post('/api/v1/loja/portal/registrar')
      .send({ termsAccepted: true, email: 'vitima@example.com', document: CPF_DA_VITIMA, password: SENHA });
    provarCaixa(reg.body.account.id as string, 'vitima@example.com');

    const lista = await request(app)
      .get('/api/v1/loja/portal/pedidos')
      .set('x-portal-token', reg.body.token as string);
    const ids = (lista.body.items as { id: string }[]).map((i) => i.id);
    expect(ids).toContain(daVitima);
    // O pedido que o atacante fez com o CPF dela é do atacante: ela não o
    // cancela nem lê o endereço que ele digitou.
    expect(ids).not.toContain(doAtacante.body.orders[0].id);
  });
});

describe('o outro caminho automático que achava o cadastro pelo CPF', () => {
  /*
    `findOrCreateCustomer` também espelha o comprador de um equipamento
    vendido online para a Oficina (`EquipmentStockLink`), casando SÓ pelo
    documento. Com o `COALESCE(?, email)` antigo, o espelho levava o e-mail de
    quem digitou o CPF para o cadastro da vítima na Oficina — e a co-prova
    ficava fabricada lá. O conserto é na função, não no chamador.
  */
  it('achar pelo documento devolve o cadastro sem trocar o contato dele', async () => {
    const { findOrCreateCustomer } = await import('../src/services/core/CatalogService.js');
    compraDaVitima(gringa, 'v10');
    const antes = cadastroDaVitima(gringa);

    const achado = findOrCreateCustomer(
      gringa,
      {
        name: 'Atacante',
        document: CPF_DA_VITIMA,
        email: 'atacante@example.com',
        phone: '11888880000',
        address: 'Rua do Atacante, 1',
      },
      { matchBy: 'document' },
    )!;

    expect(String(achado.id)).toBe(antes.id);
    expect(cadastroDaVitima(gringa)).toEqual(antes);
  });
});
