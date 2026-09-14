/**
 * CARRINHO DE DUAS LOJAS: CADA UMA COTA O PRÓPRIO FRETE.
 *
 * ============================================================================
 * O DEFEITO, E POR QUE ELE É DINHEIRO
 * ============================================================================
 *
 * O checkout divide o carrinho por operação — "cada empresa tem seu próprio
 * faturamento, estoque e fulfillment", diz o comentário dele. Mas o FRETE era
 * cotado uma vez só:
 *
 *     lerCarrinho()  →  companyId ??= p.company_id;
 *                       if (p.company_id !== companyId) continue;
 *
 *     checkout()     →  const shipping = index === 0 ? frete.priceCents : 0;
 *                       const metodo   = frete?.method ?? 'retirada';
 *
 * Quer dizer: a cotação é do pacote da PRIMEIRA loja, e o segundo pedido nasce
 * com o MÉTODO dela e R$ 0,00 de frete. Três consequências, todas de dinheiro:
 *
 *   1. o cliente paga UM frete e recebe DOIS pacotes, de dois endereços
 *      diferentes — a segunda operação despacha por conta dela;
 *   2. o segundo pedido carrega `shipping_estimated_days` copiado da cotação
 *      da primeira: uma data prometida ao cliente que ninguém cotou;
 *   3. a segunda loja pode nem entregar — e o pedido dela nasce como "entrega"
 *      mesmo assim, com frete zero.
 *
 * O terceiro é o mais grave, porque o próprio `CheckoutShippingService` já
 * tinha a regra escrita para impedir exatamente isso: **"sem entrega arranjada,
 * é retirada — nunca entrega grátis"**. A divisão por empresa passava por cima
 * dela.
 *
 * ============================================================================
 * A REGRA
 * ============================================================================
 *
 * Uma cotação por operação, com a origem, o peso e as dimensões DELA. O cliente
 * vê e paga o frete de cada loja antes de fechar. Loja que não pode entregar
 * aparece como retirada — nunca como entrega de graça.
 */
process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_DATABASE_PATH = ':memory:';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

const { createApp } = await import('../src/app.js');
const { resetDbForTests } = await import('../src/db/database.js');
const { ensureCoreSchema } = await import('../src/db/schema.js');
const { getConnection } = await import('../src/db/sqlite.js');
const { upsertCompany } = await import('../src/services/auth/IdentityService.js');
const { abrirParaVisitante } = await import('./helpers/lojaAberta.js');
const { createProduct } = await import('../src/services/core/CatalogService.js');
const { applyMovement } = await import('../src/services/core/InventoryService.js');

const app = createApp();

let precoJusto: string;
let gringa: string;
let daPrecoJusto: string;
let daGringa: string;

/** Uma loja publicada, com política de entrega própria. */
function loja(
  slug: string,
  nome: string,
  entrega: { pickup: boolean; delivery: boolean; flatRateCents: number | null },
): string {
  const companyId = upsertCompany({ slug, legalName: `${nome} Ltda`, tradeName: nome });
  const agora = new Date().toISOString();

  getConnection()
    .prepare(
      `INSERT INTO core_shipping_settings
         (company_id, pickup_enabled, delivery_enabled, flat_rate_cents, estimated_days, updated_at)
       VALUES (?, ?, ?, ?, 3, ?)
       ON CONFLICT (company_id) DO UPDATE SET
         pickup_enabled = excluded.pickup_enabled,
         delivery_enabled = excluded.delivery_enabled,
         flat_rate_cents = excluded.flat_rate_cents`,
    )
    .run(companyId, entrega.pickup ? 1 : 0, entrega.delivery ? 1 : 0, entrega.flatRateCents, agora);
  // O checkout de VISITANTE exige a loja aberta para ele (GAP-PRD-028).
  abrirParaVisitante(companyId);

  return companyId;
}

/** Um produto publicado na vitrine, com saldo. */
function publicado(companyId: string, nome: string, priceCents: number): string {
  const id = createProduct(companyId, { name: nome, priceCents }).id;
  getConnection()
    .prepare('UPDATE core_products SET publish_online = 1 WHERE id = ?')
    .run(id);
  applyMovement({
    companyId,
    productId: id,
    movementType: 'in',
    quantity: 20,
    referenceType: 'entrada',
    referenceId: `carga-${id}`,
  });
  return id;
}

beforeEach(() => {
  resetDbForTests();
  ensureCoreSchema();

  // Preço Justo entrega por tabela: R$ 25,00.
  precoJusto = loja('preco-justo', 'Preço Justo', {
    pickup: true,
    delivery: true,
    flatRateCents: 2_500,
  });
  // Gringa entrega por tabela também, mas mais caro: R$ 40,00.
  gringa = loja('gringa', 'Gringa', { pickup: true, delivery: true, flatRateCents: 4_000 });

  daPrecoJusto = publicado(precoJusto, 'Camiseta', 5_000);
  daGringa = publicado(gringa, 'Bolsa importada', 20_000);
});

