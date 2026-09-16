/**
 * ============================================================================
 * A CHAVE DO `.env` NÃO VIRA "CREDENCIAL DESTA OPERAÇÃO" NA TELA
 * ============================================================================
 *
 * ## O DEFEITO
 *
 * `getAsaasApiKey` — a função que ENTREGA a chave para cobrar — recusa duas
 * coisas: a chave de PRODUÇÃO do `.env` (sempre, porque não há como saber de
 * quem ela é, e o custo de adivinhar é dinheiro na conta de outro CNPJ) e a de
 * sandbox quando o processo é de produção.
 *
 * `getAsaasCredentialStatus` — a função que a TELA lê — não tinha nenhuma das
 * duas guardas: perguntava ao `.env` "existe a variável?" e dizia
 * "configurada".
 *
 * Numa instalação com `ASAAS_PRODUCTION_ENABLED=true` e a chave de produção no
 * `.env` (é o caso do `.env` desta bancada, como `tests/setup.ts` registra),
 * o resultado era:
 *
 *   - Integrações › Asaas dizia "Produção: configurada", com a dica mascarada
 *     de uma chave que não é da operação;
 *   - "Testar conexão" escolhe os ambientes a testar POR ESSE `configured`:
 *     entrava no de produção, `testAsaasCredential` respondia "Nenhuma API key
 *     de produção configurada para esta operação", e o botão ficava vermelho
 *     mesmo com o sandbox verde.
 *
 * Duas afirmações do mesmo servidor sobre a mesma chave, uma negando a outra,
 * no dia da implantação — e a segunda escondendo o resultado do teste que
 * realmente importava.
 *
 * ## A REGRA
 *
 * Chave de ambiente que o servidor RECUSA não é "configurada". A tela e a
 * cobrança leem a mesma régua.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

process.env.DEVORA_API_ENV = 'test';

const { createApp } = await import('../src/app.js');
const { resetDbForTests } = await import('../src/db/database.js');
const { ensureCoreSchema } = await import('../src/db/schema.js');
const envModule = await import('../src/config/env.js');
const { upsertCompany, upsertUser, linkUserToCompany } = await import('../src/services/auth/IdentityService.js');
const { getAsaasApiKey, getAsaasCredentialStatus } = await import(
  '../src/services/integrations/AsaasCredentialService.js'
);

const app = createApp();
const SENHA = 'Teste@EnvChave2026';
/** Valores fictícios: nenhuma credencial real entra em teste. */
const CHAVE_SANDBOX_DO_ENV = '$aact_hmlg_do_env_de_outra_conta_SAND';
const CHAVE_PRODUCAO_DO_ENV = '$aact_prod_do_env_de_outro_cnpj_9Z7Q';
const CHAVE_SANDBOX_DA_OPERACAO = '$aact_hmlg_chave_desta_operacao_0001';

let precoJusto: string;
let gerente: { Authorization: string };
let chamadas: string[];

/** Simula o processo em produção pelo `DEVORA_API_ENV` (o `loadEnv` guarda cache). */
function emProducao() {
  const cfg = envModule.loadEnv();
  return vi.spyOn(envModule, 'loadEnv').mockReturnValue({
    ...cfg,
    DEVORA_API_ENV: 'production',
  } as ReturnType<typeof envModule.loadEnv>);
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();

  // O `.env` da instalação: as duas chaves presentes e a produção ligada.
  process.env.ASAAS_ENABLED = 'true';
  process.env.ASAAS_PRODUCTION_ENABLED = 'true';
  process.env.ASAAS_API_KEY = CHAVE_SANDBOX_DO_ENV;
  process.env.ASAAS_PRODUCTION_API_KEY = CHAVE_PRODUCAO_DO_ENV;
  envModule.resetEnvCacheForTests();

  precoJusto = upsertCompany({
    slug: 'preco-justo-env',
    tradeName: 'Preço Justo',
    legalName: 'Preço Justo Ltda',
  });
  const id = await upsertUser({ login: 'gerente.env', displayName: 'Gerente', password: SENHA });
  linkUserToCompany(id, precoJusto, 'gerente_loja', true);
  const res = await request(app).post('/api/v1/auth/login').send({ login: 'gerente.env', password: SENHA });
  gerente = { Authorization: `Bearer ${res.body.accessToken}` };

  // Nenhuma chamada sai deste processo: o dublê responde /myAccount.
  chamadas = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      chamadas.push(String(url));
      return new Response(JSON.stringify({ name: 'Conta de teste' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.ASAAS_ENABLED;
  delete process.env.ASAAS_PRODUCTION_ENABLED;
  delete process.env.ASAAS_API_KEY;
  delete process.env.ASAAS_PRODUCTION_API_KEY;
  envModule.resetEnvCacheForTests();
});

describe('a chave de produção do .env não é credencial de operação nenhuma', () => {
  it('o status lido pela tela diz o mesmo que quem entrega a chave: não há', () => {
    // Quem cobra já recusava…
    expect(getAsaasApiKey(precoJusto, 'production')).toBeNull();
    // …e agora a tela diz a mesma coisa.
    expect(getAsaasCredentialStatus(precoJusto).production).toMatchObject({
      configured: false,
      source: 'none',
    });
  });

  it('a tela de Integrações não mostra sequer a dica mascarada dela', async () => {
    const res = await request(app).get('/api/v1/core/integrations/asaas').set(gerente);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.credentials.production.configured).toBe(false);
    // Os quatro últimos caracteres da chave de produção do `.env` não saem daqui.
    expect(JSON.stringify(res.body)).not.toContain(CHAVE_PRODUCAO_DO_ENV.slice(-4));
  });

  it('"Testar conexão" não fica vermelho por uma chave que o servidor recusa', async () => {
    await request(app)
      .put('/api/v1/core/integrations/asaas/credentials')
      .set(gerente)
      .send({ environment: 'sandbox', apiKey: CHAVE_SANDBOX_DA_OPERACAO })
      .expect(200);

    const teste = await request(app).post('/api/v1/core/integrations/asaas/test').set(gerente).send({});

    expect(teste.status, JSON.stringify(teste.body)).toBe(200);
    // Antes: `ok: false`, porque o ambiente de produção entrava na lista pelo
    // `configured` fantasma e voltava `tested: false`.
    expect(teste.body.ok, JSON.stringify(teste.body)).toBe(true);
    expect(teste.body.results.map((r: { environment: string }) => r.environment)).toEqual(['sandbox']);
    // E nenhuma chamada foi para a produção do provedor.
    expect(chamadas.some((u) => u.startsWith('https://api.asaas.com'))).toBe(false);
  });
});

describe('em servidor de produção, o atalho do sandbox também deixa de contar', () => {
  it('a chave de sandbox do .env não é "configurada" quando o processo é de produção', () => {
    expect(getAsaasCredentialStatus(precoJusto).sandbox).toMatchObject({
      configured: true,
      source: 'env',
    });

    emProducao();

    expect(getAsaasApiKey(precoJusto, 'sandbox')).toBeNull();
    expect(getAsaasCredentialStatus(precoJusto).sandbox).toMatchObject({
      configured: false,
      source: 'none',
    });
  });
});
