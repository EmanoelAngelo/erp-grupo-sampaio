/**
 * ============================================================================
 * O ACESSO SEM SENHA NÃO EXISTE — em ambiente nenhum, por origem nenhuma
 * ============================================================================
 *
 * Havia um atalho de desenvolvimento que entrava sem senha: uma rota listava
 * os usuários ativos de TODAS as empresas e a vizinha emitia sessão só com o
 * id. As travas dele valiam só com o ambiente DECLARADO — e `DEVORA_API_ENV` é
 * `development` por padrão. A instalação da loja estava exatamente nesse
 * buraco: variável ligada, ambiente nenhum declarado.
 *
 * Trava que depende de alguém declarar o ambiente não é garantia. A garantia é
 * a porta não existir. Aqui se cobra, para CADA combinação de
 * `DEVORA_API_ENV` × `NODE_ENV`, com cada uma das três variáveis do atalho
 * (a de hoje, a do build e a antiga) ligada:
 *
 *   - produção ou homologação (por qualquer um dos dois nomes): o `loadEnv`
 *     RECUSA subir e diz qual variável tirar;
 *   - o resto: sobe, AVISA que a variável é aposentada e não liga nada, e as
 *     rotas antigas respondem o 404 JSON genérico da API — pelo loopback, por
 *     outro aparelho e por um cabeçalho que jura ser loopback.
 *
 * E o login continua exigindo o que sempre exigiu: sem usuário e senha não
 * entra; com a senha errada, 401.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const { loadEnv, resetEnvCacheForTests } = await import('../src/config/env.js');
const { createApp } = await import('../src/app.js');
const { resetDbForTests } = await import('../src/db/database.js');
const { linkUserToCompany, upsertCompany, upsertUser } = await import(
  '../src/services/auth/IdentityService.js'
);

/** As três variáveis que um dia ligaram um caminho sem senha. */
const VARIAVEIS = ['DEVORA_DEV_QUICK_LOGIN', 'VITE_DEV_QUICK_LOGIN', 'GRUPO_SAMPAIO_QUICK_LOGIN'] as const;
const AMBIENTES = ['development', 'test', 'staging', 'production'] as const;
const NODE_ENVS = ['development', 'production'] as const;
/** Loopback nos três formatos do socket, e um aparelho da rede da loja. */
const ORIGENS = ['127.0.0.1', '::1', '::ffff:127.0.0.1', '192.168.0.77'] as const;
const ROTAS_ANTIGAS: Array<['get' | 'post', string]> = [
  ['get', '/api/v1/auth/quick-login/users'],
  ['post', '/api/v1/auth/quick-login'],
  ['get', '/api/v1/auth/quick-login'],
];

const SENHA = 'Senha@Forte123';
const ORIGINAL = { ...process.env };

let userId = '';
let companyId = '';

function ehProducao(apiEnv: string, nodeEnv: string): boolean {
  return apiEnv === 'production' || apiEnv === 'staging' || nodeEnv === 'production';
}

/** O app de verdade, visto como se a conexão viesse do endereço dado. */
function vistoDe(app: ReturnType<typeof createApp>, endereco: string) {
  const casca = express();
  casca.use((req, _res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: endereco, configurable: true });
    next();
  });
  casca.use(app);
  return casca;
}

function ambiente(vars: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetEnvCacheForTests();
}

beforeEach(async () => {
  process.env = { ...ORIGINAL };
  resetEnvCacheForTests();
  resetDbForTests();
  companyId = upsertCompany({ slug: 'loja-atalho', legalName: 'Loja Atalho Ltda', tradeName: 'Loja Atalho' });
  userId = await upsertUser({ login: 'GESTORSEMATALHO', displayName: 'Gestor', password: SENHA });
  linkUserToCompany(userId, companyId, 'admin_geral', true);
  // Segredos fortes: a recusa medida em produção é a do atalho, nunca a das chaves.
  process.env.DEVORA_JWT_SECRET = 'jwt-secreto-longo-o-bastante-para-producao-9f3k';
  process.env.DEVORA_ENCRYPTION_KEY = 'chave-de-cifra-longa-o-bastante-para-producao-7q2w';
  for (const nome of VARIAVEIS) delete process.env[nome];
  resetEnvCacheForTests();
});

afterEach(() => {
  process.env = { ...ORIGINAL };
  resetEnvCacheForTests();
  vi.restoreAllMocks();
});

// ============================================================================

