/**
 * ============================================================================
 * A VENDA GUARDADA OFFLINE QUE O SERVIDOR RECUSOU (GAP-PRD-045 / GAP-PRD-046)
 * ============================================================================
 *
 * ## O que acontecia
 *
 * Com o servidor da loja fora do ar, o PDV guarda a venda na fila do NAVEGADOR
 * (`localStorage`, `src/lib/api/offlineQueue.ts`) com a chave de idempotência,
 * e reenvia quando ele volta. Duas recusas não passam nunca com nova
 * tentativa, e nas duas o dinheiro JÁ foi recebido do cliente:
 *
 *   - o caixa daquele turno fechou (`CORE_CASH_SESSION_CLOSED`);
 *   - o estoque acabou no meio do caminho (`CORE_INSUFFICIENT_STOCK`).
 *
 * A venda ficava presa naquele computador — invisível ao gestor e aos outros
 * caixas, e perdida se a máquina morresse —, e nenhuma tela a destravava: o
 * caminho era o desenvolvedor mexer no `localStorage`.
 *
 * ## O que muda
 *
 * Recusada de vez, a venda é ENTREGUE ao servidor, com o corpo original e a
 * MESMA chave. Daí em diante ela é do servidor, e tem duas saídas:
 *
 *   RELANÇAR    `createSale` com a MESMA chave, na gaveta ABERTA (o servidor
 *               aceita outra gaveta porque a chave ainda não existe). A chave é
 *               o que garante que relançar duas vezes não vende duas vezes.
 *   DESCARTAR   gerência, com motivo — a venda não vai existir (o cliente
 *               desistiu e o dinheiro foi devolvido, a mesma venda foi
 *               relançada à mão). Fica o rastro.
 *
 * E uma terceira, só para um caso (RES-IDEM-TELA):
 *
 *   RELANÇAR COMO VENDA NOVA   a chave desta venda JÁ registrou OUTRA venda (a
 *               #N, com outros itens): o PDV finalizou, recebeu um erro que não
 *               era de rede, o caixa mexeu no carrinho e a tentativa seguinte
 *               caiu na fila com a mesma chave. A mesma chave com outra
 *               mercadoria é 422 CORE_IDEMPOTENCY_KEY_REUSED para sempre, então
 *               RELANÇAR nunca passa. Descartar e refazer à mão pedia gerente,
 *               redigitar os itens e acertar a gaveta de outro turno. Aqui o
 *               servidor faz a venda da pendência com uma chave PRÓPRIA dela
 *               (`chaveDaVendaNovaDaPendencia`), na gaveta aberta de quem
 *               relança; a #N continua como está. Só vale quando a chave tem
 *               venda de OUTRA mercadoria — com a mesma, ou sem venda, a saída é
 *               o relançamento comum, e chave nova ali seria vender em dobro.
 *
 * A pendência de uma gaveta ainda aberta entra no fechamento daquele turno
 * (`PendenciasDoTurno`): fechar a gaveta com dinheiro de venda que não existe
 * exige ciência e motivo, igual ao dinheiro eletrônico indefinido.
 */
import { randomUUID } from 'node:crypto';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { emReais } from './Money.js';
import { findPaymentMethod, isCashMethod } from './PaymentMethods.js';
import { chaveDaVendaNovaDaPendenciaOffline, recusarChaveDoServidor } from './ChavesDoServidor.js';
import { recordAudit } from '../audit/AuditService.js';
import {
  impressaoDigitalDaMercadoria,
  outraMercadoria,
  type MercadoriaDoPedido,
} from './ImpressaoDigitalDaVenda.js';
import { chaveReusada } from '../api/ImpressaoDaRequisicao.js';
import { temAlcadaParaLiberar } from './AuthorizationService.js';

/**
 * A impressão digital do pedido de venda que um corpo guardado relançaria —
 * o que `vendaDoCorpo` desce para `createSale`: itens e dinheiro.
 */
function impressaoDoCorpo(c: Record<string, unknown>): string {
  return impressaoDigitalDaMercadoria({
    items: c.items as MercadoriaDoPedido['items'],
    payments: c.payments as MercadoriaDoPedido['payments'],
    discountCents: c.discountCents,
    surchargeCents: c.surchargeCents,
    customerCreditCents: c.customerCreditCents,
  });
}

export type SituacaoDaVendaOffline = 'pendente' | 'regularizada' | 'descartada';

/** O corpo guardado não passa disto: é uma venda, não um arquivo. */
const TAMANHO_MAXIMO_DO_CORPO = 256 * 1024;

interface Linha {
  id: string;
  company_id: string;
  idempotency_key: string;
  label: string | null;
  request_body: string;
  received_cents: number;
  items_count: number;
  queued_at: string | null;
  terminal_id: string | null;
  cash_session_id: string | null;
  status: SituacaoDaVendaOffline;
  error_code: string | null;
  error_message: string | null;
  attempts: number;
  reported_by: string | null;
  reported_at: string;
  last_reported_at: string;
  sale_id: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  resolution_note: string | null;
}

export interface VendaOfflineRecusada {
  id: string;
  idempotencyKey: string;
  label: string | null;
  /** Quando a venda foi feita no balcão (o relógio do PDV). */
  queuedAt: string | null;
  reportedAt: string;
  lastReportedAt: string;
  reportedBy: string | null;
  reportedByName: string | null;
  terminalId: string | null;
  terminalName: string | null;
  /** A gaveta em que a venda foi feita — a do turno que o servidor recusou. */
  cashSessionId: string | null;
  receivedCents: number;
  itemsCount: number;
  items: { productId: string; name: string | null; quantity: number; unitPriceCents: number | null }[];
  payments: { method: string; amountCents: number }[];
  status: SituacaoDaVendaOffline;
  errorCode: string | null;
  errorMessage: string | null;
  attempts: number;
  saleId: string | null;
  saleNumber: number | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
  /**
   * A venda que a CHAVE desta pendência já registrou com OUTROS itens
   * (RES-IDEM-TELA) — nula quando a chave não tem venda, ou tem a MESMA
   * mercadoria. Calculada na hora (a venda pode ter sido cancelada depois), e
   * só para a pendência em aberto. É o que a tela usa para dizer "esta
   * tentativa já registrou a venda #N" e oferecer a venda nova.
   */
  vendaDaChave: VendaDaChave | null;
  /**
   * A gaveta em que o relançamento entra sem ninguém escolher
   * (G-offline-sync-10) — onde o dinheiro da venda está. Calculada na hora, e
   * só para a pendência em aberto. Nula: nem a gaveta da venda nem outra do
   * mesmo caixa estão abertas.
   */
  gavetaDeDestino: GavetaDeDestino | null;
}

/**
 * A gaveta onde o dinheiro da venda guardada está (G-offline-sync-10).
 *
 *   a_da_venda    a gaveta em que a venda foi feita, ainda aberta — o caso da
 *                 recusa por estoque, em que o turno segue;
 *   mesmo_caixa   a gaveta da venda fechou, e o MESMO caixa abriu outra — a
 *                 gaveta física é a mesma.
 */
export interface GavetaDeDestino {
  cashSessionId: string;
  terminalId: string | null;
  terminalName: string | null;
  motivo: 'a_da_venda' | 'mesmo_caixa';
}

/** A venda de outra mercadoria que ocupa a chave de uma pendência. */
export interface VendaDaChave {
  id: string;
  number: number;
  totalCents: number;
  status: string;
  items: { description: string; quantity: number }[];
}

function texto(v: unknown, max: number): string | null {
  if (v === undefined || v === null) return null;
  const t = String(v).trim();
  return t ? t.slice(0, max) : null;
}

