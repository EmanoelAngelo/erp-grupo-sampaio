/**
 * ============================================================================
 * A FILA DO BALCÃO NÃO MENTE (G-offline-sync-M02 / 05 / 06 / 04 / 13 / 17)
 * ============================================================================
 *
 * O que estes casos cobram, cada um com o defeito que o motivou:
 *
 *   M02  o armazenamento recusou a gravação e a venda sumia com a tela dizendo
 *        "Venda guardada — NÃO refaça": agora é `API_QUEUE_UNAVAILABLE`, e a
 *        fila não mostra venda fantasma;
 *   05   502/503/504 do proxy ou túnel não guardavam a venda (a fila só entrava
 *        quando o `fetch` lançava exceção);
 *   06   a venda não tinha prazo (spinner eterno com o servidor travado) e,
 *        recarregada a tela no meio do envio, perdia a chave;
 *   04   a requisição que não chega ao servidor avisa a barra de conexão;
 *   13   a fila escuta a gravação das OUTRAS abas;
 *   17   o código curto que casa o comprovante offline com a venda.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EVENTO_SERVIDOR_SEM_RESPOSTA, apiRequest } from '../client';
import {
  PRAZO_DA_VENDA_MS,
  codigoDaVendaGuardada,
  isNetworkFailure,
  marcarEmEnvio,
  queued,
  recuperarEnviosInterrompidos,
  subscribeQueue,
} from '../offlineQueue';

function venda(chave: string) {
  return apiRequest('/core/sales', {
    method: 'POST',
    body: { items: [{ productId: 'p1', quantity: 1 }], payments: [{ method: 'dinheiro', amountCents: 5000 }] },
    idempotencyKey: chave,
    queueWhenOffline: true,
    queueLabel: 'venda do PDV',
    anonymous: true,
  });
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('M02 — sem espaço para guardar, a venda NÃO é dada como guardada', () => {
  it('o setItem recusado vira API_QUEUE_UNAVAILABLE, e ninguém vê venda fantasma na fila', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('A cota do armazenamento acabou.', 'QuotaExceededError');
    });
    const vistos: number[] = [];
    const cancelar = subscribeQueue((f) => vistos.push(f.length));

    await expect(venda('venda-sem-espaco')).rejects.toMatchObject({ code: 'API_QUEUE_UNAVAILABLE', status: 0 });
    expect(queued()).toHaveLength(0);
    // A barra nunca recebeu a lista em memória com a venda que não foi gravada.
    expect(vistos.every((n) => n === 0)).toBe(true);
    cancelar();
  });

  it('a mensagem diz que a venda NÃO foi registrada e que o carrinho continua', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('cheio', 'QuotaExceededError');
    });
    const erro = (await venda('venda-sem-espaco-2').catch((e: unknown) => e)) as Error;
    expect(erro.message).toMatch(/NÃO foi registrada/);
    expect(erro.message).toMatch(/carrinho continua/);
  });
});

describe('05 — o proxy que responde no lugar da API também guarda a venda', () => {
  it.each([
    [502, 'text/html', '<html><body>502 Bad Gateway</body></html>'],
    [503, 'application/json', JSON.stringify({ error: { code: 'X', message: 'fora' } })],
    [504, 'text/html', '<html>Gateway Timeout</html>'],
  ])('%i: a venda entra na fila com a mesma chave', async (status, tipo, corpo) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(corpo, { status, headers: { 'Content-Type': tipo } })));
    await expect(venda(`venda-${status}`)).rejects.toMatchObject({ code: 'API_QUEUED_OFFLINE' });
    expect(queued().map((q) => q.idempotencyKey)).toEqual([`venda-${status}`]);
  });

  it('500 da própria API (JSON) é erro, e não fila', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { code: 'CORE_BOOM', message: 'erro interno' } }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    await expect(venda('venda-500')).rejects.toMatchObject({ code: 'CORE_BOOM', status: 500 });
    expect(queued()).toHaveLength(0);
  });

  it('consulta com 502 continua sendo erro (só a venda vai para a fila)', async () => {
    /*
      O código mudou com o G-offline-sync-R01: era `API_INVALID_RESPONSE` ("O
      servidor respondeu algo que não é JSON…"), uma frase que não dizia que o
      servidor da loja estava fora. O que este caso prova continua igual — a
      consulta é erro, e não vai para a fila.
    */
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>502</html>', { status: 502 })));
    await expect(apiRequest('/core/products', { anonymous: true })).rejects.toMatchObject({
      code: 'API_SERVER_UNREACHABLE',
      status: 502,
    });
    expect(queued()).toHaveLength(0);
  });
});

