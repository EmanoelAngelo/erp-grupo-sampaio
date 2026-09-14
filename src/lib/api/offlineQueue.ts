/**
 * Fila de escrita para quando o servidor não responde.
 *
 * O SISTEMA ANTERIOR ERA OFFLINE-FIRST e isso se perdeu na migração: hoje a
 * tela fala com a API a cada ação e, se o servidor cair, o balcão para. Numa
 * loja, parar de vender é o pior desfecho possível — pior até que vender e
 * acertar depois.
 *
 * O QUE ESTA FILA COBRE, E SÓ ISSO: a venda do PDV.
 *
 * Não é "o ERP funciona offline". É que a venda não se perde. Consultar
 * produto, abrir caixa, conciliar, emitir nota — nada disso entra aqui, e
 * prometer que entra seria pior que não ter fila: o operador confiaria numa
 * garantia que não existe.
 *
 * POR QUE REENVIAR É SEGURO
 *
 * Só entra na fila requisição com CHAVE DE IDEMPOTÊNCIA. `createSale` já
 * recusa venda sem chave e devolve a venda original quando a mesma chave chega
 * de novo — é isso que permite reenviar sem medo de duplicar. Sem essa
 * garantia do servidor, uma fila de reenvio seria uma máquina de vender duas
 * vezes.
 *
 * A fila mora no `localStorage` e não em memória: o caso que importa é o
 * navegador ser fechado (ou o Windows reiniciar) antes de a rede voltar.
 */

const CHAVE = 'gs.fila.escrita';

export interface QueuedRequest {
  id: string;
  path: string;
  method: string;
  body: unknown;
  /** Sem ela a requisição NÃO entra na fila. */
  idempotencyKey: string;
  /** Rótulo curto para a tela dizer o que está pendente. */
  label: string;
  queuedAt: string;
  attempts: number;
  lastError?: string;
  /** Código da última recusa do servidor (ex.: `CORE_CASH_SESSION_CLOSED`). */
  lastErrorCode?: string;
  /**
   * De que tipo foi a última falha (GAP-PRD-044/045): `rede` passa com nova
   * tentativa; `recusa` NUNCA passa — é o servidor dizendo não —; `sessao` é o
   * login que venceu, e passa depois de entrar de novo.
   */
  lastErrorKind?: TipoDeFalha;
  lastAttemptAt?: string;
  /**
   * A operação (e a pessoa) da sessão em que a venda foi guardada
   * (RES-SESSAO). O reenvio sai com a sessão de AGORA: sem isto, a venda
   * guardada na loja subia na oficina se alguém trocasse de operação antes de
   * a fila esvaziar — e, desde que a troca encerra o token de antes, também a
   * venda que estava no ar na hora da troca. Quem envia só manda a venda da
   * operação de agora (`flushQueue`, parâmetro `pertence`).
   *
   * Ausente = guardada antes de este campo existir: sobe na sessão de agora,
   * como antes — a não ser que um envio a pegue no meio de uma troca, e aí
   * ela é vinculada à operação de onde saiu (`vincularAoEscopo`).
   */
  escopo?: EscopoDaVendaGuardada;
}

/** Quem, e em que operação, a sessão era quando a venda entrou na fila. */
export interface EscopoDaVendaGuardada {
  userId: string | null;
  companyId: string | null;
}

export type TipoDeFalha = 'rede' | 'recusa' | 'sessao';

/**
 * A falha do reenvio passa com nova tentativa?
 *
 * Rede caída, prazo esgotado, servidor sobrecarregado (408/429/5xx) passam.
 * 401 é a sessão: passa depois de entrar de novo. O resto dos 4xx é o
 * servidor RECUSANDO a venda (caixa fechado, estoque insuficiente) — insistir
 * não muda a resposta, e é esse caso que vai para a regularização.
 *
 * Por forma, e não por `instanceof ApiRequestError`: o cliente HTTP importa
 * esta fila, e a fila importar o cliente seria um ciclo.
 */
