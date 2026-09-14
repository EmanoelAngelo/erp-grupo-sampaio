/**
 * Projetor — do fato bruto para as tabelas de negócio da central.
 *
 * Duas propriedades e um cuidado:
 *
 * 1. IDEMPOTÊNCIA — reprojetar a fila inteira do zero não duplica nada. É isso
 *    que torna o "replay" uma operação de rotina em vez de um risco.
 *
 * 2. ORDEM — a rede não entrega em ordem. Um "pedido criado" que chega atrasado
 *    NÃO pode reverter um "pedido entregue" já projetado: o cliente veria o
 *    pedido voltar no tempo.
 *
 * 3. HISTÓRICO — cadastro não é apagado. Produto que já saiu em venda antiga
 *    continua existindo, marcado como desativado.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { getConnection, withTransaction } from '../src/db/sqlite.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import { recordDomainEvent } from '../src/services/sync/DomainEvents.js';
import type { OutboxRow } from '../src/services/sync/OutboxService.js';
import { InMemoryCentral, project, projectBatch } from '../src/services/sync/Projector.js';
import { createSale } from '../src/services/core/SalesService.js';
import { createEntry } from '../src/services/core/FinanceService.js';

let gringa: string;
let precoJusto: string;

function filaBruta(): OutboxRow[] {
  return getConnection()
    .prepare('SELECT * FROM core_outbox ORDER BY seq')
    .all() as unknown as OutboxRow[];
}

function produto(companyId: string, id: string, saldo: number): void {
  const agora = new Date().toISOString();
  const db = getConnection();
  db.prepare(
    `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                price_cents, active, created_at, updated_at)
     VALUES (?, ?, ?, 'Item', 'UN', 1000, 2500, 1, ?, ?)`,
  ).run(id, companyId, `PR-${id}`, agora, agora);
  db.prepare(
    'INSERT INTO core_stock (company_id, product_id, quantity, reserved, updated_at) VALUES (?, ?, ?, 0, ?)',
  ).run(companyId, id, saldo, agora);
}

/** Monta um evento cru sem passar pelo banco — para exercitar ordem à mão. */
function eventoCru(over: Partial<OutboxRow>): OutboxRow {
  return {
    seq: 1,
    id: 'ev-1',
    node_id: 'no-1',
    event_type: 'order.status_changed',
    aggregate_type: 'ecommerce_order',
    aggregate_id: 'ord-1',
    company_id: gringa,
    operational_unit_id: null,
    operation: 'update',
    schema_version: 1,
    payload: '{}',
    occurred_at: new Date().toISOString(),
    status: 'pending',
    attempts: 0,
    next_attempt_at: null,
    last_error: null,
    sent_at: null,
    created_at: new Date().toISOString(),
    ...over,
  };
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  gringa = await upsertCompany({ slug: 'gringa', tradeName: 'Gringa', legalName: 'Gringa Ltda' });
  precoJusto = await upsertCompany({
    slug: 'preco-justo',
    tradeName: 'Preço Justo',
    legalName: 'PJ Ltda',
  });
});

