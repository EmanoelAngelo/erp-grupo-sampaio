/**
 * Os três cadastros que dão sentido ao lançamento financeiro.
 *
 * | cadastro       | responde a pergunta          |
 * |----------------|------------------------------|
 * | categoria      | PARA QUE foi o dinheiro      |
 * | centro de custo| DE QUAL operação saiu        |
 * | conta          | ONDE o dinheiro está         |
 *
 * ## Categoria é opcional, e isso é decisão
 *
 * Exigir categoria quebraria os cinco pontos que já inserem lançamento sem
 * ela — inclusive a venda de balcão. Um lançamento sem classificação é ruim;
 * uma venda recusada no caixa porque ninguém cadastrou plano de contas é pior.
 *
 * O que se faz é semear as categorias de sistema na primeira vez e apontá-las
 * automaticamente, para que o padrão já venha classificado.
 *
 * ## O caixa do PDV não é uma conta
 *
 * `core_cash_sessions` já existe, abre e fecha por turno, e é conferido por
 * sangria e suprimento. Modelá-lo como conta criaria dois donos do mesmo
 * saldo — o mesmo erro que as rodadas 6 e 8 recusaram. A ponte é o
 * lançamento: a sangria vira uma linha com `account_id` do cofre ou do banco.
 */
import { randomUUID } from 'node:crypto';
import { getConnection } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';

const agora = () => new Date().toISOString();

export type FinanceDirection = 'in' | 'out';
export type AccountKind = 'banco' | 'caixinha' | 'carteira';

export interface FinanceCategory {
  id: string;
  company_id: string;
  direction: FinanceDirection;
  name: string;
  parent_id: string | null;
  system_code: string | null;
  active: number;
}

export interface CostCenter {
  id: string;
  company_id: string;
  code: string;
  name: string;
  active: number;
}

export interface FinanceAccount {
  id: string;
  company_id: string;
  name: string;
  kind: AccountKind;
  bank_code: string | null;
  agency: string | null;
  account_number: string | null;
  opening_balance_cents: number;
  opening_date: string | null;
  is_default: number;
  active: number;
}

function texto(valor: unknown, campo: string): string {
  const limpo = String(valor ?? '').trim();
  if (!limpo) throw new ApiError('CORE_FINANCE_FIELD_REQUIRED', `Informe ${campo}.`, 400);
  return limpo;
}

// ---------------------------------------------------------------- categorias

/**
 * As categorias que os lançamentos automáticos usam.
 *
 * `system_code` é o que amarra o código à linha: renomear "Venda de
 * mercadoria" para "Vendas balcão" não pode desligar a classificação
 * automática da venda. Por isso a busca é pelo código, nunca pelo nome.
 */
const CATEGORIAS_DE_SISTEMA: {
  code: string;
  direction: FinanceDirection;
  name: string;
}[] = [
  { code: 'venda', direction: 'in', name: 'Venda de mercadoria' },
  { code: 'servico', direction: 'in', name: 'Serviço de oficina' },
  { code: 'outras_receitas', direction: 'in', name: 'Outras receitas' },
  { code: 'fornecedor', direction: 'out', name: 'Compra de mercadoria' },
  // A taxa da maquininha é despesa, e precisa de categoria própria: embutida
  // na receita, ninguém nunca soma quanto o cartão custou no ano.
  { code: 'taxa_cartao', direction: 'out', name: 'Taxa de cartão' },
  { code: 'devolucao', direction: 'out', name: 'Devolução a cliente' },
  { code: 'despesa_operacional', direction: 'out', name: 'Despesa operacional' },
  { code: 'imposto', direction: 'out', name: 'Impostos e taxas' },
  { code: 'folha', direction: 'out', name: 'Folha e pró-labore' },
];

/** Cria as categorias de sistema que faltarem. Idempotente por `system_code`. */
export function seedSystemCategories(companyId: string): void {
  ensureCoreSchema();
  const db = getConnection();
  const ts = agora();
  const stmt = db.prepare(
    `INSERT INTO core_finance_categories
       (id, company_id, direction, name, parent_id, system_code, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, ?, 1, ?, ?)
     ON CONFLICT DO NOTHING`,
  );
  for (const c of CATEGORIAS_DE_SISTEMA) {
    stmt.run(randomUUID(), companyId, c.direction, c.name, c.code, ts, ts);
  }
}

/**
 * A categoria de sistema pelo código — é assim que o automático classifica.
 *
 * Semeia antes de procurar. Sem isto a PRIMEIRA venda de uma empresa nova
 * nasceria sem categoria, porque `SalesService` chama esta função direto e não
 * passa por `listCategories`.
 */