describe('R01 — o 502/503/504 da CONSULTA, atrás de proxy, é "sem conexão" e avisa a barra', () => {
  /*
    O DEFEITO: o aviso à barra saía só na falha de rede e no 502/503/504 da
    venda. A busca que recebia a página 502 do proxy virava
    `API_INVALID_RESPONSE`, sem aviso: nenhuma faixa acendia com a fila vazia,
    e o PDV (que pergunta `isNetworkFailure`) não dizia "sem conexão".
  */
  it.each([
    [502, '<html><body><h1>502 Bad Gateway</h1></body></html>'],
    [503, '<html>Service Unavailable</html>'],
    [504, ''],
  ])('%i com página do proxy (ou sem corpo): erro de sem conexão, com o status real, e a barra avisada', async (status, corpo) => {
    const avisos = vi.fn();
    window.addEventListener(EVENTO_SERVIDOR_SEM_RESPOSTA, avisos);
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(corpo || null, { status, headers: { 'Content-Type': 'text/html' } })),
      );
      const erro = (await apiRequest('/core/products/search?q=7891', { anonymous: true }).catch(
        (e: unknown) => e,
      )) as Error & { code?: string; status?: number };
      expect(erro).toMatchObject({ code: 'API_SERVER_UNREACHABLE', status });
      expect(erro.message).toContain(`HTTP ${status}`);
      if (status === 504) {
        /*
          Revisão do R01: o 504 é o proxy desistindo de esperar — o servidor de
          trás pode ter gravado. A primeira versão dizia "fora do ar ou
          reiniciando. Tente de novo em instantes", o convite para lançar duas
          vezes numa gravação sem chave.
        */
        expect(erro.message).toMatch(/^Sem resposta do servidor da loja/);
        expect(erro.message).toMatch(/confira se entrou antes de repetir/);
        expect(erro.message).not.toMatch(/Tente de novo/);
        expect(erro.message).not.toMatch(/fora do ar/);
      } else {
        expect(erro.message).toMatch(/^Sem conexão com o servidor da loja/);
        expect(erro.message).toMatch(/fora do ar ou reiniciando/);
      }
      expect(isNetworkFailure(erro)).toBe(true);
      expect(avisos).toHaveBeenCalledTimes(1);
      expect(queued()).toHaveLength(0);
    } finally {
      window.removeEventListener(EVENTO_SERVIDOR_SEM_RESPOSTA, avisos);
    }
  });

  it('o 502 que a PRÓPRIA API manda (envelope JSON) continua sendo resposta dela: código e frase dela', async () => {
    const avisos = vi.fn();
    window.addEventListener(EVENTO_SERVIDOR_SEM_RESPOSTA, avisos);
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          new Response(JSON.stringify({ error: { code: 'ASAAS_CONNECTION_FAILED', message: 'Falha de conexão com Asaas.' } }), {
            status: 502,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
      );
      const erro = (await apiRequest('/pdv/pix-asaas', { method: 'POST', body: {}, anonymous: true }).catch(
        (e: unknown) => e,
      )) as Error & { code?: string };
      expect(erro).toMatchObject({ code: 'ASAAS_CONNECTION_FAILED', status: 502, message: 'Falha de conexão com Asaas.' });
      expect(isNetworkFailure(erro)).toBe(false);
      // O aviso só faz a barra PERGUNTAR a /health; a sonda responde que está de pé.
      expect(avisos).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(EVENTO_SERVIDOR_SEM_RESPOSTA, avisos);
    }
  });

  it('500 com página HTML não é gateway: continua `API_INVALID_RESPONSE`, sem aviso à barra', async () => {
    const avisos = vi.fn();
    window.addEventListener(EVENTO_SERVIDOR_SEM_RESPOSTA, avisos);
    try {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>500</html>', { status: 500 })));
      const erro = await apiRequest('/core/products', { anonymous: true }).catch((e: unknown) => e);
      expect(erro).toMatchObject({ code: 'API_INVALID_RESPONSE', status: 500 });
      expect(isNetworkFailure(erro)).toBe(false);
      expect(avisos).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(EVENTO_SERVIDOR_SEM_RESPOSTA, avisos);
    }
  });
});

