/**
 * Prompt 26 — Audit compliance (backend)
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { CORE_TARGET_VERSION } from '../src/db/core-migrations.js';
import { getReleaseVersionInfo } from '../src/services/system-admin/SystemAdminService.js';

/*
  A "auditoria de sistema" que este arquivo cobrava — `listSystemAuditBackend`,
  `appendSystemAuditBackendForTests` e `GET /system/audit` — saiu na verificação
  do GAP-PRD-075: era uma lista em memória que só estes testes preenchiam, e a
  rota, sem tela, respondia a linha inventada `audit-stub-scan` com a lista
  vazia (sempre, em produção). A trilha é uma só, `core_audit_log`, e quem a
  cobra é `auditoria-tem-leitor.test.ts` (quem lê, paginação, filtro, e a trilha
  de outra empresa que não vaza). A rota fora do ar é cobrada em
  `o-legado-sem-consumidor-sai-do-ar.test.ts`.
*/

beforeAll(() => {
  runMigrations();
});

describe('Prompt 26 — Audit compliance', () => {
  // O `indexedDbVersion: 67` era de um IndexedDB que o frontend não tem
  // (GAP-PRD-057): o release publica a versão do NÚCLEO e o alvo da build.
  it('release info não inventa IndexedDB e publica o alvo do núcleo', () => {
    const info = getReleaseVersionInfo();
    expect(info).not.toHaveProperty('indexedDbVersion');
    expect(info.databaseTargetVersion).toBe(CORE_TARGET_VERSION);
  });

});
