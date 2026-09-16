/**
 * ============================================================================
 * O DINHEIRO ELETRÔNICO AINDA INDEFINIDO DE UM TURNO (GAP-PRD-081)
 * ============================================================================
 *
 * `closeSession` fechava a gaveta em silêncio com cobrança da maquininha sem
 * resposta, cobrança ainda andando no aparelho, cobrança aprovada que nenhuma
 * venda usou, ou PIX pendente numa venda do turno. O turno ia para o histórico
 * "conferido" com dinheiro eletrônico que ninguém sabia se entrou — e o gestor
 * descobria no dia seguinte, pela Conferência de maquininha.
 *
 * Aqui mora a PERGUNTA — "o que deste turno ainda não está resolvido?" — e ela
 * é a mesma para o resumo que a tela mostra antes de fechar e para a trava do
 * fechamento. Uma pergunta, dois lugares que a fazem.
 *
 * ## O que é "deste turno"
 *
 * A cobrança feita pelo PDV carrega a gaveta aberta no momento
 * (`cashSessionId`, carimbado em `chargeOnTerminal`). A que não tem o carimbo
 * — anterior a esta versão, ou criada pela rota do módulo — entra pela JANELA
 * do turno: começou depois da abertura (e antes do fechamento, se houver) e no
 * MESMO caixa (sem caixa com sem caixa). O PIX pendente é o da venda cuja
 * gaveta é esta.
 *
 * ## O que é "pendência"
 *
 *   nao_confirmada      o provedor não respondeu (ou o processo morreu no meio):
 *                       ninguém sabe se o cliente pagou.
 *   em_andamento        a cobrança ainda está no aparelho ou esperando o PIX.
 *   aprovada_sem_venda  a operadora aprovou e nenhuma venda usou a cobrança —
 *                       o PIX pago depois do "desistir" (GAP-PRD-078).
 *   estorno_pendente    a venda foi desfeita e o estorno ainda não foi
 *                       confirmado pela operadora (GAP-PRD-080).
 *
 * A cobrança que o gestor já tratou (conciliou, amarrou a uma venda ou
 * registrou a tratativa) deixa de ser pendência. Recusada, cancelada e
 * estornada nunca foram.
 *
 * Duas pendências que NÃO são de maquininha entraram depois, pelo mesmo
 * argumento — dinheiro do turno que fica indefinido se ninguém disser:
 *
 *   venda guardada recusada     o dinheiro está NA gaveta e a venda não existe
 *                               (GAP-PRD-045, `vendasOfflinePendentesDaGaveta`);
 *   devolução sem reembolso     a mercadoria voltou e o cliente ainda não
 *                               recebeu (auditoria do PDV,
 *                               `devolucoesAguardandoReembolsoDoTurno`).
 */
import { findRows } from '../../db/database.js';
import { getConnection } from '../../db/sqlite.js';
import { expirarComandosVencidos } from '../payment-terminal/PaymentTerminalAgentChannel.js';
import { vistaDaCobranca } from './PdvTerminalService.js';
import { vendasOfflinePendentesDaGaveta, type VendaOfflinePendenteDoTurno } from './VendasOfflineRecusadas.js';

export type TipoDePendencia = 'nao_confirmada' | 'em_andamento' | 'aprovada_sem_venda' | 'estorno_pendente';

export interface CobrancaPendenteDoTurno {
  transactionId: string;
  tipo: TipoDePendencia;
  state: string;
  method: string;
  /** Para `estorno_pendente`, o que falta estornar; para o resto, o valor da cobrança. */
  amountInCents: number;
  simulated: boolean;
  startedAt: string | null;
  saleId: string | null;
}

export interface PagamentoPendenteDoTurno {
  paymentId: string;
  saleId: string;
  saleNumber: number | null;
  method: string;
  amountCents: number;
}

/**
 * Devolução em DUAS ETAPAS registrada neste turno cujo reembolso ainda não foi
 * registrado — auditoria do PDV, P0 da Preço Justo. Ver
 * `devolucoesAguardandoReembolsoDoTurno`.
 */
export interface DevolucaoAguardandoReembolso {
  id: string;
  number: number;
  saleId: string;
  saleNumber: number | null;
  /** O que a devolução apurou como devolvível. */
  devolvivelCents: number;
  /** O que já voltou ao cliente, em uma ou mais parcelas. */
  reembolsadoCents: number;
  /** O que a loja ainda deve a esta pessoa. */
  pendenteCents: number;
  createdAt: string;
}

