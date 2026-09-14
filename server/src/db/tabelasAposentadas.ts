/**
 * ============================================================================
 * AS TABELAS APOSENTADAS — e o caminho para tirá-las do banco que já existe
 * (GAP-PRD-141)
 * ============================================================================
 *
 * Duas levas de coleções de documentos deixaram de ter leitor e escritor:
 *
 *   - a RODADA 36 tirou de `TABLE_NAMES` 81 coleções (oms_*, workshop_*,
 *     rental_*, promotion* e 15 ecommerce_*) junto com os módulos que as
 *     usavam — sem nunca apagá-las do arquivo. No banco real elas continuam
 *     lá, vazias, pesando no backup e na restauração;
 *   - o GAP-PRD-141 (com o GAP-PRD-075, que desmontou /crm, /automations e
 *     /bi) tirou mais 90: as que nenhuma linha de `server/src` fora de `db/`
 *     lia ou escrevia.
 *
 * Instalação nova já não as cria (`ensureSchema` só cria `TABLE_NAMES`). No
 * banco que já existe, apagá-las é CORREÇÃO DE DADO, e por isso não roda no
 * boot: fica aqui, para o passo de consolidação do integrador e para o
 * comando `db:podar-legado` (`scripts/podar-tabelas-aposentadas.ts`).
 *
 * ## As três regras que tornam isto seguro
 *
 *   1. Só sai tabela que está NESTA LISTA, pelo nome. Uma coleção que o
 *      código desta build não conhece (de uma versão mais nova, por exemplo)
 *      é dita — e nunca apagada.
 *   2. Só sai tabela VAZIA. Aposentada com linha fica, e o relatório diz
 *      quantas: o dono decide, com o backup na mão.
 *   3. Só sai tabela no FORMATO de coleção (`seq`, `id`, `data`). Tabela
 *      relacional com nome parecido nunca é tocada.
 */
import type { DatabaseSync } from 'node:sqlite';
import { TABLE_NAMES } from './database.js';

/** As 81 que a rodada 36 tirou de `TABLE_NAMES` sem apagar do arquivo. */
const DA_RODADA_36 = [
  'ecommerce_cart_items', 'ecommerce_checkout_sessions', 'ecommerce_banners',
  'ecommerce_navigation_menus', 'ecommerce_categories', 'ecommerce_collections',
  'ecommerce_collection_items', 'ecommerce_customer_accounts', 'ecommerce_customer_addresses',
  'ecommerce_customer_consents', 'ecommerce_order_items', 'ecommerce_order_history',
  'ecommerce_publication_versions', 'ecommerce_alerts', 'ecommerce_reconciliation',
  'oms_orders', 'oms_fulfillments', 'oms_picking_lists', 'oms_picking_items',
  'oms_packing_lists', 'oms_packing_items', 'oms_romaneios', 'oms_volumes', 'oms_labels',
  'oms_conferences', 'oms_timeline', 'oms_history', 'oms_alerts', 'oms_reconciliation',
  'workshop_orders', 'workshop_schedules', 'workshop_queue', 'workshop_checklists',
  'workshop_diagnostics', 'workshop_estimates', 'workshop_kanban', 'workshop_mechanics',
  'workshop_teams', 'workshop_time_entries', 'workshop_part_requests', 'workshop_attachments',
  'workshop_reports', 'workshop_signatures', 'workshop_warranties', 'workshop_timeline',
  'workshop_history', 'workshop_sync', 'workshop_recovery', 'workshop_reconciliation',
  'workshop_settings',
  'rental_items', 'rental_categories', 'rental_price_tables', 'rental_reservations',
  'rental_availability', 'rental_queue', 'rental_contracts', 'rental_deliveries',
  'rental_returns', 'rental_checklists', 'rental_attachments', 'rental_signatures',
  'rental_documents', 'rental_deposits', 'rental_payments', 'rental_charges',
  'rental_timeline', 'rental_history', 'rental_sync', 'rental_recovery',
  'rental_reconciliation', 'rental_settings',
  'promotions', 'promotion_targets', 'promotion_stores', 'promotion_channels',
  'promotion_quantity_tiers', 'promotion_bundle_items', 'promotion_versions',
  'promotion_history', 'promotion_usage',
];

