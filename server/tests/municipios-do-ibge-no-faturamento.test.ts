/**
 * ============================================================================
 * O ENDEREÇO DA NOTA TAMBÉM CONFERE O CÓDIGO NA TABELA (IBGE-MUNICIPIOS)
 * ============================================================================
 *
 * O item IBGE-MUNICIPIOS fez valer, com a tabela oficial carregada, a regra
 * "o código IBGE tem de existir e ser da UF do endereço" em dois lugares: ao
 * SALVAR o endereço e, no fechamento, no endereço de ENTREGA salvo antes da
 * tabela (que passou só pelo formato).
 *
 * A verificação adversarial achou o terceiro, que ficou de fora — e é o que
 * mais importa para o código IBGE: o endereço de FATURAMENTO. É dele que o
 * pedido tira o retrato `billing_city_ibge`, e é esse retrato que a NF-e do
 * pedido lê (GAP-PRD-115). Um endereço de faturamento salvo antes da tabela,
 * com um código digitado errado que só passou pelo formato (o cliente digitava
 * o código à mão — é a premissa deste item), entrava no pedido com a tabela
 * carregada: a compra fechava, o cliente pagava, e a nota saía com um cMun que
 * não é município nenhum — recusada pela SEFAZ depois de numerada.
 *
 * Com a tabela carregada:
 *   - o endereço de faturamento ESCOLHIDO (`billingAddressId`) com código que
 *     não confere é recusado antes de reservar (422, dizendo qual código e o
 *     que fazer);
 *   - o faturamento PADRÃO da conta (sem `billingAddressId`) não leva um
 *     endereço cujo código não confere — pula para o próximo que serve, ou
 *     fica sem, e a nota do pedido diz que falta, em vez de inventar
 *     município;
 *   - sem a tabela, a regra de antes: o formato basta.
 *
 * FIXTURE: os municípios abaixo são uma AMOSTRA DE TESTE declarada, não a
 * lista oficial do IBGE. "4399999" tem o prefixo do RS e não é município
 * nenhum — é o código digitado errado.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import { confirmarEmail } from '../src/services/core/CustomerPortalService.js';
import { gravarMunicipios } from '../src/services/core/MunicipiosIbge.js';
import { textoDeEntrega } from '../src/services/notifications/EmailService.js';

const app = createApp();
const BASE = '/api/v1/loja/portal';
const SENHA = 'senha-do-cliente-2026';
const CPF = '111.444.777-35';

/** FIXTURE DE TESTE — amostra, não a lista oficial do IBGE. */
const AMOSTRA = [
  { codigo: '4314407', nome: 'Pelotas', uf: 'RS' },
  { codigo: '4314902', nome: 'Porto Alegre', uf: 'RS' },
  { codigo: '3550308', nome: 'São Paulo', uf: 'SP' },
];

/** O código digitado errado: prefixo do RS, município nenhum. */
const CODIGO_ERRADO = '4399999';

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
let n = 0;

function produto(companyId: string): string {
  n += 1;
  const id = `prod-ibge-fat-${n}`;
  const agora = new Date().toISOString();
  const db = getConnection();
  db.prepare(
    `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                price_cents, active, publish_online, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'UN', 4000, 10000, 1, 1, ?, ?)`,
  ).run(id, companyId, `IF-${n}`, `Item ${n}`, agora, agora);
  db.prepare(
    'INSERT INTO core_stock (company_id, product_id, quantity, reserved, updated_at) VALUES (?, ?, 5, 0, ?)',
  ).run(companyId, id, agora);
  return id;
}

async function contaNova(email = 'ana@exemplo.com'): Promise<string> {
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
  return res.body.token as string;
}

function salvar(token: string, corpo: Record<string, unknown>) {
  return request(app).post(`${BASE}/enderecos`).set('x-portal-token', token).send(corpo);
}

/** Retirada na loja (sem `shippingMethods`): a entrega não entra na conta, só a nota. */
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

function pedidos(): number {
  return (getConnection().prepare('SELECT COUNT(*) AS c FROM core_orders').get() as { c: number }).c;
}

function reservado(): number {
  return (getConnection().prepare('SELECT COALESCE(SUM(reserved), 0) AS r FROM core_stock').get() as { r: number }).r;
}