describe('06 — a venda tem prazo, segura o F5 e sobrevive à tela recarregada', () => {
  function servidorTravado() {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: { signal?: AbortSignal }) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('abortado', 'AbortError')));
          }),
      ),
    );
  }

  it('servidor travado: passado o prazo, a venda vai para a fila com a MESMA chave', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    servidorTravado();
    const pedido = venda('venda-travada').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(PRAZO_DA_VENDA_MS - 1);
    expect(queued()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2);
    expect(await pedido).toMatchObject({ code: 'API_QUEUED_OFFLINE' });
    expect(queued().map((q) => q.idempotencyKey)).toEqual(['venda-travada']);
  });

  it('enquanto a venda está no ar, o navegador pergunta antes de sair, e a venda fica escrita', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    servidorTravado();
    const pedido = venda('venda-no-ar').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);

    const sair = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(sair);
    expect(sair.defaultPrevented).toBe(true);
    expect(localStorage.getItem('gs.fila.emEnvio')).toContain('venda-no-ar');

    await vi.advanceTimersByTimeAsync(PRAZO_DA_VENDA_MS);
    await pedido;
    // Guardada na fila: não está mais no ar, e sair não pergunta mais.
    expect(localStorage.getItem('gs.fila.emEnvio')).toBeNull();
    const depois = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(depois);
    expect(depois.defaultPrevented).toBe(false);
  });

  it('a resposta que chega tira a venda do ar', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ id: 's-1', number: 7 }), { status: 201, headers: { 'Content-Type': 'application/json' } })),
    );
    await expect(venda('venda-que-subiu')).resolves.toMatchObject({ id: 's-1' });
    expect(localStorage.getItem('gs.fila.emEnvio')).toBeNull();
    expect(queued()).toHaveLength(0);
  });

  it('a venda que ficou no ar (tela recarregada) volta para a fila com a mesma chave e a hora dela', () => {
    const agora = Date.now();
    marcarEmEnvio({
      path: '/core/sales',
      method: 'POST',
      body: { items: [] },
      idempotencyKey: 'venda-do-f5',
      label: 'venda do PDV',
      escopo: { userId: 'u-1', companyId: 'c-1' },
    });
    // Antes do prazo com folga ela pode ser de uma aba viva: fica onde está.
    expect(recuperarEnviosInterrompidos(agora + 5_000)).toBe(0);
    expect(queued()).toHaveLength(0);

    expect(recuperarEnviosInterrompidos(agora + PRAZO_DA_VENDA_MS + 15_000)).toBe(1);
    const [item] = queued();
    expect(item).toMatchObject({ idempotencyKey: 'venda-do-f5', escopo: { userId: 'u-1', companyId: 'c-1' } });
    expect(Math.abs(new Date(item.queuedAt).getTime() - agora)).toBeLessThan(2_000);
    // Não volta duas vezes.
    expect(recuperarEnviosInterrompidos(agora + PRAZO_DA_VENDA_MS + 60_000)).toBe(0);
    expect(queued()).toHaveLength(1);
  });

  it('o F5 NESTA aba recupera a venda na hora; a venda no ar de OUTRA aba espera o prazo com folga', () => {
    /*
      Revisão do 06: o F5 no meio de "Finalizando…" cai dentro do prazo, e a
      tela recarregada esperava 30 s desde a saída (mais até 15 s da procura)
      sem dizer nada — o tempo em que o operador bipava tudo de novo com chave
      nova. A página anterior desta aba morreu com o F5: a venda dela é órfã
      já, e a barra precisa mostrá-la guardada assim que a tela abre.
    */
    const agora = Date.now();
    marcarEmEnvio({
      path: '/core/sales',
      method: 'POST',
      body: { items: [] },
      idempotencyKey: 'venda-do-f5-agora',
      label: 'venda do PDV',
    });
    const [daPaginaAnterior] = JSON.parse(localStorage.getItem('gs.fila.emEnvio') ?? '[]') as Record<string, unknown>[];
    expect(daPaginaAnterior.aba).toBeTruthy();
    // A venda de uma aba VIVA (outra aba) e a desta própria página, recém-saídas.
    localStorage.setItem(
      'gs.fila.emEnvio',
      JSON.stringify([
        { ...daPaginaAnterior, pagina: 'a-pagina-antes-do-f5' },
        { ...daPaginaAnterior, idempotencyKey: 'venda-da-outra-aba', aba: 'outra-aba', pagina: 'outra-pagina' },
        { ...daPaginaAnterior, idempotencyKey: 'venda-desta-pagina' },
      ]),
    );

    expect(recuperarEnviosInterrompidos(agora + 1_000)).toBe(1);
    expect(queued().map((q) => q.idempotencyKey)).toEqual(['venda-do-f5-agora']);
    // As duas vivas continuam no ar até o prazo com folga.
    const noAr = (JSON.parse(localStorage.getItem('gs.fila.emEnvio') ?? '[]') as { idempotencyKey: string }[]).map(
      (v) => v.idempotencyKey,
    );
    expect(noAr).toEqual(['venda-da-outra-aba', 'venda-desta-pagina']);
  });
});