export function systemCategoryId(companyId: string, code: string): string | null {
  ensureCoreSchema();
  seedSystemCategories(companyId);
  const row = getConnection()
    .prepare('SELECT id FROM core_finance_categories WHERE company_id = ? AND system_code = ?')
    .get(companyId, code) as { id: string } | undefined;
  return row?.id ?? null;
}

export function listCategories(
  companyId: string,
  options: { direction?: FinanceDirection; includeInactive?: boolean } = {},
): FinanceCategory[] {
  ensureCoreSchema();
  seedSystemCategories(companyId);
  const filtros: string[] = ['company_id = ?'];
  const params: unknown[] = [companyId];
  if (options.direction) {
    filtros.push('direction = ?');
    params.push(options.direction);
  }
  if (!options.includeInactive) filtros.push('active = 1');
  return getConnection()
    .prepare(
      `SELECT * FROM core_finance_categories
        WHERE ${filtros.join(' AND ')}
        ORDER BY direction, COALESCE(parent_id, id), name COLLATE NOCASE`,
    )
    .all(...(params as never[])) as unknown as FinanceCategory[];
}

export function createCategory(
  companyId: string,
  input: { direction: FinanceDirection; name: string; parentId?: string | null },
): FinanceCategory {
  ensureCoreSchema();
  const name = texto(input.name, 'o nome da categoria');
  if (input.direction !== 'in' && input.direction !== 'out') {
    throw new ApiError('CORE_FINANCE_DIRECTION', 'Direção inválida.', 400);
  }

  const db = getConnection();
  if (input.parentId) {
    const pai = db
      .prepare('SELECT direction, parent_id FROM core_finance_categories WHERE id = ? AND company_id = ?')
      .get(input.parentId, companyId) as { direction: string; parent_id: string | null } | undefined;
    if (!pai) throw new ApiError('CORE_CATEGORY_NOT_FOUND', 'Categoria pai não encontrada.', 404);
    // A árvore é rasa de propósito: dois níveis. Plano de contas profundo é o
    // que faz o lojista desistir de classificar.
    if (pai.parent_id) {
      throw new ApiError(
        'CORE_CATEGORY_TOO_DEEP',
        'O plano de contas tem dois níveis. Escolha uma categoria principal como pai.',
        400,
      );
    }
    if (pai.direction !== input.direction) {
      throw new ApiError(
        'CORE_CATEGORY_DIRECTION_MISMATCH',
        'Uma subcategoria de receita não pode ficar dentro de uma de despesa.',
        400,
      );
    }
  }

  const id = randomUUID();
  const ts = agora();
  try {
    db.prepare(
      `INSERT INTO core_finance_categories
         (id, company_id, direction, name, parent_id, system_code, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, 1, ?, ?)`,
    ).run(id, companyId, input.direction, name, input.parentId ?? null, ts, ts);
  } catch (err) {
    if (String(err).includes('UNIQUE')) {
      throw new ApiError('CORE_CATEGORY_DUPLICATE', `Já existe a categoria "${name}".`, 409);
    }
    throw err;
  }
  return db
    .prepare('SELECT * FROM core_finance_categories WHERE id = ?')
    .get(id) as unknown as FinanceCategory;
}

export function updateCategory(
  companyId: string,
  id: string,
  input: { name?: string; active?: boolean },
): FinanceCategory {
  ensureCoreSchema();
  const db = getConnection();
  const atual = db
    .prepare('SELECT * FROM core_finance_categories WHERE id = ? AND company_id = ?')
    .get(id, companyId) as FinanceCategory | undefined;
  if (!atual) throw new ApiError('CORE_CATEGORY_NOT_FOUND', 'Categoria não encontrada.', 404);

  // Categoria de sistema não desliga: é a que o lançamento automático usa, e
  // sem ela a venda entraria sem classificação nenhuma.
  if (input.active === false && atual.system_code) {
    throw new ApiError(
      'CORE_CATEGORY_SYSTEM',
      'Esta categoria é usada pelos lançamentos automáticos e não pode ser desativada. Renomeie se precisar.',
      409,
    );
  }

  db.prepare(
    `UPDATE core_finance_categories
        SET name = COALESCE(?, name), active = COALESCE(?, active), updated_at = ?
      WHERE id = ? AND company_id = ?`,
  ).run(
    input.name?.trim() || null,
    input.active === undefined ? null : input.active ? 1 : 0,
    agora(),
    id,
    companyId,
  );
  return db
    .prepare('SELECT * FROM core_finance_categories WHERE id = ?')
    .get(id) as unknown as FinanceCategory;
}

// ----------------------------------------------------------- centro de custo

