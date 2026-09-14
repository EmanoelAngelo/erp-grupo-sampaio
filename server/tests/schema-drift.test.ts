/**
 * Um banco antigo, depois de migrado, tem que ficar IDÊNTICO a um banco novo.
 *
 * Este teste existe por causa de um erro real: o passo v4 foi editado depois
 * de já ter rodado, e todo banco marcado como v4 saiu pelo retorno antecipado
 * de `migrateCoreSchema` sem nunca receber a coluna `change_cents`. Nada
 * falhou — o schema simplesmente ficou diferente, e a venda quebrou em tempo
 * de execução com "Erro interno".
 *
 * A comparação abaixo pega qualquer divergência desse tipo: coluna que só
 * existe no schema novo, tabela que só a migração cria, tipo trocado.
 */
import { describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

const { closeConnection, getConnection } = await import('../src/db/sqlite.js');
const { ensureCoreSchema, resetCoreSchemaCache } = await import('../src/db/schema.js');
const { CORE_TARGET_VERSION, migrateCoreSchema } = await import(
  '../src/db/core-migrations.js'
);
const { criarColecoesDeDocumentos } = await import('../src/db/database.js');
const { conferirEsquema, repararEsquema, resumoDasDivergencias } = await import('../src/db/derivaDoEsquema.js');

interface Column {
  name: string;
  type: string;
  notnull: number;
  /**
   * O DEFAULT (GAP-PRD-140). Sem ele, `status DEFAULT 'recebido'` e
   * `status DEFAULT 'em_aberto'` eram a mesma coluna para este arquivo — e o
   * banco da loja tinha o primeiro.
   */
  dflt_value: string | null;
}

/**
 * A forma de uma tabela: colunas E as regras que o SQLite não devolve em
 * `PRAGMA table_info`.
 *
 * ANTES ESTE ARQUIVO SÓ COMPARAVA `{name, type, notnull}`. Isso é cego para
 * exatamente a dimensão onde o defeito mais caro do projeto morou: a chave
 * UNIQUE de `core_finance_entries`, que precisava crescer para caber a parcela
 * como linha-irmã. Um banco migrado e um banco novo podiam ter as MESMAS
 * colunas e chaves diferentes, e este teste dava verde nos dois.
 *
 * O rebuild que corrigia aquilo, aliás, nunca rodou em banco nenhum por estar
 * dentro da transação geral — e nada aqui notou.
 */
interface TableShape {
  columns: Column[];
  /** Chaves únicas, por colunas ou por expressão. */
  uniques: string[];
  /** Regras CHECK, como texto normalizado. */
  checks: string[];
  /**
   * Índices NÃO únicos, pelo texto normalizado (GAP-PRD-140). O banco da loja
   * tinha dois índices de passo marcado ausentes e um de mesmo nome com outra
   * definição; nada aqui notava, porque só o índice único entrava.
   */
  indices: string[];
}

/** Tira comentários e achata espaço, para comparar semântica e não digitação. */
function normalizar(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * As regras CHECK declaradas na DDL da tabela.
 *
 * Não dá para pegar por regex simples: `CHECK (quantity > 0)` e
 * `CHECK (status IN ('a','b'))` têm parênteses aninhados. O balanceamento
 * abaixo lê até o parêntese que fecha o de abertura.
 */
function checksDe(sqlDaTabela: string): string[] {
  const texto = normalizar(sqlDaTabela);
  const achados: string[] = [];

  for (const m of texto.matchAll(/\bCHECK\s*\(/gi)) {
    let profundidade = 1;
    let i = m.index! + m[0].length;
    const inicio = i;
    while (i < texto.length && profundidade > 0) {
      if (texto[i] === '(') profundidade += 1;
      else if (texto[i] === ')') profundidade -= 1;
      i += 1;
    }
    achados.push(texto.slice(inicio, i - 1).trim());
  }
  return achados.sort();
}

/** Tabelas do núcleo e sua forma completa, comparável. */
function snapshot(db: DatabaseSync): Record<string, TableShape> {
  const tables = db
    .prepare(
      `SELECT name, sql FROM sqlite_master
        WHERE type = 'table' AND name LIKE 'core_%'
        ORDER BY name`,
    )
    .all() as unknown as { name: string; sql: string | null }[];

  const out: Record<string, TableShape> = {};
  for (const { name, sql } of tables) {
    const cols = db.prepare(`PRAGMA table_info(${name})`).all() as unknown as Column[];

    const uniques: string[] = [];
    const comuns: string[] = [];
    const indices = db.prepare(`PRAGMA index_list(${name})`).all() as unknown as {
      name: string;
      unique: number;
    }[];
    for (const idx of indices) {
      if (!idx.unique) {
        const sqlDoIndice = db
          .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
          .get(idx.name) as { sql?: string | null } | undefined;
        if (sqlDoIndice?.sql) comuns.push(normalizar(sqlDoIndice.sql));
        continue;
      }

      const criado = db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get(idx.name) as { sql?: string | null } | undefined;

      if (criado?.sql) {
        // Índice explícito: o texto carrega expressão e `WHERE` parcial, que
        // são parte da regra — o índice de categoria usa COALESCE justamente
        // porque NULL não colide em UNIQUE no SQLite.
        uniques.push(normalizar(criado.sql));
      } else {
        // Auto-índice de um UNIQUE inline. O nome é posicional
        // (`sqlite_autoindex_..._1`) e mudaria à toa se a DDL reordenasse as
        // constraints; as COLUNAS é que são a regra.
        const cols2 = db.prepare(`PRAGMA index_info(${idx.name})`).all() as unknown as {
          name: string | null;
        }[];
        uniques.push(`UNIQUE (${cols2.map((c) => c.name ?? '?').join(', ')})`);
      }
    }

    out[name] = {
      columns: cols
        .map((c) => ({ name: c.name, type: c.type, notnull: c.notnull, dflt_value: c.dflt_value }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      uniques: uniques.sort(),
      checks: checksDe(sql ?? ''),
      indices: comuns.sort(),
    };
  }
  return out;
}

/**
 * Roda schema + migrations num arquivo isolado.
 *
 * Cada caso usa um banco próprio em pasta temporária: nenhum teste toca a
 * base real do usuário.
 */
function buildDatabase(seed: (db: DatabaseSync) => void): Record<string, TableShape> {
  const dir = mkdtempSync(join(tmpdir(), 'gs-drift-'));
  const path = join(dir, 'core.db');

  // `getConnection` reabre sozinho quando o caminho muda, e o cache do schema
  // precisa ser zerado para o CREATE rodar no arquivo novo.
  closeConnection();
  process.env.DEVORA_DATABASE_PATH = path;
  resetCoreSchemaCache();

  ensureCoreSchema();
  seed(getConnection());
  migrateCoreSchema();

  const result = snapshot(getConnection());

  closeConnection();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // No Windows o arquivo pode continuar preso; a pasta é temporária.
  }
  return result;
}

/** DDL da tabela no banco atualmente aberto. */
function ddlOf(table: string): string {
  const row = getConnection()
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { sql?: string } | undefined;
  return row?.sql ?? '';
}

/**
 * Constrói um banco com a PRIMEIRA versão de core_quotes (chave sem o tipo),
 * põe dois documentos dentro e migra. Serve para provar que a reconstrução
 * preserva o conteúdo.
 */
function rebuiltQuotes(): { ddl: string; rows: number } {
  const dir = mkdtempSync(join(tmpdir(), 'gs-quotes-'));
  const path = join(dir, 'core.db');

  closeConnection();
  process.env.DEVORA_DATABASE_PATH = path;
  resetCoreSchemaCache();
  ensureCoreSchema();

  const db = getConnection();
  // Reproduz a tabela como ela nasceu, com a chave única errada.
  db.exec(`
    DROP TABLE core_quote_items;
    DROP TABLE core_quotes;
    CREATE TABLE core_quotes (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      number INTEGER NOT NULL,
      kind TEXT NOT NULL DEFAULT 'orcamento',
      status TEXT NOT NULL DEFAULT 'aberto',
      customer_id TEXT, seller_id TEXT, valid_until TEXT,
      discount_cents INTEGER NOT NULL DEFAULT 0,
      total_cents INTEGER NOT NULL DEFAULT 0,
      note TEXT, converted_sale_id TEXT, converted_at TEXT, created_by TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE (company_id, number)
    );
  `);
  const now = new Date().toISOString();
  // A tabela reconstruída referencia core_companies, então a empresa precisa
  // existir — senão o teste falharia por dado inventado, não pela migração.
  db.prepare(
    `INSERT INTO core_companies (id, slug, legal_name, trade_name, active, created_at, updated_at)
     VALUES ('empresa-1', 'empresa-1', 'Empresa Um Ltda', 'Empresa Um', 1, ?, ?)`,
  ).run(now, now);

  const insert = db.prepare(
    `INSERT INTO core_quotes (id, company_id, number, kind, status, created_at, updated_at)
     VALUES (?, 'empresa-1', ?, ?, 'aberto', ?, ?)`,
  );
  insert.run('q1', 1, 'orcamento', now, now);
  insert.run('q2', 2, 'pre_venda', now, now);

  db.exec("DELETE FROM core_meta WHERE key LIKE 'core_migration_step_%';");
  migrateCoreSchema();

  const result = {
    ddl: ddlOf('core_quotes'),
    rows: (getConnection().prepare('SELECT COUNT(*) AS n FROM core_quotes').get() as { n: number })
      .n,
  };

  closeConnection();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Pasta temporária; no Windows o arquivo pode continuar preso.
  }
  return result;
}

function setVersion(db: DatabaseSync, version: number): void {
  db.exec('CREATE TABLE IF NOT EXISTS core_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
  db.prepare(
    `INSERT INTO core_meta (key, value) VALUES ('core_schema_version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(String(version));
}

/**
 * Reproduz um banco antigo de verdade.
 *
 * Só gravar o número da versão não serve: `ensureCoreSchema` já criou as
 * tabelas no formato ATUAL, então o banco passaria no teste sem nunca ter
 * exercitado a migração. É preciso desfazer as colunas e tabelas que aquela
 * versão ainda não tinha.
 */
function legacy(version: number) {
  return (db: DatabaseSync) => {
    if (version < 5) {
      // A v4 gravada em campo saiu sem a coluna de troco.
      db.exec('ALTER TABLE core_sales DROP COLUMN change_cents;');
    }
    if (version < 4) {
      db.exec('DROP TABLE IF EXISTS core_authorizations;');
    }
    if (version < 3) {
      db.exec('ALTER TABLE core_products DROP COLUMN publish_online;');
      db.exec('ALTER TABLE core_products DROP COLUMN kind;');
      db.exec('ALTER TABLE core_users DROP COLUMN customer_id;');
    }
    setVersion(db, version);
  };
}

describe('migrations não deixam o schema divergir', () => {
  it('banco parado na v3 chega ao mesmo schema de um banco novo', () => {
    const migrado = buildDatabase(legacy(3));
    const novo = buildDatabase(() => {});
    expect(migrado).toEqual(novo);
  });

  it('banco parado na v4 chega ao mesmo schema de um banco novo', () => {
    // O caso que quebrou de verdade: v4 gravada sem `change_cents`.
    const migrado = buildDatabase(legacy(4));
    const novo = buildDatabase(() => {});
    expect(migrado).toEqual(novo);
  });

  it('core_sales tem change_cents mesmo vindo da v4', () => {
    const migrado = buildDatabase(legacy(4));
    expect(migrado.core_sales.columns.map((c) => c.name)).toContain('change_cents');
  });

  it('banco marcado como atualizado, mas com coluna faltando, é reparado', () => {
    // Foi exatamente isto que aconteceu na base de desenvolvimento: a versão
    // alvo ficou gravada sem que o passo tivesse efeito. Nenhum passo de
    // migração roda neste caso — quem conserta é a reconciliação.
    const reparado = buildDatabase((db) => {
      db.exec('ALTER TABLE core_sales DROP COLUMN change_cents;');
      setVersion(db, 999);
    });
    expect(reparado.core_sales.columns.map((c) => c.name)).toContain('change_cents');
  });

  it('passo novo roda mesmo num banco marcado com versão futura', () => {
    // O erro que aconteceu duas vezes: a versão alvo foi gravada antes de o
    // passo existir (o watch recarrega a cada gravação do arquivo), e o passo
    // nunca mais rodou. Com marca por passo, um passo sem marca roda de
    // qualquer forma — o número global não manda mais.
    const resultado = buildDatabase((db) => {
      db.exec('ALTER TABLE core_sales DROP COLUMN change_cents;');
      db.exec("DELETE FROM core_meta WHERE key LIKE 'core_migration_step_%';");
      setVersion(db, 99);
    });
    expect(resultado.core_sales.columns.map((c) => c.name)).toContain('change_cents');
  });

  it('banco novo já nasce com numeração por tipo', () => {
    // Sem isto, o orçamento nº 1 colidiria com a pré-venda nº 1.
    const dir = mkdtempSync(join(tmpdir(), 'gs-novo-'));
    closeConnection();
    process.env.DEVORA_DATABASE_PATH = join(dir, 'core.db');
    resetCoreSchemaCache();
    ensureCoreSchema();

    expect(ddlOf('core_quotes')).toContain('company_id, kind, number');

    closeConnection();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Pasta temporária.
    }
  });

  it('tabela antiga com a chave errada é reconstruída sem perder documento', () => {
    const preservados = rebuiltQuotes();
    expect(preservados.ddl).toContain('company_id, kind, number');
    expect(preservados.rows).toBe(2);
  });

  it('a DDL canônica não cria índice sobre coluna que só a migração adiciona', () => {
    // Foi o defeito real: `ensureCoreSchema` roda ANTES das migrations, então
    // um CREATE INDEX sobre coluna nova derruba a subida de qualquer banco
    // existente com "no such column". O índice pertence ao passo da migração.
    const dir = mkdtempSync(join(tmpdir(), 'gs-idx-'));
    closeConnection();
    process.env.DEVORA_DATABASE_PATH = join(dir, 'core.db');
    resetCoreSchemaCache();
    ensureCoreSchema();

    // Simula o banco antigo: sem a coluna e sem o índice que depende dela.
    getConnection().exec(`
      DROP INDEX IF EXISTS ix_stock_movements_kind;
      ALTER TABLE core_stock_movements DROP COLUMN kind;
      DELETE FROM core_meta WHERE key LIKE 'core_migration_step_%';
    `);
    closeConnection();
    resetCoreSchemaCache();

    // A subida real faz exatamente isto, nesta ordem.
    expect(() => {
      ensureCoreSchema();
      migrateCoreSchema();
    }).not.toThrow();

    const indices = getConnection()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?")
      .all('core_stock_movements') as unknown as { name: string }[];
    expect(indices.map((i) => i.name)).toContain('ix_stock_movements_kind');

    closeConnection();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Pasta temporária.
    }
  });

  it('banco antigo ganha saldo anterior e semântica sem perder movimento', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gs-ledger-'));
    closeConnection();
    process.env.DEVORA_DATABASE_PATH = join(dir, 'core.db');
    resetCoreSchemaCache();
    ensureCoreSchema();

    const db = getConnection();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO core_companies (id, slug, legal_name, trade_name, active, created_at, updated_at)
       VALUES ('e1', 'e1', 'E1 Ltda', 'E1', 1, ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO core_products
         (id, company_id, internal_code, name, unit, cost_cents, price_cents, min_stock,
          active, created_at, updated_at)
       VALUES ('p1', 'e1', 'C1', 'Produto', 'UN', 0, 100, 0, 1, ?, ?)`,
    ).run(now, now);

    // Movimento no formato ANTIGO: sem saldo anterior, sem semântica.
    db.exec(`
      UPDATE core_stock_movements SET kind = NULL, quantity_before = NULL;
      DELETE FROM core_meta WHERE key LIKE 'core_migration_step_%';
    `);
    db.prepare(
      `INSERT INTO core_stock_movements
         (id, company_id, product_id, movement_type, quantity, reference_type,
          reference_id, balance_after, created_at)
       VALUES ('m1', 'e1', 'p1', 'in', 5, 'nfe_entrada', 'n1', 15, ?)`,
    ).run(now);
    db.exec("UPDATE core_stock_movements SET kind = NULL, quantity_before = NULL WHERE id = 'm1';");

    migrateCoreSchema();

    const row = getConnection()
      .prepare('SELECT kind, quantity_before, balance_after FROM core_stock_movements WHERE id = ?')
      .get('m1') as { kind: string; quantity_before: number; balance_after: number };

    // Reconstruído: 15 - 5 = 10, e a referência revela que foi entrada de XML.
    expect(row.quantity_before).toBe(10);
    expect(row.kind).toBe('XML_RECEIPT');
    expect(row.balance_after).toBe(15);

    closeConnection();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Pasta temporária.
    }
  });

  it('a reconciliação não apaga coluna que só existe no banco real', () => {
    // Coluna extra pode ser de uma versão mais nova rodando em paralelo.
    // Remover em silêncio destruiria dado.
    const resultado = buildDatabase((db) => {
      db.exec('ALTER TABLE core_sales ADD COLUMN coluna_de_terceiro TEXT;');
      setVersion(db, 999);
    });
    expect(resultado.core_sales.columns.map((c) => c.name)).toContain('coluna_de_terceiro');
  });
});

