/**
 * CONTA DO CLIENTE COMPLETA — rodada 38.
 *
 * O portal estava quase inacessível: o cadastro EXIGIA uma compra anterior
 * (e-mail + documento no mesmo cadastro), e o banco tinha 0 contas e 1 cliente
 * elegível. Esta rodada abre o cadastro, sem afrouxar a segurança que impede
 * uma conta de adotar os pedidos de outra pessoa.
 *
 * O QUE NÃO PODE QUEBRAR, e é o que cada bloco cobra:
 *
 *   - CRIAR conta é aberto; VINCULAR um cadastro existente continua exigindo a
 *     co-prova e-mail + documento. Saber só o CPF (que é semi-público) não
 *     puxa o histórico de ninguém.
 *   - Recuperar senha existe, com token de uso único e curto. O e-mail fica na
 *     fila até haver SMTP — o mesmo padrão honesto do fiscal e do Asaas.
 *   - Trocar a senha (ou redefinir por recuperação) derruba as outras sessões.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
// O código e o link moram selados fora do corpo da fila (GAP-PRD-007): o
// teste lê o e-mail como o CLIENTE o recebe, pela montagem do carteiro.
import { textoDeEntrega } from '../src/services/notifications/EmailService.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import { checkout } from '../src/services/core/StorefrontService.js';
import { confirmarEmail } from '../src/services/core/CustomerPortalService.js';

const app = createApp();
const SENHA = 'Senha@Cliente38';
let gringa: string;
let n = 0;

function produto(companyId: string): string {
  n += 1;
  const id = `prod-c38-${n}`;
  const agora = new Date().toISOString();
  const db = getConnection();
  db.prepare(
    `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                price_cents, active, publish_online, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'UN', 4000, 10000, 1, 1, ?, ?)`,
  ).run(id, companyId, `C38-${n}`, `Item ${n}`, agora, agora);
  db.prepare(
    'INSERT INTO core_stock (company_id, product_id, quantity, reserved, updated_at) VALUES (?, ?, 20, 0, ?)',
  ).run(companyId, id, agora);
  return id;
}

/** Uma compra de verdade cria o cadastro do cliente na operação. */
function comprar(input: { email: string; documento: string; nome?: string }): string {
  const [pedido] = checkout({
    idempotencyKey: `ck-${input.email}-${n}`,
    customerName: input.nome ?? 'Cliente 38',
    customerEmail: input.email,
    customerDocument: input.documento,
    paymentMethod: 'pix',
    items: [{ productId: produto(gringa), quantity: 1 }],
  });
  return pedido.id;
}

