/**
 * O rastreio que o CLIENTE vê no portal (GAP-PRD-119).
 *
 * Mora à parte do serviço de envios de propósito: o portal
 * (`CustomerPortalService`) só LÊ, e importar o serviço inteiro puxaria o
 * núcleo do pedido e o catálogo — que já importam o portal — fechando um ciclo
 * de módulos. Aqui só há banco e a tabela pública de transportadoras.
 *
 * Nada aqui chama o provedor: abrir a tela do cliente não consulta ninguém. A
 * tela lê o que a última consulta gravou — e diz quando ela falhou, com o
 * link da transportadora para o cliente ver direto na fonte.
 */
import { getConnection } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import type { EstadoDoEnvio } from './ProvedorDeEnvio.js';
import { linkDeRastreio, nomeDaTransportadora } from './RastreioPublico.js';

export const ROTULO_DO_ENVIO: Record<EstadoDoEnvio, string> = {
  pendente: 'No carrinho do provedor — não paga',
  paga: 'Paga — etiqueta a gerar',
  etiqueta_gerada: 'Etiqueta gerada',
  postado: 'Postado',
  entregue: 'Entregue',
  nao_entregue: 'Não entregue',
  cancelado: 'Cancelado',
};

export interface RastreioDoCliente {
  carrier: string | null;
  carrierName: string | null;
  trackingCode: string | null;
  trackingUrl: string | null;
  status: string | null;
  statusLabel: string | null;
  /** O envio é acompanhado pelo provedor (e não só um código informado no despacho). */
  viaProvedor: boolean;
  lastSyncAt: string | null;
  lastSyncOk: boolean | null;
  /** A falha da última consulta, dita para o cliente. */
  aviso: string | null;
  events: { status: string; description: string; occurredAt: string; origin: string }[];
}

/**
 * O rastreio do pedido. Quem chama já conferiu que o pedido é da pessoa.
 * `null` quando não há o que mostrar (retirada, ou ainda não despachado).
 */
export function rastreioParaCliente(orderId: string): RastreioDoCliente | null {
  ensureCoreSchema();
  const db = getConnection();
  const pedido = db
    .prepare('SELECT shipping_carrier, tracking_code FROM core_orders WHERE id = ?')
    .get(orderId) as { shipping_carrier: string | null; tracking_code: string | null } | undefined;
  if (!pedido) return null;
  const vivo = db
    .prepare(
      `SELECT id, channel, carrier, status, tracking_code, last_sync_at, last_sync_ok
         FROM core_shipments WHERE order_id = ? AND status <> 'cancelado'
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(orderId) as
    | {
      id: string;
      channel: string;
      carrier: string;
      status: EstadoDoEnvio;
      tracking_code: string | null;
      last_sync_at: string | null;
      last_sync_ok: number | null;
    }
    | undefined;
  const carrier = vivo?.carrier ?? pedido.shipping_carrier;
  const codigo = vivo?.tracking_code ?? pedido.tracking_code;
  if (!carrier && !codigo && !vivo) return null;

  const link = linkDeRastreio(carrier, codigo);
  const falhou = Boolean(vivo && vivo.last_sync_at && vivo.last_sync_ok === 0);
  const quando = vivo?.last_sync_at
    ? new Date(vivo.last_sync_at).toLocaleString('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      dateStyle: 'short',
      timeStyle: 'short',
    })
    : null;
  const eventos = vivo
    ? (db
      .prepare(
        `SELECT status, description, occurred_at, origin FROM core_shipment_events
          WHERE shipment_id = ? ORDER BY occurred_at, created_at`,
      )
      .all(vivo.id) as unknown as { status: string; description: string; occurred_at: string; origin: string }[])
    : [];

  return {
    carrier: carrier ?? null,
    carrierName: nomeDaTransportadora(carrier),
    trackingCode: codigo ?? null,
    trackingUrl: link,
    status: vivo?.status ?? null,
    statusLabel: vivo ? (ROTULO_DO_ENVIO[vivo.status] ?? vivo.status) : null,
    viaProvedor: vivo?.channel === 'melhor_envio',
    lastSyncAt: vivo?.last_sync_at ?? null,
    lastSyncOk: vivo?.last_sync_at ? vivo.last_sync_ok === 1 : null,
    aviso: falhou
      ? `Não conseguimos atualizar o rastreio com a transportadora na última consulta${quando ? ` (${quando})` : ''}. `
        + (link ? 'O link abaixo mostra a situação direto na transportadora.' : 'A loja já foi avisada.')
      : null,
    events: eventos.map((e) => ({
      status: e.status,
      description: e.description,
      occurredAt: e.occurred_at,
      origin: e.origin,
    })),
  };
}
