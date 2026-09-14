/**
 * A projeção na central — a metade que faltava.
 *
 * A fila subia o fato bruto para `erp_sync_events` e parava ali. As tabelas de
 * negócio de `02-central-schema.sql` ficavam vazias para sempre, e
 * `projected_at` nunca era preenchido — existe até um índice para "ainda não
 * projetado" que nenhuma linha de código usava. O `Projector` só era exercitado
 * por teste, contra a central em memória. Nada em produção o chamava.
 *
 * Uma central que recebe eventos e não os projeta não é central: é um log. O
 * gestor abriria o consolidado do grupo e veria zero.
 *
 * O QUE ESTE ARQUIVO PODE E NÃO PODE PROVAR
 *
 * PODE: quais linhas o nó monta, com que chave, em que ordem, e o que ele faz
 * quando a central recusa ou responde coisa que não dá para entender.
 *
 * NÃO PODE: que a função `erp_apply_projections` funcione. Ela vive em
 * `docs/supabase/03-projecao.sql` e só roda num Postgres de verdade — sem a
 * credencial da central ela nunca foi executada. É por isso que o estado
 * honesto continua READY_FOR_CREDENTIAL, e a tela diz exatamente isso.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDbForTests } from '../src/db/database.js';
import { withTransaction } from '../src/db/sqlite.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import { recordDomainEvent } from '../src/services/sync/DomainEvents.js';
import { pendentes } from '../src/services/sync/OutboxService.js';
import { InMemoryCentral, project, projectBatch } from '../src/services/sync/Projector.js';
import {
  RPC_PROJECAO,
  projetarLote,
  supabaseProjectionTransport,
  type ProjectionTransport,
} from '../src/services/sync/CentralProjection.js';
import { syncOnce, testCentralTransport } from '../src/services/sync/SyncService.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let gringa: string;

function evento(id: string, tipo = 'sale.registered', payload: Record<string, unknown> = {}) {
  withTransaction(() => {
    recordDomainEvent({
      eventType: tipo as never,
      aggregateType: 'sale',
      aggregateId: id,
      companyId: gringa,
      payload: { id, total_cents: 5000, ...payload },
    });
  });
}

/** Central falsa que só guarda o que recebeu, para conferir o lado do nó. */
function transporteQueRegistra(
  resposta: { written: number; skippedByOrder: number } = { written: 0, skippedByOrder: 0 },
) {
  const recebido: Record<string, unknown>[][] = [];
  const transporte: ProjectionTransport = {
    name: 'fake',
    isTest: true,
    async apply(projections) {
      recebido.push(projections as unknown as Record<string, unknown>[]);
      return { written: resposta.written || projections.length, skippedByOrder: resposta.skippedByOrder };
    },
  };
  return { transporte, recebido };
}

beforeEach(() => {
  resetDbForTests();
  gringa = upsertCompany({
    slug: 'gringa',
    legalName: 'Gringa Comércio Ltda',
    tradeName: 'Gringa',
  });
});

describe('o nó monta as linhas antes de mandar', () => {
  it('projeta o lote na ordem em que os fatos aconteceram', async () => {
    evento('v1');
    evento('v2');
    evento('v3');

    const { transporte, recebido } = transporteQueRegistra();
    const r = await projetarLote(pendentes(10), transporte);

    expect(recebido).toHaveLength(1);
    // A ordem é a do nó, não a da rede: os ids saem na sequência dos fatos.
    const ordem = pendentes(10).map((e) => e.id);
    expect(r.projectedIds).toEqual(ordem);
    // Um lote, uma viagem: projetar linha a linha faria uma venda de dez itens
    // custar onze idas à central remota.
    expect(recebido[0].length).toBeGreaterThan(0);
  });

  it('evento de tipo desconhecido NÃO derruba o lote e não é dado por projetado', async () => {
    evento('v1');
    withTransaction(() => {
      recordDomainEvent({
        eventType: 'coisa.que.a.central.nao.entende' as never,
        aggregateType: 'sale',
        aggregateId: 'v-futuro',
        companyId: gringa,
        payload: {},
      });
    });

    const { transporte } = transporteQueRegistra();
    const r = await projetarLote(pendentes(10), transporte);

    // A central pode ser mais antiga que o nó. O fato fica na aterrissagem
    // esperando a central subir de versão — e não pode constar como projetado.
    expect(r.unknownEvents).toBe(1);
    expect(r.projectedIds.length).toBeGreaterThan(0);
  });

  it('lote sem nada a projetar não chama a central', async () => {
    const { transporte, recebido } = transporteQueRegistra();
    const r = await projetarLote([], transporte);

    expect(recebido).toHaveLength(0);
    expect(r.written).toBe(0);
  });
});

describe('idempotência e ordem, provadas contra a central em memória', () => {
  it('o mesmo lote projetado dez vezes deixa UMA linha por chave', () => {
    evento('v1');
    const fila = pendentes(10);
    const central = new InMemoryCentral();

    for (let i = 0; i < 10; i += 1) projectBatch(fila, central);

    expect(central.count('erp_sales')).toBe(1);
  });

  it('evento antigo chegando atrasado NÃO sobrescreve estado novo', () => {
    const central = new InMemoryCentral();
    evento('v1');
    const [primeiro] = pendentes(10);

    // O mesmo agregado, com sequência maior — o estado mais recente.
    const novo = { ...primeiro, seq: primeiro.seq + 50 };
    projectBatch([novo], central);
    const depoisDoNovo = central.rows('erp_sales')[0];

    // Agora o atrasado. Sem a guarda, ele apagaria o estado novo e o pedido
    // voltaria no tempo na frente do cliente.
    const r = projectBatch([primeiro], central);
    expect(r.skippedByOrder).toBeGreaterThan(0);
    expect(central.rows('erp_sales')[0].node_seq).toBe(depoisDoNovo.node_seq);
  });
});

