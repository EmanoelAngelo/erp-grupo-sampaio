/**
 * ASSINATURA vs XML TRANSMITIDO — GAP-PRD-003.
 *
 * O harness da auditoria (b4-fiscal-e2e-nfce, apagado) mediu: o `signedXml`
 * entregue ao adapter tinha quebra de linha e indentação entre as tags, e o
 * DigestValue era o SHA-1 do fragmento `infNFe` COM OS ESPAÇOS APAGADOS e SEM
 * o `xmlns` herdado do `<NFe>` — nem o SHA-1 do que foi transmitido, nem o do
 * Canonical XML. A SEFAZ canonicaliza o que recebe e recalcula: o digest não
 * bateria em nota nenhuma (297), e os espaços entre as tags já seriam a 588.
 *
 * ## O juiz aqui NÃO é a biblioteca que assina
 *
 * O assinador usa a `xml-crypto`. A conferência abaixo canonicaliza com a
 * LIBXML2 (a C14N do `xmlsec1` e do `xmllint --c14n`), por outro caminho de
 * código, sobre os BYTES QUE O ADAPTER POE NO ENVELOPE SOAP — e só então
 * compara com o DigestValue e confere a assinatura do SignedInfo com a chave
 * pública do certificado. Se os dois canonicalizadores discordassem, este
 * arquivo ficaria vermelho.
 *
 * ## Como cada guarda falha (quebrando de propósito)
 *
 *  - volte o `canonicalize` antigo (apagar `>\s+<` e resumir o fragmento): o
 *    digest deixa de ser o da libxml2 — vermelho em "o DigestValue é o SHA-1
 *    da C14N";
 *  - tire o `compactarXmlFiscal` do assinador: o XML transmitido volta a ter
 *    caracteres de edição entre as tags — vermelho em "compacto";
 *  - ponha a Signature antes do `infNFeSupl`: o XSD recusa — vermelho no
 *    leiaute do documento assinado.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import forge from 'node-forge';
import { createHash, createVerify } from 'node:crypto';
import { XmlC14NMode, XmlDocument } from 'libxml2-wasm';
import { resetDbForTests } from '../src/db/database.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import { updateFiscalConfig, type FiscalConfig } from '../src/services/core/FiscalConfigService.js';
import { buildNfceXml, type NfceSale } from '../src/services/core/FiscalXmlNfce.js';
import { buildNfeXml, type NfeRecipient } from '../src/services/core/FiscalXmlNfe.js';
import {
  PERFIL_XMLDSIG,
  signNfceXml,
  signXmlElement,
  verifyNfceSignature,
  verifyXmlElementSignature,
} from '../src/services/core/FiscalSigner.js';
import { temEspacoEntreTags } from '../src/services/core/FiscalXmlForma.js';
import { validarXmlContraXsd } from '../src/services/core/FiscalXsdValidator.js';
import { SefazRealAdapter } from '../src/services/core/SefazRealAdapter.js';
import type { ParsedCertificateA1 } from '../src/services/fiscal/FiscalCertificateService.js';
import { grupoTributarioPadrao } from './helpers/grupoTributario.js';

const NS_NFE = 'http://www.portalfiscal.inf.br/nfe';

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
  } as ParsedCertificateA1;
}

// ------------------------------------------------------------ o oráculo

/** C14N 1.0 do primeiro elemento `nome`, pela libxml2, no contexto do documento. */
function c14nLibxml2(xml: string, nome: string): string {
  const doc = XmlDocument.fromString(xml);
  try {
    const el = doc.get(`//*[local-name()='${nome}']`);
    if (!el) throw new Error(`sem ${nome}`);
    return el.canonicalizeToString({ mode: XmlC14NMode.XML_C14N_1_0 });
  } finally {
    doc.dispose();
  }
}

