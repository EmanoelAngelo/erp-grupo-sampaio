/**
 * ============================================================================
 * MUDANÇA DE STATUS NÃO PODE INVENTAR O PEDIDO
 * ============================================================================
 *
 * A primeira reprojeção real (29/08/2026) projetou 115 de 118 eventos. Os 3
 * que falharam eram `order.status_changed`, todos com o mesmo erro do
 * PostgreSQL: 23502, violação de NOT NULL em `erp_orders.total_cents`.
 *
 * O payload real desses eventos é enxuto — `{note, status, event_id,
 * order_id}` — porque é isso que uma mudança de status É. Mas o projetor,
 * além da linha de histórico (cujos dados existem todos), emitia um upsert em
 * `erp_orders` com só `{id, company_id, status}`. Quando o pedido já existe na
 * central, o upsert cai no UPDATE e funciona. Quando não existe, cai no INSERT
 * — e um INSERT sem `total_cents` numa coluna NOT NULL é recusado.
 *
 * E "não existe" não era hipótese: dois dos três pedidos foram criados em
 * 12/08, TRÊS DIAS antes de a outbox existir. O `order.placed` deles nunca foi
 * capturado. O terceiro nem existe mais no banco local.
 *
 * ## A regra que este arquivo trava
 *
 * O fato de uma mudança de status é a MUDANÇA — e ela vai para o histórico,
 * sempre, porque seus dados existem todos no evento. A linha de estado em
 * `erp_orders` só é emitida quando o payload carrega o que o INSERT exige
 * (`total_cents`): um estado que não se consegue criar por inteiro não se cria
 * pela metade. Quem cria o estado-base é `order.placed` — e, para os pedidos
 * anteriores à outbox, o bootstrap, que lê `core_orders` local.
 *
 * ## E a emissão fica mais rica daqui para a frente
 *
 * `addOrderEvent` passa a carregar no payload o retrato do pedido no momento
 * da mudança (número, totais, cliente). Não é invenção: o pedido ESTÁ no banco
 * na hora da emissão, uma consulta de distância. Com isso, os eventos futuros
 * são autossuficientes — e o upsert de estado volta a valer para eles.
 */
process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_DATABASE_PATH = ':memory:';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

import { beforeEach, describe, expect, it } from 'vitest';

const { resetDbForTests } = await import('../src/db/database.js');
const { ensureCoreSchema, resetCoreSchemaCache } = await import('../src/db/schema.js');
const { getConnection } = await import('../src/db/sqlite.js');
const { upsertCompany } = await import('../src/services/auth/IdentityService.js');
const { project } = await import('../src/services/sync/Projector.js');
const { addOrderEvent } = await import('../src/services/core/StorefrontService.js');
const { pendentes } = await import('../src/services/sync/OutboxService.js');
import type { OutboxRow } from '../src/services/sync/OutboxService.js';

let gringa: string;

/**
 * A forma EXATA dos três eventos reais que falharam — payload copiado do que
 * está na landing, com ids trocados por valores de teste.
 */
function eventoRealDeStatus(over: Partial<OutboxRow> = {}): OutboxRow {
  return {
    seq: 6,
    id: 'ev-status-1',
    node_id: 'no-1',
    event_type: 'order.status_changed',
    aggregate_type: 'ecommerce_order',
    aggregate_id: 'ord-legado-1',
    company_id: gringa,
    operational_unit_id: null,
    operation: 'update',
    schema_version: 1,
    payload: JSON.stringify({
      note: 'Pagamento confirmado',
      status: 'pago',
      event_id: 'hist-1',
      order_id: 'ord-legado-1',
    }),
    occurred_at: '2026-08-16T02:50:46.766Z',
    status: 'synced',
    attempts: 0,
    next_attempt_at: null,
    last_error: null,
    sent_at: null,
    created_at: '2026-08-16T02:50:46.766Z',
    ...over,
  };
}

beforeEach(async () => {
  resetCoreSchemaCache();
  resetDbForTests();
  ensureCoreSchema();
  gringa = await upsertCompany({ slug: 'gringa', tradeName: 'Gringa', legalName: 'Gringa Ltda' });
});

// ============================================================================

