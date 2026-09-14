/**
 * O QUADRO DA OFICINA — a OS fora das regras (GAP-PRD-188).
 *
 * `POST /core/workshop/orders/:id/regularizar`: a gestão da oficina devolve ao
 * quadro a OS antiga (sem bancada, ou numa coluna de trabalho sem ninguém) ou a
 * encerra como lançamento indevido quando ela não tem dinheiro nenhum.
 */
import { apiRequest } from './client';

export type DestinoDaRegularizacao = 'quadro' | 'encerrar';

export const IRREGULARIDADE_DA_OS: Record<string, string> = {
  sem_bancada: 'Sem bancada — a OS é de antes de a bancada existir e aparece para todas.',
  sem_responsavel:
    'Numa coluna de trabalho sem responsável — ninguém consegue concluí-la nem largá-la.',
};

export const oficinaQuadroApi = {
  regularizar: (
    orderId: string,
    corpo: { destino: DestinoDaRegularizacao; motivo: string; workshopId?: string },
  ) =>
    apiRequest<{ id: string; status: string; workshop_id: string | null }>(
      `/core/workshop/orders/${orderId}/regularizar`,
      { method: 'POST', body: corpo },
    ),
};
