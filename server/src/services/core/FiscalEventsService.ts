/**
 * Eventos fiscais: cancelamento, carta de correção e inutilização.
 *
 * Os três compartilham a mesma mecânica — pedir à SEFAZ, esperar resposta, e
 * só então mudar o estado local — e por isso vivem juntos. O que muda é a
 * regra de quando cada um é permitido.
 *
 * ============================ AS TRÊS REGRAS ============================
 *
 * 1. NADA MUDA SEM EVIDÊNCIA. Um documento só vira CANCELLED com protocolo de
 *    evento aceito. Resposta rejeitada deixa o documento exatamente como
 *    estava — porque foi isso que aconteceu.
 *
 * 2. EVENTO NÃO APAGA NADA. O documento autorizado continua inteiro, com o
 *    XML original intocado. A carta de correção NÃO reescreve a nota: ela se
 *    soma a ela. Reescrever o autorizado apagaria o que a SEFAZ tem.
 *
 * 3. CANCELAMENTO FISCAL NÃO É CANCELAMENTO DE VENDA. Cancelar a nota não
 *    repõe estoque, não estorna dinheiro e não desfaz a venda. O cliente pagou
 *    e levou a mercadoria; o que mudou foi o documento. Desfazer o comercial
 *    em silêncio produziria estoque fantasma e caixa furado.
 *
 * =======================================================================
 */
import { randomUUID } from 'node:crypto';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { recordDomainEvent } from '../sync/DomainEvents.js';
import { recordAudit } from '../audit/AuditService.js';
import { getFiscalConfig, type FiscalConfig } from './FiscalConfigService.js';
import { getDocument, transition, type FiscalDocument } from './FiscalDocumentService.js';
import { MODEL_NFCE, MODEL_NFE, type FiscalEnvironment } from './FiscalKeyService.js';
import { momentoFiscal } from './MomentoFiscal.js';
import { montarProcEventoNfe, montarProcInutNfe } from './FiscalProcNfe.js';
import { classifyCStat, type SefazAdapter, type SefazResponse } from './SefazAdapter.js';
import { assertAdapterPodeAgirNoDocumento } from './FiscalAtosAdministrativos.js';
import { numeroNaoConsumidoPelaSefaz } from './FiscalReemissao.js';
import { lerOperacao, operacaoDoDocumento } from './FiscalOperacoes.js';

/**
 * O adapter de um ato — pronto, ou a fábrica dele.
 *
 * A fábrica é o caminho da rota (GAP-PRD-005): o certificado só é aberto
 * depois de a nota passar pelas validações, então "justificativa curta" e
 * "só nota autorizada" continuam respondendo antes de "falta o A1".
 */
export type AdapterDoAto = SefazAdapter | (() => SefazAdapter);

function resolverAdapter(adapter: AdapterDoAto): SefazAdapter {
  return typeof adapter === 'function' ? adapter() : adapter;
}

/**
 * O ambiente em que a NOTA vive — é lá que o evento sobre ela vale.
 *
 * A config diz o ambiente de HOJE; a nota guarda o de quando foi autorizada.
 * Cancelar em produção uma nota de homologação (ou o contrário) é pedir à
 * SEFAZ que ache, no ambiente errado, uma chave que nunca esteve lá.
 */
function ambienteDaNota(doc: FiscalDocument, config: FiscalConfig): FiscalEnvironment {
  return doc.environment === 'production' || doc.environment === 'homologation'
    ? doc.environment
    : config.environment;
}

/** Os modelos que se inutilizam: NF-e e NFC-e. */
const MODELOS_INUTILIZAVEIS: readonly string[] = [MODEL_NFE, MODEL_NFCE];

/** O ano mais antigo que o leiaute aceita numa inutilização (cStat 454 abaixo disso). */
export const VOID_YEAR_MIN = 2006;

/**
 * O documento de ARQUIVAMENTO de um evento aceito (GAP-V32).
 *
 * Só existe quando o adapter entregou as duas metades — o evento assinado e o
 * retorno íntegro. O provider de teste nunca entrega a primeira, e é assim que
 * ensaio não vira prova; o legado (evento gravado antes desta rodada) fica sem
 * a coluna para sempre, e o LEIA-ME do pacote declara a ressalva.
 */
function procDoEvento(response: SefazResponse): string | null {
  return montarProcEventoNfe({
    eventoAssinado: response.xmlEventoAssinado,
    retorno: response.rawResponseIntegro,
  });
}

/** O arquivamento da INUTILIZAÇÃO — o espelho de `procDoEvento`. */
function procDaInutilizacao(response: SefazResponse): string | null {
  return montarProcInutNfe({
    inutAssinado: response.xmlInutAssinado,
    retorno: response.rawResponseIntegro,
  });
}

/**
 * Tamanho da justificativa.
 *
 * O piso existe porque "cancelamento" não explica nada a quem auditar meses
 * depois; o teto é o limite do campo no layout.
 */
