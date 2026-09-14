/**
 * ============================================================================
 * CORREIOS E JADLOG, DITOS COMO SÃO (GAP-PRD-118)
 * ============================================================================
 *
 * O que a auditoria achou: não existe cliente HTTP dos Correios nem da Jadlog —
 * a cotação é simulada, conexão e rastreio respondiam "pendente de
 * implementação" —, e mesmo assim:
 *
 *   - a prontidão acendia o item IMPLEMENTADO em verde, FIXO, para as três
 *     transportadoras (`{ key: 'implementado', status: 'ok' }` sem olhar nada);
 *   - a tela Integrações dizia `READY_FOR_CREDENTIAL — Contrato, usuário e
 *     senha`, como se a credencial bastasse;
 *   - os `.env` de exemplo traziam LOGISTICS_CORREIOS_USERNAME/PASSWORD e
 *     LOGISTICS_JADLOG_TOKEN, que nenhum código lia;
 *   - os testes da ausência eram `it.skip` vazios.
 *
 * O dono podia contratar os Correios acreditando que bastaria colar a senha. A
 * decisão que o código implementa: os serviços dos Correios e da Jadlog chegam
 * PELO MELHOR ENVIO (cotação, etiqueta e rastreio — GAP-PRD-119/120), e tudo o
 * que o sistema diz sobre as duas passa a dizer isso. Contrato direto exigiria
 * programar a integração, e o sistema diz também isso.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetEnvCacheForTests } from '../src/config/env.js';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { linkUserToCompany, upsertCompany, upsertUser } from '../src/services/auth/IdentityService.js';
import {
  markCredentialTest,
  upsertLogisticsCredentials,
} from '../src/services/logistics/LogisticsCredentialService.js';
import { buildLogisticsReadinessChecklist } from '../src/services/logistics/LogisticsReadinessService.js';
import { trackLogisticsCarrier } from '../src/services/logistics/LogisticsCarrierAdapter.js';

process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-key';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-32-chars!!';

const app = createApp();
const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SENHA = 'Teste@Correios2026';

let companyId: string;
let gerente: { Authorization: string };

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  resetEnvCacheForTests();
  companyId = upsertCompany({ slug: 'gringa', legalName: 'Gringa Comércio Ltda', tradeName: 'Gringa' });
  const userId = await upsertUser({ login: 'GERENTE_CORREIOS', displayName: 'Gerente', password: SENHA });
  linkUserToCompany(userId, companyId, 'gerente_loja', true);
  const login = await request(app).post('/api/v1/auth/login').send({ login: 'GERENTE_CORREIOS', password: SENHA });
  gerente = { Authorization: `Bearer ${login.body.accessToken}` };
});

describe('a prontidão não acende IMPLEMENTADO para quem não tem cliente HTTP', () => {
  it.each(['correios', 'jadlog'] as const)('%s: implemented=false, um item só, vermelho, apontando o Melhor Envio', async (carrier) => {
    const res = await request(app).get('/api/v1/core/logistics/readiness').set(gerente);
    expect(res.status).toBe(200);
    const p = res.body.providers.find((x: { carrier: string }) => x.carrier === carrier);
    expect(p.implemented).toBe(false);
    expect(p.items).toEqual([
      expect.objectContaining({ key: 'implementado', label: 'SEM INTEGRAÇÃO DIRETA', status: 'blocked' }),
    ]);
    expect(p.items[0].message).toMatch(/pelo Melhor Envio/);
    expect(p.items[0].message).toMatch(/a credencial sozinha não basta/);
    // Não é pendência de ninguém: não entra na lista do que falta.
    expect(res.body.blockingReasons.join(' ')).not.toMatch(/CORREIOS|JADLOG/);
  });

  it('nem com credencial guardada o Correios vira "implementado"', () => {
    upsertLogisticsCredentials({
      companyId,
      carrier: 'correios',
      credentials: { username: 'u', password: 'senha-do-contrato', contract: 'c1' },
    });
    const p = buildLogisticsReadinessChecklist(companyId).providers.find((x) => x.carrier === 'correios')!;
    expect(p.configured).toBe(true);
    expect(p.implemented).toBe(false);
    expect(p.items[0].status).toBe('blocked');
  });

  it('o Melhor Envio continua implementado, e ETIQUETA/RASTREAMENTO acendem com o fato — não por um status que ninguém grava', () => {
    upsertLogisticsCredentials({ companyId, carrier: 'melhor_envio', credentials: { token: 'me-sandbox-token-honesto-0001' } });
    const antes = buildLogisticsReadinessChecklist(companyId).providers.find((x) => x.carrier === 'melhor_envio')!;
    expect(antes.implemented).toBe(true);
    const item = (k: string, p = antes) => p.items.find((i) => i.key === k)!;
    expect(item('implementado').status).toBe('ok');
    expect(item('etiqueta')).toMatchObject({ status: 'pending' });
    expect(item('etiqueta').message).toMatch(/ficha do pedido/);
    expect(item('tracking').status).toBe('pending');

    markCredentialTest(companyId, 'melhor_envio', 'label_ok', undefined, { kind: 'label', ok: true });
    markCredentialTest(companyId, 'melhor_envio', 'tracking_ok', undefined, { kind: 'tracking', ok: true });
    const depois = buildLogisticsReadinessChecklist(companyId).providers.find((x) => x.carrier === 'melhor_envio')!;
    expect(item('etiqueta', depois).status).toBe('ok');
    expect(item('tracking', depois).status).toBe('ok');
    expect(depois.labelValidated).toBe(true);
    expect(depois.trackingValidated).toBe(true);

    // Token novo: o que o anterior provou não vale para ele.
    upsertLogisticsCredentials({ companyId, carrier: 'melhor_envio', credentials: { token: 'me-sandbox-token-honesto-0002' } });
    const trocado = buildLogisticsReadinessChecklist(companyId).providers.find((x) => x.carrier === 'melhor_envio')!;
    expect(item('etiqueta', trocado).status).toBe('pending');
  });
});

describe('a tela Integrações e o painel não pedem o que não serve', () => {
  it('a linha dos Correios não diz mais READY_FOR_CREDENTIAL — Contrato, usuário e senha', async () => {
    const res = await request(app).get('/api/v1/core/integrations/status').set(gerente);
    const correios = res.body.providers.find((p: { provider: string }) => p.provider === 'correios');
    expect(correios.readiness).toBe('NOT_IMPLEMENTED');
    expect(correios.missing).toMatch(/Melhor Envio/);
    expect(correios.missing).not.toMatch(/^Contrato, usuário e senha$/);
  });

  // O painel de `/integrations/:carrier` saiu com o roteador, que nenhuma tela
  // chamava (GAP-PRD-075); a prontidão da logística acima diz o mesmo.

  it('o teste de conexão dos Correios diz "sem integração direta", sem se passar por real', async () => {
    upsertLogisticsCredentials({ companyId, carrier: 'correios', credentials: { password: 'x', contract: 'c', username: 'u' } });
    const res = await request(app)
      .post('/api/v1/logistics/carriers/correios/test-connection')
      .set(gerente)
      .send({});
    expect(res.body).toMatchObject({ ok: false, real: false });
    expect(res.body.message).toMatch(/SEM INTEGRAÇÃO DIRETA/);
    expect(res.body.message).toMatch(/Melhor Envio/);
  });

  it('em servidor de produção, o "rastreio" de conferência dos Correios não inventa evento simulado', async () => {
    upsertLogisticsCredentials({ companyId, carrier: 'correios', credentials: { password: 'x', contract: 'c', username: 'u' } });
    process.env.DEVORA_API_ENV = 'production';
    try {
      const r = await trackLogisticsCarrier(companyId, 'correios', 'AA123456789BR');
      expect(r.simulated).toBe(false);
      expect(r.trackingEvents).toBeUndefined();
    } finally {
      delete process.env.DEVORA_API_ENV;
    }
  });
});

describe('o que se escreve para o dono bate com o código', () => {
  it('os .env de exemplo não pedem credencial de Correios/Jadlog que ninguém lê', () => {
    for (const arquivo of ['.env.example', '.env.production.example']) {
      const texto = readFileSync(resolve(RAIZ, arquivo), 'utf8');
      expect(texto, arquivo).not.toMatch(/^LOGISTICS_CORREIOS_(USERNAME|PASSWORD)=/m);
      expect(texto, arquivo).not.toMatch(/^LOGISTICS_JADLOG_TOKEN=/m);
      expect(texto, arquivo).toMatch(/Correios e Jadlog NÃO têm integração direta/);
    }
    // E a variável nova que o exemplo cita existe no schema do servidor.
    expect(readFileSync(resolve(RAIZ, 'server/src/config/env.ts'), 'utf8')).toMatch(/LOGISTICS_TRACKING_SYNC_MINUTES/);
  });

  it('ESTADO-ATUAL, KNOWN_LIMITATIONS e CHECKPOINT não dizem que falta só a credencial dos Correios', () => {
    const estado = readFileSync(resolve(RAIZ, 'docs/ESTADO-ATUAL.md'), 'utf8');
    expect(estado).not.toMatch(/\| Correios \| `READY_FOR_CREDENTIAL` \|/);
    expect(estado).toMatch(/\| Correios \/ Jadlog \*\*diretos\*\* \| `NOT_IMPLEMENTED`/);

    const limites = readFileSync(resolve(RAIZ, 'docs/KNOWN_LIMITATIONS.md'), 'utf8');
    expect(limites).not.toMatch(/\| Correios \| Adapter \| Pendente credencial \|/);
    expect(limites).not.toMatch(/\| Jadlog \| Adapter \| Pendente credencial \|/);

    const checkpoint = readFileSync(resolve(RAIZ, 'docs/CHECKPOINT.md'), 'utf8');
    expect(checkpoint).not.toMatch(/\| Correios \| `READY_FOR_CREDENTIAL` \|/);
    expect(checkpoint).not.toMatch(/Contrato Correios \/ token Melhor Envio/);
  });
});
