import { randomUUID } from 'node:crypto';
import { insertRow, findOneRow, findRows, updateRows } from '../../db/database.js';
import { ApiError, sanitizeForLog } from '../../utils/errors.js';
import { AsaasHttpClient } from './AsaasHttpClient.js';
import { loadEnv } from '../../config/env.js';
import { getAsaasApiKey } from '../integrations/AsaasCredentialService.js';

/*
  A FILA DA HOMOLOGAÇÃO SANDBOX — e só isso (GAP-PRD-075).

  Esta fila (`asaas_operational_attempts`) tem um escritor, o passo de
  idempotência da homologação sandbox, e dois leitores: o próprio passo e
  `GET /asaas/queue` (com o retry cercado pela empresa, GAP-PRD-155). Cobrança
  de verdade não passa por aqui: nasce em `core_payment_intents` pelo núcleo.

  O que saiu na junção do GAP-PRD-075:

    - `receiveAsaasWebhook` e `processWebhookEvent`, sem um chamador desde que
      `/webhooks/asaas` passou a entrar no processamento do núcleo
      (GAP-PRD-002). Gravavam em `asaas_webhook_events`, um segundo livro de
      avisos ao lado de `core_payment_webhooks`; os avisos antigos são copiados
      para o livro do núcleo pelo passo 85 e a coleção foi aposentada.
    - as coleções `asaas_customer_links` e `asaas_charge_links`, que só este
      processador escrevia e ninguém lia. O que o provedor devolve fica na
      própria tentativa (`remoteLink`), que é o registro que a fila mostra.
    - o ramo `asaas_charge_create`: ninguém mais o enfileira (a rota que o
      fazia responde 410 desde o GAP-PRD-093).

  E um tipo de operação que o processador não conhece deixou de terminar
  "completed" sem ter feito nada: vai para `dead_letter` com o motivo.
*/

export interface OperationalAttemptInput {
  companyId: string;
  storeId?: string;
  operationType: string;
  sourceType: string;
  sourceId?: string;
  idempotencyKey: string;
  correlationId: string;
  payload?: Record<string, unknown>;
}

/** Os tipos que o processador sabe executar. */
export const OPERACOES_CONHECIDAS: readonly string[] = ['asaas_customer_sync'];

export function enqueueOperationalAttempt(input: OperationalAttemptInput): Record<string, unknown> {
  const existing = findOneRow<Record<string, unknown>>(
    'asaas_operational_attempts',
    (row) =>
      row.companyId === input.companyId &&
      row.idempotencyKey === input.idempotencyKey,
  );
  if (existing) return existing;

  const row = {
    id: randomUUID(),
    companyId: input.companyId,
    storeId: input.storeId,
    operationType: input.operationType,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    status: 'queued',
    stage: 'pending',
    retryCount: 0,
    maxRetries: loadEnv().ASAAS_MAX_RETRIES,
    idempotencyKey: input.idempotencyKey,
    correlationId: input.correlationId,
    fingerprint: `${input.operationType}|${input.sourceType}|${input.sourceId ?? ''}`,
    metadata: sanitizeForLog(input.payload ?? {}),
    createdAt: new Date().toISOString(),
  };
  insertRow('asaas_operational_attempts', row);
  return row;
}

export function listOperationalAttempts(companyId: string): Record<string, unknown>[] {
  return findRows('asaas_operational_attempts', (row) => row.companyId === companyId);
}

/**
 * Processa UMA tentativa da fila — DA EMPRESA INFORMADA (GAP-PRD-155).
 *
 * A busca era só pelo id. Quem soubesse o id de uma tentativa de outra
 * operação (a rota de retry aceitava qualquer um) disparava o processamento
 * dela com o cofre DELA: criação de cliente e de cobrança no Asaas da vizinha,
 * na hora que quisesse. `companyId` agora é obrigatório e entra no predicado
 * de TODAS as leituras e escritas: tentativa alheia é tentativa inexistente.
 *
 * Devolve a tentativa como ficou, ou `null` quando ela não existe NESTA
 * empresa — é o que deixa a rota responder 404 sem ter tocado em nada.
 */
export async function processOperationalAttempt(
  attemptId: string,
  companyId: string,
  fetchImpl?: typeof fetch,
): Promise<Record<string, unknown> | null> {
  if (!companyId) return null;
  const daEmpresa = (row: Record<string, unknown>) => row.id === attemptId && row.companyId === companyId;
  const reler = () => findOneRow<Record<string, unknown>>('asaas_operational_attempts', daEmpresa);
  const attempt = reler();
  if (!attempt) return null;
  if (attempt.status === 'completed') return attempt;

  if (!OPERACOES_CONHECIDAS.includes(String(attempt.operationType))) {
    updateRows(
      'asaas_operational_attempts',
      daEmpresa,
      (row) => ({
        ...row,
        status: 'dead_letter',
        sanitizedError: 'ASAAS_OPERATION_UNKNOWN',
        failedAt: new Date().toISOString(),
      }),
    );
    return reler();
  }

  const env = loadEnv();
  if (!env.asaasEnabled) {
    const hasVault = getAsaasApiKey(String(attempt.companyId), 'sandbox', { storeId: attempt.storeId as string | undefined });
    if (!hasVault) {
      updateRows(
        'asaas_operational_attempts',
        daEmpresa,
        (row) => ({ ...row, status: 'retry_pending', sanitizedError: 'ASAAS_DISABLED' }),
      );
      return reler();
    }
  }

  const client = new AsaasHttpClient({ environment: 'sandbox', fetchImpl, companyId: String(attempt.companyId), storeId: attempt.storeId as string | undefined });
  try {
    // `asaas_customer_sync`, o único tipo conhecido (conferido acima).
    const payload = (attempt.metadata ?? {}) as Record<string, unknown>;
    const remote = await client.createCustomer({
      name: payload.name ?? 'Cliente DEVORA',
      cpfCnpj: payload.document,
      externalReference: String(payload.customerId ?? attempt.sourceId),
    });
    // O que o provedor devolveu fica NA TENTATIVA — o registro que a fila mostra.
    const remoteLink = {
      customerId: attempt.sourceId,
      asaasCustomerId: remote.id,
      environment: 'sandbox',
      createdAt: new Date().toISOString(),
    };
    updateRows(
      'asaas_operational_attempts',
      daEmpresa,
      (row) => ({ ...row, status: 'completed', completedAt: new Date().toISOString(), remoteLink }),
    );
  } catch (err) {
    const code = err instanceof ApiError ? err.code : 'ASAAS_REMOTE_ERROR';
    updateRows(
      'asaas_operational_attempts',
      daEmpresa,
      (row) => ({
        ...row,
        status: Number(row.retryCount) >= Number(row.maxRetries) ? 'dead_letter' : 'retry_pending',
        retryCount: Number(row.retryCount) + 1,
        sanitizedError: code,
        failedAt: new Date().toISOString(),
      }),
    );
  }
  return reler();
}
