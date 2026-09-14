/**
 * Os atos com a SEFAZ — cancelamento, carta de correção e inutilização
 * (GAP-PRD-005).
 *
 * A tela não escolhe mais o provider: ela PERGUNTA ao servidor como o ato vai
 * sair (SEFAZ e em qual ambiente, simulador para nota de ensaio, ou bloqueado
 * com o motivo) e se a senha do certificado vai ser pedida. É a mesma decisão
 * que o ato executa depois do clique — as duas não têm como divergir.
 */
import { apiRequest } from './client';

export type CaminhoDoAtoFiscal = 'SEFAZ' | 'SIMULADOR' | 'BLOQUEADO';
export type SenhaDoAtoFiscal = 'NAO_SE_APLICA' | 'OPCIONAL' | 'OBRIGATORIA';
export type SituacaoDoCofreFiscal = 'SELADO' | 'SEM_SENHA_SELADA' | 'AUSENTE';

export interface PoliticaDosAtosFiscais {
  /** `true`: cada ato pede a senha do A1. `false` (padrão): vale o cofre. */
  exigirSenhaDigitada: boolean;
  atualizadoEm: string | null;
  atualizadoPor: string | null;
}

export interface PlanoDoAtoFiscal {
  caminho: CaminhoDoAtoFiscal;
  ambiente: 'homologation' | 'production';
  senha: SenhaDoAtoFiscal;
  cofre: SituacaoDoCofreFiscal;
  codigo: string | null;
  motivo: string;
  politica: PoliticaDosAtosFiscais;
}

export const fiscalAtosApi = {
  /** Sem `documentId`, o plano da inutilização (que não age sobre nota). */
  plano: (documentId?: string | null) =>
    apiRequest<PlanoDoAtoFiscal>(
      `/core/fiscal/acts/plan${documentId ? `?documentId=${encodeURIComponent(documentId)}` : ''}`,
    ),

  /** Só os donos do grupo gravam — é a regra de uso do certificado. */
  gravarPolitica: (exigirSenhaDigitada: boolean) =>
    apiRequest<PoliticaDosAtosFiscais>('/core/fiscal/acts/policy', {
      method: 'PUT',
      body: { exigirSenhaDigitada },
    }),
};
