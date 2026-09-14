/**
 * DEVORA Local Agent — pareamento, identidade e presença (Prompt 18 + GAP-PRD-014).
 *
 * O agente local é o programa que roda no computador do caixa e fala com o
 * PinPad pelo cliente TEF da adquirente. O navegador nunca toca no aparelho:
 * contratos tipados apenas, sem shell/DLL arbitrário pelo browser.
 *
 * ## O que mudou (GAP-PRD-014)
 *
 * O pareamento existia só como "estado": o gestor gerava um código, alguém o
 * confirmava com a sessão do GESTOR, e o agente aparecia `online` para sempre
 * — sem nenhum programa do outro lado. Não havia identidade para o agente
 * falar com o servidor, nem fila de onde ele tirasse o que fazer.
 *
 * Agora:
 *
 * - O código de pareamento é gerado PARA UM CAIXA (ou para a operação toda),
 *   vale 10 minutos e é de uso único.
 * - Quem o confirma recebe, UMA vez, o identificador do agente e um SEGREDO.
 *   O segredo fica selado no cofre (`encryptedSecret`) e é o que o servidor
 *   usa para conferir a assinatura HMAC de cada pedido do agente
 *   (`agentSignature.ts`). Nenhuma listagem o devolve.
 * - `online` deixou de ser um campo gravado: é "o agente assinou algum pedido
 *   nos últimos 90 segundos". Agente que parou de falar aparece fora do ar
 *   sozinho, e a cobrança é recusada ANTES de nascer.
 * - O gestor revoga (motivo obrigatório, auditoria). Revogado, o segredo é
 *   apagado e todo pedido assinado com ele é recusado.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { findOneRow, findRows, insertRow, updateRows } from '../../db/database.js';
import { withTransaction } from '../../db/sqlite.js';
import { ApiError, sanitizeForLog } from '../../utils/errors.js';
import { decryptFiscalSecret, encryptFiscalSecret } from '../fiscal/FiscalSecretVault.js';
import { recordAudit } from '../audit/AuditService.js';
import { assertTerminalDaEmpresa } from '../core/TerminalRegistry.js';

const PAIRING_TTL_MS = 10 * 60 * 1000;

/** Sem pedido assinado há mais que isto, o agente está fora do ar. */
export const AGENTE_ONLINE_MS = 90 * 1000;

export type LocalAgentTypedContract =
  | 'startPayment'
  | 'queryStatus'
  | 'cancel'
  | 'refund'
  | 'reprint'
  | 'health';

export const LOCAL_AGENT_ALLOWED_CONTRACTS: LocalAgentTypedContract[] = [
  'startPayment',
  'queryStatus',
  'cancel',
  'refund',
  'reprint',
  'health',
];

export function assertLocalAgentContract(command: string): LocalAgentTypedContract {
  if (!LOCAL_AGENT_ALLOWED_CONTRACTS.includes(command as LocalAgentTypedContract)) {
    throw new ApiError(
      'PAYMENT_TERMINAL_AGENT_COMMAND_DENIED',
      'Comando Local Agent não permitido. Somente contratos tipados.',
      403,
    );
  }
  return command as LocalAgentTypedContract;
}

type Linha = Record<string, unknown>;

/** Pareado = já recebeu o segredo e não foi revogado. (`online` é o nome antigo.) */
export function agentePareado(row: Linha | null | undefined): boolean {
  return Boolean(row) && (row!.status === 'paired' || row!.status === 'online');
}

/** Falou com o servidor (pedido assinado) nos últimos 90 segundos? */
export function agenteOnline(row: Linha | null | undefined, agora = Date.now()): boolean {
  if (!agentePareado(row)) return false;
  const visto = row!.lastSeenAt ? new Date(String(row!.lastSeenAt)).getTime() : 0;
  return visto > 0 && agora - visto <= AGENTE_ONLINE_MS;
}

