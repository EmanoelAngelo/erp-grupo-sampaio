/**
 * Rotas de configuração do Asaas.
 *
 * O que se cobra aqui é a BORDA: quem pode configurar, de qual operação, e —
 * a parte que não pode falhar nunca — que a chave não volta pela API.
 *
 * A regra fiscal do `companyId` vale igual aqui: vem do token, nunca do corpo.
 * Aceitar do corpo permitiria gravar a credencial de cobrança de outra
 * empresa, ou ler o estado da conta dela.
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
import { getAsaasApiKey } from '../src/services/integrations/AsaasCredentialService.js';
import { upsertAsaasIntegrationState } from '../src/services/integrations/AsaasIntegrationStateService.js';
import { listAudit } from '../src/services/audit/AuditService.js';

const app = createApp();
const SENHA = 'Teste@Asaas2026';
const CHAVE = '$aact_chave_sandbox_de_teste_0000000000';

let gringa: string;
let precoJusto: string;
let gerente: { Authorization: string };
let gerenteVizinho: { Authorization: string };
let caixa: { Authorization: string };

async function ator(login: string, profile: string, company: string) {
  const id = await upsertUser({ login, displayName: login, password: SENHA });
  linkUserToCompany(id, company, profile, true);
  const res = await request(app).post('/api/v1/auth/login').send({ login, password: SENHA });
  expect(res.status).toBe(200);
  return { Authorization: `Bearer ${res.body.accessToken}` };
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  gringa = await upsertCompany({ slug: 'gringa', tradeName: 'Gringa', legalName: 'Gringa Ltda' });
  precoJusto = await upsertCompany({
    slug: 'preco-justo',
    tradeName: 'Preço Justo',
    legalName: 'Preço Justo Ltda',
  });
  gerente = await ator('gerente.gringa', 'gerente_loja', gringa);
  gerenteVizinho = await ator('gerente.pj', 'gerente_loja', precoJusto);
  caixa = await ator('caixa.gringa', 'operador_caixa_loja', gringa);
});

describe('quem pode configurar', () => {
  it('caixa não configura cobrança online', async () => {
    const res = await request(app).get('/api/v1/core/integrations/asaas').set(caixa);

    expect(res.status).toBe(403);
  });

  it('gerente vê o estado da própria operação', async () => {
    const res = await request(app).get('/api/v1/core/integrations/asaas').set(gerente);

    expect(res.status).toBe(200);
    expect(res.body.state.companyId).toBe(gringa);
    expect(res.body.status.environment).toBe('sandbox');
  });
});

describe('a chave não volta', () => {
  it('gravar devolve dica mascarada, nunca a chave', async () => {
    const res = await request(app)
      .put('/api/v1/core/integrations/asaas/credentials')
      .set(gerente)
      .send({ environment: 'sandbox', apiKey: CHAVE });

    expect(res.status).toBe(200);
    expect(res.body.credentials.sandbox.configured).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain(CHAVE);
  });

  it('nem no GET seguinte', async () => {
    await request(app)
      .put('/api/v1/core/integrations/asaas/credentials')
      .set(gerente)
      .send({ environment: 'sandbox', apiKey: CHAVE });

    const res = await request(app).get('/api/v1/core/integrations/asaas').set(gerente);

    expect(JSON.stringify(res.body)).not.toContain(CHAVE);
  });

  it('chave curta demais é recusada antes de chegar ao cofre', async () => {
    const res = await request(app)
      .put('/api/v1/core/integrations/asaas/credentials')
      .set(gerente)
      .send({ environment: 'sandbox', apiKey: 'curta' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CORE_ASAAS_KEY_INVALID');
  });
});

describe('isolamento entre operações', () => {
  it('companyId do corpo é ignorado — vale o do token', async () => {
    await request(app)
      .put('/api/v1/core/integrations/asaas/credentials')
      .set(gerente)
      .send({ environment: 'sandbox', apiKey: CHAVE, companyId: precoJusto });

    // A chave foi para a Gringa, que é a operação do token.
    expect(getAsaasApiKey(gringa, 'sandbox')).toBe(CHAVE);
    // E o vizinho continua sem chave própria no cofre.
    const vizinho = await request(app).get('/api/v1/core/integrations/asaas').set(gerenteVizinho);
    expect(vizinho.body.credentials.sandbox.source).not.toBe('vault');
  });

  it('cada gerente vê a própria operação', async () => {
    const daGringa = await request(app).get('/api/v1/core/integrations/asaas').set(gerente);
    const doPrecoJusto = await request(app)
      .get('/api/v1/core/integrations/asaas')
      .set(gerenteVizinho);

    expect(daGringa.body.state.companyId).toBe(gringa);
    expect(doPrecoJusto.body.state.companyId).toBe(precoJusto);
  });
});

describe('produção é conquistada, não escolhida', () => {
  it('pedir produção devolve o que ainda falta', async () => {
    const res = await request(app)
      .patch('/api/v1/core/integrations/asaas')
      .set(gerente)
      .send({ environment: 'production' });

    expect(res.status).toBe(200);
    expect(res.body.state.environment).toBe('production');
    // Pedido registrado; ambiente efetivo continua sandbox.
    expect(res.body.status.environment).toBe('sandbox');
    expect(res.body.status.productionBlockedBy).toContain('SEM_CREDENCIAL_DE_PRODUCAO');
  });

  it('trocar a credencial derruba conexão verificada e homologação', async () => {
    upsertAsaasIntegrationState(
      { companyId: gringa },
      { connectionVerified: true, sandboxHomologated: true },
    );

    await request(app)
      .put('/api/v1/core/integrations/asaas/credentials')
      .set(gerente)
      .send({ environment: 'sandbox', apiKey: CHAVE });

    const res = await request(app).get('/api/v1/core/integrations/asaas').set(gerente);
    // O selo era da chave ANTERIOR. Mantê-lo diria que a nova já foi testada.
    expect(res.body.state.connectionVerified).toBe(false);
    expect(res.body.state.sandboxHomologated).toBe(false);
  });

  it('remover a credencial também derruba os selos', async () => {
    await request(app)
      .put('/api/v1/core/integrations/asaas/credentials')
      .set(gerente)
      .send({ environment: 'sandbox', apiKey: CHAVE });
    upsertAsaasIntegrationState({ companyId: gringa }, { connectionVerified: true });

    await request(app)
      .delete('/api/v1/core/integrations/asaas/credentials/sandbox')
      .set(gerente);

    const res = await request(app).get('/api/v1/core/integrations/asaas').set(gerente);
    expect(res.body.state.connectionVerified).toBe(false);
  });
});

describe('auditoria', () => {
  it('registra que a credencial foi gravada, sem registrar a credencial', async () => {
    await request(app)
      .put('/api/v1/core/integrations/asaas/credentials')
      .set(gerente)
      .send({ environment: 'sandbox', apiKey: CHAVE });

    const registros = listAudit(gringa).items;
    const entrada = registros.find(
      (i) => (i as { action: string }).action === 'integrations.asaas.credential_saved',
    );

    expect(entrada).toBeDefined();
    expect(JSON.stringify(registros)).not.toContain(CHAVE);
  });
});
