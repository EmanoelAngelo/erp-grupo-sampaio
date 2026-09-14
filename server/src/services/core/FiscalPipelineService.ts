/**
 * Orquestra o caminho fiscal de uma venda.
 *
 * A VENDA É A AUTORIDADE COMERCIAL; o fiscal é consequência. Nada aqui cria
 * venda, baixa estoque ou gera receita — esses fatos já aconteceram no
 * fechamento do caixa, e repeti-los produziria estoque negativo e faturamento
 * em dobro.
 *
 * FALHA FISCAL NÃO DESFAZ VENDA. Se a SEFAZ recusar, a venda continua
 * existindo: o cliente pagou e levou a mercadoria. O que muda é que existe uma
 * pendência fiscal visível, não uma venda apagada.
 *
 * A ASSINATURA DE DESENVOLVIMENTO
 *
 * Sem certificado A1 real não há como assinar de verdade. Para que o pipeline
 * possa ser exercitado inteiro antes das credenciais, existe uma assinatura de
 * FIXTURE — que só é aceita fora de produção e junto do provider de teste. O
 * documento assinado assim carrega a marca no XML, e a reconciliação acusa
 * qualquer um que apareça em produção.
 */
import { createSign, generateKeyPairSync } from 'node:crypto';
import { getConnection } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { buildReadiness, getFiscalConfig } from './FiscalConfigService.js';
import { loadSaleForNfce, validateNfce } from './FiscalXmlNfce.js';
import { completarPeloGrupo } from './TributacaoDoItem.js';
import { motivosDaTributacaoDaVenda } from './ProntidaoTributaria.js';
import {
  createNfceForSale,
  getDocument,
  getDocumentBySale,
  transition,
  type FiscalDocument,
} from './FiscalDocumentService.js';
import { validateDocument } from './FiscalDocumentService.js';
import { enqueue, processNext } from './FiscalQueueService.js';
import { PERFIL_XMLDSIG, signNfceXml, verifyNfceSignature } from './FiscalSigner.js';
import { validarLeiauteNfe } from './FiscalXsdValidator.js';
import { getCertificateA1 } from '../fiscal/FiscalCertificateService.js';
import type { ParsedCertificateA1 } from '../fiscal/FiscalCertificateService.js';
import { SefazRealAdapter } from './SefazRealAdapter.js';
import type { SefazAdapter } from './SefazAdapter.js';
import { SefazTestAdapter, type TestScenario } from './SefazTestAdapter.js';
import { MODEL_NFCE } from './FiscalKeyService.js';
import { emitidaOffline, periodoAtivo, prazoDeTransmissao } from './FiscalContingenciaOffline.js';
import { aplicarQrOffline } from './NfceQrOffline.js';

/** Marca no XML: assinatura de desenvolvimento, não vale para o fisco. */
export const FIXTURE_SIGNATURE_MARK = 'GS-FIXTURE-SIGNATURE';

/**
 * Situação fiscal em linguagem de operador.
 *
 * O caixa não tem por que aprender a máquina de estados. Ele precisa saber se
 * pode entregar o cupom, se tem que chamar o gerente, ou se é só esperar.
 */
export const STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Preparando NFC-e',
  VALIDATED: 'Validando dados fiscais',
  SIGNED: 'Assinando documento',
  QUEUED: 'Aguardando transmissão',
  SENDING: 'Enviando à SEFAZ',
  AUTHORIZED: 'NFC-e autorizada',
  REJECTED: 'NFC-e rejeitada',
  CONTINGENCY: 'Em contingência',
  CANCELLED: 'NFC-e cancelada',
  ERROR: 'Erro fiscal',
};

/** Estados em que não há mais nada a esperar — o poll para aqui. */
export const TERMINAL_STATUSES = new Set(['AUTHORIZED', 'REJECTED', 'CANCELLED']);

let fixtureKeys: { privateKey: string; certificate: string } | null = null;

