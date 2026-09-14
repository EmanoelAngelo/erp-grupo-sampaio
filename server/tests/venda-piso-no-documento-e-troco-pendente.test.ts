/**
 * ============================================================================
 * A VENDA NO SERVIDOR — complementos da trilha "venda" (lote 5)
 * ============================================================================
 *
 *   A-produto-17#orcamento  o piso de preço do cadastro valia no balcão, e o
 *                           orçamento/pré-venda o contornava: o documento media
 *                           só a concessão, e a conversão não conferia o piso.
 *                           Camiseta de piso R$ 25,00 escrita a R$ 23,92 (8%,
 *                           dentro dos 10% do operador) virava venda abaixo do
 *                           piso sem liberação de ninguém.
 *
 *   E-venda-servidor-07     troco contra PIX pendente: a tela bloqueava, a API
 *                           aceitava. Venda de R$ 100 com R$ 60 de PIX
 *                           pendente e R$ 50 em dinheiro fechava com troco zero
 *                           e R$ 10 que não eram de ninguém.
 *
 * Cada caso executa documento, conversão ou venda de verdade e confere o que
 * ficou no banco; cada um dos casos de recusa passava (201) na versão anterior.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { getConnection } from '../src/db/sqlite.js';
import {
  convertQuote,
  createQuote,
  promoteToPreSale,
  updateQuote,
} from '../src/services/core/QuoteService.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();
const LOJA = 'loja-venda-lote5';

type Auth = { Authorization: string };
let gerente: Auth;
let gerenteId: string;

/** Perfil de quem opera o caixa: nenhuma alçada para liberar nada. */
const CAIXA = { profileCodes: ['operador_caixa_loja'] };

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
  const g = await entrar('gerente-lote5', 'gerente_loja');
  gerente = g.auth;
  gerenteId = g.userId;
});

async function produto(precoCents: number, nome = `Produto ${randomUUID().slice(0, 6)}`): Promise<string> {
  const p = await request(app).post('/api/v1/core/products').set(gerente).send({ name: nome, priceCents: precoCents });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  const m = await request(app).post('/api/v1/core/stock/movements').set(gerente).send({
    productId: p.body.id,
    movementType: 'in',
    quantity: 20,
    referenceType: 'entrada',
    referenceId: `carga-${p.body.id as string}`,
  });
  expect(m.status, JSON.stringify(m.body)).toBeLessThan(300);
  return String(p.body.id);
}

/** Camiseta de R$ 26,00 com piso declarado de R$ 25,00 — o caso da auditoria. */
async function camisetaComPiso(): Promise<string> {
  const p = await produto(2600, 'Camiseta básica');
  getConnection().prepare('UPDATE core_products SET min_price_cents = 2500 WHERE id = ?').run(p);
  return p;
}

function liberacaoPara(requestedBy: string): string {
  const id = randomUUID();
  getConnection()
    .prepare(
      `INSERT INTO core_authorizations
         (id, company_id, action, requested_by, authorized_by, granted_concession_cents, created_at)
       VALUES (?, ?, 'desconto_acima_limite', ?, ?, NULL, ?)`,
    )
    .run(id, LOJA, requestedBy, gerenteId, new Date().toISOString());
  return id;
}

function gastaEm(liberacao: string): string | null {
  const linha = getConnection()
    .prepare('SELECT consumed_ref_id FROM core_authorizations WHERE id = ?')
    .get(liberacao) as { consumed_ref_id: string | null };
  return linha.consumed_ref_id;
}

function contar(sql: string, ...params: unknown[]): number {
  return Number((getConnection().prepare(sql).get(...params) as { n: number }).n);
}

const contarVendas = () => contar('SELECT COUNT(*) AS n FROM core_sales WHERE company_id = ?', LOJA);
const contarDocumentos = () => contar('SELECT COUNT(*) AS n FROM core_quotes WHERE company_id = ?', LOJA);

function documento(id: string): { status: string; authorization_id: string | null } {
  return getConnection()
    .prepare('SELECT status, authorization_id FROM core_quotes WHERE id = ?')
    .get(id) as never;
}

