/**
 * OS DOIS GRAVES DA AUDITORIA DE ENTREGA — e as fronteiras que faltavam.
 *
 * ============================================================================
 * DE ONDE ESTES CASOS VIERAM
 * ============================================================================
 *
 * A auditoria multiempresa (5 lentes, 37 agentes, 27 achados confirmados)
 * encontrou dois furos GRAVES na fronteira entre empresas:
 *
 *  1. A VENDA ACEITAVA O CAIXA DE OUTRA EMPRESA. `createSale` gravava o
 *     `cashSessionId` recebido sem conferir de quem é a gaveta — a venda da
 *     empresa A entrava no caixa da empresa B e contaminava o fechamento
 *     dela. A devolução, no arquivo ao lado, valida exatamente isso; a venda
 *     não validava.
 *
 *  2. O TOKEN DE WEBHOOK DO .env VALIA EM PRODUÇÃO PARA QUALQUER EMPRESA.
 *     A API key tem guarda (`asaasEnvFallbackAllowed`: env só fora de
 *     produção); o token do webhook não tinha — uma empresa sem token
 *     cadastrado validava eventos com o token global, que na prática é o da
 *     primeira empresa configurada.
 *
 * E três fronteiras médias do mesmo gênero — ids soltos do corpo escapando da
 * validação por empresa: productId/locationId no movimento de estoque e
 * customerId na venda.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_DATABASE_PATH = ':memory:';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';
delete process.env.ASAAS_WEBHOOK_AUTH_TOKEN;

const { createApp } = await import('../src/app.js');
const { resetDbForTests } = await import('../src/db/database.js');
const { ensureCoreSchema } = await import('../src/db/schema.js');
const { upsertCompany, upsertUser, linkUserToCompany } = await import(
  '../src/services/auth/IdentityService.js'
);

const app = createApp();
const SENHA = 'Auditoria@P0';

let empresaA: string;
let empresaB: string;
let gerenteA: { Authorization: string };
let gerenteB: { Authorization: string };

async function entrar(login: string, companyId: string) {
  const id = await upsertUser({ login, displayName: login, password: SENHA });
  linkUserToCompany(id, companyId, 'gerente_loja', true);
  const res = await request(app)
    .post('/api/v1/auth/login')
    .send({ login, password: SENHA, companyId });
  expect(res.status).toBe(200);
  return { Authorization: `Bearer ${res.body.accessToken}` };
}

async function produtoCom10(auth: { Authorization: string }, nome: string): Promise<string> {
  const p = await request(app).post('/api/v1/core/products').set(auth).send({ name: nome, priceCents: 1000 });
  expect(p.status).toBe(201);
  await request(app)
    .post('/api/v1/core/stock/movements')
    .set(auth)
    .send({ productId: p.body.id, movementType: 'in', quantity: 10, referenceId: `in-${nome}` });
  return String(p.body.id);
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  empresaA = upsertCompany({ slug: 'empresa-a', legalName: 'Empresa A Ltda', tradeName: 'Empresa A' });
  empresaB = upsertCompany({ slug: 'empresa-b', legalName: 'Empresa B Ltda', tradeName: 'Empresa B' });
  gerenteA = await entrar('GER.A', empresaA);
  gerenteB = await entrar('GER.B', empresaB);
});

// ============================================================================

describe('GRAVE 1: a venda não entra na gaveta de outra empresa', () => {
  it('cashSessionId da empresa B é recusado na venda da empresa A', async () => {
    // O caixa aberto é o da B.
    const caixaB = await request(app)
      .post('/api/v1/core/cash/open')
      .set(gerenteB)
      .send({ openingCents: 0 });
    expect([200, 201]).toContain(caixaB.status);
    const sessaoB = String(caixaB.body.id ?? caixaB.body.sessionId ?? caixaB.body.session?.id);

    const produtoA = await produtoCom10(gerenteA, 'Produto A');

    /*
      A venda é da empresa A apontando para a gaveta da B. Antes: 200, e o
      dinheiro aparecia no fechamento da B — um caixa que nunca viu essa
      venda fecharia com sobra inexplicável, e o da A com falta.
    */
    const venda = await request(app)
      .post('/api/v1/core/sales')
      .set(gerenteA)
      .set('Idempotency-Key', 'venda-gaveta-alheia')
      .send({
        cashSessionId: sessaoB,
        items: [{ productId: produtoA, quantity: 1 }],
        payments: [{ method: 'dinheiro', amountCents: 1000 }],
      });

    expect(venda.status).toBe(400);
    expect(String(venda.body?.error?.message ?? '')).toMatch(/caixa/i);
  });

  it('caixa FECHADO também é recusado — venda não entra em gaveta que já bateu', async () => {
    const caixa = await request(app)
      .post('/api/v1/core/cash/open')
      .set(gerenteA)
      .send({ openingCents: 0 });
    const sessao = String(caixa.body.id ?? caixa.body.sessionId ?? caixa.body.session?.id);
    const fecha = await request(app)
      .post('/api/v1/core/cash/' + sessao + '/close')
      .set(gerenteA)
      .send({ countedCents: 0 });
    expect([200, 201]).toContain(fecha.status);

    const produtoA = await produtoCom10(gerenteA, 'Produto A2');
    const venda = await request(app)
      .post('/api/v1/core/sales')
      .set(gerenteA)
      .set('Idempotency-Key', 'venda-gaveta-fechada')
      .send({
        cashSessionId: sessao,
        items: [{ productId: produtoA, quantity: 1 }],
        payments: [{ method: 'dinheiro', amountCents: 1000 }],
      });

    expect(venda.status).toBe(400);
  });

  it('a venda com o caixa CERTO continua passando', async () => {
    const caixa = await request(app)
      .post('/api/v1/core/cash/open')
      .set(gerenteA)
      .send({ openingCents: 0 });
    const sessao = String(caixa.body.id ?? caixa.body.sessionId ?? caixa.body.session?.id);
    const produtoA = await produtoCom10(gerenteA, 'Produto A3');

    const venda = await request(app)
      .post('/api/v1/core/sales')
      .set(gerenteA)
      .set('Idempotency-Key', 'venda-gaveta-certa')
      .send({
        cashSessionId: sessao,
        items: [{ productId: produtoA, quantity: 1 }],
        payments: [{ method: 'dinheiro', amountCents: 1000 }],
      });

    expect([200, 201]).toContain(venda.status);
  });
});

