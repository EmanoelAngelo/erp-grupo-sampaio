/**
 * O ADAPTER SEFAZ REAL (RS) — rodada 46.
 *
 * A auditoria descobriu (rodada 36) que o "adapter real" ligado em
 * `fiscalAdapter()` era o SIMULADOR: preencher endereços não transmitia nada.
 * Este arquivo prova o cliente SOAP de verdade — envelopes, assinatura de
 * eventos, parse das respostas, gzip do DF-e — com o TRANSPORTE dublado:
 * o `postSoap` injetado devolve as respostas XML que a SEFAZ devolveria, e
 * cada teste confere o que o adapter MANDOU e o que ele ENTENDEU.
 *
 * A homologação de verdade — bytes na SEFAZ — depende do certificado A1 real
 * e é a parte do dono. O que se trava aqui é tudo o que dá para travar antes:
 *
 *   - TransportFailure é a MESMA classe que a fila reconhece por instanceof —
 *     timeout de autorização nunca vira resposta, vira exceção que força a
 *     consulta antes do retry;
 *   - a decisão é SEMPRE pelo cStat, nunca pelo HTTP;
 *   - a resposta de EVENTO é lida do bloco infEvento — o cStat 128 do LOTE
 *     não pode ser confundido com o desfecho do evento;
 *   - o docZip do DF-e é gzip+base64 DE VERDADE, e o adapter descomprime.
 *
 * ## Como cada guarda falha (quebrando de propósito)
 *
 *   - passe o corpo inteiro do retEvento ao parse e o caso do cancelamento
 *     lê 128 em vez de 135 — vermelho;
 *   - deixe a declaração <?xml?> dentro do enviNFe e o caso da autorização
 *     fica vermelho;
 *   - troque TransportFailure por Error e o caso do timeout fica vermelho.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import forge from 'node-forge';
import { resetDbForTests } from '../src/db/database.js';
import { upsertCertificateA1 } from '../src/services/fiscal/FiscalCertificateService.js';
import {
  SefazRealAdapter,
  endpointAmbienteNacional,
  resolverEndpointReal,
} from '../src/services/core/SefazRealAdapter.js';
import { adapterDoAtoFiscal } from '../src/services/core/FiscalAtosAdministrativos.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import { TransportFailure } from '../src/services/core/SefazTestAdapter.js';
import type { ParsedCertificateA1 } from '../src/services/fiscal/FiscalCertificateService.js';

// A chave é do MESMO CNPJ do certificado de teste: o evento é do emitente, e a
// raiz do A1 precisa ser a dele (GAP-PRD-019).
const CHAVE = '43260811222333000181550010000000015123456789';

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

let cert: ParsedCertificateA1;
beforeAll(() => {
  cert = gerarCertificado('EMPRESA TESTE:11222333000181');
});

/** Transporte dublado: grava o que foi mandado e devolve o roteiro. */
function transporte(respostas: Record<string, string>) {
  const chamadas: { url: string; body: string }[] = [];
  const postSoap = async (input: { url: string; body: string }) => {
    chamadas.push({ url: input.url, body: input.body });
    for (const [trecho, corpo] of Object.entries(respostas)) {
      if (input.url.includes(trecho)) return { status: 200, body: corpo };
    }
    return { status: 200, body: '<vazio/>' };
  };
  return { chamadas, postSoap };
}

function adapter(respostas: Record<string, string>) {
  const { chamadas, postSoap } = transporte(respostas);
  return { chamadas, adapter: new SefazRealAdapter({ cert, postSoap }) };
}

describe('os endereços do RS', () => {
  it('homologação e produção resolvem hosts DIFERENTES, nos cinco serviços', () => {
    for (const service of ['status', 'authorize', 'consult', 'event', 'void'] as const) {
      const hom = resolverEndpointReal({ uf: 'RS', model: '55', environment: 'homologation', service });
      const prod = resolverEndpointReal({ uf: 'RS', model: '55', environment: 'production', service });
      expect(hom).toContain('nfe-homologacao.sefazrs.rs.gov.br');
      expect(prod).toContain('nfe.sefazrs.rs.gov.br');
      expect(hom).not.toBe(prod);
    }
  });

  it('NFC-e (modelo 65) usa os hosts próprios do RS', () => {
    const hom = resolverEndpointReal({ uf: 'RS', model: '65', environment: 'homologation', service: 'authorize' });
    expect(hom).toContain('nfce-homologacao.sefazrs.rs.gov.br');
  });

  it('o Ambiente Nacional tem endereço próprio para DF-e e manifestação', () => {
    expect(endpointAmbienteNacional('homologation', 'dist')).toContain('hom');
    expect(endpointAmbienteNacional('production', 'dist')).toContain('www1.nfe.fazenda.gov.br');
    expect(endpointAmbienteNacional('production', 'evento')).toContain('www1.nfe.fazenda.gov.br');
  });

  it('UF sem tabela é recusada com o 501 explicado — não se chuta endereço fiscal', () => {
    expect(() =>
      resolverEndpointReal({ uf: 'AC', model: '55', environment: 'homologation', service: 'status' }),
    ).toThrowError(/endpoint/i);
  });
});

