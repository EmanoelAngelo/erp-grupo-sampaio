/**
 * GAP-PRD-043 e GAP-PRD-028 — A COMPRA É DA CONTA.
 *
 * O que a auditoria mediu no navegador: criar acesso → verificar e-mail →
 * endereço → carrinho → "Pedido #1 registrado" → "Meus pedidos" = "Nenhum
 * pedido ainda". O checkout era rota pública que não lia a sessão do portal;
 * o cadastro criado não era ligado à conta; e a loja não exigia conta,
 * não pré-preenchia nada, não usava o endereço salvo e não tinha regra de
 * "cadastro completo".
 *
 * Este arquivo cobra, pela API:
 *
 *   - o pedido feito logado aparece na conta NA HORA (043);
 *   - comprar exige conta por padrão, e a loja que o dono abrir para
 *     visitante aceita visitante (028, com a decisão registrada);
 *   - a conta precisa do e-mail provado e do cadastro completo, e o checkout
 *     completa o cadastro com o que foi digitado;
 *   - o endereço salvo entra no pedido como cópia.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import { checkout } from '../src/services/core/StorefrontService.js';
import { confirmarEmail } from '../src/services/core/CustomerPortalService.js';
import { loginForTest } from './helpers/auth.js';
import { textoDeEntrega } from '../src/services/notifications/EmailService.js';

const app = createApp();
const SENHA = 'senha-do-cliente-2026';
const CPF = '111.444.777-35';

let gringa: string;
let precoJusto: string;
let n = 0;

function produto(companyId: string): string {
  n += 1;
  const id = `prod-conta-obrig-${n}`;
  const agora = new Date().toISOString();
  const db = getConnection();
  db.prepare(
    `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                price_cents, active, publish_online, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'UN', 4000, 10000, 1, 1, ?, ?)`,
  ).run(id, companyId, `CO-${n}`, `Item ${n}`, agora, agora);
  db.prepare(
    'INSERT INTO core_stock (company_id, product_id, quantity, reserved, updated_at) VALUES (?, ?, 5, 0, ?)',
  ).run(companyId, id, agora);
  return id;
}

function reservado(productId: string): number {
  return (
    getConnection()
      .prepare('SELECT reserved FROM core_stock WHERE product_id = ?')
      .get(productId) as { reserved: number }
  ).reserved;
}

function abrirParaVisitante(companyId: string): void {
  getConnection()
    .prepare(
      `INSERT INTO core_storefront_settings (company_id, banner_active, checkout_mode, updated_at)
       VALUES (?, 0, 'visitante', ?)
       ON CONFLICT (company_id) DO UPDATE SET checkout_mode = 'visitante'`,
    )
    .run(companyId, new Date().toISOString());
}

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

/** A conta NOVA, do jeito que a auditoria fez: registrar e provar a caixa. */
async function contaNova(
  email = 'nova@exemplo.com',
  opcoes: { provar?: boolean } = {},
): Promise<{ token: string; accountId: string }> {
  const res = await request(app)
    .post('/api/v1/loja/portal/registrar')
    .send({ termsAccepted: true, email, password: SENHA });
  expect(res.status).toBe(201);
  const accountId = res.body.account.id as string;
  if (opcoes.provar !== false) provarCaixa(accountId, email);
  return { token: res.body.token as string, accountId };
}

function comprarLogado(
  token: string | null,
  corpo: Record<string, unknown>,
  chave = `k-${Math.random()}`,
) {
  const req = request(app).post('/api/v1/loja/checkout').set('Idempotency-Key', chave);
  if (token) req.set('x-portal-token', token);
  return req.send({ paymentMethod: 'pix', ...corpo });
}

const DADOS = { customerName: 'Ana Nova', customerDocument: CPF, customerPhone: '(53) 99999-0000' };

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
});

