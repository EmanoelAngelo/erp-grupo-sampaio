/**
 * Cliente HTTP do Grupo Sampaio ERP.
 *
 * Ponto único de acesso ao backend. Responsabilidades:
 *  - anexar o access token
 *  - renovar automaticamente com o refresh token quando expira (uma única
 *    renovação concorrente, para que 10 requisições em paralelo não gerem
 *    10 refreshes e invalidem a rotação)
 *  - normalizar erros da API em `ApiRequestError`
 *
 * Os tokens ficam em memória + localStorage — e a memória de cada aba segue o
 * que as outras gravam (evento `storage`, R2-SESSAO). O `companyId` NUNCA é
 * enviado pelo cliente: o servidor o deriva da sessão.
 */

import {
  ESCOPO_VAZIO,
  assertScopeChange,
  assertScopeMatchesToken,
  scopeFromToken,
  type ActiveScope,
  type ScopeChangeReason,
} from '../activeScope';
import {
  CODIGO_PROXY_SEM_API,
  FilaIndisponivelError,
  PRAZO_DA_VENDA_MS,
  desmarcarEmEnvio,
  enqueue,
  isNetworkFailure,
  marcarEmEnvio,
} from './offlineQueue';
import { uuid } from '../uuid';

const STORAGE_KEY = 'gs.session';

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export interface SessionUser {
  id: string;
  login: string;
  displayName: string;
  profileCode: string;
  /**
   * A senha desta conta é PROVISÓRIA — criada ou reiniciada pela gestão, que
   * portanto a conhece. O login devolve a bandeira e a tela de entrada segura
   * a pessoa na etapa de troca (`POST /auth/password`) antes de soltá-la no
   * app. Opcional porque sessões guardadas antes deste contrato não têm o
   * campo — e ausência significa "não precisa trocar".
   */
  mustChangePassword?: boolean;
}

export interface SessionCompany {
  id: string;
  slug: string;
  tradeName: string;
  kind: string;
}

/**
 * O ACESSO do vínculo ativo, como o servidor devolve em `access` (login,
 * dispositivo, sessão e troca de empresa): as capabilities efetivas (modelo ±
 * personalização), os caixas e as bancadas do escopo, e a casa calculada. É
 * com ele que a tela decide menu, guarda e botões de quem teve o acesso
 * PERSONALIZADO na tela de Usuários. Não é segredo e não autoriza nada: quem
 * autoriza é o servidor, a cada requisição.
 */
export interface AcessoDaSessao {
  modelo: { code: string; name: string; personalizado: boolean };
  capabilities: string[];
  terminais: 'todos' | string[];
  bancadas: 'todas' | string[];
  casa: string;
  carimbo: string;
}

export interface StoredSession extends SessionTokens {
  user: SessionUser;
  company: SessionCompany;
  companies: (SessionCompany & { profileCode: string })[];
  /** Opcional: sessão guardada antes do acesso granular não tem o campo. */
  access?: AcessoDaSessao;
}

export class ApiRequestError extends Error {
  // Campos declarados e atribuídos explicitamente: o projeto usa
  // `erasableSyntaxOnly`, que não aceita parameter properties.
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;
  /**
   * O `requestId` que o servidor devolveu no envelope de erro (GAP-PRD-064).
   * É a chave do log: com ele o suporte acha a linha exata do erro. Ausente
   * quando não houve resposta do servidor.
   */
  readonly requestId?: string;

  constructor(code: string, message: string, status: number, details?: unknown, requestId?: string) {
    super(message);
    this.name = 'ApiRequestError';
    this.code = code;
    this.status = status;
    this.details = details;
    this.requestId = requestId;
  }
}

/**
 * ==========================================================================
 * OS ÚLTIMOS ERROS DESTA ABA — com o código que o log conhece (GAP-PRD-064)
 * ==========================================================================
 *
 * O servidor devolve `requestId` em todo erro, e o log grava o mesmo número.
 * O cliente jogava isso fora: a pessoa via "Erro interno." e o suporte não
 * tinha como achar a linha do log daquele clique. Os documentos de incidente
 * mandavam "capturar o correlationId" que nenhuma tela mostrava.
 *
 * Agora: erro 5xx sai com o começo do código na própria frase, e os vinte
 * últimos erros desta aba ficam guardados (só na memória, nunca no disco)
 * para a tela Configurações › Sistema mostrar inteiros.
 */
export interface ErroDaApiRegistrado {
  em: string;
  metodo: string;
  caminho: string;
  status: number;
  codigo: string;
  mensagem: string;
  requestId: string | null;
}

const ULTIMOS_ERROS: ErroDaApiRegistrado[] = [];
const MAXIMO_DE_ERROS_GUARDADOS = 20;

export function ultimosErrosDaApi(): ErroDaApiRegistrado[] {
  return [...ULTIMOS_ERROS];
}

export function limparErrosDaApiParaTestes(): void {
  ULTIMOS_ERROS.length = 0;
}

function registrarErroDaApi(erro: ErroDaApiRegistrado): void {
  ULTIMOS_ERROS.unshift(erro);
  if (ULTIMOS_ERROS.length > MAXIMO_DE_ERROS_GUARDADOS) ULTIMOS_ERROS.length = MAXIMO_DE_ERROS_GUARDADOS;
}

/**
 * ==========================================================================
 * O DESEMBRULHO DO ENVELOPE — um ponto só
 * ==========================================================================
 *
 * O contrato desta API é: **200 devolve um OBJETO que nomeia o conteúdo**.
 * `{ items: [...] }`, `{ formats: [...] }`, `{ account: {...} }`. Não há
 * `data` nem `result` em volta, e não há lista solta na raiz.
 *
 * `coreApi` desembrulhava isso em 58 lugares, cada um com o seu
 * `.then((r) => r.items)`. Enquanto a chave vem, funciona. Quando ela NÃO
 * vem, nada reclama: `r.items` vira `undefined`, a promessa RESOLVE, e o
 * `try/catch` da tela não é acionado — porque não houve erro. O `undefined`
 * viaja até o componente e estoura lá, num `.map`, com a tela em branco.
 *
 * O caminho de ERRO nunca foi o problema: `apiRequest` lança
 * `ApiRequestError` em qualquer status fora de 2xx, e as 86 telas do
 * roteador sobrevivem a ele (provado em `toda-tela-monta`). O que faltava era
 * o caminho do CONTRATO QUEBRADO: 200 com um corpo que não é o combinado.
 *
 * O gatilho realista nasce no deploy — o navegador guarda o pacote antigo em
 * cache e a API sobe nova. Uma rota que deixou de mandar `items`, ou que
 * passou a responder 204, entrega `undefined` a um cliente que ainda pede
 * `items`.
 *
 * ## O QUE ELE NÃO FAZ
 *
 * Não devolve `[]` quando o servidor não mandou nada. Isso transformaria
 * falha em "não há registros": a tela diria "nenhuma venda hoje" num dia de
 * movimento, e ninguém procuraria defeito nenhum. Contrato quebrado é ERRO,
 * e erro as telas já sabem mostrar.
 *
 * `{ items: [] }` — lista vazia de verdade — passa, e é justamente a
 * distinção que dá sentido a tudo: o servidor dizendo "não há" é resposta; o
 * servidor não dizendo nada é falha.
 */
export function envelope<K extends string>(chave: K) {
  return function desembrulhar<T>(corpo: Record<K, T> | undefined | null): T {
    if (corpo === undefined || corpo === null) {
      throw new ApiRequestError(
        'API_CONTRACT_BROKEN',
        `O servidor respondeu sem corpo onde a tela espera "${chave}". `
          + 'Se o problema continuar, avise o suporte: a versão da tela pode estar '
          + 'diferente da versão do servidor.',
        200,
        { chave },
      );
    }
    if (typeof corpo !== 'object' || Array.isArray(corpo)) {
      throw new ApiRequestError(
        'API_CONTRACT_BROKEN',
        `O servidor respondeu num formato que a tela não entende (esperava um `
          + `objeto com "${chave}").`,
        200,
        { chave },
      );
    }
    const valor = (corpo as Record<string, unknown>)[chave];
    /*
      NULO e AUSENTE reprovam; `0`, `false` e `[]` passam. A diferença é a
      razão de existir deste guarda: zero é resposta, ausência é falha.
    */
    if (valor === undefined || valor === null) {
      throw new ApiRequestError(
        'API_CONTRACT_BROKEN',
        `O servidor respondeu sem "${chave}". A tela não tem o que mostrar, e `
          + 'mostrar uma lista vazia esconderia o problema.',
        200,
        { chave },
      );
    }
    return valor as T;
  };
}

