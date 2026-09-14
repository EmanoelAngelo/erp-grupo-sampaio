/**
 * ============================================================================
 * O PISO ASSINADO PELA GERÊNCIA NO DOCUMENTO VALE NA CONVERSÃO
 * (A-produto-17#assinado)
 * ============================================================================
 *
 * O DEFEITO: o gerente escreve a pré-venda abaixo do piso de preço do produto
 * para um cliente especial. Ele tem alçada, então o documento nasce sem gastar
 * liberação — `authorization_id` fica nulo. A conversão confere o piso e só
 * deixava passar sem pedir de novo o documento com `authorization_id`: o caixa
 * que faturava a pré-venda era barrado pedindo a liberação que o gerente já
 * tinha dado ao escrever.
 *
 * O conserto grava QUEM assinou (`core_quotes.floor_authorized_by`) quando quem
 * escreve tem alçada e alguma linha fica abaixo do piso, apaga a assinatura
 * quando outra pessoa reescreve o documento (ou ele volta ao piso), leva a
 * assinatura do orçamento para a pré-venda aprovada, e deixa a conversão passar
 * o documento assinado — com a trilha dizendo de quem era a decisão.
 *
 * COMO FALHA SEM O CONSERTO: a primeira conversão devolve 403
 * CORE_DISCOUNT_NEEDS_AUTHORIZATION (o caixa é barrado), a coluna fica nula e
 * o detalhe do documento não tem `pisoAssinadoPor`.
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
  getQuoteDetail,
  promoteToPreSale,
  updateQuote,
} from '../src/services/core/QuoteService.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();
const LOJA = 'loja-piso-assinado';

type Auth = { Authorization: string };
let gerente: Auth;
let gerenteId: string;

/** Perfil de quem opera o caixa: nenhuma alçada para liberar nada. */
const CAIXA = { profileCodes: ['operador_caixa_loja'] };
const GERENCIA = { profileCodes: ['gerente_loja'] };

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
  const g = await entrar('gerente-piso', 'gerente_loja');
  gerente = g.auth;
  gerenteId = g.userId;
});

