/**
 * GAP-PRD-127 — o que se diz ao dono sobre o Melhor Envio bate com o código.
 *
 * `docs/ESTADO-ATUAL.md` classificava o Melhor Envio como pronto para "token de
 * sandbox e de produção" quando produção não existia no código; e a tela
 * Integrações repetia a frase num objeto FIXO de `core.ts`, com
 * `configured: false` para sempre. Os dois agora são conferidos aqui contra o
 * comportamento — a frase no documento e a linha na tela.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetEnvCacheForTests } from '../src/config/env.js';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import {
  linkUserToCompany,
  upsertCompany,
  upsertUser,
} from '../src/services/auth/IdentityService.js';
import { upsertLogisticsCredentials } from '../src/services/logistics/LogisticsCredentialService.js';

process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-key';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-32-chars!!';

const app = createApp();
const SENHA = 'Teste@MelhorEnvio2026';
const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

let companyId: string;
let gerente: { Authorization: string };

function guardar(environment: 'homologation' | 'production', token: string) {
  upsertLogisticsCredentials({ companyId, carrier: 'melhor_envio', environment, credentials: { token } });
}

async function linhaDoMelhorEnvio() {
  const res = await request(app).get('/api/v1/core/integrations/status').set(gerente);
  expect(res.status).toBe(200);
  return res.body.providers.find((p: { provider: string }) => p.provider === 'melhor-envio');
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  process.env.LOGISTICS_PRODUCTION_ENABLED = 'true';
  resetEnvCacheForTests();
  companyId = upsertCompany({ slug: 'gringa', legalName: 'Gringa Comércio Ltda', tradeName: 'Gringa' });
  const userId = await upsertUser({ login: 'GERENTE_DOC', displayName: 'Gerente', password: SENHA });
  linkUserToCompany(userId, companyId, 'gerente_loja', true);
  const login = await request(app).post('/api/v1/auth/login').send({ login: 'GERENTE_DOC', password: SENHA });
  gerente = { Authorization: `Bearer ${login.body.accessToken}` };
});

afterEach(() => {
  delete process.env.LOGISTICS_PRODUCTION_ENABLED;
  resetEnvCacheForTests();
});

describe('a linha do Melhor Envio em Integrações', () => {
  it('sai da credencial guardada, não de um objeto fixo', async () => {
    expect(await linhaDoMelhorEnvio()).toMatchObject({ configured: false, readiness: 'READY_FOR_CREDENTIAL' });

    guardar('homologation', 'me-sandbox-token-de-teste-0002');
    expect(await linhaDoMelhorEnvio()).toMatchObject({
      configured: true,
      environment: 'sandbox',
      readiness: 'READY_FOR_SANDBOX_TEST',
    });

    guardar('production', 'me-prod-token-de-teste-0001');
    expect(await linhaDoMelhorEnvio()).toMatchObject({
      configured: true,
      environment: 'producao',
      readiness: 'PRODUCTION_ENABLED',
    });
  });

  it('com a trava do servidor desligada, diz qual chave falta', async () => {
    process.env.LOGISTICS_PRODUCTION_ENABLED = 'false';
    resetEnvCacheForTests();
    guardar('production', 'me-prod-token-de-teste-0001');

    const linha = await linhaDoMelhorEnvio();
    expect(linha.readiness).toBe('BLOCKED_BY_PROCESS');
    expect(linha.missing).toMatch(/LOGISTICS_PRODUCTION_ENABLED/);
  });
});

describe('docs/ESTADO-ATUAL.md', () => {
  it('não promete o que não existe, e nomeia o que o dono precisa ligar', () => {
    const estado = readFileSync(resolve(RAIZ, 'docs/ESTADO-ATUAL.md'), 'utf8');
    const linhas = estado.split(/\r?\n/).filter((l) => l.startsWith('| Melhor Envio'));
    expect(linhas.length).toBeGreaterThan(0);
    // A promessa antiga — "token de sandbox e de produção" como se bastasse — sumiu.
    expect(estado).not.toMatch(/\| Melhor Envio \| `READY_FOR_CREDENTIAL` \| Token de sandbox e de produção \|/);
    // A cotação cita a chave do servidor. Etiqueta e rastreio eram `MISSING_IMPLEMENTATION`
    // até o lote L2 (GAP-PRD-119/120), que os programou: agora esperam a mesma
    // credencial, e o documento diz isso — sem prometer chamada real medida.
    expect(linhas.join('\n')).toMatch(/LOGISTICS_PRODUCTION_ENABLED/);
    expect(linhas.join('\n')).toMatch(/etiqueta e rastreio\*\* \| `READY_FOR_CREDENTIAL`/);
    expect(linhas.join('\n')).toMatch(/nenhuma etiqueta real foi comprada/);
    expect(linhas.join('\n')).not.toMatch(/MISSING_IMPLEMENTATION/);
  });

  it('o que o documento cita existe no código', () => {
    const env = readFileSync(resolve(RAIZ, 'server/src/config/env.ts'), 'utf8');
    expect(env).toMatch(/LOGISTICS_MELHOR_ENVIO_PRODUCTION_URL/);
    expect(env).toMatch(/LOGISTICS_PRODUCTION_ENABLED/);
    // A variável de teste não decide mais nada no servidor.
    expect(env).not.toMatch(/logisticsHomologationTests/);
  });
});