/**
 * O MESMO GUARDA, para o corpo que traz VÁRIOS campos.
 *
 * `envelope` serve a chamada que devolve um conteúdo só. Boa parte das telas
 * lê um corpo com vários — `const c = await coreApi.labelCatalog(); setSources(c.sources)` —
 * e ali o `undefined` entra pela mesma porta: `setSources(undefined)` e o
 * `sources.find` do render seguinte apaga a tela.
 *
 * Conferir os campos numa linha só, na volta da chamada, transforma isso no
 * mesmo `ApiRequestError` que o `catch` da tela já trata — e mantém a
 * tipagem, porque o retorno é o próprio corpo.
 *
 * Como `envelope`: `0`, `false` e `[]` passam; ausente e nulo reprovam.
 */
export function exigirCampos<T extends object, K extends keyof T & string>(
  corpo: T | undefined | null,
  ...campos: K[]
): T {
  if (corpo === undefined || corpo === null || typeof corpo !== 'object') {
    throw new ApiRequestError(
      'API_CONTRACT_BROKEN',
      `O servidor respondeu sem corpo onde a tela espera ${campos.map((c) => `"${c}"`).join(', ')}.`,
      200,
      { campos },
    );
  }
  /*
    AUSÊNCIA reprova; NULO passa — e a diferença não é sutil.

    Meia dúzia de tipos deste projeto declaram `description: string | null`,
    `category: string | null`. O campo é obrigatório no contrato e o valor
    legítimo dele é nulo: produto sem descrição existe. Reprovar nulo aqui
    recusaria resposta correta.

    O que quebra a tela é o campo NÃO VIR — aí a leitura devolve `undefined`,
    e é isso que se cobra. `envelope` é mais duro de propósito: lá o campo É o
    conteúdo pedido, e conteúdo nulo não é conteúdo.
  */
  const faltando = campos.filter((c) => !(c in (corpo as Record<string, unknown>))
    || (corpo as Record<string, unknown>)[c] === undefined);
  if (faltando.length > 0) {
    throw new ApiRequestError(
      'API_CONTRACT_BROKEN',
      `O servidor respondeu sem ${faltando.map((c) => `"${c}"`).join(', ')}. A tela não tem `
        + 'o que mostrar, e mostrar vazio esconderia o problema. Se continuar, a versão '
        + 'da tela pode estar diferente da versão do servidor.',
      200,
      { campos: faltando },
    );
  }
  return corpo;
}

/** Porta padrão da API quando não há configuração explícita. */
const DEFAULT_API_PORT = '8787';

/**
 * Endereço da API.
 *
 * Sem `VITE_API_BASE_URL`, o endereço é derivado do host que serviu a página.
 * Fixar `localhost` quebraria o uso em rede: um PDV abrindo
 * `http://192.168.0.10:5173` tentaria falar com a API da própria máquina, que
 * não existe — e a tela mostraria "não foi possível conectar ao servidor".
 */
function baseUrl(): string {
  const configured = (import.meta.env?.VITE_API_BASE_URL as string | undefined)?.trim();
  if (configured) return `${configured.replace(/\/+$/, '')}/api/v1`;

  if (typeof window !== 'undefined' && window.location?.hostname) {
    const { protocol, hostname } = window.location;
    return `${protocol}//${hostname}:${DEFAULT_API_PORT}/api/v1`;
  }
  return `http://localhost:${DEFAULT_API_PORT}/api/v1`;
}

/**
 * Origem da API, sem o sufixo /api/v1.
 *
 * Arquivos enviados (fotos de produto) são servidos pela API em /uploads, fora
 * do prefixo versionado — e precisam do mesmo host derivado, senão a foto
 * quebra quando o PDV é aberto pelo IP da rede.
 */
export function apiOrigin(): string {
  return baseUrl().replace(/\/api\/v1$/, '');
}

// ------------------------------------------------------------------ sessão

let session: StoredSession | null = null;
let hydrated = false;

/**
 * Sessão restaurada do armazenamento local — VALIDADA antes de valer.
 *
 * O que vem do `localStorage` é entrada, não verdade: pode ter sido escrita
 * por uma versão anterior, por outra aba, ou à mão. Restaurar sem conferir era
 * um caminho por onde a operação ativa podia mudar sozinha.
 *
 * Só sobrevive a sessão em que a operação exibida é a mesma do token. Se
 * divergir, a sessão é descartada e a pessoa escolhe de novo — nunca se
 * escolhe uma empresa por ela.
 */
function lerGuardada(): { sessao: StoredSession | null; divergente: boolean } {
  let bruta: StoredSession | null = null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    bruta = raw ? (JSON.parse(raw) as StoredSession) : null;
  } catch {
    return { sessao: null, divergente: false };
  }
  if (!bruta?.accessToken || !bruta.company?.id) return { sessao: null, divergente: false };

  const doToken = scopeFromToken(bruta.accessToken);
  if (doToken.companyId && doToken.companyId !== bruta.company.id) {
    return { sessao: null, divergente: true };
  }
  return { sessao: bruta, divergente: false };
}

function restaurarSessao(): StoredSession | null {
  const { sessao: guardada, divergente } = lerGuardada();
  if (divergente) {
    // Divergência: a tela mostraria uma empresa e o servidor gravaria em
    // outra. Melhor pedir login do que adivinhar qual das duas está certa.
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Sem localStorage a sessão já não persiste; nada a limpar.
    }
  }
  return guardada;
}

/** A sessão guardada AGORA — validada como na restauração, sem apagar nada. */
function lerSessaoGuardada(): StoredSession | null {
  return lerGuardada().sessao;
}

export function getSession(): StoredSession | null {
  if (!hydrated) {
    hydrated = true;
    session = restaurarSessao();
  }
  return session;
}

/** Escopo de uma sessão guardada, do jeito que `activeScope` compara. */
function escopoDaSessao(s: StoredSession | null): ActiveScope {
  if (!s) return ESCOPO_VAZIO;
  const doToken = scopeFromToken(s.accessToken);
  return {
    userId: s.user?.id ?? doToken.userId,
    companyId: s.company?.id ?? doToken.companyId,
    unitId: doToken.unitId,
    // PDV e oficina não são escopo ambiente hoje: entram por requisição. Os
    // campos existem para que o diário já registre a transição no dia em que
    // passarem a ser.
    pdvId: null,
    workshopId: null,
  };
}

/**
 * Troca a sessão — e SEMPRE diz por quê.
 *
 * O motivo não é documentação: é a regra. `assertScopeChange` recusa mudança
 * de operação vinda de motivo que não pode mudar de operação, e a recusa
 * estoura. Ver `src/lib/activeScope.ts` para o porquê disso existir.
 */
export function setSession(
  next: StoredSession | null,
  reason: ScopeChangeReason,
  source: string,
): void {
  aplicarSessao(next, reason, source, true);
}

/**
 * O miolo de `setSession`. `gravar = false` é a sessão que OUTRA aba já gravou
 * (R2-SESSAO): a memória desta passa a ser ela, com as mesmas travas de escopo,
 * sem reescrever o `localStorage` — que é da vizinha tanto quanto desta.
 */
function aplicarSessao(
  next: StoredSession | null,
  reason: ScopeChangeReason,
  source: string,
  gravar: boolean,
): void {
  const anterior = escopoDaSessao(session ?? getSession());

  if (next) {
    // A tela não pode nomear uma empresa e o token valer para outra.
    assertScopeMatchesToken({
      companyId: next.company?.id ?? null,
      accessToken: next.accessToken,
      source,
    });
  }

  assertScopeChange({ previous: anterior, next: escopoDaSessao(next), reason, source });

  session = next;
  hydrated = true;
  if (gravar) {
    try {
      if (next) localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      // localStorage indisponível (modo privativo) — sessão segue só em memória
    }
  }
  for (const listener of listeners) listener(next);
}

type SessionListener = (s: StoredSession | null) => void;
const listeners = new Set<SessionListener>();

