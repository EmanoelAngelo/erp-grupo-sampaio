/**
 * A fila de transmissão fiscal na tela (GAP-PRD-020).
 *
 * O servidor transmite sozinho — um trabalhador de fundo drena a fila de cada
 * operação e reprocessa quando a SEFAZ volta. A tela mostra o que espera e
 * por quê, e dá ao gestor os dois gestos que faltavam: transmitir agora UMA
 * nota (inclusive a que entrou em contingência) ou a fila inteira.
 */
import { apiRequest, exigirCampos } from './client';
import type { FiscalDocumentRow, FiscalPendency } from './core';

export interface EstadoDoTrabalhadorFiscal {
  ligado: boolean;
  tickMs: number | null;
  ultimaPassada: string | null;
  ultimoErro: string | null;
}

export interface SondagemDaSefaz {
  em: string;
  online: boolean;
  cStat: string | null;
  xMotivo: string | null;
  fonte: 'sefaz' | 'test' | 'falha';
}

export interface ItemDaFilaFiscal {
  documentId: string;
  model: string;
  serie: number;
  number: number;
  documentStatus: string;
  /** pending | retry | sending | dead */
  queueStatus: string;
  attempts: number;
  nextAttemptAt: string | null;
  lastAttemptAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
}

export interface PainelDaFilaFiscal {
  trabalhador: EstadoDoTrabalhadorFiscal;
  sefaz: SondagemDaSefaz | null;
  contagem: { aguardando: number; novaTentativa: number; desistiu: number; enviando: number };
  itens: ItemDaFilaFiscal[];
  pendencias: FiscalPendency[];
}

export interface ResultadoDaTransmissaoFiscal {
  document: FiscalDocumentRow;
  statusLabel: string;
  outcome: string | null;
}

/**
 * O painel é lido campo a campo no render (`painel.contagem.aguardando`). Um
 * 200 sem esses campos — o pacote antigo da tela contra a API nova — vira o
 * mesmo `ApiRequestError` que o `catch` do quadro já mostra, em vez de apagar
 * a tela de Documentos inteira (`toda-tela-monta`). `sefaz` é anulável e fica
 * de fora.
 */
function painelConferido(p: PainelDaFilaFiscal): PainelDaFilaFiscal {
  return exigirCampos(p, 'trabalhador', 'contagem', 'itens', 'pendencias');
}

export const filaFiscalApi = {
  painel: () => apiRequest<PainelDaFilaFiscal>('/core/fiscal/queue').then(painelConferido),

  /** A fila inteira da operação, agora — o mesmo que o trabalhador faz a cada minuto. */
  transmitirPendentes: () =>
    apiRequest<{ resultado: { transmitidos: number; esperando: number; paradaPor: string | null }; painel: PainelDaFilaFiscal }>(
      '/core/fiscal/queue/drain',
      { method: 'POST' },
    ).then((r) => {
      exigirCampos(r, 'resultado', 'painel');
      painelConferido(r.painel);
      return r;
    }),

  /** Uma nota, agora — a da fila ou a que entrou em contingência. */
  transmitirAgora: (documentId: string) =>
    apiRequest<ResultadoDaTransmissaoFiscal>(
      `/core/fiscal/documents/${encodeURIComponent(documentId)}/transmitir`,
      { method: 'POST' },
    ),
};
