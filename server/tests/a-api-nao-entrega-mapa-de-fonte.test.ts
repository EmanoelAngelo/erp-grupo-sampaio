/**
 * ============================================================================
 * A API NÃO ENTREGA MAPA DE FONTE (GAP-PRD-210)
 * ============================================================================
 *
 * O build publicava `assets/index-*.js.map` — 6,4 MB com o código-fonte
 * inteiro do frontend — e a API, servindo o `out/` como veio, o entregava a
 * quem pedisse. O build agora não gera mapa por padrão; o modo
 * `DEVORA_BUILD_SOURCEMAP=hidden` gera, para a ferramenta de erros. Este
 * arquivo prova a segunda trava: mesmo com o `.map` na pasta, a API responde
 * 404 — e para toda grafia que o disco da loja (Windows) leria como o mesmo
 * arquivo.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';

const { createApp } = await import('../src/app.js');
const { resetEnvCacheForTests } = await import('../src/config/env.js');
const { resetDbForTests } = await import('../src/db/database.js');

const ORIGINAL = { ...process.env };
const FONTE = 'export function codigoFonteDoSistema() { return "segredo-do-repositorio"; }';
const MAPA = JSON.stringify({ version: 3, sources: ['src/App.tsx'], sourcesContent: [FONTE] });
let pasta = '';

beforeAll(() => {
  resetDbForTests();
  pasta = mkdtempSync(join(tmpdir(), 'gs-frontend-mapa-'));
  writeFileSync(join(pasta, 'index.html'), '<!doctype html><title>Grupo Sampaio</title><div id="root"></div>');
  mkdirSync(join(pasta, 'assets'));
  writeFileSync(join(pasta, 'assets', 'index-abc123.js'), 'console.log("app")');
  writeFileSync(join(pasta, 'assets', 'index-abc123.js.map'), MAPA);
  writeFileSync(join(pasta, 'assets', 'index-abc123.css.map'), MAPA);
  writeFileSync(join(pasta, 'sw.js.map'), MAPA);
});

afterAll(() => {
  rmSync(pasta, { recursive: true, force: true });
});

afterEach(() => {
  for (const chave of Object.keys(process.env)) if (!(chave in ORIGINAL)) delete process.env[chave];
  Object.assign(process.env, ORIGINAL);
  resetEnvCacheForTests();
});

function ligada() {
  process.env.DEVORA_SERVIR_FRONTEND = 'true';
  process.env.DEVORA_FRONTEND_DIR = pasta;
  resetEnvCacheForTests();
  return createApp();
}

function naoEntregouAFonte(res: request.Response): void {
  expect(res.status).toBe(404);
  expect(res.text ?? '').not.toContain('segredo-do-repositorio');
  expect(res.text ?? '').not.toContain('sourcesContent');
  // Nem o index no lugar: um 200 com HTML esconderia a recusa.
  expect(res.text ?? '').not.toContain('<div id="root">');
}

describe('o .map que está na pasta não sai', () => {
  it.each([
    '/assets/index-abc123.js.map',
    '/assets/index-abc123.css.map',
    '/sw.js.map',
  ])('GET %s → 404', async (caminho) => {
    naoEntregouAFonte(await request(ligada()).get(caminho));
  });

  it('HEAD também — o tamanho do arquivo já diz que ele existe', async () => {
    const res = await request(ligada()).head('/assets/index-abc123.js.map');
    expect(res.status).toBe(404);
  });

  it('e o mapa que não existe responde igual ao que existe', async () => {
    const existe = await request(ligada()).get('/assets/index-abc123.js.map');
    const naoExiste = await request(ligada()).get('/assets/index-nao-existe.js.map');
    expect(naoExiste.status).toBe(existe.status);
    expect(naoExiste.text).toBe(existe.text);
  });
});

describe('nenhuma grafia que o disco leria como o mesmo arquivo passa', () => {
  it.each([
    ['caixa alta', '/assets/index-abc123.js.MAP'],
    ['ponto codificado', '/assets/index-abc123.js%2emap'],
    ['ponto codificado em caixa alta', '/assets/index-abc123.js%2EMAP'],
    ['ponto no fim (o Windows ignora)', '/assets/index-abc123.js.map.'],
    ['espaço no fim (o Windows ignora)', '/assets/index-abc123.js.map%20'],
    ['fluxo ::$DATA do NTFS', '/assets/index-abc123.js.map::$DATA'],
    ['barra invertida codificada', '/assets%5Cindex-abc123.js.map'],
    // Verificação do grupo BUILD: o nome do .map não é o último pedaço da
    // URL, mas é o último que o disco abre — o `\.` do fim some na
    // normalização do caminho e o `express.static` entregava o mapa.
    ['barra invertida e ponto no fim', '/assets/index-abc123.js.map%5C.'],
    ['barra e ponto no fim', '/assets/index-abc123.js.map/.'],
    ['barra no fim', '/assets/index-abc123.js.map/'],
    ['barra invertida no fim', '/assets/index-abc123.js.map%5C'],
    ['três pontos no fim (o Windows apara)', '/assets/index-abc123.js.map/...'],
    ['ponto-ponto-espaço no fim', '/assets/index-abc123.js.map/x/..%20'],
    ['ponto e espaço depois da barra invertida', '/assets/index-abc123.js.map%5C.%20'],
  ])('%s: %s', async (_rotulo, caminho) => {
    naoEntregouAFonte(await request(ligada()).get(caminho));
  });
});

describe('a recusa é só do mapa', () => {
  it('o pacote ao lado continua saindo, com cache longo', async () => {
    const res = await request(ligada()).get('/assets/index-abc123.js');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toMatch(/immutable/);
  });

  it('e a rota de tela com "map" no nome continua sendo tela', async () => {
    const res = await request(ligada()).get('/sistema/mapa');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<div id="root">');
  });

  it('/api continua sendo da API, com o 404 JSON dela', async () => {
    const res = await request(ligada()).get('/api/v1/nao-existe.map');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('API_NOT_FOUND');
  });
});
