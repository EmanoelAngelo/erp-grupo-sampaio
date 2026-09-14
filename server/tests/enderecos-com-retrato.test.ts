/**
 * GAP-PRD-115 — O ENDEREÇO DA CONTA SE EDITA, TEM TIPO E DESTINATÁRIO, E O
 * PEDIDO GUARDA O RETRATO EM COLUNAS.
 *
 * A auditoria achou: `PUT /loja/portal/enderecos/:id` = 404 (corrigir o
 * número exigia apagar e recriar); nenhum tipo (entrega × faturamento) nem
 * nome de destinatário; IBGE opcional até para faturar; e o pedido guardava
 * o endereço como UMA linha de texto — a NF-e do pedido quer logradouro,
 * número, bairro, município com IBGE e UF em campos, e ia buscá-los no
 * endereço VIVO da conta (que muda depois da compra).
 *
 * A regra:
 *   - PUT edita o endereço inteiro (só o da própria conta; o de outra é 404);
 *   - `kind`: 'entrega', 'faturamento' ou 'ambos'. Servir para FATURAR exige
 *     o código IBGE (7 dígitos, com o prefixo da UF); sem IBGE o endereço
 *     nasce só de entrega;
 *   - `recipientName`: quem recebe (opcional; vazio = o nome da conta);
 *   - o checkout escolhe o de entrega e o de faturamento, e o pedido guarda
 *     o RETRATO dos dois em colunas — editar ou apagar o endereço depois não
 *     muda o pedido, e a NF-e do pedido lê o retrato.
 */
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import { confirmarEmail } from '../src/services/core/CustomerPortalService.js';
import { recipientForOrder } from '../src/services/core/OrderInvoiceService.js';
import { textoDeEntrega } from '../src/services/notifications/EmailService.js';

const app = createApp();
const BASE = '/api/v1/loja/portal';
const SENHA = 'senha-do-cliente-2026';
const CPF = '111.444.777-35';

let gringa: string;
let n = 0;

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

function produto(companyId: string): string {
  n += 1;
  const id = `prod-end-${n}`;
  const agora = new Date().toISOString();
  const db = getConnection();
  db.prepare(
    `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                price_cents, active, publish_online, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'UN', 4000, 10000, 1, 1, ?, ?)`,
  ).run(id, companyId, `EN-${n}`, `Item ${n}`, agora, agora);
  db.prepare(
    'INSERT INTO core_stock (company_id, product_id, quantity, reserved, updated_at) VALUES (?, ?, 5, 0, ?)',
  ).run(companyId, id, agora);
  return id;
}

async function contaNova(email = 'ana@exemplo.com'): Promise<{ token: string; accountId: string }> {
  const res = await request(app)
    .post(`${BASE}/registrar`)
    .send({ termsAccepted: true, email, password: SENHA, name: 'Ana da Conta' });
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

function salvar(token: string, corpo: Record<string, unknown>) {
  return request(app).post(`${BASE}/enderecos`).set('x-portal-token', token).send(corpo);
}

function editar(token: string, id: string, corpo: Record<string, unknown>) {
  return request(app).put(`${BASE}/enderecos/${id}`).set('x-portal-token', token).send(corpo);
}

function comprar(token: string, corpo: Record<string, unknown>) {
  return request(app)
    .post('/api/v1/loja/checkout')
    .set('Idempotency-Key', `k-${Math.random()}`)
    .set('x-portal-token', token)
    .send({
      paymentMethod: 'pix',
      customerDocument: CPF,
      customerPhone: '(53) 99999-0000',
      items: [{ productId: produto(gringa), quantity: 1 }],
      ...corpo,
    });
}

function pedido(id: string): Record<string, unknown> {
  return getConnection().prepare('SELECT * FROM core_orders WHERE id = ?').get(id) as Record<string, unknown>;
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  n = 0;
  gringa = await upsertCompany({ slug: 'gringa', tradeName: 'Gringa', legalName: 'Gringa Ltda' });
});

