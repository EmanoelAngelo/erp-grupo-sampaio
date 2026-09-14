/**
 * ============================================================================
 * O REGISTRO DO BACKUP (GAP-PRD-011)
 * ============================================================================
 *
 * Cada execução do diário — a da subida, a da hora marcada, a manual — vira
 * uma linha em `core_backup_execucoes`, com o resultado de CADA etapa: a cópia
 * local, a cópia remota do banco e o envio das fotos. O log continua
 * recebendo as mesmas linhas; a diferença é que agora a pergunta "o backup
 * está rodando?" tem resposta sem abrir o terminal do servidor.
 *
 * Nada aqui guarda segredo: nome de arquivo, nome de objeto no bucket,
 * tamanho, data e o motivo da falha (já sem chave — os módulos de envio nunca
 * põem a chave no motivo).
 */
import { randomUUID } from 'node:crypto';
import { getConnection } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';

export type Gatilho = 'boot' | 'agenda' | 'manual';
export type EstadoLocal = 'ok' | 'falhou' | 'pulado';
export type EstadoRemoto = 'ok' | 'falhou' | 'nao_configurado' | 'nao_tentado';
export type EstadoDosUploads = 'enviado' | 'sem_mudanca' | 'vazio' | 'falhou' | 'nao_configurado' | 'nao_tentado';

export interface ExecucaoDoBackup {
  id: string;
  gatilho: Gatilho;
  iniciadoEm: string;
  terminadoEm: string;
  local: {
    estado: EstadoLocal;
    arquivo: string | null;
    bytes: number | null;
    detalhe: string | null;
    mesmoDisco: boolean | null;
  };
  remoto: { estado: EstadoRemoto; objeto: string | null; detalhe: string | null };
  uploads: {
    estado: EstadoDosUploads;
    arquivos: number | null;
    enviados: number | null;
    bytes: number | null;
    manifesto: string | null;
    detalhe: string | null;
  };
}

/** Quantas execuções ficam. Um ano de diário e folga para as subidas. */
const MANTER_EXECUCOES = 400;

interface Linha {
  id: string;
  gatilho: Gatilho;
  iniciado_em: string;
  terminado_em: string;
  local_estado: EstadoLocal;
  local_arquivo: string | null;
  local_bytes: number | null;
  local_detalhe: string | null;
  mesmo_disco: number | null;
  remoto_estado: EstadoRemoto;
  remoto_objeto: string | null;
  remoto_detalhe: string | null;
  uploads_estado: EstadoDosUploads;
  uploads_arquivos: number | null;
  uploads_enviados: number | null;
  uploads_bytes: number | null;
  uploads_manifesto: string | null;
  uploads_detalhe: string | null;
}

function paraExecucao(l: Linha): ExecucaoDoBackup {
  return {
    id: l.id,
    gatilho: l.gatilho,
    iniciadoEm: l.iniciado_em,
    terminadoEm: l.terminado_em,
    local: {
      estado: l.local_estado,
      arquivo: l.local_arquivo,
      bytes: l.local_bytes,
      detalhe: l.local_detalhe,
      mesmoDisco: l.mesmo_disco === null ? null : l.mesmo_disco === 1,
    },
    remoto: { estado: l.remoto_estado, objeto: l.remoto_objeto, detalhe: l.remoto_detalhe },
    uploads: {
      estado: l.uploads_estado,
      arquivos: l.uploads_arquivos,
      enviados: l.uploads_enviados,
      bytes: l.uploads_bytes,
      manifesto: l.uploads_manifesto,
      detalhe: l.uploads_detalhe,
    },
  };
}

export function novoIdDeExecucao(): string {
  return randomUUID();
}