describe('GAP-PRD-043 — o pedido feito logado está na conta', () => {
  it('cliente NOVO, logado: compra e vê o pedido em "Meus pedidos" na hora', async () => {
    const { token } = await contaNova();
    const item = produto(gringa);

    const res = await comprarLogado(token, { ...DADOS, items: [{ productId: item, quantity: 1 }] });
    expect(res.status).toBe(201);
    const pedidoId = res.body.orders[0].id as string;

    const lista = await request(app).get('/api/v1/loja/portal/pedidos').set('x-portal-token', token);
    expect(lista.body.items.map((i: { id: string }) => i.id)).toEqual([pedidoId]);

    const detalhe = await request(app)
      .get(`/api/v1/loja/portal/pedidos/${pedidoId}`)
      .set('x-portal-token', token);
    expect(detalhe.status).toBe(200);
  });

  it('o pedido nasce da conta: e-mail PROVADO no pedido, cadastro criado e ligado a ela', async () => {
    const { token, accountId } = await contaNova();
    const res = await comprarLogado(token, {
      ...DADOS,
      // O corpo não escolhe o e-mail do pedido: vale o que a conta provou.
      customerEmail: 'outro@exemplo.com',
      items: [{ productId: produto(gringa), quantity: 1 }],
    });

    const pedido = getConnection()
      .prepare('SELECT customer_id, customer_email, customer_document, customer_account_id FROM core_orders WHERE id = ?')
      .get(res.body.orders[0].id) as Record<string, string>;
    expect(pedido.customer_account_id).toBe(accountId);
    expect(pedido.customer_email).toBe('nova@exemplo.com');
    expect(pedido.customer_document).toBe('11144477735');

    const vinculo = getConnection()
      .prepare('SELECT proof FROM core_customer_account_links WHERE account_id = ? AND customer_id = ?')
      .get(accountId, pedido.customer_id) as { proof: string } | undefined;
    expect(vinculo?.proof).toBe('checkout');
    const cadastro = getConnection()
      .prepare('SELECT email, origin FROM core_customers WHERE id = ?')
      .get(pedido.customer_id) as { email: string; origin: string };
    expect(cadastro).toEqual({ email: 'nova@exemplo.com', origin: 'loja_online' });
  });

  it('carrinho de duas lojas: os dois pedidos estão na conta', async () => {
    const { token } = await contaNova();
    const res = await comprarLogado(token, {
      ...DADOS,
      items: [
        { productId: produto(gringa), quantity: 1 },
        { productId: produto(precoJusto), quantity: 1 },
      ],
    });
    expect(res.status).toBe(201);
    const lista = await request(app).get('/api/v1/loja/portal/pedidos').set('x-portal-token', token);
    expect(lista.body.items).toHaveLength(2);
  });

  it('a segunda compra usa o MESMO cadastro — o que já é da conta', async () => {
    const { token } = await contaNova();
    const a = await comprarLogado(token, { ...DADOS, items: [{ productId: produto(gringa), quantity: 1 }] });
    const b = await comprarLogado(token, { items: [{ productId: produto(gringa), quantity: 1 }] });
    expect(b.status).toBe(201);

    const clientes = getConnection()
      .prepare('SELECT customer_id FROM core_orders WHERE id IN (?, ?)')
      .all(a.body.orders[0].id, b.body.orders[0].id) as { customer_id: string }[];
    expect(new Set(clientes.map((c) => c.customer_id)).size).toBe(1);
  });
});

