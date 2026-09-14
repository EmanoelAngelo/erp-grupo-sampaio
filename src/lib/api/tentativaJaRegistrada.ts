import { ApiRequestError } from './client';

/**
 * A recusa da chave reusada (422 CORE_IDEMPOTENCY_KEY_REUSED), lida pelo
 * CÓDIGO — nunca pelo texto, que fala em "chave de idempotência" (R2-IDEM).
 * A pergunta que a tela faz diante dela mora em `TentativaJaRegistrada`.
 */
export function ehTentativaJaRegistrada(err: unknown): err is ApiRequestError {
  return err instanceof ApiRequestError && err.code === 'CORE_IDEMPOTENCY_KEY_REUSED';
}
