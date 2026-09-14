/**
 * A FORMA DO XML QUE VIAJA — GAP-PRD-003.
 *
 * ## O defeito que isto conserta
 *
 * Os geradores (`buildNfceXml`, `buildNfeXml`) montam o documento INDENTADO:
 * quebras de linha e espaços entre as tags, para quem lê o código. O
 * assinador antigo calculava o digest sobre uma cópia com esses espaços
 * removidos e depois inseria a assinatura no XML indentado original. O que
 * viajava para a SEFAZ, então, NÃO era o que tinha sido resumido: a SEFAZ
 * canonicaliza o que recebe, recalcula o digest, e ele não bate (rejeição
 * 297). E, antes disso, espaço entre as tags da mensagem já é rejeição por si
 * (588: "caracteres de edição entre as tags").
 *
 * ## A regra
 *
 * O XML fiscal é COMPACTADO ANTES de assinar, e o que se assina é exatamente o
 * que se transmite. Compactar aqui é remover os nós de texto feitos só de
 * espaço que estão ENTRE ELEMENTOS (conteúdo só-de-elementos) e os
 * comentários. Texto de campo (`<xNome>`, `<xProd>`...) nunca é tocado — nem
 * quando é só espaço, porque ali o espaço é o valor, e decidir se ele serve é
 * papel do leiaute (XSD), não da forma.
 *
 * A remoção é feita em árvore (DOM), e não por expressão regular sobre o
 * texto: `>\s+<` também casaria dentro de um valor de campo e o mutilaria.
 */
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { XmlDocument, XmlLibError } from 'libxml2-wasm';
import { ApiError } from '../../utils/errors.js';

/** A declaração que abre todo XML fiscal gravado por este sistema. */
export const DECLARACAO_XML = '<?xml version="1.0" encoding="UTF-8"?>';

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const COMMENT_NODE = 8;

function malFormado(erros: string[]): ApiError {
  return new ApiError(
    'CORE_FISCAL_XML_MALFORMED',
    `O XML fiscal está mal formado e não pode ser assinado: ${
      erros.map((e) => e.replace(/\s+/g, ' ').trim()).join(' | ') || 'documento vazio'
    }`,
    400,
  );
}

/**
 * Lê o XML RECUSANDO erro de sintaxe, e devolve a árvore do xmldom.
 *
 * O xmldom é tolerante: tag trocada vira "a árvore possível" com um aviso no
 * console (`<NFe><infNFe></NFe>` sai como `<NFe><infNFe/></NFe>`). Para
 * documento fiscal isso é inaceitável — um XML quebrado viraria outro XML, e a
 * assinatura selaria o que ninguém escreveu. Por isso o JUIZ da boa formação
 * é a libxml2, que é estrita; o xmldom só entra depois, para a árvore que a
 * `xml-crypto` sabe manipular.
 */
export function lerXmlEstrito(xml: string): Document {
  try {
    XmlDocument.fromString(xml).dispose();
  } catch (err) {
    const detalhes = err instanceof XmlLibError ? err.details.map((d) => d.message) : [];
    throw malFormado(detalhes.length > 0 ? detalhes : [err instanceof Error ? err.message : String(err)]);
  }

  const erros: string[] = [];
  const parser = new DOMParser({
    errorHandler: {
      warning: () => undefined,
      error: (msg: unknown) => erros.push(String(msg)),
      fatalError: (msg: unknown) => erros.push(String(msg)),
    },
  });
  let doc: Document | undefined;
  try {
    doc = parser.parseFromString(xml, 'text/xml');
  } catch (err) {
    erros.push(err instanceof Error ? err.message : String(err));
  }
  if (erros.length > 0 || !doc || !doc.documentElement) throw malFormado(erros);
  return doc;
}

/** Tem algum filho que é elemento? Então o conteúdo é "de elementos". */
function temFilhoElemento(no: Node): boolean {
  for (let filho = no.firstChild; filho; filho = filho.nextSibling) {
    if (filho.nodeType === ELEMENT_NODE) return true;
  }
  return false;
}

/** Remove, na árvore, o espaço entre elementos e os comentários. */
function podar(no: Node): void {
  const conteudoDeElementos = temFilhoElemento(no);
  let filho = no.firstChild;
  while (filho) {
    const proximo = filho.nextSibling;
    const soEspaco =
      filho.nodeType === TEXT_NODE && /^[ \t\r\n]*$/.test(filho.nodeValue ?? '');
    if (filho.nodeType === COMMENT_NODE || (soEspaco && conteudoDeElementos)) {
      no.removeChild(filho);
    } else if (filho.nodeType === ELEMENT_NODE) {
      podar(filho);
    }
    filho = proximo;
  }
}

/**
 * Compacta o XML fiscal: sem caracteres de edição entre as tags, sem
 * comentários, com a declaração XML padrão na frente.
 *
 * IDEMPOTENTE: compactar o que já está compacto devolve o mesmo texto. É isso
 * que permite chamar esta função em qualquer ponto do caminho sem medo de
 * mudar o documento duas vezes.
 */
export function compactarXmlFiscal(xml: string): string {
  const doc = lerXmlEstrito(xml);
  // Fora do elemento raiz só pode sobrar a declaração, que é reescrita abaixo.
  let filho = doc.firstChild;
  while (filho) {
    const proximo = filho.nextSibling;
    if (filho.nodeType !== ELEMENT_NODE) doc.removeChild(filho);
    filho = proximo;
  }
  podar(doc.documentElement);
  const corpo = new XMLSerializer().serializeToString(doc.documentElement);
  return `${DECLARACAO_XML}${corpo}`;
}

/**
 * Sobra caractere de edição entre as tags? É a pergunta da rejeição 588.
 *
 * Responde sobre a ÁRVORE, não sobre o texto: um valor de campo que contém
 * `> <` escapado não é espaço entre tags.
 */
export function temEspacoEntreTags(xml: string): boolean {
  const doc = lerXmlEstrito(xml);
  let achou = false;
  const visitar = (no: Node): void => {
    if (achou) return;
    const conteudoDeElementos = temFilhoElemento(no);
    for (let filho = no.firstChild; filho && !achou; filho = filho.nextSibling) {
      if (
        conteudoDeElementos
        && filho.nodeType === TEXT_NODE
        && /^[ \t\r\n]+$/.test(filho.nodeValue ?? '')
      ) {
        achou = true;
      } else if (filho.nodeType === ELEMENT_NODE) {
        visitar(filho);
      }
    }
  };
  visitar(doc.documentElement);
  return achou;
}

/** Remove a declaração `<?xml?>` — o que vai DENTRO de um envelope não a leva. */
export function semDeclaracaoXml(xml: string): string {
  return xml.replace(/^\s*<\?xml[^?]*\?>\s*/, '');
}
