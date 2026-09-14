/*
  O AMBIENTE DO TESTE É DO TESTE — auditoria de entrega.

  Estes casos leem o resultado de loadEnv(), e o dotenv NUNCA sobrescreve
  variável já presente no processo: fixá-las aqui isola o teste do .env da
  MÁQUINA. Sem isto, no dia em que o dono ligou ASAAS_PRODUCTION_ENABLED no
  .env dele, sete testes de prontidão ficaram vermelhos em três rodadas
  seguidas — medindo a máquina do dono, não o código.
*/
process.env.ASAAS_PRODUCTION_ENABLED = 'false';
process.env.NFE_PRODUCTION_ENABLED = 'false';
process.env.NFCE_PRODUCTION_ENABLED = 'false';
process.env.LOGISTICS_PRODUCTION_ENABLED = 'false';
process.env.PAYMENT_TERMINAL_PRODUCTION_ENABLED = 'false';
process.env.ECOMMERCE_PRODUCTION_ENABLED = 'false';
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
// Sessão da conta que EXISTE: authMiddleware confere a conta a cada requisição (GAP-PRD-053).
import { issueSession } from './helpers/sessao.js';
import { runMigrations } from '../src/db/migrate.js';
import { loadDb } from '../src/db/database.js';
import { CORE_TARGET_VERSION, migrateCoreSchema } from '../src/db/core-migrations.js';

const app = createApp();

function authHeaders() {
  const tokens = issueSession({
    userId: '550e8400-e29b-41d4-a716-446655440005',
    companyId: 'company-sys-api',
    storeId: 'store-sys-api',
    profileCodes: ['admin_geral'],
  });
  return { Authorization: `Bearer ${tokens.accessToken}` };
}

beforeAll(() => {
  // O READY mede o NÚCLEO (GAP-PRD-057): o banco precisa estar migrado como
  // o boot o deixa, não só na camada de documentos.
  runMigrations();
  migrateCoreSchema();
});

describe('System Admin API — Checkpoint 73', () => {
  it('GET /system/health', async () => {
    const res = await request(app).get('/api/v1/system/health');
    expect(res.status).toBe(200);
    expect(res.body.checkpoint).toBe(73);
  });

  it('GET /version 1.0.0 metadata', async () => {
    const res = await request(app).get('/api/v1/version');
    expect(res.body.checkpoint).toBe(73);
    expect(res.body.appVersion).toBe('1.0.0');
    // Sem IndexedDB inventado; o número do banco é o do núcleo (GAP-PRD-057).
    expect(res.body).not.toHaveProperty('indexedDbVersion');
    expect(res.body.databaseVersion).toBe(CORE_TARGET_VERSION);
  });

  it('migration v15 fresh', () => {
    expect(loadDb().version).toBeGreaterThanOrEqual(15);
  });

  // O relatório de staging saiu (GAP-PRD-075): nenhuma tela o chamava, e ele
  // dizia "operacional" de CRM, BI e Automações, que já não existiam.
  it('GET /system/staging/readiness saiu do ar', async () => {
    const res = await request(app).get('/api/v1/system/staging/readiness').set(authHeaders());
    expect(res.status).toBe(404);
  });

  it('GET /system/readiness', async () => {
    const res = await request(app).get('/api/v1/system/readiness').set(authHeaders());
    expect(res.status).toBe(200);
    expect(typeof res.body.stagingStatus).toBe('string');
    expect(res.body.coreStatus).toBe('READY');
    expect(res.body.externalIntegrationsStatus).toBe('PENDING');
    expect(res.body.overallStatus).toBe('ready_for_core_production');
  });

  // `/go-live` e `/homologations` respondiam listas cravadas sem tela nenhuma
  // (GAP-PRD-064) e saíram; a prova da saída está em
  // `o-roteador-do-sistema-so-tem-o-que-e-verdade.test.ts`.

  it('GET /system/release', async () => {
    const res = await request(app).get('/api/v1/system/release').set(authHeaders());
    expect(res.status).toBe(200);
    expect(res.body.release).toContain('1.0.0');
  });

  it('error handler inclui correlationId', async () => {
    const res = await request(app).get('/api/v1/asaas/charges').set(authHeaders());
    expect(res.headers['x-request-id']).toBeDefined();
  });
});

describe('Migration tests — CP73', () => {
  it('repeatable migrate', () => {
    runMigrations();
    runMigrations();
    expect(loadDb().version).toBeGreaterThanOrEqual(15);
  });
});
