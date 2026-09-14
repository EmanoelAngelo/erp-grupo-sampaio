/**
 * Homologação NFC-e REAL — certificado e QR Code. Executar somente com
 * NFCE_HOMOLOGATION_TESTS=true, certificado e CSC configurados.
 *
 * A prontidão, os endereços e o status da SEFAZ que este arquivo cobrava eram
 * do módulo legado (`NfceReadinessService`, `NfeSefazEndpoints`,
 * `NfceService.nfceServiceStatus`), com um emitente paralelo em
 * `fiscal_issuer_profiles`. Saíram na junção do GAP-PRD-075: a prontidão
 * fiscal é `/core/fiscal/readiness` e o teste de comunicação com a SEFAZ é
 * `POST /core/fiscal/sefaz/status`. O CSC e o QR Code continuam aqui porque
 * são os mesmos que a NFC-e do núcleo usa (`NfceCscService`).
 */

import { describe, it, expect } from 'vitest';
import { parseCertificateA1, testCertificateSignature } from '../src/services/fiscal/FiscalCertificateService.js';
import { buildNfceQRCodeUrl } from '../src/services/nfce/NfceCscService.js';

process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-key';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-32-chars!!';

const homologationEnabled = process.env.NFCE_HOMOLOGATION_TESTS === 'true';
const hasCert = Boolean(process.env.NFE_TEST_PFX_BASE64?.trim());
const hasCsc = Boolean(process.env.NFCE_TEST_CSC_TOKEN?.trim());
const certPassword = process.env.NFE_TEST_CERT_PASSWORD ?? '';
const cscId = process.env.NFCE_TEST_CSC_ID ?? '1';
const cscToken = process.env.NFCE_TEST_CSC_TOKEN ?? '';

describe.skipIf(!homologationEnabled || !hasCert || !hasCsc)('Homologação — NFC-e REAL (certificado e CSC)', () => {
  it('certificado parseado e assinatura validada', () => {
    const parsed = parseCertificateA1(String(process.env.NFE_TEST_PFX_BASE64), certPassword);
    expect(parsed.cnpj.length).toBeGreaterThanOrEqual(0);
    expect(testCertificateSignature(parsed)).toBe(true);
  });

  it('QR Code com hash CSC conforme regra vigente', () => {
    const accessKey = '43250700000000000191650010000000011000000000';
    const qr = buildNfceQRCodeUrl(accessKey, 'homologation', cscId, cscToken, 'RS');
    expect(qr.url).toMatch(/homolog|svrs/);
    expect(qr.payload.split('|').length).toBe(5);
    expect(qr.hash).toHaveLength(40);
  });
});

describe.skipIf(homologationEnabled && hasCert && hasCsc)('Homologação — NFC-e REAL (certificado e CSC)', () => {
  it('PENDING — configure NFCE_HOMOLOGATION_TESTS=true, NFE_TEST_PFX_BASE64, NFE_TEST_CERT_PASSWORD, NFCE_TEST_CSC_ID e NFCE_TEST_CSC_TOKEN', () => {
    expect(homologationEnabled && hasCert && hasCsc).toBe(false);
  });
});

describe('Homologação — NFC-e QR Code (unitário)', () => {
  it('CSC ausente deve falhar ao gerar hash', () => {
    expect(() => buildNfceQRCodeUrl('43250700000000000191650010000000011000000000', 'homologation', '1', '', 'RS')).not.toThrow();
  });

  it('ambiente homologação usa tpAmb=2 na URL', () => {
    const qr = buildNfceQRCodeUrl('43250700000000000191650010000000011000000000', 'homologation', '1', 'token-test', 'RS');
    expect(qr.payload).toContain('|2|');
    expect(qr.url).toMatch(/homolog|svrs/);
  });
});