async function registrar(body: Record<string, unknown>) {
  // O aceite dos termos é exigido desde a rodada 45; aqui é default para o
  // arquivo continuar testando o que sempre testou (o caso do aceite mora em
  // conformidade-da-loja.test.ts).
  const res = await request(app)
    .post('/api/v1/loja/portal/registrar')
    .send({ termsAccepted: true, ...body });
  /*
    Desde a rodada 50 a co-prova espera o CÓDIGO — o vínculo dos pedidos só
    nasce com o e-mail provado. Este arquivo testa o que vem DEPOIS dessa
    prova, então o registro aqui prova a caixa na hora, como o cliente de
    verdade faria (o caso da espera mora em cadastro-por-email.test.ts).
  */
  if (res.status === 201 && res.body?.account?.id) {
    provarCaixa(res.body.account.id, String(body.email));
  }
  return res;
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

beforeEach(() => {
  resetDbForTests();
  n = 0;
  gringa = upsertCompany({ slug: 'gringa', tradeName: 'Gringa', legalName: 'Gringa Ltda' });
});

describe('cadastro aberto', () => {
  it('cria conta só com e-mail e senha, sem exigir compra anterior', async () => {
    const res = await registrar({ email: 'novo@exemplo.com', password: SENHA });
    expect(res.status).toBe(201);
    expect(res.body.token).toBeTruthy();
    // Sem compra, o portal existe e está vazio — não é erro, é conta nova.
    const pedidos = await request(app)
      .get('/api/v1/loja/portal/pedidos')
      .set('x-portal-token', res.body.token);
    expect(pedidos.status).toBe(200);
    expect(pedidos.body.items).toEqual([]);
  });

  it('com documento que co-bate uma compra, já traz os pedidos', async () => {
    comprar({ email: 'ana@exemplo.com', documento: '11144477735' });
    const res = await registrar({
      email: 'ana@exemplo.com',
      document: '111.444.777-35',
      password: SENHA,
    });
    expect(res.status).toBe(201);
    const pedidos = await request(app)
      .get('/api/v1/loja/portal/pedidos')
      .set('x-portal-token', res.body.token);
    expect(pedidos.body.items.length).toBe(1);
  });

  it('documento que NÃO co-bate não liga cadastro nenhum, e a conta é criada mesmo assim', async () => {
    const pedido = comprar({ email: 'ana@exemplo.com', documento: '11144477735' });
    // Documento aleatório, sem cadastro: a conta nasce sem vínculo nenhum.
    const res = await registrar({
      email: 'ana@exemplo.com',
      document: '52998224725',
      password: SENHA,
    });
    expect(res.status).toBe(201);
    const vinculos = getConnection()
      .prepare('SELECT COUNT(*) c FROM core_customer_account_links WHERE account_id = ?')
      .get(res.body.account.id) as { c: number };
    expect(vinculos.c).toBe(0);
    /*
      O PEDIDO aparece, e não é pelo documento (GAP-PRD-043). Ele foi feito com
      o e-mail que esta conta acabou de PROVAR — é para essa caixa que o pedido
      já mandou o recibo e o PIX. O documento diferente não traz o CADASTRO;
      o e-mail provado traz o que foi comprado com ele.
    */
    const pedidos = await request(app)
      .get('/api/v1/loja/portal/pedidos')
      .set('x-portal-token', res.body.token);
    expect(pedidos.body.items.map((i: { id: string }) => i.id)).toEqual([pedido]);
  });

  it('ANTI-ROUBO: o CPF da vítima, com o e-mail do atacante, não puxa os pedidos dela', async () => {
    comprar({ email: 'vitima@exemplo.com', documento: '11144477735' });
    // Atacante sabe o CPF da vítima (semi-público) e registra com o PRÓPRIO
    // e-mail. Sem o e-mail da vítima no mesmo cadastro, não há co-prova.
    const res = await registrar({
      email: 'atacante@exemplo.com',
      document: '111.444.777-35',
      password: SENHA,
    });
    expect(res.status).toBe(201);
    const pedidos = await request(app)
      .get('/api/v1/loja/portal/pedidos')
      .set('x-portal-token', res.body.token);
    expect(pedidos.body.items).toEqual([]);
  });
});

describe('vincular pedidos depois (claim)', () => {
  it('conta aberta vincula os pedidos ao informar o documento que co-bate', async () => {
    comprar({ email: 'ana@exemplo.com', documento: '11144477735' });
    const conta = await registrar({ email: 'ana@exemplo.com', password: SENHA });
    const token = conta.body.token;

    const vinculos = () =>
      (getConnection()
        .prepare('SELECT COUNT(*) c FROM core_customer_account_links WHERE account_id = ?')
        .get(conta.body.account.id) as { c: number }).c;

    // O pedido feito com o e-mail provado já está na conta (GAP-PRD-043) —
    // o que o documento traz é o CADASTRO da loja, que antes não vinha.
    let pedidos = await request(app).get('/api/v1/loja/portal/pedidos').set('x-portal-token', token);
    expect(pedidos.body.items.length).toBe(1);
    expect(vinculos()).toBe(0);

    const vinc = await request(app)
      .post('/api/v1/loja/portal/vincular')
      .set('x-portal-token', token)
      .send({ document: '111.444.777-35' });
    expect(vinc.status).toBe(200);
    expect(vinc.body.linked).toBe(1);
    expect(vinculos()).toBe(1);
    // A resposta diz quantos NASCERAM agora — é o que a tela conta ao cliente.
    expect(vinc.body.novos).toBe(1);
    const denovo = await request(app)
      .post('/api/v1/loja/portal/vincular')
      .set('x-portal-token', token)
      .send({ document: '111.444.777-35' });
    expect(denovo.body).toMatchObject({ linked: 1, novos: 0 });

    pedidos = await request(app).get('/api/v1/loja/portal/pedidos').set('x-portal-token', token);
    expect(pedidos.body.items.length).toBe(1);
  });

  it('ANTI-ROUBO: vincular com CPF cujo e-mail não é o da conta não traz nada', async () => {
    comprar({ email: 'vitima@exemplo.com', documento: '11144477735' });
    const conta = await registrar({ email: 'atacante@exemplo.com', password: SENHA });
    const token = conta.body.token;

    const vinc = await request(app)
      .post('/api/v1/loja/portal/vincular')
      .set('x-portal-token', token)
      .send({ document: '111.444.777-35' });
    // Ou recusa, ou aceita sem vincular — nunca traz o pedido da vítima.
    const pedidos = await request(app)
      .get('/api/v1/loja/portal/pedidos')
      .set('x-portal-token', token);
    expect(pedidos.body.items).toEqual([]);
    expect(vinc.status).toBeLessThan(500);
  });
});

describe('recuperar senha', () => {
  async function contaCom(email: string) {
    const r = await registrar({ email, password: SENHA });
    return r.body.token as string;
  }

  it('e-mail desconhecido responde 200 sem revelar que não existe', async () => {
    const res = await request(app)
      .post('/api/v1/loja/portal/recuperar-senha')
      .send({ email: 'ninguem@exemplo.com' });
    expect(res.status).toBe(200);
    // Nenhum token vaza na resposta — ele iria pelo e-mail.
    expect(JSON.stringify(res.body)).not.toMatch(/token/i);
  });

  it('gera um token, redefine a senha, e a senha antiga para de valer', async () => {
    await contaCom('ana@exemplo.com');
    const pedir = await request(app)
      .post('/api/v1/loja/portal/recuperar-senha')
      .send({ email: 'ana@exemplo.com' });
    expect(pedir.status).toBe(200);

    // O token não vem na resposta; para o teste, lê-se da fila de e-mail o
    // link enfileirado. (Em produção ele chega no e-mail do cliente.)
    const fila = getConnection()
      .prepare("SELECT id FROM core_email_queue WHERE template = 'recuperacao_senha' ORDER BY created_at DESC LIMIT 1")
      .get() as { id: string } | undefined;
    expect(fila).toBeDefined();
    const token = ((textoDeEntrega(fila!.id) ?? '').match(/token=([A-Za-z0-9_-]+)/) || [])[1] as string;
    expect(token).toBeTruthy();

    const redefinir = await request(app)
      .post('/api/v1/loja/portal/redefinir-senha')
      .send({ token, password: 'NovaSenha@2026' });
    expect(redefinir.status).toBe(200);

    // Senha nova entra; senha velha não.
    const nova = await request(app)
      .post('/api/v1/loja/portal/entrar')
      .send({ email: 'ana@exemplo.com', password: 'NovaSenha@2026' });
    expect(nova.status).toBe(200);
    const velha = await request(app)
      .post('/api/v1/loja/portal/entrar')
      .send({ email: 'ana@exemplo.com', password: SENHA });
    expect(velha.status).toBe(401);
  });

  it('o token vale UMA vez', async () => {
    await contaCom('ana@exemplo.com');
    await request(app).post('/api/v1/loja/portal/recuperar-senha').send({ email: 'ana@exemplo.com' });
    const fila = getConnection()
      .prepare("SELECT id FROM core_email_queue WHERE template = 'recuperacao_senha' ORDER BY created_at DESC LIMIT 1")
      .get() as { id: string };
    const token = ((textoDeEntrega(fila.id) ?? '').match(/token=([A-Za-z0-9_-]+)/) || [])[1] as string;

    const um = await request(app)
      .post('/api/v1/loja/portal/redefinir-senha')
      .send({ token, password: 'NovaSenha@2026' });
    expect(um.status).toBe(200);
    const dois = await request(app)
      .post('/api/v1/loja/portal/redefinir-senha')
      .send({ token, password: 'OutraSenha@2026' });
    expect(dois.status).toBe(400);
  });

  it('redefinir a senha derruba as sessões abertas', async () => {
    const tokenSessao = await contaCom('ana@exemplo.com');
    await request(app).post('/api/v1/loja/portal/recuperar-senha').send({ email: 'ana@exemplo.com' });
    const fila = getConnection()
      .prepare("SELECT id FROM core_email_queue WHERE template = 'recuperacao_senha' ORDER BY created_at DESC LIMIT 1")
      .get() as { id: string };
    const resetToken = ((textoDeEntrega(fila.id) ?? '').match(/token=([A-Za-z0-9_-]+)/) || [])[1] as string;

    await request(app)
      .post('/api/v1/loja/portal/redefinir-senha')
      .send({ token: resetToken, password: 'NovaSenha@2026' });

    // A sessão que estava aberta antes da redefinição não vale mais.
    const comSessaoVelha = await request(app)
      .get('/api/v1/loja/portal/pedidos')
      .set('x-portal-token', tokenSessao);
    expect(comSessaoVelha.status).toBe(401);
  });
});

describe('dados cadastrais editáveis', () => {
  it('o cliente edita nome e telefone, e isso chega ao cadastro da operação', async () => {
    comprar({ email: 'ana@exemplo.com', documento: '11144477735', nome: 'Ana Antiga' });
    const conta = await registrar({
      email: 'ana@exemplo.com',
      document: '11144477735',
      password: SENHA,
    });
    const token = conta.body.token;

    const put = await request(app)
      .put('/api/v1/loja/portal/perfil')
      .set('x-portal-token', token)
      .send({ name: 'Ana Nova', phone: '53 99999-1234' });
    expect(put.status).toBe(200);

    const cadastro = getConnection()
      .prepare("SELECT name, phone FROM core_customers WHERE email = 'ana@exemplo.com'")
      .get() as { name: string; phone: string };
    expect(cadastro.name).toBe('Ana Nova');
    expect(cadastro.phone).toContain('99999');
  });

  it('sem sessão, não edita perfil', async () => {
    const put = await request(app)
      .put('/api/v1/loja/portal/perfil')
      .send({ name: 'Qualquer' });
    expect(put.status).toBe(401);
  });
});

describe('sair de todos os dispositivos', () => {
  it('mantém a sessão atual e derruba as outras', async () => {
    await registrar({ email: 'ana@exemplo.com', password: SENHA });
    const s1 = (await request(app).post('/api/v1/loja/portal/entrar').send({ email: 'ana@exemplo.com', password: SENHA })).body.token;
    const s2 = (await request(app).post('/api/v1/loja/portal/entrar').send({ email: 'ana@exemplo.com', password: SENHA })).body.token;

    // De s2, sai de todos os outros. s1 deve cair; s2 continua.
    const sair = await request(app)
      .post('/api/v1/loja/portal/sair-outros')
      .set('x-portal-token', s2);
    expect(sair.status).toBe(200);

    const usoS1 = await request(app).get('/api/v1/loja/portal/pedidos').set('x-portal-token', s1);
    const usoS2 = await request(app).get('/api/v1/loja/portal/pedidos').set('x-portal-token', s2);
    expect(usoS1.status).toBe(401);
    expect(usoS2.status).toBe(200);
  });
});
