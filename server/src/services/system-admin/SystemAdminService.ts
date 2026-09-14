import { versoesDoBancoEmUso } from '../../db/versaoDoEsquema.js';
import { loadEnv } from '../../config/env.js';
import { evaluateStagingReadiness } from './StagingReadinessService.js';
import { evaluateCoreProductionReadiness } from './CoreProductionReadinessService.js';

export const DEVORA_BACKEND_VERSION = '1.0.0';
export const DEVORA_CHECKPOINT = 73;

/*
  A "auditoria de sistema" que morava aqui SAIU (verificação do GAP-PRD-075):
  uma lista em memória que só os testes preenchiam, lida por `GET
  /system/audit` — que nenhuma tela chamava e que, com a lista vazia (sempre,
  em produção), inventava a linha `audit-stub-scan`. A trilha é uma só:
  `core_audit_log`, escrita por `recordAudit` e lida em `GET /core/audit`.
*/

export function systemAdminHealth() {
  return { status: 'ok', module: 'system-admin', checkpoint: DEVORA_CHECKPOINT };
}

/**
 * A versão publicada (`GET /version`, `GET /system/release`).
 *
 * GAP-PRD-057: `databaseVersion` era `loadDb().version` — a camada de
 * DOCUMENTOS, parada em 19 — e `indexedDbVersion: 67` descrevia um IndexedDB
 * que o frontend não tem. Agora o número do banco é o do NÚCLEO, com o alvo
 * desta build ao lado; a camada de documentos vem rotulada à parte.
 */
export function getReleaseVersionInfo() {
  const env = loadEnv();
  const esquema = versoesDoBancoEmUso();
  return {
    appVersion: DEVORA_BACKEND_VERSION,
    apiVersion: DEVORA_BACKEND_VERSION,
    backendVersion: DEVORA_BACKEND_VERSION,
    databaseVersion: esquema.nucleo.versao,
    databaseTargetVersion: esquema.nucleo.alvo,
    databaseSituation: esquema.situacao,
    documentsVersion: esquema.documentos.versao,
    build: `cp73-${DEVORA_BACKEND_VERSION}`,
    environment: env.DEVORA_API_ENV,
    releaseChannel: 'stable',
    checkpoint: DEVORA_CHECKPOINT,
    release: 'Grupo Sampaio ERP 1.0.0',
  };
}

export function evaluateBackendReadiness() {
  const core = evaluateCoreProductionReadiness();
  const staging = evaluateStagingReadiness();
  return {
    ...core,
    stagingStatus: staging.overallStatus,
    readyForProduction: core.overallStatus === 'ready_for_core_production' || core.overallStatus === 'ready_for_full_production',
  };
}

/*
  Aqui moravam `listSystemRecoveryBackend` e `listSystemReconciliationBackend`
  ("scan_ok" para qualquer empresa), `getHomologationMatrixBackend` (o "Core
  ERP" homologado por constante), `getGoLiveChecklistBackend` (quatro listas de
  palavras) e `activateCoreProductionBackend`, que dizia "Core Production
  ativado" sem ativar nada. Nenhuma tela as chamava; saíram com as rotas
  (GAP-PRD-064). A prontidão de verdade é `evaluateBackendReadiness` (acima), a
  implantação da instalação é `conferirImplantacao` e a de cada empresa é
  `implantacaoDaEmpresa`.
*/
