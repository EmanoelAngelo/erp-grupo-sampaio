/**
 * ============================================================================
 * O PÓS-VENDA NO PORTAL DO CLIENTE (GAP-PRD-125)
 * ============================================================================
 *
 * ## O DEFEITO
 *
 * O portal tinha perfil, endereços, pedidos, pagamento, equipamentos e
 * chamados — e parava no "Entregue". A nota fiscal da compra só existia no ERP
 * (Fiscal → Documentos) e a loja mandava o DANFE por e-mail à mão; o código de
 * rastreio aparecia como texto, sem caminho para acompanhar; e a devolução só
 * existia "falando com a loja", embora a própria vitrine anuncie o selo "Troca
 * em 7 dias" (CDC, art. 49).
 *
 * ## O QUE ESTE MÓDULO ENTREGA
 *
 *   - A NOTA do pedido, para a dona dele: número, chave e situação no
 *     detalhe; o DANFE (autorizada ou cancelada, com a tarja) e o XML
 *     autorizado (`nfeProc`: nota + protocolo — o arquivo que vale guardar).
 *   - O LINK DE RASTREIO quando o código é um objeto dos Correios (padrão
 *     público `AA123456789BR`). É um link, não uma consulta: o servidor não
 *     chama transportadora nenhuma. Código de outra transportadora continua
 *     aparecendo, sem link inventado.
 *   - O PEDIDO DE DEVOLUÇÃO pelo portal: depois de entregue, a cliente pede
 *     por arrependimento (dentro de 7 dias corridos a contar do recebimento,
 *     no dia da loja) ou por defeito (sem prazo imposto pelo sistema — a loja
 *     avalia). A loja aprova ou recusa (com motivo, que a cliente lê), e o
 *     reembolso feito pelo ERP conclui a solicitação.
 *
 * Quem é dona do pedido é decidido ANTES, na rota, por `getCustomerOrder`
 * (`filtroDoDono`). Este módulo recebe a operação e o pedido já provados.
 */
import { randomUUID } from 'node:crypto';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { recordAudit } from '../audit/AuditService.js';
import { addOrderEvent, DIAS_DE_ARREPENDIMENTO } from './StorefrontService.js';
import { renderDanfe } from './DanfeRenderer.js';
import { montarProcNfe } from './FiscalProcNfe.js';
import { diaDaLoja, hojeNaLoja, somarDias } from './CalendarioOperacional.js';

// ---------------------------------------------------------------- rastreio

/** O objeto dos Correios: duas letras, nove dígitos, duas letras. */
const OBJETO_DOS_CORREIOS = /^[A-Z]{2}\d{9}[A-Z]{2}$/;

/**
 * O link público de acompanhamento do objeto — ou nulo quando o código não é
 * de padrão conhecido. Não inventa link para transportadora que não se sabe.
 */
export function linkDeRastreio(codigo: string | null | undefined): string | null {
  const c = String(codigo ?? '').trim().toUpperCase();
  if (!OBJETO_DOS_CORREIOS.test(c)) return null;
  return `https://rastreamento.correios.com.br/app/index.php?objetos=${encodeURIComponent(c)}`;
}

// ------------------------------------------------------------ nota fiscal

interface DocumentoDoPedido {
  id: string;
  number: number;
  serie: number;
  access_key: string | null;
  status: string;
  authorized_at: string | null;
  xml_signed: string | null;
  xml_authorized: string | null;
}

export interface NotaDoPedidoNoPortal {
  numero: number;
  serie: number;
  chave: string | null;
  status: 'AUTHORIZED' | 'CANCELLED';
  statusLabel: string;
  autorizadaEm: string | null;
  /** O DANFE existe para nota autorizada e para cancelada (com a tarja). */
  danfe: boolean;
  /** O XML entregue à cliente é o autorizado: nota + protocolo. */
  xml: boolean;
}

