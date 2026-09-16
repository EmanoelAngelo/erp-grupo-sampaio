/**
 * Ciclo de vida do documento fiscal.
 *
 * O documento é CONSEQUÊNCIA de uma venda. Criar um documento não cria venda,
 * não baixa estoque e não gera receita — esses fatos já aconteceram no
 * fechamento do caixa.
 *
 * DUAS INVARIANTES SUSTENTAM O RESTO
 *
 * 1. UMA VENDA, UM DOCUMENTO POR MODELO. Garantido pelo banco
 *    (`UNIQUE (company_id, idempotency_key)`), não por conferência antes de
 *    gravar: cem cliques simultâneos passariam todos pela conferência antes de
 *    qualquer um gravar. Documento duplicado significa DOIS números fiscais
 *    queimados e duas chaves para a mesma venda.
 *
 * 2. ESTADO SÓ ANDA PARA FRENTE, pelas transições declaradas. `AUTHORIZED`
 *    nunca volta a `DRAFT`; `CANCELLED` nunca volta a `AUTHORIZED`; `REJECTED`
 *    nunca é apresentado como autorizado. Sem isso, um retry mal colocado
 *    reapresentaria como válida uma nota que a SEFAZ recusou.
 */
import { randomUUID } from 'node:crypto';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { limitesDoPeriodo } from './CalendarioOperacional.js';
import { ApiError } from '../../utils/errors.js';
import { recordDomainEvent } from '../sync/DomainEvents.js';
import { recordAudit } from '../audit/AuditService.js';
import { assertCanEmit, getFiscalConfig } from './FiscalConfigService.js';
import { MODEL_NFCE, MODEL_NFE, reserveNextNumber, resolveSerie } from './FiscalKeyService.js';
import {
  buildNfceXml,
  conferirExigenciasDaMontagem,
  loadSaleForNfce,
  validateAgainstSchema,
  validateNfce,
} from './FiscalXmlNfce.js';
import { completarPeloGrupo } from './TributacaoDoItem.js';
import {
  buildNfeXml,
  validateNfe,
  type NfeRecipient,
  type NfeTransport,
  type PresenceIndicator,
} from './FiscalXmlNfe.js';
import { conferirLeiauteAntesDeNumerar } from './FiscalXsdValidator.js';
import { emissaoEmContingencia } from './FiscalContingenciaOffline.js';
import { municipioDaNotaQueNaoConfere } from './MunicipiosIbge.js';

export type FiscalStatus =
  | 'DRAFT'
  | 'VALIDATED'
  | 'SIGNED'
  | 'QUEUED'
  | 'SENDING'
  | 'AUTHORIZED'
  | 'REJECTED'
  | 'CONTINGENCY'
  | 'CANCELLED'
  | 'ERROR';

/**
 * Transições permitidas.
 *
 * Declarado como tabela, e não espalhado em `if`s, porque é a regra que
 * impede o documento de voltar no tempo. `AUTHORIZED` só vai para `CANCELLED`;
 * de `CANCELLED` não sai nada.
 */
export const ALLOWED_TRANSITIONS: Record<FiscalStatus, FiscalStatus[]> = {
  DRAFT: ['VALIDATED', 'ERROR'],
  VALIDATED: ['SIGNED', 'DRAFT', 'ERROR'],
  SIGNED: ['QUEUED', 'ERROR'],
  QUEUED: ['SENDING', 'CONTINGENCY', 'ERROR'],
  // SENDING pode virar QUEUED de novo: é o retry depois de timeout, e só
  // acontece DEPOIS de consultar o estado real na SEFAZ.
  SENDING: ['AUTHORIZED', 'REJECTED', 'QUEUED', 'CONTINGENCY', 'ERROR'],
  AUTHORIZED: ['CANCELLED'],
  // Rejeitada volta ao rascunho para correção — com número NOVO, porque o
  // anterior já foi apresentado à SEFAZ.
  REJECTED: ['DRAFT'],
  CONTINGENCY: ['QUEUED', 'SENDING', 'AUTHORIZED', 'REJECTED', 'ERROR'],
  CANCELLED: [],
  ERROR: ['DRAFT', 'QUEUED'],
};

