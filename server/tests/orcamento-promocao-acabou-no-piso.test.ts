/**
 * ============================================================================
 * A PROMOÇÃO DO DOCUMENTO QUE ACABOU ANTES DA CONVERSÃO — revisão do
 * A-produto-R01 (qualidade da mensagem, P3)
 * ============================================================================
 *
 * O caixa escreve a pré-venda pelo preço da promoção do gerente, abaixo do piso
 * do produto — e pode, sem liberação, porque o preço é da GESTÃO. A promoção
 * acaba antes da conversão. A conversão corta a linha no preço do documento e
 * recusa o caixa — o bloqueio está certo, a promoção não existe mais —, mas a
 * frase dizia "o preço veio do documento, que foi escrito abaixo do piso sem
 * liberação". O documento foi escrito certo; a causa é a promoção que acabou.
 *
 * O conserto grava a procedência do preço de cada linha
 * (`core_quote_items.price_source`) e a conversão a leva à recusa. Os outros
 * casos — a linha escrita abaixo do piso à mão, e a linha anterior à coluna —
 * seguem com a frase de antes.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { getConnection } from '../src/db/sqlite.js';
import { createQuote, updateQuote } from '../src/services/core/QuoteService.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();
const LOJA = 'loja-promocao-acabou';

type Auth = { Authorization: string };
let gerente: Auth;
let gerenteId: string;

const FRASE_ANTIGA = 'o preço veio do documento, que foi escrito abaixo do piso sem liberação';

async function entrar(userId: string, perfil: string): Promise<{ auth: Auth; userId: string }> {
  const res = await loginForTest(app, { userId, companyId: LOJA, profileCodes: [perfil] });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return {
    auth: { Authorization: `Bearer ${res.body.accessToken as string}` },
    userId: String(res.body.user.id),
  };
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  const g = await entrar('gerente-promo-acabou', 'gerente_loja');
  gerente = g.auth;
  gerenteId = g.userId;
});

/** Perfume de R$ 30,00 com piso declarado de R$ 25,00, e 20 no estoque. */
async function perfumeComPiso(): Promise<string> {
  const p = await request(app)
    .post('/api/v1/core/products')
    .set(gerente)
    .send({ name: 'Perfume Floral', priceCents: 3000 });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  const m = await request(app).post('/api/v1/core/stock/movements').set(gerente).send({
    productId: p.body.id,
    movementType: 'in',
    quantity: 20,
    referenceType: 'entrada',
    referenceId: `carga-${p.body.id as string}`,
  });
  expect(m.status, JSON.stringify(m.body)).toBeLessThan(300);
  getConnection().prepare('UPDATE core_products SET min_price_cents = 2500 WHERE id = ?').run(p.body.id);
  return String(p.body.id);
}

/** A promoção é do GERENTE: R$ 23,92, abaixo do piso. */
async function promocaoDoGerente(productId: string): Promise<string> {
  const res = await request(app)
    .post('/api/v1/core/promotions')
    .set(gerente)
    .send({ productId, priceCents: 2392 });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return String(res.body.id);
}

/** A promoção acaba: a data de fim vai para dois dias atrás. */
function acabarPromocao(promotionId: string): void {
  const ontemDeAnteontem = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  getConnection().prepare('UPDATE core_promotions SET ends_at = ? WHERE id = ?').run(ontemDeAnteontem, promotionId);
}

async function abrirCaixa(auth: Auth): Promise<string> {
  const res = await request(app).post('/api/v1/core/cash/open').set(auth).send({ openingCents: 0 });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return String(res.body.id);
}

function converterPelaRota(quoteId: string, auth: Auth, corpo: Record<string, unknown>) {
  return request(app)
    .post(`/api/v1/core/quotes/${quoteId}/convert`)
    .set(auth)
    .set('Idempotency-Key', randomUUID())
    .send(corpo);
}