export const JUSTIFICATION_MIN = 15;
export const JUSTIFICATION_MAX = 255;

/** Texto da carta de correção. */
export const CCE_TEXT_MIN = 15;
export const CCE_TEXT_MAX = 1000;

/**
 * O que a carta de correção NÃO pode tocar.
 *
 * A legislação lista alterações vedadas — valores, quantidades, identidade das
 * partes, data de emissão. Implementar a lista COMPLETA exige a norma vigente,
 * que não está no projeto; então a política aqui é CONSERVADORA: bloqueia o
 * que é reconhecidamente proibido e não promete cobrir o resto.
 *
 * É melhor recusar uma correção legítima (o usuário emite nota nova) do que
 * aceitar uma proibida e descobrir na fiscalização.
 */
export const CCE_FORBIDDEN_PATTERNS: { termo: RegExp; motivo: string }[] = [
  { termo: /\bvalor(es)?\b/i, motivo: 'valores não podem ser corrigidos por carta' },
  { termo: /\bpre[çc]o\b/i, motivo: 'preço não pode ser corrigido por carta' },
  { termo: /\bquantidade\b/i, motivo: 'quantidade não pode ser corrigida por carta' },
  { termo: /\bal[íi]quota\b/i, motivo: 'tributação não pode ser corrigida por carta' },
  { termo: /\bimposto\b/i, motivo: 'tributação não pode ser corrigida por carta' },
  { termo: /\bICMS\b/i, motivo: 'tributação não pode ser corrigida por carta' },
  { termo: /\bCNPJ\b/i, motivo: 'identidade das partes não pode ser corrigida por carta' },
  { termo: /\bCPF\b/i, motivo: 'identidade das partes não pode ser corrigida por carta' },
  {
    termo: /\bdata de emiss[ãa]o\b/i,
    motivo: 'data de emissão não pode ser corrigida por carta',
  },
];

/** Aviso mostrado na interface — a limitação precisa estar visível. */
export const CCE_LIMITATION_NOTICE =
  'A carta de correção não altera a NF-e: ela se soma a ela. Valores, quantidades, '
  + 'tributação, identidade das partes e data de emissão NÃO podem ser corrigidos por '
  + 'carta — nesses casos o caminho é cancelar e emitir nova nota. Este sistema aplica '
  + 'uma política conservadora e pode recusar textos que a norma permitiria.';

function assertJustification(texto: string, campo = 'justificativa'): string {
  const limpo = (texto ?? '').trim();
  if (limpo.length < JUSTIFICATION_MIN) {
    throw new ApiError(
      'CORE_FISCAL_JUSTIFICATION_TOO_SHORT',
      `A ${campo} precisa ter ao menos ${JUSTIFICATION_MIN} caracteres — ela é o que explica `
        + 'a operação a quem auditar depois.',
      400,
    );
  }
  if (limpo.length > JUSTIFICATION_MAX) {
    throw new ApiError(
      'CORE_FISCAL_JUSTIFICATION_TOO_LONG',
      `A ${campo} passa do limite de ${JUSTIFICATION_MAX} caracteres.`,
      400,
    );
  }
  return limpo;
}

interface RegistrarEventoInput {
  companyId: string;
  documentId: string | null;
  eventType: string;
  sequence?: number;
  justification?: string | null;
  protocol?: string | null;
  cStat?: string | null;
  xMotivo?: string | null;
  xml?: string | null;
  /** O procEventoNFe íntegro (GAP-V32) — ver o comentário da coluna. */
  xmlProc?: string | null;
  model?: string | null;
  serie?: number | null;
  numberFrom?: number | null;
  numberTo?: number | null;
  userId?: string | null;
}

function registrarEvento(input: RegistrarEventoInput): string {
  // Transacional em si mesma: o evento fiscal e o fato para a central saem
  // juntos ou não saem. Aninhada, vira SAVEPOINT.
  return withTransaction(() => gravarEventoFiscal(input));
}