const sha1b64 = (s: string) => createHash('sha1').update(s, 'utf8').digest('base64');
const tag = (xml: string, nome: string) =>
  new RegExp(`<${nome}>([^<]*)</${nome}>`).exec(xml)?.[1] ?? '';

/**
 * A conferência completa, só com libxml2 + node:crypto: o digest do elemento
 * referenciado e a assinatura do SignedInfo com a chave do X509Certificate.
 */
function conferirPorFora(xml: string, alvo: string): { digestOk: boolean; assinaturaOk: boolean } {
  const digestOk = sha1b64(c14nLibxml2(xml, alvo)) === tag(xml, 'DigestValue');
  const pem = `-----BEGIN CERTIFICATE-----\n${tag(xml, 'X509Certificate').replace(/(.{64})/g, '$1\n')}\n-----END CERTIFICATE-----`;
  const v = createVerify('RSA-SHA1');
  v.update(c14nLibxml2(xml, 'SignedInfo'), 'utf8');
  v.end();
  return { digestOk, assinaturaOk: v.verify(pem, tag(xml, 'SignatureValue'), 'base64') };
}

// ------------------------------------------------------------ o cenário

let cert: ParsedCertificateA1;
let companyId: string;
let config: FiscalConfig;

const venda = (): NfceSale => ({
  id: 'sale-c14n',
  number: 7,
  companyId,
  createdAt: '2026-09-10T12:00:00.000Z',
  subtotalCents: 12_990,
  discountCents: 0,
  surchargeCents: 0,
  totalCents: 12_990,
  changeCents: 0,
  customerId: null,
  customerDocument: null,
  customerName: null,
  items: [
    {
      productId: 'p1',
      // Espaço DUPLO e acento dentro do valor: C14N preserva texto — é isso
      // que o antigo "apagar espaços" ameaçava.
      description: 'Camisa  Social Algodão & Linho',
      quantity: 1,
      unitPriceCents: 12_990,
      discountCents: 0,
      totalCents: 12_990,
      ncm: '62052000',
      cest: null,
      cfop: '5102',
      origin: '0',
      unit: 'UN',
      barcode: '7891234567895',
      internalCode: 'GS-0001',
      taxProfile: null,
    },
  ],
  payments: [{ method: 'pix', amountCents: 12_990 }],
});

const DESTINATARIO: NfeRecipient = {
  document: '11144477735',
  name: 'Cliente de Teste',
  ieIndicator: '9',
  ie: null,
  street: 'Rua das Flores',
  number: '10',
  district: 'Centro',
  cityIbge: '4314407',
  cityName: 'Pelotas',
  uf: 'RS',
  zip: '96010000',
} as NfeRecipient;

beforeAll(() => {
  cert = gerarCertificado('PRECO JUSTO LTDA:11222333000181');
}, 60_000);

beforeEach(() => {
  resetDbForTests();
  companyId = upsertCompany({ slug: 'preco-justo', legalName: 'Preço Justo Ltda', tradeName: 'Preço Justo' });
  config = updateFiscalConfig({
    companyId,
    patch: {
      legalName: 'Preço Justo Comércio Ltda',
      cnpj: '11.222.333/0001-81',
      ie: '0960012345',
      crt: '1',
      street: 'Av. Central',
      number: '100',
      district: 'Centro',
      cityName: 'Pelotas',
      cityIbge: '4314407',
      uf: 'RS',
      zip: '96010-000',
    },
  });
  grupoTributarioPadrao(companyId);
});

function nfceAssinada() {
  const { xml, accessKey } = buildNfceXml({ sale: venda(), config, serie: 1, number: 7 });
  return { original: xml, accessKey, ...signNfceXml(xml, cert) };
}

// ------------------------------------------------------------ os testes

