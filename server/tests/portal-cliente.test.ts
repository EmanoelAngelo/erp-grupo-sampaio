/**
 * Portal do cliente.
 *
 * O que este arquivo cobra, acima de tudo: CONHECER O ID DE UM PEDIDO NÃO DÁ
 * ACESSO A ELE. Foi assim que a rota pública antiga funcionava — quem tivesse
 * o UUID lia o pedido inteiro, com nome, documento e endereço de outra pessoa.
 *
 * Também se cobra a separação de contextos: uma sessão de cliente não pode
 * valer no ERP, e um token administrativo não pode abrir o portal. Misturar
 * daria escopo de PDV ou de gerente a quem só comprou uma jaqueta.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
// O código e o link moram selados fora do corpo da fila (GAP-PRD-007): o
// teste lê o e-mail como o CLIENTE o recebe, pela montagem do carteiro.
import { textoDeEntrega } from '../src/services/notifications/EmailService.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import { checkout } from '../src/services/core/StorefrontService.js';
import { createPaymentIntent, handlePaymentWebhook } from '../src/services/core/PaymentService.js';
import { upsertAsaasWebhookToken } from '../src/services/integrations/AsaasCredentialService.js';
import { confirmarEmail, resolveCustomerSession } from '../src/services/core/CustomerPortalService.js';

const app = createApp();
const SENHA = 'senha-do-cliente-2026';
const TOKEN_WEBHOOK = 'token-webhook-portal';

let gringa: string;
let precoJusto: string;
let n = 0;

function produto(companyId: string): string {
  n += 1;
  const id = `prod-portal-${n}`;
  const agora = new Date().toISOString();
  const db = getConnection();
  db.prepare(
    `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                price_cents, active, publish_online, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'UN', 4000, 10000, 1, 1, ?, ?)`,
  ).run(id, companyId, `PT-${n}`, `Item ${n}`, agora, agora);
  db.prepare(
    'INSERT INTO core_stock (company_id, product_id, quantity, reserved, updated_at) VALUES (?, ?, 20, 0, ?)',
  ).run(companyId, id, agora);
  return id;
}

/** Compra de verdade: é ela que cria o cadastro do cliente na operação. */
function comprar(input: {
  companyId: string;
  email: string;
  documento: string;
  chave: string;
}): { orderId: string } {
  const [pedido] = checkout({
    idempotencyKey: input.chave,
    customerName: 'Cliente do Portal',
    customerEmail: input.email,
    customerDocument: input.documento,
    paymentMethod: 'pix',
    items: [{ productId: produto(input.companyId), quantity: 1 }],
  });
  return { orderId: pedido.id };
}

async function criarAcesso(email: string, documento: string) {
  const res = await request(app)
    .post('/api/v1/loja/portal/registrar')
    .send({ termsAccepted: true, email, document: documento, password: SENHA });
  expect(res.status).toBe(201);
  // Rodada 50: a co-prova espera o código — este arquivo testa o que vem
  // DEPOIS da prova, então prova a caixa na hora, como o dono dela faria.
  provarCaixa(res.body.account.id as string, email);
  return res.body.token as string;
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
  expect(codigo, 'codigo de verificacao ausente na fila').toBeTruthy(); confirmarEmail({ accountId, codigo });
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
  upsertAsaasWebhookToken({ companyId: gringa, webhookToken: TOKEN_WEBHOOK });
});