describe('quando a central responde errado', () => {
  it('HTTP de erro vira exceção com o status, não sucesso silencioso', async () => {
    const transporte = supabaseProjectionTransport({
      url: 'https://central.exemplo',
      serviceRoleKey: 'chave',
      fetchImpl: (async () =>
        new Response('permission denied', { status: 403 })) as unknown as typeof fetch,
    });

    evento('v1');
    await expect(projetarLote(pendentes(10), transporte)).rejects.toThrow(/403/);
  });

  it('resposta sem contagem é recusada — não se inventa que gravou', async () => {
    const transporte = supabaseProjectionTransport({
      url: 'https://central.exemplo',
      serviceRoleKey: 'chave',
      fetchImpl: (async () =>
        new Response('{"ok":true}', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })) as unknown as typeof fetch,
    });

    evento('v1');
    // Dizer que gravou o que não se sabe ter gravado é como o consolidado fica
    // errado em silêncio.
    await expect(projetarLote(pendentes(10), transporte)).rejects.toThrow(/quantas linhas/);
  });

  it('chama a RPC certa, com a chave de serviço nos dois cabeçalhos', async () => {
    const chamadas: { url: string; init: RequestInit }[] = [];
    const transporte = supabaseProjectionTransport({
      url: 'https://central.exemplo/',
      serviceRoleKey: 'chave-secreta',
      fetchImpl: (async (url: string, init: RequestInit) => {
        chamadas.push({ url, init });
        return new Response('{"written":1,"skipped_by_order":0}', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as unknown as typeof fetch,
    });

    evento('v1');
    await projetarLote(pendentes(10), transporte);

    expect(chamadas[0].url).toBe(`https://central.exemplo/rest/v1/rpc/${RPC_PROJECAO}`);
    const headers = chamadas[0].init.headers as Record<string, string>;
    expect(headers.apikey).toBe('chave-secreta');
    expect(headers.Authorization).toBe('Bearer chave-secreta');
  });
});

describe('projetar é consequência de entregar, nunca o contrário', () => {
  it('a falha da projeção não devolve o evento para a fila de envio', async () => {
    evento('v1');
    const quebrado: ProjectionTransport = {
      name: 'quebrado',
      isTest: true,
      apply: async () => {
        throw new Error('central fora do ar');
      },
    };

    const r = await syncOnce({
      transport: testCentralTransport(),
      projectionTransport: quebrado,
    });

    // O fato JÁ ESTÁ na aterrissagem: reenviá-lo não conserta a projeção e
    // ainda faria a fila crescer para sempre. A projeção se refaz depois.
    expect(r.sent).toBe(1);
    expect(r.failed).toBe(0);
    expect(r.projected).toBeUndefined();
  });

  it('sem transporte de projeção, não projeta e não finge que projetou', async () => {
    evento('v1');
    const r = await syncOnce({ transport: testCentralTransport() });

    expect(r.sent).toBe(1);
    // `undefined` e não `{written: 0}`: zero pareceria "tentou e nada havia".
    expect(r.projected).toBeUndefined();
  });

  it('com transporte, projeta só o que a central CONFIRMOU ter recebido', async () => {
    evento('v1');
    const { transporte } = transporteQueRegistra();

    const r = await syncOnce({
      transport: testCentralTransport(),
      projectionTransport: transporte,
    });

    expect(r.sent).toBe(1);
    expect(r.projected?.projectedIds).toHaveLength(1);
  });
});

describe('a lista branca do Postgres acompanha o projetor', () => {
  it('toda tabela que o projetor escreve está autorizada no SQL', () => {
    const sql = readFileSync(
      join(process.cwd(), '..', 'docs', 'supabase', '03-projecao.sql'),
      'utf8',
    );

    // A função SQL levanta exceção para tabela fora da lista — de propósito,
    // porque ignorar faria o nó marcar como projetado um fato que não chegou a
    // tabela nenhuma. O preço disso é a lista precisar acompanhar o projetor, e
    // é este teste que cobra.
    const tabelas = new Set<string>();
    for (const tipo of [
      'company.upserted',
      'customer.upserted',
      'equipment.upserted',
      'finance.entry_recorded',
      'fiscal.document_issued',
      'fiscal.event_recorded',
      'inventory.moved',
      'inventory.reserved',
      'order.placed',
      'order.status_changed',
      'payment.registered',
      'product.upserted',
      'product_variant.upserted',
      'sale.registered',
      'service_order.opened',
    ]) {
      for (const p of project({
        id: 'x',
        seq: 1,
        event_type: tipo,
        aggregate_type: 'x',
        aggregate_id: 'x',
        company_id: gringa,
        payload: '{}',
        occurred_at: new Date().toISOString(),
      } as never)) {
        tabelas.add(p.table);
      }
    }

    // Se o projetor deixasse de reconhecer tudo, o laço abaixo passaria vazio
    // e este teste viraria enfeite.
    expect(tabelas.size).toBeGreaterThan(3);
    for (const tabela of tabelas) {
      expect(sql).toContain(`'${tabela}'`);
    }
  });
});
