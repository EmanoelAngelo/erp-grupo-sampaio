/**
 * Cobranças do Asaas — os gestos que nasceram na remediação da frente FIN.
 *
 * Módulo próprio (e não mais linhas em `core.ts`) para as telas de Contas e
 * de Conciliação dependerem só do que usam:
 *
 *   - ESTORNAR a cobrança paga de um título (GAP-PRD-092);
 *   - SINCRONIZAR as cobranças em aberto com o que o provedor diz delas
 *     (GAP-PRD-016).
 */
import { apiRequest } from './client';

/** O que o servidor responde depois do estorno — cada metade dita à parte. */
export interface EstornoDaCobranca {
  intentId: string;
  providerRef: string;
  /** O provedor foi chamado agora e aceitou; `false` quando já estava estornada. */
  estornadoNoProvedor: boolean;
  /** A baixa do título foi desfeita agora. */
  baixaDesfeita: boolean;
  /** A baixa desta cobrança continua de pé depois do gesto. */
  baixaDePe: boolean;
  detail: string;
}

/** Uma cobrança cujo status o ERP corrigiu consultando o provedor. */
export interface MudancaDaSincronizacao {
  intentId: string;
  originType: string;
  originId: string;
  originLabel: string | null;
  providerRef: string;
  antes: string;
  depois: string;
  statusNoProvedor: string;
  detail: string;
}

export interface SincronizacaoAsaas {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  trigger: 'manual' | 'automatico';
  /** Cobranças perguntadas ao provedor nesta passada. */
  checked: number;
  /** Cobranças cujo status mudou aqui por causa da resposta. */
  changed: number;
  /** Consultas que falharam — essas continuam sem resposta. */
  failed: number;
  /** Cobranças que ficaram de fora pelo teto da passada. */
  skipped: number;
  /** Operação sem credencial: nada foi consultado. */
  unconfigured: boolean;
  changes: MudancaDaSincronizacao[];
  errors: { intentId: string; providerRef: string; error: string }[];
}

export const cobrancasApi = {
  /**
   * Estorna a cobrança PAGA do título (gerência). `desfazerBaixa` é a
   * confirmação explícita: sem ela o servidor recusa com 400.
   */
  estornarCobrancaDoTitulo: (entryId: string, input: { desfazerBaixa: boolean; motivo?: string }) =>
    apiRequest<EstornoDaCobranca>(`/core/finance/entries/${entryId}/charges/refund`, {
      method: 'POST',
      body: input,
    }),

  /** Pergunta ao provedor pelas cobranças em aberto e aplica o que ele disser. */
  sincronizarComOProvedor: () =>
    apiRequest<SincronizacaoAsaas>('/core/asaas/conciliacao/sincronizar', { method: 'POST' }),

  /** A última passada de sincronização desta operação, ou nula. */
  ultimaSincronizacao: () =>
    apiRequest<{ last: SincronizacaoAsaas | null; pendingWithRef: number }>(
      '/core/asaas/conciliacao/sincronizacao',
    ),
};
