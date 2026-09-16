/**
 * ============================================================================
 * A PORTA DA VENDA RECUSA O QUE NÃO É VENDA — e diz o que fazer
 * ============================================================================
 *
 * Auditoria do PDV da Preço Justo (P0), frente "do bipe ao caixa fechado".
 *
 * O DEFEITO MEDIDO: `POST /core/sales`, `POST /core/sale-returns` e
 * `POST /core/print/jobs` usavam campos do CORPO HTTP crus — como parâmetro do
 * `prepare(...).get()` e no INSERT. A interface de `createSale` promete
 * `productId: string`, mas quem chega pela rota é `req.body`, e ali
 * `{ items: [{ quantity: 1 }] }` é JSON legítimo. O que saía no balcão era
 * 500 `API_UNAVAILABLE` — "Erro interno." —, o pior desfecho possível na rota
 * mais usada do sistema: o operador não fica sabendo o que houve NEM se a
 * venda entrou, e a única saída é tentar de novo com o cliente na frente.
 *
 * As oito formas que derrubavam a venda, medidas antes do conserto:
 *
 *   items: [null] .............. TypeError "Cannot read properties of null"
 *   item sem productId ......... "Provided value cannot be bound to SQLite parameter 1."
 *   productId objeto ........... "Unknown named parameter 'id'"
 *   customerId objeto .......... idem
 *   cashSessionId objeto ....... idem
 *   sellerId objeto ............ idem
 *   unitIds objeto ............. "unidadesDaLinha is not iterable"
 *   note objeto ................ "Provided value cannot be bound to SQLite parameter 16."
 *
 * mais a devolução de balcão (`saleItemId` ausente ou objeto) e a via do cupom
 * (`copies` que não é número → "NOT NULL constraint failed").
 *
 * O QUE ESTE ARQUIVO PROVA, em cada caso: status 400 (nunca 5xx), CÓDIGO
 * NOMEADO, a frase dizendo qual linha e o que fazer — e que NADA foi escrito
 * (sem venda, sem devolução, estoque e gaveta intactos, numeração não gasta).
 * No fim, o caminho feliz das mesmas três rotas, para a recusa não ter sido
 * comprada com uma trava que atrapalha o balcão.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { getConnection } from '../src/db/sqlite.js';
import { resetDbForTests } from '../src/db/database.js';
import {
  linkUserToCompany,
  upsertCompany,
  upsertUser,
} from '../src/services/auth/IdentityService.js';

const app = createApp();
const SENHA = 'Balcao@PrecoJusto2026';
let companyId = '';

interface Ator {
  auth: { Authorization: string };
  userId: string;
}

async function ator(login: string, profile: string): Promise<Ator> {
  const userId = await upsertUser({ login, displayName: login, password: SENHA });
  linkUserToCompany(userId, companyId, profile, true);
  const res = await request(app)
    .post('/api/v1/auth/login')
    .send({ login, password: SENHA, companyId });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { auth: { Authorization: `Bearer ${res.body.accessToken}` }, userId };
}

/** O saldo cru da prateleira — a prova de que a recusa não mexeu em estoque. */
function saldo(productId: string): number {
  const linha = getConnection()
    .prepare('SELECT quantity FROM core_stock WHERE company_id = ? AND product_id = ?')
    .get(companyId, productId) as { quantity: number } | undefined;
  return linha?.quantity ?? 0;
}

/** Quantas vendas existem nesta operação — a prova de que nada nasceu. */
function vendasGravadas(): number {
  const linha = getConnection()
    .prepare('SELECT COUNT(*) AS n FROM core_sales WHERE company_id = ?')
    .get(companyId) as { n: number };
  return Number(linha.n);
}

/** Quantas devoluções existem — a mesma prova, do lado do balcão de trocas. */
function devolucoesGravadas(): number {
  const linha = getConnection()
    .prepare('SELECT COUNT(*) AS n FROM core_sale_returns WHERE company_id = ?')
    .get(companyId) as { n: number };
  return Number(linha.n);
}

interface Cenario {
  caixa: Ator;
  gerente: Ator;
  productId: string;
  sessao: string;
}

