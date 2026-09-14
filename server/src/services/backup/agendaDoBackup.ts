/**
 * ============================================================================
 * A HORA DO DIÁRIO (GAP-PRD-058)
 * ============================================================================
 *
 * O diário rodava ao subir e depois a cada 24 h CONTADAS DO BOOT: quem ligava
 * o servidor às 10h tinha a cópia (e o envio das fotos) todo dia às 10h, no
 * meio do movimento do balcão. Agora a execução diária tem hora de parede,
 * pelo relógio da loja (`America/Sao_Paulo`, o mesmo de `CalendarioOperacional`),
 * e o padrão é 03:00 — a loja fechada e a rede livre.
 *
 * A cópia ao SUBIR continua existindo, pelo motivo de sempre: o servidor pode
 * ter passado dias desligado. Ela só acontece se não houver cópia diária de
 * menos de 20 h (`jaHaBackupDeHoje`).
 *
 * `DEVORA_BACKUP_HORA` escolhe a hora (0 a 23). Vazio = 3. Valor fora disso o
 * boot recusa (`loadEnv`), em vez de cair num horário que ninguém escolheu.
 */
import { loadEnv } from '../../config/env.js';
import { hojeNaLoja, inicioDoDia, somarDias } from '../core/CalendarioOperacional.js';

export const HORA_PADRAO_DO_DIARIO = 3;
const HORA_MS = 60 * 60 * 1000;

/** Interpreta o valor da variável: vazio = padrão; fora de 0..23 = null (inválido). */
export function lerHoraDoDiario(valor: string | undefined | null): number | null {
  const texto = String(valor ?? '').trim();
  if (texto === '') return HORA_PADRAO_DO_DIARIO;
  if (!/^\d{1,2}$/.test(texto)) return null;
  const hora = Number(texto);
  return hora >= 0 && hora <= 23 ? hora : null;
}

/** A hora configurada nesta instalação. O `loadEnv` já recusou valor inválido. */
export function horaDoDiario(): number {
  return lerHoraDoDiario(loadEnv().DEVORA_BACKUP_HORA) ?? HORA_PADRAO_DO_DIARIO;
}

/**
 * O próximo instante em que o relógio da loja marca `hora`:00, estritamente
 * depois de `agora`.
 *
 * Soma horas ao início do dia da loja. O Brasil não tem horário de verão desde
 * 2019, e `oDeslocamentoAindaEFixo` (cobrado por teste ao longo de um ano) é o
 * alarme que toca se isso mudar.
 */
export function proximaExecucaoDoDiario(agora: Date, hora: number): Date {
  const hoje = hojeNaLoja(agora);
  for (const dia of [hoje, somarDias(hoje, 1), somarDias(hoje, 2)]) {
    const alvo = new Date(Date.parse(inicioDoDia(dia)) + hora * HORA_MS);
    if (alvo.getTime() > agora.getTime()) return alvo;
  }
  // Inalcançável: amanhã às `hora` é sempre depois de agora.
  return new Date(agora.getTime() + 24 * HORA_MS);
}
