/**
 * O GERENTE DA OFICINA ABRIA O PDV E NÃO CONSEGUIA VENDER NADA.
 *
 * ============================================================================
 * O QUE ACONTECIA
 * ============================================================================
 *
 * O roteador do navegador deixa `gerente_oficina` chegar ao /pdv: ele é do
 * ambiente de gestão, e a rota do PDV aceita gestão. Mas TODAS as rotas de
 * dinheiro do balcão nomeavam `gerente_loja` e esqueciam `gerente_oficina` —
 * abrir o caixa, sangrar, suprir, fechar, lançar pré-venda, faturar e vender.
 *
 * Em oficina pequena o gerente É quem fica no balcão. Ele abria a tela inteira,
 * montava o carrinho com o cliente na frente e tomava 403 no Finalizar. Uma
 * tela que abre e não funciona é pior que uma tela que não abre: a pessoa só
 * descobre depois de se comprometer.
 *
 * A causa é conhecida neste arquivo — o comentário do `CAIXAS` já conta que
 * "seis rotas fiscais esqueciam o `_oficina`" e que espalhar a lista à mão foi
 * o que permitiu a divergência. A lista voltou a ser espalhada à mão para a
 * gerência, e o mesmo esquecimento aconteceu de novo, do outro lado.
 *
 * Agora há um nome para "quem opera o balcão": `BALCAO_E_GERENCIA`.
 *
 * ============================================================================
 * O QUE ESTE TESTE NÃO DEIXA VOLTAR
 * ============================================================================
 *
 * Além do 403 em cada rota, há a varredura: nenhuma rota do balcão pode
 * nomear `gerente_loja` sem nomear `gerente_oficina` junto. É a mesma forma de
 * guarda que já protege os dois perfis de caixa.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_DATABASE_PATH = ':memory:';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

const request = (await import('supertest')).default;
const { createApp } = await import('../src/app.js');
const { ensureCoreSchema } = await import('../src/db/schema.js');
const { resetDbForTests } = await import('../src/db/database.js');
const { upsertCompany, upsertUser, linkUserToCompany } = await import(
  '../src/services/auth/IdentityService.js'
);
const { createProduct } = await import('../src/services/core/CatalogService.js');
const { applyMovement } = await import('../src/services/core/InventoryService.js');

const app = createApp();
const SENHA = 'Teste@Oficina2026';

let oficina: string;
let produto: string;
let token: string;

async function entrar(login: string) {
  const r = await request(app).post('/api/v1/auth/login').send({ login, password: SENHA });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.accessToken as string;
}

const comToken = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();

  oficina = upsertCompany({
    slug: 'oficina',
    legalName: 'Oficina Sampaio Ltda',
    tradeName: 'Oficina',
    kind: 'mobility',
  });

  const gerente = await upsertUser({
    login: 'GERENTE_OFC',
    displayName: 'Gerente da Oficina',
    password: SENHA,
  });
  linkUserToCompany(gerente, oficina, 'gerente_oficina', true);

  produto = createProduct(oficina, { name: 'Pastilha de freio', priceCents: 8000 }).id;
  applyMovement({
    companyId: oficina,
    productId: produto,
    movementType: 'in',
    quantity: 10,
    referenceType: 'ajuste',
    referenceId: 'e1',
  });

  token = await entrar('GERENTE_OFC');
});

// ============================================================================

describe('o gerente da oficina opera o balcão da própria oficina', () => {
  it('abre o caixa', async () => {
    const r = await comToken(request(app).post('/api/v1/core/cash/open')).send({
      openingCents: 10000,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  });

  it('faz sangria e suprimento na gaveta que abriu', async () => {
    const caixa = await comToken(request(app).post('/api/v1/core/cash/open')).send({
      openingCents: 10000,
    });
    const sessionId = caixa.body.id as string;

    const suprimento = await comToken(
      request(app).post(`/api/v1/core/cash/${sessionId}/movements`),
    ).send({ movementType: 'supply', amountCents: 5000, note: 'troco' });
    expect(suprimento.status, JSON.stringify(suprimento.body)).toBe(201);
  });

  it('vende — e é aqui que o 403 chegava, com o cliente na frente', async () => {
    const caixa = await comToken(request(app).post('/api/v1/core/cash/open')).send({
      openingCents: 0,
    });

    const venda = await comToken(request(app).post('/api/v1/core/sales')).send({
      items: [{ productId: produto, quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: 8000 }],
      cashSessionId: caixa.body.id,
      idempotencyKey: 'ofc-1',
    });
    expect(venda.status, JSON.stringify(venda.body)).toBe(201);
  });

  it('fecha o caixa no fim do turno', async () => {
    const caixa = await comToken(request(app).post('/api/v1/core/cash/open')).send({
      openingCents: 10000,
    });
    const r = await comToken(
      request(app).post(`/api/v1/core/cash/${caixa.body.id}/close`),
    ).send({ countedCents: 10000 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  });

  it('lança e fatura uma pré-venda — a peça encomendada que o cliente volta para buscar', async () => {
    const caixa = await comToken(request(app).post('/api/v1/core/cash/open')).send({
      openingCents: 0,
    });

    const orcamento = await comToken(request(app).post('/api/v1/core/quotes')).send({
      kind: 'pre_venda',
      items: [{ productId: produto, quantity: 1 }],
    });
    expect(orcamento.status, JSON.stringify(orcamento.body)).toBe(201);

    const faturada = await comToken(
      request(app).post(`/api/v1/core/quotes/${orcamento.body.id}/convert`),
    ).send({
      payments: [{ method: 'dinheiro', amountCents: 8000 }],
      cashSessionId: caixa.body.id,
      idempotencyKey: 'ofc-2',
    });
    expect(faturada.status, JSON.stringify(faturada.body)).toBe(201);
  });
});

// ============================================================================

describe('a lista de quem opera o balcão tem um nome só', () => {
  it('nenhuma rota nomeia gerente_loja sem nomear a oficina junto', () => {
    /*
      Espalhar a lista à mão foi o que permitiu a divergência das seis rotas
      fiscais que esqueciam o `_oficina` — está escrito no próprio arquivo. A
      lição valeu para os caixas e não valeu para a gerência: o mesmo
      esquecimento voltou, do outro lado.
    */
    const fonte = readFileSync(new URL('../src/routes/v1/core.ts', import.meta.url), 'utf8');
    const chamadas = [...fonte.matchAll(/requireProfile\(\s*req\s*,([^)]*)\)/g)].map((m) => m[1]);

    const doBalcao = chamadas.filter((args) => /operador_caixa/.test(args));
    expect(doBalcao.length).toBeGreaterThan(5);

    for (const args of doBalcao) {
      if (!/'gerente_loja'/.test(args)) continue;
      expect(
        /gerente_oficina|BALCAO_E_GERENCIA/.test(args),
        `rota de balcão com gerente_loja e sem gerente_oficina: ${args.trim()}`,
      ).toBe(true);
    }
  });
});
