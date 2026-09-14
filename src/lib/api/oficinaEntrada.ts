/**
 * A ENTRADA NA OFICINA — onde o balcão abre a OS e cadastra a máquina
 * (GAP-PRD-099).
 *
 * O servidor decide a régua (`GET /core/workshop/entrada`): o caixa e o
 * atendente abrem em qualquer bancada da empresa, o mecânico só nas dele. A
 * tela só pergunta a bancada quando a lista tem mais de uma — com uma, o
 * servidor a assume sozinho.
 */
import { apiRequest } from './client';

export interface BancadaDeEntrada {
  id: string;
  slug: string;
  name: string;
  kind: string;
}

/** O corpo da abertura da OS, como `POST /core/workshop/orders` o lê. */
export interface AberturaDeOs {
  workshopId?: string | null;
  customerName?: string;
  customerId?: string | null;
  equipment?: string;
  equipmentId?: string | null;
  plate?: string;
  complaint?: string;
  priority?: string;
  dueDate?: string | null;
}

export interface OsAberta {
  id: string;
  number: number;
  status: string;
  workshop_id: string | null;
}

export const oficinaEntradaApi = {
  bancadas: () =>
    apiRequest<{ items: BancadaDeEntrada[] }>('/core/workshop/entrada').then((r) =>
      Array.isArray(r?.items) ? r.items : [],
    ),

  abrirOs: (corpo: AberturaDeOs) =>
    apiRequest<OsAberta>('/core/workshop/orders', { method: 'POST', body: corpo }),
};

/** Escolher a bancada só faz sentido quando há mais de uma no alcance. */
export function precisaEscolherBancada(bancadas: BancadaDeEntrada[] | null): boolean {
  return Array.isArray(bancadas) && bancadas.length > 1;
}