export function subscribeSession(listener: SessionListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * ==========================================================================
 * DUAS ABAS, UMA SESSÃO (R2-SESSAO)
 * ==========================================================================
 *
 * O `localStorage` é um só para todas as abas; a memória, uma por aba. Ninguém
 * ouvia o evento `storage`, e com o PDV numa aba e o escritório noutra:
 *
 *   - a aba que perdia a corrida da rotação tomava 401 na renovação e chamava
 *     `setSession(null)` — que APAGAVA do storage o refresh novo que a vizinha
 *     acabara de gravar. As duas caíam no login;
 *   - o logout numa aba não chegava à outra.
 *
 * Agora a memória acompanha o storage (este evento), a renovação relê o
 * storage antes de ir à rede e diante do 401 (`sessaoDaVizinha`), e as abas
 * renovam uma de cada vez (`naTrancaDaRenovacao`). E nunca se apaga a sessão
 * guardada que não é a sua.
 */
function mesmaSessao(a: StoredSession, b: StoredSession): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * A tela foi montada para outra pessoa ou outra operação: recomeça, como a
 * própria troca de operação faz na aba em que foi escolhida (`AppShell`).
 * Sem isto, o carrinho montado para a operação A seria gravado na B com o
 * token novo — o que `activeScope` existe para impedir.
 */
let recarregarAba: () => void = () => {
  try {
    window.location.reload();
  } catch {
    // Sem janela (fora do navegador): nada a recarregar.
  }
};

/** Troca a recarga da aba por um dublê — a recarga de verdade derruba o jsdom. */
export function definirRecargaDaAbaParaTestes(fn: () => void): void {
  recarregarAba = fn;
}

/** Passa a valer, nesta aba, a sessão que outra aba gravou. */
function adotarSessaoDeOutraAba(guardada: StoredSession): StoredSession {
  if (session && mesmaSessao(session, guardada)) return session;
  const antes = session ? escopoDaSessao(session) : null;
  const depois = escopoDaSessao(guardada);
  const outraPessoa = antes !== null && antes.userId !== depois.userId;
  const outraOperacao = antes !== null && antes.companyId !== depois.companyId;
  /*
    O motivo diz o que a OUTRA aba fez — e é o que `activeScope` confere: a
    troca de operação lá foi escolha explícita de quem opera, e o login de
    outra pessoa é login. A fonte (`client.outraAba`) registra de onde veio.
  */
  const motivo: ScopeChangeReason = antes === null
    ? 'SESSION_RESTORE_VALIDATED'
    : outraPessoa
      ? 'LOGIN'
      : outraOperacao
        ? 'EXPLICIT_OPERATION_CHANGE'
        : 'TOKEN_REFRESH';
  aplicarSessao(guardada, motivo, 'client.outraAba', false);
  if (outraPessoa || outraOperacao) recarregarAba();
  return guardada;
}

/**
 * Outra aba já rotacionou (ou trocou) a sessão? Então o storage tem um refresh
 * DIFERENTE do que esta aba tem — e é ele que vale: esta adota a sessão da
 * vizinha em vez de renovar de novo (o que queimaria o refresh recém-nascido)
 * ou de apagar o storage (o que derrubaria as duas).
 */
function sessaoDaVizinha(refreshQueEuTenho: string): StoredSession | null {
  const guardada = lerSessaoGuardada();
  if (!guardada?.refreshToken || guardada.refreshToken === refreshQueEuTenho) return null;
  return adotarSessaoDeOutraAba(guardada);
}

/**
 * O refresh de AGORA, para o corpo que prova a sessão (logout, troca de
 * operação): o guardado, se for da mesma pessoa — a vizinha pode ter renovado
 * antes de o evento chegar —, senão o da memória.
 */
function refreshDeAgora(): string | undefined {
  const minha = getSession();
  const guardada = lerSessaoGuardada();
  if (guardada?.refreshToken && minha && escopoDaSessao(guardada).userId === escopoDaSessao(minha).userId) {
    return guardada.refreshToken;
  }
  return minha?.refreshToken;
}

function aoMudarOStorageNoutraAba(evento: StorageEvent): void {
  if (evento.key !== null && evento.key !== STORAGE_KEY) return;
  // A aba que ainda não leu a sessão vai ler a de agora quando precisar.
  if (!hydrated) return;
  try {
    if (evento.storageArea && evento.storageArea !== localStorage) return;
  } catch {
    return;
  }
  const guardada = lerSessaoGuardada();
  if (!guardada) {
    // Saiu noutra aba (ou o que ficou guardado não vale): esta sai também.
    if (session) aplicarSessao(null, 'LOGOUT', 'client.outraAba', false);
    return;
  }
  adotarSessaoDeOutraAba(guardada);
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', aoMudarOStorageNoutraAba);
}

// ------------------------------------------------------------------ refresh

/**
 * O que a renovação respondeu — e a diferença entre as duas falhas é a razão
 * de este tipo existir (GAP-PRD-055).
 *
 * Qualquer `!res.ok` do `/auth/refresh` apagava a sessão e mandava para o
 * login. Mas 429 e 5xx não dizem que a credencial morreu: dizem que o
 * SERVIDOR (ou o proxy na frente dele) não atendeu agora. Atrás de um proxy
 * sem `DEVORA_TRUST_PROXY`, as seis operações dividem o balde de 300
 * requisições por minuto, e um robô na vitrine fazia o caixa do balcão ser
 * deslogado no meio da venda.
 *
 *   - `renovada`: sessão nova guardada.
 *   - `recusada`: o servidor RECUSOU a credencial (400/401/403 — refresh
 *     vencido, revogado, conta desligada). Aí sim a sessão local é apagada.
 *   - `indisponivel`: 429, 5xx, rede, corpo que não é JSON. A sessão FICA; a
 *     próxima requisição tenta renovar de novo.
 */
type ResultadoDaRenovacao =
  | { tipo: 'renovada'; sessao: StoredSession }
  | { tipo: 'recusada' }
  | { tipo: 'indisponivel'; status: number };

let refreshInFlight: Promise<ResultadoDaRenovacao> | null = null;

/** Status do `/auth/refresh` que querem dizer "esta credencial não vale mais". */
function refreshFoiRecusado(status: number): boolean {
  return status === 400 || status === 401 || status === 403;
}

/** O que o navegador oferece para serializar entre abas (Web Locks). */
type TrancaEntreAbas = {
  request: <T>(nome: string, opcoes: { signal?: AbortSignal }, fn: () => Promise<T>) => Promise<T>;
};

/**
 * Quanto uma aba espera pela tranca que outra segura. A outra segura durante a
 * renovação dela — um `fetch` — e um `fetch` pendurado (servidor que aceita e
 * não responde) prenderia a renovação de TODAS as abas, mesmo depois de o
 * servidor voltar. Passado o limite, esta renova sem a tranca: a queda segura
 * de sempre (`sessaoDaVizinha` diante do 401).
 */
const ESPERA_MAXIMA_DA_TRANCA_MS = 10_000;

function trancaEntreAbas(): TrancaEntreAbas | null {
  try {
    const locks = (globalThis.navigator as { locks?: TrancaEntreAbas } | undefined)?.locks;
    return locks && typeof locks.request === 'function' ? locks : null;
  } catch {
    return null;
  }
}

/**
 * Uma renovação por vez ENTRE AS ABAS (R2-SESSAO). Com a tranca, a segunda aba
 * espera a primeira e, ao entrar, acha no storage o refresh que ela acabou de
 * rotacionar — e o adota sem ir à rede. Sem Web Locks (navegador antigo, ou a
 * tranca recusada), segue sem ela: a queda segura é o `sessaoDaVizinha` diante
 * do 401, que adota em vez de apagar.
 */
async function naTrancaDaRenovacao<T>(fn: () => Promise<T>): Promise<T> {
  const tranca = trancaEntreAbas();
  if (!tranca) return fn();
  let comecou = false;
  // O sinal só vale ENQUANTO se espera: depois de concedida, a tranca é desta aba.
  const desistir = typeof AbortController === 'function' ? new AbortController() : null;
  const relogio = desistir ? setTimeout(() => desistir.abort(), ESPERA_MAXIMA_DA_TRANCA_MS) : null;
  try {
    return await tranca.request('gs.session.renovacao', desistir ? { signal: desistir.signal } : {}, () => {
      comecou = true;
      if (relogio !== null) clearTimeout(relogio);
      return fn();
    });
  } catch (err) {
    // Recusada ou desistida antes de começar: segue sem ela. Falha de dentro, propaga.
    if (comecou) throw err;
    return fn();
  } finally {
    if (relogio !== null) clearTimeout(relogio);
  }
}

/*
  A MARCA DA RENOVAÇÃO EM CURSO — a espera quando não há Web Locks.

  Web Locks só existe em contexto seguro (HTTPS ou localhost). O PDV aberto
  pelo IP da rede (`http://192.168.0.10:3000`, ver `src/lib/uuid.ts`) NÃO é
  contexto seguro: ali `navigator.locks` não existe e a tranca acima nunca
  entra. É o caminho de todo dia da loja — não o de um navegador antigo.

  Sem a tranca, as duas abas mandam o mesmo refresh; o servidor rotaciona na
  primeira e recusa a segunda. Quando o 401 da segunda chegava ANTES de a
  primeira gravar o refresh novo (ela ainda lia o corpo da resposta), o
  storage ainda guardava o recusado, e a segunda concluía "recusada de
  verdade": caía no login com a requisição perdida, e o apagar do storage
  chegava à vizinha como logout, no meio da renovação dela.

  Agora cada aba, antes de mandar o refresh, deixa no storage "estou renovando
  ESTE refresh" (a impressão dele, não ele) e tira a marca depois de gravar o
  novo. A que toma 401 tira a própria marca e, enquanto houver marca de OUTRA
  aba para o mesmo refresh e o storage ainda guardar o recusado, espera: a
  vizinha grava e é adotada, ou termina sem gravar e a recusa é de verdade.
  A marca vence sozinha (a aba fechada no meio da renovação não a tira), e a
  espera tem teto.
*/
const PREFIXO_DA_MARCA_DE_RENOVACAO = 'gs.session.renovando.';
const MARCA_DESTA_ABA = PREFIXO_DA_MARCA_DE_RENOVACAO + uuid();
const VALIDADE_DA_MARCA_MS = 15_000;
const INTERVALO_DA_ESPERA_PELA_VIZINHA_MS = 50;

/** Impressão curta e NÃO secreta do refresh — só para comparar entre abas. */
function impressaoDoRefresh(refresh: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < refresh.length; i += 1) {
    h ^= refresh.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

function marcarRenovacao(refresh: string): void {
  try {
    localStorage.setItem(
      MARCA_DESTA_ABA,
      JSON.stringify({ refresh: impressaoDoRefresh(refresh), ate: Date.now() + VALIDADE_DA_MARCA_MS }),
    );
  } catch {
    // Sem storage não há vizinha que o leia: a espera simplesmente não acontece.
  }
}

function desmarcarRenovacao(): void {
  try {
    localStorage.removeItem(MARCA_DESTA_ABA);
  } catch {
    // Idem.
  }
}

/** OUTRA aba avisou que está renovando este mesmo refresh, e o aviso ainda vale? */
function vizinhaRenovandoOMesmo(refresh: string): boolean {
  const impressao = impressaoDoRefresh(refresh);
  const agora = Date.now();
  const vencidas: string[] = [];
  let renovando = false;
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const chave = localStorage.key(i);
      if (!chave || !chave.startsWith(PREFIXO_DA_MARCA_DE_RENOVACAO) || chave === MARCA_DESTA_ABA) continue;
      let marca: { refresh?: unknown; ate?: unknown } | null = null;
      try {
        marca = JSON.parse(localStorage.getItem(chave) ?? 'null') as typeof marca;
      } catch {
        marca = null;
      }
      const ate = typeof marca?.ate === 'number' ? marca.ate : 0;
      if (ate <= agora) {
        vencidas.push(chave);
        continue;
      }
      if (marca?.refresh === impressao) renovando = true;
    }
    // A marca de uma aba fechada no meio da renovação: ninguém mais a tiraria.
    for (const chave of vencidas) localStorage.removeItem(chave);
  } catch {
    return false;
  }
  return renovando;
}

