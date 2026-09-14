/**
 * ============================================================================
 * CORPO QUE NÃO É JSON É ERRO DE QUEM MANDOU, E NÃO "ERRO INTERNO" (GAP-PRD-157)
 * ============================================================================
 *
 * O tratador de erro do app só reconhecia `ApiError`. O `SyntaxError` que o
 * `express.json` lança diante de um corpo quebrado — e o `PayloadTooLarge`
 * diante de um corpo acima do teto — caíam no ramo genérico:
 *
 *   - o cliente recebia 500 `API_UNAVAILABLE` "Erro interno.", e a tela dizia
 *     que o servidor falhou quando quem errou foi a requisição;
 *   - o log de produção ganhava um `unhandled_error` COM PILHA por requisição —
 *     o mesmo registro de um defeito de verdade, afogando os defeitos de
 *     verdade;
 *   - `api_request_logs` nem sabia que a requisição existiu.
 *
 * O gatilho realista é o pacote antigo no cache do navegador mandando um corpo
 * que a versão nova não aceita — e "servidor fora" é o pior diagnóstico
 * possível para isso.
 *
 * Este arquivo cobra a resposta PELA ROTA (supertest sobre `createApp`), com o
 * envelope da casa, e cobra que o log de erro fique limpo.
 */
process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

const { createApp } = await import('../src/app.js');
const { resetDbForTests, findRows } = await import('../src/db/database.js');
const { loginForTest } = await import('./helpers/auth.js');

const app = createApp();
let auth: { Authorization: string };

beforeEach(async () => {
  resetDbForTests();
  const login = await loginForTest(app, {
    userId: 'gerente-json',
    companyId: 'loja-json',
    profileCodes: ['gerente_loja'],
  });
  expect(login.status, JSON.stringify(login.body)).toBe(200);
  auth = { Authorization: `Bearer ${login.body.accessToken}` };
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Tudo o que foi para `console.error` durante a chamada — é onde `logError` escreve. */
function espiarLogDeErro() {
  const linhas: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    linhas.push(args.map(String).join(' '));
  });
  return linhas;
}

describe('JSON malformado no corpo', () => {
  it('responde 400 API_INVALID_PAYLOAD com o envelope da casa — não 500', async () => {
    const log = espiarLogDeErro();
    const res = await request(app)
      .post('/api/v1/core/customers')
      .set(auth)
      .set('Content-Type', 'application/json')
      .send('{"name": "x", ');

    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.error.code).toBe('API_INVALID_PAYLOAD');
    expect(res.body.error.message).toMatch(/JSON/);
    // O envelope inteiro: é o que toda tela sabe ler.
    expect(res.body.requestId).toBeTruthy();
    expect(res.body.correlationId).toBeTruthy();
    // A frase do parser (posição, token esperado) é detalhe de implementação:
    // não vai para o cliente.
    expect(JSON.stringify(res.body)).not.toMatch(/Expected|position|Unexpected/);

    // O log de ERRO fica para defeito de verdade.
    expect(log.filter((l) => l.includes('unhandled_error'))).toEqual([]);
  });

  it('o id de correlação que o cliente mandou volta no erro e no cabeçalho', async () => {
    espiarLogDeErro();
    const res = await request(app)
      .post('/api/v1/core/customers')
      .set(auth)
      .set('X-Request-Id', 'req-do-cliente-157')
      .set('Content-Type', 'application/json')
      .send('{quebrado');

    expect(res.status).toBe(400);
    expect(res.body.requestId).toBe('req-do-cliente-157');
    expect(res.headers['x-request-id']).toBe('req-do-cliente-157');
  });

  it('a requisição recusada fica registrada em api_request_logs, como toda recusa', async () => {
    espiarLogDeErro();
    await request(app)
      .post('/api/v1/core/customers')
      .set(auth)
      .set('X-Request-Id', 'req-registrada-157')
      .set('Content-Type', 'application/json')
      .send('{"a":');

    const registradas = findRows<{ requestId?: string; status?: number }>(
      'api_request_logs',
      (r) => r.requestId === 'req-registrada-157',
    );
    expect(registradas).toHaveLength(1);
    expect(registradas[0].status).toBe(400);
  });

  it('vale também antes da autenticação: o parser roda primeiro, e a resposta continua honesta', async () => {
    espiarLogDeErro();
    const res = await request(app)
      .post('/api/v1/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"login": "fulano", "password": ');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('API_INVALID_PAYLOAD');
  });
});

describe('corpo acima do teto', () => {
  it('rota comum (teto de 1 MB) responde 413 API_PAYLOAD_TOO_LARGE com envelope', async () => {
    const log = espiarLogDeErro();
    const grande = JSON.stringify({ name: 'x'.repeat(1_200_000) });
    const res = await request(app)
      .post('/api/v1/core/customers')
      .set(auth)
      .set('Content-Type', 'application/json')
      .send(grande);

    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('API_PAYLOAD_TOO_LARGE');
    // A mensagem diz o teto, que é a única coisa que quem mandou pode ajustar.
    expect(res.body.error.message).toMatch(/1 ?MB/i);
    expect(log.filter((l) => l.includes('unhandled_error'))).toEqual([]);
  });

  it('rota de upload (teto de 8 MB) aceita o que a comum recusa — a folga continua valendo', async () => {
    espiarLogDeErro();
    // 1,2 MB numa rota da lista de 8 MB passa pelo parser; quem responde é a
    // rota (aqui, a própria validação dela ou o 404 do produto), nunca o 413.
    const res = await request(app)
      .post('/api/v1/core/products/nao-existe/images')
      .set(auth)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ dataUrl: `data:image/png;base64,${'A'.repeat(1_200_000)}` }));

    expect(res.status).not.toBe(413);
    expect(res.status).not.toBe(500);
  });
});

describe('erro de verdade continua sendo erro de verdade', () => {
  it('só os erros do PARSER do corpo são traduzidos; exceção comum segue para o ramo de 500', async () => {
    const { erroDoCorpoDaRequisicao } = await import('../src/middleware/erroDoCorpo.js');

    // Uma exceção qualquer — o defeito que o log de erro existe para mostrar.
    expect(erroDoCorpoDaRequisicao(new Error('defeito de verdade'))).toBeNull();
    expect(erroDoCorpoDaRequisicao(new SyntaxError('JSON.parse no meio de um serviço'))).toBeNull();
    expect(erroDoCorpoDaRequisicao('texto solto')).toBeNull();
    expect(erroDoCorpoDaRequisicao(null)).toBeNull();

    // Um erro do parser com status 500 não é "culpa de quem mandou".
    const internoDoParser = Object.assign(new Error('stream encoding should not be set'), {
      type: 'stream.encoding.set',
      status: 500,
      expose: false,
    });
    expect(erroDoCorpoDaRequisicao(internoDoParser)).toBeNull();
  });

  it('charset que o parser não entende vira 415, com envelope', async () => {
    espiarLogDeErro();
    const res = await request(app)
      .post('/api/v1/core/customers')
      .set(auth)
      .set('Content-Type', 'application/json; charset=klingon')
      .send('{"name":"x"}');
    expect(res.status).toBe(415);
    expect(res.body.error.code).toBe('API_UNSUPPORTED_MEDIA_TYPE');
  });
});