describe('status do serviço', () => {
  it('monta o consStatServ com a UF 43 e o tpAmb do ambiente, e lê o 107 como online', async () => {
    const { chamadas, adapter: a } = adapter({
      NfeStatusServico:
        '<retConsStatServ><cStat>107</cStat><xMotivo>Servico em Operacao</xMotivo><tMed>1</tMed></retConsStatServ>',
    });
    const r = await a.statusServico({ uf: 'RS', environment: 'homologation' });
    expect(r.online).toBe(true);
    expect(r.cStat).toBe('107');
    expect(r.source).toBe('sefaz');

    const corpo = chamadas[0].body;
    expect(corpo).toContain('<cUF>43</cUF>');
    expect(corpo).toContain('<tpAmb>2</tpAmb>');
    expect(corpo).toContain('<xServ>STATUS</xServ>');
  });
});

describe('autorização', () => {
  const XML_ASSINADO = `<?xml version="1.0" encoding="UTF-8"?><NFe xmlns="http://www.portalfiscal.inf.br/nfe"><infNFe Id="NFe${CHAVE}" versao="4.00"><ide/></infNFe></NFe>`;

  function respostaAutorizada() {
    return (
      '<retEnviNFe><cStat>104</cStat><xMotivo>Lote processado</xMotivo><protNFe><infProt>'
      + `<chNFe>${CHAVE}</chNFe><cStat>100</cStat><xMotivo>Autorizado o uso da NF-e</xMotivo><nProt>143260000000001</nProt>`
      + '</infProt></protNFe></retEnviNFe>'
    );
  }

  it('embrulha o XML assinado no enviNFe síncrono — SEM a declaração <?xml?> no meio', async () => {
    const { chamadas, adapter: a } = adapter({ NfeAutorizacao: respostaAutorizada() });
    const r = await a.authorize({
      companyId: 'c1',
      documentId: 'd1',
      accessKey: CHAVE,
      signedXml: XML_ASSINADO,
      uf: 'RS',
      environment: 'homologation',
    });
    expect(r.outcome).toBe('AUTHORIZED');
    expect(r.protocol).toBe('143260000000001');

    const corpo = chamadas[0].body;
    expect(corpo).toContain('<indSinc>1</indSinc>');
    expect(corpo).toContain(`<infNFe Id="NFe${CHAVE}"`);
    // Declaração XML no meio do envelope é XML inválido — a SEFAZ recusaria.
    const depoisDoEnvelope = corpo.slice(corpo.indexOf('<enviNFe'));
    expect(depoisDoEnvelope).not.toContain('<?xml');
  });

  it('rejeição vem do cStat do DOCUMENTO — 539 vira DUPLICATE, nunca autorizado', async () => {
    const { adapter: a } = adapter({
      NfeAutorizacao:
        '<retEnviNFe><cStat>104</cStat><protNFe><infProt>'
        + `<chNFe>${CHAVE}</chNFe><cStat>539</cStat><xMotivo>Duplicidade</xMotivo>`
        + '</infProt></protNFe></retEnviNFe>',
    });
    const r = await a.authorize({
      companyId: 'c1',
      documentId: 'd1',
      accessKey: CHAVE,
      signedXml: XML_ASSINADO,
      uf: 'RS',
      environment: 'homologation',
    });
    expect(r.outcome).toBe('DUPLICATE');
    expect(r.protocol).toBeNull();
  });

  it('timeout LANÇA TransportFailure — a classe que a fila reconhece por instanceof', async () => {
    const a = new SefazRealAdapter({
      cert,
      postSoap: async () => {
        throw new TransportFailure('TIMEOUT', 'demorou demais');
      },
    });
    await expect(
      a.authorize({
        companyId: 'c1',
        documentId: 'd1',
        accessKey: CHAVE,
        signedXml: XML_ASSINADO,
        uf: 'RS',
        environment: 'homologation',
      }),
    ).rejects.toBeInstanceOf(TransportFailure);
  });
});

