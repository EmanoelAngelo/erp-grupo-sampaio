/**
 * Página pública de produto.
 *
 * A loja vai na URL, e é o SERVIDOR que confere. Sem isso, a URL da Gringa
 * serviria produto do Preço Justo e a página anunciaria a loja errada como
 * vendedora — o cliente compraria de quem não vende.
 *
 * Também se cobra aqui o que decide se dá para entregar: peso e dimensões.
 * Sem os quatro, `SHIPPING_DATA_INCOMPLETE`, e a tela oferece retirada em vez
 * de inventar uma caixa.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import { createProduct } from '../src/services/core/CatalogService.js';
import { getStorefrontProductDetail } from '../src/services/core/StorefrontService.js';

const app = createApp();

let gringa: string;
let precoJusto: string;

interface Medidas {
  weightGrams?: number;
  heightCm?: number;
  widthCm?: number;
  lengthCm?: number;
}

function publicar(companyId: string, nome: string, medidas: Medidas = {}): string {
  const p = createProduct(companyId, {
    name: nome,
    priceCents: 20000,
    category: 'Acessórios',
    subcategory: 'Vestuário',
    brand: 'Marca X',
    description: 'Anotação interna que não deve aparecer na loja',
    onlineDescription: 'Texto de vitrine, escrito para o cliente',
    publishOnline: true,
    ...medidas,
  });
  const id = String(p.id);
  getConnection()
    .prepare(
      'INSERT INTO core_stock (company_id, product_id, quantity, reserved, updated_at) VALUES (?, ?, 8, 0, ?)',
    )
    .run(companyId, id, new Date().toISOString());
  return id;
}

const COMPLETO: Medidas = { weightGrams: 800, heightCm: 12, widthCm: 18, lengthCm: 24 };

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  gringa = await upsertCompany({ slug: 'gringa', tradeName: 'Gringa', legalName: 'Gringa Ltda' });
  precoJusto = await upsertCompany({
    slug: 'preco-justo',
    tradeName: 'Preço Justo',
    legalName: 'Preço Justo Ltda',
  });
});

describe('a loja da URL é conferida no servidor', () => {
  it('produto de outra operação não existe nesta loja', async () => {
    const daGringa = publicar(gringa, 'Jaqueta');

    const res = await request(app).get(`/api/v1/loja/stores/preco-justo/products/${daGringa}`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('CORE_PRODUCT_NOT_FOUND');
  });

  it('na loja certa, aparece', async () => {
    const daGringa = publicar(gringa, 'Jaqueta');

    const res = await request(app).get(`/api/v1/loja/stores/gringa/products/${daGringa}`);

    expect(res.status).toBe(200);
    expect(res.body.storeName).toBe('Gringa');
  });

  it('produto despublicado não aparece nem na loja dele', async () => {
    const escondido = publicar(gringa, 'Interno');
    getConnection()
      .prepare('UPDATE core_products SET publish_online = 0 WHERE id = ?')
      .run(escondido);

    const res = await request(app).get(`/api/v1/loja/stores/gringa/products/${escondido}`);

    expect(res.status).toBe(404);
  });
});

describe('o que a página mostra', () => {
  it('usa a descrição de VITRINE, não a anotação interna', () => {
    const id = publicar(gringa, 'Jaqueta');

    const detalhe = getStorefrontProductDetail('gringa', id)!;

    expect(detalhe.description).toBe('Texto de vitrine, escrito para o cliente');
    expect(detalhe.description).not.toContain('Anotação interna');
  });

  it('traz marca, categoria e subcategoria', () => {
    const id = publicar(gringa, 'Jaqueta');

    const detalhe = getStorefrontProductDetail('gringa', id)!;

    expect(detalhe.brand).toBe('Marca X');
    expect(detalhe.category).toBe('Acessórios');
    expect(detalhe.subcategory).toBe('Vestuário');
  });

  it('a disponibilidade vem do estoque real', () => {
    const id = publicar(gringa, 'Jaqueta');

    expect(getStorefrontProductDetail('gringa', id)!.available).toBe(8);
  });

  it('o preço passa pela promoção — o mesmo do PDV e do carrinho', () => {
    const id = publicar(gringa, 'Jaqueta');
    const agora = new Date();
    getConnection()
      .prepare(
        `INSERT INTO core_promotions (id, company_id, product_id, price_cents, starts_at, ends_at, active, created_at)
         VALUES ('promo-pp', ?, ?, 15000, ?, ?, 1, ?)`,
      )
      .run(
        gringa,
        id,
        new Date(agora.getTime() - 86_400_000).toISOString(),
        new Date(agora.getTime() + 86_400_000).toISOString(),
        agora.toISOString(),
      );

    const detalhe = getStorefrontProductDetail('gringa', id)!;

    expect(detalhe.priceCents).toBe(15000);
    expect(detalhe.basePriceCents).toBe(20000);
    expect(detalhe.onSale).toBe(true);
  });
});

describe('prontidão de envio', () => {
  it('sem as quatro medidas, entrega não é oferecida', () => {
    const id = publicar(gringa, 'Sem medidas');

    const detalhe = getStorefrontProductDetail('gringa', id)!;

    expect(detalhe.shippingReadiness).toBe('SHIPPING_DATA_INCOMPLETE');
    expect(detalhe.missingShippingFields).toEqual(['peso', 'altura', 'largura', 'comprimento']);
  });

  it('faltando só uma medida, ainda é incompleto — e diz qual', () => {
    const id = publicar(gringa, 'Quase completo', {
      weightGrams: 500,
      heightCm: 10,
      widthCm: 15,
    });

    const detalhe = getStorefrontProductDetail('gringa', id)!;

    expect(detalhe.shippingReadiness).toBe('SHIPPING_DATA_INCOMPLETE');
    expect(detalhe.missingShippingFields).toEqual(['comprimento']);
  });

  it('com as quatro, está pronto para entrega', () => {
    const id = publicar(gringa, 'Completo', COMPLETO);

    const detalhe = getStorefrontProductDetail('gringa', id)!;

    expect(detalhe.shippingReadiness).toBe('READY_FOR_SHIPPING');
    expect(detalhe.missingShippingFields).toEqual([]);
  });
});

describe('validação das medidas no cadastro', () => {
  it.each([
    ['peso zero', { weightGrams: 0 }],
    ['peso negativo', { weightGrams: -5 }],
    ['altura texto', { heightCm: 'alto' as unknown as number }],
    ['largura NaN', { widthCm: Number.NaN }],
  ])('recusa %s', (_caso, medidas) => {
    expect(() =>
      createProduct(gringa, { name: 'Invalido', ...(medidas as Medidas) }),
    ).toThrow(expect.objectContaining({ code: 'CORE_INVALID_SHIPPING_DATA' }));
  });

  it('produto sem medidas é permitido — retirada não precisa delas', () => {
    expect(() => createProduct(gringa, { name: 'Só retirada' })).not.toThrow();
  });

  it('grava em gramas e centímetros, a convenção oficial', () => {
    const id = publicar(gringa, 'Medido', COMPLETO);

    const linha = getConnection()
      .prepare('SELECT weight_grams, height_cm, width_cm, length_cm FROM core_products WHERE id = ?')
      .get(id) as Record<string, number>;

    expect(linha).toEqual({ weight_grams: 800, height_cm: 12, width_cm: 18, length_cm: 24 });
  });
});

describe('variantes', () => {
  it('cada variante traz o próprio saldo — vender o P não consome o G', () => {
    const modelo = publicar(precoJusto, 'Camiseta Polo', COMPLETO);
    const agora = new Date().toISOString();
    const db = getConnection();
    for (const [sufixo, tamanho, saldo] of [
      ['p', 'P', 3],
      ['g', 'G', 7],
    ] as const) {
      const idVariante = `${modelo}-${sufixo}`;
      db.prepare(
        `INSERT INTO core_products (id, company_id, parent_id, internal_code, name, unit,
                                    cost_cents, price_cents, barcode, variant_attributes,
                                    active, publish_online, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'UN', 4000, 20000, ?, ?, 1, 1, ?, ?)`,
      ).run(
        idVariante,
        precoJusto,
        modelo,
        `VAR-${sufixo}`,
        `Camiseta Polo · ${tamanho}`,
        `789000000000${sufixo === 'p' ? 1 : 2}`,
        JSON.stringify({ tamanho }),
        agora,
        agora,
      );
      db.prepare(
        'INSERT INTO core_stock (company_id, product_id, quantity, reserved, updated_at) VALUES (?, ?, ?, 0, ?)',
      ).run(precoJusto, idVariante, saldo, agora);
    }

    const detalhe = getStorefrontProductDetail('preco-justo', modelo)!;

    expect(detalhe.variants).toHaveLength(2);
    // A ordem é por código interno, não por inserção.
    const porTamanho = Object.fromEntries(
      detalhe.variants.map((v) => [v.attributes.tamanho, v.available]),
    );
    expect(porTamanho).toEqual({ P: 3, G: 7 });
    // EAN próprio: é o que o PDV lê no balcão.
    expect(detalhe.variants[0].barcode).not.toBe(detalhe.variants[1].barcode);
  });

  it('produto sem grade não inventa variante', () => {
    const id = publicar(gringa, 'Item simples', COMPLETO);

    expect(getStorefrontProductDetail('gringa', id)!.variants).toEqual([]);
  });
});
