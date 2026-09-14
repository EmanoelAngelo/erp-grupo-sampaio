/**
 * Carga inicial da central a partir do nó local.
 *
 * A fila de saída só carrega o que aconteceu DEPOIS que ela passou a existir.
 * Todo o histórico anterior — produtos, clientes, vendas, notas — está no
 * SQLite e não subiria nunca. Este serviço leva esse passado para a central.
 *
 * COMO ELE NÃO DUPLICA
 *
 * O evento de bootstrap tem id DERIVADO do fato (`bootstrap:<agregado>:<id>`),
 * não aleatório. Rodar o bootstrap dez vezes produz os mesmos ids, e a central
 * faz upsert por id — dez execuções, uma linha. É a mesma propriedade que
 * torna o reenvio inofensivo, aplicada à carga inicial.
 *
 * CHECKPOINT
 *
 * Uma carga de milhares de linhas cai no meio: energia, rede, o processo
 * morre. O checkpoint guarda o último agregado e o último id processados, e o
 * reinício continua de onde parou em vez de recomeçar do zero. Como os ids são
 * derivados, mesmo um reinício que reprocesse não estraga nada — o checkpoint
 * é economia de tempo, não a garantia de corretude.
 *
 * O QUE ELE NUNCA FAZ
 *
 * Não altera o SQLite. A carga é de leitura; o banco operacional é a fonte, e
 * mexer nele para "fazer bater" com a central inverteria quem é a autoridade.
 */
import { createHash } from 'node:crypto';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { nodeId, redigirPayload } from './OutboxService.js';
import { EVENT_SCHEMA_VERSION, type AggregateType, type EventType } from './DomainEvents.js';
import { marcarBootstrapConcluido, setMeta } from './SyncService.js';

const META_CHECKPOINT = 'central_bootstrap_checkpoint';

/**
 * O que sobe na carga inicial, na ordem em que precisa subir.
 *
 * Empresa antes de produto, produto antes de venda: a central tem chaves
 * estrangeiras, e mandar o filho antes do pai faz o INSERT ser recusado.
 */
interface FonteBootstrap {
  aggregate: AggregateType;
  eventType: EventType;
  table: string;
  /** Colunas lidas. `id` e `company_id` são obrigatórias. */
  sql: string;
}

const FONTES: FonteBootstrap[] = [
  {
    aggregate: 'company',
    eventType: 'company.upserted',
    table: 'core_companies',
    sql: `SELECT id, id AS company_id, slug, trade_name, legal_name, kind, active
            FROM core_companies ORDER BY id`,
  },
  {
    aggregate: 'product',
    eventType: 'product.upserted',
    table: 'core_products',
    sql: `SELECT id, company_id, internal_code, name, unit, category, subcategory, brand,
                 cost_cents, price_cents, parent_id, active, publish_online,
                 weight_grams, height_cm, width_cm, length_cm
            FROM core_products ORDER BY id`,
  },
  {
    aggregate: 'customer',
    eventType: 'customer.upserted',
    table: 'core_customers',
    sql: `SELECT id, company_id, name, document, email, phone
            FROM core_customers ORDER BY id`,
  },
  {
    aggregate: 'sale',
    eventType: 'sale.registered',
    table: 'core_sales',
    sql: `SELECT id, company_id, number, customer_id, seller_id, status, subtotal_cents,
                 discount_cents, surcharge_cents, total_cents, change_cents, origin, created_at
            FROM core_sales ORDER BY id`,
  },
  {
    aggregate: 'finance_entry',
    eventType: 'finance.entry_recorded',
    table: 'core_finance_entries',
    sql: `SELECT id, company_id, direction, amount_cents, settled_cents, status, due_date,
                 settled_at, customer_id, supplier_id, description, origin_type, origin_id, created_at
            FROM core_finance_entries ORDER BY id`,
  },
  {
    aggregate: 'ecommerce_order',
    eventType: 'order.placed',
    table: 'core_orders',
    sql: `SELECT id, company_id, number, customer_id, customer_name, status, items_cents,
                 shipping_cents, total_cents, payment_method, shipping_method, tracking_code, created_at
            FROM core_orders ORDER BY id`,
  },
  {
    aggregate: 'inventory_movement',
    eventType: 'inventory.moved',
    table: 'core_stock_movements',
    sql: `SELECT id, company_id, product_id, movement_type, quantity, quantity_before,
                 balance_after, reference_type, reference_id, document_number,
                 unit_cost_cents, workshop_id, created_at
            FROM core_stock_movements ORDER BY created_at, id`,
    /*
      ORDER BY created_at, e nao por id: o snapshot de estoque guarda o
      balance_after do movimento de MAIOR seq, e o seq nasce na ordem de
      enfileiramento. Em ordem de id (UUID), o ultimo seria um movimento
      QUALQUER da historia — e o saldo consolidado da central regrediria para
      um saldo antigo, calado. O id desempata created_at igual.
    */
  },
  {
    aggregate: 'fiscal_document',
    eventType: 'fiscal.document_issued',
    table: 'core_fiscal_documents',
    sql: `SELECT id, company_id, model, serie, number, access_key, status, environment,
                 sale_id, issued_at
            FROM core_fiscal_documents ORDER BY id`,
  },
  {
    aggregate: 'service_order',
    eventType: 'service_order.opened',
    table: 'core_service_orders',
    sql: `SELECT id, company_id, workshop_id, number, customer_id, customer_name,
                 equipment_id, status, labor_cents, parts_cents, total_cents, created_at
            FROM core_service_orders ORDER BY id`,
  },
  {
    aggregate: 'equipment',
    eventType: 'equipment.upserted',
    table: 'core_equipment',
    // `status` e o campo que o projetor le (e o que os eventos vivos levam,
    // via SELECT *). So `sale_status` deixaria o status nulo vencer o vivo.
    sql: `SELECT id, company_id, workshop_id, public_id, origin, category, brand, model,
                 serial_number, owner_customer_id, status, sale_status, created_at
            FROM core_equipment ORDER BY id`,
  },
];