/**
 * A fila de saída como ela nasceu no passo 23: `entity_type` e `entity_id`
 * NOT NULL, sem nada do envelope.
 *
 * Existe porque o passo 24 só ADICIONA colunas — o SQLite não afrouxa
 * constraint por ALTER. Num banco que viveu a v23, as colunas velhas
 * continuavam obrigatórias e o INSERT novo não as preenche: **toda venda
 * falharia** com "NOT NULL constraint failed: core_outbox.entity_type".
 *
 * A suíte não pegou porque banco de teste nasce do DDL canônico, já sem elas.
 * O defeito só apareceu ao aplicar a migração no banco operacional real — que
 * é exatamente o cenário que este arquivo existe para cobrir.
 */
function outboxV23(): { colunas: string[]; inseriu: boolean; erro: string | null } {
  const dir = mkdtempSync(join(tmpdir(), 'gs-outbox-v23-'));
  const path = join(dir, 'core.db');

  closeConnection();
  process.env.DEVORA_DATABASE_PATH = path;
  resetCoreSchemaCache();
  ensureCoreSchema();

  const db = getConnection();
  db.exec(`
    DROP TABLE IF EXISTS core_outbox;
    CREATE TABLE core_outbox (
      seq             INTEGER PRIMARY KEY AUTOINCREMENT,
      id              TEXT NOT NULL UNIQUE,
      node_id         TEXT NOT NULL,
      company_id      TEXT NOT NULL,
      entity_type     TEXT NOT NULL,
      entity_id       TEXT NOT NULL,
      operation       TEXT NOT NULL,
      payload         TEXT NOT NULL,
      occurred_at     TEXT NOT NULL,
      attempts        INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      last_error      TEXT,
      sent_at         TEXT,
      created_at      TEXT NOT NULL
    );
  `);
  // Um evento gravado no formato velho: a reconstrução não pode descartá-lo.
  db.prepare(
    `INSERT INTO core_outbox (id, node_id, company_id, entity_type, entity_id,
                              operation, payload, occurred_at, created_at)
     VALUES ('ev-velho', 'no-1', 'emp-1', 'core_sales', 'venda-1', 'insert', '{}', '2026-01-01', '2026-01-01')`,
  ).run();

  // Marca o banco como parado na v23, com os passos anteriores aplicados.
  db.prepare("INSERT OR REPLACE INTO core_meta (key, value) VALUES ('core_schema_version', '23')").run();
  for (let passo = 8; passo <= 23; passo += 1) {
    db.prepare(
      `INSERT OR REPLACE INTO core_meta (key, value) VALUES ('core_migration_step_${passo}', 'applied')`,
    ).run();
  }

  resetCoreSchemaCache();
  migrateCoreSchema();

  const colunas = (
    getConnection().prepare('PRAGMA table_info(core_outbox)').all() as unknown as Column[]
  ).map((c) => c.name);

  let inseriu = false;
  let erro: string | null = null;
  try {
    getConnection()
      .prepare(
        `INSERT INTO core_outbox
           (id, node_id, event_type, aggregate_type, aggregate_id, company_id,
            operational_unit_id, operation, schema_version, payload, occurred_at,
            status, created_at)
         VALUES ('ev-novo', 'no-1', 'sale.registered', 'sale', 'venda-2', 'emp-1',
                 NULL, 'insert', 1, '{}', '2026-01-02', 'pending', '2026-01-02')`,
      )
      .run();
    inseriu = true;
  } catch (err) {
    erro = (err as Error).message;
  }

  const preservados = Number(
    (getConnection().prepare("SELECT COUNT(*) c FROM core_outbox WHERE id = 'ev-velho'").get() as {
      c: number;
    }).c,
  );

  closeConnection();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows às vezes segura o arquivo; o diretório é temporário.
  }

  return { colunas, inseriu, erro: erro ?? (preservados === 1 ? null : 'evento antigo perdido') };
}