describe('consulta por chave', () => {
  it('monta o consSitNFe e lê o 217 como NOT_FOUND', async () => {
    const { chamadas, adapter: a } = adapter({
      NfeConsulta:
        '<retConsSitNFe><cStat>217</cStat><xMotivo>NF-e nao consta na base</xMotivo></retConsSitNFe>',
    });
    const r = await a.consult({ companyId: 'c1', accessKey: CHAVE, uf: 'RS', environment: 'homologation' });
    expect(r.outcome).toBe('NOT_FOUND');
    expect(chamadas[0].body).toContain(`<chNFe>${CHAVE}</chNFe>`);
    expect(chamadas[0].body).toContain('<xServ>CONSULTAR</xServ>');
  });
});

describe('cancelamento (evento 110111)', () => {
  function respostaEvento(cStatEvento: string, comProtocolo: boolean) {
    return (
      '<retEnvEvento><idLote>1</idLote><cStat>128</cStat><xMotivo>Lote de Evento Processado</xMotivo>'
      + '<retEvento versao="1.00"><infEvento>'
      + `<chNFe>${CHAVE}</chNFe><tpEvento>110111</tpEvento><cStat>${cStatEvento}</cStat>`
      + `<xMotivo>desfecho</xMotivo>${comProtocolo ? '<nProt>143260000000099</nProt>' : ''}`
      + '</infEvento></retEvento></retEnvEvento>'
    );
  }

  it('o evento vai ASSINADO e a leitura é do infEvento — o 128 do lote não engana', async () => {
    const { chamadas, adapter: a } = adapter({ RecepcaoEvento: respostaEvento('135', true) });
    const r = await a.cancel({
      companyId: 'c1',
      accessKey: CHAVE,
      protocol: '143260000000001',
      justification: 'cancelamento por erro de digitacao',
      uf: 'RS',
      environment: 'homologation',
    });
    // O cStat que importa é o do EVENTO (135), não o do lote (128).
    expect(r.cStat).toBe('135');
    expect(r.protocol).toBe('143260000000099');

    const corpo = chamadas[0].body;
    expect(corpo).toContain('<tpEvento>110111</tpEvento>');
    expect(corpo).toContain('<nProt>143260000000001</nProt>');
    expect(corpo).toContain('cancelamento por erro de digitacao');
    // A assinatura está DENTRO do <evento>, sobre o infEvento.
    const evento = corpo.slice(corpo.indexOf('<evento'), corpo.indexOf('</evento>'));
    expect(evento).toContain('<Signature');
    expect(evento).toContain(`ID110111${CHAVE}01`);
  });

  it('evento rejeitado volta sem protocolo — e o chamador não marca nada', async () => {
    const { adapter: a } = adapter({ RecepcaoEvento: respostaEvento('573', false) });
    const r = await a.cancel({
      companyId: 'c1',
      accessKey: CHAVE,
      protocol: '143260000000001',
      justification: 'cancelamento por erro de digitacao',
      uf: 'RS',
      environment: 'homologation',
    });
    expect(r.cStat).toBe('573');
    expect(r.protocol).toBeNull();
  });
});

describe('inutilização', () => {
  it('o inutNFe vai assinado, com o Id no formato do layout, e o 102 traz protocolo', async () => {
    const { chamadas, adapter: a } = adapter({
      NfeInutilizacao:
        '<retInutNFe><infInut><cStat>102</cStat><xMotivo>Inutilizacao homologada</xMotivo><nProt>143260000000777</nProt></infInut></retInutNFe>',
    });
    const r = await a.voidNumberRange({
      companyId: 'c1',
      model: '55',
      serie: 1,
      from: 10,
      to: 12,
      year: 2026,
      cnpj: '11222333000181',
      justification: 'quebra de sequencia na numeracao',
      uf: 'RS',
      environment: 'homologation',
    });
    expect(r.cStat).toBe('102');
    expect(r.protocol).toBe('143260000000777');

    const corpo = chamadas[0].body;
    expect(corpo).toContain('<xServ>INUTILIZAR</xServ>');
    expect(corpo).toContain('<nNFIni>10</nNFIni>');
    expect(corpo).toContain('<nNFFin>12</nNFFin>');
    expect(corpo).toContain('<Signature');
    // Id = "ID" + cUF + ano(2) + CNPJ(14) + mod(2) + serie(3) + ini(9) + fim(9)
    expect(corpo).toMatch(/Id="ID43\d{2}11222333000181550{0,2}1000000010000000012"/);
  });
});

