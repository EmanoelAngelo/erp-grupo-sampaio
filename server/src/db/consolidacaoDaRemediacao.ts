/**
 * ============================================================================
 * PASSO 85 — A CONSOLIDAÇÃO DA REMEDIAÇÃO DE PRODUÇÃO
 * ============================================================================
 *
 * A remediação dos 210 gaps de prontidão rodou em frentes paralelas, e nenhuma
 * delas podia criar passo numerado: os passos são contíguos, e duas frentes
 * criando "o 85" colidiriam. Cada frente deixou em
 * `docs/audits/remediacao/migracoes/<FRENTE>.md` o que o boot NÃO pode fazer
 * sozinho — índice sobre coluna nova de tabela existente e correção de dado.
 * Este módulo é o passo único que junta tudo, com uma regra por espécie:
 *
 *  - ÍNDICE DE DESEMPENHO: cria (idempotente). A coluna que ele usa é
 *    acrescentada antes (`addColumn`), porque o `reconcileCoreSchema` só roda
 *    DEPOIS dos passos — sem isto o índice falharia em banco antigo.
 *  - ÍNDICE ÚNICO COM PRÉ-CONDIÇÃO (placa do equipamento; uma gaveta sem caixa
 *    por operação): confere antes. Banco que tem o dado que o índice recusaria
 *    NÃO derruba o boot — a pendência fica registrada com o que resolver e
 *    onde, e `resolverPendenciasDaConsolidacao` tenta de novo a cada subida,
 *    até o dono corrigir pela tela.
 *  - CORREÇÃO DE DADO: só a que é segura sem decisão de ninguém — segredo em
 *    claro, configuração de TESTE ligada, vínculo que o próprio dado prova,
 *    marca que só torna explícito o que o código já lê do nulo. O que muda
 *    dinheiro, competência ou documento fiscal NÃO entra aqui: tem tela, rota
 *    ou comando próprio, e a prontidão aponta. A exceção é a COMPETÊNCIA
 *    LEGADA no dia de Greenwich (GAP-PRD-142), porque ali não há decisão: só
 *    lançamento automático, só a diferença de fuso, só linha que ninguém
 *    baixou nem editou — e cada linha corrigida ganha trilha de auditoria.
 *  - REPARO DO ESQUEMA (GAP-PRD-140): o banco contra um banco novo desta
 *    build — índice faltando ou diferente, tabela com DEFAULT ou constraint
 *    antiga. A reconstrução de tabela não cabe na transação (o PRAGMA das
 *    chaves estrangeiras não muda dentro de uma): roda logo DEPOIS dela, a
 *    cada subida, em `repararEsquema` (`derivaDoEsquema.ts`).
 *
 * Tudo roda dentro da transação da migração (o snapshot já foi tirado, porque
 * havia passo pendente). Cada item é um SAVEPOINT: o que falhar vira pendência
 * e o resto segue — um índice que não nasce não pode custar a subida da loja.
 */
import type { DatabaseSync } from 'node:sqlite';
import { diaDaLojaSql } from '../services/core/CalendarioOperacional.js';
import { STATEMENTS } from './schema.js';

export interface FerramentasDaMigracao {
  addColumn(table: string, column: string, ddl: string): void;
  tableExists(table: string): boolean;
  columns(table: string): Set<string>;
}

export interface PendenciaDaConsolidacao {
  chave: string;
  titulo: string;
  motivo: string;
  comoResolver: string;
  origem: string;
  detalhe?: unknown;
  registradaEm: string;
}

export interface ResultadoDaConsolidacao {
  aplicados: string[];
  pulados: string[];
  pendencias: PendenciaDaConsolidacao[];
}

const PREFIXO_PENDENCIA = 'consolidacao85:pendencia:';
const CHAVE_RESULTADO = 'consolidacao85:resultado';

/**
 * O marcador que a fila de e-mail põe no lugar do segredo. Igual, caractere a
 * caractere, a `MARCA_DO_CONTEUDO_PROTEGIDO` (EmailService) — o teste do passo
 * confere; o módulo de banco não importa serviço.
 */
export const MARCA_DO_CONTEUDO_PROTEGIDO_NA_MIGRACAO = '[protegido: só o cliente recebe]';

/** Os corpos de hoje dos dois modelos com segredo (EmailService), com o marcador. */
export const CORPO_ATUAL_RECUPERACAO =
  'Você pediu para redefinir a senha da sua conta no Grupo Sampaio.\n\n'
  + `Abra este link para escolher uma nova senha (vale por 1 hora):\n${MARCA_DO_CONTEUDO_PROTEGIDO_NA_MIGRACAO}\n\n`
  + 'Se não foi você, ignore este e-mail: sua senha continua a mesma.\n\n'
  + 'Grupo Sampaio';
export const CORPO_ATUAL_VERIFICACAO =
  'Olá!\n\n'
  + `Seu código de confirmação no Grupo Sampaio é: ${MARCA_DO_CONTEUDO_PROTEGIDO_NA_MIGRACAO}\n\n`
  + 'Digite-o na página "Minha conta" para provar que este e-mail é seu.\n'
  + 'Ele vale por 1 hora. Se não foi você, ignore esta mensagem.\n\n'
  + 'Grupo Sampaio';

// ---------------------------------------------------------------- índices

interface IndiceDeDesempenho {
  nome: string;
  tabela: string;
  /** Colunas novas que o índice usa: acrescentadas antes (tipo idêntico ao da DDL canônica). */
  colunas: [string, string][];
  sql: string;
  origem: string;
}

