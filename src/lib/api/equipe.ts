/**
 * Equipe: o que a hierarquia por capacidade acrescentou ao cliente
 * (GAP-PRD-010 e GAP-PRD-152).
 *
 * Mora fora de `core.ts` de propósito — o módulo grande é dividido por várias
 * frentes, e estas três peças são do mesmo assunto:
 *
 *   - `acoes`, que `GET /core/team` passa a mandar em cada pessoa: o que a tela
 *     pode oferecer sobre ela, calculado no servidor pelas MESMAS funções que
 *     recusam. A tela não tem uma segunda régua para divergir da primeira;
 *   - "Remover desta operação", a alavanca do vínculo — "Desativar" desliga a
 *     CONTA, que vale em todas as operações da pessoa;
 *   - "Dar acesso a uma conta que já existe", o desfazer da remoção.
 */
import { apiRequest } from './client';
import type { TeamMember } from './core';

export interface AcoesSobreMembro {
  /** Perfil e bancadas nesta operação. */
  gerirNaOperacao: boolean;
  /** Senha, desativação, nome e e-mail — valem para todas as operações da pessoa. */
  gerirConta: boolean;
  /** Tirar a pessoa só desta operação, mantendo as outras. */
  removerDaOperacao: boolean;
  /** Em quantas OUTRAS operações do grupo a conta entra (número, não nomes). */
  outrasOperacoes: number;
  /** A frase da recusa, quando `gerirConta` é falso. */
  motivo: string | null;
}

/**
 * Uma pessoa da lista de equipe. `acoes` é opcional porque um servidor de
 * antes deste contrato não a manda — e aí a tela oferece o que sempre ofereceu,
 * deixando a recusa, se houver, para o servidor.
 */
export type MembroDaEquipe = TeamMember & { acoes?: AcoesSobreMembro };

export const equipeApi = {
  removerDaOperacao: (id: string) =>
    apiRequest<{ id: string; removedFromCompany: true; outrasOperacoes: number }>(
      `/core/team/${id}/remove-from-company`,
      { method: 'POST', body: {} },
    ),

  darAcessoAContaExistente: (input: { login: string; profileCode: string; workshopIds?: string[] }) =>
    apiRequest<TeamMember>('/core/team/link', { method: 'POST', body: input }),
};
