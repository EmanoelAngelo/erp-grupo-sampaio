/**
 * A NF-e DE DEVOLUÇÃO — de venda e de compra (P0 fiscal — Preço Justo).
 *
 * ## O defeito
 *
 * As duas devoluções registravam mercadoria e dinheiro e paravam no fiscal com
 * uma frase: "o DEVORA não emite a nota de devolução" (venda) e "o emissor do
 * sistema ainda não emite devolução de compra: emita pelo emissor do contador"
 * (compra). O montador da NF-e só sabia `finNFe 1`, sem `NFref`, com `tpNF 1`
 * cravado — a nota de devolução era impossível por construção.
 *
 * ## O que este módulo faz
 *
 *  - devolução de VENDA: NF-e de ENTRADA emitida pela loja (tpNF 0),
 *    finalidade 4, referenciando a nota AUTORIZADA da venda (NFC-e ou NF-e),
 *    com o CFOP da operação (1202 dentro do RS, 2202 de fora, por padrão);
 *  - devolução de COMPRA: NF-e de SAÍDA (tpNF 1), finalidade 4, referenciando
 *    a NF-e de entrada do fornecedor, CFOP 5202/6202 por padrão;
 *  - os valores são os do REGISTRO da devolução (preço praticado na venda,
 *    custo da compra), a tributação é a do grupo que a operação manda (ou o do
 *    produto), e `<pag>` é "90 — sem pagamento", como o leiaute exige na
 *    devolução.
 *
 * ## O que ele NÃO decide sozinho (pendência contábil)
 *
 * CFOP, natureza, CSOSN/pCredSN e CST de PIS/COFINS da devolução são do
 * contador (`FiscalOperacoes`). Enquanto ele não confirma, a nota sai em
 * HOMOLOGAÇÃO com a pendência declarada no resultado, e NÃO sai em produção.
 * ST, IPI devolvido e FCP da nota de compra não são reproduzidos: o cadastro
 * não os tem, e a nota de compra que os destacou precisa do contador.
 */
import { randomUUID } from 'node:crypto';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { recordDomainEvent } from '../sync/DomainEvents.js';
import { assertCanEmit, getFiscalConfig, type FiscalConfig } from './FiscalConfigService.js';
import { MODEL_NFCE, MODEL_NFE, reserveNextNumber, resolveSerie } from './FiscalKeyService.js';
import {
  getDocument,
  getDocumentBySale,
  recordTransition,
  type FiscalDocument,
} from './FiscalDocumentService.js';
import {
  buildNfeXml,
  validateNfe,
  type BuiltNfe,
  type NfeRecipient,
  type PresenceIndicator,
} from './FiscalXmlNfe.js';
import type { NfceSale, NfceSaleItem } from './FiscalXmlNfce.js';
import { conferirLeiauteAntesDeNumerar } from './FiscalXsdValidator.js';
import { digitoDoCfopEsperado } from './TributacaoDoItem.js';
import { exigirOperacaoConfirmadaEmProducao, lerOperacao } from './FiscalOperacoes.js';
import { municipioDaNotaQueNaoConfere } from './MunicipiosIbge.js';
import { advanceDocument, type PipelineResult } from './FiscalPipelineService.js';
import type { SefazAdapter } from './SefazAdapter.js';
import type { OrigemDeDevolucao } from './SituacaoFiscalDaDevolucao.js';

export type OperacaoDeDevolucao = OrigemDeDevolucao;

/** O limite do `infCpl` no leiaute. */
const INFCPL_MAX = 5000;

interface OrigemCarregada {
  numero: number;
  chaveReferenciada: string;
  itens: Omit<NfceSaleItem, 'cfop'>[];
  infoComplementar: string;
}

