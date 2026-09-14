// @vitest-environment node
/**
 * ============================================================================
 * O SERVICE WORKER GUARDA TODAS AS TELAS — não só as que alguém abriu
 * (GAP-PRD-210)
 * ============================================================================
 *
 * Com a divisão por tela, cada tela virou um pedaço baixado sob demanda. O
 * `public/sw.js` guardava só o que passava por ele: uma tela nunca aberta com
 * rede desde o último deploy não abriria sem ela. Este arquivo roda o `sw.js`
 * DE VERDADE (o texto do arquivo publicado) contra uma rede, um `caches` e um
 * `self` de mentira, e prova:
 *
 *   - a instalação guarda a casca e TODOS os pedaços da lista do build;
 *   - sem rede, uma tela nunca aberta abre do que foi guardado;
 *   - o deploy troca a lista, e a primeira abertura com rede guarda os pedaços
 *     novos e descarta os velhos;
 *   - um pedaço que falha não derruba a instalação e é buscado de novo;
 *   - a API e a própria lista nunca saem do cache.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LISTA_DO_SERVICE_WORKER } from '../build/configuracaoDoBuild';

const CODIGO = readFileSync(fileURLToPath(new URL('../../../public/sw.js', import.meta.url)), 'utf8');
const ORIGEM = 'https://loja.test';
const abs = (caminho: string) => new URL(caminho, `${ORIGEM}/`).href;

type Pedido = { url: string; method: string; mode: string };
type Ouvinte = (evento: Record<string, unknown>) => void;

function resposta(corpo: string, status = 200): Response {
  const res = new Response(status === 204 ? null : corpo, { status });
  // Resposta de mesma origem, como o navegador a entrega ao service worker.
  Object.defineProperty(res, 'type', { value: 'basic' });
  return res;
}

/** Um `Cache` em memória, pelo endereço absoluto. */
class CacheFalso {
  readonly mapa = new Map<string, Response>();
  private readonly buscar: (entrada: string | Pedido) => Promise<Response>;
  constructor(buscar: (entrada: string | Pedido) => Promise<Response>) {
    this.buscar = buscar;
  }
  private chave(entrada: string | Pedido): string {
    return abs(typeof entrada === 'string' ? entrada : entrada.url);
  }
  async match(entrada: string | Pedido) {
    const guardado = this.mapa.get(this.chave(entrada));
    return guardado ? guardado.clone() : undefined;
  }
  async put(entrada: string | Pedido, res: Response) {
    this.mapa.set(this.chave(entrada), res);
  }
  async addAll(caminhos: string[]) {
    for (const caminho of caminhos) {
      const res = await this.buscar(abs(caminho));
      if (!res.ok) throw new TypeError(`addAll: ${caminho} respondeu ${res.status}`);
      this.mapa.set(abs(caminho), res);
    }
  }
  async keys() {
    return [...this.mapa.keys()].map((url) => ({ url }));
  }
  async delete(entrada: string | Pedido) {
    return this.mapa.delete(this.chave(entrada));
  }
  guardados(): string[] {
    return [...this.mapa.keys()].map((u) => new URL(u).pathname).sort();
  }
}

interface Montado {
  rede: Map<string, { corpo: string; status: number }>;
  cache: CacheFalso;
  pedidosNaRede: string[];
  ficarSemRede(): void;
  voltarARede(): void;
  instalar(): Promise<void>;
  pedir(caminho: string, modo?: string): Promise<Response | undefined>;
  skipWaiting: ReturnType<typeof vi.fn>;
}

function lista(versao: string, arquivos: string[]) {
  return { corpo: JSON.stringify({ versao, arquivos }), status: 200 };
}

const BUILD_1 = {
  '/': { corpo: '<div id="root"></div>', status: 200 },
  '/index.html': { corpo: '<div id="root"></div>', status: 200 },
  '/assets/index-A1.js': { corpo: 'pacote inicial com PDV e login', status: 200 },
  '/assets/index-C1.css': { corpo: 'estilo', status: 200 },
  '/assets/PainelPage-B1.js': { corpo: 'tela do painel', status: 200 },
  '/assets/EstoquePage-E1.js': { corpo: 'tela do estoque', status: 200 },
  [`/${LISTA_DO_SERVICE_WORKER}`]: lista('v1', [
    '/assets/index-A1.js',
    '/assets/index-C1.css',
    '/assets/PainelPage-B1.js',
    '/assets/EstoquePage-E1.js',
  ]),
};

