/**
 * ============================================================================
 * requirePermission → capability, ROTA A ROTA (C8)
 * ============================================================================
 *
 * ARQUIVO GERADO por `scripts/rbac/gerar-artefatos.mjs` a partir de
 * `scripts/rbac/mapa-final.json`. Não edite à mão.
 *
 * `requirePermission('modulo.recurso.acao')` perguntava à matriz de
 * `Permissions.ts` se os PERFIS do token davam conta da string. Desde a F1 do
 * RBAC granular ele pergunta às CAPABILITIES do vínculo de agora — e a
 * tradução é por ROTA (método + caminho), não por string: a mesma string
 * `payment-terminal.settings.manage` guarda uma leitura (`GET
 * /payment-terminals/local-agent/status`, `integrations.card_terminal.operate`)
 * e um pareamento (`POST /payment-terminals/local-agent/pairing`,
 * `integrations.card_terminal.manage`). Uma tabela por string alargaria uma e
 * estreitaria a outra.
 *
 * Cada linha foi derivada do acesso de hoje (matriz de módulos + a interseção
 * com `GERENCIA_DA_MAQUININHA` dentro do handler): com os modelos de sistema,
 * quem passa é exatamente quem passava. `tests/rbac/equivalencia.test.ts`
 * cobra isso rota a rota, e cobra que toda chamada de `requirePermission` do
 * código tenha a sua linha aqui. Rota sem linha NEGA (falha fechada).
 *
 * A tabela morre na fatia (e) da F2, quando as chamadas viram `comCapability`.
 */
import type { ExpressaoDeCapability } from './Capabilities.js';

export interface TraducaoDaPermissao {
  /** A string que a rota pede hoje — conferida, para a tradução não servir a outra chamada. */
  readonly permissao: string;
  readonly expressao: ExpressaoDeCapability;
}

