/**
 * Leitura automática das caixas de e-mail.
 *
 * Roda no BACKEND, num laço próprio. Depender de alguém deixar a tela aberta
 * não é automação — é sorte: o gestor fecha o navegador às 18h e as notas que
 * chegam à noite só entram no dia seguinte, se ele lembrar.
 *
 * TRÊS GARANTIAS
 *
 * 1. EXECUÇÃO ÚNICA. A caixa é reivindicada com um UPDATE condicional dentro
 *    de uma transação: quem conseguir gravar o próprio `locked_by` executa, os
 *    outros saem de mãos vazias. Sem isso, duas instâncias do servidor
 *    abririam a mesma caixa ao mesmo tempo — a chave da NF-e barraria a nota
 *    duplicada, mas o trabalho e a conexão IMAP seriam desperdiçados.
 *
 * 2. RECUPERAÇÃO. A trava tem prazo. Se o processo morrer no meio da leitura,
 *    a trava vence sozinha e a próxima execução assume. Nada fica preso
 *    esperando intervenção manual.
 *
 * 3. NADA DUPLICA. Retomar depois de uma queda não reprocessa: o UID da
 *    mensagem já vista e a chave da NF-e continuam sendo a defesa, exatamente
 *    como na leitura manual.
 */
import { randomUUID } from 'node:crypto';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError, logError, logInfo } from '../../utils/errors.js';
import { recordAudit } from '../audit/AuditService.js';
import { checkInbox } from './MailInboxService.js';

/** Intervalo mínimo, para não martelar o provedor. */
export const MIN_INTERVAL_MINUTES = 1;

/** Intervalo padrão de leitura. */
export const DEFAULT_INTERVAL_MINUTES = 5;

/**
 * Quanto tempo a trava vale.
 *
 * Precisa ser maior que uma leitura demorada e menor que a paciência de quem
 * espera a nota: se o processo cair, a caixa volta a ser lida em minutos, não
 * em horas.
 */
const LOCK_MINUTES = 10;

/** Identidade deste processo, para saber quem segura a trava. */
const PROCESS_ID = `${process.pid}-${randomUUID().slice(0, 8)}`;

export interface SchedulerSettings {
  autoEnabled: boolean;
  intervalMinutes: number;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  lastResult: string | null;
  nextRunAt: string | null;
  /** Preenchido enquanto uma leitura está em curso. */
  lockedUntil: string | null;
}

function minutesFrom(base: Date, minutes: number): string {
  return new Date(base.getTime() + minutes * 60_000).toISOString();
}

export function getSchedulerSettings(companyId: string): SchedulerSettings | null {
  ensureCoreSchema();
  const row = getConnection()
    .prepare(
      `SELECT auto_enabled, interval_minutes, last_run_at, last_success_at, last_error_at,
              last_error, last_result, next_run_at, locked_until
         FROM core_mail_inboxes WHERE company_id = ? ORDER BY created_at LIMIT 1`,
    )
    .get(companyId) as Record<string, unknown> | undefined;
  if (!row) return null;

  return {
    autoEnabled: row.auto_enabled === 1,
    intervalMinutes: Number(row.interval_minutes ?? DEFAULT_INTERVAL_MINUTES),
    lastRunAt: (row.last_run_at as string | null) ?? null,
    lastSuccessAt: (row.last_success_at as string | null) ?? null,
    lastErrorAt: (row.last_error_at as string | null) ?? null,
    lastError: (row.last_error as string | null) ?? null,
    lastResult: (row.last_result as string | null) ?? null,
    nextRunAt: (row.next_run_at as string | null) ?? null,
    lockedUntil: (row.locked_until as string | null) ?? null,
  };
}

/**
 * Liga ou desliga a leitura automática.
 *
 * Ligar agenda a primeira leitura para agora: quem acabou de ativar espera ver
 * o resultado, não daqui a cinco minutos.
 */
