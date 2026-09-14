/**
 * Assinatura XMLDSig do documento fiscal.
 *
 * RODA NO BACKEND, sempre. O .pfx, a senha e a chave privada nunca chegam ao
 * navegador — quem assina no cliente entrega a chave privada a quem abrir o
 * DevTools, e uma chave A1 vazada permite emitir nota em nome da empresa até o
 * certificado ser revogado.
 *
 * O QUE A ASSINATURA GARANTE
 *
 * Que o XML autorizado é exatamente o que foi assinado. Mudar um centavo
 * depois de assinar invalida a assinatura — é essa propriedade que impede
 * alterar a nota entre a emissão e a transmissão. Os testes cobram justamente
 * isso: adulterar valor, produto ou quantidade tem que derrubar a verificação.
 *
 * O PERFIL (GAP-PRD-003)
 *
 * Assinatura enveloped RSA-SHA1 sobre o elemento com `Id` (`infNFe`,
 * `infEvento`, `infInut`), com as duas transformações do leiaute —
 * enveloped-signature e Canonical XML 1.0 — e o certificado do signatário em
 * `KeyInfo/X509Data`. Sem prefixo de namespace: a SEFAZ recusa `ds:`.
 *
 * O TRABALHO DE XMLDSig É DA BIBLIOTECA `xml-crypto` (6.1.2, fixada), e não
 * mais de expressão regular. A versão anterior "canonicalizava" apagando os
 * espaços entre as tags de uma cópia, resumia a cópia e inseria a assinatura
 * no XML indentado original: o digest não era o do documento transmitido, e
 * nem era C14N — faltava o `xmlns` herdado do `<NFe>`, que o Canonical XML
 * renderiza no ápice do elemento assinado. A SEFAZ recalcularia outro digest
 * e recusaria toda nota (297).
 *
 * Agora:
 *
 *  1. o XML é COMPACTADO antes de tudo (`compactarXmlFiscal`) — sem
 *     caracteres de edição entre as tags, que já seriam a rejeição 588;
 *  2. a `xml-crypto` canonicaliza o elemento em C14N 1.0 de verdade (xmlns
 *     herdado, atributos ordenados, texto preservado), resume, monta o
 *     SignedInfo, canonicaliza o SignedInfo e assina;
 *  3. o XML devolvido é o MESMO que foi resumido, com a Signature inserida
 *     como a última filha do pai do elemento assinado — e é ele que se grava
 *     e se transmite.
 *
 * A prova de que o digest é o que a SEFAZ vai recalcular não depende desta
 * biblioteca: os testes canonicalizam o elemento com a libxml2 (a C14N que o
 * `xmlsec1` usa), sobre os bytes exatos que o adapter põe no envelope, e
 * comparam.
 */
import { createHash, createVerify } from 'node:crypto';
import { C14nCanonicalization, SignedXml as XmlCryptoSignedXml, findAncestorNs } from 'xml-crypto';
import { ApiError } from '../../utils/errors.js';
import { type ParsedCertificateA1 } from '../fiscal/FiscalCertificateService.js';
import { DECLARACAO_XML, compactarXmlFiscal, lerXmlEstrito } from './FiscalXmlForma.js';

const NS_XMLDSIG = 'http://www.w3.org/2000/09/xmldsig#';

/** Os algoritmos que o leiaute da NF-e fixa no próprio XSD de assinatura. */
export const PERFIL_XMLDSIG = {
  canonicalizacao: 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315',
  assinatura: 'http://www.w3.org/2000/09/xmldsig#rsa-sha1',
  digest: 'http://www.w3.org/2000/09/xmldsig#sha1',
  transformacoes: [
    'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
    'http://www.w3.org/TR/2001/REC-xml-c14n-20010315',
  ],
  biblioteca: 'xml-crypto 6.1.2',
} as const;

/**
 * O que esta implementação AINDA depende de fora, para não ser descoberto na
 * homologação. A canonicalização deixou de constar aqui: ela é C14N 1.0 pela
 * `xml-crypto`, conferida contra a libxml2 nos testes.
 */
