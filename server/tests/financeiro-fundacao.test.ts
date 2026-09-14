/**
 * Financeiro — fundação.
 *
 * Esta rodada abre `core_finance_entries`, e o plano diz que ela abre UMA VEZ.
 * O que se cobra aqui, em ordem de importância:
 *
 *  1. a reconstrução da tabela não perde lançamento nem afrouxa a trava
 *     anti-duplicidade de receita;
 *  2. os CHECK que a tabela nunca teve agora recusam lixo;
 *  3. os cinco escritores automáticos continuam funcionando — inclusive os
 *     dois que usam ON CONFLICT, cujo alvo teve de mudar junto com a chave;
 *  4. os três cadastros novos (categoria, centro de custo, conta).
 */
import { beforeEach, describe, expect, it } from 'vitest';

process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_DATABASE_PATH = ':memory:';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

const { ensureCoreSchema } = await import('../src/db/schema.js');
const { resetDbForTests } = await import('../src/db/database.js');
const { getConnection } = await import('../src/db/sqlite.js');
const { upsertCompany, upsertUser, linkUserToCompany } = await import(
  '../src/services/auth/IdentityService.js'
);
const { createProduct } = await import('../src/services/core/CatalogService.js');
const { applyMovement } = await import('../src/services/core/InventoryService.js');
const { createSale, cancelSale } = await import('../src/services/core/SalesService.js');
const { createEntry, listEntries } = await import('../src/services/core/FinanceService.js');
const {
  accountBalanceCents,
  createAccount,
  createCategory,
  createCostCenter,
  listAccounts,
  listCategories,
  listCostCenters,
  systemCategoryId,
  updateAccount,
  updateCategory,
} = await import('../src/services/core/FinanceSetupService.js');

let empresa: string;
let usuario: string;
let produto: string;

/** Insere direto na tabela, para exercitar os CHECK sem passar por serviço. */
function inserirCru(campos: Record<string, unknown>): void {
  const base: Record<string, unknown> = {
    id: `e-${Math.abs(Math.round(Number(campos.amount_cents ?? 1)))}-${campos.origin_id ?? 'x'}-${campos.direction ?? 'in'}-${campos.installment_number ?? 1}`,
    company_id: empresa,
    direction: 'in',
    amount_cents: 1000,
    status: 'open',
    settled_cents: 0,
    description: 'teste',
    origin_type: 'manual',
    origin_id: 'o1',
    created_at: new Date().toISOString(),
    ...campos,
  };
  const cols = Object.keys(base);
  getConnection()
    .prepare(
      `INSERT INTO core_finance_entries (${cols.join(',')})
       VALUES (${cols.map(() => '?').join(',')})`,
    )
    .run(...(Object.values(base) as never[]));
}

beforeEach(async () => {
  resetDbForTests();
  ensureCoreSchema();
  empresa = upsertCompany({
    slug: 'preco-justo',
    legalName: 'Preço Justo Ltda',
    tradeName: 'Preço Justo',
    kind: 'store',
  });
  usuario = await upsertUser({
    login: 'CAIXA_FIN',
    displayName: 'Caixa',
    password: 'Teste@Fin2026',
  });
  linkUserToCompany(usuario, empresa, 'gestor', true);
  produto = createProduct(empresa, { name: 'Camiseta Polo', priceCents: 5000 }).id;
});

describe('a trava anti-duplicidade de receita', () => {
  /**
   * A chave é (origem, id, direção, PARCELA). Sem a parcela, a segunda
   * prestação do carnê colidiria com a primeira e sumiria em silêncio pelo
   * ON CONFLICT.
   */
  it('o mesmo fato não gera dois lançamentos na mesma direção e parcela', () => {
    inserirCru({ origin_type: 'sale', origin_id: 'v1', direction: 'in' });
    expect(() =>
      inserirCru({ origin_type: 'sale', origin_id: 'v1', direction: 'in' }),
    ).toThrow(/UNIQUE/i);
  });

  it('o mesmo fato pode ter uma entrada e uma saída', () => {
    inserirCru({ origin_type: 'sale', origin_id: 'v1', direction: 'in' });
    expect(() =>
      inserirCru({ origin_type: 'sale', origin_id: 'v1', direction: 'out' }),
    ).not.toThrow();
  });

  /** É o que permite carnê sem reabrir a tabela de novo. */
  it('parcelas diferentes do mesmo fato convivem', () => {
    inserirCru({
      origin_type: 'sale',
      origin_id: 'v1',
      installment_number: 1,
      installment_total: 3,
    });
    expect(() =>
      inserirCru({
        origin_type: 'sale',
        origin_id: 'v1',
        installment_number: 2,
        installment_total: 3,
      }),
    ).not.toThrow();
  });

  /**
   * `installment_number` é NOT NULL DEFAULT 1 justamente por isto: no SQLite
   * vários NULL não colidem em índice único, e um nulo aqui devolveria a
   * duplicidade de receita pela porta dos fundos.
   */
  it('a parcela não aceita nulo', () => {
    expect(() => inserirCru({ installment_number: null })).toThrow();
  });
});

