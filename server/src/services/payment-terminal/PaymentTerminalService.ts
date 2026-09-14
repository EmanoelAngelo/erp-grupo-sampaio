import { randomUUID } from 'node:crypto';
import { findRows, insertRow, findOneRow, updateRows } from '../../db/database.js';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { loadEnv } from '../../config/env.js';
import { ApiError } from '../../utils/errors.js';
import { recordAudit } from '../audit/AuditService.js';
import {
  buildPaymentTerminalReadinessChecklist,
  homologacaoDaConfiguracao,
} from './PaymentTerminalReadinessService.js';
import {
  assertMockProviderAllowed,
  listPaymentTerminalCredentialRefs,
  mockProviderBlocked,
  sanitizePaymentTerminalCredential,
  upsertPaymentTerminalCredentials,
  type PaymentTerminalProviderId,
} from './PaymentTerminalCredentialService.js';
import {
  cancelPaymentTerminalTransaction,
  getLocalAgentStatus,
  processPaymentTerminalTransaction,
  refundPaymentTerminalTransaction,
  testPaymentTerminalConnection,
  getProviderImplementationType,
  type PaymentTerminalAdapterResult,
  type PaymentTerminalOperationRef,
} from './PaymentTerminalProviderAdapter.js';
import {
  assertCanalImplementado,
  canalDe,
  driverDe,
  modoPadrao,
  NOME_DO_PROVEDOR,
} from './PaymentTerminalChannels.js';
import {
  agenteDoCaixa,
  agenteOnline,
  listLocalAgentsForManager,
} from './PaymentTerminalLocalAgentService.js';
import {
  enfileirarComando,
  expirarComandosVencidos,
  listarComandosDoAgente,
  operacaoPendenteNoAgente,
} from './PaymentTerminalAgentChannel.js';
import {
  aplicarCancelamentoConfirmado,
  aplicarEstornoConfirmado,
  gravarNaCobranca,
  guardarComprovante,
  registrarTentativa,
  respostaAtrasada,
} from './PaymentTerminalTransactionEffects.js';
import { assertTerminalDaEmpresa } from '../core/TerminalRegistry.js';
import * as Impressao from '../api/ImpressaoDaRequisicao.js';

export {
  upsertPaymentTerminalCredentials,
  listPaymentTerminalCredentialRefs,
  sanitizePaymentTerminalCredential,
};

export function paymentTerminalHealth() {
  const env = loadEnv();
  return {
    status: 'ok',
    module: 'payment-terminal',
    checkpoint: 72,
    enabled: env.paymentTerminalEnabled,
    productionEnabled: false,
    productionBlocked: !env.paymentTerminalProductionEnabled,
  };
}

export function paymentTerminalReadiness(companyId: string) {
  const checklist = buildPaymentTerminalReadinessChecklist(companyId);
  return {
    companyId,
    readyForHomologation: checklist.overallStatus === 'ready_for_homologation',
    readyForProduction: false,
    productionBlocked: checklist.productionBlocked,
    terminalEnabled: checklist.terminalEnabled,
    overallStatus: checklist.overallStatus,
    providers: checklist.providers,
    configurations: checklist.configurations,
    blockingReasons: checklist.blockingReasons,
  };
}

export async function paymentTerminalProvidersStatus(companyId: string) {
  const providers: PaymentTerminalProviderId[] = ['mock', 'stone', 'cielo', 'rede', 'getnet', 'pagbank', 'mercado_pago', 'generic_tef'];
  const creds = listPaymentTerminalCredentialRefs(companyId);
  const configs = listPaymentTerminalConfigurationsRaw(companyId);
  const items = await Promise.all(
    providers.map(async (provider) => {
      const cred = creds.find((c) => c.provider === provider);
      /*
        "Configurado" é ter um CAMINHO que opera (GAP-PRD-014), e não ter
        credencial gravada: a credencial da Stone num canal que nenhum código
        atende contava como configurada, e o balcão parava de vender cartão.
      */
      const comCaminho = configs.some((c) => c.provider === provider && driverDe(c).implemented);
      const connection = comCaminho || provider === 'mock'
        ? await testPaymentTerminalConnection(companyId, provider)
        : { ok: false, real: false, simulated: false, pending: true, message: 'Não configurado.' };
      // O mock só "está configurado" onde ele pode operar (GAP-PRD-001): em
      // produção o painel dizia configurado e conexão OK para o provider que
      // aprova sem dinheiro.
      const mockUtilizavel = provider === 'mock' && !mockProviderBlocked();
      return {
        provider,
        implementationType: getProviderImplementationType(provider),
        configured: (comCaminho && provider !== 'mock') || mockUtilizavel,
        environment: cred?.environment ?? 'sandbox',
        lastTestAt: cred?.lastTestAt,
        lastTestStatus: cred?.lastTestStatus,
        connection,
        productionBlocked: !loadEnv().paymentTerminalProductionEnabled,
      };
    }),
  );
  return { items, localAgent: getLocalAgentStatus(companyId), productionBlocked: !loadEnv().paymentTerminalProductionEnabled };
}

export function listPaymentTerminalProvidersBackend() {
  return ['generic_tef', 'stone', 'cielo', 'rede', 'getnet', 'pagbank', 'mercado_pago', 'mock'];
}

export function getProviderCapabilitiesBackend(provider: string) {
  const pix = !['getnet'].includes(provider);
  return {
    credit: true, debit: true, pix, voucher: provider === 'mock',
    installments: true, cancellation: true, refund: true, receipt: true, reprint: true,
    maxInstallments: 12, supportedCurrencies: ['BRL'],
    implementationType: getProviderImplementationType(provider as PaymentTerminalProviderId),
  };
}

export function listPaymentTerminalConfigurationsBackend(companyId: string, storeId?: string) {
  return findRows('payment_terminal_configurations', (r) => r.companyId === companyId && (!storeId || r.storeId === storeId))
    .map((r) => sanitizePaymentTerminalCredential(r as Record<string, unknown>));
}

export function createPaymentTerminalConfigurationBackend(input: Record<string, unknown>) {
  // A rota preenche 'mock' quando ninguém manda provider — a trava tem que
  // ler o mesmo padrão, senão o silêncio vira porta.
  const provider = String(input.provider ?? 'mock');
  assertMockProviderAllowed(provider);
  /*
    O CAMINHO TEM DE EXISTIR ANTES DA CONFIGURAÇÃO (GAP-PRD-014).

    Aceitava qualquer provedor em qualquer modo, e a configuração nascia
    LIGADA: cadastrar a Stone "na nuvem" passava a exigir no balcão uma
    cobrança aprovada que nenhum código sabia produzir. Agora o canal é
    conferido (`assertCanalImplementado`), o modo padrão é o único que existe
    (agente local), e a maquininha real nasce DESLIGADA — quem liga é o
    gestor, depois de parear o agente (ver `setPaymentTerminalConfigurationActiveBackend`).
  */
  const connectionMode = (input.connectionMode as string | undefined) ?? modoPadrao(provider);
  const driver = assertCanalImplementado({ provider, connectionMode });
  const companyId = String(input.companyId ?? '');
  const caixa = input.pdvTerminalId
    ? assertTerminalDaEmpresa(companyId, String(input.pdvTerminalId), { exigirAtivo: true })
    : null;
  // Mesma cerca da transação, e pelo mesmo motivo: chave repetida entre
  // empresas devolvia a configuração da OUTRA operação — e a segunda empresa
  // ficava sem maquininha nenhuma achando que cadastrou a dela. E só com
  // chave: sem ela, `undefined === undefined` devolvia a PRIMEIRA
  // configuração da empresa a quem pedia uma segunda.
  const chave = typeof input.idempotencyKey === 'string' && input.idempotencyKey.trim() !== ''
    ? input.idempotencyKey
    : null;
  if (chave) {
    const existing = findOneRow(
      'payment_terminal_configurations',
      (r) => r.idempotencyKey === chave && r.companyId === input.companyId,
    );
    if (existing) return existing;
  }
  const ligada = driver.channel === 'mock' ? input.active !== false : false;
  return insertRow('payment_terminal_configurations', {
    // Ver a nota sobre `Date.now()` em
    // `createAndProcessPaymentTerminalTransactionBackend`: o relógio em
    // milissegundos não é identidade.
    id: `ptcfg-${randomUUID()}`,
    primary: false,
    environment: 'sandbox',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...input,
    provider,
    connectionMode,
    pdvTerminalId: caixa?.id ?? null,
    active: ligada,
  });
}

/**
 * Edita uma maquininha: nome, identificador do aparelho, caixa e canal.
 *
 * Mudar o CAIXA de uma maquininha ligada muda para qual agente a cobrança vai
 * — por isso a mudança é conferida como uma religação: o agente do caixa novo
 * tem de estar pareado. Canal sem implementação é recusado sempre.
 */
