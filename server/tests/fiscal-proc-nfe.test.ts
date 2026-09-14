/**
 * ============================================================================
 * O procNFe TEM QUE PROVAR AUTORIZAÇÃO — OU NÃO EXISTIR
 * ============================================================================
 *
 * O `nfeProc` é o arquivo que o contador guarda: a nota assinada mais o
 * protocolo da SEFAZ, num arquivo só. Ele tem duas maneiras de sair errado, e
 * as DUAS produzem um arquivo que abre, que parece completo, e que não vale
 * nada:
 *
 *   1. COMPOR A `<NFe>` A PARTIR DA RESPOSTA DA SEFAZ. A resposta guardada em
 *      `xml_authorized` passou por `sanitizeResponse`, que troca o conteúdo de
 *      `<SignatureValue>` por "[removido]" — de propósito, para não guardar
 *      segredo no banco. Um procNFe montado dali sai com a assinatura
 *      mutilada, e nenhum validador o aceita. O erro só apareceria na
 *      fiscalização, sobre um arquivo que ninguém mais tem como refazer.
 *
 *   2. COMPLETAR O QUE FALTA. Faltando o protocolo, a saída "prática" seria
 *      escrever um `<protNFe>` com as colunas soltas que o documento tem. Isso
 *      é fabricar prova de autorização.
 *
 * Este arquivo cobra as duas recusas, e a primeira é cobrada do jeito que dói:
 * a resposta usada nos casos abaixo passa DE VERDADE por `sanitizeResponse` —
 * não por uma string escrita à mão que finge estar higienizada.
 *
 * COMO ELE FALHA (medido, quebrando de propósito):
 *   - trocando `input.xmlAssinado` por `input.protocolo` no recorte da `<NFe>`
 *     dentro de `montarProcNfe`, o primeiro caso fica vermelho com
 *     "[removido]" no lugar da assinatura;
 *   - apagando a conferência de `nProt`, o caso da rejeição passa a devolver
 *     um documento e fica vermelho.
 */
import { describe, expect, it } from 'vitest';
import { montarProcNfe } from '../src/services/core/FiscalProcNfe.js';
import { sanitizeResponse } from '../src/services/core/SefazAdapter.js';

const CHAVE = '35260714200166000187550010000010241000010248';
const ASSINATURA = 'k3JhZ2FvIGRlIGFzc2luYXR1cmEgcmVhbCBkbyBjZXJ0aWZpY2Fkbw==';

/** A nota como ela fica em `xml_signed`: com a assinatura de verdade. */
const XML_ASSINADO = `<?xml version="1.0" encoding="UTF-8"?>
<NFe xmlns="http://www.portalfiscal.inf.br/nfe">
  <infNFe versao="4.00" Id="NFe${CHAVE}">
    <ide><nNF>1024</nNF><serie>1</serie></ide>
    <emit><CNPJ>14200166000187</CNPJ></emit>
  </infNFe>
  <Signature xmlns="http://www.w3.org/2000/09/xmldsig#">
    <SignatureValue>${ASSINATURA}</SignatureValue>
    <KeyInfo><X509Data><X509Certificate>MIIF-certificado-inteiro</X509Certificate></X509Data></KeyInfo>
  </Signature>
</NFe>`;

/**
 * A resposta da SEFAZ como ela CHEGA — e, logo abaixo, como ela é GUARDADA.
 *
 * Repare que a resposta traz a nota inteira embutida. É essa cópia que
 * tentaria substituir a original, e é ela que sai higienizada.
 */
const RESPOSTA_CRUA = `<retEnviNFe versao="4.00">
  <cStat>104</cStat><xMotivo>Lote processado</xMotivo>
  <protNFe versao="4.00"><infProt>
    <tpAmb>1</tpAmb><chNFe>${CHAVE}</chNFe>
    <dhRecbto>2026-07-14T10:32:11-03:00</dhRecbto>
    <nProt>135260000123456</nProt>
    <digVal>Yz0xMjM0NTY3ODkw</digVal>
    <cStat>100</cStat><xMotivo>Autorizado o uso da NF-e</xMotivo>
  </infProt></protNFe>
  ${XML_ASSINADO.replace('<?xml version="1.0" encoding="UTF-8"?>\n', '')}
</retEnviNFe>`;

/** É ISTO que o banco guarda em `xml_authorized`. */
const XML_AUTHORIZED = sanitizeResponse(RESPOSTA_CRUA);

