/**
 * A contingência off-line da NFC-e na tela (GAP-PRD-098).
 *
 * A MODALIDADE (aguardar a SEFAZ ou emitir off-line, tpEmis 9) e o PRAZO de
 * transmissão são decisão do contador — quem grava é o dono do grupo. O
 * PERÍODO abre sozinho quando a SEFAZ cai (ou pela gerência, com
 * justificativa) e fecha sozinho quando ela volta (ou pela gerência).
 */
import { apiRequest, exigirCampos } from './client';

export type ModoDeContingencia = 'AGUARDAR' | 'OFFLINE_NFCE';

export interface PoliticaDeContingencia {
  modo: ModoDeContingencia;
  prazoHoras: number | null;
  observacao: string | null;
  atualizadoEm: string | null;
  atualizadoPor: string | null;
}

export interface PeriodoDeContingencia {
  id: string;
  motivo: 'SEFAZ_UNAVAILABLE' | 'NETWORK_UNAVAILABLE' | 'TRANSPORT_ERROR';
  motivoRotulo: string;
  justificativa: string;
  iniciadoEm: string;
  origem: 'AUTOMATICA' | 'MANUAL';
  iniciadoPor: string | null;
  codigoDoGatilho: string | null;
  encerradoEm: string | null;
  origemDoEncerramento: 'AUTOMATICA' | 'MANUAL' | null;
  encerradoPor: string | null;
  ultimaSondagemEm: string | null;
  ultimaSondagemCStat: string | null;
  ultimaSondagemMotivo: string | null;
}

export interface PainelDaContingencia {
  politica: PoliticaDeContingencia;
  periodo: PeriodoDeContingencia | null;
  historico: PeriodoDeContingencia[];
  notasOffline: { pendentes: number; prazoMaisProximo: string | null };
}

/**
 * O quadro lê `p.politica.modo` ao receber o painel. Um 200 sem esses campos
 * vira `ApiRequestError` (o `catch` do quadro o mostra) em vez de apagar a
 * tela de Documentos. `periodo` é anulável e fica de fora.
 */
function painelConferido(p: PainelDaContingencia): PainelDaContingencia {
  return exigirCampos(p, 'politica', 'historico', 'notasOffline');
}

export const contingenciaFiscalApi = {
  painel: () => apiRequest<PainelDaContingencia>('/core/fiscal/contingency').then(painelConferido),

  /** Só os donos do grupo gravam — a decisão é do contador. */
  gravarPolitica: (input: { modo: ModoDeContingencia; prazoHoras?: number | null; observacao?: string }) =>
    apiRequest<PainelDaContingencia>('/core/fiscal/contingency/policy', { method: 'PUT', body: input })
      .then(painelConferido),

  /** A justificativa vai no xJust de cada NFC-e do período (15 a 256 caracteres). */
  entrar: (justificativa: string) =>
    apiRequest<PainelDaContingencia>('/core/fiscal/contingency/enter', {
      method: 'POST',
      body: { justificativa },
    }).then(painelConferido),

  sair: () =>
    apiRequest<PainelDaContingencia>('/core/fiscal/contingency/exit', { method: 'POST' }).then(painelConferido),
};