export function setSchedule(input: {
  companyId: string;
  userId?: string | null;
  enabled: boolean;
  intervalMinutes?: number;
}): SchedulerSettings {
  ensureCoreSchema();

  const intervalo = Math.max(
    MIN_INTERVAL_MINUTES,
    Math.floor(input.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES),
  );

  return withTransaction(() => {
    const db = getConnection();
    const inbox = db
      .prepare('SELECT id, secret_cipher FROM core_mail_inboxes WHERE company_id = ? LIMIT 1')
      .get(input.companyId) as { id: string; secret_cipher: string | null } | undefined;

    if (!inbox) {
      throw new ApiError(
        'CORE_MAIL_NOT_CONFIGURED',
        'Configure a caixa de e-mail antes de ativar a leitura automática.',
        409,
      );
    }
    // Ligar sem senha agendaria uma leitura que falharia a cada intervalo,
    // enchendo a auditoria de erro previsível.
    if (input.enabled && !inbox.secret_cipher) {
      throw new ApiError(
        'CORE_MAIL_NO_CREDENTIAL',
        'Informe a senha de aplicativo antes de ativar a leitura automática.',
        409,
        { readiness: 'READY_FOR_CREDENTIAL' },
      );
    }

    db.prepare(
      `UPDATE core_mail_inboxes
          SET auto_enabled = ?, interval_minutes = ?, next_run_at = ?, updated_at = ?
        WHERE id = ?`,
    ).run(
      input.enabled ? 1 : 0,
      intervalo,
      input.enabled ? new Date().toISOString() : null,
      new Date().toISOString(),
      inbox.id,
    );

    recordAudit({
      companyId: input.companyId,
      userId: input.userId ?? null,
      action: input.enabled ? 'mail.scheduler_enabled' : 'mail.scheduler_disabled',
      entityType: 'mail_inbox',
      entityId: inbox.id,
      detail: { intervalMinutes: intervalo },
    });

    return getSchedulerSettings(input.companyId)!;
  });
}

interface Claim {
  inboxId: string;
  companyId: string;
}

/**
 * Reivindica as caixas vencidas, uma a uma.
 *
 * O `UPDATE ... WHERE` é a trava: só grava quem encontrar a linha ainda livre.
 * Duas instâncias disputando a mesma caixa produzem uma vencedora e uma que
 * não altera nada — e o `changes` diz qual foi qual.
 */
function claimDueInboxes(now: Date): Claim[] {
  ensureCoreSchema();

  return withTransaction(() => {
    const db = getConnection();
    const agora = now.toISOString();

    const candidatas = db
      .prepare(
        `SELECT id, company_id FROM core_mail_inboxes
          WHERE auto_enabled = 1
            AND active = 1
            AND secret_cipher IS NOT NULL
            AND (next_run_at IS NULL OR next_run_at <= ?)
            AND (locked_until IS NULL OR locked_until <= ?)`,
      )
      .all(agora, agora) as unknown as { id: string; company_id: string }[];

    const conquistadas: Claim[] = [];
    for (const candidata of candidatas) {
      const resultado = db
        .prepare(
          `UPDATE core_mail_inboxes
              SET locked_until = ?, locked_by = ?, last_run_at = ?
            WHERE id = ?
              AND (locked_until IS NULL OR locked_until <= ?)`,
        )
        .run(minutesFrom(now, LOCK_MINUTES), PROCESS_ID, agora, candidata.id, agora);

      if (Number(resultado.changes) > 0) {
        conquistadas.push({ inboxId: candidata.id, companyId: candidata.company_id });
      }
    }
    return conquistadas;
  });
}

/** Solta a trava e reagenda a próxima leitura. */
function releaseInbox(
  inboxId: string,
  now: Date,
  desfecho: { ok: true; resumo: string; restantes?: number } | { ok: false; erro: string },
): void {
  const db = getConnection();
  const intervalo = Number(
    (
      db.prepare('SELECT interval_minutes FROM core_mail_inboxes WHERE id = ?').get(inboxId) as
        | { interval_minutes: number }
        | undefined
    )?.interval_minutes ?? DEFAULT_INTERVAL_MINUTES,
  );

  if (desfecho.ok) {
    // Sobrou mensagem na caixa (o lote é limitado): volta em 1 minuto, não
    // no intervalo cheio — 200 não lidas não podem levar 40 minutos para
    // entrar só porque o intervalo é de 5 (GAP-PRD-035).
    const proxima = (desfecho.restantes ?? 0) > 0 ? MIN_INTERVAL_MINUTES : intervalo;
    db.prepare(
      `UPDATE core_mail_inboxes
          SET locked_until = NULL, locked_by = NULL, next_run_at = ?,
              last_success_at = ?, last_result = ?, last_error = NULL, updated_at = ?
        WHERE id = ?`,
    ).run(minutesFrom(now, proxima), now.toISOString(), desfecho.resumo, now.toISOString(), inboxId);
    return;
  }

  // Erro NÃO desliga o agendamento: provedor fora do ar costuma ser
  // temporário, e desligar sozinho faria as notas pararem de entrar sem
  // ninguém perceber. A próxima tentativa fica registrada.
  db.prepare(
    `UPDATE core_mail_inboxes
        SET locked_until = NULL, locked_by = NULL, next_run_at = ?,
            last_error_at = ?, last_error = ?, updated_at = ?
      WHERE id = ?`,
  ).run(minutesFrom(now, intervalo), now.toISOString(), desfecho.erro, now.toISOString(), inboxId);
}