export function canTransition(from: FiscalStatus, to: FiscalStatus): boolean {
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

export interface FiscalDocument {
  id: string;
  companyId: string;
  saleId: string | null;
  model: string;
  serie: number;
  number: number;
  accessKey: string | null;
  environment: string;
  status: FiscalStatus;
  protocol: string | null;
  cStat: string | null;
  xMotivo: string | null;
  contingencyMode: string | null;
  issuedAt: string | null;
  authorizedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
}

function toDocument(row: Record<string, unknown>): FiscalDocument {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    saleId: (row.sale_id as string | null) ?? null,
    model: String(row.model),
    serie: Number(row.serie),
    number: Number(row.number),
    accessKey: (row.access_key as string | null) ?? null,
    environment: String(row.environment),
    status: String(row.status) as FiscalStatus,
    protocol: (row.protocol as string | null) ?? null,
    cStat: (row.c_stat as string | null) ?? null,
    xMotivo: (row.x_motivo as string | null) ?? null,
    contingencyMode: (row.contingency_mode as string | null) ?? null,
    issuedAt: (row.issued_at as string | null) ?? null,
    authorizedAt: (row.authorized_at as string | null) ?? null,
    cancelledAt: (row.cancelled_at as string | null) ?? null,
    createdAt: String(row.created_at),
  };
}

export function getDocument(companyId: string, id: string): FiscalDocument | null {
  ensureCoreSchema();
  const row = getConnection()
    .prepare('SELECT * FROM core_fiscal_documents WHERE company_id = ? AND id = ?')
    .get(companyId, id) as Record<string, unknown> | undefined;
  return row ? toDocument(row) : null;
}

export function getDocumentBySale(
  companyId: string,
  saleId: string,
  model = MODEL_NFCE,
): FiscalDocument | null {
  ensureCoreSchema();
  const row = getConnection()
    .prepare(
      'SELECT * FROM core_fiscal_documents WHERE company_id = ? AND sale_id = ? AND model = ?',
    )
    .get(companyId, saleId, model) as Record<string, unknown> | undefined;
  return row ? toDocument(row) : null;
}

/** Chave de idempotência de uma venda: uma nota por venda e por modelo. */
function idempotencyFor(saleId: string, model: string): string {
  return `sale:${saleId}:model:${model}`;
}

/**
 * UMA VENDA, UM DOCUMENTO VIVO — entre os DOIS modelos (P0 fiscal).
 *
 * O defeito: a idempotência é por (venda, modelo), e o comentário de
 * `createNfeForSale` celebrava "a mesma venda pode ter um cupom e uma nota".
 * Pode — mas não os dois VALENDO: NFC-e autorizada e NF-e autorizada da mesma
 * venda documentam a mesma mercadoria duas vezes (faturamento e ICMS em dobro
 * na apuração do contador). Quem vendeu no balcão e precisa da NF-e cancela o
 * cupom (dentro do prazo) e só então emite a nota.
 *
 * Rejeitada e cancelada não documentam nada; qualquer outro estado — do
 * rascunho à contingência — é um documento que pode vir a valer.
 */
const ESTADOS_QUE_NAO_DOCUMENTAM: ReadonlySet<FiscalStatus> = new Set(['CANCELLED', 'REJECTED']);

/** O documento do OUTRO modelo que ainda documenta (ou pode documentar) esta venda. */
export function outroDocumentoVivoDaVenda(
  companyId: string,
  saleId: string,
  model: string,
): FiscalDocument | null {
  const outro = getDocumentBySale(companyId, saleId, model === MODEL_NFCE ? MODEL_NFE : MODEL_NFCE);
  return outro && !ESTADOS_QUE_NAO_DOCUMENTAM.has(outro.status) ? outro : null;
}

/**
 * OS DOCUMENTOS FISCAIS DESTA VENDA, NOS DOIS MODELOS (P0 fiscal).
 *
 * O DEFEITO: quem perguntava "esta venda tem nota?" perguntava por
 * `getDocumentBySale(..., MODEL_NFCE)` — só o cupom. Com a NF-e de balcão
 * (modelo 55) existindo, a mesma pergunta passou a responder NÃO para uma
 * venda documentada: a ficha da venda oferecia emitir de novo, e a ficha da
 * devolução dizia "não há documento fiscal a regularizar" para uma venda com
 * NF-e AUTORIZADA — enquanto a rota de devolução emitia a nota sem reclamar.
 * A pergunta é por VENDA, e a resposta tem de olhar os dois modelos.
 *
 * Ordem: o cupom primeiro, a nota depois — é a ordem em que a loja os emite.
 */
export function documentosDaVenda(companyId: string, saleId: string): FiscalDocument[] {
  return [
    getDocumentBySale(companyId, saleId, MODEL_NFCE),
    getDocumentBySale(companyId, saleId, MODEL_NFE),
  ].filter((d): d is FiscalDocument => Boolean(d));
}

