/**
 * ============================================================================
 * DUAS ABAS, UMA SESSÃO — E O LOGOUT QUE CHEGA AO SERVIDOR (R2-SESSAO)
 * ============================================================================
 *
 * A sessão do cliente vivia em memória, uma cópia por aba, e o `localStorage`
 * era só o lugar de onde a aba a lia ao abrir. Ninguém ouvia o evento
 * `storage`. Com o PDV numa aba e o escritório noutra:
 *
 *   - as duas renovavam com o MESMO refresh; o servidor rotaciona, então a que
 *     chegava depois tomava 401 — e chamava `setSession(null)`, que APAGAVA do
 *     `localStorage` o refresh novo que a vizinha acabara de gravar. O caixa
 *     caía no login, e o escritório também, no próximo recarregar;
 *   - o logout numa aba não chegava à outra: ela seguia com a sessão na
 *     memória até o próximo 401;
 *   - com o access vencido e a renovação indisponível (429, 5xx), o logout não
 *     alcançava o servidor — a rota exigia access válido — e a família da
 *     sessão ficava viva por até sete dias.
 *
 * "Duas abas" aqui são DUAS INSTÂNCIAS do módulo (`vi.resetModules`), cada uma
 * com a sua memória, sobre o MESMO `localStorage` e o mesmo servidor dublado.
 * O evento `storage` que o navegador entrega à outra aba é disparado à mão —
 * ou NÃO é, quando o caso é justamente o do evento que ainda não chegou.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Cliente = typeof import('../client');
type Sessao = import('../client').StoredSession;

const CHAVE = 'gs.session';

function token(companyId: string, marca: string): string {
  const corpo = btoa(JSON.stringify({ sub: 'u-1', companyId, marca }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `cabecalho.${corpo}.assinatura`;
}

const T1 = token('c-1', 'um');
const T2 = token('c-1', 'dois');
const TB = token('c-2', 'outra-operacao');

function sessao(accessToken: string, refreshToken: string, companyId = 'c-1'): Sessao {
  return {
    accessToken,
    refreshToken,
    expiresAt: Date.now() - 1000,
    user: { id: 'u-1', login: 'caixa', displayName: 'Caixa', profileCode: 'gerente_loja' },
    company: { id: companyId, slug: companyId, tradeName: companyId, kind: 'retail' },
    companies: [
      { id: 'c-1', slug: 'c-1', tradeName: 'c-1', kind: 'retail', profileCode: 'gerente_loja' },
      { id: 'c-2', slug: 'c-2', tradeName: 'c-2', kind: 'retail', profileCode: 'gerente_loja' },
    ],
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const RECUSADO = () => json(401, { error: { code: 'API_INVALID_TOKEN', message: 'Refresh token inválido.' } });
const VENCIDO = () => json(401, { error: { code: 'API_SESSION_ENDED', message: 'Sessão encerrada.' } });

type Chamada = { caminho: string; token: string; corpo: Record<string, unknown> | undefined };

function servidor(rotas: (c: Chamada) => Response | Promise<Response>): Chamada[] {
  const chamadas: Chamada[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { headers?: Record<string, string>; body?: string }) => {
      const chamada: Chamada = {
        caminho: new URL(url).pathname.replace(/^\/api\/v1/, ''),
        token: (init?.headers?.Authorization ?? '').replace(/^Bearer /, ''),
        corpo: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
      };
      chamadas.push(chamada);
      return rotas(chamada);
    }),
  );
  return chamadas;
}

/**
 * Uma aba nova: o módulo do zero, com memória própria, lendo o storage comum.
 *
 * A recarga nasce trocada por um dublê em TODA aba aberta aqui: as abas dos
 * casos anteriores continuam ouvindo o mesmo `window`, e a de verdade
 * (`location.reload`) derruba a navegação do jsdom. O caso que confere a
 * recarga troca o dublê da aba que ele observa.
 */
async function abrirAba(): Promise<Cliente> {
  vi.resetModules();
  const cliente = await import('../client');
  cliente.definirRecargaDaAbaParaTestes(() => undefined);
  cliente.getSession();
  return cliente;
}

/**
 * Web Locks de mentira, COMPARTILHADO entre as abas (como o do navegador é
 * entre as abas da mesma origem): uma fila por nome.
 */
function instalarTrancaEntreAbas(): void {
  let fila: Promise<unknown> = Promise.resolve();
  const locks = {
    request<T>(_nome: string, _opcoes: { signal?: AbortSignal }, fn: () => Promise<T>): Promise<T> {
      const vez = fila.then(() => fn());
      fila = vez.catch(() => undefined);
      return vez;
    },
  };
  Object.defineProperty(window.navigator, 'locks', { value: locks, configurable: true });
}

