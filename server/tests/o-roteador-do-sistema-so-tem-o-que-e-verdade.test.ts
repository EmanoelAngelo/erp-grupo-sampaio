/**
 * O ROTEADOR /system SÓ TEM O QUE É VERDADE (GAP-PRD-064).
 *
 * A auditoria achou o roteador inteiro sem tela, e sete rotas respondendo
 * estado cravado: `/health-dashboard` ("database ok" sem abrir o banco),
 * `/recovery` e `/reconciliation` ("scan_ok" para qualquer empresa),
 * `/homologations` (o "Core ERP" homologado por constante), `/inventory`
 * ("CP01-CP73", `indexedDbVersion: 67`), `/go-live` e `/go-live/activate-core`
 * — que respondia "Core Production ativado no backend" sem ativar nada. Os
 * documentos de operação mandavam o operador para telas que as consumiriam.
 *
 * Aqui: as sete saíram (404 com o envelope de erro), o contrato OpenAPI não as
 * anuncia, e o que ficou tem dado de verdade — `/release` diz o Node, desde
 * quando o processo está no ar e a versão do NÚCLEO.
 */
process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';

const { createApp } = await import('../src/app.js');
// Sessão da conta que EXISTE: authMiddleware confere a conta a cada requisição (GAP-PRD-053).
const { issueSession } = await import('./helpers/sessao.js');
const { prepararBanco } = await import('../src/db/migracaoCompleta.js');
const { CORE_TARGET_VERSION } = await import('../src/db/core-migrations.js');

const app = createApp();

function dono() {
  const t = issueSession({
    userId: 'dono-sistema',
    companyId: 'company-sistema',
    storeId: 'store-sistema',
    profileCodes: ['admin_geral'],
  });
  return { Authorization: `Bearer ${t.accessToken}` };
}

beforeAll(() => {
  prepararBanco();
});

const REMOVIDAS: Array<['get' | 'post', string]> = [
  ['get', '/health-dashboard'],
  ['get', '/recovery'],
  ['get', '/reconciliation'],
  ['get', '/homologations'],
  ['get', '/inventory'],
  ['get', '/go-live'],
  ['post', '/go-live/activate-core'],
];

describe('as rotas que respondiam estado cravado saíram', () => {
  for (const [metodo, caminho] of REMOVIDAS) {
    it(`${metodo.toUpperCase()} /system${caminho} → 404`, async () => {
      const res = await request(app)[metodo](`/api/v1/system${caminho}`)
        .set(dono())
        .send({ confirmationText: 'ATIVAR DEVORA CORE EM PRODUÇÃO' });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('API_NOT_FOUND');
    });
  }

  it('o contrato OpenAPI não anuncia nenhuma delas, e anuncia a implantação por empresa', async () => {
    const res = await request(app).get('/api/v1/openapi.json');
    const caminhos = Object.keys(res.body.paths ?? {});
    for (const [, caminho] of REMOVIDAS) {
      expect(caminhos, `/system${caminho} ainda está no openapi`).not.toContain(`/system${caminho}`);
    }
    expect(caminhos).toContain('/system/implantacao/empresas/{companyId}');
  });
});

describe('o que ficou tem dado de verdade', () => {
  it('/system/release diz a versão do núcleo e o processo que está no ar', async () => {
    const res = await request(app).get('/api/v1/system/release').set(dono());
    expect(res.status).toBe(200);
    expect(res.body.databaseVersion).toBe(CORE_TARGET_VERSION);
    expect(res.body.databaseSituation).toBe('EM_DIA');
    expect(res.body.processo.node).toBe(process.version);
    expect(Date.parse(res.body.processo.noArDesde)).toBeLessThanOrEqual(Date.now());
    expect(res.body).not.toHaveProperty('indexedDbVersion');
  });

  it('/system/release e /system/readiness continuam fechados a quem não responde pelo grupo', async () => {
    const t = issueSession({
      userId: 'gerente-sistema',
      companyId: 'company-sistema',
      storeId: 'store-sistema',
      profileCodes: ['gerente_loja'],
    });
    const h = { Authorization: `Bearer ${t.accessToken}` };
    expect((await request(app).get('/api/v1/system/release').set(h)).status).toBe(403);
    expect((await request(app).get('/api/v1/system/readiness').set(h)).status).toBe(403);
  });
});
