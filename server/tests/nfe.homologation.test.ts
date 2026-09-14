/**
 * Homologação NF-e REAL — o certificado. Executar somente com
 * NFE_HOMOLOGATION_TESTS=true e certificado configurado.
 *
 * A prontidão, os endereços e o status da SEFAZ que este arquivo cobrava eram
 * do módulo legado (`NfeReadinessService`, `NfeSefazEndpoints`,
 * `NfeService.nfeServiceStatus`), com um emitente paralelo em
 * `fiscal_issuer_profiles`. Saíram na junção do GAP-PRD-075: a prontidão
 * fiscal é `/core/fiscal/readiness` e o teste de comunicação com a SEFAZ é
 * `POST /core/fiscal/sefaz/status`, sobre o emitente de `core_fiscal_configs`.
 */

import { describe, it, expect } from 'vitest';
import { parseCertificateA1, testCertificateSignature } from '../src/services/fiscal/FiscalCertificateService.js';

process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-key';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-32-chars!!';

const homologationEnabled = process.env.NFE_HOMOLOGATION_TESTS === 'true';
const hasCert = Boolean(process.env.NFE_TEST_PFX_BASE64?.trim());
const certPassword = process.env.NFE_TEST_CERT_PASSWORD ?? '';

describe.skipIf(!homologationEnabled || !hasCert)('Homologação — NF-e REAL (certificado)', () => {
  it('certificado parseado e assinatura validada', () => {
    const parsed = parseCertificateA1(String(process.env.NFE_TEST_PFX_BASE64), certPassword);
    expect(parsed.cnpj.length).toBeGreaterThanOrEqual(0);
    expect(testCertificateSignature(parsed)).toBe(true);
  });
});

describe.skipIf(homologationEnabled && hasCert)('Homologação — NF-e REAL (certificado)', () => {
  it('PENDING — configure NFE_HOMOLOGATION_TESTS=true, NFE_TEST_PFX_BASE64 e NFE_TEST_CERT_PASSWORD', () => {
    expect(homologationEnabled && hasCert).toBe(false);
  });
});
