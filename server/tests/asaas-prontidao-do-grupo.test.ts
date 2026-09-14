/**
 * O QUE CADA OPERAÇÃO AINDA PRECISA PARA COBRAR PELO ASAAS (GAP-PRD-017).
 *
 * A auditoria provou que nenhuma linha de código falta para as cinco
 * operações sem credencial cobrarem: basta cadastrar chave e token de cada
 * uma. O que faltava era ENXERGAR, num lugar só, o que cada operação ainda
 * precisa — a tela do Asaas é por operação, e o dono trocava de empresa seis
 * vezes. Este arquivo cobra a leitura do grupo:
 *
 *   - só as operações a que a pessoa está vinculada;
 *   - para cada uma, o que falta, separado entre insumo externo (credencial,
 *     cadastro no painel do Asaas, configuração do servidor) e ação na tela;
 *   - operação com tudo em ordem aparece pronta, e sem nada faltando;
 *   - nenhum segredo sai na resposta;
 *   - só os donos do grupo leem.
 *
 * E a prova de que a credencial é o ÚNICO insumo: com a chave e o token da
 * Gringa guardados pela tela, a cobrança de um título dela nasce no provedor
 * sem nenhuma outra mudança.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

process.env.DEVORA_API_ENV = 'test';

const { createApp } = await import('../src/app.js');
const { resetDbForTests } = await import('../src/db/database.js');
const { ensureCoreSchema } = await import('../src/db/schema.js');
const { getConnection } = await import('../src/db/sqlite.js');
const { resetEnvCacheForTests } = await import('../src/config/env.js');
const { upsertCompany, upsertUser, linkUserToCompany } = await import('../src/services/auth/IdentityService.js');
const { upsertAsaasApiKey, upsertAsaasWebhookToken } = await import(
  '../src/services/integrations/AsaasCredentialService.js'
);
const { upsertAsaasIntegrationState } = await import('../src/services/integrations/AsaasIntegrationStateService.js');

const app = createApp();
const SENHA = 'Teste@Prontidao017';
const CHAVE_PJ = '$aact_hmlg_chave_do_preco_justo_0000000';
const CHAVE_PJ_PROD = '$aact_prod_chave_do_preco_justo_0000000';
const CHAVE_GRINGA = '$aact_hmlg_chave_da_gringa_00000000000';

let precoJusto: string;
let gringa: string;
let alheia: string;
let dono: { Authorization: string };

async function entrar(login: string, perfil: string, empresas: string[]) {
  const id = await upsertUser({ login, displayName: login, password: SENHA });
  for (const e of empresas) linkUserToCompany(id, e, perfil, e === empresas[0]);
  const res = await request(app).post('/api/v1/auth/login').send({ login, password: SENHA, companyId: empresas[0] });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { Authorization: `Bearer ${res.body.accessToken}` };
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  process.env.ASAAS_ENABLED = 'true';
  process.env.ASAAS_PRODUCTION_ENABLED = 'true';
  process.env.GRUPO_SAMPAIO_PUBLIC_URL = 'https://erp.exemplo.com.br';
  resetEnvCacheForTests();
  precoJusto = upsertCompany({ slug: 'preco-justo', tradeName: 'Preço Justo', legalName: 'Preço Justo Ltda' });
  gringa = upsertCompany({ slug: 'gringa', tradeName: 'Gringa', legalName: 'Gringa Ltda' });
  alheia = upsertCompany({ slug: 'de-fora', tradeName: 'De Fora', legalName: 'De Fora Ltda' });
  dono = await entrar('dono.grupo', 'gestor', [precoJusto, gringa]);

  // O Preço Justo com tudo em ordem.
  upsertAsaasApiKey({ companyId: precoJusto, environment: 'sandbox', apiKey: CHAVE_PJ });
  upsertAsaasApiKey({ companyId: precoJusto, environment: 'production', apiKey: CHAVE_PJ_PROD });
  upsertAsaasWebhookToken({ companyId: precoJusto, webhookToken: 'token-pj-123456' });
  upsertAsaasIntegrationState(
    { companyId: precoJusto },
    {
      environment: 'production',
      connectionVerified: true,
      sandboxHomologated: true,
      productionConnectionVerified: true,
      productionConnectionTestedAt: new Date().toISOString(),
    },
  );
  getConnection()
    .prepare(
      `INSERT INTO core_payment_webhooks (id, provider, event_id, event_type, payload, processed, received_at, company_id)
       VALUES ('w1', 'asaas', 'evt_1', 'PAYMENT_CREATED', '{}', 1, ?, ?)`,
    )
    .run(new Date().toISOString(), precoJusto);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ASAAS_ENABLED;
  delete process.env.ASAAS_PRODUCTION_ENABLED;
  delete process.env.GRUPO_SAMPAIO_PUBLIC_URL;
  resetEnvCacheForTests();
});

async function grupo() {
  const res = await request(app).get('/api/v1/core/integrations/asaas/grupo').set(dono);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as {
    total: number;
    readyForProduction: number;
    operations: {
      companyId: string;
      tradeName: string;
      canChargeProduction: boolean;
      canChargeSandbox: boolean;
      missing: { codigo: string; tipo: string; quem: string }[];
    }[];
  };
}

describe('GAP-PRD-017 — o que cada operação ainda precisa, num lugar só', () => {
  it('só as operações do vínculo; a pronta não tem nada faltando', async () => {
    const g = await grupo();
    expect(g.operations.map((o) => o.tradeName)).toEqual(['Gringa', 'Preço Justo']);
    expect(g.operations.some((o) => o.companyId === alheia)).toBe(false);

    const pj = g.operations.find((o) => o.companyId === precoJusto)!;
    expect(pj.canChargeProduction).toBe(true);
    expect(pj.missing).toEqual([]);
    expect(g.readyForProduction).toBe(1);
  });

  it('a operação sem nada diz o que falta — e é tudo insumo ou ação, nenhum código', async () => {
    const g = await grupo();
    const gr = g.operations.find((o) => o.companyId === gringa)!;
    expect(gr.canChargeSandbox).toBe(false);
    expect(gr.missing.map((m) => m.codigo)).toEqual([
      'CHAVE_SANDBOX',
      'TOKEN_WEBHOOK',
      'URL_NO_PAINEL',
      'HOMOLOGACAO',
      'CHAVE_PRODUCAO',
      'PEDIDO_PRODUCAO',
    ]);
    expect(new Set(gr.missing.map((m) => m.tipo))).toEqual(
      new Set(['credencial', 'cadastro_no_asaas', 'acao_na_tela']),
    );
  });

  it('o que é do servidor é nomeado como da instalação', async () => {
    delete process.env.GRUPO_SAMPAIO_PUBLIC_URL;
    process.env.ASAAS_PRODUCTION_ENABLED = 'false';
    resetEnvCacheForTests();
    const g = await grupo();
    const pj = g.operations.find((o) => o.companyId === precoJusto)!;
    const doServidor = pj.missing.filter((m) => m.quem === 'instalacao').map((m) => m.codigo);
    expect(doServidor).toEqual(['ENDERECO_PUBLICO', 'PRODUCAO_NO_SERVIDOR']);
    expect(pj.canChargeProduction).toBe(false);
  });

  it('nenhum segredo sai na resposta', async () => {
    const res = await request(app).get('/api/v1/core/integrations/asaas/grupo').set(dono);
    const corpo = JSON.stringify(res.body);
    expect(corpo).not.toContain(CHAVE_PJ);
    expect(corpo).not.toContain(CHAVE_PJ_PROD);
    expect(corpo).not.toContain('token-pj-123456');
  });

  it('só os donos do grupo leem — o gerente da loja, não', async () => {
    const gerente = await entrar('gerente.gringa', 'gerente_loja', [gringa]);
    const res = await request(app).get('/api/v1/core/integrations/asaas/grupo').set(gerente);
    expect(res.status).toBe(403);
  });
});

describe('GAP-PRD-017 — a credencial é o único insumo', () => {
  it('guardada a chave da Gringa pela tela, o título dela é cobrado no provedor sem mais nada', async () => {
    const gerente = await entrar('gerente.gringa2', 'gerente_loja', [gringa]);
    const antes = await request(app)
      .post('/api/v1/core/finance/entries')
      .set(gerente)
      .send({ direction: 'in', description: 'Aluguel', amountCents: 5000, dueDate: '2026-12-10' });
    expect(antes.status, JSON.stringify(antes.body)).toBe(201);

    const chamadas: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { method?: string }) => {
        const caminho = new URL(String(url)).pathname.replace('/api/v3', '');
        chamadas.push(`${init?.method ?? 'GET'} ${caminho}`);
        const corpo =
          caminho === '/customers' ? { id: 'cus_g1' }
            : caminho === '/payments' ? { id: 'pay_g1', status: 'PENDING', invoiceUrl: 'https://sandbox.asaas.com/i/1' }
              : caminho.endsWith('/pixQrCode') ? { payload: '0002', encodedImage: 'x' }
                : { data: [] };
        return new Response(JSON.stringify(corpo), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }),
    );

    // Sem a chave: a recusa declarada de sempre.
    const cliente = await request(app)
      .post('/api/v1/core/customers')
      .set(gerente)
      .send({ name: 'Cliente da Gringa', document: '24971563792' });
    expect(cliente.status, JSON.stringify(cliente.body)).toBe(201);
    getConnection()
      .prepare('UPDATE core_finance_entries SET customer_id = ? WHERE id = ?')
      .run(cliente.body.id, antes.body.id);

    const semChave = await request(app)
      .post(`/api/v1/core/finance/entries/${antes.body.id}/charge`)
      .set(gerente)
      .send({ method: 'pix' });
    expect(semChave.body.error?.code ?? semChave.body.code).toBe('CORE_ASAAS_UNCONFIGURED');

    // O insumo: a chave e o token, pela rota da tela.
    await request(app)
      .put('/api/v1/core/integrations/asaas/credentials')
      .set(gerente)
      .send({ environment: 'sandbox', apiKey: CHAVE_GRINGA });
    await request(app)
      .put('/api/v1/core/integrations/asaas/webhook-token')
      .set(gerente)
      .send({ webhookToken: 'token-da-gringa-987' });

    const comChave = await request(app)
      .post(`/api/v1/core/finance/entries/${antes.body.id}/charge`)
      .set(gerente)
      .send({ method: 'pix' });
    expect(comChave.status, JSON.stringify(comChave.body)).toBeLessThan(300);
    expect(chamadas).toContain('POST /payments');
  });
});
