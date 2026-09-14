/**
 * Catálogo dos fatos que sobem para a central, e o padrão único de registro.
 *
 * POR QUE UM CATÁLOGO, E NÃO `enqueue` SOLTO EM CADA WRITER
 *
 * Espalhar a chamada por dezenas de escritores produz três problemas que só
 * aparecem tarde: o nome do evento vira digitação livre (`sale_created`,
 * `SALE_CREATED`, `venda_criada` para o mesmo fato); a central recebe
 * agregados que ninguém sabe de onde vieram; e não existe lugar para
 * responder "quais fatos são sincronizados?".
 *
 * Aqui o conjunto é fechado e tipado. Um evento novo entra por este arquivo,
 * onde também mora a decisão sobre o que ele carrega.
 *
 * `recordDomainEvent` é a ÚNICA porta. Ela exige transação — ver `enqueue` —
 * porque o fato e o evento precisam existir ou desaparecer juntos.
 */
import { enqueue } from './OutboxService.js';

/**
 * Versão do envelope. Sobe quando o formato do payload mudar de forma que a
 * central precise saber. Evento antigo na fila continua legível pelo número
 * que carrega.
 */
export const EVENT_SCHEMA_VERSION = 1;

/**
 * Agregados sincronizados.
 *
 * "Agregado" e não "tabela": o que sobe é fato de negócio. A central tem
 * schema próprio e não é uma cópia do SQLite.
 */
export const AGGREGATES = [
  'company',
  'product',
  'product_variant',
  'customer',
  'inventory_movement',
  'inventory_reservation',
  'sale',
  'payment',
  'finance_entry',
  'ecommerce_order',
  'fiscal_document',
  'fiscal_event',
  'service_order',
  'equipment',
] as const;

export type AggregateType = (typeof AGGREGATES)[number];

/**
 * Tipos de evento.
 *
 * O nome diz o FATO, no passado — não a operação de banco. `sale.registered`
 * sobrevive a uma mudança de implementação; `core_sales.insert` não.
 */
export const EVENT_TYPES = [
  'company.upserted',
  'product.upserted',
  'product.deactivated',
  'product_variant.upserted',
  'customer.upserted',
  'inventory.moved',
  'inventory.reserved',
  'inventory.reservation_released',
  'sale.registered',
  'sale.cancelled',
  'payment.registered',
  'payment.status_changed',
  'finance.entry_recorded',
  'finance.entry_settled',
  'order.placed',
  'order.status_changed',
  'fiscal.document_issued',
  'fiscal.event_recorded',
  'service_order.opened',
  'service_order.status_changed',
  'equipment.upserted',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export interface DomainEventInput {
  eventType: EventType;
  aggregateType: AggregateType;
  aggregateId: string;
  companyId: string;
  /** Oficina, quando o fato pertence a uma. Duas oficinas não são duas empresas. */
  operationalUnitId?: string | null;
  operation?: 'insert' | 'update' | 'delete';
  payload: Record<string, unknown>;
  occurredAt?: string;
}

/**
 * Registra um fato para a central.
 *
 * DEVE ser chamada dentro da transação que grava o fato. Chamada fora, lança —
 * ver `OutboxService.enqueue`. Devolve o id do evento, ou `null` quando o
 * agregado não é sincronizável.
 */
export function recordDomainEvent(input: DomainEventInput): string | null {
  return enqueue({
    eventType: input.eventType,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    companyId: input.companyId,
    operationalUnitId: input.operationalUnitId ?? null,
    operation: input.operation ?? 'insert',
    schemaVersion: EVENT_SCHEMA_VERSION,
    payload: input.payload,
    occurredAt: input.occurredAt,
  });
}
