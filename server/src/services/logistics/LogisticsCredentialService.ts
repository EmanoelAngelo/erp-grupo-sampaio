import { deleteRows, findRows, insertRow, updateRows } from '../../db/database.js';
import { encryptFiscalSecret, decryptFiscalSecret } from '../fiscal/FiscalSecretVault.js';
import { ApiError, sanitizeForLog } from '../../utils/errors.js';

export type LogisticsCarrierId = 'correios' | 'jadlog' | 'melhor_envio' | 'generic';

/** As transportadoras que o módulo conhece. Nome fora daqui é recusado na entrada. */
export const LOGISTICS_CARRIER_IDS: readonly LogisticsCarrierId[] = ['correios', 'jadlog', 'melhor_envio', 'generic'];

export function isLogisticsCarrierId(valor: unknown): valor is LogisticsCarrierId {
  return typeof valor === 'string' && (LOGISTICS_CARRIER_IDS as readonly string[]).includes(valor);
}

/**
 * O ambiente da credencial. `homologation` é o sandbox do provedor; o nome
 * ficou por compatibilidade com as linhas já gravadas.
 */
export type LogisticsCredentialEnvironment = 'homologation' | 'production';

export interface LogisticsCredentialPayload {
  apiKey?: string;
  token?: string;
  refreshToken?: string;
  contract?: string;
  postingCard?: string;
  username?: string;
  password?: string;
  cnpj?: string;
  accountId?: string;
}

type Linha = Record<string, unknown>;

/** Os quatro últimos caracteres, para o gestor reconhecer QUAL token está guardado. */
function dicaMascarada(segredo: string): string {
  const limpo = segredo.trim();
  return limpo.length >= 8 ? `••••${limpo.slice(-4)}` : '••••';
}

/** A linha vale para o escopo pedido? `storeId` ausente e `null` são o mesmo: a operação inteira. */
function mesmoEscopo(r: Linha, storeId?: string | null): boolean {
  return (r.storeId ?? null) === (storeId ?? null);
}

/**
 * A linha de credencial que vale para (empresa, transportadora, loja).
 *
 * A LINHA DUPLICADA QUE PRENDIA O TOKEN VELHO. A gravação comparava
 * `r.storeId === (input.storeId ?? null)`, mas a linha sem loja é gravada com
 * `storeId: undefined` — que o JSON descarta, e que volta como `undefined`,
 * nunca `null`. A comparação nunca casava: cada gravação sem loja criava uma
 * linha NOVA, e a leitura devolvia a PRIMEIRA. Trocar o token pela tela não
 * trocaria nada — a cotação continuaria com o token antigo, em silêncio.
 *
 * A escolha agora é explícita: com loja, a linha daquela loja; sem loja, a da
 * operação inteira, e só na falta dela uma de loja. Havendo mais de uma (as
 * duplicatas antigas), vale a gravada por último.
 */
export function getLogisticsCredentialRow(
  companyId: string,
  carrier: LogisticsCarrierId,
  storeId?: string,
): Linha | null {
  const candidatas = findRows<Linha>(
    'logistics_carrier_credentials',
    (r) => r.companyId === companyId && r.carrier === carrier,
  );
  const maisRecente = (linhas: Linha[]) =>
    [...linhas].sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))[0] ?? null;

  if (storeId) return maisRecente(candidatas.filter((r) => r.storeId === storeId));
  return maisRecente(candidatas.filter((r) => mesmoEscopo(r, null))) ?? maisRecente(candidatas);
}

