/**
 * O CAIXA DA LOJA OPERA O PDV E NÃO ADMINISTRA ESTOQUE NEM CADASTRO
 * (H-caixa-seguranca-02 e H-caixa-seguranca-03, regra do dono PJ-CAIXA).
 *
 * Com o token do login "PREÇO JUSTO" (operador_caixa_loja):
 *   - POST /stock/movements 'in' subia o saldo sem motivo nem gestor, e 'out'
 *     sumia com a mercadoria com um motivo livre;
 *   - POST /purchases/notes/:id/confirm dava entrada da nota (estoque e custo)
 *     e, com createMissing, criava produto;
 *   - POST /products criava produto com preço, custo, NCM e CFOP do corpo.
 *
 * As duas camadas precisavam fechar: a guarda por perfil (`requireProfile`) e
 * a ponte de capability (`pdv.backoffice` no modelo do caixa da loja). Tirar só
 * o perfil deixava a ponte reabrir a rota. Os casos abaixo passam pelas duas.
 *
 * O controle também é cobrado — a gerência continua fazendo, e o caixa da
 * OFICINA segue com a retaguarda de balcão (GAP-PRD-052) —: guarda que recusa
 * todo mundo passaria no teste de recusa.
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

const EMPRESA = 'company-pj-caixa';

function auth(perfil: string): { Authorization: string } {
  const s = issueSession({ userId: `u-${perfil}`, companyId: EMPRESA, profileCodes: [perfil] });
  return { Authorization: `Bearer ${s.accessToken}` };
}

let app: ReturnType<typeof createApp>;
let produto: string;

const saldo = () =>
  (getConnection().prepare('SELECT COALESCE(SUM(quantity), 0) AS q FROM core_stock WHERE product_id = ?').get(produto) as {
    q: number;
  }).q;

beforeEach(async () => {
  resetEnvCacheForTests();
  resetDbForTests();
  app = createApp();
  const p = await request(app).post('/api/v1/core/products').set(auth('gerente_loja')).send({ name: 'Arroz 5kg', priceCents: 2490 });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  produto = String(p.body.id);
});

describe('o caixa da loja não mexe no estoque pela API', () => {
  it("entrada 'in' e saída 'out' são 403, e o saldo não muda", async () => {
    const entra = await request(app)
      .post('/api/v1/core/stock/movements')
      .set(auth('operador_caixa_loja'))
      .send({ productId: produto, movementType: 'in', quantity: 50, referenceType: 'entrada', referenceId: 'x1' });
    expect(entra.status, JSON.stringify(entra.body)).toBe(403);
    const sai = await request(app)
      .post('/api/v1/core/stock/movements')
      .set(auth('operador_caixa_loja'))
      .send({ productId: produto, movementType: 'out', quantity: 5, referenceType: 'perda', referenceId: 'x2', reason: 'perda' });
    expect(sai.status, JSON.stringify(sai.body)).toBe(403);
    expect(saldo()).toBe(0);
  });

  it('a gerência e o caixa da OFICINA continuam dando entrada', async () => {
    const gerente = await request(app)
      .post('/api/v1/core/stock/movements')
      .set(auth('gerente_loja'))
      .send({ productId: produto, movementType: 'in', quantity: 6, referenceType: 'entrada', referenceId: 'g1' });
    expect(gerente.status, JSON.stringify(gerente.body)).toBe(201);
    const oficina = await request(app)
      .post('/api/v1/core/stock/movements')
      .set(auth('operador_caixa_oficina'))
      .send({ productId: produto, movementType: 'in', quantity: 4, referenceType: 'entrada', referenceId: 'o1' });
    expect(oficina.status, JSON.stringify(oficina.body)).toBe(201);
    expect(saldo()).toBe(10);
  });
});

describe('o caixa da loja não recebe nota de compra nem cria produto', () => {
  it('confirmar e vincular nota são 403 para o caixa da loja — a guarda vem antes da nota', async () => {
    for (const rota of ['/api/v1/core/purchases/notes/nota-qualquer/confirm', '/api/v1/core/purchases/notes/nota-qualquer/link']) {
      const r = await request(app).post(rota).set(auth('operador_caixa_loja')).send({ createMissing: true, productId: produto });
      expect(r.status, `${rota} ${JSON.stringify(r.body)}`).toBe(403);
    }
  });

  /*
    As OUTRAS portas da entrada de nota que o achado listou (revisão do
    H-caixa-seguranca-02): importar e pré-visualizar NF-e, conferir item,
    importar CT-e e listar notas. Todas perderam o caixa da loja na guarda e
    ficaram sem a ponte (`pdv.backoffice` saiu do modelo).
  */
  it('importar NF-e/CT-e, pré-visualizar, conferir e listar notas: 403 para o caixa da loja', async () => {
    const caixa = auth('operador_caixa_loja');
    const pedidos = [
      request(app).post('/api/v1/core/purchases/nfe/preview').set(caixa).send({ xml: '<nfe/>' }),
      request(app).post('/api/v1/core/purchases/nfe/import').set(caixa).send({ xml: '<nfe/>' }),
      request(app).post('/api/v1/core/purchases/cte/import').set(caixa).send({ xml: '<cte/>' }),
      request(app).post('/api/v1/core/purchases/notes/nota-qualquer/conferir').set(caixa).send({ itemIndex: 0 }),
      request(app).get('/api/v1/core/purchases/notes').set(caixa),
    ];
    for (const r of await Promise.all(pedidos)) {
      expect(r.status, `${r.req.method} ${r.req.path} ${JSON.stringify(r.body)}`).toBe(403);
    }
  });

  it('para a gerência a mesma rota passa da guarda (a nota é que não existe)', async () => {
    const r = await request(app)
      .post('/api/v1/core/purchases/notes/nota-qualquer/confirm')
      .set(auth('gerente_loja'))
      .send({ createMissing: true });
    expect(r.status).not.toBe(403);
    expect(r.status).not.toBe(401);
  });

  it('POST /products é 403 para o caixa da loja, e nada nasce', async () => {
    const r = await request(app)
      .post('/api/v1/core/products')
      .set(auth('operador_caixa_loja'))
      .send({ name: 'Capa iPhone', priceCents: 100, ncm: '00000000', cfop: '5102' });
    expect(r.status, JSON.stringify(r.body)).toBe(403);
    const n = (getConnection().prepare("SELECT COUNT(*) AS n FROM core_products WHERE name = 'Capa iPhone'").get() as { n: number }).n;
    expect(n).toBe(0);
  });
});
