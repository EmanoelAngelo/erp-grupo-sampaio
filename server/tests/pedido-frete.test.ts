/**
 * Frete de um pedido — só com dado real.
 *
 * O serviço de logística assumia 500 g numa caixa 10×15×20 quando faltava
 * cadastro. O transportador cobra pelo pacote REAL; a diferença aparecia
 * depois, com a mercadoria já vendida, e quem pagava era a operação.
 *
 * Havia um teste cobrando esse comportamento — mandava só dois CEPs e esperava
 * opções de frete. Ele foi corrigido junto: teste que protege o erro é pior
 * que teste nenhum, porque dá confiança falsa.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import { checkout } from '../src/services/core/StorefrontService.js';
import {
  buildOrderPackage,
  listProductsMissingShippingData,
} from '../src/services/core/OrderShippingService.js';

let precoJusto: string;
let n = 0;

function produto(input: {
  companyId: string;
  precoCents?: number;
  weightGrams?: number | null;
  heightCm?: number | null;
  widthCm?: number | null;
  lengthCm?: number | null;
}): string {
  n += 1;
  const id = `prod-frete-${n}`;
  const agora = new Date().toISOString();
  const db = getConnection();
  db.prepare(
    `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                price_cents, weight_grams, height_cm, width_cm, length_cm,
                                active, publish_online, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'UN', 4000, ?, ?, ?, ?, ?, 1, 1, ?, ?)`,
  ).run(
    id,
    input.companyId,
    `FR-${n}`,
    `Item ${n}`,
    input.precoCents ?? 10000,
    input.weightGrams ?? null,
    input.heightCm ?? null,
    input.widthCm ?? null,
    input.lengthCm ?? null,
    agora,
    agora,
  );
  db.prepare(
    'INSERT INTO core_stock (company_id, product_id, quantity, reserved, updated_at) VALUES (?, ?, 20, 0, ?)',
  ).run(input.companyId, id, agora);
  return id;
}

function pedidoCom(itens: { productId: string; quantity: number }[], chave: string) {
  const [pedido] = checkout({
    idempotencyKey: chave,
    customerName: 'Cliente Frete',
    customerDocument: '111.444.777-35',
    paymentMethod: 'pix',
    items: itens,
  });
  return pedido;
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  n = 0;
  precoJusto = await upsertCompany({
    slug: 'preco-justo',
    tradeName: 'Preço Justo',
    legalName: 'Preço Justo Ltda',
  });
});

describe('pacote do pedido', () => {
  it('soma peso, empilha altura e toma a maior base', () => {
    const leve = produto({
      companyId: precoJusto,
      weightGrams: 300,
      heightCm: 5,
      widthCm: 10,
      lengthCm: 15,
    });
    const pesado = produto({
      companyId: precoJusto,
      weightGrams: 1200,
      heightCm: 8,
      widthCm: 20,
      lengthCm: 12,
      precoCents: 25000,
    });
    const pedido = pedidoCom(
      [
        { productId: leve, quantity: 2 },
        { productId: pesado, quantity: 1 },
      ],
      'ck-pacote',
    );

    const r = buildOrderPackage({ companyId: precoJusto, orderId: pedido.id });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.package.weightGrams).toBe(300 * 2 + 1200);
    expect(r.package.heightCm).toBe(5 * 2 + 8);
    expect(r.package.widthCm).toBe(20);
    expect(r.package.lengthCm).toBe(15);
    // Valor declarado é o do conteúdo: erra aqui e erra o seguro.
    expect(r.package.declaredValueInCents).toBe(10000 * 2 + 25000);
  });

  it('recusa montar o pacote quando falta cadastro, e diz qual produto e o quê', () => {
    const completo = produto({
      companyId: precoJusto,
      weightGrams: 300,
      heightCm: 5,
      widthCm: 10,
      lengthCm: 15,
    });
    const semPeso = produto({ companyId: precoJusto, heightCm: 5, widthCm: 10, lengthCm: 15 });
    const pedido = pedidoCom(
      [
        { productId: completo, quantity: 1 },
        { productId: semPeso, quantity: 1 },
      ],
      'ck-incompleto',
    );

    const r = buildOrderPackage({ companyId: precoJusto, orderId: pedido.id });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('SHIPPING_DATA_REQUIRED');
    expect(r.missing).toHaveLength(1);
    expect(r.missing[0].productId).toBe(semPeso);
    expect(r.missing[0].missing).toEqual(['peso']);
  });

  it('peso zero conta como ausente — não existe encomenda sem peso', () => {
    const zerado = produto({
      companyId: precoJusto,
      weightGrams: 0,
      heightCm: 5,
      widthCm: 10,
      lengthCm: 15,
    });
    const pedido = pedidoCom([{ productId: zerado, quantity: 1 }], 'ck-zero');

    const r = buildOrderPackage({ companyId: precoJusto, orderId: pedido.id });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.missing[0].missing).toContain('peso');
  });

  it('lista os quatro campos faltantes de uma vez', () => {
    const vazio = produto({ companyId: precoJusto });
    const pedido = pedidoCom([{ productId: vazio, quantity: 1 }], 'ck-vazio');

    const r = buildOrderPackage({ companyId: precoJusto, orderId: pedido.id });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.missing[0].missing).toEqual(['peso', 'altura', 'largura', 'comprimento']);
  });
});

describe('lista de trabalho do gestor', () => {
  it('aponta os produtos publicados que ainda não podem ser enviados', () => {
    produto({
      companyId: precoJusto,
      weightGrams: 500,
      heightCm: 5,
      widthCm: 10,
      lengthCm: 15,
    });
    const incompleto = produto({ companyId: precoJusto, weightGrams: 500 });

    const pendentes = listProductsMissingShippingData(precoJusto);

    expect(pendentes).toHaveLength(1);
    expect(pendentes[0].productId).toBe(incompleto);
    expect(pendentes[0].missing).toEqual(['altura', 'largura', 'comprimento']);
  });

  it('não vaza produto de outra operação', async () => {
    const gringa = await upsertCompany({
      slug: 'gringa',
      tradeName: 'Gringa',
      legalName: 'Gringa Ltda',
    });
    produto({ companyId: gringa });

    expect(listProductsMissingShippingData(precoJusto)).toHaveLength(0);
    expect(listProductsMissingShippingData(gringa)).toHaveLength(1);
  });
});

describe('isolamento', () => {
  it('pedido de outra operação não é acessível', async () => {
    const gringa = await upsertCompany({
      slug: 'gringa',
      tradeName: 'Gringa',
      legalName: 'Gringa Ltda',
    });
    const daGringa = produto({
      companyId: gringa,
      weightGrams: 300,
      heightCm: 5,
      widthCm: 10,
      lengthCm: 15,
    });
    const pedido = pedidoCom([{ productId: daGringa, quantity: 1 }], 'ck-cross-frete');

    expect(() => buildOrderPackage({ companyId: precoJusto, orderId: pedido.id })).toThrow(
      expect.objectContaining({ code: 'CORE_ORDER_NOT_FOUND' }),
    );
  });
});