async function cenario(): Promise<Cenario> {
  const caixa = await ator('caixa.balcao', 'operador_caixa_loja');
  // Quem cadastra e estoca é a gerência (PJ-CAIXA: o caixa da loja não administra produto).
  const gerente = await ator('gerente.balcao', 'gerente_loja');
  const produto = await request(app)
    .post('/api/v1/core/products')
    .set(gerente.auth)
    .send({ name: 'Camiseta do Balcão', priceCents: 5_000 });
  expect(produto.status, JSON.stringify(produto.body)).toBe(201);
  const productId = produto.body.id as string;
  const entrada = await request(app)
    .post('/api/v1/core/stock/movements')
    .set(gerente.auth)
    .send({
      productId,
      movementType: 'in',
      quantity: 10,
      referenceType: 'entrada',
      referenceId: `carga-${productId}`,
    });
  expect(entrada.status, JSON.stringify(entrada.body)).toBe(201);
  const abertura = await request(app)
    .post('/api/v1/core/cash/open')
    .set(caixa.auth)
    .send({ openingCents: 10_000 });
  expect(abertura.status, JSON.stringify(abertura.body)).toBe(201);
  return { caixa, gerente, productId, sessao: abertura.body.id as string };
}

beforeEach(() => {
  resetDbForTests();
  companyId = upsertCompany({
    slug: 'preco-justo',
    legalName: 'Preço Justo Comércio Ltda',
    tradeName: 'Preço Justo',
    kind: 'retail',
  });
});

// ============================================================================
// POST /core/sales — a rota mais usada do sistema
// ============================================================================

