/**
 * GAP-PRD-028 (reauditoria) — COM CONTA, A ENTREGA VAI PARA UM ENDEREÇO
 * SALVO, COMPLETO, E O PEDIDO GUARDA O RETRATO DELE.
 *
 * O que a reauditoria refutou no fechamento com conta:
 *
 *   1. com sessão do portal e alguma loja ENTREGANDO, o servidor aceitava o
 *      endereço em TEXTO SOLTO (`shippingAddress`) sem `shippingAddressId` —
 *      só a tela obrigava o endereço salvo, e o comentário dela dizia que "o
 *      servidor recusaria depois", o que não era verdade;
 *   2. a ficha exige IBGE e destinatário no endereço do fechamento; o IBGE só
 *      era exigido no endereço de FATURAMENTO.
 *
 * A regra que este arquivo cobra, pela API:
 *
 *   - conta + alguma loja entregando = `shippingAddressId` de um endereço da
 *     conta, ou 422 CHECKOUT_ENDERECO_SALVO_OBRIGATORIO — antes de reservar
 *     estoque, numerar pedido ou emitir cobrança;
 *   - o endereço de entrega do fechamento está completo (rua, número, bairro,
 *     cidade, UF, CEP e código IBGE), ou 422 CHECKOUT_ENDERECO_INCOMPLETO com
 *     o que falta e onde completar;
 *   - o retrato do pedido grava o IBGE e o destinatário (o do endereço, ou o
 *     nome de quem compra);
 *   - retirada não pede endereço; o visitante (loja aberta para ele) continua
 *     com o endereço digitado.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import { confirmarEmail } from '../src/services/core/CustomerPortalService.js';
import { saveShippingSettings } from '../src/services/core/CheckoutShippingService.js';
import { textoDeEntrega } from '../src/services/notifications/EmailService.js';
import { abrirParaVisitante, VISITANTE } from './helpers/lojaAberta.js';

const app = createApp();
const SENHA = 'senha-do-cliente-2026';
const CPF = '111.444.777-35';
const DADOS = { customerName: 'Ana Nova', customerDocument: CPF, customerPhone: '(53) 99999-0000' };

const CASA = {
  label: 'Casa',
  zip: '96010-000',
  street: 'Rua XV de Novembro',
  number: '500',
  complement: 'ap 12',
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
  const id = `prod-entrega-salva-${n}`;
  const agora = new Date().toISOString();
  const db = getConnection();
  db.prepare(
    `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                price_cents, active, publish_online, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'UN', 4000, 10000, 1, 1, ?, ?)`,
  ).run(id, companyId, `ES-${n}`, `Item ${n}`, agora, agora);
  db.prepare(
    'INSERT INTO core_stock (company_id, product_id, quantity, reserved, updated_at) VALUES (?, ?, 5, 0, ?)',
  ).run(companyId, id, agora);
  return id;
}

function reservado(productId: string): number {
  return (
    getConnection().prepare('SELECT reserved FROM core_stock WHERE product_id = ?').get(productId) as {
      reserved: number;
    }
  ).reserved;
}

function contar(tabela: 'core_orders' | 'core_payment_intents'): number {
  return (getConnection().prepare(`SELECT COUNT(*) c FROM ${tabela}`).get() as { c: number }).c;
}

function pedido(id: string): Record<string, unknown> {
  return getConnection().prepare('SELECT * FROM core_orders WHERE id = ?').get(id) as Record<string, unknown>;
}

/** A loja entrega pela tabela do dono (R$ 25,00) e também deixa retirar. */
function ligarEntrega(companyId: string): void {
  saveShippingSettings({
    companyId,
    pickupEnabled: true,
    deliveryEnabled: true,
    flatRateCents: 2500,
    estimatedDays: 4,
  });
}

async function contaNova(email = 'ana@exemplo.com'): Promise<{ token: string; accountId: string }> {
  const res = await request(app)
    .post('/api/v1/loja/portal/registrar')
    .send({ termsAccepted: true, email, password: SENHA });
  expect(res.status).toBe(201);
  const accountId = res.body.account.id as string;
  const linha = getConnection()
    .prepare(
      `SELECT id FROM core_email_queue
        WHERE template = 'verificacao_email' AND to_address = ? ORDER BY created_at DESC LIMIT 1`,
    )
    .get(email) as { id: string };
  confirmarEmail({ accountId, codigo: textoDeEntrega(linha.id)!.match(/é: (\d{6})/)![1] });
  return { token: res.body.token as string, accountId };
}