function linhaParaItem(row: Record<string, unknown>, precoCents: number, descricao: string): Omit<NfceSaleItem, 'cfop'> {
  const quantidade = Number(row.quantity);
  const total = Number(row.total_cents);
  const bruto = Math.round(quantidade * precoCents);
  return {
    productId: String(row.product_id ?? ''),
    description: descricao,
    quantity: quantidade,
    unitPriceCents: precoCents,
    // vProd = qCom × vUnCom; o que a devolução pagou a menos (desconto da venda
    // rateado) é desconto da linha, e o total fecha com o registro.
    discountCents: Math.max(0, bruto - total),
    totalCents: total,
    ncm: (row.ncm as string | null) ?? null,
    cest: (row.cest as string | null) ?? null,
    origin: (row.origin as string | null) ?? null,
    unit: (row.unit as string | null) ?? null,
    barcode: (row.barcode as string | null) ?? null,
    internalCode: (row.internal_code as string | null) ?? null,
    taxProfile: (row.tax_profile as string | null) ?? null,
  };
}

/** A devolução de VENDA: o registro, a nota autorizada da venda e os itens devolvidos. */
function carregarDevolucaoDeVenda(companyId: string, returnId: string): OrigemCarregada {
  const db = getConnection();
  const r = db
    .prepare(
      `SELECT r.id, r.number, r.sale_id, r.reason, s.number AS sale_number
         FROM core_sale_returns r
         JOIN core_sales s ON s.id = r.sale_id
        WHERE r.id = ? AND r.company_id = ?`,
    )
    .get(returnId, companyId) as Record<string, unknown> | undefined;
  if (!r) throw new ApiError('CORE_RETURN_NOT_FOUND', 'Devolução não encontrada.', 404);

  const saleId = String(r.sale_id);
  const notas = [getDocumentBySale(companyId, saleId, MODEL_NFCE), getDocumentBySale(companyId, saleId, MODEL_NFE)];
  const autorizada = notas.find((d): d is FiscalDocument => Boolean(d && d.status === 'AUTHORIZED' && d.accessKey));
  if (!autorizada) {
    const cancelada = notas.some((d) => d?.status === 'CANCELLED');
    throw new ApiError(
      'CORE_FISCAL_RETURN_NO_AUTHORIZED_NOTE',
      cancelada
        ? 'A nota desta venda foi cancelada: não há nota a devolver, e a devolução não gera NF-e.'
        : 'A venda não tem nota AUTORIZADA (saiu com comprovante não fiscal, ou a nota ainda está '
          + 'pendente): a NF-e de devolução referencia a nota autorizada da venda.',
      409,
    );
  }

  const itens = (
    db
      .prepare(
        `SELECT ri.quantity, ri.unit_price_cents, ri.total_cents, ri.product_id, si.description,
                p.ncm, p.cest, p.origin, p.unit, p.barcode, p.internal_code, p.tax_profile
           FROM core_sale_return_items ri
           JOIN core_sale_items si ON si.id = ri.sale_item_id
           LEFT JOIN core_products p ON p.id = ri.product_id
          WHERE ri.return_id = ? AND ri.company_id = ?
          ORDER BY ri.created_at, ri.rowid`,
      )
      .all(returnId, companyId) as unknown as Record<string, unknown>[]
  ).map((row) => linhaParaItem(row, Number(row.unit_price_cents), String(row.description ?? '')));

  const modelo = autorizada.model === MODEL_NFCE ? 'NFC-e' : 'NF-e';
  return {
    numero: Number(r.number),
    chaveReferenciada: String(autorizada.accessKey),
    itens,
    infoComplementar:
      `Devolução de mercadoria da venda nº ${String(r.sale_number)} (${modelo} ${autorizada.number}, série `
      + `${autorizada.serie}). Registro de devolução nº ${String(r.number)}: ${String(r.reason ?? '')}`,
  };
}

