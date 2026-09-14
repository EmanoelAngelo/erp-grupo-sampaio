/**
 * ============================================================================
 * AS ROTAS LEGADAS /api/v1/asaas/* (GAP-PRD-155, GAP-PRD-093)
 * ============================================================================
 *
 * GAP-PRD-155 — O RETRY DA FILA ATRAVESSAVA EMPRESA. `POST /asaas/queue/:id/
 * retry` chamava `processOperationalAttempt(id)` e o serviço buscava a
 * tentativa SÓ pelo id: o gestor da empresa B, com o id de uma tentativa da
 * empresa A, disparava o processamento de A com o cofre de A — e ainda
 * recebia `200 {status:'not_found'}`, porque a lista de B não a mostrava. A
 * resposta escondia o que tinha acontecido, e a auditoria não registrava quem
 * disparou.
 *
 * GAP-PRD-093 — CONTRATO PÚBLICO COM CARA DE REAL. `GET /asaas/charges/:id`
 * respondia `{status:'queued'}` para QUALQUER id; `POST /asaas/homologation/
 * start` respondia `in_progress, steps: []` sem rodar nada; `POST /asaas/
 * production/activate` respondia `activated:false`; `POST /asaas/charges`
 * enfileirava numa coleção paralela que nunca vira título nem baixa; e `GET
 * /asaas/status` lia só o `.env`, dizendo "não configurado" com a chave da
 * operação no cofre. Um integrador que seguisse o OpenAPI criaria cobrança
 * numa fila que ninguém lê.
 *
 * Agora: o que fingia responde 410 dizendo QUAL rota faz o serviço de
 * verdade; o status lê o cofre da operação; o retry é cercado pela empresa do
 * token, responde 404 para id alheio sem tocar nada, e fica na auditoria.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetEnvCacheForTests } from '../src/config/env.js';
import { resetDbForTests, findOneRow, findRows } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { loginForTest } from './helpers/auth.js';
import {
  enqueueOperationalAttempt,
  processOperationalAttempt,
} from '../src/services/asaas/AsaasOperationalService.js';
import { upsertAsaasApiKey } from '../src/services/integrations/AsaasCredentialService.js';

process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-key';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-32-chars!!';

const app = createApp();

async function entrar(companyId: string, userId: string): Promise<{ Authorization: string }> {
  const login = await loginForTest(app, { userId, companyId, profileCodes: ['admin_geral'] });
  expect(login.status).toBe(200);
  return { Authorization: `Bearer ${login.body.accessToken}` };
}

function tentativaDe(companyId: string, chave: string): Record<string, unknown> {
  return enqueueOperationalAttempt({
    companyId,
    operationType: 'asaas_customer_sync',
    sourceType: 'customer',
    sourceId: `cli-${chave}`,
    idempotencyKey: chave,
    correlationId: `corr-${chave}`,
    payload: { name: 'Cliente da fila', customerId: `cli-${chave}`, document: '24971563792' },
  });
}

function lerTentativa(id: string): Record<string, unknown> | null {
  return findOneRow<Record<string, unknown>>('asaas_operational_attempts', (row) => row.id === id);
}

beforeEach(() => {
  process.env.ASAAS_ENABLED = 'false';
  process.env.ASAAS_PRODUCTION_ENABLED = 'false';
  delete process.env.ASAAS_API_KEY;
  resetEnvCacheForTests();
  resetDbForTests();
  ensureCoreSchema();
  vi.stubGlobal('fetch', async () => {
    throw new TypeError('rede bloqueada neste teste');
  });
});

// ============================================================================
describe('GAP-PRD-155 — o retry da fila é da empresa do token', () => {
  it('B com o id da tentativa de A: 404, e a tentativa de A NÃO muda', async () => {
    await entrar('empresa-a', 'gestor-a');
    const b = await entrar('empresa-b', 'gestor-b');
    const deA = tentativaDe('empresa-a', 'fila-a-1');
    expect(lerTentativa(String(deA.id))?.status).toBe('queued');

    const res = await request(app).post(`/api/v1/asaas/queue/${deA.id}/retry`).set(b).send({});

    // Antes: 200 {status:'not_found'} — e a tentativa de A virava
    // retry_pending/ASAAS_DISABLED, processada com o cofre de A.
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ASAAS_ATTEMPT_NOT_FOUND');
    const depois = lerTentativa(String(deA.id));
    expect(depois?.status).toBe('queued');
    expect(depois?.sanitizedError).toBeUndefined();
    expect(depois?.retryCount).toBe(0);
  });

  it('o serviço também recusa processar tentativa de outra empresa (sem depender da rota)', async () => {
    const deA = tentativaDe('empresa-a', 'fila-a-2');

    const r = await processOperationalAttempt(String(deA.id), 'empresa-b');

    expect(r).toBeNull();
    expect(lerTentativa(String(deA.id))?.status).toBe('queued');
  });

  it('A reprocessa a própria tentativa: 200 com o estado novo, e a auditoria diz quem disparou', async () => {
    const a = await entrar('empresa-a', 'gestor-a');
    const deA = tentativaDe('empresa-a', 'fila-a-3');

    const res = await request(app).post(`/api/v1/asaas/queue/${deA.id}/retry`).set(a).send({});

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(deA.id);
    // Sem Asaas habilitado nem chave no cofre: o processamento de verdade
    // rodou e registrou o motivo — nada de "not_found" inventado.
    expect(res.body.status).toBe('retry_pending');
    expect(res.body.sanitizedError).toBe('ASAAS_DISABLED');

    const auditoria = getConnection()
      .prepare(
        `SELECT company_id, user_id, action, entity_id, detail FROM core_audit_log
          WHERE action = 'asaas.queue.retry'`,
      )
      .all() as { company_id: string; user_id: string; entity_id: string; detail: string }[];
    expect(auditoria).toHaveLength(1);
    expect(auditoria[0].company_id).toBe('empresa-a');
    expect(auditoria[0].user_id).toBeTruthy();
    expect(auditoria[0].entity_id).toBe(deA.id);
    expect(JSON.parse(auditoria[0].detail)).toMatchObject({ antes: 'queued', depois: 'retry_pending' });
  });

  it('a recusa de B também fica na auditoria — sem vazar o estado da tentativa alheia', async () => {
    await entrar('empresa-a', 'gestor-a');
    const b = await entrar('empresa-b', 'gestor-b');
    const deA = tentativaDe('empresa-a', 'fila-a-4');

    await request(app).post(`/api/v1/asaas/queue/${deA.id}/retry`).set(b).send({});

    const linhas = getConnection()
      .prepare(`SELECT company_id, detail FROM core_audit_log WHERE action = 'asaas.queue.retry_denied'`)
      .all() as { company_id: string; detail: string }[];
    expect(linhas).toHaveLength(1);
    expect(linhas[0].company_id).toBe('empresa-b');
    expect(linhas[0].detail).not.toContain('queued');
  });

  it('a listagem da fila continua cercada pela empresa', async () => {
    const a = await entrar('empresa-a', 'gestor-a');
    const b = await entrar('empresa-b', 'gestor-b');
    tentativaDe('empresa-a', 'fila-a-5');

    const deB = await request(app).get('/api/v1/asaas/queue').set(b);
    const deA = await request(app).get('/api/v1/asaas/queue').set(a);

    expect(deB.status).toBe(200);
    expect(deB.body.items).toHaveLength(0);
    expect(deA.body.items).toHaveLength(1);
  });
});

// ============================================================================
describe('GAP-PRD-093 — rota que fingia responde 410 e diz qual é a de verdade', () => {
  const QUE_SAIRAM: { metodo: 'get' | 'post'; caminho: string; substituta: RegExp }[] = [
    { metodo: 'get', caminho: '/api/v1/asaas/charges/qualquer-coisa', substituta: /\/core\/payment-intents/ },
    { metodo: 'post', caminho: '/api/v1/asaas/charges', substituta: /\/core\/finance\/entries\/:id\/charge/ },
    { metodo: 'post', caminho: '/api/v1/asaas/charges/qualquer-coisa/cancel', substituta: /\/core\/finance\/entries\/:id\/charges\/cancel/ },
    { metodo: 'post', caminho: '/api/v1/asaas/customers/sync', substituta: /\/core\/finance\/entries\/:id\/charge/ },
    { metodo: 'post', caminho: '/api/v1/asaas/homologation/start', substituta: /\/core\/integrations\/asaas\/homologar/ },
    // A substituta era `POST /integrations/asaas/activate`, que saiu com o
    // roteador `/integrations` (GAP-PRD-075): produção se pede pela tela do Asaas.
    { metodo: 'post', caminho: '/api/v1/asaas/production/activate', substituta: /PATCH \/api\/v1\/core\/integrations\/asaas/ },
  ];

  for (const rota of QUE_SAIRAM) {
    it(`${rota.metodo.toUpperCase()} ${rota.caminho} → 410 com a substituta`, async () => {
      const auth = await entrar('empresa-a', 'gestor-a');
      const antes = findRows('asaas_operational_attempts', () => true).length;

      const chamada = request(app)[rota.metodo](rota.caminho)
        .set({ ...auth, 'Idempotency-Key': `legado-${rota.caminho}` });
      const res = rota.metodo === 'post'
        ? await chamada.send({ billingType: 'PIX', value: 10, customerId: 'c1' })
        : await chamada;

      // Antes: 200 {status:'queued'} para qualquer id, 202 com fila paralela,
      // 202 'in_progress' com steps [], 403/200 'activated:false'.
      expect(res.status).toBe(410);
      expect(res.body.error.code).toBe('API_ROUTE_GONE');
      expect(String(res.body.error.details?.substituta)).toMatch(rota.substituta);
      // Nenhum dos corpos inventados sobrevive: nem status, nem passos, nem id.
      expect(res.body.status).toBeUndefined();
      expect(res.body.steps).toBeUndefined();
      expect(res.body.activated).toBeUndefined();
      // E nada nasce na fila paralela.
      expect(findRows('asaas_operational_attempts', () => true).length).toBe(antes);
    });
  }

  it('sem sessão continua 401: a rota que saiu não vira porta aberta', async () => {
    const res = await request(app).get('/api/v1/asaas/charges/x');
    expect(res.status).toBe(401);
  });

  it('GET /asaas/status lê o COFRE da operação, não só o .env', async () => {
    const auth = await entrar('empresa-a', 'gestor-a');
    upsertAsaasApiKey({ companyId: 'empresa-a', environment: 'sandbox', apiKey: '$aact_sandbox_cofre_a_0000000000' });

    const res = await request(app).get('/api/v1/asaas/status').set(auth);

    // Antes: sandbox.configured=false com a chave da operação no cofre.
    expect(res.status).toBe(200);
    expect(res.body.sandbox.configured).toBe(true);
    expect(res.body.sandbox.source).toBe('vault');
    expect(res.body.production.configured).toBe(false);
    expect(res.body.companyId).toBe('empresa-a');
    expect(JSON.stringify(res.body)).not.toContain('$aact_sandbox_cofre_a_0000000000');
  });

  it('o status de uma operação não enxerga a chave de outra', async () => {
    await entrar('empresa-a', 'gestor-a');
    const b = await entrar('empresa-b', 'gestor-b');
    upsertAsaasApiKey({ companyId: 'empresa-a', environment: 'sandbox', apiKey: '$aact_sandbox_cofre_a_0000000000' });

    const res = await request(app).get('/api/v1/asaas/status').set(b);

    expect(res.status).toBe(200);
    expect(res.body.sandbox.configured).toBe(false);
    expect(res.body.sandbox.source).toBe('none');
  });

  it('o OpenAPI não anuncia mais as rotas que saíram — e continua anunciando as que ficaram', async () => {
    const res = await request(app).get('/api/v1/openapi.json');
    const caminhos = Object.keys(res.body.paths as Record<string, unknown>);
    expect(caminhos).not.toContain('/asaas/charges');
    expect(caminhos).not.toContain('/asaas/charges/{chargeLinkId}');
    expect(caminhos).not.toContain('/asaas/homologation/start');
    expect(caminhos).not.toContain('/asaas/production/activate');
    expect(caminhos).toContain('/asaas/status');
    expect(caminhos).toContain('/core/finance/entries/{id}/charge');
  });
});
