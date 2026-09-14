/**
 * A FILA É DO NÓ; A VISÃO E AS AÇÕES DO GERENTE SÃO DA OPERAÇÃO — GAP-PRD-136.
 *
 * `core_outbox` guarda os eventos de TODAS as empresas do servidor. As rotas
 * `/core/sync/*` operavam no nó inteiro: o gerente da empresa A via a fila da
 * B (contagens, tipo do último evento, texto do último erro), devolvia à fila
 * os eventos mortos da B e disparava a carga inicial do histórico da B.
 *
 * A régua daqui:
 *
 *   - quem responde pelo GRUPO (vínculo de gestão em todas as operações
 *     ativas — `respondePeloGrupo`) vê e age no nó inteiro;
 *   - qualquer outro vê as contagens DA SUA operação, e "tentar novamente"
 *     devolve à fila só os eventos dela;
 *   - a carga inicial sobe o histórico de TODAS as operações do servidor (é um
 *     passo de instalação, com checkpoint do nó): só quem responde pelo grupo.
 *
 * O estado das credenciais e do schema da central continua visível ao gerente:
 * é do servidor, não é dado de empresa, e é o que ele precisa para chamar o dono.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetEnvCacheForTests } from '../src/config/env.js';
import { resetDbForTests } from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import { issueSession } from './helpers/sessao.js';

process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-key';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-32-chars!!';

const A = 'empresa-a';
const B = 'empresa-b';
const AGORA = '2026-06-10T15:00:00.000Z';

let app: ReturnType<typeof createApp>;
let seq = 0;

function sessao(userId: string, companyId: string, perfil: string): { Authorization: string } {
  const s = issueSession({ userId, companyId, profileCodes: [perfil] });
  return { Authorization: `Bearer ${s.accessToken}` };
}

function vincular(userId: string, companyId: string, perfil: string): void {
  getConnection()
    .prepare(
      `INSERT INTO core_user_companies (id, user_id, company_id, profile_code, is_default, created_at)
       VALUES (?, ?, ?, ?, 0, ?)
       ON CONFLICT (user_id, company_id) DO UPDATE SET profile_code = excluded.profile_code`,
    )
    .run(`${userId}:${companyId}`, userId, companyId, perfil, AGORA);
}

function evento(
  companyId: string,
  status: 'pending' | 'dead' | 'synced',
  extra: { tipo?: string; erro?: string } = {},
): void {
  seq += 1;
  getConnection()
    .prepare(
      `INSERT INTO core_outbox
         (id, node_id, event_type, aggregate_type, aggregate_id, company_id, operation,
          schema_version, payload, occurred_at, status, attempts, last_error, sent_at, created_at)
       VALUES (?, 'no-teste', ?, 'product', ?, ?, 'insert', 1, '{}', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `ev-${seq}`,
      extra.tipo ?? `produto.criado.${companyId}`,
      `agg-${seq}`,
      companyId,
      AGORA,
      status,
      status === 'dead' ? 8 : 0,
      extra.erro ?? null,
      status === 'synced' ? AGORA : null,
      AGORA,
    );
}

function statusNoBanco(companyId: string, status: string): number {
  return Number(
    (
      getConnection()
        .prepare('SELECT COUNT(*) AS n FROM core_outbox WHERE company_id = ? AND status = ?')
        .get(companyId, status) as { n: number }
    ).n,
  );
}

beforeEach(() => {
  resetEnvCacheForTests();
  resetDbForTests();
  app = createApp();
  // As duas empresas nascem pelas sessões dos gerentes de cada uma.
  sessao('u-gerente-a', A, 'gerente_loja');
  sessao('u-gerente-b', B, 'gerente_loja');
  evento(A, 'pending');
  evento(A, 'dead', { erro: 'falha da A' });
  evento(B, 'pending');
  evento(B, 'pending');
  evento(B, 'dead', { erro: 'segredo operacional da B' });
  evento(B, 'synced', { tipo: 'venda.da.b' });
});

describe('o gerente vê e age na SUA operação', () => {
  it('GET /sync/status conta só os eventos da A — nada da B vaza', async () => {
    const res = await request(app).get('/api/v1/core/sync/status').set(sessao('u-gerente-a', A, 'gerente_loja'));
    expect(res.status).toBe(200);
    expect(res.body.outbox.pending).toBe(1);
    expect(res.body.outbox.dead).toBe(1);
    expect(res.body.outbox.synced).toBe(0);
    expect(res.body.outbox.lastError).toBe('falha da A');
    expect(res.body.outbox.lastSyncedEventType).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain('segredo operacional da B');
    expect(JSON.stringify(res.body)).not.toContain('venda.da.b');
    expect(res.body.escopo).toBe('operacao');
    expect(res.body.acoes).toEqual({ cargaInicial: false, conferirSchema: true, reviver: true, sincronizar: true });
  });

  it('POST /sync/revive devolve à fila só o morto da A; o da B continua morto', async () => {
    const res = await request(app).post('/api/v1/core/sync/revive').set(sessao('u-gerente-a', A, 'gerente_loja'));
    expect(res.status).toBe(200);
    expect(res.body.revived).toBe(1);
    expect(statusNoBanco(A, 'dead')).toBe(0);
    expect(statusNoBanco(B, 'dead')).toBe(1);
  });

  it('POST /sync/bootstrap é 403 para o gerente — a carga é do nó inteiro — e nada entra na fila', async () => {
    const antes = statusNoBanco(B, 'pending');
    const res = await request(app).post('/api/v1/core/sync/bootstrap').set(sessao('u-gerente-a', A, 'gerente_loja'));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CORE_SYNC_NODE_SCOPE');
    expect(statusNoBanco(B, 'pending')).toBe(antes);
    const total = getConnection().prepare('SELECT COUNT(*) AS n FROM core_outbox').get() as { n: number };
    expect(total.n).toBe(6);
  });

  it('o gerente da oficina vê a sua operação, sem conferir schema (a rota é do gerente de loja)', async () => {
    const res = await request(app)
      .get('/api/v1/core/sync/status')
      .set(sessao('u-gerente-of', A, 'gerente_oficina'));
    expect(res.status).toBe(200);
    expect(res.body.acoes.conferirSchema).toBe(false);
    expect(res.body.acoes.cargaInicial).toBe(false);
  });

  it('o caixa continua de fora (403)', async () => {
    const res = await request(app).get('/api/v1/core/sync/status').set(sessao('u-caixa', A, 'operador_caixa_loja'));
    expect(res.status).toBe(403);
  });
});

describe('quem responde pelo grupo vê e age no nó', () => {
  it('gestor com vínculo de gestão nas duas: status do nó, revive do nó, carga inicial permitida', async () => {
    const auth = sessao('u-gestor', A, 'gestor');
    vincular('u-gestor', B, 'gestor');

    const status = await request(app).get('/api/v1/core/sync/status').set(auth);
    expect(status.status).toBe(200);
    expect(status.body.escopo).toBe('no');
    expect(status.body.outbox.pending).toBe(3);
    expect(status.body.outbox.dead).toBe(2);
    expect(status.body.acoes.cargaInicial).toBe(true);

    const carga = await request(app).post('/api/v1/core/sync/bootstrap').set(auth);
    expect(carga.status).toBe(200);

    const revive = await request(app).post('/api/v1/core/sync/revive').set(auth);
    expect(revive.status).toBe(200);
    expect(revive.body.revived).toBe(2);
  });

  it('gestor que só tem a A (a B existe e está ativa) fica no escopo da operação, e a carga é 403', async () => {
    const auth = sessao('u-gestor-a', A, 'gestor');
    const status = await request(app).get('/api/v1/core/sync/status').set(auth);
    expect(status.body.escopo).toBe('operacao');
    expect(status.body.outbox.pending).toBe(1);
    const carga = await request(app).post('/api/v1/core/sync/bootstrap').set(auth);
    expect(carga.status).toBe(403);
  });

  it('gestor mecânico na B (vínculo sem gestão) também não responde pelo nó', async () => {
    const auth = sessao('u-gestor-meio', A, 'gestor');
    vincular('u-gestor-meio', B, 'mecanico');
    const carga = await request(app).post('/api/v1/core/sync/bootstrap').set(auth);
    expect(carga.status).toBe(403);
  });
});
