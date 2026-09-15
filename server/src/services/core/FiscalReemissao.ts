/**
 * A NOTA REJEITADA SE CORRIGE E SAI COM O MESMO NÚMERO (P0 fiscal — Preço Justo).
 *
 * ## O defeito
 *
 * A tabela de transições dizia `REJECTED: ['DRAFT']` — "rejeitada volta ao
 * rascunho para correção" — e ninguém percorria a transição. A emissão é
 * idempotente por venda (`createNfceForSale` devolve o documento que existe),
 * então a venda com NFC-e rejeitada ficava rejeitada para sempre: corrigir o
 * cadastro não mudava nada, e o número ficava fora da sequência sem nenhuma
 * inutilização possível (a inutilização recusava qualquer número com
 * documento). A nota em ERRO que nunca saiu (leiaute ou assinatura recusados na
 * autoconferência) estava no mesmo beco.
 *
 * ## A regra
 *
 * Rejeição NÃO consome o número na SEFAZ: a nota rejeitada não é gravada lá.
 * A reemissão usa o MESMO número e a mesma série — nada é queimado, não nasce
 * buraco na numeração — com uma CHAVE NOVA (novo cNF, o instante da
 * reemissão). O XML é remontado das mesmas fontes da primeira emissão (a
 * venda, o pedido, o grupo tributário de HOJE) pelas mesmas funções: é o
 * cadastro corrigido que precisa entrar.
 *
 * ## O que ela recusa
 *
 *  - denegada (110, 301, 302, 303): o número FOI consumido e a nota existe na
 *    SEFAZ como denegada — fica como prova;
 *  - duplicidade (204, 539): a SEFAZ diz que o número/chave já existe lá.
 *    Reemitir com outra chave pode ser a segunda nota da venda — é caso de
 *    consultar, com um humano olhando;
 *  - erro de nota que JÁ FOI transmitida: o destino dela não se sabe;
 *  - número inutilizado (ou com inutilização em curso);
 *  - operação que mudou de ambiente desde a nota (a numeração é por ambiente);
 *  - venda já documentada pelo outro modelo.
 */
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { recordAudit } from '../audit/AuditService.js';
import { getFiscalConfig, type FiscalConfig } from './FiscalConfigService.js';
import {
  getDocument,
  outroDocumentoVivoDaVenda,
  transition,
  type FiscalDocument,
} from './FiscalDocumentService.js';
import { MODEL_NFCE, MODEL_NFE } from './FiscalKeyService.js';
import {
  buildNfceXml,
  conferirExigenciasDaMontagem,
  loadSaleForNfce,
  validateNfce,
  type ValidationProblem,
} from './FiscalXmlNfce.js';
import {
  PRESENCE_IN_PERSON,
  buildNfeXml,
  validateNfe,
  type NfeRecipient,
  type NfeTransport,
  type PresenceIndicator,
} from './FiscalXmlNfe.js';
import { completarPeloGrupo } from './TributacaoDoItem.js';
import { conferirLeiauteAntesDeNumerar } from './FiscalXsdValidator.js';
import { emissaoEmContingencia, emitidaOffline } from './FiscalContingenciaOffline.js';
import { municipioDaNotaQueNaoConfere } from './MunicipiosIbge.js';
import { CSTAT } from './SefazAdapter.js';
import { prepararNfeDoPedido } from './OrderInvoiceService.js';
import { montarNfeDeDevolucao } from './FiscalDevolucao.js';
import { exigirOperacaoConfirmadaEmProducao } from './FiscalOperacoes.js';

const DENEGADOS: readonly string[] = CSTAT.DENIED;
/** Duplicidade: a SEFAZ diz que o número (ou a chave) já existe lá. */
const DUPLICIDADE: readonly string[] = CSTAT.DUPLICATE;

function jaFoiTransmitida(companyId: string, documentId: string): boolean {
  return Boolean(
    getConnection()
      .prepare(
        `SELECT 1 FROM core_fiscal_events
          WHERE company_id = ? AND document_id = ? AND event_type LIKE 'status:%->SENDING'
          LIMIT 1`,
      )
      .get(companyId, documentId),
  );
}

/**
 * O número deste documento foi consumido pela SEFAZ?
 *
 * NÃO foi quando a nota foi REJEITADA (fora denegação e duplicidade) ou ficou
 * em ERRO sem nunca ter sido transmitida. Só esses números podem ser
 * reemitidos — ou, se a operação desistir da nota, inutilizados.
 */