export const SIGNER_LIMITATIONS = [
  'O digest e a assinatura usam SHA-1/RSA-SHA1 conforme o layout da NF-e 4.00 '
    + '(o XSD de assinatura fixa esses algoritmos). Se a versão vigente do layout mudar o '
    + 'algoritmo, isto precisa acompanhar.',
  'A aceitação final da assinatura é da SEFAZ: a homologação real com o certificado A1 do '
    + 'grupo é o juiz, e ela é a parte do dono.',
] as const;

// ------------------------------------------------------------ árvore (DOM)

function* elementos(raiz: Node): Generator<Element> {
  for (let filho = raiz.firstChild; filho; filho = filho.nextSibling) {
    if (filho.nodeType === 1) {
      yield filho as Element;
      yield* elementos(filho);
    }
  }
}

/**
 * O primeiro elemento `tagName` com `Id`, na ordem do documento.
 *
 * Pega o PRIMEIRO, como o original: quem montar lote de eventos assina cada
 * `<evento>` isolado ANTES de juntar.
 */
function acharAlvo(doc: Document, tagName: string): Element | null {
  for (const el of elementos(doc)) {
    if (el.localName === tagName && el.hasAttribute('Id')) return el;
  }
  return null;
}

/** Os elementos XMLDSig `nome` dentro de `raiz` (a própria raiz não conta). */
function acharDsig(raiz: Node, nome: string): Element | null {
  for (const el of elementos(raiz)) {
    if (el.localName === nome && el.namespaceURI === NS_XMLDSIG) return el;
  }
  return null;
}

function alvoAusente(tagName: string): ApiError {
  return new ApiError(
    'CORE_FISCAL_SIGN_TARGET_MISSING',
    `O XML não tem um elemento ${tagName} com Id — não há o que assinar.`,
    400,
  );
}

