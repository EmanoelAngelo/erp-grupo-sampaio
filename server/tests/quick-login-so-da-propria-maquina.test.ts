/**
 * NEM DA PRÓPRIA MÁQUINA — a porta sem senha não existe para origem nenhuma.
 *
 * A rodada 34 mediu o buraco: `DEVORA_DEV_QUICK_LOGIN=true` no `.env` da loja,
 * nenhum `DEVORA_API_ENV` (logo 'development'), e qualquer aparelho no Wi-Fi
 * recebia a lista dos 23 funcionários das seis empresas e virava qualquer um
 * deles com um clique. O conserto de então foi uma quarta trava: só o
 * loopback, lendo o socket. Este arquivo cobrava que a própria máquina ENTRAVA
 * e que as outras não.
 *
 * Agora nenhuma entra. As rotas saíram: a própria máquina, o aparelho da rede
 * e o cabeçalho forjado recebem o mesmo 404 genérico da API — o de qualquer
 * endereço que nunca existiu.
 *
 * COMO SE SIMULA A ORIGEM: o supertest sempre conecta por loopback; o teste
 * envolve o app num middleware que reescreve `socket.remoteAddress`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { resetEnvCacheForTests } from '../src/config/env.js';
import {
  linkUserToCompany,
  upsertCompany,
  upsertUser,
} from '../src/services/auth/IdentityService.js';

const ORIGINAL = { ...process.env };

let app: ReturnType<typeof createApp>;
let userId: string;
let companyId: string;

/** O app de verdade, visto como se a conexão viesse do endereço dado. */
function vistoDe(endereco: string) {
  const casca = express();
  casca.use((req, _res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: endereco, configurable: true });
    next();
  });
  casca.use(app);
  return casca;
}

beforeEach(async () => {
  // A variável ligada, como no `.env` da loja: o pior caso de antes.
  process.env.DEVORA_DEV_QUICK_LOGIN = 'true';
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  resetEnvCacheForTests();
  resetDbForTests();
  app = createApp();
  companyId = upsertCompany({ slug: 'preco-justo', legalName: 'Preço Justo Ltda', tradeName: 'Preço Justo' });
  userId = await upsertUser({ login: 'GESTORATALHO', displayName: 'Gestor', password: 'Senha@Forte123' });
  linkUserToCompany(userId, companyId, 'gestor', true);
});

afterEach(() => {
  process.env = { ...ORIGINAL };
  resetEnvCacheForTests();
  vi.restoreAllMocks();
});

function semPorta(res: request.Response, onde: string): void {
  expect(res.status, onde).toBe(404);
  expect(res.body.error?.code, onde).toBe('API_NOT_FOUND');
  expect(res.body.users, onde).toBeUndefined();
  expect(res.body.accessToken, onde).toBeUndefined();
}

describe('a própria máquina não entra mais', () => {
  it('pelo loopback (o jeito do supertest): a lista e a entrada respondem 404', async () => {
    semPorta(await request(app).get('/api/v1/auth/quick-login/users'), 'lista');
    semPorta(await request(app).post('/api/v1/auth/quick-login').send({ userId, companyId }), 'entrada');
  });

  it('loopback em IPv6 e IPv4-mapeado também: 404', async () => {
    for (const endereco of ['::1', '::ffff:127.0.0.1', '127.0.0.1']) {
      semPorta(await request(vistoDe(endereco)).get('/api/v1/auth/quick-login/users'), endereco);
      semPorta(await request(vistoDe(endereco)).post('/api/v1/auth/quick-login').send({ userId, companyId }), endereco);
    }
  });
});

describe('nem outro aparelho da rede', () => {
  it('a lista responde 404', async () => {
    semPorta(await request(vistoDe('192.168.0.77')).get('/api/v1/auth/quick-login/users'), 'lista');
  });

  it('a entrada responde 404 e não emite sessão', async () => {
    semPorta(await request(vistoDe('10.0.0.5')).post('/api/v1/auth/quick-login').send({ userId, companyId }), 'entrada');
  });

  it('com trust proxy ligado, cabeçalho dizendo "sou loopback" não muda nada', async () => {
    app.set('trust proxy', true);
    const res = await request(vistoDe('192.168.0.77'))
      .get('/api/v1/auth/quick-login/users')
      .set('X-Forwarded-For', '127.0.0.1');
    semPorta(res, 'cabeçalho forjado');
  });
});