const INDICES: IndiceDeDesempenho[] = [
  // FIN — Asaas e financeiro
  { nome: 'ix_payment_webhooks_company_received', tabela: 'core_payment_webhooks', colunas: [['company_id', 'TEXT']],
    sql: 'CREATE INDEX IF NOT EXISTS ix_payment_webhooks_company_received ON core_payment_webhooks (company_id, received_at)',
    origem: 'FIN GAP-PRD-002' },
  { nome: 'ix_payment_intents_company_status_checked', tabela: 'core_payment_intents', colunas: [['provider_checked_at', 'TEXT']],
    sql: 'CREATE INDEX IF NOT EXISTS ix_payment_intents_company_status_checked ON core_payment_intents (company_id, status, provider_checked_at)',
    origem: 'FIN GAP-PRD-016' },
  { nome: 'ix_payment_intents_installment_ref', tabela: 'core_payment_intents',
    colunas: [['installment_count', 'INTEGER'], ['provider_installment_ref', 'TEXT']],
    sql: 'CREATE INDEX IF NOT EXISTS ix_payment_intents_installment_ref ON core_payment_intents (provider_installment_ref) WHERE provider_installment_ref IS NOT NULL',
    origem: 'FIN GAP-PRD-114' },
  { nome: 'ix_sale_payments_intent', tabela: 'core_sale_payments', colunas: [['payment_intent_id', 'TEXT'], ['settled_at', 'TEXT']],
    sql: 'CREATE INDEX IF NOT EXISTS ix_sale_payments_intent ON core_sale_payments (payment_intent_id) WHERE payment_intent_id IS NOT NULL',
    origem: 'FIN GAP-PRD-077' },
  { nome: 'ix_sale_payments_company_status', tabela: 'core_sale_payments', colunas: [],
    sql: 'CREATE INDEX IF NOT EXISTS ix_sale_payments_company_status ON core_sale_payments (company_id, status)',
    origem: 'FIN GAP-PRD-077' },
  // EML — fila de e-mail
  { nome: 'ix_email_queue_proxima_tentativa', tabela: 'core_email_queue', colunas: [['next_attempt_at', 'TEXT']],
    sql: 'CREATE INDEX IF NOT EXISTS ix_email_queue_proxima_tentativa ON core_email_queue (status, next_attempt_at)',
    origem: 'EML GAP-PRD-038' },
  // SEG — poda diária da trilha
  { nome: 'ix_audit_created', tabela: 'core_audit_log', colunas: [],
    sql: 'CREATE INDEX IF NOT EXISTS ix_audit_created ON core_audit_log (created_at)',
    origem: 'SEG GAP-PRD-073' },
  // ECO — conta do cliente, pedidos pagos, estoque promocional
  { nome: 'ix_orders_account', tabela: 'core_orders', colunas: [['customer_account_id', 'TEXT']],
    sql: 'CREATE INDEX IF NOT EXISTS ix_orders_account ON core_orders (customer_account_id, created_at)',
    origem: 'ECO GAP-PRD-043' },
  { nome: 'ix_orders_customer_email_norm', tabela: 'core_orders', colunas: [],
    sql: 'CREATE INDEX IF NOT EXISTS ix_orders_customer_email_norm ON core_orders (LOWER(TRIM(customer_email)))',
    origem: 'ECO GAP-PRD-043' },
  { nome: 'ix_customers_email_norm', tabela: 'core_customers', colunas: [],
    sql: 'CREATE INDEX IF NOT EXISTS ix_customers_email_norm ON core_customers (LOWER(TRIM(email)))',
    origem: 'ECO GAP-PRD-006' },
  { nome: 'ix_orders_company_paid', tabela: 'core_orders', colunas: [],
    sql: 'CREATE INDEX IF NOT EXISTS ix_orders_company_paid ON core_orders (company_id, paid_at)',
    origem: 'ECO GAP-PRD-132' },
  { nome: 'ix_sale_items_promotion', tabela: 'core_sale_items', colunas: [['promotion_id', 'TEXT']],
    sql: 'CREATE INDEX IF NOT EXISTS ix_sale_items_promotion ON core_sale_items (promotion_id)',
    origem: 'ECO GAP-PRD-194' },
  { nome: 'ix_order_items_promotion', tabela: 'core_order_items', colunas: [['promotion_id', 'TEXT']],
    sql: 'CREATE INDEX IF NOT EXISTS ix_order_items_promotion ON core_order_items (promotion_id)',
    origem: 'ECO GAP-PRD-194' },
  // PAG — retirada do agente de impressão
  { nome: 'ix_print_jobs_agent_ready', tabela: 'core_print_jobs', colunas: [['transport', 'TEXT'], ['pdv_terminal_id', 'TEXT']],
    sql: "CREATE INDEX IF NOT EXISTS ix_print_jobs_agent_ready ON core_print_jobs (company_id, pdv_terminal_id, created_at) WHERE transport = 'agent' AND status IN ('ready', 'printing')",
    origem: 'PAG GAP-PRD-082' },
];

interface IndiceUnicoComPreCondicao {
  nome: string;
  tabela: string;
  colunas: [string, string][];
  /** Tem de voltar VAZIA; o que voltar é o que impede o índice. */
  conferencia: string;
  sql: string;
  titulo: string;
  comoResolver: string;
  origem: string;
}

const UNICOS: IndiceUnicoComPreCondicao[] = [
  {
    nome: 'ux_equipment_plate', tabela: 'core_equipment', colunas: [['plate', 'TEXT']],
    conferencia:
      'SELECT company_id, plate, COUNT(*) AS n FROM core_equipment WHERE plate IS NOT NULL GROUP BY company_id, plate HAVING COUNT(*) > 1',
    sql: 'CREATE UNIQUE INDEX IF NOT EXISTS ux_equipment_plate ON core_equipment (company_id, plate) WHERE plate IS NOT NULL',
    titulo: 'Placa repetida em dois equipamentos da mesma operação',
    comoResolver: 'Oficina › Equipamentos › ficha › Corrigir identidade: deixe cada placa num equipamento só.',
    origem: 'OFI GAP-PRD-106',
  },
  {
    nome: 'ux_cash_open_sem_terminal', tabela: 'core_cash_sessions', colunas: [],
    conferencia:
      "SELECT company_id, COUNT(*) AS n FROM core_cash_sessions WHERE status = 'open' AND terminal_id IS NULL GROUP BY company_id HAVING COUNT(*) > 1",
    sql: "CREATE UNIQUE INDEX IF NOT EXISTS ux_cash_open_sem_terminal ON core_cash_sessions (company_id) WHERE status = 'open' AND terminal_id IS NULL",
    titulo: 'Mais de uma gaveta sem caixa aberta na mesma operação',
    comoResolver: 'Vendas › Caixa › Gavetas abertas nesta operação › Fechar esta gaveta, contando o dinheiro.',
    origem: 'PAG GAP-PRD-146',
  },
];

/**
 * Onde se corrige o que impede um índice ÚNICO desta consolidação — o mesmo texto
 * da pendência dela. O reparo do esquema (`derivaDoEsquema.ts`) usa isto quando o
 * índice volta a faltar (banco restaurado de antes dele) e os dados repetidos o
 * recusam, em vez de mostrar a mensagem crua do SQLite.
 */
export function comoResolverOIndiceUnico(nome: string): string | null {
  return UNICOS.find((u) => u.nome === nome)?.comoResolver ?? null;
}

/** As coleções com segredo ou credencial por empresa (DEP, GAP-PRD-147). */
const COLECOES_POR_EMPRESA = [
  'integration_secrets',
  'integration_configurations',
  'fiscal_certificate_references',
  'nfce_settings',
  'logistics_carrier_credentials',
  'payment_terminal_configurations',
  'payment_terminal_local_agents',
];

// ---------------------------------------------------------------- correções de dado

interface CorrecaoDeDado {
  nome: string;
  origem: string;
  /** Tabelas que precisam existir; sem elas, a correção é pulada (nada a corrigir). */
  precisa: string[];
  /** Colunas novas lidas ou gravadas: acrescentadas antes. */
  colunas?: [string, string, string][];
  aplicar(db: DatabaseSync): number;
}

const AGORA_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