/**
 * Par de chaves de desenvolvimento, gerado uma vez por processo.
 *
 * Não é certificado ICP-Brasil e não pretende ser: serve para exercitar o
 * caminho de assinatura e a detecção de adulteração enquanto o A1 real não
 * existe.
 */
function fixtureKeyPair(): { privateKey: string; certificate: string } {
  if (fixtureKeys) return fixtureKeys;
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  fixtureKeys = {
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    // Não é um X.509 de verdade — é o material público, marcado.
    certificate: `${FIXTURE_SIGNATURE_MARK}:${publicKey
      .export({ type: 'spki', format: 'pem' })
      .toString()
      .replace(/-----[A-Z ]+-----/g, '')
      .replace(/\s+/g, '')}`,
  };
  return fixtureKeys;
}

function signWithFixture(xml: string): string {
  const { privateKey, certificate } = fixtureKeyPair();
  const infNFe = /<infNFe\b[^>]*\bId="([^"]+)"[^>]*>[\s\S]*?<\/infNFe>/.exec(xml);
  if (!infNFe) {
    throw new ApiError('CORE_FISCAL_SIGN_TARGET_MISSING', 'XML sem infNFe.', 400);
  }
  const signer = createSign('RSA-SHA256');
  signer.update(infNFe[0], 'utf8');
  signer.end();
  const valor = signer.sign(privateKey, 'base64');

  const assinatura =
    `<Signature xmlns="http://www.w3.org/2000/09/xmldsig#">`
    + `<SignatureValue>${valor}</SignatureValue>`
    + `<KeyInfo><X509Data><X509Certificate>${certificate}</X509Certificate></X509Data></KeyInfo>`
    + `</Signature>`;
  return xml.replace('</NFe>', `${assinatura}</NFe>`);
}

export interface PipelineOptions {
  companyId: string;
  saleId: string;
  userId?: string | null;
  /**
   * Senha do A1 digitada nesta chamada — o caminho ADMINISTRATIVO, de quem
   * está afirmando qual é a senha (ex.: conferir-certificado). Quando ausente,
   * vale a senha SELADA no cofre junto do `.pfx` — é assim que o PDV emite sem
   * pedir nada a ninguém. Sem certificado utilizável, só resta o modo de
   * desenvolvimento, fora de produção.
   */
  certificatePassword?: string;
  /** Liga o provider de teste e a assinatura de fixture. Proibido em produção. */
  developmentMode?: boolean;
  /**
   * Adapter injetado pelos testes — vale nos DOIS ramos: no de desenvolvimento
   * (como sempre) e no real, onde permite provar que o A1 do cofre chegou ao
   * `authorize` sem falar com a SEFAZ de verdade. Em produção, adapter que se
   * declara de teste é recusado antes de transmitir.
   */
  adapter?: SefazAdapter;
  /**
   * Cenário do provider de teste.
   *
   * Existe para que rejeição e timeout possam ser exercitados no navegador —
   * caminhos que, sem isto, só seriam vistos em produção, quando doem. Só tem
   * efeito junto do modo de desenvolvimento, que por sua vez é proibido em
   * produção.
   */
  testScenario?: TestScenario;
}

export interface PipelineResult {
  document: FiscalDocument;
  statusLabel: string;
  terminal: boolean;
  /** `true` quando assinado/autorizado por fixture — nunca vale para o fisco. */
  isTest: boolean;
}

/** NFC-e off-line ainda sem desfecho: o cupom de contingência já foi entregue. */
function offlinePendente(doc: FiscalDocument): boolean {
  return emitidaOffline(doc.accessKey) && ['CONTINGENCY', 'QUEUED', 'SENDING'].includes(doc.status);
}

function describe(doc: FiscalDocument, isTest: boolean): PipelineResult {
  return {
    document: doc,
    statusLabel: offlinePendente(doc)
      ? 'Emitida em contingência (off-line) — pendente de autorização'
      : (STATUS_LABEL[doc.status] ?? doc.status),
    terminal: TERMINAL_STATUSES.has(doc.status),
    isTest,
  };
}

