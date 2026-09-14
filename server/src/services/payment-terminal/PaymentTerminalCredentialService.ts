import { randomUUID } from 'node:crypto';
import { findOneRow, findRows, insertRow, updateRows } from '../../db/database.js';
import { assertCanalImplementado, driverDe, modoPadrao } from './PaymentTerminalChannels.js';
import { encryptFiscalSecret, decryptFiscalSecret } from '../fiscal/FiscalSecretVault.js';
import { ApiError, sanitizeForLog } from '../../utils/errors.js';
import { loadEnv } from '../../config/env.js';

export type PaymentTerminalProviderId =
  | 'generic_tef' | 'stone' | 'cielo' | 'rede' | 'getnet' | 'pagbank' | 'mercado_pago' | 'mock';

/**
 * O MOCK NÃO EXISTE ONDE EXISTE DINHEIRO.
 *
 * Este domínio nunca consultava o ambiente: em produção, um POST de
 * configuração criava e ativava o provider 'mock', e a cobrança "aprovava"
 * na hora — venda fechada, gaveta aberta, e nenhum centavo trocou de mãos.
 * A tela não distingue: `authorized` é `authorized`.
 *
 * A régua é a mesma do fiscal (`SefazAdapter.selectAdapter`, que recusa o
 * provider de teste em produção): a checagem mora num ponto só e é chamada
 * pelas três portas por onde o mock entraria — criar/ativar configuração,
 * gravar credencial e executar cobrança. Staging entra na trava junto com
 * produção pelo mesmo motivo de sempre: homologação é o ensaio de produção.
 *
 * Dev e teste continuam livres — é onde o mock tem razão de existir.
 */
export function assertMockProviderAllowed(provider: PaymentTerminalProviderId | string): void {
  if (provider !== 'mock') return;
  const ambiente = ambienteQueBloqueiaOMock();
  if (ambiente) {
    throw new ApiError(
      'PAYMENT_TERMINAL_MOCK_IN_PRODUCTION',
      'O provider mock não pode ser configurado nem cobrar em produção/homologação: '
        + 'ele aprova sem dinheiro trocar de mãos.',
      403,
      { provider: 'mock', environment: ambiente },
    );
  }
}

/**
 * EM QUE AMBIENTE O MOCK ESTÁ PROIBIDO — e por qual dos dois nomes (GAP-PRD-001).
 *
 * A trava olhava só `DEVORA_API_ENV`, cujo padrão é `development`. Quem subisse
 * o build como todo mundo sobe um Node —
 *
 *     NODE_ENV=production node dist/index.js
 *
 * — sem declarar a variável deste projeto ficava com o mock LIBERADO num
 * processo de produção. O `Dockerfile` deste repositório faz exatamente isso
 * (`ENV NODE_ENV=production`), e o `docker-compose.yml` ainda declara
 * `DEVORA_API_ENV: development` por cima. É a mesma régua dos dois nomes que o
 * `loadEnv` já usa para a chave do cofre e para as variáveis aposentadas.
 *
 * `NODE_ENV` é lido na hora, e não pelo cache do `loadEnv`: é a variável que
 * hospedagem e gerenciador de processo definem sozinhos, e o cache congelaria
 * o primeiro valor lido.
 *
 * Devolve o nome do ambiente que proíbe (para a mensagem dizer QUAL), ou
 * `null` quando o mock pode operar.
 */
export function ambienteQueBloqueiaOMock(): string | null {
  const apiEnv = loadEnv().DEVORA_API_ENV;
  if (apiEnv === 'production' || apiEnv === 'staging') return apiEnv;
  if (process.env.NODE_ENV === 'production') return 'NODE_ENV=production';
  return null;
}

/** O provider de teste pode operar neste processo? Leitura sem efeito colateral. */
export function mockProviderBlocked(): boolean {
  return ambienteQueBloqueiaOMock() !== null;
}

export interface PaymentTerminalCredentialPayload {
  merchantId?: string;
  merchantKey?: string;
  accessToken?: string;
  clientId?: string;
  clientSecret?: string;
  terminalSerial?: string;
  establishmentCode?: string;
}