describe('criar acesso', () => {
  it('cria a conta mesmo sem compra anterior — cadastro aberto na rodada 38', async () => {
    // Até a rodada 38 isto respondia 404 PORTAL_CUSTOMER_NOT_FOUND: o cadastro
    // EXIGIA uma compra com o mesmo e-mail e documento. O portal nascia
    // inacessível (0 contas, 1 cliente elegível). Agora a conta nasce, e o que
    // continua exigindo a co-prova é VINCULAR os pedidos — não criar a conta.
    const res = await request(app)
      .post('/api/v1/loja/portal/registrar')
      .send({ termsAccepted: true, email: 'ninguem@exemplo.com', document: '111.444.777-35', password: SENHA });

    expect(res.status).toBe(201);
    expect(res.body.token).toBeTruthy();
    // Documento que não co-bate compra nenhuma: a conta nasce vazia.
    const pedidos = await request(app)
      .get('/api/v1/loja/portal/pedidos')
      .set('x-portal-token', res.body.token);
    expect(pedidos.body.items).toEqual([]);
  });

  it('com a compra feita, cria e já devolve sessão', async () => {
    comprar({ companyId: gringa, email: 'ana@exemplo.com', documento: '111.444.777-35', chave: 'c1' });

    const res = await request(app)
      .post('/api/v1/loja/portal/registrar')
      .send({ termsAccepted: true, email: 'ana@exemplo.com', document: '111.444.777-35', password: SENHA });

    expect(res.status).toBe(201);
    expect(res.body.token).toBeTruthy();
    expect(res.body.account.email).toBe('ana@exemplo.com');
  });

  it('recusa senha curta — e não cria conta pela metade', async () => {
    comprar({ companyId: gringa, email: 'ana@exemplo.com', documento: '111.444.777-35', chave: 'c2' });

    const res = await request(app)
      .post('/api/v1/loja/portal/registrar')
      .send({ termsAccepted: true, email: 'ana@exemplo.com', document: '111.444.777-35', password: '123' });

    expect(res.status).toBe(400);
    const contas = getConnection()
      .prepare('SELECT COUNT(*) c FROM core_customer_accounts')
      .get() as { c: number };
    expect(contas.c).toBe(0);
  });

  it('não cria duas contas para o mesmo e-mail', async () => {
    comprar({ companyId: gringa, email: 'ana@exemplo.com', documento: '111.444.777-35', chave: 'c3' });
    await criarAcesso('ana@exemplo.com', '111.444.777-35');

    const res = await request(app)
      .post('/api/v1/loja/portal/registrar')
      .send({ termsAccepted: true, email: 'ana@exemplo.com', document: '111.444.777-35', password: SENHA });

    expect(res.status).toBe(409);
  });

  it('a senha NUNCA volta pela API', async () => {
    comprar({ companyId: gringa, email: 'ana@exemplo.com', documento: '111.444.777-35', chave: 'c4' });

    const res = await request(app)
      .post('/api/v1/loja/portal/registrar')
      .send({ termsAccepted: true, email: 'ana@exemplo.com', document: '111.444.777-35', password: SENHA });

    expect(JSON.stringify(res.body)).not.toContain(SENHA);
    expect(JSON.stringify(res.body)).not.toContain('password');
  });
});

describe('entrar', () => {
  beforeEach(() => {
    comprar({ companyId: gringa, email: 'ana@exemplo.com', documento: '111.444.777-35', chave: 'e1' });
  });

  it('com a senha certa, abre sessão', async () => {
    await criarAcesso('ana@exemplo.com', '111.444.777-35');

    const res = await request(app)
      .post('/api/v1/loja/portal/entrar')
      .send({ email: 'ana@exemplo.com', password: SENHA });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
  });

  it('senha errada é recusada sem dizer se a conta existe', async () => {
    await criarAcesso('ana@exemplo.com', '111.444.777-35');

    const existente = await request(app)
      .post('/api/v1/loja/portal/entrar')
      .send({ email: 'ana@exemplo.com', password: 'errada-mas-longa' });
    const inexistente = await request(app)
      .post('/api/v1/loja/portal/entrar')
      .send({ email: 'nao-existe@exemplo.com', password: 'errada-mas-longa' });

    expect(existente.status).toBe(401);
    expect(inexistente.status).toBe(401);
    // Mesma mensagem: a diferença diria quais e-mails têm conta.
    expect(existente.body.error.message).toBe(inexistente.body.error.message);
  });

  it('tentativas repetidas travam a conta', async () => {
    await criarAcesso('ana@exemplo.com', '111.444.777-35');

    let ultimo = 0;
    for (let i = 0; i < 8; i += 1) {
      const r = await request(app)
        .post('/api/v1/loja/portal/entrar')
        .send({ email: 'ana@exemplo.com', password: `errada-${i}` });
      ultimo = r.status;
    }

    expect(ultimo).toBe(429);
  });
});