/**
 * A tranca que OUTRA aba segura e não solta (a renovação dela pendurou num
 * `fetch` sem resposta): nunca é concedida; só desiste, como a do navegador,
 * quando o sinal de quem espera aborta.
 */
function instalarTrancaPresaNoutraAba(): void {
  const locks = {
    request<T>(_nome: string, opcoes: { signal?: AbortSignal }): Promise<T> {
      return new Promise<T>((_resolver, rejeitar) => {
        opcoes.signal?.addEventListener('abort', () => rejeitar(new DOMException('Desistiu da espera.', 'AbortError')));
      });
    },
  };
  Object.defineProperty(window.navigator, 'locks', { value: locks, configurable: true });
}

/** O que o navegador faz na OUTRA aba quando esta grava no `localStorage`. */
function entregarEventoDoStorage(antes: string | null): void {
  window.dispatchEvent(
    new StorageEvent('storage', {
      key: CHAVE,
      oldValue: antes,
      newValue: localStorage.getItem(CHAVE),
      storageArea: localStorage,
    }),
  );
}

function guardado(): Sessao | null {
  const bruto = localStorage.getItem(CHAVE);
  return bruto ? (JSON.parse(bruto) as Sessao) : null;
}

function adiada<T>() {
  let resolver!: (v: T) => void;
  const promessa = new Promise<T>((r) => {
    resolver = r;
  });
  return { promessa, resolver };
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(CHAVE, JSON.stringify(sessao(T1, 'R1')));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window.navigator, 'locks');
  localStorage.clear();
});

