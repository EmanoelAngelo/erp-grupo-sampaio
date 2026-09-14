/**
 * ============================================================================
 * A CHAVE QUE O SERVIDOR DERIVA NÃO É DO CLIENTE (R2-IDEM, item 1)
 * ============================================================================
 *
 * `core_sales.idempotency_key` é UM espaço de nomes, e duas fontes escrevem
 * nele: a chave CRUA do cliente (POST /sales, e a venda guardada offline, que
 * sobe com a chave com que foi feita) e as chaves que o PRÓPRIO SERVIDOR monta
 * para os caminhos que partem de um documento:
 *
 *   quote:<quoteId>:<chave>        conversão de orçamento/pré-venda
 *   consignacao:<id>:<chave>       faturamento da consignação
 *   venda-nova:<pendenciaId>       relançamento da venda guardada como venda nova
 *   os:<orderId>:<chave>           recebimento da OS com Idempotency-Key
 *   os-<orderId>[:<n>]             recebimento da OS sem chave (e depois de estorno)
 *
 * O prefixo existe para que dois documentos nunca dividam uma venda. Mas nada
 * impedia o CLIENTE de mandar uma dessas formas como chave crua: o balcão que
 * vende com "venda-nova:<pendência>" (outra mercadoria) ocupa a chave da venda
 * nova daquela pendência, e o relançamento dela vira 422 para sempre — a venda
 * guardada, com o dinheiro na gaveta, fica sem saída. O mesmo com a OS sem
 * chave (`os-<id>` é determinística) e com a conversão da pré-venda.
 *
 * O que este arquivo trava: nas rotas que recebem a chave do cliente e a gravam
 * crua em `core_sales`, as formas do servidor são recusadas com 400
 * CORE_IDEMPOTENCY_KEY_RESERVED, antes de qualquer escrita; os caminhos
 * internos seguem vendendo com elas.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { getConnection } from '../src/db/sqlite.js';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { chaveDaVendaNovaDaPendencia } from '../src/services/core/VendasOfflineRecusadas.js';
import { chaveDoRecebimento } from '../src/services/core/WorkshopCashierService.js';
import {
  PREFIXOS_DO_SERVIDOR,
  chaveDaConversaoDoDocumento,
  chaveDoFaturamentoDaConsignacao,
  ehChaveDoServidor,
} from '../src/services/core/ChavesDoServidor.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();
const LOJA = 'loja-chave-do-servidor';

type Auth = { Authorization: string };
let gerente: Auth;
let caixa: Auth;

async function entrar(userId: string, perfil: string): Promise<Auth> {
  const res = await loginForTest(app, { userId, companyId: LOJA, profileCodes: [perfil] });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { Authorization: `Bearer ${res.body.accessToken as string}` };
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  gerente = await entrar('gerente-chave-do-servidor', 'gerente_loja');
  caixa = await entrar('caixa-chave-do-servidor', 'operador_caixa_loja');
});

async function produto(estoque: number, precoCents = 5000): Promise<string> {
  const p = await request(app)
    .post('/api/v1/core/products')
    .set(gerente)
    .send({ name: `Camiseta ${randomUUID().slice(0, 6)}`, priceCents: precoCents });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  const r = await request(app).post('/api/v1/core/stock/movements').set(gerente).send({
    productId: p.body.id,
    movementType: 'in',
    quantity: estoque,
    referenceType: 'entrada',
    referenceId: `carga-${randomUUID()}`,
  });
  expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
  return p.body.id as string;
}

async function abrirCaixa(auth: Auth): Promise<string> {
  const res = await request(app).post('/api/v1/core/cash/open').set(auth).send({ openingCents: 0 });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

function vender(auth: Auth, chave: string, corpo: Record<string, unknown>) {
  return request(app).post('/api/v1/core/sales').set(auth).set('Idempotency-Key', chave).send(corpo);
}

function vendas(): number {
  return (getConnection().prepare('SELECT COUNT(*) AS n FROM core_sales WHERE company_id = ?').get(LOJA) as { n: number }).n;
}

function pendencias(): number {
  return (
    getConnection().prepare('SELECT COUNT(*) AS n FROM core_offline_sale_pendings WHERE company_id = ?').get(LOJA) as {
      n: number;
    }
  ).n;
}

/** A pendência de chave reusada: a venda #N nasceu com a chave, a seguinte (outros itens) foi recusada e entregue. */
async function pendenciaDeChaveReusada() {
  const p = await produto(10);
  const gaveta = await abrirCaixa(caixa);
  const chave = `pdv-${randomUUID()}`;
  const original = await vender(caixa, chave, {
    cashSessionId: gaveta,
    items: [{ productId: p, quantity: 2 }],
    payments: [{ method: 'dinheiro', amountCents: 10_000 }],
  });
  expect(original.status, JSON.stringify(original.body)).toBe(201);
  const corpoDaFila = {
    cashSessionId: gaveta,
    items: [{ productId: p, quantity: 3, unitPriceCents: 5000 }],
    payments: [{ method: 'dinheiro', amountCents: 15_000 }],
  };
  const recusa = await vender(caixa, chave, corpoDaFila);
  expect(recusa.status).toBe(422);
  const entregue = await request(app).post('/api/v1/core/offline-sales').set(caixa).send({
    idempotencyKey: chave,
    label: 'venda do PDV',
    body: corpoDaFila,
    queuedAt: '2026-09-12T14:05:00.000Z',
    errorCode: recusa.body.error.code,
    errorMessage: recusa.body.error.message,
  });
  expect(entregue.status, JSON.stringify(entregue.body)).toBe(201);
  return { produtoId: p, gaveta, pendenciaId: entregue.body.pendencia.id as string };
}

