/**
 * Prompt 29 — Backend operational homologation / readiness honesty
 */

import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { loginForTest } from './helpers/auth.js';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetEnvCacheForTests } from '../src/config/env.js';
// Sessão da conta que EXISTE: authMiddleware confere a conta a cada requisição (GAP-PRD-053).
import { issueSession } from './helpers/sessao.js';
import { evaluateCoreProductionReadiness } from '../src/services/system-admin/CoreProductionReadinessService.js';
import { runMigrations } from '../src/db/migrate.js';
import { migrateCoreSchema } from '../src/db/core-migrations.js';
import { recordAudit } from '../src/services/audit/AuditService.js';

describe('Prompt 29 BE — operational homologation', () => {
  const app = createApp();

  beforeAll(() => {
    // O READY mede o NÚCLEO (GAP-PRD-057): o banco precisa estar migrado
    // como o boot o deixa, não só na camada de documentos.
    runMigrations();
    migrateCoreSchema();
  });

  beforeEach(() => {
    resetEnvCacheForTests();
  });

  it('core readiness READY pelo núcleo; externals not falsely ready', () => {
    const report = evaluateCoreProductionReadiness();
    expect(report.coreStatus).toBe('READY');
    expect(report.schema.situacao).toBe('EM_DIA');
    expect(report).not.toHaveProperty('indexedDbVersion');
    expect(report.externalIntegrationsStatus).not.toBe('READY');
  });

  // A matriz de homologação era CRAVADA ("Core ERP" homologado por constante)
  // e sem tela: saiu (GAP-PRD-064). O que se homologa de verdade está no
  // checklist de implantação de cada empresa.
  it('a matriz cravada de homologação saiu do ar', async () => {
    const tokens = issueSession({
      userId: 'admin-p29',
      companyId: 'company-preco-justo',
      storeId: 'store-preco-justo-matriz',
      profileCodes: ['admin_geral'],
    });
    const res = await request(app)
      .get('/api/v1/system/homologations')
      .set('Authorization', `Bearer ${tokens.accessToken}`);
    expect(res.status).toBe(404);
  });

  /**
   * O teste de isolamento entre empresas, agora capaz de falhar — e apontado
   * para a trilha que EXISTE.
   *
   * Ele mirava `/system/audit`, que aceitava o `companyId` da query. A rota
   * saiu na verificação do GAP-PRD-075: lia uma lista em memória que só os
   * testes preenchiam, e com ela vazia (sempre, em produção) inventava a linha
   * `audit-stub-scan` — os casos daqui "liam a própria empresa" porque a
   * linha inventada vinha com a empresa de quem perguntava.
   *
   * A trilha é `GET /core/audit` (Relatórios › Auditoria). A sessão é de
   * `gestor`, que tem acesso à trilha: com um perfil sem acesso, o 403 viria
   * da permissão e o teste nunca exercitaria o recorte por empresa. As duas
   * empresas têm linha GRAVADA, para que um recorte que regrida para "tudo"
   * apareça como a linha do vizinho na resposta.
   */
  const gestorDaGringa = () =>
    issueSession({
      userId: 'gestor-gringa',
      companyId: 'company-gringa',
      storeId: 'store-gringa-matriz',
      profileCodes: ['gestor'],
    });

  it('gestor da Gringa NÃO lê a trilha do Preço Justo, nem pedindo pela query', async () => {
    const tokens = gestorDaGringa();
    recordAudit({ companyId: 'company-preco-justo', action: 'p29.linha_do_vizinho', entityType: 'teste' });
    recordAudit({ companyId: 'company-gringa', action: 'p29.linha_da_casa', entityType: 'teste' });
    const res = await request(app)
      .get('/api/v1/core/audit')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .query({ companyId: 'company-preco-justo', limit: 200 });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const acoes = (res.body.items as { action: string }[]).map((i) => i.action);
    expect(acoes).not.toContain('p29.linha_do_vizinho');
    // Sem este, uma resposta vazia passaria no de cima.
    expect(acoes).toContain('p29.linha_da_casa');
  });

  it('e a porta antiga, que aceitava a empresa pela query, não responde mais', async () => {
    const tokens = gestorDaGringa();
    const res = await request(app)
      .get('/api/v1/system/audit')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .query({ companyId: 'company-preco-justo' });
    expect(res.status).toBe(404);
  });

  it('login bridge rejects grupo-sampaio as companyId', async () => {
    const res = await loginForTest(app, {
      userId: 'u1',
      companyId: 'grupo-sampaio',
      profileCodes: ['admin_geral'],
    });
    expect(res.status).toBe(400);
  });
});