describe('a assinatura sobrevive', () => {
  it('a resposta guardada REALMENTE perde a assinatura — a armadilha existe', () => {
    /*
      Sem este caso, todos os outros seriam sobre um perigo hipotético. Ele
      prova que `sanitizeResponse` mutila a assinatura de verdade, e é o que dá
      sentido a exigir `xml_signed` no caso seguinte.
    */
    expect(XML_AUTHORIZED).toContain('<SignatureValue>[removido]</SignatureValue>');
    expect(XML_AUTHORIZED).not.toContain(ASSINATURA);
  });

  it('o procNFe sai com a assinatura ORIGINAL, nunca com "[removido]"', () => {
    const proc = montarProcNfe({ xmlAssinado: XML_ASSINADO, protocolo: XML_AUTHORIZED })!;

    expect(proc).toContain(`<SignatureValue>${ASSINATURA}</SignatureValue>`);
    expect(proc).not.toContain('[removido]');
  });

  it('junta as duas metades e nada mais', () => {
    const proc = montarProcNfe({ xmlAssinado: XML_ASSINADO, protocolo: XML_AUTHORIZED })!;

    expect(proc.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(proc).toContain('<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">');
    expect(proc.trimEnd().endsWith('</nfeProc>')).toBe(true);
    expect(proc).toContain('<nProt>135260000123456</nProt>');
    // A nota entra UMA vez: a cópia embutida na resposta não pode vir junto.
    expect(proc.match(/<infNFe\b/g)).toHaveLength(1);
    // E o envelope da resposta fica de fora — o que se guarda é o documento.
    expect(proc).not.toContain('retEnviNFe');
  });
});

describe('metade faltando, arquivo nenhum', () => {
  it('sem XML assinado devolve null', () => {
    expect(montarProcNfe({ xmlAssinado: null, protocolo: XML_AUTHORIZED })).toBeNull();
    expect(montarProcNfe({ xmlAssinado: '   ', protocolo: XML_AUTHORIZED })).toBeNull();
  });

  it('sem protocolo devolve null', () => {
    expect(montarProcNfe({ xmlAssinado: XML_ASSINADO, protocolo: null })).toBeNull();
  });

  it('resposta SEM protNFe devolve null, mesmo trazendo cStat de sucesso', () => {
    const semProt = '<retEnviNFe><cStat>104</cStat><xMotivo>Lote processado</xMotivo></retEnviNFe>';
    expect(montarProcNfe({ xmlAssinado: XML_ASSINADO, protocolo: semProt })).toBeNull();
  });

  it('REJEIÇÃO não vira documento autorizado', () => {
    /*
      O caso mais traiçoeiro dos cinco. A recusa TAMBÉM chega dentro de um
      `<protNFe>` — com cStat de rejeição e sem `nProt`. Um recorte que só
      procurasse o elemento montaria um "nfeProc" para uma nota que a SEFAZ
      não autorizou, e ele iria para a contabilidade como se valesse.
    */
    const rejeicao = `<retEnviNFe><protNFe><infProt>
      <chNFe>${CHAVE}</chNFe><cStat>539</cStat>
      <xMotivo>Rejeicao: duplicidade de NF-e</xMotivo>
    </infProt></protNFe></retEnviNFe>`;

    expect(rejeicao).toContain('protNFe');
    expect(montarProcNfe({ xmlAssinado: XML_ASSINADO, protocolo: rejeicao })).toBeNull();
  });

  it('nProt vazio também é ausência de protocolo', () => {
    const vazio = `<retEnviNFe><protNFe><infProt><nProt>   </nProt></infProt></protNFe></retEnviNFe>`;
    expect(montarProcNfe({ xmlAssinado: XML_ASSINADO, protocolo: vazio })).toBeNull();
  });
});

describe('o que vem de fora não vem no formato de casa', () => {
  it('aceita prefixo de namespace no protNFe e na NFe', () => {
    /*
      Cada autorizador serializa o envelope do seu jeito, e vários usam prefixo
      (`ns2:`, `soap:`). Um recorte que só conhecesse `<protNFe>` devolveria
      null para uma resposta perfeitamente válida — a pior falha possível aqui,
      porque ela tem cara de "não há protocolo".
    */
    const comPrefixo = `<ns2:retEnviNFe xmlns:ns2="http://www.portalfiscal.inf.br/nfe">
      <ns2:protNFe><ns2:infProt><ns2:nProt>135260000999999</ns2:nProt></ns2:infProt></ns2:protNFe>
    </ns2:retEnviNFe>`;
    const assinadoComPrefixo = `<ns2:NFe><ns2:infNFe Id="NFe${CHAVE}"/>
      <ns2:Signature><ns2:SignatureValue>${ASSINATURA}</ns2:SignatureValue></ns2:Signature></ns2:NFe>`;

    const proc = montarProcNfe({
      xmlAssinado: assinadoComPrefixo,
      protocolo: comPrefixo,
    })!;
    expect(proc).toContain('<ns2:nProt>135260000999999</ns2:nProt>');
    expect(proc).toContain(ASSINATURA);
  });

  it('não confunde infNFe com NFe ao recortar', () => {
    // `<infNFe` contém a sequência "NFe". Um recorte sem âncora começaria no
    // elemento errado e cortaria a assinatura fora do arquivo.
    const proc = montarProcNfe({ xmlAssinado: XML_ASSINADO, protocolo: XML_AUTHORIZED })!;
    const inicio = proc.indexOf('<NFe');
    const infInicio = proc.indexOf('<infNFe');
    expect(inicio).toBeGreaterThan(-1);
    expect(inicio).toBeLessThan(infInicio);
  });
});
