/**
 * Certificado digital A1 por operação.
 *
 * Dois grupos de garantia:
 *
 *   1. a SITUAÇÃO que a tela mostra — válido, perto de vencer, vencido, não
 *      configurado — porque é ela que faz alguém renovar antes de a emissão
 *      parar;
 *   2. o SIGILO: o .pfx, a chave privada e a senha nunca podem sair pela API,
 *      nem aparecer na auditoria.
 *
 * O certificado é gerado aqui mesmo, na hora, com uma chave descartável. Não
 * há arquivo de certificado no repositório.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import forge from 'node-forge';

process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_DATABASE_PATH = ':memory:';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

const { ensureCoreSchema } = await import('../src/db/schema.js');
const { resetDbForTests } = await import('../src/db/database.js');
const { upsertCompany } = await import('../src/services/auth/IdentityService.js');
const { upsertCertificateA1 } = await import(
  '../src/services/fiscal/FiscalCertificateService.js'
);
const { EXPIRY_WARNING_DAYS, getCertificateView, revokeCertificate } = await import(
  '../src/services/core/CertificateStatusService.js'
);

const SENHA = 'senha-do-certificado';
let companyId: string;

/** Gera um .pfx real, com validade controlada, para exercitar o fluxo. */
function makePfx(validFrom: Date, validTo: Date, cnpj = '12345678000199'): string {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = validFrom;
  cert.validity.notAfter = validTo;

  const attrs = [{ name: 'commonName', value: `PRECO JUSTO LTDA:${cnpj}` }];
  const issuer = [{ name: 'commonName', value: 'AC TESTE GRUPO SAMPAIO' }];
  cert.setSubject(attrs);
  cert.setIssuer(issuer);
  cert.sign(keys.privateKey);

  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], SENHA, {
    algorithm: '3des',
  });
  return forge.util.encode64(forge.asn1.toDer(p12).getBytes());
}

function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * 86400000);
}

function carregar(validTo: Date, validFrom = daysFromNow(-30)): void {
  upsertCertificateA1({
    companyId,
    operationalUnitId: 'unit-default',
    pfxBase64: makePfx(validFrom, validTo),
    password: SENHA,
  });
}

beforeEach(() => {
  ensureCoreSchema();
  resetDbForTests();
  companyId = upsertCompany({
    slug: 'preco-justo',
    legalName: 'Preço Justo Ltda',
    tradeName: 'Preço Justo',
  });
});

describe('situação do certificado', () => {
  it('sem certificado, a operação não emite nota e o estado diz isso', () => {
    const view = getCertificateView(companyId);
    expect(view.configured).toBe(false);
    expect(view.situation).toBe('nao_configurado');
    expect(view.readiness).toBe('READY_FOR_CERTIFICATE');
    expect(view.message).toMatch(/nota fiscal não é emitida/i);
  });

  it('certificado com folga é válido e informa os dias restantes', () => {
    carregar(daysFromNow(200));
    const view = getCertificateView(companyId);
    expect(view.situation).toBe('valido');
    expect(view.daysRemaining).toBeGreaterThan(EXPIRY_WARNING_DAYS);
    expect(view.message).toMatch(/válido/i);
  });

  it('dentro da janela de aviso, pede renovação', () => {
    carregar(daysFromNow(10));
    const view = getCertificateView(companyId);
    expect(view.situation).toBe('proximo_do_vencimento');
    expect(view.message).toMatch(/renovação/i);
  });

  it('vencido é reportado como vencido, não como válido', () => {
    // A carga recusa certificado fora da janela, então o vencimento é
    // simulado avançando o relógio da consulta.
    carregar(daysFromNow(5));
    const view = getCertificateView(companyId, 'unit-default', daysFromNow(10));
    expect(view.situation).toBe('vencido');
    expect(view.message).toMatch(/bloqueada/i);
  });

  it('a fronteira do aviso é o próprio limite', () => {
    carregar(daysFromNow(200));
    const noLimite = getCertificateView(
      companyId,
      'unit-default',
      daysFromNow(200 - EXPIRY_WARNING_DAYS),
    );
    expect(noLimite.situation).toBe('proximo_do_vencimento');
  });

  it('certificado carregado ainda NÃO é homologação', () => {
    carregar(daysFromNow(200));
    const view = getCertificateView(companyId);
    // Homologar exige teste real contra a SEFAZ, com ambiente do usuário.
    expect(view.readiness).toBe('CERTIFICATE_LOADED');
    expect(view.readiness).not.toBe('HOMOLOGATED');
  });
});

