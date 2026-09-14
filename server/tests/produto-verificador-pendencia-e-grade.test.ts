/**
 * O QUE A VERIFICAÇÃO DA FRENTE PRODUTO ACHOU DEPOIS DO ENGENHEIRO.
 *
 * 1. A VENDA OFFLINE PENDENTE PRENDE O PRODUTO.
 *
 *    Com o servidor fora do ar, o PDV vende e guarda; se o reenvio for recusado
 *    de vez (gaveta fechada, saldo que acabou), a venda é ENTREGUE ao servidor
 *    como pendência (`core_offline_sale_pendings`) — e o dinheiro dela JÁ está
 *    na gaveta. O relançamento chama `createSale` com o corpo guardado. A
 *    coluna é JSON, sem FK: a lista da exclusão não a via, e um produto novo,
 *    sem saldo nem movimento, vendido nessas condições saía do banco. A
 *    pendência passava a apontar para um id que não existe, e o relançamento
 *    era 404 para sempre: a venda que aconteceu não podia mais ser registrada.
 *
 * 2. A VARIANTE DE MODELO INATIVO FICA FORA DO ORÇAMENTO E DA CONSIGNAÇÃO.
 *
 *    A frente fez a variante herdar o modelo no PDV, na venda, no checkout e na
 *    grade — mas o orçamento/pré-venda e a consignação conferiam só o `active`
 *    da própria linha. O tamanho de um modelo arquivado entrava numa remessa
 *    consignada (tirando mercadoria da prateleira e reservando saldo) e numa
 *    pré-venda, e só estourava depois, na hora de faturar.
 *
 * Cada recusa tem o controle positivo ao lado.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { resetEnvCacheForTests } from '../src/config/env.js';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { getConnection } from '../src/db/sqlite.js';
import { criarConsignacao } from '../src/services/core/ConsignmentService.js';
import { createQuote } from '../src/services/core/QuoteService.js';
import { registrarVendaOfflineRecusada } from '../src/services/core/VendasOfflineRecusadas.js';
import { issueSession } from './helpers/sessao.js';

process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-key';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-32-chars!!';

const EMPRESA = 'company-verificador-produto';
const CAIXA = 'u-caixa-verificador';
const GERENTE = 'u-gerente-verificador';

let app: ReturnType<typeof createApp>;

function auth(perfil: string, userId: string): { Authorization: string } {
  const s = issueSession({ userId, companyId: EMPRESA, profileCodes: [perfil] });
  return { Authorization: `Bearer ${s.accessToken}` };
}

function inserir(input: { id: string; ativo?: boolean; parentId?: string | null }): string {
  const agora = new Date().toISOString();
  const db = getConnection();
  db.prepare(
    `INSERT INTO core_products
       (id, company_id, internal_code, name, unit, cost_cents, price_cents,
        active, publish_online, kind, parent_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'UN', 1000, 5000, ?, 1, 'retail', ?, ?, ?)`,
  ).run(
    input.id,
    EMPRESA,
    `COD-${input.id}`,
    `Produto ${input.id}`,
    input.ativo === false ? 0 : 1,
    input.parentId ?? null,
    agora,
    agora,
  );
  db.prepare(
    'INSERT INTO core_stock (company_id, product_id, quantity, reserved, updated_at) VALUES (?, ?, 10, 0, ?)',
  ).run(EMPRESA, input.id, agora);
  return input.id;
}

function codigoDoErro(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? String(err);
  }
}

beforeEach(() => {
  resetEnvCacheForTests();
  resetDbForTests();
  ensureCoreSchema();
  app = createApp();
  // Provisiona o caixa e o gerente de verdade (usuário da casa).
  auth('operador_caixa_loja', CAIXA);
  auth('gerente_loja', GERENTE);
});

describe('a venda offline pendente prende o produto', () => {
  it('pendência com o produto → 409 com o motivo; descartada, a exclusão passa', async () => {
    const gerente = auth('gerente_loja', GERENTE);
    // Produto novo, sem saldo nem movimento: o único rastro é a venda guardada.
    const criado = await request(app)
      .post('/api/v1/core/products')
      .set(gerente)
      .send({ name: 'Capinha nova', priceCents: 5000 });
    expect(criado.status, JSON.stringify(criado.body)).toBe(201);
    const id = String(criado.body.id);

    const entregue = registrarVendaOfflineRecusada({
      companyId: EMPRESA,
      userId: CAIXA,
      idempotencyKey: `offline-${randomUUID()}`,
      body: {
        items: [{ productId: id, quantity: 1 }],
        payments: [{ method: 'dinheiro', amountCents: 5000 }],
      },
      errorCode: 'CORE_CASH_SESSION_CLOSED',
      errorMessage: 'O caixa daquele turno fechou.',
    });
    expect(entregue.jaSubiu).toBe(false);
    const pendenciaId = (entregue as { pendencia: { id: string } }).pendencia.id;

    const recusa = await request(app).delete(`/api/v1/core/products/${id}`).set(gerente);
    expect(recusa.status, JSON.stringify(recusa.body)).toBe(409);
    expect(recusa.body.error.code).toBe('CORE_PRODUCT_HAS_HISTORY');
    const historico = recusa.body.error.details.historico as { codigo: string; quantidade: number }[];
    expect(historico.find((h) => h.codigo === 'vendas_offline_pendentes')?.quantidade).toBe(1);
    expect(
      (getConnection().prepare('SELECT COUNT(*) AS n FROM core_products WHERE id = ?').get(id) as { n: number }).n,
    ).toBe(1);

    // Descartada (a venda não vai existir), nada mais depende do cadastro.
    getConnection()
      .prepare("UPDATE core_offline_sale_pendings SET status = 'descartada' WHERE id = ?")
      .run(pendenciaId);
    const exclusao = await request(app).delete(`/api/v1/core/products/${id}`).set(gerente);
    expect(exclusao.status, JSON.stringify(exclusao.body)).toBe(200);
  });

  it('corpo guardado ilegível não derruba a exclusão de outro produto', async () => {
    const gerente = auth('gerente_loja', GERENTE);
    const agora = new Date().toISOString();
    getConnection()
      .prepare(
        `INSERT INTO core_offline_sale_pendings
           (id, company_id, idempotency_key, request_body, status, reported_at, last_reported_at)
         VALUES ('pend-quebrada', ?, 'chave-quebrada', '{nao e json', 'pendente', ?, ?)`,
      )
      .run(EMPRESA, agora, agora);
    const criado = await request(app)
      .post('/api/v1/core/products')
      .set(gerente)
      .send({ name: 'Película', priceCents: 1500 });
    expect(criado.status).toBe(201);
    const res = await request(app).delete(`/api/v1/core/products/${criado.body.id}`).set(gerente);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });
});

describe('a variante de modelo inativo fica fora do orçamento e da consignação', () => {
  beforeEach(() => {
    inserir({ id: 'modelo', ativo: false });
    inserir({ id: 'var-p', parentId: 'modelo' });
    inserir({ id: 'modelo-ok' });
    inserir({ id: 'var-ok', parentId: 'modelo-ok' });
  });

  it('ORÇAMENTO e PRÉ-VENDA recusam o tamanho do modelo inativo — e aceitam o do ativo', () => {
    for (const kind of ['orcamento', 'pre_venda'] as const) {
      const cotar = (productId: string) => () =>
        createQuote({
          companyId: EMPRESA,
          userId: CAIXA,
          kind,
          items: [{ productId, quantity: 1 }],
        });
      expect(codigoDoErro(cotar('var-p')), kind).toBe('CORE_PRODUCT_NOT_FOUND');
      expect(codigoDoErro(cotar('var-ok')), kind).toBeNull();
    }
  });

  it('CONSIGNAÇÃO recusa o tamanho do modelo inativo — e aceita o do ativo', async () => {
    const cliente = await request(app)
      .post('/api/v1/core/customers')
      .set(auth('gerente_loja', GERENTE))
      .send({ name: 'Cliente Consignado', document: '11122233396' });
    expect(cliente.status, JSON.stringify(cliente.body)).toBe(201);
    const remeter = (productId: string) => () =>
      criarConsignacao({
        companyId: EMPRESA,
        userId: GERENTE,
        customerId: String(cliente.body.id),
        items: [{ productId, quantity: 1 }],
        idempotencyKey: randomUUID(),
      });
    expect(codigoDoErro(remeter('var-p'))).toBe('CORE_PRODUCT_NOT_FOUND');
    expect(
      (getConnection().prepare('SELECT COUNT(*) AS n FROM core_consignment_items WHERE product_id = ?').get('var-p') as {
        n: number;
      }).n,
    ).toBe(0);
    expect(codigoDoErro(remeter('var-ok'))).toBeNull();
  });
});
