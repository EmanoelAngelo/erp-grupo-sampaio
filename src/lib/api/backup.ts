/**
 * Estado do backup (GAP-PRD-011, GAP-PRD-068) — o cliente de
 * `GET /system/backup/status` e `POST /system/backup/conferir-bucket`.
 *
 * O servidor lê a pasta de backup, o registro das execuções do diário, a
 * configuração da cópia remota (só se existe, nunca o valor) e a última
 * conferência do bucket, e responde item por item: PRONTO, PENDENTE ou
 * FALHOU. Nomes de arquivo e de objeto, nunca chave nem URL do bucket.
 */
import { apiRequest, exigirCampos } from './client';

export type EstadoDoItemDeBackup = 'PRONTO' | 'PENDENTE' | 'FALHOU';

export interface ItemDoBackup {
  id: 'copia_local' | 'outro_disco' | 'copia_remota' | 'fotos' | 'bucket_conferido';
  titulo: string;
  estado: EstadoDoItemDeBackup;
  detalhe: string;
  quando: string | null;
  comoResolver?: string;
}

export interface ExecucaoDoBackup {
  id: string;
  gatilho: 'boot' | 'agenda' | 'manual';
  iniciadoEm: string;
  terminadoEm: string;
  local: { estado: 'ok' | 'falhou' | 'pulado'; arquivo: string | null; bytes: number | null; detalhe: string | null; mesmoDisco: boolean | null };
  remoto: { estado: 'ok' | 'falhou' | 'nao_configurado' | 'nao_tentado'; objeto: string | null; detalhe: string | null };
  uploads: {
    estado: 'enviado' | 'sem_mudanca' | 'vazio' | 'falhou' | 'nao_configurado' | 'nao_tentado';
    arquivos: number | null;
    enviados: number | null;
    bytes: number | null;
    manifesto: string | null;
    detalhe: string | null;
  };
}

export interface ConferenciaDoBucket {
  conferidoEm: string;
  ok: boolean;
  motivo: string | null;
  bancos: number;
  ultimoBanco: { nome: string; bytes: number; criadoEm: string | null } | null;
  ultimoEnvioPresente: boolean | null;
  manifesto: string | null;
  fotosNoManifesto: number | null;
  objetosFaltando: number | null;
}

export interface EstadoDoBackup {
  conferidoEm: string;
  geral: EstadoDoItemDeBackup;
  itens: ItemDoBackup[];
  local: {
    pasta: string;
    mesmoDiscoDoBanco: boolean;
    bancoDescartavel: boolean;
    quantidade: number;
    bytes: number;
    ultimo: { arquivo: string; bytes: number; criadoEm: string; motivo: string } | null;
  };
  remoto: { configurado: boolean; bucket: string | null };
  fotos: { arquivos: number; bytes: number; ultimoConjunto: { manifesto: string; enviadoEm: string; arquivos: number; bytes: number } | null };
  bucket: ConferenciaDoBucket | null;
  agenda: { hora: number; proxima: string };
  execucoes: ExecucaoDoBackup[];
  falhas: ExecucaoDoBackup[];
}

export async function consultarEstadoDoBackup(): Promise<EstadoDoBackup> {
  const corpo = await apiRequest<EstadoDoBackup>('/system/backup/status');
  return exigirCampos(corpo, 'conferidoEm', 'geral', 'itens', 'local', 'remoto', 'agenda', 'execucoes', 'falhas');
}

export async function conferirBucketDoBackup(): Promise<{ conferencia: ConferenciaDoBucket; estado: EstadoDoBackup }> {
  const corpo = await apiRequest<{ conferencia: ConferenciaDoBucket; estado: EstadoDoBackup }>(
    '/system/backup/conferir-bucket',
    { method: 'POST' },
  );
  return exigirCampos(corpo, 'conferencia', 'estado');
}