/** Espera a vizinha que renova o MESMO refresh terminar — o storage diz se ela renovou. */
async function esperarAVizinhaQueRenova(refresh: string): Promise<void> {
  const limite = Date.now() + VALIDADE_DA_MARCA_MS;
  while (
    Date.now() < limite
    && lerSessaoGuardada()?.refreshToken === refresh
    && vizinhaRenovandoOMesmo(refresh)
  ) {
    await new Promise<void>((resolver) => {
      setTimeout(resolver, INTERVALO_DA_ESPERA_PELA_VIZINHA_MS);
    });
  }
}

async function refreshSession(): Promise<ResultadoDaRenovacao> {
  const current = getSession();
  if (!current?.refreshToken) return { tipo: 'recusada' };

  // Uma renovação por vez: a rotação invalida o refresh token usado, então
  // chamadas paralelas derrubariam a sessão.
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async (): Promise<ResultadoDaRenovacao> => {
    try {
      return await naTrancaDaRenovacao(() => renovarNaTranca(current.refreshToken));
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

async function renovarNaTranca(refreshPedido: string): Promise<ResultadoDaRenovacao> {
  /*
    ANTES DE IR À REDE: outra aba já renovou? Enquanto esta esperava a tranca,
    o evento pode ter trazido a sessão dela para a memória — ou ainda não, e
    ela só está no storage. Nos dois casos é ela que vale.
  */
  const minha = getSession();
  if (!minha) return { tipo: 'recusada' };
  if (minha.refreshToken !== refreshPedido) return { tipo: 'renovada', sessao: minha };
  const daVizinha = sessaoDaVizinha(minha.refreshToken);
  if (daVizinha) return { tipo: 'renovada', sessao: daVizinha };

  const enviado = minha.refreshToken;
  // Às outras abas: "estou renovando este refresh" — ver a marca, acima.
  marcarRenovacao(enviado);
  try {
    const res = await fetch(`${baseUrl()}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: enviado }),
    });
    if (!res.ok) {
      if (refreshFoiRecusado(res.status)) {
        /*
          A recusa pode ser só a corrida perdida: a vizinha rotacionou este
          mesmo refresh primeiro e já gravou o novo — ou ainda vai gravar, e
          então esta espera por ela (sem a própria marca, para duas recusadas
          não esperarem uma pela outra). O novo é adotado; e o storage só é
          apagado quando o que está nele é o refresh recusado (ou nada), isto
          é, quando a sessão guardada é a DESTA aba.
        */
        desmarcarRenovacao();
        await esperarAVizinhaQueRenova(enviado);
        const vizinha = sessaoDaVizinha(enviado);
        if (vizinha) return { tipo: 'renovada', sessao: vizinha };
        setSession(null, 'LOGOUT', 'client.refreshSession');
        return { tipo: 'recusada' };
      }
      return { tipo: 'indisponivel', status: res.status };
    }
    let body: { accessToken?: string; refreshToken?: string; expiresIn?: number };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      // 200 com página HTML: é o proxy respondendo no lugar da API.
      return { tipo: 'indisponivel', status: res.status };
    }
    if (!body.accessToken || !body.refreshToken || !body.expiresIn) {
      return { tipo: 'indisponivel', status: res.status };
    }
    const next: StoredSession = {
      ...minha,
      accessToken: body.accessToken,
      refreshToken: body.refreshToken,
      expiresAt: Date.now() + body.expiresIn * 1000,
    };
    setSession(next, 'TOKEN_REFRESH', 'client.refreshSession');
    return { tipo: 'renovada', sessao: next };
  } catch {
    // Rede fora: a sessão continua sendo desta pessoa.
    return { tipo: 'indisponivel', status: 0 };
  } finally {
    // Só DEPOIS de gravar o refresh novo: quem espera por esta aba o acha no storage.
    desmarcarRenovacao();
  }
}

/**
 * Renova depois de um 401 e diz o que fazer com o resultado.
 *
 * Devolve a sessão nova para repetir a requisição, ou `null` quando a
 * credencial foi recusada (o 401 original segue, e a tela cai no login porque
 * a sessão já foi apagada). Quando o servidor não pôde renovar AGORA, lança um
 * erro que diz isso — em vez do "Token inválido." do 401 original, que
 * mandaria a pessoa desconfiar da senha.
 */
async function renovarAposRecusa(): Promise<StoredSession | null> {
  const resultado = await refreshSession();
  if (resultado.tipo === 'renovada') return resultado.sessao;
  if (resultado.tipo === 'recusada') return null;
  throw new ApiRequestError(
    'API_SESSION_REFRESH_UNAVAILABLE',
    resultado.status === 429
      ? 'O servidor está recebendo requisições demais e não renovou a sessão agora. '
        + 'Você continua conectado: tente de novo em alguns segundos.'
      : 'Não foi possível renovar a sessão agora — o servidor não respondeu. '
        + 'Você continua conectado: tente de novo em instantes.',
    resultado.status,
  );
}

/** Quem, e em que operação, a sessão era quando a requisição SAIU. */
function escopoDoEnvio(): ActiveScope {
  return escopoDaSessao(getSession());
}

/**
 * O que fazer com o 401 de uma requisição autenticada (RES-SESSAO).
 *
 * O servidor encerra o access anterior na rotação do refresh e na troca de
 * operação. Então o 401 de uma requisição que estava no ar quando OUTRA
 * chamada renovou ou trocou de operação não quer dizer "meu token venceu":
 *
 *   - a sessão de agora já tem OUTRO token, da mesma pessoa e operação: repete
 *     com ele. Renovar de novo queimaria o refresh que acabou de nascer — e
 *     encerraria o access que a outra chamada está usando;
 *   - a pessoa ou a operação mudou: NÃO repete. A venda montada para a
 *     operação A não pode ser gravada na operação B só porque a sessão trocou
 *     no meio do caminho. A tela recebe um erro que diz isso;
 *   - senão, é o 401 de sempre: renova (uma vez, compartilhada) e repete.
 */
async function sessaoParaRepetir(tokenUsado: string | null, escopo: ActiveScope | null): Promise<StoredSession | null> {
  const atual = getSession();
  if (!atual) return null;
  if (tokenUsado && atual.accessToken !== tokenUsado) {
    recusarSeOEscopoMudou(atual, escopo);
    return atual;
  }
  const renovada = await renovarAposRecusa();
  /*
    A renovação pode ADOTAR a sessão de outra aba (R2-SESSAO) — e a vizinha
    pode ter trocado de operação. A mesma regra: não repete na operação nova.
  */
  if (renovada) recusarSeOEscopoMudou(renovada, escopo);
  return renovada;
}

function recusarSeOEscopoMudou(sessao: StoredSession, escopo: ActiveScope | null): void {
  if (!escopo) return;
  // `escopoDaSessao` aguenta sessão restaurada de versão antiga, sem `user`.
  const agora = escopoDaSessao(sessao);
  if (agora.userId !== escopo.userId || agora.companyId !== escopo.companyId) {
    throw new ApiRequestError(
      'API_SESSION_SCOPE_CHANGED',
      'A sessão mudou de operação enquanto esta ação estava a caminho, e ela não foi repetida '
        + 'na operação nova. Confira a operação ativa e refaça, se for o caso.',
      409,
    );
  }
}

// ------------------------------------------------------------------ request

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Chave de idempotência — obrigatória para venda e cobranças. */
  idempotencyKey?: string;
  signal?: AbortSignal;
  /** Requisições públicas (login) não anexam token nem tentam refresh. */
  anonymous?: boolean;
  /**
   * Cabeçalhos extras.
   *
   * Existe para o portal do cliente, que manda o próprio token em
   * `x-portal-token` — sessão separada da administrativa, de propósito.
   */
  headers?: Record<string, string>;
  /**
   * Se o SERVIDOR não responder, guarda para reenviar depois.
   *
   * Exige `idempotencyKey`: sem ela, reenviar é duplicar. Vale só para escrita
   * que a loja não pode perder — hoje, a venda do PDV. Consulta não entra:
   * devolver dado velho como atual é pior que dizer que está sem conexão.
   */
  queueWhenOffline?: boolean;
  /** Rótulo curto para a tela dizer o que está pendente. */
  queueLabel?: string;
  /**
   * O corpo montado NA HORA de cada envio, e não antes da chamada (RES-SESSAO).
   *
   * Para corpo que carrega credencial da sessão: se o primeiro envio toma 401
   * e o cliente renova, a repetição sai com o corpo relido — senão levaria o
   * refresh que a própria renovação acabou de matar. Quando presente, vale no
   * lugar de `body`. Hoje, o `logout` e a troca de operação (R2-SESSAO).
   */
  corpoNaHora?: () => unknown;
}

/**
 * O SERVIDOR disse que esta sessão é de senha provisória (GAP-PRD-202).
 *
 * A API recusa com 403 `API_PASSWORD_CHANGE_REQUIRED` toda rota que não seja
 * a da etapa de troca, e a tela precisa obedecer à mesma verdade: a sessão
 * guardada passa a carregar `mustChangePassword`, e `Protected` — que
 * acompanha a sessão — manda a pessoa para a porta, que abre na etapa. Sem
 * isto, uma sessão cuja bandeira local se perdeu mostraria erro em cada tela,
 * sem nunca oferecer a troca que resolve todos eles.
 */
function marcarSessaoComoProvisoria(): void {
  const atual = getSession();
  if (!atual || atual.user.mustChangePassword) return;
  setSession(
    { ...atual, user: { ...atual.user, mustChangePassword: true } },
    'TOKEN_REFRESH',
    'client.apiRequest.senhaProvisoria',
  );
}

/**
 * O SERVIDOR disse que o perfil desta sessão mudou (GAP-PRD-053).
 *
 * A API confere a conta a cada requisição e usa o perfil do vínculo DE AGORA;
 * quando ele difere do que o token carrega, a resposta traz
 * `X-Perfil-Em-Vigor`. A tela guarda o perfil do login e é com ele que monta
 * o menu e os guardas de tela: sem acompanhar o aviso, o gerente rebaixado
 * continuaria vendo o menu de gerente (e levando 403), e o atendente
 * promovido não veria o que passou a alcançar até entrar de novo.
 *
 * Só o perfil muda — a operação não: o aviso vale para a operação do token,
 * que é a mesma da sessão guardada.
 */
function acompanharPerfilEmVigor(res: Response): void {
  const perfil = res.headers?.get?.('X-Perfil-Em-Vigor')?.trim();
  if (!perfil) return;
  const atual = getSession();
  if (!atual || atual.user.profileCode === perfil) return;
  setSession(
    {
      ...atual,
      user: { ...atual.user, profileCode: perfil },
      companies: atual.companies.map((c) => (c.id === atual.company.id ? { ...c, profileCode: perfil } : c)),
    },
    'TOKEN_REFRESH',
    'client.apiRequest.perfilEmVigor',
  );
}

/**
 * O SERVIDOR disse que o ACESSO desta sessão mudou (RBAC granular): capability
 * dada ou tirada, modelo trocado, escopo de caixa mudado. A resposta traz
 * `X-Acesso-Em-Vigor` com o carimbo novo; a tela relê `GET /auth/session` UMA
 * vez e redesenha menu e guardas sem novo login. O cabeçalho continua vindo
 * até o token ser renovado — por isso compara com o carimbo JÁ guardado, e
 * não relê de novo o que já releu.
 */
let releituraDoAcesso: Promise<void> | null = null;
function acompanharAcessoEmVigor(res: Response): void {
  const carimbo = res.headers?.get?.('X-Acesso-Em-Vigor')?.trim();
  if (!carimbo || releituraDoAcesso) return;
  const atual = getSession();
  if (!atual || atual.access?.carimbo === carimbo) return;
  releituraDoAcesso = apiRequest<{ access?: AcessoDaSessao }>('/auth/session')
    .then((r) => {
      const agora = getSession();
      if (agora && r?.access && agora.company.id === atual.company.id) {
        setSession({ ...agora, access: r.access }, 'TOKEN_REFRESH', 'client.apiRequest.acessoEmVigor');
      }
    })
    .catch(() => undefined)
    .finally(() => {
      releituraDoAcesso = null;
    });
}

/**
 * O evento que a tela ouve para perguntar ao servidor se ele está de pé
 * (G-offline-sync-04).
 *
 * A sonda de `/health` só rodava quando já havia venda na fila: com a fila
 * vazia e o servidor caído (a rede da loja de pé, `navigator.onLine` em
 * `true`), nenhuma faixa dizia que o servidor estava fora — o operador via
 * "Falha na busca." a cada bipe e achava que era o leitor. Toda requisição que
 * não chega ao servidor avisa, e a barra de conexão sonda na hora.
 */
export const EVENTO_SERVIDOR_SEM_RESPOSTA = 'gs:servidor-caiu';

function avisarServidorSemResposta(): void {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  try {
    window.dispatchEvent(new Event(EVENTO_SERVIDOR_SEM_RESPOSTA));
  } catch {
    // Aviso é conveniência da tela: nunca derruba a requisição.
  }
}

/*
  A VENDA NO AR SEGURA O F5 (G-offline-sync-06).

  Recarregar ou fechar a aba durante "Finalizando…" perdia a venda do ponto de
  vista da tela, e o servidor podia gravá-la mesmo assim. Enquanto houver venda
  no ar, o navegador pergunta antes de sair — é o `beforeunload` do próprio
  navegador, a única pergunta que ele permite nessa hora. E se a pessoa sair
  mesmo assim, a venda está escrita em `marcarEmEnvio` e volta pela fila.
*/
let vendasNoAr = 0;
function aoSairComVendaNoAr(e: BeforeUnloadEvent): void {
  e.preventDefault();
  // Navegadores antigos só perguntam com `returnValue` preenchido.
  e.returnValue = '';
}
function segurarSaidaDaTela(delta: 1 | -1): void {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  const antes = vendasNoAr;
  vendasNoAr = Math.max(0, vendasNoAr + delta);
  if (antes === 0 && vendasNoAr > 0) window.addEventListener('beforeunload', aoSairComVendaNoAr);
  if (antes > 0 && vendasNoAr === 0) window.removeEventListener('beforeunload', aoSairComVendaNoAr);
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  /*
    A ESCRITA QUE PODE IR PARA A FILA (hoje, a venda do PDV) tem PRAZO
    (G-offline-sync-06). O `fetch` não tinha nenhum: servidor travado deixava
    o spinner para sempre. Estourado o prazo, a venda vai para a fila com a
    MESMA chave — reenviar é seguro, porque a chave devolve a venda que o
    servidor tiver gravado. O `signal` de quem chamou continua valendo.
  */
  const enfileiravel = Boolean(options.queueWhenOffline && options.idempotencyKey);
  const prazo = enfileiravel ? new AbortController() : null;
  const relogioDoPrazo = prazo ? setTimeout(() => prazo.abort(), PRAZO_DA_VENDA_MS) : null;
  if (prazo && options.signal) {
    if (options.signal.aborted) prazo.abort();
    else options.signal.addEventListener('abort', () => prazo.abort(), { once: true });
  }
  const sinal = prazo ? prazo.signal : options.signal;

  const perform = async (token: string | null): Promise<Response> => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    };
    // O token PRECISA ir no header. Este trecho já esteve como `Bearer ` — sem
    // interpolação —, e o efeito era mudo do jeito mais caro possível: toda
    // requisição autenticada saía com portador vazio, a API respondia 401, e a
    // tela mostrava "Autenticação obrigatória" com a pessoa logada. Nenhuma
    // tela do ERP carregava dado; só apareceu ao abrir a oficina no navegador.
    if (token) headers.Authorization = `Bearer ${token}`;
    if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
    // Relido a CADA envio: a repetição depois da renovação leva o corpo de agora.
    const corpo = options.corpoNaHora ? options.corpoNaHora() : options.body;
    return fetch(`${baseUrl()}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
      signal: sinal,
    });
  };

  // Quem, e em que operação, a sessão era na saída: o 401 não repete esta
  // requisição em outra (RES-SESSAO — ver `sessaoParaRepetir`).
  const escopo = options.anonymous ? null : escopoDoEnvio();
  let token = options.anonymous ? null : (getSession()?.accessToken ?? null);
  const escopoDaVenda = escopo ? { userId: escopo.userId, companyId: escopo.companyId } : undefined;

  /**
   * Guarda na fila e devolve o erro que a tela entende.
   *
   * Só entra na fila o que foi marcado como enfileirável E tem chave de
   * idempotência — hoje, a venda do PDV. O resto propaga o erro: fingir que
   * uma consulta "foi enfileirada" mostraria dado velho como se fosse atual.
   *
   * Se o navegador não conseguir GUARDAR (G-offline-sync-M02), a resposta é
   * outra: a venda NÃO foi registrada em lugar nenhum, e a tela precisa manter
   * o carrinho e a chave para repetir — e não dizer "guardada, não refaça".
   */
  const erroDeGuardarNaFila = (): ApiRequestError => {
    try {
      enqueue({
        path,
        method: options.method ?? 'POST',
        body: options.body,
        idempotencyKey: options.idempotencyKey!,
        label: options.queueLabel ?? path,
        // A operação em que a venda foi feita: o reenvio só a manda nela
        // (RES-SESSAO — ver `QueuedRequest.escopo`).
        escopo: escopoDaVenda,
      });
    } catch (erroDaFila) {
      if (erroDaFila instanceof FilaIndisponivelError) {
        return new ApiRequestError(
          'API_QUEUE_UNAVAILABLE',
          'Sem conexão com o servidor da loja, e este navegador não conseguiu guardar a venda (armazenamento '
            + 'cheio ou bloqueado): a venda NÃO foi registrada. O carrinho continua na tela — finalize de novo '
            + 'quando o servidor voltar.',
          0,
        );
      }
      throw erroDaFila;
    }
    return new ApiRequestError(
      'API_QUEUED_OFFLINE',
      'Sem conexão com o servidor. A operação ficou na fila e será enviada quando voltar.',
      0,
    );
  };

  /** A requisição não chegou ao servidor: avisa a tela e, se for a venda, guarda. */
  const semResposta = (err: unknown): unknown => {
    // O `abort` de quem chamou (a tela que desmontou) não é servidor fora.
    if (isNetworkFailure(err) && !options.signal?.aborted) avisarServidorSemResposta();
    if (enfileiravel && isNetworkFailure(err)) return erroDeGuardarNaFila();
    return err;
  };

  if (enfileiravel) {
    marcarEmEnvio({
      path,
      method: options.method ?? 'POST',
      body: options.body,
      idempotencyKey: options.idempotencyKey!,
      label: options.queueLabel ?? path,
      escopo: escopoDaVenda,
    });
    segurarSaidaDaTela(1);
  }
  let res: Response;
  try {
    try {
      res = await perform(token);
    } catch (err) {
      // SERVIDOR FORA DO AR (ou o prazo da venda estourou).
      throw semResposta(err);
    }

    // 401 com sessão existente: repete uma vez — com o token que outra chamada
    // já renovou, ou renovando agora; nunca em outra operação (RES-SESSAO).
    if (res.status === 401 && !options.anonymous && getSession()) {
      const renewed = await sessaoParaRepetir(token, escopo);
      if (renewed) {
        token = renewed.accessToken;
        try {
          res = await perform(token);
        } catch (err) {
          // A repetição também pode não chegar: o mesmo destino da primeira.
          throw semResposta(err);
        }
      }
    }
  } finally {
    if (relogioDoPrazo) clearTimeout(relogioDoPrazo);
    if (enfileiravel) {
      desmarcarEmEnvio(options.idempotencyKey!);
      segurarSaidaDaTela(-1);
    }
  }

  /*
    O PROXY RESPONDEU NO LUGAR DA API (G-offline-sync-05).

    A fila só entrava quando o `fetch` lançava exceção. Atrás de proxy reverso
    ou túnel (a implantação que `observarProxy` reconhece), a API caída vira
    502/504 com HTML — que caía em `API_INVALID_RESPONSE` dentro do diálogo de
    pagamento, sem guardar a venda — ou 503. A própria API só responde 503 no
    `/health`, e o reenvio já tratava 5xx como rede (`classificarFalha`): era
    incoerente a venda não entrar. Guardar é seguro também no 504, em que o
    servidor de trás pode ter gravado: a mesma chave devolve a venda original.
    Um 500 da API (JSON, erro dela) continua sendo erro, e não fila.
  */
  const gatewaySemResposta = res.status === 502 || res.status === 503 || res.status === 504;
  if (enfileiravel && gatewaySemResposta) {
    avisarServidorSemResposta();
    throw erroDeGuardarNaFila();
  }

  /*
    A CONSULTA TAMBÉM AVISA A BARRA (G-offline-sync-R01).

    O DEFEITO: o aviso só saía na falha de rede e no 502/503/504 da VENDA.
    Atrás de proxy ou túnel, com a API caída e a fila vazia, a busca do bipe
    recebia o 502 do proxy e ninguém avisava a barra de conexão — que só sonda
    quando avisada (o intervalo de 15 s roda só com o servidor já dado como
    fora). Nenhuma faixa acendia até a primeira venda ir para a fila: o
    cenário dos achados 04 e 03 inteiro, nessa implantação.

    Qualquer 502/503/504 avisa. O aviso só faz a barra PERGUNTAR a `/health`,
    e é a sonda que decide: o 502 que a própria API manda (provedor externo
    fora, com envelope JSON) custa uma sonda à toa, e a faixa não acende.
  */
  if (gatewaySemResposta) avisarServidorSemResposta();

  if (!options.anonymous) {
    acompanharPerfilEmVigor(res);
    acompanharAcessoEmVigor(res);
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  /*
    QUEM RESPONDEU FOI O PROXY, NÃO A API (G-offline-sync-R01).

    502/503/504 com página HTML (ou sem corpo nenhum) é o proxy dizendo que a
    API atrás dele não responde. Isso caía em `API_INVALID_RESPONSE` ("O
    servidor respondeu algo que não é JSON…"), uma frase que manda procurar
    defeito no proxy quando o que houve é o servidor da loja fora. O erro sai
    com código próprio e o status que veio: a frase é a de sem conexão, e
    `isNetworkFailure` o reconhece — a busca do PDV diz o que ainda dá para
    fazer. Resposta JSON continua sendo da API, com o código e a frase dela.
  */
  /*
    O 504 NÃO É "FORA DO AR" (revisão do G-offline-sync-R01).

    O DEFEITO da primeira versão: a mesma frase servia aos três — "o servidor
    está fora do ar ou reiniciando. Tente de novo em instantes". O 504 é o
    proxy desistindo de ESPERAR: o servidor de trás recebeu o pedido e pode
    estar só lento (relatório ou backup segurando o banco) — ou já ter
    gravado. Numa gravação sem chave de idempotência, "tente de novo" era o
    convite para lançar duas vezes (é o caso que a DevolucoesPage conta). O
    502/503 (o proxy nem alcançou a API) mantém a frase de fora do ar.
  */
  const erroDoProxySemApi = () =>
    new ApiRequestError(
      CODIGO_PROXY_SEM_API,
      res.status === 504
        ? 'Sem resposta do servidor da loja: quem respondeu foi o proxy (ou túnel) na frente dele, com HTTP 504 '
          + '— o servidor não respondeu a tempo. Ele pode estar travado, ou ter feito a operação sem conseguir '
          + 'avisar: se você estava gravando algo, confira se entrou antes de repetir. Se continuar, avise quem '
          + 'cuida do servidor.'
        : 'Sem conexão com o servidor da loja: quem respondeu foi o proxy (ou túnel) na frente dele, '
          + `com HTTP ${res.status} — o servidor está fora do ar ou reiniciando. Tente de novo em instantes; `
          + 'se continuar, avise quem cuida do servidor.',
      res.status,
    );
  if (gatewaySemResposta && !text.trim()) throw erroDoProxySemApi();
  /*
    CORPO QUE NÃO É JSON.

    É o que um proxy devolve quando o app está fora do ar: 200 com uma
    página HTML. `JSON.parse` lançava `SyntaxError: Unexpected token '<'` —
    um erro que não é `ApiRequestError` e que chega à tela como frase de
    runtime, sem código e sem status. Aqui ele vira erro nomeado, com o
    status que realmente veio.
  */
  let payload: Record<string, unknown>;
  try {
    payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    if (gatewaySemResposta) throw erroDoProxySemApi();
    throw new ApiRequestError(
      'API_INVALID_RESPONSE',
      'O servidor respondeu algo que não é JSON. Se houver um proxy ou túnel '
        + 'no caminho, ele pode estar respondendo no lugar da API.',
      res.status,
    );
  }

  if (!res.ok) {
    const error = (payload.error ?? {}) as { code?: string; message?: string; details?: unknown };
    if (res.status === 403 && error.code === 'API_PASSWORD_CHANGE_REQUIRED') {
      marcarSessaoComoProvisoria();
    }
    const requestId = typeof payload.requestId === 'string' && payload.requestId ? payload.requestId : null;
    const base = error.message ?? 'Falha na comunicação com o servidor.';
    // Erro do SERVIDOR (5xx) não tem frase que ajude quem está na tela: o
    // código é o que leva o suporte à linha do log. Recusa de regra (4xx) já
    // diz o que fazer, e fica como está.
    const mensagem = res.status >= 500 && requestId ? `${base} Código para o suporte: ${requestId.slice(0, 8)}.` : base;
    registrarErroDaApi({
      em: new Date().toISOString(),
      metodo: options.method ?? 'GET',
      caminho: path.split('?')[0],
      status: res.status,
      codigo: error.code ?? 'API_ERROR',
      mensagem: base,
      requestId,
    });
    throw new ApiRequestError(error.code ?? 'API_ERROR', mensagem, res.status, error.details, requestId ?? undefined);
  }

  return payload as T;
}

/**
 * Documento servido pela API como ARQUIVO — DANFE, DANFCE, XML.
 *
 * Existe porque abrir a URL da API direto numa aba nova NÃO funciona: a aba
 * não leva o token, a API recusa, e quem clicou em "DANFE" recebe um JSON de
 * erro no lugar da nota. O caminho certo é buscar autenticado e abrir o
 * conteúdo já baixado.
 *
 * Devolve texto porque é isso que estes endpoints produzem (HTML e XML). Quem
 * chama decide o que fazer: abrir numa aba, imprimir ou salvar.
 */
export async function apiDocument(
  path: string,
): Promise<{ content: string; contentType: string }> {
  const perform = async (token: string | null): Promise<Response> =>
    fetch(`${baseUrl()}${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });

  const escopo = escopoDoEnvio();
  const tokenUsado = getSession()?.accessToken ?? null;
  let res = await perform(tokenUsado);
  // O mesmo 401 de `apiRequest`: repete com o token de agora, nunca em outra operação.
  if (res.status === 401 && getSession()) {
    const renewed = await sessaoParaRepetir(tokenUsado, escopo);
    if (renewed) res = await perform(renewed.accessToken);
  }

  const content = await res.text();
  if (!res.ok) {
    // O corpo de erro continua sendo JSON; a mensagem do servidor é melhor do
    // que qualquer texto genérico inventado aqui.
    let code = 'API_ERROR';
    let message = 'Falha ao obter o documento.';
    try {
      const payload = JSON.parse(content) as { error?: { code?: string; message?: string } };
      code = payload.error?.code ?? code;
      message = payload.error?.message ?? message;
    } catch {
      // Resposta não-JSON: fica a mensagem genérica.
    }
    throw new ApiRequestError(code, message, res.status);
  }

  return { content, contentType: res.headers.get('content-type') ?? 'text/plain' };
}

/** Um arquivo que a API entregou, já em bytes, com o nome que ela deu. */
export interface ArquivoDaApi {
  blob: Blob;
  /** O nome do `Content-Disposition` — ou o que quem chamou pediu de reserva. */
  nomeArquivo: string;
  contentType: string;
  /**
   * Os cabeçalhos da resposta, para o que só o servidor sabe dizer sobre o
   * arquivo — o SHA-256 do pacote do contador (GAP-PRD-176). Opcional: quem
   * fabrica um `ArquivoDaApi` à mão (dublê de teste) não precisa inventá-los.
   */
  headers?: Headers;
}

/**
 * O nome do arquivo, lido do `Content-Disposition`.
 *
 * Devolve `null` sempre que não houver um nome utilizável, e é de propósito que
 * ele não invente nada: quem chama tem um nome de reserva melhor do que
 * qualquer palpite feito aqui, porque sabe O QUE está baixando.
 *
 * O cabeçalho é ENTRADA, mesmo vindo do nosso servidor: o dia em que um nome
 * carregar barra ou `..`, alguns navegadores escrevem fora da pasta de
 * downloads. O filtro custa uma linha e fecha isso.
 */
function nomeDoCabecalho(disposition: string | null): string | null {
  if (!disposition) return null;

  // `filename*=UTF-8''…` vence quando existe: é a forma que carrega acento sem
  // depender da codificação que o navegador chutar para o `filename` simples.
  let bruto: string | undefined;
  const estendido = /filename\*=\s*UTF-8''([^;]+)/i.exec(disposition);
  if (estendido) {
    try {
      bruto = decodeURIComponent(estendido[1]);
    } catch {
      // Percentual malformado: cai para o `filename` simples abaixo.
    }
  }
  if (!bruto) {
    const simples = /filename\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(disposition);
    bruto = simples?.[1] ?? simples?.[2];
  }
  if (!bruto) return null;

  const limpo = bruto.trim().replace(/[\\/]+/g, '-').replace(/\.{2,}/g, '.');
  return limpo || null;
}

/**
 * Arquivo BINÁRIO servido pela API — o zip do contador, o XML da compra.
 *
 * Irmão de `apiDocument`, e a diferença entre os dois é a razão deste existir:
 * `apiDocument` termina em `res.text()`, e `text()` é DECODIFICAÇÃO. Um zip
 * que passa por ali volta com cada byte que não é UTF-8 válido trocado por
 * U+FFFD — o arquivo baixa, tem tamanho, tem nome, e o Windows recusa abrir.
 * Aqui o corpo vira `Blob`, que é o byte como veio do fio.
 *
 * A mesma dança de token e renovação do resto do cliente, e ela não é
 * opcional: `authMiddleware` lê o token SÓ do cabeçalho `Authorization` — não
 * há cookie nem `?token=`. É por isso que baixar por `<a href>` ou
 * `window.open` recebe 401: janela aberta assim não manda cabeçalho nenhum.
 *
 * O NOME vem do `Content-Disposition`, que o servidor precisa expor ao
 * JavaScript por `exposedHeaders` no CORS (ver `server/src/app.ts`). Sem
 * aquela linha o navegador filtra o cabeçalho antes de ele chegar aqui, e o
 * `nomePadrao` é o que impede o arquivo de cair na pasta de downloads com
 * nome de identificador. Ele cobre também proxy que remove cabeçalho.
 */
export async function apiBinary(path: string, nomePadrao: string): Promise<ArquivoDaApi> {
  const perform = async (token: string | null): Promise<Response> =>
    fetch(`${baseUrl()}${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });

  const escopo = escopoDoEnvio();
  const tokenUsado = getSession()?.accessToken ?? null;
  let res = await perform(tokenUsado);
  // O mesmo 401 de `apiRequest`: repete com o token de agora, nunca em outra operação.
  if (res.status === 401 && getSession()) {
    const renewed = await sessaoParaRepetir(tokenUsado, escopo);
    if (renewed) res = await perform(renewed.accessToken);
  }

  if (!res.ok) {
    /*
      O corpo de ERRO continua sendo JSON, e lê-lo como texto não custa nada:
      só o corpo de SUCESSO é binário.

      O `code` é o que a tela precisa: é ele que separa "esta nota não existe"
      de "esta nota existe e o arquivo nunca foi guardado", que são duas
      frases muito diferentes para quem está na doca com a carga na mesa.
    */
    let code = 'API_ERROR';
    let message = 'Falha ao baixar o arquivo.';
    try {
      const payload = JSON.parse(await res.text()) as {
        error?: { code?: string; message?: string };
      };
      code = payload.error?.code ?? code;
      message = payload.error?.message ?? message;
    } catch {
      // Resposta não-JSON: fica a mensagem genérica.
    }
    throw new ApiRequestError(code, message, res.status);
  }

  return {
    blob: await res.blob(),
    nomeArquivo: nomeDoCabecalho(res.headers.get('content-disposition')) ?? nomePadrao,
    contentType: res.headers.get('content-type') ?? 'application/octet-stream',
    headers: res.headers,
  };
}

// -------------------------------------------------------------------- login

export async function login(
  loginName: string,
  password: string,
  companyId?: string,
): Promise<StoredSession> {
  const body = await apiRequest<{
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
    user: SessionUser;
    company: SessionCompany;
    companies: (SessionCompany & { profileCode: string })[];
    access?: AcessoDaSessao;
  }>('/auth/login', {
    method: 'POST',
    anonymous: true,
    body: { login: loginName, password, companyId },
  });

  const next: StoredSession = {
    accessToken: body.accessToken,
    refreshToken: body.refreshToken,
    expiresAt: Date.now() + body.expiresIn * 1000,
    user: body.user,
    company: body.company,
    companies: body.companies ?? [],
    access: body.access,
  };
  setSession(next, 'LOGIN', 'client.login');
  return next;
}

/**
 * Terminal confiável: troca um token de dispositivo por uma sessão real.
 *
 * É o único caminho que dispensa digitar senha, e não é acesso anônimo — o
 * token é emitido por um administrador ao registrar o terminal, e é revogável.
 */
export async function loginWithDeviceToken(deviceToken: string): Promise<StoredSession> {
  const body = await apiRequest<{
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
    user: SessionUser;
    company: SessionCompany;
    access?: AcessoDaSessao;
  }>('/auth/device/login', {
    method: 'POST',
    anonymous: true,
    body: { deviceToken },
  });

  const next: StoredSession = {
    accessToken: body.accessToken,
    refreshToken: body.refreshToken,
    expiresAt: Date.now() + body.expiresIn * 1000,
    user: body.user,
    company: body.company,
    companies: [],
    access: body.access,
  };
  setSession(next, 'DEVICE_LOGIN', 'client.loginWithDeviceToken');
  return next;
}

/**
 * Troca a PRÓPRIA senha — `POST /auth/password`, a saída da senha provisória.
 *
 * O corpo leva as duas credenciais que o servidor exige: a sessão (token) e a
 * SENHA ATUAL, conferida lá antes de qualquer escrita. Sucesso é 204.
 *
 * Dois desvios do caminho autenticado padrão, os dois de propósito:
 *
 * - O token vai À MÃO (`anonymous` + header), fora da dança de refresh do
 *   `apiRequest`: NESTA rota, 401 significa "senha atual incorreta", não
 *   "access token vencido". O retry padrão leria o 401, renovaria a sessão e
 *   REENVIARIA a mesma senha errada — um refresh queimado por tentativa, para
 *   receber o mesmo erro. Aqui o 401 chega à tela como veio, com a mensagem
 *   do servidor.
 *
 * - Quem chama precisa saber o que sobra da sessão: a troca sobe
 *   `session_version` no servidor, o que REVOGA todos os refresh tokens —
 *   inclusive o desta sessão (decisão de lá: se a troca foi porque a senha
 *   vazou, a sessão do ladrão não sobrevive ao gesto, e não há como derrubar
 *   só "as outras"). O access atual também cai na requisição seguinte — o
 *   servidor confere a versão da sessão a cada uma (GAP-PRD-053). Quem fecha o ciclo é o fluxo de login,
 *   relogando com a senha nova (ver `LoginPage.submitTrocaSenha`).
 */
export async function trocarPropriaSenha(
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const current = getSession();
  if (!current) {
    throw new ApiRequestError('API_INVALID_TOKEN', 'Sessão encerrada. Entre novamente.', 401);
  }
  await apiRequest<undefined>('/auth/password', {
    method: 'POST',
    anonymous: true,
    headers: { Authorization: `Bearer ${current.accessToken}` },
    body: { currentPassword, newPassword },
  });
}

/**
 * Sai — e a sessão sai também no servidor.
 *
 * O refresh do corpo é lido NA HORA de cada envio (RES-SESSAO). Montado antes
 * da chamada, como era, ele envelhecia no caminho: com o access vencido (mais
 * de uma hora parado), o primeiro envio toma 401, `apiRequest` renova (R1 vira
 * R2) e repete — e a repetição levava R1, que a renovação acabou de matar,
 * enquanto R2 ficava vivo por até sete dias. O servidor também encerra a
 * família inteira da sessão pelo token, e o corpo certo cobre a sessão emitida
 * antes daquele conserto, que não tem família.
 */
export async function logout(): Promise<void> {
  const current = getSession();
  if (current) {
    let chegou = false;
    try {
      await apiRequest('/auth/logout', {
        method: 'POST',
        corpoNaHora: () => ({ refreshToken: refreshDeAgora() ?? current.refreshToken }),
      });
      chegou = true;
    } catch {
      // Segue para a saída pelo refresh; a local acontece de qualquer forma.
    }
    /*
      A SAÍDA PELO REFRESH (R2-SESSAO). Com o access vencido e a renovação
      indisponível (429, 5xx), o envio acima não chega: o servidor pede access
      válido, e renovar não deu. A família ficava viva por até sete dias. O
      servidor aceita encerrar só pelo refresh do corpo quando não há access
      válido — então vai sem `Authorization`, com o refresh de agora.
    */
    if (!chegou) await sairPeloRefresh(refreshDeAgora() ?? current.refreshToken);
  }
  setSession(null, 'LOGOUT', 'client.logout');
}

async function sairPeloRefresh(refreshToken: string): Promise<void> {
  if (!refreshToken) return;
  try {
    await fetch(`${baseUrl()}/auth/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
  } catch {
    // Rede fora: não há como avisar o servidor agora; a saída local acontece.
  }
}

/**
 * Troca a operação ativa — sempre por escolha explícita de quem opera.
 *
 * O `target ?? current.company` que existia aqui era um buraco de tenant: o
 * servidor emitia token para `companyId`, e a tela continuava mostrando a
 * empresa anterior porque a nova não estava na lista. A pessoa via "PJ Motors"
 * e vendia na Me Mimei. Agora, empresa fora da lista de vínculos é erro — não
 * se troca para uma operação que a sessão não conhece.
 */
export async function switchCompany(companyId: string): Promise<StoredSession | null> {
  const current = getSession();
  if (!current) return null;

  // Trocar para a operação em que já se está não é troca. Sem isto, um evento
  // de `change` disparado sem escolha humana — restauração de formulário pelo
  // navegador, por exemplo — viraria token novo e recarga de página.
  if (companyId === current.company.id) return current;

  const target = current.companies.find((c) => c.id === companyId);
  if (!target) {
    throw new ApiRequestError(
      'API_TENANT_UNKNOWN',
      'Operação não está entre as desta sessão. Entre novamente para atualizar seus acessos.',
      403,
    );
  }

  /*
    A PROVA DA SESSÃO (R2-SESSAO): o servidor só troca com o refresh atual no
    corpo — sem ele, um access furtado virava refresh de sete dias. Lido NA
    HORA de cada envio: se o primeiro toma 401 e o cliente renova, a repetição
    leva o refresh novo, e não o que a renovação acabou de matar.
  */
  const body = await apiRequest<{
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
    access?: AcessoDaSessao;
  }>('/auth/switch-company', {
    method: 'POST',
    corpoNaHora: () => ({ companyId, refreshToken: refreshDeAgora() ?? current.refreshToken }),
  });

  const next: StoredSession = {
    ...current,
    accessToken: body.accessToken,
    refreshToken: body.refreshToken,
    expiresAt: Date.now() + body.expiresIn * 1000,
    company: target,
    // O perfil é DO VÍNCULO, não da pessoa: gestor na PJ Motors pode ser
    // mecânico na Me Mimei. O token novo já veio com o perfil do destino
    // (o servidor emite pelo vínculo); sem esta linha, a cópia guardada
    // ficava com o perfil da empresa ANTERIOR — e é ela que o menu e os
    // guardas de tela leem. Era o "adm enxerga o painel da outra loja".
    user: { ...current.user, profileCode: target.profileCode },
    access: body.access,
  };
  setSession(next, 'EXPLICIT_OPERATION_CHANGE', 'client.switchCompany');
  return next;
}