const CORRECOES: CorrecaoDeDado[] = [
  {
    // EML GAP-PRD-007: o link de recuperação e o código de verificação que ficaram EM CLARO
    // no corpo das linhas antigas. A pendente com menos de 1 h fica (ainda vale; o carteiro
    // mascara ao terminar); a antiga passa a ter o marcador e o carteiro a encerra.
    nome: 'eml_segredo_em_claro_nas_linhas_antigas', origem: 'EML GAP-PRD-007', precisa: ['core_email_queue'],
    aplicar(db) {
      const sql = `UPDATE core_email_queue SET body_text = ?
                    WHERE template = ? AND instr(body_text, ?) = 0
                      AND NOT (status = 'pending' AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hour'))`;
      const m = MARCA_DO_CONTEUDO_PROTEGIDO_NA_MIGRACAO;
      const a = db.prepare(sql).run(CORPO_ATUAL_RECUPERACAO, 'recuperacao_senha', m).changes;
      const b = db.prepare(sql).run(CORPO_ATUAL_VERIFICACAO, 'verificacao_email', m).changes;
      return Number(a) + Number(b);
    },
  },
  {
    // FIN GAP-PRD-174: o título do fechamento de comissão antigo nascia 'manual'; o vínculo
    // morava só em core_commission_closings.finance_entry_id. Valor e baixa não mudam.
    nome: 'fin_titulo_do_fechamento_de_comissao', origem: 'FIN GAP-PRD-174',
    precisa: ['core_finance_entries', 'core_commission_closings'],
    aplicar(db) {
      return Number(db.prepare(
        `UPDATE core_finance_entries
            SET origin_type = 'commission_closing',
                origin_id = (SELECT c.id FROM core_commission_closings c
                              WHERE c.finance_entry_id = core_finance_entries.id
                                AND c.company_id = core_finance_entries.company_id)
          WHERE origin_type = 'manual'
            AND installment_total = 1
            AND EXISTS (SELECT 1 FROM core_commission_closings c
                         WHERE c.finance_entry_id = core_finance_entries.id
                           AND c.company_id = core_finance_entries.company_id)`,
      ).run().changes);
    },
  },
  {
    // SEG GAP-PRD-040: as contas do seed antigo nasceram sem a bandeira de senha provisória,
    // com as senhas compartilhadas de desenvolvimento. Só as que NUNCA entraram: quem já
    // entrou e trocou não é incomodado (a gerência reseta essas pela tela, se quiser).
    nome: 'seg_senha_do_seed_provisoria', origem: 'SEG GAP-PRD-040', precisa: ['core_users'],
    aplicar(db) {
      return Number(db.prepare(
        `UPDATE core_users
            SET must_change_password = 1, session_version = session_version + 1, updated_at = ${AGORA_SQL}
          WHERE must_change_password = 0 AND last_login_at IS NULL
            AND login IN ('ADMIN', 'CARLOSGERENTE',
                          'preco-justo.pdv', 'gringa.pdv', 'me-mimei.pdv', 'conceito.pdv', 'pj-motors.pdv', 'oficina.pdv',
                          'ROBERTOMECANICO', 'MARCOSMECANICO', 'PAULOMECANICO', 'LUCASMECANICO', 'JOAOCELULAR')`,
      ).run().changes);
    },
  },
  {
    // OFI GAP-PRD-182: pedido de aprovação pendurado em OS que já saiu da bancada.
    nome: 'ofi_aprovacao_pendurada_fora_da_bancada', origem: 'OFI GAP-PRD-182', precisa: ['core_service_orders'],
    aplicar(db) {
      return Number(db.prepare(
        `UPDATE core_service_orders SET approval_requested_at = NULL
          WHERE approval_requested_at IS NOT NULL AND approved_at IS NULL
            AND status IN ('aguardando_pagamento', 'finalizada')`,
      ).run().changes);
    },
  },
  {
    // PAG GAP-PRD-001: a configuração de maquininha de TESTE ('mock') ligada aprova cartão sem
    // dinheiro. Rastro e auditoria ANTES de desligar, nos mesmos formatos da rota.
    nome: 'pag_maquininha_de_teste_desligada', origem: 'PAG GAP-PRD-001',
    precisa: ['payment_terminal_configurations', 'payment_terminal_history', 'core_audit_log'],
    aplicar(db) {
      const motivo = 'GAP-PRD-001: provider de teste (mock) desligado na consolidação — aprova cartão sem dinheiro.';
      const alvo = "json_valid(data) AND json_extract(data, '$.provider') = 'mock' AND COALESCE(json_extract(data, '$.active'), 1) <> 0";
      db.prepare(
        `INSERT INTO payment_terminal_history (id, data)
         SELECT 'pthist-mig-' || id,
                json_object('id', 'pthist-mig-' || id, 'companyId', json_extract(data, '$.companyId'),
                            'configurationId', id, 'provider', 'mock', 'action', 'configuration_deactivated',
                            'reason', ?, 'userId', 'migracao-consolidacao', 'createdAt', ${AGORA_SQL})
           FROM payment_terminal_configurations WHERE ${alvo}`,
      ).run(motivo);
      db.prepare(
        `INSERT INTO core_audit_log (id, company_id, user_id, action, entity_type, entity_id, detail, ip, created_at)
         SELECT 'audit-mig-' || id, json_extract(data, '$.companyId'), NULL,
                'payment_terminal.configuration.deactivated', 'payment_terminal_configuration', id,
                json_object('provider', 'mock', 'reason', ?, 'simulated', json('true'), 'by', 'migracao-consolidacao'),
                NULL, ${AGORA_SQL}
           FROM payment_terminal_configurations WHERE ${alvo}`,
      ).run(motivo);
      return Number(db.prepare(
        `UPDATE payment_terminal_configurations
            SET data = json_set(data, '$.active', json('false'), '$.deactivatedAt', ${AGORA_SQL},
                                '$.deactivatedBy', 'migracao-consolidacao', '$.deactivationReason', ?,
                                '$.updatedAt', ${AGORA_SQL})
          WHERE ${alvo}`,
      ).run(motivo).changes);
    },
  },
  {
    // PAG GAP-PRD-078: o PIX pago na maquininha antes do carimbo e usado numa venda CONCLUÍDA
    // (a linha de pagamento aponta a cobrança). Venda cancelada fica fora: é estorno a fazer.
    nome: 'pag_pix_da_maquininha_amarrado_a_venda', origem: 'PAG GAP-PRD-078',
    precisa: ['payment_terminal_transactions', 'core_sale_payments', 'core_sales'],
    aplicar(db) {
      const venda = `FROM core_sale_payments p JOIN core_sales s ON s.id = p.sale_id
                      WHERE p.provider_ref = payment_terminal_transactions.id
                        AND p.company_id = json_extract(payment_terminal_transactions.data, '$.companyId')
                        AND s.status = 'completed'`;
      return Number(db.prepare(
        `UPDATE payment_terminal_transactions
            SET data = json_set(data,
                  '$.saleId', (SELECT p.sale_id ${venda} LIMIT 1),
                  '$.saleNumber', (SELECT s.number ${venda} LIMIT 1),
                  '$.boundAt', ${AGORA_SQL}, '$.boundBy', 'migracao-consolidacao')
          WHERE json_valid(data) AND json_extract(data, '$.paymentMethod') = 'pix'
            AND json_extract(data, '$.saleId') IS NULL
            AND EXISTS (SELECT 1 ${venda})`,
      ).run().changes);
    },
  },
  {
    // ECO GAP-PRD-006: a origem dos cadastros legados, pelo que o próprio dado prova. Nulo
    // continua o lado seguro (não propaga documento); estes dois critérios o tornam explícito.
    nome: 'eco_origem_dos_cadastros_legados', origem: 'ECO GAP-PRD-006',
    precisa: ['core_customers', 'core_orders', 'core_sales', 'core_quotes', 'core_service_orders', 'core_consignments', 'core_rental_contracts'],
    colunas: [['core_customers', 'origin', 'TEXT']],
    aplicar(db) {
      const a = db.prepare(
        `UPDATE core_customers SET origin = 'balcao'
          WHERE origin IS NULL
            AND id NOT IN (SELECT customer_id FROM core_orders WHERE customer_id IS NOT NULL)
            AND (   id IN (SELECT customer_id FROM core_sales WHERE customer_id IS NOT NULL)
                 OR id IN (SELECT customer_id FROM core_quotes WHERE customer_id IS NOT NULL)
                 OR id IN (SELECT customer_id FROM core_service_orders WHERE customer_id IS NOT NULL)
                 OR id IN (SELECT customer_id FROM core_consignments WHERE customer_id IS NOT NULL)
                 OR id IN (SELECT customer_id FROM core_rental_contracts WHERE customer_id IS NOT NULL))`,
      ).run().changes;
      const b = db.prepare(
        `UPDATE core_customers SET origin = 'loja_online'
          WHERE origin IS NULL
            AND id IN (SELECT customer_id FROM core_orders WHERE customer_id IS NOT NULL)
            AND id NOT IN (SELECT customer_id FROM core_sales WHERE customer_id IS NOT NULL)`,
      ).run().changes;
      return Number(a) + Number(b);
    },
  },
  {
    // ECO GAP-PRD-115: o tipo dos endereços anteriores à regra, pelo mesmo critério do código.
    nome: 'eco_tipo_dos_enderecos_legados', origem: 'ECO GAP-PRD-115', precisa: ['core_customer_addresses'],
    colunas: [['core_customer_addresses', 'kind', 'TEXT']],
    aplicar(db) {
      return Number(db.prepare(
        `UPDATE core_customer_addresses
            SET kind = CASE WHEN city_ibge IS NOT NULL AND TRIM(city_ibge) <> '' THEN 'ambos' ELSE 'entrega' END
          WHERE kind IS NULL`,
      ).run().changes);
    },
  },
  {
    // ECO GAP-PRD-122: o reembolso antigo JÁ devolveu o estoque (movimento do pedido).
    nome: 'eco_mercadoria_do_reembolso_antigo', origem: 'ECO GAP-PRD-122', precisa: ['core_orders', 'core_stock_movements'],
    colunas: [['core_orders', 'return_goods_status', 'TEXT'], ['core_orders', 'return_goods_at', 'TEXT']],
    aplicar(db) {
      return Number(db.prepare(
        `UPDATE core_orders
            SET return_goods_status = 'recebida',
                return_goods_at = (SELECT MIN(m.created_at) FROM core_stock_movements m
                                    WHERE m.reference_type = 'ecommerce_order_refund' AND m.reference_id = core_orders.id)
          WHERE status = 'reembolsado' AND return_goods_status IS NULL
            AND EXISTS (SELECT 1 FROM core_stock_movements m
                         WHERE m.reference_type = 'ecommerce_order_refund' AND m.reference_id = core_orders.id)`,
      ).run().changes);
    },
  },
  {
    // ECO GAP-PRD-032/197: promoção inválida (valor fora da regra, produto de outra empresa)
    // ENCERRADA — não apagada: explica vendas antigas. O preço já a ignorava.
    nome: 'eco_promocoes_invalidas_encerradas', origem: 'ECO GAP-PRD-032', precisa: ['core_promotions', 'core_products'],
    colunas: [['core_promotions', 'updated_at', 'TEXT'], ['core_promotions', 'updated_by', 'TEXT']],
    aplicar(db) {
      return Number(db.prepare(
        `UPDATE core_promotions SET active = 0, updated_at = ${AGORA_SQL}, updated_by = 'migracao-consolidacao'
          WHERE active = 1 AND (
                (price_cents IS NOT NULL AND price_cents < 0)
             OR (percent_off IS NOT NULL AND (percent_off <= 0 OR percent_off > 100))
             OR (price_cents IS NOT NULL AND percent_off IS NOT NULL)
             OR (price_cents IS NULL AND percent_off IS NULL)
             OR (ends_at IS NOT NULL AND ends_at < starts_at)
             OR (product_id IS NULL AND category IS NULL)
             OR (product_id IS NOT NULL AND NOT EXISTS (
                   SELECT 1 FROM core_products p WHERE p.id = core_promotions.product_id AND p.company_id = core_promotions.company_id)))`,
      ).run().changes);
    },
  },
  {
    // FIS GAP-PRD-179: certificado revogado ainda com a senha e o arquivo selados; e o
    // válido com carimbo de revogação (reenvio pela versão antiga).
    nome: 'fis_certificado_revogado_sem_segredo', origem: 'FIS GAP-PRD-179', precisa: ['fiscal_certificate_references'],
    aplicar(db) {
      const a = db.prepare(
        `UPDATE fiscal_certificate_references SET data = json_remove(data, '$.encryptedPassword', '$.encryptedPfx')
          WHERE json_valid(data) AND json_extract(data, '$.status') = 'revoked'
            AND (json_type(data, '$.encryptedPassword') IS NOT NULL OR json_type(data, '$.encryptedPfx') IS NOT NULL)`,
      ).run().changes;
      const b = db.prepare(
        `UPDATE fiscal_certificate_references SET data = json_remove(data, '$.revokedAt', '$.revokeReason')
          WHERE json_valid(data) AND json_extract(data, '$.status') = 'valid' AND json_type(data, '$.revokedAt') IS NOT NULL`,
      ).run().changes;
      return Number(a) + Number(b);
    },
  },
  {
    // DEP GAP-PRD-058: a digital do PACOTE de fotos (formato 1) deixou de ter leitor.
    nome: 'dep_digital_antiga_do_pacote_de_fotos', origem: 'DEP GAP-PRD-058', precisa: ['core_meta'],
    aplicar(db) {
      return Number(db.prepare("DELETE FROM core_meta WHERE key = 'uploads_backup_digital'").run().changes);
    },
  },
  {
    // DEP GAP-PRD-144: `ix_stock_mov_product` é idêntico a `ix_stock_movements_product`
    // (mesmas colunas, mesma ordem) — cada movimento do razão pagava duas escritas de
    // índice. Só derruba enquanto o gêmeo EXISTE: o razão nunca fica sem o índice.
    nome: 'dep_indice_duplicado_do_razao', origem: 'DEP GAP-PRD-144', precisa: ['core_stock_movements'],
    aplicar(db) {
      const gemeo = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'ix_stock_movements_product'")
        .get();
      if (!gemeo) return 0;
      const tinha = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'ix_stock_mov_product'").get();
      db.exec('DROP INDEX IF EXISTS ix_stock_mov_product');
      return tinha ? 1 : 0;
    },
  },
  {
    // INT DFE-AMBIENTE (GAP-PRD-168): o NSU da Distribuição DF-e é por ambiente. A tabela
    // ganha o ambiente de cada documento e troca UNIQUE (company_id, nsu) por
    // (company_id, environment, nsu) — reconstrução, com todas as linhas, rowid e índices.
    nome: 'dfe_ambiente_por_documento', origem: 'INT DFE-AMBIENTE (GAP-PRD-168)', precisa: ['core_dfe_documents'],
    aplicar(db) {
      const r = garantirAmbienteDosDocumentosDfe(db);
      return r.preenchidas;
    },
  },
  {
    // INT GAP-PRD-142: a competência legada no dia de GREENWICH. Só lançamento automático
    // (venda, pedido online, devolução, entrada de nota) cuja competência é o dia UTC do
    // carimbo e difere do dia da loja, sem baixa nem edição de gente; o vencimento vai
    // junto só quando era igual à competência antiga. Cada linha ganha trilha.
    nome: 'fin_competencia_legada_no_dia_da_loja', origem: 'INT GAP-PRD-142',
    precisa: ['core_finance_entries', 'core_finance_settlements', 'core_audit_log'],
    colunas: [['core_finance_entries', 'competence_date', 'TEXT'], ['core_finance_entries', 'cancelled_at', 'TEXT']],
    aplicar(db) {
      return corrigirCompetenciaLegada(db).linhas.length;
    },
  },
  /*
    LEG GAP-PRD-075 — UM ESCRITOR POR CONCEITO. As três abaixo levam para a verdade do
    núcleo o que ficou em coleções aposentadas que TÊM linha no banco da loja. A regra é
    a mesma nas três: COPIAR, e só então apagar a linha cuja cópia está no núcleo (o
    snapshot da migração já foi tirado). Linha sem para onde ir fica, e a poda
    (`db:podar-legado`) diz que ela ficou. Nada disso muda dinheiro: são avisos de
    sandbox, vínculos de teste e trilha de homologação.
  */
  {
    // O segundo livro de avisos do Asaas (`asaas_webhook_events`, da rota antiga antes do
    // GAP-PRD-002) entra em `core_payment_webhooks` como JÁ TRATADO — `processed = 1` e a
    // nota no `error` —, para que ninguém o reprocesse. Evento que o núcleo já tem
    // (mesmo provider + event_id) não é duplicado: a linha antiga só sai.
    nome: 'leg_avisos_do_asaas_no_livro_do_nucleo', origem: 'LEG GAP-PRD-075',
    precisa: ['asaas_webhook_events', 'core_payment_webhooks'],
    colunas: [['core_payment_webhooks', 'company_id', 'TEXT']],
    aplicar(db) {
      const nota = 'Aviso recebido pela rota antiga (asaas_webhook_events) antes do GAP-PRD-002; '
        + 'copiado para o livro do núcleo sem reprocessar (GAP-PRD-075).';
      db.prepare(
        `INSERT OR IGNORE INTO core_payment_webhooks
           (id, provider, event_id, event_type, payload, processed, processed_at, error, received_at, company_id)
         SELECT 'legado-awe-' || seq, 'asaas', json_extract(data, '$.eventId'), json_extract(data, '$.eventType'),
                COALESCE(json_extract(data, '$.payload'), '{}'), 1,
                COALESCE(json_extract(data, '$.processedAt'), json_extract(data, '$.createdAt'), ${AGORA_SQL}),
                ?, COALESCE(json_extract(data, '$.createdAt'), ${AGORA_SQL}), json_extract(data, '$.companyId')
           FROM asaas_webhook_events
          WHERE json_valid(data) AND json_type(data, '$.eventId') = 'text'`,
      ).run(nota);
      return Number(db.prepare(
        `DELETE FROM asaas_webhook_events
          WHERE json_valid(data)
            AND EXISTS (SELECT 1 FROM core_payment_webhooks w
                         WHERE w.provider = 'asaas' AND w.event_id = json_extract(asaas_webhook_events.data, '$.eventId'))`,
      ).run().changes);
    },
  },
  {
    // Os vínculos que só o processador da fila escrevia e ninguém lia
    // (`asaas_customer_links`, `asaas_charge_links`) vão para a própria tentativa, em
    // `remoteLink` — é onde o processador grava agora. Casa pela empresa e pelo que o
    // processador usava: `sourceId` (cliente) ou a chave de idempotência (cobrança).
    nome: 'leg_vinculos_da_fila_asaas_na_tentativa', origem: 'LEG GAP-PRD-075',
    precisa: ['asaas_operational_attempts'],
    aplicar(db) {
      const existe = (t: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t));
      const levar = (colecao: string, tipo: string, campoDoVinculo: string, campoDaTentativa: string): number => {
        if (!existe(colecao)) return 0;
        const casa = `FROM "${colecao}" l
                       WHERE json_valid(l.data)
                         AND json_extract(l.data, '$.companyId') = json_extract(asaas_operational_attempts.data, '$.companyId')
                         AND json_extract(l.data, '$.${campoDoVinculo}') = json_extract(asaas_operational_attempts.data, '$.${campoDaTentativa}')`;
        db.prepare(
          `UPDATE asaas_operational_attempts
              SET data = json_set(data, '$.remoteLink', json((SELECT l.data ${casa} ORDER BY l.seq LIMIT 1)))
            WHERE json_valid(data) AND json_extract(data, '$.operationType') = ?
              AND json_type(data, '$.remoteLink') IS NULL AND EXISTS (SELECT 1 ${casa})`,
        ).run(tipo);
        return Number(db.prepare(
          `DELETE FROM "${colecao}"
            WHERE json_valid(data)
              AND EXISTS (SELECT 1 FROM asaas_operational_attempts a
                           WHERE json_valid(a.data)
                             AND json_extract(a.data, '$.remoteLink.id') = json_extract("${colecao}".data, '$.id'))`,
        ).run().changes);
      };
      return levar('asaas_customer_links', 'asaas_customer_sync', 'customerId', 'sourceId')
        + levar('asaas_charge_links', 'asaas_charge_create', 'idempotencyKey', 'idempotencyKey');
    },
  },
  {
    // As duas trilhas da homologação sandbox fora do núcleo (`integration_audit_entries`
    // e `asaas_sandbox_homologations`) vão para `core_audit_log`, com o registro inteiro
    // no `detail`. A chave da cópia é o `seq` da linha antiga: duas linhas nunca viram uma.
    nome: 'leg_trilha_da_homologacao_asaas_no_nucleo', origem: 'LEG GAP-PRD-075',
    precisa: ['core_audit_log'],
    aplicar(db) {
      const existe = (t: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t));
      const levar = (colecao: string, prefixo: string, acao: string, entidade: string, quando: string): number => {
        if (!existe(colecao)) return 0;
        db.prepare(
          `INSERT OR IGNORE INTO core_audit_log (id, company_id, user_id, action, entity_type, entity_id, detail, ip, created_at)
           SELECT '${prefixo}' || seq, json_extract(data, '$.companyId'), json_extract(data, '$.userId'),
                  ${acao}, 'integration', ${entidade},
                  json_object('origem', '${colecao}', 'registro', json(data), 'by', 'migracao-consolidacao'),
                  NULL, COALESCE(${quando}, ${AGORA_SQL})
             FROM "${colecao}" WHERE json_valid(data)`,
        ).run();
        return Number(db.prepare(
          `DELETE FROM "${colecao}"
            WHERE json_valid(data)
              AND EXISTS (SELECT 1 FROM core_audit_log a WHERE a.id = '${prefixo}' || "${colecao}".seq)`,
        ).run().changes);
      };
      return levar(
        'integration_audit_entries', 'audit-mig-iae-',
        "'integrations.' || COALESCE(json_extract(data, '$.provider'), 'desconhecido') || '.' || COALESCE(json_extract(data, '$.action'), 'registro')",
        "COALESCE(json_extract(data, '$.provider'), 'desconhecido')",
        "COALESCE(json_extract(data, '$.occurredAt'), json_extract(data, '$.createdAt'))",
      ) + levar(
        'asaas_sandbox_homologations', 'audit-mig-ash-',
        "CASE WHEN json_type(data, '$.resourceType') IS NOT NULL THEN 'integrations.asaas.sandbox_resource' ELSE 'integrations.asaas.homologation_run' END",
        "'asaas'",
        "json_extract(data, '$.createdAt')",
      );
    },
  },
];