// ============================================================================

describe('o balcão não ocupa a chave da venda nova de uma pendência', () => {
  it('POST /sales com "venda-nova:<pendência>" é recusado (400) e a pendência continua relançável', async () => {
    const c = await pendenciaDeChaveReusada();
    const outra = await produto(10, 3000);
    const antes = vendas();

    const ataque = await vender(caixa, chaveDaVendaNovaDaPendencia(c.pendenciaId), {
      cashSessionId: c.gaveta,
      items: [{ productId: outra, quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: 3000 }],
    });
    expect(ataque.status, JSON.stringify(ataque.body)).toBe(400);
    expect(ataque.body.error.code).toBe('CORE_IDEMPOTENCY_KEY_RESERVED');
    expect(ataque.body.error.message).not.toMatch(/idempot/i);
    expect(vendas()).toBe(antes);

    // A saída da pendência continua de pé: a venda nova nasce com a chave dela.
    const relancada = await request(app)
      .post(`/api/v1/core/offline-sales/${c.pendenciaId}/relaunch-as-new`)
      .set(caixa)
      .send({ cashSessionId: c.gaveta, terminalId: null });
    expect(relancada.status, JSON.stringify(relancada.body)).toBe(201);
    expect(relancada.body.duplicated).toBe(false);
    expect(relancada.body.sale.total_cents).toBe(15_000);
  });
});

describe('a pendência guardada ANTES da recusa, com a forma de uma chave do servidor', () => {
  it('não é relançada com essa chave crua (ocuparia a venda de um documento): 400, e nada é vendido', async () => {
    /*
      A entrega agora recusa essas formas — mas uma pendência gravada antes
      desta correção continua no banco, e o relançamento comum desce a chave
      DELA para `createSale`. "venda-nova:<outra>" relançada ocuparia a venda
      nova da outra pendência para sempre. A pendência antiga sai por descarte
      (gerência), não por relançamento.
    */
    const c = await pendenciaDeChaveReusada();
    const p = await produto(5);
    const agora = new Date().toISOString();
    getConnection()
      .prepare(
        `INSERT INTO core_offline_sale_pendings
           (id, company_id, idempotency_key, label, request_body, received_cents, items_count, queued_at,
            terminal_id, cash_session_id, status, error_code, error_message, attempts, reported_by,
            reported_at, last_reported_at)
         VALUES (?, ?, ?, 'venda do PDV', ?, 5000, 1, ?, NULL, NULL, 'pendente', 'CORE_CASH_SESSION_CLOSED',
                 'fechado', 1, NULL, ?, ?)`,
      )
      .run(
        'offsale-antiga',
        LOJA,
        chaveDaVendaNovaDaPendencia(c.pendenciaId),
        JSON.stringify({ items: [{ productId: p, quantity: 1 }], payments: [{ method: 'dinheiro', amountCents: 5000 }] }),
        agora,
        agora,
        agora,
      );
    const antes = vendas();

    const r = await request(app)
      .post('/api/v1/core/offline-sales/offsale-antiga/relaunch')
      .set(caixa)
      .send({ cashSessionId: c.gaveta, terminalId: null });
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect(r.body.error.code).toBe('CORE_IDEMPOTENCY_KEY_RESERVED');
    expect(vendas()).toBe(antes);

    // E a pendência de verdade segue relançável como venda nova.
    const relancada = await request(app)
      .post(`/api/v1/core/offline-sales/${c.pendenciaId}/relaunch-as-new`)
      .set(caixa)
      .send({ cashSessionId: c.gaveta, terminalId: null });
    expect(relancada.status, JSON.stringify(relancada.body)).toBe(201);
  });
});

