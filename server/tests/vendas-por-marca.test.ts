/**
 * ============================================================================
 * VENDAS POR MARCA — GAP-V44
 * ============================================================================
 *
 * ## O defeito
 *
 * "Qual marca vende mais no período" não tinha resposta em superfície nenhuma.
 * O ingrediente existia — `core_products.brand`, cadastro de marcas com merge
 * em `/core/taxonomy/brands` —, e os insights agregavam por produto, por
 * operação e por margem; nunca por marca. Para responder, o gerente exportava
 * as vendas e somava fora do sistema.
 *
 * ## As três coisas que este arquivo cobra, e por que cada uma
 *
 * 1. A SOMA DOS GRUPOS É O FATURAMENTO. É a mesma régua de `audit-dashboard`:
 *    um recorte que não fecha com o total é um relatório que perde ou duplica
 *    linha, e nesse formato ninguém percebe — o número sai plausível.
 *
 * 2. "SEM MARCA" É UM GRUPO, e não uma linha que some. Zero de dezenove
 *    produtos do banco real têm marca preenchida; se a agregação filtrasse
 *    `brand IS NOT NULL`, o relatório nasceria vazio E a soma dos grupos
 *    deixaria de bater com o faturamento — as duas coisas ao mesmo tempo, e a
 *    segunda esconderia a primeira. Marca vazia e marca em branco são a mesma
 *    ausência e caem no mesmo balde.
 *
 * 3. VENDA CANCELADA NÃO ENTRA, e a da EMPRESA VIZINHA muito menos. As duas
 *    são as regras do painel; um recorte novo que as ignorasse seria a porta
 *    por onde o faturamento da outra loja apareceria no relatório desta.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
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
const SENHA = 'Marca@DoPainel2026';

const HOJE = '2026-06-10';
const MEIO_DIA = '2026-06-10T15:00:00.000Z';

let conceito: string;
let gringa: string;
let auth: { Authorization: string };
let authGringa: { Authorization: string };

async function ator(login: string, companyId: string): Promise<{ Authorization: string }> {
  const userId = await upsertUser({ login, displayName: login, password: SENHA });
  linkUserToCompany(userId, companyId, 'gerente_loja', false);
  const res = await request(app).post('/api/v1/auth/login').send({ login, password: SENHA, companyId });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { Authorization: `Bearer ${res.body.accessToken}` };
}

beforeEach(async () => {
  resetDbForTests();
  conceito = upsertCompany({
    slug: 'conceito',
    legalName: 'Conceito Moda Feminina Ltda',
    tradeName: 'Conceito',
    kind: 'retail',
  });
  gringa = upsertCompany({
    slug: 'gringa',
    legalName: 'Gringa Comércio de Roupas Ltda',
    tradeName: 'Gringa',
    kind: 'retail',
  });
  auth = await ator('GERENTE.MARCA', conceito);
  authGringa = await ator('GERENTE.MARCA.GRINGA', gringa);
});

async function criarProduto(
  quem: { Authorization: string },
  nome: string,
  precoCents: number,
  brand?: string,
): Promise<string> {
  const res = await request(app)
    .post('/api/v1/core/products')
    .set(quem)
    .send({ name: nome, priceCents: precoCents, brand });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

async function carregar(quem: { Authorization: string }, productId: string, qtd: number) {
  const res = await request(app).post('/api/v1/core/stock/movements').set(quem).send({
    productId,
    movementType: 'in',
    quantity: qtd,
    referenceType: 'entrada',
    referenceId: `carga-${productId}-${randomUUID()}`,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
}

async function vender(
  quem: { Authorization: string },
  itens: { productId: string; quantity: number }[],
  totalCents: number,
): Promise<string> {
  const res = await request(app)
    .post('/api/v1/core/sales')
    .set(quem)
    .set('Idempotency-Key', randomUUID())
    .send({ items: itens, payments: [{ method: 'dinheiro', amountCents: totalCents }] });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const venda = res.body.sale ?? res.body;
  expect(venda.total_cents).toBe(totalCents);
  return venda.id as string;
}

function carimbar(saleId: string): void {
  getConnection().prepare('UPDATE core_sales SET created_at = ? WHERE id = ?').run(MEIO_DIA, saleId);
}

interface LinhaDeMarca {
  brand: string;
  quantity: number;
  revenue_cents: number;
  sales_count: number;
}

async function painel(quem: { Authorization: string }) {
  const res = await request(app)
    .get(`/api/v1/core/dashboard?from=${HOJE}&to=${HOJE}`)
    .set(quem);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as {
    revenueCents: number;
    byBrand: LinhaDeMarca[];
    byBrandUnallocatedCents: number;
  };
}

/**
 * O cenário: duas marcas e um produto sem marca, na Conceito.
 *
 *   Nike     — 2 × 10.000 = 20.000
 *   Adidas   — 1 ×  6.000 =  6.000
 *   (branco) — 3 ×  1.000 =  3.000
 *   cancelada: Nike 1 × 10.000 (não entra)
 *   faturamento do dia = 29.000
 */
async function montarCenario() {
  const nike = await criarProduto(auth, 'Tênis Corrida', 10_000, 'Nike');
  const adidas = await criarProduto(auth, 'Camiseta Dry', 6_000, 'Adidas');
  // Marca em BRANCO, e não ausente: o catálogo real tem as duas formas, e as
  // duas significam a mesma coisa.
  const semMarca = await criarProduto(auth, 'Meia avulsa', 1_000, '   ');
  await carregar(auth, nike, 10);
  await carregar(auth, adidas, 10);
  await carregar(auth, semMarca, 10);

  const v1 = await vender(auth, [{ productId: nike, quantity: 2 }], 20_000);
  const v2 = await vender(
    auth,
    [
      { productId: adidas, quantity: 1 },
      { productId: semMarca, quantity: 3 },
    ],
    9_000,
  );
  const cancelada = await vender(auth, [{ productId: nike, quantity: 1 }], 10_000);
  const cancel = await request(app)
    .post(`/api/v1/core/sales/${cancelada}/cancel`)
    .set(auth)
    .send({ reason: 'teste: a cancelada não pode contar' });
  expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);

  for (const id of [v1, v2, cancelada]) carimbar(id);
  return { nike, adidas, semMarca };
}

