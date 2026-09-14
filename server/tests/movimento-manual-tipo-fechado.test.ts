process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';

/**
 * O MOVIMENTO MANUAL DE ESTOQUE TEM TRÊS DIREÇÕES, E SÓ TRÊS.
 *
 * `POST /core/stock/movements` repassava `movementType` cru para o razão.
 * Qualquer texto que não fosse 'out' virava delta POSITIVO: `reserve`, `xyz`
 * ou um erro de digitação somavam mercadoria à prateleira, sem motivo, com a
 * linha rotulada "Acerto de inventário (+)". E o tipo ausente estourava o
 * NOT NULL da coluna com um 500 cru.
 *
 * A tela manda só 'in', 'out' e 'adjust' (MovimentacoesEstoquePage). O
 * servidor passa a aceitar exatamente essas três, com 400 nomeado para o resto
 * — e nada gravado.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { linkUserToCompany, upsertCompany, upsertUser } from '../src/services/auth/IdentityService.js';

const app = createApp();
const SENHA = 'Senha@Estoque2026';
let loja: string;
let gestor: { Authorization: string };
let produto: string;

const movimentos = () =>
  (getConnection().prepare('SELECT count(*) AS n FROM core_stock_movements WHERE product_id = ?').get(produto) as { n: number }).n;
const saldo = () =>
  (getConnection().prepare('SELECT COALESCE(SUM(quantity), 0) AS q FROM core_stock WHERE product_id = ?').get(produto) as { q: number }).q;

beforeAll(async () => {
  resetDbForTests();
  loja = upsertCompany({ slug: 'preco-justo', legalName: 'Preço Justo Comércio Ltda', tradeName: 'Preço Justo' });
  const g = await upsertUser({ login: 'GESTOR.ESTOQUE', displayName: 'Gestor', password: SENHA });
  linkUserToCompany(g, loja, 'gerente_loja', true);
  const r = await request(app).post('/api/v1/auth/login').send({ login: 'GESTOR.ESTOQUE', password: SENHA, companyId: loja });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  gestor = { Authorization: `Bearer ${r.body.accessToken}` };
  const p = await request(app).post('/api/v1/core/products').set(gestor).send({ name: 'Arroz 5kg', priceCents: 2490 });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  produto = p.body.id;
}, 60_000);

describe('o tipo do movimento manual é uma lista fechada', () => {
  for (const tipo of ['reserve', 'release', 'xyz', undefined]) {
    it(`movementType ${tipo === undefined ? 'ausente' : `'${tipo}'`}: 400 nomeado e nada gravado`, async () => {
      const antes = { movs: movimentos(), saldo: saldo() };
      const r = await request(app)
        .post('/api/v1/core/stock/movements')
        .set(gestor)
        .send({ productId: produto, ...(tipo === undefined ? {} : { movementType: tipo }), quantity: 5, referenceType: 'manual', referenceId: `tipo-${String(tipo)}` });
      expect(r.status, JSON.stringify(r.body)).toBe(400);
      expect(r.body.error?.code).toBe('CORE_MOVEMENT_TYPE_INVALID');
      expect({ movs: movimentos(), saldo: saldo() }).toEqual(antes);
    });
  }

  it("as três direções da tela continuam: 'in' soma, 'out' com motivo tira, 'adjust' acerta", async () => {
    const entra = await request(app).post('/api/v1/core/stock/movements').set(gestor)
      .send({ productId: produto, movementType: 'in', quantity: 10, referenceType: 'entrada', referenceId: 'nf-1' });
    expect(entra.status, JSON.stringify(entra.body)).toBe(201);
    expect(saldo()).toBe(10);
    const sai = await request(app).post('/api/v1/core/stock/movements').set(gestor)
      .send({ productId: produto, movementType: 'out', quantity: 2, referenceType: 'perda', referenceId: 'perda-1', reason: 'embalagem rasgada' });
    expect(sai.status, JSON.stringify(sai.body)).toBe(201);
    expect(saldo()).toBe(8);
    const acerta = await request(app).post('/api/v1/core/stock/movements').set(gestor)
      .send({ productId: produto, movementType: 'adjust', quantity: -1, referenceType: 'ajuste', referenceId: 'ajuste-1', reason: 'contagem' });
    expect(acerta.status, JSON.stringify(acerta.body)).toBe(201);
    expect(saldo()).toBe(7);
  });
});
