/**
 * ============================================================================
 * UMA EXECUÇÃO DO DIÁRIO — e o registro do que aconteceu em cada etapa
 * ============================================================================
 *
 * Três etapas, nesta ordem, cada uma com o próprio resultado:
 *
 *   1. CÓPIA LOCAL do banco, numa worker thread (GAP-PRD-058): a API segue
 *      atendendo enquanto o SQLite copia. É a etapa soberana — sem ela não há
 *      o que mandar ao bucket.
 *   2. CÓPIA REMOTA do banco (o arquivo que a etapa 1 acabou de criar).
 *   3. FOTOS, uma a uma, só o que ainda não está no bucket (GAP-PRD-058).
 *      Não depende da etapa 1: a foto de ontem continua precisando de cópia
 *      mesmo no dia em que o disco do backup local encheu.
 *
 * Nenhuma etapa derruba a outra, e nenhuma falha é calada: o log recebe as
 * mesmas linhas de sempre (agora com a mensagem do erro — GAP-PRD-059) e o
 * resultado vai para `core_backup_execucoes` (GAP-PRD-011), que é o que a tela
 * Configurações › Backup lê.
 *
 * Banco DESCARTÁVEL (`:memory:` ou o anunciado em `TEST_DATABASE_PATH`) não é
 * copiado, e então nada mais roda: uma suíte de testes não manda fotos para
 * bucket nenhum. A execução fica registrada como "pulada", com o motivo.
 */
import { basename } from 'node:path';
import {
  backupDirectory,
  backupNoMesmoDiscoDoBanco,
  snapshotDatabaseEmSegundoPlano,
  type BackupResult,
} from '../../db/backup.js';
import {
  enviarBackupRemoto,
  remoteBackupConfig,
  remoteBackupConfigured,
  type EnvioRemoto,
  type RemoteBackupConfig,
} from '../../db/backupRemoto.js';
import { logError, logInfo } from '../../utils/errors.js';
import {
  novoIdDeExecucao,
  registrarExecucao,
  type ExecucaoDoBackup,
  type Gatilho,
} from './registroDoBackup.js';
import { sincronizarUploads, type SincroniaDeUploads } from './uploadsIncrementais.js';

export interface OpcoesDoDiario {
  gatilho?: Gatilho;
  fetchImpl?: typeof fetch;
  config?: RemoteBackupConfig;
  /** A cópia local. Padrão: `snapshotDatabaseEmSegundoPlano('diario')`. O teste troca. */
  copiarLocal?: () => Promise<BackupResult>;
}

export interface ResultadoDoDiario {
  execucao: ExecucaoDoBackup;
  /** A cópia local; `null` quando ela falhou (o motivo está em `execucao.local.detalhe`). */
  local: BackupResult | null;
  remoto: EnvioRemoto | null;
  uploads: SincroniaDeUploads | null;
}

function mensagemDe(err: unknown): string {
  if (err instanceof Error) {
    const codigo = (err as NodeJS.ErrnoException).code;
    return codigo && !err.message.includes(codigo) ? `${err.message} (${codigo})` : err.message;
  }
  return String(err);
}