function montar(arquivos: Record<string, { corpo: string; status: number }> = BUILD_1): Montado {
  const rede = new Map(Object.entries(arquivos).map(([k, v]) => [abs(k), v]));
  const pedidosNaRede: string[] = [];
  let online = true;

  const buscar = async (entrada: string | Pedido): Promise<Response> => {
    const url = abs(typeof entrada === 'string' ? entrada : entrada.url);
    if (!online) throw new TypeError('Failed to fetch');
    pedidosNaRede.push(new URL(url).pathname);
    const achado = rede.get(url);
    if (achado) return resposta(achado.corpo, achado.status);
    // O fallback de SPA do servidor: caminho de tela (sem extensão) é o index.
    const { pathname } = new URL(url);
    if (!pathname.startsWith('/api/') && !/\.[A-Za-z0-9]+$/.test(pathname)) {
      const indice = rede.get(abs('/index.html'));
      if (indice) return resposta(indice.corpo, indice.status);
    }
    return resposta('não encontrado', 404);
  };

  const cache = new CacheFalso(buscar);
  const caches = {
    open: async () => cache,
    match: async (entrada: string | Pedido) => cache.match(entrada),
    keys: async () => ['gs-casca-v1'],
    delete: async () => true,
  };
  const ouvintes: Record<string, Ouvinte> = {};
  const skipWaiting = vi.fn(async () => {});
  const self = {
    location: new URL(`${ORIGEM}/sw.js`),
    addEventListener: (tipo: string, ouvinte: Ouvinte) => {
      ouvintes[tipo] = ouvinte;
    },
    skipWaiting,
    clients: { claim: vi.fn(async () => {}) },
  };

  new Function('self', 'caches', 'fetch', CODIGO)(self, caches, buscar);

  return {
    rede,
    cache,
    pedidosNaRede,
    skipWaiting,
    ficarSemRede: () => {
      online = false;
    },
    voltarARede: () => {
      online = true;
    },
    async instalar() {
      const esperas: Promise<unknown>[] = [];
      ouvintes.install({ waitUntil: (p: Promise<unknown>) => esperas.push(p) });
      await Promise.all(esperas);
    },
    async pedir(caminho: string, modo = 'no-cors') {
      let respondido: Promise<Response> | undefined;
      const esperas: Promise<unknown>[] = [];
      ouvintes.fetch({
        request: { url: abs(caminho), method: 'GET', mode: modo },
        respondWith: (p: Promise<Response>) => {
          respondido = p;
        },
        waitUntil: (p: Promise<unknown>) => esperas.push(p),
      });
      const res = respondido ? await respondido : undefined;
      await Promise.all(esperas);
      return res;
    },
  };
}

describe('a instalação', () => {
  it('guarda a casca e TODOS os pedaços da lista do build — inclusive telas que ninguém abriu', async () => {
    const sw = montar();
    await sw.instalar();
    expect(sw.cache.guardados()).toEqual([
      '/',
      '/assets/EstoquePage-E1.js',
      '/assets/PainelPage-B1.js',
      '/assets/index-A1.js',
      '/assets/index-C1.css',
      '/index.html',
    ]);
    expect(sw.skipWaiting).toHaveBeenCalled();
  });

  it('um pedaço que falha não derruba a instalação — e é buscado de novo na próxima abertura', async () => {
    const sw = montar({ ...BUILD_1, '/assets/EstoquePage-E1.js': { corpo: 'erro', status: 503 } });
    await sw.instalar();
    expect(sw.skipWaiting).toHaveBeenCalled();
    expect(sw.cache.guardados()).not.toContain('/assets/EstoquePage-E1.js');
    expect(sw.cache.guardados()).toContain('/assets/PainelPage-B1.js');

    sw.rede.set(abs('/assets/EstoquePage-E1.js'), { corpo: 'tela do estoque', status: 200 });
    await sw.pedir('/sistema/painel', 'navigate');
    expect(sw.cache.guardados()).toContain('/assets/EstoquePage-E1.js');
  });

  it('sem a lista (build antigo, desenvolvimento), a casca continua sendo guardada', async () => {
    const semLista: Record<string, { corpo: string; status: number }> = { ...BUILD_1 };
    delete semLista[`/${LISTA_DO_SERVICE_WORKER}`];
    const sw = montar(semLista);
    await sw.instalar();
    expect(sw.cache.guardados()).toEqual(['/', '/index.html']);
    expect(sw.skipWaiting).toHaveBeenCalled();
  });

  it('lista corrompida também não derruba nada', async () => {
    const sw = montar({ ...BUILD_1, [`/${LISTA_DO_SERVICE_WORKER}`]: { corpo: '<html>proxy</html>', status: 200 } });
    await sw.instalar();
    expect(sw.cache.guardados()).toEqual(['/', '/index.html']);
  });
});

