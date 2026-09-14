/**
 * A situação de staging que tem leitor (`stagingStatus` de `GET /system/readiness`).
 *
 * O relatório "integrado" de antes saiu com a rota `/system/staging/readiness`
 * (GAP-PRD-075): ele cravava `ok` para doze módulos — CRM, BI e Automações
 * entre eles, já inexistentes — e montava a prontidão fiscal sobre coleções
 * que ninguém escreve. O que fica sai só do ambiente e das travas.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetEnvCacheForTests } from '../src/config/env.js';
import { evaluateStagingReadiness } from '../src/services/system-admin/StagingReadinessService.js';

process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-key';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-32-chars!!';

const TRAVAS = [
  'ASAAS_PRODUCTION_ENABLED',
  'NFE_PRODUCTION_ENABLED',
  'NFCE_PRODUCTION_ENABLED',
  'LOGISTICS_PRODUCTION_ENABLED',
  'PAYMENT_TERMINAL_PRODUCTION_ENABLED',
  'ECOMMERCE_PRODUCTION_ENABLED',
];

describe('a situação de staging sai do ambiente', () => {
  beforeEach(() => {
    process.env.DEVORA_API_ENV = 'staging';
    for (const t of TRAVAS) process.env[t] = 'false';
    resetEnvCacheForTests();
  });

  it('staging com todas as travas fechadas: pronto para staging, nunca para produção', () => {
    const report = evaluateStagingReadiness();
    expect(report.overallStatus).toBe('ready_for_staging');
    expect(report.productionFlagsBlocked).toBe(true);
    expect(report.readyForProduction).toBe(false);
  });

  it('uma trava de produção aberta tira o selo', () => {
    process.env.NFCE_PRODUCTION_ENABLED = 'true';
    resetEnvCacheForTests();
    const report = evaluateStagingReadiness();
    expect(report.productionFlagsBlocked).toBe(false);
    expect(report.overallStatus).toBe('not_ready');
  });

  it('não inventa estado de módulo: nenhum CRM, BI ou Automações "operacional", nenhuma prontidão fiscal paralela', () => {
    const report = evaluateStagingReadiness() as unknown as Record<string, unknown>;
    expect(Object.keys(report).sort()).toEqual(
      ['environment', 'isStagingEnv', 'overallStatus', 'productionFlagsBlocked', 'readyForProduction'].sort(),
    );
    expect(JSON.stringify(report)).not.toMatch(/crm|automations|bi dashboards|fiscal_issuer/i);
  });
});