export interface PendenciasEletronicas {
  cobrancas: CobrancaPendenteDoTurno[];
  pagamentosPendentes: PagamentoPendenteDoTurno[];
  /**
   * Venda feita com o servidor fora, guardada no PDV, que o servidor recusou
   * e que ainda não foi relançada nem descartada (GAP-PRD-045). O dinheiro
   * dela ESTÁ na gaveta e a venda não existe: fechar sem dizer seria a sobra
   * que ninguém explica.
   */
  vendasOffline: VendaOfflinePendenteDoTurno[];
  /**
   * Devolução em duas etapas deste turno com reembolso pendente ou parcial —
   * dinheiro que a loja DEVE, e que ainda está na gaveta quando o reembolso
   * for em espécie.
   */
  devolucoesAguardandoReembolso: DevolucaoAguardandoReembolso[];
  quantidade: number;
  totalCents: number;
}

/** O que a pendência quer dizer, em uma frase de balcão. */
export const ROTULO_DA_PENDENCIA: Record<TipoDePendencia, string> = {
  nao_confirmada: 'cobrança sem resposta da operadora',
  em_andamento: 'cobrança ainda em andamento no aparelho',
  aprovada_sem_venda: 'cobrança aprovada que nenhuma venda usou',
  estorno_pendente: 'estorno de venda desfeita ainda não confirmado',
};

type Linha = Record<string, unknown>;

/** A cobrança está pendente? Qual pendência? `null` = resolvida (ou nunca foi). */
export function tipoDaPendencia(row: Linha): TipoDePendencia | null {
  if (Number(row.aEstornarCents ?? 0) > 0) return 'estorno_pendente';
  const vista = vistaDaCobranca(row);
  if (vista.needsReconciliation) return 'nao_confirmada';
  // Amarrada a venda, ou tratada pelo gestor: não é dinheiro sem dono.
  if (row.saleId || row.semVendaTratadaAt) return null;
  if (vista.pending) return 'em_andamento';
  if (vista.settled) return 'aprovada_sem_venda';
  return null;
}

interface TurnoLido {
  id: string;
  terminal_id: string | null;
  opened_at: string;
  closed_at: string | null;
}

/** Esta cobrança é deste turno? Pelo carimbo; sem carimbo, pela janela e pelo caixa. */
function doTurno(row: Linha, turno: TurnoLido): boolean {
  if (row.cashSessionId) return row.cashSessionId === turno.id;
  const inicio = String(row.startedAt ?? row.createdAt ?? '');
  if (!inicio || inicio < turno.opened_at) return false;
  if (turno.closed_at && inicio > turno.closed_at) return false;
  return ((row.pdvTerminalId as string | null | undefined) ?? null) === (turno.terminal_id ?? null);
}

export function pendenciasEletronicasDoTurno(companyId: string, turno: TurnoLido): PendenciasEletronicas {
  // A cobrança do agente que venceu o prazo de resposta vira "não confirmada"
  // AGORA — senão o fechamento a veria como "em andamento" para sempre.
  expirarComandosVencidos(companyId);

  const cobrancas: CobrancaPendenteDoTurno[] = [];
  for (const row of findRows<Linha>('payment_terminal_transactions', (r) => r.companyId === companyId)) {
    if (!doTurno(row, turno)) continue;
    const tipo = tipoDaPendencia(row);
    if (!tipo) continue;
    const vista = vistaDaCobranca(row);
    cobrancas.push({
      transactionId: String(row.id),
      tipo,
      state: vista.state,
      method: vista.method,
      amountInCents: tipo === 'estorno_pendente' ? Number(row.aEstornarCents ?? 0) : vista.amountInCents,
      simulated: vista.simulated,
      startedAt: (row.startedAt as string | undefined) ?? (row.createdAt as string | undefined) ?? null,
      saleId: (row.saleId as string | null | undefined) ?? null,
    });
  }
  cobrancas.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));

  /*
    O PIX (ou outro meio assíncrono) que entrou `pending` numa venda desta
    gaveta: a venda fechou, o dinheiro ainda não chegou. O resumo do turno já
    o deixava FORA do "recebido por meio"; aqui ele volta como o que é — uma
    pendência que alguém precisa acompanhar.
  */
  const pagamentosPendentes = (
    getConnection()
      .prepare(
        `SELECT p.id AS paymentId, p.sale_id AS saleId, s.number AS saleNumber,
                p.method AS method, p.amount_cents AS amountCents
           FROM core_sale_payments p
           JOIN core_sales s ON s.id = p.sale_id
          WHERE s.company_id = ? AND s.cash_session_id = ? AND s.status = 'completed'
            AND p.status = 'pending'
          ORDER BY s.number, p.id`,
      )
      .all(companyId, turno.id) as unknown as PagamentoPendenteDoTurno[]
  ).map((p) => ({ ...p, saleNumber: p.saleNumber ?? null, amountCents: Number(p.amountCents) }));

  const vendasOffline = vendasOfflinePendentesDaGaveta(companyId, turno.id);
  const devolucoesAguardandoReembolso = devolucoesAguardandoReembolsoDoTurno(companyId, turno);

  const totalCents =
    cobrancas.reduce((s, c) => s + c.amountInCents, 0)
    + pagamentosPendentes.reduce((s, p) => s + p.amountCents, 0)
    + vendasOffline.reduce((s, v) => s + v.receivedCents, 0)
    + devolucoesAguardandoReembolso.reduce((s, d) => s + d.pendenteCents, 0);
  return {
    cobrancas,
    pagamentosPendentes,
    vendasOffline,
    devolucoesAguardandoReembolso,
    quantidade:
      cobrancas.length
      + pagamentosPendentes.length
      + vendasOffline.length
      + devolucoesAguardandoReembolso.length,
    totalCents,
  };
}

