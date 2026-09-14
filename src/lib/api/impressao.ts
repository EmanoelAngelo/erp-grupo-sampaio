/**
 * O cupom e a gaveta pelo AGENTE LOCAL do caixa (GAP-PRD-082).
 *
 * Quando o servidor decide que um job vai pelo agente (`transport: 'agent'`),
 * nenhuma janela abre: o agente do computador do caixa retira o cupom em
 * ESC/POS, escreve na térmica e conta se imprimiu. A tela acompanha o job até
 * `printed` ou `failed` — e diz o que o agente disse, em vez de afirmar que
 * saiu.
 */
import { apiRequest } from './client';
import type { PrintJob } from './core';

export const impressaoApi = {
  job: (id: string) => apiRequest<PrintJob>(`/core/print/jobs/${encodeURIComponent(id)}`),

  /** A página de teste da impressora de agente (gerência). */
  testarImpressora: (printerId: string) =>
    apiRequest<PrintJob>(`/core/print/printers/${encodeURIComponent(printerId)}/test`, { method: 'POST' }),

  /** Abrir a gaveta sem venda, com motivo. Só com o agente do caixa no ar. */
  abrirGaveta: (reason: string, terminalId: string | null) =>
    apiRequest<PrintJob>('/core/print/drawer/open', {
      method: 'POST',
      body: { reason, terminalId: terminalId ?? undefined },
    }),
};

const FINAIS = new Set(['printed', 'failed', 'cancelled']);

/**
 * Espera o agente dizer o que aconteceu com o job. Devolve o job no último
 * estado lido: `printed`, `failed`, ou — passado o prazo — ainda `ready` /
 * `printing`, que quem chama trata como "o agente não confirmou".
 */
export async function acompanharNoAgente(
  jobId: string,
  opcoes: { intervaloMs?: number; prazoMs?: number } = {},
): Promise<PrintJob> {
  const intervalo = opcoes.intervaloMs ?? 700;
  const fim = Date.now() + (opcoes.prazoMs ?? 20_000);
  let job = await impressaoApi.job(jobId);
  while (!FINAIS.has(job.status) && Date.now() < fim) {
    await new Promise((r) => setTimeout(r, intervalo));
    job = await impressaoApi.job(jobId);
  }
  return job;
}