function instante(v: unknown): string | null {
  if (!v) return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function corpoDe(linha: Linha): Record<string, unknown> {
  try {
    const c = JSON.parse(linha.request_body) as unknown;
    return c && typeof c === 'object' ? (c as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function pagamentosDo(corpo: Record<string, unknown>): { method: string; amountCents: number }[] {
  const lista = Array.isArray(corpo.payments) ? (corpo.payments as Record<string, unknown>[]) : [];
  return lista.map((p) => ({
    method: String(p?.method ?? ''),
    amountCents: Number.isFinite(Number(p?.amountCents)) ? Math.max(0, Math.round(Number(p?.amountCents))) : 0,
  }));
}

/**
 * A venda que a chave já registrou, se for de OUTRA mercadoria.
 *
 * A comparação é a de `createSale` e a da entrega: a impressão digital do
 * pedido que o relançamento desceria — itens E DINHEIRO (`impressaoDoCorpo`).
 * Era só os itens: desde que a impressão gravada na venda passou a levar o
 * dinheiro (RES-IDEM-VIZ), a de só itens nunca batia, e TODA venda na chave
 * parecia "outra" — a pendência cuja própria venda já tinha subido era
 * oferecida para relançar como venda nova, e vendia em dobro (R2-IDEM). Venda
 * anterior à impressão (nula) não é "outra": o relançamento comum a devolve.
 */
function vendaDeOutraMercadoriaNaChave(
  companyId: string,
  chave: string,
  corpo: Record<string, unknown>,
): VendaDaChave | null {
  const db = getConnection();
  const venda = db
    .prepare(
      `SELECT id, number, total_cents, status, idempotency_fingerprint FROM core_sales
        WHERE company_id = ? AND idempotency_key = ?`,
    )
    .get(companyId, chave) as
    | { id: string; number: number; total_cents: number; status: string; idempotency_fingerprint: string | null }
    | undefined;
  if (!venda) return null;
  if (!outraMercadoria(venda.idempotency_fingerprint, impressaoDoCorpo(corpo))) return null;
  // A venda que o relançamento COM AJUSTE DE PREÇO fez com esta chave
  // (G-offline-sync-08) é desta pendência, e não "outra": oferecê-la como
  // outra venda puxaria o "Relançar como venda nova" e venderia em dobro.
  if (ehAVendaAjustada(corpo, venda.idempotency_fingerprint)) return null;
  const itens = db
    .prepare('SELECT description, quantity FROM core_sale_items WHERE sale_id = ?')
    .all(venda.id) as unknown as { description: string | null; quantity: number }[];
  return {
    id: venda.id,
    number: Number(venda.number),
    totalCents: Number(venda.total_cents ?? 0),
    status: venda.status,
    items: itens.map((i) => ({ description: i.description ?? 'item', quantity: Number(i.quantity ?? 0) })),
  };
}

function vista(linha: Linha): VendaOfflineRecusada {
  const db = getConnection();
  const corpo = corpoDe(linha);
  const itensBrutos = Array.isArray(corpo.items) ? (corpo.items as Record<string, unknown>[]) : [];
  const nomeDoProduto = db.prepare('SELECT name FROM core_products WHERE id = ? AND company_id = ?');
  const items = itensBrutos.map((i) => {
    const productId = String(i?.productId ?? '');
    const p = nomeDoProduto.get(productId, linha.company_id) as { name?: string } | undefined;
    return {
      productId,
      name: p?.name ?? null,
      quantity: Number(i?.quantity ?? 0),
      unitPriceCents: Number.isFinite(Number(i?.unitPriceCents)) ? Number(i?.unitPriceCents) : null,
    };
  });
  const quem = linha.reported_by
    ? (db.prepare('SELECT display_name FROM core_users WHERE id = ?').get(linha.reported_by) as
        | { display_name?: string }
        | undefined)
    : undefined;
  const caixa = linha.terminal_id
    ? (db
        .prepare('SELECT name FROM core_terminals WHERE id = ? AND company_id = ?')
        .get(linha.terminal_id, linha.company_id) as { name?: string } | undefined)
    : undefined;
  const venda = linha.sale_id
    ? (db.prepare('SELECT number FROM core_sales WHERE id = ?').get(linha.sale_id) as { number?: number } | undefined)
    : undefined;
  return {
    id: linha.id,
    idempotencyKey: linha.idempotency_key,
    label: linha.label,
    queuedAt: linha.queued_at,
    reportedAt: linha.reported_at,
    lastReportedAt: linha.last_reported_at,
    reportedBy: linha.reported_by,
    reportedByName: quem?.display_name ?? null,
    terminalId: linha.terminal_id,
    terminalName: caixa?.name ?? null,
    cashSessionId: linha.cash_session_id,
    receivedCents: Number(linha.received_cents ?? 0),
    itemsCount: Number(linha.items_count ?? 0),
    items,
    payments: pagamentosDo(corpo),
    status: linha.status,
    errorCode: linha.error_code,
    errorMessage: linha.error_message,
    attempts: Number(linha.attempts ?? 0),
    saleId: linha.sale_id,
    saleNumber: venda?.number ?? null,
    resolvedBy: linha.resolved_by,
    resolvedAt: linha.resolved_at,
    resolutionNote: linha.resolution_note,
    vendaDaChave:
      linha.status === 'pendente'
        ? vendaDeOutraMercadoriaNaChave(linha.company_id, linha.idempotency_key, corpo)
        : null,
    gavetaDeDestino: linha.status === 'pendente' ? gavetaDeDestinoDa(linha) : null,
  };
}

// ------------------------------------------ a gaveta onde o dinheiro está

interface SessaoDeCaixa {
  id: string;
  status: string;
  terminal_id: string | null;
}

function sessaoDeCaixa(companyId: string, id: string | null): SessaoDeCaixa | null {
  if (!id) return null;
  return (
    (getConnection()
      .prepare('SELECT id, status, terminal_id FROM core_cash_sessions WHERE id = ? AND company_id = ?')
      .get(id, companyId) as SessaoDeCaixa | undefined) ?? null
  );
}

function nomeDoCaixa(companyId: string, terminalId: string | null): string | null {
  if (!terminalId) return null;
  const t = getConnection()
    .prepare('SELECT name FROM core_terminals WHERE id = ? AND company_id = ?')
    .get(terminalId, companyId) as { name?: string } | undefined;
  return t?.name ?? null;
}

/** O caixa em que a venda foi feita: o da gaveta dela, ou o que o corpo informou. */
function caixaDaVenda(linha: Linha): string | null {
  return sessaoDeCaixa(linha.company_id, linha.cash_session_id)?.terminal_id ?? linha.terminal_id ?? null;
}

function gavetaDeDestinoDa(linha: Linha): GavetaDeDestino | null {
  const daVenda = sessaoDeCaixa(linha.company_id, linha.cash_session_id);
  if (daVenda && daVenda.status === 'open') {
    return {
      cashSessionId: daVenda.id,
      terminalId: daVenda.terminal_id,
      terminalName: nomeDoCaixa(linha.company_id, daVenda.terminal_id),
      motivo: 'a_da_venda',
    };
  }
  const caixa = daVenda?.terminal_id ?? linha.terminal_id ?? null;
  if (!caixa) return null;
  const aberta = getConnection()
    .prepare(
      `SELECT id FROM core_cash_sessions
        WHERE company_id = ? AND terminal_id = ? AND status = 'open'
        ORDER BY opened_at DESC LIMIT 1`,
    )
    .get(linha.company_id, caixa) as { id: string } | undefined;
  return aberta
    ? { cashSessionId: aberta.id, terminalId: caixa, terminalName: nomeDoCaixa(linha.company_id, caixa), motivo: 'mesmo_caixa' }
    : null;
}

/**
 * EM QUE GAVETA A PENDÊNCIA É RELANÇADA (G-offline-sync-10).
 *
 * O DEFEITO: a tela relançava sempre na gaveta aberta DO COMPUTADOR DE QUEM
 * CLICA, e a rota sobrescrevia a gaveta e o caixa com o que o pedido mandava,
 * sem olhar onde a venda tinha sido feita. O Caixa 1 vendia R$ 200 em
 * dinheiro sem servidor, o reenvio era recusado por estoque, o operador do
 * Caixa 2 clicava em "Relançar na gaveta aberta" — e a venda entrava na gaveta
 * do Caixa 2. No fechamento, o Caixa 1 sobrava R$ 200 e o Caixa 2 faltava
 * R$ 200; e a pendência, que travava o fechamento da gaveta certa, sumia dela.
 *
 * A regra agora é a do dinheiro:
 *
 *   - a gaveta da venda ainda aberta recebe o relançamento SEMPRE, venha o
 *     pedido de onde vier (inclusive do escritório, sem gaveta nenhuma — o
 *     gerente não precisa estar no computador daquele caixa);
 *   - fechada ela, a gaveta aberta do MESMO caixa (a gaveta física é a mesma);
 *   - só sem nenhuma das duas vale a gaveta de quem relança — e, sendo de OUTRO
 *     caixa conhecido, só com `confirmarOutraGaveta`: a sobra e a falta passam a
 *     ser uma escolha dita, e não um clique distraído.
 *
 * Venda de loja sem cadastro de caixas (caixa nulo) e gaveta fechada segue
 * como antes: não há como saber qual gaveta física era, e a gaveta aberta de
 * quem relança é a resposta que o fechamento já sabe explicar.
 */
export function destinoDoRelancamento(input: {
  companyId: string;
  id: string;
  pedido: { cashSessionId?: unknown; terminalId?: unknown; confirmarOutraGaveta?: unknown } | null | undefined;
  /** O caixa do token do computador (`req.auth.storeId`), se ele entrou como caixa registrado. */
  terminalDoDispositivo?: string | null;
}): {
  cashSessionId: string | null;
  terminalId: string | null;
  gavetaDeDestino: GavetaDeDestino | null;
  outraGavetaConfirmada: boolean;
} {
  ensureCoreSchema();
  const linha = carregar(input.companyId, input.id);
  exigirPendente(linha);
  const dispositivo = input.terminalDoDispositivo ? String(input.terminalDoDispositivo) : null;

  const destino = gavetaDeDestinoDa(linha);
  if (destino) {
    // O computador que entrou como OUTRO caixa registrado só opera a própria
    // gaveta (GAP-PRD-039): a recusa diz onde o dinheiro está e quem resolve.
    if (dispositivo && destino.terminalId && dispositivo !== destino.terminalId) {
      const onde = destino.terminalName ? `do ${destino.terminalName}` : 'do caixa em que ela foi feita';
      throw new ApiError(
        'CORE_OFFLINE_SALE_OTHER_DRAWER',
        `O dinheiro desta venda está na gaveta ${onde}, que está aberta, e ela é relançada nela. Este `
          + 'computador só opera a gaveta do próprio caixa: relance naquele caixa, ou peça a quem está no '
          + 'escritório para relançar.',
        409,
        {
          confirmavel: false,
          gavetaDaVenda: destino.cashSessionId,
          terminalDaVenda: destino.terminalId,
          caixaDaVenda: destino.terminalName,
        },
      );
    }
    return {
      cashSessionId: destino.cashSessionId,
      terminalId: destino.terminalId,
      gavetaDeDestino: destino,
      outraGavetaConfirmada: false,
    };
  }

  const pedido = input.pedido ?? {};
  const gavetaPedida =
    typeof pedido.cashSessionId === 'string' && pedido.cashSessionId ? pedido.cashSessionId : null;
  const caixaPedido = texto(pedido.terminalId, 120);
  const caixaDeOrigem = caixaDaVenda(linha);
  if (!caixaDeOrigem) {
    return { cashSessionId: gavetaPedida, terminalId: caixaPedido, gavetaDeDestino: null, outraGavetaConfirmada: false };
  }

  const caixaDaGavetaPedida = gavetaPedida
    ? (sessaoDeCaixa(input.companyId, gavetaPedida)?.terminal_id ?? caixaPedido ?? dispositivo)
    : null;
  if (caixaDaGavetaPedida === caixaDeOrigem) {
    return { cashSessionId: gavetaPedida, terminalId: caixaPedido, gavetaDeDestino: null, outraGavetaConfirmada: false };
  }
  if (pedido.confirmarOutraGaveta !== true) {
    const origem = nomeDoCaixa(input.companyId, caixaDeOrigem);
    const aqui = nomeDoCaixa(input.companyId, caixaDaGavetaPedida);
    const doCaixa = origem ? `do ${origem}` : 'do caixa em que ela foi feita';
    throw new ApiError(
      'CORE_OFFLINE_SALE_OTHER_DRAWER',
      `O dinheiro desta venda ficou na gaveta ${doCaixa}, que já fechou, e ${origem ?? 'esse caixa'} não tem `
        + `gaveta aberta agora. Relançar na gaveta ${aqui ? `do ${aqui}` : 'deste computador'} põe a venda onde o `
        + 'dinheiro não está: uma gaveta fica com a sobra e a outra com a falta. Abra o caixa '
        + `${origem ?? 'da venda'} e relance lá, ou confirme para relançar nesta gaveta mesmo assim.`,
      409,
      {
        confirmavel: true,
        terminalDaVenda: caixaDeOrigem,
        caixaDaVenda: origem,
        gavetaPedida,
        caixaPedido: caixaDaGavetaPedida,
      },
    );
  }
  return { cashSessionId: gavetaPedida, terminalId: caixaPedido, gavetaDeDestino: null, outraGavetaConfirmada: true };
}

// --------------------------------- quem vendeu a venda que a fila reenvia

/**
 * A ALÇADA DA VENDA GUARDADA É A DE QUEM VENDEU (G-offline-sync-M03).
 *
 * O DEFEITO: o reenvio da fila sai com o token de quem está logado AGORA, e a
 * alçada do desconto era medida com os perfis desse token. O operador fechava
 * uma venda com 25% de desconto de rodapé com o servidor fora (a tela não tem
 * como pedir liberação sem servidor); antes de a conexão voltar, o gerente
 * entrava no mesmo computador para conferir o caixa; o reenvio saía com o
 * token do gerente, passava na alçada sem liberação nenhuma, e a trilha e o
 * relatório de concessões atribuíam os 25% ao gerente.
 *
 * O PDV agora manda, no reenvio, quem estava na sessão quando a venda foi
 * guardada e quando (`vendaGuardada: { userId, queuedAt }`). A alçada é medida
 * pela régua MAIS ESTREITA das duas pessoas — nunca mais permissiva que a de
 * quem vendeu, nem que a de quem envia (o campo vem do cliente: declarar um
 * gerente como vendedor não abre alçada nenhuma). Vendedor que não é vínculo
 * ativo desta operação não tem alçada. Recusada, a venda vira pendência e sai
 * por "Regularizar", com a liberação de um gestor (G-offline-sync-11).
 *
 * `null` quando o corpo não é de venda guardada (a venda comum do balcão).
 */
export function alcadaDaVendaGuardada(input: {
  companyId: string;
  userId: string;
  perfisDoToken: string[];
  vendaGuardada: unknown;
  agora?: Date;
}): { perfis: string[]; vendidaPor: string | null; vendidaEm: string | null } | null {
  const g = input.vendaGuardada;
  if (!g || typeof g !== 'object' || Array.isArray(g)) return null;
  const bruto = g as { userId?: unknown; queuedAt?: unknown };
  const vendidaPor = texto(bruto.userId, 200);
  const quando = instante(bruto.queuedAt);
  // A hora do relógio do PDV só vale se não for do futuro (relógio adiantado).
  const agora = (input.agora ?? new Date()).getTime();
  const vendidaEm = quando && new Date(quando).getTime() <= agora + 5 * 60_000 ? quando : null;
  if (!vendidaPor || vendidaPor === input.userId) {
    return { perfis: input.perfisDoToken, vendidaPor: vendidaPor ?? null, vendidaEm };
  }
  const vinculo = getConnection()
    .prepare(
      `SELECT uc.profile_code FROM core_user_companies uc
         JOIN core_users u ON u.id = uc.user_id
        WHERE uc.user_id = ? AND uc.company_id = ? AND u.active = 1`,
    )
    .get(vendidaPor, input.companyId) as { profile_code: string } | undefined;
  const perfisDoVendedor = vinculo ? [vinculo.profile_code] : [];
  const perfis =
    temAlcadaParaLiberar(input.perfisDoToken) && !temAlcadaParaLiberar(perfisDoVendedor)
      ? perfisDoVendedor
      : input.perfisDoToken;
  return { perfis, vendidaPor, vendidaEm };
}

function carregar(companyId: string, id: string): Linha {
  const linha = getConnection()
    .prepare('SELECT * FROM core_offline_sale_pendings WHERE id = ? AND company_id = ?')
    .get(id, companyId) as Linha | undefined;
  if (!linha) {
    throw new ApiError('CORE_OFFLINE_SALE_NOT_FOUND', 'Venda guardada não encontrada nesta operação.', 404);
  }
  return linha;
}

function exigirPendente(linha: Linha): void {
  if (linha.status !== 'pendente') {
    throw new ApiError(
      'CORE_OFFLINE_SALE_NOT_PENDING',
      linha.status === 'regularizada'
        ? 'Esta venda guardada já foi relançada.'
        : 'Esta venda guardada já foi descartada.',
      409,
      { status: linha.status, saleId: linha.sale_id },
    );
  }
}

/**
 * O PDV entrega a venda que o servidor recusou de vez.
 *
 * Idempotente pela chave: o mesmo PDV entregando de novo só atualiza o motivo
 * da última recusa. Se a venda com esta chave JÁ existe com a MESMA mercadoria
 * — subiu por outro caminho —, nada é guardado e a resposta diz qual é a venda.
 * Com OUTRA mercadoria (a chave foi reusada), a venda entregue vira pendência.
 */
export function registrarVendaOfflineRecusada(input: {
  companyId: string;
  userId: string;
  idempotencyKey: unknown;
  label?: unknown;
  body: unknown;
  queuedAt?: unknown;
  errorCode?: unknown;
  errorMessage?: unknown;
}):
  | { jaSubiu: true; saleId: string; saleNumber: number | null }
  | { jaSubiu: false; pendencia: VendaOfflineRecusada } {
  ensureCoreSchema();
  const chave = texto(input.idempotencyKey, 200);
  if (!chave) {
    throw new ApiError('CORE_IDEMPOTENCY_REQUIRED', 'A venda guardada precisa da chave com que foi feita.', 400);
  }
  // A pendência é relançada com esta chave CRUA: a forma de uma chave do
  // servidor aqui ocuparia a venda de um documento (R2-IDEM).
  recusarChaveDoServidor(chave);
  const corpo = input.body;
  if (!corpo || typeof corpo !== 'object' || !Array.isArray((corpo as { items?: unknown }).items)) {
    throw new ApiError('CORE_OFFLINE_SALE_BODY_INVALID', 'O corpo da venda guardada não é uma venda.', 400);
  }
  const serializado = JSON.stringify(corpo);
  if (serializado.length > TAMANHO_MAXIMO_DO_CORPO) {
    throw new ApiError('CORE_OFFLINE_SALE_BODY_INVALID', 'O corpo da venda guardada é grande demais.', 400);
  }

  const db = getConnection();
  const c = corpo as Record<string, unknown>;
  const existente = db
    .prepare('SELECT id, number, idempotency_fingerprint FROM core_sales WHERE company_id = ? AND idempotency_key = ?')
    .get(input.companyId, chave) as
    | { id: string; number: number; idempotency_fingerprint: string | null }
    | undefined;
  /*
    "JÁ SUBIU" SÓ QUANDO É ESTA VENDA (item IDEM).

    A venda com esta chave pode ser OUTRA: o PDV mandou a mesma chave com outra
    mercadoria, `createSale` recusou com 422 CORE_IDEMPOTENCY_KEY_REUSED, e a
    fila entregou aqui. Responder "já subiu" faria o PDV marcar como enviada
    uma venda que não existe — o mesmo sumiço calado que a 422 veio fechar. A
    comparação é a mesma de `createSale`, pela impressão digital do pedido que
    o relançamento usaria (itens e dinheiro: `vendaDoCorpo` não desce
    serviço). Diferente, a venda vira pendência: o dinheiro dela está na gaveta
    e o gestor precisa vê-la para descartar e refazer com chave nova.
  */
  const impressao = impressaoDoCorpo(c);
  if (existente && !outraMercadoria(existente.idempotency_fingerprint, impressao)) {
    return { jaSubiu: true, saleId: existente.id, saleNumber: existente.number ?? null };
  }
  /*
    A VENDA RELANÇADA COM AJUSTE DE PREÇO TAMBÉM É "JÁ SUBIU" (G-offline-sync-08).

    O relançamento pelo preço de agora (ou mantendo o cobrado) grava a venda
    com OUTRO dinheiro que o do corpo guardado — a impressão digital muda. A
    cópia que ainda estava na fila do PDV, reenviada depois, toma 422 de chave
    reusada, e a entrega dela caía aqui como "outra mercadoria": o PDV ouvia
    "foi para Regularizar" sobre uma venda que já existe. A pendência desta
    chave guarda a impressão da venda ajustada: sendo ela, é esta venda.
  */
  if (existente) {
    const daPendencia = db
      .prepare('SELECT request_body FROM core_offline_sale_pendings WHERE company_id = ? AND idempotency_key = ?')
      .get(input.companyId, chave) as { request_body: string } | undefined;
    if (daPendencia && ehAVendaAjustada(corpoDe(daPendencia as Linha), existente.idempotency_fingerprint)) {
      return { jaSubiu: true, saleId: existente.id, saleNumber: existente.number ?? null };
    }
  }

  const recebido = pagamentosDo(c).reduce((s, p) => s + p.amountCents, 0);
  const agora = new Date().toISOString();
  const codigo = texto(input.errorCode, 80);
  const mensagem = texto(input.errorMessage, 500);

  const jaGuardada = db
    .prepare('SELECT * FROM core_offline_sale_pendings WHERE company_id = ? AND idempotency_key = ?')
    .get(input.companyId, chave) as Linha | undefined;
  if (jaGuardada) {
    /*
      A MESMA CHAVE COM OUTRO CORPO NÃO É A MESMA PENDÊNCIA (RES-IDEM-VIZ).

      A entrega repetida só atualizava o motivo e devolvia a pendência GUARDADA
      — com o corpo da primeira venda. Outro corpo com esta chave ouvia "está
      guardada", o PDV a tirava da fila, e a venda nova sumia. Recusada, ela
      FICA no PDV com a recusa escrita (`EstadoConexao`), e o gestor refaz com
      chave nova.
    */
    if (impressaoDoCorpo(corpoDe(jaGuardada)) !== impressao) {
      throw chaveReusada('outra venda guardada offline', { pendingId: jaGuardada.id });
    }
    if (jaGuardada.status === 'pendente') {
      db.prepare(
        `UPDATE core_offline_sale_pendings
            SET error_code = COALESCE(?, error_code), error_message = COALESCE(?, error_message),
                attempts = attempts + 1, last_reported_at = ?
          WHERE id = ?`,
      ).run(codigo, mensagem, agora, jaGuardada.id);
    }
    return { jaSubiu: false, pendencia: vista(carregar(input.companyId, jaGuardada.id)) };
  }

  const id = `offsale-${randomUUID()}`;
  db.prepare(
    `INSERT INTO core_offline_sale_pendings
       (id, company_id, idempotency_key, label, request_body, received_cents, items_count, queued_at,
        terminal_id, cash_session_id, status, error_code, error_message, attempts, reported_by,
        reported_at, last_reported_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendente', ?, ?, 1, ?, ?, ?)`,
  ).run(
    id,
    input.companyId,
    chave,
    texto(input.label, 120),
    serializado,
    recebido,
    (c.items as unknown[]).length,
    instante(input.queuedAt),
    texto(c.terminalId, 120),
    texto(c.cashSessionId, 120),
    codigo,
    mensagem,
    input.userId,
    agora,
    agora,
  );
  recordAudit({
    companyId: input.companyId,
    userId: input.userId,
    action: 'sale.offline.pending_reported',
    entityType: 'offline_sale_pending',
    entityId: id,
    detail: { idempotencyKey: chave, receivedCents: recebido, errorCode: codigo, queuedAt: instante(input.queuedAt) },
  });
  return { jaSubiu: false, pendencia: vista(carregar(input.companyId, id)) };
}

export function listarVendasOfflineRecusadas(
  companyId: string,
  filtro: { status?: SituacaoDaVendaOffline | 'todas'; limit?: number } = {},
): VendaOfflineRecusada[] {
  ensureCoreSchema();
  const status = filtro.status ?? 'pendente';
  const limite = Math.max(1, Math.min(500, Math.floor(filtro.limit ?? 200)));
  const linhas = (
    status === 'todas'
      ? getConnection()
          .prepare(
            `SELECT * FROM core_offline_sale_pendings WHERE company_id = ?
              ORDER BY COALESCE(queued_at, reported_at) DESC LIMIT ?`,
          )
          .all(companyId, limite)
      : getConnection()
          .prepare(
            `SELECT * FROM core_offline_sale_pendings WHERE company_id = ? AND status = ?
              ORDER BY COALESCE(queued_at, reported_at) LIMIT ?`,
          )
          .all(companyId, status, limite)
  ) as unknown as Linha[];
  return linhas.map(vista);
}

/** O corpo original, para quem vai relançar a venda (a rota monta o `createSale`). */
export function corpoDaVendaOffline(
  companyId: string,
  id: string,
): { pendencia: VendaOfflineRecusada; idempotencyKey: string; corpo: Record<string, unknown> } {
  ensureCoreSchema();
  const linha = carregar(companyId, id);
  exigirPendente(linha);
  // A pendência gravada antes de a entrega recusar as formas do servidor
  // (R2-IDEM) não sobe com essa chave crua: ela sai por descarte.
  recusarChaveDoServidor(linha.idempotency_key);
  return { pendencia: vista(linha), idempotencyKey: linha.idempotency_key, corpo: corpoDe(linha) };
}

/**
 * A chave da venda nova de uma pendência: DELA, e sempre a mesma.
 *
 * Determinística de propósito. O relançamento como venda nova grava a venda
 * (transação de `createSale`) e depois fecha a pendência; se o pedido cair
 * entre as duas coisas, o próximo pedido chega com a MESMA chave, `createSale`
 * devolve a venda que já nasceu (mesma mercadoria), e a pendência fecha — sem
 * vender duas vezes. Uma chave aleatória por pedido venderia de novo.
 */
export function chaveDaVendaNovaDaPendencia(pendenciaId: string): string {
  return chaveDaVendaNovaDaPendenciaOffline(pendenciaId);
}

/**
 * O que a rota precisa para relançar a pendência como VENDA NOVA — ou a recusa.
 *
 * Só quando a chave da pendência tem venda de OUTRA mercadoria: é o único caso
 * em que o relançamento comum nunca passa. Sem venda na chave, o comum vende;
 * com a mesma mercadoria, o comum devolve a venda que já existe. Nos dois,
 * vender com chave nova seria vender em dobro.
 */
export function vendaNovaDaPendencia(
  companyId: string,
  id: string,
): {
  corpo: Record<string, unknown>;
  chaveOriginal: string;
  chaveNova: string;
  vendaDaChave: VendaDaChave;
} {
  ensureCoreSchema();
  const linha = carregar(companyId, id);
  exigirPendente(linha);
  const corpo = corpoDe(linha);
  const vendaDaChave = vendaDeOutraMercadoriaNaChave(companyId, linha.idempotency_key, corpo);
  if (!vendaDaChave) {
    throw new ApiError(
      'CORE_OFFLINE_SALE_KEY_NOT_REUSED',
      'Esta venda guardada não registrou outra venda antes: use "Relançar na gaveta aberta". '
        + 'Registrar como venda nova aqui venderia em dobro.',
      409,
    );
  }
  return { corpo, chaveOriginal: linha.idempotency_key, chaveNova: chaveDaVendaNovaDaPendencia(linha.id), vendaDaChave };
}

// ------------------------ o preço que mudou entre a venda e o relançamento

/**
 * O PREÇO BAIXOU ENTRE A VENDA E O RELANÇAMENTO (G-offline-sync-08).
 *
 * O DEFEITO: a venda feita sem servidor cobrou no cartão o preço que a tela
 * conhecia; quando o servidor voltou, o preço tinha baixado (promoção, cadastro)
 * e o reenvio era recusado com 409 `CORE_SALE_TOTAL_CHANGED` — o servidor cobra
 * o preço de AGORA, e o cartão passado a mais não pode virar troco. A pendência
 * ia para "Regularizar", e ali o relançamento repetia o mesmo corpo e tomava a
 * mesma recusa para sempre: nenhuma saída a não ser descartar uma venda que
 * aconteceu, com o dinheiro no cartão.
 *
 * Agora quem relança escolhe, vendo a diferença:
 *
 *   preco_de_agora    a venda entra pelo preço de agora, e os pagamentos
 *                     eletrônicos são diminuídos da diferença — é o valor a
 *                     devolver ao cliente (estorno no aparelho). O troco que já
 *                     foi dado no balcão não muda.
 *   manter_o_cobrado  a venda entra pelo que foi cobrado: a diferença vira
 *                     ACRÉSCIMO sobre o preço de agora, no campo que a nota sabe
 *                     imprimir. Cobrar acima do preço anunciado é decisão da
 *                     gerência (quem tem alçada de liberar).
 *
 * Os números NÃO vêm da tela: o servidor tenta o corpo guardado e, recusado
 * pelo preço, refaz o corpo com as linhas que ELE MESMO apontou na recusa (o
 * vigente de cada uma). A decisão fica escrita na pendência e na trilha.
 */
export type ModoDoAjusteDePreco = 'preco_de_agora' | 'manter_o_cobrado';

export interface AjusteDePrecoAplicado {
  modo: ModoDoAjusteDePreco;
  /** Quanto a venda sai mais barata pelo preço de agora do que o que foi cobrado. */
  diferencaCents: number;
  linhas: { productId: string; name: string | null; quantity: number; informadoCents: number; vigenteCents: number }[];
  /** preco_de_agora: quanto dos pagamentos eletrônicos foi diminuído — o estorno no aparelho. */
  estornoCents: number;
  /** preco_de_agora: o que sai da gaveta em dinheiro para completar a devolução. */
  devolverEmDinheiroCents: number;
  /** manter_o_cobrado: o acréscimo lançado sobre o preço de agora. */
  acrescimoCents: number;
  decididoPor: string;
  /** A decisão numa frase — a nota da pendência e o aviso da tela. */
  frase: string;
}

/**
 * A marca que a venda ajustada deixa na pendência, gravada na MESMA transação
 * da venda. É o que faz a venda ajustada ser reconhecida como DESTA pendência
 * — a impressão digital dela é outra (o dinheiro mudou) — se o pedido cair
 * entre gravar a venda e fechar a pendência, ou se a cópia da fila do PDV
 * chegar depois: sem ela, a venda pareceria "outra mercadoria na chave", e o
 * "Relançar como venda nova" venderia em dobro.
 */
interface MarcaDoAjuste {
  impressao: string;
  items: unknown;
  payments: unknown;
  surchargeCents: number;
  resumo: AjusteDePrecoAplicado;
}

const CAMPO_DA_MARCA = 'ajusteDePrecoAplicado';

function marcaDoAjuste(corpo: Record<string, unknown>): MarcaDoAjuste | null {
  const m = corpo[CAMPO_DA_MARCA] as MarcaDoAjuste | undefined;
  return m && typeof m === 'object' && typeof m.impressao === 'string' ? m : null;
}

/** A venda com esta impressão é a que o relançamento com ajuste fez para esta pendência? */
function ehAVendaAjustada(corpo: Record<string, unknown>, impressaoDaVenda: string | null): boolean {
  const m = marcaDoAjuste(corpo);
  return Boolean(m && impressaoDaVenda && m.impressao === impressaoDaVenda);
}

/**
 * A venda que ESTA pendência já fez no servidor, se fez: a da chave com a
 * mesma mercadoria (ou a ajustada), ou a venda nova com a chave própria dela.
 */
function vendaDestaPendencia(linha: Linha): { id: string; number: number; cancelada: boolean } | null {
  const db = getConnection();
  const corpo = corpoDe(linha);
  const buscar = db.prepare(
    'SELECT id, number, status, idempotency_fingerprint FROM core_sales WHERE company_id = ? AND idempotency_key = ?',
  );
  const naChave = buscar.get(linha.company_id, linha.idempotency_key) as
    | { id: string; number: number; status: string | null; idempotency_fingerprint: string | null }
    | undefined;
  if (
    naChave
    && (!outraMercadoria(naChave.idempotency_fingerprint, impressaoDoCorpo(corpo))
      || ehAVendaAjustada(corpo, naChave.idempotency_fingerprint))
  ) {
    return { id: naChave.id, number: Number(naChave.number), cancelada: naChave.status === 'cancelled' };
  }
  const nova = buscar.get(linha.company_id, chaveDaVendaNovaDaPendencia(linha.id)) as
    | { id: string; number: number; status: string | null }
    | undefined;
  return nova ? { id: nova.id, number: Number(nova.number), cancelada: nova.status === 'cancelled' } : null;
}

function lerModoDoAjuste(pedido: unknown): ModoDoAjusteDePreco | null {
  if (pedido === undefined || pedido === null || pedido === '') return null;
  if (pedido === 'preco_de_agora' || pedido === 'manter_o_cobrado') return pedido;
  throw new ApiError(
    'CORE_OFFLINE_SALE_PRICE_ADJUST_INVALID',
    'O ajuste de preço pedido não existe. Escolha "relançar pelo preço de agora" ou "manter o valor cobrado".',
    400,
    { ajusteDePreco: pedido },
  );
}

function descreverLinhas(linhas: AjusteDePrecoAplicado['linhas']): string {
  return linhas
    .map((l) => `"${l.name ?? 'item'}" de ${emReais(l.informadoCents)} para ${emReais(l.vigenteCents)}`)
    .join('; ');
}

/**
 * O corpo guardado refeito com a decisão sobre o preço, a partir das linhas
 * que o SERVIDOR apontou na recusa `CORE_SALE_TOTAL_CHANGED`. Pura: não lê o
 * banco. Exportada para o teste medir a conta sem subir venda.
 */
export function corpoComAjusteDePreco(
  corpo: Record<string, unknown>,
  detalhesDaRecusa: unknown,
  modo: ModoDoAjusteDePreco,
  decididoPor: string,
): { corpo: Record<string, unknown>; resumo: AjusteDePrecoAplicado } {
  const d = (detalhesDaRecusa ?? {}) as { linhas?: unknown; recebidoCents?: unknown; aCobrarCents?: unknown };
  // As linhas da recusa, consumidas na ordem: o mesmo produto em duas linhas
  // (quantidades diferentes, faixas diferentes) casa com a sua.
  const daRecusa = (Array.isArray(d.linhas) ? (d.linhas as Record<string, unknown>[]) : []).map((l) => ({
    productId: String(l?.productId ?? ''),
    name: typeof l?.name === 'string' ? l.name : null,
    informadoCents: Math.round(Number(l?.informadoCents)),
    vigenteCents: Math.round(Number(l?.vigenteCents)),
    usada: false,
  }));

  const itens = Array.isArray(corpo.items) ? (corpo.items as Record<string, unknown>[]) : [];
  let diferenca = 0;
  const linhas: AjusteDePrecoAplicado['linhas'] = [];
  const itensAjustados = itens.map((item) => {
    const informado = Math.round(Number(item?.unitPriceCents));
    const b = daRecusa.find(
      (l) =>
        !l.usada
        && l.productId === String(item?.productId ?? '')
        && l.informadoCents === informado
        && Number.isFinite(l.vigenteCents)
        && l.vigenteCents < l.informadoCents,
    );
    if (!b) return item;
    b.usada = true;
    const q = Number(item?.quantity ?? 0);
    // A mesma conta da linha em `createSale`: arredonda preço × quantidade.
    const menos = Math.round(b.informadoCents * q) - Math.round(b.vigenteCents * q);
    if (!(menos > 0)) return item;
    diferenca += menos;
    linhas.push({ productId: b.productId, name: b.name, quantity: q, informadoCents: b.informadoCents, vigenteCents: b.vigenteCents });
    return modo === 'preco_de_agora' ? { ...item, unitPriceCents: b.vigenteCents } : item;
  });
  if (diferenca <= 0) {
    throw new ApiError(
      'CORE_OFFLINE_SALE_PRICE_ADJUST_IMPOSSIBLE',
      'O servidor recusou esta venda pelo preço, mas nenhuma linha dela bate com o preço que ele apontou. '
        + 'Confira os itens: se a venda aconteceu, descarte esta pendência (gerência) e lance a venda de novo.',
      409,
    );
  }

  if (modo === 'manter_o_cobrado') {
    const acrescimo = Math.max(0, Math.round(Number(corpo.surchargeCents ?? 0))) + diferenca;
    const resumo: AjusteDePrecoAplicado = {
      modo,
      diferencaCents: diferenca,
      linhas,
      estornoCents: 0,
      devolverEmDinheiroCents: 0,
      acrescimoCents: diferenca,
      decididoPor,
      frase:
        `O preço baixou depois da venda (${descreverLinhas(linhas)}); a gerência manteve o valor cobrado: `
        + `acréscimo de ${emReais(diferenca)} sobre o preço de agora. Nada a devolver ao cliente.`,
    };
    return { corpo: { ...corpo, items: itensAjustados, surchargeCents: acrescimo }, resumo };
  }

  // Pelo preço de agora: a diferença sai dos pagamentos ELETRÔNICOS, do último
  // para o primeiro. O dinheiro em espécie fica como está — o troco que o
  // balcão deu já é fato. O pagamento preso a uma cobrança da maquininha
  // (`providerRef`) não é diminuído: o valor dele é o da cobrança no aparelho.
  const pagamentos = (Array.isArray(corpo.payments) ? (corpo.payments as Record<string, unknown>[]) : []).map(
    (p) => ({ ...p }),
  );
  let falta = diferenca;
  const zerados = new Set<number>();
  /** De qual meio sai cada parte da devolução — é o que diz ao caixa COMO devolver. */
  const devolucoes: { method: string; cents: number }[] = [];
  for (let k = pagamentos.length - 1; k >= 0 && falta > 0; k -= 1) {
    const p = pagamentos[k];
    if (isCashMethod(String(p.method ?? ''))) continue;
    if ((p.status ?? 'settled') !== 'settled') continue;
    if (p.providerRef) continue;
    const valor = Math.max(0, Math.round(Number(p.amountCents ?? 0)));
    const tira = Math.min(valor, falta);
    p.amountCents = valor - tira;
    falta -= tira;
    if (tira > 0) devolucoes.push({ method: String(p.method ?? ''), cents: tira });
    if (valor - tira === 0) zerados.add(k);
  }
  const estorno = diferenca - falta;
  const dinheiro = pagamentos
    .filter((p) => isCashMethod(String(p.method ?? '')) && (p.status ?? 'settled') === 'settled')
    .reduce((s, p) => s + Math.max(0, Math.round(Number(p.amountCents ?? 0))), 0);
  // O troco que a venda passa a ter: o que ainda sobra depois do estorno. Só
  // cabe no dinheiro em espécie — é a regra de `createSale`.
  const recebido = Math.round(Number(d.recebidoCents));
  const aCobrar = Math.round(Number(d.aCobrarCents));
  const trocoNovo = Number.isFinite(recebido) && Number.isFinite(aCobrar) ? recebido - estorno - aCobrar : 0;
  if (trocoNovo > dinheiro) {
    throw new ApiError(
      'CORE_OFFLINE_SALE_PRICE_ADJUST_IMPOSSIBLE',
      `Pelo preço de agora esta venda fecha ${emReais(diferenca)} mais barata, e o pagamento eletrônico dela está `
        + 'preso à cobrança da maquininha: não dá para diminuí-lo aqui. Relance mantendo o valor cobrado '
        + '(decisão da gerência), ou estorne a cobrança no aparelho, descarte esta pendência e lance a venda de novo.',
      409,
      { diferencaCents: diferenca, estornoPossivelCents: estorno },
    );
  }
  /*
    COMO CADA PARTE DA DEVOLUÇÃO SAI, pelo meio em que foi paga (revisão).
    A frase dizia "de estorno no aparelho do cartão" para toda devolução
    eletrônica — inclusive a do PIX, que não passa pelo aparelho: o caixa
    procurava na maquininha um estorno que é uma devolução de PIX.
  */
  const partesDaDevolucao = devolucoes.map((dv) => {
    const meio = findPaymentMethod(dv.method);
    if (meio?.code === 'pix') return `${emReais(dv.cents)} devolvidos por PIX`;
    if (meio?.code === 'debito' || meio?.code === 'credito') {
      return `${emReais(dv.cents)} de estorno no ${meio.label.toLowerCase()}, no aparelho do cartão`;
    }
    return `${emReais(dv.cents)} a devolver no ${meio?.label ?? dv.method}`;
  });
  if (falta > 0) partesDaDevolucao.push(`${emReais(falta)} em dinheiro, da gaveta`);
  const resumo: AjusteDePrecoAplicado = {
    modo,
    diferencaCents: diferenca,
    linhas,
    estornoCents: estorno,
    devolverEmDinheiroCents: falta,
    acrescimoCents: 0,
    decididoPor,
    frase:
      `O preço baixou depois da venda (${descreverLinhas(linhas)}); relançada pelo preço de agora. `
      + `Devolver ${emReais(diferenca)} ao cliente`
      + (partesDaDevolucao.length > 0 ? `: ${partesDaDevolucao.join(' e ')}` : '')
      + '.',
  };
  return {
    corpo: { ...corpo, items: itensAjustados, payments: pagamentos.filter((_, k) => !zerados.has(k)) },
    resumo,
  };
}

/**
 * O relançamento que sabe sair da recusa pelo preço (G-offline-sync-08).
 *
 * Tenta o corpo guardado como sempre. Só quando o servidor recusa com
 * `CORE_SALE_TOTAL_CHANGED` E quem relança escolheu um ajuste, refaz o corpo
 * com as linhas da própria recusa e vende — na mesma transação em que deixa a
 * marca da venda ajustada na pendência. Sem ajuste pedido, a recusa sobe como
 * está: é ela que traz as linhas para a tela mostrar a diferença.
 *
 * Se a pendência já tem a marca (a venda ajustada nasceu e a pendência não
 * fechou), o corpo ajustado vai de novo e a chave devolve a venda que existe.
 */
export function relancarComAjusteDePreco<T>(input: {
  companyId: string;
  userId: string;
  id: string;
  /** Os perfis de quem relança: manter o valor cobrado é da gerência. */
  perfis: string[];
  corpo: Record<string, unknown>;
  pedido: unknown;
  vender: (corpo: Record<string, unknown>) => T;
}): { result: T; ajusteDePreco: AjusteDePrecoAplicado | null } {
  const modo = lerModoDoAjuste(input.pedido);
  const marca = marcaDoAjuste(input.corpo);
  if (marca) {
    const ajustado = { ...input.corpo, items: marca.items, payments: marca.payments, surchargeCents: marca.surchargeCents };
    return { result: input.vender(ajustado), ajusteDePreco: marca.resumo };
  }
  if (modo === 'manter_o_cobrado' && !temAlcadaParaLiberar(input.perfis)) {
    throw new ApiError(
      'CORE_OFFLINE_SALE_PRICE_ADJUST_FORBIDDEN',
      'Manter o valor cobrado lança um acréscimo sobre o preço anunciado, e isso é decisão da gerência: peça a '
        + 'um gerente para relançar esta venda, ou relance pelo preço de agora e devolva a diferença ao cliente.',
      403,
    );
  }
  try {
    return { result: input.vender(input.corpo), ajusteDePreco: null };
  } catch (err) {
    if (!modo || (err as { code?: unknown })?.code !== 'CORE_SALE_TOTAL_CHANGED') throw err;
    const ajustado = corpoComAjusteDePreco(input.corpo, (err as ApiError).details, modo, input.userId);
    return withTransaction(() => {
      const result = input.vender(ajustado.corpo);
      const linha = carregar(input.companyId, input.id);
      const marcaNova: MarcaDoAjuste = {
        impressao: impressaoDoCorpo(ajustado.corpo),
        items: ajustado.corpo.items,
        payments: ajustado.corpo.payments,
        surchargeCents: Math.round(Number(ajustado.corpo.surchargeCents ?? 0)),
        resumo: ajustado.resumo,
      };
      // O corpo guardado continua o ORIGINAL (a impressão dele não muda: a marca
      // fica num campo que a impressão não lê); a marca vai ao lado.
      getConnection()
        .prepare('UPDATE core_offline_sale_pendings SET request_body = ? WHERE id = ? AND company_id = ?')
        .run(JSON.stringify({ ...corpoDe(linha), [CAMPO_DA_MARCA]: marcaNova }), input.id, input.companyId);
      return { result, ajusteDePreco: ajustado.resumo };
    });
  }
}

/**
 * As recusas que são de QUEM RELANÇA, e não da venda (G-offline-sync-08): o
 * caixa sem alçada pedindo para manter o valor cobrado, o pedido de ajuste
 * que não existe. Gravadas na pendência, trocariam o motivo verdadeiro (o
 * preço mudou) por um que só vale para aquela pessoa — e a próxima, o gerente,
 * não veria mais o caminho do preço.
 */
const RECUSAS_DE_QUEM_RELANCA = new Set([
  'CORE_OFFLINE_SALE_PRICE_ADJUST_FORBIDDEN',
  'CORE_OFFLINE_SALE_PRICE_ADJUST_INVALID',
]);

/** A recusa do relançamento fica na pendência: a próxima pessoa vê o motivo. */
export function registrarRecusaDoRelancamento(companyId: string, id: string, err: unknown): void {
  const e = err as { code?: string; message?: string };
  if (e?.code && RECUSAS_DE_QUEM_RELANCA.has(e.code)) return;
  getConnection()
    .prepare(
      `UPDATE core_offline_sale_pendings
          SET error_code = ?, error_message = ?, attempts = attempts + 1, last_reported_at = ?
        WHERE id = ? AND company_id = ? AND status = 'pendente'`,
    )
    .run(
      texto(e?.code, 80) ?? 'ERRO',
      texto(e?.message, 500) ?? 'Falha ao relançar.',
      new Date().toISOString(),
      id,
      companyId,
    );
}

/** A venda nasceu (ou já existia com a mesma chave): a pendência fecha apontando para ela. */
export function concluirRelancamento(input: {
  companyId: string;
  userId: string;
  id: string;
  saleId: string;
  saleNumber: number | null;
  cashSessionId: string | null;
  duplicated: boolean;
  /** Relançada como VENDA NOVA (RES-IDEM-TELA): a chave original e a venda que ela registrou. */
  vendaNova?: { chaveOriginal: string; vendaDaChave: { id: string; number: number } };
  /** O preço tinha mudado, e quem relançou decidiu como (G-offline-sync-08). */
  ajusteDePreco?: AjusteDePrecoAplicado | null;
}): VendaOfflineRecusada {
  const linha = carregar(input.companyId, input.id);
  const agora = new Date().toISOString();
  const notaBase = input.vendaNova
    ? `Relançada como venda nova${input.saleNumber ? ` (#${input.saleNumber})` : ''}: a chave desta venda já `
      + `tinha registrado a venda #${input.vendaNova.vendaDaChave.number}, com outros itens, que continua como está.`
      + (input.duplicated ? ' A venda nova já existia no servidor: nada foi vendido de novo.' : '')
    : input.duplicated
      ? 'A venda com esta chave já existia no servidor: nada foi vendido de novo.'
      : `Relançada na gaveta aberta${input.cashSessionId ? ` (${input.cashSessionId})` : ''}.`;
  // A decisão sobre o preço fica escrita na pendência, com o valor: é o que o
  // fechamento e a conciliação do cartão vão perguntar.
  const nota = input.ajusteDePreco ? `${notaBase} ${input.ajusteDePreco.frase}` : notaBase;
  getConnection()
    .prepare(
      `UPDATE core_offline_sale_pendings
          SET status = 'regularizada', sale_id = ?, resolved_by = ?, resolved_at = ?, resolution_note = ?
        WHERE id = ? AND company_id = ? AND status = 'pendente'`,
    )
    .run(input.saleId, input.userId, agora, nota, input.id, input.companyId);
  recordAudit({
    companyId: input.companyId,
    userId: input.userId,
    action: 'sale.offline.regularized',
    entityType: 'offline_sale_pending',
    entityId: input.id,
    detail: {
      saleId: input.saleId,
      saleNumber: input.saleNumber,
      duplicated: input.duplicated,
      // A gaveta do turno em que a venda foi feita e a em que ela entrou: a
      // conferência daquele turno fica com a sobra explicada aqui.
      originalCashSessionId: linha.cash_session_id,
      newCashSessionId: input.cashSessionId,
      queuedAt: linha.queued_at,
      receivedCents: linha.received_cents,
      originalErrorCode: linha.error_code,
      ...(input.ajusteDePreco ? { ajusteDePreco: input.ajusteDePreco } : {}),
      ...(input.vendaNova
        ? {
            comoVendaNova: true,
            chaveOriginal: input.vendaNova.chaveOriginal,
            vendaDaChaveOriginal: input.vendaNova.vendaDaChave,
          }
        : {}),
    },
  });
  return vista(carregar(input.companyId, input.id));
}

export function descartarVendaOffline(input: {
  companyId: string;
  userId: string;
  id: string;
  motivo: unknown;
}): VendaOfflineRecusada {
  ensureCoreSchema();
  const motivo = texto(input.motivo, 500) ?? '';
  if (motivo.length < 10) {
    throw new ApiError(
      'CORE_OFFLINE_SALE_REASON_REQUIRED',
      'Diga por que esta venda não vai existir (ex.: "cliente desistiu e o dinheiro foi devolvido").',
      400,
    );
  }
  const linha = carregar(input.companyId, input.id);
  exigirPendente(linha);
  /*
    NÃO SE DESCARTA A VENDA QUE JÁ EXISTE (G-offline-sync-16).

    O DEFEITO: o descarte só olhava a pendência. Se a venda desta chave já
    tinha nascido no servidor — uma cópia que seguia na fila de outro
    computador subiu, ou o relançamento gravou e caiu antes de fechar a
    pendência —, o gerente "descartava" com o motivo "o cliente desistiu, o
    dinheiro foi devolvido", e a venda seguia existindo: estoque baixado,
    dinheiro na gaveta, cupom emitido, e a trilha dizendo o contrário.

    Recusa com o número da venda. Só a venda DESTA pendência conta: a da
    mesma mercadoria na chave, a do relançamento com ajuste de preço, ou a
    venda nova que ela já fez. Venda de OUTRA mercadoria na chave (a #N do
    RES-IDEM-TELA) não é esta, e o descarte continua sendo uma saída válida.
  */
  const jaExiste = vendaDestaPendencia(linha);
  if (jaExiste) {
    /*
      A VENDA JÁ CANCELADA NÃO MANDA CANCELAR DE NOVO (revisão).

      A recusa mandava "cancele a venda #N em Vendas" sempre. O gerente
      cancelava, voltava para descartar, e ouvia a MESMA frase mandando fazer o
      que ele tinha acabado de fazer — um laço sem saída dita. Com a #N já
      cancelada, a única saída é "Relançar", que fecha a pendência apontando
      para ela sem vender de novo.
    */
    const saida = jaExiste.cancelada
      ? `A venda #${jaExiste.number} já está CANCELADA: use "Relançar" para fechar a pendência apontando `
        + 'para ela (nada é vendido de novo).'
      : `Use "Relançar" para fechar a pendência apontando para a #${jaExiste.number} (nada é vendido de novo). `
        + `Se o cliente desistiu e o dinheiro foi devolvido, cancele a venda #${jaExiste.number} em Vendas.`;
    throw new ApiError(
      'CORE_OFFLINE_SALE_ALREADY_SOLD',
      `Esta venda guardada já está registrada no servidor como a venda #${jaExiste.number}, e por isso não `
        + `pode ser descartada: descartar diria que ela não existe. ${saida}`,
      409,
      { saleId: jaExiste.id, saleNumber: jaExiste.number, cancelada: jaExiste.cancelada },
    );
  }
  const agora = new Date().toISOString();
  getConnection()
    .prepare(
      `UPDATE core_offline_sale_pendings
          SET status = 'descartada', resolved_by = ?, resolved_at = ?, resolution_note = ?
        WHERE id = ? AND company_id = ? AND status = 'pendente'`,
    )
    .run(input.userId, agora, motivo, input.id, input.companyId);
  recordAudit({
    companyId: input.companyId,
    userId: input.userId,
    action: 'sale.offline.discarded',
    entityType: 'offline_sale_pending',
    entityId: input.id,
    detail: {
      motivo,
      idempotencyKey: linha.idempotency_key,
      receivedCents: linha.received_cents,
      cashSessionId: linha.cash_session_id,
      queuedAt: linha.queued_at,
    },
  });
  return vista(carregar(input.companyId, input.id));
}

export interface VendaOfflinePendenteDoTurno {
  id: string;
  label: string | null;
  receivedCents: number;
  queuedAt: string | null;
  errorMessage: string | null;
}

/** As vendas guardadas recusadas feitas NESTA gaveta e ainda sem saída. */
export function vendasOfflinePendentesDaGaveta(
  companyId: string,
  cashSessionId: string,
): VendaOfflinePendenteDoTurno[] {
  ensureCoreSchema();
  return (
    getConnection()
      .prepare(
        `SELECT id, label, received_cents, queued_at, error_message
           FROM core_offline_sale_pendings
          WHERE company_id = ? AND cash_session_id = ? AND status = 'pendente'
          ORDER BY COALESCE(queued_at, reported_at)`,
      )
      .all(companyId, cashSessionId) as unknown as {
      id: string;
      label: string | null;
      received_cents: number;
      queued_at: string | null;
      error_message: string | null;
    }[]
  ).map((r) => ({
    id: r.id,
    label: r.label,
    receivedCents: Number(r.received_cents ?? 0),
    queuedAt: r.queued_at,
    errorMessage: r.error_message,
  }));
}