describe('fila de saída em banco que viveu a v23', () => {
  it('o INSERT do formato novo FUNCIONA — senão toda venda falharia', () => {
    const r = outboxV23();
    expect(r.erro).toBeNull();
    expect(r.inseriu).toBe(true);
  });

  it('as colunas obrigatórias antigas somem da tabela', () => {
    const r = outboxV23();
    expect(r.colunas).not.toContain('entity_type');
    expect(r.colunas).not.toContain('entity_id');
    expect(r.colunas).toContain('aggregate_type');
    expect(r.colunas).toContain('status');
  });
});

/**
 * O alvo e o último passo têm que ser o MESMO número.
 *
 * `haPassoPendente` varre de 2 até `CORE_TARGET_VERSION` para decidir se tira
 * snapshot antes de migrar. Um alvo maior que o último passo declarado cria um
 * passo fantasma que ninguém marca — e aí a resposta é "sim, há passo
 * pendente" para sempre, em todo restart, e cada restart copia o banco inteiro
 * com VACUUM INTO.
 *
 * Não é hipótese: com o alvo em 39 e o último passo em 38, a pasta de backups
 * tinha dez cópias, três delas no mesmo minuto, todas chamadas
 * `pre-migracao-v39`. O `tsx watch` reinicia a cada gravação de arquivo.
 */
