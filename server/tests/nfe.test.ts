import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetEnvCacheForTests } from '../src/config/env.js';
import { resetDbForTests } from '../src/db/database.js';

process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-key';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-32-chars!!';

/*
  CP65 cobrava o roteador `/api/v1/fiscal/nfe`, que saiu inteiro no
  GAP-PRD-096: `number|validate|xml|sign` alteravam o documento de OUTRA
  empresa pelo id e fabricavam chave "3526<timestamp>". A lista completa das
  rotas que respondem 404 está em `rotas-fiscais-legadas-fora-do-ar.test.ts`.

  A trava do SERVIÇO (`authorizeNfeDocumentBackend` recusando sem SEFAZ) saiu
  junto com o serviço na junção do GAP-PRD-075: `NfeService` era o segundo
  escritor de documento fiscal, e a proteção agora é não existir escritor
  nenhum fora de `core_fiscal_documents`.
*/
describe('CP65 — Backend NF-e API', () => {
  beforeEach(() => {
    resetEnvCacheForTests();
    resetDbForTests();
  });

  it('version endpoint reporta checkpoint 65', async () => {
    const app = createApp();
    const res = await request(app).get('/api/v1/version');
    expect(res.status).toBe(200);
    expect(res.body.checkpoint).toBe(73);
  });

  it('o roteador legado da NF-e saiu: health e documentos são 404', async () => {
    const app = createApp();
    expect((await request(app).get('/api/v1/fiscal/nfe/health')).status).toBe(404);
    expect((await request(app).post('/api/v1/fiscal/nfe/documents').send({})).status).toBe(404);
  });
});
