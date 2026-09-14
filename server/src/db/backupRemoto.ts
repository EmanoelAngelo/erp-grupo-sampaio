/**
 * Cópia REMOTA do backup — Supabase Storage.
 *
 * ## Por que existe
 *
 * A rodada 35 deu ao banco o backup diário automático com retenção e
 * restauração provada — mas a cópia continuou no mesmo computador (o log
 * avisa isso a cada boot desde então). Disco morre, PC é furtado, a loja
 * pega fogo: a cópia que salva é a que está FORA do prédio. Este módulo sobe
 * o arquivo do diário para um bucket do Supabase.
 *
 * ## A divisão de responsabilidade (a mesma do Asaas)
 *
 * A CONTA e a CHAVE são do dono: `DEVORA_SUPABASE_URL`,
 * `DEVORA_SUPABASE_SERVICE_KEY` e `DEVORA_SUPABASE_BUCKET` moram no arquivo
 * de ambiente — nunca no chat, nunca no banco, nunca no log. Sem elas, o
 * diário AVISA que não há cópia remota: silêncio aqui seria o dono achando
 * que tem proteção quando não tem.
 *
 * ## Melhor esforço, de propósito
 *
 * Falha remota NUNCA derruba o diário local — um backup em casa é melhor
 * que nenhum. O erro fica no log, legível, sem a chave.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { loadEnv } from '../config/env.js';
import type { ResultadoDoDiario } from '../services/backup/diarioDoBackup.js';

export interface RemoteBackupConfig {
  url: string;
  serviceKey: string;
  bucket: string;
}

export function remoteBackupConfig(): RemoteBackupConfig {
  const env = loadEnv();
  return {
    url: String(env.DEVORA_SUPABASE_URL ?? '').trim().replace(/\/+$/, ''),
    serviceKey: String(env.DEVORA_SUPABASE_SERVICE_KEY ?? '').trim(),
    bucket: String(env.DEVORA_SUPABASE_BUCKET ?? '').trim() || 'backups',
  };
}

export function remoteBackupConfigured(config: RemoteBackupConfig = remoteBackupConfig()): boolean {
  return Boolean(config.url && config.serviceKey && config.bucket);
}

export type EnvioRemoto = { ok: true; objeto: string; bytes: number } | { ok: false; motivo: string };

/**
 * Sobe UM arquivo de backup para o bucket, com upsert — reenviar o diário do
 * mesmo dia substitui em vez de acumular duplicata.
 */
export async function enviarBackupRemoto(
  caminhoLocal: string,
  opts: { fetchImpl?: typeof fetch; config?: RemoteBackupConfig } = {},
): Promise<EnvioRemoto> {
  const config = opts.config ?? remoteBackupConfig();
  if (!remoteBackupConfigured(config)) {
    return {
      ok: false,
      motivo:
        'Cópia remota não configurada — defina DEVORA_SUPABASE_URL, DEVORA_SUPABASE_SERVICE_KEY e (opcional) DEVORA_SUPABASE_BUCKET no ambiente.',
    };
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const nome = basename(caminhoLocal);
  const objeto = `${config.bucket}/${nome}`;
  try {
    const bytes = readFileSync(caminhoLocal);
    const resposta = await fetchImpl(`${config.url}/storage/v1/object/${objeto}`, {
      method: 'POST',
      headers: {
        // A chave só existe AQUI, no cabeçalho da requisição — nenhum log,
        // erro ou retorno a carrega.
        Authorization: `Bearer ${config.serviceKey}`,
        // O esquema NOVO de chaves do Supabase (sb_secret_...) autentica
        // pelo header apikey; o Bearer cobre o esquema antigo (service_role
        // JWT). Mandar os dois atende qualquer idade de projeto.
        apikey: config.serviceKey,
        'x-upsert': 'true',
        'Content-Type': 'application/octet-stream',
      },
      body: new Uint8Array(bytes).buffer as ArrayBuffer,
    });
    if (!resposta.ok) {
      return { ok: false, motivo: `O bucket recusou o envio (HTTP ${resposta.status}).` };
    }
    return { ok: true, objeto, bytes: bytes.length };
  } catch (err) {
    return { ok: false, motivo: err instanceof Error ? err.message : 'Falha ao enviar o backup.' };
  }
}

/** Um objeto que existe no bucket. */
export interface BackupRemoto {
  nome: string;
  bytes: number;
  criadoEm: string | null;
}

/**
 * O QUE EXISTE LÁ — e por que ler é tão necessário quanto escrever.
 *
 * O módulo só sabia ENVIAR. Um envio que devolve HTTP 200 prova que o
 * bucket aceitou a requisição; não prova que o objeto está lá, com o tamanho
 * certo, no dia seguinte. "O job existe e o log diz ok" é exatamente o tipo
 * de garantia que ninguém conferiu — e backup sem conferência é a promessa
 * mais cara que um sistema pode fazer.
 *
 * A listagem é a metade que faltava. A outra é `baixarBackupRemoto`: só com
 * ela dá para RESTAURAR, e backup sem teste de restauração não está
 * validado.
 */
export async function listarBackupsRemotos(
  opts: { fetchImpl?: typeof fetch; config?: RemoteBackupConfig; limite?: number } = {},
): Promise<{ ok: true; itens: BackupRemoto[] } | { ok: false; motivo: string }> {
  const config = opts.config ?? remoteBackupConfig();
  if (!remoteBackupConfigured(config)) {
    return { ok: false, motivo: 'Cópia remota não configurada.' };
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const resposta = await fetchImpl(`${config.url}/storage/v1/object/list/${config.bucket}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.serviceKey}`,
        apikey: config.serviceKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        prefix: '',
        limit: opts.limite ?? 100,
        offset: 0,
        sortBy: { column: 'created_at', order: 'desc' },
      }),
    });
    if (!resposta.ok) {
      return { ok: false, motivo: `O bucket recusou a listagem (HTTP ${resposta.status}).` };
    }
    const corpo = (await resposta.json()) as {
      name: string;
      created_at?: string;
      metadata?: { size?: number };
    }[];
    if (!Array.isArray(corpo)) {
      return { ok: false, motivo: 'O bucket respondeu num formato inesperado.' };
    }
    return {
      ok: true,
      itens: corpo.map((o) => ({
        nome: o.name,
        bytes: Number(o.metadata?.size ?? 0),
        criadoEm: o.created_at ?? null,
      })),
    };
  } catch (err) {
    return { ok: false, motivo: err instanceof Error ? err.message : 'Falha ao listar.' };
  }
}