describe('nenhum passo de migração fica pendente para sempre', () => {
  it('todo passo até o alvo fica marcado depois de migrar', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gs-passos-'));
    const path = join(dir, 'core.db');

    closeConnection();
    process.env.DEVORA_DATABASE_PATH = path;
    resetCoreSchemaCache();
    ensureCoreSchema();
    migrateCoreSchema();

    const db = getConnection();
    const pendentes: number[] = [];
    for (let passo = 2; passo <= CORE_TARGET_VERSION; passo += 1) {
      const row = db
        .prepare('SELECT value FROM core_meta WHERE key = ?')
        .get(`core_migration_step_${passo}`) as { value?: string } | undefined;
      if (row?.value !== 'applied') pendentes.push(passo);
    }

    closeConnection();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Pasta temporária.
    }

    expect(pendentes).toEqual([]);
  });

  /**
   * E O CONTRÁRIO: nenhum passo ACIMA do alvo.
   *
   * O caso acima varre de 2 até o alvo e prova que nada ficou pendente. Ele
   * é cego para a outra ponta — um `stepApplied(73)` escrito com o alvo em
   * 72 —, e essa ponta custa caro:
   *
   *   - o passo RODA (ele está no corpo da função, não dentro da varredura),
   *     então a estrutura do banco muda de verdade;
   *   - `haPassoPendente` não o enxerga, então o SNAPSHOT ANTES DA
   *     MIGRAÇÃO não é tirado;
   *   - e `setVersion(CORE_TARGET_VERSION)` grava o número velho, então o
   *     banco fica dizendo que está numa versão que já não descreve a forma
   *     dele.
   *
   * Resultado: a alteração estrutural entra sem cópia de segurança e sem
   * rastro na versão — exatamente o que o snapshot existe para impedir. Isto
   * aconteceu neste projeto, com o passo 73 e o alvo em 72.
   *
   * A leitura é por texto e não por execução porque é a DECLARAÇÃO que está
   * errada: o passo existe no código-fonte e não existe para a varredura.
   */
  it('nenhum passo declarado acima do alvo — senão a migração roda sem snapshot', () => {
    const fonte = readFileSync(
      new URL('../src/db/core-migrations.ts', import.meta.url),
      'utf8',
    );
    const passos = [...fonte.matchAll(/stepApplied\((\d+)\)/g)].map((m) => Number(m[1]));
    expect(passos.length, 'nenhum stepApplied encontrado — a leitura quebrou')
      .toBeGreaterThan(20);

    const acimaDoAlvo = [...new Set(passos.filter((p) => p > CORE_TARGET_VERSION))].sort(
      (a, b) => a - b,
    );
    expect(
      acimaDoAlvo,
      `passo(s) ${acimaDoAlvo.join(", ")} rodam sem snapshot: CORE_TARGET_VERSION é `
        + `${CORE_TARGET_VERSION} e precisa ser o número do ÚLTIMO passo`,
    ).toEqual([]);

    // E o alvo não pode passar do último passo, que é o defeito espelhado
    // (dez cópias do banco a cada restart) já descrito acima.
    expect(Math.max(...passos)).toBe(CORE_TARGET_VERSION);
  });
});