/**
 * O A1 do COFRE — o que sela `.pfx` e senha juntos no upsert do certificado.
 *
 * `getCertificateA1` sem senha explícita já cai na selada; o que este leitor
 * acrescenta é a TRADUÇÃO das ausências para o fluxo de emissão:
 *
 *  - certificado nenhum → `null`, e quem chamou decide a recusa (produção e
 *    homologação recusam com frases diferentes; desenvolvimento usa fixture);
 *  - certificado SEM senha selada → o erro preciso do cofre sobe inteiro
 *    (`FISCAL_CERTIFICATE_PASSWORD_REQUIRED`, mandando reenviar o arquivo);
 *  - senha selada que NÃO abre o arquivo → erro claro nomeando o cofre. O
 *    upsert valida a senha antes de selar, então este estado só nasce por
 *    fora (rotação de chave, banco mexido na mão) — e responder "senha
 *    incorreta" acusaria alguém que não digitou nada. A senha, óbvio, não
 *    aparece na mensagem.
 */
export function certificadoDoCofre(companyId: string): ParsedCertificateA1 | null {
  try {
    return getCertificateA1(companyId, 'unit-default');
  } catch (err) {
    if (err instanceof ApiError && err.code === 'FISCAL_CERTIFICATE_NOT_FOUND') {
      return null;
    }
    if (err instanceof ApiError && err.code === 'FISCAL_CERTIFICATE_PASSWORD_INVALID') {
      throw new ApiError(
        'FISCAL_CERTIFICATE_PASSWORD_INVALID',
        'A senha selada no cofre não abre o certificado — o arquivo ou a senha mudaram por '
          + 'fora. Reenvie o .pfx com a senha atual em Fiscal › Certificado.',
        400,
      );
    }
    throw err;
  }
}

/**
 * O certificado utilizável DESTA chamada, na ordem em que a senha pode vir.
 *
 * Senha explícita no corpo GANHA: quem digita está afirmando qual é (o
 * caminho administrativo), e errar tem que aparecer — cair no cofre esconderia
 * o erro de digitação. Sem senha no corpo, vale o segredo selado — o fluxo
 * normal de emissão, que não pede nada no balcão. O modo de desenvolvimento
 * não abre cofre nenhum: ele existe justamente para rodar sem A1.
 */
function certificadoDaChamada(
  options: Pick<PipelineOptions, 'companyId' | 'certificatePassword'>,
  dev: boolean,
): ParsedCertificateA1 | null {
  if (options.certificatePassword) {
    return getCertificateA1(options.companyId, 'unit-default', options.certificatePassword);
  }
  if (dev) return null;
  return certificadoDoCofre(options.companyId);
}

/**
 * Assina o documento.
 *
 * Com certificado utilizável — senha do corpo ou segredo selado no cofre —
 * usa o A1 real da operação. Sem ele, só o modo de desenvolvimento fora de
 * produção — e o XML sai marcado.
 */
