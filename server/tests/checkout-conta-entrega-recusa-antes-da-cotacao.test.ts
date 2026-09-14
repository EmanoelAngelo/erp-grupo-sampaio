/**
 * GAP-PRD-028 (verificação adversarial) — COM CONTA, O TEXTO SOLTO É
 * RECUSADO COM O CÓDIGO DELE, ANTES DE COTAR O FRETE.
 *
 * O conserto da reauditoria pôs a regra em `resolverFretesDoCarrinho`, mas
 * DEPOIS de `resolveCheckoutShipping` — a cotação. Dois efeitos:
 *
 *   1. conta + texto solto SEM CEP + entrega: a cotação sem CEP só oferece
 *      retirada, e a recusa que saía era 400 SHIPPING_OPTION_UNAVAILABLE
 *      ("Informe um CEP de 8 dígitos…") — o código genérico, mandando a
 *      pessoa digitar um CEP que não resolveria nada. O código próprio
 *      (CHECKOUT_ENDERECO_SALVO_OBRIGATORIO) nunca chegava;
 *   2. com CEP, a cotação (que, com transportadora conectada, é chamada ao
 *      provedor) rodava para um pedido que seria recusado de qualquer jeito —
 *      e, no carrinho de duas lojas, a primeira era cotada antes de a
 *      segunda recusar.
 *
 * A regra: com conta e alguma loja pedindo entrega, o endereço salvo e
 * completo é conferido ANTES de cotar qualquer loja.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../src/services/core/CheckoutShippingService.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/services/core/CheckoutShippingService.js')>();
  return { ...original, resolveCheckoutShipping: vi.fn(original.resolveCheckoutShipping) };
});

import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import { confirmarEmail } from '../src/services/core/CustomerPortalService.js';
import {
  resolveCheckoutShipping,
  saveShippingSettings,
} from '../src/services/core/CheckoutShippingService.js';
import { textoDeEntrega } from '../src/services/notifications/EmailService.js';

const app = createApp();
const cotacao = vi.mocked(resolveCheckoutShipping);
const SENHA = 'senha-do-cliente-2026';
const DADOS = { customerName: 'Ana Nova', customerDocument: '111.444.777-35', customerPhone: '(53) 99999-0000' };
const CASA = {
  label: 'Casa',
  zip: '96010-000',
  street: 'Rua XV de Novembro',
  number: '500',
  district: 'Centro',
  city: 'Pelotas',
  state: 'RS',
  cityIbge: '4314407',
};

let gringa: string;
let precoJusto: string;
let n = 0;

function produto(companyId: string): string {
  n += 1;
  const id = `prod-antes-da-cotacao-${n}`;
  const agora = new Date().toISOString();
  const db = getConnection();
  db.prepare(
    `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                price_cents, active, publish_online, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'UN', 4000, 10000, 1, 1, ?, ?)`,
  ).run(id, companyId, `AC-${n}`, `Item ${n}`, agora, agora);
  db.prepare(
    'INSERT INTO core_stock (company_id, product_id, quantity, reserved, updated_at) VALUES (?, ?, 5, 0, ?)',
  ).run(companyId, id, agora);
  return id;
}

function contar(tabela: 'core_orders' | 'core_payment_intents'): number {
  return (getConnection().prepare(`SELECT COUNT(*) c FROM ${tabela}`).get() as { c: number }).c;
}

function reservado(productId: string): number {
  return (
    getConnection().prepare('SELECT reserved FROM core_stock WHERE product_id = ?').get(productId) as {
      reserved: number;
    }
  ).reserved;
}

async function contaNova(email = 'ana@exemplo.com'): Promise<string> {
  const res = await request(app)
    .post('/api/v1/loja/portal/registrar')
    .send({ termsAccepted: true, email, password: SENHA });
  expect(res.status).toBe(201);
  const linha = getConnection()
    .prepare(
      `SELECT id FROM core_email_queue
        WHERE template = 'verificacao_email' AND to_address = ? ORDER BY created_at DESC LIMIT 1`,
    )
    .get(email) as { id: string };
  confirmarEmail({
    accountId: res.body.account.id as string,
    codigo: textoDeEntrega(linha.id)!.match(/é: (\d{6})/)![1],
  });
  return res.body.token as string;
}

async function salvarEndereco(token: string, corpo: Record<string, unknown>): Promise<string> {
  const res = await request(app).post('/api/v1/loja/portal/enderecos').set('x-portal-token', token).send(corpo);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

function fechar(token: string, corpo: Record<string, unknown>) {
  n += 1;
  return request(app)
    .post('/api/v1/loja/checkout')
    .set('Idempotency-Key', `antes-da-cotacao-${n}`)
    .set('x-portal-token', token)
    .send({ paymentMethod: 'pix', ...DADOS, ...corpo });
}

function nadaAconteceu(...itens: string[]): void {
  expect(contar('core_orders')).toBe(0);
  expect(contar('core_payment_intents')).toBe(0);
  for (const item of itens) expect(reservado(item)).toBe(0);
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  n = 0;
  gringa = await upsertCompany({ slug: 'gringa', tradeName: 'Gringa', legalName: 'Gringa Ltda' });
  precoJusto = await upsertCompany({ slug: 'preco-justo', tradeName: 'Preço Justo', legalName: 'PJ Ltda' });
  for (const loja of [gringa, precoJusto]) {
    saveShippingSettings({
      companyId: loja,
      pickupEnabled: true,
      deliveryEnabled: true,
      flatRateCents: 2500,
      estimatedDays: 4,
    });
  }
  cotacao.mockClear();
});

describe('GAP-PRD-028 — com conta, a recusa do texto solto vem antes da cotação', () => {
  it('texto solto SEM CEP: o código próprio (não "informe um CEP"), sem cotar, sem pedido, reserva nem cobrança', async () => {
    const token = await contaNova();
    await salvarEndereco(token, CASA);
    const item = produto(gringa);

    const res = await fechar(token, {
      shippingAddress: 'Rua Digitada, 2 - Pelotas/RS',
      shippingMethods: { [gringa]: 'tabela_da_loja' },
      items: [{ productId: item, quantity: 1 }],
    });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error.code).toBe('CHECKOUT_ENDERECO_SALVO_OBRIGATORIO');
    expect(cotacao).not.toHaveBeenCalled();
    nadaAconteceu(item);
  });

  it('texto solto COM CEP, na forma antiga (shippingMethod único): recusado sem cotar', async () => {
    const token = await contaNova();
    const item = produto(gringa);

    const res = await fechar(token, {
      shippingZip: '96010-000',
      shippingAddress: 'Rua Digitada, 2 - Pelotas/RS',
      shippingMethod: 'tabela_da_loja',
      items: [{ productId: item, quantity: 1 }],
    });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CHECKOUT_ENDERECO_SALVO_OBRIGATORIO');
    expect(cotacao).not.toHaveBeenCalled();
    nadaAconteceu(item);
  });

  it('carrinho de duas lojas: a loja da retirada não é cotada antes de a da entrega recusar', async () => {
    const token = await contaNova();
    const doPrecoJusto = produto(precoJusto);
    const daGringa = produto(gringa);

    const res = await fechar(token, {
      shippingZip: '96010-000',
      shippingAddress: 'Rua Digitada, 2 - Pelotas/RS',
      shippingMethods: { [precoJusto]: 'retirada', [gringa]: 'tabela_da_loja' },
      items: [
        { productId: doPrecoJusto, quantity: 1 },
        { productId: daGringa, quantity: 1 },
      ],
    });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CHECKOUT_ENDERECO_SALVO_OBRIGATORIO');
    expect(cotacao).not.toHaveBeenCalled();
    nadaAconteceu(doPrecoJusto, daGringa);
  });

  it('endereço salvo sem IBGE: CHECKOUT_ENDERECO_INCOMPLETO, sem cotar', async () => {
    const token = await contaNova();
    const trabalho = await salvarEndereco(token, { ...CASA, label: 'Trabalho', cityIbge: '' });
    const item = produto(gringa);

    const res = await fechar(token, {
      shippingAddressId: trabalho,
      shippingMethods: { [gringa]: 'tabela_da_loja' },
      items: [{ productId: item, quantity: 1 }],
    });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CHECKOUT_ENDERECO_INCOMPLETO');
    expect(res.body.error.details.faltando).toEqual(['ibge']);
    expect(cotacao).not.toHaveBeenCalled();
    nadaAconteceu(item);
  });

  it('o que passa continua passando: endereço salvo completo (cotado uma vez) e retirada sem endereço', async () => {
    const token = await contaNova();
    const casa = await salvarEndereco(token, CASA);

    const entrega = await fechar(token, {
      shippingAddressId: casa,
      shippingMethods: { [gringa]: 'tabela_da_loja' },
      items: [{ productId: produto(gringa), quantity: 1 }],
    });
    expect(entrega.status, JSON.stringify(entrega.body)).toBe(201);
    expect(cotacao).toHaveBeenCalledTimes(1);

    const retirada = await fechar(token, {
      shippingMethods: { [gringa]: 'retirada' },
      items: [{ productId: produto(gringa), quantity: 1 }],
    });
    expect(retirada.status, JSON.stringify(retirada.body)).toBe(201);
  });
});
