/**
 * Prompt 17 — backend logística: cofre da transportadora e sanitização.
 *
 * O catálogo, o painel, `testIntegrationConnection`, `runIntegrationHomologation`
 * e `requestProductionActivation` saíram com o roteador `/integrations`, que
 * nenhuma tela chamava (GAP-PRD-075). O token do Melhor Envio tem UMA porta —
 * `POST /logistics/carriers/credentials`, da tela Loja › Logística — e o teste
 * de conexão é o da própria logística (`testLogisticsCarrierConnection`).
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
// Sessão da conta que EXISTE: authMiddleware confere a conta a cada requisição (GAP-PRD-053).
import { issueSession } from './helpers/sessao.js';
import { runMigrations } from '../src/db/migrate.js';
import { resetDbForTests } from '../src/db/database.js';
import { upsertLogisticsCredentials } from '../src/services/logistics/LogisticsCredentialService.js';
import { buildLogisticsReadinessChecklist } from '../src/services/logistics/LogisticsReadinessService.js';
import { testLogisticsCarrierConnection } from '../src/services/logistics/LogisticsCarrierAdapter.js';
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

describe('Prompt 17 BE — cofre da transportadora', () => {
  it('credencial salva mascara e não vaza secret', () => {
    const row = upsertLogisticsCredentials({
      companyId: GRINGA,
      storeId: STORE_G,
      carrier: 'melhor_envio',
      environment: 'homologation',
      credentials: { token: 'sandbox-secret-token-xyz' },
    });
    const sanitized = sanitizeForLog(row);
    expect(JSON.stringify(sanitized)).not.toContain('sandbox-secret-token-xyz');
    expect(row.encryptedPayload).toBeTruthy();
  });

  it('teste de conexão sem API real não se passa por real', async () => {
    upsertLogisticsCredentials({
      companyId: GRINGA,
      storeId: STORE_G,
      carrier: 'correios',
      credentials: { password: 'x', contract: 'c1', username: 'u' },
    });
    const result = await testLogisticsCarrierConnection(GRINGA, 'correios', STORE_G);
    expect(result.real).toBeFalsy();
    expect(result.ok).toBe(false);
  });

  it('a porta da tela guarda sem ecoar o token', async () => {
    const res = await request(app)
      .post('/api/v1/logistics/carriers/credentials')
      .set(adminAuth(GRINGA, STORE_G))
      .set('Idempotency-Key', 'p17-me-token')
      .send({ carrier: 'melhor_envio', environment: 'sandbox', token: 'me-sandbox-token-abc' });
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    expect(JSON.stringify(res.body)).not.toContain('me-sandbox-token-abc');
  });

  it('a segunda porta saiu: /integrations/melhor_envio/secrets responde 404', async () => {
    const res = await request(app)
      .post('/api/v1/integrations/melhor_envio/secrets')
      .set(adminAuth(GRINGA, STORE_G))
      .send({ token: 'me-sandbox-token-velho', environment: 'homologation' });
    expect(res.status).toBe(404);
  });
});

describe('Prompt 17 BE — testes reais externos', () => {
  const meToken = process.env.MELHOR_ENVIO_SANDBOX_TOKEN;
  const runReal = process.env.LOGISTICS_HOMOLOGATION_TESTS === 'true' && Boolean(meToken);

  // `skipIf` em vez de sair cedo com `expect(true)`: sem credencial o caso
  // aparece como PULADO, e não como mais um verde no total.
  it.skipIf(!runReal)('Melhor Envio sandbox REAL', async () => {
    upsertLogisticsCredentials({
      companyId: GRINGA,
      storeId: STORE_G,
      carrier: 'melhor_envio',
      credentials: { token: meToken! },
    });
    const result = await testLogisticsCarrierConnection(GRINGA, 'melhor_envio', STORE_G);
    expect(result.real).toBe(true);
  });

  /*
    ERAM DOIS `it.skip` VAZIOS (GAP-PRD-118): a ausência do cliente HTTP dos
    Correios e da Jadlog ficava escondida no total de pulados, enquanto a
    prontidão acendia IMPLEMENTADO em verde. A ausência continua — os serviços
    deles chegam pelo Melhor Envio —, mas agora é DITA e cobrada aqui.
  */
  it.each(['correios', 'jadlog'] as const)('%s — sem integração direta, e a prontidão diz isso', (carrier) => {
    const provider = buildLogisticsReadinessChecklist(GRINGA).providers.find((p) => p.carrier === carrier)!;
    expect(provider.implemented).toBe(false);
    expect(provider.items).toHaveLength(1);
    expect(provider.items[0]).toMatchObject({ key: 'implementado', status: 'blocked' });
    expect(provider.items[0].message).toMatch(/Melhor Envio/);
  });
});