/** A devolução de COMPRA: o registro, a NF-e de entrada do fornecedor e os itens. */
function carregarDevolucaoDeCompra(companyId: string, returnId: string): OrigemCarregada {
  const db = getConnection();
  const r = db
    .prepare(
      `SELECT r.id, r.number, r.reason, r.fiscal_status, n.access_key AS note_access_key,
              n.doc_type AS note_doc_type, n.number AS note_number
         FROM core_supplier_returns r
         JOIN core_inbound_notes n ON n.id = r.note_id
        WHERE r.id = ? AND r.company_id = ?`,
    )
    .get(returnId, companyId) as Record<string, unknown> | undefined;
  if (!r) throw new ApiError('CORE_SUPPLIER_RETURN_NOT_FOUND', 'Devolução não encontrada.', 404);
  if (String(r.note_doc_type ?? 'nfe') === 'manual') {
    throw new ApiError(
      'CORE_FISCAL_RETURN_NO_INBOUND_NFE',
      'A compra entrou sem NF-e (entrada manual): não há nota a referenciar. Confirme com o contador e '
        + 'registre a decisão na devolução.',
      409,
    );
  }
  if (String(r.fiscal_status) !== 'pendente') {
    throw new ApiError(
      'CORE_FISCAL_RETURN_ALREADY_RESOLVED',
      `A situação fiscal desta devolução já foi registrada ("${String(r.fiscal_status)}").`,
      409,
    );
  }

  const itens = (
    db
      .prepare(
        `SELECT i.quantity, i.unit_cost_cents, i.total_cents, i.product_id, p.name,
                p.ncm, p.cest, p.origin, p.unit, p.barcode, p.internal_code, p.tax_profile
           FROM core_supplier_return_items i
           JOIN core_products p ON p.id = i.product_id
          WHERE i.return_id = ? AND i.company_id = ?
          ORDER BY i.created_at, i.rowid`,
      )
      .all(returnId, companyId) as unknown as Record<string, unknown>[]
  ).map((row) => linhaParaItem(row, Number(row.unit_cost_cents), String(row.name ?? '')));

  return {
    numero: Number(r.number),
    chaveReferenciada: String(r.note_access_key ?? '').replace(/\D/g, ''),
    itens,
    infoComplementar:
      `Devolução de compra da NF-e ${String(r.note_number ?? '')} do fornecedor. Registro de devolução `
      + `nº ${String(r.number)}: ${String(r.reason ?? '')}`,
  };
}

/**
 * Monta o XML da NF-e de devolução — sem numerar. Usado pela emissão (com
 * número provisório, antes de reservar), pela emissão de verdade e pela
 * REEMISSÃO da devolução rejeitada. Toda recusa acontece aqui, antes do número.
 */