function procedencia(quoteId: string): (string | null)[] {
  return (
    getConnection()
      .prepare('SELECT price_source FROM core_quote_items WHERE quote_id = ?')
      .all(quoteId) as { price_source: string | null }[]
  ).map((r) => r.price_source);
}

function contarVendas(): number {
  return Number(
    (getConnection().prepare('SELECT COUNT(*) AS n FROM core_sales WHERE company_id = ?').get(LOJA) as { n: number }).n,
  );
}

function statusDo(quoteId: string): string {
  return (getConnection().prepare('SELECT status FROM core_quotes WHERE id = ?').get(quoteId) as { status: string })
    .status;
}

// ============================================================================
describe('A-produto-R01 (revisão) — a promoção que dava o preço do documento acabou antes da conversão', () => {
  it('pré-venda do caixa pelo preço da promoção: aceita; a promoção acaba; a conversão recusa dizendo que a PROMOÇÃO acabou', async () => {
    const caixa = await entrar('caixa-promo-acabou', 'operador_caixa_loja');
    const gaveta = await abrirCaixa(caixa.auth);
    const p = await perfumeComPiso();
    const promo = await promocaoDoGerente(p);

    // O caixa escreve pelo preço da promoção, sem liberação: é preço da gestão.
    const criado = await request(app)
      .post('/api/v1/core/quotes')
      .set(caixa.auth)
      .send({ kind: 'pre_venda', items: [{ productId: p, quantity: 1 }] });
    expect(criado.status, JSON.stringify(criado.body)).toBe(201);
    const doc = String(criado.body.id);
    const linha = getConnection()
      .prepare('SELECT unit_price_cents, price_source FROM core_quote_items WHERE quote_id = ?')
      .get(doc) as { unit_price_cents: number; price_source: string | null };
    expect(linha).toEqual({ unit_price_cents: 2392, price_source: 'promocao' });

    acabarPromocao(promo);

    const res = await converterPelaRota(doc, caixa.auth, {
      payments: [{ method: 'dinheiro', amountCents: 2392 }],
      cashSessionId: gaveta,
    });
    // O bloqueio continua: a promoção não existe mais e R$ 23,92 está abaixo do piso.
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error.code).toBe('CORE_DISCOUNT_NEEDS_AUTHORIZATION');
    const mensagem = String(res.body.error.message);
    // A causa real.
    expect(mensagem).toContain('promoção');
    expect(mensagem).toContain('acabou');
    expect(mensagem).toContain(
      '"Perfume Floral": a promoção que dava R$ 23,92 quando o documento foi escrito já acabou, '
        + 'e esse preço está abaixo do piso de R$ 25,00.',
    );
    expect(mensagem).toContain('Peça a liberação agora, ou atualize o preço no documento antes de converter.');
    // Antes: culpava o documento, que foi escrito certo.
    expect(mensagem).not.toContain('escrito abaixo do piso sem liberação');
    expect(res.body.error.details.abaixoDoPiso[0]).toMatchObject({
      productId: p,
      unitarioCobradoCents: 2392,
      pisoCents: 2500,
      precoDoCadastroCents: null,
      precoDaGestao: null,
      precoDaGestaoQueAcabou: { fonte: 'promocao', precoCents: 2392 },
    });
    // Nada mudou: nem venda, nem documento.
    expect(contarVendas()).toBe(0);
    expect(statusDo(doc)).toBe('aberto');
  });

  it('controle: a linha escrita À MÃO abaixo do piso segue com a frase de antes, que culpa o documento', async () => {
    const caixa = await entrar('caixa-promo-acabou', 'operador_caixa_loja');
    const gaveta = await abrirCaixa(caixa.auth);
    const p = await perfumeComPiso();
    // Sem promoção nenhuma: R$ 23,92 digitado num documento que nunca teve o
    // piso conferido (chamador interno, sem alçada — como o papel antigo).
    const doc = String(
      createQuote({
        companyId: LOJA,
        userId: gerenteId,
        kind: 'orcamento',
        items: [{ productId: p, quantity: 1, unitPriceCents: 2392 }],
      }).id,
    );
    expect(procedencia(doc)).toEqual(['digitado']);

    const res = await converterPelaRota(doc, caixa.auth, {
      payments: [{ method: 'dinheiro', amountCents: 2392 }],
      cashSessionId: gaveta,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error.code).toBe('CORE_DISCOUNT_NEEDS_AUTHORIZATION');
    expect(res.body.error.message).toContain(FRASE_ANTIGA);
    expect(res.body.error.message).toContain('corrija o preço no documento antes de converter');
    expect(res.body.error.message).not.toContain('acabou');
    expect(res.body.error.details.abaixoDoPiso[0].precoDaGestaoQueAcabou).toBeNull();
    expect(contarVendas()).toBe(0);
  });

  it('controle: linha anterior à coluna (procedência nula) segue com a frase de antes', async () => {
    const caixa = await entrar('caixa-promo-acabou', 'operador_caixa_loja');
    const gaveta = await abrirCaixa(caixa.auth);
    const p = await perfumeComPiso();
    const promo = await promocaoDoGerente(p);
    const criado = await request(app)
      .post('/api/v1/core/quotes')
      .set(caixa.auth)
      .send({ kind: 'pre_venda', items: [{ productId: p, quantity: 1 }] });
    expect(criado.status, JSON.stringify(criado.body)).toBe(201);
    const doc = String(criado.body.id);
    // O documento gravado antes desta coluna existir não tem procedência.
    getConnection().prepare('UPDATE core_quote_items SET price_source = NULL WHERE quote_id = ?').run(doc);
    acabarPromocao(promo);

    const res = await converterPelaRota(doc, caixa.auth, {
      payments: [{ method: 'dinheiro', amountCents: 2392 }],
      cashSessionId: gaveta,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error.message).toContain(FRASE_ANTIGA);
    expect(res.body.error.message).not.toContain('acabou');
  });

  it('com a promoção ainda de pé, a mesma pré-venda converte sem ninguém', async () => {
    const caixa = await entrar('caixa-promo-acabou', 'operador_caixa_loja');
    const gaveta = await abrirCaixa(caixa.auth);
    const p = await perfumeComPiso();
    await promocaoDoGerente(p);
    const criado = await request(app)
      .post('/api/v1/core/quotes')
      .set(caixa.auth)
      .send({ kind: 'pre_venda', items: [{ productId: p, quantity: 1 }] });
    expect(criado.status, JSON.stringify(criado.body)).toBe(201);

    const res = await converterPelaRota(String(criado.body.id), caixa.auth, {
      payments: [{ method: 'dinheiro', amountCents: 2392 }],
      cashSessionId: gaveta,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(contarVendas()).toBe(1);
  });

  it('a procedência é gravada pelos DOIS escritores: a criação e a edição', async () => {
    const p = await perfumeComPiso();
    const CAIXA = { profileCodes: ['operador_caixa_loja'] };
    // Sem promoção: o preço é o do cadastro.
    const doc = String(
      createQuote({
        companyId: LOJA,
        userId: gerenteId,
        kind: 'orcamento',
        items: [{ productId: p, quantity: 1 }],
        alcada: CAIXA,
      }).id,
    );
    expect(procedencia(doc)).toEqual(['cadastro']);

    // Outro preço escrito à mão (acima do piso, dentro da alçada): 'digitado'.
    updateQuote({
      companyId: LOJA,
      userId: gerenteId,
      quoteId: doc,
      items: [{ productId: p, quantity: 1, unitPriceCents: 2900 }],
      alcada: CAIXA,
    });
    expect(procedencia(doc)).toEqual(['digitado']);

    // Com a promoção no ar, a edição pelo preço vigente grava a promoção.
    await promocaoDoGerente(p);
    updateQuote({
      companyId: LOJA,
      userId: gerenteId,
      quoteId: doc,
      items: [{ productId: p, quantity: 1 }],
      alcada: CAIXA,
    });
    expect(procedencia(doc)).toEqual(['promocao']);
  });
});