export async function executarDiario(opts: OpcoesDoDiario = {}): Promise<ResultadoDoDiario> {
  const iniciadoEm = new Date().toISOString();
  const config = opts.config ?? remoteBackupConfig();
  const configurado = remoteBackupConfigured(config);
  const execucao: ExecucaoDoBackup = {
    id: novoIdDeExecucao(),
    gatilho: opts.gatilho ?? 'manual',
    iniciadoEm,
    terminadoEm: iniciadoEm,
    local: { estado: 'pulado', arquivo: null, bytes: null, detalhe: null, mesmoDisco: null },
    remoto: { estado: 'nao_tentado', objeto: null, detalhe: null },
    uploads: { estado: 'nao_tentado', arquivos: null, enviados: null, bytes: null, manifesto: null, detalhe: null },
  };

  // ── 1. cópia local ──────────────────────────────────────────────────────
  let local: BackupResult | null;
  try {
    local = await (opts.copiarLocal ?? (() => snapshotDatabaseEmSegundoPlano('diario')))();
    if (local.skipped) {
      execucao.local.detalhe =
        local.skipped === 'in-memory'
          ? 'O banco configurado é ":memory:" — não há arquivo para copiar.'
          : 'O banco configurado está marcado como descartável (TEST_DATABASE_PATH) — não é copiado.';
    } else {
      const mesmoDisco = backupNoMesmoDiscoDoBanco();
      execucao.local = {
        estado: 'ok',
        arquivo: basename(local.path),
        bytes: local.bytes,
        detalhe: null,
        mesmoDisco,
      };
      if (mesmoDisco) {
        logError('backup_no_mesmo_disco', {
          aviso: 'O backup está no MESMO disco do banco. Se o disco morrer, morrem os dois. '
            + 'Aponte DEVORA_BACKUP_DIR para outro disco, pen drive ou pasta sincronizada.',
          pasta: backupDirectory(),
        });
      }
      logInfo('backup_diario', { path: local.path, bytes: local.bytes });
    }
  } catch (err) {
    local = null;
    execucao.local = { estado: 'falhou', arquivo: null, bytes: null, detalhe: mensagemDe(err), mesmoDisco: null };
    logError('backup_diario_falhou', { err, pasta: backupDirectory() });
  }

  const pulado = local?.skipped !== undefined;
  let remoto: EnvioRemoto | null = null;
  let uploads: SincroniaDeUploads | null = null;

  if (!pulado) {
    // ── 2. cópia remota do banco ──────────────────────────────────────────
    if (!configurado) {
      execucao.remoto = { estado: 'nao_configurado', objeto: null, detalhe: 'Cópia remota não configurada.' };
      execucao.uploads = { ...execucao.uploads, estado: 'nao_configurado', detalhe: 'Cópia remota não configurada.' };
      logError('backup_sem_copia_remota', {
        aviso:
          'O backup diário NÃO tem cópia remota. Configure DEVORA_SUPABASE_URL e '
          + 'DEVORA_SUPABASE_SERVICE_KEY para o banco de ontem existir fora deste computador.',
      });
    } else {
      if (local && execucao.local.estado === 'ok') {
        remoto = await enviarBackupRemoto(local.path, { fetchImpl: opts.fetchImpl, config });
        if (remoto.ok) {
          execucao.remoto = { estado: 'ok', objeto: remoto.objeto, detalhe: null };
          logInfo('backup_remoto', { objeto: remoto.objeto, bytes: remoto.bytes });
        } else {
          execucao.remoto = { estado: 'falhou', objeto: null, detalhe: remoto.motivo };
          logError('backup_remoto_falhou', { motivo: remoto.motivo });
        }
      } else {
        execucao.remoto = { estado: 'nao_tentado', objeto: null, detalhe: 'A cópia local falhou: não há arquivo a enviar.' };
      }

      // ── 3. fotos ────────────────────────────────────────────────────────
      uploads = await sincronizarUploads({ fetchImpl: opts.fetchImpl, config });
      execucao.uploads = {
        estado: uploads.estado,
        arquivos: uploads.arquivos,
        enviados: uploads.enviados,
        bytes: uploads.bytes,
        manifesto: uploads.manifesto,
        detalhe: uploads.detalhe,
      };
      if (uploads.estado === 'falhou') logError('backup_uploads_falhou', { motivo: uploads.detalhe });
      else if (uploads.estado === 'enviado') {
        logInfo('backup_uploads', { manifesto: uploads.manifesto, arquivos: uploads.arquivos, enviados: uploads.enviados });
      } else logInfo('backup_uploads_' + uploads.estado, { arquivos: uploads.arquivos });
    }
  }

  execucao.terminadoEm = new Date().toISOString();
  try {
    registrarExecucao(execucao);
  } catch (err) {
    // Não registrar é ruim; perder a execução por causa do registro seria pior.
    logError('backup_registro_falhou', { err });
  }
  return { execucao, local, remoto, uploads };
}
