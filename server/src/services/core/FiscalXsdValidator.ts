/**
 * VALIDAÇÃO DE LEIAUTE PELO XSD OFICIAL — GAP-PRD-097.
 *
 * ## O que faltava
 *
 * `validateAgainstSchema` só conferia se as tags abriam e fechavam: XML bem
 * formado. A conformidade com o leiaute — ordem dos elementos,
 * cardinalidade, tamanho, padrão e domínio de cada campo — era julgada só pela
 * SEFAZ, e cada erro virava rejeição com número fiscal já reservado.
 *
 * ## O que existe agora
 *
 *  - Os XSDs do Pacote de Liberação vigente da NF-e/NFC-e 4.00 estão NO
 *    REPOSITÓRIO (`server/fiscal-schemas/PL_010b_V1.30`), com um manifesto de
 *    integridade (SHA-256 de cada arquivo). Se um arquivo sumir ou for
 *    alterado, o pacote é dado como INDISPONÍVEL — e a emissão recusa, em vez
 *    de fingir que validou.
 *  - O validador é a libxml2 (via `libxml2-wasm` 0.7.2, fixada): o mesmo
 *    motor do `xmllint --schema`, compilado para WebAssembly, sem binário
 *    nativo para instalar no servidor da loja.
 *  - A nota ainda NÃO assinada é validada com uma ASSINATURA-MOLDE no lugar da
 *    `Signature` (o leiaute a exige): o molde tem o formato exato que o XSD de
 *    assinatura fixa, então tudo o que o validador acusar é do conteúdo da
 *    nota, e é isso que se quer saber ANTES de reservar número. Depois de
 *    assinada, a nota é validada de novo — agora com a assinatura real.
 *
 * ## O que ele NÃO faz
 *
 * O XSD não conhece regra de negócio da SEFAZ (as ~700 regras de validação
 * do Manual de Orientação: soma de totais, CFOP × destino, chave × campos).
 * As que o sistema consegue verificar sozinho estão em `validateNfce` /
 * `validateNfe`; o resto continua sendo julgado pela SEFAZ na homologação.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  XmlBufferInputProvider,
  XmlDocument,
  XmlLibError,
  XsdValidator,
  xmlRegisterInputProvider,
} from 'libxml2-wasm';
import { ApiError } from '../../utils/errors.js';
import { compactarXmlFiscal } from './FiscalXmlForma.js';

/** O pacote de esquemas embutido. Trocar de pacote é trocar esta pasta. */
export const PACOTE_DE_ESQUEMAS = 'PL_010b_V1.30';

/** A pasta, relativa a ESTE arquivo — vale em `src/` (tsx) e em `dist/` (build). */
const PASTA = fileURLToPath(new URL(`../../../fiscal-schemas/${PACOTE_DE_ESQUEMAS}/`, import.meta.url));

/** O nome virtual dos arquivos para a libxml2: os `include` resolvem entre eles. */
const PREFIXO_VIRTUAL = `devora-fiscal-schemas/${PACOTE_DE_ESQUEMAS}/`;

/** Os documentos que o sistema sabe validar — a raiz de cada um. */
export const ESQUEMAS = {
  nfe: 'nfe_v4.00.xsd',
  enviNFe: 'enviNFe_v4.00.xsd',
  procNFe: 'procNFe_v4.00.xsd',
  inutNFe: 'inutNFe_v4.00.xsd',
} as const;
export type EsquemaFiscal = keyof typeof ESQUEMAS;

export interface ResultadoXsd {
  /** `true` só quando o XSD oficial foi carregado E aplicado. */
  validated: boolean;
  wellFormed: boolean;
  /** Vazio = o documento cumpre o leiaute (quando `validated`). */
  problems: string[];
  /** Explica por que `validated` é falso, quando for o caso. */
  note: string | null;
  schemaPackage: string | null;
}

interface Manifesto {
  pacote: string;
  arquivos: Record<string, string>;
}

interface EstadoDoPacote {
  disponivel: boolean;
  motivo: string | null;
  arquivos: number;
}

let estado: EstadoDoPacote | null = null;
const validadores = new Map<EsquemaFiscal, XsdValidator>();