function signDocument(input: {
  companyId: string;
  document: FiscalDocument;
  cert: ParsedCertificateA1 | null;
  developmentMode?: boolean;
  userId?: string | null;
}): FiscalDocument {
  const row = getConnection()
    .prepare('SELECT xml_original FROM core_fiscal_documents WHERE id = ?')
    .get(input.document.id) as { xml_original: string | null };

  if (!row.xml_original) {
    throw new ApiError('CORE_FISCAL_XML_MISSING', 'Documento sem XML para assinar.', 500);
  }

  const config = getFiscalConfig(input.companyId);
  let assinado: string;

  // A NFC-e off-line (GAP-PRD-098) troca o QR provisório pelo definitivo, com
  // o digVal da assinatura — fora do infNFe assinado, então a assinatura vale.
  const qrOffline = (xml: string): string =>
    emitidaOffline(input.document.accessKey)
      ? aplicarQrOffline(xml, {
          companyId: input.companyId,
          environment: input.document.environment === 'production' ? 'production' : 'homologation',
          uf: config.uf ?? '',
        })
      : xml;

  if (input.cert) {
    assinado = qrOffline(signNfceXml(row.xml_original, input.cert).xml);

    /*
      A AUTOCONFERÊNCIA ANTES DA FILA (GAP-PRD-003 / GAP-PRD-097).

      O que vai para a fila é o que viaja. Então, antes de gravar, o XML
      ASSINADO passa pelas duas perguntas que a SEFAZ vai fazer: a assinatura
      confere (digest em C14N + SignedInfo) e o documento inteiro — agora com a
      Signature real — cumpre o XSD. Falhar aqui é defeito do sistema, não do
      cadastro: o documento vai para ERROR com o motivo, e nada é transmitido.
    */
    const conferencia = verifyNfceSignature(assinado);
    const leiaute = validarLeiauteNfe(assinado);
    const problemas = [
      ...(conferencia.valid ? [] : [`assinatura: ${conferencia.reason}`]),
      ...(leiaute.validated ? leiaute.problems : [leiaute.note ?? 'leiaute não conferido']),
    ];
    if (problemas.length > 0) {
      return transition({
        companyId: input.companyId,
        documentId: input.document.id,
        to: 'ERROR',
        patch: { x_motivo: `O XML assinado não passou na autoconferência: ${problemas.join('; ')}` },
        detail: { signatureValid: conferencia.valid, schemaValidated: leiaute.validated, problems: problemas },
        userId: input.userId,
      });
    }
  } else {
    if (config.environment === 'production') {
      throw new ApiError(
        'CORE_FISCAL_CERTIFICATE_PASSWORD_REQUIRED',
        'Produção exige o certificado A1 com a senha selada no cofre — envie o .pfx com a '
          + 'senha em Fiscal › Certificado. Assinatura de desenvolvimento é proibida aqui.',
        409,
      );
    }
    if (!input.developmentMode) {
      throw new ApiError(
        'CORE_FISCAL_CERTIFICATE_PASSWORD_REQUIRED',
        'Sem certificado A1 utilizável para assinar. Envie o .pfx com a senha em Fiscal › '
          + 'Certificado — ela fica selada no cofre e a emissão sai sem pedir senha no balcão.',
        400,
      );
    }
    assinado = qrOffline(signWithFixture(row.xml_original));
  }

  getConnection()
    .prepare('UPDATE core_fiscal_documents SET xml_signed = ?, updated_at = ? WHERE id = ?')
    .run(assinado, new Date().toISOString(), input.document.id);

  return transition({
    companyId: input.companyId,
    documentId: input.document.id,
    to: 'SIGNED',
    // O histórico diz COMO foi assinado — o perfil XMLDSig e a biblioteca, ou
    // a marca de fixture de desenvolvimento.
    detail: input.cert
      ? {
          signer: PERFIL_XMLDSIG.biblioteca,
          c14n: PERFIL_XMLDSIG.canonicalizacao,
          signatureValid: true,
          schemaValidated: true,
        }
      : { signer: 'fixture-de-desenvolvimento' },
    userId: input.userId,
  });
}

/**
 * Roda o pipeline inteiro para uma venda.
 *
 * IDEMPOTENTE em cada etapa: chamar duas vezes não cria segundo documento nem
 * segunda transmissão. Se o documento já estiver adiante, as etapas cumpridas
 * são puladas — é o que permite o PDV chamar isto sem medo depois de um erro
 * de rede.
 */
export async function emitNfceForSale(options: PipelineOptions): Promise<PipelineResult> {
  ensureCoreSchema();

  const config = getFiscalConfig(options.companyId);
  const dev = Boolean(options.developmentMode);

  // A trava mais importante deste módulo.
  if (dev && config.environment === 'production') {
    throw new ApiError(
      'CORE_SEFAZ_TEST_PROVIDER_IN_PRODUCTION',
      'Modo de desenvolvimento não é permitido em produção. Nota emitida assim não existe '
        + 'para o fisco.',
      409,
    );
  }

  const { document } = createNfceForSale({
    companyId: options.companyId,
    saleId: options.saleId,
    userId: options.userId,
  });

  return advanceDocument(document.id, options, dev);
}

