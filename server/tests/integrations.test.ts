/**
 * O cofre de segredos de integração e a credencial do Asaas por cima dele.
 *
 * Os casos da "Central de Integrações" (`GET/POST/DELETE /integrations/*` e o
 * catálogo) saíram com o roteador, que nenhuma tela chamava (GAP-PRD-075). A
 * prova da saída está em `o-legado-sem-consumidor-sai-do-ar.test.ts`; a porta
 * da chave do Asaas é `PUT /core/integrations/asaas/credentials`
 * (`prompt15-integrations-asaas.test.ts`).
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { loadDb, resetDbForTests } from '../src/db/database.js';
import {
  upsertIntegrationSecret,
  getIntegrationSecretPlaintext,
  deleteIntegrationSecret,
} from '../src/services/integrations/IntegrationSecretVaultService.js';
import {
  getAsaasCredentialStatus,
  upsertAsaasApiKey,
  removeAsaasSecret,
} from '../src/services/integrations/AsaasCredentialService.js';

const COMPANY = 'company-integrations-test';

beforeAll(() => {
  runMigrations();
});

beforeEach(() => {
  resetDbForTests();
  runMigrations();
});

describe('Integration Secret Vault', () => {
  it('cifra e não retorna plaintext na resposta sanitizada', () => {
    const sanitized = upsertIntegrationSecret({
      companyId: COMPANY,
      provider: 'asaas',
      secretType: 'asaas_sandbox_api_key',
      plaintext: 'sk_test_1234567890',
    });
    expect(sanitized.configured).toBe(true);
    expect(JSON.stringify(sanitized)).not.toContain('sk_test_1234567890');
    expect(sanitized.maskedHint).toContain('7890');
    expect(getIntegrationSecretPlaintext({
      companyId: COMPANY,
      provider: 'asaas',
      secretType: 'asaas_sandbox_api_key',
    })).toBe('sk_test_1234567890');
  });

  it('remove segredo', () => {
    upsertIntegrationSecret({
      companyId: COMPANY,
      provider: 'asaas',
      secretType: 'asaas_sandbox_api_key',
      plaintext: 'key-remove-test',
    });
    expect(deleteIntegrationSecret({
      companyId: COMPANY,
      provider: 'asaas',
      secretType: 'asaas_sandbox_api_key',
    })).toBe(true);
    expect(getIntegrationSecretPlaintext({
      companyId: COMPANY,
      provider: 'asaas',
      secretType: 'asaas_sandbox_api_key',
    })).toBeNull();
  });

  it('isolamento multiempresa', () => {
    upsertIntegrationSecret({
      companyId: COMPANY,
      provider: 'asaas',
      secretType: 'asaas_sandbox_api_key',
      plaintext: 'company-a-key',
    });
    upsertIntegrationSecret({
      companyId: 'other-company',
      provider: 'asaas',
      secretType: 'asaas_sandbox_api_key',
      plaintext: 'company-b-key',
    });
    expect(getIntegrationSecretPlaintext({
      companyId: 'other-company',
      provider: 'asaas',
      secretType: 'asaas_sandbox_api_key',
    })).toBe('company-b-key');
    expect(getIntegrationSecretPlaintext({
      companyId: COMPANY,
      provider: 'asaas',
      secretType: 'asaas_sandbox_api_key',
    })).toBe('company-a-key');
  });

  it('a coleção do cofre existe na instalação', () => {
    expect(loadDb().version).toBeGreaterThanOrEqual(18);
    expect(Array.isArray(loadDb().integration_secrets)).toBe(true);
  });
});

describe('Asaas credentials via vault', () => {
  it('status mascarado após salvar', () => {
    upsertAsaasApiKey({
      companyId: COMPANY,
      environment: 'sandbox',
      apiKey: '$aact_test_abcdefghij',
    });
    const status = getAsaasCredentialStatus(COMPANY);
    expect(status.sandbox.configured).toBe(true);
    expect(status.sandbox.source).toBe('vault');
    expect(status.sandbox.maskedHint).not.toContain('$aact_test_abcdefghij');
  });

  it('remove credencial Asaas', () => {
    upsertAsaasApiKey({ companyId: COMPANY, environment: 'sandbox', apiKey: 'temp-key' });
    expect(removeAsaasSecret(COMPANY, 'api_key')).toBe(true);
    const status = getAsaasCredentialStatus(COMPANY);
    expect(status.sandbox.source).not.toBe('vault');
  });
});