/** A forma que sai para a rede: sem segredo, sem código de pareamento vencido. */
export function vistaDoAgente(row: Linha, agora = Date.now()): Record<string, unknown> {
  return {
    agentId: row.id,
    companyId: row.companyId,
    pdvTerminalId: (row.pdvTerminalId as string | null | undefined) ?? null,
    storeId: (row.storeId as string | null | undefined) ?? null,
    operationalUnitId: (row.operationalUnitId as string | null | undefined) ?? null,
    status: row.status === 'online' ? 'paired' : row.status,
    paired: agentePareado(row),
    online: agenteOnline(row, agora),
    version: row.version ?? null,
    hostname: row.hostname ?? null,
    lastSeenAt: row.lastSeenAt ?? null,
    pairedAt: row.pairedAt ?? null,
    health: row.health ?? null,
    revokedAt: row.revokedAt ?? null,
    revokedBy: row.revokedBy ?? null,
    revocationReason: row.revocationReason ?? null,
    message: String(row.message ?? ''),
    allowedContracts: LOCAL_AGENT_ALLOWED_CONTRACTS,
  };
}

export function getLocalAgentStatusDetailed(
  companyId: string,
  storeId?: string,
): Record<string, unknown> {
  const agents = findRows<Linha>('payment_terminal_local_agents', (r) => {
    if (r.companyId !== companyId) return false;
    if (r.status === 'revoked') return false;
    if (storeId && r.storeId !== storeId && r.operationalUnitId !== storeId && r.pdvTerminalId !== storeId) {
      return false;
    }
    return true;
  });
  const active = agents.find((a) => agenteOnline(a)) ?? agents.find((a) => agentePareado(a)) ?? agents[0];
  if (!active) {
    return {
      companyId,
      status: 'not_installed',
      paired: false,
      online: false,
      version: null,
      message: 'Local Agent não instalado/pareado. Browser não acessa PinPad/TEF diretamente.',
      allowedContracts: LOCAL_AGENT_ALLOWED_CONTRACTS,
    };
  }

  const expiresAt = active.pairingExpiresAt ? new Date(String(active.pairingExpiresAt)).getTime() : 0;
  if (active.status === 'pairing' && expiresAt && Date.now() > expiresAt) {
    updateRows('payment_terminal_local_agents', (r) => r.id === active.id, (r) => ({
      ...r,
      status: 'offline',
      pairingCode: null,
      pairingExpiresAt: null,
      updatedAt: new Date().toISOString(),
    }));
    return {
      companyId,
      status: 'offline',
      paired: false,
      online: false,
      version: active.version ?? null,
      message: 'Código de pareamento expirado.',
      allowedContracts: LOCAL_AGENT_ALLOWED_CONTRACTS,
    };
  }

  return sanitizeForLog(vistaDoAgente(active)) as Record<string, unknown>;
}

/**
 * Gera o código de pareamento — para um CAIXA, ou para a operação inteira.
 *
 * O caixa é conferido (desta operação e ligado): o agente pareado para o
 * Caixa 2 só recebe as cobranças da maquininha do Caixa 2. Oito caracteres
 * hexadecimais (4 bilhões de combinações), dez minutos, uso único.
 */