export function numeroNaoConsumidoPelaSefaz(
  companyId: string,
  doc: { id: string; status: string; c_stat: string | null },
): boolean {
  if (doc.status === 'REJECTED') {
    const cStat = String(doc.c_stat ?? '').trim();
    return !DENEGADOS.includes(cStat) && !DUPLICIDADE.includes(cStat);
  }
  if (doc.status === 'ERROR') return !jaFoiTransmitida(companyId, doc.id);
  return false;
}

/** O número está inutilizado — ou com inutilização pedida e ainda sem resposta? */
function numeroInutilizado(companyId: string, model: string, serie: number, number: number): boolean {
  const r = getConnection()
    .prepare(
      `SELECT SUM(CASE WHEN event_type = 'void_requested'  THEN 1 ELSE 0 END) AS pedidos,
              SUM(CASE WHEN event_type = 'void_authorized' THEN 1 ELSE 0 END) AS aceitos,
              SUM(CASE WHEN event_type = 'void_rejected'   THEN 1 ELSE 0 END) AS recusados
         FROM core_fiscal_events
        WHERE company_id = ? AND model = ? AND serie = ?
          AND number_from <= ? AND number_to >= ?
          AND event_type IN ('void_requested', 'void_authorized', 'void_rejected')`,
    )
    .get(companyId, model, serie, number, number) as
    | { pedidos: number | null; aceitos: number | null; recusados: number | null }
    | undefined;
  const aceitos = Number(r?.aceitos ?? 0);
  const pedidos = Number(r?.pedidos ?? 0);
  const recusados = Number(r?.recusados ?? 0);
  return aceitos > 0 || pedidos > aceitos + recusados;
}

// ---------------------------------------------------------------- leitura do XML

