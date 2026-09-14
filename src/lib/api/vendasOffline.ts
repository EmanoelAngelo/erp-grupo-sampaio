/**
 * As vendas guardadas sem servidor que o servidor RECUSOU (GAP-PRD-045/046).
 *
 * A fila do navegador (`offlineQueue.ts`) guarda a venda quando o servidor da
 * loja não responde. Recusada de vez no reenvio — o caixa daquele turno já
 * fechou, o estoque acabou —, ela é ENTREGUE ao servidor (`entregar`) com o
 * corpo original e a MESMA chave, e sai do navegador: daí em diante o gestor
 * e os outros caixas a veem, e ela não morre com a máquina do caixa.
 *
 * Também mora aqui a SONDA do servidor: a barra de conexão precisa saber a
 * diferença entre "este computador está sem rede" e "o servidor da loja não
 * responde", e `navigator.onLine` só sabe a primeira.
 */
import { apiOrigin, apiRequest } from './client';
import type { Sale } from './core';

export type SituacaoDaVendaOffline = 'pendente' | 'regularizada' | 'descartada';

export interface VendaOfflineRecusada {
  id: string;
  idempotencyKey: string;
  label: string | null;
  queuedAt: string | null;
  reportedAt: string;
  lastReportedAt: string;
  reportedBy: string | null;
  reportedByName: string | null;
  terminalId: string | null;
  terminalName: string | null;
  cashSessionId: string | null;
  receivedCents: number;
  itemsCount: number;
  items: { productId: string; name: string | null; quantity: number; unitPriceCents: number | null }[];
  payments: { method: string; amountCents: number }[];
  status: SituacaoDaVendaOffline;
  errorCode: string | null;
  errorMessage: string | null;
  attempts: number;
  saleId: string | null;
  saleNumber: number | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
  /**
   * A venda que a CHAVE desta pendência já registrou com OUTROS itens
   * (RES-IDEM-TELA). Relançar com a mesma chave nunca passa; a saída é
   * `relancarComoVendaNova`. Opcional: servidor anterior não manda.
   */
  vendaDaChave?: VendaDaChave | null;
  /**
   * A gaveta em que o relançamento entra sem ninguém escolher
   * (G-offline-sync-10): a gaveta em que a venda foi feita, se ainda estiver
   * aberta, ou a aberta do MESMO caixa. É onde o dinheiro está. Nula quando
   * nenhuma das duas existe — aí a venda precisa da gaveta aberta de quem
   * relança, e outro caixa pede confirmação. Opcional: servidor anterior não
   * manda.
   */
  gavetaDeDestino?: GavetaDeDestino | null;
}

export interface GavetaDeDestino {
  cashSessionId: string;
  terminalId: string | null;
  terminalName: string | null;
  /** `a_da_venda`: a gaveta da venda, ainda aberta. `mesmo_caixa`: ela fechou e o mesmo caixa abriu outra. */
  motivo: 'a_da_venda' | 'mesmo_caixa';
}

/** Para onde e com que liberação a pendência é relançada. */
export interface PedidoDeRelancamento {
  cashSessionId: string | null;
  terminalId: string | null;
  /**
   * Quem relança confirmou pôr a venda numa gaveta de OUTRO caixa, sabendo que
   * o dinheiro não está nela (G-offline-sync-10). Sem isto, o servidor recusa
   * com 409 `CORE_OFFLINE_SALE_OTHER_DRAWER`.
   */
  confirmarOutraGaveta?: boolean;
  /**
   * A liberação do gestor para a concessão acima da alçada (G-offline-sync-11).
   * A venda feita sem servidor não tinha como pedir: sem este campo, a pendência
   * recusada por alçada só saía com um gestor logado no próprio caixa.
   */
  authorizationId?: string;
  /**
   * O preço baixou depois da venda e o servidor recusou com 409
   * `CORE_SALE_TOTAL_CHANGED` (G-offline-sync-08): como relançar.
   * `preco_de_agora` diminui o pagamento eletrônico da diferença (a devolver ao
   * cliente); `manter_o_cobrado` lança a diferença como acréscimo — da gerência.
   */
  ajusteDePreco?: ModoDoAjusteDePreco;
}