export function createLocalAgentPairingCode(input: {
  companyId: string;
  storeId?: string;
  operationalUnitId?: string;
  terminalId?: string;
  pdvTerminalId?: string | null;
  createdBy?: string;
}): Record<string, unknown> {
  const caixa = input.pdvTerminalId
    ? assertTerminalDaEmpresa(input.companyId, input.pdvTerminalId, { exigirAtivo: true })
    : null;
  const code = randomBytes(4).toString('hex').toUpperCase();
  const expiresAt = new Date(Date.now() + PAIRING_TTL_MS).toISOString();
  const unit = input.operationalUnitId ?? input.storeId ?? null;
  const pdvTerminalId = caixa?.id ?? null;

  const existing = findOneRow<Linha>(
    'payment_terminal_local_agents',
    (r) =>
      r.companyId === input.companyId
      && r.status === 'pairing'
      && ((r.pdvTerminalId as string | null | undefined) ?? null) === pdvTerminalId
      && (r.operationalUnitId ?? r.storeId ?? null) === unit,
  );

  if (existing) {
    updateRows('payment_terminal_local_agents', (r) => r.id === existing.id, (r) => ({
      ...r,
      pairingCode: code,
      pairingExpiresAt: expiresAt,
      terminalId: input.terminalId ?? r.terminalId,
      updatedAt: new Date().toISOString(),
    }));
    return {
      agentId: existing.id,
      pairingCode: code,
      expiresAt,
      pdvTerminalId,
      pdvTerminalName: caixa?.name ?? null,
      ttlSeconds: PAIRING_TTL_MS / 1000,
      message: 'Código de pareamento renovado (expira em 10 min).',
    };
  }

  const row = insertRow('payment_terminal_local_agents', {
    id: `ptagent-${randomUUID()}`,
    companyId: input.companyId,
    storeId: input.storeId ?? null,
    operationalUnitId: unit,
    terminalId: input.terminalId ?? null,
    pdvTerminalId,
    status: 'pairing',
    pairingCode: code,
    pairingExpiresAt: expiresAt,
    version: null,
    createdBy: input.createdBy ?? null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    message: 'Aguardando o agente local informar o código.',
  });

  return {
    agentId: row.id,
    pairingCode: code,
    expiresAt,
    pdvTerminalId,
    pdvTerminalName: caixa?.name ?? null,
    ttlSeconds: PAIRING_TTL_MS / 1000,
    message: 'Código de pareamento gerado (expira em 10 min).',
  };
}

/**
 * Confirma o código e ENTREGA O SEGREDO — a única vez em que ele sai do cofre.
 *
 * Chamado pelo próprio agente (rota pública, o código é a prova) ou pela tela
 * do gestor que digita o código no computador do caixa. `companyId` é opcional
 * para o agente, que ainda não sabe de que operação é: o código, aleatório e
 * de uso único, é que diz.
 */
export function confirmLocalAgentPairing(input: {
  companyId?: string;
  pairingCode: string;
  version?: string;
  hostname?: string;
  storeId?: string;
}): Record<string, unknown> {
  const code = String(input.pairingCode ?? '').trim().toUpperCase();
  if (!code) {
    throw new ApiError('PAYMENT_TERMINAL_PAIRING_INVALID', 'Código de pareamento inválido.', 400);
  }
  const agent = findOneRow<Linha>(
    'payment_terminal_local_agents',
    (r) =>
      (!input.companyId || r.companyId === input.companyId)
      && String(r.pairingCode ?? '').toUpperCase() === code
      && r.status === 'pairing',
  );
  if (!agent) {
    throw new ApiError('PAYMENT_TERMINAL_PAIRING_INVALID', 'Código de pareamento inválido.', 400);
  }
  const expiresAt = agent.pairingExpiresAt ? new Date(String(agent.pairingExpiresAt)).getTime() : 0;
  if (!expiresAt || Date.now() > expiresAt) {
    throw new ApiError('PAYMENT_TERMINAL_PAIRING_EXPIRED', 'Código de pareamento expirado.', 400);
  }

  const segredo = randomBytes(32).toString('base64url');
  const agora = new Date().toISOString();
  withTransaction(() => {
    updateRows<Linha>('payment_terminal_local_agents', (r) => r.id === agent.id, (r) => ({
      ...r,
      status: 'paired',
      version: input.version ?? '1.0.0',
      hostname: input.hostname ?? r.hostname ?? null,
      encryptedSecret: encryptFiscalSecret(segredo),
      pairingCode: null,
      pairingExpiresAt: null,
      pairedAt: agora,
      lastSeenAt: agora,
      updatedAt: agora,
      message: 'Agente local pareado.',
    }));
    recordAudit({
      companyId: String(agent.companyId),
      userId: null,
      action: 'payment_terminal.agent.paired',
      entityType: 'payment_terminal_local_agent',
      entityId: String(agent.id),
      detail: { pdvTerminalId: agent.pdvTerminalId ?? null, version: input.version ?? null },
    });
  });

  const atualizado = findOneRow<Linha>('payment_terminal_local_agents', (r) => r.id === agent.id)!;
  // Montado à mão, e não pelo sanitizador: `agentSecret` casaria com /secret/
  // e sairia "[REDACTED]" — justamente na única resposta que deve levá-lo.
  return {
    ...(sanitizeForLog(vistaDoAgente(atualizado)) as Record<string, unknown>),
    agentId: String(agent.id),
    agentSecret: segredo,
    secretShownOnce: true,
  };
}