describe('sem rede', () => {
  it('a tela que ninguém abriu abre do que foi guardado', async () => {
    const sw = montar();
    await sw.instalar();
    sw.ficarSemRede();

    const casca = await sw.pedir('/sistema/estoque', 'navigate');
    expect(await casca!.text()).toContain('<div id="root">');

    const pedaco = await sw.pedir('/assets/EstoquePage-E1.js');
    expect(pedaco!.status).toBe(200);
    expect(await pedaco!.text()).toBe('tela do estoque');
  });

  it('e o pacote inicial — o PDV e o login estão nele — também', async () => {
    const sw = montar();
    await sw.instalar();
    sw.ficarSemRede();
    const pacote = await sw.pedir('/assets/index-A1.js');
    expect(await pacote!.text()).toBe('pacote inicial com PDV e login');
  });
});

describe('com rede fraca', () => {
  it('pedaço com hash sai do guardado sem esperar a rede — o nome muda quando o conteúdo muda', async () => {
    const sw = montar();
    await sw.instalar();
    sw.pedidosNaRede.length = 0;
    const pedaco = await sw.pedir('/assets/PainelPage-B1.js');
    expect(await pedaco!.text()).toBe('tela do painel');
    expect(sw.pedidosNaRede).toEqual([]);
  });
});