describe('os CHECK que a tabela nunca teve', () => {
  it('direção inventada é recusada', () => {
    expect(() => inserirCru({ direction: 'lateral' })).toThrow(/CHECK/i);
  });

  it('status que nenhuma tela sabe ler é recusado', () => {
    expect(() => inserirCru({ status: 'pendente' })).toThrow(/CHECK/i);
  });

  it('valor negativo é recusado', () => {
    expect(() => inserirCru({ amount_cents: -1 })).toThrow(/CHECK/i);
  });

  it('baixa negativa é recusada', () => {
    expect(() => inserirCru({ settled_cents: -5 })).toThrow(/CHECK/i);
  });

  it('parcela 3 de 2 é recusada', () => {
    expect(() =>
      inserirCru({ installment_number: 3, installment_total: 2 }),
    ).toThrow(/CHECK/i);
  });

  it('os três status usados em produção continuam válidos', () => {
    for (const status of ['open', 'settled', 'cancelled']) {
      expect(() => inserirCru({ status, origin_id: `o-${status}` })).not.toThrow();
    }
  });
});

describe('os escritores automáticos continuam funcionando', () => {
  function vender(chave: string) {
    applyMovement({
      companyId: empresa,
      productId: produto,
      movementType: 'in',
      quantity: 5,
      referenceType: 'ajuste',
      referenceId: `e-${chave}`,
    });
    return createSale({
      companyId: empresa,
      userId: usuario,
      items: [{ productId: produto, quantity: 1 }],
      payments: [{ method: 'dinheiro', amountCents: 5000 }],
      idempotencyKey: chave,
    });
  }

  it('a venda gera exatamente um lançamento', () => {
    vender('v1');
    expect(listEntries(empresa, {})).toHaveLength(1);
  });

  /** Classificação automática: sem ela o plano de contas ficaria vazio. */
  it('a venda nasce já classificada na categoria de sistema', () => {
    vender('v1');
    const [lanc] = getConnection()
      .prepare('SELECT category_id, competence_date FROM core_finance_entries')
      .all() as unknown as { category_id: string | null; competence_date: string | null }[];
    expect(lanc.category_id).toBe(systemCategoryId(empresa, 'venda'));
    expect(lanc.competence_date).toBeTruthy();
  });

  it('cancelar a venda não apaga o lançamento — ele fica cancelado', () => {
    const { sale } = vender('v1');
    cancelSale({ companyId: empresa, saleId: sale.id, userId: usuario, reason: 'teste' });
    const linhas = getConnection()
      .prepare('SELECT status FROM core_finance_entries')
      .all() as unknown as { status: string }[];
    expect(linhas).toHaveLength(1);
    expect(linhas[0].status).toBe('cancelled');
  });

  /**
   * Os dois escritores com ON CONFLICT tiveram de mudar o alvo junto com a
   * chave. Alvo parcial faz o SQLite recusar a instrução INTEIRA — e a
   * entrada de nota pararia de importar.
   */
  it('o alvo do ON CONFLICT casa com a chave de quatro colunas', () => {
    const db = getConnection();
    const inserir = () =>
      db
        .prepare(
          `INSERT INTO core_finance_entries
             (id, company_id, direction, amount_cents, status, settled_cents,
              description, origin_type, origin_id, created_at)
           VALUES (?, ?, 'out', 100, 'open', 0, 'nota', 'nfe_entrada', 'n1', ?)
           ON CONFLICT (origin_type, origin_id, direction, installment_number) DO NOTHING`,
        )
        .run(`id-${Math.random()}`, empresa, new Date().toISOString());

    expect(() => inserir()).not.toThrow();
    // A segunda é engolida pelo DO NOTHING, e não estoura.
    expect(() => inserir()).not.toThrow();
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM core_finance_entries').get() as { n: number }).n,
    ).toBe(1);
  });
});

