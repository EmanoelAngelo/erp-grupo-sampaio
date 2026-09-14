/**
 * A agenda do rastreio (GAP-PRD-119).
 *
 * Os envios comprados pelo Melhor Envio que ainda estão a caminho são
 * consultados sozinhos, de tempos em tempos, no backend — sem depender de
 * alguém abrir a ficha do pedido. É ela que faz o pedido virar "expedido"
 * quando a transportadora registra a postagem, e "entregue" quando confirma a
 * entrega, com origem "provedor".
 *
 * Mesmo molde das outras agendas (`OrderReservationExpiry`): liga sempre, e
 * sem envio a caminho a batida é uma consulta vazia ao banco. Uma falha do
 * provedor vira linha de log E fica gravada no envio (`last_sync_*`), onde o
 * ERP e o portal a mostram.
 */
import { loadEnv } from '../../config/env.js';
import { logInfo } from '../../utils/errors.js';
import { sincronizarEnviosPendentes } from './EnvioDoPedidoService.js';

let timer: ReturnType<typeof setInterval> | null = null;
let rodando = false;

async function rodar(): Promise<void> {
  // Uma rodada lenta (provedor fora do ar, 20 s por lote) não pode empilhar
  // outra por cima.
  if (rodando) return;
  rodando = true;
  try {
    const r = await sincronizarEnviosPendentes();
    if (r.ok + r.falhas > 0) logInfo('LOGISTICS_TRACKING_SYNC', r);
  } catch (err) {
    console.warn(`[rastreio] rodada falhou: ${(err as Error).message}`);
  } finally {
    rodando = false;
  }
}

export function startRastreioAgendado(): void {
  if (timer) return;
  const minutos = loadEnv().LOGISTICS_TRACKING_SYNC_MINUTES;
  if (!minutos) {
    logInfo('LOGISTICS_TRACKING_SYNC_DISABLED', { motivo: 'LOGISTICS_TRACKING_SYNC_MINUTES=0' });
    return;
  }
  void rodar();
  timer = setInterval(() => void rodar(), minutos * 60_000);
  timer.unref();
}

export function stopRastreioAgendado(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