async function salvarEndereco(token: string, corpo: Record<string, unknown>): Promise<string> {
  const res = await request(app).post('/api/v1/loja/portal/enderecos').set('x-portal-token', token).send(corpo);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

function fechar(token: string | null, corpo: Record<string, unknown>) {
  n += 1;
  const req = request(app).post('/api/v1/loja/checkout').set('Idempotency-Key', `entrega-salva-${n}`);
  if (token) req.set('x-portal-token', token);
  return req.send({ paymentMethod: 'pix', ...corpo });
}

/** A recusa não deixou rastro: nenhum pedido, nenhuma reserva, nenhuma cobrança. */
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
  ligarEntrega(gringa);
});

describe('GAP-PRD-028 — com conta, entregar exige um endereço SALVO da conta', () => {
  it('texto solto sem shippingAddressId é 422 CHECKOUT_ENDERECO_SALVO_OBRIGATORIO, sem pedido, reserva nem cobrança', async () => {
    const { token } = await contaNova();
    await salvarEndereco(token, CASA);
    const item = produto(gringa);

    const res = await fechar(token, {
      ...DADOS,
      shippingZip: '96010-000',
      shippingAddress: 'Rua Digitada, 2 - Pelotas/RS',
      shippingMethods: { [gringa]: 'tabela_da_loja' },
      items: [{ productId: item, quantity: 1 }],
    });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error.code).toBe('CHECKOUT_ENDERECO_SALVO_OBRIGATORIO');
    expect(res.body.error.message).toMatch(/endereço salvo/);
    nadaAconteceu(item);
  });

  it('sem endereço nenhum, a recusa é a mesma (não a genérica de "informe o endereço")', async () => {
    const { token } = await contaNova();
    const item = produto(gringa);

    const res = await fechar(token, {
      ...DADOS,
      shippingZip: '96010-000',
      shippingMethods: { [gringa]: 'tabela_da_loja' },
      items: [{ productId: item, quantity: 1 }],
    });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CHECKOUT_ENDERECO_SALVO_OBRIGATORIO');
    nadaAconteceu(item);
  });

  it('a loja aberta para visitante não abre o texto solto para quem está logado', async () => {
    abrirParaVisitante(gringa);
    const { token } = await contaNova();
    const item = produto(gringa);

    const res = await fechar(token, {
      ...DADOS,
      shippingZip: '96010-000',
      shippingAddress: 'Rua Digitada, 2 - Pelotas/RS',
      shippingMethods: { [gringa]: 'tabela_da_loja' },
      items: [{ productId: item, quantity: 1 }],
    });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CHECKOUT_ENDERECO_SALVO_OBRIGATORIO');
    nadaAconteceu(item);
  });

  it('carrinho de duas lojas: basta UMA entregar para exigir o endereço salvo', async () => {
    const { token } = await contaNova();
    const daGringa = produto(gringa);
    const doPrecoJusto = produto(precoJusto);

    const res = await fechar(token, {
      ...DADOS,
      shippingZip: '96010-000',
      shippingAddress: 'Rua Digitada, 2 - Pelotas/RS',
      shippingMethods: { [gringa]: 'tabela_da_loja', [precoJusto]: 'retirada' },
      items: [
        { productId: doPrecoJusto, quantity: 1 },
        { productId: daGringa, quantity: 1 },
      ],
    });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CHECKOUT_ENDERECO_SALVO_OBRIGATORIO');
    nadaAconteceu(daGringa, doPrecoJusto);
  });
});