/**
 * FALSIFICAÇÃO: a comparação enxerga mesmo UNIQUE e CHECK?
 *
 * Ampliar o `snapshot` só vale se a dimensão nova detectar diferença. Este caso
 * monta duas tabelas com AS MESMAS COLUNAS e chaves diferentes — precisamente o
 * cenário que passava despercebido, e precisamente o formato do defeito de
 * `core_finance_entries`, onde a chave precisou crescer para caber a parcela
 * como linha-irmã.
 *
 * Se este teste um dia ficar verde com as duas formas iguais, a ampliação
 * virou enfeite e o arquivo voltou a ser cego.
 */
describe('a comparação distingue chave e regra, não só coluna', () => {
  it('mesmas colunas com UNIQUE diferente NÃO são consideradas iguais', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gs-unique-'));
    closeConnection();
    process.env.DEVORA_DATABASE_PATH = join(dir, 'core.db');
    resetCoreSchemaCache();
    ensureCoreSchema();

    const db = getConnection();
    const antes = snapshot(db);

    // Mesmas colunas, chave única encolhida: some o `kind`, e o orçamento nº 1
    // volta a colidir com a pré-venda nº 1.
    db.exec(`
      DROP TABLE core_quote_items;
      DROP TABLE core_quotes;
      CREATE TABLE core_quotes (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL,
        number INTEGER NOT NULL,
        kind TEXT NOT NULL DEFAULT 'orcamento',
        status TEXT NOT NULL DEFAULT 'aberto',
        customer_id TEXT, seller_id TEXT, valid_until TEXT,
        discount_cents INTEGER NOT NULL DEFAULT 0,
        total_cents INTEGER NOT NULL DEFAULT 0,
        note TEXT, converted_sale_id TEXT, converted_at TEXT,
        -- As três da alçada do documento (v54). Estão aqui porque o teste
        -- precisa de MESMAS COLUNAS com chave diferente: a única diferença
        -- entre as duas formas tem que ser a UNIQUE, senão o caso deixa de
        -- provar o que promete.
        concession_cents INTEGER, concession_gross_cents INTEGER,
        authorization_id TEXT,
        -- A assinatura do piso (auditoria da Preço Justo, A-produto-17), pelo
        -- MESMO motivo: a única diferença entre as duas formas tem que ser a UNIQUE.
        floor_authorized_by TEXT,
        -- As duas da tabela de preço (v59), pelo MESMO motivo das três acima:
        -- a única diferença entre as duas formas tem que ser a UNIQUE.
        price_table_id TEXT, price_table_percent_off REAL,
        created_by TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE (company_id, number)
      );
    `);
    const depois = snapshot(db);

    closeConnection();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Pasta temporária.
    }

    // As COLUNAS são idênticas — era só isto que o teste olhava antes.
    expect(depois.core_quotes!.columns).toEqual(antes.core_quotes!.columns);
    // E a forma completa, não.
    expect(depois.core_quotes).not.toEqual(antes.core_quotes);
    expect(antes.core_quotes!.uniques.join(' ')).toMatch(/kind/);
    expect(depois.core_quotes!.uniques.join(' ')).not.toMatch(/kind/);
  });

  it('a leitura de CHECK aguenta parêntese aninhado', () => {
    // `CHECK (quantity > 0)` é fácil; `CHECK (status IN ('a','b'))` é o que
    // quebra regex ingênua — e o schema tem os dois formatos.
    expect(checksDe("CREATE TABLE t (q REAL CHECK (q > 0), s TEXT CHECK (s IN ('a','b')));")).toEqual(
      ["q > 0", "s IN ('a','b')"],
    );
  });

  it('comentário e espaçamento não contam como divergência', () => {
    const a = checksDe('CREATE TABLE t (\n  q REAL -- o saldo\n    CHECK (q  >=  0)\n);');
    const b = checksDe('CREATE TABLE t (q REAL CHECK (q >= 0));');
    expect(a).toEqual(b);
  });
});

/**
 * O número da versão não decide mais se um passo rodou.
 *
 * Os passos 2 a 7 aceitavam `core_schema_version >= passo` como prova de que
 * tinham rodado. Mas o número é exatamente o que já mentiu duas vezes aqui: foi
 * gravado antes de o passo existir, e o passo nunca mais rodou.
 *
 * Para cinco desses passos isso seria inofensivo — só adicionam coluna, e a
 * reconciliação repara coluna faltante. O passo 3 é diferente: ele RECRIA
 * `core_sale_items` para afrouxar o `NOT NULL` de `product_id`, e reconciliação
 * nenhuma desfaz constraint. Um banco com o número alto e sem o passo ficaria
 * com a coluna obrigatória para sempre — e toda venda com linha de serviço
 * (que é toda OS faturada) falharia com NOT NULL.
 */
describe('passo pulado pelo número da versão é reparado', () => {
  it('core_sale_items perde o NOT NULL mesmo com a versão dizendo que já rodou', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gs-passo-3-'));
    closeConnection();
    process.env.DEVORA_DATABASE_PATH = join(dir, 'core.db');
    resetCoreSchemaCache();
    ensureCoreSchema();

    const db = getConnection();
    // Reproduz a tabela como ela era ANTES do passo 3: product_id obrigatório.
    db.exec(`
      DROP TABLE core_sale_items;
      CREATE TABLE core_sale_items (
        id               TEXT PRIMARY KEY,
        sale_id          TEXT NOT NULL,
        company_id       TEXT NOT NULL,
        product_id       TEXT NOT NULL,
        description      TEXT NOT NULL,
        quantity         REAL NOT NULL CHECK (quantity > 0),
        unit_price_cents INTEGER NOT NULL,
        discount_cents   INTEGER NOT NULL DEFAULT 0,
        total_cents      INTEGER NOT NULL
      );
    `);

    // O estado que o defeito produzia: número alto, marcas dos passos velhos
    // ausentes. As marcas de 8 em diante ficam, para isolar o caso nos seis
    // primeiros — é assim que um banco de campo real se parecia.
    setVersion(db, CORE_TARGET_VERSION);
    db.exec(`
      DELETE FROM core_meta WHERE key IN (
        'core_migration_step_2','core_migration_step_3','core_migration_step_4',
        'core_migration_step_5','core_migration_step_6','core_migration_step_7'
      );
    `);

    migrateCoreSchema();

    const info = getConnection()
      .prepare('PRAGMA table_info(core_sale_items)')
      .all() as unknown as Column[];
    const productId = info.find((c) => c.name === 'product_id');

    closeConnection();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Pasta temporária.
    }

    // Sem a correção, o passo 3 era pulado e isto continuava 1.
    expect(productId?.notnull).toBe(0);
  });
});