export function classificarFalha(err: unknown): TipoDeFalha {
  if (isNetworkFailure(err)) return 'rede';
  /*
    A SESSÃO MUDOU DE OPERAÇÃO (ou de pessoa) enquanto o reenvio estava no ar
    (RES-SESSAO). O servidor encerra o token de antes na troca, e o cliente,
    em vez de repetir a venda na operação nova, lança
    `API_SESSION_SCOPE_CHANGED` com 409. O servidor NÃO recusou a venda:
    tratá-la como recusa a entregaria a "Regularizar" da operação de AGORA,
    com um motivo que ninguém deu, e a tiraria desta fila. É caso de sessão —
    a venda fica e espera a sessão certa.
  */
  if ((err as { code?: unknown })?.code === 'API_SESSION_SCOPE_CHANGED') return 'sessao';
  const status = Number((err as { status?: unknown })?.status);
  if (!Number.isFinite(status) || status === 0) return 'rede';
  if (status === 401) return 'sessao';
  if (status === 408 || status === 429 || status >= 500) return 'rede';
  return status >= 400 ? 'recusa' : 'rede';
}

type Listener = (fila: QueuedRequest[]) => void;
const listeners = new Set<Listener>();

function ler(): QueuedRequest[] {
  try {
    const bruto = localStorage.getItem(CHAVE);
    return bruto ? (JSON.parse(bruto) as QueuedRequest[]) : [];
  } catch {
    // Fila corrompida não pode travar o balcão: começa vazia e segue.
    return [];
  }
}

/**
 * Grava a fila e diz se GRAVOU (G-offline-sync-M02).
 *
 * O DEFEITO: a falha do `setItem` (cota cheia, navegador em modo privado ou
 * quiosque com o armazenamento bloqueado) era engolida, e os ouvintes recebiam
 * a lista EM MEMÓRIA — com a venda nova. `enqueue` devolvia o registro como se
 * estivesse guardado, o PDV dizia "Venda guardada na fila — NÃO refaça esta
 * venda", limpava o carrinho e imprimia o comprovante. Nada tinha sido
 * gravado: a venda nunca subia, o estoque não baixava, e a gaveta fechava com
 * a sobra sem explicação. A barra ainda mostrava "1 operação aguardando envio"
 * até a tela recarregar — e aí sumia.
 *
 * Agora a tela só ouve o que está GRAVADO (relido do armazenamento), e quem
 * grava sabe se gravou.
 */
function gravar(fila: QueuedRequest[]): boolean {
  let gravou = true;
  try {
    localStorage.setItem(CHAVE, JSON.stringify(fila));
  } catch {
    // A falha de gravação não derruba a tela; quem precisa saber (`enqueue`)
    // confere pelo retorno.
    gravou = false;
  }
  avisarOuvintes();
  return gravou;
}

function avisarOuvintes(): void {
  const gravada = ler();
  for (const l of listeners) l(gravada);
}

/*
  A FILA DAS OUTRAS ABAS (G-offline-sync-13).

  Os ouvintes só eram avisados pelo `gravar` desta aba. Com o PDV aberto em
  duas abas, a aba A enviava a venda e a aba B seguia dizendo "1 operação
  aguardando envio" para sempre; o diálogo do caixa já aberto na aba B não via
  a venda que a aba A guardou e deixava fechar a gaveta com ela na fila. O
  evento `storage` é o que o navegador dispara nas OUTRAS abas quando uma delas
  grava — `key` nulo é o `localStorage.clear()` de outra aba.
*/
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (e: StorageEvent) => {
    if (e.key === CHAVE || e.key === null) avisarOuvintes();
  });
}

export function queued(): QueuedRequest[] {
  return ler();
}

export function subscribeQueue(listener: Listener): () => void {
  listeners.add(listener);
  listener(ler());
  return () => listeners.delete(listener);
}

/**
 * A fila não conseguiu guardar a venda (G-offline-sync-M02): o armazenamento do
 * navegador recusou a gravação. Quem chama NÃO pode dizer "guardada".
 */
export class FilaIndisponivelError extends Error {
  readonly code = 'QUEUE_UNAVAILABLE';
  constructor() {
    super('O navegador recusou guardar a venda na fila (armazenamento cheio ou bloqueado).');
    this.name = 'FilaIndisponivelError';
  }
}

