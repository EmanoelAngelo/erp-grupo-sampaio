/**
 * AS TRANCAS DE PRODUÇÃO DO ASAAS NÃO DEPENDEM DA ORDEM, E A CHAVE DE
 * PRODUÇÃO É TESTADA ANTES DE VALER (GAP-PRD-170).
 *
 * ============================================================================
 * OS TRÊS DEFEITOS, MEDIDOS PELA AUDITORIA
 * ============================================================================
 *
 * 1. SALVAR CHAVE ZERAVA SELOS QUE NÃO ERAM DELA. Guardar a chave de
 *    PRODUÇÃO derrubava a conexão testada e a homologação do SANDBOX. O dono
 *    que testou, homologou e pediu produção via, depois de colar a chave de
 *    produção, as travas [CONEXAO_NAO_TESTADA, HOMOLOGACAO_SANDBOX_PENDENTE].
 *
 * 2. HOMOLOGAR DERRUBAVA O PEDIDO DE PRODUÇÃO. O primeiro passo da
 *    homologação (`testAsaasSandboxConnection`) gravava `environment:
 *    'sandbox'`, desfazendo o PATCH environment=production.
 *
 * 3. A CHAVE DE PRODUÇÃO NUNCA ERA TESTADA ANTES DE VALER. O teste de conexão
 *    usava o ambiente EFETIVO — sandbox enquanto a porta estava fechada —, e
 *    o selo que a porta pedia era carimbado pela chave de sandbox. As duas
 *    chamadas a /myAccount iam para sandbox.asaas.com; a primeira cobrança
 *    real era o primeiro teste da chave de produção.
 *
 * ============================================================================
 * O CONSERTO
 * ============================================================================
 *
 * Um selo por ambiente (`connectionVerified` do sandbox,
 * `productionConnectionVerified` da produção), guardar/remover chave derruba
 * só o do próprio ambiente, a homologação não toca o ambiente pedido, e o
 * teste de conexão testa CADA chave no próprio ambiente — a de produção em
 * api.asaas.com, e só com ASAAS_PRODUCTION_ENABLED.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

process.env.DEVORA_API_ENV = 'test';

const { createApp } = await import('../src/app.js');
const { resetDbForTests } = await import('../src/db/database.js');
const { ensureCoreSchema } = await import('../src/db/schema.js');
const { resetEnvCacheForTests } = await import('../src/config/env.js');
const { upsertCompany, upsertUser, linkUserToCompany } = await import('../src/services/auth/IdentityService.js');
const { upsertAsaasIntegrationState, getAsaasIntegrationState } = await import(
  '../src/services/integrations/AsaasIntegrationStateService.js'
);
const { testAsaasSandboxConnection } = await import('../src/services/integrations/AsaasHomologationService.js');

const app = createApp();
const SENHA = 'Teste@Trancas2026';
const CHAVE_SANDBOX = '$aact_hmlg_chave_de_teste_sandbox_000000';
const CHAVE_PRODUCAO = '$aact_prod_chave_de_teste_producao_00000';

let gringa: string;
let gerente: { Authorization: string };
let chamadas: { url: string; chave: string | undefined }[];
let producaoRecusa: boolean;

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  process.env.ASAAS_ENABLED = 'true';
  process.env.ASAAS_PRODUCTION_ENABLED = 'true';
  resetEnvCacheForTests();
  gringa = upsertCompany({ slug: 'gringa', tradeName: 'Gringa', legalName: 'Gringa Ltda' });
  const id = await upsertUser({ login: 'gerente.trancas', displayName: 'Gerente', password: SENHA });
  linkUserToCompany(id, gringa, 'gerente_loja', true);
  const res = await request(app).post('/api/v1/auth/login').send({ login: 'gerente.trancas', password: SENHA });
  gerente = { Authorization: `Bearer ${res.body.accessToken}` };

  chamadas = [];
  producaoRecusa = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
      const alvo = String(url);
      const chave = init?.headers?.access_token;
      chamadas.push({ url: alvo, chave });
      if (alvo.startsWith('https://api.asaas.com') && producaoRecusa) {
        return new Response(JSON.stringify({ errors: [{ description: 'Chave inválida' }] }), { status: 401 });
      }
      return new Response(JSON.stringify({ balance: 0, name: 'Conta de teste' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ASAAS_ENABLED;
  delete process.env.ASAAS_PRODUCTION_ENABLED;
  resetEnvCacheForTests();
});

async function guardar(environment: 'sandbox' | 'production', apiKey: string) {
  const res = await request(app)
    .put('/api/v1/core/integrations/asaas/credentials')
    .set(gerente)
    .send({ environment, apiKey });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

async function travas(): Promise<{ environment: string; blocked: string[] }> {
  const res = await request(app).get('/api/v1/core/integrations/asaas').set(gerente);
  return { environment: res.body.status.environment, blocked: res.body.status.productionBlockedBy };
}

describe('GAP-PRD-170 — guardar a chave de produção não derruba o que era do sandbox', () => {
  it('testou, homologou, pediu produção, guardou a chave de produção: só falta TESTAR a de produção', async () => {
    await guardar('sandbox', CHAVE_SANDBOX);
    const teste = await request(app).post('/api/v1/core/integrations/asaas/test').set(gerente).send({});
    expect(teste.body.ok, JSON.stringify(teste.body)).toBe(true);
    // A homologação é encenada: o que se mede aqui é o que a chave de produção derruba.
    upsertAsaasIntegrationState({ companyId: gringa }, { sandboxHomologated: true });
    await request(app).patch('/api/v1/core/integrations/asaas').set(gerente).send({ environment: 'production' });

    await guardar('production', CHAVE_PRODUCAO);

    const estado = getAsaasIntegrationState({ companyId: gringa });
    expect(estado.connectionVerified).toBe(true);
    expect(estado.sandboxHomologated).toBe(true);
    const t = await travas();
    // Antes: [CONEXAO_NAO_TESTADA, HOMOLOGACAO_SANDBOX_PENDENTE] — dois selos do sandbox perdidos.
    expect(t.blocked).toEqual(['CREDENCIAL_DE_PRODUCAO_NAO_TESTADA']);
    expect(t.environment).toBe('sandbox');
  });

  it('trocar a chave de SANDBOX derruba os selos do sandbox (eram dela), e não o da produção', async () => {
    upsertAsaasIntegrationState(
      { companyId: gringa },
      { connectionVerified: true, sandboxHomologated: true, productionConnectionVerified: true },
    );
    await guardar('sandbox', CHAVE_SANDBOX);
    const estado = getAsaasIntegrationState({ companyId: gringa });
    expect(estado.connectionVerified).toBe(false);
    expect(estado.sandboxHomologated).toBe(false);
    expect(estado.productionConnectionVerified).toBe(true);
  });

  it('remover a chave de produção derruba só o selo da produção', async () => {
    await guardar('production', CHAVE_PRODUCAO);
    upsertAsaasIntegrationState(
      { companyId: gringa },
      { connectionVerified: true, sandboxHomologated: true, productionConnectionVerified: true },
    );
    await request(app).delete('/api/v1/core/integrations/asaas/credentials/production').set(gerente);
    const estado = getAsaasIntegrationState({ companyId: gringa });
    expect(estado.productionConnectionVerified).toBe(false);
    expect(estado.sandboxHomologated).toBe(true);
  });
});

describe('GAP-PRD-170 — a homologação não desfaz o pedido de produção', () => {
  it('o teste do sandbox (primeiro passo da homologação) não grava environment', async () => {
    await guardar('sandbox', CHAVE_SANDBOX);
    await request(app).patch('/api/v1/core/integrations/asaas').set(gerente).send({ environment: 'production' });

    const r = await testAsaasSandboxConnection({ companyId: gringa });
    expect(r.ok).toBe(true);

    expect(getAsaasIntegrationState({ companyId: gringa }).environment).toBe('production');
    expect((await travas()).blocked).not.toContain('CONFIGURACAO_EM_SANDBOX');
  });
});

describe('GAP-PRD-170 — a chave de produção é testada em api.asaas.com antes de valer', () => {
  it('o teste vai às duas contas, cada uma com a própria chave, e a porta abre', async () => {
    await guardar('sandbox', CHAVE_SANDBOX);
    await guardar('production', CHAVE_PRODUCAO);
    upsertAsaasIntegrationState({ companyId: gringa }, { sandboxHomologated: true, environment: 'production' });

    const res = await request(app).post('/api/v1/core/integrations/asaas/test').set(gerente).send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const producao = chamadas.find((c) => c.url.startsWith('https://api.asaas.com'));
    const sandbox = chamadas.find((c) => c.url.startsWith('https://sandbox.asaas.com'));
    // Antes: as duas chamadas a /myAccount iam para o sandbox.
    expect(producao?.url).toBe('https://api.asaas.com/api/v3/myAccount');
    expect(producao?.chave).toBe(CHAVE_PRODUCAO);
    expect(sandbox?.chave).toBe(CHAVE_SANDBOX);

    const t = await travas();
    expect(t.blocked).toEqual([]);
    expect(t.environment).toBe('production');
    expect(JSON.stringify(res.body)).not.toContain(CHAVE_PRODUCAO);
  });

  it('chave de produção recusada: o selo fica fechado e a frase diz qual chave', async () => {
    await guardar('production', CHAVE_PRODUCAO);
    upsertAsaasIntegrationState({ companyId: gringa }, { sandboxHomologated: true, environment: 'production' });
    producaoRecusa = true;

    const res = await request(app)
      .post('/api/v1/core/integrations/asaas/test')
      .set(gerente)
      .send({ environment: 'production' });
    expect(res.body.ok).toBe(false);
    expect(res.body.detail).toContain('Produção: O Asaas recusou a credencial');
    expect(getAsaasIntegrationState({ companyId: gringa }).productionConnectionVerified).toBe(false);
    expect((await travas()).blocked).toContain('CREDENCIAL_DE_PRODUCAO_NAO_TESTADA');
  });

  it('com produção desligada no processo, a chave de produção NÃO é chamada — e isso é dito', async () => {
    process.env.ASAAS_PRODUCTION_ENABLED = 'false';
    resetEnvCacheForTests();
    await guardar('production', CHAVE_PRODUCAO);

    const res = await request(app)
      .post('/api/v1/core/integrations/asaas/test')
      .set(gerente)
      .send({ environment: 'production' });
    expect(res.body.ok).toBe(false);
    expect(res.body.results[0]).toMatchObject({ environment: 'production', tested: false });
    expect(res.body.detail).toContain('ASAAS_PRODUCTION_ENABLED');
    expect(chamadas.some((c) => c.url.startsWith('https://api.asaas.com'))).toBe(false);
    expect(getAsaasIntegrationState({ companyId: gringa }).productionConnectionVerified).toBeFalsy();
  });

  it('o selo da produção não é carimbado pelo teste do sandbox', async () => {
    await guardar('sandbox', CHAVE_SANDBOX);
    await guardar('production', CHAVE_PRODUCAO);
    const res = await request(app)
      .post('/api/v1/core/integrations/asaas/test')
      .set(gerente)
      .send({ environment: 'sandbox' });
    expect(res.body.ok).toBe(true);
    const estado = getAsaasIntegrationState({ companyId: gringa });
    expect(estado.connectionVerified).toBe(true);
    expect(estado.productionConnectionVerified).toBeFalsy();
  });
});