/**
 * O documento que DOCUMENTA esta venda hoje — em qualquer dos dois modelos.
 *
 * Autorizado primeiro (é o que vale para o fisco); na falta dele, o que ainda
 * pode vir a valer (do rascunho à contingência); e só então o que já não
 * documenta nada (cancelado, rejeitado), porque a ficha precisa dizer "a nota
 * desta venda foi cancelada" em vez de "esta venda não teve nota".
 */
export function documentoQueDocumentaAVenda(
  companyId: string,
  saleId: string,
): FiscalDocument | null {
  const docs = documentosDaVenda(companyId, saleId);
  return (
    docs.find((d) => d.status === 'AUTHORIZED')
    ?? docs.find((d) => !ESTADOS_QUE_NAO_DOCUMENTAM.has(d.status))
    ?? docs[0]
    ?? null
  );
}

function recusarSeOutroModeloDocumentaAVenda(companyId: string, saleId: string, model: string): void {
  const outro = outroDocumentoVivoDaVenda(companyId, saleId, model);
  if (!outro) return;
  const nome = (m: string) => (m === MODEL_NFE ? 'NF-e (modelo 55)' : 'NFC-e (modelo 65)');
  throw new ApiError(
    'CORE_FISCAL_SALE_ALREADY_DOCUMENTED',
    `Esta venda já tem ${nome(outro.model)} nº ${outro.number} (situação ${outro.status}). Emitir também a `
      + `${nome(model)} documentaria a mesma mercadoria duas vezes. Para trocar de documento, cancele o `
      + 'outro primeiro — dentro do prazo de cancelamento.',
    409,
    { documentId: outro.id, model: outro.model, status: outro.status },
  );
}

/**
 * Registra a mudança de estado, sempre append-only.
 *
 * O histórico é o que permite auditar depois: de onde veio, para onde foi, e
 * por quê. Sobrescrever o estado sem registrar deixaria um documento
 * `REJECTED` indistinguível de um que nunca foi enviado.
 */