describe('meus pedidos', () => {
  it('sem sessão, não lista nada', async () => {
    const res = await request(app).get('/api/v1/loja/portal/pedidos');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('PORTAL_UNAUTHENTICATED');
  });

  it('lista os pedidos da pessoa, mais recente primeiro', async () => {
    comprar({ companyId: gringa, email: 'ana@exemplo.com', documento: '111.444.777-35', chave: 'p1' });
    comprar({ companyId: gringa, email: 'ana@exemplo.com', documento: '111.444.777-35', chave: 'p2' });
    const token = await criarAcesso('ana@exemplo.com', '111.444.777-35');

    const res = await request(app).get('/api/v1/loja/portal/pedidos').set('x-portal-token', token);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    // Estado em português, nunca o enum cru.
    expect(res.body.items[0].statusLabel).toBe('Aguardando pagamento');
  });

  it('a pessoa que comprou em duas operações vê os dois pedidos', async () => {
    comprar({ companyId: gringa, email: 'ana@exemplo.com', documento: '111.444.777-35', chave: 'm1' });
    comprar({
      companyId: precoJusto,
      email: 'ana@exemplo.com',
      documento: '111.444.777-35',
      chave: 'm2',
    });
    const token = await criarAcesso('ana@exemplo.com', '111.444.777-35');

    const res = await request(app).get('/api/v1/loja/portal/pedidos').set('x-portal-token', token);

    expect(res.body.items).toHaveLength(2);
    expect(new Set(res.body.items.map((i: { storeName: string }) => i.storeName))).toEqual(
      new Set(['Gringa', 'Preço Justo']),
    );
  });
});

