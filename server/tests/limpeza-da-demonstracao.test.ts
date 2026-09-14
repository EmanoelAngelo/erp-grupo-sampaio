/**
 * ============================================================================
 * A LIMPEZA DA DEMONSTRAÇÃO — `npm run db:limpar-demonstracao --prefix server`
 * ============================================================================
 *
 * O banco daqui é o DESCARTÁVEL da suíte, montado com a forma da demonstração
 * que a loja carrega: produtos com variantes e fotos no disco, saldo e razão,
 * dois caixas abertos, vendas com itens e pagamentos, pedido online com
 * cobrança, nota de entrada de teste, OS com peça/comentário/eventos,
 * orçamento, pré-venda, inventário, equipamento com plaquinha, lançamentos,
 * promoção, filas de impressão e de e-mail, comissão, artefatos ZZ-TESTE e
 * ZZ-VERIF, maquininha `mock` com cobranças simuladas, as treze contas com
 * vínculos, bancadas e sessões — e a configuração de verdade ao lado: fiscal,
 * certificado, séries, grupo tributário, CSC, integração e cofre (com a chave
 * de PRODUÇÃO), caixa IMAP, categorias de sistema, seis empresas, bancadas.
 *
 * O que cada caso derruba sem o conserto:
 *   - a simulação que escreve, ou que lista outra coisa, cai no primeiro;
 *   - impressão errada que apaga, no segundo;
 *   - o caminho feliz que leva uma linha de configuração, sem cópia, sem
 *     quarentena, com auditoria de dado pessoal, ou reinicia a numeração de
 *     etiqueta sem a flag, no terceiro;
 *   - a API no ar, a nota de produção e o gatilho que apaga a mais (o banco
 *     fazendo o que o plano não previu) têm de deixar o banco IDÊNTICO;
 *   - rodar de novo depois de aplicada tem de ser "nada a fazer".
 */
process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { verificarBackup } from '../src/db/backup.js';
import { ensureOfficialWorkshops } from '../src/db/core-migrations.js';
import { insertRow, resetDbForTests } from '../src/db/database.js';
import { ACAO_DA_LIMPEZA, LOGINS_DA_DEMONSTRACAO } from '../src/db/limpezaDaDemonstracao.js';
import { ensureCoreSchema, resetCoreSchemaCache } from '../src/db/schema.js';
import { closeConnection, getConnection, resolveDatabasePath } from '../src/db/sqlite.js';
import { limparPelaLinhaDeComando } from '../src/scripts/limpar-demonstracao.js';
import { recordAudit } from '../src/services/audit/AuditService.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import { seedSystemCategories } from '../src/services/core/FinanceSetupService.js';
import {
  aplicarLimpezaDaDemonstracao,
  simularLimpezaDaDemonstracao,
} from '../src/services/implantacao/LimpezaDaDemonstracao.js';
import { liberarInstancia, tentarAssumir } from '../src/services/implantacao/instanciaUnica.js';

const RAIZ = process.env.GS_ERP_TEST_TMP_ROOT ?? tmpdir();
const AGORA = '2026-08-12T19:55:05.000Z';

const EMPRESAS = [
  { id: 'emp-pj', slug: 'preco-justo', kind: 'retail' },
  { id: 'emp-gr', slug: 'gringa', kind: 'retail' },
  { id: 'emp-mm', slug: 'me-mimei', kind: 'retail' },
  { id: 'emp-co', slug: 'conceito', kind: 'retail' },
  { id: 'emp-pm', slug: 'pj-motors', kind: 'retail' },
  { id: 'emp-of', slug: 'oficina', kind: 'workshop' },
] as const;
const PJ = 'emp-pj';
const GR = 'emp-gr';
const MM = 'emp-mm';
const OF = 'emp-of';
const PM = 'emp-pm';

/** O que nunca pode aparecer na saída: segredo, hash, documento e contato de pessoa. */
const NUNCA_NA_SAIDA = [
  'CHAVE-DE-PRODUCAO-ASAAS-NAO-IMPRIMIR',
  'CHAVE-SANDBOX-ASAAS-NAO-IMPRIMIR',
  'SENHA-DO-PFX-NAO-IMPRIMIR',
  'CSC-DE-TESTE-NAO-IMPRIMIR',
  'SENHA-IMAP-NAO-IMPRIMIR',
  'CREDENCIAL-STONE-NAO-IMPRIMIR',
  'refresh-hash-nao-imprimir',
  'argon2id$hash-nao-imprimir',
  '52998224725',
  'cliente.oficina@exemplo.test',
  '11987654321',
  'Cliente Roteiro Oficina',
  'cliente.pedido@exemplo.test',
];

// ---------------------------------------------------------------------------
// O banco de teste com a forma da demonstração
// ---------------------------------------------------------------------------

let contador = 0;

function colunasDe(tabela: string): Array<{ name: string; type: string; notnull: number; dflt_value: unknown; pk: number }> {
  return getConnection().prepare(`PRAGMA table_info("${tabela}")`).all() as never;
}

/**
 * INSERT com as colunas NOT NULL sem padrão preenchidas por um valor neutro.
 * `opcionais` só entram se a coluna existir nesta versão do esquema.
 */
function inserir(tabela: string, valores: Record<string, unknown>, opcionais: Record<string, unknown> = {}): void {
  const cols = colunasDe(tabela);
  expect(cols.length, `a tabela ${tabela} existe`).toBeGreaterThan(0);
  const nomes = new Set(cols.map((c) => c.name));
  const linha: Record<string, unknown> = { ...valores };
  for (const [k, v] of Object.entries(opcionais)) if (nomes.has(k)) linha[k] = v;
  for (const c of cols) {
    if (c.name in linha || c.pk || !c.notnull || c.dflt_value !== null) continue;
    contador += 1;
    linha[c.name] = c.name.endsWith('_at') ? AGORA : /INT|REAL|NUM/i.test(c.type) ? 1 : `${c.name}-${contador}`;
  }
  const chaves = Object.keys(linha);
  getConnection()
    .prepare(`INSERT INTO "${tabela}" (${chaves.map((k) => `"${k}"`).join(', ')}) VALUES (${chaves.map(() => '?').join(', ')})`)
    .run(...(chaves.map((k) => linha[k]) as never[]));
}

function usuario(login: string, nome: string): string {
  const id = `u-${login}`;
  inserir('core_users', {
    id,
    login,
    display_name: nome,
    password_hash: 'argon2id$hash-nao-imprimir',
    must_change_password: 1,
    active: 1,
    created_at: AGORA,
    updated_at: AGORA,
  });
  return id;
}