export function enqueue(
  item: Omit<QueuedRequest, 'id' | 'queuedAt' | 'attempts'> & {
    /** Quando a venda foi feita — a venda recuperada de um envio interrompido guarda a hora dela. */
    queuedAt?: string;
  },
): QueuedRequest {
  if (!item.idempotencyKey) {
    // Guarda dura, e não um aviso: sem chave, reenviar é duplicar.
    throw new Error('Requisição sem chave de idempotência não pode entrar na fila.');
  }
  const registro: QueuedRequest = {
    ...item,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    queuedAt: item.queuedAt ?? new Date().toISOString(),
    attempts: 0,
  };
  gravar([...ler(), registro]);
  // A prova de que guardou é RELER: o `setItem` pode ter falhado, ou gravado
  // e sido apagado no mesmo instante. Sem o registro relido, a venda não está
  // guardada em lugar nenhum, e dizer o contrário é o sumiço calado.
  if (!ler().some((r) => r.id === registro.id)) throw new FilaIndisponivelError();
  return registro;
}

/**
 * O código curto de uma venda guardada — o que o comprovante offline, a barra
 * e "Regularizar" mostram para casar o papel do cliente com a venda
 * (G-offline-sync-15/17). A hora sozinha ("Venda offline 15:20") repetia em
 * duas vendas do mesmo minuto. São os 8 últimos caracteres alfanuméricos da
 * chave, em maiúsculas: a chave é única por venda, e o fim dela é o trecho
 * aleatório (a da tela começa por `pdv-`).
 */
export function codigoDaVendaGuardada(chave: string): string {
  return String(chave ?? '').replace(/[^a-z0-9]/gi, '').slice(-8).toUpperCase();
}

// ------------------------------------------------ a venda que estava no ar

/**
 * Quanto a venda espera o servidor antes de ir para a fila (G-offline-sync-06).
 *
 * O `fetch` da venda não tinha prazo: servidor travado (relatório pesado ou
 * backup segurando o `node:sqlite`, que é síncrono) deixava "Finalizando…"
 * girando para sempre. Passado o prazo, a venda entra na fila com a MESMA
 * chave — se o servidor tiver gravado, o reenvio devolve a venda original.
 */
export const PRAZO_DA_VENDA_MS = 20_000;
/** Folga depois do prazo antes de considerar órfã a venda que estava no ar. */
const FOLGA_DO_ENVIO_MS = 10_000;
const CHAVE_EM_ENVIO = 'gs.fila.emEnvio';

interface VendaNoAr {
  path: string;
  method: string;
  body: unknown;
  idempotencyKey: string;
  label: string;
  escopo?: EscopoDaVendaGuardada;
  /** Quando saiu (ms): é a hora da venda se ela precisar ser recuperada. */
  desde: number;
  /** A aba que pôs a venda no ar (`sessionStorage`, sobrevive ao F5 da própria aba). */
  aba?: string | null;
  /** A carga da página que pôs a venda no ar (muda a cada F5). */
  pagina?: string;
}

/*
  QUEM PÔS A VENDA NO AR — para a tela recarregada recuperá-la NA HORA
  (revisão do G-offline-sync-06).

  A venda no ar só voltava para a fila passados o prazo e a folga (30 s desde
  a saída), e a procura roda na montagem e a cada 15 s. O F5 no meio de
  "Finalizando…" acontece dentro do prazo, então a tela recarregada ficava até
  ~45 s sem dizer nada — exatamente o tempo em que o operador, vendo o carrinho
  vazio, bipava tudo de novo com chave nova, e nascia a #N+1 que o achado
  descreve. A espera existe para não roubar a venda de uma aba VIVA; mas a
  página anterior DESTA aba morreu com o F5, e a venda dela é órfã com certeza.

  `sessionStorage` é por aba e atravessa o recarregamento; `PAGINA` muda a cada
  carga. Mesma aba e outra página = a página que enviou não existe mais. A aba
  duplicada pelo navegador copia o `sessionStorage` — é o único caso em que a
  regra erra, e erra para o lado da chave: o reenvio devolve a venda gravada.
*/
const PAGINA = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const CHAVE_DA_ABA = 'gs.fila.aba';