const CARRINHO_DAS_DUAS = () => [
  { productId: daPrecoJusto, quantity: 1 },
  { productId: daGringa, quantity: 1 },
];

function cotar(items: { productId: string; quantity: number }[], zip = '96015440') {
  return request(app).post('/api/v1/loja/checkout/frete').send({ items, zip });
}

function fechar(body: Record<string, unknown>) {
  return request(app)
    .post('/api/v1/loja/checkout')
    .set('Idempotency-Key', randomUUID())
    .send({
      customerName: 'Ana Compradora',
      // CPF com dígito verificador certo: o visitante é conferido (GAP-PRD-191).
      customerDocument: '529.982.247-25',
      customerEmail: 'ana@teste.local',
      shippingZip: '96015440',
      shippingAddress: 'Rua Um, 100 — Centro',
      paymentMethod: 'pix',
      ...body,
    });
}

function pedidosDe(orders: { id: string }[]) {
  return orders.map((o) => {
    const linha = getConnection()
      .prepare(
        `SELECT c.slug AS loja, o.shipping_method, o.shipping_cents, o.items_cents,
                o.total_cents, o.shipping_estimated_days
           FROM core_orders o JOIN core_companies c ON c.id = o.company_id
          WHERE o.id = ?`,
      )
      .get(o.id) as Record<string, unknown>;
    return linha;
  });
}

// ============================================================================

describe('a cotação enxerga as DUAS lojas', () => {
  it('devolve uma lista de opções por operação, com o nome de cada loja', async () => {
    const r = await cotar(CARRINHO_DAS_DUAS());

    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const lojas = r.body.lojas as { companyId: string; storeName: string }[];
    expect(lojas.map((l) => l.storeName).sort()).toEqual(['Gringa', 'Preço Justo']);
  });

  it('cada loja cota o PRÓPRIO preço — e eles são diferentes', async () => {
    const r = await cotar(CARRINHO_DAS_DUAS());
    const lojas = r.body.lojas as {
      companyId: string;
      options: { method: string; priceCents: number }[];
    }[];

    const daPj = lojas.find((l) => l.companyId === precoJusto)!;
    const daGr = lojas.find((l) => l.companyId === gringa)!;

    expect(daPj.options.find((o) => o.method === 'tabela_da_loja')?.priceCents).toBe(2_500);
    expect(daGr.options.find((o) => o.method === 'tabela_da_loja')?.priceCents).toBe(4_000);
  });

  it('o valor dos itens é o daquela loja, e não o do carrinho inteiro', async () => {
    /*
      Importa por causa do frete grátis acima de X: com o total do carrinho
      inteiro, a loja barata daria frete grátis por causa da compra feita na
      outra.
    */
    const r = await cotar(CARRINHO_DAS_DUAS());
    const lojas = r.body.lojas as { companyId: string; itemsCents: number }[];

    expect(lojas.find((l) => l.companyId === precoJusto)!.itemsCents).toBe(5_000);
    expect(lojas.find((l) => l.companyId === gringa)!.itemsCents).toBe(20_000);
  });

  it('carrinho de uma loja só continua funcionando', async () => {
    const r = await cotar([{ productId: daPrecoJusto, quantity: 1 }]);
    expect((r.body.lojas as unknown[]).length).toBe(1);
  });
});

// ============================================================================

describe('cada pedido nasce com o frete DELE', () => {
  it('as duas lojas entregam: cada pedido carrega o próprio preço', async () => {
    const r = await fechar({
      items: CARRINHO_DAS_DUAS(),
      shippingMethods: {
        [precoJusto]: 'tabela_da_loja',
        [gringa]: 'tabela_da_loja',
      },
    });

    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const linhas = pedidosDe(r.body.orders);

    const pj = linhas.find((l) => l.loja === 'preco-justo')!;
    const gr = linhas.find((l) => l.loja === 'gringa')!;

    // O defeito dava shipping_cents = 0 num dos dois.
    expect([pj.shipping_cents, gr.shipping_cents]).toEqual([2_500, 4_000]);
    expect([pj.total_cents, gr.total_cents]).toEqual([7_500, 24_000]);
  });

  it('o cliente paga os DOIS fretes, e não um só', async () => {
    const r = await fechar({
      items: CARRINHO_DAS_DUAS(),
      shippingMethods: { [precoJusto]: 'tabela_da_loja', [gringa]: 'tabela_da_loja' },
    });

    const total = pedidosDe(r.body.orders).reduce((s, l) => s + Number(l.total_cents), 0);
    // 5.000 + 2.500 + 20.000 + 4.000 = 31.500. O defeito cobrava 29.000.
    expect(total).toBe(31_500);
  });

  it('uma loja retira e a outra entrega — cada pedido diz a verdade sobre si', async () => {
    const r = await fechar({
      items: CARRINHO_DAS_DUAS(),
      shippingMethods: { [precoJusto]: 'retirada', [gringa]: 'tabela_da_loja' },
    });

    const linhas = pedidosDe(r.body.orders);
    const pj = linhas.find((l) => l.loja === 'preco-justo')!;
    const gr = linhas.find((l) => l.loja === 'gringa')!;

    expect([pj.shipping_method, pj.shipping_cents]).toEqual(['retirada', 0]);
    expect([gr.shipping_method, gr.shipping_cents]).toEqual(['tabela_da_loja', 4_000]);
  });

  it('o prazo prometido é o da cotação DAQUELA loja', async () => {
    /*
      O segundo pedido copiava `shipping_estimated_days` da cotação do
      primeiro: uma data prometida ao cliente que ninguém cotou para aquela
      operação, saindo de outro endereço.
    */
    const r = await fechar({
      items: CARRINHO_DAS_DUAS(),
      shippingMethods: { [precoJusto]: 'retirada', [gringa]: 'tabela_da_loja' },
    });

    const linhas = pedidosDe(r.body.orders);
    // Retirada não promete data.
    expect(linhas.find((l) => l.loja === 'preco-justo')!.shipping_estimated_days).toBeNull();
    expect(linhas.find((l) => l.loja === 'gringa')!.shipping_estimated_days).toBe(3);
  });
});