/**
 * A nota do pedido online precisa de uma coluna nova — e ela chega pela
 * migração, não pela DDL canônica.
 *
 * O mesmo defeito que derrubou a subida por causa de `core_stock_movements`
 * mora aqui: `ensureCoreSchema` roda ANTES das migrations, então um índice
 * declarado na DDL sobre coluna que só a migração adiciona quebra todo banco
 * que já existe — inclusive o da loja.
 */
describe('documento fiscal ganha a coluna do pedido sem derrubar banco antigo', () => {
  it('sobe, migra e fica com coluna e índice', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gs-nfe-pedido-'));
    closeConnection();
    process.env.DEVORA_DATABASE_PATH = join(dir, 'core.db');
    resetCoreSchemaCache();
    ensureCoreSchema();
    migrateCoreSchema();

    // Volta o banco ao estado anterior ao passo: sem coluna e sem índice.
    getConnection().exec(`
      DROP INDEX IF EXISTS ix_fiscal_docs_order;
      ALTER TABLE core_fiscal_documents DROP COLUMN order_id;
      DELETE FROM core_meta WHERE key LIKE 'core_migration_step_%';
    `);
    closeConnection();
    resetCoreSchemaCache();

    // A subida real faz exatamente isto, nesta ordem.
    expect(() => {
      ensureCoreSchema();
      migrateCoreSchema();
    }).not.toThrow();

    const db = getConnection();
    const colunas = (
      db.prepare('PRAGMA table_info(core_fiscal_documents)').all() as unknown as { name: string }[]
    ).map((c) => c.name);
    const indices = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?")
        .all('core_fiscal_documents') as unknown as { name: string }[]
    ).map((i) => i.name);

    closeConnection();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Pasta temporária.
    }

    expect(colunas).toContain('order_id');
    expect(indices).toContain('ix_fiscal_docs_order');
  });
});

/*
  ============================================================================
  O BANCO MIGRADO IGUAL AO BANCO NOVO — DEFAULT, UNIQUE e ÍNDICE (GAP-PRD-140)
  ============================================================================

  O banco da loja, lido só para leitura em 11/09/2026, tinha:
    1) core_service_orders.status DEFAULT 'recebido' (o canônico é 'em_aberto');
    2) core_finance_categories com a UNIQUE (company_id, direction, name,
       parent_id) antiga, inline, além do índice COALESCE novo;
    3) ix_stock_movements_kind AUSENTE com core_migration_step_9 = applied;
    4) ix_fiscal_docs_order AUSENTE com core_migration_step_39 = applied;
    5) ix_service_orders_status em (company_id, status, updated_at), sem o
       workshop_id do canônico.
  Os casos abaixo montam esse banco e o sobem pelo boot.
*/

/** Um banco novo pelo caminho do boot: coleções, DDL canônica, passos. */
function bancoNovoPeloBoot(prefixo: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefixo));
  closeConnection();
  process.env.DEVORA_DATABASE_PATH = join(dir, 'core.db');
  resetCoreSchemaCache();
  criarColecoesDeDocumentos(getConnection());
  ensureCoreSchema();
  migrateCoreSchema();
  return dir;
}

/** A subida da API de novo sobre o mesmo arquivo. */
function subirDeNovo(): void {
  closeConnection();
  resetCoreSchemaCache();
  criarColecoesDeDocumentos(getConnection());
  ensureCoreSchema();
  migrateCoreSchema();
}

function apagarPasta(dir: string): void {
  closeConnection();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Pasta temporária.
  }
}

/**
 * Troca a DDL de uma tabela por uma variante (DEFAULT antigo, UNIQUE antiga,
 * coluna a mais), com as linhas dentro — como o banco que viveu a versão velha.
 * Os índices da tabela voltam, menos os de `exceto`.
 */
function trocarDdl(db: DatabaseSync, tabela: string, transformar: (sql: string) => string, exceto: string[] = []): void {
  const sql = ddlOf(tabela);
  const variante = transformar(sql);
  expect(variante, `a variante de ${tabela} não mudou nada`).not.toBe(sql);
  const indicesDaTabela = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL")
    .all(tabela) as unknown as { name: string; sql: string }[];
  const colunas = (db.prepare(`PRAGMA table_info(${tabela})`).all() as unknown as Column[]).map((c) => c.name);
  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec(variante.replace(new RegExp(`^CREATE TABLE ${tabela}\\b`), `CREATE TABLE ${tabela}_velha`));
  db.exec(`INSERT INTO ${tabela}_velha (${colunas.join(', ')}) SELECT ${colunas.join(', ')} FROM ${tabela}`);
  db.exec(`DROP TABLE ${tabela}`);
  db.exec(`ALTER TABLE ${tabela}_velha RENAME TO ${tabela}`);
  for (const ix of indicesDaTabela) if (!exceto.includes(ix.name)) db.exec(ix.sql);
  db.exec('PRAGMA foreign_keys = ON;');
}

const DEFAULT_ANTIGO = (sql: string) => sql.replace("status              TEXT NOT NULL DEFAULT 'em_aberto'", "status              TEXT NOT NULL DEFAULT 'recebido'");
const UNIQUE_ANTIGA = (sql: string) =>
  sql.replace("CHECK (direction IN ('in', 'out'))", "UNIQUE (company_id, direction, name, parent_id),\n     CHECK (direction IN ('in', 'out'))");

function semearOficinaECategorias(db: DatabaseSync): void {
  const agora = '2026-08-12T12:00:00.000Z';
  db.prepare(
    `INSERT INTO core_companies (id, slug, legal_name, trade_name, active, created_at, updated_at)
     VALUES ('empresa-1', 'empresa-1', 'Empresa Um Ltda', 'Empresa Um', 1, ?, ?)`,
  ).run(agora, agora);
  const os = db.prepare(
    `INSERT INTO core_service_orders (id, company_id, number, customer_name, status, created_at, updated_at)
     VALUES (?, 'empresa-1', ?, ?, ?, ?, ?)`,
  );
  os.run('os-1', 1, 'Cliente Um', 'em_aberto', agora, agora);
  os.run('os-2', 2, 'Cliente Dois', 'finalizada', agora, agora);
  const cat = db.prepare(
    `INSERT INTO core_finance_categories (id, company_id, direction, name, parent_id, active, created_at, updated_at)
     VALUES (?, 'empresa-1', 'in', ?, ?, 1, ?, ?)`,
  );
  cat.run('cat-pai', 'Vendas', null, agora, agora);
  cat.run('cat-filho', 'Balcão', 'cat-pai', agora, agora);
}