describe('a corrida da rotação entre duas abas', () => {
  it('a vizinha já renovou e o evento ainda não chegou: a aba ADOTA a sessão guardada, sem queimar outra renovação', async () => {
    const chamadas = servidor((c) => {
      if (c.caminho === '/auth/refresh') {
        return c.corpo?.refreshToken === 'R1'
          && chamadas.filter((x) => x.caminho === '/auth/refresh').length === 1
          ? json(200, { accessToken: T2, refreshToken: 'R2', expiresIn: 3600 })
          : RECUSADO();
      }
      return c.token === T2 ? json(200, { items: ['ok'] }) : VENCIDO();
    });
    const pdv = await abrirAba();
    const escritorio = await abrirAba();

    // O escritório renova primeiro (R1 → R2) e grava no storage comum.
    await escritorio.apiRequest('/core/pdv/produtos');
    expect(guardado()?.refreshToken).toBe('R2');

    // O PDV ainda tem R1 na memória: o 401 dele NÃO pode virar outra renovação
    // com R1 — e muito menos apagar o R2 do storage.
    const corpo = await pdv.apiRequest<{ items: string[] }>('/core/pdv/produtos');

    expect(corpo.items).toEqual(['ok']);
    expect(chamadas.filter((c) => c.caminho === '/auth/refresh')).toHaveLength(1);
    expect(pdv.getSession()?.refreshToken).toBe('R2');
    expect(escritorio.getSession()?.refreshToken).toBe('R2');
    expect(guardado()?.refreshToken).toBe('R2');
  });

  it('as duas renovam ao mesmo tempo: a que perde toma 401, confere o storage e adota a vizinha — ninguém cai', async () => {
    const vencedora = adiada<Response>();
    const perdedora = adiada<Response>();
    let renovacoes = 0;
    servidor((c) => {
      if (c.caminho === '/auth/refresh') {
        renovacoes += 1;
        return renovacoes === 1 ? vencedora.promessa : perdedora.promessa;
      }
      return c.token === T2 ? json(200, { items: ['ok'] }) : VENCIDO();
    });
    const pdv = await abrirAba();
    const escritorio = await abrirAba();

    const noPdv = pdv.apiRequest<{ items: string[] }>('/core/pdv/produtos');
    const noEscritorio = escritorio.apiRequest<{ items: string[] }>('/core/pdv/produtos');

    // As duas saíram com R1 antes de qualquer resposta.
    await vi.waitFor(() => expect(renovacoes).toBe(2));
    vencedora.resolver(json(200, { accessToken: T2, refreshToken: 'R2', expiresIn: 3600 }));
    await vi.waitFor(() => expect(guardado()?.refreshToken).toBe('R2'));
    // O servidor já rotacionou: o R1 da segunda é recusado.
    perdedora.resolver(RECUSADO());

    expect((await noPdv).items).toEqual(['ok']);
    expect((await noEscritorio).items).toEqual(['ok']);
    expect(pdv.getSession()?.refreshToken).toBe('R2');
    expect(escritorio.getSession()?.refreshToken).toBe('R2');
    // Antes: a perdedora apagava o storage — e o R2 da vizinha ia junto.
    expect(guardado()?.refreshToken).toBe('R2');
  });

  it('com Web Locks: as duas renovam ao mesmo tempo e só UMA vai à rede — a segunda acha o refresh novo no storage', async () => {
    instalarTrancaEntreAbas();
    let renovacoes = 0;
    servidor((c) => {
      if (c.caminho === '/auth/refresh') {
        renovacoes += 1;
        return c.corpo?.refreshToken === 'R1' && renovacoes === 1
          ? json(200, { accessToken: T2, refreshToken: 'R2', expiresIn: 3600 })
          : RECUSADO();
      }
      return c.token === T2 ? json(200, { items: ['ok'] }) : VENCIDO();
    });
    const pdv = await abrirAba();
    const escritorio = await abrirAba();

    const [noPdv, noEscritorio] = await Promise.all([
      pdv.apiRequest<{ items: string[] }>('/core/pdv/produtos'),
      escritorio.apiRequest<{ items: string[] }>('/core/pdv/produtos'),
    ]);

    expect(noPdv.items).toEqual(['ok']);
    expect(noEscritorio.items).toEqual(['ok']);
    // Sem a tranca, as duas iam à rede com R1 e a segunda tomava 401.
    expect(renovacoes).toBe(1);
    expect(guardado()?.refreshToken).toBe('R2');
  });

  it('com Web Locks presa noutra aba (fetch pendurado): passado o limite, esta renova sem a tranca — não fica presa junto', async () => {
    instalarTrancaPresaNoutraAba();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      servidor((c) => {
        if (c.caminho === '/auth/refresh') return json(200, { accessToken: T2, refreshToken: 'R2', expiresIn: 3600 });
        return c.token === T2 ? json(200, { items: ['ok'] }) : VENCIDO();
      });
      const aba = await abrirAba();

      const pedido = aba.apiRequest<{ items: string[] }>('/core/pdv/produtos');
      await vi.advanceTimersByTimeAsync(10_000);

      expect((await pedido).items).toEqual(['ok']);
      expect(guardado()?.refreshToken).toBe('R2');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a vizinha trocou de operação: a requisição que estava no ar NÃO é repetida na operação nova, e o storage fica', async () => {
    const chamadas = servidor((c) => {
      if (c.caminho === '/auth/refresh') return RECUSADO();
      return c.token === T1 ? VENCIDO() : json(201, { gravadaEm: c.token });
    });
    const pdv = await abrirAba();
    const recargas = vi.fn();
    pdv.definirRecargaDaAbaParaTestes(recargas);

    // O escritório trocou para c-2 (o servidor encerrou a família em c-1).
    localStorage.setItem(CHAVE, JSON.stringify(sessao(TB, 'RB', 'c-2')));

    const erro = await pdv
      .apiRequest('/core/sales', { method: 'POST', body: { itens: [] }, idempotencyKey: 'k-1' })
      .catch((e: unknown) => e);

    expect((erro as { code?: string }).code).toBe('API_SESSION_SCOPE_CHANGED');
    expect(chamadas.filter((c) => c.caminho === '/core/sales')).toHaveLength(1);
    expect(guardado()?.company.id).toBe('c-2');
    expect(pdv.getSession()?.company.id).toBe('c-2');
    // A tela foi montada para c-1: ela recomeça na operação nova.
    expect(recargas).toHaveBeenCalledTimes(1);
  });

  it('a renovação recusada de verdade (o storage ainda é o MEU refresh): aí sim a sessão sai', async () => {
    servidor((c) => (c.caminho === '/auth/refresh' ? RECUSADO() : VENCIDO()));
    const aba = await abrirAba();
    const erro = await aba.apiRequest('/core/pdv/produtos').catch((e: unknown) => e);
    expect((erro as { status?: number }).status).toBe(401);
    expect(aba.getSession()).toBeNull();
    expect(guardado()).toBeNull();
  });
});