describe('projeção básica', () => {
  it('a venda vira cabeçalho e itens', () => {
    produto(gringa, 'p-1', 10);
    createSale({
      companyId: gringa,
      userId: 'u-1',
      idempotencyKey: 'v-1',
      items: [{ productId: 'p-1', quantity: 2 }],
      payments: [{ method: 'dinheiro', amountCents: 5000 }],
    });

    const central = new InMemoryCentral();
    projectBatch(filaBruta(), central);

    expect(central.count('erp_sales')).toBe(1);
    expect(central.count('erp_sale_items')).toBe(1);
    const [venda] = central.rows('erp_sales');
    expect(venda.total_cents).toBe(5000);
    expect(venda.company_id).toBe(gringa);
  });

  it('o movimento vira razão E atualiza o saldo consolidado', () => {
    produto(gringa, 'p-1', 10);
    createSale({
      companyId: gringa,
      userId: 'u-1',
      idempotencyKey: 'v-1',
      items: [{ productId: 'p-1', quantity: 3 }],
      payments: [{ method: 'dinheiro', amountCents: 7500 }],
    });

    const central = new InMemoryCentral();
    projectBatch(filaBruta(), central);

    expect(central.count('erp_inventory_ledger')).toBe(1);
    const [saldo] = central.rows('erp_inventory_snapshots');
    expect(saldo.quantity).toBe(7);
  });

  it('o financeiro chega com valor, direção e origem', () => {
    createEntry({
      companyId: gringa,
      direction: 'in',
      description: 'Serviço avulso',
      amountCents: 9000,
    });

    const central = new InMemoryCentral();
    projectBatch(filaBruta(), central);

    const [lancamento] = central.rows('erp_finance_entries');
    expect(lancamento.amount_cents).toBe(9000);
    expect(lancamento.direction).toBe('in');
    expect(lancamento.origin_type).toBe('manual');
    expect(lancamento.company_id).toBe(gringa);
  });

  it('evento desconhecido NÃO derruba a projeção do resto', () => {
    const central = new InMemoryCentral();
    const r = projectBatch(
      [
        eventoCru({ seq: 1, id: 'a', event_type: 'algo.que.nao.existe' as never }),
        eventoCru({
          seq: 2,
          id: 'b',
          event_type: 'order.placed',
          payload: JSON.stringify({ total_cents: 100, status: 'aguardando_pagamento' }),
        }),
      ],
      central,
    );

    // Um nó mais novo mandando um tipo que esta central não entende ainda: o
    // fato fica na aterrissagem esperando a central ser atualizada.
    expect(r.unknownEvents).toBe(1);
    expect(central.count('erp_orders')).toBe(1);
  });
});

describe('IDEMPOTÊNCIA — replay não duplica', () => {
  it('projetar a mesma fila dez vezes deixa a central igual', () => {
    produto(gringa, 'p-1', 10);
    createSale({
      companyId: gringa,
      userId: 'u-1',
      idempotencyKey: 'v-1',
      items: [{ productId: 'p-1', quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: 2500 }],
    });
    const eventos = filaBruta();
    const central = new InMemoryCentral();

    for (let i = 0; i < 10; i += 1) projectBatch(eventos, central);

    expect(central.count('erp_sales')).toBe(1);
    expect(central.count('erp_sale_items')).toBe(1);
    expect(central.count('erp_inventory_ledger')).toBe(1);
    expect(central.count('erp_inventory_snapshots')).toBe(1);
  });

  it('o replay completo do zero reproduz o mesmo estado', () => {
    produto(gringa, 'p-1', 10);
    createSale({
      companyId: gringa,
      userId: 'u-1',
      idempotencyKey: 'v-1',
      items: [{ productId: 'p-1', quantity: 2 }],
      payments: [{ method: 'dinheiro', amountCents: 5000 }],
    });
    const eventos = filaBruta();

    const primeira = new InMemoryCentral();
    projectBatch(eventos, primeira);
    const segunda = new InMemoryCentral();
    projectBatch(eventos, segunda);
    projectBatch(eventos, segunda);

    expect(segunda.rows('erp_sales')).toEqual(primeira.rows('erp_sales'));
  });
});