/**
 * Traz UM objeto de volta para um arquivo local.
 *
 * O destino é do chamador de propósito: restaurar por cima do banco
 * operacional é a única coisa que este módulo nunca deve fazer sozinho.
 */
export async function baixarBackupRemoto(
  nome: string,
  destino: string,
  opts: { fetchImpl?: typeof fetch; config?: RemoteBackupConfig } = {},
): Promise<{ ok: true; bytes: number } | { ok: false; motivo: string }> {
  const config = opts.config ?? remoteBackupConfig();
  if (!remoteBackupConfigured(config)) {
    return { ok: false, motivo: 'Cópia remota não configurada.' };
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const resposta = await fetchImpl(
      `${config.url}/storage/v1/object/${config.bucket}/${nome}`,
      {
        headers: {
          Authorization: `Bearer ${config.serviceKey}`,
          apikey: config.serviceKey,
        },
      },
    );
    if (!resposta.ok) {
      return { ok: false, motivo: `O bucket recusou a leitura (HTTP ${resposta.status}).` };
    }
    const bytes = Buffer.from(await resposta.arrayBuffer());
    writeFileSync(destino, bytes);
    return { ok: true, bytes: bytes.length };
  } catch (err) {
    return { ok: false, motivo: err instanceof Error ? err.message : 'Falha ao baixar.' };
  }
}

/**
 * Apaga UM objeto do bucket.
 *
 * Existe para a poda, e só ela chama. Nenhuma rotina automática usa: a poda é
 * comando, rodado por gente, com ensaio obrigatório antes. Backup que some
 * sozinho é a única coisa pior que backup que não existe.
 */
export async function apagarBackupRemoto(
  nome: string,
  opts: { fetchImpl?: typeof fetch; config?: RemoteBackupConfig } = {},
): Promise<{ ok: true } | { ok: false; motivo: string }> {
  const config = opts.config ?? remoteBackupConfig();
  if (!remoteBackupConfigured(config)) {
    return { ok: false, motivo: 'Cópia remota não configurada.' };
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const resposta = await fetchImpl(
      `${config.url}/storage/v1/object/${config.bucket}/${nome}`,
      {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${config.serviceKey}`,
          apikey: config.serviceKey,
        },
      },
    );
    if (!resposta.ok) {
      return {
        ok: false,
        motivo: `O bucket recusou a remoção (HTTP ${resposta.status}).`,
      };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, motivo: err instanceof Error ? err.message : 'Falha ao apagar.' };
  }
}

/**
 * Uma execução do diário COM a cópia remota e o envio das fotos.
 *
 * O desenho mora em `services/backup/diarioDoBackup.ts` desde a frente DEP/D2
 * (GAP-PRD-011, GAP-PRD-058): cópia local numa worker thread, envio do banco,
 * envio incremental das fotos e UMA linha em `core_backup_execucoes` com o
 * resultado de cada etapa. Este nome continua existindo para quem já o chama;
 * o import é dinâmico porque aquele módulo importa este.
 */
export async function executarBackupDiarioComRemoto(
  opts: { fetchImpl?: typeof fetch; config?: RemoteBackupConfig } = {},
): Promise<ResultadoDoDiario> {
  const { executarDiario } = await import('../services/backup/diarioDoBackup.js');
  return executarDiario({ gatilho: 'manual', ...opts });
}
