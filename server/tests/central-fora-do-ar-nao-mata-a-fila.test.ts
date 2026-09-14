/**
 * ============================================================================
 * CENTRAL FORA DO AR NÃO MATA A FILA (GAP-PRD-047)
 * ============================================================================
 *
 * Doze tentativas com espera de 2^n segundos (teto de 5 min) somam uns 25
 * minutos. Depois disso o evento virava `dead` — e `dead` não tenta mais: a
 * central só voltava a receber quando alguém abrisse Sincronização e clicasse
 * "Tentar novamente". Uma queda de meia hora da Supabase, ou um fim de semana
 * com link ruim, parava o consolidado do grupo inteiro até segunda-feira.
 *
 * As duas falhas são de natureza diferente, e agora são tratadas assim:
 *
 *   - TRANSPORTE (rede, tempo esgotado, 5xx, 408, 429): a central não
 *     respondeu sobre o evento. Tenta para sempre, com espera que cresce até
 *     10 minutos e para aí. Nunca vira `dead`.
 *   - RECUSA (4xx determinístico, ou a central respondeu sem confirmar o
 *     evento): a central olhou e disse não. Conta para o limite, e o evento
 *     que esgota vira `dead` esperando gente — como antes.
 *
 * E a recusa de um LOTE não pode matar os inocentes: se a central recusa um
 * lote de vários eventos, a passada os reenvia um a um e só o envenenado
 * ganha tentativa de recusa.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { getConnection, withTransaction } from '../src/db/sqlite.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import { recordDomainEvent } from '../src/services/sync/DomainEvents.js';
import { MAX_ATTEMPTS, outboxStatus } from '../src/services/sync/OutboxService.js';
import {
  setMeta,
  supabaseTransport,
  syncOnce,
  type CentralTransport,
} from '../src/services/sync/SyncService.js';

let empresa: string;

function evento(id: string): void {
  withTransaction(() => {
    recordDomainEvent({
      eventType: 'sale.registered' as never,
      aggregateType: 'sale',
      aggregateId: id,
      companyId: empresa,
      payload: { id, total_cents: 5000 },
    });
  });
}

function linha(aggregateId: string) {
  return getConnection()
    .prepare(
      `SELECT id, status, attempts, next_attempt_at, last_error
         FROM core_outbox WHERE aggregate_id = ?`,
    )
    .get(aggregateId) as {
    id: string;
    status: string;
    attempts: number;
    next_attempt_at: string | null;
    last_error: string | null;
  };
}

/** Solta os prazos de espera: o teste não espera o relógio de verdade. */
function adiantarRelogio(): void {
  getConnection().prepare('UPDATE core_outbox SET next_attempt_at = NULL').run();
}

/** A central de verdade (PostgREST), com o `fetch` trocado por um dublê. */
function centralReal(responder: (corpo: Array<{ id: string; aggregate_id: string }>) => Response | Promise<Response>): CentralTransport {
  const fetchDublado = (async (_url: string | URL | Request, init?: RequestInit) => {
    const corpo = JSON.parse(String(init?.body ?? '[]')) as Array<{ id: string; aggregate_id: string }>;
    return responder(corpo);
  }) as typeof fetch;
  return supabaseTransport({ url: 'https://central.invalid', serviceRoleKey: 'chave-de-teste' }, fetchDublado);
}

function json(status: number, corpo: unknown): Response {
  return new Response(JSON.stringify(corpo), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  resetDbForTests();
  ensureCoreSchema();
  getConnection().exec(
    "DELETE FROM core_meta WHERE key LIKE 'central_%'; DELETE FROM core_outbox;",
  );
  empresa = upsertCompany({ slug: 'gringa', legalName: 'Gringa Ltda', tradeName: 'Gringa' });
  // Esquema da central já conferido: a passada vai direto ao envio.
  setMeta('central_schema_ok_at', '2026-09-01T00:00:00.000Z');
  setMeta('central_bootstrap_completed_at', '2026-09-01T00:00:00.000Z');
});