describe('toda forma de chave que o servidor deriva é recusada nas rotas de chave crua', () => {
  const RESERVADAS = [
    'quote:q-123:pdv-abc',
    'consignacao:cons-1:chave',
    'venda-nova:offsale-1',
    'os:ordem-1:os-recebimento-1',
    'os-ordem-1',
    'os-ordem-1:2',
  ];

  it.each(RESERVADAS)('POST /sales com "%s" (cabeçalho ou corpo) não vende', async (chave) => {
    const p = await produto(5);
    const gaveta = await abrirCaixa(caixa);
    const corpo = {
      cashSessionId: gaveta,
      items: [{ productId: p, quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: 5000 }],
    };
    const pelaChave = await vender(caixa, chave, corpo);
    expect(pelaChave.status, JSON.stringify(pelaChave.body)).toBe(400);
    expect(pelaChave.body.error.code).toBe('CORE_IDEMPOTENCY_KEY_RESERVED');

    const peloCorpo = await request(app).post('/api/v1/core/sales').set(caixa).send({ ...corpo, idempotencyKey: chave });
    expect(peloCorpo.status, JSON.stringify(peloCorpo.body)).toBe(400);
    expect(peloCorpo.body.error.code).toBe('CORE_IDEMPOTENCY_KEY_RESERVED');
    expect(vendas()).toBe(0);
  });

  it.each(RESERVADAS)('POST /offline-sales com "%s" não guarda a venda (ela subiria com a chave do servidor)', async (chave) => {
    const p = await produto(5);
    const r = await request(app).post('/api/v1/core/offline-sales').set(caixa).send({
      idempotencyKey: chave,
      label: 'venda do PDV',
      body: { items: [{ productId: p, quantity: 1 }], payments: [{ method: 'dinheiro', amountCents: 5000 }] },
      queuedAt: '2026-09-12T14:05:00.000Z',
      errorCode: 'CORE_CASH_SESSION_CLOSED',
      errorMessage: 'fechado',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect(r.body.error.code).toBe('CORE_IDEMPOTENCY_KEY_RESERVED');
    expect(pendencias()).toBe(0);
  });

  it('a lista reservada cobre cada chave que o servidor deriva', () => {
    const derivadas = [
      chaveDaConversaoDoDocumento('q-1', 'pdv-x'),
      chaveDoFaturamentoDaConsignacao('cons-1', 'k'),
      chaveDaVendaNovaDaPendencia('offsale-1'),
      chaveDoRecebimento('o-1', 'os-recebimento-1', 0),
      chaveDoRecebimento('o-1', null, 0),
      chaveDoRecebimento('o-1', null, 3),
    ];
    for (const chave of derivadas) expect(ehChaveDoServidor(chave), chave).toBe(true);
    expect([...PREFIXOS_DO_SERVIDOR].sort()).toEqual(['consignacao:', 'os-', 'os:', 'quote:', 'venda-nova:']);
  });

  it('nenhum arquivo do servidor monta uma dessas chaves por fora de ChavesDoServidor', () => {
    /*
      A reserva só vale se a derivação mora no mesmo lugar da lista: um caminho
      novo que montasse `quote:${...}` à mão ficaria fora dela sem ninguém ver.
    */
    const raiz = join(__dirname, '..', 'src');
    const arquivos = (readdirSync(raiz, { recursive: true }) as string[])
      .filter((f) => f.endsWith('.ts'))
      .map((f) => join(raiz, f))
      .filter((f) => !f.endsWith('ChavesDoServidor.ts'));
    const montaNaMao = /`(quote|consignacao|venda-nova|os):\$\{|`os-\$\{/;
    const achados = arquivos.filter((f) => montaNaMao.test(readFileSync(f, 'utf8'))).map((f) => relative(raiz, f));
    expect(achados).toEqual([]);
  });

  it('a chave do PDV (e parecidas que não são do servidor) continuam vendendo', async () => {
    const p = await produto(10);
    const gaveta = await abrirCaixa(caixa);
    for (const chave of [`pdv-${randomUUID()}`, 'quote-sem-dois-pontos', 'Quote:q-1:k', 'osso-1', 'venda-novaX']) {
      const r = await vender(caixa, chave, {
        cashSessionId: gaveta,
        items: [{ productId: p, quantity: 1 }],
        payments: [{ method: 'dinheiro', amountCents: 5000 }],
      });
      expect(r.status, `${chave}: ${JSON.stringify(r.body)}`).toBe(201);
    }
  });
});
