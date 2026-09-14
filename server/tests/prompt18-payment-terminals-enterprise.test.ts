/**
 * Prompt 18 — backend maquininhas: cofre da credencial e agente local.
 *
 * O catálogo, o painel, `testIntegrationConnection`, `runIntegrationHomologation`
 * e `requestProductionActivation` saíram com o roteador `/integrations`, que
 * nenhuma tela chamava (GAP-PRD-075). A credencial da maquininha tem UMA
 * porta — `POST /payment-terminals/credentials`, da tela Configurações ›
 * Maquininhas — e o teste de conexão é o do adaptador
 * (`testPaymentTerminalConnection`).
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
// Sessão da conta que EXISTE: authMiddleware confere a conta a cada requisição (GAP-PRD-053).
import { issueSession } from './helpers/sessao.js';
import { runMigrations } from '../src/db/migrate.js';
import { resetDbForTests } from '../src/db/database.js';
import { upsertPaymentTerminalCredentials } from '../src/services/payment-terminal/PaymentTerminalCredentialService.js';
import { testPaymentTerminalConnection } from '../src/services/payment-terminal/PaymentTerminalProviderAdapter.js';
import {
  createLocalAgentPairingCode,
  confirmLocalAgentPairing,
  getLocalAgentStatusDetailed,
  assertLocalAgentContract,
} from '../src/services/payment-terminal/PaymentTerminalLocalAgentService.js';
import { sanitizeForLog } from '../src/utils/errors.js';

const app = createApp();
const GRINGA = 'company-gringa';
const STORE_G = 'store-gringa-matriz';

function adminAuth(companyId: string, storeId: string) {
  const tokens = issueSession({
    userId: '550e8400-e29b-41d4-a716-446655440005',
    companyId,
    storeId,
    profileCodes: ['admin_geral'],
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

describe('Prompt 18 BE — cofre / teste / agente', () => {
  it('credencial mascara secret', () => {
    const row = upsertPaymentTerminalCredentials({
      companyId: GRINGA,
      storeId: STORE_G,
      provider: 'stone',
      credentials: { accessToken: 'stone-secret-xyz', merchantId: 'm1' },
    });
    expect(JSON.stringify(sanitizeForLog(row))).not.toContain('stone-secret-xyz');
  });

  it('teste do adaptador sem SDK real não se passa por real', async () => {
    upsertPaymentTerminalCredentials({
      companyId: GRINGA,
      storeId: STORE_G,
      provider: 'cielo',
      credentials: { merchantKey: 'key', merchantId: 'mid' },
    });
    const result = await testPaymentTerminalConnection(GRINGA, 'cielo', STORE_G);
    expect(result.real).toBeFalsy();
  });

  it('Local Agent pairing expira e contratos tipados', () => {
    expect(() => assertLocalAgentContract('rm -rf /')).toThrow(/não permitido|DENIED/i);
    expect(assertLocalAgentContract('health')).toBe('health');

    const pair = createLocalAgentPairingCode({ companyId: GRINGA, storeId: STORE_G });
    expect(pair.pairingCode).toBeTruthy();
    expect(Number(pair.ttlSeconds)).toBeLessThanOrEqual(600);

    const confirmed = confirmLocalAgentPairing({
      companyId: GRINGA,
      pairingCode: String(pair.pairingCode),
      storeId: STORE_G,
      version: '1.0.0-test',
    });
    expect(confirmed.paired).toBe(true);
    expect(confirmed.online).toBe(true);

    const status = getLocalAgentStatusDetailed(GRINGA, STORE_G);
    expect(status.paired).toBe(true);
  });

  it('a porta da tela guarda sem ecoar a credencial', async () => {
    const res = await request(app)
      .post('/api/v1/payment-terminals/credentials')
      .set(adminAuth(GRINGA, STORE_G))
      .set('Idempotency-Key', 'p18-stone-cred')
      .send({ provider: 'stone', storeId: STORE_G, accessToken: 'tef-secret-abc', environment: 'sandbox' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(JSON.stringify(res.body)).not.toContain('tef-secret-abc');
  });

  it('a segunda porta saiu: /integrations/stone/secrets responde 404', async () => {
    const res = await request(app)
      .post('/api/v1/integrations/stone/secrets')
      .set(adminAuth(GRINGA, STORE_G))
      .send({ accessToken: 'tef-secret-velho', environment: 'sandbox' });
    expect(res.status).toBe(404);
  });
});

/**
 * Estes três dependem de maquininha física ou de credencial que não temos.
 *
 * Eram `it(...)` com `expect(true).toBe(true)` no corpo: contavam como três
 * APROVAÇÕES no total da suíte, sem tocar em uma linha de produção. Agora são
 * `skip`, e aparecem como pulados — que é a verdade. O número de testes verdes
 * é a medida de confiança que a gente usa para decidir o que subir; inflá-lo
 * com casos vazios corrói justamente essa medida.
 */
describe('Prompt 18 BE — testes reais externos', () => {
  it.skip('Stone — exige maquininha física', () => {});
  it.skip('Cielo — exige maquininha física', () => {});
  it.skip('TEF genérico — exige agente local instalado', () => {});
});