/**
 * Leva um documento já montado de DRAFT até a fila (e, em desenvolvimento, até
 * o desfecho do provider de teste).
 *
 * Vale para os dois modelos: NFC-e de venda e NF-e de pedido. As etapas são as
 * mesmas, e duplicá-las abriria espaço para as duas versões divergirem —
 * alguém arruma a assinatura de um lado e esquece o outro.
 *
 * IDEMPOTENTE por etapa: documento que já está adiante pula o que cumpriu.
 */
export async function advanceDocument(
  documentId: string,
  options: Omit<PipelineOptions, 'saleId'>,
  dev: boolean,
): Promise<PipelineResult> {
  let atual = getDocument(options.companyId, documentId)!;

  if (atual.status === 'DRAFT') {
    atual = validateDocument({
      companyId: options.companyId,
      documentId: atual.id,
      userId: options.userId,
    });
  }

  /*
    O A1 é resolvido UMA vez, DEPOIS de validar e ANTES de assinar: o mesmo
    certificado que assina o XML fecha o TLS com a SEFAZ logo abaixo. Vem
    depois da validação de propósito — certificado é exigência de ASSINAR,
    não de registrar: o documento da venda nasce e espera mesmo com o A1 em
    renovação, em vez de a loja perder a nota (a mesma decisão do portão de
    montagem em createNfceForSale).
  */
  const certificado = certificadoDaChamada(options, dev);

  if (atual.status === 'VALIDATED') {
    atual = signDocument({
      companyId: options.companyId,
      document: atual,
      cert: certificado,
      developmentMode: dev,
      userId: options.userId,
    });
  }

  if (atual.status === 'SIGNED') {
    enqueue({ companyId: options.companyId, documentId: atual.id, userId: options.userId });
    atual = getDocument(options.companyId, atual.id)!;
  }

  /*
    A NFC-e OFF-LINE NÃO ESPERA A SEFAZ NO BALCÃO (GAP-PRD-098).

    Ela nasceu em contingência porque a SEFAZ está fora: tentar transmitir
    agora seria o caixa esperando um timeout por nota. Vai para CONTINGENCY
    (emitida, pendente de autorização) com o item na fila, e o DANFCE de
    contingência já pode ser entregue. Quem transmite é o trabalhador da
    fila, quando o período fechar.
  */
  if (atual.status === 'QUEUED' && emitidaOffline(atual.accessKey)) {
    atual = transition({
      companyId: options.companyId,
      documentId: atual.id,
      to: 'CONTINGENCY',
      detail: { tpEmis: '9', motivo: 'emitida em contingência off-line — pendente de autorização' },
      userId: options.userId,
    });
    return describe(atual, dev);
  }
  // Período aberto: a NFC-e de antes dele (tpEmis 1) também não tenta no
  // balcão — a SEFAZ está fora, e ela sai com o trabalhador quando voltar.
  if (atual.status === 'QUEUED' && atual.model === MODEL_NFCE && periodoAtivo(options.companyId)) {
    return describe(atual, dev);
  }

  if (dev) {
    const adapter = options.adapter ?? new SefazTestAdapter();
    if (options.testScenario && adapter instanceof SefazTestAdapter) {
      adapter.setScenario(options.testScenario);
      // Rejeição pedida explicitamente não pode ser "salva" pela consulta: o
      // cenário existe justamente para exercitar o caminho da recusa.
      if (options.testScenario === 'REJECTED') adapter.setConsultScenario('CONSULT_NOT_FOUND');
    }
    await processNext({
      companyId: options.companyId,
      adapter,
      userId: options.userId,
      // SÓ a nota desta chamada (GAP-PRD-020) — a fila é do trabalhador de fundo.
      documentId: atual.id,
    });
    atual = getDocument(options.companyId, atual.id)!;
  } else if (certificado) {
    /*
      TRANSMISSÃO REAL, NA MESMA CHAMADA: o certificado que acabou de assinar
      também abre a conversa com a SEFAZ. A rodada 46 fazia isto só quando a
      senha vinha no corpo — "a senha não fica guardada, então todo ato
      fiscal real tem alguém presente" — e nenhuma tela envia senha: o botão
      do PDV morria pedindo o que ninguém ia digitar. Desde que a senha
      passou a ser SELADA no cofre junto do `.pfx`, o fluxo normal de emissão
      anda sozinho com o segredo selado; a senha digitada ficou para os atos
      administrativos, e continua ganhando quando vem.
    */
    const adapter = options.adapter ?? new SefazRealAdapter({ cert: certificado });
    /*
      O portão que o seam de teste exigiu: em produção, adapter que se
      declara de teste NÃO transmite — nem injetado por dentro. É a mesma
      regra do `selectAdapter`, repetida aqui porque este ramo não passa por
      ele. Nota autorizada por provider de teste não existe para o fisco.
    */
    if (!adapter.isReal && getFiscalConfig(options.companyId).environment === 'production') {
      throw new ApiError(
        'CORE_SEFAZ_TEST_PROVIDER_IN_PRODUCTION',
        'O provider de teste não pode transmitir em produção. Nota emitida por ele não '
          + 'existe para o fisco.',
        409,
      );
    }
    await processNext({
      companyId: options.companyId,
      adapter,
      userId: options.userId,
      documentId: atual.id,
    });
    atual = getDocument(options.companyId, atual.id)!;
  }

  return describe(atual, dev);
}

