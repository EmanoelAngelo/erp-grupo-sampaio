/**
 * ============================================================================
 * AS TELAS SERVIDAS PELA API CARREGAM — a CSP de API não vale para elas
 * (GAP-PRD-156, GAP-PRD-013)
 * ============================================================================
 *
 * Com `DEVORA_SERVIR_FRONTEND=true` (o deploy de referência, a imagem Docker e
 * o modo A do Caddy), a API entrega o `out/` do `vite build`. Mas o middleware
 * de cabeçalhos de segurança passou para a frente de tudo, e punha em TODA
 * resposta — `index.html` e `/assets/*.js` inclusive — a CSP de API:
 *
 *     default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'
 *
 * Um Chromium de verdade em `/login` recusava o script, o estilo e o ícone, e
 * a página ficava em branco. A CSP da tela mora na `<meta>` que o build injeta
 * no `index.html` (`src/lib/seguranca/politicaDeConteudo.ts`), e uma `<meta>`
 * só acrescenta restrição sobre o cabeçalho — nunca afrouxa.
 *
 * O que vale agora:
 *
 *   - o que é TELA (arquivo do build e o `index.html` do fallback) sai sem a
 *     CSP de API: quem manda é a `<meta>`, e o cabeçalho leva só o que uma
 *     `<meta>` não consegue dizer — `frame-ancestors 'none'`;
 *   - o `sw.js` também: o service worker tira a CSP do PRÓPRIO cabeçalho, não
 *     da página, e com `default-src 'none'` não guardaria tela nenhuma;
 *   - `/api`, `/uploads` e o que não é tela (404 de arquivo, mapa de fonte
 *     recusado) continuam com a CSP de API.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';

const { createApp } = await import('../src/app.js');
const { resetEnvCacheForTests } = await import('../src/config/env.js');
const { resetDbForTests } = await import('../src/db/database.js');
const { POLITICA_DE_CONTEUDO_DA_API } = await import('../src/middleware/cabecalhosDeSeguranca.js');

const ORIGINAL = { ...process.env };
let pasta = '';

beforeAll(() => {
  resetDbForTests();
  pasta = mkdtempSync(join(tmpdir(), 'gs-frontend-csp-'));
  writeFileSync(
    join(pasta, 'index.html'),
    '<!doctype html><head><meta charset="UTF-8" />'
      + `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'" />`
      + '<script type="module" src="/assets/index-abc123.js"></script></head><div id="root"></div>',
  );
  mkdirSync(join(pasta, 'assets'));
  writeFileSync(join(pasta, 'assets', 'index-abc123.js'), 'console.log("app")');
  writeFileSync(join(pasta, 'assets', 'index-abc123.css'), 'body{margin:0}');
  writeFileSync(join(pasta, 'assets', 'index-abc123.js.map'), '{"version":3}');
  writeFileSync(join(pasta, 'favicon.ico'), Buffer.from([0, 0, 1, 0]));
  writeFileSync(join(pasta, 'sw.js'), 'self.addEventListener("fetch", () => {})');
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

function cspDe(res: request.Response): string {
  return String(res.headers['content-security-policy'] ?? '');
}

/** A tela carrega: nada de `default-src 'none'`, e não se deixa emoldurar. */
function cobrarCabecalhosDeTela(res: request.Response): void {
  expect(res.status).toBeLessThan(400);
  const csp = cspDe(res);
  expect(csp).not.toContain("default-src 'none'");
  // Nenhuma diretiva de busca no cabeçalho: se houvesse, a `<meta>` do build
  // não conseguiria afrouxá-la, e a tela voltaria a ficar em branco.
  expect(csp).not.toMatch(/(default|script|style|img|font|connect|worker|manifest)-src/);
  expect(csp).toContain("frame-ancestors 'none'");
  expect(res.headers['x-frame-options']).toBe('DENY');
  expect(res.headers['x-content-type-options']).toBe('nosniff');
  expect(res.headers['referrer-policy']).toBe('no-referrer');
}

describe('com DEVORA_SERVIR_FRONTEND=true, as telas saem sem a CSP de API', () => {
  it('a raiz (index.html)', async () => {
    const res = await request(ligada()).get('/');
    expect(res.text).toContain('<div id="root">');
    cobrarCabecalhosDeTela(res);
  });

  it('o /login e o deep link do fallback', async () => {
    const app = ligada();
    for (const caminho of ['/login', '/sistema/pdv']) {
      const res = await request(app).get(caminho).set('Accept', 'text/html');
      expect(res.text).toContain('<div id="root">');
      cobrarCabecalhosDeTela(res);
    }
  });

  it('o script, o estilo e o ícone do build', async () => {
    const app = ligada();
    for (const caminho of ['/assets/index-abc123.js', '/assets/index-abc123.css', '/favicon.ico']) {
      cobrarCabecalhosDeTela(await request(app).get(caminho));
    }
  });

  it('o service worker, que tira a CSP do próprio cabeçalho', async () => {
    cobrarCabecalhosDeTela(await request(ligada()).get('/sw.js'));
  });

  it('HEAD e a revalidação (304) do index — o navegador troca os cabeçalhos guardados pelos do 304', async () => {
    const app = ligada();
    cobrarCabecalhosDeTela(await request(app).head('/'));
    const primeira = await request(app).get('/');
    const etag = primeira.headers.etag;
    expect(etag).toBeTruthy();
    const revalidada = await request(app).get('/').set('If-None-Match', etag);
    expect(revalidada.status).toBe(304);
    cobrarCabecalhosDeTela(revalidada);
  });
});

describe('o que não é tela continua com a CSP de API', () => {
  it('/api/v1/health', async () => {
    const res = await request(ligada()).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(cspDe(res)).toBe(POLITICA_DE_CONTEUDO_DA_API);
  });

  it('/api que não existe', async () => {
    const res = await request(ligada()).get('/api/v1/rota-que-nao-existe');
    expect(res.status).toBe(404);
    expect(cspDe(res)).toBe(POLITICA_DE_CONTEUDO_DA_API);
  });

  it('/uploads, mesmo o que sumiu', async () => {
    const res = await request(ligada()).get('/uploads/produtos/nao-existe');
    expect(res.status).toBe(404);
    expect(cspDe(res)).toContain("default-src 'none'");
  });

  it('arquivo do build que não existe e mapa de fonte recusado', async () => {
    const app = ligada();
    for (const caminho of ['/assets/index-velho999.js', '/assets/index-abc123.js.map']) {
      const res = await request(app).get(caminho);
      expect(res.status).toBe(404);
      expect(cspDe(res)).toBe(POLITICA_DE_CONTEUDO_DA_API);
    }
  });

  it('POST num caminho de tela', async () => {
    const res = await request(ligada()).post('/sistema/pdv').send({});
    expect(res.status).toBe(404);
    expect(cspDe(res)).toBe(POLITICA_DE_CONTEUDO_DA_API);
  });
});

describe('desligada (o padrão)', () => {
  it('nada muda: a raiz é o 404 da API, com a CSP de API', async () => {
    delete process.env.DEVORA_SERVIR_FRONTEND;
    process.env.DEVORA_FRONTEND_DIR = pasta;
    resetEnvCacheForTests();
    const res = await request(createApp()).get('/');
    expect(res.status).toBe(404);
    expect(cspDe(res)).toBe(POLITICA_DE_CONTEUDO_DA_API);
  });
});