function erroDe(fn: () => unknown): { code: string; message: string; details?: Record<string, unknown> } {
  try {
    fn();
  } catch (err) {
    return err as { code: string; message: string; details?: Record<string, unknown> };
  }
  throw new Error('esperava um erro, e a operação passou');
}

async function abrirCaixa(auth: Auth): Promise<string> {
  const res = await request(app).post('/api/v1/core/cash/open').set(auth).send({ openingCents: 0 });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return String(res.body.id);
}

/**
 * Documento que NUNCA teve o piso conferido — o orçamento escrito antes deste
 * conserto, ou por um caminho interno sem alçada. `createQuote` sem `alcada` é
 * exatamente como esse papel era gravado.
 */
function documentoNaoConferido(productId: string, unitPriceCents = 2392): string {
  return String(
    createQuote({
      companyId: LOJA,
      userId: gerenteId,
      kind: 'orcamento',
      items: [{ productId, quantity: 1, unitPriceCents }],
    }).id,
  );
}

function converterPelaRota(quoteId: string, auth: Auth, corpo: Record<string, unknown>) {
  return request(app)
    .post(`/api/v1/core/quotes/${quoteId}/convert`)
    .set(auth)
    .set('Idempotency-Key', randomUUID())
    .send(corpo);
}

// ============================================================================
describe('A-produto-17#orcamento — o piso vale no documento', () => {
  it('orçamento a R$ 23,92 num produto de piso R$ 25,00 é recusado sem liberação — mesmo dentro dos 10%', async () => {
    const caixa = await entrar('caixa-lote5', 'operador_caixa_loja');
    const p = await camisetaComPiso();
    const res = await request(app)
      .post('/api/v1/core/quotes')
      .set(caixa.auth)
      .send({ kind: 'orcamento', items: [{ productId: p, quantity: 1, unitPriceCents: 2392 }] });
    // Antes: 201 — 8% de concessão, dentro da alçada, e o piso nunca lido.
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error.code).toBe('CORE_DISCOUNT_NEEDS_AUTHORIZATION');
    expect(res.body.error.message).toMatch(/Neste orçamento/);
    expect(res.body.error.message).toMatch(/"Camiseta básica" sai a R\$ 23,92 a unidade, abaixo do piso de R\$ 25,00/);
    expect(res.body.error.message).toMatch(/escreva ao menos o piso/);
    expect(res.body.error.details.abaixoDoPiso[0]).toMatchObject({
      productId: p,
      unitarioCobradoCents: 2392,
      pisoCents: 2500,
    });
    expect(contarDocumentos()).toBe(0);
  });

  it('com a liberação do gestor o orçamento nasce — e a liberação fica gasta nele', async () => {
    const caixa = await entrar('caixa-lote5', 'operador_caixa_loja');
    const p = await camisetaComPiso();
    const lib = liberacaoPara(caixa.userId);
    const res = await request(app)
      .post('/api/v1/core/quotes')
      .set(caixa.auth)
      .send({ kind: 'orcamento', items: [{ productId: p, quantity: 1, unitPriceCents: 2392 }], authorizationId: lib });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(documento(res.body.id).authorization_id).toBe(lib);
    expect(gastaEm(lib)).toBe(res.body.id);
  });

  it('o gerente escreve abaixo do piso sem pedir a si mesmo', async () => {
    const p = await camisetaComPiso();
    const res = await request(app)
      .post('/api/v1/core/quotes')
      .set(gerente)
      .send({ kind: 'orcamento', items: [{ productId: p, quantity: 1, unitPriceCents: 2392 }] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it('o desconto do rodapé também abate do que a linha cobra', async () => {
    const p = await camisetaComPiso();
    const erro = erroDe(() =>
      createQuote({
        companyId: LOJA,
        userId: gerenteId,
        kind: 'orcamento',
        items: [{ productId: p, quantity: 1 }],
        discountCents: 208,
        alcada: CAIXA,
      }),
    );
    expect(erro.code).toBe('CORE_DISCOUNT_NEEDS_AUTHORIZATION');
    expect((erro.details?.abaixoDoPiso as { unitarioCobradoCents: number }[])[0].unitarioCobradoCents).toBe(2392);
  });

  it('no piso ou acima, o operador escreve como sempre — e produto sem piso não é afetado', async () => {
    const p = await camisetaComPiso();
    const semPiso = await produto(2600);
    const doc = createQuote({
      companyId: LOJA,
      userId: gerenteId,
      kind: 'orcamento',
      items: [
        { productId: p, quantity: 1, unitPriceCents: 2500 },
        { productId: semPiso, quantity: 1, unitPriceCents: 2392 },
      ],
      alcada: CAIXA,
    });
    expect(documento(String(doc.id)).status).toBe('aberto');
  });

  it('a pré-venda escrita abaixo do piso também pede liberação', async () => {
    const p = await camisetaComPiso();
    const erro = erroDe(() =>
      createQuote({
        companyId: LOJA,
        userId: gerenteId,
        kind: 'pre_venda',
        items: [{ productId: p, quantity: 1, unitPriceCents: 2392 }],
        alcada: CAIXA,
      }),
    );
    expect(erro.code).toBe('CORE_DISCOUNT_NEEDS_AUTHORIZATION');
    expect(erro.message).toMatch(/Nesta pré-venda/);
    // Nada reservado: a recusa vem antes de segurar estoque.
    const saldo = getConnection()
      .prepare('SELECT reserved FROM core_stock WHERE company_id = ? AND product_id = ?')
      .get(LOJA, p) as { reserved: number };
    expect(saldo.reserved).toBe(0);
  });

  it('a EDIÇÃO que baixa o preço abaixo do piso é recusada, e o documento fica como estava', async () => {
    const p = await camisetaComPiso();
    const doc = createQuote({
      companyId: LOJA,
      userId: gerenteId,
      kind: 'orcamento',
      items: [{ productId: p, quantity: 1 }],
      alcada: CAIXA,
    });
    const erro = erroDe(() =>
      updateQuote({
        companyId: LOJA,
        userId: gerenteId,
        quoteId: String(doc.id),
        items: [{ productId: p, quantity: 1, unitPriceCents: 2392 }],
        alcada: CAIXA,
      }),
    );
    expect(erro.code).toBe('CORE_DISCOUNT_NEEDS_AUTHORIZATION');
    const item = getConnection()
      .prepare('SELECT unit_price_cents FROM core_quote_items WHERE quote_id = ?')
      .get(String(doc.id)) as { unit_price_cents: number };
    expect(item.unit_price_cents).toBe(2600);
  });
});

// ============================================================================
describe('A-produto-17#orcamento — o piso vale na conversão', () => {
  it('documento nunca conferido, abaixo do piso, convertido por quem não tem alçada: recusado, e nada muda', async () => {
    const caixa = await entrar('caixa-lote5', 'operador_caixa_loja');
    const gaveta = await abrirCaixa(caixa.auth);
    const p = await camisetaComPiso();
    const doc = documentoNaoConferido(p);

    const res = await converterPelaRota(doc, caixa.auth, {
      payments: [{ method: 'dinheiro', amountCents: 2392 }],
      cashSessionId: gaveta,
    });
    // Antes: 201 — a venda saía a R$ 23,92 num produto de piso R$ 25,00.
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error.code).toBe('CORE_DISCOUNT_NEEDS_AUTHORIZATION');
    expect(res.body.error.message).toMatch(/abaixo do piso de R\$ 25,00/);
    // A saída que o balcão tem na conversão: a liberação, ou corrigir o documento.
    expect(res.body.error.message).toMatch(/corrija o preço no documento/);
    expect(res.body.error.message).not.toMatch(/cobre ao menos o piso/);
    expect(contarVendas()).toBe(0);
    expect(documento(doc).status).toBe('aberto');
  });

  it('com a liberação trazida na conversão, a venda sai — e a liberação fica gasta nela', async () => {
    const caixa = await entrar('caixa-lote5', 'operador_caixa_loja');
    const gaveta = await abrirCaixa(caixa.auth);
    const p = await camisetaComPiso();
    const doc = documentoNaoConferido(p);
    const lib = liberacaoPara(caixa.userId);

    const res = await converterPelaRota(doc, caixa.auth, {
      payments: [{ method: 'dinheiro', amountCents: 2392 }],
      cashSessionId: gaveta,
      authorizationId: lib,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(gastaEm(lib)).toBe(res.body.saleId);
    expect(documento(doc).status).toBe('convertido');
  });

  it('o gerente converte o documento abaixo do piso sem pedir a si mesmo', () => {
    const p = camisetaComPisoSync();
    const doc = documentoNaoConferido(p);
    const r = convertQuote({
      companyId: LOJA,
      userId: gerenteId,
      quoteId: doc,
      idempotencyKey: randomUUID(),
      payments: [{ method: 'pix', amountCents: 2392 }],
      alcada: { profileCodes: ['gerente_loja'] },
    });
    expect(r.saleId).toBeTruthy();
  });

  it('chamador interno que não diz quem converte não ganha alçada — a trava falha FECHADA', () => {
    const p = camisetaComPisoSync();
    const doc = documentoNaoConferido(p);
    const erro = erroDe(() =>
      convertQuote({
        companyId: LOJA,
        userId: gerenteId,
        quoteId: doc,
        idempotencyKey: randomUUID(),
        payments: [{ method: 'pix', amountCents: 2392 }],
      }),
    );
    expect(erro.code).toBe('CORE_DISCOUNT_NEEDS_AUTHORIZATION');
    expect(contarVendas()).toBe(0);
  });

  it('documento LIBERADO quando foi escrito converte sem pedir de novo — mesmo por outro operador', async () => {
    const autor = await entrar('caixa-lote5', 'operador_caixa_loja');
    const outro = await entrar('caixa2-lote5', 'operador_caixa_loja');
    const gaveta = await abrirCaixa(outro.auth);
    const p = await camisetaComPiso();
    const lib = liberacaoPara(autor.userId);
    const criado = await request(app)
      .post('/api/v1/core/quotes')
      .set(autor.auth)
      .send({ kind: 'orcamento', items: [{ productId: p, quantity: 1, unitPriceCents: 2392 }], authorizationId: lib });
    expect(criado.status, JSON.stringify(criado.body)).toBe(201);

    const res = await converterPelaRota(String(criado.body.id), outro.auth, {
      payments: [{ method: 'dinheiro', amountCents: 2392 }],
      cashSessionId: gaveta,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it('orçamento liberado, aprovado em pré-venda: a liberação acompanha, e o caixa converte sem gestor', () => {
    const p = camisetaComPisoSync();
    const lib = liberacaoPara(gerenteId);
    const orcamento = createQuote({
      companyId: LOJA,
      userId: gerenteId,
      kind: 'orcamento',
      items: [{ productId: p, quantity: 1, unitPriceCents: 2392 }],
      alcada: { profileCodes: ['operador_caixa_loja'], authorizationId: lib },
    });
    const preVenda = promoteToPreSale({ companyId: LOJA, userId: gerenteId, quoteId: String(orcamento.id) });
    // Sem isto, a pré-venda nascia sem a assinatura e pedia gestor no caixa.
    expect(documento(String(preVenda.id)).authorization_id).toBe(lib);

    const r = convertQuote({
      companyId: LOJA,
      userId: gerenteId,
      quoteId: String(preVenda.id),
      idempotencyKey: randomUUID(),
      payments: [{ method: 'pix', amountCents: 2392 }],
      alcada: CAIXA,
    });
    expect(r.saleId).toBeTruthy();
  });

  /*
    REVISÃO — o preço de venda do CADASTRO abaixo do piso (R$ 24,00 com piso de
    R$ 25,00). `createSale` corta a linha de preço fechado no vigente; o
    documento não cortava. Escrito a R$ 25,00 (o conselho "escreva ao menos o
    piso"), o orçamento passava sem liberação e a conversão cobrava R$ 24,00 e
    recusava o operador dizendo que o documento fora escrito abaixo do piso.
  */
  it('cadastro abaixo do piso: o documento escrito NO piso é medido pelo que a venda cobra, e manda corrigir em Produtos', () => {
    const p = produtoSync(2400, 2500);
    const erro = erroDe(() =>
      createQuote({
        companyId: LOJA,
        userId: gerenteId,
        kind: 'orcamento',
        items: [{ productId: p, quantity: 1, unitPriceCents: 2500 }],
        alcada: CAIXA,
      }),
    );
    // Antes da revisão: o documento nascia (o escrito, R$ 25,00, cobria o piso).
    expect(erro.code).toBe('CORE_DISCOUNT_NEEDS_AUTHORIZATION');
    expect((erro.details?.abaixoDoPiso as { unitarioCobradoCents: number; precoDoCadastroCents: number }[])[0])
      .toMatchObject({ unitarioCobradoCents: 2400, precoDoCadastroCents: 2400 });
    expect(erro.message).toMatch(/preço de venda do cadastro, R\$ 24,00, já está abaixo desse piso/);
    expect(erro.message).toMatch(/corrija em Produtos/);
    expect(erro.message).not.toMatch(/escreva ao menos o piso/);
    expect(contarDocumentos()).toBe(0);
  });

  it('cadastro abaixo do piso na conversão: a recusa não acusa o documento de ter sido escrito abaixo', () => {
    const p = produtoSync(2400, 2500);
    const doc = documentoNaoConferido(p, 2500);
    const erro = erroDe(() =>
      convertQuote({
        companyId: LOJA,
        userId: gerenteId,
        quoteId: doc,
        idempotencyKey: randomUUID(),
        payments: [{ method: 'pix', amountCents: 2400 }],
        alcada: CAIXA,
      }),
    );
    expect(erro.code).toBe('CORE_DISCOUNT_NEEDS_AUTHORIZATION');
    // Antes da revisão: "o preço veio do documento, que foi escrito abaixo do piso".
    expect(erro.message).not.toMatch(/escrito abaixo do piso/);
    expect(erro.message).toMatch(/corrija o preço de venda em Produtos/);
    expect(contarVendas()).toBe(0);
    expect(documento(doc).status).toBe('aberto');
  });

  it('documento de produto sem piso converte como sempre, por quem não tem alçada', () => {
    const p = produtoSemPisoSync();
    const doc = documentoNaoConferido(p, 2392);
    const r = convertQuote({
      companyId: LOJA,
      userId: gerenteId,
      quoteId: doc,
      idempotencyKey: randomUUID(),
      payments: [{ method: 'pix', amountCents: 2392 }],
      alcada: CAIXA,
    });
    expect(r.saleId).toBeTruthy();
  });
});

// Produtos gravados direto — para os casos que chamam o serviço sem HTTP.
function produtoSync(precoCents: number, minPrice = 0): string {
  const id = randomUUID();
  const agora = new Date().toISOString();
  getConnection()
    .prepare(
      `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                  price_cents, category, open_price, active, min_price_cents,
                                  created_at, updated_at)
       VALUES (?, ?, ?, 'Camiseta básica', 'UN', 0, ?, 'Geral', 0, 1, ?, ?, ?)`,
    )
    .run(id, LOJA, id.slice(0, 8), precoCents, minPrice, agora, agora);
  getConnection()
    .prepare('INSERT INTO core_stock (company_id, product_id, quantity, reserved, updated_at) VALUES (?, ?, 20, 0, ?)')
    .run(LOJA, id, agora);
  return id;
}
const camisetaComPisoSync = () => produtoSync(2600, 2500);
const produtoSemPisoSync = () => produtoSync(2600, 0);

// ============================================================================
describe('E-venda-servidor-07 — troco não sai contra PIX pendente, também no servidor', () => {
  function vender(corpo: Record<string, unknown>) {
    return request(app).post('/api/v1/core/sales').set(gerente).set('Idempotency-Key', randomUUID()).send(corpo);
  }

  it('R$ 100 com R$ 60 de PIX pendente e R$ 50 em dinheiro: 409, e nada entra na gaveta', async () => {
    const gaveta = await abrirCaixa(gerente);
    const p = await produto(10_000);
    const res = await vender({
      items: [{ productId: p, quantity: 1 }],
      payments: [
        { method: 'pix', amountCents: 6000, status: 'pending' },
        { method: 'dinheiro', amountCents: 5000 },
      ],
      cashSessionId: gaveta,
    });
    // Antes: 201, troco zero, R$ 50 na gaveta e R$ 10 que não eram de ninguém.
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe('CORE_CHANGE_WITH_PENDING');
    expect(res.body.error.message).toContain('O PIX de R$ 60,00 ainda não caiu');
    expect(res.body.error.message).toContain('em R$ 10,00');
    expect(res.body.error.message).toContain('receba em dinheiro só R$ 40,00');
    expect(res.body.error.details).toMatchObject({
      pendenteCents: 6000,
      recebidoCents: 11_000,
      aCobrarCents: 10_000,
      excedenteCents: 1000,
      dinheiroQueFechaCents: 4000,
    });
    expect(contarVendas()).toBe(0);
    expect(contar('SELECT COUNT(*) AS n FROM core_cash_movements WHERE session_id = ? AND reference_type = ?', gaveta, 'sale')).toBe(0);
  });

  it('o dinheiro sozinho já cobre e o PIX pendente sobra: também recusado', async () => {
    const gaveta = await abrirCaixa(gerente);
    const p = await produto(10_000);
    const res = await vender({
      items: [{ productId: p, quantity: 1 }],
      payments: [
        { method: 'pix', amountCents: 6000, status: 'pending' },
        { method: 'dinheiro', amountCents: 15_000 },
      ],
      cashSessionId: gaveta,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe('CORE_CHANGE_WITH_PENDING');
    expect(res.body.error.details.dinheiroQueFechaCents).toBe(4000);
  });

  it('PIX pendente mais o dinheiro exato fecha como sempre, sem troco', async () => {
    const gaveta = await abrirCaixa(gerente);
    const p = await produto(10_000);
    const res = await vender({
      items: [{ productId: p, quantity: 1 }],
      payments: [
        { method: 'pix', amountCents: 6000, status: 'pending' },
        { method: 'dinheiro', amountCents: 4000 },
      ],
      cashSessionId: gaveta,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.change_cents).toBe(0);
  });

  it('sem PIX pendente, o dinheiro a mais continua virando troco', async () => {
    const gaveta = await abrirCaixa(gerente);
    const p = await produto(10_000);
    const res = await vender({
      items: [{ productId: p, quantity: 1 }],
      payments: [
        { method: 'pix', amountCents: 6000 },
        { method: 'dinheiro', amountCents: 5000 },
      ],
      cashSessionId: gaveta,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.change_cents).toBe(1000);
  });

  it('a conversão de documento passa pela mesma regra', async () => {
    const gaveta = await abrirCaixa(gerente);
    const p = produtoSemPisoSync();
    const doc = documentoNaoConferido(p, 2600);
    const erro = erroDe(() =>
      convertQuote({
        companyId: LOJA,
        userId: gerenteId,
        quoteId: doc,
        idempotencyKey: randomUUID(),
        // R$ 26,00: R$ 20,00 de PIX pendente e R$ 10,00 em dinheiro — R$ 4,00
        // a mais que não são troco de ninguém.
        payments: [
          { method: 'pix', amountCents: 2000, status: 'pending' },
          { method: 'dinheiro', amountCents: 1000 },
        ],
        cashSessionId: gaveta,
        alcada: { profileCodes: ['gerente_loja'] },
      }),
    );
    // Antes: a conversão fechava com troco zero e R$ 10 na gaveta.
    expect(erro.code).toBe('CORE_CHANGE_WITH_PENDING');
    expect(erro.details).toMatchObject({ excedenteCents: 400, dinheiroQueFechaCents: 600 });
    expect(contarVendas()).toBe(0);
    expect(documento(doc).status).toBe('aberto');
  });
});
