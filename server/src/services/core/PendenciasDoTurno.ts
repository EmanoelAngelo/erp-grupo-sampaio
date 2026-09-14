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

  const totalCents =
    cobrancas.reduce((s, c) => s + c.amountInCents, 0)
    + pagamentosPendentes.reduce((s, p) => s + p.amountCents, 0)
    + vendasOffline.reduce((s, v) => s + v.receivedCents, 0);
  return {
    cobrancas,
    pagamentosPendentes,
    vendasOffline,
    quantidade: cobrancas.length + pagamentosPendentes.length + vendasOffline.length,
    totalCents,
  };
}
