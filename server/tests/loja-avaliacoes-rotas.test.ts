/**
 * As três rotas de avaliação, pela porta HTTP.
 *
 * O serviço já é coberto em `loja-avaliacoes.test.ts`. O que só aparece na
 * camada HTTP é o que este arquivo cobra:
 *
 *  - o RESUMO é público: a vitrine precisa mostrar nota para visitante que
 *    nem conta tem;
 *  - ESCREVER exige sessão do portal, e sem token a resposta é 401 — a tela
 *    depende desse código para decidir entre "entre na sua conta" e ficar
 *    muda (foi exatamente uma sessão vencida que deixou a seção em branco no
 *    navegador);
 *  - a recusa por falta de pedido entregue chega com o MOTIVO, não com um 500
 *    genérico: a pessoa que pagou e ainda não recebeu precisa entender por
 *    que não consegue avaliar;
 *  - a rota pública não vaza nome completo nem e-mail de quem comprou.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { getConnection } from '../src/db/sqlite.js';
// O código e o link moram selados fora do corpo da fila (GAP-PRD-007): o
// teste lê o e-mail como o CLIENTE o recebe, pela montagem do carteiro.
import { textoDeEntrega } from '../src/services/notifications/EmailService.js';
import { confirmarEmail } from '../src/services/core/CustomerPortalService.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import {
  advanceFulfillment,
  checkout,
  markOrderPaid,
} from '../src/services/core/StorefrontService.js';

const app = createApp();
const SENHA = 'senha-do-cliente-2026';
const BASE = '/api/v1/loja';

let gringa: string;
let n = 0;

function produto(): string {
  n += 1;
  const id = `prod-av-${n}`;
  const agora = new Date().toISOString();
  const db = getConnection();
  db.prepare(
    `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                price_cents, active, publish_online, created_at, updated_at)
     VALUES (?, ?, ?, 'Jaqueta', 'UN', 4000, 10000, 1, 1, ?, ?)`,
  ).run(id, gringa, `AVR-${n}`, agora, agora);
  db.prepare(
    'INSERT INTO core_stock (company_id, product_id, quantity, reserved, updated_at) VALUES (?, ?, 20, 0, ?)',
  ).run(gringa, id, agora);
  return id;
}

/** Compra o produto e devolve o token do portal. `entregar` leva até o fim. */
async function comprador(input: {
  productId: string;
  entregar: boolean;
  email?: string;
  documento?: string;
}): Promise<string> {
  n += 1;
  const email = input.email ?? 'ana@exemplo.com';
  const documento = input.documento ?? '111.444.777-35';

  const [pedido] = checkout({
    idempotencyKey: `avr-${n}`,
    customerName: 'Ana Beatriz Silva',
    customerEmail: email,
    customerDocument: documento,
    paymentMethod: 'pix',
    items: [{ productId: input.productId, quantity: 1 }],
  });

  if (input.entregar) {
    markOrderPaid({ companyId: gringa, orderId: pedido.id, provider: 'manual' });
    // Esteira de RETIRADA: chega em 'entregue' sem precisar de transportadora.
    for (const etapa of ['separacao', 'conferencia', 'embalado', 'pronto_para_retirada', 'entregue']) {
      advanceFulfillment({ companyId: gringa, orderId: pedido.id, toStatus: etapa });
    }
  }

  const res = await request(app)
    .post(`${BASE}/portal/registrar`)
    .send({ termsAccepted: true, email, document: documento, password: SENHA });
  expect(res.status).toBe(201);
  // Rodada 50: a co-prova espera o código — prova a caixa na hora, como o
  // dono dela faria (a espera em si mora em cadastro-por-email.test.ts).
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
});

