/**
 * ============================================================================
 * UMA API QUE RESPONDE HTML NÃO É UMA API
 * ============================================================================
 *
 * Achado ao subir o build de produção e bater numa rota que não existe:
 *
 *     GET /api/v1/nao-existe  →  200 bytes de `<!DOCTYPE html>` com
 *                                "Cannot GET /api/v1/nao-existe"
 *
 * É a página padrão do Express. O erro do projeto tem envelope — `{ error:
 * { code, message }, requestId }` — e toda tela sabe lê-lo; mas o caminho que
 * NÃO chega a rota nenhuma nunca passou pelo tratador, e caiu no fallback do
 * framework.
 *
 * ## Por que isso importa mais depois desta rodada
 *
 * O cliente passou a transformar corpo-não-JSON em `API_INVALID_RESPONSE`,
 * com a frase "o servidor respondeu algo que não é JSON; se houver um proxy no
 * caminho, ele pode estar respondendo no lugar da API". Diante deste 404 a
 * frase é FALSA e manda procurar no lugar errado: não há proxy nenhum — a rota
 * é que não existe.
 *
 * E o gatilho é o mesmo do resto do bloco: no dia do deploy, o pacote antigo
 * no cache do navegador chama uma rota que saiu. O que ele tem de receber é
 * "não encontrado", não uma página de erro de framework.
 *
 * ## O que a página padrão ainda entrega de brinde
 *
 * O caminho pedido, ecoado no corpo. Não é segredo, mas é superfície: um
 * respondedor de API não devolve HTML com o que o cliente digitou.
 */
process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_DATABASE_PATH = ':memory:';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';

const { createApp } = await import('../src/app.js');
const { resetDbForTests } = await import('../src/db/database.js');

const app = createApp();

beforeEach(() => {
  resetDbForTests();
});

// ============================================================================

describe('rota que não existe responde JSON, e não a página do Express', () => {
  it('dentro de /api/v1', async () => {
    const res = await request(app).get('/api/v1/nao-existe-em-lugar-nenhum');

    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.error.code).toBe('API_NOT_FOUND');
    expect(String(res.text)).not.toMatch(/<!DOCTYPE html>/i);
  });

  it('fora de /api também — nada neste processo serve HTML', async () => {
    const res = await request(app).get('/qualquer-coisa');

    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.error.code).toBe('API_NOT_FOUND');
  });

  it('em POST, PUT e DELETE também', async () => {
    for (const metodo of ['post', 'put', 'delete', 'patch'] as const) {
      const res = await request(app)[metodo]('/api/v1/rota-que-nao-existe');
      expect(res.status, metodo).toBe(404);
      expect(res.body.error?.code, metodo).toBe('API_NOT_FOUND');
    }
  });

  it('e carrega o requestId, como todo erro deste servidor', async () => {
    /*
      O id é o que liga a reclamação de quem está na loja à linha do log. Um
      404 sem ele é um 404 que não dá para investigar.
    */
    const res = await request(app).get('/api/v1/nao-existe');
    expect(res.body.requestId).toBeTruthy();
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('a mensagem NÃO ecoa o caminho pedido', async () => {
    /*
      "Cannot GET /api/v1/<o que o cliente digitou>" devolve entrada não
      tratada dentro de HTML. Não é segredo, mas é superfície — e um
      respondedor de API não tem por que ter nenhuma.
    */
    const res = await request(app).get('/api/v1/<script>alert(1)</script>');
    expect(String(res.text)).not.toContain('<script>');
  });
});

// ============================================================================

describe('e o que existe continua respondendo como antes', () => {
  it('a saúde responde 200', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('rota protegida sem token continua 401 com o envelope', async () => {
    const res = await request(app).get('/api/v1/core/products');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('API_AUTHENTICATION_REQUIRED');
  });

  it('rota que existe e recusa continua com o código DELA, não com 404', async () => {
    // O login sem credencial é recusado pela própria rota, com o código dela
    // — a recusa é uma decisão da rota, não a ausência dela.
    const res = await request(app).post('/api/v1/auth/login').send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('API_INVALID_PAYLOAD');
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('a porta sem senha que existia responde o 404 genérico — como endereço que nunca existiu', async () => {
    for (const rota of ['/api/v1/auth/quick-login/users', '/api/v1/auth/quick-login']) {
      const res = await request(app).get(rota);
      expect(res.status, rota).toBe(404);
      expect(res.body.error.code, rota).toBe('API_NOT_FOUND');
      expect(res.headers['content-type'], rota).toMatch(/application\/json/);
    }
  });
});