/** Um endereço de faturamento salvo ANTES da tabela: o formato passou. */
async function faturamentoAntigoComCodigoErrado(token: string, extra: Record<string, unknown> = {}) {
  const res = await salvar(token, {
    ...CASA,
    label: 'Escritório',
    kind: 'faturamento',
    street: 'Av. Antiga',
    cityIbge: CODIGO_ERRADO,
    ...extra,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  n = 0;
  gringa = await upsertCompany({ slug: 'gringa-ibge-fat', tradeName: 'Gringa', legalName: 'Gringa Ltda' });
});

describe('sem a tabela, a regra de antes: o formato basta para faturar', () => {
  it('o endereço de faturamento com código de formato certo vai no retrato do pedido', async () => {
    const token = await contaNova();
    const id = await faturamentoAntigoComCodigoErrado(token);
    const res = await comprar(token, { billingAddressId: id });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(pedido(res.body.orders[0].id)).toMatchObject({ billing_city_ibge: CODIGO_ERRADO });
  });
});

describe('com a tabela carregada, o endereço da nota confere o código', () => {
  it('billingAddressId cujo código não é município da UF: 422 antes de reservar, dizendo o código', async () => {
    const token = await contaNova();
    const id = await faturamentoAntigoComCodigoErrado(token);
    gravarMunicipios(AMOSTRA);

    const res = await comprar(token, { billingAddressId: id });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error.code).toBe('CHECKOUT_ENDERECO_INCOMPLETO');
    expect(res.body.error.details).toMatchObject({ addressId: id, faltando: ['ibge'] });
    expect(res.body.error.message).toContain(CODIGO_ERRADO);
    expect(res.body.error.message).toMatch(/Minha conta/);
    expect(pedidos()).toBe(0);
    expect(reservado()).toBe(0);
  });

  it('o faturamento padrão da conta não leva o endereço cujo código não é município — fica sem, e não inventa', async () => {
    const token = await contaNova();
    await faturamentoAntigoComCodigoErrado(token);
    gravarMunicipios(AMOSTRA);

    const res = await comprar(token, {});
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const linha = pedido(res.body.orders[0].id);
    expect(linha.billing_city_ibge).toBeNull();
    expect(linha.billing_street).toBeNull();
  });

  it('o faturamento padrão pula o endereço de código errado e usa o próximo que confere', async () => {
    const token = await contaNova();
    // O primeiro salvo vira o padrão — e é o do código errado.
    await faturamentoAntigoComCodigoErrado(token);
    await salvar(token, { ...CASA, label: 'Fiscal', kind: 'faturamento', street: 'Av. Fiscal', number: '7' });
    gravarMunicipios(AMOSTRA);

    const res = await comprar(token, {});
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(pedido(res.body.orders[0].id)).toMatchObject({
      billing_street: 'Av. Fiscal',
      billing_city_ibge: '4314407',
    });
  });

  it('o endereço de faturamento com o código certo continua passando', async () => {
    const token = await contaNova();
    const certo = await salvar(token, { ...CASA, kind: 'faturamento', street: 'Av. Certa' });
    expect(certo.status).toBe(201);
    gravarMunicipios(AMOSTRA);

    const res = await comprar(token, { billingAddressId: certo.body.id });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(pedido(res.body.orders[0].id)).toMatchObject({ billing_street: 'Av. Certa', billing_city_ibge: '4314407' });
  });

  it('o endereço só de entrega, sem código, continua servindo para entregar (a nota vai noutro)', async () => {
    const token = await contaNova();
    const soEntrega = await salvar(token, { ...CASA, label: 'Trabalho', kind: 'entrega', cityIbge: '' });
    const fatura = await salvar(token, { ...CASA, label: 'Fiscal', kind: 'faturamento', street: 'Av. Fiscal' });
    gravarMunicipios(AMOSTRA);

    const res = await comprar(token, { shippingAddressId: soEntrega.body.id, billingAddressId: fatura.body.id });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(pedido(res.body.orders[0].id)).toMatchObject({ shipping_city_ibge: null, billing_city_ibge: '4314407' });
  });
});