export interface SchedulerRunResult {
  claimed: number;
  imported: number;
  failed: number;
}

/**
 * Uma passada do agendador.
 *
 * Exportada para o teste poder chamá-la diretamente, sem depender de relógio.
 */
export async function runScheduledSync(now = new Date()): Promise<SchedulerRunResult> {
  const claims = claimDueInboxes(now);
  let imported = 0;
  let failed = 0;

  for (const claim of claims) {
    recordAudit({
      companyId: claim.companyId,
      userId: null,
      action: 'mail.scheduler_run',
      entityType: 'mail_inbox',
      entityId: claim.inboxId,
    });

    try {
      // A leitura em si é a MESMA do botão "Ler agora": mesma idempotência,
      // mesma conferência. O agendador só decide quando.
      const resultado = await checkInbox({
        companyId: claim.companyId,
        userId: 'scheduler',
      });

      const importadas = resultado.results.filter((r) => r.outcome === 'importado').length;
      imported += importadas;
      // Quantas ficaram na caixa entra no resumo: "25 mensagem(ns), 0 nota(s)"
      // repetido para sempre era exatamente o sintoma do GAP-PRD-035.
      const restantes = resultado.restantes ?? 0;
      const resumo =
        `${resultado.checked} mensagem(ns), ${importadas} nota(s) em conferência.` +
        (restantes > 0
          ? ` Ainda há ${restantes} na caixa — a próxima leitura continua em ${MIN_INTERVAL_MINUTES} minuto.`
          : '') +
        (resultado.avisos?.length ? ` Aviso: ${resultado.avisos.join(' ')}` : '');

      releaseInbox(claim.inboxId, now, { ok: true, resumo, restantes });
      recordAudit({
        companyId: claim.companyId,
        userId: null,
        action: 'mail.scheduler_success',
        entityType: 'mail_inbox',
        entityId: claim.inboxId,
        detail: { checked: resultado.checked, imported: importadas, restantes },
      });
    } catch (err) {
      failed += 1;
      // A credencial nunca entra na mensagem — `checkInbox` já cuida disso.
      const motivo = err instanceof ApiError ? err.message : 'Falha na leitura automática.';
      releaseInbox(claim.inboxId, now, { ok: false, erro: motivo });
      recordAudit({
        companyId: claim.companyId,
        userId: null,
        action: 'mail.scheduler_error',
        entityType: 'mail_inbox',
        entityId: claim.inboxId,
        detail: { error: motivo },
      });
      logError('MAIL_SCHEDULER_ERROR', { inboxId: claim.inboxId, error: motivo });
    }
  }

  return { claimed: claims.length, imported, failed };
}

let timer: NodeJS.Timeout | null = null;

/**
 * Liga o laço do agendador.
 *
 * O tique é fixo e curto (1 min); quem decide se a caixa está vencida é o
 * `next_run_at` dela. Assim o intervalo é por operação, sem um temporizador
 * para cada uma.
 */
export function startMailScheduler(tickMs = 60_000): void {
  if (timer) return;

  timer = setInterval(() => {
    void runScheduledSync().catch((err) => {
      logError('MAIL_SCHEDULER_TICK_FAILED', { error: String(err) });
    });
  }, tickMs);

  // Não segura o processo: `npm test` e o encerramento do servidor não podem
  // ficar presos esperando o próximo tique.
  timer.unref?.();
  logInfo('MAIL_SCHEDULER_STARTED', { tickMs, processId: PROCESS_ID });
}

export function stopMailScheduler(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
