/**
 * A conferência de reservas — o cliente das duas rotas que nasceram no
 * GAP-PRD-087.
 *
 * `GET /core/stock/reconciliation` responde "o que está reservado sem origem, e
 * por quê" (as referências do razão que reservaram e não soltaram), e
 * `POST /core/stock/reservations/:id/liberar-sem-origem` é o gesto da gerência
 * para soltar SÓ a parte sem origem, com motivo.
 *
 * Módulo próprio pela regra da casa: domínio novo em arquivo novo, `core.ts`
 * intocado.
 */
import { apiRequest } from './client';

export type SituacaoDaOrigem = 'aberta' | 'encerrada' | 'inexistente' | 'nao_verificada';

export interface ReferenciaDaReserva {
  referenceType: string;
  referenceId: string;
  documentNumber: string | null;
  quantidade: number;
  desde: string;
  situacao: SituacaoDaOrigem;
  explicacao: string;
}

export type ChecagemDeReserva =
  | 'STOCK_RESERVATION_WITHOUT_SOURCE'
  | 'OPEN_ORDER_WITHOUT_RESERVATION'
  | 'RESERVATION_WITHOUT_LEDGER';

export interface ProblemaDeReserva {
  check: ChecagemDeReserva;
  severity: 'critical' | 'warning';
  productId: string;
  productName: string;
  detail: string;
  reserved: number;
  withSource: number;
  semOrigem: number;
  referencias: ReferenciaDaReserva[];
}

export interface ConferenciaDeReservas {
  healthy: boolean;
  critical: number;
  warnings: number;
  issues: ProblemaDeReserva[];
}

export interface LiberacaoDeReserva {
  productId: string;
  productName: string;
  liberado: number;
  reservadoAntes: number;
  reservadoDepois: number;
  semOrigemAntes: number;
}

export const reservasApi = {
  conferir: () => apiRequest<ConferenciaDeReservas>('/core/stock/reconciliation'),

  /** Sem `quantity`, o servidor solta exatamente a parte sem origem. */
  liberarSemOrigem: (productId: string, input: { reason: string; quantity?: number }) =>
    apiRequest<LiberacaoDeReserva>(
      `/core/stock/reservations/${encodeURIComponent(productId)}/liberar-sem-origem`,
      { method: 'POST', body: input },
    ),
};