describe('payload enxuto — o dos três eventos reais', () => {
  it('projeta SÓ o histórico: os dados dele existem todos', () => {
    const linhas = project(eventoRealDeStatus());

    expect(linhas).toHaveLength(1);
    expect(linhas[0].table).toBe('erp_order_status_history');
    expect(linhas[0].row.status).toBe('pago');
    expect(linhas[0].row.note).toBe('Pagamento confirmado');
    expect(linhas[0].row.company_id).toBe(gringa);
    expect(linhas[0].row.order_id).toBe('ord-legado-1');
  });

  it('NÃO emite linha de erp_orders — seria um INSERT sem total_cents', () => {
    /*
      É o 23502 em forma de teste. A linha de estado com só {id, company,
      status} funciona no UPDATE e explode no INSERT — e o projetor não tem
      como saber qual dos dois vai acontecer.
    */
    const linhas = project(eventoRealDeStatus());
    expect(linhas.map((l) => l.table)).not.toContain('erp_orders');
  });
});

// ============================================================================

describe('payload autossuficiente — o dos eventos daqui para a frente', () => {
  function payloadRico(): string {
    return JSON.stringify({
      note: 'Pagamento confirmado',
      status: 'pago',
      event_id: 'hist-2',
      order_id: 'ord-novo-1',
      number: 7,
      customer_name: 'Cliente da Silva',
      items_cents: 30000,
      shipping_cents: 2900,
      total_cents: 32900,
    });
  }

  it('emite o histórico E o estado do pedido', () => {
    const linhas = project(eventoRealDeStatus({
      aggregate_id: 'ord-novo-1',
      payload: payloadRico(),
    }));

    expect(linhas.map((l) => l.table).sort()).toEqual([
      'erp_order_status_history',
      'erp_orders',
    ]);
  });

  it('e a linha de estado carrega o total — o INSERT passa a ser possível', () => {
    const linhas = project(eventoRealDeStatus({
      aggregate_id: 'ord-novo-1',
      payload: payloadRico(),
    }));
    const estado = linhas.find((l) => l.table === 'erp_orders');

    expect(estado?.row.total_cents).toBe(32900);
    expect(estado?.row.number).toBe(7);
    expect(estado?.row.status).toBe('pago');
    expect(estado?.guardByOrder, 'estado continua protegido por ordem').toBe(true);
  });
});

// ============================================================================

describe('a emissão fica autossuficiente na fonte', () => {
  it('addOrderEvent carrega o retrato do pedido no payload', () => {
    /*
      Não é invenção de dado: o pedido ESTÁ no banco no momento da emissão.
      Sem isso, todo evento futuro de status repete a fragilidade dos três
      que falharam.
    */
    const agora = new Date().toISOString();
    getConnection()
      .prepare(
        `INSERT INTO core_orders (id, company_id, number, customer_name, shipping_cents,
           items_cents, total_cents, status, idempotency_key, created_at, updated_at)
         VALUES ('ord-vivo', ?, 9, 'Cliente Teste', 2900, 30000, 32900,
           'aguardando_pagamento', 'idem-1', ?, ?)`,
      )
      .run(gringa, agora, agora);

    addOrderEvent('ord-vivo', gringa, 'pago', 'Pagamento confirmado');

    const evento = pendentes(10).find(
      (e) => e.event_type === 'order.status_changed' && e.aggregate_id === 'ord-vivo',
    );
    expect(evento, 'o evento tem de estar na fila').toBeTruthy();

    const p = JSON.parse(String(evento?.payload)) as Record<string, unknown>;
    expect(p.status).toBe('pago');
    expect(p.total_cents).toBe(32900);
    expect(p.number).toBe(9);
    expect(p.customer_name).toBe('Cliente Teste');
    // E o que sempre esteve continua: o vínculo com a linha de histórico.
    expect(p.order_id).toBe('ord-vivo');
    expect(typeof p.event_id).toBe('string');
  });

  it('pedido inexistente é RECUSADO pela chave estrangeira — antes do retrato', () => {
    /*
      Registrar status de pedido que não existe é recusado pelo banco:
      `core_order_events.order_id` referencia `core_orders`. O caso Conceito
      — evento de status na central para pedido ausente no local — só pôde
      existir porque o pedido foi APAGADO depois de o evento ter sido
      emitido. Pela porta da frente, o retrato sempre encontra o pedido.
    */
    expect(() =>
      addOrderEvent('ord-fantasma', gringa, 'cancelado', 'Cancelado'),
    ).toThrow(/FOREIGN KEY/);

    expect(pendentes(10).find((e) => e.aggregate_id === 'ord-fantasma')).toBeUndefined();
  });
});