describe('cada ambiente, cada NODE_ENV, cada variável ligada', () => {
  for (const variavel of VARIAVEIS) {
    for (const apiEnv of AMBIENTES) {
      for (const nodeEnv of NODE_ENVS) {
        const producao = ehProducao(apiEnv, nodeEnv);
        const caso = `${variavel}=true, DEVORA_API_ENV=${apiEnv}, NODE_ENV=${nodeEnv}`;

        if (producao) {
          it(`${caso}: o servidor RECUSA subir e diz qual variável tirar`, () => {
            ambiente({ DEVORA_API_ENV: apiEnv, NODE_ENV: nodeEnv, [variavel]: 'true' });
            let erro: Error | null = null;
            try {
              loadEnv();
            } catch (e) {
              erro = e as Error;
            }
            expect(erro, 'subiu com a variável do atalho ligada num ambiente de produção').not.toBeNull();
            expect(erro!.message).toContain(variavel);
            expect(erro!.message).toMatch(/sem senha/i);
          });
          continue;
        }

        it(`${caso}: sobe ignorando, avisa, e nenhuma rota antiga responde — de origem nenhuma`, async () => {
          const avisos = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
          ambiente({ DEVORA_API_ENV: apiEnv, NODE_ENV: nodeEnv, [variavel]: 'true' });

          expect(() => loadEnv()).not.toThrow();
          // O esquema não conhece mais a chave: nada no processo a lê.
          expect((loadEnv() as unknown as Record<string, unknown>)[variavel]).toBeUndefined();
          const escrito = avisos.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
          expect(escrito, 'a variável aposentada passou sem aviso').toContain(variavel);
          expect(escrito).toMatch(/aposentada/i);

          const app = createApp();
          for (const origem of ORIGENS) {
            for (const [metodo, rota] of ROTAS_ANTIGAS) {
              const res = await request(vistoDe(app, origem))[metodo](rota).send({ userId, companyId });
              const onde = `${metodo.toUpperCase()} ${rota} de ${origem}`;
              expect(res.status, onde).toBe(404);
              expect(res.headers['content-type'], onde).toMatch(/application\/json/);
              expect(res.body.error?.code, onde).toBe('API_NOT_FOUND');
              expect(res.body.accessToken, onde).toBeUndefined();
              expect(res.body.users, onde).toBeUndefined();
            }
          }
        });
      }
    }
  }

  it('um cabeçalho jurando ser loopback, com trust proxy ligado, também dá 404', async () => {
    ambiente({ DEVORA_API_ENV: 'development', NODE_ENV: 'development', DEVORA_DEV_QUICK_LOGIN: 'true' });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const app = createApp();
    app.set('trust proxy', true);
    const res = await request(vistoDe(app, '192.168.0.77'))
      .get('/api/v1/auth/quick-login/users')
      .set('X-Forwarded-For', '127.0.0.1');
    expect(res.status).toBe(404);
    expect(res.body.users).toBeUndefined();
  });

  it('"ligada" não depende da grafia: TRUE, 1 e sim também recusam em produção', () => {
    for (const valor of ['TRUE', ' 1 ', 'sim', 'yes', 'on']) {
      ambiente({ DEVORA_API_ENV: 'production', NODE_ENV: 'production', DEVORA_DEV_QUICK_LOGIN: valor });
      expect(() => loadEnv(), JSON.stringify(valor)).toThrow(/DEVORA_DEV_QUICK_LOGIN/);
    }
  });

  /*
    O COMENTÁRIO NA MESMA LINHA NÃO DESLIGA A TRAVA.

    O leitor do `.env` desta casa (`lerArquivoDotEnv`) não corta comentário
    depois do valor: `DEVORA_DEV_QUICK_LOGIN=true   # para entrar rapido`
    chega ao processo como `true   # para entrar rapido`. Quem escreveu isso
    quis ligar — e o `secret:scan` já o acha no repositório. A trava do boot
    e a conferência não achavam: a produção subia calada.
  */
  it('`true` seguido de comentário na mesma linha também recusa em produção', () => {
    for (const valor of ['true   # para entrar rapido', 'true#dev', '"true" # aspas e comentario']) {
      ambiente({ DEVORA_API_ENV: 'production', NODE_ENV: 'production', DEVORA_DEV_QUICK_LOGIN: valor });
      expect(() => loadEnv(), JSON.stringify(valor)).toThrow(/DEVORA_DEV_QUICK_LOGIN/);
    }
  });

  it('`false` seguido de comentário continua desligada — sobe, só avisando', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    ambiente({ DEVORA_API_ENV: 'production', NODE_ENV: 'production', DEVORA_DEV_QUICK_LOGIN: 'false # desligado' });
    expect(() => loadEnv()).not.toThrow();
  });
});

// ============================================================================

describe('e o que é legítimo continua subindo', () => {
  it('produção sem nenhuma das três sobe, sem aviso de variável aposentada', () => {
    const avisos = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    ambiente({ DEVORA_API_ENV: 'production', NODE_ENV: 'production' });
    expect(() => loadEnv()).not.toThrow();
    const escrito = avisos.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
    expect(escrito).not.toMatch(/aposentada/i);
  });

  it('produção com a variável escrita `false` sobe — e avisa que ela não liga nada', () => {
    const avisos = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    ambiente({ DEVORA_API_ENV: 'production', NODE_ENV: 'production', DEVORA_DEV_QUICK_LOGIN: 'false' });
    expect(() => loadEnv()).not.toThrow();
    const escrito = avisos.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
    expect(escrito).toContain('DEVORA_DEV_QUICK_LOGIN');
  });
});

// ============================================================================

describe('o login exige usuário e senha — não há outro jeito de entrar', () => {
  it('sem usuário e sem senha, não entra', async () => {
    const res = await request(createApp()).post('/api/v1/auth/login').send({});
    expect(res.status).toBe(400);
    expect(res.body.accessToken).toBeUndefined();
  });

  it('com o usuário e sem a senha, não entra', async () => {
    const res = await request(createApp()).post('/api/v1/auth/login').send({ login: 'GESTORSEMATALHO' });
    expect(res.status).toBe(400);
    expect(res.body.accessToken).toBeUndefined();
  });

  it('só com o id do usuário e da empresa — o formato do atalho —, não entra', async () => {
    const res = await request(createApp()).post('/api/v1/auth/login').send({ userId, companyId });
    expect(res.status).toBe(400);
    expect(res.body.accessToken).toBeUndefined();
  });

  it('com a senha errada, 401', async () => {
    const res = await request(createApp())
      .post('/api/v1/auth/login')
      .send({ login: 'GESTORSEMATALHO', password: 'errada-de-proposito' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('API_INVALID_CREDENTIALS');
    expect(res.body.accessToken).toBeUndefined();
  });

  it('com a senha certa, entra — o controle de que o teste mede o login de verdade', async () => {
    const res = await request(createApp())
      .post('/api/v1/auth/login')
      .send({ login: 'GESTORSEMATALHO', password: SENHA });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
  });
});
