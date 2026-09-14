/**
 * A NFC-e no Finalizar (GAP-PRD-163): manual (padrão) ou automática quando a
 * venda está pronta. A escolha é do dono; a gerência vê qual está valendo.
 */
import { apiRequest } from './client';

export type ModoDaNfceNoFinalizar = 'MANUAL' | 'AUTOMATICA';

export interface PoliticaDeEmissao {
  modo: ModoDaNfceNoFinalizar;
  atualizadoEm: string | null;
  atualizadoPor: string | null;
}

/** O que o Finalizar fez com a NFC-e — vem na resposta da venda. */
export interface DisparoDaNfce {
  modo: ModoDaNfceNoFinalizar;
  disparada: boolean;
  motivos: string[];
}

export const emissaoNoFinalizarApi = {
  ler: () => apiRequest<PoliticaDeEmissao>('/core/fiscal/emission-policy'),
  /** Só os donos gravam — a gerência recebe a recusa do servidor. */
  gravar: (modo: ModoDaNfceNoFinalizar) =>
    apiRequest<PoliticaDeEmissao>('/core/fiscal/emission-policy', { method: 'PUT', body: { modo } }),
};