function vinculo(userId: string, companyId: string, perfil: string): void {
  inserir('core_user_companies', { id: `uc-${userId}-${companyId}`, user_id: userId, company_id: companyId, profile_code: perfil, is_default: 0, created_at: AGORA });
}

function bancada(slug: string): string {
  return (getConnection().prepare('SELECT id FROM core_workshops WHERE slug = ?').get(slug) as { id: string }).id;
}

function montarDemonstracao(uploads: string): void {
  // --- A estrutura e a configuração DE VERDADE ---------------------------
  for (const e of EMPRESAS) upsertCompany({ id: e.id, slug: e.slug, legalName: `${e.slug} LTDA`, tradeName: e.slug, kind: e.kind });
  ensureOfficialWorkshops();
  const mobilidade = bancada('oficina-mobilidade');
  const celulares = bancada('oficina-celulares');
  seedSystemCategories(PJ);
  seedSystemCategories(OF);
  inserir('core_units', { id: 'un-1', company_id: PJ, code: 'UN', name: 'Unidade' });
  inserir('core_printers', { id: 'imp-1', company_id: PJ, name: 'Cupom do balcao', kind: 'escpos' });
  inserir('core_stock_locations', { id: 'loc-geral-pj', company_id: PJ, code: 'GERAL', name: 'Estoque geral' });
  inserir('core_stock_locations', { id: 'loc-geral-of', company_id: OF, code: 'GERAL', name: 'Estoque geral' });
  inserir('core_fiscal_configs', { company_id: PJ, updated_at: AGORA }, { environment: 'homologation', csc_id: '000001' });
  inserir('core_fiscal_series', { id: 'ser-65', company_id: PJ, model: '65', serie: 1 });
  inserir('core_fiscal_series', { id: 'ser-55', company_id: PJ, model: '55', serie: 1 });
  inserir('core_tax_groups', { id: 'tg-1', company_id: PJ, code: 'SIMPLES-102', name: 'Simples Nacional — CSOSN 102' });
  const senhaImap = colunasDe('core_mail_inboxes').find((c) => /pass|senha|secret|cipher/i.test(c.name))?.name;
  inserir(
    'core_mail_inboxes',
    { id: 'caixa-1', company_id: PJ, address: 'notas@loja.test', host: 'imap.loja.test', username: 'notas' },
    senhaImap ? { [senhaImap]: 'SENHA-IMAP-NAO-IMPRIMIR' } : {},
  );
  insertRow('fiscal_certificate_references', { id: 'cert-1', companyId: PJ, status: 'valid', validTo: '2026-10-15', senhaCifrada: 'SENHA-DO-PFX-NAO-IMPRIMIR' });
  insertRow('nfce_settings', { id: 'csc-1', companyId: PJ, cscId: '000001', cscToken: 'CSC-DE-TESTE-NAO-IMPRIMIR' });
  insertRow('integration_configurations', { id: 'int-asaas-pj', companyId: PJ, provider: 'asaas', environment: 'sandbox', status: 'homologated' });
  insertRow('integration_configurations', { id: 'int-asaas-pm', companyId: PM, provider: 'asaas', environment: 'sandbox', status: 'pending' });
  insertRow('integration_secrets', { id: 'sec-prod', companyId: PJ, provider: 'asaas', environment: 'production', ciphertext: 'CHAVE-DE-PRODUCAO-ASAAS-NAO-IMPRIMIR', hint: '****9f3a' });
  insertRow('integration_secrets', { id: 'sec-sandbox', companyId: PJ, provider: 'asaas', environment: 'sandbox', ciphertext: 'CHAVE-SANDBOX-ASAAS-NAO-IMPRIMIR', hint: '****11aa' });
  insertRow('asaas_operational_attempts', { id: 'asaas-att-1', companyId: PJ, kind: 'homologation', status: 'done' });
  // O rastro sandbox do Asaas em coleção do banco antigo (aposentada no esquema novo).
  getConnection().exec('CREATE TABLE asaas_sandbox_homologations (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT, data TEXT NOT NULL);');
  getConnection().prepare('INSERT INTO asaas_sandbox_homologations (id, data) VALUES (?, ?)').run('hom-1', JSON.stringify({ companyId: PJ, step: 'pix', status: 'ok' }));

  // --- As contas do seed, com vínculos e bancadas -------------------------
  const admin = usuario('ADMIN', 'Administrador Grupo Sampaio');
  const gestor = usuario('CARLOSGERENTE', 'Carlos Gerente');
  for (const e of EMPRESAS) {
    vinculo(admin, e.id, 'admin_geral');
    vinculo(gestor, e.id, 'gestor');
    vinculo(usuario(`${e.slug}.pdv`, `PDV ${e.slug}`), e.id, e.kind === 'workshop' ? 'operador_caixa_oficina' : 'operador_caixa_loja');
  }
  for (const login of ['ROBERTOMECANICO', 'MARCOSMECANICO', 'PAULOMECANICO', 'LUCASMECANICO']) {
    const id = usuario(login, login.replace('MECANICO', ' (Mecânico)'));
    vinculo(id, OF, 'mecanico');
    inserir('core_workshop_members', { id: `wm-${login}`, workshop_id: mobilidade, user_id: id, role: 'mecanico', created_at: AGORA });
  }
  const joao = usuario('JOAOCELULAR', 'JOAO (Técnico)');
  vinculo(joao, PJ, 'mecanico');
  inserir('core_workshop_members', { id: 'wm-joao', workshop_id: celulares, user_id: joao, role: 'mecanico', created_at: AGORA });
  const roberto = 'u-ROBERTOMECANICO';
  for (const [i, u] of [gestor, gestor, 'u-conceito.pdv'].entries()) {
    insertRow('api_sessions', { id: `sess-${i}`, userId: u, companyId: PJ, refreshTokenHash: 'refresh-hash-nao-imprimir', createdAt: AGORA });
  }
  inserir('core_login_attempts', { login: 'admin', succeeded: 0, attempted_at: AGORA });
  inserir('core_login_attempts', { login: 'carlosgerente', succeeded: 0, attempted_at: AGORA });

  // --- Artefatos de teste (ZZ) ao lado do que é real ----------------------
  inserir('core_finance_accounts', { id: 'conta-real', company_id: PJ, name: 'Banco do Brasil', kind: 'banco' });
  inserir('core_finance_accounts', { id: 'conta-zz', company_id: PJ, name: 'ZZ-TESTE Banco', kind: 'banco' });
  inserir('core_acquirers', { id: 'adq-zz', company_id: PJ, name: 'ZZ-TESTE Cielo', account_id: 'conta-zz' });
  inserir('core_finance_categories', { id: 'cat-zz-pai', company_id: PJ, direction: 'out', name: 'ZZ-TESTE Ocupacao', active: 0 });
  inserir('core_finance_categories', { id: 'cat-zz-filha', company_id: PJ, direction: 'out', name: 'ZZ-TESTE Aluguel', parent_id: 'cat-zz-pai', active: 0 });
  inserir('core_commission_groups', { id: 'com-zz', company_id: PJ, name: 'ZZ-TESTE Loja' });
  inserir('core_commission_tiers', { id: 'tier-zz', company_id: PJ, group_id: 'com-zz', rate_bps: 100 });
  inserir('core_stock_locations', { id: 'loc-zz', company_id: PJ, code: 'ZZ-VERIF', name: 'ZZ-VERIF Local' });

  // --- Pessoas da demonstração ---------------------------------------------
  inserir('core_customers', { id: 'cli-of', company_id: OF, name: 'Cliente Roteiro Oficina' }, {
    document: '52998224725', cpf_cnpj: '52998224725', email: 'cliente.oficina@exemplo.test', phone: '11987654321',
  });
  inserir('core_customers', { id: 'cli-mm', company_id: MM, name: 'Teste Pedido Online' }, { email: 'cliente.pedido@exemplo.test' });
  inserir('core_customers', { id: 'cli-real', company_id: PJ, name: 'Cliente de Balcão' });
  inserir('core_suppliers', { id: 'forn-nota', company_id: PJ, name: 'Fornecedor da Nota' });
  inserir('core_suppliers', { id: 'forn-real', company_id: PJ, name: 'Distribuidora de Verdade' });

  // --- Produtos, variantes, fotos, saldo, razão, promoção -----------------
  inserir('core_products', { id: 'p-capa', company_id: PJ, internal_code: '00001', name: 'Capa de celular', image_url: '/uploads/produtos/foto-capa.png' });
  inserir('core_products', { id: 'p-camiseta', company_id: PJ, internal_code: '00002', name: 'Camiseta Básica' });
  inserir('core_products', { id: 'p-camiseta-p', company_id: PJ, internal_code: '00003', name: 'Camiseta Básica P', parent_id: 'p-camiseta' });
  inserir('core_products', { id: 'p-camiseta-m', company_id: PJ, internal_code: '00004', name: 'Camiseta Básica M', parent_id: 'p-camiseta' });
  inserir('core_products', { id: 'p-pneu', company_id: OF, internal_code: '00001', name: 'Pneu aro 10' });
  inserir('core_products', { id: 'p-patinete', company_id: OF, internal_code: '00002', name: 'Patinete Elétrico X', image_url: '/uploads/produtos/foto-patinete.png' });
  inserir('core_product_images', { id: 'img-capa', company_id: PJ, product_id: 'p-capa', url: '/uploads/produtos/foto-capa.png', is_primary: 1 });
  inserir('core_product_images', { id: 'img-patinete', company_id: OF, product_id: 'p-patinete', url: '/uploads/produtos/foto-patinete.png', is_primary: 1 });
  mkdirSync(join(uploads, 'produtos'), { recursive: true });
  mkdirSync(join(uploads, 'lojas'), { recursive: true });
  for (const nome of ['foto-capa.png', 'foto-patinete.png', 'outra-que-ninguem-cita.png']) writeFileSync(join(uploads, 'produtos', nome), 'PNG');
  writeFileSync(join(uploads, 'lojas', 'logo.png'), 'PNG');
  for (const [p, c, q, r] of [['p-capa', PJ, 5, 1], ['p-camiseta-p', PJ, 3, 0], ['p-camiseta-m', PJ, 2, 0], ['p-pneu', OF, 10, 0], ['p-patinete', OF, 1, 0]] as const) {
    inserir('core_stock', { company_id: c, product_id: p, quantity: q, reserved: r, updated_at: AGORA });
  }
  const movimentos: Array<[string, string, string | null]> = [
    ['p-capa', PJ, 'loc-geral-pj'], ['p-camiseta-p', PJ, null], ['p-camiseta-m', PJ, null],
    ['p-pneu', OF, 'loc-geral-of'], ['p-patinete', OF, null], ['p-capa', PJ, 'loc-zz'],
  ];
  for (const [i, [p, c, loc]] of movimentos.entries()) {
    inserir('core_stock_movements', {
      id: `mov-${i}`, company_id: c, product_id: p, movement_type: 'entrada', quantity: 1, reference_type: 'ajuste', reference_id: `ref-${i}`, balance_after: 1, location_id: loc, created_at: AGORA,
    });
  }
  inserir('core_promotions', { id: 'promo-1', company_id: PJ, product_id: 'p-capa', starts_at: AGORA });

  // --- Caixas (dois ABERTOS), vendas, pedido, cobrança ---------------------
  inserir('core_cash_sessions', { id: 'cx-pj', company_id: PJ, opened_by: 'u-preco-justo.pdv', opened_at: AGORA });
  inserir('core_cash_sessions', { id: 'cx-gr', company_id: GR, opened_by: 'u-gringa.pdv', opened_at: AGORA });
  inserir('core_cash_sessions', { id: 'cx-of', company_id: OF, opened_by: 'u-oficina.pdv', opened_at: AGORA }, { closed_at: AGORA });
  inserir('core_cash_movements', { id: 'cxm-1', session_id: 'cx-pj', company_id: PJ, movement_type: 'suprimento', amount_cents: 5000 });
  inserir('core_cash_movements', { id: 'cxm-2', session_id: 'cx-gr', company_id: GR, movement_type: 'sangria', amount_cents: 1000 });
  inserir('core_sales', { id: 's-pj', company_id: PJ, number: 1, idempotency_key: 'venda-pj-1', cash_session_id: 'cx-pj' });
  inserir('core_sales', { id: 's-of', company_id: OF, number: 1, idempotency_key: 'venda-of-1', cash_session_id: 'cx-of', customer_id: 'cli-of' });
  inserir('core_sale_items', { id: 'si-1', sale_id: 's-pj', company_id: PJ, product_id: 'p-capa', description: 'Capa', quantity: 1, unit_price_cents: 2990, total_cents: 2990 });
  inserir('core_sale_items', { id: 'si-2', sale_id: 's-of', company_id: OF, product_id: 'p-patinete', description: 'Patinete', quantity: 1, unit_price_cents: 199000, total_cents: 199000 });
  inserir('core_sale_payments', { id: 'sp-1', sale_id: 's-pj', company_id: PJ, method: 'pix', amount_cents: 2990 });
  inserir('core_sale_payments', { id: 'sp-2', sale_id: 's-of', company_id: OF, method: 'dinheiro', amount_cents: 199000 });
  inserir('core_orders', { id: 'o-mm', company_id: MM, number: 1, customer_name: 'Teste Pedido Online', customer_id: 'cli-mm', idempotency_key: 'pedido-1' });
  inserir('core_order_items', { id: 'oi-1', order_id: 'o-mm', company_id: MM, product_id: 'p-capa', description: 'Capa', quantity: 1, unit_price_cents: 1050, total_cents: 1050 });
  inserir('core_order_events', { id: 'oe-1', order_id: 'o-mm', company_id: MM, status: 'placed' });
  inserir('core_order_events', { id: 'oe-2', order_id: 'o-mm', company_id: MM, status: 'paid' });
  for (const i of [1, 2]) {
    inserir('core_payment_intents', { id: `pi-${i}`, company_id: MM, provider: 'asaas', origin_type: 'order', origin_id: 'o-mm', method: 'pix', amount_cents: 1050, idempotency_key: `pix-${i}` });
  }
  inserir('core_inbound_notes', { id: 'nf-9991', company_id: PJ, access_key: '35260811222333000181550010000099911000099910', supplier_id: 'forn-nota' });
  inserir('core_inbound_note_items', { id: 'nfi-1', note_id: 'nf-9991', company_id: PJ, product_id: 'p-capa', description: 'Capa', quantity: 10 });

  // --- Oficina: equipamento com plaquinha, OS com peça, comentário e eventos
  inserir('core_equipment', {
    id: 'eq-1', company_id: OF, workshop_id: mobilidade, public_id: 1, public_token: 'tok-eq-1', origin: 'venda',
    owner_customer_id: 'cli-of', sale_id: 's-of', linked_product_id: 'p-patinete', assembly_mechanic_id: roberto,
  });
  inserir('core_equipment_events', { id: 'eqe-1', equipment_id: 'eq-1', company_id: OF, event_type: 'montagem' });
  inserir('core_equipment_events', { id: 'eqe-2', equipment_id: 'eq-1', company_id: OF, event_type: 'entrega' });
  inserir('core_equipment_tags', { id: 'tag-1', company_id: OF, public_id: 1, public_token: 'tok-tag-1', equipment_id: 'eq-1', created_by: roberto });
  inserir('core_service_orders', {
    id: 'os-1', company_id: OF, number: 1, workshop_id: mobilidade, mechanic_id: roberto, customer_id: 'cli-of', equipment_id: 'eq-1', sale_id: 's-of',
  });
  inserir('core_service_order_parts', { id: 'osp-1', order_id: 'os-1', company_id: OF, product_id: 'p-pneu', description: 'Pneu', quantity: 1, unit_price_cents: 9000, total_cents: 9000 });
  inserir('core_service_order_comments', { id: 'osc-1', order_id: 'os-1', company_id: OF, body: 'Troca de pneu', author_id: roberto });
  for (const [i, s] of ['aberta', 'em_andamento', 'concluida'].entries()) {
    inserir('core_service_order_events', { id: `ose-${i}`, order_id: 'os-1', company_id: OF, to_status: s });
  }

  // --- Orçamento, pré-venda, inventário ------------------------------------
  inserir('core_quotes', { id: 'q-orc', company_id: PJ, number: 1 }, { kind: 'orcamento' });
  inserir('core_quote_items', { id: 'qi-1', quote_id: 'q-orc', company_id: PJ, product_id: 'p-capa', description: 'Capa', quantity: 1, unit_price_cents: 2990, total_cents: 2990 });
  inserir('core_quotes', { id: 'q-pv', company_id: PJ, number: 2, converted_sale_id: 's-pj' }, { kind: 'pre_venda' });
  inserir('core_quote_items', { id: 'qi-2', quote_id: 'q-pv', company_id: PJ, product_id: 'p-camiseta-p', description: 'Camiseta P', quantity: 1, unit_price_cents: 4990, total_cents: 4990 });
  inserir('core_inventory_counts', { id: 'inv-1', company_id: PJ, number: 1, opened_at: AGORA }, { location_id: 'loc-geral-pj' });
  inserir('core_inventory_count_items', { id: 'invi-1', count_id: 'inv-1', company_id: PJ, product_id: 'p-capa', expected_quantity: 5 });
  inserir('core_inventory_count_items', { id: 'invi-2', count_id: 'inv-1', company_id: PJ, product_id: 'p-camiseta-m', expected_quantity: 2 });

  // --- Financeiro, comissão, filas -----------------------------------------
  const categoriaDeVenda = (getConnection().prepare("SELECT id FROM core_finance_categories WHERE company_id = ? AND system_code IS NOT NULL AND direction = 'in' ORDER BY system_code LIMIT 1").get(PJ) as { id: string }).id;
  inserir('core_finance_entries', { id: 'fe-venda', company_id: PJ, direction: 'in', amount_cents: 2990, description: 'Venda 1', origin_type: 'sale', origin_id: 's-pj', account_id: 'conta-real', category_id: categoriaDeVenda });
  inserir('core_finance_entries', { id: 'fe-of', company_id: OF, direction: 'in', amount_cents: 199000, description: 'Venda 1', origin_type: 'sale', origin_id: 's-of', customer_id: 'cli-of' });
  inserir('core_finance_entries', { id: 'fe-com', company_id: PJ, direction: 'out', amount_cents: 300, description: 'Comissão', origin_type: 'commission', origin_id: 'cc-1' });
  inserir('core_finance_entries', { id: 'fe-nota', company_id: PJ, direction: 'out', amount_cents: 10000, description: 'NF 9991', origin_type: 'inbound_note', origin_id: 'nf-9991', supplier_id: 'forn-nota' });
  inserir('core_commission_closings', { id: 'cc-1', company_id: PJ, seller_id: 'u-preco-justo.pdv', period_from: '2026-08-01', period_to: '2026-08-31', total_cents: 300, finance_entry_id: 'fe-com' });
  inserir('core_print_jobs', { id: 'job-1', company_id: PJ, document_type: 'sale', document_id: 's-pj' });
  inserir('core_print_jobs', { id: 'job-2', company_id: PJ, document_type: 'sale', document_id: 's-pj', reprint_of: 'job-1' });
  inserir('core_email_queue', {
    id: 'mail-1', company_id: MM, template: 'pagamento_confirmado', to_address: 'cliente.pedido@exemplo.test', subject: 'Pagamento', body_text: 'ok', payload: '{}', dedupe_key: 'mail-1',
  });

  // --- Maquininha de teste, e uma de verdade ao lado -----------------------
  insertRow('payment_terminal_configurations', { id: 'ptc-mock', companyId: PJ, provider: 'mock', active: true });
  insertRow('payment_terminal_configurations', { id: 'ptc-stone', companyId: PJ, provider: 'stone', active: true, credencial: 'CREDENCIAL-STONE-NAO-IMPRIMIR' });
  for (const i of [1, 2]) insertRow('payment_terminal_transactions', { id: `ptt-${i}`, companyId: PJ, provider: 'mock', simulated: true, real: false, amountInCents: 100 });
  insertRow('payment_terminal_transactions', { id: 'ptt-stone', companyId: PJ, provider: 'stone', simulated: false, real: true, amountInCents: 500 });

  // --- Numeração ------------------------------------------------------------
  const seq: Array<[string, string, number]> = [
    [PJ, 'sale', 2], [PJ, 'product_code', 4], [PJ, 'quote_orcamento', 1], [PJ, 'quote_pre_venda', 1], [PJ, 'inventory_count', 1], [PJ, 'barcode', 3],
    [OF, 'sale', 1], [OF, 'service_order', 1], [OF, 'product_code', 2], [OF, 'barcode', 1], [OF, 'equipment_public_id', 1], [MM, 'ecommerce_order', 1],
  ];
  for (const [c, n, v] of seq) inserir('core_sequences', { company_id: c, name: n, current: v });

  // --- A trilha que já existia ----------------------------------------------
  recordAudit({ companyId: PJ, userId: gestor, action: 'auth.quick_login', entityType: 'user', entityId: gestor });
  recordAudit({ companyId: PJ, userId: gestor, action: 'product.create', entityType: 'product', entityId: 'p-capa', detail: { nome: 'Capa de celular' } });
  recordAudit({ companyId: PJ, userId: admin, action: 'fiscal.config.update', entityType: 'fiscal_config', entityId: PJ });
}

