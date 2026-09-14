/**
 * A pendência de envio, do jeito que o gestor precisa ver.
 *
 * Um produto publicado sem peso e dimensões não pode ser entregue — e ninguém
 * descobre isso até um cliente tentar comprar. O contador e o filtro existem
 * para que a pendência apareça antes da venda, não depois.
 *
 * A regra do que é "sem dados de envio" é UMA SÓ, compartilhada com a vitrine
 * e com a cotação. Se a listagem do gestor discordasse da loja sobre quais
 * itens podem ser enviados, as duas telas estariam certas ao mesmo tempo.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import {
  linkUserToCompany,
  upsertCompany,
  upsertUser,
} from '../src/services/auth/IdentityService.js';
import {
  countProductsMissingShippingData,
  createProduct,
  listProducts,
} from '../src/services/core/CatalogService.js';

const app = createApp();
const SENHA = 'Teste@Envio2026';
const COMPLETO = { weightGrams: 800, heightCm: 12, widthCm: 18, lengthCm: 24 };

let gringa: string;
let precoJusto: string;
let gerenteGringa: { Authorization: string };
let gerentePrecoJusto: { Authorization: string };

async function ator(login: string, company: string) {
  const id = await upsertUser({ login, displayName: login, password: SENHA });
  linkUserToCompany(id, company, 'gerente_loja', true);
  const res = await request(app).post('/api/v1/auth/login').send({ login, password: SENHA });
  expect(res.status).toBe(200);
  return { Authorization: `Bearer ${res.body.accessToken}` };
}

function produto(
  companyId: string,
  nome: string,
  opcoes: { publicado?: boolean; medidas?: Partial<typeof COMPLETO> } = {},
): string {
  const p = createProduct(companyId, {
    name: nome,
    priceCents: 10000,
    publishOnline: opcoes.publicado ?? true,
    ...(opcoes.medidas ?? {}),
  });
  return String(p.id);
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  gringa = await upsertCompany({ slug: 'gringa', tradeName: 'Gringa', legalName: 'Gringa Ltda' });
  precoJusto = await upsertCompany({
    slug: 'preco-justo',
    tradeName: 'Preço Justo',
    legalName: 'PJ Ltda',
  });
  gerenteGringa = await ator('gerente.gringa', gringa);
  gerentePrecoJusto = await ator('gerente.pj', precoJusto);
});

describe('o que conta como pendência', () => {
  it('publicado sem nenhuma medida conta', () => {
    produto(gringa, 'Sem medidas');

    expect(countProductsMissingShippingData(gringa)).toBe(1);
  });

  it('faltando UMA medida ainda conta — não dá para cotar meia caixa', () => {
    produto(gringa, 'Quase', { medidas: { weightGrams: 500, heightCm: 10, widthCm: 15 } });

    expect(countProductsMissingShippingData(gringa)).toBe(1);
  });

  it('completo não conta', () => {
    produto(gringa, 'Completo', { medidas: COMPLETO });

    expect(countProductsMissingShippingData(gringa)).toBe(0);
  });

  it('produto NÃO publicado não é pendência — nunca vai ser enviado', () => {
    produto(gringa, 'Interno', { publicado: false });

    expect(countProductsMissingShippingData(gringa)).toBe(0);
  });

  it('medida zerada conta como ausente', async () => {
    const id = produto(gringa, 'Zerado', { medidas: COMPLETO });
    // Zero não passa pelo cadastro; simula um dado antigo no banco.
    const { getConnection } = await import('../src/db/sqlite.js');
    getConnection().prepare('UPDATE core_products SET weight_grams = 0 WHERE id = ?').run(id);

    expect(countProductsMissingShippingData(gringa)).toBe(1);
  });
});

describe('o filtro', () => {
  it('devolve só os pendentes', () => {
    produto(gringa, 'Completo', { medidas: COMPLETO });
    produto(gringa, 'Pendente');

    const filtrados = listProducts(gringa, { missingShippingData: true });

    expect(filtrados).toHaveLength(1);
    expect(filtrados[0].name).toBe('Pendente');
  });

  it('sem o filtro, devolve todos', () => {
    produto(gringa, 'Completo', { medidas: COMPLETO });
    produto(gringa, 'Pendente');

    expect(listProducts(gringa)).toHaveLength(2);
  });
});

describe('cada operação enxerga a própria pendência', () => {
  it('a contagem não soma o catálogo da vizinha', () => {
    produto(gringa, 'Pendente da Gringa');
    produto(precoJusto, 'Pendente do Preço Justo');
    produto(precoJusto, 'Outro do Preço Justo');

    expect(countProductsMissingShippingData(gringa)).toBe(1);
    expect(countProductsMissingShippingData(precoJusto)).toBe(2);
  });

  it('pela API, cada gerente recebe a contagem da sua operação', async () => {
    produto(gringa, 'Pendente da Gringa');
    produto(precoJusto, 'Pendente A');
    produto(precoJusto, 'Pendente B');

    const daGringa = await request(app).get('/api/v1/core/products').set(gerenteGringa);
    const doPrecoJusto = await request(app).get('/api/v1/core/products').set(gerentePrecoJusto);

    expect(daGringa.body.missingShippingDataCount).toBe(1);
    expect(doPrecoJusto.body.missingShippingDataCount).toBe(2);
  });

  it('o filtro pela API respeita o tenant', async () => {
    produto(gringa, 'Pendente da Gringa');
    produto(precoJusto, 'Pendente do Preço Justo');

    const res = await request(app)
      .get('/api/v1/core/products?missingShippingData=1')
      .set(gerenteGringa);

    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].name).toBe('Pendente da Gringa');
  });
});