/**
 * ============================================================================
 * A DEVOLUÇÃO EM DUAS ETAPAS QUE AINDA NÃO PAGOU O CLIENTE
 * ============================================================================
 *
 * O DEFEITO (auditoria do PDV, P0 da Preço Justo): a Preço Justo é a operação
 * onde a devolução em duas etapas está LIGADA por padrão
 * (`ativarDevolucaoEmDuasEtapasNaPrecoJusto`). Nela o registro da devolução
 * trata só a MERCADORIA — a peça volta à prateleira na hora — e o dinheiro é
 * registrado depois, quando de fato voltar ao cliente. Entre uma coisa e a
 * outra a loja DEVE aquele valor.
 *
 * O fechamento do turno não enxergava isso. A gaveta fechava com diferença
 * ZERO e o histórico dizia "conferido": e estava certo na aritmética, porque o
 * dinheiro do reembolso em espécie continua DENTRO da gaveta — só que ele não
 * é da loja. O operador ia embora sem saber que devia R$ X a alguém, o turno
 * seguinte contava aquele dinheiro como seu, e a devolução ficava esperando
 * num lugar que o balcão não abre (Vendas › Devoluções, da gestão).
 *
 * É exatamente a espécie de coisa que o GAP-PRD-081 decidiu não deixar passar
 * calada, e a regra aqui é a MESMA das outras três: não trava para sempre —
 * quem paga o cliente muitas vezes é a gestão, e o operador não pode ficar
 * preso no balcão por isso —, trava até ser DITA. A primeira tentativa volta
 * 409 com o valor e a venda; fechar exige declarar ciência com o motivo, e o
 * que ficou pendente vai para o turno e para a auditoria.
 *
 * ## De quem é a devolução
 *
 * `core_sale_returns.cash_session_id` NÃO serve: ele é a gaveta de onde o
 * dinheiro SAIU e nasce nulo de propósito (GAP-PRD-161) — na devolução em duas
 * etapas ele continua nulo justamente porque nada saiu ainda. A amarra é a
 * mesma que este arquivo já usa para a cobrança sem carimbo: a JANELA do turno
 * (registrada depois da abertura e, se já fechou, antes do fechamento). Na
 * Preço Justo a janela é exata, porque a operação tem uma gaveta aberta por vez
 * (`CORE_CASH_ALREADY_OPEN`).
 *
 * A devolução do fluxo IMEDIATO nunca entra: nele o registro já dá o dinheiro
 * por devolvido, e `refund_flow` é nulo. As outras cinco operações do grupo
 * seguem nesse fluxo e não veem diferença nenhuma.
 */
export function devolucoesAguardandoReembolsoDoTurno(
  companyId: string,
  turno: TurnoLido,
): DevolucaoAguardandoReembolso[] {
  const linhas = getConnection()
    .prepare(
      `SELECT r.id AS id, r.number AS number, r.sale_id AS saleId, s.number AS saleNumber,
              r.total_cents AS devolvivelCents, r.created_at AS createdAt,
              (SELECT COALESCE(SUM(f.amount_cents), 0) FROM core_sale_return_refunds f
                WHERE f.return_id = r.id) AS reembolsadoCents
         FROM core_sale_returns r
         JOIN core_sales s ON s.id = r.sale_id
        WHERE r.company_id = ? AND r.refund_flow = 'duas_etapas'
          AND r.created_at >= ?
          AND (? IS NULL OR r.created_at <= ?)
        ORDER BY r.number`,
    )
    .all(companyId, turno.opened_at, turno.closed_at, turno.closed_at) as unknown as {
    id: string;
    number: number;
    saleId: string;
    saleNumber: number | null;
    devolvivelCents: number;
    createdAt: string;
    reembolsadoCents: number;
  }[];
  return linhas
    .map((l) => {
      const devolvivelCents = Number(l.devolvivelCents ?? 0);
      const reembolsadoCents = Number(l.reembolsadoCents ?? 0);
      return {
        id: String(l.id),
        number: Number(l.number),
        saleId: String(l.saleId),
        saleNumber: l.saleNumber ?? null,
        devolvivelCents,
        reembolsadoCents,
        pendenteCents: Math.max(0, devolvivelCents - reembolsadoCents),
        createdAt: String(l.createdAt),
      };
    })
    .filter((d) => d.pendenteCents > 0);
}