export function upsertLogisticsCredentials(input: {
  companyId: string;
  storeId?: string;
  carrier: LogisticsCarrierId;
  environment?: LogisticsCredentialEnvironment;
  enabled?: boolean;
  simulationMode?: boolean;
  /** E-mail de contato técnico que o Melhor Envio pede no User-Agent. Não é segredo. */
  contactEmail?: string | null;
  credentials: LogisticsCredentialPayload;
}): Record<string, unknown> {
  /*
    A RECUSA DE PRODUÇÃO SAIU DAQUI (GAP-PRD-030/117). Guardar o token de
    produção era 403 enquanto `LOGISTICS_PRODUCTION_ENABLED` estivesse
    desligada — o dono não conseguia nem ENTREGAR o insumo. A trava continua
    existindo, no lugar certo: quem decide se a chamada vai para a produção é
    `resolveCarrierAccess`, que lê a trava e a devolve pelo nome para a tela.
  */
  if (!isLogisticsCarrierId(input.carrier)) {
    throw new ApiError('LOGISTICS_CARRIER_INVALID', 'Transportadora desconhecida.', 400);
  }
  const secret = input.credentials.apiKey ?? input.credentials.token ?? input.credentials.password;
  if (!secret?.trim()) {
    throw new ApiError('LOGISTICS_CREDENTIALS_REQUIRED', 'Credencial obrigatória (token/apiKey/senha).', 400);
  }

  const encryptedPayload = encryptFiscalSecret(JSON.stringify(input.credentials));
  const existentes = findRows<Linha>(
    'logistics_carrier_credentials',
    (r) => r.companyId === input.companyId && r.carrier === input.carrier && mesmoEscopo(r, input.storeId),
  );
  const agora = new Date().toISOString();

  const row: Linha = {
    companyId: input.companyId,
    storeId: input.storeId,
    carrier: input.carrier,
    environment: input.environment ?? 'homologation',
    enabled: input.enabled ?? true,
    simulationMode: input.simulationMode ?? true,
    secretReference: `vault:logistics:${input.carrier}:${input.storeId ?? 'company'}`,
    encryptedPayload,
    // `apiKeyEncrypted` era uma SEGUNDA cópia do mesmo cifrado. A rotação da
    // chave do cofre só regrava `encryptedPayload`; a cópia ficaria selada pela
    // chave velha. Não se grava mais, e a gravação apaga a que existir.
    apiKeyEncrypted: undefined,
    maskedHint: dicaMascarada(secret),
    contactEmail: input.contactEmail?.trim() || null,
    // Token novo: teste feito com o anterior não prova nada sobre este.
    lastTestAt: null,
    lastTestStatus: null,
    connectionStatus: null,
    connectionTestedAt: null,
    connectionMessage: null,
    lastQuoteStatus: null,
    lastQuoteAt: null,
    lastQuoteMessage: null,
    lastLabelStatus: null,
    lastLabelAt: null,
    lastLabelMessage: null,
    lastTrackingStatus: null,
    lastTrackingAt: null,
    lastTrackingMessage: null,
    updatedAt: agora,
  };

  if (existentes.length > 0) {
    const [manter, ...duplicadas] = existentes;
    updateRows<Linha>('logistics_carrier_credentials', (r) => r.id === manter.id, (r) => ({ ...r, ...row }));
    // As duplicatas antigas saem: senão uma delas poderia voltar a ser lida.
    if (duplicadas.length > 0) {
      const ids = new Set(duplicadas.map((d) => d.id));
      deleteRows<Linha>('logistics_carrier_credentials', (r) => ids.has(r.id) && r.companyId === input.companyId);
    }
    return getLogisticsCredentialRow(input.companyId, input.carrier, input.storeId) as Record<string, unknown>;
  }

  return insertRow('logistics_carrier_credentials', {
    id: `lgcred-${input.carrier}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: agora,
    ...row,
  });
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * A credencial que chega pela tela (ou pela API), conferida ANTES de tocar o cofre.
 *
 * Transportadora fora da lista, ambiente com nome inventado, token curto
 * demais para ser token e e-mail que não é e-mail são recusados com o motivo —
 * nada é gravado pela metade.
 */
export function lerEntradaDeCredencial(body: Record<string, unknown> | undefined): {
  carrier: LogisticsCarrierId;
  environment: LogisticsCredentialEnvironment;
  token: string;
  contactEmail: string | null;
} {
  const carrier = body?.carrier;
  if (!isLogisticsCarrierId(carrier)) {
    throw new ApiError(
      'LOGISTICS_CARRIER_INVALID',
      `Transportadora desconhecida. Use uma destas: ${LOGISTICS_CARRIER_IDS.join(', ')}.`,
      400,
    );
  }

  const bruto = String(body?.environment ?? 'homologation').trim().toLowerCase();
  let environment: LogisticsCredentialEnvironment;
  if (bruto === 'production' || bruto === 'producao' || bruto === 'produção') environment = 'production';
  else if (bruto === 'homologation' || bruto === 'sandbox' || bruto === 'homologacao' || bruto === 'homologação') {
    environment = 'homologation';
  } else {
    throw new ApiError('LOGISTICS_ENVIRONMENT_INVALID', 'Ambiente deve ser sandbox ou produção.', 400);
  }

  const token = String(body?.token ?? body?.apiKey ?? '').trim();
  if (token.length < 10) {
    throw new ApiError(
      'LOGISTICS_CREDENTIALS_REQUIRED',
      'Cole o token completo gerado no painel da transportadora.',
      400,
    );
  }

  const email = String(body?.contactEmail ?? '').trim();
  if (email && !EMAIL.test(email)) {
    throw new ApiError('LOGISTICS_CONTACT_EMAIL_INVALID', 'E-mail de contato técnico inválido.', 400);
  }

  return { carrier, environment, token, contactEmail: email || null };
}

/**
 * Remove a credencial da transportadora.
 *
 * Sem loja, remove TODAS as linhas daquela transportadora na operação: a tela
 * trabalha no nível da operação, e sobrar uma linha de loja faria a cotação
 * continuar usando um token que o gestor acabou de tirar.
 */
export function removeLogisticsCredentials(companyId: string, carrier: LogisticsCarrierId, storeId?: string): number {
  return deleteRows<Linha>(
    'logistics_carrier_credentials',
    (r) => r.companyId === companyId && r.carrier === carrier && (storeId ? r.storeId === storeId : true),
  );
}

export function getLogisticsCredentials(
  companyId: string,
  carrier: LogisticsCarrierId,
  storeId?: string,
): LogisticsCredentialPayload | null {
  const row = getLogisticsCredentialRow(companyId, carrier, storeId);
  if (!row?.encryptedPayload && !row?.apiKeyEncrypted) return null;
  try {
    const payload = String(row.encryptedPayload ?? row.apiKeyEncrypted);
    return JSON.parse(decryptFiscalSecret(payload)) as LogisticsCredentialPayload;
  } catch {
    return null;
  }
}

export function sanitizeLogisticsCredentialForResponse(row: Record<string, unknown>): Record<string, unknown> {
  return sanitizeForLog({
    id: row.id,
    companyId: row.companyId,
    storeId: row.storeId,
    carrier: row.carrier,
    environment: row.environment ?? 'homologation',
    enabled: row.enabled,
    simulationMode: row.simulationMode,
    hasCredentials: Boolean(row.encryptedPayload ?? row.apiKeyEncrypted),
    configured: Boolean(row.encryptedPayload ?? row.apiKeyEncrypted),
    secretReference: row.secretReference,
    maskedHint: row.maskedHint ?? null,
    contactEmail: row.contactEmail ?? null,
    updatedAt: row.updatedAt ?? null,
    lastTestAt: row.lastTestAt,
    lastTestStatus: row.lastTestStatus,
    connectionStatus: row.connectionStatus ?? null,
    connectionTestedAt: row.connectionTestedAt ?? null,
    connectionMessage: row.connectionMessage ?? null,
    lastQuoteStatus: row.lastQuoteStatus ?? null,
    lastQuoteAt: row.lastQuoteAt ?? null,
    lastQuoteMessage: row.lastQuoteMessage ?? null,
    lastLabelStatus: row.lastLabelStatus ?? null,
    lastLabelAt: row.lastLabelAt ?? null,
    lastLabelMessage: row.lastLabelMessage ?? null,
    lastTrackingStatus: row.lastTrackingStatus ?? null,
    lastTrackingAt: row.lastTrackingAt ?? null,
    lastTrackingMessage: row.lastTrackingMessage ?? null,
  }) as Record<string, unknown>;
}

export function listLogisticsCredentialRefs(companyId: string): Record<string, unknown>[] {
  return findRows('logistics_carrier_credentials', (r) => r.companyId === companyId).map(sanitizeLogisticsCredentialForResponse);
}

/**
 * O que um teste provou, separado por assunto.
 *
 * `lastTestStatus` era um campo só para tudo: cotar depois de testar a conexão
 * sobrescrevia `connection_ok` com `quote_ok`, e a prontidão passava a dizer
 * que a conexão nunca fora testada. Conexão e cotação agora têm campo próprio;
 * `lastTestStatus` continua sendo gravado para quem ainda o lê.
 */
export interface LogisticsTestDetail {
  /**
   * `label` e `tracking` (GAP-PRD-120/119): a primeira etiqueta gerada e a
   * primeira consulta de rastreio que deram certo acendem os itens ETIQUETA e
   * RASTREAMENTO da prontidão — que antes só acendiam por um status que
   * nenhum código gravava.
   */
  kind: 'connection' | 'quote' | 'label' | 'tracking';
  ok: boolean;
  message?: string | null;
}

export function markCredentialTest(
  companyId: string,
  carrier: LogisticsCarrierId,
  status: string,
  storeId?: string,
  detalhe?: LogisticsTestDetail,
): void {
  const row = getLogisticsCredentialRow(companyId, carrier, storeId);
  if (!row) return;
  const agora = new Date().toISOString();
  const extra: Linha = {};
  if (detalhe?.kind === 'connection') {
    extra.connectionStatus = detalhe.ok ? 'ok' : 'failed';
    extra.connectionTestedAt = agora;
    extra.connectionMessage = detalhe.message ?? null;
  } else if (detalhe?.kind === 'quote') {
    extra.lastQuoteStatus = detalhe.ok ? 'ok' : 'failed';
    extra.lastQuoteAt = agora;
    extra.lastQuoteMessage = detalhe.message ?? null;
  } else if (detalhe?.kind === 'label') {
    extra.lastLabelStatus = detalhe.ok ? 'ok' : 'failed';
    extra.lastLabelAt = agora;
    extra.lastLabelMessage = detalhe.message ?? null;
  } else if (detalhe?.kind === 'tracking') {
    extra.lastTrackingStatus = detalhe.ok ? 'ok' : 'failed';
    extra.lastTrackingAt = agora;
    extra.lastTrackingMessage = detalhe.message ?? null;
  }
  updateRows<Linha>('logistics_carrier_credentials', (r) => r.id === row.id, (r) => ({
    ...r,
    lastTestAt: agora,
    lastTestStatus: status,
    ...extra,
  }));
}