// ---------------------------------------------------------------- competência legada (GAP-PRD-142)

/** As origens que o SISTEMA grava sozinho — a competência delas só podia vir do relógio. */
export const ORIGENS_AUTOMATICAS_DA_COMPETENCIA = ['sale', 'ecommerce_order', 'sale_return', 'nfe_entrada'] as const;
export const CHAVE_DA_COMPETENCIA_LEGADA = 'consolidacao85:competencia_legada';

export interface LinhaDaCompetenciaLegada {
  id: string;
  companyId: string;
  originType: string;
  competenciaAntes: string;
  competenciaDepois: string;
  vencimentoAntes: string | null;
  vencimentoDepois: string | null;
}

/**
 * A COMPETÊNCIA QUE CAIU NO DIA DE GREENWICH.
 *
 * Antes do calendário da loja, o lançamento automático nascia com
 * `competence_date = now.slice(0, 10)` — o dia UTC. A venda das 21h59 de 12/08
 * em Pelotas competia em 13/08: o DRE por competência a contava num dia e o
 * relatório de vendas (que já corta pelo dia da loja) noutro. No banco da loja
 * são três linhas (R$ 50,00, R$ 269,70 e R$ 329,00).
 *
 * O critério é o mais estreito que prova a origem do erro, e nada além dele:
 *   - origem AUTOMÁTICA (venda, pedido online, devolução, entrada de nota) —
 *     o lançamento digitado tem a data que a pessoa escolheu;
 *   - a competência é EXATAMENTE o dia UTC do carimbo e DIFERE do dia da loja
 *     — fora da janela das 21h à meia-noite não há o que corrigir;
 *   - ninguém mexeu: sem baixa registrada, sem trilha de auditoria da linha,
 *     não cancelada, e quitada (quando quitada) no mesmo instante em que
 *     nasceu — a quitação automática do balcão, não a baixa de alguém.
 *
 * O vencimento vai junto só quando era igual à competência antiga (venda à
 * vista, que vence no dia): o do cartão, em trinta dias, é outra data e fica.
 * Cada linha corrigida ganha uma linha na auditoria com o antes e o depois, e o
 * total fica em `core_meta` (`consolidacao85:competencia_legada`).
 *
 * `aplicar: false` só lista — é o ensaio.
 */