function gravarEventoFiscal(input: RegistrarEventoInput): string {
  const id = randomUUID();
  getConnection()
    .prepare(
      `INSERT INTO core_fiscal_events
         (id, company_id, document_id, event_type, sequence, justification, protocol,
          c_stat, x_motivo, xml, xml_proc, model, serie, number_from, number_to, user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.companyId,
      input.documentId,
      input.eventType,
      input.sequence ?? 1,
      input.justification ?? null,
      input.protocol ?? null,
      input.cStat ?? null,
      input.xMotivo ?? null,
      input.xml ?? null,
      // O documento de arquivamento, quando o adapter entregou as duas
      // metades. `xml` acima continua sendo o retorno SANITIZADO — o que
      // muda no GAP-V32 é o armazenamento do documento, não o do log.
      input.xmlProc ?? null,
      input.model ?? null,
      input.serie ?? null,
      input.numberFrom ?? null,
      input.numberTo ?? null,
      input.userId ?? null,
      new Date().toISOString(),
    );

  // Cancelamento, CC-e e inutilização são fatos fiscais e vão para a central.
  // O XML fica no nó: ele carrega assinatura e não acrescenta nada ao
  // consolidado.
  recordDomainEvent({
    eventType: 'fiscal.event_recorded',
    aggregateType: 'fiscal_event',
    aggregateId: id,
    companyId: input.companyId,
    payload: {
      id,
      document_id: input.documentId ?? null,
      fiscal_event_type: input.eventType,
      sequence: input.sequence ?? 1,
      protocol: input.protocol ?? null,
      c_stat: input.cStat ?? null,
      x_motivo: input.xMotivo ?? null,
      model: input.model ?? null,
      serie: input.serie ?? null,
      number_from: input.numberFrom ?? null,
      number_to: input.numberTo ?? null,
    },
  });

  recordAudit({
    companyId: input.companyId,
    userId: input.userId ?? null,
    action: `fiscal.${input.eventType}`,
    entityType: 'fiscal_document',
    entityId: input.documentId ?? input.companyId,
    detail: { cStat: input.cStat, protocol: input.protocol },
  });

  return id;
}

/** A resposta do fisco aceitou o evento? */
function eventoAceito(response: SefazResponse): boolean {
  // 135/136 = evento registrado; 155 = cancelamento homologado fora do prazo.
  const aceitos = ['135', '136', '155', '102'];
  return Boolean(response.protocol) && aceitos.includes(response.cStat ?? '');
}

// ------------------------------------------------------------ cancelamento

export interface CancelResult {
  document: FiscalDocument;
  accepted: boolean;
  eventId: string;
  cStat: string | null;
  xMotivo: string | null;
  protocol: string | null;
}

/**
 * Solicita o cancelamento de uma NF-e autorizada.
 *
 * IDEMPOTENTE: documento já cancelado devolve o cancelamento existente em vez
 * de pedir outro. Dois cliques não produzem dois eventos.
 */
export async function requestCancel(input: {
  companyId: string;
  documentId: string;
  justification: string;
  /** O adapter, ou quem o fabrica — chamado só depois das validações da nota. */
  adapter: AdapterDoAto;
  userId?: string | null;
  /** O relógio do pedido — injetável para o teste do prazo. */
  now?: Date;
}): Promise<CancelResult> {
  ensureCoreSchema();

  const justificativa = assertJustification(input.justification);
  const doc = getDocument(input.companyId, input.documentId);
  if (!doc) {
    throw new ApiError('CORE_FISCAL_DOCUMENT_NOT_FOUND', 'Documento fiscal não encontrado.', 404);
  }

  // Já cancelado: devolve o que existe. Pedir de novo geraria um segundo
  // evento para um fato que já aconteceu.
  if (doc.status === 'CANCELLED') {
    const anterior = getConnection()
      .prepare(
        `SELECT id, protocol, c_stat, x_motivo FROM core_fiscal_events
          WHERE document_id = ? AND event_type = 'cancelled' ORDER BY created_at DESC LIMIT 1`,
      )
      .get(doc.id) as Record<string, unknown> | undefined;
    return {
      document: doc,
      accepted: true,
      eventId: String(anterior?.id ?? ''),
      cStat: (anterior?.c_stat as string | null) ?? null,
      xMotivo: (anterior?.x_motivo as string | null) ?? null,
      protocol: (anterior?.protocol as string | null) ?? null,
    };
  }

  if (doc.status !== 'AUTHORIZED' || !doc.protocol) {
    throw new ApiError(
      'CORE_FISCAL_CANCEL_NOT_ALLOWED',
      `Só nota autorizada pode ser cancelada. Esta está como ${doc.status}.`,
      409,
      { status: doc.status },
    );
  }

  const config = getFiscalConfig(input.companyId);

  /*
    O PRAZO DE CANCELAMENTO (P0 fiscal).

    O defeito: nenhum prazo era conferido — o pedido fora do prazo ia à SEFAZ,
    voltava recusado, e o gerente só descobria depois de abrir o certificado e
    registrar "cancelamento pedido" na linha do tempo. O prazo é da UF e do
    modelo (NFC-e e NF-e têm prazos diferentes), então ele NÃO é cravado aqui:
    é o que o contador informou na operação fiscal da empresa. Sem prazo
    informado, nada muda — a SEFAZ decide, e a falta aparece como pendência
    contábil.
  */
  const origem = getConnection()
    .prepare('SELECT origin_type FROM core_fiscal_documents WHERE id = ? AND company_id = ?')
    .get(doc.id, input.companyId) as { origin_type: string | null } | undefined;
  const operacao = lerOperacao(
    input.companyId,
    operacaoDoDocumento({ model: doc.model, originType: origem?.origin_type ?? null }),
  );
  const prazo = operacao.prazoCancelamentoMinutos;
  const autorizadaEm = doc.authorizedAt ? new Date(doc.authorizedAt).getTime() : Number.NaN;
  const agora = (input.now ?? new Date()).getTime();
  if (prazo !== null && Number.isFinite(autorizadaEm) && agora - autorizadaEm > prazo * 60_000) {
    throw new ApiError(
      'CORE_FISCAL_CANCEL_DEADLINE_EXCEEDED',
      `O prazo de cancelamento desta nota (${prazo} min depois da autorização, o que o contador informou `
        + `para a UF em "${operacao.rotulo}") terminou em ${new Date(autorizadaEm + prazo * 60_000).toISOString()}. `
        + 'Fora do prazo a SEFAZ recusa o cancelamento: o caminho é o que o contador indicar para a UF '
        + '(nota de devolução/estorno, ou cancelamento extemporâneo onde a UF o aceita).',
      409,
      { prazoMinutos: prazo, autorizadaEm: doc.authorizedAt },
    );
  }

  // O adapter nasce DEPOIS das validações da nota (o certificado só é aberto
  // para um ato que vai acontecer) e ANTES do registro do pedido: um ato que
  // não pode sair não deixa "cancelamento pedido" pendurado na linha do tempo.
  const adapter = resolverAdapter(input.adapter);
  assertAdapterPodeAgirNoDocumento({ companyId: input.companyId, adapter, doc });

  registrarEvento({
    companyId: input.companyId,
    documentId: doc.id,
    eventType: 'cancel_requested',
    justification: justificativa,
    userId: input.userId,
  });

  const response = await adapter.cancel({
    companyId: input.companyId,
    accessKey: doc.accessKey!,
    // O modelo escolhe o host: NFC-e e NF-e moram em endereços diferentes.
    model: doc.model,
    protocol: doc.protocol,
    justification: justificativa,
    uf: config.uf ?? '',
    environment: ambienteDaNota(doc, config),
  });

  const aceito = eventoAceito(response);

  const eventId = registrarEvento({
    companyId: input.companyId,
    documentId: doc.id,
    eventType: aceito ? 'cancelled' : 'cancel_rejected',
    justification: justificativa,
    protocol: response.protocol,
    cStat: response.cStat,
    xMotivo: response.xMotivo,
    xml: response.rawResponse,
    // Recusa não gera prova: só o evento ACEITO tem procEventoNFe.
    xmlProc: aceito ? procDoEvento(response) : null,
    userId: input.userId,
  });

  // SEM PROTOCOLO NÃO HÁ CANCELAMENTO. A nota continua valendo, e é isso que
  // o operador precisa ver.
  if (!aceito) {
    return {
      document: getDocument(input.companyId, doc.id)!,
      accepted: false,
      eventId,
      cStat: response.cStat,
      xMotivo: response.xMotivo,
      protocol: null,
    };
  }

  const atualizado = transition({
    companyId: input.companyId,
    documentId: doc.id,
    to: 'CANCELLED',
    patch: {
      cancelled_at: response.receivedAt,
      // O protocolo de AUTORIZAÇÃO permanece: ele prova que a nota existiu.
      // O do cancelamento vive no evento.
      x_motivo: response.xMotivo,
    },
    detail: { cancelProtocol: response.protocol, cStat: response.cStat },
    userId: input.userId,
  });

  return {
    document: atualizado,
    accepted: true,
    eventId,
    cStat: response.cStat,
    xMotivo: response.xMotivo,
    protocol: response.protocol,
  };
}

// ------------------------------------------------------------------- CC-e

export interface CorrectionResult {
  accepted: boolean;
  eventId: string;
  sequence: number;
  cStat: string | null;
  xMotivo: string | null;
  protocol: string | null;
}

/** Recusa o texto quando ele tenta corrigir o que carta não corrige. */
export function checkCorrectionText(texto: string): string | null {
  for (const { termo, motivo } of CCE_FORBIDDEN_PATTERNS) {
    if (termo.test(texto)) return motivo;
  }
  return null;
}

/**
 * Emite carta de correção para uma NF-e autorizada.
 *
 * A SEQUÊNCIA é atribuída dentro da transação, a partir do maior já usado
 * naquele documento. Duas cartas simultâneas recebem números diferentes —
 * sequência repetida é rejeição na SEFAZ.
 */
export async function requestCorrectionLetter(input: {
  companyId: string;
  documentId: string;
  text: string;
  /** O adapter, ou quem o fabrica — chamado só depois das validações da nota. */
  adapter: AdapterDoAto;
  userId?: string | null;
}): Promise<CorrectionResult> {
  ensureCoreSchema();

  const texto = (input.text ?? '').trim();
  if (texto.length < CCE_TEXT_MIN || texto.length > CCE_TEXT_MAX) {
    throw new ApiError(
      'CORE_FISCAL_CCE_TEXT_INVALID',
      `O texto da correção precisa ter entre ${CCE_TEXT_MIN} e ${CCE_TEXT_MAX} caracteres.`,
      400,
    );
  }

  const proibido = checkCorrectionText(texto);
  if (proibido) {
    throw new ApiError(
      'CORE_FISCAL_CCE_FORBIDDEN',
      `Esta correção não é permitida por carta: ${proibido}. `
        + 'O caminho é cancelar a nota e emitir outra.',
      409,
      { notice: CCE_LIMITATION_NOTICE },
    );
  }

  const doc = getDocument(input.companyId, input.documentId);
  if (!doc) {
    throw new ApiError('CORE_FISCAL_DOCUMENT_NOT_FOUND', 'Documento fiscal não encontrado.', 404);
  }
  if (doc.model !== MODEL_NFE) {
    throw new ApiError(
      'CORE_FISCAL_CCE_WRONG_MODEL',
      'Carta de correção é da NF-e modelo 55.',
      409,
    );
  }
  if (doc.status !== 'AUTHORIZED') {
    throw new ApiError(
      'CORE_FISCAL_CCE_NOT_ALLOWED',
      `Só nota autorizada recebe carta de correção. Esta está como ${doc.status}.`,
      409,
    );
  }

  // O adapter nasce antes de reservar a sequência: um ato que não pode sair
  // (sem certificado, simulador sobre nota real, produção) não gasta número.
  const adapter = resolverAdapter(input.adapter) as SefazAdapter & {
    correctionLetter?: (i: {
      companyId: string;
      accessKey: string;
      model?: string;
      sequence: number;
      text: string;
      uf: string;
      environment: FiscalEnvironment;
    }) => Promise<SefazResponse>;
  };
  assertAdapterPodeAgirNoDocumento({ companyId: input.companyId, adapter, doc });
  if (!adapter.correctionLetter) {
    throw new ApiError(
      'CORE_FISCAL_CCE_NOT_SUPPORTED',
      'O provider configurado não implementa carta de correção.',
      501,
    );
  }

  // Reserva a sequência numa transação própria: é o que garante unicidade sob
  // concorrência, do mesmo jeito que a numeração fiscal.
  const sequence = withTransaction(() => {
    const row = getConnection()
      .prepare(
        `SELECT COALESCE(MAX(sequence), 0) AS ultima FROM core_fiscal_events
          WHERE document_id = ? AND event_type IN ('cce_requested', 'cce_authorized')`,
      )
      .get(doc.id) as { ultima: number };
    const proxima = Number(row.ultima) + 1;

    registrarEvento({
      companyId: input.companyId,
      documentId: doc.id,
      eventType: 'cce_requested',
      sequence: proxima,
      justification: texto,
      userId: input.userId,
    });
    return proxima;
  });

  const config = getFiscalConfig(input.companyId);
  const response = await adapter.correctionLetter({
    companyId: input.companyId,
    accessKey: doc.accessKey!,
    model: doc.model,
    sequence,
    text: texto,
    uf: config.uf ?? '',
    environment: ambienteDaNota(doc, config),
  });

  const aceito = eventoAceito(response);
  const eventId = registrarEvento({
    companyId: input.companyId,
    documentId: doc.id,
    eventType: aceito ? 'cce_authorized' : 'cce_rejected',
    sequence,
    justification: texto,
    protocol: response.protocol,
    cStat: response.cStat,
    xMotivo: response.xMotivo,
    xml: response.rawResponse,
    // A carta aceita ganha o mesmo arquivamento do cancelamento.
    xmlProc: aceito ? procDoEvento(response) : null,
    userId: input.userId,
  });

  return {
    accepted: aceito,
    eventId,
    sequence,
    cStat: response.cStat,
    xMotivo: response.xMotivo,
    protocol: response.protocol,
  };
}

// ----------------------------------------------------------- inutilização

export interface VoidRangeResult {
  accepted: boolean;
  eventId: string;
  cStat: string | null;
  xMotivo: string | null;
  protocol: string | null;
}

/**
 * Números já usados na faixa — emitidos ou já inutilizados.
 *
 * Inutilizar um número que já virou nota é impossível, e o sistema precisa
 * dizer isso antes de mandar para a SEFAZ.
 */
function conflitosNaFaixa(input: {
  companyId: string;
  model: string;
  serie: number;
  from: number;
  to: number;
}): { emitidos: number[]; inutilizados: [number, number][] } {
  const db = getConnection();

  /*
    NÚMERO QUE A SEFAZ NÃO CONSUMIU SE INUTILIZA (P0 fiscal).

    O defeito: qualquer linha de documento na faixa bloqueava a inutilização —
    inclusive a nota REJEITADA, cujo número a SEFAZ não gravou. Quem desistia
    de corrigir uma rejeitada ficava com um buraco na numeração que nenhuma
    inutilização podia justificar. Agora só bloqueia o número consumido (ver
    `numeroNaoConsumidoPelaSefaz`): autorizada, cancelada, denegada, em
    andamento, ou rejeitada por duplicidade (539 — o número é de outra chave).
  */
  const emitidos = (
    db
      .prepare(
        `SELECT id, number, status, c_stat FROM core_fiscal_documents
          WHERE company_id = ? AND model = ? AND serie = ?
            AND number BETWEEN ? AND ?`,
      )
      .all(input.companyId, input.model, input.serie, input.from, input.to) as unknown as {
      id: string;
      number: number;
      status: string;
      c_stat: string | null;
    }[]
  )
    .filter((r) => !numeroNaoConsumidoPelaSefaz(input.companyId, r))
    .map((r) => Number(r.number));

  /**
   * Faixas bloqueadas: as já inutilizadas E as EM CURSO.
   *
   * Olhar só as autorizadas não reservava nada: a autorização só chega depois
   * da resposta da SEFAZ, então dois pedidos simultâneos passavam os dois pela
   * conferência e produziam duas inutilizações da mesma faixa. Foi assim que o
   * teste de concorrência falhou.
   *
   * "Em curso" é derivado sem escrever de volta — os eventos são append-only:
   * um pedido cuja faixa ainda não tem desfecho (nem autorizado, nem
   * rejeitado) conta como reservado. Faixa rejeitada volta a ficar livre.
   */
  const bloqueadas = (
    db
      .prepare(
        `SELECT number_from, number_to,
                SUM(CASE WHEN event_type = 'void_requested'  THEN 1 ELSE 0 END) AS pedidos,
                SUM(CASE WHEN event_type = 'void_authorized' THEN 1 ELSE 0 END) AS aceitos,
                SUM(CASE WHEN event_type = 'void_rejected'   THEN 1 ELSE 0 END) AS recusados
           FROM core_fiscal_events
          WHERE company_id = ? AND model = ? AND serie = ?
            AND event_type IN ('void_requested', 'void_authorized', 'void_rejected')
            AND number_from <= ? AND number_to >= ?
          GROUP BY number_from, number_to`,
      )
      .all(input.companyId, input.model, input.serie, input.to, input.from) as unknown as {
      number_from: number;
      number_to: number;
      pedidos: number;
      aceitos: number;
      recusados: number;
    }[]
  )
    .filter((r) => Number(r.aceitos) > 0 || Number(r.pedidos) > Number(r.aceitos) + Number(r.recusados))
    .map((r) => [Number(r.number_from), Number(r.number_to)] as [number, number]);

  return { emitidos, inutilizados: bloqueadas };
}

/**
 * Inutiliza uma faixa de numeração.
 *
 * DEPOIS DISSO O NÚMERO NUNCA MAIS SAI. A sequência é empurrada para além da
 * faixa dentro da MESMA transação da checagem — senão duas inutilizações
 * concorrentes, ou uma emissão no meio, poderiam usar um número já queimado.
 */
export async function requestVoidRange(input: {
  companyId: string;
  model: string;
  serie: number;
  /** AAAA. Ausente: o ano corrente no relógio do emitente. */
  year?: number;
  from: number;
  to: number;
  justification: string;
  /** O adapter, ou quem o fabrica — chamado só depois das validações do pedido. */
  adapter: AdapterDoAto;
  userId?: string | null;
}): Promise<VoidRangeResult> {
  let numeroAntesDaFaixa: number | null = null;
  ensureCoreSchema();

  const justificativa = assertJustification(input.justification);

  /*
    MODELO, SÉRIE E ANO SÃO CONFERIDOS ANTES DE RESERVAR — GAP-PRD-019.

    O ano era aceito e jogado fora: o adapter tirava o ano do relógio. Agora
    ele viaja no Id e no <ano> do inutNFe, então precisa ser um ano que a
    SEFAZ aceite — nem futuro (453) nem anterior a 2006 (454). "Futuro" é pelo
    relógio do EMITENTE: no réveillon, a máquina em UTC já virou o ano e a loja
    em Pelotas ainda não.
  */
  if (!MODELOS_INUTILIZAVEIS.includes(String(input.model))) {
    throw new ApiError(
      'CORE_FISCAL_VOID_MODEL_INVALID',
      `Modelo "${String(input.model)}" não se inutiliza aqui: os modelos são ${MODEL_NFE} (NF-e) e ${MODEL_NFCE} (NFC-e).`,
      400,
    );
  }
  if (!Number.isInteger(input.serie) || input.serie < 0 || input.serie > 999) {
    throw new ApiError('CORE_FISCAL_VOID_SERIE_INVALID', 'A série vai de 0 a 999.', 400);
  }
  const configDoEmitente = getFiscalConfig(input.companyId);
  const anoCorrente = Number(
    `20${momentoFiscal(new Date(), configDoEmitente.uf ?? '').aamm.slice(0, 2)}`,
  );
  const ano = input.year === undefined ? anoCorrente : input.year;
  if (!Number.isInteger(ano) || ano < VOID_YEAR_MIN || ano > anoCorrente) {
    throw new ApiError(
      'CORE_FISCAL_VOID_YEAR_INVALID',
      `O ano da inutilização vai de ${VOID_YEAR_MIN} a ${anoCorrente} — a SEFAZ não inutiliza `
        + 'numeração de ano futuro nem anterior a 2006.',
      400,
    );
  }

  if (!Number.isInteger(input.from) || !Number.isInteger(input.to) || input.from < 1) {
    throw new ApiError('CORE_FISCAL_VOID_RANGE_INVALID', 'Faixa inválida.', 400);
  }
  if (input.to < input.from) {
    throw new ApiError(
      'CORE_FISCAL_VOID_RANGE_INVALID',
      'O número final não pode ser menor que o inicial.',
      400,
    );
  }

  // O adapter nasce antes de reservar: sem certificado, ou com simulador em
  // produção, a faixa não fica presa esperando uma resposta que não virá.
  const adapter = resolverAdapter(input.adapter);
  assertAdapterPodeAgirNoDocumento({ companyId: input.companyId, adapter, doc: null });

  // Reserva a faixa ANTES de falar com a SEFAZ: a checagem e o avanço da
  // sequência precisam ser atômicos entre si.
  const reservado = withTransaction(() => {
    const conflitos = conflitosNaFaixa({
      companyId: input.companyId,
      model: input.model,
      serie: input.serie,
      from: input.from,
      to: input.to,
    });

    if (conflitos.emitidos.length > 0) {
      throw new ApiError(
        'CORE_FISCAL_VOID_NUMBER_USED',
        `A faixa contém número já emitido: ${conflitos.emitidos.slice(0, 10).join(', ')}. `
          + 'Número que virou nota não se inutiliza — se a nota não vale, o caminho é cancelar.',
        409,
        { used: conflitos.emitidos },
      );
    }
    if (conflitos.inutilizados.length > 0) {
      throw new ApiError(
        'CORE_FISCAL_VOID_RANGE_OVERLAP',
        `A faixa se sobrepõe a uma inutilização existente `
          + `(${conflitos.inutilizados.map(([a, b]) => `${a}-${b}`).join(', ')}).`,
        409,
      );
    }

    const db = getConnection();

    /*
      GUARDA O QUE ERA, PARA PODER DESFAZER.

      Empurrar a sequência ANTES de falar com a SEFAZ está certo: é isso que
      impede uma emissão concorrente de cair dentro do intervalo que está
      sendo inutilizado. O que faltava era o desfazer — nada voltava atrás
      quando a resposta era recusa, e `setSeriesNextNumber` recusa retroceder.

      O gerente digitava 10-20 por engano, a SEFAZ recusava, e a numeração
      saltava de 9 para 21 sem nenhuma inutilização autorizada para justificar
      o buraco no pacote do contador.
    */
    const anterior = db
      .prepare(
        'SELECT next_number FROM core_fiscal_series WHERE company_id = ? AND model = ? AND serie = ?',
      )
      .get(input.companyId, input.model, input.serie) as { next_number?: number } | undefined;
    numeroAntesDaFaixa = anterior?.next_number ?? null;
    // Empurra a sequência para depois da faixa, se necessário. É isto que
    // impede a próxima emissão de cair dentro do intervalo queimado.
    db.prepare(
      `INSERT INTO core_fiscal_series (id, company_id, model, serie, next_number, active, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT (company_id, model, serie) DO NOTHING`,
    ).run(
      randomUUID(),
      input.companyId,
      input.model,
      input.serie,
      input.to + 1,
      new Date().toISOString(),
    );
    db.prepare(
      `UPDATE core_fiscal_series SET next_number = ?
        WHERE company_id = ? AND model = ? AND serie = ? AND next_number <= ?`,
    ).run(input.to + 1, input.companyId, input.model, input.serie, input.to);

    return registrarEvento({
      companyId: input.companyId,
      documentId: null,
      eventType: 'void_requested',
      justification: justificativa,
      model: input.model,
      serie: input.serie,
      numberFrom: input.from,
      numberTo: input.to,
      userId: input.userId,
    });
  });
  void reservado;

  const config = getFiscalConfig(input.companyId);
  const response = await adapter.voidNumberRange({
    companyId: input.companyId,
    model: input.model,
    serie: input.serie,
    from: input.from,
    to: input.to,
    // O ano do pedido e o emitente do cadastro — não o relógio nem o A1.
    year: ano,
    cnpj: (config.cnpj ?? '').replace(/\D/g, '') || undefined,
    justification: justificativa,
    uf: config.uf ?? '',
    environment: config.environment,
  });

  const aceito = eventoAceito(response);

  /*
    RECUSADA: a faixa volta a ficar livre DE VERDADE.

    Só desfaz se ninguém mexeu na sequência no meio: se ela ainda está
    exatamente em `to + 1`, o empurrão desta chamada é o único responsável por
    ela estar ali. Qualquer outro valor significa que houve emissão depois, e
    aí voltar atrás produziria número repetido — que é pior que o buraco.
  */
  if (!aceito && numeroAntesDaFaixa !== null) {
    getConnection()
      .prepare(
        `UPDATE core_fiscal_series SET next_number = ?
          WHERE company_id = ? AND model = ? AND serie = ? AND next_number = ?`,
      )
      .run(numeroAntesDaFaixa, input.companyId, input.model, input.serie, input.to + 1);
  }
  const eventId = registrarEvento({
    companyId: input.companyId,
    documentId: null,
    eventType: aceito ? 'void_authorized' : 'void_rejected',
    justification: justificativa,
    protocol: response.protocol,
    cStat: response.cStat,
    xMotivo: response.xMotivo,
    xml: response.rawResponse,
    /*
      A INUTILIZAÇÃO TAMBÉM DEIXA PROVA — o resíduo do GAP-V32.

      O cancelamento e a CC-e ganharam o procEventoNFe íntegro naquela rodada; a
      inutilização ficou de fora e continuava entregando ao contador apenas o
      retorno sanitizado, com a assinatura trocada por "[removido]". É justo o
      documento em que a prova mais importa: ele existe PARA justificar números
      que nunca viraram nota.

      Só o ACEITO: recusa não gera prova — arquivar um "procInutNFe" de um
      pedido que a SEFAZ negou seria guardar a prova de um ato que não
      aconteceu.
    */
    xmlProc: aceito ? procDaInutilizacao(response) : null,
    model: input.model,
    serie: input.serie,
    numberFrom: input.from,
    numberTo: input.to,
    userId: input.userId,
  });

  return {
    accepted: aceito,
    eventId,
    cStat: response.cStat,
    xMotivo: response.xMotivo,
    protocol: response.protocol,
  };
}

export interface VoidRangeRow {
  id: string;
  model: string;
  serie: number;
  from: number;
  to: number;
  justification: string | null;
  status: 'AUTHORIZED' | 'REJECTED' | 'REQUESTED';
  cStat: string | null;
  xMotivo: string | null;
  protocol: string | null;
  createdAt: string;
}

/**
 * Faixas inutilizadas, UMA LINHA POR FAIXA.
 *
 * A tabela de eventos é append-only: um pedido aceito deixa `void_requested` E
 * `void_authorized`. Listar os eventos crus mostrava a mesma faixa duas vezes,
 * uma delas "aguardando resposta" — quem lê entende que pediu duas vezes e que
 * uma ficou pendurada. O pedido é o RASTRO; o que a tela mostra é o desfecho.
 *
 * O pedido sem desfecho continua aparecendo, e deve: é a faixa que ficou no ar.
 */
export function listVoidRanges(companyId: string): VoidRangeRow[] {
  ensureCoreSchema();
  const rows = getConnection()
    .prepare(
      `SELECT * FROM core_fiscal_events e
        WHERE e.company_id = ?
          AND e.event_type IN ('void_authorized', 'void_rejected', 'void_requested')
          -- O pedido só aparece enquanto não houver desfecho para a mesma faixa.
          AND (
            e.event_type <> 'void_requested'
            OR NOT EXISTS (
              SELECT 1 FROM core_fiscal_events d
               WHERE d.company_id = e.company_id
                 AND d.event_type IN ('void_authorized', 'void_rejected')
                 AND d.model = e.model AND d.serie = e.serie
                 AND d.number_from = e.number_from AND d.number_to = e.number_to
                 AND d.created_at >= e.created_at
            )
          )
        ORDER BY e.created_at DESC LIMIT 200`,
    )
    .all(companyId) as unknown as Record<string, unknown>[];

  return rows.map((r) => ({
    id: String(r.id),
    model: String(r.model ?? ''),
    serie: Number(r.serie ?? 0),
    from: Number(r.number_from ?? 0),
    to: Number(r.number_to ?? 0),
    justification: (r.justification as string | null) ?? null,
    status:
      r.event_type === 'void_authorized'
        ? 'AUTHORIZED'
        : r.event_type === 'void_rejected'
          ? 'REJECTED'
          : 'REQUESTED',
    cStat: (r.c_stat as string | null) ?? null,
    xMotivo: (r.x_motivo as string | null) ?? null,
    protocol: (r.protocol as string | null) ?? null,
    createdAt: String(r.created_at),
  }));
}

export { classifyCStat };
