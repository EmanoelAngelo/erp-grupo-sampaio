/**
 * GAP-PRD-133 e GAP-PRD-205 — OS DADOS DA PESSOA MORAM NA CONTA.
 *
 * O perfil do portal era lido do "primeiro" cadastro vinculado e escrito em
 * TODOS os cadastros vinculados — a conta em si só guardava e-mail e senha.
 * Dois defeitos saíam daí:
 *
 *   133 — a conta sem cadastro vinculado (a conta nova, que ainda não comprou)
 *         salvava o nome em lugar nenhum: PUT 200, "Dados atualizados.", e o
 *         GET seguinte devolvia nome nulo;
 *   205 — a conta com dois cadastros mostrava o nome de um deles conforme a
 *         ordem das linhas.
 *
 * O que se cobra: o que a pessoa salva é o que ela lê de volta, com ou sem
 * vínculo; e quando a conta ainda não tem nome próprio (conta antiga), a
 * regra de qual cadastro fala por ela é uma só e está escrita.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import { confirmarEmail } from '../src/services/core/CustomerPortalService.js';
import { textoDeEntrega } from '../src/services/notifications/EmailService.js';

const app = createApp();
const SENHA = 'senha-do-cliente-2026';

let gringa: string;
let precoJusto: string;

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

async function contaNova(email = 'nova@exemplo.com'): Promise<{ token: string; accountId: string }> {
  const res = await request(app)
    .post('/api/v1/loja/portal/registrar')
    .send({ termsAccepted: true, email, password: SENHA });
  expect(res.status).toBe(201);
  return { token: res.body.token as string, accountId: res.body.account.id as string };
}

/** Cadastro de balcão com o e-mail da conta — é o que a co-prova liga. */
function cadastroDeBalcao(id: string, companyId: string, nome: string, email: string, doc: string) {
  const agora = new Date().toISOString();
  getConnection()
    .prepare(
      `INSERT INTO core_customers (id, company_id, name, document, email, phone, active, origin, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, '11911112222', 1, 'balcao', ?, ?)`,
    )
    .run(id, companyId, nome, doc, email, agora, agora);
}

function ligar(accountId: string, customerId: string, companyId: string, quando: string) {
  getConnection()
    .prepare(
      `INSERT INTO core_customer_account_links (id, account_id, customer_id, company_id, created_at, proof)
       VALUES (?, ?, ?, ?, ?, 'coprova')`,
    )
    .run(`l-${customerId}`, accountId, customerId, companyId, quando);
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  gringa = await upsertCompany({ slug: 'gringa', tradeName: 'Gringa', legalName: 'Gringa Ltda' });
  precoJusto = await upsertCompany({
    slug: 'preco-justo',
    tradeName: 'Preço Justo',
    legalName: 'PJ Ltda',
  });
});