describe('GAP-PRD-115 — editar o endereço', () => {
  it('PUT corrige número e complemento sem apagar e recriar', async () => {
    const { token } = await contaNova();
    const salvo = await salvar(token, CASA);
    expect(salvo.status).toBe(201);

    const res = await editar(token, salvo.body.id, { ...CASA, number: '502', complement: 'fundos' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const lista = await request(app).get(`${BASE}/enderecos`).set('x-portal-token', token);
    expect(lista.body.items).toHaveLength(1);
    expect(lista.body.items[0]).toMatchObject({ id: salvo.body.id, number: '502', complement: 'fundos' });
  });

  it('PUT no endereço de OUTRA conta é 404 e não muda nada', async () => {
    const { token: ana } = await contaNova('ana@exemplo.com');
    const { token: bia } = await contaNova('bia@exemplo.com');
    const daAna = await salvar(ana, CASA);

    const res = await editar(bia, daAna.body.id, { ...CASA, number: '1' });
    expect(res.status).toBe(404);
    const linha = getConnection()
      .prepare('SELECT number FROM core_customer_addresses WHERE id = ?')
      .get(daAna.body.id) as { number: string };
    expect(linha.number).toBe('500');
  });

  it('PUT valida como o POST (CEP torto é 400) e pode tornar o endereço o padrão', async () => {
    const { token } = await contaNova();
    const a = await salvar(token, CASA);
    const b = await salvar(token, { ...CASA, label: 'Trabalho', number: '10' });
    expect((await editar(token, b.body.id, { ...CASA, zip: '123' })).status).toBe(400);

    const res = await editar(token, b.body.id, { ...CASA, label: 'Trabalho', number: '10', isDefault: true });
    expect(res.status).toBe(200);
    const lista = await request(app).get(`${BASE}/enderecos`).set('x-portal-token', token);
    const padrao = lista.body.items.filter((e: { isDefault: boolean }) => e.isDefault);
    expect(padrao.map((e: { id: string }) => e.id)).toEqual([b.body.id]);
    expect(lista.body.items.find((e: { id: string }) => e.id === a.body.id).isDefault).toBe(false);
  });
});

describe('GAP-PRD-115 — tipo, destinatário e IBGE para faturar', () => {
  it('sem tipo: com IBGE serve para entrega e faturamento; sem IBGE, só entrega', async () => {
    const { token } = await contaNova();
    const com = await salvar(token, CASA);
    const sem = await salvar(token, { ...CASA, label: 'Sítio', cityIbge: '' });
    expect(com.body.kind).toBe('ambos');
    expect(sem.body.kind).toBe('entrega');
  });

  it('faturamento (ou ambos) SEM IBGE é recusado: a nota não sai sem ele', async () => {
    const { token } = await contaNova();
    for (const kind of ['faturamento', 'ambos']) {
      const res = await salvar(token, { ...CASA, cityIbge: '', kind });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('PORTAL_IBGE_OBRIGATORIO');
    }
  });

  it('IBGE de outra UF é recusado (4314407 é RS; 3550308 é SP)', async () => {
    const { token } = await contaNova();
    const res = await salvar(token, { ...CASA, cityIbge: '3550308' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PORTAL_INVALID_ADDRESS');
    expect(res.body.error.message).toMatch(/RS/);
  });

  it('tipo desconhecido é recusado', async () => {
    const { token } = await contaNova();
    expect((await salvar(token, { ...CASA, kind: 'cobranca' })).status).toBe(400);
  });

  it('o destinatário é guardado e volta na lista', async () => {
    const { token } = await contaNova();
    const res = await salvar(token, { ...CASA, recipientName: 'Maria (portaria)' });
    expect(res.body.recipientName).toBe('Maria (portaria)');
  });
});

describe('GAP-PRD-115 — o pedido guarda o retrato em colunas', () => {
  it('entrega e faturamento viram colunas; editar e apagar o endereço depois não mudam o pedido', async () => {
    const { token } = await contaNova();
    const casa = await salvar(token, { ...CASA, recipientName: 'Maria Recebedora' });

    const res = await comprar(token, { shippingAddressId: casa.body.id });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const orderId = res.body.orders[0].id as string;

    const antes = pedido(orderId);
    expect(antes).toMatchObject({
      shipping_address_id: casa.body.id,
      shipping_recipient_name: 'Maria Recebedora',
      shipping_street: 'Rua XV de Novembro',
      shipping_number: '500',
      shipping_complement: 'ap 12',
      shipping_district: 'Centro',
      shipping_city: 'Pelotas',
      shipping_state: 'RS',
      shipping_city_ibge: '4314407',
      shipping_zip: '96010000',
      // O endereço "ambos" escolhido para entregar também fatura.
      billing_address_id: casa.body.id,
      billing_name: 'Ana da Conta',
      billing_street: 'Rua XV de Novembro',
      billing_number: '500',
      billing_city_ibge: '4314407',
      billing_state: 'RS',
      billing_zip: '96010000',
    });
    // A linha de texto continua (etiqueta, telas antigas), no formato de sempre.
    expect(antes.shipping_address).toBe(
      'Rua XV de Novembro, 500 — ap 12 · Centro · Pelotas/RS · CEP 96010-000',
    );

    await editar(token, casa.body.id, { ...CASA, number: '999', street: 'Outra Rua' });
    expect(pedido(orderId)).toMatchObject({ shipping_number: '500', billing_street: 'Rua XV de Novembro' });
    await request(app).delete(`${BASE}/enderecos/${casa.body.id}`).set('x-portal-token', token);
    expect(pedido(orderId)).toMatchObject({ shipping_street: 'Rua XV de Novembro', billing_number: '500' });

    // A NF-e do pedido lê o RETRATO — não o endereço vivo (que nem existe mais).
    const dest = recipientForOrder(gringa, orderId)!;
    expect(dest).toMatchObject({
      name: 'Ana da Conta',
      street: 'Rua XV de Novembro',
      number: '500',
      district: 'Centro',
      cityName: 'Pelotas',
      cityIbge: '4314407',
      uf: 'RS',
      zip: '96010000',
    });
  });

  it('entrega num endereço, faturamento em outro (billingAddressId)', async () => {
    const { token } = await contaNova();
    const entrega = await salvar(token, { ...CASA, label: 'Trabalho', kind: 'entrega', cityIbge: '' });
    const fatura = await salvar(token, {
      ...CASA,
      label: 'Escritório fiscal',
      kind: 'faturamento',
      street: 'Av. Bento Gonçalves',
      number: '1',
    });

    const res = await comprar(token, { shippingAddressId: entrega.body.id, billingAddressId: fatura.body.id });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(pedido(res.body.orders[0].id)).toMatchObject({
      shipping_street: 'Rua XV de Novembro',
      shipping_city_ibge: null,
      billing_street: 'Av. Bento Gonçalves',
      billing_city_ibge: '4314407',
    });
  });

  it('sem billingAddressId e com entrega só de entrega: fatura no endereço de faturamento da conta', async () => {
    const { token } = await contaNova();
    const entrega = await salvar(token, { ...CASA, kind: 'entrega', cityIbge: '' });
    await salvar(token, { ...CASA, kind: 'faturamento', street: 'Av. Fiscal', number: '7' });

    const res = await comprar(token, { shippingAddressId: entrega.body.id });
    expect(pedido(res.body.orders[0].id)).toMatchObject({ billing_street: 'Av. Fiscal', billing_number: '7' });
  });

  it('retirada na loja também fatura no endereço da conta (a NF-e precisa dele)', async () => {
    const { token } = await contaNova();
    await salvar(token, CASA);
    const res = await comprar(token, {});
    expect(res.status).toBe(201);
    expect(pedido(res.body.orders[0].id)).toMatchObject({
      shipping_street: null,
      billing_street: 'Rua XV de Novembro',
      billing_city_ibge: '4314407',
    });
  });

  it('usar o endereço para o que o tipo não permite é 422, antes de reservar', async () => {
    const { token } = await contaNova();
    const soFatura = await salvar(token, { ...CASA, kind: 'faturamento' });
    const soEntrega = await salvar(token, { ...CASA, kind: 'entrega', cityIbge: '' });

    const r1 = await comprar(token, { shippingAddressId: soFatura.body.id });
    expect(r1.status).toBe(422);
    expect(r1.body.error.code).toBe('CHECKOUT_ENDERECO_TIPO');
    const r2 = await comprar(token, { shippingAddressId: soEntrega.body.id, billingAddressId: soEntrega.body.id });
    expect(r2.status).toBe(422);
    expect(getConnection().prepare('SELECT COUNT(*) c FROM core_orders').get()).toEqual({ c: 0 });
  });

  it('billingAddressId de OUTRA conta é 404', async () => {
    const { token: ana } = await contaNova('ana@exemplo.com');
    const { token: bia } = await contaNova('bia@exemplo.com');
    const daAna = await salvar(ana, CASA);
    const res = await comprar(bia, { billingAddressId: daAna.body.id });
    expect(res.status).toBe(404);
  });

  it('o detalhe do pedido na conta mostra os dois endereços em campos', async () => {
    const { token } = await contaNova();
    const casa = await salvar(token, CASA);
    const res = await comprar(token, { shippingAddressId: casa.body.id });
    const detalhe = await request(app)
      .get(`${BASE}/pedidos/${res.body.orders[0].id}`)
      .set('x-portal-token', token);
    expect(detalhe.status).toBe(200);
    expect(detalhe.body.shippingAddressDetail).toMatchObject({
      recipientName: 'Ana da Conta',
      street: 'Rua XV de Novembro',
      number: '500',
      city: 'Pelotas',
      state: 'RS',
      zip: '96010000',
    });
    expect(detalhe.body.billingAddress).toMatchObject({ name: 'Ana da Conta', cityIbge: '4314407' });
  });
});
