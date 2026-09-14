/**
 * A política de gestão (GAP-PRD-165/166) — quem vê dinheiro e como o estoque é
 * valorizado. Ler é do escritório; salvar é dos donos. Módulo próprio pela
 * regra da casa: `core.ts` intocado.
 */
import { apiRequest, envelope } from './client';

export type ReguaDeValorizacao = 'ultimo_custo' | 'custo_medio';

export interface PoliticaDeGestao {
  painelFinanceiroEquipe: boolean;
  custoDoEstoqueEquipe: boolean;
  reguaDeValorizacao: ReguaDeValorizacao;
  reguaConfirmadaPor: string | null;
  reguaConfirmadaEm: string | null;
  decidida: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
}

export interface MudancaDaPolitica {
  painelFinanceiroEquipe?: boolean;
  custoDoEstoqueEquipe?: boolean;
  reguaDeValorizacao?: ReguaDeValorizacao;
  /** Nome de quem confirmou a régua (o contador). Vazio desfaz a confirmação. */
  reguaConfirmadaPor?: string;
}

export const politicaGestaoApi = {
  ler: () =>
    apiRequest<{ policy: PoliticaDeGestao }>('/core/management-policy').then(envelope('policy')),
  salvar: (mudanca: MudancaDaPolitica) =>
    apiRequest<{ policy: PoliticaDeGestao }>('/core/management-policy', {
      method: 'PUT',
      body: mudanca,
    }).then(envelope('policy')),
};
