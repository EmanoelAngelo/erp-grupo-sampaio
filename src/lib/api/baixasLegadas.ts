/**
 * As quitações antigas sem baixa (GAP-PRD-171) — a lista e a decisão.
 *
 * Lançamentos quitados antes do V29 não têm linha de baixa, e a conciliação
 * bancária (que casa extrato com BAIXA) não os enxerga. Criar a baixa-espelho
 * deles é decisão de quem responde pelo caixa; este é o cliente das duas
 * rotas que a tornam possível.
 */
import { apiRequest, exigirCampos } from './client';

export interface QuitacaoSemBaixa {
  id: string;
  direction: 'in' | 'out';
  description: string;
  amountCents: number;
  settledCents: number;
  explainedCents: number;
  /** O valor da baixa-espelho que seria criada. */
  missingCents: number;
  /** A data que ela levaria: a da quitação original. */
  mirrorDate: string;
  paymentMethod: string | null;
  originType: string;
  createdAt: string;
}

export interface QuitacoesSemBaixa {
  items: QuitacaoSemBaixa[];
  count: number;
  inCents: number;
  outCents: number;
}

export const baixasLegadasApi = {
  listar: () =>
    apiRequest<QuitacoesSemBaixa>('/core/finance/legacy-settlements').then((r) =>
      exigirCampos(r, 'items', 'count', 'inCents', 'outCents'),
    ),

  /** Cria as baixas-espelho. `confirm` vai sempre: o servidor recusa sem ele. */
  criarEspelhos: (entryIds?: string[]) =>
    apiRequest<{ created: number; totalCents: number; settlementIds: string[] }>(
      '/core/finance/legacy-settlements/mirror',
      { method: 'POST', body: { confirm: true, ...(entryIds ? { entryIds } : {}) } },
    ),
};
