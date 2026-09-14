/**
 * ============================================================================
 * A PROJEÇÃO NA CENTRAL SE MOSTRA (GAP-PRD-048)
 * ============================================================================
 *
 * O diagnóstico de projeção era escrito e nunca lido: `syncOnce` gravava o
 * último erro em `core_meta.central_projection_last_error`, e nem
 * `GET /core/sync/status`, nem a tela, nem `conferir-central` o liam. O banco
 * da loja ainda guarda um PGRST202 (a função `erp_apply_projections` não
 * existia na central) de 30/08 — e nada distingue "faltou um dia e foi criada
 * depois" de "continua faltando e o consolidado do grupo está vazio".
 *
 * O que este arquivo cobra:
 *
 *   1. o estado da sincronia diz o último erro de projeção, QUANDO ele
 *      aconteceu e quando a central aceitou uma projeção pela última vez — e a
 *      rota entrega isso a quem cuida da loja;
 *   2. a reprojeção administrativa, que é o outro caminho que projeta, limpa
 *      o erro quando projeta (e registra o novo quando falha);
 *   3. a conferência pergunta à central, sem gravar nada, se a função de
 *      projeção existe: chamada com lote VAZIO.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { getConnection, withTransaction } from '../src/db/sqlite.js';
import {
  linkUserToCompany,
  upsertCompany,
  upsertUser,
} from '../src/services/auth/IdentityService.js';
import { recordDomainEvent } from '../src/services/sync/DomainEvents.js';
import {
  registrarErroDeProjecao,
  registrarProjecaoAceita,
  syncOnce,
  syncStatus,
  testCentralTransport,
} from '../src/services/sync/SyncService.js';
import type { ProjectionTransport } from '../src/services/sync/CentralProjection.js';
import { conferirRpcDeProjecao } from '../src/services/sync/conferenciaDaProjecao.js';

const app = createApp();
const SENHA = 'Projecao@Central!2026';
const PGRST202 =
  'A central recusou a projeção (HTTP 404). {"code":"PGRST202","message":"Could not find the function public.erp_apply_projections(payload)"}';

let empresa: string;

function evento(id: string): void {
  withTransaction(() => {
    recordDomainEvent({
      eventType: 'product.upserted' as never,
      aggregateType: 'product',
      aggregateId: id,
      companyId: empresa,
      payload: { name: 'Produto ' + id, unit: 'UN', active: 1 },
    });
  });
}

const projecaoQueFalha: ProjectionTransport = {
  name: 'central-sem-rpc',
  isTest: true,
  async apply() {
    throw new Error(PGRST202);
  },
};

const projecaoQueAceita: ProjectionTransport = {
  name: 'central-com-rpc',
  isTest: true,
  async apply(linhas) {
    return { written: linhas.length, skippedByOrder: 0 };
  },
};

beforeEach(() => {
  resetDbForTests();
  ensureCoreSchema();
  getConnection().exec("DELETE FROM core_meta WHERE key LIKE 'central_%'; DELETE FROM core_outbox;");
  empresa = upsertCompany({ slug: 'gringa', legalName: 'Gringa Ltda', tradeName: 'Gringa' });
});

describe('o estado da sincronia diz como vai a projeção', () => {
  it('sem nada ter acontecido: nenhum erro e nenhuma projeção aceita — dito, não omitido', () => {
    expect(syncStatus().projecao).toEqual({ ultimoErro: null, ultimoErroEm: null, ultimaAceitaEm: null });
  });

  it('a projeção falha: o erro aparece, com a hora', async () => {
    evento('p-1');
    const antes = Date.now();
    await syncOnce({ transport: testCentralTransport(), projectionTransport: projecaoQueFalha });

    const p = syncStatus().projecao;
    expect(p.ultimoErro).toContain('PGRST202');
    expect(new Date(p.ultimoErroEm!).getTime()).toBeGreaterThanOrEqual(antes - 1000);
    expect(p.ultimaAceitaEm).toBeNull();
  });

  it('a projeção volta: o erro sai e fica a hora da última aceita', async () => {
    evento('p-1');
    await syncOnce({ transport: testCentralTransport(), projectionTransport: projecaoQueFalha });
    evento('p-2');
    await syncOnce({ transport: testCentralTransport(), projectionTransport: projecaoQueAceita });

    const p = syncStatus().projecao;
    expect(p.ultimoErro).toBeNull();
    expect(p.ultimoErroEm).toBeNull();
    expect(p.ultimaAceitaEm).not.toBeNull();
  });

  it('GET /core/sync/status entrega o diagnóstico a quem cuida da loja', async () => {
    registrarErroDeProjecao(PGRST202);
    const userId = await upsertUser({ login: 'GERENTE.SYNC', displayName: 'Gerente', password: SENHA });
    linkUserToCompany(userId, empresa, 'gerente_loja', true);
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ login: 'GERENTE.SYNC', password: SENHA, companyId: empresa });
    expect(login.status, JSON.stringify(login.body)).toBe(200);

    const r = await request(app)
      .get('/api/v1/core/sync/status')
      .set({ Authorization: `Bearer ${login.body.accessToken}` });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.projecao.ultimoErro).toContain('PGRST202');
    expect(r.body.projecao.ultimoErroEm).toEqual(expect.any(String));
  });
});

describe('a reprojeção administrativa também conta', () => {
  it('projetar pela reprojeção limpa o erro antigo e registra a hora', () => {
    registrarErroDeProjecao(PGRST202);
    registrarProjecaoAceita();
    const p = syncStatus().projecao;
    expect(p.ultimoErro).toBeNull();
    expect(p.ultimaAceitaEm).not.toBeNull();
  });

  it('a reprojeção que falha registra o erro novo por cima', () => {
    registrarProjecaoAceita('2026-09-01T10:00:00.000Z');
    registrarErroDeProjecao('A central recusou a projeção (HTTP 500). outro motivo');
    const p = syncStatus().projecao;
    expect(p.ultimoErro).toContain('HTTP 500');
    // A última aceita continua dita: "quebrou agora" não apaga "funcionava".
    expect(p.ultimaAceitaEm).toBe('2026-09-01T10:00:00.000Z');
  });
});

describe('a conferência pergunta à central se a função de projeção existe', () => {
  function central(responder: (url: string, corpo: string) => Response): {
    fetchImpl: typeof fetch;
    chamadas: Array<{ url: string; corpo: string; metodo: string }>;
  } {
    const chamadas: Array<{ url: string; corpo: string; metodo: string }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const corpo = String(init?.body ?? '');
      chamadas.push({ url: String(url), corpo, metodo: String(init?.method ?? 'GET') });
      return responder(String(url), corpo);
    }) as typeof fetch;
    return { fetchImpl, chamadas };
  }
  const config = { url: 'https://central.invalid', serviceRoleKey: 'chave-de-teste' };

  it('a função existe: PRONTA — e o lote enviado é VAZIO, nada é gravado', async () => {
    const c = central(() => new Response(JSON.stringify({ written: 0, skipped_by_order: 0 }), { status: 200 }));
    const r = await conferirRpcDeProjecao({ ...config, fetchImpl: c.fetchImpl });
    expect(r.estado).toBe('PRONTA');
    expect(c.chamadas).toHaveLength(1);
    expect(c.chamadas[0]!.url).toBe('https://central.invalid/rest/v1/rpc/erp_apply_projections');
    expect(c.chamadas[0]!.metodo).toBe('POST');
    expect(JSON.parse(c.chamadas[0]!.corpo)).toEqual({ payload: [] });
  });

  it('PGRST202: AUSENTE, e diz qual arquivo rodar', async () => {
    const c = central(
      () => new Response(JSON.stringify({ code: 'PGRST202', message: 'Could not find the function' }), { status: 404 }),
    );
    const r = await conferirRpcDeProjecao({ ...config, fetchImpl: c.fetchImpl });
    expect(r.estado).toBe('AUSENTE');
    expect(r.detalhe).toContain('03-projecao.sql');
  });

  it('central que não responde: SEM_RESPOSTA, e a chave nunca aparece na frase', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed chave-de-teste');
    }) as unknown as typeof fetch;
    const r = await conferirRpcDeProjecao({ ...config, fetchImpl });
    expect(r.estado).toBe('SEM_RESPOSTA');
    expect(r.detalhe).not.toContain('chave-de-teste');
  });

  it('outra recusa (401, 500): RECUSADA, com o código', async () => {
    const c = central(() => new Response('{"message":"JWT inválido"}', { status: 401 }));
    const r = await conferirRpcDeProjecao({ ...config, fetchImpl: c.fetchImpl });
    expect(r.estado).toBe('RECUSADA');
    expect(r.detalhe).toContain('401');
  });
});