/**
 * As 90 que o GAP-PRD-141 tirou: sem uma referência em `server/src` fora de
 * `db/` (as de crm_*, automation_* e corporate_bi_* perderam a última com o
 * GAP-PRD-075). A trava `as-tabelas-mortas-saem.test.ts` cobra a regra nos
 * dois sentidos.
 */
const DA_PODA_DO_GAP_141 = [
  'api_tenants', 'api_clients', 'api_audit_logs', 'api_outbox', 'api_inbox',
  'ecommerce_carts', 'ecommerce_orders',
  'logistics_labels', 'logistics_tracking_events', 'logistics_manifests',
  'logistics_alerts', 'logistics_reconciliation',
  'fiscal_operation_natures', 'fiscal_tax_rules', 'fiscal_rule_packs',
  'fiscal_reference_tables', 'fiscal_reference_table_entries', 'fiscal_document_items',
  'fiscal_document_versions', 'fiscal_document_history', 'fiscal_numbering_sequences',
  'fiscal_number_reservations', 'fiscal_contingency_policies', 'fiscal_contingency_sessions',
  'fiscal_operational_attempts', 'fiscal_alerts', 'fiscal_reconciliation', 'fiscal_settings',
  'nfe_document_versions', 'nfe_document_events', 'nfe_authorization_receipts',
  'nfe_protocols', 'nfe_cancellations', 'nfe_correction_letters', 'nfe_number_invalidations',
  'nfe_contingency_sessions', 'nfe_xml_files', 'nfe_danfe_files', 'nfe_alerts',
  'nfce_events', 'nfce_history', 'nfce_sync', 'nfce_recovery', 'nfce_qrcode',
  'crm_leads', 'crm_opportunities', 'crm_pipelines', 'crm_pipeline_stages', 'crm_tasks',
  'crm_segments', 'crm_campaigns', 'crm_score_rules', 'crm_automation_rules', 'crm_sync',
  'crm_recovery', 'crm_reconciliation',
  'corporate_bi_snapshots', 'corporate_bi_kpi_cache', 'corporate_bi_dashboard_cache',
  'corporate_bi_reports', 'corporate_bi_alerts', 'corporate_bi_jobs', 'corporate_bi_history',
  'corporate_bi_reconciliation', 'corporate_bi_sync',
  'automation_rules', 'automation_rule_versions', 'automation_executions',
  'automation_action_executions', 'automation_schedule_state', 'automation_watch_state',
  'automation_approval_requests', 'automation_templates', 'automation_history',
  'automation_alerts', 'automation_operational_attempts', 'automation_dead_letter',
  'automation_reconciliation', 'automation_sync',
  'payment_terminals', 'payment_terminal_transaction_attempts',
  'payment_terminal_settlement_references', 'payment_terminal_alerts',
  'system_release_metadata', 'system_readiness_reports', 'system_backup_manifests',
  'system_audit_entries',
];

/**
 * As da junção do GAP-PRD-075: o conceito delas ganhou um escritor só, no
 * núcleo, e o legado que as lia ou escrevia saiu da árvore.
 *
 *   - `ecommerce_*`: o módulo `services/ecommerce/` só era lido pelo painel de
 *     `/integrations` e pela prontidão de staging, que saíram sem tela; a loja
 *     que vende é `/loja` sobre `core_*`.
 *   - `nfe_*`, `nfce_*` (menos `nfce_settings`, o CSC) e `fiscal_*` (menos
 *     `fiscal_certificate_references`, o A1): o segundo escritor de documento
 *     fiscal. `NfeService`, `NfceService` e `FiscalService` gravavam rascunho,
 *     fila e homologação que nenhuma rota nem tela chamava desde o GAP-PRD-096,
 *     e o emitente e o perfil de produto de `fiscal_issuer_profiles` e
 *     `fiscal_product_profiles` só eram lidos pela prontidão paralela da
 *     Central de Integrações. O documento fiscal é `core_fiscal_documents`; o
 *     emitente, `core_fiscal_configs`. As doze estão com ZERO linha no banco da
 *     loja (leitura somente-leitura de 2026-09-11).
 *   - `asaas_webhook_events`, `asaas_customer_links`, `asaas_charge_links`,
 *     `asaas_sandbox_homologations` e `integration_audit_entries`: um segundo
 *     livro de avisos ao lado de `core_payment_webhooks`, dois vínculos que só
 *     o processador da fila escrevia e ninguém lia, e duas trilhas da
 *     homologação sandbox ao lado de `core_audit_log`. Estas TÊM linha no banco
 *     da loja (5, 3, 3, 15 e 8 — todas de sandbox). O passo 85 copia cada linha
 *     para a verdade do núcleo e só então a apaga (a cópia e o snapshot da
 *     migração vêm antes); o que não tiver para onde ir fica, e a poda diz.
 */
