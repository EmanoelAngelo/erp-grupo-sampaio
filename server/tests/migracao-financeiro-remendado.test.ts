/**
 * O conserto do banco meio migrado.
 *
 * ## O que aconteceu num banco real
 *
 * O passo que reconstrói `core_finance_entries` para pôr a PARCELA na chave
 * única foi MARCADO como aplicado sem fazer o trabalho: a reconstrução falhou
 * com "database is locked" durante um restart, o processo morreu, e o marcador
 * ficou gravado. Na subida seguinte o passo foi pulado, e o
 * `reconcileCoreSchema` acrescentou as colunas que faltavam via ALTER.
 *
 * Resultado: COLUNAS novas com CONSTRAINT antiga, de três colunas. O sintoma
 * só apareceu na primeira venda parcelada — a segunda parcela colidia com a
 * primeira e a venda inteira falhava com 500.
 *
 * Pior: a guarda de "já reconstruída" procurava o NOME DA COLUNA, que o
 * reconcile cria sozinho. Ela dava falso positivo justamente no banco que
 * precisava do conserto.
 *
 * Este arquivo monta esse estado à mão e cobra que a reconstrução aconteça,
 * preserve os dados e preserve a classificação que já existia.
 */
import { beforeEach, describe, expect, it } from 'vitest';

process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_DATABASE_PATH = ':memory:';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

const { ensureCoreSchema } = await import('../src/db/schema.js');
const { resetDbForTests } = await import('../src/db/database.js');
const { getConnection } = await import('../src/db/sqlite.js');
const { upsertCompany } = await import('../src/services/auth/IdentityService.js');
const { rebuildFinanceEntriesForTests } = await import('../src/db/core-migrations.js');
const { systemCategoryId } = await import('../src/services/core/FinanceSetupService.js');

let empresa: string;

/** Monta o estado defeituoso: colunas novas, chave antiga de três colunas. */
function montarBancoRemendado(): void {
  const db = getConnection();
  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec('DROP TABLE IF EXISTS core_finance_entries;');
  db.exec(`
    CREATE TABLE core_finance_entries (
      id             TEXT PRIMARY KEY,
      company_id     TEXT NOT NULL,
      direction      TEXT NOT NULL,
      amount_cents   INTEGER NOT NULL,
      status         TEXT NOT NULL DEFAULT 'open',
      due_date       TEXT,
      settled_at     TEXT,
      settled_cents  INTEGER NOT NULL DEFAULT 0,
      customer_id    TEXT,
      supplier_id    TEXT,
      description    TEXT NOT NULL,
      origin_type    TEXT NOT NULL,
      origin_id      TEXT NOT NULL,
      category_id    TEXT,
      cost_center_id TEXT,
      account_id     TEXT,
      installment_number INTEGER NOT NULL DEFAULT 1,
      installment_total  INTEGER NOT NULL DEFAULT 1,
      payment_method TEXT,
      document_number TEXT,
      interest_cents INTEGER NOT NULL DEFAULT 0,
      fine_cents     INTEGER NOT NULL DEFAULT 0,
      discount_cents INTEGER NOT NULL DEFAULT 0,
      competence_date TEXT,
      note           TEXT,
      created_at     TEXT NOT NULL,
      UNIQUE (origin_type, origin_id, direction)
    );
  `);
  db.exec('PRAGMA foreign_keys = ON;');
}

function ddlAtual(): string {
  return (
    getConnection()
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'core_finance_entries'",
      )
      .get() as { sql: string }
  ).sql;
}

beforeEach(() => {
  resetDbForTests();
  ensureCoreSchema();
  empresa = upsertCompany({
    slug: 'preco-justo',
    legalName: 'Preço Justo Ltda',
    tradeName: 'Preço Justo',
    kind: 'store',
  });
});

describe('a guarda distingue reconstruída de remendada', () => {
  it('num banco já correto, a reconstrução não faz nada', () => {
    const antes = ddlAtual();
    rebuildFinanceEntriesForTests();
    expect(ddlAtual()).toBe(antes);
  });

  /**
   * A guarda antiga procurava a palavra `installment_number` e dava falso
   * positivo aqui — o banco tem a coluna e não tem a chave.
   */
  it('num banco remendado, a reconstrução acontece', () => {
    montarBancoRemendado();
    expect(ddlAtual()).toContain('installment_number');
    expect(ddlAtual()).not.toMatch(/direction\s*,\s*installment_number/);

    rebuildFinanceEntriesForTests();

    expect(ddlAtual()).toMatch(
      /UNIQUE\s*\(\s*origin_type\s*,\s*origin_id\s*,\s*direction\s*,\s*installment_number/i,
    );
  });

  it('depois do conserto, duas parcelas do mesmo fato convivem', () => {
    montarBancoRemendado();
    rebuildFinanceEntriesForTests();

    const db = getConnection();
    const inserir = (n: number) =>
      db
        .prepare(
          `INSERT INTO core_finance_entries
             (id, company_id, direction, amount_cents, status, description,
              origin_type, origin_id, installment_number, installment_total, created_at)
           VALUES (?, ?, 'in', 1000, 'open', 'Venda', 'sale', 'v1', ?, 2, ?)`,
        )
        .run(`e${n}`, empresa, n, new Date().toISOString());

    expect(() => inserir(1)).not.toThrow();
    expect(() => inserir(2)).not.toThrow();
  });
});

describe('a reconstrução não perde dado', () => {
  it('preserva os lançamentos e a classificação que já existia', () => {
    // Categoria REAL: a reconstrução acrescenta a chave estrangeira, e uma
    // categoria inventada seria (corretamente) recusada como órfã.
    const catVenda = systemCategoryId(empresa, 'venda')!;
    montarBancoRemendado();
    const db = getConnection();
    db.prepare(
      `INSERT INTO core_finance_entries
         (id, company_id, direction, amount_cents, status, description, origin_type,
          origin_id, category_id, competence_date, payment_method, created_at)
       VALUES ('e1', ?, 'in', 5000, 'settled', 'Venda #1', 'sale', 'v1',
               ?, '2026-03-15', 'credito', '2026-03-15T10:00:00.000Z')`,
    ).run(empresa, catVenda);

    rebuildFinanceEntriesForTests();

    const linha = db.prepare('SELECT * FROM core_finance_entries WHERE id = ?').get('e1') as {
      amount_cents: number;
      category_id: string | null;
      competence_date: string | null;
      payment_method: string | null;
    };
    expect(linha.amount_cents).toBe(5000);
    // A classificação NÃO pode se perder: o DRE do mês passado mudaria sem
    // ninguém entender por quê.
    expect(linha.category_id).toBe(systemCategoryId(empresa, 'venda'));
    expect(linha.competence_date).toBe('2026-03-15');
    expect(linha.payment_method).toBe('credito');
  });

  it('a contagem antes e depois é a mesma', () => {
    montarBancoRemendado();
    const db = getConnection();
    for (let i = 1; i <= 5; i += 1) {
      db.prepare(
        `INSERT INTO core_finance_entries
           (id, company_id, direction, amount_cents, status, description, origin_type,
            origin_id, created_at)
         VALUES (?, ?, 'in', 1000, 'open', 'Venda', 'sale', ?, ?)`,
      ).run(`e${i}`, empresa, `v${i}`, new Date().toISOString());
    }

    rebuildFinanceEntriesForTests();

    const n = db.prepare('SELECT COUNT(*) AS n FROM core_finance_entries').get() as { n: number };
    expect(n.n).toBe(5);
  });
});