export function updatePaymentTerminalConfigurationBackend(input: {
  companyId: string;
  userId: string;
  configurationId: string;
  displayName?: unknown;
  terminalIdentifier?: unknown;
  pdvTerminalId?: unknown;
  connectionMode?: unknown;
  primary?: unknown;
}): Record<string, unknown> {
  const row = findOneRow<Record<string, unknown>>(
    'payment_terminal_configurations',
    (r) => r.id === input.configurationId && r.companyId === input.companyId,
  );
  if (!row) {
    throw new ApiError(
      'PAYMENT_TERMINAL_CONFIGURATION_NOT_FOUND',
      'Configuração de maquininha não encontrada nesta operação.',
      404,
    );
  }
  const patch: Record<string, unknown> = {};
  if (input.displayName !== undefined) {
    const nome = String(input.displayName ?? '').trim();
    if (!nome) {
      throw new ApiError('PAYMENT_TERMINAL_NAME_REQUIRED', 'Dê um nome à maquininha (ex.: "PinPad do Caixa 1").', 400);
    }
    patch.displayName = nome.slice(0, 80);
  }
  if (input.terminalIdentifier !== undefined) {
    patch.terminalIdentifier = String(input.terminalIdentifier ?? '').trim().slice(0, 80) || null;
  }
  if (input.pdvTerminalId !== undefined) {
    const caixa = input.pdvTerminalId
      ? assertTerminalDaEmpresa(input.companyId, String(input.pdvTerminalId), { exigirAtivo: true })
      : null;
    patch.pdvTerminalId = caixa?.id ?? null;
  }
  if (input.connectionMode !== undefined) {
    patch.connectionMode = String(input.connectionMode);
  }
  if (input.primary !== undefined) patch.primary = input.primary === true;
  const depois = { ...row, ...patch };
  const driver = assertCanalImplementado(depois);
  if (depois.active !== false && driver.channel === 'local_agent') {
    exigirAgentePareado(input.companyId, (depois.pdvTerminalId as string | null | undefined) ?? null);
  }
  const agora = new Date().toISOString();
  withTransaction(() => {
    updateRows<Record<string, unknown>>(
      'payment_terminal_configurations',
      (r) => r.id === row.id && r.companyId === input.companyId,
      (r) => ({ ...r, ...patch, updatedAt: agora, updatedBy: input.userId }),
    );
    insertRow('payment_terminal_history', {
      id: `pthist-${randomUUID()}`,
      companyId: input.companyId,
      configurationId: row.id,
      provider: row.provider,
      action: 'configuration_updated',
      changes: Object.keys(patch),
      userId: input.userId,
      createdAt: agora,
    });
    recordAudit({
      companyId: input.companyId,
      userId: input.userId,
      action: 'payment_terminal.configuration.updated',
      entityType: 'payment_terminal_configuration',
      entityId: String(row.id),
      detail: { provider: row.provider, changes: patch },
    });
  });
  const atualizada = findOneRow<Record<string, unknown>>(
    'payment_terminal_configurations',
    (r) => r.id === row.id && r.companyId === input.companyId,
  );
  return sanitizePaymentTerminalCredential(atualizada ?? depois);
}

/** Maquininha pelo agente local só liga com o agente DAQUELE caixa pareado. */
function exigirAgentePareado(companyId: string, pdvTerminalId: string | null): Record<string, unknown> {
  const agente = agenteDoCaixa(companyId, pdvTerminalId);
  if (!agente) {
    throw new ApiError(
      'PAYMENT_TERMINAL_AGENT_NOT_PAIRED',
      pdvTerminalId
        ? 'Nenhum agente local pareado para o caixa desta maquininha. Gere o código de pareamento em '
          + 'Configurações › Maquininhas e informe-o no agente instalado no computador do caixa.'
        : 'Nenhum agente local pareado para a operação. Gere o código de pareamento em '
          + 'Configurações › Maquininhas e informe-o no agente instalado no computador do caixa.',
      409,
      { pdvTerminalId },
    );
  }
  return agente;
}

/**
 * As configurações COMO ESTÃO GRAVADAS, para quem decide com elas.
 *
 * `listPaymentTerminalConfigurationsBackend` devolve a forma sanitizada, que é
 * a certa para responder a uma tela — e foi lendo ESSA forma que
 * `getTerminalStatus` deixou de enxergar `active` (GAP-PRD-001). Quem decide
 * se o balcão exige cobrança no aparelho lê a linha inteira, aqui; quem mostra
 * lê a sanitizada. Nada daqui sai para a rede.
 */
export function listPaymentTerminalConfigurationsRaw(companyId: string): Record<string, unknown>[] {
  return findRows<Record<string, unknown>>(
    'payment_terminal_configurations',
    (r) => r.companyId === companyId,
  );
}

/**
 * Liga ou desliga uma configuração de maquininha (GAP-PRD-001).
 *
 * NÃO EXISTIA COMO DESLIGAR. A linha `mock` ativa no banco real da Preço Justo
 * só sairia com alguém abrindo o SQLite à mão. Aqui é o caminho do gestor:
 *
 * - DESLIGAR sempre pode, em qualquer ambiente — inclusive, e principalmente,
 *   em produção, onde a linha de teste é o problema. Sem trava de mock aqui.
 * - RELIGAR passa pela trava do mock: religar o provider de teste em produção
 *   seria recriar pelo caminho de volta a porta que a criação já fecha.
 * - Motivo obrigatório nos dois sentidos, e o registro vai para a auditoria e
 *   para o histórico do módulo com o nome de quem decidiu. Desligar a
 *   maquininha desliga a exigência de cobrança aprovada no cartão
 *   (`assertCardPaymentBackedByTerminal`): é decisão sobre dinheiro, e fica
 *   com dono.
 * - A cerca é por empresa: id de outra operação é "não existe" (404), sem
 *   confirmar que existe em outro lugar.
 */
export function setPaymentTerminalConfigurationActiveBackend(input: {
  companyId: string;
  userId: string;
  configurationId: string;
  active: boolean;
  reason: string;
}): Record<string, unknown> {
  const row = findOneRow<Record<string, unknown>>(
    'payment_terminal_configurations',
    (r) => r.id === input.configurationId && r.companyId === input.companyId,
  );
  if (!row) {
    throw new ApiError(
      'PAYMENT_TERMINAL_CONFIGURATION_NOT_FOUND',
      'Configuração de maquininha não encontrada nesta operação.',
      404,
    );
  }
  const reason = String(input.reason ?? '').trim();
  if (!reason) {
    throw new ApiError(
      'PAYMENT_TERMINAL_REASON_REQUIRED',
      input.active
        ? 'Informe por que esta maquininha volta a ser usada no balcão.'
        : 'Informe por que esta maquininha está sendo desligada.',
      400,
    );
  }
  const ligadaHoje = row.active !== false;
  if (ligadaHoje === input.active) {
    throw new ApiError(
      input.active
        ? 'PAYMENT_TERMINAL_CONFIGURATION_ALREADY_ACTIVE'
        : 'PAYMENT_TERMINAL_CONFIGURATION_ALREADY_INACTIVE',
      input.active ? 'Esta maquininha já está ligada.' : 'Esta maquininha já está desligada.',
      409,
    );
  }
  if (input.active) {
    assertMockProviderAllowed(String(row.provider ?? 'mock'));
    /*
      LIGAR É PROMETER AO BALCÃO QUE O CARTÃO PASSA PELO APARELHO (GAP-PRD-014).

      Ligada, a maquininha faz toda venda em cartão exigir a cobrança aprovada.
      Se o caminho não existe (nuvem sem adaptador) ou ninguém está do outro
      lado (agente não pareado), ligar é parar o cartão da loja — exatamente o
      que a auditoria mediu. Então: canal implementado e, no agente local, o
      agente daquele caixa pareado.
    */
    const driver = assertCanalImplementado(row);
    if (driver.channel === 'local_agent') {
      exigirAgentePareado(input.companyId, (row.pdvTerminalId as string | null | undefined) ?? null);
    }
  }

  const agora = new Date().toISOString();
  const patch: Record<string, unknown> = input.active
    ? { active: true, activatedAt: agora, activatedBy: input.userId, activationReason: reason }
    : { active: false, deactivatedAt: agora, deactivatedBy: input.userId, deactivationReason: reason };

  withTransaction(() => {
    updateRows<Record<string, unknown>>(
      'payment_terminal_configurations',
      (r) => r.id === row.id && r.companyId === input.companyId,
      (r) => ({ ...r, ...patch, updatedAt: agora }),
    );
    insertRow('payment_terminal_history', {
      id: `pthist-${randomUUID()}`,
      companyId: input.companyId,
      configurationId: row.id,
      provider: row.provider,
      action: input.active ? 'configuration_activated' : 'configuration_deactivated',
      reason,
      userId: input.userId,
      createdAt: agora,
    });
    recordAudit({
      companyId: input.companyId,
      userId: input.userId,
      action: input.active
        ? 'payment_terminal.configuration.activated'
        : 'payment_terminal.configuration.deactivated',
      entityType: 'payment_terminal_configuration',
      entityId: String(row.id),
      detail: { provider: row.provider, reason, simulated: row.provider === 'mock' },
    });
  });

  const atualizada = findOneRow<Record<string, unknown>>(
    'payment_terminal_configurations',
    (r) => r.id === row.id && r.companyId === input.companyId,
  );
  return sanitizePaymentTerminalCredential(atualizada ?? { ...row, ...patch });
}

