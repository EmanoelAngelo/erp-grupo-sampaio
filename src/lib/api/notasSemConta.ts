/**
 * A nota recebida sem conta a pagar — o cliente das duas rotas do GAP-PRD-088.
 *
 * A lista das notas que entraram antes de o financeiro nascer junto (a NF 9991)
 * e a decisão do dono sobre cada uma: lançar a conta, lançar já paga, ou
 * declarar que a nota não gera conta. Módulo próprio: `core.ts` intocado.
 */
import { apiRequest, envelope } from './client';

export interface NotaSemConta {
  id: string;
  number: string | null;
  docType: string;
  accessKey: string;
  supplierId: string | null;
  supplierName: string | null;
  totalCents: number;
  receivedAt: string | null;
  vencimentoSugerido: string;
}

export type DecisaoDaNota =
  | { acao: 'lancar'; dueDate?: string }
  | { acao: 'ja_paga'; paidOn: string; method?: string }
  | { acao: 'sem_divida'; reason: string };

export const notasSemContaApi = {
  listar: () =>
    apiRequest<{ items: NotaSemConta[] }>('/core/purchases/notas-sem-conta').then(envelope('items')),

  decidir: (noteId: string, decisao: DecisaoDaNota) =>
    apiRequest<{ noteId: string; acao: string; entryId: string | null }>(
      `/core/purchases/notes/${encodeURIComponent(noteId)}/conta-a-pagar`,
      { method: 'POST', body: decisao },
    ),
};