describe('04 — a requisição que não chega ao servidor avisa a barra', () => {
  it('falha de rede dispara o aviso; o cancelamento de quem chamou, não', async () => {
    const avisos = vi.fn();
    window.addEventListener(EVENTO_SERVIDOR_SEM_RESPOSTA, avisos);
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: { signal?: AbortSignal }) =>
        init?.signal?.aborted
          ? Promise.reject(new DOMException('abortado', 'AbortError'))
          : Promise.reject(new TypeError('Failed to fetch')),
      ),
    );

    await expect(apiRequest('/core/products/search?q=7891', { anonymous: true })).rejects.toThrow();
    expect(avisos).toHaveBeenCalledTimes(1);

    const controle = new AbortController();
    controle.abort();
    await expect(apiRequest('/core/products/search?q=x', { anonymous: true, signal: controle.signal })).rejects.toThrow();
    expect(avisos).toHaveBeenCalledTimes(1);
    window.removeEventListener(EVENTO_SERVIDOR_SEM_RESPOSTA, avisos);
  });
});

describe('13 — a fila escuta as outras abas', () => {
  it('a gravação de outra aba chega a quem assina a fila', () => {
    const vistos: number[] = [];
    const cancelar = subscribeQueue((f) => vistos.push(f.length));
    // A outra aba grava direto no armazenamento; o navegador avisa ESTA com `storage`.
    localStorage.setItem(
      'gs.fila.escrita',
      JSON.stringify([
        { id: 'x', path: '/core/sales', method: 'POST', body: {}, idempotencyKey: 'k', label: 'venda do PDV', queuedAt: new Date().toISOString(), attempts: 0 },
      ]),
    );
    window.dispatchEvent(new StorageEvent('storage', { key: 'gs.fila.escrita' }));
    localStorage.removeItem('gs.fila.escrita');
    window.dispatchEvent(new StorageEvent('storage', { key: null }));
    // Outra chave do armazenamento não é a fila.
    window.dispatchEvent(new StorageEvent('storage', { key: 'gs.session' }));
    cancelar();
    expect(vistos).toEqual([0, 1, 0]);
  });
});

describe('17 — o código da venda guardada', () => {
  it('é o fim da chave, curto e em maiúsculas — diferente para duas vendas do mesmo minuto', () => {
    expect(codigoDaVendaGuardada('pdv-0b8f2c1e-4d3a-4f7e-9a61-5c2d7e8f9a10')).toBe('7E8F9A10');
    expect(codigoDaVendaGuardada('pdv-11111111-2222-3333-4444-aaaaaaaaaaaa')).not.toBe(
      codigoDaVendaGuardada('pdv-11111111-2222-3333-4444-bbbbbbbbbbbb'),
    );
  });
});