/** A nota emitida em contingência off-line (tpEmis 9). */
export interface ContingenciaDaNota {
  offline: true;
  /** Ainda sem desfecho da SEFAZ: o DANFCE de contingência é o que vale no balcão. */
  pendente: boolean;
  /** Emissão + prazo que o contador decidiu. Nulo sem prazo decidido. */
  prazoDeTransmissao: string | null;
}

/** Onde a nota está na fila de transmissão — o que o balcão precisa ler. */
export interface FilaDaNota {
  attempts: number;
  nextAttemptAt: string | null;
  /** pending | retry | sending | done | dead */
  status: string;
  errorMessage: string | null;
}

/** Situação fiscal de uma venda, para o PDV consultar sem recarregar a tela. */
export function fiscalStatusForSale(
  companyId: string,
  saleId: string,
): (PipelineResult & { queue: FilaDaNota | null; contingencia: ContingenciaDaNota | null }) | null {
  ensureCoreSchema();
  const doc = getDocumentBySale(companyId, saleId, MODEL_NFCE);
  if (!doc) return null;

  const item = getConnection()
    .prepare(
      'SELECT attempts, next_attempt_at, status, error_message FROM core_fiscal_queue WHERE document_id = ? LIMIT 1',
    )
    .get(doc.id) as
    | { attempts: number; next_attempt_at: string | null; status: string; error_message: string | null }
    | undefined;

  const xml = getConnection()
    .prepare('SELECT xml_signed FROM core_fiscal_documents WHERE id = ?')
    .get(doc.id) as { xml_signed: string | null };

  return {
    ...describe(doc, String(xml.xml_signed ?? '').includes(FIXTURE_SIGNATURE_MARK)),
    queue: item
      ? {
          attempts: Number(item.attempts),
          nextAttemptAt: item.next_attempt_at,
          // O caixa lê "nova tentativa automática às…" em vez de achar que parou.
          status: item.status,
          errorMessage: item.error_message,
        }
      : null,
    // A nota off-line (GAP-PRD-098): o caixa entrega o DANFCE de contingência,
    // e a tela diz até quando ela precisa ser transmitida.
    contingencia: emitidaOffline(doc.accessKey)
      ? {
          offline: true,
          pendente: offlinePendente(doc),
          prazoDeTransmissao: prazoDeTransmissao(companyId, doc.issuedAt),
        }
      : null,
  };
}

