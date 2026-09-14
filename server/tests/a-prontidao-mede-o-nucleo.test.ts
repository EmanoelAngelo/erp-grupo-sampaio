/**
 * A PRONTIDÃO MEDE O NÚCLEO, NÃO A CAMADA DE DOCUMENTOS (GAP-PRD-057).
 *
 * Harness da auditoria: `GET /system/readiness` → `coreStatus: READY`,
 * `databaseVersion: 19`, com o núcleo em 84. O READY vinha de
 * `db.version >= 15` — a versão da camada de documentos, que fica em 19 para
 * sempre depois do primeiro boot. Uma sonda que não pode ficar vermelha.
 * E `/version` publicava `indexedDbVersion: 67`, de um IndexedDB que o
 * frontend não tem.
 *
 * Aqui: com os documentos migrados e o núcleo NÃO, a prontidão diz NOT_READY
 * e por quê; com o núcleo no alvo, READY, e o número publicado é o do núcleo.
 */
process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';
for (const flag of [
  'ASAAS_PRODUCTION_ENABLED',
  'NFE_PRODUCTION_ENABLED',
  'NFCE_PRODUCTION_ENABLED',
  'LOGISTICS_PRODUCTION_ENABLED',
  'PAYMENT_TERMINAL_PRODUCTION_ENABLED',
  'ECOMMERCE_PRODUCTION_ENABLED',
]) {
  process.env[flag] = 'false';
}

import { describe, expect, it } from 'vitest';
import request from 'supertest';

const { createApp } = await import('../src/app.js');
// Sessão da conta que EXISTE: authMiddleware confere a conta a cada requisição (GAP-PRD-053).
const { issueSession } = await import('./helpers/sessao.js');
const { runMigrations, ALVO_DA_CAMADA_DE_DOCUMENTOS } = await import('../src/db/migrate.js');
const { CORE_TARGET_VERSION, migrateCoreSchema } = await import('../src/db/core-migrations.js');
const { getConnection } = await import('../src/db/sqlite.js');

const app = createApp();

function dono() {
  const t = issueSession({
    userId: 'dono-prontidao',
    companyId: 'company-prontidao',
    storeId: 'store-prontidao',
    profileCodes: ['admin_geral'],
  });
  return { Authorization: `Bearer ${t.accessToken}` };
}

describe('GET /system/readiness mede o núcleo', () => {
  it('só a camada de documentos migrada: NOT_READY, e diz que falta o núcleo', async () => {
    runMigrations();
    const res = await request(app).get('/api/v1/system/readiness').set(dono());
    expect(res.status).toBe(200);
    expect(res.body.coreStatus).toBe('NOT_READY');
    expect(res.body.overallStatus).toBe('not_ready');
    expect(res.body.schema.situacao).toBe('NUNCA_MIGRADO');
    expect(res.body.schema.documentos.versao).toBe(ALVO_DA_CAMADA_DE_DOCUMENTOS);
    expect(res.body.criticalBlockers.join(' ')).toMatch(/núcleo/i);
  });

  it('núcleo no alvo: READY, e databaseVersion é o número do núcleo', async () => {
    migrateCoreSchema();
    const res = await request(app).get('/api/v1/system/readiness').set(dono());
    expect(res.body.coreStatus).toBe('READY');
    expect(res.body.databaseVersion).toBe(CORE_TARGET_VERSION);
    expect(res.body.schema.nucleo).toEqual({
      versao: CORE_TARGET_VERSION,
      alvo: CORE_TARGET_VERSION,
      passosPendentes: [],
    });
    expect(res.body.criticalBlockers).toEqual([]);
  });

  it('núcleo abaixo do alvo: NOT_READY, com a versão e o alvo na frase', async () => {
    const conn = getConnection();
    conn
      .prepare("UPDATE core_meta SET value = ? WHERE key = 'core_schema_version'")
      .run(String(CORE_TARGET_VERSION - 1));
    try {
      const res = await request(app).get('/api/v1/system/readiness').set(dono());
      expect(res.body.coreStatus).toBe('NOT_READY');
      expect(res.body.schema.situacao).toBe('ATRASADO');
      expect(res.body.criticalBlockers.join(' ')).toContain(String(CORE_TARGET_VERSION));
    } finally {
      conn
        .prepare("UPDATE core_meta SET value = ? WHERE key = 'core_schema_version'")
        .run(String(CORE_TARGET_VERSION));
    }
  });

  it('as pendências externas nomeiam a chave de produção desligada — não um texto fixo', async () => {
    const res = await request(app).get('/api/v1/system/readiness').set(dono());
    const texto = (res.body.externalBlockers as string[]).join('\n');
    expect(texto).toContain('NFE_PRODUCTION_ENABLED');
    expect(texto).toContain('ASAAS_PRODUCTION_ENABLED');
    expect(res.body.externalIntegrationsStatus).toBe('PENDING');
  });
});

describe('GET /version publica o número que existe', () => {
  it('databaseVersion é o do núcleo, com o alvo ao lado; sem IndexedDB inventado', async () => {
    migrateCoreSchema();
    const res = await request(app).get('/api/v1/version');
    expect(res.status).toBe(200);
    expect(res.body.databaseVersion).toBe(CORE_TARGET_VERSION);
    expect(res.body.databaseTargetVersion).toBe(CORE_TARGET_VERSION);
    expect(res.body.documentsVersion).toBe(ALVO_DA_CAMADA_DE_DOCUMENTOS);
    expect(res.body).not.toHaveProperty('indexedDbVersion');
  });
});