describe('manifestação do destinatário (Ambiente Nacional)', () => {
  it('o evento 210240 leva a justificativa e vai para o AN — não para o RS', async () => {
    const { chamadas, adapter: a } = adapter({
      'fazenda.gov.br':
        '<retEnvEvento><cStat>128</cStat><retEvento><infEvento>'
        + `<chNFe>${CHAVE}</chNFe><cStat>135</cStat><xMotivo>ok</xMotivo><nProt>891260000000001</nProt>`
        + '</infEvento></retEvento></retEnvEvento>',
    });
    const r = await a.manifest({
      accessKey: CHAVE,
      eventType: '210240',
      justification: 'pedido cancelado antes do envio',
      environment: 'homologation',
    });
    expect(r.cStat).toBe('135');
    expect(r.protocol).toBe('891260000000001');

    expect(chamadas[0].url).toContain('fazenda.gov.br');
    const corpo = chamadas[0].body;
    expect(corpo).toContain('<tpEvento>210240</tpEvento>');
    expect(corpo).toContain('<cOrgao>91</cOrgao>');
    expect(corpo).toContain('pedido cancelado antes do envio');
    expect(corpo).toContain('<Signature');
  });
});

describe('distribuição DF-e (Ambiente Nacional)', () => {
  function docZip(xml: string): string {
    return gzipSync(Buffer.from(xml, 'utf8')).toString('base64');
  }

  it('descomprime o docZip (gzip+base64 DE VERDADE) e corta o sufixo do schema', async () => {
    const resumo = `<resNFe><chNFe>${CHAVE}</chNFe><xNome>Fornecedor</xNome><vNF>10.00</vNF></resNFe>`;
    const { chamadas, adapter: a } = adapter({
      'fazenda.gov.br':
        '<retDistDFeInt><cStat>138</cStat><xMotivo>Documentos localizados</xMotivo>'
        + '<ultNSU>000000000000042</ultNSU><maxNSU>000000000000042</maxNSU>'
        + '<loteDistDFeInt>'
        + `<docZip NSU="000000000000042" schema="resNFe_v1.01">${docZip(resumo)}</docZip>`
        + '</loteDistDFeInt></retDistDFeInt>',
    });
    const r = await a.distributionDFe({ cnpj: '11222333000181', lastNsu: 41, environment: 'homologation' });
    expect(r.cStat).toBe('138');
    expect(r.ultNsu).toBe(42);
    expect(r.docs).toHaveLength(1);
    expect(r.docs[0].nsu).toBe('42');
    expect(r.docs[0].schema).toBe('resNFe');
    expect(r.docs[0].xml).toContain(`<chNFe>${CHAVE}</chNFe>`);

    const corpo = chamadas[0].body;
    expect(corpo).toContain('<ultNSU>000000000000041</ultNSU>');
    expect(corpo).toContain('<CNPJ>11222333000181</CNPJ>');
  });

  it('com accessKey pede a nota específica (consChNFe) — o download que a ciência libera', async () => {
    const proc = `<nfeProc><NFe><infNFe Id="NFe${CHAVE}"/></NFe></nfeProc>`;
    const { chamadas, adapter: a } = adapter({
      'fazenda.gov.br':
        '<retDistDFeInt><cStat>138</cStat><xMotivo>ok</xMotivo><ultNSU>000000000000001</ultNSU>'
        + `<loteDistDFeInt><docZip NSU="000000000000001" schema="procNFe_v4.00">${docZip(proc)}</docZip></loteDistDFeInt>`
        + '</retDistDFeInt>',
    });
    const r = await a.distributionDFe({
      cnpj: '11222333000181',
      lastNsu: 0,
      accessKey: CHAVE,
      environment: 'homologation',
    });
    expect(r.docs[0].schema).toBe('procNFe');
    expect(chamadas[0].body).toContain(`<chNFe>${CHAVE}</chNFe>`);
  });

  it('docZip que é BOMBA de gzip não estoura a memória — o pacote é descartado', async () => {
    // 60 MB de zeros comprimem para ~60 KB: é a forma da bomba.
    const bomba = gzipSync(Buffer.alloc(60 * 1024 * 1024, 0)).toString('base64');
    const { adapter: a } = adapter({
      'fazenda.gov.br':
        '<retDistDFeInt><cStat>138</cStat><xMotivo>ok</xMotivo><ultNSU>000000000000001</ultNSU>'
        + `<loteDistDFeInt><docZip NSU="000000000000001" schema="resNFe_v1.01">${bomba}</docZip></loteDistDFeInt>`
        + '</retDistDFeInt>',
    });
    const r = await a.distributionDFe({ cnpj: '11222333000181', lastNsu: 0, environment: 'homologation' });
    // O lote sobrevive; o pacote venenoso fica de fora e o NSU volta depois.
    expect(r.docs).toHaveLength(0);
    expect(r.cStat).toBe('138');
  });

  it('137 (nada novo) volta sem documentos, sem inventar lote', async () => {
    const { adapter: a } = adapter({
      'fazenda.gov.br':
        '<retDistDFeInt><cStat>137</cStat><xMotivo>Nenhum documento localizado</xMotivo><ultNSU>000000000000042</ultNSU></retDistDFeInt>',
    });
    const r = await a.distributionDFe({ cnpj: '11222333000181', lastNsu: 42, environment: 'homologation' });
    expect(r.cStat).toBe('137');
    expect(r.docs).toHaveLength(0);
  });
});

