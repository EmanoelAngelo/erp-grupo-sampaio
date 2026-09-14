/**
 * EXCLUIR PRODUTO: SÓ O QUE NUNCA ACONTECEU SAI DO BANCO.
 *
 * Até esta frente não existia exclusão de produto — nenhuma rota DELETE, nenhum
 * `DELETE FROM core_products` no repositório. Só inativar pelo PUT. E um DELETE
 * ingênuo seria pior que a falta dele: com a FK ligada, dezesseis filhas caem
 * em CASCADE, e entre elas está o RAZÃO de estoque (`core_stock_movements`), as
 * unidades serializadas e os lotes. Um produto que só teve entrada manual
 * sumiria com a entrada junto, sem erro nenhum.
 *
 * A regra cobrada aqui:
 *
 *   - SEM histórico (nada vendido, comprado, contado, movimentado, orçado,
 *     alugado, consignado, lançado em OS, pedido online…) no produto nem nas
 *     variantes dele → exclusão física controlada: variantes, códigos, fotos (e
 *     o ARQUIVO da foto), preços, faixas, promoção nunca usada, campos
 *     personalizados, de-para de fornecedor e saldo zerado saem; a trilha grava
 *     `product.deleted` com o retrato do que era; a central recebe o tombstone.
 *   - COM histórico → 409 `CORE_PRODUCT_HAS_HISTORY`, a lista do que prende e a
 *     saída (inativar). E NADA muda.
 *
 * Status EXATO em todos os casos, e o 200 de quem pode também é cobrado: guarda
 * que recusa todo mundo passaria no teste de recusa.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetEnvCacheForTests } from '../src/config/env.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { generateVariants } from '../src/services/core/VariantService.js';
import { uploadsDir } from '../src/services/core/ProductImageService.js';
import { issueSession } from './helpers/sessao.js';

process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-key';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-32-chars!!';

const EMPRESA = 'company-exclusao';
const OUTRA = 'company-exclusao-outra';

/** PNG de 1×1 — o menor arquivo que o serviço de fotos aceita. */
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

function auth(perfil: string, empresa = EMPRESA): { Authorization: string } {
  const s = issueSession({
    userId: `u-${perfil}-${empresa}`,
    companyId: empresa,
    profileCodes: [perfil],
  });
  return { Authorization: `Bearer ${s.accessToken}` };
}

let app: ReturnType<typeof createApp>;

beforeEach(() => {
  resetEnvCacheForTests();
  resetDbForTests();
  app = createApp();
});

async function criar(nome: string, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await request(app)
    .post('/api/v1/core/products')
    .set(auth('gerente_loja'))
    .send({ name: nome, priceCents: 3990, costCents: 1800, ...extra });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return String(res.body.id);
}