export type ModoDoAjusteDePreco = 'preco_de_agora' | 'manter_o_cobrado';

/** O ajuste de preço que o servidor aplicou no relançamento, e a decisão numa frase. */
export interface AjusteDePreco {
  modo: ModoDoAjusteDePreco;
  diferencaCents: number;
  linhas: { productId: string; name: string | null; quantity: number; informadoCents: number; vigenteCents: number }[];
  estornoCents: number;
  devolverEmDinheiroCents: number;
  acrescimoCents: number;
  frase: string;
}

/** A resposta do relançamento (comum ou como venda nova). */
export interface RespostaDoRelancamento {
  sale: Sale;
  duplicated: boolean;
  pendencia: VendaOfflineRecusada;
  /** Presente quando o relançamento precisou do ajuste de preço. Servidor anterior não manda. */
  ajusteDePreco?: AjusteDePreco | null;
}

export interface VendaDaChave {
  id: string;
  number: number;
  totalCents: number;
  status: string;
  items: { description: string; quantity: number }[];
}

export type RespostaDaEntrega =
  | { jaSubiu: true; saleId: string; saleNumber: number | null }
  | { jaSubiu: false; pendencia: VendaOfflineRecusada };

export const vendasOfflineApi = {
  /** Entrega ao servidor a venda da fila que ele recusou de vez. */
  entregar: (input: {
    idempotencyKey: string;
    label: string;
    body: unknown;
    queuedAt: string;
    errorCode: string | null;
    errorMessage: string | null;
  }) => apiRequest<RespostaDaEntrega>('/core/offline-sales', { method: 'POST', body: input }),

  listar: (status: SituacaoDaVendaOffline | 'todas' = 'pendente') =>
    apiRequest<{ items: VendaOfflineRecusada[] }>(`/core/offline-sales?status=${status}`).then(
      (r) => r.items ?? [],
    ),

  /**
   * Relança com a MESMA chave, na gaveta em que o dinheiro está: a da venda
   * (ou a aberta do mesmo caixa) quando existe — o servidor escolhe —, e senão
   * a gaveta aberta deste computador.
   */
  relancar: (id: string, input: PedidoDeRelancamento) =>
    apiRequest<RespostaDoRelancamento>(
      `/core/offline-sales/${encodeURIComponent(id)}/relaunch`,
      { method: 'POST', body: input },
    ),

  /**
   * A chave desta venda já registrou OUTRA venda (RES-IDEM-TELA): a venda da
   * pendência vira venda nova, com chave própria, na gaveta aberta. A venda que
   * a chave registrou continua como está.
   */
  relancarComoVendaNova: (id: string, input: PedidoDeRelancamento) =>
    apiRequest<RespostaDoRelancamento>(
      `/core/offline-sales/${encodeURIComponent(id)}/relaunch-as-new`,
      { method: 'POST', body: input },
    ),

  /** Gerência: a venda não vai existir. Motivo obrigatório. */
  descartar: (id: string, reason: string) =>
    apiRequest<VendaOfflineRecusada>(`/core/offline-sales/${encodeURIComponent(id)}/discard`, {
      method: 'POST',
      body: { reason },
    }),
};

export type EstadoDoServidor = 'ok' | 'sem_rede' | 'servidor_fora';

/**
 * O servidor da loja responde AGORA?
 *
 * `navigator.onLine` diz se o computador tem rede, e só isso: com a rede da
 * loja de pé e o servidor desligado ele continua `true` e o evento `online`
 * nunca dispara. Aqui a pergunta vai ao próprio servidor (`/health`, pública,
 * sem sessão), com prazo curto — um servidor que não responde em 4 s, para o
 * balcão, está fora.
 */
export async function sondarServidor(prazoMs = 4000): Promise<EstadoDoServidor> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'sem_rede';
  const controle = new AbortController();
  const relogio = setTimeout(() => controle.abort(), prazoMs);
  try {
    const res = await fetch(`${apiOrigin()}/api/v1/health`, { signal: controle.signal, cache: 'no-store' });
    return res.ok ? 'ok' : 'servidor_fora';
  } catch {
    return typeof navigator !== 'undefined' && navigator.onLine === false ? 'sem_rede' : 'servidor_fora';
  } finally {
    clearTimeout(relogio);
  }
}