describe('o contrato com a fila', () => {
  it('isReal é true e o protocolo nunca leva o prefixo de teste', async () => {
    const { adapter: a } = adapter({});
    expect(a.isReal).toBe(true);
    expect(a.name).toContain('real');
  });
});

/*
  A FÁBRICA DO SLOT REAL DO DF-e SAIU (GAP-PRD-168): `adapterRealOuSimulador`
  só abria o A1 com a senha digitada e, sem ela, devolvia o simulador fora de
  produção — com o certificado no cofre, a tela não chegava à SEFAZ. O ato sem
  nota (inutilização, consulta e manifestação DF-e) decide em
  `adapterDoAtoFiscal`, pela política do dono. Os três casos continuam aqui,
  medindo a regra de agora.
*/
describe('a fábrica do ato sem nota (a que o DF-e usa)', () => {
  beforeEach(() => {
    resetDbForTests();
    upsertCompany({ id: 'empresa-x', slug: 'empresa-x', legalName: 'Empresa X Ltda', tradeName: 'Empresa X' });
  });

  /** Um .pfx de verdade, gerado no teste — nada de fixture em disco. */
  function pfxBase64(senha: string): string {
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const certificado = forge.pki.createCertificate();
    certificado.publicKey = keys.publicKey;
    certificado.serialNumber = '02';
    certificado.validity.notBefore = new Date(Date.now() - 86400000);
    certificado.validity.notAfter = new Date(Date.now() + 86400000 * 365);
    const attrs = [{ name: 'commonName', value: 'EMPRESA TESTE:11222333000181' }];
    certificado.setSubject(attrs);
    certificado.setIssuer(attrs);
    certificado.sign(keys.privateKey, forge.md.sha256.create());
    const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [certificado], senha, {
      algorithm: '3des',
    });
    return forge.util.encode64(forge.asn1.toDer(p12).getBytes());
  }

  it('sem A1 no cofre e sem pedido, a recusa diz o que falta — o simulador não entra calado', () => {
    expect(() => adapterDoAtoFiscal({ companyId: 'empresa-x' })).toThrowError(/[Cc]ertificado/);
    // O caminho de desenvolvimento continua existindo, mas só por pedido EXPLÍCITO.
    expect(adapterDoAtoFiscal({ companyId: 'empresa-x', developmentMode: true }).isReal).toBe(false);
  });

  it('com senha e SEM certificado no cofre, a recusa diz o que falta', () => {
    expect(() =>
      adapterDoAtoFiscal({ companyId: 'empresa-x', certificatePassword: 'qualquer' }),
    ).toThrowError(/[Cc]ertificado/);
  });

  it('com o A1 no cofre, o slot real É o cliente SOAP — pela senha selada ou pela digitada', () => {
    upsertCertificateA1({
      companyId: 'empresa-x',
      operationalUnitId: 'unit-default',
      pfxBase64: pfxBase64('Senha@Cofre1'),
      password: 'Senha@Cofre1',
    });

    // Política padrão (cofre): nenhuma senha no pedido, e mesmo assim é a SEFAZ.
    const peloCofre = adapterDoAtoFiscal({ companyId: 'empresa-x' });
    expect(peloCofre.isReal).toBe(true);
    expect(peloCofre.name).toContain('real');

    const pelaSenha = adapterDoAtoFiscal({ companyId: 'empresa-x', certificatePassword: 'Senha@Cofre1' });
    expect(pelaSenha.isReal).toBe(true);

    // Senha errada não abre o cofre — e não cai no simulador em silêncio.
    expect(() =>
      adapterDoAtoFiscal({ companyId: 'empresa-x', certificatePassword: 'errada' }),
    ).toThrowError();
  });
});