export function listCostCenters(companyId: string, includeInactive = false): CostCenter[] {
  ensureCoreSchema();
  const filtro = includeInactive ? '' : ' AND active = 1';
  return getConnection()
    .prepare(
      `SELECT * FROM core_cost_centers
        WHERE company_id = ?${filtro}
        ORDER BY code`,
    )
    .all(companyId) as unknown as CostCenter[];
}

export function createCostCenter(
  companyId: string,
  input: { code: string; name: string },
): CostCenter {
  ensureCoreSchema();
  const code = texto(input.code, 'o código do centro de custo').toUpperCase();
  const name = texto(input.name, 'o nome do centro de custo');
  const db = getConnection();
  const id = randomUUID();
  const ts = agora();
  try {
    db.prepare(
      `INSERT INTO core_cost_centers (id, company_id, code, name, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)`,
    ).run(id, companyId, code, name, ts, ts);
  } catch (err) {
    if (String(err).includes('UNIQUE')) {
      throw new ApiError(
        'CORE_COST_CENTER_DUPLICATE',
        `Já existe um centro de custo com o código ${code}.`,
        409,
      );
    }
    throw err;
  }
  return db.prepare('SELECT * FROM core_cost_centers WHERE id = ?').get(id) as unknown as CostCenter;
}

export function updateCostCenter(
  companyId: string,
  id: string,
  input: { name?: string; active?: boolean },
): CostCenter {
  ensureCoreSchema();
  const db = getConnection();
  const atual = db
    .prepare('SELECT id FROM core_cost_centers WHERE id = ? AND company_id = ?')
    .get(id, companyId);
  if (!atual) throw new ApiError('CORE_COST_CENTER_NOT_FOUND', 'Centro de custo não encontrado.', 404);

  db.prepare(
    `UPDATE core_cost_centers
        SET name = COALESCE(?, name), active = COALESCE(?, active), updated_at = ?
      WHERE id = ? AND company_id = ?`,
  ).run(
    input.name?.trim() || null,
    input.active === undefined ? null : input.active ? 1 : 0,
    agora(),
    id,
    companyId,
  );
  return db.prepare('SELECT * FROM core_cost_centers WHERE id = ?').get(id) as unknown as CostCenter;
}

// ------------------------------------------------------------------- contas

export function listAccounts(companyId: string, includeInactive = false): FinanceAccount[] {
  ensureCoreSchema();
  const filtro = includeInactive ? '' : ' AND active = 1';
  return getConnection()
    .prepare(
      `SELECT * FROM core_finance_accounts
        WHERE company_id = ?${filtro}
        ORDER BY is_default DESC, name COLLATE NOCASE`,
    )
    .all(companyId) as unknown as FinanceAccount[];
}

