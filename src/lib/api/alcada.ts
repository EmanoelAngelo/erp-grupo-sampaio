/**
 * Alçada pontual — quem libera nesta operação (GAP-PRD-054).
 *
 * `GET /core/authorizations/quem-libera` responde, para a operação da sessão,
 * quem tem alçada ALI: os gerentes da operação e os donos do grupo. Só nomes e
 * perfis; o login fica de fora de propósito (é metade da credencial que o
 * diálogo de liberação pede).
 */
import { apiRequest, exigirCampos } from '@/lib/api/client';

export interface QuemLibera {
  nome: string;
  perfil: string;
}

export interface QuemLiberaResposta {
  daOperacao: QuemLibera[];
  doGrupo: QuemLibera[];
  /** Nenhum gerente desta operação tem alçada: tudo depende dos donos do grupo. */
  semAlcadaNaOperacao: boolean;
  /** As ações que o servidor cobra com liberação (`RESTRICTED_ACTIONS`). */
  acoes: string[];
}

export const alcadaApi = {
  quemLibera: () =>
    apiRequest<QuemLiberaResposta>('/core/authorizations/quem-libera').then((r) =>
      exigirCampos(r, 'daOperacao', 'doGrupo', 'semAlcadaNaOperacao', 'acoes'),
    ),
};
