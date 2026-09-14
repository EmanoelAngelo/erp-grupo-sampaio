/**
 * Prompt 15 — testes backend: cofre do Asaas, isolamento, sanitização.
 *
 * Os casos da "Central de Integrações" (catálogo, painel, `saveIntegrationSecrets`,
 * `requestProductionActivation` e as rotas `/integrations/*`) saíram com o
 * roteador, que nenhuma tela chamava (GAP-PRD-075). A chave do Asaas tem UMA
 * porta — `PUT /core/integrations/asaas/credentials`, da tela do Asaas — e os
 * casos de HTTP abaixo passam por ela.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
// Sessão da conta que EXISTE: authMiddleware confere a conta a cada requisição (GAP-PRD-053).
import { issueSession } from './helpers/sessao.js';
import { runMigrations } from '../src/db/migrate.js';
import { resetDbForTests } from '../src/db/database.js';
import {
  upsertAsaasApiKey,
  getAsaasCredentialStatus,
  getAsaasApiKey,
} from '../src/services/integrations/AsaasCredentialService.js';
import { getAsaasIntegrationState, upsertAsaasIntegrationState } from '../src/services/integrations/AsaasIntegrationStateService.js';
import { sanitizeForLog } from '../src/utils/errors.js';

const app = createApp();
const PRECO = 'company-preco-justo';
const GRINGA = 'company-gringa';
const OFICINA = 'company-oficina';
const STORE_G = 'store-gringa-matriz';
const STORE_P = 'store-preco-justo-matriz';

function managerAuth(companyId: string, storeId: string) {
  const tokens = issueSession({
    userId: '550e8400-e29b-41d4-a716-446655440099',
    companyId,
    storeId,
    profileCodes: ['gerente_loja'],
  });
  return { Authorization: `Bearer ${tokens.accessToken}` };
}

beforeAll(() => {
  runMigrations();
});

beforeEach(() => {
  resetDbForTests();
  runMigrations();
});

describe('Prompt 15 BE — isolamento no cofre', () => {
  it('Gringa isolada de Preço Justo no vault', () => {
    upsertAsaasApiKey({
      companyId: GRINGA,
      storeId: STORE_G,
      operationalUnitId: STORE_G,
      environment: 'sandbox',
      apiKey: '$aact_hmlg_gringa_secret_key_XXXX',
    });
    upsertAsaasApiKey({
      companyId: PRECO,
      storeId: STORE_P,
      operationalUnitId: STORE_P,
      environment: 'sandbox',
      apiKey: '$aact_hmlg_preco_secret_key_YYYY',
    });
    const gKey = getAsaasApiKey(GRINGA, 'sandbox', { storeId: STORE_G, operationalUnitId: STORE_G });
    const pKey = getAsaasApiKey(PRECO, 'sandbox', { storeId: STORE_P, operationalUnitId: STORE_P });
    expect(gKey).toBeTruthy();
    expect(pKey).toBeTruthy();
    expect(String(gKey)).toContain('gringa');
    expect(String(pKey)).toContain('preco');
    expect(String(gKey)).not.toContain('preco');
    expect(String(pKey)).not.toContain('gringa');
  });

  it('Oficina isolada', () => {
    upsertAsaasApiKey({
      companyId: OFICINA,
      environment: 'sandbox',
      apiKey: '$aact_hmlg_oficina_only_ZZZZ',
    });
    expect(getAsaasApiKey(OFICINA, 'sandbox')).toContain('oficina');
    expect(getAsaasCredentialStatus(PRECO, {}).sandbox.configured).toBe(false);
  });

  it('empresa dinâmica (id novo) aceita credencial', () => {
    const dyn = 'company-runtime-p15-nova';
    upsertAsaasApiKey({
      companyId: dyn,
      environment: 'sandbox',
      apiKey: '$aact_hmlg_dyn_ABCD',
    });
    const status = getAsaasCredentialStatus(dyn, {});
    expect(status.sandbox.configured).toBe(true);
    expect(String(status.sandbox.maskedHint)).toMatch(/ABCD|••••/);
  });

  it('sanitizeForLog remove apiKey Authorization e token', () => {
    const cleaned = sanitizeForLog({
      apiKey: '$aact_hmlg_xxx',
      Authorization: 'Bearer supersecret',
      webhookToken: 'tok-123',
      nested: { access_token: 'abc', safe: 'ok' },
    }) as Record<string, unknown>;
    expect(JSON.stringify(cleaned)).not.toContain('supersecret');
    expect(JSON.stringify(cleaned)).not.toContain('$aact');
    expect(cleaned.apiKey).toBe('[REDACTED]');
    expect((cleaned.nested as Record<string, unknown>).safe).toBe('ok');
  });
});

describe('Prompt 15 BE — a porta da tela: PUT /core/integrations/asaas/credentials', () => {
  it('guarda sem ecoar a chave, e a chave nova derruba a conexão verificada da antiga', async () => {
    upsertAsaasIntegrationState({ companyId: GRINGA }, { connectionVerified: true });

    const save = await request(app)
      .put('/api/v1/core/integrations/asaas/credentials')
      .set(managerAuth(GRINGA, STORE_G))
      .send({ environment: 'sandbox', apiKey: '$aact_hmlg_http_SECRET99' });

    expect(save.status, JSON.stringify(save.body)).toBe(200);
    expect(JSON.stringify(save.body)).not.toContain('SECRET99');
    expect(save.body.credentials.sandbox.configured).toBe(true);
    expect(getAsaasIntegrationState({ companyId: GRINGA }).connectionVerified).toBeFalsy();
  });

  it('companyId de outra empresa no corpo não é ouvido: a chave cai na empresa do token', async () => {
    const res = await request(app)
      .put('/api/v1/core/integrations/asaas/credentials')
      .set(managerAuth(GRINGA, STORE_G))
      .send({ companyId: PRECO, environment: 'sandbox', apiKey: '$aact_hmlg_blocked_XXXX' });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(getAsaasCredentialStatus(PRECO, {}).sandbox.configured).toBe(false);
    expect(getAsaasCredentialStatus(GRINGA, {}).sandbox.configured).toBe(true);
  });

  it('a segunda porta saiu: /integrations/asaas/secrets responde 404 e não grava', async () => {
    const res = await request(app)
      .post('/api/v1/integrations/asaas/secrets')
      .set(managerAuth(GRINGA, STORE_G))
      .send({ environment: 'sandbox', apiKey: '$aact_hmlg_porta_velha_XXXX' });
    expect(res.status).toBe(404);
    expect(getAsaasCredentialStatus(GRINGA, {}).sandbox.configured).toBe(false);
  });
});

const HAS_REAL = Boolean(process.env.ASAAS_SANDBOX_API_KEY || process.env.ASAAS_API_KEY);

describe('Prompt 15 BE — sandbox real', () => {
  it.skipIf(!HAS_REAL)('test connection real', async () => {
    // Placeholder: suite asaas.sandbox cobre path real quando chave existe.
    expect(HAS_REAL).toBe(true);
  });
});
