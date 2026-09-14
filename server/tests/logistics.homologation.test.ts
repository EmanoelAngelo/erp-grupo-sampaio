/**
 * Homologação Logística REAL — executar somente com LOGISTICS_HOMOLOGATION_TESTS=true e credenciais configuradas.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { resetEnvCacheForTests } from '../src/config/env.js';
import { resetDbForTests } from '../src/db/database.js';
import { upsertLogisticsCredentials } from '../src/services/logistics/LogisticsCredentialService.js';
import { buildLogisticsReadinessChecklist } from '../src/services/logistics/LogisticsReadinessService.js';
import { testLogisticsCarrierConnection, quoteLogisticsCarrier } from '../src/services/logistics/LogisticsCarrierAdapter.js';
import { logisticsHealth } from '../src/services/logistics/LogisticsService.js';

process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-key';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-32-chars!!';
process.env.LOGISTICS_PRODUCTION_ENABLED = 'false';

const homologationEnabled = process.env.LOGISTICS_HOMOLOGATION_TESTS === 'true';
const hasMelhorEnvio = Boolean(process.env.LOGISTICS_MELHOR_ENVIO_TOKEN?.trim());

describe.skipIf(!homologationEnabled || !hasMelhorEnvio)('Homologação — Melhor Envio REAL (Sandbox)', () => {
  beforeEach(() => {
    resetEnvCacheForTests();
    resetDbForTests();
    process.env.LOGISTICS_PRODUCTION_ENABLED = 'false';
    process.env.LOGISTICS_HOMOLOGATION_TESTS = 'true';
    upsertLogisticsCredentials({
      companyId: 'company-hom-lg',
      carrier: 'melhor_envio',
      environment: 'homologation',
      credentials: { token: String(process.env.LOGISTICS_MELHOR_ENVIO_TOKEN) },
    });
  });

  it('conexão Melhor Envio sandbox REAL', async () => {
    const result = await testLogisticsCarrierConnection('company-hom-lg', 'melhor_envio');
    expect(result.real).toBe(true);
    expect(result.ok).toBe(true);
  }, 30_000);

  it('cotação Melhor Envio sandbox REAL', async () => {
    const result = await quoteLogisticsCarrier('company-hom-lg', 'melhor_envio', {
      originZipCode: '01310100',
      destinationZipCode: '30130000',
      weightGrams: 500,
      heightCm: 10,
      widthCm: 15,
      lengthCm: 20,
      declaredValueInCents: 10000,
    });
    expect(result.real).toBe(true);
    expect(result.options?.length).toBeGreaterThan(0);
  }, 30_000);
});

describe.skipIf(homologationEnabled && hasMelhorEnvio)('Homologação — Logística REAL', () => {
  it('PENDING — configure LOGISTICS_HOMOLOGATION_TESTS=true e LOGISTICS_MELHOR_ENVIO_TOKEN', () => {
    expect(homologationEnabled && hasMelhorEnvio).toBe(false);
  });
});

describe('Homologação — Logística produção bloqueada', () => {
  beforeEach(() => {
    // Idem: sem resetar o banco, o resultado dependia da ordem dos arquivos.
    resetDbForTests();
    resetEnvCacheForTests();
    process.env.LOGISTICS_PRODUCTION_ENABLED = 'false';
  });

  it('LOGISTICS_PRODUCTION_ENABLED=false por padrão', () => {
    const health = logisticsHealth();
    expect(health.productionBlocked).toBe(true);
    const readiness = buildLogisticsReadinessChecklist('company-1');
    expect(readiness.productionBlocked).toBe(true);
  });
});

describe('Homologação — Credenciais criptografadas', () => {
  beforeEach(() => {
    resetEnvCacheForTests();
    resetDbForTests();
  });

  it('credencial não expõe token na resposta sanitizada', () => {
    const row = upsertLogisticsCredentials({
      companyId: 'company-1',
      carrier: 'correios',
      credentials: { token: 'secret-correios-token' },
    });
    expect(row.encryptedPayload ?? row.apiKeyEncrypted).toBeTruthy();
    expect(String(row.encryptedPayload ?? row.apiKeyEncrypted)).not.toContain('secret-correios-token');
  });
});