// ============================================================================

describe('loja que não entrega não vira entrega grátis', () => {
  it('escolher entrega numa loja que só retira é RECUSADO', async () => {
    /*
      A regra já estava escrita em `CheckoutShippingService`: "sem entrega
      arranjada, é retirada — nunca entrega grátis". A divisão por empresa
      passava por cima dela, e a segunda loja despachava de graça.
    */
    const soRetira = loja('me-mimei', 'Me Mimei', {
      pickup: true,
      delivery: false,
      flatRateCents: null,
    });
    const dela = publicado(soRetira, 'Presente', 3_000);

    const r = await fechar({
      items: [{ productId: daPrecoJusto, quantity: 1 }, { productId: dela, quantity: 1 }],
      shippingMethods: { [precoJusto]: 'tabela_da_loja', [soRetira]: 'tabela_da_loja' },
    });

    expect(r.status).toBe(400);
    expect(String(r.body.error.message)).toMatch(/Me Mimei/);
  });

  it('e a recusa nomeia a loja, para o cliente saber qual mudar', async () => {
    const soRetira = loja('conceito', 'Conceito', {
      pickup: true,
      delivery: false,
      flatRateCents: null,
    });
    const dela = publicado(soRetira, 'Item', 3_000);

    const r = await fechar({
      items: [{ productId: daPrecoJusto, quantity: 1 }, { productId: dela, quantity: 1 }],
      shippingMethods: { [precoJusto]: 'tabela_da_loja', [soRetira]: 'tabela_da_loja' },
    });

    expect(String(r.body.error.message)).toContain('Conceito');
  });

  it('com retirada na que não entrega, o pedido fecha', async () => {
    const soRetira = loja('conceito', 'Conceito', {
      pickup: true,
      delivery: false,
      flatRateCents: null,
    });
    const dela = publicado(soRetira, 'Item', 3_000);

    const r = await fechar({
      items: [{ productId: daPrecoJusto, quantity: 1 }, { productId: dela, quantity: 1 }],
      shippingMethods: { [precoJusto]: 'tabela_da_loja', [soRetira]: 'retirada' },
    });

    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const linhas = pedidosDe(r.body.orders);
    expect(linhas.find((l) => l.loja === 'conceito')!.shipping_cents).toBe(0);
  });

  it('sem método nenhum, todas as lojas caem em retirada — nunca em entrega grátis', async () => {
    const r = await fechar({ items: CARRINHO_DAS_DUAS() });

    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const linhas = pedidosDe(r.body.orders);
    for (const l of linhas) {
      expect([l.loja, l.shipping_method, l.shipping_cents]).toEqual([l.loja, 'retirada', 0]);
    }
  });
});

// ============================================================================

describe('o método único, do jeito antigo, continua sendo aceito', () => {
  it('`shippingMethod` aplica a MESMA escolha a cada loja, resolvida em cada uma', async () => {
    /*
      Compatibilidade com quem já chama a rota assim — mas o preço passou a ser
      resolvido POR LOJA. Antes, a mesma chave carregava o preço da primeira
      para todas; agora cada uma cobra o dela.
    */
    const r = await fechar({
      items: CARRINHO_DAS_DUAS(),
      shippingMethod: 'tabela_da_loja',
    });

    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const linhas = pedidosDe(r.body.orders);
    expect(
      linhas.map((l) => Number(l.shipping_cents)).sort((a, b) => a - b),
    ).toEqual([2_500, 4_000]);
  });
});
