/**
 * ============================================================================
 * O FLUXO NORMAL TAMBÉM PRECISA CARIMBAR O QUE PROJETOU
 * ============================================================================
 *
 * Descoberto na auditoria de retomada do sync (30/08/2026): o ÚNICO escritor
 * de `projected_at` na aterrissagem era a REPROJEÇÃO — o comando
 * administrativo. O fluxo normal (`syncOnce`) entregava, projetava... e nunca
 * carimbava.
 *
 * A consequência não é perda — é mentira acumulada. Cada evento novo ficaria
 * `projected_at IS NULL` para sempre, mesmo com a linha de negócio gravada:
 *
 *   - o diagnóstico do dono mostraria "não projetados" crescendo sem parar;
 *   - o invariante "pendentes = 0", recém-conquistado com os 118, derivaria
 *     na primeira venda;
 *   - a reprojeção re-selecionaria tudo o que o fluxo normal já fez —
 *     inofensivo pelo UPSERT, mas ruído que esconde o pendente de verdade.
 *
 * ## A ordem, que é a mesma da reprojeção
 *
 * Projeta, e SÓ ENTÃO carimba — apenas os ids que a central confirmou
 * (`projectedIds`). Tipo desconhecido não entra: fica sem carimbo, esperando a
 * central aprender, e é assim que a reprojeção o encontra depois.
 *
 * ## E carimbo que falha não derruba o sync
 *
 * O fato está entregue e projetado; o carimbo é metadado de progresso. Se o
 * PATCH falhar, o evento fica `NULL` na landing e a reprojeção o refaz
 * idempotentemente — o sistema se cura sozinho. O que não pode acontecer é a
 * falha do carimbo desfazer ou reter o envio.
 */
process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';

import { beforeEach, describe, expect, it } from 'vitest';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { getConnection, withTransaction } from '../src/db/sqlite.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import { recordDomainEvent } from '../src/services/sync/DomainEvents.js';
import { outboxStatus } from '../src/services/sync/OutboxService.js';
import { syncOnce, type CentralTransport } from '../src/services/sync/SyncService.js';
import type { ProjectionTransport } from '../src/services/sync/CentralProjection.js';

let gringa: string;

function evento(id: string, tipo = 'product.upserted'): void {
  withTransaction(() => {
    recordDomainEvent({
      eventType: tipo as never,
      aggregateType: 'product',
      aggregateId: id,
      companyId: gringa,
      payload: { name: 'Produto ' + id, unit: 'UN', active: 1 },
    });
  });
}

/** Central de aterrissagem que aceita tudo. */
function centralQueAceita(): CentralTransport {
  return {
    name: 'central-de-teste',
    isTest: true,
    async send(batch) {
      return { acceptedIds: batch.map((r) => r.id) };
    },
    async probeSchema() {
      return { ok: true, centralVersion: 1 };
    },
  };
}

/** Transporte de projeção que grava e CARIMBA — com memória do que carimbou. */
function projecaoComCarimbo(opts: { falharAplicacao?: boolean; falharCarimbo?: boolean } = {}) {
  const carimbados: string[][] = [];
  const aplicadas: number[] = [];
  const transporte: ProjectionTransport = {
    name: 'projecao-de-teste',
    isTest: true,
    async apply(projections) {
      if (opts.falharAplicacao) throw new Error('A central recusou a projeção (HTTP 404).');
      aplicadas.push(projections.length);
      return { written: projections.length, skippedByOrder: 0 };
    },
    async marcarProjetados(ids: string[]) {
      if (opts.falharCarimbo) throw new Error('A central recusou o carimbo (HTTP 500).');
      carimbados.push([...ids]);
      return ids.length;
    },
  };
  return { transporte, carimbados, aplicadas };
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  getConnection().exec("DELETE FROM core_meta WHERE key LIKE 'central_%'");
  gringa = await upsertCompany({ slug: 'gringa', tradeName: 'Gringa', legalName: 'Gringa Ltda' });
});

// ============================================================================

describe('o fluxo normal carimba o que projetou', () => {
  it('depois de entregar e projetar, os ids confirmados são carimbados', async () => {
    evento('p-1');
    evento('p-2');
    const proj = projecaoComCarimbo();

    const r = await syncOnce({
      transport: centralQueAceita(),
      projectionTransport: proj.transporte,
    });

    expect(r.sent).toBe(2);
    expect(r.projected?.written).toBeGreaterThan(0);
    expect(proj.carimbados.flat().sort()).toHaveLength(2);
  });

  it('carimba EXATAMENTE os projectedIds — nem mais, nem menos', async () => {
    evento('p-1');
    // Tipo que nenhum projetor conhece: entra na aterrissagem e fica esperando.
    evento('x-1', 'tipo.que.ninguem.conhece');
    const proj = projecaoComCarimbo();

    await syncOnce({ transport: centralQueAceita(), projectionTransport: proj.transporte });

    const ids = proj.carimbados.flat();
    expect(ids).toHaveLength(1);
    // O desconhecido NÃO foi carimbado: é assim que a reprojeção o acha depois.
  });

  it('projeção que FALHA não carimba nada', async () => {
    evento('p-1');
    const proj = projecaoComCarimbo({ falharAplicacao: true });

    const r = await syncOnce({ transport: centralQueAceita(), projectionTransport: proj.transporte });

    // O envio aconteceu — projeção e entrega são falhas separadas.
    expect(r.sent).toBe(1);
    expect(outboxStatus().synced).toBe(1);
    expect(proj.carimbados).toHaveLength(0);
  });

  it('carimbo que FALHA não derruba o sync nem o envio', async () => {
    /*
      O fato está entregue e projetado. O carimbo é metadado: se falhar, o
      evento fica NULL na landing e a reprojeção o refaz idempotentemente.
      A falha não pode reter o envio nem devolver o evento à fila.
    */
    evento('p-1');
    const proj = projecaoComCarimbo({ falharCarimbo: true });

    const r = await syncOnce({ transport: centralQueAceita(), projectionTransport: proj.transporte });

    expect(r.sent).toBe(1);
    expect(r.projected?.written).toBeGreaterThan(0);
    expect(outboxStatus().synced).toBe(1);
    expect(outboxStatus().pending).toBe(0);
  });

  it('transporte SEM marcarProjetados continua funcionando — o método é opcional', async () => {
    // Os transportes de teste antigos não têm o método; quebrá-los seria
    // exigir que todo dublê soubesse de carimbo.
    evento('p-1');
    const semCarimbo: ProjectionTransport = {
      name: 'projecao-sem-carimbo',
      isTest: true,
      async apply(projections) {
        return { written: projections.length, skippedByOrder: 0 };
      },
    };

    const r = await syncOnce({ transport: centralQueAceita(), projectionTransport: semCarimbo });
    expect(r.sent).toBe(1);
    expect(r.projected?.written).toBeGreaterThan(0);
  });
});

