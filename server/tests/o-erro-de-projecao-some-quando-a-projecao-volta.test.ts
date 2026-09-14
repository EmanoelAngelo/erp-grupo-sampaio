/**
 * ============================================================================
 * O ERRO DE PROJEÇÃO SOME QUANDO A PROJEÇÃO VOLTA
 * ============================================================================
 *
 * Descoberto na conferência da retomada (30/08/2026): com a central 100%
 * saudável — 199 eventos entregues, projetados e carimbados —, o diagnóstico
 * ainda exibia um erro do dia anterior:
 *
 *     central_projection_last_error:
 *     A central recusou a projeção (HTTP 404). PGRST202 ...
 *
 * O worker gravava a última falha em `core_meta` e nunca a apagava. Erro de
 * projeção virava fóssil: quem consultasse o diagnóstico veria uma central
 * quebrada que já não existia, e não teria como distinguir "quebrou agora"
 * de "quebrou um dia".
 *
 * ## A regra
 *
 * O erro só sai quando uma projeção posterior REALMENTE acontece — a central
 * aceitou pelo menos um evento (`projectedIds` não vazio). Nada mais limpa:
 *
 *   - batida com a fila vazia não projeta nada, então não apaga nada;
 *   - entrega na aterrissagem SEM projeção (lote só de tipos desconhecidos)
 *     não é sucesso de projeção, então também não apaga;
 *   - projeção que falha registra o erro NOVO por cima — nunca esconde;
 *   - e limpar é mexer SÓ em `core_meta`: nenhum evento é tocado para
 *     deixar o diagnóstico bonito.
 */
process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';

import { beforeEach, describe, expect, it } from 'vitest';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { getConnection, withTransaction } from '../src/db/sqlite.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import { recordDomainEvent } from '../src/services/sync/DomainEvents.js';
import { setMeta, syncOnce, type CentralTransport } from '../src/services/sync/SyncService.js';
import type { ProjectionTransport } from '../src/services/sync/CentralProjection.js';

const CHAVE = 'central_projection_last_error';
const ERRO_ANTIGO = 'A central recusou a projeção (HTTP 404). PGRST202 — fóssil de 29/08.';

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

function erroRegistrado(): string | null {
  const linha = getConnection()
    .prepare('SELECT value FROM core_meta WHERE key = ?')
    .get(CHAVE) as { value?: string } | undefined;
  return linha?.value ?? null;
}

function retratoDaFila(): Map<string, string> {
  const linhas = getConnection().prepare('SELECT * FROM core_outbox ORDER BY seq').all() as Array<
    Record<string, unknown> & { id: string }
  >;
  return new Map(linhas.map((l) => [l.id, JSON.stringify(l)]));
}

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

function projecao(opts: { falharAplicacao?: boolean; falharCarimbo?: boolean } = {}) {
  const transporte: ProjectionTransport = {
    name: 'projecao-de-teste',
    isTest: true,
    async apply(projections) {
      if (opts.falharAplicacao) throw new Error('A central recusou a projeção (HTTP 503).');
      return { written: projections.length, skippedByOrder: 0 };
    },
    async marcarProjetados(ids: string[]) {
      if (opts.falharCarimbo) throw new Error('A central recusou o carimbo (HTTP 500).');
      return ids.length;
    },
  };
  return transporte;
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  getConnection().exec("DELETE FROM core_meta WHERE key LIKE 'central_%'");
  gringa = await upsertCompany({ slug: 'gringa', tradeName: 'Gringa', legalName: 'Gringa Ltda' });
});

// ============================================================================