/*
  SEM WEB LOCKS (verificação do R2-SESSAO). `navigator.locks` só existe em
  contexto seguro — HTTPS ou localhost —, e o PDV aberto pelo IP da rede
  (`http://192.168.0.10:3000`, ver `src/lib/uuid.ts`) não é: na loja, a tranca
  entre abas nunca entra, e a corrida abaixo é a de todo dia, não a de um
  navegador antigo. O caso de cima resolvia a vencedora ANTES de responder à
  perdedora — a ordem boa. Aqui, a ordem ruim: o servidor rotacionou na
  primeira, e o 401 da segunda chega enquanto a primeira ainda lê a resposta.
*/
describe('sem Web Locks: o 401 da perdedora chega antes de a vencedora gravar', () => {
  it('a perdedora espera a vizinha terminar e adota o refresh novo — nenhuma das duas cai no login', async () => {
    const vencedora = adiada<Response>();
    let renovacoes = 0;
    servidor((c) => {
      if (c.caminho === '/auth/refresh') {
        renovacoes += 1;
        // A primeira já rotacionou R1 no servidor; a resposta dela está a caminho.
        return renovacoes === 1 ? vencedora.promessa : RECUSADO();
      }
      return c.token === T2 ? json(200, { items: ['ok'] }) : VENCIDO();
    });
    const pdv = await abrirAba();
    const escritorio = await abrirAba();
    const quedas: string[] = [];
    pdv.subscribeSession((s) => {
      if (!s) quedas.push('pdv');
    });
    escritorio.subscribeSession((s) => {
      if (!s) quedas.push('escritorio');
    });

    const noPdv = pdv.apiRequest<{ items: string[] }>('/core/pdv/produtos');
    await vi.waitFor(() => expect(renovacoes).toBe(1));
    const antes = localStorage.getItem(CHAVE);
    const noEscritorio = escritorio
      .apiRequest<{ items: string[] }>('/core/pdv/produtos')
      .catch((e: unknown) => e);
    await vi.waitFor(() => expect(renovacoes).toBe(2));
    // O 401 da perdedora já chegou: o tempo de ela reagir.
    await new Promise((r) => {
      setTimeout(r, 200);
    });
    // O que ela apagou, o navegador entrega à vizinha — que ainda espera a resposta.
    if (localStorage.getItem(CHAVE) !== antes) entregarEventoDoStorage(antes);

    const antesDaVencedora = localStorage.getItem(CHAVE);
    vencedora.resolver(json(200, { accessToken: T2, refreshToken: 'R2', expiresIn: 3600 }));
    await vi.waitFor(() => expect(guardado()?.refreshToken).toBe('R2'));
    entregarEventoDoStorage(antesDaVencedora);

    expect((await noPdv).items).toEqual(['ok']);
    expect(await noEscritorio).toEqual({ items: ['ok'] });
    // Antes: a perdedora apagava o storage e caía; o evento derrubava a vizinha.
    expect(quedas).toEqual([]);
    expect(pdv.getSession()?.refreshToken).toBe('R2');
    expect(escritorio.getSession()?.refreshToken).toBe('R2');
    expect(guardado()?.refreshToken).toBe('R2');
  });

  it('a vizinha também é recusada: a espera acaba quando ela termina, e aí as duas saem', async () => {
    const primeira = adiada<Response>();
    let renovacoes = 0;
    servidor((c) => {
      if (c.caminho === '/auth/refresh') {
        renovacoes += 1;
        return renovacoes === 1 ? primeira.promessa : RECUSADO();
      }
      return VENCIDO();
    });
    const pdv = await abrirAba();
    const escritorio = await abrirAba();

    const noPdv = pdv.apiRequest('/core/pdv/produtos').catch((e: unknown) => e);
    await vi.waitFor(() => expect(renovacoes).toBe(1));
    const noEscritorio = escritorio.apiRequest('/core/pdv/produtos').catch((e: unknown) => e);
    await vi.waitFor(() => expect(renovacoes).toBe(2));
    await new Promise((r) => {
      setTimeout(r, 150);
    });
    // Enquanto a vizinha não responde, a sessão guardada não é apagada.
    expect(guardado()?.refreshToken).toBe('R1');

    primeira.resolver(RECUSADO());

    expect((await noPdv as { status?: number }).status).toBe(401);
    expect((await noEscritorio as { status?: number }).status).toBe(401);
    expect(pdv.getSession()).toBeNull();
    expect(escritorio.getSession()).toBeNull();
    expect(guardado()).toBeNull();
  });
});

