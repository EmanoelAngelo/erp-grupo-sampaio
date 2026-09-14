/**
 * As duas perguntas das telas que fecham gaveta sobre a pendência eletrônica
 * do turno (GAP-PRD-081). Moram fora do componente `PendenciasDoFechamento`
 * para que ele exporte só componente (fast refresh).
 */
import { ApiRequestError } from '@/lib/api/client';
import type { PendenciasEletronicas } from '@/lib/api/core';

/** A recusa do fechamento traz as pendências — ou não é essa recusa. */
export function pendenciasDoErro(err: unknown): PendenciasEletronicas | null {
  if (!(err instanceof ApiRequestError) || err.code !== 'CORE_CASH_CLOSE_ELECTRONIC_PENDING') return null;
  const detalhes = err.details as { pendencias?: PendenciasEletronicas } | undefined;
  return detalhes?.pendencias ?? null;
}

/** O motivo é aceitável? A mesma régua do servidor (3 caracteres). */
export function cienciaCompleta(ciente: boolean, motivo: string): boolean {
  return ciente && motivo.trim().length >= 3;
}