export interface BootstrapCheckpoint {
  aggregate: string;
  lastId: string;
  enqueued: number;
  startedAt: string;
}

function lerCheckpoint(): BootstrapCheckpoint | null {
  ensureCoreSchema();
  const db = getConnection();
  db.exec('CREATE TABLE IF NOT EXISTS core_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
  const linha = db.prepare('SELECT value FROM core_meta WHERE key = ?').get(META_CHECKPOINT) as
    | { value?: string }
    | undefined;
  if (!linha?.value) return null;
  try {
    return JSON.parse(linha.value) as BootstrapCheckpoint;
  } catch {
    return null;
  }
}

function gravarCheckpoint(cp: BootstrapCheckpoint): void {
  setMeta(META_CHECKPOINT, JSON.stringify(cp));
}

export function limparCheckpoint(): void {
  setMeta(META_CHECKPOINT, '');
}

/**
 * Id determinístico do evento de carga inicial — e um uuid DE VERDADE.
 *
 * É o coração da idempotência do bootstrap: o mesmo fato produz sempre o mesmo
 * id, e a central faz upsert por id. Não usa `randomUUID` de propósito.
 *
 * ## Por que não é mais o texto `bootstrap:<agregado>:<id>`
 *
 * Porque `erp_sync_events.id` é `uuid primary key`. Na primeira Carga inicial
 * real (30/08/2026) a central recusou o lote INTEIRO com 22P02 — invalid input
 * syntax for type uuid — e os 81 fatos do histórico ficaram em retry queimando
 * tentativas. Os testes não viram porque as centrais de mentira aceitam
 * qualquer string; o tipo uuid só existe no Postgres de verdade.
 *
 * A derivação continua a mesma em espírito: sha256 do nome
 * `bootstrap:<agregado>:<id>`, com os bits de versão (8, RFC 9562) e variante
 * postos sobre o hash. Determinístico, sem colisão entre agregados — e cabe na
 * coluna. A identidade da ENTIDADE nunca esteve aqui: ela é o aggregate_id,
 * que sempre foi o uuid real da linha local.
 */
export function bootstrapEventId(aggregate: string, id: string): string {
  const hash = createHash('sha256')
    .update(`bootstrap:${aggregate}:${id}`)
    .digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  // Versão 8 (RFC 9562, "custom"): uuid derivado, não sorteado.
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

export interface BootstrapResult {
  enqueued: number;
  skipped: number;
  byAggregate: Record<string, number>;
  resumedFrom: string | null;
  completed: boolean;
}

/**
 * Enfileira o histórico do nó.
 *
 * Grava em lotes com transação própria: uma transação única sobre dezenas de
 * milhares de linhas seguraria o write lock do SQLite e travaria o PDV
 * enquanto durasse.
 */
export function bootstrapCentralFromLocal(options?: {
  batchSize?: number;
  resume?: boolean;
}): BootstrapResult {
  ensureCoreSchema();
  const db = getConnection();
  const lote = options?.batchSize ?? 200;
  const checkpoint = options?.resume === false ? null : lerCheckpoint();

  const byAggregate: Record<string, number> = {};
  let enqueued = 0;
  let skipped = 0;
  let alcancouRetomada = !checkpoint;

  const agora = new Date().toISOString();
  const no = nodeId();

  for (const fonte of FONTES) {
    // Retomada: pula as fontes já concluídas antes do ponto de parada.
    if (!alcancouRetomada && checkpoint && checkpoint.aggregate !== fonte.aggregate) {
      const indiceAtual = FONTES.findIndex((f) => f.aggregate === fonte.aggregate);
      const indiceCheckpoint = FONTES.findIndex((f) => f.aggregate === checkpoint.aggregate);
      if (indiceAtual < indiceCheckpoint) {
        skipped += Number(
          (db.prepare(`SELECT COUNT(*) c FROM ${fonte.table}`).get() as { c: number }).c,
        );
        continue;
      }
      alcancouRetomada = true;
    }

    const linhas = db.prepare(fonte.sql).all() as unknown as Record<string, unknown>[];
    let pendentes: Record<string, unknown>[] = [];

    const gravarLote = () => {
      if (pendentes.length === 0) return;
      const paraGravar = pendentes;
      pendentes = [];
      withTransaction(() => {
        const stmt = db.prepare(
          `INSERT INTO core_outbox
             (id, node_id, event_type, aggregate_type, aggregate_id, company_id,
              operational_unit_id, operation, schema_version, payload, occurred_at,
              status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'insert', ?, ?, ?, 'pending', ?)
           ON CONFLICT(id) DO NOTHING`,
        );
        for (const linha of paraGravar) {
          const id = String(linha.id);
          stmt.run(
            bootstrapEventId(fonte.aggregate, id),
            no,
            fonte.eventType,
            fonte.aggregate,
            id,
            String(linha.company_id ?? ''),
            (linha.workshop_id as string | null) ?? null,
            EVENT_SCHEMA_VERSION,
            JSON.stringify(redigirPayload(linha)),
            String(linha.created_at ?? linha.issued_at ?? agora),
            agora,
          );
        }
      });
    };

    for (const linha of linhas) {
      const id = String(linha.id);

      // Retomada dentro da fonte interrompida.
      if (!alcancouRetomada && checkpoint && checkpoint.aggregate === fonte.aggregate) {
        skipped += 1;
        if (id === checkpoint.lastId) alcancouRetomada = true;
        continue;
      }

      pendentes.push(linha);
      enqueued += 1;
      byAggregate[fonte.aggregate] = (byAggregate[fonte.aggregate] ?? 0) + 1;

      if (pendentes.length >= lote) {
        gravarLote();
        gravarCheckpoint({
          aggregate: fonte.aggregate,
          lastId: id,
          enqueued,
          startedAt: checkpoint?.startedAt ?? agora,
        });
      }
    }

    gravarLote();
    if (linhas.length > 0) {
      gravarCheckpoint({
        aggregate: fonte.aggregate,
        lastId: String(linhas[linhas.length - 1].id),
        enqueued,
        startedAt: checkpoint?.startedAt ?? agora,
      });
    }
    alcancouRetomada = true;
  }

  limparCheckpoint();
  marcarBootstrapConcluido();

  return {
    enqueued,
    skipped,
    byAggregate,
    resumedFrom: checkpoint?.aggregate ?? null,
    completed: true,
  };
}

// ------------------------------------------------------- comparação

export interface ComparisonLine {
  domain: string;
  localCount: number;
  centralCount: number;
  verdict: 'MATCH' | 'MISMATCH';
}

/**
 * Compara o nó com a central, por domínio.
 *
 * Só COMPARA. Nunca escreve nos dois lados — durante a primeira carga a
 * central é quem está recebendo, e "corrigir" o banco operacional para fazer
 * bater inverteria quem é a autoridade e poderia apagar fato real.
 */
export function compareLocalWithCentral(
  contarNaCentral: (tabela: string) => number,
): { lines: ComparisonLine[]; verdict: 'MATCH' | 'MISMATCH' } {
  ensureCoreSchema();
  const db = getConnection();

  const pares: { domain: string; local: string; central: string }[] = [
    { domain: 'companies', local: 'core_companies', central: 'erp_companies' },
    { domain: 'products', local: 'core_products', central: 'erp_products' },
    { domain: 'customers', local: 'core_customers', central: 'erp_customers' },
    { domain: 'inventory', local: 'core_stock_movements', central: 'erp_inventory_ledger' },
    { domain: 'sales', local: 'core_sales', central: 'erp_sales' },
    { domain: 'orders', local: 'core_orders', central: 'erp_orders' },
    { domain: 'finance', local: 'core_finance_entries', central: 'erp_finance_entries' },
    { domain: 'fiscal', local: 'core_fiscal_documents', central: 'erp_fiscal_documents' },
    { domain: 'workshop', local: 'core_service_orders', central: 'erp_service_orders' },
  ];

  const lines = pares.map(({ domain, local, central }) => {
    let localCount: number;
    try {
      localCount = Number((db.prepare(`SELECT COUNT(*) c FROM ${local}`).get() as { c: number }).c);
    } catch {
      // Tabela que ainda não existe neste banco conta como zero: a conferência
      // não pode quebrar por causa de um domínio ainda não migrado.
      localCount = 0;
    }
    const centralCount = contarNaCentral(central);
    return {
      domain,
      localCount,
      centralCount,
      verdict: localCount === centralCount ? ('MATCH' as const) : ('MISMATCH' as const),
    };
  });

  return {
    lines,
    verdict: lines.every((l) => l.verdict === 'MATCH') ? 'MATCH' : 'MISMATCH',
  };
}