describe('GAP-PRD-028 — comprar exige conta (padrão), e o dono decide abrir', () => {
  it('sem sessão, a loja que não decidiu nada recusa ANTES de reservar', async () => {
    const item = produto(gringa);
    const res = await comprarLogado(null, { ...DADOS, customerEmail: 'x@exemplo.com', items: [{ productId: item, quantity: 1 }] });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('CHECKOUT_CONTA_OBRIGATORIA');
    expect(reservado(item)).toBe(0);
    const pedidos = getConnection().prepare('SELECT COUNT(*) c FROM core_orders').get() as { c: number };
    expect(pedidos.c).toBe(0);
  });

  it('a loja que o dono abriu para visitante aceita quem compra sem conta', async () => {
    abrirParaVisitante(gringa);
    const res = await comprarLogado(null, {
      ...DADOS,
      customerEmail: 'visitante@exemplo.com',
      items: [{ productId: produto(gringa), quantity: 1 }],
    });
    expect(res.status).toBe(201);
  });

  it('carrinho misto: basta uma loja exigir conta para o visitante ser recusado', async () => {
    abrirParaVisitante(gringa);
    const res = await comprarLogado(null, {
      ...DADOS,
      items: [
        { productId: produto(gringa), quantity: 1 },
        { productId: produto(precoJusto), quantity: 1 },
      ],
    });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('CHECKOUT_CONTA_OBRIGATORIA');
  });

  it('a cotação de frete diz, loja por loja, quem exige conta', async () => {
    abrirParaVisitante(gringa);
    const res = await request(app)
      .post('/api/v1/loja/checkout/frete')
      .send({
        items: [
          { productId: produto(gringa), quantity: 1 },
          { productId: produto(precoJusto), quantity: 1 },
        ],
      });
    expect(res.status).toBe(200);
    const porLoja = Object.fromEntries(
      (res.body.lojas as { companyId: string; exigeConta: boolean }[]).map((l) => [l.companyId, l.exigeConta]),
    );
    expect(porLoja).toEqual({ [gringa]: false, [precoJusto]: true });
    expect(res.body.exigeConta).toBe(true);
  });

  it('token vencido não vira compra de visitante — é 401, e o pedido não some da conta', async () => {
    abrirParaVisitante(gringa);
    const { token } = await contaNova();
    getConnection()
      .prepare('UPDATE core_customer_sessions SET expires_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 1000).toISOString(), token);

    const res = await comprarLogado(token, { ...DADOS, items: [{ productId: produto(gringa), quantity: 1 }] });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('PORTAL_UNAUTHENTICATED');
  });
});

describe('GAP-PRD-028 — cadastro completo antes de fechar', () => {
  it('e-mail ainda não provado: 403, nada reservado', async () => {
    const { token } = await contaNova('semprova@exemplo.com', { provar: false });
    const item = produto(gringa);
    const res = await comprarLogado(token, { ...DADOS, items: [{ productId: item, quantity: 1 }] });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PORTAL_EMAIL_NAO_VERIFICADO');
    expect(reservado(item)).toBe(0);
  });

  it('sem nome, documento e telefone: 422 dizendo o que falta, nada reservado, nada gravado', async () => {
    const { token } = await contaNova();
    const item = produto(gringa);
    const res = await comprarLogado(token, { customerName: 'Só o Nome', items: [{ productId: item, quantity: 1 }] });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PORTAL_CADASTRO_INCOMPLETO');
    expect(res.body.error.details.faltando).toEqual(['documento', 'telefone']);
    expect(reservado(item)).toBe(0);
    // A recusa não guardou o nome pela metade.
    const conta = getConnection()
      .prepare('SELECT name FROM core_customer_accounts WHERE email = ?')
      .get('nova@exemplo.com') as { name: string | null };
    expect(conta.name).toBeNull();
  });

  it('CPF com dígito errado é recusado antes de reservar', async () => {
    const { token } = await contaNova();
    const res = await comprarLogado(token, {
      ...DADOS,
      customerDocument: '111.444.777-00',
      items: [{ productId: produto(gringa), quantity: 1 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PORTAL_INVALID_DOCUMENT');
  });

  it('o checkout COMPLETA o cadastro da conta com o que foi digitado', async () => {
    const { token } = await contaNova();
    await comprarLogado(token, { ...DADOS, items: [{ productId: produto(gringa), quantity: 1 }] });

    const perfil = await request(app).get('/api/v1/loja/portal/perfil').set('x-portal-token', token);
    expect(perfil.body).toMatchObject({
      name: 'Ana Nova',
      phone: '(53) 99999-0000',
      hasDocument: true,
      documentMasked: '••• 7735',
      faltando: [],
    });
  });

  it('perfil completo: a compra seguinte não precisa de nenhum campo', async () => {
    const { token } = await contaNova();
    await request(app)
      .put('/api/v1/loja/portal/perfil')
      .set('x-portal-token', token)
      .send({ name: 'Ana Nova', phone: '53999990000', document: CPF });

    const res = await comprarLogado(token, { items: [{ productId: produto(gringa), quantity: 1 }] });
    expect(res.status).toBe(201);
    const pedido = getConnection()
      .prepare('SELECT customer_name FROM core_orders WHERE id = ?')
      .get(res.body.orders[0].id) as { customer_name: string };
    expect(pedido.customer_name).toBe('Ana Nova');
  });

  it('documento diferente do da conta: 409 — a nota sai no documento da conta', async () => {
    const { token } = await contaNova();
    await request(app)
      .put('/api/v1/loja/portal/perfil')
      .set('x-portal-token', token)
      .send({ name: 'Ana Nova', phone: '53999990000', document: CPF });

    const res = await comprarLogado(token, {
      customerDocument: '529.982.247-25',
      items: [{ productId: produto(gringa), quantity: 1 }],
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CHECKOUT_DOCUMENTO_DIFERENTE');
  });
});

describe('GAP-PRD-028 — o endereço salvo entra no pedido', () => {
  async function comEndereco(token: string): Promise<string> {
    const res = await request(app)
      .post('/api/v1/loja/portal/enderecos')
      .set('x-portal-token', token)
      .send({
        label: 'Casa',
        zip: '96010-000',
        street: 'Rua XV de Novembro',
        number: '500',
        district: 'Centro',
        city: 'Pelotas',
        state: 'RS',
        cityIbge: '4314407',
      });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  it('shippingAddressId: o pedido guarda a CÓPIA do endereço salvo e o CEP dele', async () => {
    const { token } = await contaNova();
    const enderecoId = await comEndereco(token);

    const res = await comprarLogado(token, {
      ...DADOS,
      shippingAddressId: enderecoId,
      // O texto digitado não vale quando há endereço salvo escolhido.
      shippingAddress: 'Rua Digitada, 2',
      items: [{ productId: produto(gringa), quantity: 1 }],
    });
    expect(res.status).toBe(201);

    const pedido = getConnection()
      .prepare('SELECT shipping_address, shipping_zip FROM core_orders WHERE id = ?')
      .get(res.body.orders[0].id) as { shipping_address: string; shipping_zip: string };
    expect(pedido.shipping_zip).toBe('96010000');
    expect(pedido.shipping_address).toBe(
      'Rua XV de Novembro, 500 · Centro · Pelotas/RS · CEP 96010-000',
    );

    // Remover o endereço depois não reescreve para onde o pedido foi.
    await request(app).delete(`/api/v1/loja/portal/enderecos/${enderecoId}`).set('x-portal-token', token);
    const depois = getConnection()
      .prepare('SELECT shipping_address FROM core_orders WHERE id = ?')
      .get(res.body.orders[0].id) as { shipping_address: string };
    expect(depois.shipping_address).toBe(pedido.shipping_address);
  });

  it('endereço de OUTRA conta é 404, e nada é reservado', async () => {
    const { token: tokenAna } = await contaNova('ana@exemplo.com');
    const enderecoDaAna = await comEndereco(tokenAna);
    const { token: tokenBia } = await contaNova('bia@exemplo.com');
    const item = produto(gringa);

    const res = await comprarLogado(tokenBia, {
      ...DADOS,
      shippingAddressId: enderecoDaAna,
      items: [{ productId: item, quantity: 1 }],
    });
    expect(res.status).toBe(404);
    expect(reservado(item)).toBe(0);
  });
});

describe('GAP-PRD-006 — com conta, o CPF alheio também não sequestra', () => {
  it('conta que compra com o CPF de outra pessoa: o pedido usa o cadastro fiscal, sem ligar nem alterar', async () => {
    abrirParaVisitante(gringa);
    // A vítima comprou antes, com o e-mail dela.
    const [daVitima] = checkout({
      idempotencyKey: 'vitima-1',
      customerName: 'Vítima',
      customerEmail: 'vitima@exemplo.com',
      customerDocument: CPF,
      customerPhone: '11999990000',
      paymentMethod: 'pix',
      items: [{ productId: produto(gringa), quantity: 1 }],
    });
    const { token, accountId } = await contaNova('atacante@exemplo.com');

    const res = await comprarLogado(token, {
      customerName: 'Atacante',
      customerDocument: CPF,
      customerPhone: '11888880000',
      items: [{ productId: produto(gringa), quantity: 1 }],
    });
    expect(res.status).toBe(201);

    const cadastro = getConnection()
      .prepare("SELECT id, email, phone, name FROM core_customers WHERE company_id = ? AND document = '11144477735'")
      .get(gringa) as { id: string; email: string; phone: string; name: string };
    expect(cadastro).toMatchObject({ email: 'vitima@exemplo.com', phone: '11999990000', name: 'Vítima' });
    const vinculos = getConnection()
      .prepare('SELECT COUNT(*) c FROM core_customer_account_links WHERE account_id = ?')
      .get(accountId) as { c: number };
    expect(vinculos.c).toBe(0);

    // O atacante vê o pedido DELE — e só ele.
    const lista = await request(app).get('/api/v1/loja/portal/pedidos').set('x-portal-token', token);
    const ids = lista.body.items.map((i: { id: string }) => i.id);
    expect(ids).toEqual([res.body.orders[0].id]);
    expect(ids).not.toContain(daVitima.id);
  });

  it('cadastro com o e-mail PROVADO da conta e o mesmo documento: co-prova, liga e usa', async () => {
    abrirParaVisitante(gringa);
    checkout({
      idempotencyKey: 'antes-da-conta',
      customerName: 'Ana de Antes',
      customerEmail: 'nova@exemplo.com',
      customerDocument: CPF,
      paymentMethod: 'pix',
      items: [{ productId: produto(gringa), quantity: 1 }],
    });
    const { token, accountId } = await contaNova('nova@exemplo.com');

    const res = await comprarLogado(token, { ...DADOS, items: [{ productId: produto(gringa), quantity: 1 }] });
    expect(res.status).toBe(201);
    const vinculo = getConnection()
      .prepare('SELECT proof FROM core_customer_account_links WHERE account_id = ?')
      .get(accountId) as { proof: string };
    expect(vinculo.proof).toBe('coprova');
  });
});

describe('GAP-PRD-028 — a decisão do dono tem tela, permissão e trilha', () => {
  async function gerente() {
    const res = await loginForTest(app, {
      userId: 'gerente-da-gringa',
      companyId: 'loja-politica',
      profileCodes: ['gerente_loja'],
    });
    return { Authorization: `Bearer ${res.body.accessToken}` };
  }

  it('nasce no padrão seguro ("conta"), declarado como não configurado', async () => {
    const auth = await gerente();
    const res = await request(app).get('/api/v1/core/storefront/checkout-policy').set(auth);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mode: 'conta', padrao: 'conta', configurado: false });
  });

  it('o gerente abre para visitante, a vitrine obedece, e a troca fica na trilha', async () => {
    const auth = await gerente();
    const put = await request(app)
      .put('/api/v1/core/storefront/checkout-policy')
      .set(auth)
      .send({ mode: 'visitante' });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ mode: 'visitante', configurado: true });

    const trilha = getConnection()
      .prepare(
        "SELECT detail FROM core_audit_log WHERE action = 'storefront.checkout_mode_updated' AND company_id = 'loja-politica'",
      )
      .get() as { detail: string };
    expect(JSON.parse(trilha.detail)).toEqual({ antes: 'conta', depois: 'visitante' });

    const item = produto('loja-politica');
    const compra = await comprarLogado(null, {
      ...DADOS,
      customerEmail: 'v@exemplo.com',
      items: [{ productId: item, quantity: 1 }],
    });
    expect(compra.status).toBe(201);
  });

  it('valor desconhecido é recusado sem gravar', async () => {
    const auth = await gerente();
    const res = await request(app)
      .put('/api/v1/core/storefront/checkout-policy')
      .set(auth)
      .send({ mode: 'qualquer-um' });
    expect(res.status).toBe(400);
    const depois = await request(app).get('/api/v1/core/storefront/checkout-policy').set(auth);
    expect(depois.body.mode).toBe('conta');
  });

  it('quem não gerencia a loja não troca a política', async () => {
    const res = await loginForTest(app, {
      userId: 'caixa-da-gringa',
      companyId: 'loja-politica',
      profileCodes: ['operador_caixa_loja'],
    });
    const put = await request(app)
      .put('/api/v1/core/storefront/checkout-policy')
      .set({ Authorization: `Bearer ${res.body.accessToken}` })
      .send({ mode: 'visitante' });
    expect(put.status).toBe(403);
  });
});
