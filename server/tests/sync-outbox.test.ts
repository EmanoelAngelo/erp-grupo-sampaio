/**
 * Fila de saída — o fato e o evento são inseparáveis.
 *
 * O que este arquivo cobra é a propriedade que sustenta toda a sincronização:
 * o evento vive e morre com o fato. Se a venda volta atrás, o evento some; se
 * a venda commita, o evento existe. Não há terceiro estado — e é justamente o
 * terceiro estado ("gravou e não publicou") que faz a central divergir para
 * sempre sem ninguém perceber.
 *
 * Cobre também o que NUNCA pode sair do nó: senha, certificado, token, chave.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { getConnection, withTransaction } from '../src/db/sqlite.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import { nodeId, redigirPayload } from '../src/services/sync/OutboxService.js';
import { EVENT_SCHEMA_VERSION, recordDomainEvent } from '../src/services/sync/DomainEvents.js';
import { createSale } from '../src/services/core/SalesService.js';
import { applyMovement, reserveStock } from '../src/services/core/InventoryService.js';
import { createEntry } from '../src/services/core/FinanceService.js';
import { checkout } from '../src/services/core/StorefrontService.js';
import { createCustomer, createProduct } from '../src/services/core/CatalogService.js';

let gringa: string;
let precoJusto: string;

interface FilaRow {
  id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  company_id: string;
  operational_unit_id: string | null;
  schema_version: number;
  payload: string;
  status: string;
  occurred_at: string;
}

function fila(): FilaRow[] {
  return getConnection()
    .prepare('SELECT * FROM core_outbox ORDER BY seq')
    .all() as unknown as FilaRow[];
}

function filaDe(aggregateType: string): FilaRow[] {
  return fila().filter((f) => f.aggregate_type === aggregateType);
}

function produto(companyId: string, id: string, saldo: number): string {
  const agora = new Date().toISOString();
  const db = getConnection();
  db.prepare(
    `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                price_cents, active, publish_online, created_at, updated_at)
     VALUES (?, ?, ?, 'Item', 'UN', 1000, 2500, 1, 1, ?, ?)`,
  ).run(id, companyId, `SY-${id}`, agora, agora);
  db.prepare(
    'INSERT INTO core_stock (company_id, product_id, quantity, reserved, updated_at) VALUES (?, ?, ?, 0, ?)',
  ).run(companyId, id, saldo, agora);
  return id;
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

describe('envelope do evento', () => {
  it('carrega tipo, agregado, empresa e VERSÃO do schema', () => {
    withTransaction(() => {
      recordDomainEvent({
        eventType: 'sale.registered',
        aggregateType: 'sale',
        aggregateId: 'venda-1',
        companyId: gringa,
        payload: { total_cents: 5000 },
      });
    });

    const [evento] = fila();
    expect(evento.event_type).toBe('sale.registered');
    expect(evento.aggregate_type).toBe('sale');
    expect(evento.aggregate_id).toBe('venda-1');
    expect(evento.company_id).toBe(gringa);
    // Sem versão no envelope, evoluir o payload depois quebraria a leitura de
    // todo evento antigo que ainda estivesse na fila.
    expect(evento.schema_version).toBe(EVENT_SCHEMA_VERSION);
  });

  it('a unidade operacional acompanha quando o fato é de uma oficina', () => {
    withTransaction(() => {
      recordDomainEvent({
        eventType: 'service_order.opened',
        aggregateType: 'service_order',
        aggregateId: 'os-1',
        companyId: gringa,
        operationalUnitId: 'oficina-mobilidade',
        payload: {},
      });
    });

    // Duas oficinas do grupo não são duas empresas: sem este campo o
    // consolidado somaria as duas como se fossem uma.
    expect(fila()[0].operational_unit_id).toBe('oficina-mobilidade');
  });

  it('o nó vai junto — a central sabe de onde veio o fato', () => {
    withTransaction(() => {
      recordDomainEvent({
        eventType: 'sale.registered',
        aggregateType: 'sale',
        aggregateId: 'v-1',
        companyId: gringa,
        payload: {},
      });
    });

    const linha = getConnection()
      .prepare('SELECT node_id FROM core_outbox LIMIT 1')
      .get() as { node_id: string };
    expect(linha.node_id).toBe(nodeId());
  });

  it('enfileirar FORA de transação é erro, não caso tolerado', () => {
    expect(() =>
      recordDomainEvent({
        eventType: 'sale.registered',
        aggregateType: 'sale',
        aggregateId: 'v-1',
        companyId: gringa,
        payload: {},
      }),
    ).toThrow(/transação/i);
  });
});

describe('ATOMICIDADE — rollback do fato leva o evento junto', () => {
  it('venda: estoque insuficiente desfaz a venda E o evento', () => {
    produto(gringa, 'p-1', 1);

    expect(() =>
      createSale({
        companyId: gringa,
        userId: 'u-1',
        idempotencyKey: 'v-rollback',
        items: [{ productId: 'p-1', quantity: 5 }],
        payments: [{ method: 'dinheiro', amountCents: 12500 }],
      }),
    ).toThrow();

    // Sem isto, a central registraria uma venda que o estoque recusou.
    expect(fila()).toHaveLength(0);
    const vendas = getConnection().prepare('SELECT COUNT(*) c FROM core_sales').get() as {
      c: number;
    };
    expect(vendas.c).toBe(0);
  });

  it('estoque: movimento que estoura o saldo não deixa evento', () => {
    produto(gringa, 'p-1', 2);

    expect(() =>
      applyMovement({
        companyId: gringa,
        productId: 'p-1',
        movementType: 'out',
        quantity: 99,
        referenceType: 'ajuste',
        referenceId: 'ref-1',
      }),
    ).toThrow();

    expect(filaDe('inventory_movement')).toHaveLength(0);
  });

  it('financeiro: lançamento inválido não deixa evento', () => {
    expect(() =>
      createEntry({
        companyId: gringa,
        direction: 'in',
        description: 'Teste',
        amountCents: 0,
      }),
    ).toThrow();

    expect(filaDe('finance_entry')).toHaveLength(0);
  });

  it('pedido: checkout sem saldo não deixa evento nem reserva', () => {
    produto(gringa, 'p-1', 1);

    expect(() =>
      checkout({
        idempotencyKey: 'pedido-rollback',
        customerName: 'Ana',
        customerDocument: '111.444.777-35',
        paymentMethod: 'pix',
        items: [{ productId: 'p-1', quantity: 9 }],
      }),
    ).toThrow();

    expect(filaDe('ecommerce_order')).toHaveLength(0);
    const reserva = getConnection()
      .prepare('SELECT reserved FROM core_stock WHERE product_id = ?')
      .get('p-1') as { reserved: number };
    expect(reserva.reserved).toBe(0);
  });

  it('uma transação externa que falha desfaz TODOS os eventos dela', () => {
    produto(gringa, 'p-1', 10);

    expect(() =>
      withTransaction(() => {
        applyMovement({
          companyId: gringa,
          productId: 'p-1',
          movementType: 'out',
          quantity: 1,
          referenceType: 'ajuste',
          referenceId: 'r-1',
        });
        createEntry({
          companyId: gringa,
          direction: 'in',
          description: 'Lançamento',
          amountCents: 1000,
        });
        throw new Error('falha no fim da operação');
      }),
    ).toThrow('falha no fim da operação');

    // Dois fatos, uma transação, nenhum evento.
    expect(fila()).toHaveLength(0);
  });
});

describe('COBERTURA — cada domínio gera o seu fato', () => {
  it('venda registra evento com itens e pagamentos', () => {
    produto(gringa, 'p-1', 10);
    const { sale } = createSale({
      companyId: gringa,
      userId: 'u-1',
      idempotencyKey: 'v-1',
      items: [{ productId: 'p-1', quantity: 2 }],
      payments: [{ method: 'dinheiro', amountCents: 5000 }],
    });

    const venda = filaDe('sale')[0];
    expect(venda.aggregate_id).toBe(sale.id);
    const payload = JSON.parse(venda.payload) as Record<string, unknown>;
    expect((payload.items as unknown[]).length).toBe(1);
    expect((payload.payments as unknown[]).length).toBe(1);
  });

  it('movimento de estoque registra saldo anterior e posterior', () => {
    produto(gringa, 'p-1', 10);
    applyMovement({
      companyId: gringa,
      productId: 'p-1',
      movementType: 'out',
      quantity: 3,
      referenceType: 'ajuste',
      referenceId: 'r-1',
    });

    const mov = filaDe('inventory_movement')[0];
    const payload = JSON.parse(mov.payload) as Record<string, unknown>;
    expect(payload.quantity_before).toBe(10);
    expect(payload.balance_after).toBe(7);
  });

  it('reserva registra fato próprio, sem mexer no saldo físico', () => {
    produto(gringa, 'p-1', 10);
    reserveStock({
      companyId: gringa,
      productId: 'p-1',
      quantity: 2,
      referenceType: 'ecommerce_order',
      referenceId: 'o-1',
    });

    const reserva = filaDe('inventory_reservation')[0];
    const payload = JSON.parse(reserva.payload) as Record<string, unknown>;
    expect(payload.reserved_delta).toBe(2);
    expect(payload.quantity).toBe(10);
  });

  it('produto, cliente, financeiro e pedido também sobem', () => {
    createProduct(gringa, { name: 'Camiseta', priceCents: 5000, unit: 'UN' });
    createCustomer(gringa, { name: 'Ana', document: '111.444.777-35' });
    createEntry({ companyId: gringa, direction: 'in', description: 'Serviço', amountCents: 9000 });
    produto(gringa, 'p-2', 5);
    checkout({
      idempotencyKey: 'pedido-1',
      customerName: 'Bruno',
      customerDocument: '529.982.247-25',
      paymentMethod: 'pix',
      items: [{ productId: 'p-2', quantity: 1 }],
    });

    expect(filaDe('product').length).toBeGreaterThanOrEqual(1);
    expect(filaDe('customer').length).toBeGreaterThanOrEqual(1);
    expect(filaDe('finance_entry').length).toBeGreaterThanOrEqual(1);
    expect(filaDe('ecommerce_order').length).toBeGreaterThanOrEqual(1);
  });

  it('mudança de estado do pedido vira fato separado do pedido', () => {
    produto(gringa, 'p-1', 5);
    checkout({
      idempotencyKey: 'pedido-2',
      customerName: 'Ana',
      customerDocument: '111.444.777-35',
      paymentMethod: 'pix',
      items: [{ productId: 'p-1', quantity: 1 }],
    });

    const tipos = filaDe('ecommerce_order').map((f) => f.event_type);
    expect(tipos).toContain('order.placed');
    expect(tipos).toContain('order.status_changed');
  });
});

describe('MULTI-EMPRESA — a central não pode misturar tenants', () => {
  it('cada evento carrega a empresa dona, e elas não se cruzam', () => {
    produto(gringa, 'pg-1', 10);
    produto(precoJusto, 'pj-1', 10);

    createSale({
      companyId: gringa,
      userId: 'u-1',
      idempotencyKey: 'vg-1',
      items: [{ productId: 'pg-1', quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: 2500 }],
    });
    createSale({
      companyId: precoJusto,
      userId: 'u-2',
      idempotencyKey: 'vp-1',
      items: [{ productId: 'pj-1', quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: 2500 }],
    });

    const vendas = filaDe('sale');
    expect(vendas).toHaveLength(2);
    expect(new Set(vendas.map((v) => v.company_id))).toEqual(new Set([gringa, precoJusto]));
    // Nenhum evento pode ter a empresa errada: seria faturamento de um CNPJ
    // aparecendo no consolidado de outro.
    for (const evento of fila()) {
      expect([gringa, precoJusto]).toContain(evento.company_id);
    }
  });
});

describe('SEGREDO não sai do nó', () => {
  it('campos sensíveis somem do payload em qualquer profundidade', () => {
    const limpo = redigirPayload({
      id: 'u-1',
      email: 'ana@exemplo.com',
      password_hash: '$argon2id$v=19$...',
      config: { api_key: 'chave-secreta', webhook_token: 'token-secreto', ambiente: 'sandbox' },
      lista: [{ csc_token: 'segredo', nome: 'ok' }],
      certificado: { pfx_base64: 'MIIK-conteudo', validade: '2027-01-01' },
    }) as Record<string, unknown>;

    const texto = JSON.stringify(limpo);
    expect(texto).not.toContain('argon2id');
    expect(texto).not.toContain('chave-secreta');
    expect(texto).not.toContain('token-secreto');
    expect(texto).not.toContain('MIIK-conteudo');
    // O que não é segredo continua indo: a central precisa do dado de negócio.
    expect(limpo.email).toBe('ana@exemplo.com');
    expect((limpo.config as Record<string, unknown>).ambiente).toBe('sandbox');
  });

  it('a senha não chega à fila nem por descuido de quem chamou', () => {
    withTransaction(() => {
      recordDomainEvent({
        eventType: 'customer.upserted',
        aggregateType: 'customer',
        aggregateId: 'c-1',
        companyId: gringa,
        payload: { id: 'c-1', name: 'Ana', password_hash: '$argon2id$abc' },
      });
    });

    expect(fila()[0].payload).not.toContain('argon2id');
  });

  it('agregado que só guarda segredo não é sincronizável de forma alguma', () => {
    withTransaction(() => {
      const id = recordDomainEvent({
        eventType: 'customer.upserted',
        aggregateType: 'certificate' as never,
        aggregateId: 'cert-1',
        companyId: gringa,
        payload: { id: 'cert-1' },
      });
      expect(id).toBeNull();
    });

    expect(fila()).toHaveLength(0);
  });

  it('documento fiscal sobe SEM xml — a assinatura fica no nó', () => {
    withTransaction(() => {
      recordDomainEvent({
        eventType: 'fiscal.document_issued',
        aggregateType: 'fiscal_document',
        aggregateId: 'doc-1',
        companyId: gringa,
        payload: {
          id: 'doc-1',
          model: '65',
          access_key: '4325'.padEnd(44, '0'),
          status: 'authorized',
          xml: '<nfeProc>assinado</nfeProc>',
        },
      });
    });

    const payload = fila()[0].payload;
    expect(payload).toContain('access_key');
    // `xml` carrega assinatura e não acrescenta nada ao consolidado.
    expect(payload).not.toContain('nfeProc');
  });
});
