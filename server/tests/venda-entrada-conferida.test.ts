/**
 * ============================================================================
 * A VENDA CONFERE O QUE ENTRA — a trilha "venda" da auditoria do Preço Justo
 * ============================================================================
 *
 *   E-venda-servidor-02  status do pagamento era texto livre: dinheiro
 *                        'pending' fechava venda sem espécie na gaveta; 'x'
 *                        punha dinheiro na gaveta com o título em aberto.
 *   E-venda-servidor-12  'CREDITO' passava a conferência, escapava do portão
 *                        da maquininha e era gravado cru.
 *   E-venda-servidor-08  venda de balcão sem dinheiro nascia sem gaveta, e
 *   H-caixa-seguranca-05 passava com todos os caixas fechados.
 *   E-venda-servidor-11  preço que baixou depois do bipe, pago no cartão, era
 *   G-offline-sync-08    recusado com "troco só sobre dinheiro".
 *   E-venda-servidor-13  0,5 de camiseta UN virava venda.
 *   D-pdv-teclado-14
 *   E-venda-servidor-15  "Falta 12.50".
 *   G-offline-sync-07    preço que subiu depois do bipe virava "preço abaixo do
 *                        vigente" na conta do operador.
 *   G-offline-sync-09    produto inativado respondia só com o UUID.
 *   G-offline-sync-16    a venda offline DESCARTADA pela gerência nascia no
 *                        reenvio seguinte.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { getConnection } from '../src/db/sqlite.js';
import { createSale } from '../src/services/core/SalesService.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();
const LOJA = 'loja-entrada-conferida';

type Auth = { Authorization: string };
let gerente: Auth;
let companyId: string;
let userId: string;

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  const res = await loginForTest(app, {
    userId: 'gerente-entrada',
    companyId: LOJA,
    profileCodes: ['gerente_loja'],
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  gerente = { Authorization: `Bearer ${res.body.accessToken as string}` };
  companyId = String(res.body.company.id);
  userId = String(res.body.user.id);
});

async function produto(precoCents: number, quantidade = 20, nome?: string): Promise<string> {
  const p = await request(app)
    .post('/api/v1/core/products')
    .set(gerente)
    .send({ name: nome ?? `Produto ${randomUUID().slice(0, 6)}`, priceCents: precoCents });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  if (quantidade > 0) {
    const m = await request(app).post('/api/v1/core/stock/movements').set(gerente).send({
      productId: p.body.id,
      movementType: 'in',
      quantity: quantidade,
      referenceType: 'entrada',
      referenceId: `carga-${p.body.id as string}`,
    });
    expect(m.status, JSON.stringify(m.body)).toBeLessThan(300);
  }
  return String(p.body.id);
}

function vender(corpo: Record<string, unknown>, chave = randomUUID(), auth: Auth = gerente) {
  return request(app).post('/api/v1/core/sales').set(auth).set('Idempotency-Key', chave).send(corpo);
}

function contarVendas(): number {
  return Number(
    (
      getConnection()
        .prepare('SELECT COUNT(*) AS n FROM core_sales WHERE company_id = ?')
        .get(companyId) as { n: number }
    ).n,
  );
}

async function abrirCaixa(): Promise<string> {
  const res = await request(app).post('/api/v1/core/cash/open').set(gerente).send({ openingCents: 0 });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return String(res.body.id);
}

// ============================================================================
describe('E-venda-servidor-02 — o status do pagamento só é liquidado ou pendente', () => {
  it('dinheiro "pendente" é recusado: só o PIX do balcão fica pendente, e quem diz é a cobrança', async () => {
    const p = await produto(5000);
    const res = await vender({
      items: [{ productId: p, quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: 5000, status: 'pending' }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error.code).toBe('CORE_PAYMENT_PENDING_NOT_ALLOWED');
    expect(contarVendas()).toBe(0);
  });

  it('status inventado é recusado em vez de ser lido de dois jeitos', async () => {
    const p = await produto(5000);
    const res = await vender({
      items: [{ productId: p, quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: 5000, status: 'x' }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error.code).toBe('CORE_PAYMENT_STATUS_INVALID');
    expect(contarVendas()).toBe(0);

    // 'settled' dito por extenso continua sendo o de sempre.
    const ok = await vender({
      items: [{ productId: p, quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: 5000, status: 'settled' }],
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
  });
});

// ============================================================================
describe('E-venda-servidor-12 — a forma de pagamento entra canônica', () => {
  it('"CREDITO" é gravado como "credito" — o mesmo código que o portão da maquininha e o turno leem', async () => {
    const p = await produto(15000);
    const res = await vender({
      items: [{ productId: p, quantity: 1 }],
      payments: [{ method: ' CREDITO ', amountCents: 15000 }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const linha = getConnection()
      .prepare('SELECT method FROM core_sale_payments WHERE sale_id = ?')
      .get(res.body.id) as { method: string };
    expect(linha.method).toBe('credito');
  });
});

// ============================================================================
describe('E-venda-servidor-08 / H-caixa-seguranca-05 — a venda de balcão sem dinheiro cai no turno', () => {
  it('com uma gaveta aberta, a venda no cartão sem cashSessionId entra nela', async () => {
    const caixa = await abrirCaixa();
    const p = await produto(30000);
    const res = await vender({
      items: [{ productId: p, quantity: 1 }],
      payments: [{ method: 'credito', amountCents: 30000 }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const venda = getConnection()
      .prepare('SELECT cash_session_id FROM core_sales WHERE id = ?')
      .get(res.body.id) as { cash_session_id: string | null };
    // Antes: NULO — e o "recebido no turno, por meio" não a via.
    expect(venda.cash_session_id).toBe(caixa);
  });

  it('com as gavetas fechadas numa operação que trabalha com gaveta, a venda no cartão é recusada', async () => {
    const caixa = await abrirCaixa();
    const fechou = await request(app)
      .post(`/api/v1/core/cash/${caixa}/close`)
      .set(gerente)
      .send({ countedCents: 0 });
    expect(fechou.status, JSON.stringify(fechou.body)).toBe(200);

    const p = await produto(8000);
    const res = await vender({
      items: [{ productId: p, quantity: 1 }],
      payments: [{ method: 'pix', amountCents: 8000 }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe('CORE_CASH_SESSION_REQUIRED');
    expect(res.body.error.message).toMatch(/cartão ou no PIX/);
    expect(contarVendas()).toBe(0);
  });

  it('a operação que nunca abriu caixa segue vendendo no cartão, sem turno', async () => {
    const p = await produto(8000);
    const res = await vender({
      items: [{ productId: p, quantity: 1 }],
      payments: [{ method: 'debito', amountCents: 8000 }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });
});

// ============================================================================
describe('E-venda-servidor-11 / G-offline-sync-08 — o preço que baixou depois do bipe', () => {
  it('pago no cartão pelo preço antigo: a recusa diz o preço novo, não "troco só sobre dinheiro"', async () => {
    const p = await produto(5000, 20, 'Jaqueta jeans');
    getConnection().prepare('UPDATE core_products SET price_cents = 4000 WHERE id = ?').run(p);

    const res = await vender({
      items: [{ productId: p, quantity: 1, unitPriceCents: 5000 }],
      payments: [{ method: 'debito', amountCents: 5000 }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe('CORE_SALE_TOTAL_CHANGED');
    expect(res.body.error.message).toMatch(/Jaqueta jeans/);
    expect(res.body.error.message).toMatch(/R\$ 50,00 para R\$ 40,00/);
    expect(res.body.error.details.linhas[0]).toMatchObject({ productId: p, vigenteCents: 4000 });
    expect(res.body.error.details.diferencaCents).toBe(1000);
    expect(contarVendas()).toBe(0);
  });

  it('pago em dinheiro, a venda segue como sempre — a diferença é troco', async () => {
    const p = await produto(5000);
    getConnection().prepare('UPDATE core_products SET price_cents = 4000 WHERE id = ?').run(p);
    const res = await vender({
      items: [{ productId: p, quantity: 1, unitPriceCents: 5000 }],
      payments: [{ method: 'dinheiro', amountCents: 5000 }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.change_cents).toBe(1000);
  });
});

// ============================================================================
describe('E-venda-servidor-13 / D-pdv-teclado-14 — produto vendido por unidade não sai em pedaço', () => {
  it('0,5 de um produto UN é recusado', async () => {
    const p = await produto(4000, 10, 'Camiseta lisa');
    const res = await vender({
      items: [{ productId: p, quantity: 0.5 }],
      payments: [{ method: 'dinheiro', amountCents: 2000 }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error.code).toBe('CORE_QUANTITY_MUST_BE_INTEGER');
    expect(res.body.error.message).toMatch(/Camiseta lisa/);
    expect(contarVendas()).toBe(0);
  });

  it('pesável e unidade fracionável (KG) continuam aceitando fração', async () => {
    const pesavel = await produto(1000);
    getConnection().prepare('UPDATE core_products SET weighable = 1 WHERE id = ?').run(pesavel);
    const porQuilo = await produto(2000);
    getConnection().prepare("UPDATE core_products SET unit = 'KG' WHERE id = ?").run(porQuilo);

    const a = await vender({
      items: [{ productId: pesavel, quantity: 0.5 }],
      payments: [{ method: 'dinheiro', amountCents: 500 }],
    });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    const b = await vender({
      items: [{ productId: porQuilo, quantity: 1.5 }],
      payments: [{ method: 'dinheiro', amountCents: 3000 }],
    });
    expect(b.status, JSON.stringify(b.body)).toBe(201);
  });
});

// ============================================================================
describe('E-venda-servidor-15 — a falta sai em reais', () => {
  it('"Falta R$ 12,50", e não "Falta 12.50"', async () => {
    const p = await produto(5000);
    const res = await vender({
      items: [{ productId: p, quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: 3750 }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error.code).toBe('CORE_PAYMENT_MISMATCH');
    expect(res.body.error.message).toContain('Falta R$ 12,50');
  });
});

// ============================================================================
describe('G-offline-sync-07 — o preço que subiu depois do bipe tem nome próprio', () => {
  it('linha não negociada: a diferença sai como "preço de tela desatualizado", e não como rebaixa do operador', async () => {
    const p = await produto(1200);
    const marcada = createSale({
      companyId,
      userId,
      idempotencyKey: randomUUID(),
      items: [{ productId: p, quantity: 1, unitPriceCents: 1150, precoNegociado: false }],
      payments: [{ method: 'dinheiro', amountCents: 1150 }],
    });
    expect(marcada.concessao?.origens).toEqual({
      cabecalho: 0,
      itens: 0,
      precoRebaixado: 0,
      precoDesatualizado: 50,
    });
    // Continua dentro da concessão — é a alçada que protege o preço.
    expect(marcada.concessao?.concedidoCents).toBe(50);

    // Sem a marca, é o de sempre: preço rebaixado.
    const semMarca = createSale({
      companyId,
      userId,
      idempotencyKey: randomUUID(),
      items: [{ productId: p, quantity: 1, unitPriceCents: 1150 }],
      payments: [{ method: 'dinheiro', amountCents: 1150 }],
    });
    expect(semMarca.concessao?.origens).toEqual({ cabecalho: 0, itens: 0, precoRebaixado: 50 });
  });

  it('acima da alçada, a recusa diz de onde veio — "preço de tela desatualizado"', async () => {
    const caixa = await loginForTest(app, {
      userId: 'caixa-entrada',
      companyId: LOJA,
      profileCodes: ['operador_caixa_loja'],
    });
    const auth = { Authorization: `Bearer ${caixa.body.accessToken as string}` };
    const p = await produto(1200);
    const res = await vender(
      {
        items: [{ productId: p, quantity: 1, unitPriceCents: 1000, precoNegociado: false }],
        payments: [{ method: 'dinheiro', amountCents: 1000 }],
      },
      randomUUID(),
      auth,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error.code).toBe('CORE_DISCOUNT_NEEDS_AUTHORIZATION');
    expect(res.body.error.message).toMatch(/preço de tela desatualizado/);
    expect(res.body.error.message).not.toMatch(/abaixo do vigente/);
  });
});

// ============================================================================
describe('G-offline-sync-09 — o produto inativado diz o nome', () => {
  it('a recusa traz o nome e o id para a tela marcar a linha, e não um UUID solto', async () => {
    const p = await produto(3000, 10, 'Caneca azul');
    getConnection().prepare('UPDATE core_products SET active = 0 WHERE id = ?').run(p);
    const res = await vender({
      items: [{ productId: p, quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: 3000 }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(res.body.error.code).toBe('CORE_PRODUCT_NOT_FOUND');
    expect(res.body.error.message).toMatch(/"Caneca azul"/);
    expect(res.body.error.message).not.toContain(p);
    expect(res.body.error.details).toMatchObject({ productId: p, name: 'Caneca azul', inativo: true });
  });
});

// ============================================================================
describe('G-offline-sync-16 — a venda offline descartada pela gerência não nasce depois', () => {
  it('o reenvio com a chave da pendência descartada é 409, e nenhuma venda é gravada', async () => {
    const p = await produto(5000);
    const chave = `pdv-${randomUUID()}`;
    const corpo = {
      items: [{ productId: p, quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: 5000 }],
    };
    const agora = new Date().toISOString();
    getConnection()
      .prepare(
        `INSERT INTO core_offline_sale_pendings
           (id, company_id, idempotency_key, request_body, status, reported_at, last_reported_at,
            resolution_note)
         VALUES (?, ?, ?, ?, 'descartada', ?, ?, 'cliente desistiu, dinheiro devolvido')`,
      )
      .run(randomUUID(), companyId, chave, JSON.stringify(corpo), agora, agora);

    const res = await vender(corpo, chave);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe('CORE_OFFLINE_SALE_DISCARDED');
    expect(contarVendas()).toBe(0);
  });
});
