/**
 * QUEM VENDEU É QUEM O CAIXA APONTA — e o caixa não conseguia apontar ninguém.
 *
 * ============================================================================
 * O QUE ACONTECIA
 * ============================================================================
 *
 * O PDV monta o seletor "Vendedor" chamando `GET /core/team` na abertura da
 * tela. Essa rota exige `gerente_loja` ou `gerente_oficina` — e quem opera o
 * PDV é `operador_caixa_loja` ou `operador_caixa_oficina`. O 403 caía num
 * `.catch(() => setEquipe([]))` silencioso, o seletor nunca aparecia, e TODA
 * venda saía em nome de quem estava no caixa.
 *
 * O estrago é o contracheque: a comissão do mês inteiro, das seis operações,
 * ia para o operador do caixa. Quem vendeu não aparece em relatório nenhum, e
 * quem descobre é o vendedor, no fim do mês, sem prova de nada.
 *
 * ============================================================================
 * POR QUE UMA ROTA NOVA, E NÃO ABRIR A DE GESTÃO
 * ============================================================================
 *
 * `GET /core/team` devolve o cadastro inteiro: login, e-mail, último acesso,
 * se precisa trocar a senha, vínculos de oficina. Login é metade de uma
 * credencial, e nada disso serve para preencher um seletor de vendedor.
 *
 * A porta do balcão devolve só o que o balcão usa: id, nome e se está ativo.
 * Quem é gerente continua vendo o cadastro completo pela rota de gestão.
 */
import { beforeEach, describe, expect, it } from 'vitest';

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

const app = createApp();
const SENHA = 'Teste@Balcao2026';

let lojaA: string;
let lojaB: string;

async function entrar(login: string) {
  const r = await request(app).post('/api/v1/auth/login').send({ login, password: SENHA });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.accessToken as string;
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();

  lojaA = upsertCompany({
    slug: 'preco-justo',
    legalName: 'Preço Justo Ltda',
    tradeName: 'Preço Justo',
    kind: 'store',
  });
  lojaB = upsertCompany({
    slug: 'gringa',
    legalName: 'Gringa Ltda',
    tradeName: 'Gringa',
    kind: 'store',
  });

  const caixa = await upsertUser({ login: 'CAIXA_A', displayName: 'Caixa A', password: SENHA });
  linkUserToCompany(caixa, lojaA, 'operador_caixa_loja', true);

  const vendedora = await upsertUser({
    login: 'VENDEDORA_A',
    displayName: 'Marta Vendedora',
    password: SENHA,
    email: 'marta@exemplo.com',
  });
  linkUserToCompany(vendedora, lojaA, 'atendente', true);

  const daOutraLoja = await upsertUser({
    login: 'VENDEDOR_B',
    displayName: 'Ninguém Daqui',
    password: SENHA,
  });
  linkUserToCompany(daOutraLoja, lojaB, 'atendente', true);

  const gerente = await upsertUser({
    login: 'GERENTE_A',
    displayName: 'Gerente A',
    password: SENHA,
  });
  linkUserToCompany(gerente, lojaA, 'gerente_loja', true);
});

// ============================================================================

describe('o balcão alcança a lista de vendedores', () => {
  it('o operador de caixa vê quem pode vender na SUA loja', async () => {
    const token = await entrar('CAIXA_A');
    const r = await request(app)
      .get('/api/v1/core/sellers')
      .set('Authorization', `Bearer ${token}`);

    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const nomes = (r.body.items as { displayName: string }[]).map((p) => p.displayName);
    expect(nomes).toContain('Marta Vendedora');
    expect(nomes).toContain('Caixa A');
  });

  it('a lista para na porta da loja — ninguém de outra empresa aparece', async () => {
    const token = await entrar('CAIXA_A');
    const r = await request(app)
      .get('/api/v1/core/sellers')
      .set('Authorization', `Bearer ${token}`);

    const nomes = (r.body.items as { displayName: string }[]).map((p) => p.displayName);
    expect(nomes).not.toContain('Ninguém Daqui');
  });

  it('devolve só o que o seletor usa — nada de login, e-mail ou último acesso', async () => {
    /*
      `GET /core/team` devolve o cadastro inteiro, e login é metade de uma
      credencial. Abrir aquela rota para o balcão resolveria o seletor e
      entregaria de brinde o cadastro de pessoal a quem só precisa de um nome.
    */
    const token = await entrar('CAIXA_A');
    const r = await request(app)
      .get('/api/v1/core/sellers')
      .set('Authorization', `Bearer ${token}`);

    const chaves = Object.keys((r.body.items as Record<string, unknown>[])[0]).sort();
    expect(chaves).toEqual(['active', 'displayName', 'id']);
  });

  it('o gerente também alcança — é a mesma tela de balcão', async () => {
    const token = await entrar('GERENTE_A');
    const r = await request(app)
      .get('/api/v1/core/sellers')
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
  });

  it('sem token não passa', async () => {
    const r = await request(app).get('/api/v1/core/sellers');
    expect(r.status).toBe(401);
  });
});

// ============================================================================

describe('a rota de gestão continua sendo de gestão', () => {
  it('o operador de caixa NÃO lê o cadastro de pessoal', async () => {
    const token = await entrar('CAIXA_A');
    const r = await request(app).get('/api/v1/core/team').set('Authorization', `Bearer ${token}`);

    // Nome de vendedor para atribuir a venda é uma coisa; login, e-mail e
    // último acesso de cada colega é outra.
    expect(r.status).toBe(403);
  });
});