/**
 * O agente e o segredo dele, para conferir uma assinatura.
 *
 * Nunca sai para a rede. Agente revogado, em pareamento ou sem segredo
 * responde nulo — a assinatura é recusada do mesmo jeito que a de um id
 * inventado.
 */
export function agenteParaConferir(agentId: string): { row: Linha; segredo: string } | null {
  const row = findOneRow<Linha>('payment_terminal_local_agents', (r) => r.id === agentId);
  if (!row || !agentePareado(row) || !row.encryptedSecret) return null;
  try {
    return { row, segredo: decryptFiscalSecret(String(row.encryptedSecret)) };
  } catch {
    return null;
  }
}

/** Todo pedido assinado que passou é um sinal de vida. */
export function registrarSinalDoAgente(
  agentId: string,
  info: { version?: string; hostname?: string; health?: Record<string, unknown> | null } = {},
): void {
  const agora = new Date().toISOString();
  updateRows<Linha>('payment_terminal_local_agents', (r) => r.id === agentId, (r) => ({
    ...r,
    lastSeenAt: agora,
    version: info.version ?? r.version,
    hostname: info.hostname ?? r.hostname,
    ...(info.health !== undefined ? { health: normalizarSaude(info.health), healthAt: agora } : {}),
    updatedAt: agora,
  }));
}

/** O que o agente conta da saúde do cliente TEF e do PinPad, em forma conhecida. */
function normalizarSaude(health: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!health || typeof health !== 'object') return null;
  const texto = (v: unknown, max = 200) => (v == null ? null : String(v).slice(0, max));
  return {
    tefClient: texto(health.tefClient, 40),
    pinpad: texto(health.pinpad, 40),
    bridge: texto(health.bridge, 40),
    message: texto(health.message),
    reportedAt: new Date().toISOString(),
  };
}

/** O agente declarou o cliente TEF funcionando no último sinal? */
export function saudeDoAgenteOk(row: Linha | null | undefined): boolean {
  const saude = (row?.health ?? null) as Record<string, unknown> | null;
  return Boolean(saude) && saude!.tefClient === 'ok';
}

/**
 * Sinal manual pela sessão do gestor (rota antiga `/local-agent/heartbeat`).
 *
 * Não conta como presença: `online` é o AGENTE assinando pedido. Um navegador
 * aberto na tela do gestor dizendo "estou vivo" era exatamente como o painel
 * mostrava agente online sem programa nenhum do outro lado.
 */
export function heartbeatLocalAgent(input: {
  companyId: string;
  agentId: string;
  version?: string;
}): Record<string, unknown> {
  const agent = findOneRow<Linha>(
    'payment_terminal_local_agents',
    (r) => r.id === input.agentId && r.companyId === input.companyId,
  );
  if (!agent) {
    throw new ApiError('PAYMENT_TERMINAL_AGENT_NOT_FOUND', 'Local Agent não encontrado.', 404);
  }
  updateRows('payment_terminal_local_agents', (r) => r.id === agent.id, (r) => ({
    ...r,
    version: input.version ?? r.version,
    lastManualCheckAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }));
  const atualizado = findOneRow<Linha>('payment_terminal_local_agents', (r) => r.id === agent.id)!;
  return sanitizeForLog(vistaDoAgente(atualizado)) as Record<string, unknown>;
}