describe('o evento storage mantém a memória da aba igual ao que foi guardado', () => {
  it('o logout numa aba chega à outra', async () => {
    servidor((c) => (c.caminho === '/auth/logout' ? new Response(null, { status: 204 }) : json(404, {})));
    const pdv = await abrirAba();
    const escritorio = await abrirAba();
    const ouvinte = vi.fn();
    pdv.subscribeSession(ouvinte);

    const antes = localStorage.getItem(CHAVE);
    await escritorio.logout();
    entregarEventoDoStorage(antes);

    expect(escritorio.getSession()).toBeNull();
    expect(pdv.getSession()).toBeNull();
    expect(ouvinte).toHaveBeenCalledWith(null);
  });

  it('a renovação feita numa aba chega à outra sem rede', async () => {
    const chamadas = servidor((c) => {
      if (c.caminho === '/auth/refresh') return json(200, { accessToken: T2, refreshToken: 'R2', expiresIn: 3600 });
      return c.token === T2 ? json(200, { items: ['ok'] }) : VENCIDO();
    });
    const pdv = await abrirAba();
    const escritorio = await abrirAba();

    const antes = localStorage.getItem(CHAVE);
    await escritorio.apiRequest('/core/pdv/produtos');
    entregarEventoDoStorage(antes);

    expect(pdv.getSession()?.refreshToken).toBe('R2');
    await pdv.apiRequest('/core/pdv/produtos');
    const doPdv = chamadas.slice(-1)[0];
    expect(doPdv).toMatchObject({ caminho: '/core/pdv/produtos', token: T2 });
    expect(chamadas.filter((c) => c.caminho === '/auth/refresh')).toHaveLength(1);
  });

  it('a troca de operação feita noutra aba: a vizinha acompanha e recomeça a tela na operação nova', async () => {
    servidor(() => json(404, {}));
    const pdv = await abrirAba();
    const recargas = vi.fn();
    pdv.definirRecargaDaAbaParaTestes(recargas);

    const antes = localStorage.getItem(CHAVE);
    localStorage.setItem(CHAVE, JSON.stringify(sessao(TB, 'RB', 'c-2')));
    entregarEventoDoStorage(antes);

    expect(pdv.getSession()?.company.id).toBe('c-2');
    expect(recargas).toHaveBeenCalledTimes(1);
  });
});

describe('o logout chega ao servidor mesmo sem access válido', () => {
  it('access vencido e renovação 429: o logout sai pelo refresh do corpo, sem Authorization', async () => {
    const chamadas = servidor((c) => {
      if (c.caminho === '/auth/refresh') return json(429, { error: { code: 'RATE_LIMITED', message: 'Too many requests' } });
      if (c.caminho === '/auth/logout') return c.token ? VENCIDO() : new Response(null, { status: 204 });
      return json(404, {});
    });
    const aba = await abrirAba();

    await aba.logout();

    const saidas = chamadas.filter((c) => c.caminho === '/auth/logout');
    // Antes: uma saída só, com o access vencido, e a família ficava viva.
    expect(saidas.some((c) => c.token === '' && c.corpo?.refreshToken === 'R1')).toBe(true);
    expect(aba.getSession()).toBeNull();
    expect(guardado()).toBeNull();
  });

  it('servidor fora do ar na renovação (502): idem', async () => {
    const chamadas = servidor((c) => {
      if (c.caminho === '/auth/refresh') return new Response('<html>Bad Gateway</html>', { status: 502 });
      if (c.caminho === '/auth/logout') return c.token ? VENCIDO() : new Response(null, { status: 204 });
      return json(404, {});
    });
    const aba = await abrirAba();
    await aba.logout();
    expect(chamadas.filter((c) => c.caminho === '/auth/logout' && c.token === '')).toHaveLength(1);
  });
});

describe('a troca de operação leva a prova da sessão', () => {
  it('o corpo leva o refresh de agora, lido na hora do envio', async () => {
    const chamadas = servidor((c) =>
      c.caminho === '/auth/switch-company'
        ? json(200, { accessToken: TB, refreshToken: 'RB', expiresIn: 3600 })
        : json(404, {}),
    );
    const aba = await abrirAba();

    await aba.switchCompany('c-2');

    const troca = chamadas.find((c) => c.caminho === '/auth/switch-company');
    expect(troca).toMatchObject({ token: T1, corpo: { companyId: 'c-2', refreshToken: 'R1' } });
    expect(aba.getSession()?.company.id).toBe('c-2');
  });

  it('access vencido: renova, e a repetição da troca leva o refresh NOVO', async () => {
    const chamadas = servidor((c) => {
      if (c.caminho === '/auth/refresh') return json(200, { accessToken: T2, refreshToken: 'R2', expiresIn: 3600 });
      if (c.caminho === '/auth/switch-company') {
        return c.token === T1 ? VENCIDO() : json(200, { accessToken: TB, refreshToken: 'RB', expiresIn: 3600 });
      }
      return json(404, {});
    });
    const aba = await abrirAba();

    await aba.switchCompany('c-2');

    const trocas = chamadas.filter((c) => c.caminho === '/auth/switch-company');
    expect(trocas).toHaveLength(2);
    expect(trocas[1]).toMatchObject({ token: T2, corpo: { companyId: 'c-2', refreshToken: 'R2' } });
  });
});
