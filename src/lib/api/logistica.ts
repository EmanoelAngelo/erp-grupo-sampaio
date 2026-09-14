/**
 * Credencial de transportadora — o que a tela Logística grava (GAP-PRD-117).
 *
 * Até aqui a credencial só entrava por `POST /logistics/carriers/credentials`
 * com curl e um JWT na mão. Estas chamadas são a mesma porta, agora com tela:
 * o token vai e não volta — a resposta traz só a dica mascarada (`••••1234`),
 * o ambiente e o que ainda trava a cotação no checkout.
 */
import { apiRequest } from './client';
import { uuid } from '@/lib/uuid';

/** O que a credencial desta transportadora permite hoje. */
export type LogisticsAccessMode = 'none' | 'simulated' | 'sandbox' | 'production' | 'blocked';

/**
 * Por que a cotação não vale como preço cobrado. Códigos estáveis do servidor;
 * a tela os traduz em `TRAVA_DA_LOGISTICA`.
 */
export type LogisticsAccessLock =
  | 'SEM_CREDENCIAL'
  | 'SEM_INTEGRACAO_DIRETA'
  | 'CREDENCIAL_DE_SANDBOX'
  | 'PRODUCAO_DESABILITADA_NO_PROCESSO'
  | 'SANDBOX_EM_SERVIDOR_DE_PRODUCAO'
  | 'SIMULACAO_EM_SERVIDOR_DE_PRODUCAO';

export interface LogisticsAccess {
  carrier: string;
  configured: boolean;
  environment: 'homologation' | 'production' | null;
  mode: LogisticsAccessMode;
  realCalls: boolean;
  chargeable: boolean;
  locks: LogisticsAccessLock[];
}

/** O ambiente como a tela o escolhe. `homologation` é o nome do sandbox no servidor. */
export type AmbienteDaCredencial = 'homologation' | 'production';

export interface CredencialGuardada {
  carrier: string;
  environment: AmbienteDaCredencial;
  hasCredentials: boolean;
  maskedHint: string | null;
  contactEmail: string | null;
  access: LogisticsAccess;
}

export interface ResultadoDoTeste {
  ok: boolean;
  real: boolean;
  simulated: boolean;
  environment?: 'sandbox' | 'production' | null;
  message?: string;
  locks?: LogisticsAccessLock[];
}

export const logisticaApi = {
  /** Guarda (ou substitui) o token. Chave de idempotência nova a cada gravação. */
  salvarCredencial: (input: {
    carrier: string;
    environment: AmbienteDaCredencial;
    token: string;
    contactEmail?: string;
  }) =>
    apiRequest<CredencialGuardada>('/logistics/carriers/credentials', {
      method: 'POST',
      body: input,
      idempotencyKey: `logistica-cred-${uuid()}`,
    }),

  removerCredencial: (carrier: string) =>
    apiRequest<{ removed: number; access: LogisticsAccess }>(
      `/logistics/carriers/${encodeURIComponent(carrier)}/credentials`,
      { method: 'DELETE' },
    ),

  /** Teste pedido pelo gestor. O resultado fica guardado e vira a coluna Conexão. */
  testarConexao: (carrier: string) =>
    apiRequest<ResultadoDoTeste>(`/logistics/carriers/${encodeURIComponent(carrier)}/test-connection`, {
      method: 'POST',
      body: {},
    }),
};
