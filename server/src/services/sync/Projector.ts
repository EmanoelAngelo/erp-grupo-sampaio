/**
 * Projeção: do fato bruto para as tabelas de negócio da central.
 *
 * A tabela de aterrissagem guarda o evento como ele saiu do nó. Consultar
 * relatório em cima dela seria reprocessar milhões de JSON a cada pergunta —
 * por isso existe a projeção. E a ordem importa: RECEBER e PROJETAR são
 * falhas separadas de propósito. Se uma projeção estiver errada, o fato já
 * está salvo e a projeção pode ser refeita; fosse direto para a tabela final,
 * um erro de projeção significaria fato perdido.
 *
 * DUAS GARANTIAS
 *
 * 1. IDEMPOTÊNCIA — a projeção é UPSERT pela chave do próprio fato. Reprocessar
 *    a fila inteira do zero não duplica nada, e é isso que torna o "replay"
 *    uma operação de rotina em vez de um risco.
 *
 * 2. ORDEM — a rede não entrega em ordem, e um evento antigo chegando depois
 *    NÃO pode sobrescrever estado novo. Cada linha projetada carrega
 *    `node_seq`, e a gravação só acontece quando o evento é mais recente que o
 *    que já está lá. Sem isso, um "pedido criado" atrasado reverteria um
 *    "pedido entregue" — e o cliente veria o pedido voltar no tempo.
 *
 * O projetor NÃO fica no frontend. Ele é lógica de consolidação do grupo, com
 * acesso de escrita à central; no navegador seria acessível a quem abrisse o
 * DevTools.
 */
import type { OutboxRow } from './OutboxService.js';

export interface Projection {
  table: string;
  /** Colunas que identificam a linha no destino. */
  key: Record<string, unknown>;
  row: Record<string, unknown>;
  /**
   * `true` → só grava se for mais novo que o que está lá (estado atual).
   * `false` → linha imutável de histórico; grava uma vez e pronto.
   */
  guardByOrder: boolean;
}

