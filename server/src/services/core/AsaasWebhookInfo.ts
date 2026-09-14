/**
 * QUAL URL CADASTRAR NO PAINEL DO ASAAS — e se o aviso está chegando
 * (GAP-PRD-002).
 *
 * ## O defeito
 *
 * A tela de Integrações tinha o campo do token e nenhuma URL. O checklist de
 * go-live dizia "URL pública do webhook cadastrada" sem dizer qual, e o
 * OpenAPI anunciava `/webhooks/asaas` — a rota que só gravava o evento numa
 * coleção legada. O dono seguiu o papel, e o dinheiro entrava sem baixar
 * nada.
 *
 * ## O que esta leitura responde
 *
 *   - a URL POR OPERAÇÃO que se cola no painel do Asaas desta empresa;
 *   - a URL antiga, que continua funcionando (mesmo processamento) para quem
 *     já a cadastrou — não é preciso trocar;
 *   - se o endereço é alcançável de fora: `http://localhost` é o padrão de
 *     desenvolvimento, e o Asaas não chega nele. A tela diz o que configurar;
 *   - o ÚLTIMO aviso que chegou para esta operação, e quantos chegaram no mês.
 *     "Configurado" sem nenhum aviso recebido é a pista de que a URL ou o token
 *     do painel não batem com os daqui.
 *
 * O endereço público é CONFIGURAÇÃO DO SERVIDOR (`GRUPO_SAMPAIO_PUBLIC_URL`, ou
 * `ASAAS_WEBHOOK_PUBLIC_URL` para um endereço só do webhook, como um túnel) —
 * não é dado da operação, e não se edita por tela: quem escolhe o domínio é
 * quem hospeda o servidor.
 */
import { getConnection } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { loadEnv } from '../../config/env.js';

export interface AsaasWebhookEvent {
  eventType: string;
  receivedAt: string;
  processed: boolean;
  error: string | null;
}

/**
 * O prefixo do `event_id` dos avisos que a homologação gera por dentro
 * (passo "Webhook do ERP"). Constante literal, sem caractere de LIKE.
 */
export const AVISO_LOCAL_DA_HOMOLOGACAO = 'DEVORA_HOMOLOGATION-local-';

export interface AsaasWebhookInfo {
  /** A URL a cadastrar no painel do Asaas DESTA operação. */
  url: string;
  /** A rota antiga: aceita, pelo mesmo processamento, com a empresa pelo token. */
  legacyUrl: string;
  /** De qual variável do servidor a origem pública veio. */
  baseSource: 'ASAAS_WEBHOOK_PUBLIC_URL' | 'GRUPO_SAMPAIO_PUBLIC_URL';
  /** HTTPS e fora da rede local — o único endereço que o Asaas alcança. */
  publiclyReachable: boolean;
  /** O que falta para o Asaas alcançar, em português; nulo quando nada falta. */
  warning: string | null;
  /** Último aviso recebido para esta operação. */
  lastEvent: AsaasWebhookEvent | null;
  /** Avisos recebidos nos últimos 30 dias. */
  eventsLast30Days: number;
  /** Avisos que falharam no processamento e esperam o reenvio do provedor. */
  pendingWithError: number;
}

/** Só a origem: um caminho colado na variável não pode duplicar o `/api/v1`. */
function origemDe(valor: string): string | null {
  const bruto = valor.trim();
  if (!bruto) return null;
  try {
    return new URL(bruto).origin;
  } catch {
    return null;
  }
}

/** O Asaas só entrega em HTTPS público. */
function alcancavelDeFora(origem: string): boolean {
  let url: URL;
  try {
    url = new URL(origem);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '[::1]') {
    return false;
  }
  // Faixas de rede local: o provedor, lá fora, não entra nelas.
  return !/^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(host);
}

export function describeAsaasWebhook(companyId: string): AsaasWebhookInfo {
  ensureCoreSchema();
  const env = loadEnv();

  const doWebhook = origemDe(env.ASAAS_WEBHOOK_PUBLIC_URL ?? '');
  const baseSource = doWebhook ? 'ASAAS_WEBHOOK_PUBLIC_URL' : 'GRUPO_SAMPAIO_PUBLIC_URL';
  const origem = doWebhook ?? origemDe(env.GRUPO_SAMPAIO_PUBLIC_URL ?? '') ?? 'http://localhost:8787';
  const publiclyReachable = alcancavelDeFora(origem);

  const db = getConnection();
  // O aviso que a própria homologação gera no passo local (GAP-PRD-169) não
  // é aviso do Asaas: contá-lo aqui diria "o Asaas está alcançando o servidor"
  // sem o Asaas ter mandado nada.
  const semOLocal = `AND event_id NOT LIKE '${AVISO_LOCAL_DA_HOMOLOGACAO}%'`;
  const ultimo = db
    .prepare(
      `SELECT event_type, received_at, processed, error
         FROM core_payment_webhooks
        WHERE company_id = ? ${semOLocal}
        ORDER BY received_at DESC
        LIMIT 1`,
    )
    .get(companyId) as
    | { event_type: string | null; received_at: string; processed: number; error: string | null }
    | undefined;

  const desde = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const contagem = db
    .prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN processed = 0 AND error IS NOT NULL THEN 1 ELSE 0 END), 0) AS falhos
         FROM core_payment_webhooks
        WHERE company_id = ? AND received_at >= ? ${semOLocal}`,
    )
    .get(companyId, desde) as { total: number; falhos: number };

  return {
    url: `${origem}/api/v1/loja/webhooks/payments/asaas/${encodeURIComponent(companyId)}`,
    legacyUrl: `${origem}/api/v1/webhooks/asaas`,
    baseSource,
    publiclyReachable,
    warning: publiclyReachable
      ? null
      : `O endereço ${origem} não é alcançável pelo Asaas (ele só entrega em HTTPS público). `
        + 'Defina GRUPO_SAMPAIO_PUBLIC_URL no servidor com o endereço HTTPS da API — ou '
        + 'ASAAS_WEBHOOK_PUBLIC_URL, se o webhook entrar por outro endereço — e reinicie.',
    lastEvent: ultimo
      ? {
          eventType: String(ultimo.event_type ?? ''),
          receivedAt: ultimo.received_at,
          processed: Number(ultimo.processed) === 1,
          error: ultimo.error ?? null,
        }
      : null,
    eventsLast30Days: Number(contagem.total ?? 0),
    pendingWithError: Number(contagem.falhos ?? 0),
  };
}
