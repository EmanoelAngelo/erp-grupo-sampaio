// @vitest-environment node
/**
 * O build do frontend sem mapa de fonte público e com a lista do service
 * worker (GAP-PRD-210).
 *
 * As funções puras são testadas diretamente, e o `vite.config.ts` DE VERDADE é
 * importado para provar que é delas que o build lê — um teste só da função
 * ficaria verde com o `sourcemap: true` de volta no config.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  baseDaApiDoBuild,
  LISTA_DO_SERVICE_WORKER,
  listaDoServiceWorker,
  mapaDeFonteDoBuild,
  type ArquivosDoBundle,
} from '../configuracaoDoBuild';

const ORIGINAL = process.env.DEVORA_BUILD_SOURCEMAP;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.DEVORA_BUILD_SOURCEMAP;
  else process.env.DEVORA_BUILD_SOURCEMAP = ORIGINAL;
  vi.resetModules();
});

describe('mapaDeFonteDoBuild', () => {
  it.each([undefined, '', '   ', 'false', 'FALSE'])('%j → nenhum mapa', (valor) => {
    expect(mapaDeFonteDoBuild(valor)).toBe(false);
  });

  it.each(['hidden', ' HIDDEN ', 'Hidden'])('%j → mapas sem o comentário que os anuncia', (valor) => {
    expect(mapaDeFonteDoBuild(valor)).toBe('hidden');
  });

  it.each(['true', 'inline', '1', 'sim'])('%j → recusa o build, dizendo o que é aceito', (valor) => {
    // `true` é justamente o mapa público que o gap fechou: cair em silêncio
    // no padrão esconderia que o pedido foi recusado.
    expect(() => mapaDeFonteDoBuild(valor)).toThrow(/hidden/);
  });
});

describe('o vite.config.ts lê daqui', () => {
  async function configDoBuild() {
    vi.resetModules();
    const modulo = await import('../../../../vite.config');
    return modulo.default as {
      build: { sourcemap: unknown };
      plugins: Array<{ name?: string } | Array<{ name?: string }>>;
    };
  }

  it('sem a variável, o build não gera mapa nenhum', async () => {
    delete process.env.DEVORA_BUILD_SOURCEMAP;
    expect((await configDoBuild()).build.sourcemap).toBe(false);
  });

  it('com DEVORA_BUILD_SOURCEMAP=hidden, gera os mapas escondidos', async () => {
    process.env.DEVORA_BUILD_SOURCEMAP = 'hidden';
    expect((await configDoBuild()).build.sourcemap).toBe('hidden');
  });

  it('com DEVORA_BUILD_SOURCEMAP=true, o build nem começa', async () => {
    process.env.DEVORA_BUILD_SOURCEMAP = 'true';
    await expect(configDoBuild()).rejects.toThrow(/DEVORA_BUILD_SOURCEMAP/);
  });

  it('e o plugin que escreve a lista do service worker está ligado', async () => {
    delete process.env.DEVORA_BUILD_SOURCEMAP;
    const nomes = (await configDoBuild()).plugins.flat().map((p) => p?.name);
    expect(nomes).toContain('devora-lista-do-service-worker');
  });
});

describe('listaDoServiceWorker', () => {
  const bundle: ArquivosDoBundle = {
    'assets/index-AAA.js': { fileName: 'assets/index-AAA.js', type: 'chunk' },
    'assets/PainelPage-BBB.js': { fileName: 'assets/PainelPage-BBB.js', type: 'chunk' },
    'assets/index-CCC.css': { fileName: 'assets/index-CCC.css', type: 'asset' },
    'assets/index-AAA.js.map': { fileName: 'assets/index-AAA.js.map', type: 'asset' },
    'index.html': { fileName: 'index.html', type: 'asset' },
    [LISTA_DO_SERVICE_WORKER]: { fileName: LISTA_DO_SERVICE_WORKER, type: 'asset' },
  };

  it('lista todo pedaço e todo arquivo, sem .map, sem o index e sem ela mesma', () => {
    expect(listaDoServiceWorker(bundle).arquivos).toEqual([
      '/assets/PainelPage-BBB.js',
      '/assets/index-AAA.js',
      '/assets/index-CCC.css',
    ]);
  });

  it('respeita o base do build', () => {
    expect(listaDoServiceWorker(bundle, '/erp').arquivos[0]).toBe('/erp/assets/PainelPage-BBB.js');
    expect(listaDoServiceWorker(bundle, '/erp/').arquivos[0]).toBe('/erp/assets/PainelPage-BBB.js');
  });

  it('a versão muda quando um pedaço muda, e não muda com a ordem do bundle', () => {
    const invertido = Object.fromEntries(Object.entries(bundle).reverse()) as ArquivosDoBundle;
    expect(listaDoServiceWorker(invertido).versao).toBe(listaDoServiceWorker(bundle).versao);

    const outro = {
      ...bundle,
      'assets/PainelPage-BBB.js': { fileName: 'assets/PainelPage-ZZZ.js', type: 'chunk' as const },
    };
    expect(listaDoServiceWorker(outro).versao).not.toBe(listaDoServiceWorker(bundle).versao);
  });
});

describe('baseDaApiDoBuild — o endereço da API do build não é caminho do disco', () => {
  it('aceita vazio, a mesma origem e endereços http(s)', () => {
    expect(baseDaApiDoBuild(undefined)).toBeUndefined();
    expect(baseDaApiDoBuild('  ')).toBeUndefined();
    expect(baseDaApiDoBuild('/')).toBe('/');
    expect(baseDaApiDoBuild('https://api.exemplo.com.br')).toBe('https://api.exemplo.com.br');
    expect(baseDaApiDoBuild('http://192.168.0.10:8787')).toBe('http://192.168.0.10:8787');
  });

  it('recusa o "/" que o Git Bash reescreveu para a pasta dele, dizendo como consertar', () => {
    expect(() => baseDaApiDoBuild('C:/Program Files/Git/')).toThrow(/MSYS_NO_PATHCONV=1/);
    expect(() => baseDaApiDoBuild('C:\\Users\\loja')).toThrow(/caminho do disco/);
  });

  it('recusa o que não é "/" nem http(s)', () => {
    expect(() => baseDaApiDoBuild('api.exemplo.com.br')).toThrow(/nem um endereço http/);
  });
});
