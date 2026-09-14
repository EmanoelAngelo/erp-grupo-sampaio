/**
 * Simulação de frete na página do produto.
 *
 * É ESTIMATIVA. O frete que vale é o do checkout, sobre o carrinho fechado —
 * prometer aqui um valor definitivo seria cobrar diferente depois, com o
 * cliente já decidido.
 *
 * E nada vai ao provedor antes de existir tudo: CEP de origem, CEP de destino
 * e as quatro medidas. A alternativa seria cotar uma caixa imaginária, que é
 * exatamente o defeito que esta rodada veio fechar.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import { createProduct, updateProduct } from '../src/services/core/CatalogService.js';
import { updateFiscalConfig } from '../src/services/core/FiscalConfigService.js';
import { normalizeZip } from '../src/services/core/OrderShippingService.js';
import { grupoTributarioPadrao } from './helpers/grupoTributario.js';

const app = createApp();
const COMPLETO = { weightGrams: 800, heightCm: 12, widthCm: 18, lengthCm: 24 };

let gringa: string;

function publicar(nome: string, medidas: Partial<typeof COMPLETO> = {}): string {
  const p = createProduct(gringa, {
    name: nome,
    priceCents: 20000,
    publishOnline: true,
    ...medidas,
  });
  getConnection()
    .prepare(
      'INSERT INTO core_stock (company_id, product_id, quantity, reserved, updated_at) VALUES (?, ?, 5, 0, ?)',
    )
    .run(gringa, String(p.id), new Date().toISOString());
  return String(p.id);
}

function comEnderecoDeOrigem(zip: string) {
  updateFiscalConfig({ companyId: gringa, patch: { zip } });
  grupoTributarioPadrao(gringa);
}

async function cotar(productId: string, zip: string) {
  return request(app)
    .post(`/api/v1/loja/stores/gringa/products/${productId}/shipping-quote`)
    .send({ zip });
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  gringa = await upsertCompany({ slug: 'gringa', tradeName: 'Gringa', legalName: 'Gringa Ltda' });
});

describe('CEP', () => {
  it.each([
    ['com hífen', '68900-000', '68900000'],
    ['sem hífen', '68900000', '68900000'],
    ['com espaços', ' 68900 000 ', '68900000'],
  ])('%s é normalizado', (_caso, entrada, esperado) => {
    expect(normalizeZip(entrada)).toBe(esperado);
  });

  it.each([['curto', '689'], ['vazio', ''], ['texto', 'abcdefgh']])(
    'CEP %s é recusado',
    (_caso, entrada) => {
      expect(normalizeZip(entrada)).toBeNull();
    },
  );

  it('CEP inválido não chega ao provedor', async () => {
    comEnderecoDeOrigem('01310100');
    const id = publicar('Com medidas', COMPLETO);

    const res = await cotar(id, '123');

    expect(res.body.code).toBe('INVALID_ZIP');
    expect(res.body.options).toEqual([]);
  });
});

describe('o que impede a cotação', () => {
  it('produto sem medidas: SHIPPING_DATA_REQUIRED, com a lista do que falta', async () => {
    comEnderecoDeOrigem('01310100');
    const id = publicar('Sem medidas');

    const res = await cotar(id, '68900-000');

    expect(res.body.code).toBe('SHIPPING_DATA_REQUIRED');
    expect(res.body.missing).toEqual(['peso', 'altura', 'largura', 'comprimento']);
    expect(res.body.options).toEqual([]);
  });

  it('loja sem endereço de origem: pendência do gestor, não erro do cliente', async () => {
    const id = publicar('Com medidas', COMPLETO);

    const res = await cotar(id, '68900-000');

    expect(res.body.code).toBe('ORIGIN_NOT_CONFIGURED');
    expect(res.body.missing).toEqual(['CEP de origem da loja']);
  });

  it('produto de outra loja não é cotável por esta URL', async () => {
    const precoJusto = await upsertCompany({
      slug: 'preco-justo',
      tradeName: 'Preço Justo',
      legalName: 'PJ Ltda',
    });
    const doVizinho = createProduct(precoJusto, {
      name: 'Do vizinho',
      priceCents: 1000,
      publishOnline: true,
      ...COMPLETO,
    });

    const res = await request(app)
      .post(`/api/v1/loja/stores/gringa/products/${String(doVizinho.id)}/shipping-quote`)
      .send({ zip: '68900-000' });

    expect(res.status).toBe(404);
  });
});

describe('com tudo no lugar', () => {
  it('responde como ESTIMATIVA — o valor final é o do checkout', async () => {
    comEnderecoDeOrigem('01310100');
    const id = publicar('Com medidas', COMPLETO);

    const res = await cotar(id, '68900-000');

    expect(res.status).toBe(200);
    expect(res.body.estimate).toBe(true);
    expect(res.body.code).toBeUndefined();
  });

  it('sem credencial de transportadora, nenhuma opção é inventada', async () => {
    comEnderecoDeOrigem('01310100');
    const id = publicar('Com medidas', COMPLETO);

    const res = await cotar(id, '68900-000');

    // Sem credencial não há cotação real; o que não pode é aparecer preço
    // fabricado como se viesse do transportador.
    expect(res.body.real).toBe(false);
    for (const opcao of res.body.options ?? []) {
      expect(opcao.simulated).toBe(true);
    }
  });
});

describe('medidas no cadastro', () => {
  it('atualizar outro campo preserva as medidas já gravadas', () => {
    const id = publicar('Com medidas', COMPLETO);

    updateProduct(gringa, id, { name: 'Nome novo' });

    const linha = getConnection()
      .prepare('SELECT name, weight_grams, height_cm FROM core_products WHERE id = ?')
      .get(id) as { name: string; weight_grams: number; height_cm: number };
    expect(linha.name).toBe('Nome novo');
    expect(linha.weight_grams).toBe(800);
    expect(linha.height_cm).toBe(12);
  });

  it('medida inválida na edição é recusada e nada é gravado', () => {
    const id = publicar('Com medidas', COMPLETO);

    expect(() => updateProduct(gringa, id, { name: 'X', weightGrams: -1 })).toThrow(
      expect.objectContaining({ code: 'CORE_INVALID_SHIPPING_DATA' }),
    );

    const linha = getConnection()
      .prepare('SELECT name, weight_grams FROM core_products WHERE id = ?')
      .get(id) as { name: string; weight_grams: number };
    expect(linha.name).toBe('Com medidas');
    expect(linha.weight_grams).toBe(800);
  });
});