// ============================================================================

/*
  ============================================================================
  O CAMINHO INTEIRO, COM A CENTRAL CAINDO NO MEIO
  ============================================================================

  É o ensaio do dia ruim: o evento nasce, a central está fora do ar, o envio
  falha — e nada pode se perder. Quando ela volta, o mesmo fato atravessa o
  caminho inteiro UMA vez: outbox → envio → aterrissagem → projeção → carimbo →
  synced local. Nem duas projeções, nem nenhuma.
*/
describe('central fora do ar: o evento espera, volta e atravessa uma vez', () => {
  it('falha no envio → retry → uma entrega, uma projeção, um carimbo', async () => {
    evento('p-resiliente');

    let centralNoAr = false;
    const enviados: string[][] = [];
    const central: CentralTransport = {
      name: 'central-que-cai',
      isTest: true,
      async send(batch) {
        if (!centralNoAr) throw new Error('ECONNREFUSED');
        enviados.push(batch.map((r) => r.id));
        return { acceptedIds: batch.map((r) => r.id) };
      },
      async probeSchema() {
        return { ok: true, centralVersion: 1 };
      },
    };
    const proj = projecaoComCarimbo();

    // 1ª passada: a central está fora do ar.
    const r1 = await syncOnce({ transport: central, projectionTransport: proj.transporte });
    expect(r1.sent).toBe(0);
    expect(r1.failed).toBe(1);
    expect(outboxStatus().retry, 'o evento espera em retry — não se perde').toBe(1);
    expect(proj.aplicadas, 'nada projetado com a central fora').toHaveLength(0);
    expect(proj.carimbados).toHaveLength(0);

    // A central volta; o backoff é vencido adiantando o relógio da fila.
    centralNoAr = true;
    getConnection().exec(
      "UPDATE core_outbox SET next_attempt_at = '2000-01-01T00:00:00.000Z' WHERE status = 'retry'",
    );

    // 2ª passada: o caminho inteiro, uma vez.
    const r2 = await syncOnce({ transport: central, projectionTransport: proj.transporte });
    expect(r2.sent).toBe(1);
    expect(outboxStatus().synced).toBe(1);
    expect(outboxStatus().pending + outboxStatus().retry).toBe(0);
    expect(enviados.flat(), 'uma entrega').toHaveLength(1);
    expect(proj.aplicadas, 'uma chamada de projeção').toHaveLength(1);
    expect(proj.carimbados.flat(), 'um carimbo').toHaveLength(1);

    // 3ª passada: nada a fazer — reenvio não existe.
    const r3 = await syncOnce({ transport: central, projectionTransport: proj.transporte });
    expect(r3.attempted).toBe(0);
    expect(enviados.flat()).toHaveLength(1);
  });

  it('reenvio do MESMO id não vira segunda linha — a aterrissagem faz upsert', async () => {
    /*
      O caso do ACK perdido: a central gravou, a resposta caiu, o nó reenvia.
      O id do evento é a chave primária lá — o upsert converge para uma linha,
      e é isso que torna o reenvio inofensivo por desenho.
    */
    evento('p-ack-perdido');
    const recebidos = new Map<string, number>();
    const central: CentralTransport = {
      name: 'central-com-eco',
      isTest: true,
      async send(batch) {
        for (const r of batch) recebidos.set(r.id, (recebidos.get(r.id) ?? 0) + 1);
        // Primeira resposta "se perde": não confirma nada.
        if ([...recebidos.values()][0] === 1) return { acceptedIds: [] };
        return { acceptedIds: batch.map((r) => r.id) };
      },
      async probeSchema() {
        return { ok: true, centralVersion: 1 };
      },
    };
    const proj = projecaoComCarimbo();

    await syncOnce({ transport: central, projectionTransport: proj.transporte });
    getConnection().exec(
      "UPDATE core_outbox SET next_attempt_at = '2000-01-01T00:00:00.000Z' WHERE status = 'retry'",
    );
    await syncOnce({ transport: central, projectionTransport: proj.transporte });

    // A central VIU o fato duas vezes — e é papel dela (upsert por id) reduzir
    // a um. O que o nó garante: só marcou synced com confirmação, e projetou
    // uma vez.
    expect([...recebidos.values()][0]).toBe(2);
    expect(outboxStatus().synced).toBe(1);
    expect(proj.aplicadas).toHaveLength(1);
    expect(proj.carimbados.flat()).toHaveLength(1);
  });
});