describe('o deploy', () => {
  it('a primeira abertura com rede guarda os pedaços novos e descarta os velhos', async () => {
    const sw = montar();
    await sw.instalar();

    // O deploy: o painel mudou, o estoque não, o pacote inicial mudou.
    sw.rede.delete(abs('/assets/index-A1.js'));
    sw.rede.delete(abs('/assets/PainelPage-B1.js'));
    sw.rede.set(abs('/assets/index-A2.js'), { corpo: 'pacote inicial novo', status: 200 });
    sw.rede.set(abs('/assets/PainelPage-B2.js'), { corpo: 'painel novo', status: 200 });
    sw.rede.set(
      abs(`/${LISTA_DO_SERVICE_WORKER}`),
      lista('v2', ['/assets/index-A2.js', '/assets/index-C1.css', '/assets/PainelPage-B2.js', '/assets/EstoquePage-E1.js']),
    );

    await sw.pedir('/pdv', 'navigate');

    expect(sw.cache.guardados().filter((p) => p.startsWith('/assets/'))).toEqual([
      '/assets/EstoquePage-E1.js',
      '/assets/PainelPage-B2.js',
      '/assets/index-A2.js',
      '/assets/index-C1.css',
    ]);
    // A casca continua: a poda é só de pedaço.
    expect(sw.cache.guardados()).toEqual(expect.arrayContaining(['/', '/index.html']));

    // E o painel novo abre sem rede, sem ninguém tê-lo aberto depois do deploy.
    sw.ficarSemRede();
    expect(await (await sw.pedir('/assets/PainelPage-B2.js'))!.text()).toBe('painel novo');
  });

  /*
    Verificação do grupo BUILD: a poda tirava os pedaços do build anterior,
    mas a casca guardada (`/index.html`, só na instalação — o `sw.js` não muda
    de um deploy para outro) e a cópia por endereço de tela aberta antes do
    deploy continuavam citando o pacote inicial VELHO. Sem rede, o endereço
    abria uma casca cujo pacote já não estava guardado: página em branco,
    inclusive no PDV.
  */
  const cascaQueCita = (pacote: string) => ({
    corpo: `<div id="root"></div><script type="module" src="${pacote}"></script>`,
    status: 200,
  });
  const pacoteCitado = (html: string) => /src="([^"]+)"/.exec(html)?.[1] ?? '';

  function comCascaQueCitaOPacote() {
    return {
      ...BUILD_1,
      '/': cascaQueCita('/assets/index-A1.js'),
      '/index.html': cascaQueCita('/assets/index-A1.js'),
    };
  }

  function publicarBuild2(sw: Montado, falhar: string[] = []) {
    sw.rede.delete(abs('/assets/index-A1.js'));
    sw.rede.delete(abs('/assets/PainelPage-B1.js'));
    sw.rede.set(abs('/'), cascaQueCita('/assets/index-A2.js'));
    sw.rede.set(abs('/index.html'), cascaQueCita('/assets/index-A2.js'));
    sw.rede.set(abs('/assets/index-A2.js'), { corpo: 'pacote inicial novo', status: 200 });
    sw.rede.set(abs('/assets/PainelPage-B2.js'), { corpo: 'painel novo', status: 200 });
    for (const caminho of falhar) sw.rede.set(abs(caminho), { corpo: 'erro', status: 503 });
    sw.rede.set(
      abs(`/${LISTA_DO_SERVICE_WORKER}`),
      lista('v2', ['/assets/index-A2.js', '/assets/index-C1.css', '/assets/PainelPage-B2.js', '/assets/EstoquePage-E1.js']),
    );
  }

  async function abreSemRede(sw: Montado, caminho: string) {
    const casca = await sw.pedir(caminho, 'navigate');
    const pacote = pacoteCitado(await casca!.text());
    expect(pacote, `a casca de ${caminho} cita um pacote`).not.toBe('');
    const res = await sw.pedir(pacote).catch(() => undefined);
    expect(res?.status, `${caminho}: o pacote ${pacote} que a casca cita está guardado`).toBe(200);
    return pacote;
  }

  it('depois do deploy, sem rede, todo endereço abre uma casca cujo pacote está guardado', async () => {
    const sw = montar(comCascaQueCitaOPacote());
    await sw.instalar();
    // O PDV foi aberto com rede ANTES do deploy: a cópia dele cita o pacote velho.
    await sw.pedir('/pdv', 'navigate');

    publicarBuild2(sw);
    await sw.pedir('/sistema/painel', 'navigate');

    sw.ficarSemRede();
    // Nunca aberta, aberta antes do deploy e aberta depois: todas com o pacote novo.
    expect(await abreSemRede(sw, '/sistema/estoque')).toBe('/assets/index-A2.js');
    expect(await abreSemRede(sw, '/pdv')).toBe('/assets/index-A2.js');
    expect(await abreSemRede(sw, '/sistema/painel')).toBe('/assets/index-A2.js');
  });

  it('um pedaço novo que falha não poda os velhos: a casca antiga continua abrindo sem rede', async () => {
    const sw = montar(comCascaQueCitaOPacote());
    await sw.instalar();

    publicarBuild2(sw, ['/assets/PainelPage-B2.js']);
    await sw.pedir('/sistema/estoque', 'navigate');

    sw.ficarSemRede();
    expect(await abreSemRede(sw, '/pdv')).toBe('/assets/index-A1.js');
    expect(await (await sw.pedir('/assets/PainelPage-B1.js'))!.text()).toBe('tela do painel');

    // Com a rede de volta e o pedaço no ar, a abertura seguinte troca tudo.
    sw.voltarARede();
    sw.rede.set(abs('/assets/PainelPage-B2.js'), { corpo: 'painel novo', status: 200 });
    await sw.pedir('/sistema/estoque', 'navigate');
    sw.ficarSemRede();
    expect(await abreSemRede(sw, '/pdv')).toBe('/assets/index-A2.js');
    expect(sw.cache.guardados()).not.toContain('/assets/index-A1.js');
  });

  it('abrir de novo com a mesma lista não baixa nada outra vez', async () => {
    const sw = montar();
    await sw.instalar();
    sw.pedidosNaRede.length = 0;
    await sw.pedir('/sistema/painel', 'navigate');
    await sw.pedir('/sistema/painel', 'navigate');
    expect(sw.pedidosNaRede.filter((p) => p.startsWith('/assets/'))).toEqual([]);
  });
});

describe('o que nunca sai do cache', () => {
  it('a API vai sempre à rede — o service worker nem responde', async () => {
    const sw = montar();
    await sw.instalar();
    expect(await sw.pedir('/api/v1/core/products')).toBeUndefined();
  });

  it('a lista também: guardada, ela esconderia o deploy', async () => {
    const sw = montar();
    await sw.instalar();
    expect(await sw.pedir(`/${LISTA_DO_SERVICE_WORKER}`)).toBeUndefined();
  });

  it('o sw.js lê o arquivo que o build escreve, pelo mesmo nome', () => {
    expect(CODIGO).toContain(`'${LISTA_DO_SERVICE_WORKER}'`);
  });
});