export function upsertPaymentTerminalCredentials(input: {
  companyId: string;
  storeId?: string;
  provider: PaymentTerminalProviderId;
  environment?: 'sandbox' | 'homologation' | 'production';
  credentials: PaymentTerminalCredentialPayload;
  /** A maquininha que recebe a credencial; sem ela, a do provedor nesta loja. */
  configurationId?: string;
  connectionMode?: string;
}): Record<string, unknown> {
  // Credencial para o mock em produção/homologação é configuração do mock —
  // cai na mesma trava de `assertMockProviderAllowed`.
  assertMockProviderAllowed(input.provider);
  const env = loadEnv();
  if (input.environment === 'production' && !env.paymentTerminalProductionEnabled) {
    throw new ApiError('PAYMENT_TERMINAL_PRODUCTION_DISABLED', 'Produção de terminal bloqueada.', 403);
  }
  const secret = input.credentials.accessToken ?? input.credentials.merchantKey ?? input.credentials.clientSecret;
  if (!secret?.trim()) {
    throw new ApiError('PAYMENT_TERMINAL_CREDENTIALS_REQUIRED', 'Credencial obrigatória.', 400);
  }

  const existing = input.configurationId
    ? findOneRow<Record<string, unknown>>(
        'payment_terminal_configurations',
        (r) => r.id === input.configurationId && r.companyId === input.companyId,
      )
    : findOneRow<Record<string, unknown>>(
        'payment_terminal_configurations',
        (r) => r.companyId === input.companyId && r.provider === input.provider && r.storeId === (input.storeId ?? null),
      );
  if (input.configurationId && !existing) {
    throw new ApiError(
      'PAYMENT_TERMINAL_CONFIGURATION_NOT_FOUND',
      'Configuração de maquininha não encontrada nesta operação.',
      404,
    );
  }
  if (existing && existing.provider !== input.provider) {
    throw new ApiError(
      'PAYMENT_TERMINAL_PROVIDER_MISMATCH',
      `Esta maquininha é de ${String(existing.provider)}, e a credencial informada é de ${input.provider}.`,
      409,
    );
  }
  /*
    CREDENCIAL SÓ PARA CAMINHO QUE EXISTE (GAP-PRD-014).

    Gravar a credencial da Stone "na nuvem" criava uma configuração LIGADA num
    canal sem código: o balcão passava a exigir cobrança aprovada e toda
    cobrança morria `failed`. A recusa agora vem antes de selar qualquer coisa,
    e diz qual é o caminho que existe (o agente local).
  */
  const connectionMode = String(
    (existing?.connectionMode as string | undefined) ?? input.connectionMode ?? modoPadrao(input.provider),
  );
  assertCanalImplementado({ provider: input.provider, connectionMode });

  const encryptedPayload = encryptFiscalSecret(JSON.stringify(input.credentials));

  const row = {
    companyId: input.companyId,
    storeId: input.storeId,
    provider: input.provider,
    environment: input.environment ?? 'sandbox',
    secretReference: `vault:payment-terminal:${input.provider}:${input.storeId ?? 'company'}`,
    encryptedPayload,
    hasCredentials: true,
    updatedAt: new Date().toISOString(),
  };

  if (existing) {
    // Só o que é da credencial muda: a maquininha continua no caixa, no canal
    // e no estado (ligada/desligada) em que estava.
    updateRows('payment_terminal_configurations', (r) => r.id === existing.id, (r) => ({
      ...r,
      environment: row.environment,
      secretReference: row.secretReference,
      encryptedPayload,
      hasCredentials: true,
      updatedAt: row.updatedAt,
    }));
    return findOneRow('payment_terminal_configurations', (r) => r.id === existing.id) as Record<string, unknown>;
  }

  return insertRow('payment_terminal_configurations', {
    id: `ptcred-${randomUUID()}`,
    // A maquininha real nasce DESLIGADA (GAP-PRD-014): quem liga é o gestor,
    // com o agente do caixa pareado. Ligada antes disso, pararia o cartão.
    active: input.provider === 'mock',
    primary: false,
    terminalType: 'tef',
    terminalIdentifier: `TERM-${input.provider}`,
    displayName: `Terminal ${input.provider}`,
    integrationMode: 'backend_api',
    connectionMode,
    pdvTerminalId: null,
    createdAt: new Date().toISOString(),
    ...row,
  });
}

