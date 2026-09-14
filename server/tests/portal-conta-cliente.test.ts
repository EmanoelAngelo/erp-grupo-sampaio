/**
 * A conta do cliente: endereços salvos e troca de senha.
 *
 * O que este arquivo cobra é o que separa uma conta utilizável de uma conta
 * perigosa:
 *
 *  - endereço é da CONTA, não do cadastro por operação — quem compra em duas
 *    lojas do grupo não digita o endereço duas vezes;
 *  - endereço de outra pessoa é 404, não 403: confirmar que o id existe já
 *    contaria algo sobre a conta alheia;
 *  - trocar a senha EXIGE a senha atual — senão quem pega o computador
 *    destravado toma a conta;
 *  - trocar a senha derruba as OUTRAS sessões, e só elas.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { getConnection } from '../src/db/sqlite.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import { checkout } from '../src/services/core/StorefrontService.js';
import { loginCustomer } from '../src/services/core/CustomerPortalService.js';

const app = createApp();
const SENHA = 'senha-do-cliente-2026';
const NOVA = 'outra-senha-bem-melhor';

let gringa: string;
let n = 0;

function produto(companyId: string): string {
  n += 1;
  const id = `prod-conta-${n}`;
  const agora = new Date().toISOString();
  const db = getConnection();
  db.prepare(
    `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                price_cents, active, publish_online, created_at, updated_at)
     VALUES (?, ?, ?, 'Item', 'UN', 4000, 10000, 1, 1, ?, ?)`,
  ).run(id, companyId, `CT-${n}`, agora, agora);
  db.prepare(
    'INSERT INTO core_stock (company_id, product_id, quantity, reserved, updated_at) VALUES (?, ?, 20, 0, ?)',
  ).run(companyId, id, agora);
  return id;
}

async function contaComToken(email = 'ana@exemplo.com'): Promise<string> {
  checkout({
    idempotencyKey: `compra-${email}-${n}`,
    customerName: 'Ana Compradora',
    customerEmail: email,
    customerDocument: '111.444.777-35',
    paymentMethod: 'pix',
    items: [{ productId: produto(gringa), quantity: 1 }],
  });
  const res = await request(app)
    .post('/api/v1/loja/portal/registrar')
    .send({ termsAccepted: true, email, document: '111.444.777-35', password: SENHA });
  expect(res.status).toBe(201);
  return res.body.token as string;
}

const ENDERECO = {
  label: 'Casa',
  zip: '01001-000',
  street: 'Praça da Sé',
  number: '100',
  district: 'Sé',
  city: 'São Paulo',
  state: 'sp',
};

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  n = 0;
  gringa = await upsertCompany({ slug: 'gringa', tradeName: 'Gringa', legalName: 'Gringa Ltda' });
});

describe('endereços', () => {
  it('salva e devolve na listagem', async () => {
    const token = await contaComToken();

    const criado = await request(app)
      .post('/api/v1/loja/portal/enderecos')
      .set('x-portal-token', token)
      .send(ENDERECO);

    expect(criado.status).toBe(201);
    // UF normalizada: "sp" digitado vira "SP".
    expect(criado.body.state).toBe('SP');
    expect(criado.body.zip).toBe('01001000');

    const lista = await request(app)
      .get('/api/v1/loja/portal/enderecos')
      .set('x-portal-token', token);
    expect(lista.body.items).toHaveLength(1);
  });

  it('o primeiro endereço vira padrão sozinho', async () => {
    const token = await contaComToken();
    const criado = await request(app)
      .post('/api/v1/loja/portal/enderecos')
      .set('x-portal-token', token)
      .send(ENDERECO);

    // Pedir para marcar "padrão" quando só existe um é um clique que não
    // decide nada.
    expect(criado.body.isDefault).toBe(true);
  });

  it('só existe UM padrão por vez', async () => {
    const token = await contaComToken();
    await request(app)
      .post('/api/v1/loja/portal/enderecos')
      .set('x-portal-token', token)
      .send(ENDERECO);
    await request(app)
      .post('/api/v1/loja/portal/enderecos')
      .set('x-portal-token', token)
      .send({ ...ENDERECO, label: 'Trabalho', isDefault: true });

    const lista = await request(app)
      .get('/api/v1/loja/portal/enderecos')
      .set('x-portal-token', token);
    const padroes = lista.body.items.filter((e: { isDefault: boolean }) => e.isDefault);
    // Dois marcados fariam o checkout escolher por ordem de inserção.
    expect(padroes).toHaveLength(1);
    expect(padroes[0].label).toBe('Trabalho');
  });

  it('remover o padrão promove o mais antigo restante', async () => {
    const token = await contaComToken();
    const primeiro = await request(app)
      .post('/api/v1/loja/portal/enderecos')
      .set('x-portal-token', token)
      .send(ENDERECO);
    await request(app)
      .post('/api/v1/loja/portal/enderecos')
      .set('x-portal-token', token)
      .send({ ...ENDERECO, label: 'Trabalho' });

    const depois = await request(app)
      .delete(`/api/v1/loja/portal/enderecos/${primeiro.body.id}`)
      .set('x-portal-token', token);

    // Ficar sem padrão faria o próximo checkout começar em branco sem motivo.
    expect(depois.body.items).toHaveLength(1);
    expect(depois.body.items[0].isDefault).toBe(true);
  });

  it('CEP inválido é recusado', async () => {
    const token = await contaComToken();
    const res = await request(app)
      .post('/api/v1/loja/portal/enderecos')
      .set('x-portal-token', token)
      .send({ ...ENDERECO, zip: '123' });
    expect(res.status).toBe(400);
  });

  it('endereço de OUTRA conta responde 404, não 403', async () => {
    const tokenAna = await contaComToken('ana@exemplo.com');
    const dela = await request(app)
      .post('/api/v1/loja/portal/enderecos')
      .set('x-portal-token', tokenAna)
      .send(ENDERECO);

    const tokenBruno = await contaComToken('bruno@exemplo.com');
    const res = await request(app)
      .delete(`/api/v1/loja/portal/enderecos/${dela.body.id}`)
      .set('x-portal-token', tokenBruno);

    // 403 confirmaria que o id existe — já é informação sobre a conta alheia.
    expect(res.status).toBe(404);
  });

  it('sem sessão não lista endereço nenhum', async () => {
    await contaComToken();
    const res = await request(app).get('/api/v1/loja/portal/enderecos');
    expect(res.status).toBe(401);
  });
});

describe('troca de senha', () => {
  it('troca com a senha atual correta', async () => {
    const token = await contaComToken();

    const res = await request(app)
      .post('/api/v1/loja/portal/senha')
      .set('x-portal-token', token)
      .send({ currentPassword: SENHA, newPassword: NOVA });

    expect(res.status).toBe(200);
    // A senha nova funciona.
    const entrou = await loginCustomer({ email: 'ana@exemplo.com', password: NOVA });
    expect(entrou.token).toBeTruthy();
  });

  it('sem a senha atual é RECUSADA', async () => {
    const token = await contaComToken();

    const res = await request(app)
      .post('/api/v1/loja/portal/senha')
      .set('x-portal-token', token)
      .send({ currentPassword: 'chute-errado', newPassword: NOVA });

    // O token de sessão sozinho não prova identidade para mudar credencial:
    // senão quem pega o computador destravado toma a conta.
    expect(res.status).toBe(401);
  });

  it('senha nova curta é recusada', async () => {
    const token = await contaComToken();
    const res = await request(app)
      .post('/api/v1/loja/portal/senha')
      .set('x-portal-token', token)
      .send({ currentPassword: SENHA, newPassword: '123' });
    expect(res.status).toBe(400);
  });

  it('repetir a senha atual é recusado', async () => {
    const token = await contaComToken();
    const res = await request(app)
      .post('/api/v1/loja/portal/senha')
      .set('x-portal-token', token)
      .send({ currentPassword: SENHA, newPassword: SENHA });
    expect(res.status).toBe(400);
  });

  it('as OUTRAS sessões caem, e a de quem trocou continua', async () => {
    const tokenAntigo = await contaComToken();
    const outra = await loginCustomer({ email: 'ana@exemplo.com', password: SENHA });

    // Troca usando a sessão NOVA: a antiga é quem deve cair.
    await request(app)
      .post('/api/v1/loja/portal/senha')
      .set('x-portal-token', outra.token)
      .send({ currentPassword: SENHA, newPassword: NOVA });

    const comAntiga = await request(app)
      .get('/api/v1/loja/portal/enderecos')
      .set('x-portal-token', tokenAntigo);
    const comNova = await request(app)
      .get('/api/v1/loja/portal/enderecos')
      .set('x-portal-token', outra.token);

    // Se a senha mudou porque alguém tinha acesso, esse alguém perde agora.
    expect(comAntiga.status).toBe(401);
    // E quem trocou não é expulso da própria tela.
    expect(comNova.status).toBe(200);
  });

  it('a senha NUNCA volta pela API', async () => {
    const token = await contaComToken();
    const res = await request(app)
      .post('/api/v1/loja/portal/senha')
      .set('x-portal-token', token)
      .send({ currentPassword: SENHA, newPassword: NOVA });

    const corpo = JSON.stringify(res.body);
    expect(corpo).not.toContain(SENHA);
    expect(corpo).not.toContain(NOVA);
    expect(corpo).not.toContain('hash');
  });
});
