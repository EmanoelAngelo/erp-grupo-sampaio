/**
 * Os direitos do titular (LGPD, art. 18) — cliente (GAP-PRD-073).
 *
 * Três rotas da gerência: exportar tudo o que a operação guarda de uma
 * pessoa, anonimizar o cadastro mantendo o histórico fiscal, e ler a política
 * de retenção (o que fica guardado, e por quanto tempo). O servidor decide
 * tudo — perfil, empresa, pendências —; a tela mostra o que ele disser.
 */
import { apiRequest, envelope, type ApiRequestError } from '@/lib/api/client';

export interface RegraDeRetencao {
  chave: string;
  oQue: string;
  prazo: string;
  base: string;
  destino: string;
}

export interface PendenciaDoTitular {
  chave: string;
  descricao: string;
}

export interface DocumentoDoTitular {
  formato: string;
  geradoEm: string;
  titular: Record<string, unknown>;
  secoes: { chave: string; titulo: string; total: number; linhas: Record<string, unknown>[] }[];
  retencao: RegraDeRetencao[];
  observacoes: string[];
}

export interface ResultadoDaAnonimizacao {
  id: string;
  anonimizadoEm: string;
  motivo: string;
  alterados: Record<string, number>;
  retidos: RegraDeRetencao[];
  avisos: string[];
}

export const lgpdApi = {
  /** O documento inteiro do titular, como o servidor o montou. */
  exportar: (customerId: string) =>
    apiRequest<DocumentoDoTitular>(`/core/customers/${encodeURIComponent(customerId)}/dados-do-titular`),

  /** Anonimiza — sem volta. O servidor recusa com a lista de pendências (409). */
  anonimizar: (customerId: string, motivo: string) =>
    apiRequest<ResultadoDaAnonimizacao>(`/core/customers/${encodeURIComponent(customerId)}/anonimizar`, {
      method: 'POST',
      body: { motivo },
    }),

  retencao: () =>
    apiRequest<{ items: RegraDeRetencao[] }>('/core/lgpd/retencao').then(envelope('items')),
};

/**
 * As pendências que o servidor mandou junto com a recusa (`CORE_TITULAR_COM_PENDENCIA`).
 *
 * Conferidas na borda: um `details` em outro formato vira lista vazia, e a
 * tela mostra ao menos a frase da recusa em vez de quebrar.
 */
export function pendenciasDoErro(err: ApiRequestError): PendenciaDoTitular[] {
  const detalhes = err.details as { pendencias?: unknown } | undefined;
  if (!detalhes || !Array.isArray(detalhes.pendencias)) return [];
  return detalhes.pendencias.filter(
    (p): p is PendenciaDoTitular =>
      !!p && typeof (p as PendenciaDoTitular).descricao === 'string' && typeof (p as PendenciaDoTitular).chave === 'string',
  );
}
