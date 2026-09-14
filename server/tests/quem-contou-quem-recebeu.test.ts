/**
 * AS COLUNAS ESCRITAS QUE NENHUMA TELA NOMEAVA — agora os DTOs carregam o NOME.
 *
 * A varredura da rodada 28 mediu: `counted_by` (contagem de inventário),
 * `received_by` (conferência de nota) e `matched_by` (conciliação bancária)
 * eram escritas em todo fluxo e devolvidas a ninguém. "QUEM contou" é
 * justamente a pergunta de quando faltam 40 peças; "quem conferiu a nota" é a
 * de quando a doca recebeu 4 e o papel dizia 10; "quem casou a linha" é a de
 * quando a baixa não bate com o extrato.
 *
 * Cada caso abaixo escreve pelo fluxo de verdade (ou pela linha que o fluxo
 * teria deixado) e LÊ pela rota que a tela usa — se o JOIN com `core_users`
 * sair, o nome some e o caso cai. O quarto autor da lista, o comentário de OS,
 * JÁ viajava no DTO (`author_name` é coluna própria, gravada na escrita), e o
 * caso final o prova para ele não regredir.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { loginForTest } from './helpers/auth.js';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { getConnection } from '../src/db/sqlite.js';

const app = createApp();
const LOJA = 'loja-autores';

async function entrar(perfil: string, userId: string) {
  const res = await loginForTest(app, { userId, companyId: LOJA, profileCodes: [perfil] });
  expect(res.status).toBe(200);
  return {
    token: res.body.accessToken as string,
    userId: res.body.user.id as string,
    auth: { Authorization: `Bearer ${res.body.accessToken}` },
  };
}

function produto(id: string): void {
  const agora = new Date().toISOString();
  getConnection()
    .prepare(
      `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                  price_cents, category, open_price, active, created_at, updated_at)
       VALUES (?, ?, ?, 'Peça de Teste', 'UN', 0, 1000, 'Geral', 0, 1, ?, ?)`,
    )
    .run(id, LOJA, id, agora, agora);
  getConnection()
    .prepare(
      'INSERT INTO core_stock (company_id, product_id, quantity, reserved, updated_at) VALUES (?, ?, 10, 0, ?)',
    )
    .run(LOJA, id, agora);
}

beforeEach(() => {
  resetDbForTests();
  ensureCoreSchema();
});

describe('counted_by — a contagem de inventário diz QUEM contou', () => {
  it('quem registrou a contagem volta pelo nome no detalhe da contagem', async () => {
    const estoquista = await entrar('estoquista', 'jose');
    produto('p-parafuso');

    const aberta = await request(app)
      .post('/api/v1/core/inventory-counts')
      .set(estoquista.auth)
      .send({ productIds: ['p-parafuso'] });
    expect(aberta.status).toBe(201);

    const contado = await request(app)
      .post(`/api/v1/core/inventory-counts/${aberta.body.id}/items`)
      .set(estoquista.auth)
      .send({ productId: 'p-parafuso', countedQuantity: 6 });
    expect(contado.status).toBe(200);

    const detalhe = await request(app)
      .get(`/api/v1/core/inventory-counts/${aberta.body.id}`)
      .set(estoquista.auth);
    expect(detalhe.status).toBe(200);
    expect(detalhe.body.items[0].counted_by_name).toBe('jose');
  });
});

describe('received_by — a lista de notas diz QUEM conferiu', () => {
  it('a nota recebida volta com received_by_name e received_at', async () => {
    const estoquista = await entrar('estoquista', 'jose');
    // A linha que `confirmNfe` deixa: status recebido, com autor e hora.
    const agora = new Date().toISOString();
    getConnection()
      .prepare(
        `INSERT INTO core_inbound_notes
           (id, company_id, access_key, number, total_cents, status, received_at, received_by, created_at)
         VALUES (?, ?, ?, '123', 5000, 'received', ?, ?, ?)`,
      )
      .run(randomUUID(), LOJA, `chave-${randomUUID()}`, agora, estoquista.userId, agora);

    const lista = await request(app).get('/api/v1/core/purchases/notes').set(estoquista.auth);
    expect(lista.status).toBe(200);
    expect(lista.body.items).toHaveLength(1);
    expect(lista.body.items[0].received_by_name).toBe('jose');
    expect(lista.body.items[0].received_at).toBe(agora);
  });
});

describe('matched_by — a conciliação diz QUEM casou a linha', () => {
  it('a linha casada volta com matched_by_name; a não casada, com nulo', async () => {
    const gerente = await entrar('gerente_loja', 'chefe');
    const agora = new Date().toISOString();
    const db = getConnection();
    db.prepare(
      `INSERT INTO core_bank_statements (id, company_id, account_label, created_at)
       VALUES ('ext-1', ?, 'Conta PJ', ?)`,
    ).run(LOJA, agora);
    // Sem settlement: a coluna matched_settlement_id fica nula na linha casada
    // à mão aqui — o que este caso mede é o JOIN do NOME, não o casamento.
    db.prepare(
      `INSERT INTO core_bank_statement_lines
         (id, statement_id, company_id, occurred_at, description, amount_cents,
          matched_at, matched_by, created_at)
       VALUES ('linha-1', 'ext-1', ?, ?, 'PIX RECEBIDO', 5000, ?, ?, ?)`,
    ).run(LOJA, agora, agora, gerente.userId, agora);
    db.prepare(
      `INSERT INTO core_bank_statement_lines
         (id, statement_id, company_id, occurred_at, description, amount_cents, created_at)
       VALUES ('linha-2', 'ext-1', ?, ?, 'TARIFA', -900, ?)`,
    ).run(LOJA, agora, agora);

    const res = await request(app).get('/api/v1/core/bank/lines').set(gerente.auth);
    expect(res.status).toBe(200);
    const casada = res.body.items.find((l: { id: string }) => l.id === 'linha-1');
    const solta = res.body.items.find((l: { id: string }) => l.id === 'linha-2');
    expect(casada.matched_by_name).toBe('chefe');
    expect(solta.matched_by_name).toBeNull();
  });
});

describe('author_name — o comentário de OS JÁ dizia o autor, e continua dizendo', () => {
  it('o comentário criado pela rota volta com author_name no detalhe da OS', async () => {
    const gerente = await entrar('gerente_oficina', 'mestre');
    // A OS mora numa oficina; o gerente de oficina alcança todas as da empresa.
    getConnection()
      .prepare(
        `INSERT INTO core_workshops (id, company_id, slug, name, created_at)
         VALUES ('of-teste', ?, 'of-teste', 'Bancada de Teste', ?)`,
      )
      .run(LOJA, new Date().toISOString());

    const os = await request(app)
      .post('/api/v1/core/workshop/orders')
      .set(gerente.auth)
      .send({ customerName: 'Cliente da Bancada', equipment: 'CG 160', complaint: 'não liga' });
    expect(os.status).toBe(201);

    const comentario = await request(app)
      .post(`/api/v1/core/workshop/orders/${os.body.id}/comments`)
      .set(gerente.auth)
      .send({ body: 'vela trocada, aguardando teste' });
    expect(comentario.status).toBe(201);

    const detalhe = await request(app)
      .get(`/api/v1/core/workshop/orders/${os.body.id}`)
      .set(gerente.auth);
    expect(detalhe.status).toBe(200);
    const c = detalhe.body.comments.find(
      (x: { body: string }) => x.body === 'vela trocada, aguardando teste',
    );
    expect(c).toBeTruthy();
    expect(c.author_name).toBe('mestre');
  });
});
