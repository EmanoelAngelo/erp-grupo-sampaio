/**
 * Homologação Payment Terminal REAL — mock executável; providers reais exigem SDK/hardware.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { resetEnvCacheForTests } from '../src/config/env.js';
import { resetDbForTests } from '../src/db/database.js';
import { upsertPaymentTerminalCredentials } from '../src/services/payment-terminal/PaymentTerminalCredentialService.js';
import { buildPaymentTerminalReadinessChecklist } from '../src/services/payment-terminal/PaymentTerminalReadinessService.js';
import {
  processPaymentTerminalTransaction,
  testPaymentTerminalConnection,
} from '../src/services/payment-terminal/PaymentTerminalProviderAdapter.js';
import { paymentTerminalHealth, runPaymentTerminalHomologationBackend } from '../src/services/payment-terminal/PaymentTerminalService.js';

process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-key';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-32-chars!!';
process.env.PAYMENT_TERMINAL_PRODUCTION_ENABLED = 'false';

const homologationEnabled = process.env.PAYMENT_TERMINAL_HOMOLOGATION_TESTS === 'true';

describe('Homologação — Payment Terminal mock', () => {
  beforeEach(() => {
    resetEnvCacheForTests();
    resetDbForTests();
    process.env.PAYMENT_TERMINAL_PRODUCTION_ENABLED = 'false';
  });

  it('produção bloqueada por padrão', () => {
    expect(paymentTerminalHealth().productionBlocked).toBe(true);
  });

  it('mock — conexão e crédito simulados', async () => {
    const conn = await testPaymentTerminalConnection('company-pt', 'mock');
    expect(conn.ok).toBe(true);
    expect(conn.simulated).toBe(true);
    const tx = await processPaymentTerminalTransaction('company-pt', 'mock', { paymentMethod: 'credit', amountInCents: 1000 });
    expect(tx.ok).toBe(true);
    expect(tx.providerNsu).toBeTruthy();
    expect(tx.maskedCard).toMatch(/\*\*\*\*/);
  });

  it('timeout incerto simulado', async () => {
    const tx = await processPaymentTerminalTransaction('company-pt', 'mock', {
      paymentMethod: 'credit',
      amountInCents: 1000,
      scenario: 'timeout_uncertain',
    });
    expect(tx.status).toBe('timeout_uncertain');
  });

  it('homologação mock runner', async () => {
    const result = await runPaymentTerminalHomologationBackend('company-pt', 'mock');
    expect(result.stepsCompleted.length).toBeGreaterThan(5);
    expect(result.homologated).toBe(false);
    expect(result.mockInternal).toBe(true);
    expect(result.status).toBe('mock_internal_passed');
  });

  it('credencial criptografada', () => {
    const row = upsertPaymentTerminalCredentials({
      companyId: 'company-pt',
      provider: 'stone',
      credentials: { accessToken: 'secret-stone-token' },
    });
    expect(String(row.encryptedPayload)).not.toContain('secret-stone-token');
  });

  it('stone adapter estrutural sem credencial', async () => {
    const tx = await processPaymentTerminalTransaction('company-pt', 'stone', { paymentMethod: 'credit', amountInCents: 1000 });
    expect(tx.pending).toBe(true);
    expect(tx.ok).toBe(false);
  });
});

describe.skipIf(!homologationEnabled)('Homologação — Payment Terminal REAL', () => {
  it('PENDING — configure PAYMENT_TERMINAL_HOMOLOGATION_TESTS=true e credenciais provider', () => {
    expect(homologationEnabled).toBe(true);
  });
});

describe.skipIf(homologationEnabled)('Homologação — Payment Terminal REAL', () => {
  it('PENDING — configure PAYMENT_TERMINAL_HOMOLOGATION_TESTS=true', () => {
    expect(homologationEnabled).toBe(false);
  });
});

describe('Homologação — readiness', () => {
  beforeEach(() => {
    resetEnvCacheForTests();
    resetDbForTests();
  });

  it('readiness lista providers', () => {
    const checklist = buildPaymentTerminalReadinessChecklist('company-1');
    expect(checklist.providers.length).toBeGreaterThanOrEqual(8);
    expect(checklist.productionBlocked).toBe(true);
  });
});