// ============================================================================

describe('GRAVE 2: token de webhook do .env não vale em produção', () => {
  it('em produção, o token do ambiente é ignorado — só o cofre vale', async () => {
    /*
      A MESMA guarda da API key, que o token não tinha. Em produção, o env é
      atalho de desenvolvimento esquecido; aceitar o token global faria o
      evento de QUALQUER empresa validar com o token da primeira que foi
      configurada — exatamente o fallback entre empresas que a regra proíbe.
    */
    const { secretProvider } = await import('../src/secrets/SecretProvider.js');
    const env = await import('../src/config/env.js');
    vi.spyOn(secretProvider, 'getAsaasWebhookToken').mockReturnValue('token-do-env');
    const cfg = env.loadEnv();
    const espiao = vi.spyOn(env, 'loadEnv').mockReturnValue({
      ...cfg,
      DEVORA_API_ENV: 'production',
    } as ReturnType<typeof env.loadEnv>);

    const res = await request(app)
      .post('/api/v1/webhooks/asaas')
      .set('asaas-access-token', 'token-do-env')
      .send({ event: 'PAYMENT_CONFIRMED', id: 'evt-prod-env' });

    // Sem token no cofre e com o env barrado: 503, "nada a conferir".
    expect(res.status).toBe(503);
    espiao.mockRestore();
    vi.restoreAllMocks();
  });

  it('fora de produção o env continua valendo — o caminho de dev não quebra', async () => {
    const { secretProvider } = await import('../src/secrets/SecretProvider.js');
    vi.spyOn(secretProvider, 'getAsaasWebhookToken').mockReturnValue('token-dev');

    const res = await request(app)
      .post('/api/v1/webhooks/asaas')
      .set('asaas-access-token', 'token-dev')
      .send({ event: 'PAYMENT_CONFIRMED', id: 'evt-dev-env' });

    expect(res.status).toBe(200);
    vi.restoreAllMocks();
  });
});