export function recordTransition(input: {
  companyId: string;
  documentId: string;
  from: FiscalStatus;
  to: FiscalStatus;
  detail?: Record<string, unknown>;
  userId?: string | null;
}): void {
  getConnection()
    .prepare(
      `INSERT INTO core_fiscal_events
         (id, company_id, document_id, event_type, sequence, justification, user_id, created_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      input.companyId,
      input.documentId,
      `status:${input.from}->${input.to}`,
      input.detail ? JSON.stringify(input.detail) : null,
      input.userId ?? null,
      new Date().toISOString(),
    );

  recordAudit({
    companyId: input.companyId,
    userId: input.userId ?? null,
    action: `fiscal.${input.to.toLowerCase()}`,
    entityType: 'fiscal_document',
    entityId: input.documentId,
    detail: { from: input.from, to: input.to, ...(input.detail ?? {}) },
  });
}

/**
 * Move o documento de estado, recusando o que a tabela não permite.
 *
 * O `UPDATE ... WHERE status = ?` é a proteção contra corrida: dois processos
 * tentando a mesma transição, só um altera a linha.
 */
export function transition(input: {
  companyId: string;
  documentId: string;
  to: FiscalStatus;
  patch?: Record<string, unknown>;
  detail?: Record<string, unknown>;
  userId?: string | null;
}): FiscalDocument {
  ensureCoreSchema();

  return withTransaction(() => {
    const db = getConnection();
    const atual = getDocument(input.companyId, input.documentId);
    if (!atual) {
      throw new ApiError('CORE_FISCAL_DOCUMENT_NOT_FOUND', 'Documento fiscal não encontrado.', 404);
    }
    if (!canTransition(atual.status, input.to)) {
      throw new ApiError(
        'CORE_FISCAL_TRANSITION_INVALID',
        `Um documento ${atual.status} não pode ir para ${input.to}.`,
        409,
        { from: atual.status, to: input.to, allowed: ALLOWED_TRANSITIONS[atual.status] },
      );
    }

    const colunas: string[] = ['status = ?', 'updated_at = ?'];
    const valores: unknown[] = [input.to, new Date().toISOString()];
    for (const [chave, valor] of Object.entries(input.patch ?? {})) {
      colunas.push(`${chave} = ?`);
      valores.push(valor as never);
    }

    const r = db
      .prepare(
        `UPDATE core_fiscal_documents SET ${colunas.join(', ')}
          WHERE id = ? AND company_id = ? AND status = ?`,
      )
      .run(...(valores as never[]), input.documentId, input.companyId, atual.status);

    if (Number(r.changes) === 0) {
      throw new ApiError(
        'CORE_FISCAL_TRANSITION_RACE',
        'O documento mudou de estado durante a operação. Recarregue e tente de novo.',
        409,
      );
    }

    recordTransition({
      companyId: input.companyId,
      documentId: input.documentId,
      from: atual.status,
      to: input.to,
      detail: input.detail,
      userId: input.userId,
    });

    return getDocument(input.companyId, input.documentId)!;
  });
}

/**
 * Cria (ou devolve) o documento fiscal de uma venda.
 *
 * IDEMPOTENTE POR CONSTRUÇÃO. A chave `sale:<id>:model:<modelo>` tem UNIQUE no
 * banco; a segunda chamada colide e devolve o documento existente em vez de
 * criar outro. É isso que impede o clique duplo de queimar dois números.
 *
 * O readiness é conferido ANTES de reservar o número: descobrir que falta o
 * CNPJ depois de numerar queimaria um número por erro de cadastro, e número
 * queimado só se resolve por inutilização.
 */
export function createNfceForSale(input: {
  companyId: string;
  saleId: string;
  serie?: number;
  userId?: string | null;
}): { document: FiscalDocument; created: boolean } {
  ensureCoreSchema();

  const existente = getDocumentBySale(input.companyId, input.saleId, MODEL_NFCE);
  if (existente) return { document: existente, created: false };
  recusarSeOutroModeloDocumentaAVenda(input.companyId, input.saleId, MODEL_NFCE);

  // Portão do estágio de MONTAGEM: emitente, série e dados fiscais do produto.
  // O CERTIFICADO é cobrado na assinatura/transmissão — exigi-lo aqui faria o
  // PDV perder vendas enquanto ele é renovado, em vez de acumular na fila para
  // transmitir depois. O CSC é diferente: sem ele não existe nem o QR Code do
  // cupom, então ele entra na pré-validação logo abaixo, antes do número.
  assertCanEmit(input.companyId, MODEL_NFCE, 'document');

  const config = getFiscalConfig(input.companyId);
  // O que o produto não declara (NCM, CFOP, origem, CEST) vem do grupo
  // tributário — cupom do balcão, sempre operação interna (GAP-PRD-129).
  const sale = completarPeloGrupo(loadSaleForNfce(input.companyId, input.saleId), null);
  /*
    A SÉRIE VEM DA CONFIGURAÇÃO DA OPERAÇÃO.

    Era `input.serie ?? 1`, e nenhum chamador passava série: a loja cadastrava
    a série 5 na tela, o checklist ficava verde porque existe série, e a nota
    saía na 1 — numeração que o contador não conhece.
  */
  // A série do AMBIENTE em que a nota sai: o teste da homologação não gasta a
  // numeração da produção (auditoria P0 da Preço Justo).
  const serie = resolveSerie(input.companyId, MODEL_NFCE, input.serie, config.environment);
  const chave = idempotencyFor(input.saleId, MODEL_NFCE);

  // VALIDA A VENDA ANTES DE NUMERAR.
  //
  // O portão acima cobre o emitente; este passo cobre os ITENS desta venda —
  // NCM, CFOP, origem, totais. Reservar o número e só então descobrir que um
  // item está sem NCM queimaria um número fiscal por erro de cadastro, e
  // número queimado só se resolve por inutilização.
  const problemas = validateNfce(sale, config);
  if (problemas.length > 0) {
    throw new ApiError(
      'CORE_FISCAL_DOCUMENT_INVALID',
      `A nota não pode ser emitida: ${problemas
        .map((p) => `${p.field} — ${p.message}`)
        .join(' | ')}`,
      409,
      { problems: problemas },
    );
  }

  /*
    PRÉ-VALIDA O QUE A MONTAGEM VAI EXIGIR — ainda ANTES de reservar o número.

    A chave de acesso depende do nNF, então `buildNfceXml` só pode rodar depois
    da reserva. Mas era DENTRO dele que a falta de CSC (`NFCE_CSC_REQUIRED`) e
    a tributação incompleta (`CORE_FISCAL_TRIBUTACAO_INCOMPLETA`) eram
    descobertas — e recusa por erro de CONFIGURAÇÃO queimava um número,
    contrariando a promessa lá de cima. A régua é a MESMA do build (nada
    duplicado): só o momento da recusa mudou de lugar. O CSC exigido é o do
    ambiente da operação (GAP-PRD-022).
  */
  conferirExigenciasDaMontagem(sale, config.environment);

  /*
    EM CONTINGÊNCIA OFF-LINE, A NOTA NASCE OFF-LINE (GAP-PRD-098).

    Com a modalidade decidida pelo contador e um período aberto, a NFC-e é
    montada com tpEmis 9 DESDE O INÍCIO — na chave, no XML (com dhCont e
    xJust) e no QR. A decisão vem antes de numerar: o tpEmis entra na chave,
    e trocá-lo depois mudaria a chave de uma nota já numerada.
  */
  const contingencia = emissaoEmContingencia(input.companyId, MODEL_NFCE, config.uf);
  const montagemOffline = contingencia
    ? {
        emissionType: contingencia.emissionType,
        contingency: { dhCont: contingencia.dhCont, xJust: contingencia.xJust },
      }
    : {};

  // E O LEIAUTE, pelo XSD oficial, com um número provisório (GAP-PRD-097):
  // erro de ordem, tamanho ou padrão de campo aparece aqui, nomeado, em vez
  // de virar rejeição da SEFAZ com o número já queimado.
  conferirLeiauteAntesDeNumerar(
    (provisorio) =>
      buildNfceXml({ sale, config, serie, number: provisorio, ...montagemOffline }).xml,
  );

  // Número reservado FORA da transação do documento: ele é queimado de
  // propósito. Se a montagem falhar depois, o número não volta — devolvê-lo
  // permitiria que outra venda o reutilizasse enquanto a SEFAZ já o viu.
  const numero = reserveNextNumber({
    companyId: input.companyId,
    model: MODEL_NFCE,
    serie,
  });

  const issuedAt = new Date();
  const construido = buildNfceXml({
    sale,
    config,
    serie,
    number: numero,
    issuedAt,
    ...montagemOffline,
  });

  try {
    return withTransaction(() => {
      const db = getConnection();
      const id = randomUUID();
      const now = new Date().toISOString();

      db.prepare(
        `INSERT INTO core_fiscal_documents
           (id, company_id, sale_id, model, serie, number, access_key, environment, status,
            xml_original, issued_at, idempotency_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.companyId,
        input.saleId,
        MODEL_NFCE,
        serie,
        numero,
        construido.accessKey,
        config.environment,
        construido.xml,
        issuedAt.toISOString(),
        chave,
        now,
        now,
      );

      // A nota off-line carrega o período de onde nasceu: motivo, início e a
      // pendência de transmissão — a fila e a tela leem daqui.
      if (contingencia) {
        db.prepare(
          `UPDATE core_fiscal_documents
              SET contingency_mode = 'OFFLINE', contingency_reason = ?, contingency_started_at = ?,
                  pending_transmission = 1
            WHERE id = ?`,
        ).run(contingencia.periodo.motivo, contingencia.periodo.iniciadoEm, id);
      }

      recordTransition({
        companyId: input.companyId,
        documentId: id,
        from: 'DRAFT',
        to: 'DRAFT',
        detail: {
          saleId: input.saleId,
          number: numero,
          serie,
          ...(contingencia ? { tpEmis: contingencia.emissionType, contingencyPeriod: contingencia.periodo.id } : {}),
        },
        userId: input.userId,
      });

      const documento = getDocument(input.companyId, id)!;
      // O documento fiscal sobe SEM XML, sem certificado e sem chave privada —
      // ver a lista de campos proibidos no OutboxService. O que a central
      // precisa é do fato: modelo, série, número, chave e situação.
      recordDomainEvent({
        eventType: 'fiscal.document_issued',
        aggregateType: 'fiscal_document',
        aggregateId: id,
        companyId: input.companyId,
        payload: {
          id,
          model: documento.model,
          serie: documento.serie,
          number: documento.number,
          access_key: documento.accessKey,
          status: documento.status,
          environment: documento.environment,
          sale_id: documento.saleId,
          issued_at: documento.issuedAt,
        },
      });
      return { document: documento, created: true };
    });
  } catch (err) {
    // A colisão de UNIQUE é o caso ESPERADO no clique duplo: outra requisição
    // ganhou a corrida. Devolver o documento dela é o comportamento correto.
    const jaExiste = getDocumentBySale(input.companyId, input.saleId, MODEL_NFCE);
    if (jaExiste) return { document: jaExiste, created: false };
    throw err;
  }
}