export function corrigirCompetenciaLegada(
  db: DatabaseSync,
  opcoes: { aplicar: boolean } = { aplicar: true },
): { linhas: LinhaDaCompetenciaLegada[] } {
  const dia = diaDaLojaSql('e.created_at');
  const origens = ORIGENS_AUTOMATICAS_DA_COMPETENCIA.map(() => '?').join(', ');
  const candidatas = db
    .prepare(
      `SELECT e.id, e.company_id, e.origin_type, e.competence_date, e.due_date, ${dia} AS dia
         FROM core_finance_entries e
        WHERE e.origin_type IN (${origens})
          AND e.competence_date IS NOT NULL
          AND e.competence_date = substr(e.created_at, 1, 10)
          AND e.competence_date <> ${dia}
          AND e.cancelled_at IS NULL
          AND (e.settled_at IS NULL OR e.settled_at = e.created_at)
          AND NOT EXISTS (SELECT 1 FROM core_finance_settlements s WHERE s.entry_id = e.id)
          AND NOT EXISTS (SELECT 1 FROM core_audit_log a
                           WHERE a.entity_type = 'finance_entry' AND a.entity_id = e.id)
        ORDER BY e.created_at`,
    )
    .all(...ORIGENS_AUTOMATICAS_DA_COMPETENCIA) as unknown as {
    id: string;
    company_id: string;
    origin_type: string;
    competence_date: string;
    due_date: string | null;
    dia: string;
  }[];

  const linhas: LinhaDaCompetenciaLegada[] = candidatas.map((c) => ({
    id: c.id,
    companyId: c.company_id,
    originType: c.origin_type,
    competenciaAntes: c.competence_date,
    competenciaDepois: c.dia,
    vencimentoAntes: c.due_date,
    vencimentoDepois: c.due_date === c.competence_date ? c.dia : c.due_date,
  }));
  if (!opcoes.aplicar) return { linhas };

  const atualizar = db.prepare(
    'UPDATE core_finance_entries SET competence_date = ?, due_date = ? WHERE id = ? AND competence_date = ?',
  );
  const auditar = db.prepare(
    `INSERT INTO core_audit_log (id, company_id, user_id, action, entity_type, entity_id, detail, ip, created_at)
     VALUES (?, ?, NULL, 'finance.entry_competence_corrected', 'finance_entry', ?, ?, NULL, ${AGORA_SQL})`,
  );
  const feitas: LinhaDaCompetenciaLegada[] = [];
  for (const l of linhas) {
    if (Number(atualizar.run(l.competenciaDepois, l.vencimentoDepois, l.id, l.competenciaAntes).changes) === 0) continue;
    auditar.run(
      `audit-mig-142-${l.id}`,
      l.companyId,
      l.id,
      JSON.stringify({
        antes: { competenceDate: l.competenciaAntes, dueDate: l.vencimentoAntes },
        depois: { competenceDate: l.competenciaDepois, dueDate: l.vencimentoDepois },
        originType: l.originType,
        reason: 'GAP-PRD-142: competência gravada no dia de Greenwich; corrigida para o dia da loja.',
        by: 'migracao-consolidacao',
      }),
    );
    feitas.push(l);
  }
  const porEmpresa: Record<string, number> = {};
  for (const l of feitas) porEmpresa[l.companyId] = (porEmpresa[l.companyId] ?? 0) + 1;
  db.prepare(
    `INSERT INTO core_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(
    CHAVE_DA_COMPETENCIA_LEGADA,
    JSON.stringify({ em: new Date().toISOString(), linhas: feitas.length, porEmpresa, ids: feitas.slice(0, 200).map((l) => l.id) }),
  );
  return { linhas: feitas };
}

// ---------------------------------------------------------------- o ambiente do DF-e (DFE-AMBIENTE)

/**
 * As chaves que o simulador INVENTA na Distribuição DF-e (`chaveDfeDoSimulador`,
 * SefazTestAdapter), iguais dígito a dígito — o teste confere; o módulo de banco
 * não importa serviço.
 */
export const CHAVES_DFE_DO_SIMULADOR_NA_MIGRACAO: readonly string[] = [1, 2].map((i) =>
  `43260814200166000187550010${String(i).padStart(9, '0')}`.padEnd(44, '7').slice(0, 44));

export const CHAVE_DO_AMBIENTE_DFE = 'consolidacao85:dfe_ambiente';

const TABELA_DFE = 'core_dfe_documents';
const UNICO_POR_AMBIENTE = 'company_id, environment, nsu';

function existeTabela(db: DatabaseSync, tabela: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tabela));
}

function colunasDaTabela(db: DatabaseSync, tabela: string): string[] {
  return (db.prepare(`PRAGMA table_info("${tabela}")`).all() as unknown as { name: string }[]).map((c) => c.name);
}

/** As UNIQUE declaradas na tabela, pelas colunas: `a, b`. */
function unicosDaTabela(db: DatabaseSync, tabela: string): string[] {
  const lista = db.prepare(`PRAGMA index_list("${tabela}")`).all() as unknown as { name: string; origin: string }[];
  return lista
    .filter((i) => i.origin === 'u')
    .map((i) =>
      (db.prepare(`PRAGMA index_info("${i.name}")`).all() as unknown as { name: string | null }[])
        .map((c) => c.name ?? '?')
        .join(', '),
    );
}

/**
 * O AMBIENTE DE UMA LINHA ANTIGA — que ninguém gravou. Da prova mais forte para
 * a mais fraca:
 *   1. chave do SIMULADOR → homologação: o simulador nunca responde por produção
 *      (`exigirAdapterDeVerdade`), e as marcas de 7eb354f são dele;
 *   2. nota COMPLETA com `<tpAmb>` no XML → o ambiente que a própria SEFAZ
 *      carimbou na nota e no protocolo (1 produção, 2 homologação) — só quando o
 *      XML diz um só;
 *   3. o resto (o resumo resNFe não traz tpAmb) → o ambiente fiscal ATUAL da
 *      empresa, que é o que a consulta usou desde a rodada 46; sem configuração
 *      fiscal, homologação (o padrão da configuração).
 * Para o banco da loja (84), o caso real é o 1: a homologação pelo simulador.
 */
function ambienteDaLinhaAntigaSql(db: DatabaseSync): string {
  const doXml = (tpAmb: string, outro: string) =>
    `instr(COALESCE(xml, ''), '<tpAmb>${tpAmb}</tpAmb>') > 0 AND instr(COALESCE(xml, ''), '<tpAmb>${outro}</tpAmb>') = 0`;
  const daEmpresa = existeTabela(db, 'core_fiscal_configs')
    ? `COALESCE((SELECT CASE WHEN c.environment = 'production' THEN 'production' ELSE 'homologation' END
                   FROM core_fiscal_configs c WHERE c.company_id = ${TABELA_DFE}.company_id), 'homologation')`
    : "'homologation'";
  return `CASE
            WHEN access_key IN (${CHAVES_DFE_DO_SIMULADOR_NA_MIGRACAO.map(() => '?').join(', ')}) THEN 'homologation'
            WHEN ${doXml('1', '2')} THEN 'production'
            WHEN ${doXml('2', '1')} THEN 'homologation'
            ELSE ${daEmpresa}
          END`;
}

export interface ResultadoDoAmbienteDfe {
  /** Linhas antigas que receberam o ambiente pela regra acima. */
  preenchidas: number;
  /** A tabela foi reconstruída com UNIQUE (company_id, environment, nsu). */
  reconstruida: boolean;
  /** Por que a reconstrução ficou para o reparo do esquema (fora da transação), ou nulo. */
  adiada: string | null;
}

/**
 * O NSU É POR AMBIENTE (DFE-AMBIENTE, GAP-PRD-168).
 *
 * A Distribuição DF-e numera homologação e produção em sequências separadas, e
 * `core_dfe_documents` tinha UNIQUE (company_id, nsu): a primeira consulta de
 * produção partia do maior NSU da homologação, e a nota de produção com NSU
 * repetido era engolida pelo INSERT OR IGNORE. A tabela ganha o ambiente de
 * cada documento e a unicidade (company_id, environment, nsu).
 *
 * UNIQUE declarada na tabela não se troca com ALTER: a tabela é RECONSTRUÍDA
 * pela DDL canônica — todas as linhas com o MESMO rowid, os índices que ela
 * tinha (os canônicos e os que só existam neste banco) e as chaves, inclusive
 * `imported_note_id`. Dentro da transação da migração, com as chaves
 * estrangeiras LIGADAS (o PRAGMA não muda numa transação): ninguém aponta para
 * esta tabela, então o DROP não dispara nada, e cada linha copiada é conferida
 * contra a empresa e a nota. Por isso, antes, duas conferências adiam a
 * reconstrução para o reparo do esquema (`repararEsquema`, fora da transação,
 * chaves desligadas, cópia do banco antes), sem derrubar a subida:
 *   - referência ÓRFÃ (vínculo com nota que não existe mais): copiá-la com as
 *     chaves ligadas falharia — o reparo a preserva como está;
 *   - coluna que o banco novo não tem: reconstruir apagaria o dado.
 * O ambiente é preenchido de qualquer jeito: o reparo copia a coluna.
 *
 * Idempotente e barata: com a tabela já certa, só lê o catálogo. Roda no passo
 * 85 (banco da 84) e de novo antes do reconcile, a cada subida — o banco criado
 * pela DDL canônica anterior (85 sem a coluna) já tem o passo marcado, e o
 * reconcile acrescentaria a coluna com o DEFAULT, sem o ambiente de cada linha.
 */
export function garantirAmbienteDosDocumentosDfe(db: DatabaseSync): ResultadoDoAmbienteDfe {
  const r: ResultadoDoAmbienteDfe = { preenchidas: 0, reconstruida: false, adiada: null };
  if (!existeTabela(db, TABELA_DFE)) return r;
  const colunasAntes = colunasDaTabela(db, TABELA_DFE);
  const unicosAntes = unicosDaTabela(db, TABELA_DFE);
  if (colunasAntes.includes('environment') && unicosAntes.length === 1 && unicosAntes[0] === UNICO_POR_AMBIENTE) {
    // A tabela está certa (pelo passo, ou pelo reparo do esquema depois de uma falha
    // aqui): a pendência que a falha deixou não fica acusando o que já se resolveu.
    apagarPendencia(db, 'dfe_ambiente_por_documento');
    return r;
  }

  comSavepoint(db, 'dfe_ambiente_por_documento', () => {
    const ambienteDaLinha = ambienteDaLinhaAntigaSql(db);
    if (!colunasAntes.includes('environment')) {
      db.exec(`ALTER TABLE ${TABELA_DFE} ADD COLUMN environment TEXT NOT NULL DEFAULT 'homologation'`);
      r.preenchidas = Number(
        db.prepare(`UPDATE ${TABELA_DFE} SET environment = ${ambienteDaLinha}`).run(...CHAVES_DFE_DO_SIMULADOR_NA_MIGRACAO)
          .changes,
      );
    } else {
      // A coluna veio pelo reconcile (DEFAULT) ou com valor fora dos dois: a mesma regra.
      r.preenchidas = Number(
        db
          .prepare(
            `UPDATE ${TABELA_DFE} SET environment = ${ambienteDaLinha}
              WHERE environment IS NULL OR environment NOT IN ('homologation', 'production')`,
          )
          .run(...CHAVES_DFE_DO_SIMULADOR_NA_MIGRACAO).changes,
      );
    }
    const unicos = unicosDaTabela(db, TABELA_DFE);
    if (unicos.length === 1 && unicos[0] === UNICO_POR_AMBIENTE) return;

    const canonica = STATEMENTS.find((s) => /^\s*CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+core_dfe_documents\s*\(/i.test(s));
    if (!canonica) throw new Error('A DDL canônica de core_dfe_documents não está em STATEMENTS.');
    const nova = `${TABELA_DFE}__por_ambiente`;
    db.exec(`DROP TABLE IF EXISTS ${nova}`);
    db.exec(canonica.replace(/^\s*CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+core_dfe_documents/i, `CREATE TABLE ${nova}`));
    const daNova = colunasDaTabela(db, nova);
    const daVelha = colunasDaTabela(db, TABELA_DFE);
    const aMais = daVelha.filter((c) => !daNova.includes(c));
    const orfas = (db.prepare(`PRAGMA foreign_key_check("${TABELA_DFE}")`).all() as unknown[]).length;
    if (aMais.length > 0 || orfas > 0) {
      db.exec(`DROP TABLE ${nova}`);
      r.adiada = aMais.length > 0
        ? `a tabela tem coluna(s) que o banco novo não tem (${aMais.join(', ')}): o reparo do esquema diz o que decidir`
        : `${orfas} referência(s) órfã(s) em ${TABELA_DFE}: com as chaves estrangeiras ligadas a cópia falharia; `
          + 'o reparo do esquema reconstrói fora da transação, com a cópia do banco antes';
      return;
    }

    const indices = db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL ORDER BY name")
      .all(TABELA_DFE) as unknown as { name: string; sql: string }[];
    const contar = (t: string) => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n);
    const antes = contar(TABELA_DFE);
    const colunas = daVelha.join(', ');
    db.exec(`INSERT INTO ${nova} (rowid, ${colunas}) SELECT rowid, ${colunas} FROM ${TABELA_DFE}`);
    db.exec(`DROP TABLE ${TABELA_DFE}`);
    db.exec(`ALTER TABLE ${nova} RENAME TO ${TABELA_DFE}`);
    for (const ix of indices) db.exec(ix.sql);
    for (const s of STATEMENTS) {
      if (/^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+\S+\s+ON\s+core_dfe_documents\b/i.test(s)) db.exec(s);
    }
    const depois = contar(TABELA_DFE);
    if (depois !== antes) {
      throw new Error(`a reconstrução de ${TABELA_DFE} perderia linhas: ${antes} antes, ${depois} depois`);
    }
    if ((db.prepare(`PRAGMA foreign_key_check("${TABELA_DFE}")`).all() as unknown[]).length > 0) {
      throw new Error(`a reconstrução de ${TABELA_DFE} deixaria referência órfã`);
    }
    r.reconstruida = true;
  });

  if (!r.adiada) apagarPendencia(db, 'dfe_ambiente_por_documento');
  db.prepare(
    `INSERT INTO core_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(CHAVE_DO_AMBIENTE_DFE, JSON.stringify({ em: new Date().toISOString(), ...r }));
  return r;
}

// ---------------------------------------------------------------- execução

function comSavepoint<T>(db: DatabaseSync, nome: string, fn: () => T): T {
  const sp = `consolidacao_${nome.replace(/[^A-Za-z0-9_]/g, '_')}`;
  db.exec(`SAVEPOINT ${sp}`);
  try {
    const r = fn();
    db.exec(`RELEASE ${sp}`);
    return r;
  } catch (err) {
    db.exec(`ROLLBACK TO ${sp}`);
    db.exec(`RELEASE ${sp}`);
    throw err;
  }
}

function gravarPendencia(db: DatabaseSync, p: Omit<PendenciaDaConsolidacao, 'registradaEm'>): PendenciaDaConsolidacao {
  const completa = { ...p, registradaEm: new Date().toISOString() };
  db.prepare(
    `INSERT INTO core_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(PREFIXO_PENDENCIA + p.chave, JSON.stringify(completa));
  return completa;
}

function apagarPendencia(db: DatabaseSync, chave: string): void {
  db.prepare('DELETE FROM core_meta WHERE key = ?').run(PREFIXO_PENDENCIA + chave);
}

/** Coluna gerada (VIRTUAL) só aparece em `table_xinfo`, não em `table_info`. */
function temColunaGerada(db: DatabaseSync, tabela: string, coluna: string): boolean {
  const linhas = db.prepare(`PRAGMA table_xinfo("${tabela}")`).all() as unknown as { name: string }[];
  return linhas.some((l) => l.name === coluna);
}

function tentarIndiceUnico(db: DatabaseSync, u: IndiceUnicoComPreCondicao): 'criado' | 'pendente' {
  const impede = db.prepare(u.conferencia).all();
  if (impede.length > 0) {
    gravarPendencia(db, {
      chave: u.nome,
      titulo: u.titulo,
      motivo: `O índice ${u.nome} não foi criado: o banco tem ${impede.length} caso(s) que ele recusaria.`,
      comoResolver: u.comoResolver,
      origem: u.origem,
      detalhe: impede.slice(0, 20),
    });
    return 'pendente';
  }
  db.exec(u.sql);
  apagarPendencia(db, u.nome);
  return 'criado';
}

function tentarIndiceDaColecao(db: DatabaseSync, colecao: string): 'criado' | 'pulado' | 'pendente' {
  const nome = `ix_${colecao}_company`;
  if (!temColunaGerada(db, colecao, 'company_id')) return 'pulado';
  const lixo = db.prepare(`SELECT COUNT(*) AS n FROM "${colecao}" WHERE json_valid(data) = 0`).get() as { n: number };
  if (Number(lixo.n) > 0) {
    gravarPendencia(db, {
      chave: nome,
      titulo: `Coleção ${colecao} com documento que não é JSON`,
      motivo: `${lixo.n} linha(s) de ${colecao} não abrem como JSON; o índice por empresa não foi criado (o filtro por empresa continua correto, só mais lento).`,
      comoResolver: `Conferir as linhas com SELECT seq FROM "${colecao}" WHERE json_valid(data) = 0 e corrigir ou remover pelo suporte, com cópia do banco antes.`,
      origem: 'DEP GAP-PRD-147',
    });
    return 'pendente';
  }
  db.exec(`CREATE INDEX IF NOT EXISTS "${nome}" ON "${colecao}" (company_id)`);
  apagarPendencia(db, nome);
  return 'criado';
}

/**
 * Aplica a consolidação. Chamado UMA vez, pelo passo 85, dentro da transação da
 * migração. Idempotente: rodar de novo não muda nada que já esteja certo.
 */
export function aplicarConsolidacaoDaRemediacao(
  db: DatabaseSync,
  f: FerramentasDaMigracao,
): ResultadoDaConsolidacao {
  const r: ResultadoDaConsolidacao = { aplicados: [], pulados: [], pendencias: [] };
  const falhou = (chave: string, titulo: string, origem: string, err: unknown) => {
    r.pendencias.push(gravarPendencia(db, {
      chave, titulo, origem,
      motivo: `Falhou na consolidação: ${(err as Error).message}`,
      comoResolver: 'Reportar ao suporte com o log da subida; o resto da consolidação foi aplicado.',
    }));
  };

  for (const ix of INDICES) {
    if (!f.tableExists(ix.tabela)) { r.pulados.push(ix.nome); continue; }
    try {
      comSavepoint(db, ix.nome, () => {
        for (const [c, ddl] of ix.colunas) f.addColumn(ix.tabela, c, ddl);
        db.exec(ix.sql);
      });
      r.aplicados.push(ix.nome);
    } catch (err) {
      falhou(ix.nome, `Índice ${ix.nome} não criado`, ix.origem, err);
    }
  }

  for (const u of UNICOS) {
    if (!f.tableExists(u.tabela)) { r.pulados.push(u.nome); continue; }
    try {
      const s = comSavepoint(db, u.nome, () => {
        for (const [c, ddl] of u.colunas) f.addColumn(u.tabela, c, ddl);
        return tentarIndiceUnico(db, u);
      });
      if (s === 'criado') r.aplicados.push(u.nome);
      else r.pendencias.push(...pendenciasDaConsolidacao(db).filter((p) => p.chave === u.nome));
    } catch (err) {
      falhou(u.nome, `Índice ${u.nome} não criado`, u.origem, err);
    }
  }

  for (const colecao of COLECOES_POR_EMPRESA) {
    if (!f.tableExists(colecao)) { r.pulados.push(`ix_${colecao}_company`); continue; }
    try {
      const s = comSavepoint(db, `col_${colecao}`, () => tentarIndiceDaColecao(db, colecao));
      if (s === 'criado') r.aplicados.push(`ix_${colecao}_company`);
      else if (s === 'pulado') r.pulados.push(`ix_${colecao}_company`);
      else r.pendencias.push(...pendenciasDaConsolidacao(db).filter((p) => p.chave === `ix_${colecao}_company`));
    } catch (err) {
      falhou(`ix_${colecao}_company`, `Índice por empresa em ${colecao} não criado`, 'DEP GAP-PRD-147', err);
    }
  }

  for (const c of CORRECOES) {
    if (!c.precisa.every((t) => f.tableExists(t))) { r.pulados.push(c.nome); continue; }
    try {
      const n = comSavepoint(db, c.nome, () => {
        for (const [t, col, ddl] of c.colunas ?? []) f.addColumn(t, col, ddl);
        return c.aplicar(db);
      });
      r.aplicados.push(`${c.nome}:${n}`);
    } catch (err) {
      falhou(c.nome, `Correção ${c.nome} não aplicada`, c.origem, err);
    }
  }

  db.prepare(
    `INSERT INTO core_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(CHAVE_RESULTADO, JSON.stringify({ em: new Date().toISOString(), ...r, pendencias: r.pendencias.map((p) => p.chave) }));
  return r;
}

/** As pendências que a consolidação deixou — a prontidão e a conferência da implantação as leem. */
export function pendenciasDaConsolidacao(db: DatabaseSync): PendenciaDaConsolidacao[] {
  const existe = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'core_meta'").get();
  if (!existe) return [];
  const linhas = db
    .prepare('SELECT value FROM core_meta WHERE key LIKE ? ORDER BY key')
    .all(`${PREFIXO_PENDENCIA}%`) as unknown as { value: string }[];
  return linhas.flatMap((l) => {
    try {
      return [JSON.parse(l.value) as PendenciaDaConsolidacao];
    } catch {
      return [];
    }
  });
}

/**
 * A cada subida: tenta de novo o que ficou pendente. Barato — só roda se houver
 * pendência. É o que faz o índice nascer sozinho depois que o dono fecha a
 * gaveta excedente ou corrige a placa pela tela.
 */
export function resolverPendenciasDaConsolidacao(db: DatabaseSync): { resolvidas: string[]; restantes: string[] } {
  const pendentes = pendenciasDaConsolidacao(db);
  const resolvidas: string[] = [];
  for (const p of pendentes) {
    try {
      const unico = UNICOS.find((u) => u.nome === p.chave);
      if (unico) {
        if (comSavepoint(db, `re_${unico.nome}`, () => tentarIndiceUnico(db, unico)) === 'criado') resolvidas.push(p.chave);
        continue;
      }
      const colecao = COLECOES_POR_EMPRESA.find((c) => `ix_${c}_company` === p.chave);
      if (colecao) {
        if (comSavepoint(db, `re_col_${colecao}`, () => tentarIndiceDaColecao(db, colecao)) === 'criado') resolvidas.push(p.chave);
      }
    } catch {
      // Continua pendente; a próxima subida tenta de novo.
    }
  }
  return { resolvidas, restantes: pendenciasDaConsolidacao(db).map((p) => p.chave) };
}

/** Para os testes e para a conferência da implantação: o que o passo sabe fazer. */
export const ITENS_DA_CONSOLIDACAO = {
  indices: INDICES.map((i) => i.nome),
  unicos: UNICOS.map((u) => u.nome),
  colecoes: COLECOES_POR_EMPRESA.map((c) => `ix_${c}_company`),
  correcoes: CORRECOES.map((c) => c.nome),
};