describe('GAP-PRD-028 — o endereço de entrega do fechamento está completo, com IBGE e destinatário', () => {
  it('endereço salvo completo, com quem recebe: 201, e o retrato do pedido tem o IBGE e o destinatário do endereço', async () => {
    const { token } = await contaNova();
    const casa = await salvarEndereco(token, { ...CASA, recipientName: 'Maria Recebedora' });
    const item = produto(gringa);

    const res = await fechar(token, {
      ...DADOS,
      shippingAddressId: casa,
      shippingMethods: { [gringa]: 'tabela_da_loja' },
      items: [{ productId: item, quantity: 1 }],
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.payments).toHaveLength(1);
    expect(reservado(item)).toBe(1);
    expect(pedido(res.body.orders[0].id)).toMatchObject({
      shipping_method: 'tabela_da_loja',
      shipping_cents: 2500,
      shipping_address_id: casa,
      shipping_recipient_name: 'Maria Recebedora',
      shipping_street: 'Rua XV de Novembro',
      shipping_number: '500',
      shipping_complement: 'ap 12',
      shipping_district: 'Centro',
      shipping_city: 'Pelotas',
      shipping_state: 'RS',
      shipping_zip: '96010000',
      shipping_city_ibge: '4314407',
    });
  });

  it('endereço sem destinatário: o retrato grava o nome de quem compra', async () => {
    const { token } = await contaNova();
    const casa = await salvarEndereco(token, CASA);

    const res = await fechar(token, {
      ...DADOS,
      shippingAddressId: casa,
      shippingMethods: { [gringa]: 'tabela_da_loja' },
      items: [{ productId: produto(gringa), quantity: 1 }],
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(pedido(res.body.orders[0].id)).toMatchObject({
      shipping_recipient_name: 'Ana Nova',
      shipping_city_ibge: '4314407',
    });
  });

  it('endereço salvo SEM o código IBGE: 422 CHECKOUT_ENDERECO_INCOMPLETO dizendo o que completar e onde; completado, fecha', async () => {
    const { token } = await contaNova();
    const trabalho = await salvarEndereco(token, { ...CASA, label: 'Trabalho', cityIbge: '' });
    const item = produto(gringa);
    const corpo = {
      ...DADOS,
      shippingAddressId: trabalho,
      shippingMethods: { [gringa]: 'tabela_da_loja' },
      items: [{ productId: item, quantity: 1 }],
    };

    const res = await fechar(token, corpo);

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error.code).toBe('CHECKOUT_ENDERECO_INCOMPLETO');
    expect(res.body.error.message).toMatch(/Trabalho/);
    expect(res.body.error.message).toMatch(/código IBGE do município/);
    expect(res.body.error.message).toMatch(/Minha conta/);
    expect(res.body.error.details).toMatchObject({ addressId: trabalho, faltando: ['ibge'] });
    nadaAconteceu(item);

    // A tela de endereços da conta completa o que falta (PUT), e o mesmo
    // fechamento passa.
    const editado = await request(app)
      .put(`/api/v1/loja/portal/enderecos/${trabalho}`)
      .set('x-portal-token', token)
      .send({ ...CASA, label: 'Trabalho', kind: 'entrega' });
    expect(editado.status).toBe(200);
    const denovo = await fechar(token, corpo);
    expect(denovo.status, JSON.stringify(denovo.body)).toBe(201);
    expect(pedido(denovo.body.orders[0].id)).toMatchObject({ shipping_city_ibge: '4314407' });
  });

  it('sem número e sem bairro: a recusa nomeia os dois de uma vez', async () => {
    const { token } = await contaNova();
    const semNumero = await salvarEndereco(token, { ...CASA, number: '', district: '' });
    const item = produto(gringa);

    const res = await fechar(token, {
      ...DADOS,
      shippingAddressId: semNumero,
      shippingMethods: { [gringa]: 'tabela_da_loja' },
      items: [{ productId: item, quantity: 1 }],
    });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CHECKOUT_ENDERECO_INCOMPLETO');
    expect(res.body.error.details.faltando).toEqual(['numero', 'bairro']);
    expect(res.body.error.message).toMatch(/número/);
    expect(res.body.error.message).toMatch(/bairro/);
    nadaAconteceu(item);
  });
});

describe('GAP-PRD-028 — o que continua como era', () => {
  it('retirada com conta não pede endereço', async () => {
    const { token } = await contaNova();
    const item = produto(gringa);

    const res = await fechar(token, {
      ...DADOS,
      shippingMethods: { [gringa]: 'retirada' },
      items: [{ productId: item, quantity: 1 }],
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(pedido(res.body.orders[0].id)).toMatchObject({
      shipping_method: 'retirada',
      shipping_address: null,
      shipping_address_id: null,
    });
  });

  it('visitante numa loja que aceita visitante: o endereço digitado continua aceito', async () => {
    abrirParaVisitante(gringa);
    const item = produto(gringa);

    const res = await fechar(null, {
      customerName: 'Visitante da Silva',
      ...VISITANTE,
      shippingZip: '96010-000',
      shippingAddress: 'Rua Digitada, 2 - Centro - Pelotas/RS',
      shippingMethods: { [gringa]: 'tabela_da_loja' },
      items: [{ productId: item, quantity: 1 }],
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(pedido(res.body.orders[0].id)).toMatchObject({
      shipping_method: 'tabela_da_loja',
      shipping_address: 'Rua Digitada, 2 - Centro - Pelotas/RS',
      customer_account_id: null,
    });
  });
});