/** Camiseta de R$ 26,00 com piso declarado de R$ 25,00 e 20 no estoque. */
function camisetaComPiso(): string {
  const id = randomUUID();
  const agora = new Date().toISOString();
  getConnection()
    .prepare(
      `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                  price_cents, category, open_price, active, min_price_cents,
                                  created_at, updated_at)
       VALUES (?, ?, ?, 'Camiseta básica', 'UN', 0, 2600, 'Geral', 0, 1, 2500, ?, ?)`,
    )
    .run(id, LOJA, id.slice(0, 8), agora, agora);
  getConnection()
    .prepare('INSERT INTO core_stock (company_id, product_id, quantity, reserved, updated_at) VALUES (?, ?, 20, 0, ?)')
    .run(LOJA, id, agora);
  return id;
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

function documento(id: string): {
  status: string;
  authorization_id: string | null;
  floor_authorized_by: string | null;
} {
  return getConnection()
    .prepare('SELECT status, authorization_id, floor_authorized_by FROM core_quotes WHERE id = ?')
    .get(id) as never;
}

function auditoria(acao: string): { entity_id: string; detail: string }[] {
  return getConnection()
    .prepare('SELECT entity_id, detail FROM core_audit_log WHERE company_id = ? AND action = ?')
    .all(LOJA, acao) as never;
}

const contarVendas = () =>
  Number(
    (getConnection().prepare('SELECT COUNT(*) AS n FROM core_sales WHERE company_id = ?').get(LOJA) as {
      n: number;
    }).n,
  );

function erroDe(fn: () => unknown): { code: string; message: string; status?: number } {
  try {
    fn();
  } catch (err) {
    return err as { code: string; message: string; status?: number };
  }
  throw new Error('esperava um erro, e a operação passou');
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

/** O gerente escreve o documento abaixo do piso, sem liberação — ele tem alçada. */
function documentoDoGerente(productId: string, kind: 'orcamento' | 'pre_venda' = 'pre_venda'): string {
  return String(
    createQuote({
      companyId: LOJA,
      userId: gerenteId,
      kind,
      items: [{ productId, quantity: 1, unitPriceCents: 2392 }],
      alcada: GERENCIA,
    }).id,
  );
}

// ============================================================================
describe('A-produto-17#assinado — o gerente escreve, o caixa converte', () => {
  it('pré-venda do gerente abaixo do piso: o caixa fatura no balcão SEM liberação', async () => {
    const caixa = await entrar('caixa-piso', 'operador_caixa_loja');
    const gaveta = await abrirCaixa(caixa.auth);
    const p = camisetaComPiso();

    const criado = await request(app)
      .post('/api/v1/core/quotes')
      .set(gerente)
      .send({ kind: 'pre_venda', items: [{ productId: p, quantity: 1, unitPriceCents: 2392 }] });
    expect(criado.status, JSON.stringify(criado.body)).toBe(201);
    const doc = String(criado.body.id);
    // O gerente não gastou liberação — e a assinatura dele ficou no documento.
    expect(documento(doc)).toMatchObject({ authorization_id: null, floor_authorized_by: gerenteId });

    const res = await converterPelaRota(doc, caixa.auth, {
      payments: [{ method: 'dinheiro', amountCents: 2392 }],
      cashSessionId: gaveta,
    });
    // Antes: 403 CORE_DISCOUNT_NEEDS_AUTHORIZATION — o caixa era barrado.
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(documento(doc).status).toBe('convertido');

    // A trilha diz de quem era a decisão: quem converteu não respondeu pelo piso.
    const rastro = auditoria('quote.convert.piso_assinado');
    expect(rastro).toHaveLength(1);
    expect(JSON.parse(rastro[0].detail)).toMatchObject({
      saleId: res.body.saleId,
      pisoAssinadoPor: gerenteId,
    });
  });

  it('a assinatura fica na trilha da criação, com a linha e o preço assinados', () => {
    const p = camisetaComPiso();
    const doc = documentoDoGerente(p);
    const rastro = auditoria('quote.piso_assinado');
    expect(rastro).toHaveLength(1);
    expect(rastro[0].entity_id).toBe(doc);
    expect(JSON.parse(rastro[0].detail)).toMatchObject({
      acao: 'criacao',
      pisoAssinadoPor: gerenteId,
      linhas: [{ productId: p, unitarioCobradoCents: 2392, pisoCents: 2500 }],
    });
  });

  it('o detalhe do documento diz quem assinou o piso', () => {
    const p = camisetaComPiso();
    const doc = documentoDoGerente(p);
    const detalhe = getQuoteDetail(LOJA, doc) as { pisoAssinadoPor: { userId: string; nome: string | null } | null };
    expect(detalhe.pisoAssinadoPor?.userId).toBe(gerenteId);
    expect(detalhe.pisoAssinadoPor?.nome).toBeTruthy();
  });

  it('no piso, o gerente não assina nada — não há o que assinar', () => {
    const p = camisetaComPiso();
    const doc = createQuote({
      companyId: LOJA,
      userId: gerenteId,
      kind: 'orcamento',
      items: [{ productId: p, quantity: 1, unitPriceCents: 2500 }],
      alcada: GERENCIA,
    });
    expect(documento(String(doc.id)).floor_authorized_by).toBeNull();
    expect(auditoria('quote.piso_assinado')).toHaveLength(0);
  });

  it('orçamento do gerente aprovado em pré-venda: a assinatura acompanha, e o caixa converte', () => {
    const p = camisetaComPiso();
    const orcamento = documentoDoGerente(p, 'orcamento');
    const preVenda = promoteToPreSale({ companyId: LOJA, userId: gerenteId, quoteId: orcamento });
    // Sem isto, a pré-venda nascia sem assinatura (createQuote sem alçada).
    expect(documento(String(preVenda.id)).floor_authorized_by).toBe(gerenteId);

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
});

// ============================================================================
describe('A-produto-17#assinado — a liberação do operador continua valendo', () => {
  it('operador escreve abaixo do piso COM liberação: a conversão por outro operador não pede de novo', async () => {
    const autor = await entrar('caixa-autor', 'operador_caixa_loja');
    const outro = await entrar('caixa-outro', 'operador_caixa_loja');
    const gaveta = await abrirCaixa(outro.auth);
    const p = camisetaComPiso();
    const lib = liberacaoPara(autor.userId);
    const criado = await request(app)
      .post('/api/v1/core/quotes')
      .set(autor.auth)
      .send({ kind: 'orcamento', items: [{ productId: p, quantity: 1, unitPriceCents: 2392 }], authorizationId: lib });
    expect(criado.status, JSON.stringify(criado.body)).toBe(201);
    // Quem não tem alçada não assina: a cobertura é a liberação.
    expect(documento(String(criado.body.id))).toMatchObject({ authorization_id: lib, floor_authorized_by: null });

    const res = await converterPelaRota(String(criado.body.id), outro.auth, {
      payments: [{ method: 'dinheiro', amountCents: 2392 }],
      cashSessionId: gaveta,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    // Liberação já tem o próprio rastro; a linha da assinatura não aparece.
    expect(auditoria('quote.convert.piso_assinado')).toHaveLength(0);
  });
});

// ============================================================================
describe('A-produto-17#assinado — a assinatura é da versão que o gerente escreveu', () => {
  it('documento assinado e depois reescrito sem alçada: a assinatura some, e a conversão pede liberação', () => {
    const p = camisetaComPiso();
    const doc = documentoDoGerente(p);
    expect(documento(doc).floor_authorized_by).toBe(gerenteId);

    // Reescrito por um caminho que não diz quem escreve — ninguém assina por ele.
    updateQuote({
      companyId: LOJA,
      userId: gerenteId,
      quoteId: doc,
      items: [{ productId: p, quantity: 1, unitPriceCents: 2300 }],
    });
    expect(documento(doc).floor_authorized_by).toBeNull();

    const erro = erroDe(() =>
      convertQuote({
        companyId: LOJA,
        userId: gerenteId,
        quoteId: doc,
        idempotencyKey: randomUUID(),
        payments: [{ method: 'pix', amountCents: 2300 }],
        alcada: CAIXA,
      }),
    );
    // A linha alterada depois não é a que o gerente assinou.
    expect(erro.code).toBe('CORE_DISCOUNT_NEEDS_AUTHORIZATION');
    expect(contarVendas()).toBe(0);
    expect(documento(doc).status).toBe('aberto');
  });

  it('o operador que reescreve o documento assinado abaixo do piso é barrado na edição — a assinatura não é dele', async () => {
    const caixa = await entrar('caixa-edita', 'operador_caixa_loja');
    const p = camisetaComPiso();
    const doc = documentoDoGerente(p);

    const res = await request(app)
      .patch(`/api/v1/core/quotes/${doc}`)
      .set(caixa.auth)
      .send({ items: [{ productId: p, quantity: 2, unitPriceCents: 2392 }] });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error.code).toBe('CORE_DISCOUNT_NEEDS_AUTHORIZATION');
    // Recusada, a edição não mexe em nada — a versão do gerente continua assinada.
    expect(documento(doc).floor_authorized_by).toBe(gerenteId);
  });

  it('o operador reescreve COM liberação: a assinatura do gerente sai, a liberação entra, e a conversão passa por ela', () => {
    const caixa = 'caixa-com-lib';
    const p = camisetaComPiso();
    const doc = documentoDoGerente(p);
    const lib = liberacaoPara(caixa);

    updateQuote({
      companyId: LOJA,
      userId: caixa,
      quoteId: doc,
      items: [{ productId: p, quantity: 2, unitPriceCents: 2392 }],
      alcada: { ...CAIXA, authorizationId: lib },
    });
    expect(documento(doc)).toMatchObject({ authorization_id: lib, floor_authorized_by: null });

    const trilha = auditoria('quote.update');
    expect(JSON.parse(trilha[trilha.length - 1].detail)).toMatchObject({
      pisoAssinadoAntes: gerenteId,
      pisoAssinadoPor: null,
    });

    const r = convertQuote({
      companyId: LOJA,
      userId: caixa,
      quoteId: doc,
      idempotencyKey: randomUUID(),
      payments: [{ method: 'pix', amountCents: 2 * 2392 }],
      alcada: CAIXA,
    });
    expect(r.saleId).toBeTruthy();
  });

  it('o gerente reescreve ainda abaixo do piso: assina de novo; e, devolvendo ao piso, a assinatura sai', () => {
    const p = camisetaComPiso();
    const doc = documentoDoGerente(p);

    updateQuote({
      companyId: LOJA,
      userId: gerenteId,
      quoteId: doc,
      items: [{ productId: p, quantity: 3, unitPriceCents: 2400 }],
      alcada: GERENCIA,
    });
    expect(documento(doc).floor_authorized_by).toBe(gerenteId);
    const assinaturas = auditoria('quote.piso_assinado');
    expect(assinaturas).toHaveLength(2);
    expect(JSON.parse(assinaturas[1].detail)).toMatchObject({
      acao: 'edicao',
      linhas: [{ productId: p, unitarioCobradoCents: 2400 }],
    });

    updateQuote({
      companyId: LOJA,
      userId: gerenteId,
      quoteId: doc,
      items: [{ productId: p, quantity: 3, unitPriceCents: 2500 }],
      alcada: GERENCIA,
    });
    expect(documento(doc).floor_authorized_by).toBeNull();
  });
});
