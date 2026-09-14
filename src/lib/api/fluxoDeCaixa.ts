/**
 * Fluxo de caixa projetado (GAP-PRD-094) — o cliente da rota
 * `GET /core/finance/cash-flow`.
 *
 * O servidor faz a conta inteira (saldo de hoje, vencidos, o que entra e sai
 * por período, menor saldo, primeiro dia negativo) e diz o que ficou de fora.
 * A tela só escolhe o recorte e mostra.
 */
import { apiRequest, exigirCampos } from './client';

export type GranularidadeDoFluxo = 'day' | 'week';
/** O que fazer com os títulos vencidos em aberto. */
export type VencidosNoFluxo = 'payables' | 'both' | 'none';

export interface ItemDoFluxo {
  id: string;
  direction: 'in' | 'out';
  description: string;
  dueDate: string | null;
  balanceCents: number;
  counterpartyName: string | null;
  originType: string;
  originId: string;
  accountId: string | null;
}

export interface PeriodoDoFluxo {
  start: string;
  end: string;
  inCents: number;
  outCents: number;
  netCents: number;
  /** Saldo projetado ao fim do período. */
  balanceCents: number;
  count: number;
  items: ItemDoFluxo[];
}

export interface FluxoDeCaixa {
  from: string;
  to: string;
  today: string;
  granularity: GranularidadeDoFluxo;
  overdueMode: VencidosNoFluxo;
  account: { id: string; name: string } | null;
  openingBalanceCents: number;
  accountsConsidered: number;
  overdue: {
    inCents: number;
    outCents: number;
    count: number;
    countedInCents: number;
    countedOutCents: number;
  };
  periods: PeriodoDoFluxo[];
  totals: { inCents: number; outCents: number; netCents: number };
  closingBalanceCents: number;
  lowestBalance: { cents: number; date: string };
  firstNegativeDate: string | null;
  noDueDate: { inCents: number; outCents: number; count: number };
  beyond: { inCents: number; outCents: number; count: number };
  withoutAccount: { inCents: number; outCents: number; count: number } | null;
  settledWithoutAccountCents: number;
  caveats: string[];
}

export const fluxoDeCaixaApi = {
  projetar: (params: {
    days?: number;
    from?: string;
    to?: string;
    accountId?: string | null;
    granularity?: GranularidadeDoFluxo;
    overdue?: VencidosNoFluxo;
  } = {}) => {
    const qs = new URLSearchParams();
    if (params.days) qs.set('days', String(params.days));
    if (params.from) qs.set('from', params.from);
    if (params.to) qs.set('to', params.to);
    if (params.accountId) qs.set('accountId', params.accountId);
    if (params.granularity) qs.set('granularity', params.granularity);
    if (params.overdue) qs.set('overdue', params.overdue);
    const q = qs.toString();
    // Contrato conferido: um corpo sem as partes que a tela lê viraria
    // `undefined` no meio do render; assim vira o aviso de erro de sempre.
    return apiRequest<FluxoDeCaixa>(`/core/finance/cash-flow${q ? `?${q}` : ''}`).then((r) =>
      exigirCampos(
        r,
        'periods',
        'totals',
        'overdue',
        'lowestBalance',
        'caveats',
        'beyond',
        'openingBalanceCents',
        'closingBalanceCents',
      ),
    );
  },
};