/**
 * Configurações do provider de TESTE ainda ligadas, em todas as operações.
 *
 * É a pergunta que a prontidão de go-live faz (GAP-PRD-001): "alguma empresa
 * em operação real está com a maquininha que aprova sem dinheiro?". Leitura
 * pura, sem escrever nada.
 */
export function listActiveTestTerminalConfigurations(): {
  companyId: string;
  configurationId: string;
  provider: string;
  displayName: string | null;
}[] {
  return findRows<Record<string, unknown>>(
    'payment_terminal_configurations',
    (r) => r.provider === 'mock' && r.active !== false,
  ).map((r) => ({
    companyId: String(r.companyId),
    configurationId: String(r.id),
    provider: String(r.provider),
    displayName: (r.displayName as string | undefined) ?? null,
  }));
}

export function listPaymentTerminalTransactionsBackend(companyId: string, storeId?: string) {
  return findRows('payment_terminal_transactions', (r) => r.companyId === companyId && (!storeId || r.storeId === storeId));
}

/**
 * O que a cobrança pede — forma, valor e parcelas (RES-IDEM-VIZ). O cenário
 * do mock, o caixa e a gaveta ficam fora: o reenvio do PDV é o mesmo pedido
 * mesmo quando a gaveta do turno já é outra.
 */
function impressaoDaCobranca(entrada: Record<string, unknown>): string {
  return Impressao.impressaoDe({
    forma: String(entrada.paymentMethod ?? 'credit'),
    valor: Math.round(Number(entrada.amountInCents ?? 0)) || 0,
    parcelas: Math.round(Number(entrada.installments ?? 1)) || 1,
  });
}

/** A cobrança achada pela chave pedia OUTRA coisa? Então é 422 (RES-IDEM-VIZ). */
function recusarSeOutraCobranca(existente: Record<string, unknown>, impressao: unknown): void {
  if (typeof impressao !== 'string') return;
  if (Impressao.outraImpressao(existente.idempotencyFingerprint, impressao)) {
    throw Impressao.chaveReusada('outra cobrança na maquininha', { transactionId: existente.id });
  }
}

export async function createAndProcessPaymentTerminalTransactionBackend(entrada: Record<string, unknown>) {
  const companyId = String(entrada.companyId);

  /*
    A CHAVE DE IDEMPOTÊNCIA É DA EMPRESA, NÃO DO GRUPO.

    O lookup era global: `r.idempotencyKey === input.idempotencyKey`, sem olhar
    de quem era a linha. Com seis operações no mesmo banco, duas chaves iguais
    vindas de empresas diferentes devolviam A TRANSAÇÃO DA OUTRA EMPRESA — e a
    resposta traz valor, bandeira, cartão mascarado e código de autorização.
    Vazamento de tenant e cobrança que não acontece, no mesmo gesto: a segunda
    empresa acharia que cobrou, e ninguém teria cobrado nada dela.

    Com o PDV mandando uuid o risco é teórico; com um integrador mandando
    `venda-1`, `caixa-2` ou a data do dia, é o caso normal. Idempotência é
    promessa de "o MESMO pedido não repete" — e pedido de outra empresa nunca
    foi o mesmo pedido.
  */
  const idempotencyKey = String(entrada.idempotencyKey ?? '').trim();
  if (!idempotencyKey) {
    throw new ApiError(
      'PAYMENT_TERMINAL_IDEMPOTENCY_REQUIRED',
      'Cobrança na maquininha exige chave de idempotência: sem ela, um reenvio cobraria o cliente duas vezes.',
      400,
    );
  }
  const provider = String(entrada.provider ?? 'mock') as PaymentTerminalProviderId;
  // A trava do mock vem ANTES de qualquer escrita: em produção, nem a linha
  // `in_progress` nem a reserva da chave podem nascer para ele.
  assertMockProviderAllowed(provider);

  /*
    A MESMA CHAVE COM OUTRA COBRANÇA NÃO É O REENVIO (RES-IDEM-VIZ).

    A transação da chave era devolvida sem olhar o que se pedia: a mesma chave
    com R$ 250 em vez de R$ 150 respondia a cobrança de R$ 150 como se fosse a
    nova, e o balcão fechava a venda contra um valor que ninguém cobrou. A
    impressão (forma, valor, parcelas) é conferida AQUI, antes da promessa em
    voo e de qualquer reserva, e gravada na linha; cobrança anterior a ela
    segue a regra de sempre.
  */
  const impressao = impressaoDaCobranca(entrada);
  const jaCobrada = cobrancaDaChave(companyId, idempotencyKey);
  if (jaCobrada) recusarSeOutraCobranca(jaCobrada, impressao);
  const input: Record<string, unknown> = { ...entrada, idempotencyFingerprint: impressao };

  /*
    UMA COBRANÇA POR CHAVE, MESMO COM DUAS CHAMADAS AO MESMO TEMPO (GAP-PRD-008).

    O desenho antigo era "busca a chave → await provedor → grava". Com o
    provedor levando segundos (aparelho real: cliente digitando senha), duas
    requisições com a mesma chave passavam as duas pela busca antes de
    qualquer uma gravar — reenvio do PDV depois de um timeout, clique repetido,
    a fila offline despejando — e o cliente era cobrado DUAS VEZES. E se o
    processo morresse durante o `await`, nenhuma linha existia: o cliente
    podia ter sido cobrado e o ERP não sabia.

    Agora são três passos, nesta ordem:

      1. Chamada DESTE processo ainda em voo com a mesma chave? Espera por ela
         e devolve o mesmo resultado — o provedor não é chamado de novo.
      2. Reserva a chave NO BANCO (PRIMARY KEY em
         `core_payment_terminal_charge_keys`) e cria a transação `in_progress`
         com `providerCallState: 'awaiting_provider'`, numa transação só,
         ANTES de falar com o provedor. Se a chave já estava reservada, a
         linha que já existe é a resposta.
      3. Fala com o provedor, e grava o que ele disse na MESMA linha.

    Se o processo cair entre 2 e 3, a linha fica `awaiting_provider` sem
    ninguém esperando por ela — e o balcão a vê como NÃO CONFIRMADA
    (`isTerminalChargeOrphan`), na fila de conferência do gestor. Nunca é
    cobrada de novo sozinha.
  */
  const chave = chaveEmVoo(companyId, idempotencyKey);
  const emVoo = COBRANCAS_EM_VOO.get(chave);
  if (emVoo) return emVoo;

  /*
    POR ONDE ESTA COBRANÇA VAI (GAP-PRD-014).

    - Agente local: a cobrança nasce `in_progress` com o comando
      `startPayment` na fila, NA MESMA transação da reserva da chave, e a
      resposta volta depois, pelo agente. Não há `await` de provedor aqui: o
      PDV consulta a cobrança até ela sair de "processando".
    - Nuvem sem adaptador: recusada ANTES de nascer qualquer linha. Antes ela
      nascia e morria `failed` — e o balcão, que exigia cobrança aprovada, não
      fechava cartão nenhum.
    - Mock (dev/teste): o caminho síncrono de sempre, abaixo.
  */
  const config = configuracaoDaCobranca(companyId, input, provider);
  const canal = config ? canalDe(config) : provider === 'mock' ? 'mock' : 'cloud';
  if (canal === 'local_agent') {
    return cobrarPeloAgente(companyId, idempotencyKey, input, config!);
  }
  if (canal === 'cloud') {
    const existente = cobrancaDaChave(companyId, idempotencyKey);
    if (existente) return existente;
    const driver = driverDe(config ?? { provider, connectionMode: 'cloud' });
    throw new ApiError(
      'PAYMENT_TERMINAL_CHANNEL_NOT_IMPLEMENTED',
      String(driver.reason),
      409,
      { provider, channel: 'cloud' },
    );
  }

  const reserva = reservarCobranca(companyId, idempotencyKey, input);
  if (!reserva.nova) return reserva.linha;

  // Tudo daqui até o `set` é síncrono: nenhuma outra chamada JS entra entre a
  // reserva e o registro da promessa em voo.
  const execucao = executarCobrancaNoProvedor(reserva.linha, provider, input).finally(() => {
    COBRANCAS_EM_VOO.delete(chave);
  });
  COBRANCAS_EM_VOO.set(chave, execucao);
  return execucao;
}

/**
 * Cobranças deste processo esperando resposta do provedor, por (empresa, chave).
 *
 * Mora em memória de propósito: é a resposta à pergunta "tem alguém VIVO
 * esperando por esta cobrança?". Depois de um reinício ela nasce vazia — e é
 * exatamente isso que faz a linha `awaiting_provider` que sobrou virar "não
 * confirmada" em vez de "processando" para sempre.
 */
const COBRANCAS_EM_VOO = new Map<string, Promise<Record<string, unknown>>>();

function chaveEmVoo(companyId: string, idempotencyKey: string): string {
  // Par serializado, e não concatenado: nenhuma chave de integrador consegue
  // se passar pela de outra empresa escolhendo um separador.
  return JSON.stringify([companyId, idempotencyKey]);
}

/** Existe chamada viva, neste processo, esperando o provedor desta cobrança? */
export function isTerminalChargeInFlight(companyId: string, idempotencyKey: string): boolean {
  return COBRANCAS_EM_VOO.has(chaveEmVoo(companyId, idempotencyKey));
}