describe('o XML assinado é o XML que viaja', () => {
  it('sai COMPACTO: nenhum caractere de edição entre as tags (rejeição 588)', () => {
    const { original, xml } = nfceAssinada();
    // O gerador continua indentado — a compactação é do caminho de assinatura.
    expect(temEspacoEntreTags(original)).toBe(true);
    expect(temEspacoEntreTags(xml)).toBe(false);
    expect(xml).not.toMatch(/<\/ide>\s*\n\s+<emit>/);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?><NFe xmlns=')).toBe(true);
  });

  it('o texto dos campos NÃO é tocado: espaço duplo e & sobrevivem', () => {
    const { xml } = nfceAssinada();
    expect(xml).toContain('<xProd>Camisa  Social Algodão &amp; Linho</xProd>');
  });

  it('a Signature é a última filha de NFe, sem prefixo, depois do infNFeSupl', () => {
    const { xml } = nfceAssinada();
    expect(xml).toMatch(/<\/infNFeSupl><Signature xmlns="http:\/\/www\.w3\.org\/2000\/09\/xmldsig#">/);
    expect(xml.endsWith('</Signature></NFe>')).toBe(true);
    expect(xml).not.toMatch(/<ds:/);
  });

  it('o SignedInfo declara o perfil do leiaute: C14N 1.0, RSA-SHA1, SHA-1, as duas transformações', () => {
    const { xml, accessKey } = nfceAssinada();
    expect(xml).toContain(`<CanonicalizationMethod Algorithm="${PERFIL_XMLDSIG.canonicalizacao}"/>`);
    expect(xml).toContain(`<SignatureMethod Algorithm="${PERFIL_XMLDSIG.assinatura}"/>`);
    expect(xml).toContain(`<Reference URI="#NFe${accessKey}">`);
    expect(xml).toContain(
      `<Transforms><Transform Algorithm="${PERFIL_XMLDSIG.transformacoes[0]}"/>`
        + `<Transform Algorithm="${PERFIL_XMLDSIG.transformacoes[1]}"/></Transforms>`,
    );
    expect(xml).toContain(`<DigestMethod Algorithm="${PERFIL_XMLDSIG.digest}"/>`);
  });
});

describe('o digest é o que a SEFAZ vai recalcular (C14N pela libxml2)', () => {
  it('a C14N do infNFe renderiza o xmlns HERDADO e os atributos em ordem', () => {
    const { xml, accessKey } = nfceAssinada();
    const canonico = c14nLibxml2(xml, 'infNFe');
    expect(canonico.startsWith(`<infNFe xmlns="${NS_NFE}" Id="NFe${accessKey}" versao="4.00">`)).toBe(true);
  });

  it('o DigestValue é o SHA-1 da C14N 1.0 do infNFe — e não o do fragmento sem espaços', () => {
    const { xml, digestValue, original } = nfceAssinada();
    expect(digestValue).toBe(sha1b64(c14nLibxml2(xml, 'infNFe')));

    // A conta da versão antiga, reproduzida: fragmento recortado por regex,
    // espaços entre tags apagados, sem o xmlns herdado. Ela NÃO pode bater.
    const fragmentoAntigo = /<infNFe\b[\s\S]*?<\/infNFe>/.exec(original)![0].replace(/>\s+</g, '><');
    expect(digestValue).not.toBe(sha1b64(fragmentoAntigo));
  });

  it('a assinatura do SignedInfo confere com a chave pública do certificado, por fora da xml-crypto', () => {
    const { xml } = nfceAssinada();
    expect(conferirPorFora(xml, 'infNFe')).toEqual({ digestOk: true, assinaturaOk: true });
  });

  it('o verificador do sistema concorda com o oráculo', () => {
    const { xml } = nfceAssinada();
    expect(verifyNfceSignature(xml)).toMatchObject({ valid: true, digestMatches: true, signatureMatches: true });
  });

  it('mexer em UM espaço dentro de um valor derruba o digest — texto é conteúdo', () => {
    const { xml } = nfceAssinada();
    const adulterado = xml.replace('Camisa  Social', 'Camisa Social');
    expect(conferirPorFora(adulterado, 'infNFe').digestOk).toBe(false);
    expect(verifyNfceSignature(adulterado)).toMatchObject({ valid: false, digestMatches: false });
  });

  it('reassinar o que já foi assinado não empilha assinatura nem muda a forma', () => {
    const { original } = nfceAssinada();
    const a = signNfceXml(original, cert);
    const b = signNfceXml(original, cert);
    // RSA PKCS#1 v1.5 é determinístico: mesmo documento, mesma chave, mesmos bytes.
    expect(b.xml).toBe(a.xml);
    expect(a.xml.match(/<Signature /g)).toHaveLength(1);
  });
});