export function getPaymentTerminalCredentials(
  companyId: string,
  provider: PaymentTerminalProviderId,
  storeId?: string,
): PaymentTerminalCredentialPayload | null {
  const row = findOneRow<Record<string, unknown>>(
    'payment_terminal_configurations',
    (r) => r.companyId === companyId && r.provider === provider && (storeId ? r.storeId === storeId : true),
  );
  if (!row?.encryptedPayload) return null;
  try {
    return JSON.parse(decryptFiscalSecret(String(row.encryptedPayload))) as PaymentTerminalCredentialPayload;
  } catch {
    return null;
  }
}

export function sanitizePaymentTerminalCredential(row: Record<string, unknown>): Record<string, unknown> {
  return sanitizeForLog({
    id: row.id,
    companyId: row.companyId,
    storeId: row.storeId,
    provider: row.provider,
    environment: row.environment ?? 'sandbox',
    hasCredentials: Boolean(row.encryptedPayload),
    configured: Boolean(row.encryptedPayload),
    secretReference: row.secretReference,
    lastTestAt: row.lastTestAt,
    lastTestStatus: row.lastTestStatus,
    displayName: row.displayName,
    terminalIdentifier: row.terminalIdentifier,
    /*
      O ESTADO DA CONFIGURAÇÃO VIAJA JUNTO (GAP-PRD-001).

      O sanitizador descartava `active`, e `getTerminalStatus` lia a lista
      sanitizada perguntando `c.active !== false` — `undefined !== false` é
      sempre verdadeiro. Resultado: gravar `active: false` à mão não desligava
      maquininha nenhuma. Nada aqui é segredo; é o que a tela do gestor precisa
      para dizer "ligada", "desligada por fulano" e "de TESTE".
    */
    active: row.active !== false,
    primary: row.primary === true,
    terminalType: row.terminalType,
    connectionMode: row.connectionMode,
    // O caixa desta maquininha e o caminho até ela (GAP-PRD-014): é o que a
    // tela do gestor precisa para dizer "PinPad do Caixa 2, pelo agente local"
    // — ou "este caminho não existe".
    pdvTerminalId: (row.pdvTerminalId as string | null | undefined) ?? null,
    channel: driverDe(row).channel,
    implemented: driverDe(row).implemented,
    channelLabel: driverDe(row).label,
    channelReason: driverDe(row).reason,
    integrationMode: row.integrationMode,
    simulated: row.provider === 'mock',
    deactivatedAt: row.deactivatedAt,
    deactivatedBy: row.deactivatedBy,
    deactivationReason: row.deactivationReason,
    activatedAt: row.activatedAt,
    activatedBy: row.activatedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }) as Record<string, unknown>;
}

export function listPaymentTerminalCredentialRefs(companyId: string): Record<string, unknown>[] {
  return findRows('payment_terminal_configurations', (r) => r.companyId === companyId && Boolean(r.encryptedPayload)).map(sanitizePaymentTerminalCredential);
}

export function markPaymentTerminalTest(companyId: string, provider: PaymentTerminalProviderId, status: string, storeId?: string): void {
  const row = findOneRow<Record<string, unknown>>(
    'payment_terminal_configurations',
    (r) => r.companyId === companyId && r.provider === provider && (storeId ? r.storeId === storeId : true),
  );
  if (!row) return;
  updateRows('payment_terminal_configurations', (r) => r.id === row.id, (r) => ({
    ...r,
    lastTestAt: new Date().toISOString(),
    lastTestStatus: status,
  }));
}