describe('GAP-PRD-133 — conta sem cadastro vinculado', () => {
  it('o nome e o telefone salvos voltam no GET seguinte', async () => {
    const { token } = await contaNova();

    const put = await request(app)
      .put('/api/v1/loja/portal/perfil')
      .set('x-portal-token', token)
      .send({ name: 'Ana Nova', phone: '(11) 98888-7777' });
    expect(put.status).toBe(200);
    expect(put.body.name).toBe('Ana Nova');

    const get = await request(app).get('/api/v1/loja/portal/perfil').set('x-portal-token', token);
    expect(get.body).toMatchObject({ name: 'Ana Nova', phone: '(11) 98888-7777', nameSource: 'conta' });

    // No banco, na conta — não num cadastro que não existe.
    const conta = getConnection()
      .prepare('SELECT name, phone FROM core_customer_accounts WHERE email = ?')
      .get('nova@exemplo.com') as { name: string; phone: string };
    expect(conta).toEqual({ name: 'Ana Nova', phone: '(11) 98888-7777' });
  });

  it('o CPF/CNPJ declarado fica na conta, volta mascarado, e conta com dígito errado é recusada', async () => {
    const { token } = await contaNova();

    const errado = await request(app)
      .put('/api/v1/loja/portal/perfil')
      .set('x-portal-token', token)
      .send({ document: '111.444.777-00' });
    expect(errado.status).toBe(400);
    expect(errado.body.error.code).toBe('PORTAL_INVALID_DOCUMENT');

    const certo = await request(app)
      .put('/api/v1/loja/portal/perfil')
      .set('x-portal-token', token)
      .send({ document: '111.444.777-35' });
    expect(certo.status).toBe(200);
    expect(certo.body.hasDocument).toBe(true);
    expect(certo.body.documentMasked).toBe('••• 7735');
    // O número inteiro não volta pela API.
    expect(JSON.stringify(certo.body)).not.toContain('11144477735');
  });

  it('o documento da conta não é trocado por um PUT — trocar de CPF é assunto com a loja', async () => {
    const { token } = await contaNova();
    await request(app)
      .put('/api/v1/loja/portal/perfil')
      .set('x-portal-token', token)
      .send({ document: '111.444.777-35' });

    const troca = await request(app)
      .put('/api/v1/loja/portal/perfil')
      .set('x-portal-token', token)
      .send({ document: '529.982.247-25' });
    expect(troca.status).toBe(409);
    expect(troca.body.error.code).toBe('PORTAL_DOCUMENTO_DEFINIDO');

    // Mandar o MESMO documento de novo não é erro (a tela reenvia o formulário).
    const igual = await request(app)
      .put('/api/v1/loja/portal/perfil')
      .set('x-portal-token', token)
      .send({ document: '11144477735', name: 'Ana' });
    expect(igual.status).toBe(200);
  });

  it('nome em branco continua recusado, sem gravar o resto pela metade', async () => {
    const { token } = await contaNova();
    const res = await request(app)
      .put('/api/v1/loja/portal/perfil')
      .set('x-portal-token', token)
      .send({ name: '   ', phone: '11999999999' });
    expect(res.status).toBe(400);

    const get = await request(app).get('/api/v1/loja/portal/perfil').set('x-portal-token', token);
    expect(get.body.phone).toBeNull();
  });

  it('o perfil diz o que ainda falta para fechar pedido', async () => {
    const { token, accountId } = await contaNova();

    let perfil = await request(app).get('/api/v1/loja/portal/perfil').set('x-portal-token', token);
    expect(perfil.body.faltando).toEqual(['email_verificado', 'nome', 'documento', 'telefone']);

    provarCaixa(accountId, 'nova@exemplo.com');
    await request(app)
      .put('/api/v1/loja/portal/perfil')
      .set('x-portal-token', token)
      .send({ name: 'Ana', phone: '11999999999', document: '11144477735' });

    perfil = await request(app).get('/api/v1/loja/portal/perfil').set('x-portal-token', token);
    expect(perfil.body.faltando).toEqual([]);
  });
});

describe('GAP-PRD-205 — conta com mais de um cadastro vinculado', () => {
  it('sem nome próprio, fala o cadastro vinculado MAIS RECENTEMENTE — regra declarada, não ordem de linha', async () => {
    const { token, accountId } = await contaNova('dupla@exemplo.com');
    // O cadastro da Gringa nasceu ANTES e foi ligado ANTES; o do Preço Justo
    // é o vínculo mais novo. A leitura antiga pegava o cadastro mais antigo.
    cadastroDeBalcao('c-gringa', gringa, 'Nome da Gringa', 'dupla@exemplo.com', '11144477735');
    cadastroDeBalcao('c-pj', precoJusto, 'Nome do Preço Justo', 'dupla@exemplo.com', '11144477735');
    ligar(accountId, 'c-gringa', gringa, '2026-01-01T00:00:00.000Z');
    ligar(accountId, 'c-pj', precoJusto, '2026-06-01T00:00:00.000Z');

    const get = await request(app).get('/api/v1/loja/portal/perfil').set('x-portal-token', token);
    expect(get.body).toMatchObject({ name: 'Nome do Preço Justo', nameSource: 'cadastro' });
  });

  it('com nome próprio, a conta fala por si — e o nome salvo chega aos dois cadastros', async () => {
    const { token, accountId } = await contaNova('dupla@exemplo.com');
    cadastroDeBalcao('c-gringa', gringa, 'Nome da Gringa', 'dupla@exemplo.com', '11144477735');
    cadastroDeBalcao('c-pj', precoJusto, 'Nome do Preço Justo', 'dupla@exemplo.com', '11144477735');
    ligar(accountId, 'c-gringa', gringa, '2026-01-01T00:00:00.000Z');
    ligar(accountId, 'c-pj', precoJusto, '2026-06-01T00:00:00.000Z');

    await request(app)
      .put('/api/v1/loja/portal/perfil')
      .set('x-portal-token', token)
      .send({ name: 'Ana Dupla' });

    const get = await request(app).get('/api/v1/loja/portal/perfil').set('x-portal-token', token);
    expect(get.body).toMatchObject({ name: 'Ana Dupla', nameSource: 'conta' });

    const nomes = getConnection()
      .prepare("SELECT name FROM core_customers WHERE id IN ('c-gringa', 'c-pj') ORDER BY id")
      .all() as { name: string }[];
    expect(nomes.map((n) => n.name)).toEqual(['Ana Dupla', 'Ana Dupla']);
  });
});