async function entrada(productId: string, quantidade: number): Promise<void> {
  const res = await request(app)
    .post('/api/v1/core/stock/movements')
    .set(auth('gerente_loja'))
    .send({
      productId,
      movementType: 'in',
      quantity: quantidade,
      referenceType: 'entrada',
      referenceId: `carga-${randomUUID()}`,
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
}

async function vender(productId: string, totalCents: number): Promise<string> {
  const res = await request(app)
    .post('/api/v1/core/sales')
    .set(auth('gerente_loja'))
    .set('Idempotency-Key', randomUUID())
    .send({
      items: [{ productId, quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: totalCents }],
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return String((res.body.sale ?? res.body).id);
}

function excluir(productId: string, perfil = 'gerente_loja', empresa = EMPRESA) {
  return request(app).delete(`/api/v1/core/products/${productId}`).set(auth(perfil, empresa));
}

function contar(sql: string, ...params: unknown[]): number {
  const linha = getConnection().prepare(sql).get(...(params as never[])) as { n: number };
  return Number(linha.n);
}

function existe(productId: string): boolean {
  return contar('SELECT COUNT(*) AS n FROM core_products WHERE id = ?', productId) === 1;
}

describe('produto sem histórico: a exclusão é física e não deixa órfão', () => {
  it('apaga produto, variantes, códigos, fotos (e o arquivo), preços, campos, promoção, de-para — e grava trilha e tombstone', async () => {
    const id = await criar('Blusa de linho', { barcode: '7890000001007' });
    const db = getConnection();
    const agora = new Date().toISOString();

    // Código adicional.
    const codigo = await request(app)
      .post(`/api/v1/core/products/${id}/barcodes`)
      .set(auth('gerente_loja'))
      .send({ barcode: '7890000001014' });
    expect(codigo.status, JSON.stringify(codigo.body)).toBe(201);

    // Foto — e o arquivo no disco.
    const foto = await request(app)
      .post(`/api/v1/core/products/${id}/images`)
      .set(auth('gerente_loja'))
      .send({ dataUrl: PNG, fileName: 'blusa.png' });
    expect(foto.status, JSON.stringify(foto.body)).toBe(201);
    const arquivo = join(uploadsDir(), String(foto.body.url).split('/').pop() ?? '');
    expect(existsSync(arquivo)).toBe(true);

    // Faixa de preço por quantidade.
    const faixa = await request(app)
      .put(`/api/v1/core/products/${id}/price-tiers`)
      .set(auth('gerente_loja'))
      .send({ minQuantity: 3, priceCents: 3000 });
    expect(faixa.status, JSON.stringify(faixa.body)).toBe(200);

    // Item de tabela de preço, campo personalizado, promoção NUNCA usada e
    // de-para de fornecedor: gravados direto, que é como a importação e as
    // telas auxiliares os deixam.
    db.prepare(
      `INSERT INTO core_price_tables (id, company_id, name, percent_off, active, created_at, updated_at)
       VALUES ('tab-atacado', ?, 'Atacado', 0, 1, ?, ?)`,
    ).run(EMPRESA, agora, agora);
    db.prepare(
      `INSERT INTO core_price_table_items (id, company_id, price_table_id, product_id, price_cents, created_at, updated_at)
       VALUES ('tab-item-1', ?, 'tab-atacado', ?, 3500, ?, ?)`,
    ).run(EMPRESA, id, agora, agora);
    db.prepare(
      `INSERT INTO core_custom_fields (id, company_id, code, label, kind, entity, position, active, created_at, updated_at)
       VALUES ('cf-tecido', ?, 'TECIDO', 'Tecido', 'text', 'product', 0, 1, ?, ?)`,
    ).run(EMPRESA, agora, agora);
    db.prepare(
      `INSERT INTO core_custom_field_values (id, company_id, field_id, entity, entity_id, value, updated_at)
       VALUES ('cfv-1', ?, 'cf-tecido', 'product', ?, 'Linho', ?)`,
    ).run(EMPRESA, id, agora);
    db.prepare(
      `INSERT INTO core_promotions (id, company_id, product_id, price_cents, starts_at, active, created_at)
       VALUES ('promo-nunca-usada', ?, ?, 2990, ?, 1, ?)`,
    ).run(EMPRESA, id, agora, agora);
    db.prepare(
      `INSERT INTO core_suppliers (id, company_id, name, created_at) VALUES ('forn-1', ?, 'Tecelagem', ?)`,
    ).run(EMPRESA, agora);
    db.prepare(
      `INSERT INTO core_supplier_item_codes (id, company_id, supplier_id, supplier_code, product_id, origin, created_at, updated_at)
       VALUES ('depara-1', ?, 'forn-1', 'TEC-9', ?, 'vinculo_manual', ?, ?)`,
    ).run(EMPRESA, id, agora, agora);

    // Grade: duas variantes, cada uma com o próprio código.
    const grade = generateVariants({ companyId: EMPRESA, productId: id, axes: { tamanho: ['P', 'M'] } });
    const variantes = grade.created.map((v) => String((v as { id: string }).id));
    expect(variantes).toHaveLength(2);

    const res = await excluir(id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.deleted).toBe(true);

    // O produto e a grade saíram.
    expect(existe(id)).toBe(false);
    for (const v of variantes) expect(existe(v)).toBe(false);
    const todos = [id, ...variantes];
    const marcas = todos.map(() => '?').join(',');
    for (const [tabela, coluna] of [
      ['core_product_barcodes', 'product_id'],
      ['core_product_images', 'product_id'],
      ['core_price_table_items', 'product_id'],
      ['core_product_price_tiers', 'product_id'],
      ['core_promotions', 'product_id'],
      ['core_custom_field_values', 'entity_id'],
      ['core_supplier_item_codes', 'product_id'],
      ['core_stock', 'product_id'],
    ] as const) {
      expect(
        contar(`SELECT COUNT(*) AS n FROM ${tabela} WHERE ${coluna} IN (${marcas})`, ...todos),
        `${tabela} ficou com linha do produto excluído`,
      ).toBe(0);
    }
    // O ARQUIVO da foto: o CASCADE não faz unlink, e a foto órfã iria no
    // backup e continuaria servida por URL pública.
    expect(existsSync(arquivo)).toBe(false);
    // A tabela de preço em si é da loja, não do produto: fica.
    expect(contar("SELECT COUNT(*) AS n FROM core_price_tables WHERE id = 'tab-atacado'")).toBe(1);

    // A trilha: quem apagou o quê, com o retrato — o id não diz mais nada a ninguém.
    const trilha = getConnection()
      .prepare(
        "SELECT user_id, detail FROM core_audit_log WHERE action = 'product.deleted' AND entity_id = ?",
      )
      .all(id) as { user_id: string; detail: string }[];
    expect(trilha).toHaveLength(1);
    expect(trilha[0].user_id).toBe(`u-gerente_loja-${EMPRESA}`);
    const retrato = JSON.parse(trilha[0].detail) as Record<string, unknown>;
    expect(retrato.name).toBe('Blusa de linho');
    expect(retrato.barcode).toBe('7890000001007');
    expect(retrato.barcodes).toEqual(['7890000001014']);
    expect(String(retrato.internal_code ?? '')).not.toBe('');
    expect((retrato.variants as unknown[]).length).toBe(2);

    // A central: tombstone do modelo, com a operação de exclusão.
    const evento = getConnection()
      .prepare(
        `SELECT event_type, operation, payload FROM core_outbox
          WHERE aggregate_type = 'product' AND aggregate_id = ? ORDER BY seq DESC LIMIT 1`,
      )
      .get(id) as { event_type: string; operation: string; payload: string };
    expect(evento.event_type).toBe('product.deactivated');
    expect(evento.operation).toBe('delete');
    expect(JSON.parse(evento.payload).active).toBe(0);

    // E a ficha responde que não existe mais.
    const ficha = await request(app).get(`/api/v1/core/products/${id}`).set(auth('gerente_loja'));
    expect(ficha.status).toBe(404);
  });

  it('gerente de oficina também exclui (o par de gerência do catálogo)', async () => {
    const id = await criar('Cabo USB');
    const res = await excluir(id, 'gerente_oficina');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(existe(id)).toBe(false);
  });
});

describe('produto com histórico: 409 com o motivo, e nada muda', () => {
  it('UMA venda prende o produto — a resposta diz quantas e oferece inativar', async () => {
    const id = await criar('Cinto', { barcode: '7890000002004' });
    await entrada(id, 5);
    await vender(id, 3990);
    const movimentosAntes = contar(
      'SELECT COUNT(*) AS n FROM core_stock_movements WHERE product_id = ?',
      id,
    );

    const res = await excluir(id);

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe('CORE_PRODUCT_HAS_HISTORY');
    const historico = res.body.error.details.historico as { codigo: string; quantidade: number }[];
    expect(historico.find((h) => h.codigo === 'vendas')?.quantidade).toBe(1);
    expect(res.body.error.details.saida).toBe('inativar');
    expect(res.body.error.message).toContain('1 venda');
    expect(res.body.error.message).toMatch(/inativ/i);

    // NADA mudou: o produto, o código, o razão, a trilha.
    expect(existe(id)).toBe(true);
    expect(
      contar('SELECT COUNT(*) AS n FROM core_products WHERE id = ? AND active = 1', id),
    ).toBe(1);
    expect(
      contar('SELECT COUNT(*) AS n FROM core_stock_movements WHERE product_id = ?', id),
    ).toBe(movimentosAntes);
    expect(
      contar("SELECT COUNT(*) AS n FROM core_audit_log WHERE action = 'product.deleted'"),
    ).toBe(0);
  });

  it('só uma ENTRADA MANUAL de estoque já é histórico — o razão não cai em CASCADE', async () => {
    const id = await criar('Meia');
    await entrada(id, 2);

    const res = await excluir(id);

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe('CORE_PRODUCT_HAS_HISTORY');
    const historico = res.body.error.details.historico as { codigo: string; quantidade: number }[];
    expect(historico.find((h) => h.codigo === 'movimentos_estoque')?.quantidade).toBe(1);
    expect(existe(id)).toBe(true);
    expect(contar('SELECT COUNT(*) AS n FROM core_stock_movements WHERE product_id = ?', id)).toBe(1);
  });

  it('o histórico de uma VARIANTE prende o modelo inteiro', async () => {
    const id = await criar('Camiseta');
    const grade = generateVariants({ companyId: EMPRESA, productId: id, axes: { tamanho: ['P'] } });
    const variante = String((grade.created[0] as { id: string }).id);
    await entrada(variante, 1);

    const res = await excluir(id);

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe('CORE_PRODUCT_HAS_HISTORY');
    expect(existe(id)).toBe(true);
    expect(existe(variante)).toBe(true);
  });

  it('a saída oferecida funciona: inativar, e a venda antiga continua dizendo o nome do item', async () => {
    const id = await criar('Bolsa');
    await entrada(id, 3);
    const venda = await vender(id, 3990);
    expect((await excluir(id)).status).toBe(409);

    const inativar = await request(app)
      .put(`/api/v1/core/products/${id}`)
      .set(auth('gerente_loja'))
      .send({ active: false });
    expect(inativar.status, JSON.stringify(inativar.body)).toBe(200);
    expect(inativar.body.active).toBe(0);

    // O histórico continua mostrando o produto…
    const ficha = await request(app).get(`/api/v1/core/sales/${venda}`).set(auth('gerente_loja'));
    expect(ficha.status, JSON.stringify(ficha.body)).toBe(200);
    expect(ficha.body.items[0].description).toBe('Bolsa');
    // …e o inativo continua consultável por id.
    const produto = await request(app).get(`/api/v1/core/products/${id}`).set(auth('gerente_loja'));
    expect(produto.status).toBe(200);
    expect(produto.body.active).toBe(0);
  });
});

describe('quem pode e de quem é', () => {
  it('produto de OUTRA empresa é 404 — e continua lá', async () => {
    const id = await criar('Jaqueta');
    const res = await excluir(id, 'gerente_loja', OUTRA);
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(res.body.error.code).toBe('CORE_PRODUCT_NOT_FOUND');
    expect(existe(id)).toBe(true);
  });

  for (const perfil of ['estoquista', 'operador_caixa_loja', 'atendente', 'mecanico']) {
    it(`${perfil}: 403 e o produto continua`, async () => {
      const id = await criar(`Item de ${perfil}`);
      const res = await excluir(id, perfil);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('API_PERMISSION_DENIED');
      expect(existe(id)).toBe(true);
    });
  }
});

describe('a lista do cadastro separa ativos de inativos', () => {
  it('?situacao=ativos só traz ativos; ?situacao=inativos só os arquivados; sem filtro, todos', async () => {
    await criar('Ativo A');
    const b = await criar('Inativo B');
    await request(app)
      .put(`/api/v1/core/products/${b}`)
      .set(auth('gerente_loja'))
      .send({ active: false })
      .expect(200);

    const ativos = await request(app)
      .get('/api/v1/core/products?situacao=ativos')
      .set(auth('gerente_loja'));
    expect(ativos.status).toBe(200);
    expect(ativos.body.items.map((p: { name: string }) => p.name)).toEqual(['Ativo A']);
    expect(ativos.body.total).toBe(1);

    const inativos = await request(app)
      .get('/api/v1/core/products?situacao=inativos')
      .set(auth('gerente_loja'));
    expect(inativos.body.items.map((p: { name: string }) => p.name)).toEqual(['Inativo B']);
    expect(inativos.body.total).toBe(1);

    const todos = await request(app).get('/api/v1/core/products').set(auth('gerente_loja'));
    expect(todos.body.total).toBe(2);
  });
});

describe('o balcão sabe quando o catálogo está vazio', () => {
  it('sem produto ativo nenhum, a busca vazia diz catalogoVazio — com produto, não', async () => {
    const vazio = await request(app)
      .get('/api/v1/core/products/search?q=qualquer')
      .set(auth('operador_caixa_loja'));
    expect(vazio.status).toBe(200);
    expect(vazio.body.items).toEqual([]);
    expect(vazio.body.catalogoVazio).toBe(true);

    await criar('Produto de verdade');
    const semAchar = await request(app)
      .get('/api/v1/core/products/search?q=naoexiste')
      .set(auth('operador_caixa_loja'));
    expect(semAchar.body.items).toEqual([]);
    expect(semAchar.body.catalogoVazio).toBe(false);
  });
});
