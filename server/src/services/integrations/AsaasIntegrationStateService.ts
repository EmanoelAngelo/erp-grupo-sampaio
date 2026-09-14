/**
 * Estado operacional Asaas por empresa/unidade — integration_configurations.
 */

import { findOneRow, insertRow, updateRows } from '../../db/database.js';

export type AsaasScope = {
  companyId: string;
  storeId?: string;
  operationalUnitId?: string;
};

function scopeKey(scope: AsaasScope): (row: Record<string, unknown>) => boolean {
  const unit = scope.operationalUnitId ?? scope.storeId ?? null;
  return (row) =>
    row.provider === 'asaas'
    && row.companyId === scope.companyId
    && (row.operationalUnitId ?? row.storeId ?? null) === unit;
}

export function getAsaasIntegrationState(scope: AsaasScope): Record<string, unknown> {
  const row = findOneRow<Record<string, unknown>>('integration_configurations', scopeKey(scope));
  if (!row) {
    return {
      companyId: scope.companyId,
      storeId: scope.storeId ?? null,
      operationalUnitId: scope.operationalUnitId ?? scope.storeId ?? null,
      provider: 'asaas',
      environment: 'sandbox',
      connectionVerified: false,
      lastConnectionTestAt: null,
      productionConnectionVerified: false,
      productionConnectionTestedAt: null,
      sandboxHomologated: false,
      homologationStatus: 'pending',
      homologationSteps: [],
      lastHomologationAt: null,
    };
  }
  return row;
}

export function upsertAsaasIntegrationState(
  scope: AsaasScope,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const existing = findOneRow<Record<string, unknown>>('integration_configurations', scopeKey(scope));
  const now = new Date().toISOString();
  const base = {
    provider: 'asaas',
    companyId: scope.companyId,
    storeId: scope.storeId ?? null,
    operationalUnitId: scope.operationalUnitId ?? scope.storeId ?? null,
    updatedAt: now,
    ...patch,
  };

  if (existing) {
    updateRows('integration_configurations', (r) => r.id === existing.id, (r) => ({ ...r, ...base }));
    return findOneRow('integration_configurations', (r) => r.id === existing.id)!;
  }

  return insertRow('integration_configurations', {
    id: `icfg-asaas-${Date.now()}`,
    createdAt: now,
    environment: 'sandbox',
    connectionVerified: false,
    sandboxHomologated: false,
    homologationStatus: 'pending',
    homologationSteps: [],
    ...base,
  });
}

/**
 * Ambiente EFETIVO de uma operação.
 *
 * Produção não é uma preferência: é uma porta com cinco trancas, e todas
 * precisam estar abertas. Cobrar de verdade no cartão de um cliente por causa
 * de um campo mal preenchido é o tipo de erro que não se desfaz com um
 * `UPDATE`.
 *
 * As trancas:
 *  1. a operação pediu produção (`environment` na configuração);
 *  2. o processo permite produção (`ASAAS_PRODUCTION_ENABLED`) — a mesma
 *     bandeira que impede um ambiente de desenvolvimento cobrar de verdade;
 *  3. existe credencial de produção no cofre desta operação;
 *  4. a credencial de PRODUÇÃO foi testada contra o Asaas de produção;
 *  5. a homologação em sandbox foi concluída.
 *
 * Faltando qualquer uma, o ambiente efetivo é `sandbox` — e o motivo vem
 * junto, porque "por que ainda estou em sandbox?" é a pergunta seguinte.
 *
 * ## A quarta tranca testava a chave errada (GAP-PRD-170)
 *
 * Ela olhava `connectionVerified`, e o teste de conexão testava o ambiente
 * EFETIVO — sandbox enquanto a porta estava fechada. O selo "conexão testada"
 * era satisfeito pela chave de sandbox, a porta abria, e a primeira cobrança
 * real era o primeiro teste da chave de produção. Agora cada ambiente tem o
 * próprio selo: `connectionVerified` é o do sandbox (e a homologação o exige),
 * `productionConnectionVerified` é o da chave de produção testada em
 * `api.asaas.com` — e é ele que a quarta tranca lê.
 *
 * As trancas também passaram a ser independentes da ORDEM: guardar a chave de
 * produção zera só o selo da produção (não a homologação, que era do
 * sandbox), e a homologação deixou de sobrescrever o ambiente pedido.
 */
export function resolveAsaasEnvironment(
  scope: AsaasScope,
  input: { productionCredentialConfigured: boolean; productionAllowedByProcess: boolean },
): { environment: 'sandbox' | 'production'; blockedBy: string[] } {
  const state = getAsaasIntegrationState(scope);
  const bloqueios: string[] = [];

  if (state.environment !== 'production') bloqueios.push('CONFIGURACAO_EM_SANDBOX');
  if (!input.productionAllowedByProcess) bloqueios.push('PRODUCAO_DESABILITADA_NO_PROCESSO');
  if (!input.productionCredentialConfigured) bloqueios.push('SEM_CREDENCIAL_DE_PRODUCAO');
  if (state.productionConnectionVerified !== true) bloqueios.push('CREDENCIAL_DE_PRODUCAO_NAO_TESTADA');
  if (!state.sandboxHomologated) bloqueios.push('HOMOLOGACAO_SANDBOX_PENDENTE');

  return {
    environment: bloqueios.length === 0 ? 'production' : 'sandbox',
    blockedBy: bloqueios,
  };
}

/**
 * Derruba os selos que eram DAQUELA credencial.
 *
 * Trocar ou remover a chave de sandbox invalida a conexão testada e a
 * homologação (as duas foram feitas com ela). Trocar ou remover a de produção
 * invalida só o teste da produção — a homologação do sandbox continua sendo
 * verdade (GAP-PRD-170). Sem ambiente, derruba os dois: é o que os caminhos
 * antigos, que não diziam qual chave mudou, sempre fizeram.
 */
export function resetAsaasConnectionState(
  scope: AsaasScope,
  environment?: 'sandbox' | 'production',
): void {
  const sandbox = {
    connectionVerified: false,
    lastConnectionTestAt: null,
    sandboxHomologated: false,
    homologationStatus: 'pending',
    homologationSteps: [],
    lastHomologationAt: null,
  };
  const producao = {
    productionConnectionVerified: false,
    productionConnectionTestedAt: null,
    productionConnectionError: null,
  };
  upsertAsaasIntegrationState(
    scope,
    environment === 'sandbox'
      ? sandbox
      : environment === 'production'
        ? producao
        : { ...sandbox, ...producao },
  );
}