const DA_JUNCAO_DO_GAP_075 = [
  'ecommerce_storefronts', 'ecommerce_product_publications', 'ecommerce_operational_attempts',
  'ecommerce_themes', 'ecommerce_content_pages', 'ecommerce_domain_bindings',
  'fiscal_issuer_profiles', 'fiscal_product_profiles', 'fiscal_documents',
  'nfe_configurations', 'nfe_documents', 'nfe_operational_attempts',
  'nfe_homologation_executions', 'nfe_reconciliation',
  'nfce_documents', 'nfce_queue', 'nfce_reconciliation', 'nfce_homologation_executions',
  'asaas_webhook_events', 'asaas_customer_links', 'asaas_charge_links',
  'asaas_sandbox_homologations', 'integration_audit_entries',
  // Sem escritor nenhum: o envio é `core_shipments` (GAP-PRD-120), e a
  // "conciliação" da maquininha só era lida por uma rota que respondia a
  // lista vazia. As duas com ZERO linha no banco da loja.
  'logistics_shipments', 'payment_terminal_reconciliation',
];

export const TABELAS_APOSENTADAS: readonly string[] = [
  ...DA_RODADA_36,
  ...DA_PODA_DO_GAP_141,
  ...DA_JUNCAO_DO_GAP_075,
];

export interface ResultadoDaPoda {
  /** `true` quando nada foi escrito (só contagem). */
  ensaio: boolean;
  /** Aposentadas e vazias: saem quando se aplica. */
  aRemover: string[];
  /** As que saíram de fato (vazio no ensaio). */
  removidas: string[];
  /** Aposentadas com linha: ficam, e o dono decide. */
  mantidasComDado: Array<{ nome: string; linhas: number }>;
  /** No formato de coleção, fora de toda lista: nunca se apaga o que não se conhece. */
  desconhecidas: string[];
}

function formatoDeColecao(db: DatabaseSync, nome: string): boolean {
  const colunas = (db.prepare(`PRAGMA table_info("${nome}")`).all() as { name: string }[]).map((c) => c.name);
  return colunas.join(',') === 'seq,id,data';
}

/**
 * Confere (e, com `aplicar`, apaga) as tabelas aposentadas do banco aberto em
 * `db`. Funciona dentro ou fora de uma transação do chamador (SAVEPOINT), para
 * servir ao passo de consolidação e ao comando.
 */
export function podarTabelasAposentadas(db: DatabaseSync, opcoes: { aplicar: boolean }): ResultadoDaPoda {
  const vivas = new Set<string>(TABLE_NAMES);
  const aposentadas = new Set(TABELAS_APOSENTADAS);
  const resultado: ResultadoDaPoda = {
    ensaio: !opcoes.aplicar,
    aRemover: [],
    removidas: [],
    mantidasComDado: [],
    desconhecidas: [],
  };

  const tabelas = (db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' "
        + "AND name NOT LIKE 'core_%' AND name <> 'db_meta' ORDER BY name",
    )
    .all() as { name: string }[]).map((r) => r.name);

  for (const nome of tabelas) {
    if (vivas.has(nome) || !formatoDeColecao(db, nome)) continue;
    if (!aposentadas.has(nome)) {
      resultado.desconhecidas.push(nome);
      continue;
    }
    const linhas = Number((db.prepare(`SELECT COUNT(*) AS n FROM "${nome}"`).get() as { n: number }).n);
    if (linhas === 0) resultado.aRemover.push(nome);
    else resultado.mantidasComDado.push({ nome, linhas });
  }

  if (opcoes.aplicar && resultado.aRemover.length > 0) {
    db.exec('SAVEPOINT poda_das_aposentadas;');
    try {
      for (const nome of resultado.aRemover) db.exec(`DROP TABLE IF EXISTS "${nome}";`);
      db.exec('RELEASE poda_das_aposentadas;');
    } catch (err) {
      db.exec('ROLLBACK TO poda_das_aposentadas;');
      db.exec('RELEASE poda_das_aposentadas;');
      throw err;
    }
    resultado.removidas = [...resultado.aRemover];
  }
  return resultado;
}