/**
 * Cria (ou devolve) a NF-e modelo 55 de uma venda.
 *
 * Mesma idempotência da NFC-e — a chave inclui o MODELO, então a mesma venda
 * pode ter um cupom e uma nota sem que um atropele o outro. É o caso real de
 * quem vendeu no balcão e depois precisou da NF-e para o cliente PJ.
 *
 * NUMERAÇÃO SEPARADA: a série 55 tem contador próprio. Misturar com a 65
 * produziria buracos nas duas sequências, e buraco em numeração fiscal é
 * pergunta do fisco.
 *
 * O destinatário NÃO é guardado em coluna: ele vive no XML, que é a verdade do
 * que foi enviado. Guardar cópia criaria uma segunda versão que divergiria do
 * documento no primeiro cadastro corrigido.
 */
export function createNfeForSale(input: {
  companyId: string;
  saleId: string;
  recipient: NfeRecipient;
  serie?: number;
  transport?: NfeTransport;
  presence?: PresenceIndicator;
  additionalInfo?: string;
  userId?: string | null;
}): { document: FiscalDocument; created: boolean } {
  ensureCoreSchema();

  const existente = getDocumentBySale(input.companyId, input.saleId, MODEL_NFE);
  if (existente) return { document: existente, created: false };
  recusarSeOutroModeloDocumentaAVenda(input.companyId, input.saleId, MODEL_NFE);

  assertCanEmit(input.companyId, MODEL_NFE, 'document');

  const config = getFiscalConfig(input.companyId);
  // O que o produto não declara vem do grupo — com o CFOP INTERESTADUAL dele
  // quando o destinatário é de outra UF (GAP-PRD-129).
  const sale = completarPeloGrupo(
    loadSaleForNfce(input.companyId, input.saleId),
    input.recipient?.uf ?? null,
  );
  /*
    A SÉRIE VEM DA CONFIGURAÇÃO DA OPERAÇÃO.

    Era `input.serie ?? 1`, e nenhum chamador passava série: a loja cadastrava
    a série 5 na tela, o checklist ficava verde porque existe série, e a nota
    saía na 1 — numeração que o contador não conhece.
  */
  const serie = resolveSerie(input.companyId, MODEL_NFE, input.serie, config.environment);
  const chave = idempotencyFor(input.saleId, MODEL_NFE);

  // Valida ANTES de numerar — inclusive o destinatário, que só a NF-e exige.
  const problemas = validateNfe({ sale, config, recipient: input.recipient });
  /*
    E O MUNICÍPIO DO DESTINATÁRIO NA TABELA OFICIAL (R3-IBGE). O leiaute só
    confere 7 dígitos; um código que não é município da UF passa por ele e é
    recusado pela SEFAZ com o número já queimado. Sem a tabela, nada muda.
  */
  const municipioErrado = municipioDaNotaQueNaoConfere(
    input.recipient?.cityIbge,
    input.recipient?.uf,
    input.recipient?.cityName,
  );
  if (municipioErrado) {
    problemas.push({
      field: 'dest.cMun',
      message: `${municipioErrado.motivo} — corrija o município do destinatário antes de emitir.`,
    });
  }
  if (problemas.length > 0) {
    throw new ApiError(
      'CORE_FISCAL_DOCUMENT_INVALID',
      `A NF-e não pode ser emitida: ${problemas
        .map((p) => `${p.field} — ${p.message}`)
        .join(' | ')}`,
      409,
      { problems: problemas },
    );
  }

  // O leiaute pelo XSD, antes do número — o mesmo portão da NFC-e (GAP-PRD-097).
  conferirLeiauteAntesDeNumerar(
    (provisorio) =>
      buildNfeXml({
        sale,
        config,
        recipient: input.recipient,
        serie,
        number: provisorio,
        transport: input.transport,
        presence: input.presence,
        additionalInfo: input.additionalInfo,
      }).xml,
  );

  const numero = reserveNextNumber({ companyId: input.companyId, model: MODEL_NFE, serie });
  const issuedAt = new Date();
  const construido = buildNfeXml({
    sale,
    config,
    recipient: input.recipient,
    serie,
    number: numero,
    transport: input.transport,
    presence: input.presence,
    additionalInfo: input.additionalInfo,
    issuedAt,
  });

  try {
    return withTransaction(() => {
      const db = getConnection();
      const id = randomUUID();
      const now = new Date().toISOString();

      db.prepare(
        `INSERT INTO core_fiscal_documents
           (id, company_id, sale_id, model, serie, number, access_key, environment, status,
            xml_original, issued_at, recipient_name, recipient_document,
            idempotency_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.companyId,
        input.saleId,
        MODEL_NFE,
        serie,
        numero,
        construido.accessKey,
        config.environment,
        construido.xml,
        issuedAt.toISOString(),
        // Guardado na emissão: é o destinatário DAQUELA nota. Buscar depois no
        // cadastro traria o nome de hoje, não o que foi para o fisco.
        input.recipient.name,
        input.recipient.document,
        chave,
        now,
        now,
      );

      recordTransition({
        companyId: input.companyId,
        documentId: id,
        from: 'DRAFT',
        to: 'DRAFT',
        detail: { saleId: input.saleId, number: numero, serie, model: MODEL_NFE },
        userId: input.userId,
      });

      const documento = getDocument(input.companyId, id)!;
      // O documento fiscal sobe SEM XML, sem certificado e sem chave privada —
      // ver a lista de campos proibidos no OutboxService. O que a central
      // precisa é do fato: modelo, série, número, chave e situação.
      recordDomainEvent({
        eventType: 'fiscal.document_issued',
        aggregateType: 'fiscal_document',
        aggregateId: id,
        companyId: input.companyId,
        payload: {
          id,
          model: documento.model,
          serie: documento.serie,
          number: documento.number,
          access_key: documento.accessKey,
          status: documento.status,
          environment: documento.environment,
          sale_id: documento.saleId,
          issued_at: documento.issuedAt,
        },
      });
      return { document: documento, created: true };
    });
  } catch (err) {
    const jaExiste = getDocumentBySale(input.companyId, input.saleId, MODEL_NFE);
    if (jaExiste) return { document: jaExiste, created: false };
    throw err;
  }
}

/**
 * DRAFT -> VALIDATED.
 *
 * Separado da criação de propósito: validar é uma etapa que pode ser repetida
 * depois de corrigir o cadastro, sem gerar documento novo.
 */
export function validateDocument(input: {
  companyId: string;
  documentId: string;
  userId?: string | null;
}): FiscalDocument {
  const doc = getDocument(input.companyId, input.documentId);
  if (!doc) {
    throw new ApiError('CORE_FISCAL_DOCUMENT_NOT_FOUND', 'Documento fiscal não encontrado.', 404);
  }

  const row = getConnection()
    .prepare('SELECT xml_original FROM core_fiscal_documents WHERE id = ?')
    .get(input.documentId) as { xml_original: string | null };

  const estrutura = validateAgainstSchema(row.xml_original ?? '');
  if (!estrutura.wellFormed) {
    return transition({
      companyId: input.companyId,
      documentId: input.documentId,
      to: 'ERROR',
      patch: { x_motivo: `XML mal formado: ${estrutura.problems.join('; ')}` },
      userId: input.userId,
    });
  }

  /*
    O LEIAUTE PELO XSD OFICIAL (GAP-PRD-097), agora que ele existe no projeto.

    Sem o pacote de esquemas (instalação corrompida), o documento NÃO segue
    para a assinatura fingindo que foi validado: vai para ERROR com o motivo.
    Fora do leiaute, idem — cada problema nomeado, antes de assinar e muito
    antes da SEFAZ.
  */
  if (!estrutura.validated || estrutura.problems.length > 0) {
    return transition({
      companyId: input.companyId,
      documentId: input.documentId,
      to: 'ERROR',
      patch: {
        x_motivo: !estrutura.validated
          ? `Leiaute não conferido: ${estrutura.note ?? 'pacote de esquemas indisponível.'}`
          : `Fora do leiaute oficial (${estrutura.schemaPackage}): ${estrutura.problems.join('; ')}`,
      },
      detail: {
        schemaValidated: estrutura.validated,
        schemaPackage: estrutura.schemaPackage,
        problems: estrutura.problems,
        note: estrutura.note,
      },
      userId: input.userId,
    });
  }

  return transition({
    companyId: input.companyId,
    documentId: input.documentId,
    to: 'VALIDATED',
    // O histórico registra QUAL pacote de esquemas aprovou o documento.
    detail: { schemaValidated: true, schemaPackage: estrutura.schemaPackage },
    userId: input.userId,
  });
}

export interface FiscalDocumentRow extends FiscalDocument {
  saleNumber: number | null;
  /** Destinatário da NF-e; na falta dele, o cliente da venda. */
  customerName: string | null;
  recipientDocument: string | null;
  totalCents: number | null;
}

/**
 * Lista para a tela de documentos.
 *
 * O valor e o cliente vêm da VENDA por junção — o documento fiscal não guarda
 * cópia deles. Duplicar o total aqui criaria uma segunda verdade que
 * divergiria da venda no primeiro ajuste.
 */
export function listFiscalDocuments(
  companyId: string,
  filters: Record<string, string | undefined> = {},
): FiscalDocumentRow[] {
  ensureCoreSchema();

  const params: unknown[] = [companyId];
  let sql = `SELECT d.*, s.number AS sale_number, s.total_cents, c.name AS customer_name
               FROM core_fiscal_documents d
               LEFT JOIN core_sales s ON s.id = d.sale_id
               LEFT JOIN core_customers c ON c.id = s.customer_id
              WHERE d.company_id = ?`;

  const filtro = (coluna: string, valor: string | undefined) => {
    if (!valor) return;
    sql += ` AND ${coluna} = ?`;
    params.push(valor);
  };

  filtro('d.model', filters.model);
  filtro('d.status', filters.status);
  filtro('d.environment', filters.environment);
  if (filters.number) {
    sql += ' AND d.number = ?';
    params.push(Number(filters.number));
  }
  if (filters.accessKey) {
    sql += ' AND d.access_key = ?';
    params.push(filters.accessKey.replace(/\D/g, ''));
  }
  // Inclui o dia inteiro, e o dia é o da LOJA: quem filtra "até 13/08" espera
  // as notas do dia 13 como o balcão o viveu, inclusive as das 21h30.
  const limitesDaLista = limitesDoPeriodo(filters.from, filters.to);
  if (filters.from) {
    sql += ' AND d.created_at >= ?';
    params.push(limitesDaLista.inicio);
  }
  if (filters.to) {
    sql += ' AND d.created_at <= ?';
    params.push(limitesDaLista.fim);
  }
  if (filters.search) {
    sql += ' AND (c.name LIKE ? OR d.access_key LIKE ?)';
    params.push(`%${filters.search}%`, `%${filters.search}%`);
  }

  sql += ' ORDER BY d.created_at DESC LIMIT 300';

  const rows = getConnection()
    .prepare(sql)
    .all(...(params as never[])) as unknown as Record<string, unknown>[];

  return rows.map(toDocumentRow);
}

/**
 * Uma linha da lista, para o detalhe.
 *
 * O detalhe usava `getDocument`, que devolve só o documento: sem valor, sem
 * número da venda, sem destinatário. Na tela isso virava "R$ NaN" e um
 * "Consumidor" que nunca existiu. Detalhe e lista precisam sair da MESMA
 * consulta, senão divergem de novo na próxima coluna.
 */
export function getFiscalDocumentRow(companyId: string, id: string): FiscalDocumentRow | null {
  ensureCoreSchema();
  const row = getConnection()
    .prepare(
      `SELECT d.*, s.number AS sale_number, s.total_cents, c.name AS customer_name
         FROM core_fiscal_documents d
         LEFT JOIN core_sales s ON s.id = d.sale_id
         LEFT JOIN core_customers c ON c.id = s.customer_id
        WHERE d.company_id = ? AND d.id = ?`,
    )
    .get(companyId, id) as unknown as Record<string, unknown> | undefined;
  return row ? toDocumentRow(row) : null;
}

function toDocumentRow(r: Record<string, unknown>): FiscalDocumentRow {
  const recipiente = (r.recipient_name as string | null) ?? null;
  return {
    ...toDocument(r),
    saleNumber: r.sale_number === null || r.sale_number === undefined ? null : Number(r.sale_number),
    // O destinatário da nota vem antes do cliente da venda: na NF-e ele é
    // obrigatório, e é dele que o fisco fala.
    customerName: recipiente ?? (r.customer_name as string | null) ?? null,
    recipientDocument: (r.recipient_document as string | null) ?? null,
    totalCents: r.total_cents === null || r.total_cents === undefined ? null : Number(r.total_cents),
  };
}

/** Histórico append-only de um documento. */
/**
 * Linha do tempo do documento.
 *
 * Devolve também protocolo, cStat e xMotivo porque a recusa é a informação
 * mais importante da lista: "cancelamento recusado" sem o motivo não diz a
 * quem opera o que fazer em seguida. O XML do evento fica de fora — quem
 * precisa dele pede o arquivo, não a tela.
 */
export function listDocumentEvents(
  companyId: string,
  documentId: string,
): {
  eventType: string;
  detail: string | null;
  sequence: number;
  protocol: string | null;
  cStat: string | null;
  xMotivo: string | null;
  createdAt: string;
}[] {
  ensureCoreSchema();
  const rows = getConnection()
    .prepare(
      `SELECT event_type, justification, sequence, protocol, c_stat, x_motivo, created_at
         FROM core_fiscal_events
        WHERE company_id = ? AND document_id = ? ORDER BY created_at, rowid`,
    )
    .all(companyId, documentId) as unknown as Record<string, unknown>[];

  return rows.map((r) => ({
    eventType: String(r.event_type),
    detail: (r.justification as string | null) ?? null,
    sequence: Number(r.sequence ?? 1),
    protocol: (r.protocol as string | null) ?? null,
    cStat: (r.c_stat as string | null) ?? null,
    xMotivo: (r.x_motivo as string | null) ?? null,
    createdAt: String(r.created_at),
  }));
}