// ============================================================================

describe('ids soltos do corpo não atravessam a fronteira', () => {
  it('movimento de estoque com productId de outra empresa é recusado', async () => {
    const produtoB = await produtoCom10(gerenteB, 'Produto B');

    /*
      Antes: a empresa A criava SALDO-FANTASMA para um produto da B — linha
      de estoque com company_id da A apontando para produto que não é dela.
      Inventário, reposição e relatório passavam a discordar para sempre.
    */
    const res = await request(app)
      .post('/api/v1/core/stock/movements')
      .set(gerenteA)
      .send({ productId: produtoB, movementType: 'in', quantity: 5, referenceId: 'atravessado' });

    expect([400, 404]).toContain(res.status);
  });

  it('venda com customerId de outra empresa é recusada', async () => {
    const clienteB = await request(app)
      .post('/api/v1/core/customers')
      .set(gerenteB)
      .send({ name: 'Cliente da B' });
    expect([200, 201]).toContain(clienteB.status);
    const clienteBId = String(clienteB.body.id);

    const produtoA = await produtoCom10(gerenteA, 'Produto A4');
    const venda = await request(app)
      .post('/api/v1/core/sales')
      .set(gerenteA)
      .set('Idempotency-Key', 'venda-cliente-alheio')
      .send({
        customerId: clienteBId,
        items: [{ productId: produtoA, quantity: 1 }],
        payments: [{ method: 'dinheiro', amountCents: 1000 }],
      });

    // Cliente de outra empresa não vira dono de venda — nem de fiado.
    expect([400, 404]).toContain(venda.status);
  });
});

// ============================================================================

describe('a junção com a oficina carrega a empresa junto', () => {
  it('nenhum SELECT junta core_workshops sem o predicado de empresa', async () => {
    /*
      `searchProducts` filtra o produto certo (`WHERE p.company_id = ?`) e
      trazia o nome da oficina com `LEFT JOIN core_workshops w ON w.id =
      p.workshop_id`, sem dizer de qual empresa. Esse `workshop_name` é
      exatamente o texto que o PDV mostra ao bipar uma peça de bancada — a
      decisão de "vender assim mesmo" era tomada lendo o nome de uma oficina
      que podia ser de outra operação.

      A varredura vale mais que um caso: o mesmo JOIN estava copiado em três
      serviços, e o próximo lugar que precisar do nome da oficina vai copiar
      de novo.
    */
    const { readFileSync, readdirSync } = await import('node:fs');
    const dir = new URL('../src/services/core/', import.meta.url);
    const arquivos = readdirSync(dir).filter((f) => f.endsWith('.ts'));

    let encontrados = 0;
    for (const nome of arquivos) {
      const fonte = readFileSync(new URL(nome, dir), 'utf8');
      for (const juncao of fonte.matchAll(/JOIN\s+core_workshops\s+(\w+)\s+ON([^\n]*)/g)) {
        encontrados += 1;
        const [, alias, condicao] = juncao;
        expect(
          new RegExp(`${alias}\.company_id`).test(condicao),
          `${nome}: junção com core_workshops sem company_id — "${juncao[0].trim()}"`,
        ).toBe(true);
      }
    }
    // Se a varredura parar de achar junções, ela deixou de proteger algo.
    expect(encontrados).toBeGreaterThan(0);
  });
});
