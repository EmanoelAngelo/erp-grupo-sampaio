/**
 * O CAIXA NÃO ESCREVE O CADASTRO DE PRODUTO — GAP-PRD-052.
 *
 * `GET /products` é do escritório (403 para o caixa), e nenhuma tela do balcão
 * chama `updateProduct`: as duas que chamam (formulário e Alteração rápida) são
 * `ROTA_GESTAO`. Mas `PUT /products/:id` aceitava os dois `operador_caixa_*`.
 * Com o próprio token, o caixa baixava o preço de tabela (ou o custo, que
 * alimenta CMV e margem) e vendia pelo preço novo sem pedir liberação — a
 * alçada de desconto medida contra o preço vigente não via concessão nenhuma,
 * porque o vigente já era o baixo.
 *
 * `POST /products` (produto NOVO) segue aberto ao balcão, como modelam
 * `audit-pdv` e `cartao-tem-comprovante`: não muda o preço de item existente.
 *
 * Status EXATO em todos os casos, e o 200 de quem responde pelo cadastro
 * também é cobrado: guarda que recusa todo mundo passaria no teste de recusa.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetEnvCacheForTests } from '../src/config/env.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { issueSession } from './helpers/sessao.js';

process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-key';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-32-chars!!';

const EMPRESA = 'company-cadastro';

function auth(perfil: string): { Authorization: string } {
  const s = issueSession({ userId: `u-${perfil}`, companyId: EMPRESA, profileCodes: [perfil] });
  return { Authorization: `Bearer ${s.accessToken}` };
}

let app: ReturnType<typeof createApp>;

beforeEach(() => {
  resetEnvCacheForTests();
  resetDbForTests();
  app = createApp();
});

async function criarComoGerente(): Promise<string> {
  const res = await request(app)
    .post('/api/v1/core/products')
    .set(auth('gerente_loja'))
    .send({ name: 'Blusa de linho', priceCents: 3990, costCents: 1800 });
  expect(res.status).toBe(201);
  return String(res.body.id);
}

function noBanco(id: string): { price_cents: number; cost_cents: number } {
  return getConnection()
    .prepare('SELECT price_cents, cost_cents FROM core_products WHERE id = ?')
    .get(id) as { price_cents: number; cost_cents: number };
}

describe('o caixa não muda o preço de tabela pela API', () => {
  for (const caixa of ['operador_caixa_loja', 'operador_caixa_oficina', 'operador_caixa']) {
    it(`${caixa}: PUT /products/:id é 403 e o preço e o custo não mudam`, async () => {
      const id = await criarComoGerente();
      const res = await request(app)
        .put(`/api/v1/core/products/${id}`)
        .set(auth(caixa))
        .send({ name: 'Blusa de linho', priceCents: 990, costCents: 100 });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('API_PERMISSION_DENIED');
      // O ESTADO, e não só a resposta.
      expect(noBanco(id)).toEqual({ price_cents: 3990, cost_cents: 1800 });
    });
  }

  it('produto inexistente continua sendo 403 para o caixa, e não 404 (a guarda vem antes)', async () => {
    const res = await request(app)
      .put('/api/v1/core/products/nao-existe')
      .set(auth('operador_caixa_loja'))
      .send({ priceCents: 1 });
    expect(res.status).toBe(403);
  });

  /*
    PJ-CAIXA (regra do dono para a Preço Justo): o login do PDV da LOJA também
    não cria produto — criava com qualquer preço, custo, dado fiscal e até
    publicado online. O produto que não está no cadastro vai para o gestor. O
    caixa da OFICINA segue criando a peça nova (GAP-PRD-052, fora desta regra).
  */
  it('produto NOVO: o caixa da loja é 403 e nada nasce; o da oficina continua (201)', async () => {
    const id = await criarComoGerente();
    const loja = await request(app)
      .post('/api/v1/core/products')
      .set(auth('operador_caixa_loja'))
      .send({ name: 'Cinto', priceCents: 2500 });
    expect(loja.status).toBe(403);
    const cintos = getConnection()
      .prepare("SELECT COUNT(*) AS n FROM core_products WHERE company_id = ? AND name = 'Cinto'")
      .get(EMPRESA) as { n: number };
    expect(cintos.n).toBe(0);
    const oficina = await request(app)
      .post('/api/v1/core/products')
      .set(auth('operador_caixa_oficina'))
      .send({ name: 'Cinto de oficina', priceCents: 2500 });
    expect(oficina.status).toBe(201);
    expect(noBanco(id)).toEqual({ price_cents: 3990, cost_cents: 1800 });
  });

  it('o balcão continua lendo a ficha para vender — GET /products/:id segue 200 para o caixa', async () => {
    const id = await criarComoGerente();
    const res = await request(app)
      .get(`/api/v1/core/products/${id}`)
      .set(auth('operador_caixa_loja'));
    expect(res.status).toBe(200);
  });
});

describe('quem responde pelo cadastro continua escrevendo', () => {
  for (const perfil of ['gerente_loja', 'gerente_oficina', 'estoquista', 'gestor', 'admin_geral']) {
    it(`${perfil}: PUT /products/:id é 200 e grava o preço novo`, async () => {
      const id = await criarComoGerente();
      const res = await request(app)
        .put(`/api/v1/core/products/${id}`)
        .set(auth(perfil))
        .send({ name: 'Blusa de linho', priceCents: 3590 });
      expect(res.status).toBe(200);
      expect(noBanco(id).price_cents).toBe(3590);
    });
  }

  it('estoquista cria produto (201)', async () => {
    const res = await request(app)
      .post('/api/v1/core/products')
      .set(auth('estoquista'))
      .send({ name: 'Calça', priceCents: 8990 });
    expect(res.status).toBe(201);
  });

  it('atendente e mecânico continuam de fora (403), como sempre estiveram', async () => {
    const id = await criarComoGerente();
    for (const perfil of ['atendente', 'mecanico']) {
      const res = await request(app)
        .put(`/api/v1/core/products/${id}`)
        .set(auth(perfil))
        .send({ priceCents: 1 });
      expect(res.status).toBe(403);
    }
  });
});