describe('ORDEM — evento antigo não sobrescreve estado novo', () => {
  it('o "entregue" sobrevive a um "aguardando pagamento" atrasado', () => {
    const central = new InMemoryCentral();

    /*
      Os payloads carregam total_cents porque a linha de estado em
      `erp_orders` só é emitida quando o payload sustenta um INSERT — a
      regra que os três eventos reais de 29/08/2026 ensinaram (23502 em
      total_cents NOT NULL). `addOrderEvent` emite assim desde então.
      A guarda de ordem, que é o assunto DESTE caso, continua a mesma.
    */
    // Chega primeiro o novo (seq 9), depois o antigo (seq 2).
    central.apply(
      project(
        eventoCru({
          seq: 9,
          id: 'ev-novo',
          payload: JSON.stringify({
            order_id: 'ord-1',
            status: 'entregue',
            event_id: 'e9',
            total_cents: 32900,
          }),
        }),
      ),
    );
    const r = central.apply(
      project(
        eventoCru({
          seq: 2,
          id: 'ev-antigo',
          payload: JSON.stringify({
            order_id: 'ord-1',
            status: 'aguardando_pagamento',
            event_id: 'e2',
            total_cents: 32900,
          }),
        }),
      ),
    );

    const [pedido] = central.rows('erp_orders');
    // Sem a guarda, o cliente veria o pedido voltar no tempo.
    expect(pedido.status).toBe('entregue');
    expect(r.skippedByOrder).toBe(1);
  });

  it('o histórico de status guarda AS DUAS linhas — ele é imutável', () => {
    const central = new InMemoryCentral();
    central.apply(
      project(
        eventoCru({
          seq: 9,
          payload: JSON.stringify({ order_id: 'ord-1', status: 'entregue', event_id: 'e9' }),
        }),
      ),
    );
    central.apply(
      project(
        eventoCru({
          seq: 2,
          payload: JSON.stringify({ order_id: 'ord-1', status: 'pago', event_id: 'e2' }),
        }),
      ),
    );

    // O estado corrente é protegido por ordem; o histórico não perde nada.
    expect(central.count('erp_order_status_history')).toBe(2);
  });

  it('a razão de estoque é imutável: chegada fora de ordem não reescreve', () => {
    const central = new InMemoryCentral();
    const base = {
      event_type: 'inventory.moved' as const,
      aggregate_type: 'inventory_movement',
    };
    central.apply(
      project(
        eventoCru({
          ...base,
          seq: 5,
          aggregate_id: 'mov-1',
          payload: JSON.stringify({ product_id: 'p-1', quantity: -1, balance_after: 9 }),
        }),
      ),
    );
    central.apply(
      project(
        eventoCru({
          ...base,
          seq: 3,
          aggregate_id: 'mov-2',
          payload: JSON.stringify({ product_id: 'p-1', quantity: -2, balance_after: 7 }),
        }),
      ),
    );

    // Dois movimentos distintos: os dois ficam.
    expect(central.count('erp_inventory_ledger')).toBe(2);
    // Mas o SALDO consolidado fica com o mais recente, não com o atrasado.
    const [saldo] = central.rows('erp_inventory_snapshots');
    expect(saldo.quantity).toBe(9);
  });
});

describe('HISTÓRICO — cadastro não é apagado', () => {
  it('produto desativado vira tombstone, não some da central', () => {
    const central = new InMemoryCentral();
    central.apply(
      project(
        eventoCru({
          seq: 1,
          event_type: 'product.upserted',
          aggregate_type: 'product',
          aggregate_id: 'p-1',
          payload: JSON.stringify({ name: 'Camiseta', active: 1, price_cents: 5000 }),
        }),
      ),
    );
    central.apply(
      project(
        eventoCru({
          seq: 2,
          event_type: 'product.deactivated',
          aggregate_type: 'product',
          aggregate_id: 'p-1',
          payload: JSON.stringify({ name: 'Camiseta', active: 0, price_cents: 5000 }),
        }),
      ),
    );

    const [prod] = central.rows('erp_products');
    // Apagar quebraria a nota e o relatório de qualquer venda antiga.
    expect(central.count('erp_products')).toBe(1);
    expect(prod.deactivated_at).toBeTruthy();
    expect(prod.name).toBe('Camiseta');
  });
});

describe('MULTI-EMPRESA — nenhuma projeção mistura tenants', () => {
  it('vendas de duas operações ficam separadas por company_id', () => {
    produto(gringa, 'pg-1', 10);
    produto(precoJusto, 'pj-1', 10);
    createSale({
      companyId: gringa,
      userId: 'u-1',
      idempotencyKey: 'vg',
      items: [{ productId: 'pg-1', quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: 2500 }],
    });
    createSale({
      companyId: precoJusto,
      userId: 'u-2',
      idempotencyKey: 'vp',
      items: [{ productId: 'pj-1', quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: 2500 }],
    });

    const central = new InMemoryCentral();
    projectBatch(filaBruta(), central);

    const vendas = central.rows('erp_sales');
    expect(vendas).toHaveLength(2);
    expect(new Set(vendas.map((v) => v.company_id))).toEqual(new Set([gringa, precoJusto]));

    // Nenhuma linha pode ficar sem dono, nem com dono trocado.
    for (const tabela of central.tables()) {
      for (const linha of central.rows(tabela)) {
        if (linha.company_id === undefined) continue;
        expect([gringa, precoJusto]).toContain(linha.company_id);
      }
    }
  });
});