describe('o que o adapter real põe no envelope (os bytes da SEFAZ)', () => {
  it('o enviNFe inteiro é compacto e o digest confere sobre a NFe extraída do envelope', async () => {
    const { xml, accessKey, digestValue } = nfceAssinada();
    const corpos: string[] = [];
    const adapter = new SefazRealAdapter({
      cert,
      postSoap: async (input) => {
        corpos.push(input.body);
        return { status: 200, body: '<retEnviNFe><cStat>104</cStat><xMotivo>Lote processado</xMotivo></retEnviNFe>' };
      },
    });

    await adapter.authorize({
      companyId,
      documentId: 'doc-1',
      accessKey,
      signedXml: xml,
      uf: 'RS',
      environment: 'homologation',
      model: '65',
    });

    expect(corpos).toHaveLength(1);
    const corpo = corpos[0];
    // Nenhum caractere de edição em lugar nenhum da mensagem.
    expect(corpo).not.toMatch(/>\s+</);

    // A NFe que viajou é, byte a byte, a que foi assinada (sem a declaração).
    const nfeNoEnvelope = /<NFe xmlns="[^"]+">[\s\S]*<\/NFe>/.exec(corpo)![0];
    expect(nfeNoEnvelope).toBe(xml.replace(/^<\?xml[^?]*\?>/, ''));

    // A SEFAZ recorta a NFe do lote e canonicaliza: tanto a NFe isolada quanto
    // o enviNFe isolado dão o MESMO digest que foi assinado.
    expect(sha1b64(c14nLibxml2(nfeNoEnvelope, 'infNFe'))).toBe(digestValue);
    const enviNFe = /<enviNFe[\s\S]*<\/enviNFe>/.exec(corpo)![0];
    expect(sha1b64(c14nLibxml2(enviNFe, 'infNFe'))).toBe(digestValue);
    expect(conferirPorFora(nfeNoEnvelope, 'infNFe')).toEqual({ digestOk: true, assinaturaOk: true });

    // E o lote, como viajou, cumpre o XSD oficial do enviNFe.
    expect(validarXmlContraXsd(enviNFe, 'enviNFe')).toMatchObject({ validated: true, problems: [] });
  });
});

describe('o documento assinado cumpre o leiaute — com a assinatura REAL', () => {
  it('NFC-e 65 assinada passa no nfe_v4.00.xsd', () => {
    const { xml } = nfceAssinada();
    expect(validarXmlContraXsd(xml, 'nfe')).toMatchObject({ validated: true, wellFormed: true, problems: [] });
  });

  it('NF-e 55 assinada passa no nfe_v4.00.xsd e confere por fora', () => {
    const { xml } = buildNfeXml({ sale: venda(), config, recipient: DESTINATARIO, serie: 1, number: 3 });
    const assinada = signNfceXml(xml, cert);
    expect(validarXmlContraXsd(assinada.xml, 'nfe')).toMatchObject({ validated: true, problems: [] });
    expect(conferirPorFora(assinada.xml, 'infNFe')).toEqual({ digestOk: true, assinaturaOk: true });
  });

  it('assinatura fora do lugar (antes do infNFeSupl) é recusada pelo XSD', () => {
    const { xml } = nfceAssinada();
    const assinatura = /<Signature [\s\S]*<\/Signature>/.exec(xml)![0];
    const foraDoLugar = xml.replace(assinatura, '').replace('<infNFeSupl>', `${assinatura}<infNFeSupl>`);
    const r = validarXmlContraXsd(foraDoLugar, 'nfe');
    expect(r.validated).toBe(true);
    expect(r.problems.join(' ')).toMatch(/infNFeSupl|Signature/);
  });
});