export function createAccount(
  companyId: string,
  input: {
    name: string;
    kind?: AccountKind;
    bankCode?: string | null;
    agency?: string | null;
    accountNumber?: string | null;
    openingBalanceCents?: number;
    openingDate?: string | null;
    isDefault?: boolean;
  },
): FinanceAccount {
  ensureCoreSchema();
  const name = texto(input.name, 'o nome da conta');
  const kind = input.kind ?? 'banco';
  if (!['banco', 'caixinha', 'carteira'].includes(kind)) {
    throw new ApiError('CORE_ACCOUNT_KIND', 'Tipo de conta inválido.', 400);
  }

  const db = getConnection();
  const id = randomUUID();
  const ts = agora();
  // A primeira conta vira padrão sozinha: obrigar a marcar depois faria o
  // lançamento nascer sem conta justamente enquanto só há uma.
  const primeira = listAccounts(companyId, true).length === 0;
  const padrao = input.isDefault || primeira;
  if (padrao) limparPadrao(companyId);

  try {
    db.prepare(
      `INSERT INTO core_finance_accounts
         (id, company_id, name, kind, bank_code, agency, account_number,
          opening_balance_cents, opening_date, is_default, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(
      id,
      companyId,
      name,
      kind,
      input.bankCode?.trim() || null,
      input.agency?.trim() || null,
      input.accountNumber?.trim() || null,
      input.openingBalanceCents ?? 0,
      input.openingDate ?? null,
      padrao ? 1 : 0,
      ts,
      ts,
    );
  } catch (err) {
    if (String(err).includes('UNIQUE')) {
      throw new ApiError('CORE_ACCOUNT_DUPLICATE', `Já existe a conta "${name}".`, 409);
    }
    throw err;
  }
  return db
    .prepare('SELECT * FROM core_finance_accounts WHERE id = ?')
    .get(id) as unknown as FinanceAccount;
}

function limparPadrao(companyId: string): void {
  getConnection()
    .prepare('UPDATE core_finance_accounts SET is_default = 0 WHERE company_id = ?')
    .run(companyId);
}

export function updateAccount(
  companyId: string,
  id: string,
  input: { name?: string; active?: boolean; isDefault?: boolean; openingBalanceCents?: number },
): FinanceAccount {
  ensureCoreSchema();
  const db = getConnection();
  const atual = db
    .prepare('SELECT * FROM core_finance_accounts WHERE id = ? AND company_id = ?')
    .get(id, companyId) as FinanceAccount | undefined;
  if (!atual) throw new ApiError('CORE_ACCOUNT_NOT_FOUND', 'Conta não encontrada.', 404);

  /*
    A conta padrão não desliga ENQUANTO HOUVER OUTRA ativa.

    A regra existe para o lançamento novo ter para onde apontar. Mas se esta é
    a última conta, desligar é legítimo: o sistema funciona com zero contas —
    `createEntry` aceita `account_id` nulo de propósito, para não exigir
    cadastro de banco antes da primeira despesa.

    Sem esta ressalva, a primeira conta cadastrada por engano ficaria presa
    para sempre como padrão da empresa.
  */
  if (input.active === false && atual.is_default === 1) {
    const outras = listAccounts(companyId).filter((c) => c.id !== id).length;
    if (outras > 0) {
      throw new ApiError(
        'CORE_ACCOUNT_DEFAULT_REQUIRED',
        'Esta é a conta padrão. Marque outra como padrão antes de desativá-la.',
        409,
      );
    }
  }
  if (input.isDefault) limparPadrao(companyId);

  db.prepare(
    `UPDATE core_finance_accounts
        SET name = COALESCE(?, name),
            active = COALESCE(?, active),
            is_default = COALESCE(?, is_default),
            opening_balance_cents = COALESCE(?, opening_balance_cents),
            updated_at = ?
      WHERE id = ? AND company_id = ?`,
  ).run(
    input.name?.trim() || null,
    input.active === undefined ? null : input.active ? 1 : 0,
    input.isDefault === undefined ? null : input.isDefault ? 1 : 0,
    input.openingBalanceCents ?? null,
    agora(),
    id,
    companyId,
  );
  return db
    .prepare('SELECT * FROM core_finance_accounts WHERE id = ?')
    .get(id) as unknown as FinanceAccount;
}

/**
 * Saldo da conta: o de partida mais o que já foi QUITADO.
 *
 * Derivado, nunca gravado — mesmo princípio do saldo por local da rodada 6.
 * Um saldo em cache aqui teria de ser mantido em dia por todo caminho que dá
 * baixa, e divergiria no primeiro que esquecesse.
 *
 * Conta a receber soma; a pagar subtrai. O que ainda está em aberto não entra:
 * dinheiro prometido não é dinheiro na conta.
 *
 * CANCELADO É O CARIMBO, NÃO O STATUS (GAP-PRD-172). Este leitor era o único
 * dos oito que decidia por `status <> 'cancelled'`; os outros sete (lista,
 * resumo, faixas, DRE, centro de custo, painel, fornecedor) olham
 * `cancelled_at IS NULL`. O status é DERIVADO — `aplicarStatus` o recalcula a
 * cada baixa e estorno —, e o carimbo não se recalcula: quem cancelou,
 * cancelou. Com dois critérios, um escritor que carimbasse sem trocar o
 * status faria o saldo da conta contar dinheiro de um fato que o resto do
 * sistema já esqueceu. A migração 56 carimbou todo 'cancelled' antigo, então
 * a troca não muda nenhum saldo existente.
 *
 * `settled_cents` já é o LÍQUIDO das baixas: o estorno grava a contrapartida e
 * subtrai do lançamento (`reverseSettlement`), então somar a coluna é somar só
 * as baixas que continuam de pé.
 */
export function accountBalanceCents(companyId: string, accountId: string): number {
  ensureCoreSchema();
  const db = getConnection();
  const conta = db
    .prepare('SELECT opening_balance_cents FROM core_finance_accounts WHERE id = ? AND company_id = ?')
    .get(accountId, companyId) as { opening_balance_cents: number } | undefined;
  if (!conta) throw new ApiError('CORE_ACCOUNT_NOT_FOUND', 'Conta não encontrada.', 404);

  const mov = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN direction = 'in'  THEN settled_cents ELSE 0 END), 0) AS entrou,
         COALESCE(SUM(CASE WHEN direction = 'out' THEN settled_cents ELSE 0 END), 0) AS saiu
       FROM core_finance_entries
      WHERE company_id = ? AND account_id = ? AND cancelled_at IS NULL`,
    )
    .get(companyId, accountId) as { entrou: number; saiu: number };

  return conta.opening_balance_cents + mov.entrou - mov.saiu;
}