function abaDestaTela(): string | null {
  try {
    let id = sessionStorage.getItem(CHAVE_DA_ABA);
    if (!id) {
      id = `aba-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      sessionStorage.setItem(CHAVE_DA_ABA, id);
    }
    return id;
  } catch {
    // Sem `sessionStorage`, vale só o prazo com folga — como antes.
    return null;
  }
}

function lerEmEnvio(): VendaNoAr[] {
  try {
    const bruto = localStorage.getItem(CHAVE_EM_ENVIO);
    const lista = bruto ? (JSON.parse(bruto) as unknown) : [];
    return Array.isArray(lista) ? (lista as VendaNoAr[]) : [];
  } catch {
    return [];
  }
}

function gravarEmEnvio(lista: VendaNoAr[]): void {
  try {
    if (lista.length === 0) localStorage.removeItem(CHAVE_EM_ENVIO);
    else localStorage.setItem(CHAVE_EM_ENVIO, JSON.stringify(lista));
  } catch {
    // Sem armazenamento, a venda no ar só não sobrevive ao F5 — como antes.
  }
}

/**
 * A venda SAIU para o servidor e ainda não teve resposta (G-offline-sync-06).
 *
 * O DEFEITO: a chave da venda vivia só no estado da tela. F5 ou aba fechada
 * durante "Finalizando…" perdia carrinho e chave; o servidor processava o POST
 * que já tinha recebido e gravava a #N; o operador bipava tudo de novo, com
 * chave nova, e nascia a #N+1 — estoque e dinheiro em dobro. Agora a venda no
 * ar fica escrita no navegador até a resposta chegar, e a que ficou órfã volta
 * para a fila com a MESMA chave (`recuperarEnviosInterrompidos`): se o servidor
 * gravou, o reenvio devolve a venda que ele gravou; se não, ela nasce agora.
 */
export function marcarEmEnvio(item: Omit<VendaNoAr, 'desde' | 'aba' | 'pagina'>): void {
  if (!item.idempotencyKey) return;
  gravarEmEnvio([
    ...lerEmEnvio().filter((v) => v.idempotencyKey !== item.idempotencyKey),
    { ...item, desde: Date.now(), aba: abaDestaTela(), pagina: PAGINA },
  ]);
}

/** A resposta chegou (ou a venda já foi para a fila): não está mais no ar. */
export function desmarcarEmEnvio(idempotencyKey: string): void {
  const lista = lerEmEnvio();
  if (!lista.some((v) => v.idempotencyKey === idempotencyKey)) return;
  gravarEmEnvio(lista.filter((v) => v.idempotencyKey !== idempotencyKey));
}

/**
 * Leva para a fila a venda que ficou no ar sem resposta — a tela recarregou ou
 * a aba fechou no meio do envio. A da página anterior DESTA aba vai na hora (o
 * F5 matou quem a enviou); a de outra aba, só passado o prazo com folga: antes
 * disso ela pode ser de uma aba viva, que ainda vai receber a resposta (ou
 * guardá-la na fila ela mesma quando o prazo estourar). Devolve quantas levou.
 */
export function recuperarEnviosInterrompidos(agora: number = Date.now()): number {
  const lista = lerEmEnvio();
  if (lista.length === 0) return 0;
  const aba = abaDestaTela();
  const orfas = lista.filter(
    (v) =>
      (aba !== null && v.aba === aba && v.pagina !== PAGINA)
      || agora - Number(v.desde ?? 0) >= PRAZO_DA_VENDA_MS + FOLGA_DO_ENVIO_MS,
  );
  if (orfas.length === 0) return 0;
  let levadas = 0;
  for (const v of orfas) {
    // A mesma chave já na fila (a aba guardou e não conseguiu desmarcar) não
    // entra duas vezes.
    if (!ler().some((r) => r.idempotencyKey === v.idempotencyKey)) {
      try {
        enqueue({
          path: v.path,
          method: v.method,
          body: v.body,
          idempotencyKey: v.idempotencyKey,
          label: v.label,
          escopo: v.escopo,
          queuedAt: new Date(Number(v.desde)).toISOString(),
        });
        levadas += 1;
      } catch {
        // Sem como guardar, ela fica no ar: a próxima volta tenta de novo.
        continue;
      }
    }
    desmarcarEmEnvio(v.idempotencyKey);
  }
  return levadas;
}

export function removeFromQueue(id: string): void {
  gravar(ler().filter((r) => r.id !== id));
}

/**
 * Vincula a venda guardada à operação de onde o envio saiu — para a venda que
 * entrou na fila antes de o campo `escopo` existir e foi pega no meio de uma
 * troca de operação (RES-SESSAO). A que já tem escopo não muda.
 */
export function vincularAoEscopo(id: string, escopo: EscopoDaVendaGuardada): void {
  gravar(ler().map((r) => (r.id === id && !r.escopo ? { ...r, escopo } : r)));
}

/**
 * Reenvia o que está pendente, em ORDEM.
 *
 * Em ordem porque a sequência importa: duas vendas do mesmo produto no fim do
 * estoque têm desfechos diferentes conforme quem chega primeiro. Uma falha
 * interrompe o lote — insistir nas seguintes deixaria buracos no meio da fila,
 * e o operador não teria como saber quais passaram.
 *
 * Só sobe o que `pertence` aceita (RES-SESSAO): a venda de outra operação fica
 * na fila, sem tentativa, e não segura as desta — a ordem que importa é a de
 * dentro da mesma operação.
 */
export async function flushQueue(
  /**
   * Envia um item. `'encaminhada'` quer dizer que o servidor RECUSOU a venda e
   * ela foi entregue a ele como pendência a regularizar (GAP-PRD-045): sai
   * desta fila do mesmo jeito, mas não conta como enviada.
   */
  enviar: (item: QueuedRequest) => Promise<void | 'enviada' | 'encaminhada'>,
  /** A venda pode subir na sessão de agora? Sem o parâmetro, todas podem. */
  pertence: (item: QueuedRequest) => boolean = () => true,
): Promise<{ sent: number; forwarded: number; failed: number }> {
  let sent = 0;
  let forwarded = 0;
  let failed = 0;

  for (const item of ler()) {
    if (!pertence(item)) continue;
    try {
      const desfecho = await enviar(item);
      removeFromQueue(item.id);
      if (desfecho === 'encaminhada') forwarded += 1;
      else sent += 1;
    } catch (err) {
      failed += 1;
      const codigo = (err as { code?: unknown })?.code;
      const fila = ler().map((r) =>
        r.id === item.id
          ? {
              ...r,
              attempts: r.attempts + 1,
              lastError: String((err as Error)?.message ?? err),
              lastErrorCode: typeof codigo === 'string' ? codigo : undefined,
              lastErrorKind: classificarFalha(err),
              lastAttemptAt: new Date().toISOString(),
            }
          : r,
      );
      gravar(fila);
      break;
    }
  }

  return { sent, forwarded, failed };
}

/**
 * A falha é de REDE, ou o servidor recusou?
 *
 * A diferença decide tudo: rede caída é caso de fila; recusa do servidor
 * (estoque insuficiente, permissão negada) é erro que o operador precisa ver
 * AGORA. Enfileirar uma recusa faria o sistema tentar para sempre uma venda que
 * nunca vai passar.
 */
/**
 * Espera até a próxima tentativa automática de reenvio (GAP-PRD-044): 5 s,
 * 10 s, 20 s e daí a cada 30 s. Curta no começo porque a queda mais comum é
 * breve; limitada a 30 s porque venda guardada é faturamento que o servidor
 * ainda não conhece.
 */
export function esperaDaTentativa(tentativasSemSucesso: number): number {
  return Math.min(30_000, 5_000 * 2 ** Math.max(0, tentativasSemSucesso));
}

/**
 * O código do erro em que o PROXY (ou túnel) respondeu no lugar da API
 * (G-offline-sync-R01): 502/503/504 com página HTML ou corpo vazio. Mora aqui,
 * e não no cliente HTTP, porque o cliente importa esta fila (o contrário seria
 * um ciclo) e `isNetworkFailure` precisa reconhecê-lo.
 */
export const CODIGO_PROXY_SEM_API = 'API_SERVER_UNREACHABLE';

export function isNetworkFailure(err: unknown): boolean {
  if (err instanceof TypeError) return true; // fetch não completou
  const nome = (err as { name?: string })?.name;
  if (nome === 'NetworkError' || nome === 'AbortError') return true;
  /*
    O PROXY QUE RESPONDE NO LUGAR DA API TAMBÉM É "NÃO CHEGOU" (G-offline-sync-R01).

    O DEFEITO: atrás de proxy reverso ou túnel, a API caída não faz o `fetch`
    lançar — o proxy responde 502/503/504 com HTML. Esta pergunta dizia "não é
    rede", e a busca do PDV mostrava "O servidor respondeu algo que não é
    JSON…" em vez de "Sem conexão com o servidor da loja — …", a frase que diz
    o que ainda dá para fazer. A requisição não chegou à API: é o mesmo caso da
    rede caída. O 502/503/504 que a PRÓPRIA API manda (envelope JSON, provedor
    externo fora) não recebe este código e continua sendo resposta do servidor.
  */
  return (err as { code?: unknown } | null)?.code === CODIGO_PROXY_SEM_API;
}