describe('o mesmo motor assina eventos e inutilização', () => {
  it('evento (infEvento dentro de evento, dentro de envEvento): C14N confere por fora', () => {
    const chave = '43260911222333000181650010000000071000000070';
    const xml =
      `<envEvento xmlns="${NS_NFE}" versao="1.00"><idLote>1</idLote>`
      + `<evento xmlns="${NS_NFE}" versao="1.00"><infEvento Id="ID110111${chave}01">`
      + '<cOrgao>43</cOrgao><tpAmb>2</tpAmb><CNPJ>11222333000181</CNPJ>'
      + `<chNFe>${chave}</chNFe><dhEvento>2026-09-10T10:00:00-03:00</dhEvento>`
      + '<tpEvento>110111</tpEvento><nSeqEvento>1</nSeqEvento><verEvento>1.00</verEvento>'
      + '<detEvento versao="1.00"><descEvento>Cancelamento</descEvento>'
      + '<nProt>143260000000001</nProt><xJust>Venda cancelada a pedido do cliente</xJust></detEvento>'
      + '</infEvento></evento></envEvento>';
    const assinado = signXmlElement(xml, { tagName: 'infEvento', closeParentTag: '</evento>' }, cert);
    expect(assinado.xml).toMatch(/<\/infEvento><Signature xmlns=/);
    expect(assinado.xml).toMatch(/<\/Signature><\/evento><\/envEvento>$/);
    expect(conferirPorFora(assinado.xml, 'infEvento')).toEqual({ digestOk: true, assinaturaOk: true });
    expect(verifyXmlElementSignature(assinado.xml, 'infEvento').valid).toBe(true);
  });

  it('inutilização pelo adapter real: assinada, conferida por fora e dentro do XSD do inutNFe', async () => {
    const corpos: string[] = [];
    const adapter = new SefazRealAdapter({
      cert,
      postSoap: async (input) => {
        corpos.push(input.body);
        return { status: 200, body: '<retInutNFe><infInut><cStat>102</cStat><xMotivo>Inutilizacao homologada</xMotivo></infInut></retInutNFe>' };
      },
    });
    await adapter.voidNumberRange({
      companyId,
      model: '65',
      serie: 1,
      from: 10,
      to: 12,
      // O autor da inutilização é o emitente do cadastro (GAP-PRD-019).
      cnpj: '11222333000181',
      year: 2026,
      justification: 'Numeracao pulada por falha de energia no caixa',
      uf: 'RS',
      environment: 'homologation',
    });
    const inut = /<inutNFe[\s\S]*<\/inutNFe>/.exec(corpos[0])![0];
    expect(conferirPorFora(inut, 'infInut')).toEqual({ digestOk: true, assinaturaOk: true });
    expect(verifyXmlElementSignature(inut, 'infInut').valid).toBe(true);
    expect(validarXmlContraXsd(inut, 'inutNFe')).toMatchObject({ validated: true, problems: [] });
  });

  it('pai errado é recusa, não palpite', () => {
    const { original } = nfceAssinada();
    expect(() => signXmlElement(original, { tagName: 'infNFe', closeParentTag: '</evento>' }, cert))
      .toThrow(/dentro de <evento>/);
  });

  it('XML mal formado não é assinado', () => {
    expect(() => signNfceXml('<NFe><infNFe Id="NFe1"></NFe>', cert)).toThrow(/mal formado/);
  });
});
