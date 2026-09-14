/**
 * Devolução ao fornecedor (GAP-PRD-089) — o cliente das cinco rotas novas.
 *
 * Desfazer PARTE de uma compra que continua valendo: estoque sai com tipo
 * próprio, o financeiro abate a dívida da nota ou vira crédito a receber do
 * fornecedor, e a NF-e de devolução fica como pendência até alguém registrar a
 * chave. Módulo próprio pela regra da casa: `core.ts` intocado.
 */
import { apiRequest, envelope, exigirCampos } from './client';

export type ModoFinanceiro = 'abatimento' | 'credito' | 'sem_financeiro';
export type SituacaoFiscal = 'pendente' | 'emitida' | 'nota_do_fornecedor' | 'dispensada';

export interface UnidadeDevolvivel {
  id: string;
  identificacao: string;
}

export interface ItemDevolvivel {
  productId: string;
  name: string;
  internalCode: string | null;
  unit: string | null;
  entrou: number;
  jaDevolvido: number;
  disponivel: number;
  podeDevolver: number;
  unitCostCents: number;
  serializado: boolean;
  unidades: UnidadeDevolvivel[];
}

export interface Devolviveis {
  nota: {
    id: string;
    rotulo: string;
    accessKey: string;
    status: string;
    supplierId: string | null;
    supplierName: string | null;
    totalCents: number;
  };
  itens: ItemDevolvivel[];
  saldoEmAbertoCents: number;
  temTitulo: boolean;
  jaCreditadoCents: number;
}

export interface DevolucaoResumo {
  id: string;
  number: number;
  noteId: string;
  noteLabel: string;
  noteAccessKey: string;
  supplierName: string | null;
  reason: string;
  goodsCents: number;
  creditCents: number;
  financeMode: ModoFinanceiro;
  fiscalStatus: SituacaoFiscal;
  fiscalAccessKey: string | null;
  createdAt: string;
  createdByName: string | null;
}

export interface DevolucaoDetalhe extends DevolucaoResumo {
  items: {
    productId: string;
    name: string;
    internalCode: string | null;
    quantity: number;
    unitCostCents: number;
    totalCents: number;
  }[];
  financeEntryId: string | null;
  financeDetail: {
    entryId: string;
    abatidoCents: number;
    antesCents: number;
    depoisCents: number;
    cancelado: boolean;
  }[];
  fiscalNote: string | null;
  pendenciaFiscal: string | null;
}

export interface NovaDevolucao {
  noteId: string;
  reason: string;
  financeMode: ModoFinanceiro;
  items: { productId: string; quantity: number; unitIds?: string[] }[];
  creditCents?: number;
  dueDate?: string;
}

export const devolucoesFornecedorApi = {
  devolviveis: (noteId: string) =>
    apiRequest<Devolviveis>(`/core/purchases/notes/${encodeURIComponent(noteId)}/devolviveis`).then(
      (r) => exigirCampos(r, 'nota', 'itens'),
    ),

  listar: (filtros: { noteId?: string; fiscalStatus?: SituacaoFiscal } = {}) => {
    const q = new URLSearchParams();
    if (filtros.noteId) q.set('noteId', filtros.noteId);
    if (filtros.fiscalStatus) q.set('fiscalStatus', filtros.fiscalStatus);
    const sufixo = q.toString() ? `?${q}` : '';
    return apiRequest<{ items: DevolucaoResumo[] }>(`/core/purchases/supplier-returns${sufixo}`).then(
      envelope('items'),
    );
  },

  abrir: (id: string) =>
    apiRequest<DevolucaoDetalhe>(`/core/purchases/supplier-returns/${encodeURIComponent(id)}`).then(
      (r) => exigirCampos(r, 'id', 'items'),
    ),

  registrar: (input: NovaDevolucao) =>
    apiRequest<DevolucaoDetalhe>('/core/purchases/supplier-returns', { method: 'POST', body: input }),

  registrarFiscal: (
    id: string,
    input: { status: Exclude<SituacaoFiscal, 'pendente'>; accessKey?: string; note?: string },
  ) =>
    apiRequest<DevolucaoDetalhe>(`/core/purchases/supplier-returns/${encodeURIComponent(id)}/fiscal`, {
      method: 'POST',
      body: input,
    }),
};