/**
 * A cobrança ficou "falando com o provedor" sem ninguém esperando por ela?
 *
 * É o rastro de um processo que morreu no meio da chamada (ou de um erro ao
 * gravar a resposta). Ninguém sabe se o cliente foi cobrado — e o sistema não
 * decide sozinho: o balcão a trata como NÃO CONFIRMADA.
 */
export function isTerminalChargeOrphan(row: Record<string, unknown>): boolean {
  return (
    row.status === 'in_progress'
    && row.providerCallState === 'awaiting_provider'
    && !isTerminalChargeInFlight(String(row.companyId), String(row.idempotencyKey ?? ''))
  );
}

/** Só para testes: simula o reinício do processo (as promessas em voo somem). */
export function resetTerminalChargesInFlightForTests(): void {
  COBRANCAS_EM_VOO.clear();
}

/**
 * Passo 2: reserva a chave e cria a linha `in_progress`, atomicamente.
 *
 * `withTransaction` abre com BEGIN IMMEDIATE: um segundo PROCESSO no mesmo
 * banco espera o commit deste e, ao entrar, já enxerga a reserva. A PRIMARY
 * KEY da tabela de reservas é o cinto por baixo do suspensório.
 */
function reservarCobranca(
  companyId: string,
  idempotencyKey: string,
  input: Record<string, unknown>,
  opcoes: {
    providerCallState?: string;
    /** Roda DENTRO da transação da reserva, com a linha recém-criada; o que devolve é gravado nela. */
    aoCriar?: (linha: Record<string, unknown>) => Record<string, unknown>;
  } = {},
): { nova: boolean; linha: Record<string, unknown> } {
  ensureCoreSchema();
  return withTransaction(() => {
    // Linhas anteriores a esta reserva existir (e as de sempre) continuam
    // respondendo pela chave.
    const existente = findOneRow<Record<string, unknown>>(
      'payment_terminal_transactions',
      (r) => r.idempotencyKey === idempotencyKey && r.companyId === companyId,
    );
    if (existente) {
      // A conferência de novo, dentro da transação: outro processo pode ter
      // reservado a chave entre a primeira conferência e esta (RES-IDEM-VIZ).
      recusarSeOutraCobranca(existente, input.idempotencyFingerprint);
      return { nova: false, linha: existente };
    }

    const db = getConnection();
    const reservada = db
      .prepare(
        `SELECT transaction_id FROM core_payment_terminal_charge_keys
          WHERE company_id = ? AND idempotency_key = ?`,
      )
      .get(companyId, idempotencyKey) as { transaction_id: string } | undefined;
    if (reservada) {
      const dela = findOneRow<Record<string, unknown>>(
        'payment_terminal_transactions',
        (r) => r.id === reservada.transaction_id && r.companyId === companyId,
      );
      if (dela) {
        recusarSeOutraCobranca(dela, input.idempotencyFingerprint);
        return { nova: false, linha: dela };
      }
      // Reserva sem transação: a linha foi apagada por fora (limpeza de
      // teste, restauração parcial). A chave não protege mais nada — é
      // liberada e reaproveitada por esta cobrança.
      db.prepare(
        'DELETE FROM core_payment_terminal_charge_keys WHERE company_id = ? AND idempotency_key = ?',
      ).run(companyId, idempotencyKey);
    }

    const agora = new Date().toISOString();
    /*
      O ID VEM DE UM UUID, E NÃO DO RELÓGIO.

      Era `pttx-${Date.now()}`: duas cobranças no MESMO milissegundo nasciam com
      o mesmo id, e a coleção não tem UNIQUE nessa coluna — as duas linhas
      entravam. `getPaymentTerminalTransactionBackend` devolve a primeira que
      casar, então a segunda cobrança ficava inalcançável e a consulta pela
      "dela" respondia com a de outra pessoa: valor, bandeira e cartão
      mascarado trocados.

      Isso deixou de ser teórico quando a venda passou a se AMARRAR à transação
      (GAP-V48): id ambíguo ali significa venda fechada contra a cobrança
      errada. Relógio em milissegundos nunca foi identidade.
    */
    const id = `pttx-${randomUUID()}`;
    db.prepare(
      `INSERT INTO core_payment_terminal_charge_keys
         (company_id, idempotency_key, transaction_id, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run(companyId, idempotencyKey, id, agora);

    const linha = insertRow('payment_terminal_transactions', {
      ...input,
      id,
      companyId,
      idempotencyKey,
      status: 'in_progress',
      providerCallState: opcoes.providerCallState ?? 'awaiting_provider',
      providerCallStartedAt: agora,
      startedAt: agora,
    });
    if (opcoes.aoCriar) {
      return { nova: true, linha: gravarNaCobranca(companyId, id, opcoes.aoCriar(linha)) };
    }
    return { nova: true, linha };
  });
}

/** A cobrança que já existe para esta chave, nesta empresa — ou nada. */
function cobrancaDaChave(companyId: string, idempotencyKey: string): Record<string, unknown> | null {
  return (
    findOneRow<Record<string, unknown>>(
      'payment_terminal_transactions',
      (r) => r.idempotencyKey === idempotencyKey && r.companyId === companyId,
    ) ?? null
  );
}

/**
 * A configuração que atende esta cobrança.
 *
 * O PDV manda a configuração que o balcão escolheu para o caixa dele
 * (`getTerminalStatus`); a rota do módulo pode mandar `terminalConfigurationId`.
 * Sem nenhuma das duas, vale a primeira LIGADA do provedor (o comportamento
 * de antes, para quem integrava sem saber de caixa).
 */
function configuracaoDaCobranca(
  companyId: string,
  input: Record<string, unknown>,
  provider: string,
): Record<string, unknown> | null {
  const id = (input.configurationId ?? input.terminalConfigurationId) as string | undefined;
  if (id) {
    const row = findOneRow<Record<string, unknown>>(
      'payment_terminal_configurations',
      (r) => r.id === id && r.companyId === companyId,
    );
    if (!row) {
      throw new ApiError(
        'PAYMENT_TERMINAL_CONFIGURATION_NOT_FOUND',
        'Configuração de maquininha não encontrada nesta operação.',
        404,
      );
    }
    assertMockProviderAllowed(String(row.provider ?? 'mock'));
    return row;
  }
  const doProvedor = findRows<Record<string, unknown>>(
    'payment_terminal_configurations',
    (r) => r.companyId === companyId && r.provider === provider,
  );
  return doProvedor.find((r) => r.active !== false) ?? doProvedor[0] ?? null;
}

/**
 * A cobrança pelo AGENTE LOCAL (GAP-PRD-014): reserva a chave, grava a linha
 * `in_progress` e põe o `startPayment` na fila — tudo numa transação.
 *
 * Nada é cobrado se o agente daquele caixa não está pareado ou está fora do
 * ar: a recusa vem ANTES da reserva, com o que fazer. Um reenvio com a mesma
 * chave devolve a cobrança que já existe, esteja o agente como estiver.
 */
function cobrarPeloAgente(
  companyId: string,
  idempotencyKey: string,
  input: Record<string, unknown>,
  config: Record<string, unknown>,
): Record<string, unknown> {
  const existente = cobrancaDaChave(companyId, idempotencyKey);
  if (existente) return existente;
  if (config.active === false) {
    throw new ApiError(
      'PAYMENT_TERMINAL_CONFIGURATION_INACTIVE',
      'Esta maquininha está desligada. Um gerente pode ligá-la em Configurações › Maquininhas.',
      409,
      { configurationId: config.id },
    );
  }
  const pdvTerminalId = (config.pdvTerminalId as string | null | undefined) ?? null;
  const agente = exigirAgentePareado(companyId, pdvTerminalId);
  if (!agenteOnline(agente)) {
    const visto = agente.lastSeenAt ? new Date(String(agente.lastSeenAt)) : null;
    throw new ApiError(
      'PAYMENT_TERMINAL_AGENT_OFFLINE',
      'O agente local da maquininha está fora do ar'
        + (visto ? ` (último sinal em ${visto.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })})` : '')
        + '. NADA foi cobrado. Confira se o computador do caixa está ligado e o agente rodando — '
        + 'ou peça ao gerente para desligar a maquininha e lançar o cartão à mão.',
      409,
      { agentId: agente.id, lastSeenAt: agente.lastSeenAt ?? null },
    );
  }
  expirarComandosVencidos(companyId);
  const metodo = String(input.paymentMethod ?? 'credit');
  const reserva = reservarCobranca(
    companyId,
    idempotencyKey,
    {
      ...input,
      provider: config.provider,
      configurationId: config.id,
      channel: 'local_agent',
      agentId: agente.id,
      pdvTerminalId,
      simulated: false,
    },
    {
      providerCallState: 'awaiting_agent',
      aoCriar: (linha) => {
        const comando = enfileirarComando({
          companyId,
          agentId: String(agente.id),
          command: 'startPayment',
          configurationId: String(config.id),
          pdvTerminalId,
          transactionId: String(linha.id),
          requestedBy: (input.createdBy as string | undefined) ?? null,
          payload: {
            transactionId: linha.id,
            amountInCents: Number(input.amountInCents ?? 0),
            paymentMethod: metodo,
            installments: Number(input.installments ?? 1),
            provider: config.provider,
            providerName: NOME_DO_PROVEDOR[String(config.provider)] ?? config.provider,
            terminalIdentifier: config.terminalIdentifier ?? null,
            // Referência curta para o documento do cliente TEF (campo de
            // número de documento): os oito últimos do id, sem hífen.
            reference: String(linha.id).replace(/-/g, '').slice(-8).toUpperCase(),
          },
        });
        return { agentCommandId: comando.id, agentStage: 'queued' };
      },
    },
  );
  return reserva.linha;
}

/**
 * Passo 3: fala com o provedor e grava a resposta na linha que já existe.
 *
 * Se o provedor estourar no meio (rede caiu, SDK lançou), a resposta honesta é
 * "não sei": `timeout_uncertain` — nunca `failed`, que o balcão lê como
 * recusado e convidaria a cobrar de novo um cliente que pode ter pago.
 */
async function executarCobrancaNoProvedor(
  linha: Record<string, unknown>,
  provider: PaymentTerminalProviderId,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const companyId = String(linha.companyId);
  const id = String(linha.id);
  let result: PaymentTerminalAdapterResult;
  try {
    result = await processPaymentTerminalTransaction(companyId, provider, {
      paymentMethod: String(input.paymentMethod ?? 'credit'),
      amountInCents: Number(input.amountInCents ?? 0),
      installments: Number(input.installments ?? 1),
      scenario: input.scenario as string | undefined,
      storeId: input.storeId as string | undefined,
    });
  } catch (err) {
    return gravarRespostaDoProvedor(companyId, id, {
      status: 'timeout_uncertain',
      providerCallState: 'failed',
      providerAnsweredAt: new Date().toISOString(),
      providerError: err instanceof Error ? err.message : String(err),
    });
  }

  const agora = new Date().toISOString();
  return withTransaction(() => {
    const atual = findOneRow<Record<string, unknown>>(
      'payment_terminal_transactions',
      (r) => r.id === id && r.companyId === companyId,
    );
    if (atual && atual.providerCallState !== 'awaiting_provider') {
      return respostaAtrasada(atual, result.status ?? (result.ok ? 'authorized' : 'failed'));
    }
    const final = gravarNaCobranca(companyId, id, {
      status: result.status ?? (result.ok ? 'authorized' : 'failed'),
      providerCallState: 'answered',
      providerAnsweredAt: agora,
      authorizedAt: result.ok ? agora : undefined,
      providerTransactionId: result.providerTransactionId,
      providerNsu: result.providerNsu,
      providerTid: result.providerTid,
      providerAuthorizationCode: result.authorizationCode,
      providerMessage: result.message,
      maskedCard: result.maskedCard,
      cardBrand: result.cardBrand,
      // Copia-e-cola do PIX. Sem gravar aqui, o QR morreria na resposta da
      // adaptadora e a tela não teria o que mostrar depois de um refresh.
      qrPayload: result.qrPayload,
      simulated: result.simulated,
      real: result.real,
    });
    guardarComprovante(final, result);
    return final;
  });
}

/**
 * Grava a falha da chamada — só se a linha ainda está esperando o provedor.
 */
function gravarRespostaDoProvedor(
  companyId: string,
  id: string,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  return withTransaction(() => {
    const atual = findOneRow<Record<string, unknown>>(
      'payment_terminal_transactions',
      (r) => r.id === id && r.companyId === companyId,
    );
    if (atual && atual.providerCallState !== 'awaiting_provider') {
      return respostaAtrasada(atual, String(patch.status));
    }
    return gravarNaCobranca(companyId, id, patch);
  });
}

/*
  `respostaAtrasada`, `gravarNaCobranca` e `guardarComprovante` moram em
  `PaymentTerminalTransactionEffects.ts` (GAP-PRD-014): o agente local grava a
  resposta dele pelas MESMAS funções que o caminho síncrono, e o relatório
  conta igual a mesma operação, venha ela de onde vier.
*/

/*
  Aqui existiu um `createPaymentTerminalTransactionBackend` sem chamador: a
  transação de maquininha nasce pelo fluxo do módulo (rota própria, com
  idempotência checada lá) e pelo PdvTerminalService no core. Um terceiro
  criador, que gravava direto na camada JSON sem passar por nenhuma das duas
  disciplinas, era o atalho que um dia produziria transação sem rastro.
*/

export function getPaymentTerminalTransactionBackend(companyId: string, id: string) {
  return findOneRow('payment_terminal_transactions', (r) => r.id === id && r.companyId === companyId);
}

export function updatePaymentTerminalTransactionBackend(id: string, patch: Record<string, unknown>) {
  updateRows('payment_terminal_transactions', (r) => r.id === id, (r) => ({ ...r, ...patch, updatedAt: new Date().toISOString() }));
  return findOneRow('payment_terminal_transactions', (r) => r.id === id);
}

// ============================================================================
// CANCELAR E ESTORNAR (GAP-PRD-079)
// ============================================================================

/*
  O ESTADO SÓ MUDA COM A CONFIRMAÇÃO DO PROVEDOR.

  As rotas do módulo faziam `status: result.status ?? 'cancelled'` (e
  `?? 'refunded'`). Para provedor real o adaptador responde `{ ok: false,
  pending: true }` sem status — e o `??` transformava "a operadora não fez
  nada" em cancelado/estornado. O relatório de maquininha passaria a dizer
  estornado o que continua cobrado no cartão do cliente.

  E nenhuma das duas olhava `saleId`: a cobrança que pagou uma venda podia ser
  estornada sem a venda saber — a venda continuaria paga, o estoque baixado, e
  o dinheiro devolvido. Cobrança amarrada a venda se desfaz desfazendo a
  VENDA (cancelamento/devolução), não por esta porta.

  Toda tentativa fica registrada (`payment_terminal_cancellations` /
  `payment_terminal_refunds`), inclusive a que o provedor não confirmou: é o
  rastro de "alguém pediu, e a operadora não respondeu".
*/

/** De onde se cancela: aprovada, ou ainda sem desfecho (PIX pendente, "não sei"). */
const CANCELAVEIS = new Set(['authorized', 'confirmed', 'in_progress', 'timeout_uncertain']);
/** De onde se estorna: só o que foi pago. */
const ESTORNAVEIS = new Set(['authorized', 'confirmed', 'partially_refunded']);

/** Cancelamento/estorno em curso por transação — o provedor não recebe dois pedidos iguais. */
const OPERACOES_EM_CURSO = new Set<string>();

function transacaoDaEmpresaOu404(companyId: string, transactionId: string): Record<string, unknown> {
  const tx = findOneRow<Record<string, unknown>>(
    'payment_terminal_transactions',
    (r) => r.id === transactionId && r.companyId === companyId,
  );
  if (!tx) {
    throw new ApiError(
      'PAYMENT_TERMINAL_TRANSACTION_NOT_FOUND',
      'Transação da maquininha não encontrada nesta operação.',
      404,
    );
  }
  return tx;
}

function exigirSemVenda(tx: Record<string, unknown>, acao: 'cancelar' | 'estornar'): void {
  if (!tx.saleId) return;
  /*
    A VENDA JÁ FOI DESFEITA (GAP-PRD-080): o cancelamento ou a devolução no
    cartão marcaram quanto desta cobrança está "a estornar". Esse valor — e só
    ele — passa por aqui: o estorno até o teto do que foi pedido, o
    cancelamento só quando o pedido cobre a cobrança inteira. Sem a marca, a
    venda continua valendo e a recusa de sempre fica.
  */
  const aEstornar = Number(tx.aEstornarCents ?? 0);
  if (aEstornar > 0) {
    if (acao === 'estornar') return;
    const restante = Number(tx.amountInCents ?? 0) - Number(tx.refundedAmountInCents ?? 0);
    if (aEstornar >= restante) return;
  }
  const numero = tx.saleNumber ?? tx.saleId;
  throw new ApiError(
    'PAYMENT_TERMINAL_TRANSACTION_BOUND_TO_SALE',
    `Esta cobrança pagou a venda ${String(numero)}. Para ${acao}, cancele ou devolva a VENDA — `
      + 'desfazer só a cobrança deixaria a venda paga com o dinheiro devolvido.',
    409,
    { transactionId: tx.id, saleId: tx.saleId, saleNumber: tx.saleNumber ?? null },
  );
}

function exigirMotivo(reason: string | undefined, acao: 'cancelar' | 'estornar'): string {
  const motivo = String(reason ?? '').trim();
  if (!motivo) {
    throw new ApiError(
      'PAYMENT_TERMINAL_REASON_REQUIRED',
      `Informe por que você está pedindo para ${acao} esta cobrança.`,
      400,
    );
  }
  return motivo;
}

function referenciaDaCobranca(tx: Record<string, unknown>): PaymentTerminalOperationRef {
  return {
    transactionId: String(tx.id),
    providerTransactionId: (tx.providerTransactionId as string | undefined) ?? undefined,
    providerNsu: (tx.providerNsu as string | undefined) ?? undefined,
    amountInCents: Number(tx.amountInCents ?? 0),
  };
}

/**
 * Pede ao provedor e interpreta a resposta SEM completar o que ele não disse.
 *
 * - `ok`: confirmado — quem chamou grava o novo estado.
 * - `pending`: a operadora não confirmou (adaptador estrutural, sem SDK) —
 *   409, a transação fica como estava.
 * - não ok e não pendente: a operadora RECUSOU — 409.
 * - o adaptador estourou: ninguém sabe o que aconteceu do outro lado — 502,
 *   com a instrução de conferir o extrato antes de repetir.
 *
 * O `ApiError` lançado pelo próprio adaptador (a trava do mock em produção)
 * sobe como está.
 */
async function pedirAoProvedor(
  operacao: 'cancel' | 'refund',
  tx: Record<string, unknown>,
  registrar: (outcome: string, result: Partial<PaymentTerminalAdapterResult>) => void,
): Promise<PaymentTerminalAdapterResult> {
  const provider = String(tx.provider ?? 'mock') as PaymentTerminalProviderId;
  const companyId = String(tx.companyId);
  const ref = referenciaDaCobranca(tx);
  let result: PaymentTerminalAdapterResult;
  try {
    result = operacao === 'cancel'
      ? await cancelPaymentTerminalTransaction(companyId, provider, tx.storeId as string | undefined, ref)
      : await refundPaymentTerminalTransaction(companyId, provider, tx.storeId as string | undefined, ref);
  } catch (err) {
    if (err instanceof ApiError) throw err;
    registrar('error', { message: err instanceof Error ? err.message : String(err) });
    throw new ApiError(
      'PAYMENT_TERMINAL_PROVIDER_ERROR',
      'Não foi possível confirmar com a operadora. A transação continua como estava — confira o '
        + 'extrato da operadora antes de pedir de novo.',
      502,
      { transactionId: tx.id },
    );
  }
  if (result.ok) {
    registrar('confirmed', result);
    return result;
  }
  if (result.pending) {
    registrar('pending_provider', result);
    throw new ApiError(
      'PAYMENT_TERMINAL_PROVIDER_PENDING',
      `A operadora não confirmou o ${operacao === 'cancel' ? 'cancelamento' : 'estorno'}: a transação `
        + `continua como estava. ${result.message ?? ''}`.trim(),
      409,
      { transactionId: tx.id, provider },
    );
  }
  registrar('declined', result);
  throw new ApiError(
    'PAYMENT_TERMINAL_PROVIDER_DECLINED',
    `A operadora recusou o ${operacao === 'cancel' ? 'cancelamento' : 'estorno'}. ${result.message ?? ''}`.trim(),
    409,
    { transactionId: tx.id, provider },
  );
}

async function comTrava<T>(companyId: string, transactionId: string, fn: () => Promise<T>): Promise<T> {
  const trava = JSON.stringify([companyId, transactionId]);
  if (OPERACOES_EM_CURSO.has(trava)) {
    throw new ApiError(
      'PAYMENT_TERMINAL_OPERATION_IN_PROGRESS',
      'Já existe um pedido em curso para esta cobrança. Aguarde a resposta da operadora.',
      409,
    );
  }
  OPERACOES_EM_CURSO.add(trava);
  try {
    return await fn();
  } finally {
    OPERACOES_EM_CURSO.delete(trava);
  }
}

export async function cancelPaymentTerminalTransactionBackend(input: {
  companyId: string;
  userId: string;
  transactionId: string;
  reason?: string;
}): Promise<Record<string, unknown>> {
  const tx = transacaoDaEmpresaOu404(input.companyId, input.transactionId);
  exigirSemVenda(tx, 'cancelar');
  const status = String(tx.status ?? '');
  const emVoo = status === 'in_progress'
    && (isTerminalChargeInFlight(input.companyId, String(tx.idempotencyKey ?? ''))
      || tx.providerCallState === 'awaiting_agent');
  if (!CANCELAVEIS.has(status) || emVoo) {
    throw new ApiError(
      'PAYMENT_TERMINAL_TRANSACTION_STATE_INVALID',
      emVoo
        ? tx.providerCallState === 'awaiting_agent'
          ? 'A cobrança ainda está no aparelho. Para desistir agora, cancele no próprio PinPad; '
            + 'depois que ele responder, o cancelamento pode ser pedido aqui.'
          : 'A cobrança ainda está sendo processada pela operadora. Aguarde a resposta antes de cancelar.'
        : `Uma cobrança "${status}" não pode ser cancelada.`,
      409,
      { transactionId: tx.id, status },
    );
  }
  const reason = exigirMotivo(input.reason, 'cancelar');
  assertMockProviderAllowed(String(tx.provider ?? 'mock'));

  // Cobrança feita pelo agente local se desfaz pelo agente local (GAP-PRD-014):
  // é ele quem fala com o cliente TEF que fez a cobrança.
  if (tx.channel === 'local_agent') {
    return pedirAoAgente('cancel', tx, { reason, userId: input.userId, amountInCents: Number(tx.amountInCents ?? 0) });
  }

  return comTrava(input.companyId, String(tx.id), async () => {
    const registrar = (outcome: string, result: Partial<PaymentTerminalAdapterResult>) => {
      registrarTentativa('cancel', {
        companyId: input.companyId,
        transactionId: String(tx.id),
        provider: tx.provider,
        outcome,
        reason,
        requestedBy: input.userId,
        providerMessage: result.message ?? null,
        simulated: result.simulated === true,
      });
    };
    const result = await pedirAoProvedor('cancel', tx, registrar);
    return aplicarCancelamentoConfirmado({
      companyId: input.companyId,
      transactionId: String(tx.id),
      userId: input.userId,
      reason,
      simulated: result.simulated === true,
    });
  });
}

export async function refundPaymentTerminalTransactionBackend(input: {
  companyId: string;
  userId: string;
  transactionId: string;
  amountInCents?: number | null;
  reason?: string;
}): Promise<Record<string, unknown>> {
  const tx = transacaoDaEmpresaOu404(input.companyId, input.transactionId);
  exigirSemVenda(tx, 'estornar');
  const status = String(tx.status ?? '');
  if (!ESTORNAVEIS.has(status)) {
    throw new ApiError(
      'PAYMENT_TERMINAL_TRANSACTION_STATE_INVALID',
      `Uma cobrança "${status}" não pode ser estornada: só se estorna o que foi pago.`,
      409,
      { transactionId: tx.id, status },
    );
  }
  const total = Number(tx.amountInCents ?? 0);
  const jaEstornado = Number(tx.refundedAmountInCents ?? 0);
  const restante = total - jaEstornado;
  // Cobrança de venda desfeita: o teto é o que a venda mandou estornar
  // (GAP-PRD-080), não a cobrança inteira.
  const teto = tx.saleId ? Math.min(restante, Number(tx.aEstornarCents ?? 0)) : restante;
  const pedido = input.amountInCents == null ? teto : Number(input.amountInCents);
  if (!Number.isInteger(pedido) || pedido <= 0 || pedido > teto) {
    throw new ApiError(
      'PAYMENT_TERMINAL_REFUND_AMOUNT_INVALID',
      tx.saleId
        ? `O estorno desta cobrança tem de ser um valor em centavos entre 1 e ${teto} (o que o `
          + 'cancelamento/devolução da venda mandou estornar).'
        : `O estorno tem de ser um valor em centavos entre 1 e ${restante} (o que ainda não foi estornado).`,
      400,
      { transactionId: tx.id, requested: input.amountInCents, remaining: teto },
    );
  }
  const reason = exigirMotivo(input.reason, 'estornar');
  assertMockProviderAllowed(String(tx.provider ?? 'mock'));

  if (tx.channel === 'local_agent') {
    return pedirAoAgente('refund', tx, { reason, userId: input.userId, amountInCents: pedido });
  }

  return comTrava(input.companyId, String(tx.id), async () => {
    const registrar = (outcome: string, result: Partial<PaymentTerminalAdapterResult>) => {
      registrarTentativa('refund', {
        companyId: input.companyId,
        transactionId: String(tx.id),
        provider: tx.provider,
        outcome,
        reason,
        requestedBy: input.userId,
        amountInCents: pedido,
        providerMessage: result.message ?? null,
        simulated: result.simulated === true,
      });
    };
    const result = await pedirAoProvedor('refund', { ...tx, amountInCents: pedido }, registrar);
    return aplicarEstornoConfirmado({
      companyId: input.companyId,
      transactionId: String(tx.id),
      userId: input.userId,
      reason,
      amountInCents: pedido,
      simulated: result.simulated === true,
    });
  });
}

/**
 * Cancelamento/estorno pelo AGENTE LOCAL (GAP-PRD-014).
 *
 * O pedido vai para a fila do agente que atende o caixa da cobrança; a
 * transação NÃO muda aqui. Muda quando o agente devolver "confirmado" — pela
 * mesma função do caminho síncrono (`aplicarCancelamentoConfirmado` /
 * `aplicarEstornoConfirmado`). Até lá a resposta é 202 com o comando, e um
 * segundo pedido para a mesma cobrança é recusado: a operadora não recebe
 * dois pedidos iguais.
 */
function pedirAoAgente(
  operacao: 'cancel' | 'refund',
  tx: Record<string, unknown>,
  pedido: { reason: string; userId: string; amountInCents: number },
): Record<string, unknown> {
  const companyId = String(tx.companyId);
  expirarComandosVencidos(companyId);
  const pendente = operacaoPendenteNoAgente(companyId, String(tx.id));
  if (pendente) {
    throw new ApiError(
      'PAYMENT_TERMINAL_OPERATION_IN_PROGRESS',
      'Já existe um pedido de cancelamento/estorno desta cobrança esperando o agente local. Aguarde a resposta.',
      409,
      { transactionId: tx.id, commandId: pendente.id },
    );
  }
  const pdvTerminalId = (tx.pdvTerminalId as string | null | undefined) ?? null;
  const agente = exigirAgentePareado(companyId, pdvTerminalId);
  if (!agenteOnline(agente)) {
    throw new ApiError(
      'PAYMENT_TERMINAL_AGENT_OFFLINE',
      'O agente local que fez esta cobrança está fora do ar. Nada foi pedido ao aparelho — ligue o '
        + 'computador do caixa e tente de novo.',
      409,
      { agentId: agente.id },
    );
  }
  const comando = withTransaction(() => {
    const cmd = enfileirarComando({
      companyId,
      agentId: String(agente.id),
      command: operacao,
      configurationId: (tx.configurationId as string | undefined) ?? null,
      pdvTerminalId,
      transactionId: String(tx.id),
      requestedBy: pedido.userId,
      payload: {
        transactionId: tx.id,
        amountInCents: pedido.amountInCents,
        originalAmountInCents: Number(tx.amountInCents ?? 0),
        paymentMethod: tx.paymentMethod ?? null,
        provider: tx.provider ?? null,
        acquirer: tx.acquirer ?? null,
        providerTransactionId: tx.providerTransactionId ?? null,
        nsu: tx.providerNsu ?? null,
        authorizationCode: tx.providerAuthorizationCode ?? null,
        authorizedAt: tx.authorizedAt ?? null,
        reason: pedido.reason,
      },
    });
    registrarTentativa(operacao, {
      companyId,
      transactionId: String(tx.id),
      provider: tx.provider,
      outcome: 'queued_to_agent',
      reason: pedido.reason,
      requestedBy: pedido.userId,
      amountInCents: pedido.amountInCents,
      commandId: cmd.id,
    });
    return cmd;
  });
  return {
    id: tx.id,
    status: tx.status ?? null,
    queuedToAgent: true,
    commandId: comando.id,
    operation: operacao,
    amountInCents: pedido.amountInCents,
    message:
      operacao === 'cancel'
        ? 'Pedido de cancelamento enviado ao agente local. A cobrança muda quando o aparelho confirmar.'
        : 'Pedido de estorno enviado ao agente local. A cobrança muda quando o aparelho confirmar.',
  };
}

/**
 * "Consulte no aparelho" — para a cobrança NÃO CONFIRMADA feita pelo agente.
 *
 * O cliente TEF sabe o desfecho de uma transação que o ERP não soube. O
 * gestor pede a consulta; a resposta do aparelho (aprovada, recusada, não
 * encontrada) resolve a pendência pela mesma regra da resposta tardia —
 * nunca por cima de uma decisão já tomada pelo extrato.
 */
export function queryPaymentTerminalTransactionOnAgentBackend(input: {
  companyId: string;
  userId: string;
  transactionId: string;
}): Record<string, unknown> {
  const tx = transacaoDaEmpresaOu404(input.companyId, input.transactionId);
  if (tx.channel !== 'local_agent') {
    throw new ApiError(
      'PAYMENT_TERMINAL_QUERY_NOT_AVAILABLE',
      'Só a cobrança feita pelo agente local pode ser consultada no aparelho. As demais se conferem no extrato.',
      409,
    );
  }
  if (tx.status !== 'timeout_uncertain') {
    throw new ApiError(
      'PAYMENT_TERMINAL_TRANSACTION_STATE_INVALID',
      `A cobrança está "${String(tx.status ?? '')}": só a não confirmada precisa de consulta.`,
      409,
    );
  }
  const companyId = input.companyId;
  expirarComandosVencidos(companyId);
  const pdvTerminalId = (tx.pdvTerminalId as string | null | undefined) ?? null;
  const agente = exigirAgentePareado(companyId, pdvTerminalId);
  if (!agenteOnline(agente)) {
    throw new ApiError(
      'PAYMENT_TERMINAL_AGENT_OFFLINE',
      'O agente local desta cobrança está fora do ar. Ligue o computador do caixa ou confira no extrato.',
      409,
      { agentId: agente.id },
    );
  }
  const cmd = enfileirarComando({
    companyId,
    agentId: String(agente.id),
    command: 'queryStatus',
    configurationId: (tx.configurationId as string | undefined) ?? null,
    pdvTerminalId,
    transactionId: String(tx.id),
    requestedBy: input.userId,
    payload: {
      transactionId: tx.id,
      amountInCents: Number(tx.amountInCents ?? 0),
      paymentMethod: tx.paymentMethod ?? null,
      reference: String(tx.id).replace(/-/g, '').slice(-8).toUpperCase(),
      startedAt: tx.startedAt ?? null,
    },
  });
  recordAudit({
    companyId,
    userId: input.userId,
    action: 'payment_terminal.transaction.query_requested',
    entityType: 'payment_terminal_transaction',
    entityId: String(tx.id),
    detail: { commandId: cmd.id },
  });
  return { id: tx.id, status: tx.status, queuedToAgent: true, commandId: cmd.id };
}

/** A fila de comandos do agente, para a tela do gestor (inclui os que venceram sem resposta). */
export function listPaymentTerminalAgentCommandsBackend(
  companyId: string,
  filtro: { status?: string; transactionId?: string; limit?: number } = {},
) {
  return listarComandosDoAgente(companyId, filtro).map((c) => ({
    id: c.id,
    agentId: c.agentId,
    configurationId: c.configurationId,
    pdvTerminalId: c.pdvTerminalId,
    transactionId: c.transactionId,
    command: c.command,
    status: c.status,
    attempts: c.attempts,
    createdAt: c.createdAt,
    deliverBy: c.deliverBy,
    answerBy: c.answerBy,
    deliveredAt: c.deliveredAt,
    answeredAt: c.answeredAt,
    expiredAt: c.expiredAt,
    resultStatus: c.resultStatus,
    amountInCents: Number(c.payload.amountInCents ?? 0) || null,
  }));
}

// ============================================================================
// COMPROVANTE E REIMPRESSÃO (GAP-PRD-162)
// ============================================================================

/*
  As duas rotas respondiam 200 com um objeto montado na hora — `{receiptType:
  'merchant', generatedAt: agora, sanitized: true}` e `{reprinted: true}` —
  sem consultar nada, sem texto de comprovante, sem conferir empresa, e até
  para id que não existe. Quem integrasse acreditaria que há comprovante.

  Agora o comprovante é o que `guardarComprovante` gravou no momento da
  cobrança. Sem comprovante guardado (cobrança recusada ou pendente, provedor
  que não devolve, linha anterior a este registro) a resposta diz ISSO, com
  404 próprio — não inventa um papel.
*/

export type ViaDoComprovante = 'merchant' | 'customer';

function comprovanteOu404(
  companyId: string,
  transactionId: string,
  via: ViaDoComprovante,
): { tx: Record<string, unknown>; recibo: Record<string, unknown>; texto: string } {
  const tx = transacaoDaEmpresaOu404(companyId, transactionId);
  const recibo = findOneRow<Record<string, unknown>>(
    'payment_terminal_receipts',
    (r) => r.transactionId === transactionId && r.companyId === companyId,
  );
  const texto = recibo
    ? ((via === 'customer' ? recibo.customerReceiptText : recibo.merchantReceiptText) as string | null)
    : null;
  if (!recibo || !texto) {
    throw new ApiError(
      'PAYMENT_TERMINAL_RECEIPT_NOT_AVAILABLE',
      recibo
        ? `A operadora não devolveu a via do ${via === 'customer' ? 'cliente' : 'estabelecimento'} desta cobrança.`
        : 'Esta cobrança não tem comprovante: a operadora não devolveu um (cobrança recusada, pendente '
          + 'ou anterior ao registro de comprovantes).',
      404,
      { transactionId, status: tx.status ?? null },
    );
  }
  return { tx, recibo, texto };
}

function vistaDoComprovante(
  tx: Record<string, unknown>,
  recibo: Record<string, unknown>,
  texto: string,
  via: ViaDoComprovante,
) {
  return {
    transactionId: String(tx.id),
    receiptType: via,
    receiptText: texto,
    provider: (tx.provider as string | undefined) ?? null,
    status: (tx.status as string | undefined) ?? null,
    amountInCents: Number(tx.amountInCents ?? 0),
    simulated: recibo.simulated === true,
    generatedAt: String(recibo.createdAt),
    reprintCount: Number(recibo.reprintCount ?? 0),
    lastReprintAt: (recibo.lastReprintAt as string | undefined) ?? null,
    sanitized: true,
  };
}

export function parseViaDoComprovante(raw: unknown): ViaDoComprovante {
  if (raw === undefined || raw === null || raw === '' || raw === 'merchant') return 'merchant';
  if (raw === 'customer') return 'customer';
  throw new ApiError(
    'PAYMENT_TERMINAL_RECEIPT_VIA_INVALID',
    'Via do comprovante deve ser "merchant" (estabelecimento) ou "customer" (cliente).',
    400,
  );
}

export function getPaymentTerminalReceiptBackend(companyId: string, transactionId: string, via: ViaDoComprovante = 'merchant') {
  const { tx, recibo, texto } = comprovanteOu404(companyId, transactionId, via);
  return vistaDoComprovante(tx, recibo, texto, via);
}

/**
 * Reimpressão: o MESMO comprovante, contado.
 *
 * Não fala com o provedor nem cria cobrança — é outra via do papel que já
 * existe. Cada reimpressão fica no histórico e na auditoria: segunda via de
 * comprovante é o gesto que antecede uma contestação "eu já paguei".
 */
export function reprintPaymentTerminalReceiptBackend(input: {
  companyId: string;
  userId: string;
  transactionId: string;
  via?: ViaDoComprovante;
}) {
  const via = input.via ?? 'merchant';
  const { tx, recibo, texto } = comprovanteOu404(input.companyId, input.transactionId, via);
  const agora = new Date().toISOString();
  const vezes = Number(recibo.reprintCount ?? 0) + 1;
  withTransaction(() => {
    updateRows<Record<string, unknown>>(
      'payment_terminal_receipts',
      (r) => r.id === recibo.id && r.companyId === input.companyId,
      (r) => ({ ...r, reprintCount: vezes, lastReprintAt: agora, lastReprintBy: input.userId }),
    );
    insertRow('payment_terminal_history', {
      id: `pthist-${randomUUID()}`,
      companyId: input.companyId,
      transactionId: tx.id,
      action: 'receipt_reprinted',
      via,
      userId: input.userId,
      createdAt: agora,
    });
    recordAudit({
      companyId: input.companyId,
      userId: input.userId,
      action: 'payment_terminal.receipt.reprinted',
      entityType: 'payment_terminal_transaction',
      entityId: String(tx.id),
      detail: { via, reprintCount: vezes },
    });
  });
  return {
    ...vistaDoComprovante(tx, { ...recibo, reprintCount: vezes, lastReprintAt: agora }, texto, via),
    reprint: true,
    newTransaction: false,
  };
}

export function getPaymentTerminalDashboardBackend(companyId: string) {
  // O que venceu na fila do agente vira "não confirmada" antes de contar.
  expirarComandosVencidos(companyId);
  const txs = findRows('payment_terminal_transactions', (r) => r.companyId === companyId);
  return {
    transactionsTotal: txs.length,
    authorized: txs.filter((t) => t.status === 'authorized').length,
    confirmed: txs.filter((t) => t.status === 'confirmed').length,
    declined: txs.filter((t) => t.status === 'declined').length,
    // A órfã (processo caiu esperando o provedor) é o mesmo "não sei" do
    // timeout — contá-la à parte esconderia uma pendência de conferência.
    timeoutUncertain: txs.filter((t) => t.status === 'timeout_uncertain' || isTerminalChargeOrphan(t)).length,
    grossAmountInCents: txs.filter((t) => ['authorized', 'confirmed'].includes(String(t.status))).reduce((s, t) => s + Number(t.amountInCents ?? 0), 0),
    productionBlocked: !loadEnv().paymentTerminalProductionEnabled,
  };
}

export function listPaymentTerminalHomologationsBackend(companyId: string) {
  return findRows('payment_terminal_homologations', (r) => r.companyId === companyId);
}

export function upsertPaymentTerminalHomologationBackend(input: Record<string, unknown>) {
  // Idem: homologação é de uma empresa, e o retrato dela não pode virar o
  // retrato da vizinha por coincidência de chave.
  const existing = findOneRow(
    'payment_terminal_homologations',
    (r) => r.idempotencyKey === input.idempotencyKey && r.companyId === input.companyId,
  );
  if (existing) return existing;
  return insertRow('payment_terminal_homologations', {
    // Idem: id de relógio colide entre duas execuções no mesmo milissegundo.
    id: `pthom-${randomUUID()}`,
    status: 'in_progress',
    stepsCompleted: [],
    productionEnabled: false,
    createdAt: new Date().toISOString(),
    ...input,
  });
}

export async function runPaymentTerminalHomologationBackend(companyId: string, provider: PaymentTerminalProviderId, storeId?: string) {
  const env = loadEnv();
  /*
    PROVEDOR REAL SE HOMOLOGA COM COBRANÇA REAL (GAP-PRD-014).

    O roteiro abaixo chama o adaptador em série — serve ao mock. Para a
    maquininha pelo agente local, homologar é passar cartão de verdade no
    PinPad: crédito, débito, uma recusa, um cancelamento, o comprovante, uma
    venda. O que conta é a EVIDÊNCIA gravada dessas operações
    (`homologacaoDaConfiguracao`), nunca um botão que declara.
  */
  if (provider !== 'mock') {
    const configs = listPaymentTerminalConfigurationsRaw(companyId).filter((c) => c.provider === provider);
    const evidencias = configs.map((c) => homologacaoDaConfiguracao(companyId, c));
    const homologada = evidencias.find((e) => e.homologated);
    const melhor = homologada ?? evidencias[0];
    return {
      status: homologada ? 'homologated' : configs.length ? 'awaiting_evidence' : 'pending_configuration',
      stepsCompleted: melhor ? melhor.items.filter((i) => i.status === 'ok').map((i) => `${i.key}_ok`) : [],
      homologated: Boolean(homologada),
      mockInternal: false,
      real: Boolean(melhor?.items.some((i) => i.status === 'ok')),
      productionBlocked: !env.paymentTerminalProductionEnabled,
      message: homologada
        ? 'Homologação comprovada por operações reais no aparelho.'
        : configs.length
          ? 'A homologação acontece com cobranças REAIS no aparelho: faça as operações da lista em Configurações › Maquininhas.'
          : 'Cadastre a maquininha e pareie o agente local antes de homologar.',
    };
  }
  const steps: string[] = [];
  const connection = await testPaymentTerminalConnection(companyId, provider, storeId);
  steps.push(connection.real ? 'connection_real' : connection.simulated ? 'connection_simulated' : 'connection_pending');

  for (const method of ['credit', 'debit', 'pix'] as const) {
    const tx = await processPaymentTerminalTransaction(companyId, provider, { paymentMethod: method, amountInCents: 1000, storeId });
    steps.push(tx.ok ? `${method}_ok` : `${method}_pending`);
  }

  const timeout = await processPaymentTerminalTransaction(companyId, provider, { paymentMethod: 'credit', amountInCents: 1000, scenario: 'timeout_uncertain', storeId });
  steps.push(timeout.status === 'timeout_uncertain' ? 'timeout_uncertain_ok' : 'timeout_pending');

  const cancel = await cancelPaymentTerminalTransaction(companyId, provider, storeId);
  steps.push(cancel.ok ? 'cancellation_ok' : 'cancellation_pending');

  const refund = await refundPaymentTerminalTransaction(companyId, provider, storeId);
  steps.push(refund.ok ? 'refund_ok' : 'refund_pending');

  const homologated = false; // Nunca homologar provider real via mock; mock = interno apenas.
  const mockInternalOk = provider === 'mock' && connection.ok && steps.includes('credit_ok');
  return {
    status: mockInternalOk ? 'mock_internal_passed' : 'pending_credential',
    stepsCompleted: steps,
    homologated,
    mockInternal: mockInternalOk,
    real: false,
    productionBlocked: !env.paymentTerminalProductionEnabled,
    message: mockInternalOk
      ? 'MOCK INTERNO concluído — não declara provider real homologado.'
      : 'ADAPTER PREPARADO / CREDENCIAL OU HARDWARE PENDENTE — nenhum mock declarado como homologado REAL.',
  };
}

/*
  Aqui morava `listPaymentTerminalReconciliationBackend`, leitor de
  `payment_terminal_reconciliation` — coleção sem escritor nenhum, aposentada
  no GAP-PRD-075 junto com a rota que só respondia a lista vazia.
*/

export function listPaymentTerminalRecoveryBackend(companyId: string) {
  return findRows('payment_terminal_history', (r) => r.companyId === companyId && r.action === 'recovery_executed');
}

export function listPaymentTerminalDeadLetterBackend(companyId: string) {
  return findRows('payment_terminal_dead_letter', (r) => r.companyId === companyId);
}

/**
 * Os agentes da operação — SEM o segredo (GAP-PRD-014). Esta rota devolvia as
 * linhas cruas, e com o pareamento de verdade a linha passou a carregar o
 * segredo selado.
 */
export function listPaymentTerminalLocalAgentsBackend(companyId: string) {
  return listLocalAgentsForManager(companyId);
}

export {
  getLocalAgentStatusDetailed,
  createLocalAgentPairingCode,
  confirmLocalAgentPairing,
  heartbeatLocalAgent,
  assertLocalAgentContract,
} from './PaymentTerminalLocalAgentService.js';