function desescapar(valor: string): string {
  return valor
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function campo(trecho: string | null | undefined, tag: string): string | null {
  if (!trecho) return null;
  const m = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(trecho);
  return m ? desescapar(m[1]) : null;
}

function bloco(trecho: string | null | undefined, tag: string): string | null {
  if (!trecho) return null;
  return new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(trecho)?.[1] ?? null;
}

/**
 * O destinatário que a nota rejeitada levou — lido do próprio XML, que é a
 * verdade do que foi enviado (o documento não guarda cópia em coluna). Quem
 * reemite pode mandar outro, quando o problema era o destinatário.
 */
export function destinatarioDoXml(xml: string | null | undefined): NfeRecipient | null {
  const dest = bloco(xml, 'dest');
  if (!dest) return null;
  const ender = bloco(dest, 'enderDest');
  const indicador = campo(dest, 'indIEDest');
  const documento = campo(dest, 'CNPJ') ?? campo(dest, 'CPF');
  if (!documento || !ender || (indicador !== '1' && indicador !== '2' && indicador !== '9')) return null;
  const indFinal = campo(bloco(xml, 'ide'), 'indFinal');
  return {
    document: documento,
    name: campo(dest, 'xNome') ?? '',
    ieIndicator: indicador,
    ie: campo(dest, 'IE'),
    consumidorFinal: indFinal === null ? null : indFinal === '1',
    street: campo(ender, 'xLgr') ?? '',
    number: campo(ender, 'nro') ?? '',
    complement: campo(ender, 'xCpl'),
    district: campo(ender, 'xBairro') ?? '',
    cityName: campo(ender, 'xMun') ?? '',
    cityIbge: campo(ender, 'cMun') ?? '',
    uf: campo(ender, 'UF') ?? '',
    zip: campo(ender, 'CEP'),
    phone: campo(ender, 'fone'),
    email: campo(dest, 'email'),
  };
}

/** Transporte, presença e informação complementar da nota — como ela foi. */
function extrasDaNfeDoXml(xml: string): {
  transport: NfeTransport;
  presence: PresenceIndicator;
  additionalInfo?: string;
} {
  const transp = bloco(xml, 'transp');
  const transporta = bloco(transp, 'transporta');
  const modFrete = (campo(transp, 'modFrete') ?? '9') as NfeTransport['modFrete'];
  const vFrete = Number(campo(bloco(xml, 'ICMSTot'), 'vFrete') ?? '0');
  const presenca = (campo(bloco(xml, 'ide'), 'indPres') ?? PRESENCE_IN_PERSON) as PresenceIndicator;
  const info = campo(bloco(xml, 'infAdic'), 'infCpl');
  return {
    transport: {
      modFrete,
      freightCents: Number.isFinite(vFrete) ? Math.round(vFrete * 100) : 0,
      carrierName: campo(transporta, 'xNome'),
      carrierDocument: campo(transporta, 'CNPJ') ?? campo(transporta, 'CPF'),
    },
    presence: presenca,
    ...(info ? { additionalInfo: info } : {}),
  };
}

function recusarProblemas(problemas: ValidationProblem[]): void {
  if (problemas.length === 0) return;
  throw new ApiError(
    'CORE_FISCAL_DOCUMENT_INVALID',
    `A nota ainda não pode ser reemitida: ${problemas.map((p) => `${p.field} — ${p.message}`).join(' | ')}`,
    409,
    { problems: problemas },
  );
}

// ------------------------------------------------------------------ a remontagem

interface Remontada {
  xml: string;
  accessKey: string;
  recipient: NfeRecipient | null;
  /** Período de contingência em que a reemissão nasce off-line — só quando é a primeira vez. */
  periodoOffline: { motivo: string; iniciadoEm: string } | null;
}

function remontar(input: {
  doc: FiscalDocument;
  row: Record<string, unknown>;
  config: FiscalConfig;
  issuedAt: Date;
  recipient: NfeRecipient | null;
}): Remontada {
  const { doc, row, config, issuedAt } = input;
  const xmlOriginal = String(row.xml_original ?? '');
  const saleId = (row.sale_id as string | null) ?? null;
  const orderId = (row.order_id as string | null) ?? null;

  if (doc.model === MODEL_NFCE && saleId) {
    const sale = completarPeloGrupo(loadSaleForNfce(doc.companyId, saleId), null);
    recusarProblemas(validateNfce(sale, config));
    conferirExigenciasDaMontagem(sale, config.environment);

    /*
      A NOTA DE CONTINGÊNCIA CONTINUA DE CONTINGÊNCIA. A NFC-e off-line já teve
      o DANFCE entregue ao cliente: a reemissão mantém tpEmis 9 com a entrada em
      contingência que ela declarou. A nota normal, reemitida durante um
      período aberto, nasce off-line como qualquer nota do período.
    */
    let contingencia: { dhCont: string; xJust: string } | null = null;
    let periodoOffline: Remontada['periodoOffline'] = null;
    if (emitidaOffline(doc.accessKey)) {
      const ide = bloco(xmlOriginal, 'ide');
      const dhCont = campo(ide, 'dhCont');
      const xJust = campo(ide, 'xJust');
      if (dhCont && xJust) contingencia = { dhCont, xJust };
    } else {
      const agora = emissaoEmContingencia(doc.companyId, MODEL_NFCE, config.uf);
      if (agora) {
        contingencia = { dhCont: agora.dhCont, xJust: agora.xJust };
        periodoOffline = { motivo: agora.periodo.motivo, iniciadoEm: agora.periodo.iniciadoEm };
      }
    }
    const built = buildNfceXml({
      sale,
      config,
      serie: doc.serie,
      number: doc.number,
      issuedAt,
      ...(contingencia ? { emissionType: '9', contingency: contingencia } : {}),
    });
    return { xml: built.xml, accessKey: built.accessKey, recipient: null, periodoOffline };
  }

  if (doc.model === MODEL_NFE && saleId) {
    const recipient = input.recipient ?? destinatarioDoXml(xmlOriginal);
    if (!recipient) {
      throw new ApiError(
        'CORE_FISCAL_REISSUE_RECIPIENT_MISSING',
        'Não foi possível ler o destinatário da nota rejeitada — informe o destinatário para reemitir.',
        409,
      );
    }
    const sale = completarPeloGrupo(loadSaleForNfce(doc.companyId, saleId), recipient.uf);
    const problemas = validateNfe({ sale, config, recipient });
    const municipio = municipioDaNotaQueNaoConfere(recipient.cityIbge, recipient.uf, recipient.cityName);
    if (municipio) {
      problemas.push({
        field: 'dest.cMun',
        message: `${municipio.motivo} — corrija o município do destinatário antes de reemitir.`,
      });
    }
    recusarProblemas(problemas);
    const built = buildNfeXml({
      sale,
      config,
      recipient,
      serie: doc.serie,
      number: doc.number,
      issuedAt,
      ...extrasDaNfeDoXml(xmlOriginal),
    });
    return { xml: built.xml, accessKey: built.accessKey, recipient, periodoOffline: null };
  }

  if (doc.model === MODEL_NFE && orderId) {
    const montagem = prepararNfeDoPedido(doc.companyId, orderId);
    const built = buildNfeXml({ ...montagem, serie: doc.serie, number: doc.number, issuedAt });
    return { xml: built.xml, accessKey: built.accessKey, recipient: montagem.recipient, periodoOffline: null };
  }

  // A NF-e de devolução (P0 fiscal): remontada pelo mesmo montador da emissão.
  const origemTipo = (row.origin_type as string | null) ?? null;
  if (doc.model === MODEL_NFE && (origemTipo === 'devolucao_venda' || origemTipo === 'devolucao_compra') && row.origin_id) {
    const recipient = input.recipient ?? destinatarioDoXml(xmlOriginal);
    if (!recipient) {
      throw new ApiError(
        'CORE_FISCAL_REISSUE_RECIPIENT_MISSING',
        'Não foi possível ler o destinatário da nota rejeitada — informe o destinatário para reemitir.',
        409,
      );
    }
    exigirOperacaoConfirmadaEmProducao(doc.companyId, origemTipo, config.environment);
    const { built } = montarNfeDeDevolucao({
      companyId: doc.companyId,
      operacao: origemTipo,
      returnId: String(row.origin_id),
      recipient,
      config,
      serie: doc.serie,
      number: doc.number,
      issuedAt,
      presence: extrasDaNfeDoXml(xmlOriginal).presence,
    });
    return { xml: built.xml, accessKey: built.accessKey, recipient, periodoOffline: null };
  }

  throw new ApiError(
    'CORE_FISCAL_REISSUE_ORIGIN_UNSUPPORTED',
    'Esta nota não vem de uma venda, de um pedido nem de uma devolução que o sistema saiba remontar.',
    409,
  );
}

// ------------------------------------------------------------------- a reemissão

export interface ResultadoDaReemissao {
  document: FiscalDocument;
  /** A chave da tentativa rejeitada — fica no histórico do documento. */
  chaveAnterior: string | null;
  serie: number;
  /** O número NÃO muda: rejeição não consome número. */
  numero: number;
}

/**
 * Reabre a nota REJEITADA (ou em erro antes de sair) com o MESMO número e uma
 * chave nova, a partir do cadastro de hoje. O documento volta a DRAFT; quem
 * chama segue o pipeline (`advanceDocument`) para validar, assinar e transmitir.
 */
export function reemitirRejeitada(input: {
  companyId: string;
  documentId: string;
  userId?: string | null;
  /** Só na NF-e: o destinatário corrigido, quando o problema era ele. */
  recipient?: NfeRecipient | null;
}): ResultadoDaReemissao {
  ensureCoreSchema();
  const db = getConnection();
  const doc = getDocument(input.companyId, input.documentId);
  if (!doc) {
    throw new ApiError('CORE_FISCAL_DOCUMENT_NOT_FOUND', 'Documento fiscal não encontrado.', 404);
  }

  if (doc.status !== 'REJECTED' && doc.status !== 'ERROR') {
    throw new ApiError(
      'CORE_FISCAL_REISSUE_NOT_ALLOWED',
      `Só nota rejeitada (ou em erro antes de ser transmitida) se reemite. Esta está como ${doc.status}.`,
      409,
      { status: doc.status },
    );
  }
  const cStat = String(doc.cStat ?? '').trim();
  if (doc.status === 'REJECTED' && DENEGADOS.includes(cStat)) {
    throw new ApiError(
      'CORE_FISCAL_DENIED_IS_FINAL',
      `Uso denegado (cStat ${cStat}): o número foi consumido e a nota existe na SEFAZ como denegada. `
        + 'Ela fica como prova; a operação precisa de outra nota, com a situação do destinatário resolvida.',
      409,
    );
  }
  if ((doc.status === 'REJECTED' && DUPLICIDADE.includes(cStat)) || (doc.status === 'ERROR' && jaFoiTransmitida(input.companyId, doc.id))) {
    throw new ApiError(
      'CORE_FISCAL_REISSUE_NEEDS_CONSULT',
      doc.status === 'ERROR'
        ? 'Esta nota chegou a ser transmitida e o desfecho não se sabe. Consulte a chave na SEFAZ antes: '
          + 'reemitir com outra chave pode criar a segunda nota da venda.'
        : `A SEFAZ respondeu duplicidade (cStat ${cStat}): o número ou a chave já existem lá. Consulte a `
          + 'situação antes — reemitir com outra chave pode criar a segunda nota da venda.',
      409,
    );
  }
  if (numeroInutilizado(input.companyId, doc.model, doc.serie, doc.number)) {
    throw new ApiError(
      'CORE_FISCAL_NUMBER_VOIDED',
      `O número ${doc.number} da série ${doc.serie} foi inutilizado (ou tem inutilização em curso): ele não `
        + 'volta a ser usado.',
      409,
    );
  }

  const config = getFiscalConfig(input.companyId);
  if (doc.environment !== config.environment) {
    throw new ApiError(
      'CORE_FISCAL_REISSUE_ENVIRONMENT_CHANGED',
      `Esta nota é de ${doc.environment} e a operação agora emite em ${config.environment}: a numeração é `
        + 'de cada ambiente, e o número dela não se reaproveita no outro.',
      409,
    );
  }
  if (doc.saleId) {
    const outro = outroDocumentoVivoDaVenda(input.companyId, doc.saleId, doc.model);
    if (outro) {
      throw new ApiError(
        'CORE_FISCAL_SALE_ALREADY_DOCUMENTED',
        `A venda já tem outro documento (modelo ${outro.model} nº ${outro.number}, ${outro.status}). Reemitir `
          + 'este documentaria a mesma mercadoria duas vezes.',
        409,
      );
    }
  }

  const row = db
    .prepare('SELECT * FROM core_fiscal_documents WHERE id = ? AND company_id = ?')
    .get(doc.id, input.companyId) as Record<string, unknown>;
  const issuedAt = new Date();
  const remontada = remontar({ doc, row, config, issuedAt, recipient: input.recipient ?? null });

  // O leiaute pelo XSD, com o número DEFINITIVO — recusa aqui não mexe em nada.
  conferirLeiauteAntesDeNumerar(() => remontada.xml);

  return withTransaction(() => {
    const atualizado = transition({
      companyId: input.companyId,
      documentId: doc.id,
      to: 'DRAFT',
      patch: {
        xml_original: remontada.xml,
        xml_signed: null,
        xml_authorized: null,
        access_key: remontada.accessKey,
        issued_at: issuedAt.toISOString(),
        protocol: null,
        c_stat: null,
        x_motivo: null,
        ...(remontada.recipient
          ? { recipient_name: remontada.recipient.name, recipient_document: remontada.recipient.document }
          : {}),
        ...(remontada.periodoOffline
          ? {
              contingency_mode: 'OFFLINE',
              contingency_reason: remontada.periodoOffline.motivo,
              contingency_started_at: remontada.periodoOffline.iniciadoEm,
              pending_transmission: 1,
            }
          : {}),
      },
      detail: {
        reemissao: true,
        mesmoNumero: doc.number,
        serie: doc.serie,
        chaveAnterior: doc.accessKey,
        cStatAnterior: doc.cStat,
        xMotivoAnterior: doc.xMotivo,
      },
      userId: input.userId,
    });

    recordAudit({
      companyId: input.companyId,
      userId: input.userId ?? null,
      action: 'fiscal.reissued',
      entityType: 'fiscal_document',
      entityId: doc.id,
      detail: { numero: doc.number, serie: doc.serie, statusAnterior: doc.status, cStatAnterior: doc.cStat },
    });

    return { document: atualizado, chaveAnterior: doc.accessKey, serie: doc.serie, numero: doc.number };
  });
}

/** Documento que a tela pode oferecer para reemitir — a mesma régua do ato. */
export function podeReemitir(companyId: string, doc: FiscalDocument): boolean {
  return numeroNaoConsumidoPelaSefaz(companyId, { id: doc.id, status: doc.status, c_stat: doc.cStat })
    && !numeroInutilizado(companyId, doc.model, doc.serie, doc.number);
}