function linhas(db: DatabaseSync, tabela: string): unknown[] {
  return db.prepare(`SELECT * FROM ${tabela} ORDER BY id`).all();
}

function meta(db: DatabaseSync, chave: string): string | null {
  return (db.prepare('SELECT value FROM core_meta WHERE key = ?').get(chave) as { value?: string } | undefined)?.value ?? null;
}

describe('o banco migrado fica igual ao banco novo, também em DEFAULT e índice (GAP-PRD-140)', () => {
  it('banco novo pelo boot é idêntico à referência — nada a reparar, nada a mais', () => {
    const dir = bancoNovoPeloBoot('gs-esq-novo-');
    try {
      const c = conferirEsquema(getConnection());
      expect(c.divergencias).toEqual([]);
      expect(c.aMais).toEqual([]);
      expect(c.identico).toBe(true);
      expect(c.tabelasConferidas).toBeGreaterThan(150);
      expect(c.indicesConferidos).toBeGreaterThan(150);
      // A subida não precisou reparar nada: o reparo só se registra quando havia o que fazer.
      expect(meta(getConnection(), 'esquema:ultimo_reparo')).toBeNull();
    } finally {
      apagarPasta(dir);
    }
  });

  it('o banco da loja, com as cinco divergências e os passos marcados, sai do boot idêntico e com os dados', () => {
    const dir = bancoNovoPeloBoot('gs-esq-loja-');
    try {
      let db = getConnection();
      semearOficinaECategorias(db);
      trocarDdl(db, 'core_service_orders', DEFAULT_ANTIGO, ['ix_service_orders_status']);
      db.exec('CREATE INDEX ix_service_orders_status ON core_service_orders (company_id, status, updated_at)');
      trocarDdl(db, 'core_finance_categories', UNIQUE_ANTIGA);
      db.exec('DROP INDEX ix_stock_movements_kind; DROP INDEX ix_fiscal_docs_order;');

      // O estado da ficha: exatamente as cinco, com os passos 9 e 39 marcados.
      const antes = conferirEsquema(db);
      expect(antes.divergencias.map((d) => `${d.tipo}:${d.objeto}`).sort()).toEqual([
        'coluna_diferente:status',
        'indice_diferente:ix_service_orders_status',
        'indice_faltando:ix_fiscal_docs_order',
        'indice_faltando:ix_stock_movements_kind',
        'unico_diferente:core_finance_categories',
      ]);
      expect(meta(db, 'core_migration_step_9')).toBe('applied');
      expect(meta(db, 'core_migration_step_39')).toBe('applied');
      const osAntes = linhas(db, 'core_service_orders');
      const catAntes = linhas(db, 'core_finance_categories');

      subirDeNovo();
      db = getConnection();

      const depois = conferirEsquema(db);
      expect(depois.divergencias).toEqual([]);
      expect(depois.aMais).toEqual([]);
      expect(ddlOf('core_service_orders')).toContain("DEFAULT 'em_aberto'");
      expect(ddlOf('core_finance_categories')).not.toMatch(/UNIQUE \(company_id, direction, name, parent_id\)/);
      expect(
        (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'ix_service_orders_status'").get() as { sql: string }).sql,
      ).toMatch(/company_id, workshop_id, status, updated_at/);
      // Os dados, intactos — inclusive a categoria-filha apontando para a mãe.
      expect(linhas(db, 'core_service_orders')).toEqual(osAntes);
      expect(linhas(db, 'core_finance_categories')).toEqual(catAntes);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys).toBe(1);
      expect((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check).toBe('ok');
      // E o que se inserir sem status nasce 'em_aberto', como no banco novo.
      db.prepare(
        `INSERT INTO core_service_orders (id, company_id, number, created_at, updated_at)
         VALUES ('os-3', 'empresa-1', 3, '2026-09-11T12:00:00.000Z', '2026-09-11T12:00:00.000Z')`,
      ).run();
      expect((db.prepare("SELECT status FROM core_service_orders WHERE id = 'os-3'").get() as { status: string }).status)
        .toBe('em_aberto');

      // O reparo ficou registrado, com a cópia de antes e a trilha.
      const reparo = JSON.parse(meta(db, 'esquema:ultimo_reparo')!) as {
        modo: string;
        reparados: string[];
        pendentes: unknown[];
        copia: string | null;
      };
      expect(reparo.modo).toBe('boot');
      expect(reparo.pendentes).toEqual([]);
      // Quatro itens para cinco divergências: reconstruir core_service_orders recria os
      // índices canônicos da tabela, e ix_service_orders_status volta junto, já certo.
      expect(reparo.reparados).toHaveLength(4);
      const feitos = reparo.reparados.join(' | ');
      expect(feitos).toMatch(/core_service_orders: reconstruída/);
      expect(feitos).toMatch(/core_finance_categories: reconstruída/);
      expect(feitos).toMatch(/ix_stock_movements_kind/);
      expect(feitos).toMatch(/ix_fiscal_docs_order/);
      expect(reparo.copia && existsSync(reparo.copia)).toBe(true);
      const trilha = db.prepare("SELECT COUNT(*) AS n FROM core_audit_log WHERE action = 'system.schema.repaired'").get() as {
        n: number;
      };
      expect(trilha.n).toBe(1);

      // A subida seguinte não reconstrói de novo (nem copia o banco de novo).
      const registrado = meta(db, 'esquema:ultimo_reparo');
      subirDeNovo();
      expect(meta(getConnection(), 'esquema:ultimo_reparo')).toBe(registrado);

      // E o índice é reparado a CADA subida, não só na primeira.
      getConnection().exec('DROP INDEX ix_stock_movements_kind');
      subirDeNovo();
      expect(conferirEsquema(getConnection()).identico).toBe(true);
    } finally {
      apagarPasta(dir);
    }
  });

  it('a comparação deste arquivo enxerga DEFAULT e índice (falsificação)', () => {
    const dir = bancoNovoPeloBoot('gs-esq-falsa-');
    try {
      const db = getConnection();
      const antes = snapshot(db);
      trocarDdl(db, 'core_service_orders', DEFAULT_ANTIGO);
      db.exec('DROP INDEX ix_fiscal_docs_order');
      const depois = snapshot(db);

      // Mesmos NOMES de coluna — era só isso (e tipo e NOT NULL) que se via.
      expect(depois.core_service_orders!.columns.map((c) => c.name)).toEqual(
        antes.core_service_orders!.columns.map((c) => c.name),
      );
      expect(depois.core_service_orders).not.toEqual(antes.core_service_orders);
      expect(depois.core_service_orders!.columns.find((c) => c.name === 'status')!.dflt_value).toBe("'recebido'");
      expect(antes.core_fiscal_documents!.indices.join(' ')).toMatch(/ix_fiscal_docs_order/);
      expect(depois.core_fiscal_documents!.indices.join(' ')).not.toMatch(/ix_fiscal_docs_order/);
    } finally {
      apagarPasta(dir);
    }
  });

  it('índice ÚNICO que os dados repetidos recusam vira pendência com o caminho da tela, e não a mensagem crua do SQLite', () => {
    const dir = bancoNovoPeloBoot('gs-esq-unico-');
    try {
      let db = getConnection();
      semearOficinaECategorias(db);
      const agora = '2026-08-12T12:00:00.000Z';
      db.prepare(
        `INSERT INTO core_workshops (id, company_id, slug, name, kind, active, created_at)
         VALUES ('ws-1', 'empresa-1', 'bancada-1', 'Bancada Um', 'mobility', 1, ?)`,
      ).run(agora);
      // O índice some (banco restaurado de antes dele) e entram duas motos com a mesma placa.
      db.exec('DROP INDEX IF EXISTS ux_equipment_plate');
      const eq = db.prepare(
        `INSERT INTO core_equipment (id, company_id, workshop_id, public_id, public_token, origin, plate, created_at, updated_at)
         VALUES (?, 'empresa-1', 'ws-1', ?, ?, 'ORIGEM_DO_TESTE', 'ABC1D23', ?, ?)`,
      );
      eq.run('eq-1', 9001, 'tok-1', agora, agora);
      eq.run('eq-2', 9002, 'tok-2', agora, agora);

      subirDeNovo();
      db = getConnection();

      const reparo = JSON.parse(meta(db, 'esquema:ultimo_reparo')!) as { pendentes: { objeto: string; motivo: string }[] };
      const pendencia = reparo.pendentes.find((p) => p.objeto === 'ux_equipment_plate');
      expect(pendencia, JSON.stringify(reparo.pendentes)).toBeDefined();
      expect(pendencia!.motivo).toMatch(/linhas repetidas/);
      expect(pendencia!.motivo).toMatch(/Corrigir identidade/);
      expect(pendencia!.motivo).not.toMatch(/UNIQUE constraint failed/);
      expect(pendencia!.motivo).not.toMatch(/\.\./);
      // O dado fica: nenhuma linha é apagada para o índice caber.
      expect((db.prepare("SELECT count(*) AS n FROM core_equipment WHERE plate = 'ABC1D23'").get() as { n: number }).n).toBe(2);
    } finally {
      apagarPasta(dir);
    }
  });

  it('o aviso da subida junta as divergências sem ponto dobrado', () => {
    expect(
      resumoDasDivergencias([
        { descricao: 'Índice ix_a (t) falta neste banco.' },
        { descricao: 't.c: DEFAULT diferente.' },
      ]),
    ).toBe('Índice ix_a (t) falta neste banco | t.c: DEFAULT diferente');
  });

  it('tabela com coluna que o banco novo não tem NÃO é reconstruída: o dado fica, e a pendência diz por quê', () => {
    const dir = bancoNovoPeloBoot('gs-esq-extra-');
    try {
      let db = getConnection();
      semearOficinaECategorias(db);
      trocarDdl(db, 'core_service_orders', (sql) =>
        DEFAULT_ANTIGO(sql).replace('UNIQUE (company_id, number)', 'coluna_de_terceiro TEXT,\n     UNIQUE (company_id, number)'),
      );
      db.exec("UPDATE core_service_orders SET coluna_de_terceiro = 'dado de outra build' WHERE id = 'os-1'");

      subirDeNovo();
      db = getConnection();

      const c = conferirEsquema(db);
      expect(c.divergencias.map((d) => `${d.tipo}:${d.objeto}`)).toEqual(['coluna_diferente:status']);
      expect(c.aMais).toEqual([{ tipo: 'coluna_a_mais', tabela: 'core_service_orders', objeto: 'coluna_de_terceiro' }]);
      expect(
        (db.prepare("SELECT coluna_de_terceiro AS v FROM core_service_orders WHERE id = 'os-1'").get() as { v: string }).v,
      ).toBe('dado de outra build');
      const reparo = JSON.parse(meta(db, 'esquema:ultimo_reparo')!) as { pendentes: { objeto: string; motivo: string }[] };
      expect(reparo.pendentes).toHaveLength(1);
      expect(reparo.pendentes[0]!.objeto).toBe('core_service_orders');
      expect(reparo.pendentes[0]!.motivo).toMatch(/coluna_de_terceiro/);
    } finally {
      apagarPasta(dir);
    }
  });

  it('reconstrução que perderia linha é desfeita inteira, e não é repetida a cada subida', () => {
    const dir = bancoNovoPeloBoot('gs-esq-desfeita-');
    try {
      const db = getConnection();
      semearOficinaECategorias(db);
      trocarDdl(db, 'core_service_orders', DEFAULT_ANTIGO);
      const antes = linhas(db, 'core_service_orders');

      // Uma linha "some" no meio da cópia: a contagem acusa e tudo volta.
      const r1 = repararEsquema(db, {
        modo: 'boot',
        aoCopiarLinhas: (conexao, nova) => conexao.exec(`DELETE FROM "${nova}" WHERE id = 'os-2'`),
      });
      expect(r1.pendentes).toHaveLength(1);
      expect(r1.pendentes[0]!.motivo).toMatch(/Reconstrução desfeita: a reconstrução de core_service_orders perderia linhas: 2 antes, 1 depois/);
      expect(linhas(db, 'core_service_orders')).toEqual(antes);
      expect(ddlOf('core_service_orders')).toContain("DEFAULT 'recebido'");
      expect((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys).toBe(1);

      // Na subida seguinte, a mesma divergência não é tentada de novo.
      const r2 = repararEsquema(db, { modo: 'boot' });
      expect(r2.copia).toBeNull();
      expect(r2.pendentes[0]!.motivo).toMatch(/já foi tentada e desfeita/);
      expect(ddlOf('core_service_orders')).toContain("DEFAULT 'recebido'");

      // O comando, com a API parada, tenta de novo — e agora dá certo.
      const r3 = repararEsquema(db, { modo: 'comando', copiaJaFeita: { caminho: null } });
      expect(r3.pendentes).toEqual([]);
      expect(r3.depois!.identico).toBe(true);
      expect(linhas(db, 'core_service_orders')).toEqual(antes);
    } finally {
      apagarPasta(dir);
    }
  });
});
