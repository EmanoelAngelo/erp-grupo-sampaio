/**
 * O pós-venda no portal do cliente (GAP-PRD-125): a nota da compra, o
 * rastreio e o pedido de devolução.
 *
 * Os tipos são os que `GET /loja/portal/pedidos/:id` devolve, e o pedido de
 * devolução vai com o token do portal — nunca com o Authorization do ERP.
 */
import { comTokenPortal } from '../portalSession';
import { ApiRequestError, apiOrigin } from './client';

export interface NotaDoPedidoNoPortal {
  numero: number;
  serie: number;
  chave: string | null;
  status: 'AUTHORIZED' | 'CANCELLED';
  statusLabel: string;
  autorizadaEm: string | null;
  /** O DANFE existe para nota autorizada e para cancelada (com a tarja). */
  danfe: boolean;
  /** O XML entregue é o autorizado: nota + protocolo. */
  xml: boolean;
}

export type TipoDaDevolucao = 'arrependimento' | 'defeito';

export interface SolicitacaoDeDevolucao {
  id: string;
  orderId: string;
  kind: TipoDaDevolucao;
  kindLabel: string;
  reason: string;
  status: 'aberta' | 'aprovada' | 'recusada' | 'concluida';
  statusLabel: string;
  decisionNote: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface DevolucaoNoPortal {
  podeSolicitar: boolean;
  motivoIndisponivel: string | null;
  /** Último dia do arrependimento (AAAA-MM-DD, dia da loja); nulo antes da entrega. */
  prazoArrependimentoAte: string | null;
  arrependimentoNoPrazo: boolean;
  solicitacoes: SolicitacaoDeDevolucao[];
}

/** AAAA-MM-DD em DD/MM/AAAA, sem passar por fuso nenhum. */
export function diaDoPrazo(dia: string): string {
  const [a, m, d] = dia.slice(0, 10).split('-');
  return `${d}/${m}/${a}`;
}

/**
 * O DANFE ou o XML da compra, em bytes, com o token do PORTAL.
 *
 * `apiDocument`/`apiBinary` mandam o `Authorization` do ERP — a cliente não
 * tem esse token, tem o `x-portal-token`. E `<a href>` não manda cabeçalho
 * nenhum: por isso a busca é aqui, e a tela abre o que já baixou.
 */
export async function documentoDoPedidoNoPortal(
  orderId: string,
  tipo: 'danfe' | 'xml',
  token: string,
): Promise<{ blob: Blob; nomeArquivo: string }> {
  const res = await fetch(`${apiOrigin()}/api/v1/loja/portal/pedidos/${orderId}/nfe/${tipo}`, {
    headers: { 'x-portal-token': token },
  });
  if (!res.ok) {
    let code = 'API_ERROR';
    let message = 'Não foi possível abrir a nota agora.';
    try {
      const payload = JSON.parse(await res.text()) as { error?: { code?: string; message?: string } };
      code = payload.error?.code ?? code;
      message = payload.error?.message ?? message;
    } catch {
      // Resposta não-JSON: fica a mensagem genérica.
    }
    throw new ApiRequestError(code, message, res.status);
  }
  const doCabecalho = /filename="?([^";]+)"?/i.exec(res.headers.get('content-disposition') ?? '')?.[1];
  const nomeArquivo =
    (doCabecalho ?? '').replace(/[\\/]+/g, '-').replace(/\.{2,}/g, '.')
    || (tipo === 'xml' ? `NFe-pedido-${orderId}.xml` : `DANFE-pedido-${orderId}.html`);
  return { blob: await res.blob(), nomeArquivo };
}

export const posVendaApi = {
  solicitarDevolucao: (orderId: string, token: string, body: { tipo: TipoDaDevolucao; motivo: string }) =>
    comTokenPortal<{ solicitacao: SolicitacaoDeDevolucao; devolucao: DevolucaoNoPortal }>(
      `/loja/portal/pedidos/${orderId}/devolucao`,
      token,
      { method: 'POST', body },
    ),
};