export function montarNfeDeDevolucao(input: {
  companyId: string;
  operacao: OperacaoDeDevolucao;
  returnId: string;
  recipient: NfeRecipient;
  config: FiscalConfig;
  serie: number;
  number: number;
  issuedAt?: Date;
  presence?: PresenceIndicator;
}): { built: BuiltNfe; chaveReferenciada: string } {
  const origem = input.operacao === 'devolucao_venda'
    ? carregarDevolucaoDeVenda(input.companyId, input.returnId)
    : carregarDevolucaoDeCompra(input.companyId, input.returnId);
  if (origem.itens.length === 0) {
    throw new ApiError('CORE_FISCAL_RETURN_EMPTY', 'A devolução não tem itens para a nota.', 409);
  }

  const parametros = lerOperacao(input.companyId, input.operacao);
  const esperado = digitoDoCfopEsperado(input.config.uf, input.recipient.uf, parametros.direcao);
  const cfop = esperado === '1' || esperado === '5'
    ? parametros.cfopInterno
    : esperado === '2' || esperado === '6'
      ? parametros.cfopInterestadual
      : null;
  if (!cfop) {
    throw new ApiError(
      'CORE_FISCAL_RETURN_CFOP_MISSING',
      `A operação "${parametros.rotulo}" não tem CFOP para este destino. Informe em Fiscal › Operações `
        + 'fiscais — quem diz qual é o contador.',
      409,
    );
  }

  const itens: NfceSaleItem[] = origem.itens.map((i) => ({ ...i, cfop }));
  const total = itens.reduce((s, i) => s + i.totalCents, 0);
  const sale: NfceSale = {
    id: input.returnId,
    number: origem.numero,
    companyId: input.companyId,
    createdAt: new Date().toISOString(),
    subtotalCents: total,
    discountCents: 0,
    surchargeCents: 0,
    totalCents: total,
    changeCents: 0,
    customerId: null,
    customerDocument: null,
    customerName: null,
    items: itens,
    // Devolução não tem pagamento: o leiaute exige tPag 90 ("sem pagamento"),
    // que o montador escreve quando a lista é vazia.
    payments: [],
  };

  const problemas = validateNfe({ sale, config: input.config, recipient: input.recipient, direcao: parametros.direcao });
  const municipio = municipioDaNotaQueNaoConfere(
    input.recipient.cityIbge,
    input.recipient.uf,
    input.recipient.cityName,
  );
  if (municipio) {
    problemas.push({
      field: 'dest.cMun',
      message: `${municipio.motivo} — corrija o município do destinatário antes de emitir.`,
    });
  }
  if (problemas.length > 0) {
    throw new ApiError(
      'CORE_FISCAL_DOCUMENT_INVALID',
      `A NF-e de devolução não pode ser emitida: ${problemas.map((p) => `${p.field} — ${p.message}`).join(' | ')}`,
      409,
      { problems: problemas },
    );
  }

  const built = buildNfeXml({
    sale,
    config: input.config,
    recipient: input.recipient,
    serie: input.serie,
    number: input.number,
    issuedAt: input.issuedAt,
    // Quem devolve a mercadoria na loja está presente; a devolução ao
    // fornecedor não é presencial.
    presence: input.presence ?? (input.operacao === 'devolucao_venda' ? '1' : '9'),
    transport: { modFrete: '9' },
    additionalInfo: origem.infoComplementar.slice(0, INFCPL_MAX),
    devolucao: { operacao: input.operacao, chaveReferenciada: origem.chaveReferenciada },
  });
  return { built, chaveReferenciada: origem.chaveReferenciada };
}

function chaveDeIdempotencia(operacao: OperacaoDeDevolucao, returnId: string): string {
  return `${operacao}:${returnId}:model:${MODEL_NFE}`;
}

function documentoPelaChave(companyId: string, chave: string): FiscalDocument | null {
  const row = getConnection()
    .prepare('SELECT id FROM core_fiscal_documents WHERE company_id = ? AND idempotency_key = ?')
    .get(companyId, chave) as { id: string } | undefined;
  return row ? getDocument(companyId, row.id) : null;
}

/**
 * Cria (ou devolve) a NF-e de devolução de um registro de devolução.
 *
 * IDEMPOTENTE: um registro de devolução, uma nota — o clique duplo devolve a
 * mesma. Tudo que recusa (operação não confirmada em produção, venda sem nota
 * autorizada, CFOP, cadastro, leiaute) recusa ANTES de reservar o número.
 */