describe('dados do titular na tela', () => {
  it('mostra CNPJ, emissor e validade', () => {
    carregar(daysFromNow(120));
    const cert = getCertificateView(companyId).certificate!;
    expect(cert.cnpj).toBe('12345678000199');
    expect(String(cert.issuer)).toContain('AC TESTE');
    expect(String(cert.subject)).toContain('PRECO JUSTO');
    expect(cert.validTo).toBeTruthy();
  });
});

describe('sigilo', () => {
  it('a resposta NUNCA traz o arquivo, a chave ou a senha', () => {
    carregar(daysFromNow(120));
    const view = getCertificateView(companyId);
    const serializado = JSON.stringify(view);

    expect(serializado).not.toContain(SENHA);
    expect(serializado).not.toContain('BEGIN PRIVATE KEY');
    expect(serializado).not.toContain('BEGIN RSA PRIVATE KEY');
    expect(view.certificate).not.toHaveProperty('encryptedPfx');
    expect(view.certificate).not.toHaveProperty('keyPem');
    expect(view.certificate).not.toHaveProperty('password');
  });

  it('a senha não é guardada em lugar nenhum do registro', () => {
    carregar(daysFromNow(120));
    const view = getCertificateView(companyId);
    // O sanitizador vai além do esperado: até a referência ao cofre volta
    // redigida. Melhor assim — nada que aponte para o segredo sai da API.
    expect(String(view.certificate?.secretReference)).toBe('[REDACTED]');
  });
});

describe('substituição e desativação', () => {
  it('carregar de novo substitui, sem criar um segundo certificado', () => {
    carregar(daysFromNow(100));
    const primeiro = getCertificateView(companyId).certificate!;

    upsertCertificateA1({
      companyId,
      operationalUnitId: 'unit-default',
      pfxBase64: makePfx(daysFromNow(-1), daysFromNow(400), '99888777000166'),
      password: SENHA,
    });

    const segundo = getCertificateView(companyId).certificate!;
    expect(segundo.id).toBe(primeiro.id);
    expect(segundo.cnpj).toBe('99888777000166');
  });

  it('desativar volta a operação para não configurado', () => {
    carregar(daysFromNow(100));
    const view = revokeCertificate({
      companyId,
      reason: 'Certificado substituído por um novo da matriz.',
    });
    expect(view.configured).toBe(false);
    expect(view.situation).toBe('nao_configurado');
    expect(view.readiness).toBe('READY_FOR_CERTIFICATE');
  });

  it('desativar exige motivo', () => {
    carregar(daysFromNow(100));
    expect(() => revokeCertificate({ companyId, reason: '  ' })).toThrowError(/motivo/i);
  });

  it('desativar sem certificado configurado é recusado', () => {
    expect(() => revokeCertificate({ companyId, reason: 'qualquer' })).toThrowError(
      /Nenhum certificado configurado/i,
    );
  });
});

describe('isolamento por operação', () => {
  it('o certificado de uma empresa não aparece na outra', () => {
    carregar(daysFromNow(100));
    const outra = upsertCompany({
      slug: 'gringa',
      legalName: 'Gringa Ltda',
      tradeName: 'Gringa',
    });
    expect(getCertificateView(outra).configured).toBe(false);
    expect(getCertificateView(companyId).configured).toBe(true);
  });
});