function payloadDe(evento: OutboxRow): Record<string, unknown> {
  try {
    return JSON.parse(evento.payload) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const num = (v: unknown): number | null =>
  v === null || v === undefined || v === '' ? null : Number(v);
const txt = (v: unknown): string | null =>
  v === null || v === undefined ? null : String(v);
const bool = (v: unknown): boolean | null =>
  v === null || v === undefined ? null : Boolean(Number(v) || v === true);

/** Colunas de proveniência, iguais em toda linha projetada. */
function proveniencia(e: OutboxRow) {
  return { occurred_at: e.occurred_at, node_seq: e.seq };
}

/**
 * Traduz um evento nas linhas que ele produz na central.
 *
 * Um evento pode virar mais de uma linha — uma venda produz o cabeçalho e os
 * itens. Evento desconhecido devolve lista vazia: um nó mais novo enviando um
 * tipo que esta central ainda não entende NÃO pode derrubar a projeção do
 * resto. O fato continua na aterrissagem, esperando a central ser atualizada.
 */
export function project(evento: OutboxRow): Projection[] {
  const p = payloadDe(evento);
  const prov = proveniencia(evento);
  const empresa = evento.company_id;

  switch (evento.event_type) {
    case 'company.upserted':
      return [
        {
          table: 'erp_companies',
          key: { id: evento.aggregate_id },
          row: {
            id: evento.aggregate_id,
            slug: txt(p.slug),
            trade_name: txt(p.trade_name),
            legal_name: txt(p.legal_name),
            kind: txt(p.kind),
            active: bool(p.active) ?? true,
            node_id: evento.node_id,
            ...prov,
          },
          guardByOrder: true,
        },
      ];

    case 'product.upserted':
    case 'product.deactivated':
      return [
        {
          table: 'erp_products',
          key: { id: evento.aggregate_id },
          row: {
            id: evento.aggregate_id,
            company_id: empresa,
            internal_code: txt(p.internal_code),
            name: txt(p.name),
            unit: txt(p.unit),
            category: txt(p.category),
            subcategory: txt(p.subcategory),
            brand: txt(p.brand),
            cost_cents: num(p.cost_cents),
            price_cents: num(p.price_cents),
            parent_id: txt(p.parent_id),
            active: bool(p.active) ?? true,
            publish_online: bool(p.publish_online) ?? false,
            weight_grams: num(p.weight_grams),
            height_cm: num(p.height_cm),
            width_cm: num(p.width_cm),
            length_cm: num(p.length_cm),
            // Tombstone, não DELETE: produto que já saiu em venda antiga
            // precisa continuar existindo para a nota fazer sentido.
            deactivated_at:
              evento.event_type === 'product.deactivated' ? evento.occurred_at : null,
            ...prov,
          },
          guardByOrder: true,
        },
      ];

    case 'product_variant.upserted':
      return [
        {
          table: 'erp_product_variants',
          key: { id: evento.aggregate_id },
          row: {
            id: evento.aggregate_id,
            company_id: empresa,
            parent_id: txt(p.parent_id),
            name: txt(p.name),
            barcode: txt(p.barcode),
            attributes: p.variant_attributes ?? p.attributes ?? null,
            price_cents: num(p.price_cents),
            active: bool(p.active) ?? true,
            ...prov,
          },
          guardByOrder: true,
        },
      ];

    case 'customer.upserted':
      return [
        {
          table: 'erp_customers',
          key: { id: evento.aggregate_id },
          row: {
            id: evento.aggregate_id,
            company_id: empresa,
            name: txt(p.name),
            document: txt(p.document),
            email: txt(p.email),
            phone: txt(p.phone),
            ...prov,
          },
          guardByOrder: true,
        },
      ];

    case 'inventory.moved': {
      const linhas: Projection[] = [
        {
          table: 'erp_inventory_ledger',
          key: { id: evento.aggregate_id },
          // Razão é IMUTÁVEL: um movimento não muda depois de acontecer.
          guardByOrder: false,
          row: {
            id: evento.aggregate_id,
            company_id: empresa,
            product_id: txt(p.product_id),
            movement_type: txt(p.movement_type),
            quantity: num(p.quantity),
            quantity_before: num(p.quantity_before),
            balance_after: num(p.balance_after),
            reference_type: txt(p.reference_type),
            reference_id: txt(p.reference_id),
            document_number: txt(p.document_number),
            unit_cost_cents: num(p.unit_cost_cents),
            operational_unit_id: evento.operational_unit_id,
            ...prov,
          },
        },
      ];

      // O saldo consolidado é derivado, e por isso protegido por ordem: um
      // movimento antigo chegando atrasado não pode reescrever o saldo atual.
      if (p.balance_after !== undefined && p.balance_after !== null) {
        linhas.push({
          table: 'erp_inventory_snapshots',
          key: { company_id: empresa, product_id: txt(p.product_id) },
          guardByOrder: true,
          row: {
            company_id: empresa,
            product_id: txt(p.product_id),
            quantity: num(p.balance_after),
            ...prov,
          },
        });
      }
      return linhas;
    }

    case 'inventory.reserved':
    case 'inventory.reservation_released':
      return [
        {
          table: 'erp_inventory_reservations',
          key: { id: evento.aggregate_id },
          guardByOrder: false,
          row: {
            id: evento.aggregate_id,
            company_id: empresa,
            product_id: txt(p.product_id),
            reserved_delta: num(p.reserved_delta),
            reserved_before: num(p.reserved_before),
            reserved_after: num(p.reserved_after),
            kind: txt(p.kind),
            reference_type: txt(p.reference_type),
            reference_id: txt(p.reference_id),
            ...prov,
          },
        },
      ];

    case 'sale.registered':
    case 'sale.cancelled': {
      const itens = Array.isArray(p.items) ? (p.items as Record<string, unknown>[]) : [];
      const linhas: Projection[] = [
        {
          table: 'erp_sales',
          key: { id: evento.aggregate_id },
          guardByOrder: true,
          row: {
            id: evento.aggregate_id,
            company_id: empresa,
            number: num(p.number),
            customer_id: txt(p.customer_id),
            seller_id: txt(p.seller_id),
            status: txt(p.status) ?? 'completed',
            subtotal_cents: num(p.subtotal_cents),
            discount_cents: num(p.discount_cents),
            surcharge_cents: num(p.surcharge_cents),
            total_cents: num(p.total_cents),
            change_cents: num(p.change_cents),
            origin: txt(p.origin),
            ...prov,
          },
        },
      ];

      itens.forEach((item, i) => {
        linhas.push({
          table: 'erp_sale_items',
          key: { sale_id: evento.aggregate_id, line_number: i + 1 },
          guardByOrder: false,
          row: {
            sale_id: evento.aggregate_id,
            line_number: i + 1,
            product_id: txt(item.product_id),
            description: txt(item.description),
            quantity: num(item.quantity),
            unit_price_cents: num(item.unit_price_cents),
            discount_cents: num(item.discount_cents),
            total_cents: num(item.total_cents),
          },
        });
      });
      return linhas;
    }

    case 'payment.registered':
    case 'payment.status_changed':
      return [
        {
          table: 'erp_payments',
          key: { id: evento.aggregate_id },
          guardByOrder: true,
          row: {
            id: evento.aggregate_id,
            company_id: empresa,
            origin_type: txt(p.origin_type),
            origin_id: txt(p.origin_id),
            method: txt(p.method),
            provider: txt(p.provider),
            amount_cents: num(p.amount_cents),
            status: txt(p.status),
            environment: txt(p.environment),
            ...prov,
          },
        },
      ];

    case 'finance.entry_recorded':
    case 'finance.entry_settled':
      return [
        {
          table: 'erp_finance_entries',
          key: { id: evento.aggregate_id },
          guardByOrder: true,
          row: {
            id: evento.aggregate_id,
            company_id: empresa,
            direction: txt(p.direction),
            amount_cents: num(p.amount_cents),
            settled_cents: num(p.settled_cents) ?? 0,
            status: txt(p.status),
            due_date: txt(p.due_date),
            settled_at: txt(p.settled_at),
            customer_id: txt(p.customer_id),
            supplier_id: txt(p.supplier_id),
            description: txt(p.description),
            origin_type: txt(p.origin_type),
            origin_id: txt(p.origin_id),
            ...prov,
          },
        },
      ];

    case 'order.placed':
      return [
        {
          table: 'erp_orders',
          key: { id: evento.aggregate_id },
          guardByOrder: true,
          row: {
            id: evento.aggregate_id,
            company_id: empresa,
            number: num(p.number),
            customer_id: txt(p.customer_id),
            customer_name: txt(p.customer_name),
            status: txt(p.status) ?? 'aguardando_pagamento',
            items_cents: num(p.items_cents),
            shipping_cents: num(p.shipping_cents),
            total_cents: num(p.total_cents),
            payment_method: txt(p.payment_method),
            delivery_method: txt(p.shipping_method) ?? 'entrega',
            tracking_code: txt(p.tracking_code),
            ...prov,
          },
        },
      ];

    case 'order.status_changed': {
      const linhas: Projection[] = [
        {
          table: 'erp_order_status_history',
          key: { id: txt(p.event_id) ?? evento.id },
          guardByOrder: false,
          row: {
            id: txt(p.event_id) ?? evento.id,
            order_id: txt(p.order_id) ?? evento.aggregate_id,
            company_id: empresa,
            status: txt(p.status),
            note: txt(p.note),
            ...prov,
          },
        },
      ];

      /*
        O estado corrente do pedido também acompanha — protegido por ordem,
        senão um "pedido criado" atrasado reverteria um "entregue".

        MAS SÓ QUANDO O PAYLOAD SUSTENTA UM INSERT. A linha com apenas
        {id, company, status} funciona no UPDATE do upsert e explode no
        INSERT: `erp_orders.total_cents` é NOT NULL, e o projetor não tem como
        saber qual dos dois caminhos vai acontecer.

        Não era hipótese. Na reprojeção de 29/08/2026, três eventos reais
        falharam com 23502 exatamente assim: pedidos criados ANTES de a
        outbox existir, sem `order.placed` na central — o upsert caiu no
        INSERT e não tinha total. O fato da mudança (o histórico, acima)
        tem todos os seus dados e vai sempre; o estado-base de um pedido
        legado é papel do `order.placed` e do bootstrap, que leem o pedido
        inteiro. Um estado que não se consegue criar por inteiro não se
        cria pela metade.

        `addOrderEvent` passou a carregar o retrato do pedido no payload,
        então os eventos daqui para a frente entram neste ramo.
      */
      if (p.status && num(p.total_cents) !== null) {
        linhas.push({
          table: 'erp_orders',
          key: { id: txt(p.order_id) ?? evento.aggregate_id },
          guardByOrder: true,
          row: {
            id: txt(p.order_id) ?? evento.aggregate_id,
            company_id: empresa,
            status: txt(p.status),
            number: num(p.number),
            customer_id: txt(p.customer_id),
            customer_name: txt(p.customer_name),
            items_cents: num(p.items_cents),
            shipping_cents: num(p.shipping_cents),
            total_cents: num(p.total_cents),
            payment_method: txt(p.payment_method),
            tracking_code: txt(p.tracking_code),
            ...prov,
          },
        });
      }
      return linhas;
    }

    case 'fiscal.document_issued':
      return [
        {
          table: 'erp_fiscal_documents',
          key: { id: evento.aggregate_id },
          guardByOrder: true,
          row: {
            id: evento.aggregate_id,
            company_id: empresa,
            model: txt(p.model),
            serie: num(p.serie),
            number: num(p.number),
            access_key: txt(p.access_key),
            status: txt(p.status),
            environment: txt(p.environment),
            sale_id: txt(p.sale_id),
            issued_at: txt(p.issued_at),
            ...prov,
          },
        },
      ];

    case 'fiscal.event_recorded':
      return [
        {
          table: 'erp_fiscal_events',
          key: { id: evento.aggregate_id },
          guardByOrder: false,
          row: {
            id: evento.aggregate_id,
            company_id: empresa,
            document_id: txt(p.document_id),
            fiscal_event_type: txt(p.fiscal_event_type),
            sequence: num(p.sequence),
            protocol: txt(p.protocol),
            c_stat: txt(p.c_stat),
            x_motivo: txt(p.x_motivo),
            model: txt(p.model),
            serie: num(p.serie),
            number_from: num(p.number_from),
            number_to: num(p.number_to),
            ...prov,
          },
        },
      ];

    case 'service_order.opened':
    case 'service_order.status_changed':
      return [
        {
          table: 'erp_service_orders',
          key: { id: evento.aggregate_id },
          guardByOrder: true,
          row: {
            id: evento.aggregate_id,
            company_id: empresa,
            operational_unit_id: evento.operational_unit_id,
            number: num(p.number),
            customer_id: txt(p.customer_id),
            customer_name: txt(p.customer_name),
            equipment_id: txt(p.equipment_id),
            status: txt(p.status),
            labor_cents: num(p.labor_cents),
            parts_cents: num(p.parts_cents),
            total_cents: num(p.total_cents),
            ...prov,
          },
        },
      ];

    case 'equipment.upserted':
      return [
        {
          table: 'erp_equipment',
          key: { id: evento.aggregate_id },
          guardByOrder: true,
          row: {
            id: evento.aggregate_id,
            company_id: empresa,
            operational_unit_id: evento.operational_unit_id,
            public_id: num(p.public_id),
            origin: txt(p.origin),
            category: txt(p.category),
            brand: txt(p.brand),
            model: txt(p.model),
            serial_number: txt(p.serial_number),
            owner_customer_id: txt(p.owner_customer_id),
            status: txt(p.status),
            ...prov,
          },
        },
      ];

    default:
      // Tipo que esta central ainda não entende. O fato fica na aterrissagem
      // e será projetado quando a central for atualizada — nunca descartado.
      return [];
  }
}

/**
 * Central em memória, com a MESMA semântica do Postgres: upsert por chave e
 * guarda de ordem. Serve aos testes e ao `bootstrap --dry-run`, e é o que
 * permite provar idempotência e ordenação sem credencial real.
 */
export class InMemoryCentral {
  private readonly tabelas = new Map<string, Map<string, Record<string, unknown>>>();

  private chaveTexto(key: Record<string, unknown>): string {
    return Object.keys(key)
      .sort()
      .map((k) => `${k}=${String(key[k])}`)
      .join('|');
  }

  apply(projections: Projection[]): { written: number; skippedByOrder: number } {
    let written = 0;
    let skippedByOrder = 0;

    for (const proj of projections) {
      if (!this.tabelas.has(proj.table)) this.tabelas.set(proj.table, new Map());
      const tabela = this.tabelas.get(proj.table)!;
      const k = this.chaveTexto(proj.key);
      const atual = tabela.get(k);

      if (atual && proj.guardByOrder) {
        const seqAtual = Number(atual.node_seq ?? -1);
        const seqNovo = Number(proj.row.node_seq ?? -1);
        // Evento antigo NÃO sobrescreve estado novo.
        if (seqNovo < seqAtual) {
          skippedByOrder += 1;
          continue;
        }
      }

      // Upsert: reprocessar o mesmo evento mil vezes deixa uma linha só.
      tabela.set(k, { ...(atual ?? {}), ...proj.row });
      written += 1;
    }

    return { written, skippedByOrder };
  }

  rows(table: string): Record<string, unknown>[] {
    return [...(this.tabelas.get(table)?.values() ?? [])];
  }

  count(table: string): number {
    return this.tabelas.get(table)?.size ?? 0;
  }

  tables(): string[] {
    return [...this.tabelas.keys()];
  }
}

/**
 * Quem recebe as linhas projetadas.
 *
 * `InMemoryCentral` é uma implementação; a Supabase é outra. A interface existe
 * para que a MESMA função de projeção sirva às duas — se o caminho de produção
 * usasse outro código, os testes provariam a idempotência de um projetor que
 * ninguém usa.
 */
export interface CentralWriter {
  apply(projections: Projection[]): { written: number; skippedByOrder: number };
}

/** Projeta um lote inteiro. Ordena por `seq` antes — a ordem é do nó. */
export function projectBatch(
  eventos: OutboxRow[],
  central: CentralWriter,
): { written: number; skippedByOrder: number; unknownEvents: number } {
  let written = 0;
  let skippedByOrder = 0;
  let unknownEvents = 0;

  for (const evento of [...eventos].sort((a, b) => a.seq - b.seq)) {
    const projections = project(evento);
    if (projections.length === 0) {
      unknownEvents += 1;
      continue;
    }
    const r = central.apply(projections);
    written += r.written;
    skippedByOrder += r.skippedByOrder;
  }

  return { written, skippedByOrder, unknownEvents };
}
