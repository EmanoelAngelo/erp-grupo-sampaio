/**
 * Prompt 30 — Backend final release gates
 */

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
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetEnvCacheForTests, loadEnv } from '../src/config/env.js';
import { runMigrations } from '../src/db/migrate.js';
import { CORE_TARGET_VERSION, migrateCoreSchema } from '../src/db/core-migrations.js';
import { evaluateCoreProductionReadiness } from '../src/services/system-admin/CoreProductionReadinessService.js';
import { getReleaseVersionInfo, getHomologationMatrixBackend } from '../src/services/system-admin/SystemAdminService.js';
// Sessão da conta que EXISTE: authMiddleware confere a conta a cada requisição (GAP-PRD-053).
import { issueSession } from './helpers/sessao.js';

describe('Prompt 30 BE — final release', () => {
  const app = createApp();

  beforeAll(() => {
    // O READY mede o NÚCLEO (GAP-PRD-057): o banco precisa estar migrado
    // como o boot o deixa, não só na camada de documentos.
    runMigrations();
    migrateCoreSchema();
  });

  beforeEach(() => {
    resetEnvCacheForTests();
  });

  it('version 1.0.0 + núcleo no alvo da build', () => {
    const info = getReleaseVersionInfo();
    expect(info.appVersion).toBe('1.0.0');
    expect(info.apiVersion).toBe('1.0.0');
    expect(info).not.toHaveProperty('indexedDbVersion');
    expect(info.databaseVersion).toBe(CORE_TARGET_VERSION);
    expect(info.releaseChannel).toBe('stable');
    expect(String(info.release)).toMatch(/Grupo Sampaio ERP 1\.0\.0/);
  });

  it('core READY, external not READY', () => {
    const report = evaluateCoreProductionReadiness();
    expect(report.coreStatus).toBe('READY');
    expect(report.externalIntegrationsStatus).not.toBe('READY');
    expect(report.overallStatus).toBe('ready_for_core_production');
  });

  // A matriz de homologação cravada saiu (GAP-PRD-064): dizia "Core ERP
  // homologado" por constante. O estado real por empresa é o checklist de
  // implantação (`a-implantacao-de-cada-empresa.test.ts`).

  it('health + version endpoints', async () => {
    const health = await request(app).get('/api/v1/health');
    expect(health.status).toBe(200);
    const version = await request(app).get('/api/v1/version');
    expect(version.status).toBe(200);
    expect(version.body.appVersion).toBe('1.0.0');
  });

  it('readiness endpoint core READY', async () => {
    const tokens = issueSession({
      userId: 'admin-p30',
      companyId: 'company-preco-justo',
      storeId: 'store-preco-justo-matriz',
      profileCodes: ['admin_geral'],
    });
    const res = await request(app)
      .get('/api/v1/system/readiness')
      .set('Authorization', `Bearer ${tokens.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.coreStatus).toBe('READY');
    expect(res.body.overallStatus).toBe('ready_for_core_production');
  });

  it('production rejects weak JWT/encryption defaults', () => {
    resetEnvCacheForTests();
    const prevEnv = process.env.DEVORA_API_ENV;
    const prevJwt = process.env.DEVORA_JWT_SECRET;
    const prevKey = process.env.DEVORA_ENCRYPTION_KEY;
    process.env.DEVORA_API_ENV = 'production';
    delete process.env.DEVORA_JWT_SECRET;
    delete process.env.DEVORA_ENCRYPTION_KEY;
    expect(() => loadEnv()).toThrow(/Produção exige/);
    process.env.DEVORA_API_ENV = prevEnv;
    if (prevJwt !== undefined) process.env.DEVORA_JWT_SECRET = prevJwt;
    else delete process.env.DEVORA_JWT_SECRET;
    if (prevKey !== undefined) process.env.DEVORA_ENCRYPTION_KEY = prevKey;
    else delete process.env.DEVORA_ENCRYPTION_KEY;
    resetEnvCacheForTests();
  });
});