describe('resumo público', () => {
  it('visitante sem conta lê a nota do produto', async () => {
    const p = produto();
    const token = await comprador({ productId: p, entregar: true });
    await request(app)
      .post(`${BASE}/products/${p}/avaliacoes`)
      .set('x-portal-token', token)
      .send({ rating: 5, comment: 'Chegou rápido.' })
      .expect(201);

    // Sem header nenhum: é a vitrine.
    const res = await request(app).get(`${BASE}/products/${p}/avaliacoes`).expect(200);
    expect(res.body.average).toBe(5);
    expect(res.body.count).toBe(1);
    expect(res.body.items[0].displayName).toBe('Ana S.');
  });

  it('produto sem avaliação devolve média nula, não zero', async () => {
    const p = produto();
    const res = await request(app).get(`${BASE}/products/${p}/avaliacoes`).expect(200);
    // Zero na vitrine é lido como nota péssima; ausência de nota é outra coisa.
    expect(res.body.average).toBeNull();
    expect(res.body.count).toBe(0);
  });

  it('a rota pública NÃO expõe nome completo nem e-mail', async () => {
    const p = produto();
    const token = await comprador({ productId: p, entregar: true });
    await request(app)
      .post(`${BASE}/products/${p}/avaliacoes`)
      .set('x-portal-token', token)
      .send({ rating: 4 })
      .expect(201);

    const res = await request(app).get(`${BASE}/products/${p}/avaliacoes`).expect(200);
    const corpo = JSON.stringify(res.body);
    expect(corpo).not.toContain('Ana Beatriz Silva');
    expect(corpo).not.toContain('ana@exemplo.com');
  });
});

describe('escrever exige sessão', () => {
  it('sem token, 401 — e é esse código que a tela usa para pedir login', async () => {
    const p = produto();
    await request(app).post(`${BASE}/products/${p}/avaliacoes`).send({ rating: 5 }).expect(401);
    await request(app).get(`${BASE}/products/${p}/minha-avaliacao`).expect(401);
  });

  it('token inválido também é 401, não 500', async () => {
    const p = produto();
    // Sessão vencida no navegador chega exatamente assim. Se virasse 500, a
    // tela não teria como distinguir "entre de novo" de "a loja quebrou".
    await request(app)
      .get(`${BASE}/products/${p}/minha-avaliacao`)
      .set('x-portal-token', 'token-que-nao-existe')
      .expect(401);
  });
});

describe('a recusa chega com o motivo', () => {
  it('quem pagou e ainda NÃO recebeu lê por que não pode avaliar', async () => {
    const p = produto();
    const token = await comprador({ productId: p, entregar: false });

    const res = await request(app)
      .post(`${BASE}/products/${p}/avaliacoes`)
      .set('x-portal-token', token)
      .send({ rating: 5 })
      .expect(403);

    expect(res.body.error.code).toBe('PORTAL_REVIEW_NOT_ALLOWED');
    expect(res.body.error.message).toMatch(/comprou e já recebeu/i);
  });

  it('nota fora de 1 a 5 é 400 com a faixa dita', async () => {
    const p = produto();
    const token = await comprador({ productId: p, entregar: true });

    const res = await request(app)
      .post(`${BASE}/products/${p}/avaliacoes`)
      .set('x-portal-token', token)
      .send({ rating: 9 })
      .expect(400);
    expect(res.body.error.message).toMatch(/1 a 5/);
  });
});

describe('minha avaliação', () => {
  it('antes de avaliar devolve null; depois devolve a nota para editar', async () => {
    const p = produto();
    const token = await comprador({ productId: p, entregar: true });

    const antes = await request(app)
      .get(`${BASE}/products/${p}/minha-avaliacao`)
      .set('x-portal-token', token)
      .expect(200);
    expect(antes.body.review).toBeNull();

    await request(app)
      .post(`${BASE}/products/${p}/avaliacoes`)
      .set('x-portal-token', token)
      .send({ rating: 3, comment: 'Razoável' })
      .expect(201);

    const depois = await request(app)
      .get(`${BASE}/products/${p}/minha-avaliacao`)
      .set('x-portal-token', token)
      .expect(200);
    expect(depois.body.review.rating).toBe(3);
    expect(depois.body.review.comment).toBe('Razoável');
  });

  it('reavaliar pela rota EDITA em vez de somar', async () => {
    const p = produto();
    const token = await comprador({ productId: p, entregar: true });

    for (const nota of [5, 2]) {
      await request(app)
        .post(`${BASE}/products/${p}/avaliacoes`)
        .set('x-portal-token', token)
        .send({ rating: nota })
        .expect(201);
    }

    // Dez compras não dão dez votos.
    const res = await request(app).get(`${BASE}/products/${p}/avaliacoes`).expect(200);
    expect(res.body.count).toBe(1);
    expect(res.body.average).toBe(2);
  });
});