export function createNfeDeDevolucao(input: {
  companyId: string;
  operacao: OperacaoDeDevolucao;
  returnId: string;
  recipient: NfeRecipient;
  serie?: number;
  presence?: PresenceIndicator;
  userId?: string | null;
}): { document: FiscalDocument; created: boolean; pendencias: string[] } {
  ensureCoreSchema();
  if (input.operacao !== 'devolucao_venda' && input.operacao !== 'devolucao_compra') {
    throw new ApiError('CORE_FISCAL_OPERATION_INVALID', 'Operação de devolução inválida.', 400);
  }
  const pendencias = lerOperacao(input.companyId, input.operacao).pendencias;
  const chave = chaveDeIdempotencia(input.operacao, input.returnId);
  const existente = documentoPelaChave(input.companyId, chave);
  if (existente) return { document: existente, created: false, pendencias };

  assertCanEmit(input.companyId, MODEL_NFE, 'document');
  const config = getFiscalConfig(input.companyId);
  exigirOperacaoConfirmadaEmProducao(input.companyId, input.operacao, config.environment);

  // A série DO AMBIENTE da operação (auditoria P0): a devolução de teste não
  // gasta a numeração da produção.
  const serie = resolveSerie(input.companyId, MODEL_NFE, input.serie, config.environment);
  const montar = (numero: number, issuedAt?: Date) =>
    montarNfeDeDevolucao({
      companyId: input.companyId,
      operacao: input.operacao,
      returnId: input.returnId,
      recipient: input.recipient,
      config,
      serie,
      number: numero,
      issuedAt,
      presence: input.presence,
    });

  // Montagem e leiaute com número provisório: nada queima número por erro de cadastro.
  conferirLeiauteAntesDeNumerar((provisorio) => montar(provisorio).built.xml);

  const numero = reserveNextNumber({ companyId: input.companyId, model: MODEL_NFE, serie });
  const issuedAt = new Date();
  const { built, chaveReferenciada } = montar(numero, issuedAt);

  try {
    return withTransaction(() => {
      const id = randomUUID();
      const agora = new Date().toISOString();
      getConnection()
        .prepare(
          `INSERT INTO core_fiscal_documents
             (id, company_id, model, serie, number, access_key, environment, status, xml_original,
              issued_at, recipient_name, recipient_document, idempotency_key, origin_type, origin_id,
              referenced_access_key, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.companyId,
          MODEL_NFE,
          serie,
          numero,
          built.accessKey,
          config.environment,
          built.xml,
          issuedAt.toISOString(),
          input.recipient.name,
          input.recipient.document,
          chave,
          input.operacao,
          input.returnId,
          chaveReferenciada,
          agora,
          agora,
        );

      recordTransition({
        companyId: input.companyId,
        documentId: id,
        from: 'DRAFT',
        to: 'DRAFT',
        detail: {
          origem: input.operacao,
          returnId: input.returnId,
          number: numero,
          serie,
          model: MODEL_NFE,
          chaveReferenciada,
          pendenciasContabeis: pendencias,
        },
        userId: input.userId,
      });

      const documento = getDocument(input.companyId, id)!;
      // Sobe SEM XML, sem certificado e sem chave privada — a central precisa
      // do fato, não do documento.
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
          sale_id: null,
          issued_at: documento.issuedAt,
        },
      });
      return { document: documento, created: true, pendencias };
    });
  } catch (err) {
    const jaExiste = documentoPelaChave(input.companyId, chave);
    if (jaExiste) return { document: jaExiste, created: false, pendencias };
    throw err;
  }
}

/** Monta, valida, assina e enfileira a NF-e de devolução — o mesmo pipeline das outras notas. */
export async function emitirNfeDeDevolucao(input: {
  companyId: string;
  operacao: OperacaoDeDevolucao;
  returnId: string;
  recipient: NfeRecipient;
  presence?: PresenceIndicator;
  userId?: string | null;
  certificatePassword?: string;
  developmentMode?: boolean;
  /** Só para teste: o transporte simulado. Em produção, adapter de teste é recusado no pipeline. */
  adapter?: SefazAdapter;
}): Promise<PipelineResult & { pendencias: string[] }> {
  ensureCoreSchema();
  const config = getFiscalConfig(input.companyId);
  const dev = Boolean(input.developmentMode);
  if (dev && config.environment === 'production') {
    throw new ApiError(
      'CORE_SEFAZ_TEST_PROVIDER_IN_PRODUCTION',
      'Modo de desenvolvimento não é permitido em produção.',
      409,
    );
  }
  const { document, pendencias } = createNfeDeDevolucao(input);
  const resultado = await advanceDocument(
    document.id,
    {
      companyId: input.companyId,
      userId: input.userId,
      certificatePassword: input.certificatePassword,
      developmentMode: dev,
      adapter: input.adapter,
    },
    dev,
  );
  return { ...resultado, pendencias };
}
