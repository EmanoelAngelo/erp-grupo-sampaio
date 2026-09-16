/**
 * ============================================================================
 * TARA E PISOS PERCENTUAIS PASSAM PELA ALFÂNDEGA DO CADASTRO (P00-prod-03)
 * ============================================================================
 *
 * Três campos do cadastro de produto entravam CRUS, e cada um estraga uma coisa
 * diferente no balcão:
 *
 *   - TARA EM TEXTO. `tareGrams: "abc"` ficava gravado como a palavra "abc"
 *     numa coluna INTEGER (o SQLite guarda o que lhe derem), e a exportação da
 *     balança escreve `String(tare_grams ?? 0)` direto no arquivo: a balança
 *     recebia "abc" como tara.
 *   - TARA NEGATIVA. Tara é o que se DESCONTA do peso bruto. Com -50 a balança
 *     SOMARIA 50 gramas a cada pesagem — o cliente pagando pela embalagem que o
 *     campo existe justamente para não cobrar.
 *   - PISO PERCENTUAL SEM CONFERÊNCIA NA CRIAÇÃO. Só o PUT chamava
 *     `percentualEditado`; o POST gravava o que viesse. E um markup mínimo
 *     "abc" não estoura em lugar nenhum — `pisoDoPreco` descarta o que não é
 *     finito, `avaliarPreco` compara número com texto (sempre falso). O gestor
 *     configura o piso, a tela diz "Produto criado", e a venda abaixo do mínimo
 *     passa em silêncio para sempre. Negativo passava nas DUAS portas: piso
 *     abaixo de zero autoriza qualquer preço.
 *
 * ## Como cada guarda falha (quebrando de propósito)
 *
 *   - tire `taraEmGramas` de `createProduct`/`atualizarProduto` e o texto volta
 *     à coluna de gramas;
 *   - tire o `numero < 0` de `percentualDoPiso` e o piso negativo volta;
 *   - volte `percentualEditado` a conferir sozinho e a criação volta a ser o
 *     contorno da edição.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetEnvCacheForTests } from '../src/config/env.js';
import { resetDbForTests } from '../src/db/database.js';
import { getProduct } from '../src/services/core/CatalogService.js';
import { cloneProduct } from '../src/services/core/ProductCloneService.js';
import { getConnection } from '../src/db/sqlite.js';
import { issueSession } from './helpers/sessao.js';

process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-key';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-32-chars!!';

const PJ = 'preco-justo-tara';

let app: ReturnType<typeof createApp>;

function auth(perfil: string): { Authorization: string } {
  const s = issueSession({ userId: `u-${perfil}-${PJ}`, companyId: PJ, profileCodes: [perfil] });
  return { Authorization: `Bearer ${s.accessToken}` };
}

const post = (body: Record<string, unknown>) =>
  request(app).post('/api/v1/core/products').set(auth('gerente_loja')).send(body);

const put = (id: string, body: Record<string, unknown>) =>
  request(app).put(`/api/v1/core/products/${id}`).set(auth('gerente_loja')).send(body);

async function criar(body: Record<string, unknown>) {
  const r = await post(body);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as Record<string, unknown> & { id: string };
}

const ler = (id: string) => getProduct(PJ, id) as Record<string, unknown>;

beforeEach(() => {
  resetEnvCacheForTests();
  resetDbForTests();
  app = createApp();
  auth('gerente_loja');
});

describe('a tara é peso de embalagem, em gramas (P00-prod-03)', () => {
  it('tara em texto é recusada com motivo, na criação e na edição', async () => {
    const r = await post({ name: 'Tomate', weighable: true, tareGrams: 'abc' });
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect(r.body.error.code).toBe('CORE_INVALID_TARE');

    const tomate = await criar({ name: 'Tomate', weighable: true, priceCents: 899 });
    const edicao = await put(tomate.id, { tareGrams: 'abc' });
    expect(edicao.status, JSON.stringify(edicao.body)).toBe(400);
    expect(edicao.body.error.code).toBe('CORE_INVALID_TARE');
    expect(ler(tomate.id).tare_grams).toBeNull();
  });

  it('tara negativa é recusada: a balança SOMARIA peso em vez de descontar', async () => {
    const r = await post({ name: 'Tomate', weighable: true, tareGrams: -50 });
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect(r.body.error.code).toBe('CORE_INVALID_TARE');
  });

  it('tara fracionada é recusada: a balança trabalha em gramas cheias', async () => {
    const r = await post({ name: 'Tomate', weighable: true, tareGrams: 12.5 });
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect(r.body.error.code).toBe('CORE_INVALID_TARE');
  });

  it('tara válida entra; ausente preserva; vazio limpa', async () => {
    const tomate = await criar({ name: 'Tomate', weighable: true, tareGrams: 12, priceCents: 899 });
    expect(ler(tomate.id).tare_grams).toBe(12);

    await put(tomate.id, { priceCents: 999 }).expect(200);
    expect(ler(tomate.id).tare_grams).toBe(12);

    await put(tomate.id, { tareGrams: '' }).expect(200);
    expect(ler(tomate.id).tare_grams).toBeNull();
  });

  it('o clone de um cadastro antigo com lixo na tara nasce SEM tara, e não é recusado', async () => {
    const tomate = await criar({ name: 'Tomate', weighable: true, priceCents: 899 });
    // O estado que o banco antigo tem: texto numa coluna de gramas.
    getConnection()
      .prepare("UPDATE core_products SET tare_grams = 'abc', min_markup_percent = 'abc' WHERE id = ?")
      .run(tomate.id);

    const clone = cloneProduct(PJ, tomate.id);
    const copia = ler(String(clone.id));
    expect(copia.tare_grams).toBeNull();
    expect(copia.min_markup_percent).toBeNull();
  });
});

describe('markup e margem mínimos são conferidos nas DUAS portas (P00-prod-03)', () => {
  it('texto é recusado TAMBÉM na criação', async () => {
    for (const campo of ['minMarkupPercent', 'minMarginPercent']) {
      const r = await post({ name: 'Perfume', [campo]: 'abc' });
      expect(r.status, `${campo}: ${JSON.stringify(r.body)}`).toBe(400);
      expect(r.body.error.code).toBe('CORE_PRICE_FLOOR_INVALID');
    }
  });

  it('percentual negativo é recusado: piso abaixo de zero não é piso', async () => {
    const r = await post({ name: 'Perfume', minMarginPercent: -300 });
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect(r.body.error.code).toBe('CORE_PRICE_FLOOR_INVALID');

    const perfume = await criar({ name: 'Perfume', priceCents: 9900 });
    const edicao = await put(perfume.id, { minMarkupPercent: -1 });
    expect(edicao.status, JSON.stringify(edicao.body)).toBe(400);
    expect(edicao.body.error.code).toBe('CORE_PRICE_FLOOR_INVALID');
  });

  it('o piso legítimo continua entrando, e o vazio continua tirando', async () => {
    const perfume = await criar({ name: 'Perfume', priceCents: 9900, minMarkupPercent: 30 });
    expect(ler(perfume.id).min_markup_percent).toBe(30);

    await put(perfume.id, { minMarkupPercent: '' }).expect(200);
    expect(ler(perfume.id).min_markup_percent).toBeNull();
  });
});