describe('o erro de projeção some quando a projeção volta', () => {
  it('a falha de projeção registra o erro', async () => {
    evento('p-1');

    await syncOnce({
      transport: centralQueAceita(),
      projectionTransport: projecao({ falharAplicacao: true }),
    });

    expect(erroRegistrado()).toContain('HTTP 503');
  });

  it('o erro permanece enquanto não houver projeção bem-sucedida', async () => {
    // O fóssil de 29/08, tal como ficou no banco real.
    setMeta(CHAVE, ERRO_ANTIGO);

    // Batida com a fila vazia: nada foi projetado, nada é apagado.
    const r = await syncOnce({ transport: centralQueAceita(), projectionTransport: projecao() });

    expect(r.attempted).toBe(0);
    expect(erroRegistrado()).toBe(ERRO_ANTIGO);
  });

  it('entregar na aterrissagem sem projetar nada NÃO limpa', async () => {
    /*
      O caso que separa envio de projeção: um lote só de tipos que a central
      ainda não conhece é entregue (aterrissagem aceita tudo), mas nenhuma
      linha de negócio é projetada — projectedIds sai vazio. Sucesso de envio
      não é sucesso de projeção.
    */
    setMeta(CHAVE, ERRO_ANTIGO);
    evento('m-1', 'tipo.que_a_central_nao_conhece');

    const r = await syncOnce({ transport: centralQueAceita(), projectionTransport: projecao() });

    expect(r.sent).toBe(1);
    expect(r.projected?.projectedIds).toHaveLength(0);
    expect(erroRegistrado()).toBe(ERRO_ANTIGO);
  });

  it('a projeção bem-sucedida limpa o erro antigo', async () => {
    setMeta(CHAVE, ERRO_ANTIGO);
    evento('p-1');

    const r = await syncOnce({ transport: centralQueAceita(), projectionTransport: projecao() });

    expect(r.projected?.projectedIds).toHaveLength(1);
    expect(erroRegistrado()).toBeNull();
  });

  it('envio bem-sucedido com projeção falhando troca o erro — nunca esconde', async () => {
    setMeta(CHAVE, ERRO_ANTIGO);
    evento('p-1');

    await syncOnce({
      transport: centralQueAceita(),
      projectionTransport: projecao({ falharAplicacao: true }),
    });

    // O fóssil saiu de cena, mas quem entrou foi o erro ATUAL — não o vazio.
    expect(erroRegistrado()).toContain('HTTP 503');
    expect(erroRegistrado()).not.toBe(ERRO_ANTIGO);
  });

  it('a rodada seguinte com projeção bem-sucedida limpa o erro da anterior', async () => {
    evento('p-1');
    await syncOnce({
      transport: centralQueAceita(),
      projectionTransport: projecao({ falharAplicacao: true }),
    });
    expect(erroRegistrado()).toContain('HTTP 503');

    evento('p-2');
    await syncOnce({ transport: centralQueAceita(), projectionTransport: projecao() });

    expect(erroRegistrado()).toBeNull();
  });

  it('projetar com o carimbo falhando: o erro que fica é o do carimbo', async () => {
    /*
      A projeção aconteceu de verdade — o fóssil sai. Mas o carimbo falhou
      AGORA, e é esse o erro que o diagnóstico tem de mostrar.
    */
    setMeta(CHAVE, ERRO_ANTIGO);
    evento('p-1');

    await syncOnce({
      transport: centralQueAceita(),
      projectionTransport: projecao({ falharCarimbo: true }),
    });

    expect(erroRegistrado()).toContain('HTTP 500');
  });

  it('limpar o diagnóstico não toca em nenhum evento da fila', async () => {
    evento('p-1');
    await syncOnce({
      transport: centralQueAceita(),
      projectionTransport: projecao({ falharAplicacao: true }),
    });

    const antes = retratoDaFila();
    evento('p-2');
    await syncOnce({ transport: centralQueAceita(), projectionTransport: projecao() });
    expect(erroRegistrado()).toBeNull();

    /*
      A limpeza mexe SÓ em core_meta. Todo evento que já estava na fila antes
      da rodada que limpou continua byte a byte igual — nada foi reescrito,
      re-datado ou re-status-ado para deixar o diagnóstico bonito.
    */
    const depois = retratoDaFila();
    for (const [id, linha] of antes) {
      expect(depois.get(id), 'evento ' + id + ' foi alterado pela limpeza').toBe(linha);
    }
    expect(depois.size).toBe(antes.size + 1); // só o p-2 entrou, legitimamente
  });
});
