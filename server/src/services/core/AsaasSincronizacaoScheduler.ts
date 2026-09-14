/**
 * A PASSADA AUTOMÁTICA DA SINCRONIZAÇÃO COM O ASAAS (GAP-PRD-016).
 *
 * O botão da conciliação resolve quando alguém lembra de apertar. O webhook
 * perdido é justamente o caso em que ninguém sabe que precisa: por isso a
 * passada roda sozinha — um minuto depois de o servidor subir (ele pode ter
 * passado a noite desligado, que é quando o reenvio do provedor desiste) e a
 * cada `ASAAS_SYNC_INTERVAL_MINUTES` (padrão 30; 0 desliga).
 *
 * Mesmo molde de `OrderReservationExpiry`: o laço é um relógio, não um
 * chamador — a rejeição vira linha de log, nunca derruba o processo — e o
 * timer é `unref` para não segurar o desligamento. Só operação com credencial
 * é consultada; sem nenhuma, a batida custa uma consulta ao banco.
 */
import { loadEnv } from '../../config/env.js';
import { logError, logInfo } from '../../utils/errors.js';
import { sincronizarTodasAsOperacoes } from './AsaasSincronizacao.js';

let primeira: ReturnType<typeof setTimeout> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let rodando = false;

async function passada(): Promise<void> {
  // Uma passada por vez: a anterior pode estar esperando o provedor.
  if (rodando) return;
  rodando = true;
  try {
    const r = await sincronizarTodasAsOperacoes();
    if (r.operacoes > 0) logInfo('asaas_sincronizacao', r);
  } catch (err) {
    logError('asaas_sincronizacao_laco', { err: (err as Error).message });
  } finally {
    rodando = false;
  }
}

/** Liga a passada automática. Devolve o intervalo em minutos (0 = desligada). */
export function startAsaasSync(): number {
  const minutos = loadEnv().ASAAS_SYNC_INTERVAL_MINUTES;
  if (timer || primeira || minutos <= 0) return timer || primeira ? minutos : 0;
  primeira = setTimeout(() => {
    primeira = null;
    void passada();
  }, 60_000);
  primeira.unref();
  timer = setInterval(() => void passada(), minutos * 60_000);
  timer.unref();
  return minutos;
}

export function stopAsaasSync(): void {
  if (primeira) {
    clearTimeout(primeira);
    primeira = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