/** O nome do elemento-pai a partir de `'</NFe>'`, `'</evento>'`, `'</inutNFe>'`. */
function nomeDoPai(closeParentTag: string): string {
  return closeParentTag.replace(/^<\//, '').replace(/>$/, '').replace(/^\w+:/, '');
}

/** O seletor XPath do alvo, pelo nome local e pelo Id — o que a xml-crypto usa. */
function seletorDoAlvo(tagName: string, id: string): string {
  return `//*[local-name(.)='${tagName}'][@Id='${id}']`;
}

export interface SignedXml {
  xml: string;
  digestValue: string;
  signatureValue: string;
  /** Titular do certificado que assinou — útil na auditoria, não é segredo. */
  signedBy: string;
}

/**
 * Assina um ELEMENTO do XML por Id — o motor comum da nota, dos eventos e da
 * inutilização (rodada 46).
 *
 * `closeParentTag` diz quem é o PAI do elemento assinado — é dentro dele que
 * a Signature entra, como a última filha (enveloped): '</NFe>' para a nota
 * (depois do `infNFeSupl`, como o leiaute manda), '</evento>' para eventos,
 * '</inutNFe>' para a inutilização. Um pai diferente do esperado é recusa, e
 * não palpite: assinatura no lugar errado é rejeição de leiaute.
 *
 * Recebe o certificado JÁ ABERTO — abrir o .pfx é papel de quem chama. A senha
 * vive SELADA no cofre AES-256-GCM (derivado de DEVORA_ENCRYPTION_KEY) e o
 * pipeline de emissão a consome internamente; vazamento do banco sozinho
 * continua não assinando nada, porque a chave do cofre mora no ambiente.
 */
export function signXmlElement(
  xml: string,
  alvo: { tagName: string; closeParentTag: string },
  cert: ParsedCertificateA1,
): SignedXml {
  const compacto = compactarXmlFiscal(xml);
  const doc = lerXmlEstrito(compacto);
  const elemento = acharAlvo(doc, alvo.tagName);
  if (!elemento) throw alvoAusente(alvo.tagName);

  const id = elemento.getAttribute('Id') ?? '';
  const pai = elemento.parentNode;
  const paiEsperado = nomeDoPai(alvo.closeParentTag);
  if (!pai || pai.nodeType !== 1 || (pai as Element).localName !== paiEsperado) {
    throw new ApiError(
      'CORE_FISCAL_SIGN_TARGET_MISPLACED',
      `O elemento ${alvo.tagName} precisa estar dentro de <${paiEsperado}> para ser assinado.`,
      400,
    );
  }

  const assinador = new XmlCryptoSignedXml({
    privateKey: cert.keyPem,
    publicCert: cert.certPem,
    signatureAlgorithm: PERFIL_XMLDSIG.assinatura,
    canonicalizationAlgorithm: PERFIL_XMLDSIG.canonicalizacao,
  });
  const seletor = seletorDoAlvo(alvo.tagName, id);
  assinador.addReference({
    xpath: seletor,
    transforms: [...PERFIL_XMLDSIG.transformacoes],
    digestAlgorithm: PERFIL_XMLDSIG.digest,
  });

  try {
    assinador.computeSignature(compacto, {
      location: { reference: `${seletor}/..`, action: 'append' },
    });
  } catch {
    // A mensagem não carrega nada do certificado nem da chave.
    throw new ApiError(
      'CORE_FISCAL_SIGN_FAILED',
      'Não foi possível assinar com a chave do certificado.',
      500,
    );
  }

  // A xmldom reserializa a árvore inteira; a declaração volta na frente, uma
  // vez, do jeito que todo XML fiscal deste sistema é gravado.
  const corpo = assinador.getSignedXml().replace(/^\s*<\?xml[^?]*\?>/, '');
  const assinatura = assinador.getSignatureXml();

  return {
    xml: `${DECLARACAO_XML}${corpo}`,
    digestValue: /<DigestValue>([^<]*)<\/DigestValue>/.exec(assinatura)?.[1] ?? '',
    signatureValue: /<SignatureValue>([^<]*)<\/SignatureValue>/.exec(assinatura)?.[1] ?? '',
    signedBy: cert.subject,
  };
}

export function signNfceXml(xml: string, cert: ParsedCertificateA1): SignedXml {
  return signXmlElement(xml, { tagName: 'infNFe', closeParentTag: '</NFe>' }, cert);
}

export interface VerificationResult {
  valid: boolean;
  /** Motivo exato da falha, para o operador entender o que houve. */
  reason: string | null;
  digestMatches: boolean;
  signatureMatches: boolean;
}

function falha(reason: string): VerificationResult {
  return { valid: false, reason, digestMatches: false, signatureMatches: false };
}

/** Base64 do X509Certificate -> PEM, para o `crypto` do Node. */
function pemDoCertificado(base64: string): string {
  const limpo = base64.replace(/\s+/g, '');
  return `-----BEGIN CERTIFICATE-----\n${limpo.replace(/(.{64})/g, '$1\n')}\n-----END CERTIFICATE-----`;
}

/**
 * Confere a assinatura do elemento `tagName`.
 *
 * Duas checagens independentes, e ambas precisam passar:
 *
 *  - o DIGEST prova que o conteúdo não mudou depois de assinado;
 *  - a ASSINATURA prova que o digest foi selado por quem tinha a chave.
 *
 * Conferir só a assinatura deixaria passar um XML com o conteúdo trocado e o
 * SignedInfo original; conferir só o digest deixaria passar um documento
 * recalculado por quem não tem a chave. As duas contas são feitas em C14N 1.0
 * pela mesma biblioteca que assina — e o veredito final (`valid`) exige ainda o
 * `checkSignature` dela, a validação XMLDSig completa.
 */
export function verifyXmlElementSignature(signedXml: string, tagName: string): VerificationResult {
  let doc: Document;
  try {
    doc = lerXmlEstrito(signedXml);
  } catch {
    return falha('O XML está mal formado.');
  }

  const alvo = acharAlvo(doc, tagName);
  if (!alvo) return falha(`O XML não contém ${tagName} assinável.`);

  let noAssinatura: Element | null = null;
  for (const el of elementos(doc)) {
    if (el.localName === 'Signature' && el.namespaceURI === NS_XMLDSIG) {
      noAssinatura = el;
      break;
    }
  }
  if (!noAssinatura) return falha('Documento sem assinatura completa.');

  const texto = (nome: string): string | null =>
    acharDsig(noAssinatura, nome)?.textContent?.replace(/\s+/g, '') || null;
  const digestNoXml = texto('DigestValue');
  const signatureValue = texto('SignatureValue');
  const x509 = texto('X509Certificate');
  const signedInfo = acharDsig(noAssinatura, 'SignedInfo');
  if (!digestNoXml || !signatureValue || !x509 || !signedInfo) {
    return falha('Documento sem assinatura completa.');
  }
  const certificado = pemDoCertificado(x509);

  const verificador = new XmlCryptoSignedXml({
    publicCert: certificado,
    // O certificado vem do KeyInfo e é passado explicitamente acima: a
    // pergunta aqui é "o documento confere com o certificado que apresenta?".
    // Se esse certificado é da empresa e da ICP-Brasil é outra checagem.
    getCertFromKeyInfo: () => null,
  });
  try {
    verificador.loadSignature(noAssinatura);
  } catch {
    return falha('Documento sem assinatura completa.');
  }

  // A referência precisa apontar para ESTE elemento — senão o digest confere
  // outra coisa, e o conteúdo da nota fica fora da assinatura.
  const referencia = verificador.getReferences()[0];
  const idDoAlvo = alvo.getAttribute('Id') ?? '';
  if (!referencia || referencia.uri !== `#${idDoAlvo}`) {
    return falha(`A assinatura não referencia o ${tagName} do documento.`);
  }

  const semExcecao = (conta: () => boolean): boolean => {
    try {
      return conta();
    } catch {
      return false;
    }
  };

  const digestMatches = semExcecao(() => {
    const canonico = verificador.getCanonXml(referencia.transforms, alvo, {
      ancestorNamespaces: findAncestorNs(doc, seletorDoAlvo(tagName, idDoAlvo)),
      signatureNode: noAssinatura,
    });
    return createHash('sha1').update(canonico, 'utf8').digest('base64') === digestNoXml;
  });

  const signatureMatches = semExcecao(() => {
    const signedInfoCanonico = new C14nCanonicalization().process(signedInfo, {
      ancestorNamespaces: findAncestorNs(doc, "//*[local-name(.)='SignedInfo']"),
    });
    const conferencia = createVerify('RSA-SHA1');
    conferencia.update(signedInfoCanonico, 'utf8');
    conferencia.end();
    return conferencia.verify(certificado, signatureValue, 'base64');
  });

  const valid =
    digestMatches && signatureMatches && semExcecao(() => verificador.checkSignature(signedXml));

  return {
    valid,
    reason: valid
      ? null
      : !digestMatches
        ? 'O conteúdo do documento foi alterado depois da assinatura.'
        : !signatureMatches
          ? 'A assinatura não confere com o certificado apresentado.'
          : 'A assinatura não passou na verificação XMLDSig completa.',
    digestMatches,
    signatureMatches,
  };
}

/** Confere a assinatura da nota (NF-e 55 e NFC-e 65) — o alvo é o `infNFe`. */
export function verifyNfceSignature(signedXml: string): VerificationResult {
  return verifyXmlElementSignature(signedXml, 'infNFe');
}

/*
  Aqui existiu um `signWithCompanyCertificate`, atalho que abria o certificado
  e assinava numa chamada. Ninguém jamais o chamou: o pipeline fiscal
  (FiscalPipelineService) abre o certificado ele mesmo e usa `signNfceXml`
  direto, porque precisa do certificado aberto para mais coisas do que
  assinar. Duas portas para a mesma assinatura era convite para a próxima
  pessoa escolher a errada.
*/