describe('o Finalizar recusa o pedido malformado com nome, e não com "Erro interno."', () => {
  it('linha sem produto: 400 nomeado dizendo QUAL linha, e nada é gravado', async () => {
    const { caixa, productId, sessao } = await cenario();
    const r = await request(app)
      .post('/api/v1/core/sales')
      .set(caixa.auth)
      .set('Idempotency-Key', 'balcao-sem-produto')
      .send({
        items: [{ productId, quantity: 1 }, { quantity: 2 }],
        payments: [{ method: 'dinheiro', amountCents: 5_000 }],
        cashSessionId: sessao,
      });
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect(r.body.error.code).toBe('CORE_SALE_ITEM_PRODUCT_REQUIRED');
    // A frase aponta a LINHA — sem ela o operador não sabe qual item tirar.
    expect(r.body.error.message).toContain('linha 2');
    expect(r.body.error.message).toContain('bipe o produto de novo');
    expect(r.body.error.details.index).toBe(1);
    expect(vendasGravadas()).toBe(0);
    expect(saldo(productId)).toBe(10);
  });

  it('linha nula no carrinho: 400 nomeado, e nada é gravado', async () => {
    const { caixa, productId, sessao } = await cenario();
    const r = await request(app)
      .post('/api/v1/core/sales')
      .set(caixa.auth)
      .set('Idempotency-Key', 'balcao-linha-nula')
      .send({
        items: [null],
        payments: [{ method: 'dinheiro', amountCents: 5_000 }],
        cashSessionId: sessao,
      });
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect(r.body.error.code).toBe('CORE_SALE_ITEM_INVALID');
    expect(vendasGravadas()).toBe(0);
    expect(saldo(productId)).toBe(10);
  });

  it('itens que não são uma lista: 400 nomeado', async () => {
    const { caixa, productId, sessao } = await cenario();
    const r = await request(app)
      .post('/api/v1/core/sales')
      .set(caixa.auth)
      .set('Idempotency-Key', 'balcao-itens-objeto')
      .send({
        items: { productId, quantity: 1 },
        payments: [{ method: 'dinheiro', amountCents: 5_000 }],
        cashSessionId: sessao,
      });
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect(r.body.error.code).toBe('CORE_SALE_ITEMS_INVALID');
    expect(vendasGravadas()).toBe(0);
  });

  it('identificador que é objeto — produto, cliente, gaveta, vendedor — e a observação', async () => {
    const { caixa, productId, sessao } = await cenario();
    const base = {
      items: [{ productId, quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: 5_000 }],
      cashSessionId: sessao,
    };
    const casos: { nome: string; corpo: Record<string, unknown>; codigo: string }[] = [
      {
        nome: 'productId',
        corpo: { ...base, items: [{ productId: { id: productId }, quantity: 1 }] },
        codigo: 'CORE_SALE_ITEM_PRODUCT_REQUIRED',
      },
      { nome: 'customerId', corpo: { ...base, customerId: { id: 'x' } }, codigo: 'CORE_SALE_FIELD_INVALID' },
      { nome: 'sellerId', corpo: { ...base, sellerId: { id: 'x' } }, codigo: 'CORE_SALE_FIELD_INVALID' },
      { nome: 'cashSessionId', corpo: { ...base, cashSessionId: { id: sessao } }, codigo: 'CORE_SALE_FIELD_INVALID' },
      { nome: 'note', corpo: { ...base, note: { texto: 'sem sacola' } }, codigo: 'CORE_SALE_FIELD_INVALID' },
      { nome: 'origin', corpo: { ...base, origin: ['pdv'] }, codigo: 'CORE_SALE_FIELD_INVALID' },
    ];
    for (const caso of casos) {
      const r = await request(app)
        .post('/api/v1/core/sales')
        .set(caixa.auth)
        .set('Idempotency-Key', `balcao-objeto-${caso.nome}`)
        .send(caso.corpo);
      expect(r.status, `${caso.nome}: ${JSON.stringify(r.body)}`).toBe(400);
      expect(r.body.error.code, caso.nome).toBe(caso.codigo);
    }
    expect(vendasGravadas()).toBe(0);
    expect(saldo(productId)).toBe(10);
  });

  it('as peças da linha (chassi) fora de uma lista: 400 nomeado, e nada é gravado', async () => {
    const { caixa, productId, sessao } = await cenario();
    const r = await request(app)
      .post('/api/v1/core/sales')
      .set(caixa.auth)
      .set('Idempotency-Key', 'balcao-unidades')
      .send({
        items: [{ productId, quantity: 1, unitIds: { primeira: 'CHASSI-1' } }],
        payments: [{ method: 'dinheiro', amountCents: 5_000 }],
        cashSessionId: sessao,
      });
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect(r.body.error.code).toBe('CORE_SALE_ITEM_UNITS_INVALID');
    expect(vendasGravadas()).toBe(0);
    expect(saldo(productId)).toBe(10);
  });

  it('o balcão continua vendendo: observação em branco, sem cliente e com nota — tudo passa', async () => {
    const { caixa, productId, sessao } = await cenario();
    const r = await request(app)
      .post('/api/v1/core/sales')
      .set(caixa.auth)
      .set('Idempotency-Key', 'balcao-venda-boa')
      .send({
        items: [{ productId, quantity: 2 }],
        payments: [{ method: 'dinheiro', amountCents: 10_000 }],
        cashSessionId: sessao,
        // Observação VAZIA é o caso comum: a trava não pode confundi-la com
        // "formato que o sistema não entende".
        note: '',
        customerId: null,
        sellerId: null,
      });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.total_cents).toBe(10_000);
    expect(vendasGravadas()).toBe(1);
    expect(saldo(productId)).toBe(8);

    const comObservacao = await request(app)
      .post('/api/v1/core/sales')
      .set(caixa.auth)
      .set('Idempotency-Key', 'balcao-venda-boa-2')
      .send({
        items: [{ productId, quantity: 1 }],
        payments: [{ method: 'dinheiro', amountCents: 5_000 }],
        cashSessionId: sessao,
        note: 'cliente pediu nota',
      });
    expect(comObservacao.status, JSON.stringify(comObservacao.body)).toBe(201);
    expect(saldo(productId)).toBe(7);
  });
});

// ============================================================================
// POST /core/sale-returns — a devolução no balcão
// ============================================================================