describe('falha de TRANSPORTE tenta para sempre', () => {
  it('rede caída (fetch lança) muito além do limite: continua em retry, nunca dead', async () => {
    evento('v-rede');
    const central = centralReal(() => {
      throw new TypeError('fetch failed');
    });

    for (let i = 0; i < MAX_ATTEMPTS + 8; i += 1) {
      adiantarRelogio();
      await syncOnce({ transport: central });
    }

    const l = linha('v-rede');
    expect(l.status).toBe('retry');
    expect(l.attempts).toBe(MAX_ATTEMPTS + 8);
    expect(outboxStatus().dead).toBe(0);
    expect(outboxStatus().lastErrorKind).toBe('TRANSPORTE');
  });

  it('HTTP 503 da central é transporte — e a espera para de crescer em 10 minutos', async () => {
    evento('v-503');
    const central = centralReal(() => json(503, { message: 'Service Unavailable' }));

    for (let i = 0; i < MAX_ATTEMPTS + 3; i += 1) {
      adiantarRelogio();
      await syncOnce({ transport: central });
    }

    const l = linha('v-503');
    expect(l.status).toBe('retry');
    const esperaMs = new Date(l.next_attempt_at!).getTime() - Date.now();
    expect(esperaMs).toBeGreaterThan(9 * 60_000);
    expect(esperaMs).toBeLessThanOrEqual(10 * 60_000);
  });

  it('429 e 408 também são transporte (a central pediu para esperar)', async () => {
    for (const status of [429, 408]) {
      resetDbForTests();
      ensureCoreSchema();
      getConnection().exec('DELETE FROM core_outbox;');
      empresa = upsertCompany({ slug: 'gringa', legalName: 'Gringa Ltda', tradeName: 'Gringa' });
      setMeta('central_schema_ok_at', '2026-09-01T00:00:00.000Z');
      evento(`v-${status}`);
      const central = centralReal(() => json(status, {}));
      for (let i = 0; i < MAX_ATTEMPTS + 1; i += 1) {
        adiantarRelogio();
        await syncOnce({ transport: central });
      }
      expect(linha(`v-${status}`).status, `HTTP ${status}`).toBe('retry');
    }
  });

  it('a central voltando, o evento que esperou sobe sem ninguém clicar em nada', async () => {
    evento('v-volta');
    let noAr = false;
    const central = centralReal((corpo) =>
      noAr ? json(201, corpo.map((c) => ({ id: c.id }))) : json(502, {}),
    );

    for (let i = 0; i < MAX_ATTEMPTS + 2; i += 1) {
      adiantarRelogio();
      await syncOnce({ transport: central });
    }
    noAr = true;
    adiantarRelogio();
    const r = await syncOnce({ transport: central });

    expect(r.sent).toBe(1);
    expect(linha('v-volta').status).toBe('synced');
  });
});

describe('RECUSA da central conta para o limite', () => {
  it('um evento que a central recusa com 400 doze vezes vira dead, esperando gente', async () => {
    evento('v-envenenado');
    const central = centralReal(() => json(400, { code: '22P02', message: 'invalid input syntax' }));

    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      adiantarRelogio();
      await syncOnce({ transport: central });
    }

    expect(linha('v-envenenado').status).toBe('dead');
    expect(outboxStatus().lastErrorKind).toBe('RECUSA');
  });

  it('o lote recusado por UM evento não mata os outros: a passada isola o culpado', async () => {
    evento('v-bom-1');
    evento('v-ruim');
    evento('v-bom-2');
    const central = centralReal((corpo) =>
      corpo.some((c) => c.aggregate_id === 'v-ruim')
        ? json(400, { message: 'o evento v-ruim não cabe' })
        : json(201, corpo.map((c) => ({ id: c.id }))),
    );

    const r = await syncOnce({ transport: central });

    expect(r.sent).toBe(2);
    expect(linha('v-bom-1').status).toBe('synced');
    expect(linha('v-bom-2').status).toBe('synced');
    const ruim = linha('v-ruim');
    expect(ruim.status).toBe('retry');
    expect(ruim.attempts).toBe(1);

    for (let i = 1; i < MAX_ATTEMPTS; i += 1) {
      adiantarRelogio();
      await syncOnce({ transport: central });
    }
    expect(linha('v-ruim').status).toBe('dead');
    expect(outboxStatus().synced).toBe(2);
  });

  it('a mensagem de erro nunca carrega a chave da central', async () => {
    evento('v-chave');
    const central = centralReal(() => json(401, { message: 'JWT chave-de-teste inválido' }));
    await syncOnce({ transport: central });
    expect(linha('v-chave').last_error).not.toContain('chave-de-teste');
  });
});