/** O que sai da demonstração acima, tabela a tabela. */
const SAI: Record<string, number> = {
  core_email_queue: 1,
  core_print_jobs: 2,
  core_payment_intents: 2,
  core_commission_closings: 1,
  core_commission_groups: 1,
  core_commission_tiers: 1,
  core_finance_entries: 4,
  core_acquirers: 1,
  core_finance_accounts: 1,
  core_finance_categories: 2,
  core_orders: 1,
  core_order_items: 1,
  core_order_events: 2,
  core_quotes: 2,
  core_quote_items: 2,
  core_service_orders: 1,
  core_service_order_parts: 1,
  core_service_order_comments: 1,
  core_service_order_events: 3,
  core_equipment_tags: 1,
  core_equipment: 1,
  core_equipment_events: 2,
  core_inventory_counts: 1,
  core_inventory_count_items: 2,
  core_inbound_notes: 1,
  core_inbound_note_items: 1,
  core_sales: 2,
  core_sale_items: 2,
  core_sale_payments: 2,
  core_cash_sessions: 3,
  core_cash_movements: 2,
  core_products: 6,
  core_product_images: 2,
  core_promotions: 1,
  core_stock: 5,
  core_stock_movements: 6,
  core_stock_locations: 1,
  core_users: 13,
  core_user_companies: 23,
  core_workshop_members: 5,
  api_sessions: 3,
  core_login_attempts: 2,
  payment_terminal_transactions: 2,
  payment_terminal_configurations: 1,
  core_sequences: 9,
};