/** Chave: `MÉTODO /caminho` como montado em `/api/v1` (sem o prefixo). */
export const PERMISSAO_PARA_CAPABILITY: Readonly<Record<string, TraducaoDaPermissao>> = {
  "DELETE /logistics/carriers/:carrier/credentials": { permissao: "logistics.config.manage", expressao: { uma: "logistics.manage" } },
  "DELETE /system/implantacao/empresas/:companyId/itens/:item/marca": { permissao: "system-readiness.manage", expressao: { uma: "system.deploy.manage" } },
  "GET /asaas/charges/:chargeLinkId": { permissao: "asaas.charge.view", expressao: { uma: "integrations.asaas.view" } },
  "GET /asaas/queue": { permissao: "asaas.queue.view", expressao: { uma: "integrations.asaas.view" } },
  "GET /asaas/status": { permissao: "asaas.connection.view", expressao: { uma: "integrations.asaas.view" } },
  "GET /auth/devices": { permissao: "api.device.list", expressao: { uma: "devices.view" } },
  "GET /logistics/carriers": { permissao: "logistics.config.view", expressao: { uma: "logistics.view" } },
  "GET /logistics/homologation": { permissao: "logistics.homologation.run", expressao: { uma: "logistics.manage" } },
  "GET /logistics/orders/:orderId/shipments": { permissao: "logistics.shipment.view", expressao: { uma: "logistics.view" } },
  "GET /logistics/providers-status": { permissao: "logistics.view", expressao: { uma: "logistics.view" } },
  "GET /logistics/quotes/:quoteId": { permissao: "logistics.quote.request", expressao: { uma: "logistics.manage" } },
  "GET /logistics/readiness": { permissao: "logistics.view", expressao: { uma: "logistics.view" } },
  "GET /logistics/settings/shipping": { permissao: "logistics.config.view", expressao: { uma: "logistics.view" } },
  "GET /logistics/shipments": { permissao: "logistics.shipment.view", expressao: { uma: "logistics.view" } },
  "GET /logistics/shipments/:id/label": { permissao: "logistics.label.view", expressao: { uma: "logistics.view" } },
  "GET /payment-terminals/agent-commands": { permissao: "payment-terminal.settings.manage", expressao: { uma: "integrations.card_terminal.manage" } },
  "GET /payment-terminals/configurations": { permissao: "payment-terminal.configuration.view", expressao: { uma: "integrations.card_terminal.view" } },
  "GET /payment-terminals/dashboard": { permissao: "payment-terminal.dashboard.view", expressao: { uma: "integrations.card_terminal.view" } },
  "GET /payment-terminals/dead-letter": { permissao: "payment-terminal.recovery.manage", expressao: { uma: "integrations.card_terminal.operate" } },
  "GET /payment-terminals/homologation": { permissao: "payment-terminal.homologation.run", expressao: { uma: "integrations.card_terminal.operate" } },
  "GET /payment-terminals/local-agent/status": { permissao: "payment-terminal.settings.manage", expressao: { uma: "integrations.card_terminal.operate" } },
  "GET /payment-terminals/local-agents": { permissao: "payment-terminal.settings.manage", expressao: { uma: "integrations.card_terminal.operate" } },
  "GET /payment-terminals/providers": { permissao: "payment-terminal.view", expressao: { uma: "integrations.card_terminal.view" } },
  "GET /payment-terminals/providers-status": { permissao: "payment-terminal.view", expressao: { uma: "integrations.card_terminal.view" } },
  "GET /payment-terminals/providers/:provider/capabilities": { permissao: "payment-terminal.view", expressao: { uma: "integrations.card_terminal.view" } },
  "GET /payment-terminals/readiness": { permissao: "payment-terminal.view", expressao: { uma: "integrations.card_terminal.view" } },
  "GET /payment-terminals/recovery": { permissao: "payment-terminal.recovery.manage", expressao: { uma: "integrations.card_terminal.operate" } },
  "GET /payment-terminals/terminals": { permissao: "payment-terminal.terminal.view", expressao: { uma: "integrations.card_terminal.view" } },
  "GET /payment-terminals/transactions": { permissao: "payment-terminal.transaction.view", expressao: { uma: "integrations.card_terminal.view" } },
  "GET /payment-terminals/transactions/:id": { permissao: "payment-terminal.transaction.view", expressao: { uma: "integrations.card_terminal.view" } },
  "GET /payment-terminals/transactions/:id/receipt": { permissao: "payment-terminal.receipt.view", expressao: { uma: "integrations.card_terminal.view" } },
  "GET /system/backup/status": { permissao: "system-backup.view", expressao: { uma: "system.backup.view" } },
  "GET /system/implantacao": { permissao: "system-readiness.view", expressao: { uma: "system.deploy.view" } },
  "GET /system/implantacao/empresas": { permissao: "system-readiness.view", expressao: { uma: "system.deploy.view" } },
  "GET /system/implantacao/empresas/:companyId": { permissao: "system-readiness.view", expressao: { uma: "system.deploy.view" } },
  "GET /system/readiness": { permissao: "system-readiness.view", expressao: { uma: "system.status.view" } },
  "GET /system/release": { permissao: "system-release.view", expressao: { uma: "system.status.view" } },
  "PATCH /payment-terminals/configurations/:id": { permissao: "payment-terminal.configuration.manage", expressao: { uma: "integrations.card_terminal.manage" } },
  "POST /asaas/charges": { permissao: "asaas.charge.create", expressao: { uma: "integrations.asaas.manage" } },
  "POST /asaas/charges/:chargeLinkId/cancel": { permissao: "asaas.charge.cancel", expressao: { uma: "integrations.asaas.manage" } },
  "POST /asaas/customers/sync": { permissao: "asaas.customer.sync", expressao: { uma: "integrations.asaas.manage" } },
  "POST /asaas/homologation/start": { permissao: "asaas.homologation.run", expressao: { uma: "integrations.asaas.manage" } },
  "POST /asaas/production/activate": { permissao: "asaas.production.activate", expressao: { uma: "integrations.asaas.manage" } },
  "POST /asaas/queue/:attemptId/retry": { permissao: "asaas.queue.retry", expressao: { uma: "integrations.asaas.manage" } },
  "POST /asaas/test-connection": { permissao: "asaas.connection.test", expressao: { uma: "integrations.asaas.manage" } },
  "POST /auth/device/:id/revoke": { permissao: "api.device.revoke", expressao: { uma: "devices.manage" } },
  "POST /auth/device/enroll": { permissao: "api.device.enroll", expressao: { uma: "devices.manage" } },
  "POST /logistics/carriers/:carrier/test-connection": { permissao: "logistics.config.manage", expressao: { uma: "logistics.manage" } },
  "POST /logistics/carriers/:carrier/test-quote": { permissao: "logistics.quote.request", expressao: { uma: "logistics.manage" } },
  "POST /logistics/carriers/:carrier/test-tracking": { permissao: "logistics.tracking.view", expressao: { uma: "logistics.view" } },
  "POST /logistics/carriers/credentials": { permissao: "logistics.config.manage", expressao: { uma: "logistics.manage" } },
  "POST /logistics/homologation/run": { permissao: "logistics.homologation.run", expressao: { uma: "logistics.manage" } },
  "POST /logistics/orders/:orderId/label": { permissao: "logistics.label.create", expressao: { uma: "logistics.manage" } },
  "POST /logistics/orders/:orderId/services": { permissao: "logistics.quote.request", expressao: { uma: "logistics.manage" } },
  "POST /logistics/quotes": { permissao: "logistics.quote.request", expressao: { uma: "logistics.manage" } },
  "POST /logistics/shipments": { permissao: "logistics.label.create", expressao: { uma: "logistics.manage" } },
  "POST /logistics/shipments/:id/cancel": { permissao: "logistics.shipment.cancel", expressao: { uma: "logistics.manage" } },
  "POST /logistics/shipments/:id/continue": { permissao: "logistics.label.create", expressao: { uma: "logistics.manage" } },
  "POST /logistics/shipments/:id/sync": { permissao: "logistics.tracking.sync", expressao: { uma: "logistics.manage" } },
  "POST /payment-terminals/configurations": { permissao: "payment-terminal.configuration.manage", expressao: { uma: "integrations.card_terminal.manage" } },
  "POST /payment-terminals/credentials": { permissao: "payment-terminal.configuration.manage", expressao: { uma: "integrations.card_terminal.manage" } },
  "POST /payment-terminals/homologation/run": { permissao: "payment-terminal.homologation.run", expressao: { uma: "integrations.card_terminal.manage" } },
  "POST /payment-terminals/local-agent/heartbeat": { permissao: "payment-terminal.settings.manage", expressao: { uma: "integrations.card_terminal.manage" } },
  "POST /payment-terminals/local-agent/pair": { permissao: "payment-terminal.settings.manage", expressao: { uma: "integrations.card_terminal.manage" } },
  "POST /payment-terminals/local-agent/pairing": { permissao: "payment-terminal.settings.manage", expressao: { uma: "integrations.card_terminal.manage" } },
  "POST /payment-terminals/local-agents/:id/revoke": { permissao: "payment-terminal.settings.manage", expressao: { uma: "integrations.card_terminal.manage" } },
  "POST /payment-terminals/providers/:provider/test-connection": { permissao: "payment-terminal.terminal.test", expressao: { uma: "integrations.card_terminal.operate" } },
  "POST /payment-terminals/providers/:provider/test-transaction": { permissao: "payment-terminal.transaction.create", expressao: { uma: "integrations.card_terminal.manage" } },
  "POST /payment-terminals/transactions": { permissao: "payment-terminal.transaction.create", expressao: { uma: "integrations.card_terminal.operate" } },
  "POST /payment-terminals/transactions/:id/cancel": { permissao: "payment-terminal.transaction.cancel", expressao: { uma: "integrations.card_terminal.operate" } },
  "POST /payment-terminals/transactions/:id/query": { permissao: "payment-terminal.reconciliation.manage", expressao: { uma: "integrations.card_terminal.manage" } },
  "POST /payment-terminals/transactions/:id/refund": { permissao: "payment-terminal.transaction.refund", expressao: { uma: "integrations.card_terminal.operate" } },
  "POST /payment-terminals/transactions/:id/reprint": { permissao: "payment-terminal.receipt.reprint", expressao: { uma: "integrations.card_terminal.operate" } },
  "POST /system/backup/conferir-bucket": { permissao: "system-backup.manage", expressao: { uma: "system.backup.manage" } },
  "PUT /logistics/settings/shipping": { permissao: "logistics.config.manage", expressao: { uma: "logistics.manage" } },
  "PUT /system/implantacao/empresas/:companyId/itens/:item/marca": { permissao: "system-readiness.manage", expressao: { uma: "system.deploy.manage" } },
};