describe('acesso horizontal — o que não pode falhar', () => {
  it('conhecer o id do pedido de outra pessoa NÃO dá acesso', async () => {
    const daAna = comprar({
      companyId: gringa,
      email: 'ana@exemplo.com',
      documento: '111.444.777-35',
      chave: 'h1',
    });
    comprar({ companyId: gringa, email: 'bruno@exemplo.com', documento: '529.982.247-25', chave: 'h2' });
    await criarAcesso('ana@exemplo.com', '111.444.777-35');
    const tokenBruno = await criarAcesso('bruno@exemplo.com', '529.982.247-25');

    const res = await request(app)
      .get(`/api/v1/loja/portal/pedidos/${daAna.orderId}`)
      .set('x-portal-token', tokenBruno);

    expect(res.status).toBe(404);
  });

  it('o pedido próprio abre normalmente', async () => {
    const daAna = comprar({
      companyId: gringa,
      email: 'ana@exemplo.com',
      documento: '111.444.777-35',
      chave: 'h3',
    });
    const token = await criarAcesso('ana@exemplo.com', '111.444.777-35');

    const res = await request(app)
      .get(`/api/v1/loja/portal/pedidos/${daAna.orderId}`)
      .set('x-portal-token', token);

    expect(res.status).toBe(200);
    expect(res.body.storeName).toBe('Gringa');
  });

  it('token inventado não vale', async () => {
    const res = await request(app)
      .get('/api/v1/loja/portal/pedidos')
      .set('x-portal-token', 'token-que-eu-inventei');

    expect(res.status).toBe(401);
  });

  it('sessão encerrada deixa de valer na hora', async () => {
    comprar({ companyId: gringa, email: 'ana@exemplo.com', documento: '111.444.777-35', chave: 'h4' });
    const token = await criarAcesso('ana@exemplo.com', '111.444.777-35');

    await request(app).post('/api/v1/loja/portal/sair').set('x-portal-token', token);
    const res = await request(app).get('/api/v1/loja/portal/pedidos').set('x-portal-token', token);

    expect(res.status).toBe(401);
  });

  it('sessão expirada não vale', async () => {
    comprar({ companyId: gringa, email: 'ana@exemplo.com', documento: '111.444.777-35', chave: 'h5' });
    const token = await criarAcesso('ana@exemplo.com', '111.444.777-35');
    getConnection()
      .prepare('UPDATE core_customer_sessions SET expires_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 1000).toISOString(), token);

    expect(resolveCustomerSession(token)).toBeNull();
  });
});

describe('o pedido que o cliente vê', () => {
  it('mostra o documento mascarado, nunca inteiro', async () => {
    const pedido = comprar({
      companyId: gringa,
      email: 'ana@exemplo.com',
      documento: '111.444.777-35',
      chave: 'd1',
    });
    const token = await criarAcesso('ana@exemplo.com', '111.444.777-35');

    const res = await request(app)
      .get(`/api/v1/loja/portal/pedidos/${pedido.orderId}`)
      .set('x-portal-token', token);

    expect(res.body.customer.document).toBe('••• 7735');
    expect(JSON.stringify(res.body)).not.toContain('11144477735');
  });

  it('traz itens, timeline e pagamento', async () => {
    const pedido = comprar({
      companyId: gringa,
      email: 'ana@exemplo.com',
      documento: '111.444.777-35',
      chave: 'd2',
    });
    const token = await criarAcesso('ana@exemplo.com', '111.444.777-35');

    const res = await request(app)
      .get(`/api/v1/loja/portal/pedidos/${pedido.orderId}`)
      .set('x-portal-token', token);

    expect(res.body.items).toHaveLength(1);
    expect(res.body.timeline.length).toBeGreaterThan(0);
    expect(res.body.timeline[0].statusLabel).toBe('Aguardando pagamento');
  });

  it('o PIX pendente é lido do que está gravado — dez aberturas, zero idas ao provedor', async () => {
    const pedido = comprar({
      companyId: gringa,
      email: 'ana@exemplo.com',
      documento: '111.444.777-35',
      chave: 'd3',
    });
    const intent = await createPaymentIntent({
      companyId: gringa,
      originType: 'ecommerce_order',
      originId: pedido.orderId,
      method: 'pix',
      amountCents: 10000,
      idempotencyKey: 'pay-d3',
    });
    getConnection()
      .prepare("UPDATE core_payment_intents SET qr_payload = '00020126COPIA-E-COLA' WHERE id = ?")
      .run(intent.id);
    const token = await criarAcesso('ana@exemplo.com', '111.444.777-35');

    const chamadas: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      chamadas.push(String(url));
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    try {
      for (let i = 0; i < 10; i += 1) {
        const res = await request(app)
          .get(`/api/v1/loja/portal/pedidos/${pedido.orderId}`)
          .set('x-portal-token', token);
        expect(res.body.payments[0].pixPayload).toBe('00020126COPIA-E-COLA');
      }
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(chamadas).toEqual([]);
  });

  it('pagamento confirmado aparece sem precisar entrar de novo', async () => {
    const pedido = comprar({
      companyId: gringa,
      email: 'ana@exemplo.com',
      documento: '111.444.777-35',
      chave: 'd4',
    });
    const intent = await createPaymentIntent({
      companyId: gringa,
      originType: 'ecommerce_order',
      originId: pedido.orderId,
      method: 'pix',
      amountCents: 10000,
      idempotencyKey: 'pay-d4',
    });
    getConnection()
      .prepare("UPDATE core_payment_intents SET provider_ref = 'pay_d4' WHERE id = ?")
      .run(intent.id);
    const token = await criarAcesso('ana@exemplo.com', '111.444.777-35');

    handlePaymentWebhook({
      provider: 'asaas',
      companyId: gringa,
      token: TOKEN_WEBHOOK,
      payload: { id: 'ev-d4', event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_d4' } },
    });

    const res = await request(app)
      .get(`/api/v1/loja/portal/pedidos/${pedido.orderId}`)
      .set('x-portal-token', token);

    expect(res.body.statusLabel).toBe('Pagamento confirmado');
    expect(res.body.payments[0].statusLabel).toBe('Pago');
  });
});