const CONFIGURACAO = [
  'core_companies', 'core_workshops', 'core_fiscal_configs', 'fiscal_certificate_references', 'core_fiscal_series', 'core_tax_groups',
  'nfce_settings', 'integration_configurations', 'integration_secrets', 'core_mail_inboxes', 'asaas_operational_attempts',
  'asaas_sandbox_homologations', 'core_units', 'core_printers', 'core_customers', 'core_suppliers',
];

// ---------------------------------------------------------------------------
// Conferência independente do módulo: o sha256 de cada tabela
// ---------------------------------------------------------------------------

function digestDa(db: DatabaseSync, tabela: string, onde = '1 = 1'): string {
  const h = createHash('sha256');
  for (const l of db.prepare(`SELECT * FROM "${tabela}" WHERE ${onde} ORDER BY rowid`).all()) h.update(JSON.stringify(Object.values(l as object)));
  return h.digest('hex');
}

function digestDoBanco(db: DatabaseSync = getConnection()): Record<string, string> {
  const r: Record<string, string> = {};
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ('core_instancia') ORDER BY name").all() as { name: string }[]) {
    r[name] = digestDa(db, name);
  }
  return r;
}

function contar(tabela: string, onde = '1 = 1'): number {
  return (getConnection().prepare(`SELECT COUNT(*) AS n FROM "${tabela}" WHERE ${onde}`).get() as { n: number }).n;
}

