/**
 * O webhook do Asaas como o servidor o descreve (GAP-PRD-002).
 *
 * Vem dentro de `GET /core/integrations/asaas`, no campo `webhook`. Tipos em
 * módulo próprio para a tela de Integrações e o card do webhook não
 * dependerem do resto do cliente do núcleo.
 */

export interface AsaasWebhookEvent {
  eventType: string;
  receivedAt: string;
  processed: boolean;
  /** Motivo gravado quando o processamento falhou e espera o reenvio. */
  error: string | null;
}

export interface AsaasWebhookInfo {
  /** A URL a cadastrar no painel do Asaas DESTA operação. */
  url: string;
  /** Endereço antigo, aceito pelo mesmo processamento (empresa pelo token). */
  legacyUrl: string;
  /** De onde saiu o endereço: a variável do webhook ou o endereço público da API (GAP-PRD-153). */
  baseSource: 'ASAAS_WEBHOOK_PUBLIC_URL' | 'GRUPO_SAMPAIO_PUBLIC_URL';
  /** HTTPS público — o único endereço que o Asaas alcança. */
  publiclyReachable: boolean;
  /** O que falta para o Asaas alcançar; nulo quando nada falta. */
  warning: string | null;
  lastEvent: AsaasWebhookEvent | null;
  eventsLast30Days: number;
  pendingWithError: number;
}