export function registrarExecucao(e: ExecucaoDoBackup): void {
  ensureCoreSchema();
  const db = getConnection();
  db.prepare(
    `INSERT INTO core_backup_execucoes (
       id, gatilho, iniciado_em, terminado_em,
       local_estado, local_arquivo, local_bytes, local_detalhe, mesmo_disco,
       remoto_estado, remoto_objeto, remoto_detalhe,
       uploads_estado, uploads_arquivos, uploads_enviados, uploads_bytes, uploads_manifesto, uploads_detalhe
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    e.id,
    e.gatilho,
    e.iniciadoEm,
    e.terminadoEm,
    e.local.estado,
    e.local.arquivo,
    e.local.bytes,
    e.local.detalhe,
    e.local.mesmoDisco === null ? null : e.local.mesmoDisco ? 1 : 0,
    e.remoto.estado,
    e.remoto.objeto,
    e.remoto.detalhe,
    e.uploads.estado,
    e.uploads.arquivos,
    e.uploads.enviados,
    e.uploads.bytes,
    e.uploads.manifesto,
    e.uploads.detalhe,
  );
  // Poda por quantidade: o registro não pode crescer para sempre, e a última
  // falha de um ano atrás não ajuda ninguém a decidir nada hoje.
  db.prepare(
    `DELETE FROM core_backup_execucoes
      WHERE id NOT IN (SELECT id FROM core_backup_execucoes ORDER BY iniciado_em DESC LIMIT ?)`,
  ).run(MANTER_EXECUCOES);
}

export function listarExecucoes(limite = 20): ExecucaoDoBackup[] {
  ensureCoreSchema();
  const linhas = getConnection()
    .prepare('SELECT * FROM core_backup_execucoes ORDER BY iniciado_em DESC LIMIT ?')
    .all(limite) as unknown as Linha[];
  return linhas.map(paraExecucao);
}

/** A execução mais recente que satisfaz a condição SQL (fixa, escrita neste módulo). */
function ultimaOnde(condicao: string): ExecucaoDoBackup | null {
  ensureCoreSchema();
  const linha = getConnection()
    .prepare(`SELECT * FROM core_backup_execucoes WHERE ${condicao} ORDER BY iniciado_em DESC LIMIT 1`)
    .get() as Linha | undefined;
  return linha ? paraExecucao(linha) : null;
}

export const ultimaExecucao = (): ExecucaoDoBackup | null => ultimaOnde('1 = 1');
export const ultimaCopiaLocalOk = (): ExecucaoDoBackup | null => ultimaOnde("local_estado = 'ok'");
export const ultimoEnvioRemotoOk = (): ExecucaoDoBackup | null => ultimaOnde("remoto_estado = 'ok'");
export const ultimaTentativaRemota = (): ExecucaoDoBackup | null =>
  ultimaOnde("remoto_estado IN ('ok', 'falhou')");
export const ultimaSincroniaDeUploadsOk = (): ExecucaoDoBackup | null =>
  ultimaOnde("uploads_estado IN ('enviado', 'sem_mudanca', 'vazio')");
export const ultimaTentativaDeUploads = (): ExecucaoDoBackup | null =>
  ultimaOnde("uploads_estado IN ('enviado', 'sem_mudanca', 'vazio', 'falhou')");

/** Execuções com alguma etapa que FALHOU desde `desde`, da mais nova para a mais velha. */
export function falhasDesde(desde: string, limite = 20): ExecucaoDoBackup[] {
  ensureCoreSchema();
  const linhas = getConnection()
    .prepare(
      `SELECT * FROM core_backup_execucoes
        WHERE iniciado_em >= ?
          AND (local_estado = 'falhou' OR remoto_estado = 'falhou' OR uploads_estado = 'falhou')
        ORDER BY iniciado_em DESC LIMIT ?`,
    )
    .all(desde, limite) as unknown as Linha[];
  return linhas.map(paraExecucao);
}

// ------------------------------------------------------------------ core_meta

export function lerMetaJson<T>(chave: string): T | null {
  try {
    ensureCoreSchema();
    const linha = getConnection().prepare('SELECT value FROM core_meta WHERE key = ?').get(chave) as
      | { value: string }
      | undefined;
    return linha ? (JSON.parse(linha.value) as T) : null;
  } catch {
    return null;
  }
}

export function gravarMetaJson(chave: string, valor: unknown): void {
  ensureCoreSchema();
  getConnection()
    .prepare(
      'INSERT INTO core_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
    .run(chave, JSON.stringify(valor));
}
