/**
 * Assinatura XMLDSig.
 *
 * A assinatura existe para garantir UMA coisa: que o documento autorizado é
 * exatamente o que foi assinado. Se adulterar um centavo depois de assinar não
 * derrubasse a verificação, a assinatura não protegeria nada — dá para trocar
 * a nota entre a emissão e a transmissão.
 *
 * Os certificados aqui são GERADOS NO TESTE. Fixture serve para provar
 * criptografia; não é, e nunca será, homologação.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import forge from 'node-forge';
import { createHash } from 'node:crypto';
import { XmlC14NMode, XmlDocument } from 'libxml2-wasm';
import { resetDbForTests } from '../src/db/database.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import { updateFiscalConfig, type FiscalConfig } from '../src/services/core/FiscalConfigService.js';
import { buildNfceXml, type NfceSale } from '../src/services/core/FiscalXmlNfce.js';
import {
  SIGNER_LIMITATIONS,
  signNfceXml,
  verifyNfceSignature,
} from '../src/services/core/FiscalSigner.js';
import type { ParsedCertificateA1 } from '../src/services/fiscal/FiscalCertificateService.js';
import { grupoTributarioPadrao } from './helpers/grupoTributario.js';

/** Gera um par de chaves + certificado autoassinado, só para o teste. */
function gerarCertificado(cn: string): ParsedCertificateA1 {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 86400000);
  cert.validity.notAfter = new Date(Date.now() + 86400000 * 365);
  const attrs = [{ name: 'commonName', value: cn }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  return {
    subject: cn,
    issuer: cn,
    cnpj: '11222333000181',
    serialNumber: '01',
    validFrom: cert.validity.notBefore.toISOString(),
    validTo: cert.validity.notAfter.toISOString(),
    certPem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

let certA: ParsedCertificateA1;
let certB: ParsedCertificateA1;
let companyId: string;
let config: FiscalConfig;

const venda: NfceSale = {
  id: 'sale-1',
  number: 1,
  companyId: '',
  createdAt: '2026-08-13T12:00:00.000Z',
  subtotalCents: 10_000,
  discountCents: 0,
  surchargeCents: 0,
  totalCents: 10_000,
  changeCents: 0,
  customerId: null,
  customerDocument: null,
  customerName: null,
  items: [
    {
      productId: 'p1',
      description: 'Camisa Social',
      quantity: 2,
      unitPriceCents: 5_000,
      discountCents: 0,
      surchargeCents: 0,
      totalCents: 10_000,
      ncm: '62052000',
      cest: null,
      cfop: '5102',
      origin: '0',
      unit: 'UN',
      barcode: '7891234567895',
      internalCode: 'GS-0001',
    },
  ],
  payments: [{ method: 'dinheiro', amountCents: 10_000 }],
};

beforeAll(() => {
  // Gerar RSA 2048 é caro; uma vez para o arquivo inteiro.
  certA = gerarCertificado('EMPRESA A:11222333000181');
  certB = gerarCertificado('EMPRESA B:99888777000166');
}, 60_000);

beforeEach(() => {
  resetDbForTests();
  companyId = upsertCompany({
    slug: 'preco-justo',
    legalName: 'Preço Justo Ltda',
    tradeName: 'Preço Justo',
  });
  config = updateFiscalConfig({
    companyId,
    patch: {
      legalName: 'Preço Justo Comércio Ltda',
      cnpj: '11.222.333/0001-81',
      ie: '123456789',
      crt: '1',
      street: 'Av. Central',
      number: '100',
      district: 'Centro',
      cityName: 'Pelotas',
      cityIbge: '4314407',
      zip: '96010000',
      uf: 'RS',
    },
  });
  grupoTributarioPadrao(companyId);
});

function assinarVenda() {
  const { xml } = buildNfceXml({ sale: { ...venda, companyId }, config, serie: 1, number: 1 });
  return signNfceXml(xml, certA);
}

describe('assinatura', () => {
  it('XML assinado passa na verificação', () => {
    const assinado = assinarVenda();
    const r = verifyNfceSignature(assinado.xml);

    expect(r.valid).toBe(true);
    expect(r.digestMatches).toBe(true);
    expect(r.signatureMatches).toBe(true);
    expect(r.reason).toBeNull();
  });

  it('a assinatura entra dentro de NFe, com digest e certificado', () => {
    const assinado = assinarVenda();
    expect(assinado.xml).toContain('<Signature xmlns="http://www.w3.org/2000/09/xmldsig#">');
    expect(assinado.xml).toContain('<DigestValue>');
    expect(assinado.xml).toContain('<X509Certificate>');
    expect(assinado.xml.indexOf('<Signature')).toBeGreaterThan(assinado.xml.indexOf('</infNFe>'));
    expect(assinado.xml.trimEnd().endsWith('</NFe>')).toBe(true);
  });

  it('a referência aponta para o Id do infNFe', () => {
    const assinado = assinarVenda();
    const id = /Id="(NFe\d{44})"/.exec(assinado.xml)![1];
    expect(assinado.xml).toContain(`<Reference URI="#${id}">`);
  });
});

describe('adulteração é detectada', () => {
  /** O caso que dá dinheiro: mudar o valor depois de assinar. */
  it('trocar um centavo no total derruba a verificação', () => {
    const assinado = assinarVenda();
    const adulterado = assinado.xml.replace('<vNF>100.00</vNF>', '<vNF>100.01</vNF>');
    expect(adulterado).not.toBe(assinado.xml);

    const r = verifyNfceSignature(adulterado);
    expect(r.valid).toBe(false);
    expect(r.digestMatches).toBe(false);
    expect(r.reason).toMatch(/alterado depois da assinatura/i);
  });

  it('trocar a descrição do produto derruba a verificação', () => {
    const assinado = assinarVenda();
    const adulterado = assinado.xml.replace('Camisa Social', 'Televisao 50 polegadas');
    expect(verifyNfceSignature(adulterado).valid).toBe(false);
  });

  it('trocar a quantidade derruba a verificação', () => {
    const assinado = assinarVenda();
    const adulterado = assinado.xml.replace('<qCom>2.0000</qCom>', '<qCom>1.0000</qCom>');
    expect(verifyNfceSignature(adulterado).valid).toBe(false);
  });

  it('trocar o CNPJ do emitente derruba a verificação', () => {
    const assinado = assinarVenda();
    const adulterado = assinado.xml.replace('11222333000181', '99888777000166');
    expect(verifyNfceSignature(adulterado).valid).toBe(false);
  });

  /**
   * O ataque mais interessante: recalcular o digest para casar com o conteúdo
   * novo. Sem a chave privada, a assinatura do SignedInfo não fecha.
   */
  it('recalcular o digest sem a chave não salva o documento', () => {
    const assinado = assinarVenda();
    const adulterado = assinado.xml.replace('<vNF>100.00</vNF>', '<vNF>1.00</vNF>');
    // Digest do conteúdo NOVO, produzido por quem não tem a chave — em C14N 1.0
    // de verdade (libxml2), como um atacante competente faria (GAP-PRD-003).
    const doc = XmlDocument.fromString(adulterado);
    const canonico = doc
      .get("//*[local-name()='infNFe']")!
      .canonicalizeToString({ mode: XmlC14NMode.XML_C14N_1_0 });
    doc.dispose();
    const novoDigest = createHash('sha1').update(canonico, 'utf8').digest('base64');

    const forjado = adulterado.replace(
      /<DigestValue>[^<]*<\/DigestValue>/,
      `<DigestValue>${novoDigest}</DigestValue>`,
    );

    const r = verifyNfceSignature(forjado);
    expect(r.digestMatches).toBe(true); // o digest passou a bater...
    expect(r.signatureMatches).toBe(false); // ...mas a assinatura não fecha.
    expect(r.valid).toBe(false);
  });

  it('assinatura de outro certificado não vale para este documento', () => {
    const { xml } = buildNfceXml({ sale: { ...venda, companyId }, config, serie: 1, number: 1 });
    const porA = signNfceXml(xml, certA);
    const porB = signNfceXml(xml, certB);

    // Troca só o valor da assinatura, mantendo o certificado de A no KeyInfo.
    const valorDeB = /<SignatureValue>([^<]*)<\/SignatureValue>/.exec(porB.xml)![1];
    const misturado = porA.xml.replace(
      /<SignatureValue>[^<]*<\/SignatureValue>/,
      `<SignatureValue>${valorDeB}</SignatureValue>`,
    );

    const r = verifyNfceSignature(misturado);
    expect(r.signatureMatches).toBe(false);
    expect(r.valid).toBe(false);
  });
});

describe('documento sem assinatura', () => {
  it('XML não assinado não passa na verificação', () => {
    const { xml } = buildNfceXml({ sale: { ...venda, companyId }, config, serie: 1, number: 1 });
    const r = verifyNfceSignature(xml);
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/sem assinatura/i);
  });

  it('XML sem infNFe é recusado ao assinar', () => {
    expect(() => signNfceXml('<NFe></NFe>', certA)).toThrow(/infNFe/);
  });
});

describe('segredo não vaza', () => {
  it('nem a chave privada nem o PEM completo aparecem no XML assinado', () => {
    const assinado = assinarVenda();
    expect(assinado.xml).not.toContain('PRIVATE KEY');
    expect(assinado.xml).not.toContain(certA.keyPem.slice(50, 120));
    // O certificado PÚBLICO vai no XML — é o esperado e não é segredo.
    expect(assinado.xml).toContain('<X509Certificate>');
    expect(assinado.xml).not.toContain('-----BEGIN CERTIFICATE-----');
  });
});

describe('limitações declaradas', () => {
  /**
   * O que este módulo NÃO faz precisa estar escrito, não descoberto na
   * homologação.
   */
  /*
    Até o GAP-PRD-003 esta lista confessava a "canonicalização simplificada".
    A C14N passou a ser da xml-crypto, conferida contra a libxml2
    (fiscal-assinatura-c14n.test.ts) — a confissão saiu, e o que continua
    dependendo de fora continua escrito.
  */
  it('o que ainda depende de fora está registrado — e a C14N simplificada não está mais', () => {
    expect(SIGNER_LIMITATIONS.length).toBeGreaterThan(0);
    expect(SIGNER_LIMITATIONS.join(' ')).toMatch(/SHA-1/);
    expect(SIGNER_LIMITATIONS.join(' ')).toMatch(/homologação/i);
    expect(SIGNER_LIMITATIONS.join(' ')).not.toMatch(/simplificada/i);
  });
});

