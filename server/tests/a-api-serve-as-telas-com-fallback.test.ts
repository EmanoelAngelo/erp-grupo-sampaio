/**
 * ============================================================================
 * A API SERVE AS TELAS — com fallback de SPA (GAP-PRD-013)
 * ============================================================================
 *
 * O repositório não servia o frontend: `app.ts` montava só `/api/v1` e
 * `/uploads/*`, e a instalação da loja rodava o Vite de DESENVOLVIMENTO na
 * porta 3000. O frontend usa `BrowserRouter`, então abrir `/sistema/pdv`
 * direto (um favorito, um F5) precisa de um host que devolva o `index.html`
 * para caminhos que não são arquivo — sem isso, 404.
 *
 * Agora a API serve o `out/` do `vite build` quando `DEVORA_SERVIR_FRONTEND`
 * está ligada. O padrão é DESLIGADA — o comportamento de antes —, porque quem
 * publica atrás de um nginx com host estático próprio não precisa disso, e
 * ligar sem `out/` buildado recusa a subida em vez de servir 404 a todos.
 *
 * O que o fallback NÃO pode engolir:
 *   - `/api/*`: rota que não existe continua sendo o 404 JSON da API;
 *   - `/uploads/*`: foto que sumiu é 404, não uma página HTML;
 *   - arquivo com extensão que não existe (`/assets/velho-abc.js` depois de
 *     um deploy): devolver HTML no lugar de JS vira "Unexpected token <"
 *     no console e esconde a causa;
 *   - método que não é GET/HEAD.
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
let pasta = '';

beforeAll(() => {
  // O 404 da API grava em api_request_logs: o banco descartável precisa existir.
  resetDbForTests();
  pasta = mkdtempSync(join(tmpdir(), 'gs-frontend-'));
  writeFileSync(join(pasta, 'index.html'), '<!doctype html><title>Grupo Sampaio</title><div id="root"></div>');
  mkdirSync(join(pasta, 'assets'));
  writeFileSync(join(pasta, 'assets', 'index-abc123.js'), 'console.log("app")');
  writeFileSync(join(pasta, 'sw.js'), 'self.addEventListener("fetch", () => {})');
  writeFileSync(join(pasta, '.env'), 'NAO=DEVE_SAIR');
});

afterAll(() => {
  rmSync(pasta, { recursive: true, force: true });
});

afterEach(() => {
  for (const chave of Object.keys(process.env)) if (!(chave in ORIGINAL)) delete process.env[chave];
  Object.assign(process.env, ORIGINAL);
  resetEnvCacheForTests();
});

function appCom(vars: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetEnvCacheForTests();
  return createApp();
}

describe('com DEVORA_SERVIR_FRONTEND=true', () => {
  const ligada = () => appCom({ DEVORA_SERVIR_FRONTEND: 'true', DEVORA_FRONTEND_DIR: pasta });

  it('a raiz devolve o index.html', async () => {
    const res = await request(ligada()).get('/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('<div id="root">');
  });

  it('um deep link (/sistema/pdv) devolve o index.html — o F5 no PDV não vira 404', async () => {
    const res = await request(ligada()).get('/sistema/pdv').set('Accept', 'text/html');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<div id="root">');
    // O index nunca fica em cache: é ele que aponta para o bundle novo.
    expect(res.headers['cache-control']).toMatch(/no-cache/);
  });

  it('e o deep link com parâmetro também (/sistema/oficina/os/123)', async () => {
    const res = await request(ligada()).get('/sistema/oficina/os/123');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<div id="root">');
  });

  it('o bundle com hash é servido com cache longo e imutável', async () => {
    const res = await request(ligada()).get('/assets/index-abc123.js');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toMatch(/immutable/);
  });

  it('o service worker NÃO fica em cache — senão a atualização nunca chega', async () => {
    const res = await request(ligada()).get('/sw.js');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toMatch(/no-cache/);
  });

  it('as telas saem com os cabeçalhos de segurança da API', async () => {
    const res = await request(ligada()).get('/sistema/pdv');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  /*
    A TELA NÃO HERDA A CSP DA API (GAP-PRD-156 × GAP-PRD-061).

    O navegador aplica TODAS as políticas que recebe: a do cabeçalho e a
    <meta> que o build põe no index.html. Com a da API (default-src 'none')
    no cabeçalho, nenhum script do próprio pacote carrega e a tela fica em
    branco; no sw.js, a política do cabeçalho é a do worker, e o precache
    não busca nada. Nenhum teste montava a tela servida pela API olhando a
    CSP — só X-Frame-Options e nosniff —, e o defeito passava verde.
  */
  it('a tela, o pacote e o service worker NÃO levam a CSP da API', async () => {
    const app = ligada();
    for (const caminho of ['/', '/sistema/pdv', '/assets/index-abc123.js', '/sw.js']) {
      const res = await request(app).get(caminho);
      expect(res.status, caminho).toBe(200);
      const csp = String(res.headers['content-security-policy'] ?? '');
      expect(csp, caminho).not.toContain("default-src 'none'");
      // O que uma <meta> não consegue continua no cabeçalho.
      expect(csp, caminho).toContain("frame-ancestors 'none'");
    }
  });

  it('a API ao lado das telas continua com a CSP dela', async () => {
    const res = await request(ligada()).get('/api/v1/health');
    expect(String(res.headers['content-security-policy'])).toContain("default-src 'none'");
  });

  it('arquivo com extensão que não existe é 404, não HTML no lugar de JS', async () => {
    const res = await request(ligada()).get('/assets/index-velho999.js');
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('<div id="root">');
  });

  it('/api/* que não existe continua sendo o 404 JSON da API', async () => {
    const res = await request(ligada()).get('/api/v1/rota-que-nao-existe');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('API_NOT_FOUND');
  });

  it('e /api sozinho também não vira tela', async () => {
    const res = await request(ligada()).get('/api');
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('<div id="root">');
  });

  it('a API continua respondendo ao lado das telas', async () => {
    const res = await request(ligada()).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('foto que sumiu em /uploads é 404, não uma página', async () => {
    const res = await request(ligada()).get('/uploads/produtos/nao-existe');
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('<div id="root">');
  });

  it('POST num caminho de tela não devolve o index', async () => {
    const res = await request(ligada()).post('/sistema/pdv').send({});
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('<div id="root">');
  });

  it('arquivo oculto da pasta (.env) não sai', async () => {
    const res = await request(ligada()).get('/.env');
    expect(res.status).not.toBe(200);
    expect(res.text).not.toContain('DEVE_SAIR');
  });
});

describe('desligada (o padrão)', () => {
  it('a API não serve tela nenhuma — o host estático da frente é quem serve', async () => {
    const res = await request(appCom({ DEVORA_SERVIR_FRONTEND: undefined, DEVORA_FRONTEND_DIR: pasta })).get(
      '/sistema/pdv',
    );
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('API_NOT_FOUND');
  });
});

describe('ligada sem o build', () => {
  it('recusa subir, dizendo o que falta — em vez de responder 404 a todo mundo', () => {
    const vazia = mkdtempSync(join(tmpdir(), 'gs-frontend-vazio-'));
    try {
      expect(() => appCom({ DEVORA_SERVIR_FRONTEND: 'true', DEVORA_FRONTEND_DIR: vazia })).toThrow(
        /build:frontend/,
      );
    } finally {
      rmSync(vazia, { recursive: true, force: true });
    }
  });

  it('e valor que não é true/false também não sobe', () => {
    expect(() => appCom({ DEVORA_SERVIR_FRONTEND: 'sim', DEVORA_FRONTEND_DIR: pasta })).toThrow();
  });
});