describe('categorias', () => {
  it('as de sistema nascem sozinhas na primeira listagem', () => {
    const cats = listCategories(empresa);
    expect(cats.length).toBeGreaterThan(0);
    expect(cats.some((c) => c.system_code === 'venda')).toBe(true);
  });

  it('listar duas vezes não duplica', () => {
    const primeira = listCategories(empresa).length;
    expect(listCategories(empresa)).toHaveLength(primeira);
  });

  it('receita e despesa não se misturam na escolha', () => {
    const receitas = listCategories(empresa, { direction: 'in' });
    expect(receitas.every((c) => c.direction === 'in')).toBe(true);
  });

  /** O código amarra a classificação automática; o nome é do lojista. */
  it('renomear a categoria de sistema não desliga a classificação', () => {
    const id = systemCategoryId(empresa, 'venda')!;
    updateCategory(empresa, id, { name: 'Vendas balcão' });
    expect(systemCategoryId(empresa, 'venda')).toBe(id);
  });

  it('categoria de sistema não pode ser desativada', () => {
    const id = systemCategoryId(empresa, 'venda')!;
    expect(() => updateCategory(empresa, id, { active: false })).toThrow(/automáticos/i);
  });

  /** Plano de contas profundo é o que faz o lojista desistir de classificar. */
  it('a árvore tem dois níveis, e o terceiro é recusado', () => {
    const pai = createCategory(empresa, { direction: 'out', name: 'Ocupação' });
    const filho = createCategory(empresa, {
      direction: 'out',
      name: 'Aluguel',
      parentId: pai.id,
    });
    expect(() =>
      createCategory(empresa, { direction: 'out', name: 'IPTU', parentId: filho.id }),
    ).toThrow(/dois níveis/i);
  });

  it('subcategoria de receita não entra em categoria de despesa', () => {
    const pai = createCategory(empresa, { direction: 'out', name: 'Ocupação' });
    expect(() =>
      createCategory(empresa, { direction: 'in', name: 'Sublocação', parentId: pai.id }),
    ).toThrow(/despesa/i);
  });

  it('nome repetido na mesma direção é recusado', () => {
    createCategory(empresa, { direction: 'out', name: 'Ocupação' });
    expect(() => createCategory(empresa, { direction: 'out', name: 'Ocupação' })).toThrow(
      /já existe/i,
    );
  });
});

describe('centro de custo', () => {
  it('normaliza o código e recusa repetido', () => {
    const cc = createCostCenter(empresa, { code: 'loja', name: 'Loja centro' });
    expect(cc.code).toBe('LOJA');
    expect(() => createCostCenter(empresa, { code: 'LOJA', name: 'Outra' })).toThrow(/já existe/i);
  });

  /** Por empresa: um centro compartilhado somaria despesa de outra operação. */
  it('empresas diferentes podem usar o mesmo código', () => {
    createCostCenter(empresa, { code: 'LOJA', name: 'Loja centro' });
    const outra = upsertCompany({
      slug: 'pj-motors',
      legalName: 'PJ Motors Ltda',
      tradeName: 'PJ Motors',
      kind: 'store',
    });
    expect(() => createCostCenter(outra, { code: 'LOJA', name: 'Loja' })).not.toThrow();
    expect(listCostCenters(empresa)).toHaveLength(1);
  });
});

