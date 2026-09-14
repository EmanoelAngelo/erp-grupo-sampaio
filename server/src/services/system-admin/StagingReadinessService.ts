/**
 * A SITUAÇÃO DE STAGING DA INSTALAÇÃO — só o que se deduz do ambiente.
 *
 * Este serviço montava um relatório "integrado" para `GET /system/staging/readiness`:
 *
 *   - doze "módulos do núcleo" com `status: 'ok'` CRAVADO — entre eles
 *     "CRM/Kanban operacional", "BI dashboards operacionais" e "Automações
 *     idempotentes", de três módulos que já tinham saído do sistema;
 *   - a prontidão da NF-e e da NFC-e montada sobre `fiscal_issuer_profiles`,
 *     `fiscal_product_profiles` e `nfe_configurations`, coleções que nenhum
 *     código escreve: "emitente não configurado" para a empresa cujo emitente
 *     o núcleo tem (`core_fiscal_configs`);
 *   - a prontidão do e-commerce sobre `ecommerce_storefronts`, de um módulo que
 *     só este relatório e o painel de `/integrations` liam.
 *
 * Nenhuma tela chamava a rota (GAP-PRD-075). O que sobra é a única informação
 * que tem leitor — o `stagingStatus` de `GET /system/readiness` — e ela sai do
 * ambiente e das travas de produção, sem inventar estado de módulo nenhum. A
 * prontidão de verdade de cada domínio mora no domínio: `/core/fiscal/readiness`,
 * `/logistics/readiness`, `/payment-terminals/readiness` e a conferência da
 * implantação (`/system/implantacao`).
 */

import { loadEnv } from '../../config/env.js';

export type StagingStatus = 'ready_for_staging' | 'conditionally_ready' | 'not_ready';

export interface StagingReadiness {
  environment: string;
  isStagingEnv: boolean;
  overallStatus: StagingStatus;
  /** Toda trava de produção de integração externa continua fechada. */
  productionFlagsBlocked: boolean;
  readyForProduction: false;
}

export function evaluateStagingReadiness(): StagingReadiness {
  const env = loadEnv();
  const isStagingEnv = env.DEVORA_API_ENV === 'staging' || env.DEVORA_API_ENV === 'development';

  const productionFlagsBlocked =
    !env.asaasProductionEnabled &&
    !env.nfeProductionEnabled &&
    !env.nfceProductionEnabled &&
    !env.logisticsProductionEnabled &&
    !env.paymentTerminalProductionEnabled &&
    !env.ecommerceProductionEnabled;

  const overallStatus: StagingStatus =
    productionFlagsBlocked && isStagingEnv
      ? 'ready_for_staging'
      : env.DEVORA_API_ENV === 'production' && productionFlagsBlocked
        ? 'conditionally_ready'
        : 'not_ready';

  return {
    environment: env.DEVORA_API_ENV,
    isStagingEnv,
    overallStatus,
    productionFlagsBlocked,
    readyForProduction: false,
  };
}
