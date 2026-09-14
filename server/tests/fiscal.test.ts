import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetEnvCacheForTests } from '../src/config/env.js';
import { resetDbForTests } from '../src/db/database.js';

process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-key';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-32-chars!!';

/*
  CP64 cobrava o roteador `/api/v1/fiscal` (health, readiness, issuers,
  documents, certificates) — a camada JSON legada que saiu inteira no
  GAP-PRD-096. As afirmações antigas exigiam justamente o que estava errado
  (`transmission:false` cravado, rascunho "homologation" numa tabela que o
  pipeline não lê). A cobertura de que tudo isso responde 404 está em
  `rotas-fiscais-legadas-fora-do-ar.test.ts`; aqui fica a versão e a sonda.
*/
describe('CP64 — Backend Fiscal API', () => {
  beforeEach(() => {
    resetEnvCacheForTests();
    resetDbForTests();
  });

  it('version endpoint reporta checkpoint 64', async () => {
    const app = createApp();
    const res = await request(app).get('/api/v1/version');
    expect(res.status).toBe(200);
    expect(res.body.checkpoint).toBe(73);
  });

  it('a sonda fiscal cravada saiu: /fiscal/health é 404', async () => {
    const app = createApp();
    const res = await request(app).get('/api/v1/fiscal/health');
    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe('API_NOT_FOUND');
  });
});