describe('contas', () => {
  it('a primeira conta vira padrão sozinha', () => {
    const c = createAccount(empresa, { name: 'Banco do Brasil' });
    expect(c.is_default).toBe(1);
  });

  it('marcar outra como padrão tira o padrão da primeira', () => {
    const primeira = createAccount(empresa, { name: 'Banco do Brasil' });
    const segunda = createAccount(empresa, { name: 'Caixinha', kind: 'caixinha' });
    updateAccount(empresa, segunda.id, { isDefault: true });

    const contas = listAccounts(empresa);
    expect(contas.find((c) => c.id === segunda.id)?.is_default).toBe(1);
    expect(contas.find((c) => c.id === primeira.id)?.is_default).toBe(0);
  });

  it('a conta padrão não é desativada enquanto houver outra ativa', () => {
    const padrao = createAccount(empresa, { name: 'Banco do Brasil' });
    createAccount(empresa, { name: 'Caixinha', kind: 'caixinha' });
    expect(() => updateAccount(empresa, padrao.id, { active: false })).toThrow(/padrão/i);
  });

  /**
   * Sendo a última, desligar é legítimo: o sistema funciona com zero contas.
   * Sem esta ressalva, a primeira conta cadastrada por engano ficaria presa
   * para sempre como padrão da empresa.
   */
  it('a última conta pode ser desativada, mesmo sendo a padrão', () => {
    const unica = createAccount(empresa, { name: 'Banco do Brasil' });
    expect(() => updateAccount(empresa, unica.id, { active: false })).not.toThrow();
    expect(listAccounts(empresa)).toHaveLength(0);
  });

  it('tipo inválido é recusado', () => {
    expect(() =>
      createAccount(empresa, { name: 'X', kind: 'cofre' as never }),
    ).toThrow(/inválido/i);
  });

  /**
   * O saldo é DERIVADO, como o saldo por local da rodada 6: em cache ele teria
   * de ser mantido por todo caminho que dá baixa, e divergiria no primeiro que
   * esquecesse.
   */
  it('o saldo é o de partida mais o que já foi quitado', () => {
    const conta = createAccount(empresa, {
      name: 'Banco do Brasil',
      openingBalanceCents: 100_000,
    });
    expect(accountBalanceCents(empresa, conta.id)).toBe(100_000);

    inserirCru({
      origin_id: 'r1',
      direction: 'in',
      amount_cents: 50_000,
      settled_cents: 50_000,
      status: 'settled',
      account_id: conta.id,
    });
    inserirCru({
      origin_id: 'p1',
      direction: 'out',
      amount_cents: 20_000,
      settled_cents: 20_000,
      status: 'settled',
      account_id: conta.id,
    });

    expect(accountBalanceCents(empresa, conta.id)).toBe(130_000);
  });

  /** Dinheiro prometido não é dinheiro na conta. */
  it('o que está em aberto não entra no saldo', () => {
    const conta = createAccount(empresa, { name: 'Banco', openingBalanceCents: 0 });
    inserirCru({
      origin_id: 'r1',
      direction: 'in',
      amount_cents: 90_000,
      settled_cents: 0,
      status: 'open',
      account_id: conta.id,
    });
    expect(accountBalanceCents(empresa, conta.id)).toBe(0);
  });

  it('lançamento cancelado não conta', () => {
    const conta = createAccount(empresa, { name: 'Banco', openingBalanceCents: 0 });
    // Cancelado é o CARIMBO (GAP-PRD-172): todo escritor grava `cancelled_at`
    // junto do status, e a migração 56 carimbou os antigos. O saldo passou a
    // ler o carimbo, como os outros sete leitores.
    inserirCru({
      origin_id: 'r1',
      direction: 'in',
      amount_cents: 90_000,
      settled_cents: 90_000,
      status: 'cancelled',
      cancelled_at: new Date().toISOString(),
      account_id: conta.id,
    });
    expect(accountBalanceCents(empresa, conta.id)).toBe(0);
  });
});

describe('lançamento manual', () => {
  it('cai na conta padrão quando nenhuma é informada', () => {
    const conta = createAccount(empresa, { name: 'Banco do Brasil' });
    const e = createEntry({
      companyId: empresa,
      direction: 'out',
      description: 'Conta de luz',
      amountCents: 25_000,
      dueDate: '2026-09-10',
    });
    const linha = getConnection()
      .prepare('SELECT account_id, competence_date FROM core_finance_entries WHERE id = ?')
      .get(e.id) as { account_id: string | null; competence_date: string };
    expect(linha.account_id).toBe(conta.id);
    // Sem competência informada, vale o vencimento.
    expect(linha.competence_date).toBe('2026-09-10');
  });

  it('sem conta cadastrada, o lançamento ainda acontece', () => {
    expect(() =>
      createEntry({
        companyId: empresa,
        direction: 'out',
        description: 'Conta de luz',
        amountCents: 25_000,
      }),
    ).not.toThrow();
  });

  it('aceita categoria e centro de custo', () => {
    const cat = createCategory(empresa, { direction: 'out', name: 'Ocupação' });
    const cc = createCostCenter(empresa, { code: 'LOJA', name: 'Loja centro' });
    const e = createEntry({
      companyId: empresa,
      direction: 'out',
      description: 'Aluguel',
      amountCents: 300_000,
      categoryId: cat.id,
      costCenterId: cc.id,
    });
    const linha = getConnection()
      .prepare('SELECT category_id, cost_center_id FROM core_finance_entries WHERE id = ?')
      .get(e.id) as { category_id: string; cost_center_id: string };
    expect(linha.category_id).toBe(cat.id);
    expect(linha.cost_center_id).toBe(cc.id);
  });
});