/** A NF-e (modelo 55) do pedido que a cliente pode ver: autorizada ou cancelada. */
function documentoDoPedido(companyId: string, orderId: string): DocumentoDoPedido | undefined {
  return getConnection()
    .prepare(
      `SELECT id, number, serie, access_key, status, authorized_at, xml_signed, xml_authorized
         FROM core_fiscal_documents
        WHERE company_id = ? AND order_id = ? AND model = '55'
          AND status IN ('AUTHORIZED', 'CANCELLED')
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(companyId, orderId) as unknown as DocumentoDoPedido | undefined;
}

export function notaFiscalNoPortal(companyId: string, orderId: string): NotaDoPedidoNoPortal | null {
  ensureCoreSchema();
  const doc = documentoDoPedido(companyId, orderId);
  if (!doc) return null;
  const autorizada = doc.status === 'AUTHORIZED';
  return {
    numero: Number(doc.number),
    serie: Number(doc.serie),
    chave: doc.access_key,
    status: autorizada ? 'AUTHORIZED' : 'CANCELLED',
    statusLabel: autorizada ? 'Autorizada' : 'Cancelada',
    autorizadaEm: doc.authorized_at,
    danfe: true,
    xml: autorizada && montarProcNfe({ xmlAssinado: doc.xml_signed, protocolo: doc.xml_authorized }) !== null,
  };
}

function naoEmitida(): ApiError {
  return new ApiError(
    'PORTAL_NFE_INDISPONIVEL',
    'A nota fiscal deste pedido ainda não foi emitida. Ela aparece aqui assim que a loja emitir.',
    404,
  );
}

/** O DANFE do pedido, em HTML para imprimir ou salvar em PDF. */
export function danfeDoPedidoParaCliente(companyId: string, orderId: string): string {
  ensureCoreSchema();
  const doc = documentoDoPedido(companyId, orderId);
  if (!doc) throw naoEmitida();
  return renderDanfe(companyId, doc.id);
}

/** O XML autorizado (`nfeProc`) do pedido, com o nome de arquivo pela chave. */
export function xmlDoPedidoParaCliente(
  companyId: string,
  orderId: string,
): { nomeDoArquivo: string; conteudo: string } {
  ensureCoreSchema();
  const doc = documentoDoPedido(companyId, orderId);
  if (!doc) throw naoEmitida();
  if (doc.status !== 'AUTHORIZED') {
    throw new ApiError(
      'PORTAL_NFE_CANCELADA',
      'A nota fiscal deste pedido foi cancelada: o DANFE continua disponível, com a tarja.',
      409,
    );
  }
  const proc = montarProcNfe({ xmlAssinado: doc.xml_signed, protocolo: doc.xml_authorized });
  if (!proc) {
    throw new ApiError(
      'PORTAL_NFE_XML_INDISPONIVEL',
      'O XML autorizado desta nota ainda não está disponível. Fale com a loja.',
      404,
    );
  }
  return { nomeDoArquivo: `NFe-${doc.access_key ?? doc.number}.xml`, conteudo: proc };
}

// --------------------------------------------------------------- devolução

export type TipoDaDevolucao = 'arrependimento' | 'defeito';
export type SituacaoDaSolicitacao = 'aberta' | 'aprovada' | 'recusada' | 'concluida';

const TIPOS: Record<TipoDaDevolucao, string> = {
  arrependimento: 'Desistência (arrependimento)',
  defeito: 'Produto com defeito',
};

const SITUACOES: Record<SituacaoDaSolicitacao, string> = {
  aberta: 'Aguardando a loja',
  aprovada: 'Aprovada — combine com a loja a entrega do produto',
  recusada: 'Recusada pela loja',
  concluida: 'Concluída — pedido reembolsado',
};

/** Tamanho do motivo: curto demais não explica; longo demais vira carta. */
const MOTIVO_MIN = 10;
const MOTIVO_MAX = 1000;

export interface SolicitacaoDeDevolucao {
  id: string;
  orderId: string;
  kind: TipoDaDevolucao;
  kindLabel: string;
  reason: string;
  status: SituacaoDaSolicitacao;
  statusLabel: string;
  decisionNote: string | null;
  createdAt: string;
  decidedAt: string | null;
}

function paraSolicitacao(r: Record<string, unknown>): SolicitacaoDeDevolucao {
  const kind = String(r.kind) as TipoDaDevolucao;
  const status = String(r.status) as SituacaoDaSolicitacao;
  return {
    id: String(r.id),
    orderId: String(r.order_id),
    kind,
    kindLabel: TIPOS[kind] ?? kind,
    reason: String(r.reason),
    status,
    statusLabel: SITUACOES[status] ?? status,
    decisionNote: (r.decision_note as string | null) ?? null,
    createdAt: String(r.created_at),
    decidedAt: (r.decided_at as string | null) ?? null,
  };
}

export function listarSolicitacoes(companyId: string, orderId: string): SolicitacaoDeDevolucao[] {
  ensureCoreSchema();
  return (
    getConnection()
      .prepare(
        `SELECT * FROM core_order_return_requests
          WHERE company_id = ? AND order_id = ?
          ORDER BY created_at, rowid`,
      )
      .all(companyId, orderId) as Record<string, unknown>[]
  ).map(paraSolicitacao);
}

export interface DevolucaoNoPortal {
  podeSolicitar: boolean;
  /** Por que não dá para pedir agora — em palavras para a cliente. */
  motivoIndisponivel: string | null;
  /** Último dia (dia da loja, AAAA-MM-DD) do arrependimento; nulo antes da entrega. */
  prazoArrependimentoAte: string | null;
  arrependimentoNoPrazo: boolean;
  solicitacoes: SolicitacaoDeDevolucao[];
}

/** Quando o pedido foi entregue: o último "entregue" da linha do tempo. */
function entregueEm(orderId: string): string | null {
  const linha = getConnection()
    .prepare(
      `SELECT created_at FROM core_order_events
        WHERE order_id = ? AND status = 'entregue'
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(orderId) as { created_at: string } | undefined;
  return linha?.created_at ?? null;
}

export function devolucaoNoPortal(
  companyId: string,
  orderId: string,
  status: string,
): DevolucaoNoPortal {
  ensureCoreSchema();
  const solicitacoes = listarSolicitacoes(companyId, orderId);
  const emAndamento = solicitacoes.some((s) => s.status === 'aberta' || s.status === 'aprovada');
  const entregue = status === 'entregue' ? entregueEm(orderId) : null;
  // CDC art. 49: sete dias a contar do RECEBIMENTO. O dia é o da loja — a
  // entrega das 22h do dia 1 conta a partir do dia 1, não do dia 2 de Greenwich.
  const prazo = entregue ? somarDias(diaDaLoja(entregue), DIAS_DE_ARREPENDIMENTO) : null;

  let motivo: string | null = null;
  if (status === 'reembolsado') motivo = 'Este pedido já foi devolvido e reembolsado.';
  else if (status === 'cancelado') motivo = 'Este pedido foi cancelado.';
  else if (status !== 'entregue') motivo = 'A devolução pode ser pedida depois que você receber o pedido.';
  else if (emAndamento) motivo = 'Já existe um pedido de devolução em andamento para esta compra.';

  return {
    podeSolicitar: motivo === null,
    motivoIndisponivel: motivo,
    prazoArrependimentoAte: prazo,
    arrependimentoNoPrazo: prazo ? hojeNaLoja() <= prazo : false,
    solicitacoes,
  };
}

function diaBR(dia: string): string {
  const [a, m, d] = dia.split('-');
  return `${d}/${m}/${a}`;
}

/** A cliente pede a devolução pelo portal. A posse do pedido já foi provada. */
export function solicitarDevolucao(input: {
  companyId: string;
  orderId: string;
  accountId: string;
  tipo: unknown;
  motivo: unknown;
}): SolicitacaoDeDevolucao {
  ensureCoreSchema();
  const tipo = String(input.tipo ?? '') as TipoDaDevolucao;
  if (!(tipo in TIPOS)) {
    throw new ApiError(
      'PORTAL_DEVOLUCAO_TIPO',
      'Diga o motivo da devolução: desistência (arrependimento) ou produto com defeito.',
      400,
    );
  }
  const motivo = typeof input.motivo === 'string' ? input.motivo.trim() : '';
  if (motivo.length < MOTIVO_MIN || motivo.length > MOTIVO_MAX) {
    throw new ApiError(
      'PORTAL_DEVOLUCAO_MOTIVO',
      `Conte em poucas palavras o que aconteceu (de ${MOTIVO_MIN} a ${MOTIVO_MAX} caracteres).`,
      400,
    );
  }

  return withTransaction(() => {
    const pedido = getConnection()
      .prepare('SELECT status FROM core_orders WHERE id = ? AND company_id = ?')
      .get(input.orderId, input.companyId) as { status: string } | undefined;
    if (!pedido) throw new ApiError('CORE_ORDER_NOT_FOUND', 'Pedido não encontrado.', 404);

    const situacao = devolucaoNoPortal(input.companyId, input.orderId, pedido.status);
    if (!situacao.podeSolicitar) {
      const jaTem = situacao.solicitacoes.some((s) => s.status === 'aberta' || s.status === 'aprovada');
      throw new ApiError(
        jaTem ? 'PORTAL_DEVOLUCAO_JA_SOLICITADA' : 'PORTAL_DEVOLUCAO_INDISPONIVEL',
        situacao.motivoIndisponivel ?? 'Não dá para pedir devolução deste pedido agora.',
        409,
      );
    }
    if (tipo === 'arrependimento' && !situacao.arrependimentoNoPrazo) {
      throw new ApiError(
        'PORTAL_DEVOLUCAO_FORA_DO_PRAZO',
        `O prazo de arrependimento (${DIAS_DE_ARREPENDIMENTO} dias a contar do recebimento) terminou em `
          + `${diaBR(situacao.prazoArrependimentoAte ?? hojeNaLoja())}. Se o produto tem defeito, `
          + 'escolha "Produto com defeito".',
        409,
        { prazoArrependimentoAte: situacao.prazoArrependimentoAte },
      );
    }

    const agora = new Date().toISOString();
    const id = randomUUID();
    getConnection()
      .prepare(
        `INSERT INTO core_order_return_requests
           (id, company_id, order_id, account_id, kind, reason, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'aberta', ?, ?)`,
      )
      .run(id, input.companyId, input.orderId, input.accountId, tipo, motivo, agora, agora);

    addOrderEvent(
      input.orderId,
      input.companyId,
      pedido.status,
      `Cliente pediu devolução pelo portal (${TIPOS[tipo]}): ${motivo}`,
    );
    recordAudit({
      companyId: input.companyId,
      userId: null,
      action: 'order.return_requested',
      entityType: 'order',
      entityId: input.orderId,
      detail: { requestId: id, accountId: input.accountId, tipo },
    });

    return paraSolicitacao(
      getConnection().prepare('SELECT * FROM core_order_return_requests WHERE id = ?').get(id) as Record<
        string,
        unknown
      >,
    );
  });
}

/** A loja decide o pedido de devolução. Recusar exige motivo: a cliente lê. */
export function decidirSolicitacao(input: {
  companyId: string;
  orderId: string;
  requestId: string;
  decisao: unknown;
  nota: unknown;
  userId?: string | null;
}): SolicitacaoDeDevolucao {
  ensureCoreSchema();
  const decisao = String(input.decisao ?? '');
  if (decisao !== 'aprovar' && decisao !== 'recusar') {
    throw new ApiError('CORE_RETURN_REQUEST_DECISION', 'A decisão é "aprovar" ou "recusar".', 400);
  }
  const nota = typeof input.nota === 'string' ? input.nota.trim() : '';
  if (decisao === 'recusar' && nota.length < 5) {
    throw new ApiError(
      'CORE_RETURN_REQUEST_NOTE',
      'Diga à cliente por que a devolução foi recusada — ela lê este motivo no portal.',
      400,
    );
  }

  return withTransaction(() => {
    const db = getConnection();
    const linha = db
      .prepare(
        'SELECT * FROM core_order_return_requests WHERE id = ? AND order_id = ? AND company_id = ?',
      )
      .get(input.requestId, input.orderId, input.companyId) as Record<string, unknown> | undefined;
    if (!linha) {
      throw new ApiError('CORE_RETURN_REQUEST_NOT_FOUND', 'Pedido de devolução não encontrado.', 404);
    }
    if (linha.status !== 'aberta') {
      throw new ApiError(
        'CORE_RETURN_REQUEST_DECIDED',
        `Este pedido de devolução já está "${SITUACOES[String(linha.status) as SituacaoDaSolicitacao] ?? linha.status}".`,
        409,
      );
    }
    const status: SituacaoDaSolicitacao = decisao === 'aprovar' ? 'aprovada' : 'recusada';
    const agora = new Date().toISOString();
    db.prepare(
      `UPDATE core_order_return_requests
          SET status = ?, decision_note = ?, decided_by = ?, decided_at = ?, updated_at = ?
        WHERE id = ?`,
    ).run(status, nota || null, input.userId ?? null, agora, agora, input.requestId);

    const pedido = db
      .prepare('SELECT status FROM core_orders WHERE id = ?')
      .get(input.orderId) as { status: string };
    addOrderEvent(
      input.orderId,
      input.companyId,
      pedido.status,
      `Pedido de devolução ${status === 'aprovada' ? 'APROVADO' : 'RECUSADO'} pela loja`
        + (nota ? `: ${nota}` : '.'),
      input.userId ?? undefined,
    );
    return paraSolicitacao(
      db.prepare('SELECT * FROM core_order_return_requests WHERE id = ?').get(input.requestId) as Record<
        string,
        unknown
      >,
    );
  });
}