/** SHA-256 do conteúdo com fim de linha LF — o git pode ter trocado para CRLF. */
function sha256Normalizado(conteudo: Buffer): string {
  return createHash('sha256').update(conteudo.toString('utf8').replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

/**
 * Carrega o pacote UMA vez por processo, conferindo o manifesto.
 *
 * Os buffers vão para um provedor de entrada da libxml2 com nomes virtuais —
 * é assim que `nfe_v4.00.xsd` acha o `leiauteNFe_v4.00.xsd` que ele inclui, sem
 * que a libxml2 precise ler o disco por conta própria.
 */
function carregarPacote(): EstadoDoPacote {
  if (estado) return estado;
  const caminhoManifesto = `${PASTA}MANIFESTO.json`;
  if (!existsSync(caminhoManifesto)) {
    estado = {
      disponivel: false,
      motivo: `O pacote de esquemas ${PACOTE_DE_ESQUEMAS} não está na instalação (falta ${caminhoManifesto}).`,
      arquivos: 0,
    };
    return estado;
  }
  let manifesto: Manifesto;
  try {
    manifesto = JSON.parse(readFileSync(caminhoManifesto, 'utf8')) as Manifesto;
  } catch {
    estado = { disponivel: false, motivo: 'O manifesto do pacote de esquemas está ilegível.', arquivos: 0 };
    return estado;
  }

  const buffers: Record<string, Uint8Array> = {};
  for (const [arquivo, hashEsperado] of Object.entries(manifesto.arquivos)) {
    const caminho = `${PASTA}${arquivo}`;
    if (!existsSync(caminho)) {
      estado = { disponivel: false, motivo: `Falta o arquivo ${arquivo} do pacote ${PACOTE_DE_ESQUEMAS}.`, arquivos: 0 };
      return estado;
    }
    const conteudo = readFileSync(caminho);
    if (sha256Normalizado(conteudo) !== hashEsperado) {
      estado = {
        disponivel: false,
        motivo: `O arquivo ${arquivo} do pacote ${PACOTE_DE_ESQUEMAS} não confere com o manifesto — foi alterado.`,
        arquivos: 0,
      };
      return estado;
    }
    buffers[`${PREFIXO_VIRTUAL}${arquivo}`] = conteudo;
  }
  xmlRegisterInputProvider(new XmlBufferInputProvider(buffers));
  estado = { disponivel: true, motivo: null, arquivos: Object.keys(buffers).length };
  return estado;
}

/** O validador compilado de um esquema — compilar custa ~200 ms; uma vez só. */
function validadorDe(esquema: EsquemaFiscal): XsdValidator {
  const pronto = validadores.get(esquema);
  if (pronto) return pronto;
  const nome = `${PREFIXO_VIRTUAL}${ESQUEMAS[esquema]}`;
  const xsd = XmlDocument.fromBuffer(readFileSync(`${PASTA}${ESQUEMAS[esquema]}`), { url: nome });
  try {
    const validador = XsdValidator.fromDoc(xsd);
    validadores.set(esquema, validador);
    return validador;
  } finally {
    xsd.dispose();
  }
}

/** Situação do pacote, para a prontidão e para os testes. */
export function situacaoDosEsquemas(): { pacote: string; disponivel: boolean; motivo: string | null; arquivos: number } {
  const e = carregarPacote();
  return { pacote: PACOTE_DE_ESQUEMAS, ...e };
}

/** A mensagem da libxml2 em português de tela: sem `{namespace}` em cada nome. */
function traduzirProblema(mensagem: string, linha: number): string {
  const limpa = mensagem
    .replace(/\{http:\/\/www\.portalfiscal\.inf\.br\/nfe\}/g, '')
    .replace(/\{http:\/\/www\.w3\.org\/2000\/09\/xmldsig#\}/g, 'ds:')
    .replace(/\s+/g, ' ')
    .trim();
  return linha > 1 ? `linha ${linha}: ${limpa}` : limpa;
}

function problemasDe(err: unknown): string[] {
  if (err instanceof XmlLibError && err.details.length > 0) {
    return err.details.map((d) => traduzirProblema(d.message, d.line));
  }
  return [err instanceof Error ? err.message : String(err)];
}

/**
 * Valida o XML contra o esquema oficial `esquema`.
 *
 * Primeiro a boa formação (a libxml2 é estrita: tag trocada, entidade
 * desconhecida e caractere proibido param aqui); depois o leiaute.
 */
export function validarXmlContraXsd(xml: string, esquema: EsquemaFiscal): ResultadoXsd {
  let doc: XmlDocument;
  try {
    doc = XmlDocument.fromString(xml);
  } catch (err) {
    return {
      validated: false,
      wellFormed: false,
      problems: problemasDe(err),
      note: 'O XML está mal formado — o leiaute nem chega a ser verificado.',
      schemaPackage: null,
    };
  }

  try {
    const pacote = carregarPacote();
    if (!pacote.disponivel) {
      return {
        validated: false,
        wellFormed: true,
        problems: [],
        note: `${pacote.motivo} Só foi verificada a boa formação do XML, que NÃO equivale a conformidade com o leiaute.`,
        schemaPackage: null,
      };
    }
    try {
      validadorDe(esquema).validate(doc);
      return { validated: true, wellFormed: true, problems: [], note: null, schemaPackage: PACOTE_DE_ESQUEMAS };
    } catch (err) {
      return {
        validated: true,
        wellFormed: true,
        problems: problemasDe(err),
        note: null,
        schemaPackage: PACOTE_DE_ESQUEMAS,
      };
    }
  } finally {
    doc.dispose();
  }
}

/**
 * A assinatura-molde: o formato exato do XSD de assinatura, com valores
 * base64 nulos. Serve SÓ para validar o conteúdo de uma nota antes de
 * assiná-la — nunca é gravada, nunca viaja.
 */
function assinaturaMolde(idInfNFe: string): string {
  return (
    '<Signature xmlns="http://www.w3.org/2000/09/xmldsig#"><SignedInfo>'
    + '<CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/>'
    + '<SignatureMethod Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"/>'
    + `<Reference URI="#${idInfNFe}"><Transforms>`
    + '<Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/>'
    + '<Transform Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/>'
    + '</Transforms><DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"/>'
    + '<DigestValue>AAAAAAAAAAAAAAAAAAAAAAAAAAA=</DigestValue></Reference></SignedInfo>'
    + '<SignatureValue>AAAA</SignatureValue>'
    + '<KeyInfo><X509Data><X509Certificate>AAAA</X509Certificate></X509Data></KeyInfo>'
    + '</Signature>'
  );
}

/**
 * Valida a NOTA (NF-e 55 ou NFC-e 65) contra o leiaute, assinada ou não.
 *
 * Nota já assinada: valida como está — a assinatura real também é conferida
 * pelo XSD. Nota ainda sem assinatura: valida a forma COMPACTA (a mesma que
 * será assinada) com a assinatura-molde no lugar da `Signature`.
 */
export function validarLeiauteNfe(xml: string): ResultadoXsd {
  const boaFormacao = validarXmlContraXsd(xml, 'nfe');
  if (!boaFormacao.wellFormed) return boaFormacao;
  if (/<(?:\w+:)?Signature\b[^>]*xmldsig#/.test(xml)) return boaFormacao;

  let compacto: string;
  try {
    compacto = compactarXmlFiscal(xml);
  } catch (err) {
    return { ...boaFormacao, validated: false, wellFormed: false, problems: problemasDe(err) };
  }
  const id = /<infNFe\b[^>]*\bId="([^"]+)"/.exec(compacto)?.[1] ?? 'NFe';
  const fim = compacto.lastIndexOf('</NFe>');
  if (fim < 0) return boaFormacao;
  const comMolde = `${compacto.slice(0, fim)}${assinaturaMolde(id)}${compacto.slice(fim)}`;
  return validarXmlContraXsd(comMolde, 'nfe');
}

/**
 * O PORTÃO ANTES DO NÚMERO: monta a nota com um número PROVISÓRIO e confere o
 * leiaute. Erro de leiaute descoberto aqui não queima número fiscal nenhum —
 * o número de verdade só é reservado depois.
 *
 * `montar` recebe o número provisório e devolve o XML. O resultado sai como
 * recusa 409 nomeando cada problema do leiaute.
 */
export function conferirLeiauteAntesDeNumerar(montar: (numeroProvisorio: number) => string): void {
  const r = validarLeiauteNfe(montar(1));
  if (!r.wellFormed) {
    throw new ApiError(
      'CORE_FISCAL_XML_MALFORMED',
      `A nota montada não é um XML bem formado: ${r.problems.join(' | ')}`,
      500,
      { problems: r.problems },
    );
  }
  if (!r.validated) {
    throw new ApiError(
      'CORE_FISCAL_XSD_UNAVAILABLE',
      `A nota não pode ser numerada sem a conferência do leiaute. ${r.note ?? ''}`.trim(),
      503,
    );
  }
  if (r.problems.length > 0) {
    throw new ApiError(
      'CORE_FISCAL_LAYOUT_INVALID',
      `A nota não cumpre o leiaute oficial (${PACOTE_DE_ESQUEMAS}) e não foi numerada: ${r.problems.join(' | ')}`,
      409,
      { problems: r.problems, schemaPackage: PACOTE_DE_ESQUEMAS },
    );
  }
}