export interface SaleEmissionReadiness {
  canEmit: boolean;
  /** Já existe NFC-e desta venda: não é caso de emitir, é caso de consultar. */
  alreadyEmitted: boolean;
  /** Em linguagem de balcão, na ordem de resolver. Vazio quando dá para emitir. */
  reasons: string[];
}

/**
 * Itens do checklist que descrevem o CATÁLOGO, não esta venda.
 *
 * `buildReadiness` conta quantos produtos ativos estão sem NCM ou sem CFOP — o
 * que serve ao gestor para priorizar cadastro, e não pode decidir se a venda do
 * balcão emite. Um único produto incompleto que ninguém vendeu hoje esconderia
 * o botão de emitir a semana inteira. Quem responde por esta venda é
 * `validateNfce`, item por item, e aponta qual deles falta.
 */
const CHAVES_DE_CATALOGO = new Set([
  'product_ncm',
  'product_cfop',
  // A origem e a tributação contam o catálogo INTEIRO (GAP-PRD-095/129); a
  // desta venda é conferida logo abaixo, item por item, pela mesma régua.
  'product_origin',
  'product_tax_group',
]);

/**
 * Dá para emitir a NFC-e DESTA venda?
 *
 * O painel do PDV pergunta isto antes de mostrar o botão. A pergunta é por
 * venda, e não pela operação, porque as duas respostas divergem: a operação
 * pode estar perfeita e esta venda ter um item sem NCM — e pode estar com
 * pendência de catálogo enquanto esta venda está impecável.
 *
 * Só há dois desfechos honestos no balcão: ou o botão aparece e a emissão
 * anda, ou ele não aparece e a tela diz o que falta. Oferecer e falhar no meio
 * do atendimento é o pior dos três, e é o que acontecia quando ninguém
 * perguntava nada.
 */
export function emissionReadinessForSale(
  companyId: string,
  saleId: string,
): SaleEmissionReadiness {
  ensureCoreSchema();

  const jaTem = getDocumentBySale(companyId, saleId, MODEL_NFCE);
  if (jaTem) {
    return {
      canEmit: false,
      alreadyEmitted: true,
      reasons: ['Esta venda já tem NFC-e.'],
    };
  }

  const relatorio = buildReadiness(companyId, MODEL_NFCE);
  const motivos = relatorio.items
    .filter((i) => i.status === 'FAIL' && !CHAVES_DE_CATALOGO.has(i.key))
    .map((i) => `${i.label}: ${i.detail}`);

  // A venda em si. `loadSaleForNfce` recusa venda cancelada e venda que não é
  // desta operação — e recusar aqui é melhor do que recusar depois do clique.
  try {
    // A venda como a emissão a monta: o que o produto não declara vem do
    // grupo (GAP-PRD-129) — senão o painel recusaria o que a nota aceita.
    const venda = completarPeloGrupo(loadSaleForNfce(companyId, saleId), null);
    const config = getFiscalConfig(companyId);
    for (const p of validateNfce(venda, config)) {
      // O emitente já foi cobrado acima pelo checklist; repetir a mesma
      // pendência com outro texto faria o caixa achar que são duas.
      if (p.field.startsWith('emit.')) continue;
      motivos.push(`${p.field} — ${p.message}`);
    }
    /*
      E A TRIBUTAÇÃO DESTA VENDA, pela mesma régua da emissão (GAP-PRD-095).
      Sem isto o painel mostrava o botão com o grupo incompleto, e a recusa —
      que nomeia o campo — só aparecia depois do clique, com o cliente no caixa.
    */
    motivos.push(...motivosDaTributacaoDaVenda(venda, null));
  } catch (err) {
    motivos.push(err instanceof ApiError ? err.message : 'Não foi possível ler esta venda.');
  }

  return { canEmit: motivos.length === 0, alreadyEmitted: false, reasons: motivos };
}
