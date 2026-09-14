/**
 * O histórico de fechamentos de comissão (GAP-PRD-174).
 *
 * O fechamento gravava histórico que nenhuma tela lia de volta, e o título da
 * comissão no contas a pagar não levava a lugar nenhum. Este é o cliente das
 * duas rotas que o leem: a lista e o fechamento por id, com as vendas que ele
 * levou e a situação do título que gerou.
 */
import { apiRequest, envelope, exigirCampos } from './client';

export interface FechamentoDeComissao {
  id: string;
  sellerId: string;
  sellerName: string | null;
  periodFrom: string;
  periodTo: string;
  totalCents: number;
  /** A conta a pagar gerada. Nulo quando o saldo do período foi zero ou negativo. */
  financeEntryId: string | null;
  /** Quanto falta pagar do título. Nulo sem título. */
  entryBalanceCents: number | null;
  entryCancelled: boolean;
  closedBy: string | null;
  closedByName: string | null;
  createdAt: string;
  lineCount: number;
}

export interface LinhaDoFechamento {
  id: string;
  saleId: string | null;
  saleNumber: number | null;
  /** sale | sale_cancel | sale_return | ajuste */
  originType: string;
  baseCents: number;
  rateBps: number;
  /** Negativo no estorno. */
  amountCents: number;
  competenceDate: string;
  note: string | null;
}

export const fechamentosDeComissaoApi = {
  listar: () =>
    apiRequest<{ items: FechamentoDeComissao[] }>('/core/commissions/closings').then(envelope('items')),

  abrir: (id: string) =>
    apiRequest<{ closing: FechamentoDeComissao; lines: LinhaDoFechamento[] }>(
      `/core/commissions/closings/${encodeURIComponent(id)}`,
    ).then((r) => exigirCampos(r, 'closing', 'lines')),
};