function ids(tabela: string, coluna = 'id'): string[] {
  return (getConnection().prepare(`SELECT "${coluna}" AS v FROM "${tabela}" ORDER BY 1`).all() as { v: string }[]).map((l) => String(l.v));
}

let uploads = '';
let backups = '';

beforeEach(() => {
  resetCoreSchemaCache();
  ensureCoreSchema(); // recria a tabela que um caso tenha derrubado
  getConnection().exec('DROP TRIGGER IF EXISTS limpeza_teste_a_mais; DROP TABLE IF EXISTS asaas_sandbox_homologations;');
  resetDbForTests();
  const pasta = mkdtempSync(join(RAIZ, 'gs limpeza '));
  uploads = join(pasta, 'data', 'uploads');
  backups = join(pasta, 'backups');
  process.env.DEVORA_UPLOADS_DIR = uploads;
  process.env.DEVORA_BACKUP_DIR = backups;
  delete process.env.DEVORA_BOOTSTRAP_ADMIN_PASSWORD;
  montarDemonstracao(uploads);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe('a simulação', () => {
  it('diz exatamente o que sai, tabela a tabela, com produtos, contas e dúvidas — e não escreve nada', () => {
    const antes = digestDoBanco();
    const r = simularLimpezaDaDemonstracao();
    expect(r.codigo, r.recusa.join('\n')).toBe(0);
    const plano = r.plano!;
    expect(plano.bloqueios).toEqual([]);
    expect(Object.fromEntries(plano.porTabela.map((l) => [l.tabela, l.saem]))).toEqual(SAI);
    expect(plano.totalQueSai).toBe(Object.values(SAI).reduce((s, n) => s + n, 0));
    expect(plano.produtos.map((p) => p.nome)).toEqual([
      'Camiseta Básica', 'Camiseta Básica M', 'Camiseta Básica P', 'Capa de celular', 'Patinete Elétrico X', 'Pneu aro 10',
    ]);
    expect(plano.usuarios.map((u) => u.login).sort()).toEqual([...LOGINS_DA_DEMONSTRACAO].sort());
    expect(plano.duvidas.clientes).toMatchObject({ citados: 2, incluidos: false });
    expect(plano.duvidas.fornecedores).toMatchObject({ citados: 1, incluidos: false });
    expect(plano.duvidas.sequenciasDeEtiqueta.linhas.map((l) => l.nome).sort()).toEqual(['barcode', 'barcode', 'equipment_public_id']);
    expect(plano.arquivos).toEqual([
      { pasta: 'produtos', nome: 'foto-capa.png' },
      { pasta: 'produtos', nome: 'foto-patinete.png' },
    ]);
    expect(plano.impressao).toMatch(/^[0-9a-f]{64}$/);
    // O CASCADE vem dito, e a origem dele também.
    expect(plano.porTabela.find((l) => l.tabela === 'core_stock')).toMatchObject({ diretas: 0, emCascata: 5, cascataDe: ['core_products'] });
    expect(plano.porTabela.find((l) => l.tabela === 'core_finance_categories')).toMatchObject({ diretas: 2 });

    const texto = r.linhas.join('\n');
    expect(texto).toContain(`--aplicar ${plano.impressao}`);
    expect(texto).toContain('CARLOSGERENTE — Carlos Gerente');
    expect(texto).toContain('Capa de celular [00001]');
    expect(texto).toMatch(/core_customers \d+/); // o que fica, com a contagem
    for (const s of NUNCA_NA_SAIDA) expect(texto, s).not.toContain(s);

    expect(digestDoBanco()).toEqual(antes);
    // Duas simulações do mesmo banco dão a mesma impressão.
    expect(simularLimpezaDaDemonstracao().plano!.impressao).toBe(plano.impressao);
  });

  it('a ordem errada seria recusada pelo banco: o plano segue a que funciona com foreign_keys ligado', () => {
    const db = getConnection();
    expect((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys).toBe(1);
    for (const sql of ['DELETE FROM core_products', 'DELETE FROM core_users', 'DELETE FROM core_sales', "DELETE FROM core_stock_locations WHERE code = 'ZZ-VERIF'"]) {
      db.exec('SAVEPOINT errada;');
      expect(() => db.exec(sql), sql).toThrow(/FOREIGN KEY/);
      db.exec('ROLLBACK TO errada; RELEASE errada;');
    }
  });
});

describe('a aplicação', () => {
  it('impressão errada: recusa, e o banco fica idêntico', () => {
    const antes = digestDoBanco();
    const r = aplicarLimpezaDaDemonstracao('0'.repeat(64));
    expect(r.codigo).toBe(1);
    expect(r.recusa.join(' ')).toMatch(/impressão digital não bate/);
    expect(digestDoBanco()).toEqual(antes);
    expect(existsSync(backups) ? readdirSync(backups) : []).toEqual([]);
  });

  it('impressão certa: sai exatamente o plano, com cópia antes, fotos em quarentena, a configuração idêntica e uma linha de auditoria sem dado pessoal', () => {
    const db = getConnection();
    const sim = simularLimpezaDaDemonstracao();
    const contagensAntes = Object.fromEntries(Object.keys(SAI).map((t) => [t, contar(t)]));
    const configAntes = Object.fromEntries(CONFIGURACAO.map((t) => [t, digestDa(db, t)]));
    const categoriasDeSistemaAntes = digestDa(db, 'core_finance_categories', 'system_code IS NOT NULL');
    const auditoriaAntes = digestDa(db, 'core_audit_log');
    const linhasDeAuditoriaAntes = contar('core_audit_log');

    const r = aplicarLimpezaDaDemonstracao(sim.plano!.impressao);
    expect(r.codigo, r.recusa.join('\n')).toBe(0);

    // Saiu exatamente o plano.
    for (const [t, n] of Object.entries(SAI)) expect(contar(t), t).toBe(contagensAntes[t] - n);
    expect(contar('core_products')).toBe(0);
    expect(contar('core_stock')).toBe(0);
    expect(contar('core_stock_movements')).toBe(0);
    expect(contar('core_users')).toBe(0);
    expect(contar('api_sessions')).toBe(0);
    expect(ids('core_stock_locations')).toEqual(['loc-geral-of', 'loc-geral-pj']);
    expect(ids('core_finance_accounts')).toEqual(['conta-real']);
    expect(contar('core_finance_categories', "name LIKE 'ZZ-%'")).toBe(0);
    expect(ids('payment_terminal_configurations')).toEqual(['ptc-stone']);
    expect(ids('payment_terminal_transactions')).toEqual(['ptt-stone']);
    // A numeração das entidades recomeça; a de etiqueta fica.
    expect(ids('core_sequences', 'name')).toEqual(['barcode', 'barcode', 'equipment_public_id']);

    // A configuração e as dúvidas: o MESMO conteúdo.
    for (const t of CONFIGURACAO) expect(digestDa(db, t), t).toBe(configAntes[t]);
    expect(digestDa(db, 'core_finance_categories', 'system_code IS NOT NULL')).toBe(categoriasDeSistemaAntes);
    expect(contar('core_companies')).toBe(6);

    // A auditoria: as de antes intactas, mais UMA, só com contagens.
    expect(contar('core_audit_log')).toBe(linhasDeAuditoriaAntes + 1);
    expect(digestDa(db, 'core_audit_log', `action <> '${ACAO_DA_LIMPEZA}'`)).toBe(auditoriaAntes);
    const nova = db.prepare('SELECT user_id, company_id, detail FROM core_audit_log WHERE action = ?').get(ACAO_DA_LIMPEZA) as {
      user_id: string | null;
      company_id: string | null;
      detail: string;
    };
    expect(nova.user_id).toBeNull();
    const detalhe = JSON.parse(nova.detail) as { porTabela: Record<string, number>; impressao: string; linhasQueSairam: number };
    expect(detalhe.porTabela).toEqual(SAI);
    expect(detalhe.impressao).toBe(sim.plano!.impressao);
    for (const pessoal of [...LOGINS_DA_DEMONSTRACAO, 'Carlos Gerente', ...NUNCA_NA_SAIDA]) expect(nova.detail, pessoal).not.toContain(pessoal);

    // A cópia de antes existe, é íntegra e tem a demonstração inteira.
    expect(r.copia).toMatch(/antes_da_limpeza\.db$/);
    expect(verificarBackup(r.copia!).ok).toBe(true);
    const copia = new DatabaseSync(r.copia!, { readOnly: true });
    try {
      expect((copia.prepare('SELECT COUNT(*) AS n FROM core_products').get() as { n: number }).n).toBe(6);
    } finally {
      copia.close();
    }

    // As fotos foram MOVIDAS para a quarentena; o que ninguém citava ficou.
    expect(r.quarentena).toMatchObject({ movidos: 2, ausentes: 0 });
    expect(readdirSync(join(r.quarentena!.pasta!, 'produtos')).sort()).toEqual(['foto-capa.png', 'foto-patinete.png']);
    expect(readdirSync(join(uploads, 'produtos'))).toEqual(['outra-que-ninguem-cita.png']);
    expect(existsSync(join(uploads, 'lojas', 'logo.png'))).toBe(true);
    // Ao lado da pasta de uploads: <data>/quarentena/<carimbo>-limpeza-demonstracao/produtos.
    expect(r.quarentena!.pasta!.startsWith(join(uploads, '..', 'quarentena'))).toBe(true);
    expect(r.quarentena!.pasta!).toMatch(/-limpeza-demonstracao$/);

    // As provas.
    const texto = r.linhas.join('\n');
    expect(texto).toContain('integrity_check: ok');
    expect(texto).toContain('foreign_key_check: 0');
    expect(texto).toContain('toda linha que devia ficar, em todas as tabelas: igual a antes');
    expect(texto).toMatch(/integration_secrets: igual a antes/);
    expect(texto).toMatch(/core_fiscal_configs: igual a antes/);
    for (const s of NUNCA_NA_SAIDA) expect(texto, s).not.toContain(s);
    expect((db.prepare('PRAGMA foreign_key_check').all() as unknown[]).length).toBe(0);
    expect(contar('core_instancia')).toBe(0); // a trava foi solta
  });

  it('rodar de novo depois de aplicada: nada a fazer, sai 0, e a auditoria não ganha linha', () => {
    const sim = simularLimpezaDaDemonstracao();
    expect(aplicarLimpezaDaDemonstracao(sim.plano!.impressao).codigo).toBe(0);
    const linhas = contar('core_audit_log');
    const antes = digestDoBanco();

    const deNovo = simularLimpezaDaDemonstracao();
    expect(deNovo.codigo).toBe(0);
    expect(deNovo.linhas.join('\n')).toMatch(/já foi aplicada neste banco em .*Nada a fazer/);
    const reaplicar = aplicarLimpezaDaDemonstracao(sim.plano!.impressao);
    expect(reaplicar.codigo).toBe(0);
    expect(reaplicar.linhas.join('\n')).toMatch(/Nada a fazer/);
    expect(contar('core_audit_log')).toBe(linhas);
    expect(digestDoBanco()).toEqual(antes);
  });

  it('com a API segurando o banco: recusa, e o banco fica idêntico', () => {
    const sim = simularLimpezaDaDemonstracao();
    const antes = digestDoBanco();
    // O dono é um processo VIVO desta máquina (o do Vitest), não este.
    const d = tentarAssumir('api', { pid: process.ppid });
    expect(d.assumiu).toBe(true);
    try {
      const r = aplicarLimpezaDaDemonstracao(sim.plano!.impressao);
      expect(r.codigo).toBe(1);
      expect(r.recusa.join(' ')).toMatch(/Outra instância já usa este banco/);
      expect(r.recusa.join(' ')).toMatch(/Nada foi apagado/);
    } finally {
      if (d.assumiu) liberarInstancia(d.token);
    }
    expect(digestDoBanco()).toEqual(antes);
  });

  it('com documento fiscal autorizado em PRODUÇÃO: a simulação aponta e a aplicação recusa', () => {
    inserir('core_fiscal_documents', {
      id: 'fd-prod', company_id: PJ, sale_id: 's-pj', model: '65', serie: 1, number: 1, environment: 'production', status: 'AUTHORIZED', protocol: '135260000000001',
    });
    const sim = simularLimpezaDaDemonstracao();
    expect(sim.codigo).toBe(1);
    expect(sim.plano!.documentosFiscaisDeProducao).toBe(1);
    expect(sim.linhas.join('\n')).toMatch(/documento\(s\) fiscal\(is\) de PRODUÇÃO/);
    const antes = digestDoBanco();
    const r = aplicarLimpezaDaDemonstracao(sim.plano!.impressao);
    expect(r.codigo).toBe(1);
    expect(r.recusa.join(' ')).toMatch(/PRODUÇÃO.*Nada foi apagado/);
    expect(digestDoBanco()).toEqual(antes);
  });

  it('o banco apaga a mais do que o plano previu: a conferência pega, ROLLBACK, nada muda', () => {
    // Um gatilho é o jeito mais direto de o banco fazer algo que nenhuma chave diz.
    getConnection().exec(
      "CREATE TRIGGER limpeza_teste_a_mais AFTER DELETE ON core_products BEGIN DELETE FROM core_units WHERE id = 'un-1'; END;",
    );
    const sim = simularLimpezaDaDemonstracao();
    const antes = digestDoBanco();
    const r = aplicarLimpezaDaDemonstracao(sim.plano!.impressao);
    expect(r.codigo).toBe(1);
    const recusa = r.recusa.join(' ');
    expect(recusa).toMatch(/ROLLBACK, nada mudou/);
    expect(recusa).toMatch(/core_units: esperava 1 linha\(s\) depois, ficaram 0/);
    expect(digestDoBanco()).toEqual(antes);
    expect(readdirSync(join(uploads, 'produtos')).sort()).toEqual(['foto-capa.png', 'foto-patinete.png', 'outra-que-ninguem-cita.png']);
  });
});

describe('as dúvidas ficam, a não ser por flag', () => {
  const FLAGS = { incluirClientes: true, incluirFornecedor: true, reiniciarSequenciasDeEtiqueta: true };

  it('com as três flags: saem os clientes e o fornecedor da demonstração, e a numeração de etiqueta — e a impressão é outra', () => {
    const sem = simularLimpezaDaDemonstracao();
    const com = simularLimpezaDaDemonstracao(FLAGS);
    expect(com.codigo, com.recusa.join('\n')).toBe(0);
    expect(com.plano!.impressao).not.toBe(sem.plano!.impressao);
    const saem = Object.fromEntries(com.plano!.porTabela.map((l) => [l.tabela, l.saem]));
    expect(saem).toEqual({ ...SAI, core_customers: 2, core_suppliers: 1, core_sequences: 12 });

    // A impressão sem flags não aplica com flags: recusa, nada muda.
    const antes = digestDoBanco();
    expect(aplicarLimpezaDaDemonstracao(sem.plano!.impressao, FLAGS).codigo).toBe(1);
    expect(digestDoBanco()).toEqual(antes);

    const r = aplicarLimpezaDaDemonstracao(com.plano!.impressao, FLAGS);
    expect(r.codigo, r.recusa.join('\n')).toBe(0);
    // Só os citados pela demonstração: o cliente e o fornecedor que ninguém citava ficam.
    expect(ids('core_customers')).toEqual(['cli-real']);
    expect(ids('core_suppliers')).toEqual(['forn-real']);
    expect(contar('core_sequences')).toBe(0);
  });

  it('o admin que o bootstrap cria (login minúsculo) não é conta da demonstração', () => {
    const admin = usuario('admin', 'Administrador');
    vinculo(admin, PJ, 'admin_geral');
    const sim = simularLimpezaDaDemonstracao();
    expect(sim.plano!.usuarios.map((u) => u.login)).not.toContain('admin');
    expect(aplicarLimpezaDaDemonstracao(sim.plano!.impressao).codigo).toBe(0);
    expect(ids('core_users', 'login')).toEqual(['admin']);
    expect(contar('core_user_companies', `user_id = '${admin}'`)).toBe(1);
  });
});

describe('outra versão do banco', () => {
  it('tabela que não existe é pulada, e o resto sai do mesmo jeito', () => {
    getConnection().exec('DROP TABLE core_email_queue;');
    const sim = simularLimpezaDaDemonstracao();
    expect(sim.codigo, sim.recusa.join('\n')).toBe(0);
    expect(sim.plano!.passos.find((p) => p.tabela === 'core_email_queue')?.situacao).toBe('ausente');
    expect(sim.linhas.join('\n')).toContain('core_email_queue: não existe neste banco — pulado');
    const r = aplicarLimpezaDaDemonstracao(sim.plano!.impressao);
    expect(r.codigo, r.recusa.join('\n')).toBe(0);
    expect(contar('core_products')).toBe(0);
  });
});

describe('o comando de linha', () => {
  it('simula por padrão, recusa argumento desconhecido, aplica com a impressão — e nunca imprime segredo', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const erro = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const saida = () => [...log.mock.calls, ...erro.mock.calls].map((c) => c.join(' ')).join('\n');

    expect(limparPelaLinhaDeComando(['--incluir-cliente'])).toBe(1);
    expect(saida()).toMatch(/Argumento desconhecido: --incluir-cliente/);

    expect(limparPelaLinhaDeComando([])).toBe(0);
    const simulacao = saida();
    const impressao = /Impressão digital: ([0-9a-f]{64})/.exec(simulacao)?.[1];
    expect(impressao).toBeTruthy();
    expect(simulacao).toContain(`npm run db:limpar-demonstracao --prefix server -- --aplicar ${impressao}`);
    expect(simulacao).toMatch(/AVISO: DEVORA_BOOTSTRAP_ADMIN_PASSWORD não está no ambiente/);
    expect(simulacao).toMatch(/limpe os dados do site/);

    process.env.DEVORA_BOOTSTRAP_ADMIN_PASSWORD = 'SenhaDoBootstrap#2026';
    try {
      log.mockClear();
      erro.mockClear();
      expect(limparPelaLinhaDeComando(['--aplicar', impressao!])).toBe(0);
      const aplicacao = saida();
      expect(aplicacao).toContain('PROVAS (depois do COMMIT)');
      expect(aplicacao).toMatch(/DEVORA_BOOTSTRAP_ADMIN_PASSWORD está definida/);
      expect(aplicacao).not.toContain('SenhaDoBootstrap#2026');
      for (const s of NUNCA_NA_SAIDA) {
        expect(simulacao, s).not.toContain(s);
        expect(aplicacao, s).not.toContain(s);
      }
    } finally {
      delete process.env.DEVORA_BOOTSTRAP_ADMIN_PASSWORD;
    }
    expect(contar('core_products')).toBe(0);
  });

  it('--banco limpa o arquivo indicado, e o banco da instalação não é tocado', () => {
    const original = resolveDatabasePath();
    const outro = join(mkdtempSync(join(RAIZ, 'gs limpeza outro ')), 'outro.db');
    getConnection().prepare('VACUUM INTO ?').run(outro);
    const antes = digestDoBanco();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(limparPelaLinhaDeComando(['--banco', outro])).toBe(0);
      const texto = log.mock.calls.map((c) => c.join(' ')).join('\n');
      const impressao = /Impressão digital: ([0-9a-f]{64})/.exec(texto)![1];
      expect(texto).toContain(`--aplicar ${impressao} --banco "${outro}"`);
      expect(limparPelaLinhaDeComando(['--aplicar', impressao, '--banco', outro])).toBe(0);
    } finally {
      process.env.DEVORA_DATABASE_PATH = original;
      closeConnection();
    }
    const limpo = new DatabaseSync(outro, { readOnly: true });
    try {
      expect((limpo.prepare('SELECT COUNT(*) AS n FROM core_products').get() as { n: number }).n).toBe(0);
    } finally {
      limpo.close();
    }
    expect(resolveDatabasePath()).toBe(original);
    expect(digestDoBanco()).toEqual(antes);
  });
});