/** Os agentes da operação, para a tela do gestor. Nunca o segredo. */
export function listLocalAgentsForManager(companyId: string): Record<string, unknown>[] {
  const agora = Date.now();
  return findRows<Linha>('payment_terminal_local_agents', (r) => r.companyId === companyId)
    .filter(
      (r) =>
        r.status !== 'offline'
        && (r.status !== 'pairing'
          || (Boolean(r.pairingExpiresAt) && new Date(String(r.pairingExpiresAt)).getTime() > agora)),
    )
    .map((r): Record<string, unknown> => ({
      ...(sanitizeForLog(vistaDoAgente(r, agora)) as Record<string, unknown>),
      pairingExpiresAt: r.status === 'pairing' ? (r.pairingExpiresAt ?? null) : null,
    }))
    .sort((a, b) => String(b.lastSeenAt ?? '').localeCompare(String(a.lastSeenAt ?? '')));
}

/**
 * O agente que atende uma maquininha: o do MESMO caixa (ou, para a
 * maquininha da operação inteira, o agente sem caixa). Entre dois, o que
 * falou por último.
 */
export function agenteDoCaixa(companyId: string, pdvTerminalId: string | null | undefined): Linha | null {
  const caixa = pdvTerminalId ?? null;
  const candidatos = findRows<Linha>(
    'payment_terminal_local_agents',
    (r) =>
      r.companyId === companyId
      && agentePareado(r)
      && ((r.pdvTerminalId as string | null | undefined) ?? null) === caixa,
  );
  candidatos.sort((a, b) => String(b.lastSeenAt ?? '').localeCompare(String(a.lastSeenAt ?? '')));
  return candidatos[0] ?? null;
}

/**
 * Revoga um agente: o segredo é apagado, e todo pedido assinado com ele passa
 * a ser recusado. Motivo obrigatório; auditoria com o nome de quem revogou.
 */
export function revokeLocalAgent(input: {
  companyId: string;
  userId: string;
  agentId: string;
  reason: string;
}): Record<string, unknown> {
  const row = findOneRow<Linha>(
    'payment_terminal_local_agents',
    (r) => r.id === input.agentId && r.companyId === input.companyId,
  );
  if (!row) {
    throw new ApiError('PAYMENT_TERMINAL_AGENT_NOT_FOUND', 'Agente local não encontrado nesta operação.', 404);
  }
  const reason = String(input.reason ?? '').trim();
  if (!reason) {
    throw new ApiError('PAYMENT_TERMINAL_REASON_REQUIRED', 'Informe por que este agente está sendo revogado.', 400);
  }
  if (row.status === 'revoked') {
    throw new ApiError('PAYMENT_TERMINAL_AGENT_ALREADY_REVOKED', 'Este agente já está revogado.', 409);
  }
  const agora = new Date().toISOString();
  withTransaction(() => {
    updateRows<Linha>('payment_terminal_local_agents', (r) => r.id === row.id, (r) => ({
      ...r,
      status: 'revoked',
      encryptedSecret: null,
      pairingCode: null,
      pairingExpiresAt: null,
      revokedAt: agora,
      revokedBy: input.userId,
      revocationReason: reason,
      updatedAt: agora,
      message: 'Agente revogado.',
    }));
    insertRow('payment_terminal_history', {
      id: `pthist-${randomUUID()}`,
      companyId: input.companyId,
      agentId: row.id,
      action: 'agent_revoked',
      reason,
      userId: input.userId,
      createdAt: agora,
    });
    recordAudit({
      companyId: input.companyId,
      userId: input.userId,
      action: 'payment_terminal.agent.revoked',
      entityType: 'payment_terminal_local_agent',
      entityId: String(row.id),
      detail: { reason, pdvTerminalId: row.pdvTerminalId ?? null },
    });
  });
  const atualizado = findOneRow<Linha>('payment_terminal_local_agents', (r) => r.id === row.id)!;
  return sanitizeForLog(vistaDoAgente(atualizado)) as Record<string, unknown>;
}