describe('a devolução de balcão recusa a linha que não diz qual item volta', () => {
  async function vendaParaDevolver(c: Cenario): Promise<{ saleId: string; saleItemId: string }> {
    const venda = await request(app)
      .post('/api/v1/core/sales')
      .set(c.caixa.auth)
      .set('Idempotency-Key', 'balcao-venda-da-devolucao')
      .send({
        items: [{ productId: c.productId, quantity: 2 }],
        payments: [{ method: 'dinheiro', amountCents: 10_000 }],
        cashSessionId: c.sessao,
      });
    expect(venda.status, JSON.stringify(venda.body)).toBe(201);
    const devolvivel = await request(app)
      .get(`/api/v1/core/sales/${venda.body.id}/returnable`)
      .set(c.caixa.auth);
    expect(devolvivel.status).toBe(200);
    return {
      saleId: venda.body.id as string,
      saleItemId: devolvivel.body.items[0].sale_item_id as string,
    };
  }

  it('sem saleItemId, com objeto no lugar dele, ou com a linha nula: 400 nomeado e nada gravado', async () => {
    const c = await cenario();
    const { saleId } = await vendaParaDevolver(c);
    const casos: { nome: string; items: unknown[] }[] = [
      { nome: 'sem saleItemId', items: [{ quantity: 1 }] },
      { nome: 'saleItemId objeto', items: [{ saleItemId: { id: 'x' }, quantity: 1 }] },
      { nome: 'linha nula', items: [null] },
      { nome: 'saleItemId vazio', items: [{ saleItemId: '   ', quantity: 1 }] },
    ];
    for (const caso of casos) {
      const r = await request(app)
        .post('/api/v1/core/sale-returns')
        .set(c.gerente.auth)
        .set('Idempotency-Key', `devolucao-${caso.nome.replace(/\s/g, '-')}`)
        .send({
          saleId,
          reason: 'o cliente trocou de ideia',
          refundMethod: 'dinheiro',
          items: caso.items,
          cashSessionId: c.sessao,
        });
      expect(r.status, `${caso.nome}: ${JSON.stringify(r.body)}`).toBe(400);
      expect(r.body.error.code, caso.nome).toBe('CORE_RETURN_ITEM_REQUIRED');
      expect(r.body.error.message).toContain('QUAL item da venda');
    }
    expect(devolucoesGravadas()).toBe(0);
    // A venda levou 2 da prateleira e nenhuma devolução devolveu nada.
    expect(saldo(c.productId)).toBe(8);
  });

  it('a devolução de verdade continua entrando, com o dinheiro saindo da gaveta', async () => {
    const c = await cenario();
    const { saleId, saleItemId } = await vendaParaDevolver(c);
    const r = await request(app)
      .post('/api/v1/core/sale-returns')
      .set(c.gerente.auth)
      .set('Idempotency-Key', 'devolucao-boa')
      .send({
        saleId,
        reason: 'o cliente trocou de ideia',
        refundMethod: 'dinheiro',
        items: [{ saleItemId, quantity: 1 }],
        cashSessionId: c.sessao,
      });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.total_cents).toBe(5_000);
    expect(devolucoesGravadas()).toBe(1);
    expect(saldo(c.productId)).toBe(9);
  });
});

// ============================================================================
// POST /core/print/jobs — o cupom da venda
// ============================================================================

describe('a via do cupom com valor ilegível não derruba a impressão', () => {
  it('copies que não é número sai com UMA via, como o pedido de −3 já saía', async () => {
    const { caixa, productId, sessao } = await cenario();
    const venda = await request(app)
      .post('/api/v1/core/sales')
      .set(caixa.auth)
      .set('Idempotency-Key', 'balcao-cupom')
      .send({
        items: [{ productId, quantity: 1 }],
        payments: [{ method: 'dinheiro', amountCents: 5_000 }],
        cashSessionId: sessao,
      });
    expect(venda.status, JSON.stringify(venda.body)).toBe(201);

    const ilegivel = await request(app)
      .post('/api/v1/core/print/jobs')
      .set(caixa.auth)
      .send({ documentType: 'SALE_RECEIPT', documentId: venda.body.id, copies: { vias: 2 } });
    expect(ilegivel.status, JSON.stringify(ilegivel.body)).toBe(201);
    expect(ilegivel.body.copies).toBe(1);

    // A aparadura que já existia continua valendo nos dois extremos.
    const negativa = await request(app)
      .post('/api/v1/core/print/jobs')
      .set(caixa.auth)
      .send({ documentType: 'SALE_RECEIPT', documentId: venda.body.id, copies: -3 });
    expect(negativa.status).toBe(201);
    expect(negativa.body.copies).toBe(1);

    const demais = await request(app)
      .post('/api/v1/core/print/jobs')
      .set(caixa.auth)
      .send({ documentType: 'SALE_RECEIPT', documentId: venda.body.id, copies: 50 });
    expect(demais.status).toBe(201);
    expect(demais.body.copies).toBe(10);
  });
});
