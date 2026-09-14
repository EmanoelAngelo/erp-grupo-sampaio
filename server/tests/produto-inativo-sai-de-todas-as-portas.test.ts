/**
 * INATIVO É INATIVO EM TODA PORTA — e a variante herda o modelo.
 *
 * `active = 0` é o arquivamento do produto: a saída quando ele tem histórico e
 * não pode ser excluído. O PDV, o orçamento, a consignação e a vitrine já o
 * recusavam. Três portas não: a LOCAÇÃO (`createRentalContract` lia o produto
 * sem olhar `active`), a PEÇA LANÇADA NA OS (`addPart`, idem) e o DESTAQUE da
 * loja (`setFeatured` conferia só `publish_online`).
 *
 * E a VARIANTE: cada tamanho é uma linha própria com `active` próprio. Inativar
 * o MODELO deixava os tamanhos ativos — bipados no balcão entravam no
 * carrinho, fechavam venda e passavam no checkout online.
 *
 * Cada caso tem o controle positivo ao lado: a recusa é do inativo, não de
 * todo mundo.
 *
 * Os produtos entram por INSERT cru de propósito, como em
 * `peca-fora-da-venda.test.ts`: o estado "modelo inativo com variante ativa"
 * chega ao banco pelo PUT do modelo, que não toca nas variantes — e é o LEITOR
 * que precisa se proteger.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetEnvCacheForTests } from '../src/config/env.js';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { getConnection } from '../src/db/sqlite.js';
import { searchProducts } from '../src/services/core/CatalogService.js';
import { createSale } from '../src/services/core/SalesService.js';
import { checkout } from '../src/services/core/StorefrontService.js';
import { setFeatured } from '../src/services/core/StorefrontSettingsService.js';
import { variantStock } from '../src/services/core/VariantService.js';
import { addPart, createOrder } from '../src/services/core/WorkshopCoreService.js';
import { issueSession } from './helpers/sessao.js';

process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-key';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-32-chars!!';

const EMPRESA = 'company-inativo';
const BANCADA = 'wk-inativo';
const MECANICO = 'u-mecanico-inativo';
const CAIXA = 'u-caixa-inativo';

let app: ReturnType<typeof createApp>;

function auth(perfil: string, userId = `u-${perfil}`): { Authorization: string } {
  const s = issueSession({ userId, companyId: EMPRESA, profileCodes: [perfil] });
  return { Authorization: `Bearer ${s.accessToken}` };
}

function inserir(input: {
  id: string;
  ativo?: boolean;
  publicado?: boolean;
  parentId?: string | null;
  barcode?: string | null;
  kind?: 'retail' | 'part';
  workshopId?: string | null;
}): string {
  const agora = new Date().toISOString();
  const db = getConnection();
  db.prepare(
    `INSERT INTO core_products
       (id, company_id, internal_code, name, unit, cost_cents, price_cents, barcode,
        active, publish_online, kind, workshop_id, parent_id,
        weight_grams, height_cm, width_cm, length_cm, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'UN', 1000, 5000, ?, ?, ?, ?, ?, ?, 500, 10, 10, 10, ?, ?)`,
  ).run(
    input.id,
    EMPRESA,
    `COD-${input.id}`,
    `Produto ${input.id}`,
    input.barcode ?? null,
    input.ativo === false ? 0 : 1,
    input.publicado === false ? 0 : 1,
    input.kind ?? 'retail',
    input.workshopId ?? null,
    input.parentId ?? null,
    agora,
    agora,
  );
  db.prepare(
    'INSERT INTO core_stock (company_id, product_id, quantity, reserved, updated_at) VALUES (?, ?, 10, 0, ?)',
  ).run(EMPRESA, input.id, agora);
  return input.id;
}

function codigoDoErro(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? String(err);
  }
}

beforeEach(() => {
  resetEnvCacheForTests();
  resetDbForTests();
  ensureCoreSchema();
  app = createApp();
  // Provisiona a empresa, o caixa e o mecânico de verdade.
  auth('operador_caixa_loja', CAIXA);
  auth('mecanico', MECANICO);
  getConnection()
    .prepare(
      `INSERT INTO core_workshops (id, company_id, slug, name, kind, active, created_at)
       VALUES (?, ?, 'bancada-inativo', 'Oficina de Celulares', 'phones', 1, ?)`,
    )
    .run(BANCADA, EMPRESA, new Date().toISOString());
});

describe('o produto inativo fica fora da venda', () => {
  it('PDV: some da busca (por código e por nome)', () => {
    inserir({ id: 'ina', ativo: false, barcode: '7891111000019' });
    inserir({ id: 'ati', barcode: '7891111000002' });
    expect(searchProducts(EMPRESA, '7891111000019')).toEqual([]);
    expect(searchProducts(EMPRESA, 'COD-ina')).toEqual([]);
    expect(searchProducts(EMPRESA, '7891111000002').map((p) => p.id)).toEqual(['ati']);
  });

  it('venda: recusada no fechamento', () => {
    inserir({ id: 'ina', ativo: false });
    expect(
      codigoDoErro(() =>
        createSale({
          companyId: EMPRESA,
          userId: CAIXA,
          items: [{ productId: 'ina', quantity: 1 }],
          payments: [{ method: 'pix', amountCents: 5000 }],
          idempotencyKey: 'venda-inativo',
        }),
      ),
    ).toBe('CORE_PRODUCT_NOT_FOUND');
  });

  it('LOCAÇÃO: recusada com o nome do produto — e o ativo continua alugando', async () => {
    inserir({ id: 'ina', ativo: false });
    inserir({ id: 'ati' });
    const gerente = auth('gerente_loja');
    const cliente = await request(app)
      .post('/api/v1/core/customers')
      .set(gerente)
      .send({ name: 'Cliente Locatário', document: '11122233396' });
    expect(cliente.status, JSON.stringify(cliente.body)).toBe(201);
    const contrato = (productId: string) =>
      request(app)
        .post('/api/v1/core/rentals')
        .set(gerente)
        .send({
          customerId: cliente.body.id,
          endsAt: new Date(Date.now() + 86_400_000).toISOString(),
          items: [{ productId, quantity: 1, unitCents: 5000 }],
        });

    const recusado = await contrato('ina');
    expect(recusado.status, JSON.stringify(recusado.body)).toBe(409);
    expect(recusado.body.error.code).toBe('CORE_PRODUCT_INACTIVE');
    expect(recusado.body.error.message).toContain('Produto ina');
    expect(
      (getConnection().prepare('SELECT COUNT(*) AS n FROM core_rental_contract_items').get() as { n: number }).n,
    ).toBe(0);

    const aceito = await contrato('ati');
    expect(aceito.status, JSON.stringify(aceito.body)).toBe(201);
  });

  it('PEÇA NA OS: recusada — e a peça ativa continua entrando', () => {
    inserir({ id: 'peca-ina', ativo: false, kind: 'part', workshopId: BANCADA, publicado: false });
    inserir({ id: 'peca-ati', kind: 'part', workshopId: BANCADA, publicado: false });
    const os = createOrder({
      companyId: EMPRESA,
      workshopId: BANCADA,
      userId: MECANICO,
      customerName: 'Cliente Balcão',
      complaint: 'Não liga',
    });
    const lancar = (productId: string) => () =>
      addPart({
        companyId: EMPRESA,
        workshopId: BANCADA,
        orderId: String(os.id),
        userId: MECANICO,
        productId,
        quantity: 1,
      });

    expect(codigoDoErro(lancar('peca-ina'))).toBe('CORE_PRODUCT_INACTIVE');
    expect(codigoDoErro(lancar('peca-ati'))).toBeNull();
  });

  it('DESTAQUE da loja: inativo publicado não vira destaque — o ativo vira', () => {
    inserir({ id: 'ina', ativo: false, publicado: true });
    inserir({ id: 'ati', publicado: true });
    expect(codigoDoErro(() => setFeatured(EMPRESA, 'ina', true))).toBe('CORE_PRODUCT_INACTIVE');
    expect(codigoDoErro(() => setFeatured(EMPRESA, 'ati', true))).toBeNull();
    // Tirar o destaque de um inativo continua possível: é limpeza, não promessa.
    expect(codigoDoErro(() => setFeatured(EMPRESA, 'ina', false))).toBeNull();
  });

  it('CHECKOUT online: recusado', () => {
    inserir({ id: 'ina', ativo: false, publicado: true });
    expect(() =>
      checkout({
        idempotencyKey: 'chk-inativo',
        customerName: 'Cliente Teste',
        paymentMethod: 'pix',
        items: [{ productId: 'ina', quantity: 1 }],
      }),
    ).toThrowError(/indisponível/i);
  });
});

describe('a VARIANTE herda o modelo: modelo inativo, tamanho fora de venda', () => {
  beforeEach(() => {
    inserir({ id: 'modelo', ativo: false, publicado: true });
    inserir({ id: 'var-p', parentId: 'modelo', barcode: '7892222000004', publicado: true });
    inserir({ id: 'modelo-ok', publicado: true });
    inserir({ id: 'var-ok', parentId: 'modelo-ok', barcode: '7892222000011', publicado: true });
  });

  it('PDV: a busca não acha o tamanho do modelo inativo — e acha o do modelo ativo', () => {
    expect(searchProducts(EMPRESA, '7892222000004')).toEqual([]);
    expect(searchProducts(EMPRESA, '7892222000011').map((p) => p.id)).toEqual(['var-ok']);
  });

  it('PDV: a venda recusa o tamanho do modelo inativo', () => {
    expect(
      codigoDoErro(() =>
        createSale({
          companyId: EMPRESA,
          userId: CAIXA,
          items: [{ productId: 'var-p', quantity: 1 }],
          payments: [{ method: 'pix', amountCents: 5000 }],
          idempotencyKey: 'venda-var-inativa',
        }),
      ),
    ).toBe('CORE_PRODUCT_NOT_FOUND');
  });

  it('CHECKOUT: recusa o tamanho do modelo inativo — e aceita o do modelo ativo', () => {
    expect(() =>
      checkout({
        idempotencyKey: 'chk-var-inativa',
        customerName: 'Cliente Teste',
        paymentMethod: 'pix',
        items: [{ productId: 'var-p', quantity: 1 }],
      }),
    ).toThrowError(/indisponível/i);
    const pedidos = checkout({
      idempotencyKey: 'chk-var-ok',
      customerName: 'Cliente Teste',
      paymentMethod: 'pix',
      items: [{ productId: 'var-ok', quantity: 1 }],
    });
    expect(pedidos).toHaveLength(1);
  });

  it('a listagem da grade diz que o tamanho não está à venda', () => {
    expect(variantStock(EMPRESA, 'modelo').items.map((v) => v.vendavel)).toEqual([0]);
    expect(variantStock(EMPRESA, 'modelo-ok').items.map((v) => v.vendavel)).toEqual([1]);
  });
});
