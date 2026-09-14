/**
 * Vault consolidado de segredos operacionais — AES-256-GCM via FiscalSecretVault.
 */

import { createHash } from 'node:crypto';
import { findOneRow, findRows, insertRow, updateRows, deleteRows } from '../../db/database.js';
import { encryptFiscalSecret, decryptFiscalSecret } from '../fiscal/FiscalSecretVault.js';
import { ApiError } from '../../utils/errors.js';

export type IntegrationProvider =
  | 'asaas'
  | 'nfe'
  | 'nfce'
  | 'correios'
  | 'jadlog'
  | 'melhor_envio'
  | 'stone'
  | 'cielo'
  | 'rede'
  | 'getnet'
  | 'pagbank'
  | 'mercado_pago'
  | 'generic_tef'
  | 'ecommerce';

export type IntegrationSecretType =
  | 'api_key'
  | 'asaas_sandbox_api_key'
  | 'asaas_production_api_key'
  | 'webhook_token'
  | 'certificate_pfx'
  | 'certificate_password'
  | 'csc_token'
  | 'carrier_credentials'
  | 'terminal_credentials'
  | 'generic';

type SecretRow = Record<string, unknown>;

function maskHint(value: string): string {
  if (!value || value.length < 4) return '•••• configurado';
  return `••••${value.slice(-4)}`;
}

function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function matchesScope(
  row: SecretRow,
  input: {
    companyId: string;
    operationalUnitId?: string;
    storeId?: string;
    provider: IntegrationProvider;
    secretType: IntegrationSecretType;
  },
): boolean {
  return row.companyId === input.companyId
    && row.provider === input.provider
    && row.secretType === input.secretType
    && row.storeId === (input.storeId ?? null)
    && row.operationalUnitId === (input.operationalUnitId ?? null);
}

export function upsertIntegrationSecret(input: {
  companyId: string;
  operationalUnitId?: string;
  storeId?: string;
  provider: IntegrationProvider;
  secretType: IntegrationSecretType;
  plaintext: string;
}): Record<string, unknown> {
  if (!input.plaintext?.trim()) {
    throw new ApiError('INTEGRATION_SECRET_REQUIRED', 'Valor do segredo obrigatório.', 400);
  }
  const encryptedValue = encryptFiscalSecret(input.plaintext);
  const now = new Date().toISOString();
  const existing = findOneRow<SecretRow>(
    'integration_secrets',
    (r) => matchesScope(r, input),
  );

  const base = {
    companyId: input.companyId,
    operationalUnitId: input.operationalUnitId ?? null,
    storeId: input.storeId ?? null,
    provider: input.provider,
    secretType: input.secretType,
    encryptedValue,
    fingerprint: fingerprint(input.plaintext),
    maskedHint: maskHint(input.plaintext),
    updatedAt: now,
    rotatedAt: existing ? now : null,
    lastUsedAt: existing?.lastUsedAt ?? null,
  };

  if (existing) {
    updateRows('integration_secrets', (r) => r.id === existing.id, (r) => ({
      ...r,
      ...base,
      version: Number(r.version ?? 1) + 1,
    }));
    return sanitizeIntegrationSecret(findOneRow('integration_secrets', (r) => r.id === existing.id)!);
  }

  return sanitizeIntegrationSecret(insertRow('integration_secrets', {
    id: `isec-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    version: 1,
    createdAt: now,
    ...base,
  }));
}

export function getIntegrationSecretPlaintext(input: {
  companyId: string;
  operationalUnitId?: string;
  storeId?: string;
  provider: IntegrationProvider;
  secretType: IntegrationSecretType;
}): string | null {
  const row = findOneRow<SecretRow>(
    'integration_secrets',
    (r) => matchesScope(r, input),
  );
  if (!row?.encryptedValue) return null;
  try {
    updateRows('integration_secrets', (r) => r.id === row.id, (r) => ({
      ...r,
      lastUsedAt: new Date().toISOString(),
    }));
    return decryptFiscalSecret(String(row.encryptedValue));
  } catch {
    return null;
  }
}

export function listIntegrationSecrets(
  companyId: string,
  filters?: { provider?: IntegrationProvider; storeId?: string; operationalUnitId?: string },
): Record<string, unknown>[] {
  return findRows<SecretRow>(
    'integration_secrets',
    (r) => {
      if (r.companyId !== companyId) return false;
      if (filters?.provider && r.provider !== filters.provider) return false;
      if (filters?.storeId && r.storeId !== filters.storeId) return false;
      if (filters?.operationalUnitId && r.operationalUnitId !== filters.operationalUnitId) return false;
      return true;
    },
  ).map(sanitizeIntegrationSecret);
}

export function deleteIntegrationSecret(input: {
  companyId: string;
  provider: IntegrationProvider;
  secretType: IntegrationSecretType;
  storeId?: string;
  operationalUnitId?: string;
}): boolean {
  const row = findOneRow<SecretRow>(
    'integration_secrets',
    (r) => matchesScope(r, input),
  );
  if (!row) return false;
  deleteRows('integration_secrets', (r) => r.id === row.id);
  return true;
}

export function sanitizeIntegrationSecret(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    companyId: row.companyId,
    operationalUnitId: row.operationalUnitId,
    storeId: row.storeId,
    provider: row.provider,
    secretType: row.secretType,
    configured: Boolean(row.encryptedValue),
    maskedHint: row.maskedHint ?? '•••• configurado',
    fingerprint: row.fingerprint,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    rotatedAt: row.rotatedAt,
    lastUsedAt: row.lastUsedAt,
  };
}
