/**
 * GAP-PRD-191 — O CHECKOUT DE VISITANTE CONFERE QUEM COMPRA ANTES DE RESERVAR.
 *
 * A auditoria fechou pela API um pedido só com `customerName`: 201, a cobrança
 * voltou `failed` ("O CPF ou CNPJ do cliente é obrigatório para gerar a
 * cobrança") e o estoque ficou reservado — 25 horas de mercadoria presa num
 * pedido que ninguém tinha como pagar, sem e-mail para avisar ninguém.
 *
 * A regra: na loja aberta para visitante (decisão do dono, GAP-PRD-028), o
 * servidor exige CPF/CNPJ com os dígitos verificadores certos e um e-mail
 * sintaticamente válido ANTES de cotar frete, reservar ou numerar o pedido.
 * Toda forma de pagamento da vitrine é cobrança online (PIX, boleto, cartão),
 * e a cobrança exige o documento; o e-mail é por onde o pedido e o PIX chegam.
 * A recusa nomeia TODOS os campos de uma vez.
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { loginForTest } from './helpers/auth.js';
import { abrirParaVisitante } from './helpers/lojaAberta.js';

const app = createApp();
let auth: { Authorization: string };

const CPF_VALIDO = '529.982.247-25';
const CNPJ_VALIDO = '11.222.333/0001-81';

async function produtoPublicado(nome: string, qty: number): Promise<string> {
  const p = await request(app)
    .post('/api/v1/core/products')
    .set(auth)
    .send({ name: nome, priceCents: 10000, category: 'Geral', publishOnline: true });
  await request(app).post('/api/v1/core/stock/movements').set(auth).send({
    productId: p.body.id,
    movementType: 'in',
    quantity: qty,
    referenceType: 'entrada',
    referenceId: `nf-${nome}`,
  });
  return p.body.id as string;
}

function fechar(productId: string, corpo: Record<string, unknown>) {
  return request(app)
    .post('/api/v1/loja/checkout')
    .set('Idempotency-Key', randomUUID())
    .send({ paymentMethod: 'pix', items: [{ productId, quantity: 1 }], ...corpo });
}

function reservado(productId: string): number {
  const linha = getConnection()
    .prepare('SELECT COALESCE(SUM(reserved), 0) AS r FROM core_stock WHERE product_id = ?')
    .get(productId) as { r: number };
  return Number(linha.r);
}

function contar(tabela: string): number {
  return (getConnection().prepare(`SELECT COUNT(*) AS c FROM ${tabela}`).get() as { c: number }).c;
}

beforeEach(async () => {
  resetDbForTests();
  const login = await loginForTest(app, {
    userId: 'ger-gringa',
    companyId: 'gringa',
    profileCodes: ['gerente_loja'],
  });
  auth = { Authorization: `Bearer ${login.body.accessToken}` };
  abrirParaVisitante('gringa');
});

describe('GAP-PRD-191 — visitante sem documento nem e-mail não reserva estoque', () => {
  it('só com o nome: 400, nenhum pedido, nenhuma reserva, nenhum e-mail', async () => {
    const productId = await produtoPublicado('Tênis', 5);
    const res = await fechar(productId, { customerName: 'Visitante' });

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error.code).toBe('CHECKOUT_VISITANTE_INCOMPLETO');
    expect(res.body.error.details.campos).toEqual(['documento', 'email']);
    expect(contar('core_orders')).toBe(0);
    expect(reservado(productId)).toBe(0);
    expect(contar('core_email_queue')).toBe(0);
  });

  it('CPF com dígito verificador errado é recusado (não basta ter 11 dígitos)', async () => {
    const productId = await produtoPublicado('Bota', 5);
    const res = await fechar(productId, {
      customerName: 'Visitante',
      customerDocument: '111.222.333-44',
      customerEmail: 'visitante@exemplo.com',
    });

    expect(res.status).toBe(400);
    expect(res.body.error.details.campos).toEqual(['documento']);
    expect(res.body.error.message).toMatch(/CPF ou CNPJ/);
    expect(reservado(productId)).toBe(0);
  });

  it('CPF de dígitos repetidos (000.000.000-00) também não passa', async () => {
    const productId = await produtoPublicado('Sandália', 5);
    const res = await fechar(productId, {
      customerName: 'Visitante',
      customerDocument: '000.000.000-00',
      customerEmail: 'visitante@exemplo.com',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.details.campos).toEqual(['documento']);
  });

  it.each([
    ['sem arroba', 'visitante.exemplo.com'],
    ['sem domínio', 'visitante@'],
    ['domínio sem ponto', 'visitante@exemplo'],
    ['com espaço', 'visi tante@exemplo.com'],
    ['ponto duplo', 'visitante..x@exemplo.com'],
  ])('e-mail %s é recusado', async (_caso, email) => {
    const productId = await produtoPublicado(`Chinelo ${_caso}`, 5);
    const res = await fechar(productId, {
      customerName: 'Visitante',
      customerDocument: CPF_VALIDO,
      customerEmail: email,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.details.campos).toEqual(['email']);
    expect(reservado(productId)).toBe(0);
  });

  it('sem nome, sem documento e sem e-mail: a recusa nomeia os três de uma vez', async () => {
    const productId = await produtoPublicado('Meia', 5);
    const res = await fechar(productId, { customerName: '  ' });
    expect(res.status).toBe(400);
    expect(res.body.error.details.campos).toEqual(['nome', 'documento', 'email']);
  });

  it('CPF válido + e-mail válido: o pedido nasce e reserva', async () => {
    const productId = await produtoPublicado('Casaco', 5);
    const res = await fechar(productId, {
      customerName: 'Visitante',
      customerDocument: CPF_VALIDO,
      customerEmail: 'Visitante@Exemplo.com',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(reservado(productId)).toBe(1);
    const pedido = getConnection()
      .prepare('SELECT customer_document, customer_email FROM core_orders')
      .get() as { customer_document: string; customer_email: string };
    // O pedido guarda o documento só com os dígitos e o e-mail normalizado.
    expect(pedido.customer_document).toBe('52998224725');
    expect(pedido.customer_email).toBe('visitante@exemplo.com');
  });

  it('CNPJ válido também é documento de comprador', async () => {
    const productId = await produtoPublicado('Caixa', 5);
    const res = await fechar(productId, {
      customerName: 'Loja Parceira Ltda',
      customerDocument: CNPJ_VALIDO,
      customerEmail: 'compras@parceira.com.br',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });
});