describe('o painel recorta as vendas por MARCA', () => {
  it('cada marca com quantidade e dinheiro, na ordem do dinheiro', async () => {
    await montarCenario();
    const p = await painel(auth);

    expect(p.byBrand.map((l) => l.brand)).toEqual(['Nike', 'Adidas', 'Sem marca']);
    expect(p.byBrand[0]).toMatchObject({ brand: 'Nike', quantity: 2, revenue_cents: 20_000 });
    expect(p.byBrand[1]).toMatchObject({ brand: 'Adidas', quantity: 1, revenue_cents: 6_000 });
    expect(p.byBrand[2]).toMatchObject({ brand: 'Sem marca', quantity: 3, revenue_cents: 3_000 });
  });

  it('A SOMA DAS MARCAS É O FATURAMENTO — nem um centavo a mais nem a menos', async () => {
    await montarCenario();
    const p = await painel(auth);
    const soma = p.byBrand.reduce((acc, l) => acc + l.revenue_cents, 0);
    expect(soma).toBe(29_000);
    // Sem desconto de rodapé no cenário, a soma das linhas É o faturamento — e
    // a parcela não rateada é exatamente zero, que é a forma de dizer isso.
    expect(p.byBrandUnallocatedCents).toBe(0);
    expect(soma + p.byBrandUnallocatedCents).toBe(p.revenueCents);
  });

  it('o desconto de RODAPÉ não é rateado entre as marcas — e a diferença é declarada', async () => {
    /*
      A conta de marca soma LINHAS de item. O desconto do rodapé (e o
      acréscimo) vive no cabeçalho da venda, sem dono entre as linhas: ratear
      R$ 5,00 por três marcas exigiria escolher um critério — proporcional ao
      valor? à quantidade? — e qualquer escolha inventaria um número que
      ninguém decidiu.

      Então ele NÃO é rateado, e a resposta diz de quanto é a diferença. Este
      caso existe para que ninguém "conserte" isso distribuindo em silêncio: o
      dia em que alguém o fizer, ele fica vermelho com a conta na mão.
    */
    const nike = await criarProduto(auth, 'Tênis Corrida', 10_000, 'Nike');
    await carregar(auth, nike, 10);
    const res = await request(app)
      .post('/api/v1/core/sales')
      .set(auth)
      .set('Idempotency-Key', randomUUID())
      .send({
        items: [{ productId: nike, quantity: 1 }],
        discountCents: 500,
        payments: [{ method: 'dinheiro', amountCents: 9_500 }],
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    carimbar((res.body.sale ?? res.body).id as string);

    const p = await painel(auth);
    expect(p.revenueCents).toBe(9_500);
    expect(p.byBrand.find((l) => l.brand === 'Nike')!.revenue_cents).toBe(10_000);
    expect(p.byBrandUnallocatedCents).toBe(-500);
  });

  it('a venda CANCELADA não engorda marca nenhuma', async () => {
    const { nike } = await montarCenario();
    expect(nike).toBeTruthy();
    const p = await painel(auth);
    // Fossem contadas as 3 unidades vendidas de Nike, o número seria 30.000.
    expect(p.byBrand.find((l) => l.brand === 'Nike')!.revenue_cents).toBe(20_000);
  });

  it('a marca da empresa VIZINHA não aparece — o recorte é o do token', async () => {
    await montarCenario();
    const puma = await criarProduto(authGringa, 'Chinelo', 4_000, 'Puma');
    await carregar(authGringa, puma, 5);
    carimbar(await vender(authGringa, [{ productId: puma, quantity: 1 }], 4_000));

    const daConceito = await painel(auth);
    expect(daConceito.byBrand.map((l) => l.brand)).not.toContain('Puma');

    const daGringa = await painel(authGringa);
    expect(daGringa.byBrand.map((l) => l.brand)).toEqual(['Puma']);
  });
});

describe('os insights somam a marca nas operações do vínculo', () => {
  it('GET /core/insights/brands devolve o mesmo dinheiro do painel da operação', async () => {
    await montarCenario();
    const res = await request(app)
      .get(`/api/v1/core/insights/brands?from=${HOJE}&to=${HOJE}`)
      .set(auth);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const itens = res.body.items as LinhaDeMarca[];
    expect(itens.map((l) => l.brand)).toEqual(['Nike', 'Adidas', 'Sem marca']);
    expect(itens.reduce((acc, l) => acc + l.revenue_cents, 0)).toBe(29_000);
  });

  it('o mecânico não alcança — o recorte de marca é leitura de quem gerencia', async () => {
    const userId = await upsertUser({
      login: 'MEC.MARCA',
      displayName: 'MEC.MARCA',
      password: SENHA,
    });
    linkUserToCompany(userId, conceito, 'mecanico', false);
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ login: 'MEC.MARCA', password: SENHA, companyId: conceito });
    expect(login.status).toBe(200);
    const res = await request(app)
      .get('/api/v1/core/insights/brands')
      .set('Authorization', `Bearer ${login.body.accessToken}`);
    expect(res.status).toBe(403);
  });
});
