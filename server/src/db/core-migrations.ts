/**
 * Migrations versionadas do núcleo.
 *
 * `ensureCoreSchema()` cria o formato ATUAL num banco novo. Este módulo leva
 * um banco JÁ EXISTENTE até o mesmo formato, sem apagar dado nenhum — nunca
 * se resolve schema pedindo para o usuário limpar a base.
 *
 * Cada passo é idempotente: rodar duas vezes não quebra e não duplica.
 */
import { PRESET_OFICIAL } from '../services/core/StorefrontPresets.js';
import { EMPRESA_DAS_PLAQUINHAS } from '../services/core/EmpresaDasPlaquinhas.js';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { getConnection, withTransaction } from './sqlite.js';
import { STATEMENTS, ensureCoreSchema } from './schema.js';
import { snapshotDatabase } from './backup.js';
import { repararEsquema, resumoDasDivergencias } from './derivaDoEsquema.js';
import { diaDaLojaSql } from '../services/core/CalendarioOperacional.js';
import {
  aplicarConsolidacaoDaRemediacao,
  garantirAmbienteDosDocumentosDfe,
  resolverPendenciasDaConsolidacao,
} from './consolidacaoDaRemediacao.js';
import { aplicarPasso86 } from './passo86Acesso.js';
/*
  O semeador das categorias de sistema vem do SERVIÇO, e não de uma cópia aqui.

  A lista de categorias tem um dono (`FinanceSetupService`), e o passo 56
  precisa dela ANTES de classificar. Copiar os nove códigos para dentro da
  migração criaria a segunda cópia que diverge da primeira no primeiro
  ajuste — e a divergência apareceria como lançamento apontando para uma
  categoria que a tela não lista.
*/
import { seedSystemCategories } from '../services/core/FinanceSetupService.js';

/**
 * De qual categoria de sistema é cada lançamento AUTOMÁTICO — por ORIGEM E
 * DIREÇÃO, nunca só por origem.
 *
 * `origin_type = 'sale'` gera as duas linhas: a parcela a receber e a taxa da
 * maquininha. Sem a direção na chave, a taxa (saída) receberia a categoria de
 * venda (receita).
 *
 * `manual` não está aqui: lançamento digitado não tem origem que revele o
 * propósito, e chutar uma categoria para ele seria inventar classificação.
 */
const BACKFILL_DE_CATEGORIA: {
  originType: string;
  direction: 'in' | 'out';
  code: string;
}[] = [
  { originType: 'sale', direction: 'in', code: 'venda' },
  { originType: 'sale', direction: 'out', code: 'taxa_cartao' },
  { originType: 'ecommerce_order', direction: 'in', code: 'venda' },
  { originType: 'sale_return', direction: 'out', code: 'devolucao' },
  { originType: 'nfe_entrada', direction: 'out', code: 'fornecedor' },
];

/**
 * Versão alvo do schema do núcleo.
 *
 * REGRA: um passo já aplicado é imutável. Alterá-lo não tem efeito no banco que
 * já o registrou — correção de passo antigo entra como um passo NOVO.
 *
 * CADA PASSO SE REGISTRA SOZINHO, e é isso que torna a regra segura.
 *
 * Antes havia um número de versão só, gravado no fim da transação. Ele mentia
 * de dois jeitos: era escrito mesmo quando nenhum passo tinha efeito, e um
 * `if (from < N)` era pulado para sempre depois disso. Na prática, salvar o
 * arquivo entre duas edições — o `tsx watch` recarrega a cada gravação — já
 * bastava para o banco ficar marcado como atualizado sem estar. Aconteceu
 * duas vezes durante o desenvolvimento: uma coluna e uma chave única ficaram
 * para trás, e a falha só apareceu ao fechar uma venda.
 *
 * Agora cada passo tem sua própria marca (`core_migration_step_N`). Um passo
 * novo roda em qualquer banco que ainda não o tenha, independentemente de
 * qualquer número global.
 */
/**
 * Versão alvo — e o número do ÚLTIMO passo que existe aqui embaixo.
 *
 * Os dois têm que ser o mesmo número. `haPassoPendente` varre de 2 até aqui
 * para decidir se vale tirar snapshot; um alvo maior que o último passo cria um
 * passo fantasma que nunca é marcado, e aí TODO restart do servidor copia o
 * banco inteiro. Foi o que aconteceu enquanto o alvo era 39 e o último passo
 * era 38: dez cópias em `server/data/backups`, três delas no mesmo minuto.
 */
export const CORE_TARGET_VERSION = 86;

function ensureMeta(): void {
  getConnection().exec(
    'CREATE TABLE IF NOT EXISTS core_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);',
  );
}

function metaValue(key: string): string | null {
  ensureMeta();
  const row = getConnection().prepare('SELECT value FROM core_meta WHERE key = ?').get(key) as
    | { value?: string }
    | undefined;
  return row?.value ?? null;
}

function setMeta(key: string, value: string): void {
  ensureMeta();
  getConnection()
    .prepare(
      `INSERT INTO core_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, value);
}

function currentVersion(): number {
  const value = metaValue('core_schema_version');
  return value ? Number(value) : 0;
}

/**
 * Um passo já rodou neste banco? Só a marca responde.
 *
 * O QUE ESTAVA AQUI: para os passos 2 a 7, o número da versão valia como marca
 * — `currentVersion() >= step`. A ideia era acomodar bancos anteriores ao
 * esquema de marcas, que só têm o número.
 *
 * O problema é que o número é justamente o que já mentiu, duas vezes, neste
 * projeto: `core_schema_version` foi gravado antes de o passo existir (o
 * `tsx watch` reinicia a cada gravação de arquivo), e o passo nunca mais
 * rodou. A marca individual nasceu POR CAUSA disso. Manter o número como marca
 * para os seis primeiros passos deixava viva, neles, exatamente a falha que a
 * marca veio eliminar — e para o passo 3 isso importa de verdade: ele recria
 * `core_sale_items` para afrouxar um NOT NULL, e a reconciliação de colunas
 * não desfaz constraint. O banco ficaria errado em silêncio, para sempre.
 *
 * POR QUE DÁ PARA SIMPLESMENTE TIRAR: os seis passos são idempotentes. Usam
 * `addColumn` (que confere antes), `CREATE ... IF NOT EXISTS`, e um `UPDATE`
 * que não acha linha depois da primeira vez. O único trecho pesado — a
 * reconstrução do passo 3 — já se detecta sozinho lendo `PRAGMA table_info`,
 * e não a marca.
 *
 * Então rodar de novo num banco que já os aplicou não faz nada, e rodar num
 * banco cujo número mentiu CONSERTA. Deixar de rodar é que era o risco.
 */
function stepApplied(step: number): boolean {
  return metaValue(`core_migration_step_${step}`) === 'applied';
}

function markStep(step: number): void {
  setMeta(`core_migration_step_${step}`, 'applied');
}

function setVersion(version: number): void {
  setMeta('core_schema_version', String(version));
}

function columns(table: string): Set<string> {
  const rows = getConnection()
    .prepare(`PRAGMA table_info(${table})`)
    .all() as unknown as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

function tableExists(table: string): boolean {
  const row = getConnection()
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { name?: string } | undefined;
  return Boolean(row?.name);
}

/** ALTER idempotente: só adiciona a coluna se ela ainda não existir. */
function addColumn(table: string, column: string, ddl: string): void {
  if (!tableExists(table)) return;
  if (columns(table).has(column)) return;
  getConnection().exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl};`);
}

/**
 * Estados antigos do Kanban -> estados operacionais definidos pelo negócio.
 * Mantido explícito para que uma OS em andamento não "suma" da tela após o
 * upgrade.
 */
const STATUS_MAP: Record<string, string> = {
  recebido: 'em_aberto',
  diagnostico: 'em_andamento',
  aguardando_aprovacao: 'em_andamento',
  em_execucao: 'em_andamento',
  finalizado: 'finalizada',
  entregue: 'finalizada',
};

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
}

function tableColumns(db: DatabaseSync, table: string): ColumnInfo[] {
  return db.prepare(`PRAGMA table_info(${table})`).all() as unknown as ColumnInfo[];
}

/**
 * Alinha o banco real com a DDL canônica, sem depender do número da versão.
 *
 * Existe porque o versionamento sozinho não é confiável: `setVersion` grava a
 * versão alvo no fim da transação mesmo quando nenhum passo teve efeito, e um
 * passo já aplicado é pulado para sempre. Bastou um deploy pegar o arquivo
 * entre duas edições para o banco ficar marcado como atualizado sem ter a
 * coluna — e o erro só apareceu na hora de fechar uma venda.
 *
 * Aqui a DDL é montada num banco de referência em memória e comparada com o
 * banco real. Toda coluna que faltar e puder ser adicionada com segurança
 * (tem DEFAULT, ou aceita nulo) é adicionada.
 *
 * O que este passo NÃO faz, de propósito: remover coluna, mudar tipo, alterar
 * constraint ou mexer em dado. Reparo silencioso destrutivo é pior que o
 * problema. Índice, DEFAULT e constraint divergentes são da fase de reparo do
 * esquema (`derivaDoEsquema.ts`, GAP-PRD-140), que roda DEPOIS da transação
 * dos passos, compara com um banco novo e reconstrói com conferência.
 */
export function reconcileCoreSchema(): { added: string[]; skipped: string[] } {
  const reference = new DatabaseSync(':memory:');
  for (const statement of STATEMENTS) reference.exec(statement);

  const db = getConnection();
  const added: string[] = [];
  const skipped: string[] = [];

  const tables = reference
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'core_%'")
    .all() as unknown as { name: string }[];

  for (const { name: table } of tables) {
    if (!tableExists(table)) continue; // tabela nova já veio do ensureCoreSchema
    const present = new Set(tableColumns(db, table).map((c) => c.name));

    for (const column of tableColumns(reference, table)) {
      if (present.has(column.name)) continue;

      // O SQLite recusa ADD COLUMN NOT NULL sem DEFAULT: não haveria valor
      // para as linhas que já existem.
      if (column.notnull === 1 && column.dflt_value === null) {
        skipped.push(`${table}.${column.name}`);
        continue;
      }
      const notNull = column.notnull === 1 ? ' NOT NULL' : '';
      const dflt = column.dflt_value === null ? '' : ` DEFAULT ${column.dflt_value}`;
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column.name} ${column.type}${notNull}${dflt};`);
      added.push(`${table}.${column.name}`);
    }
  }

  reference.close();
  return { added, skipped };
}

/**
 * Reconstrói `core_quotes` para trocar a chave única por (empresa, tipo, número).
 *
 * Fica FORA da transação principal de propósito. O SQLite não altera
 * constraint, então a tabela precisa ser recriada — e `core_quote_items`
 * aponta para ela. Com as chaves estrangeiras ligadas, o `DROP TABLE` derruba
 * a checagem; e `PRAGMA foreign_keys` é ignorado dentro de uma transação, que
 * é justamente onde o resto das migrations roda.
 *
 * O procedimento é o documentado pelo SQLite: desligar as chaves, reconstruir
 * as duas tabelas em transação própria, conferir a integridade e religar. Se a
 * conferência acusar qualquer pendência, a transação é desfeita.
 */
function rebuildQuotesForKindNumbering(): void {
  const db = getConnection();
  if (!tableExists('core_quotes')) return;

  const ddl = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'core_quotes'")
    .get() as { sql?: string } | undefined;
  if (!ddl?.sql || ddl.sql.includes('company_id, kind, number')) return;

  db.exec('PRAGMA foreign_keys = OFF;');
  try {
    db.exec('BEGIN IMMEDIATE;');
    db.exec(`
      CREATE TABLE core_quotes_new (
        id                TEXT PRIMARY KEY,
        company_id        TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
        number            INTEGER NOT NULL,
        kind              TEXT NOT NULL DEFAULT 'orcamento',
        status            TEXT NOT NULL DEFAULT 'aberto',
        customer_id       TEXT REFERENCES core_customers(id),
        seller_id         TEXT,
        valid_until       TEXT,
        discount_cents    INTEGER NOT NULL DEFAULT 0,
        total_cents       INTEGER NOT NULL DEFAULT 0,
        note              TEXT,
        converted_sale_id TEXT REFERENCES core_sales(id),
        converted_at      TEXT,
        created_by        TEXT,
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL,
        UNIQUE (company_id, kind, number)
      );
      INSERT INTO core_quotes_new
        SELECT id, company_id, number, kind, status, customer_id, seller_id,
               valid_until, discount_cents, total_cents, note, converted_sale_id,
               converted_at, created_by, created_at, updated_at
          FROM core_quotes;
      DROP TABLE core_quotes;
      ALTER TABLE core_quotes_new RENAME TO core_quotes;
      CREATE INDEX IF NOT EXISTS ix_quotes_company
        ON core_quotes (company_id, status, created_at);
    `);

    const pending = db.prepare('PRAGMA foreign_key_check').all() as unknown as unknown[];
    if (pending.length > 0) {
      db.exec('ROLLBACK;');
      throw new Error(
        `Reconstrução de core_quotes deixaria ${pending.length} referência(s) órfã(s).`,
      );
    }
    db.exec('COMMIT;');
  } catch (err) {
    try {
      db.exec('ROLLBACK;');
    } catch {
      // Já desfeita.
    }
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON;');
  }
}

/**
 * Reconstrói `core_finance_entries` — a ÚNICA vez que esta tabela abre.
 *
 * Uma auditoria deste plano descobriu que ela aparecia em quatro rodadas
 * diferentes, cada uma orçando a reconstrução como se fosse dona única. Aqui
 * ela abre uma vez e recebe as colunas de TODO o financeiro, inclusive as que
 * ainda não têm consumidor.
 *
 * O que muda e não dá para fazer com ALTER:
 *  - a UNIQUE ganha `installment_number` (parcela do carnê);
 *  - a tabela ganha os sete CHECK que nunca teve.
 *
 * O procedimento é o mesmo de `rebuildQuotesForKindNumbering`: tabela nova,
 * cópia, troca, e `foreign_key_check` antes de confirmar. Se sobrar referência
 * órfã, desfaz tudo — melhor não migrar do que migrar quebrando o razão.
 */
function rebuildFinanceEntries(): void {
  const db = getConnection();
  if (!tableExists('core_finance_entries')) return;

  const ddl = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'core_finance_entries'")
    .get() as { sql?: string } | undefined;
  if (!ddl?.sql) return;

  /*
    A MARCA DE "JÁ RECONSTRUÍDA" É A CHAVE ÚNICA, NÃO A COLUNA.

    A primeira versão desta guarda procurava a palavra `installment_number` no
    DDL — e deu falso positivo num banco real, com consequência séria.

    O que aconteceu: o passo é marcado ANTES do trabalho; a reconstrução falhou
    com "database is locked" durante um restart, o processo morreu, e o passo
    ficou marcado. Na subida seguinte o passo foi pulado, e o
    `reconcileCoreSchema` acrescentou as colunas que faltavam via ALTER. O
    banco terminou com as COLUNAS novas e a CONSTRAINT antiga, de três colunas.

    O sintoma só apareceu meses depois, na primeira venda parcelada: a segunda
    parcela colidia com a primeira e a venda inteira falhava com 500.

    Procurar a chave inteira é o que distingue "reconstruída" de "remendada".
  */
  const temChaveNova = /UNIQUE\s*\(\s*origin_type\s*,\s*origin_id\s*,\s*direction\s*,\s*installment_number/i.test(
    ddl.sql,
  );
  if (temChaveNova) return;

  const antes = (
    db.prepare('SELECT COUNT(*) AS n FROM core_finance_entries').get() as { n: number }
  ).n;

  /*
    A CÓPIA LEVA A INTERSEÇÃO DAS COLUNAS, e não uma lista fixa.

    Um banco meio migrado — colunas novas, chave antiga — já tem `category_id`,
    `competence_date` e as demais PREENCHIDAS por vendas reais. Copiar por
    lista fixa jogaria fora essa classificação em silêncio, e o DRE do mês
    passado mudaria sem ninguém entender por quê.

    Um banco genuinamente antigo não tem essas colunas, e listá-las no SELECT
    faria a migração estourar. A interseção resolve os dois casos.
  */
  const existentes = new Set(
    (db.prepare('PRAGMA table_info(core_finance_entries)').all() as unknown as {
      name: string;
    }[]).map((c) => c.name),
  );
  const desejadas = [
    'id',
    'company_id',
    'direction',
    'amount_cents',
    'status',
    'due_date',
    'settled_at',
    'settled_cents',
    'customer_id',
    'supplier_id',
    'description',
    'origin_type',
    'origin_id',
    'category_id',
    'cost_center_id',
    'account_id',
    'installment_number',
    'installment_total',
    'payment_method',
    'document_number',
    'interest_cents',
    'fine_cents',
    'discount_cents',
    'competence_date',
    'cancelled_at',
    'note',
    'created_at',
  ].filter((c) => existentes.has(c));

  // Competência retroativa para quem ainda não tem a coluna: o lançamento
  // antigo passa a competir na data em que foi criado. Nula, ele sumiria do DRE.
  const selecao = desejadas.slice();
  const colunas = desejadas.slice();
  if (!existentes.has('competence_date')) {
    colunas.push('competence_date');
    // O dia da LOJA, e não o de Greenwich (GAP-PRD-142): a venda das 22h de
    // 12/08 compete em 12/08, como o lançamento que o código grava hoje.
    selecao.push(diaDaLojaSql('created_at'));
  }
  const copia =
    `INSERT INTO core_finance_entries_new (${colunas.join(', ')})\n` +
    `        SELECT ${selecao.join(', ')} FROM core_finance_entries`;

  db.exec('PRAGMA foreign_keys = OFF;');
  try {
    db.exec('BEGIN IMMEDIATE;');
    db.exec(`
      CREATE TABLE core_finance_entries_new (
        id             TEXT PRIMARY KEY,
        company_id     TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
        direction      TEXT NOT NULL,
        amount_cents   INTEGER NOT NULL,
        status         TEXT NOT NULL DEFAULT 'open',
        due_date       TEXT,
        settled_at     TEXT,
        settled_cents  INTEGER NOT NULL DEFAULT 0,
        customer_id    TEXT REFERENCES core_customers(id),
        supplier_id    TEXT REFERENCES core_suppliers(id),
        description    TEXT NOT NULL,
        origin_type    TEXT NOT NULL,
        origin_id      TEXT NOT NULL,
        category_id    TEXT REFERENCES core_finance_categories(id),
        cost_center_id TEXT REFERENCES core_cost_centers(id),
        account_id     TEXT REFERENCES core_finance_accounts(id),
        installment_number INTEGER NOT NULL DEFAULT 1,
        installment_total  INTEGER NOT NULL DEFAULT 1,
        payment_method TEXT,
        document_number TEXT,
        interest_cents INTEGER NOT NULL DEFAULT 0,
        fine_cents     INTEGER NOT NULL DEFAULT 0,
        discount_cents INTEGER NOT NULL DEFAULT 0,
        competence_date TEXT,
        cancelled_at   TEXT,
        note           TEXT,
        created_at     TEXT NOT NULL,
        UNIQUE (origin_type, origin_id, direction, installment_number),
        CHECK (direction IN ('in', 'out')),
        CHECK (status IN ('open', 'settled', 'cancelled')),
        CHECK (amount_cents >= 0),
        CHECK (settled_cents >= 0),
        CHECK (installment_number >= 1),
        CHECK (installment_total >= 1),
        CHECK (installment_number <= installment_total)
      );
      ${copia};
      DROP TABLE core_finance_entries;
      ALTER TABLE core_finance_entries_new RENAME TO core_finance_entries;
      CREATE INDEX IF NOT EXISTS ix_finance_company
        ON core_finance_entries (company_id, status, due_date);
      CREATE INDEX IF NOT EXISTS ix_finance_entries_due
        ON core_finance_entries (company_id, direction, status, due_date);
    `);

    const depois = (
      db.prepare('SELECT COUNT(*) AS n FROM core_finance_entries').get() as { n: number }
    ).n;
    if (depois !== antes) {
      db.exec('ROLLBACK;');
      throw new Error(
        `Reconstrução de core_finance_entries perdeu lançamentos: ${antes} antes, ${depois} depois.`,
      );
    }

    const orfas = db.prepare('PRAGMA foreign_key_check').all() as unknown as {
      table?: string;
      parent?: string;
    }[];
    if (orfas.length > 0) {
      db.exec('ROLLBACK;');
      // A mensagem diz PARA ONDE a referência aponta. Sem isso, quem recebe o
      // erro sabe que falhou e não sabe o que consertar — e a reconstrução do
      // razão é justamente o momento em que se precisa saber.
      const onde = [...new Set(orfas.map((o) => `${o.table ?? '?'} → ${o.parent ?? '?'}`))];
      throw new Error(
        `Reconstrução de core_finance_entries deixaria ${orfas.length} referência(s) órfã(s): ` +
          `${onde.join('; ')}. Corrija esses vínculos antes de migrar.`,
      );
    }
    db.exec('COMMIT;');
  } catch (err) {
    try {
      db.exec('ROLLBACK;');
    } catch {
      // Já desfeita.
    }
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON;');
  }
}

/**
 * Exposta para o teste que cobre o conserto do banco meio migrado.
 *
 * A reconstrução é idempotente e se detecta sozinha, então chamá-la fora da
 * sequência de passos é seguro — é justamente isso que o teste prova.
 */
export function rebuildFinanceEntriesForTests(): void {
  rebuildFinanceEntries();
}

/**
 * Há passo pendente neste banco?
 *
 * Usado para decidir se vale tirar snapshot. Sem esta checagem, todo restart
 * do `tsx watch` — que é a cada gravação de arquivo — geraria uma cópia do
 * banco. Snapshot só faz sentido quando a estrutura vai mudar de verdade.
 */
function haPassoPendente(): boolean {
  for (let passo = 2; passo <= CORE_TARGET_VERSION; passo += 1) {
    if (!stepApplied(passo)) return true;
  }
  return false;
}

/** O que a subida (ou o comando) pede à migração além dos passos. */
export interface OpcoesDaMigracao {
  /**
   * Montando o banco de REFERÊNCIA do esquema (GAP-PRD-140), em memória: sem
   * snapshot, sem log e sem as fases de depois da transação.
   */
  referencia?: boolean;
  /** Como o reparo do esquema roda depois dos passos. Padrão: o da subida. */
  reparoDoEsquema?: { modo: 'boot' | 'comando'; copiaJaFeita?: { caminho: string | null } };
}

export function migrateCoreSchema(opcoes: OpcoesDaMigracao = {}): { from: number; to: number } {
  ensureCoreSchema();
  const from = currentVersion();

  /**
   * Snapshot ANTES de mexer na estrutura.
   *
   * Dois passos reconstroem tabela (`core_quotes`, `core_sale_items`): copiam
   * o dado para uma tabela nova e apagam a antiga. Cair no meio disso, ou
   * descobrir depois que a DDL nova estava errada, não tem desfazer sem uma
   * cópia. Falha ao tirar o snapshot NÃO impede a migração — um banco preso na
   * versão antiga por causa de disco cheio seria pior —, mas fica registrada.
   */
  // A cópia desta subida, se houve: o reparo do esquema (no fim) a aproveita
  // em vez de copiar o banco inteiro outra vez.
  let copiaDestaSubida: { caminho: string | null } | null = null;
  if (!opcoes.referencia && haPassoPendente()) {
    try {
      const snap = snapshotDatabase(`pre-migracao-v${CORE_TARGET_VERSION}`);
      copiaDestaSubida = { caminho: snap.skipped ? null : snap.path };
      if (!snap.skipped) {
        console.info(`[migração] snapshot em ${snap.path} (${snap.bytes} bytes)`);
      }
    } catch (err) {
      console.warn(
        `[migração] NÃO foi possível gerar snapshot: ${(err as Error).message}. `
          + 'A migração continua; considere copiar o banco à mão antes de seguir.',
      );
    }
  }

  // Reconstrução de tabela não cabe na transação geral (ver acima).
  if (!stepApplied(8)) {
    rebuildQuotesForKindNumbering();
    withTransaction(() => markStep(8));
  }

  /*
    RECONSTRUÇÃO DE `core_finance_entries` — TAMBÉM FORA DA TRANSAÇÃO GERAL.

    Ela estava dentro, e por isso NUNCA funcionou em banco nenhum: a função
    abre a própria transação, e o SQLite recusa com "cannot start a transaction
    within a transaction". Pior, `PRAGMA foreign_keys = OFF` é ignorado dentro
    de uma transação — então nem sem o BEGIN próprio ela funcionaria ali.

    O efeito foi silencioso e caro: a reconstrução falhava, o
    `reconcileCoreSchema` acrescentava as colunas que faltavam via ALTER, e o
    banco ficava com COLUNAS novas e CONSTRAINT antiga, de três colunas. O
    sintoma só apareceu na primeira venda parcelada — a segunda parcela
    colidia com a primeira e a venda inteira falhava.

    A marca vem DEPOIS do trabalho, como no passo 8: marcada antes, uma falha
    deixaria o passo dado por feito para sempre. Foi exatamente assim que o
    banco chegou ao estado remendado.

    `rebuildFinanceEntries` se detecta sozinha pela chave INTEIRA, então rodar
    isto em todo start é barato e seguro.
  */
  if (!stepApplied(47)) {
    rebuildFinanceEntries();
    withTransaction(() => markStep(47));
  }

  withTransaction(() => {
    const db = getConnection();

    // v1 -> v2: dimensão de oficina, equipamento e regra de assumir OS.
    if (!stepApplied(2)) {
      // A marca entra na mesma transação do passo: se ele falhar, ela some junto.
      markStep(2);
      addColumn('core_service_orders', 'workshop_id', 'TEXT REFERENCES core_workshops(id)');
      addColumn('core_service_orders', 'equipment_id', 'TEXT REFERENCES core_equipment(id)');
      addColumn('core_service_orders', 'assigned_at', 'TEXT');
      addColumn('core_service_orders', 'opened_by_customer', 'INTEGER NOT NULL DEFAULT 0');
      addColumn('core_service_orders', 'has_cost', 'INTEGER');
      addColumn('core_service_orders', 'no_cost_reason', 'TEXT');
      addColumn('core_service_orders', 'sale_id', 'TEXT REFERENCES core_sales(id)');
      addColumn('core_service_orders', 'paid_at', 'TEXT');

      // Reescreve os estados antigos preservando as OS existentes.
      const update = db.prepare('UPDATE core_service_orders SET status = ? WHERE status = ?');
      for (const [oldStatus, newStatus] of Object.entries(STATUS_MAP)) {
        update.run(newStatus, oldStatus);
      }
    }

    // v2 -> v3: produtos ganham marcação de publicação no e-commerce e
    // classificação de peça, para separar peça de oficina de item de varejo.
    if (!stepApplied(3)) {
      // A marca entra na mesma transação do passo: se ele falhar, ela some junto.
      markStep(3);
      addColumn('core_products', 'publish_online', 'INTEGER NOT NULL DEFAULT 0');
      addColumn('core_products', 'workshop_id', 'TEXT REFERENCES core_workshops(id)');
      addColumn('core_products', 'kind', "TEXT NOT NULL DEFAULT 'retail'");

      // Portal do proprietário: liga a conta de acesso ao cliente.
      addColumn('core_users', 'customer_id', 'TEXT REFERENCES core_customers(id)');

      // Linha de serviço de OS não tem produto de catálogo. O SQLite não
      // permite afrouxar NOT NULL com ALTER, então a coluna é recriada
      // copiando os dados existentes.
      if (tableExists('core_sale_items')) {
        const info = db.prepare('PRAGMA table_info(core_sale_items)').all() as unknown as {
          name: string;
          notnull: number;
        }[];
        const productColumn = info.find((c) => c.name === 'product_id');
        if (productColumn?.notnull === 1) {
          db.exec(`
            CREATE TABLE core_sale_items_new (
              id              TEXT PRIMARY KEY,
              sale_id         TEXT NOT NULL REFERENCES core_sales(id) ON DELETE CASCADE,
              company_id      TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
              product_id      TEXT REFERENCES core_products(id),
              description     TEXT NOT NULL,
              quantity        REAL NOT NULL CHECK (quantity > 0),
              unit_price_cents INTEGER NOT NULL,
              discount_cents  INTEGER NOT NULL DEFAULT 0,
              total_cents     INTEGER NOT NULL
            );
            INSERT INTO core_sale_items_new
              SELECT id, sale_id, company_id, product_id, description, quantity,
                     unit_price_cents, discount_cents, total_cents
                FROM core_sale_items;
            DROP TABLE core_sale_items;
            ALTER TABLE core_sale_items_new RENAME TO core_sale_items;
            CREATE INDEX IF NOT EXISTS ix_sale_items_sale ON core_sale_items (sale_id);
          `);
        }
      }
    }

    // v3 -> v4: troco da venda e autorização gerencial no PDV.
    if (!stepApplied(4)) {
      // A marca entra na mesma transação do passo: se ele falhar, ela some junto.
      markStep(4);
      addColumn('core_sales', 'change_cents', 'INTEGER NOT NULL DEFAULT 0');

      // Ações do PDV que exigiram liberação de um gestor. Fica separado da
      // auditoria geral porque aqui interessa QUEM autorizou o quê, e isso é
      // consultado em conferência de caixa.
      db.exec(`
        CREATE TABLE IF NOT EXISTS core_authorizations (
          id            TEXT PRIMARY KEY,
          company_id    TEXT NOT NULL,
          action        TEXT NOT NULL,
          requested_by  TEXT NOT NULL,
          authorized_by TEXT NOT NULL,
          reason        TEXT,
          detail        TEXT,
          reference_id  TEXT,
          created_at    TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ix_authorizations_company
          ON core_authorizations (company_id, created_at);
      `);
    }

    // v4 -> v5: repara bancos que pararam na v4 sem a coluna de troco.
    //
    // O passo v4 foi ajustado depois de já ter rodado em banco de
    // desenvolvimento, e quem estava marcado como v4 nunca recebeu
    // `change_cents`. `addColumn` é idempotente, então rodar isto onde a
    // coluna já existe não faz nada.
    if (!stepApplied(5)) {
      // A marca entra na mesma transação do passo: se ele falhar, ela some junto.
      markStep(5);
      addColumn('core_sales', 'change_cents', 'INTEGER NOT NULL DEFAULT 0');
    }

    // v5 -> v6: grade de produto (tamanho/cor) como produto-filho.
    if (!stepApplied(6)) {
      // A marca entra na mesma transação do passo: se ele falhar, ela some junto.
      markStep(6);
      addColumn('core_products', 'parent_id', 'TEXT REFERENCES core_products(id)');
      addColumn('core_products', 'variant_attributes', 'TEXT');
      getConnection().exec(
        'CREATE INDEX IF NOT EXISTS ix_products_parent ON core_products (parent_id);',
      );
    }

    // v6 -> v7: orçamento e pré-venda. As tabelas são novas, então
    // `ensureCoreSchema` já as criou com o CREATE IF NOT EXISTS; o passo existe
    // para o banco antigo ser marcado corretamente.
    if (!stepApplied(7)) {
      // A marca entra na mesma transação do passo: se ele falhar, ela some junto.
      markStep(7);
      getConnection().exec(
        'CREATE INDEX IF NOT EXISTS ix_quotes_company ON core_quotes (company_id, status, created_at);',
      );
    }

    // v8 -> v9: razão de estoque conta a história inteira.
    //
    // Antes só havia `balance_after`: dava para ver onde o saldo parou, mas
    // não de onde saiu nem por quê. Sem o saldo anterior a conta não fecha, e
    // com in/out/adjust genéricos o gestor não distingue uma entrada de nota
    // de um acerto de inventário.
    if (!stepApplied(9)) {
      markStep(9);
      addColumn('core_stock_movements', 'kind', 'TEXT');
      addColumn('core_stock_movements', 'quantity_before', 'REAL');
      addColumn('core_stock_movements', 'reserved_before', 'REAL');
      addColumn('core_stock_movements', 'reserved_delta', 'REAL NOT NULL DEFAULT 0');
      addColumn('core_stock_movements', 'reserved_after', 'REAL');
      addColumn('core_stock_movements', 'document_number', 'TEXT');
      addColumn('core_stock_movements', 'workshop_id', 'TEXT REFERENCES core_workshops(id)');
      addColumn('core_stock_movements', 'reason', 'TEXT');

      // Movimentos que já existem ganham o saldo anterior por reconstrução
      // (posterior - delta) e a semântica deduzida da referência. É a melhor
      // verdade disponível: um histórico derivado serve ao gestor; coluna
      // vazia, não.
      getConnection().exec(`
        UPDATE core_stock_movements
           SET quantity_before = balance_after - quantity
         WHERE quantity_before IS NULL;

        UPDATE core_stock_movements
           SET kind = CASE reference_type
             WHEN 'sale'            THEN 'SALE'
             WHEN 'sale_cancel'     THEN 'SALE_CANCEL'
             WHEN 'nfe_entrada'     THEN 'XML_RECEIPT'
             WHEN 'service_order'   THEN 'WORKSHOP_PART_CONSUMPTION'
             WHEN 'ecommerce_order' THEN 'ECOMMERCE_CONSUMPTION'
             WHEN 'entrada'         THEN 'MANUAL_ENTRY'
             ELSE CASE
               WHEN movement_type = 'in'  THEN 'MANUAL_ENTRY'
               WHEN movement_type = 'out' THEN 'MANUAL_EXIT'
               WHEN quantity < 0 THEN 'INVENTORY_ADJUSTMENT_NEGATIVE'
               ELSE 'INVENTORY_ADJUSTMENT_POSITIVE'
             END
           END
         WHERE kind IS NULL;
      `);

      // O índice entra AQUI, depois do ALTER — na DDL canônica ele quebraria a
      // subida de qualquer banco existente, porque `ensureCoreSchema` roda
      // antes das migrations e a coluna ainda não existiria.
      getConnection().exec(
        'CREATE INDEX IF NOT EXISTS ix_stock_movements_kind ON core_stock_movements (company_id, kind, created_at);',
      );
    }

    // v9 -> v10: cadastro de produto completo — subcategoria, descrição de
    // vitrine e galeria de fotos.
    if (!stepApplied(10)) {
      markStep(10);
      addColumn('core_products', 'subcategory', 'TEXT');
      addColumn('core_products', 'online_description', 'TEXT');
      // A tabela de imagens é nova, então ensureCoreSchema já a criou; o passo
      // existe para marcar o banco antigo corretamente.
    }

    // v10 -> v11: fila de impressão e impressoras por operação. Tabelas novas,
    // já criadas por ensureCoreSchema; o passo marca o banco antigo.
    if (!stepApplied(11)) {
      markStep(11);
    }

    // v11 -> v12: caixa de entrada de XML por e-mail. Tabelas novas, criadas
    // por ensureCoreSchema; o passo marca o banco antigo.
    if (!stepApplied(12)) {
      markStep(12);
    }

    // v12 -> v13: vocabulário de categorias e marcas.
    //
    // As tabelas são novas (ensureCoreSchema já as criou). O passo existe para
    // SEMEAR o vocabulário com o que já está escrito nos produtos — sem isso a
    // tela abriria vazia e o gestor teria que redigitar tudo que já existe.
    if (!stepApplied(13)) {
      markStep(13);
      const db = getConnection();
      const agora = new Date().toISOString();

      // Categorias raiz distintas, ignorando maiúsculas: se o catálogo já tem
      // "Masculino" e "masculino", entra UMA e o gestor decide qual fica.
      db.exec(`
        INSERT OR IGNORE INTO core_categories (id, company_id, name, parent_id, active, created_at, updated_at)
        SELECT lower(hex(randomblob(16))), company_id, MIN(category), NULL, 1, '${agora}', '${agora}'
          FROM core_products
         WHERE category IS NOT NULL AND trim(category) <> ''
         GROUP BY company_id, lower(trim(category));
      `);

      // Subcategorias, penduradas na categoria correspondente.
      db.exec(`
        INSERT OR IGNORE INTO core_categories (id, company_id, name, parent_id, active, created_at, updated_at)
        SELECT lower(hex(randomblob(16))), p.company_id, MIN(p.subcategory), c.id, 1, '${agora}', '${agora}'
          FROM core_products p
          JOIN core_categories c
            ON c.company_id = p.company_id
           AND c.parent_id IS NULL
           AND lower(trim(c.name)) = lower(trim(p.category))
         WHERE p.subcategory IS NOT NULL AND trim(p.subcategory) <> ''
         GROUP BY p.company_id, c.id, lower(trim(p.subcategory));
      `);

      db.exec(`
        INSERT OR IGNORE INTO core_brands (id, company_id, name, active, created_at, updated_at)
        SELECT lower(hex(randomblob(16))), company_id, MIN(brand), 1, '${agora}', '${agora}'
          FROM core_products
         WHERE brand IS NOT NULL AND trim(brand) <> ''
         GROUP BY company_id, lower(trim(brand));
      `);
    }

    // v13 -> v14: leitura automática da caixa de e-mail.
    if (!stepApplied(14)) {
      markStep(14);
      addColumn('core_mail_inboxes', 'auto_enabled', 'INTEGER NOT NULL DEFAULT 0');
      addColumn('core_mail_inboxes', 'interval_minutes', 'INTEGER NOT NULL DEFAULT 5');
      addColumn('core_mail_inboxes', 'next_run_at', 'TEXT');
      addColumn('core_mail_inboxes', 'locked_until', 'TEXT');
      addColumn('core_mail_inboxes', 'locked_by', 'TEXT');
      addColumn('core_mail_inboxes', 'last_run_at', 'TEXT');
      addColumn('core_mail_inboxes', 'last_success_at', 'TEXT');
      addColumn('core_mail_inboxes', 'last_error_at', 'TEXT');
      addColumn('core_mail_inboxes', 'last_result', 'TEXT');
    }

    // Gestão de equipe: senha inicial e último acesso.
    //
    // `must_change_password` nasce 0 para quem já existe — forçar troca em
    // toda a base numa atualização trancaria o time inteiro para fora de uma
    // vez. Só a senha definida por um gestor nasce marcada.
    //
    // `last_login_at` fica no usuário e não é derivado de core_login_attempts:
    // aquela tabela é expurgável por ser controle de força bruta, e perder o
    // histórico de tentativas não pode apagar o "sumiu há seis meses" que o
    // gestor usa para desativar conta esquecida.
    if (!stepApplied(15)) {
      markStep(15);
      addColumn('core_users', 'must_change_password', 'INTEGER NOT NULL DEFAULT 0');
      addColumn('core_users', 'last_login_at', 'TEXT');
    }

    // Contas a pagar precisam apontar para o FORNECEDOR. Até aqui o único
    // contraparte no lançamento era `customer_id`, que serve para o que se
    // recebe e não diz nada sobre o que se paga.
    //
    // `reversed_at` marca o estorno no lançamento; a baixa estornada continua
    // na tabela de baixas, com a contrapartida negativa. Apagar a linha faria
    // o extrato do mês fechar diferente do que fechou no dia.
    if (!stepApplied(16)) {
      markStep(16);
      addColumn('core_finance_entries', 'supplier_id', 'TEXT REFERENCES core_suppliers(id)');
      addColumn('core_finance_settlements', 'reversed_at', 'TEXT');
      addColumn('core_finance_settlements', 'reverses_id', 'TEXT');
      getConnection().exec(
        `CREATE INDEX IF NOT EXISTS ix_finance_entries_due
           ON core_finance_entries (company_id, direction, status, due_date);`,
      );
    }

    // Domínio fiscal. As tabelas em si vêm do `ensureCoreSchema` (CREATE TABLE
    // IF NOT EXISTS roda em banco novo e antigo); o passo existe para o caso de
    // um banco antigo precisar delas antes do próximo restart, e para deixar a
    // marca registrada.
    if (!stepApplied(17)) {
      markStep(17);
      ensureCoreSchema();
    }

    // Contexto da contingência. `contingency_mode` sozinho não responde as
    // perguntas que importam depois: POR QUE entrou, DESDE QUANDO, e se ainda
    // falta transmitir. Sem o motivo, um documento em contingência vira um
    // mistério na auditoria meses depois.
    if (!stepApplied(18)) {
      markStep(18);
      addColumn('core_fiscal_documents', 'contingency_reason', 'TEXT');
      addColumn('core_fiscal_documents', 'contingency_started_at', 'TEXT');
      addColumn('core_fiscal_documents', 'contingency_ended_at', 'TEXT');
      addColumn('core_fiscal_documents', 'pending_transmission', 'INTEGER NOT NULL DEFAULT 0');
      addColumn('core_fiscal_documents', 'trigger_code', 'TEXT');
    }

    // Destinatário da NF-e.
    //
    // Até aqui o nome só existia dentro do XML, e a tela mostrava o cliente da
    // VENDA — que na NF-e de atacado costuma ser vazio, e aparecia como
    // "Consumidor". Uma nota modelo 55 tem destinatário obrigatório: dizer
    // "Consumidor" na lista fiscal é informação errada, não informação faltando.
    if (!stepApplied(19)) {
      markStep(19);
      addColumn('core_fiscal_documents', 'recipient_name', 'TEXT');
      addColumn('core_fiscal_documents', 'recipient_document', 'TEXT');
    }

    // Ponte cliente do ERP <-> cliente do Asaas. A tabela nasce do
    // `ensureCoreSchema`; o passo existe para o banco que já rodava antes dela
    // e para deixar a marca registrada.
    if (!stepApplied(20)) {
      markStep(20);
      ensureCoreSchema();
    }

    // Peso e dimensões do produto. Sem eles a cotação de frete usava 500 g e
    // uma caixa inventada — preço que o transportador não cobra.
    if (!stepApplied(21)) {
      markStep(21);
      addColumn('core_products', 'weight_grams', 'INTEGER');
      addColumn('core_products', 'height_cm', 'REAL');
      addColumn('core_products', 'width_cm', 'REAL');
      addColumn('core_products', 'length_cm', 'REAL');
    }

    // Portal do cliente: conta, vínculo com os cadastros e sessão própria.
    // As tabelas nascem do `ensureCoreSchema`; o passo existe para banco que
    // já rodava antes delas e para deixar a marca registrada.
    if (!stepApplied(22)) {
      markStep(22);
      ensureCoreSchema();
    }

    // Fila de saída para o banco central. A tabela nasce do `ensureCoreSchema`;
    // o passo existe para o banco que já rodava antes dela e para deixar a
    // marca registrada.
    //
    // Bancos que já operavam começam com o outbox VAZIO — de propósito. Este
    // passo não varre o histórico para enfileirar tudo o que já aconteceu: a
    // carga inicial da central é um trabalho à parte, com conferência, e não
    // algo que uma migração dispara sozinha no meio de um expediente.
    if (!stepApplied(23)) {
      markStep(23);
      ensureCoreSchema();
    }

    // Envelope padronizado e versionado do evento.
    //
    // O passo 23 criou a fila com um formato ainda cru ("tabela/linha"). Aqui
    // ela passa a carregar FATO DE NEGÓCIO — tipo do evento, agregado, unidade
    // operacional — e, principalmente, `schema_version`: sem versão no
    // envelope, evoluir o payload depois quebraria a leitura de todo evento
    // antigo que ainda estivesse na fila.
    //
    // A fila nasceu vazia no passo 23 e continua vazia nos bancos reais, então
    // não há evento com o formato velho para converter. As colunas entram como
    // anuláveis ou com DEFAULT, que é o que o SQLite aceita em ALTER.
    if (!stepApplied(24)) {
      markStep(24);
      addColumn('core_outbox', 'event_type', 'TEXT');
      addColumn('core_outbox', 'aggregate_type', 'TEXT');
      addColumn('core_outbox', 'aggregate_id', 'TEXT');
      addColumn('core_outbox', 'operational_unit_id', 'TEXT');
      addColumn('core_outbox', 'schema_version', 'INTEGER NOT NULL DEFAULT 1');
      addColumn('core_outbox', 'status', "TEXT NOT NULL DEFAULT 'pending'");
      // Os índices vivem AQUI e não na DDL canônica: eles cobrem colunas que
      // este passo acabou de adicionar.
      getConnection().exec(
        `CREATE INDEX IF NOT EXISTS ix_outbox_pending
           ON core_outbox (status, seq);
         CREATE INDEX IF NOT EXISTS ix_outbox_aggregate
           ON core_outbox (aggregate_type, aggregate_id, seq);
         CREATE INDEX IF NOT EXISTS ix_outbox_company
           ON core_outbox (company_id, seq);`,
      );
    }

    // CORREÇÃO do passo 24 — entra como passo novo porque passo aplicado é
    // imutável (ver o cabeçalho deste arquivo).
    //
    // O passo 24 ADICIONOU as colunas do envelope, mas não conseguiu remover
    // as antigas: `entity_type` e `entity_id` nasceram NOT NULL no passo 23 e
    // o SQLite não afrouxa constraint por ALTER. Resultado: num banco que
    // passou pela v23, TODA VENDA falharia com "NOT NULL constraint failed:
    // core_outbox.entity_type" — o INSERT novo não preenche essas colunas.
    //
    // Não apareceu na suíte porque banco de teste nasce do DDL canônico, já
    // sem elas. Só o banco que viveu a v23 tinha o problema; foi encontrado
    // aplicando a migração no banco operacional real.
    //
    // A tabela é reconstruída. Ela nasceu vazia no passo 23 e as linhas que
    // porventura existam são copiadas para o formato novo — evento de venda
    // não se regenera, então nada é descartado.
    if (!stepApplied(25)) {
      markStep(25);
      const db25 = getConnection();
      if (tableExists('core_outbox') && columns('core_outbox').has('entity_type')) {
        db25.exec('ALTER TABLE core_outbox RENAME TO core_outbox_v23;');
        // Recria no formato canônico. `ready` do ensureCoreSchema já está
        // marcado nesta partida, então a DDL é executada diretamente.
        for (const statement of STATEMENTS) {
          if (statement.includes('core_outbox')) db25.exec(statement);
        }
        db25.exec(
          `INSERT INTO core_outbox
             (seq, id, node_id, event_type, aggregate_type, aggregate_id, company_id,
              operational_unit_id, operation, schema_version, payload, occurred_at,
              status, attempts, next_attempt_at, last_error, sent_at, created_at)
           SELECT seq, id, node_id,
                  COALESCE(event_type, entity_type),
                  COALESCE(aggregate_type, entity_type),
                  COALESCE(aggregate_id, entity_id),
                  company_id, operational_unit_id, operation,
                  COALESCE(schema_version, 1), payload, occurred_at,
                  COALESCE(status, CASE WHEN sent_at IS NULL THEN 'pending' ELSE 'synced' END),
                  attempts, next_attempt_at, last_error, sent_at, created_at
             FROM core_outbox_v23;`,
        );
        db25.exec('DROP TABLE core_outbox_v23;');
        db25.exec(
          `CREATE INDEX IF NOT EXISTS ix_outbox_pending
             ON core_outbox (status, seq);
           CREATE INDEX IF NOT EXISTS ix_outbox_aggregate
             ON core_outbox (aggregate_type, aggregate_id, seq);
           CREATE INDEX IF NOT EXISTS ix_outbox_company
             ON core_outbox (company_id, seq);`,
        );
      }
    }

    // Conferência da entrada por XML.
    //
    // Até aqui a nota entrava no estoque pela quantidade do ARQUIVO. Quando o
    // fornecedor mandava 10 e chegavam 8, o sistema dava entrada de 10 — e o
    // saldo passava a mentir sobre a prateleira, sem ninguém perceber até a
    // próxima contagem.
    if (!stepApplied(26)) {
      markStep(26);
      addColumn('core_inbound_note_items', 'received_quantity', 'REAL');
      addColumn('core_inbound_note_items', 'divergence_note', 'TEXT');
    }

    // Endereços salvos do cliente. A tabela nasce do ensureCoreSchema; o passo
    // existe para o banco que já rodava antes dela e para deixar a marca.
    if (!stepApplied(27)) {
      markStep(27);
      ensureCoreSchema();
    }

    // Avaliações de produto. A tabela nasce do ensureCoreSchema; o passo marca
    // bancos que já rodavam.
    if (!stepApplied(28)) {
      markStep(28);
      ensureCoreSchema();
    }

    // Entrega no checkout da loja.
    //
    // Até aqui o pedido online guardava `shipping_cents` vindo do CORPO DA
    // REQUISIÇÃO e `shipping_method` nulo. Duas consequências: o cliente podia
    // definir o próprio frete, e todo pedido nascia como "entrega" com frete
    // zero — a operação pagava o envio de cada venda sem nunca ter cobrado.
    //
    // As colunas novas guardam O QUE FOI VENDIDO ao cliente: o nome do serviço,
    // o prazo prometido e SE aquele prazo veio de transportadora real. Sem a
    // última coluna não há como distinguir prazo cotado de prazo simulado
    // depois do fato — e prometer data de entrega inventada é dívida com o
    // cliente.
    if (!stepApplied(29)) {
      markStep(29);
      ensureCoreSchema();
      addColumn('core_orders', 'shipping_service_name', 'TEXT');
      addColumn('core_orders', 'shipping_estimated_days', 'INTEGER');
      addColumn('core_orders', 'shipping_quote_real', 'INTEGER NOT NULL DEFAULT 0');
    }

    // COMPRAS: fornecedor que serve para comprar, e pedido de compra.
    //
    // O fornecedor existia como subproduto da importação de XML — nome e
    // documento, o suficiente para a nota ter origem e nada mais. Comprar exige
    // saber em quantos dias ele entrega e em quantos se paga; sem isso não há
    // como planejar reposição nem prever o caixa.
    //
    // As tabelas de pedido nascem do `ensureCoreSchema`. O que precisa de ALTER
    // é o que se acrescenta a tabela existente: as colunas do fornecedor e o
    // vínculo da nota com o pedido que ela atende.
    if (!stepApplied(30)) {
      markStep(30);
      ensureCoreSchema();
      addColumn('core_suppliers', 'trade_name', 'TEXT');
      addColumn('core_suppliers', 'state_registration', 'TEXT');
      addColumn('core_suppliers', 'contact_name', 'TEXT');
      addColumn('core_suppliers', 'zip', 'TEXT');
      addColumn('core_suppliers', 'street', 'TEXT');
      addColumn('core_suppliers', 'number', 'TEXT');
      addColumn('core_suppliers', 'complement', 'TEXT');
      addColumn('core_suppliers', 'district', 'TEXT');
      addColumn('core_suppliers', 'city', 'TEXT');
      addColumn('core_suppliers', 'state', 'TEXT');
      addColumn('core_suppliers', 'payment_term_days', 'INTEGER NOT NULL DEFAULT 0');
      addColumn('core_suppliers', 'delivery_days', 'INTEGER NOT NULL DEFAULT 0');
      addColumn('core_suppliers', 'notes', 'TEXT');
      addColumn('core_suppliers', 'active', 'INTEGER NOT NULL DEFAULT 1');
      addColumn('core_suppliers', 'updated_at', 'TEXT');
      addColumn('core_inbound_notes', 'purchase_order_id', 'TEXT');
    }

    // DEVOLUÇÃO de venda.
    //
    // O cancelamento já existia e desfaz a venda inteira. Faltava o caso mais
    // comum do varejo: o cliente volta dias depois com parte da mercadoria. A
    // venda continua tendo acontecido — está no fechamento do mês e na
    // comissão paga —, então a devolução é registro NOVO, nunca alteração dela.
    //
    // As duas tabelas nascem do `ensureCoreSchema`; o passo marca os bancos que
    // já existiam.
    if (!stepApplied(31)) {
      markStep(31);
      ensureCoreSchema();
    }

    // INVENTÁRIO: contagem e acerto.
    //
    // A razão de estoque já tinha os tipos semânticos
    // (INVENTORY_ADJUSTMENT_POSITIVE/NEGATIVE, INVENTORY_COUNT); faltava o
    // domínio da contagem, que é o que dá origem e rastro ao acerto. As tabelas
    // nascem do `ensureCoreSchema`.
    if (!stepApplied(32)) {
      markStep(32);
      ensureCoreSchema();
    }

    // CRM no núcleo: lead e oportunidade.
    //
    // Existia um CRM sobre a camada de coleções, com id derivado de
    // `Date.now()` e nenhum vínculo com o cadastro de clientes. Lead que vira
    // cliente precisa apontar para `core_customers`, senão o mesmo comprador
    // passa a existir duas vezes — e todo relatório por cliente conta errado.
    if (!stepApplied(33)) {
      markStep(33);
      ensureCoreSchema();
    }

    // FIDELIDADE: programa e razão de pontos.
    //
    // Ponto acumulado é dívida da loja, não receita — por isso tem razão
    // própria e não encosta no financeiro. As tabelas nascem do
    // `ensureCoreSchema`.
    if (!stepApplied(34)) {
      markStep(34);
      ensureCoreSchema();
    }

    // LOCAÇÃO: contrato e itens.
    //
    // Locar reserva estoque em vez de dar baixa — o bem continua sendo da loja
    // e volta. As tabelas nascem do `ensureCoreSchema`.
    if (!stepApplied(35)) {
      markStep(35);
      ensureCoreSchema();
    }

    // PEÇAS: devolução do que foi requisitado e não usado.
    //
    // `WORKSHOP_PART_RETURN` existia como rótulo desde sempre, sem escritor.
    // Faltava onde guardar quanto de cada peça voltou.
    if (!stepApplied(36)) {
      markStep(36);
      ensureCoreSchema();
      addColumn('core_service_order_parts', 'returned_quantity', 'REAL NOT NULL DEFAULT 0');
    }

    // CONCILIAÇÃO BANCÁRIA: extrato importado e o casamento com as baixas.
    //
    // É a terceira verdade sobre o mesmo dinheiro — a venda, o financeiro e o
    // banco. As tabelas nascem do `ensureCoreSchema`.
    if (!stepApplied(37)) {
      markStep(37);
      ensureCoreSchema();
    }

    // ADMINISTRAÇÃO DA LOJA ONLINE.
    //
    // A vitrine mostrava só o nome fantasia e a contagem de produtos: as seis
    // lojas apareciam iguais. Falta identidade por operação, e o destaque de
    // produto — que fica NO produto, não numa lista paralela.
    if (!stepApplied(38)) {
      markStep(38);
      ensureCoreSchema();
      addColumn('core_products', 'featured_online', 'INTEGER NOT NULL DEFAULT 0');
    }

    // NOTA FISCAL DO PEDIDO ONLINE.
    //
    // O documento fiscal só sabia apontar para uma VENDA. Pedido não é venda —
    // tem financeiro próprio, lançado quando o pagamento entrou —, e converter
    // pedido em venda só para caber na coluna lançaria a mesma receita duas
    // vezes. Daí a coluna própria: o documento aponta para o fato que existe.
    if (!stepApplied(39)) {
      markStep(39);
      ensureCoreSchema();
      addColumn('core_fiscal_documents', 'order_id', 'TEXT REFERENCES core_orders(id)');
      // O índice vem junto do passo, e não da DDL canônica: lá ele rodaria
      // antes da coluna existir.
      db.exec(
        'CREATE INDEX IF NOT EXISTS ix_fiscal_docs_order ON core_fiscal_documents (order_id);',
      );

      // E o endereço do cliente ganha o código IBGE do município.
      //
      // O endereço já era estruturado — CEP, rua, número, bairro, cidade, UF —,
      // e ainda assim não servia para a nota: a NF-e identifica o município do
      // destinatário pelo código de 7 dígitos, não pelo nome. Sem ele o cadastro
      // do e-commerce serve para ENTREGAR e não serve para FATURAR, que é
      // exatamente a metade que faltava.
      addColumn('core_customer_addresses', 'city_ibge', 'TEXT');
    }

    // CATÁLOGO COMPLETO: auxiliares, preço mínimo e kit.
    //
    // O cadastro de produto tinha custo e preço, e nada entre os dois: quem
    // precificava fazia a conta de cabeça e não havia onde dizer "abaixo disto
    // não vende". As tabelas novas (unidade, grupo tributário, alíquota,
    // tabela de preços, códigos adicionais, componentes de kit) nascem do
    // `ensureCoreSchema`; aqui entram só as colunas do produto.
    //
    // MARKUP E MARGEM NÃO SÃO COLUNAS, DE PROPÓSITO.
    //
    // Os dois derivam de custo e preço. Guardados, viram uma segunda verdade
    // que diverge no primeiro reajuste — e aí a tela mostra margem de 40%
    // sobre um preço que já mudou. O que se guarda é o MÍNIMO, que é política
    // e não conta: o valor abaixo do qual aquele produto não deve ser vendido.
    if (!stepApplied(40)) {
      markStep(40);
      ensureCoreSchema();
      addColumn('core_products', 'reference', 'TEXT');
      addColumn('core_products', 'min_price_cents', 'INTEGER NOT NULL DEFAULT 0');
      addColumn('core_products', 'min_markup_percent', 'REAL');
      addColumn('core_products', 'min_margin_percent', 'REAL');
      // Preço aberto: o valor é digitado na venda, não vem do cadastro. Serve
      // para serviço e para o que se vende a peso combinado no balcão.
      addColumn('core_products', 'open_price', 'INTEGER NOT NULL DEFAULT 0');
      // Kit. `explode_on_sale` decide se a venda registra o kit ou as peças:
      // desmembrar dá baixa correta no estoque de cada componente, e é o
      // padrão. Não desmembrar só faz sentido quando o kit tem estoque próprio.
      addColumn('core_products', 'is_kit', 'INTEGER NOT NULL DEFAULT 0');
      addColumn('core_products', 'kit_explode_on_sale', 'INTEGER NOT NULL DEFAULT 1');
      addColumn('core_products', 'kit_cost_from_components', 'INTEGER NOT NULL DEFAULT 0');
    }

    // LOCAIS DE ESTOQUE.
    //
    // O local entra como dimensão do RAZÃO, e não da chave de `core_stock`.
    // Pôr o local na chave do saldo mudaria o significado do
    // `CHECK (quantity >= 0)` — de "o total nunca fica negativo" para "nenhum
    // local fica negativo" — e obrigaria a revisar os vinte pontos que leem
    // saldo, o projetor da central e o espelho do bootstrap.
    //
    // Assim `core_stock` fica intocado, o invariante é o mesmo, e o saldo por
    // local sai da soma dos movimentos: uma fonte de verdade só.
    //
    // `location_id` nulo é o local PADRÃO. Todo movimento anterior a esta
    // coluna continua válido e é lido como do padrão — nenhum registro
    // histórico precisa ser reescrito.
    if (!stepApplied(41)) {
      markStep(41);
      ensureCoreSchema();
      addColumn(
        'core_stock_movements',
        'location_id',
        'TEXT REFERENCES core_stock_locations(id)',
      );
      // O índice vem junto do passo, e não da DDL canônica: lá ele rodaria
      // antes da coluna existir.
      db.exec(
        `CREATE INDEX IF NOT EXISTS ix_stock_movements_location
           ON core_stock_movements (company_id, location_id, product_id);`,
      );
    }

    // BALANÇA: produto pesável, PLU e tara.
    //
    // `weighable` e `plu_code` são separados de propósito. Pesável é natureza
    // do produto; PLU é o número que ESTA balança usa para achá-lo. Existe
    // pesável ainda não cadastrado na balança, e tratá-los como a mesma coisa
    // faria o arquivo de exportação sair com linha em branco no lugar do
    // código — que a balança recusa sem dizer por quê.
    if (!stepApplied(42)) {
      markStep(42);
      ensureCoreSchema();
      addColumn('core_products', 'weighable', 'INTEGER NOT NULL DEFAULT 0');
      addColumn('core_products', 'plu_code', 'TEXT');
      addColumn('core_products', 'tare_grams', 'INTEGER');
      // O índice vem junto do passo, e não da DDL canônica: lá ele rodaria
      // antes da coluna existir. Parcial em `plu_code IS NOT NULL` porque a
      // esmagadora maioria dos produtos não tem PLU, e no SQLite vários NULL
      // não colidem em índice único — mas ser explícito evita a dúvida.
      db.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS ux_products_company_plu
           ON core_products (company_id, plu_code) WHERE plu_code IS NOT NULL;`,
      );
    }

    // ESTOQUE SERIALIZADO.
    //
    // A tabela `core_product_units` nasce do próprio `ensureCoreSchema` — ela é
    // nova, então o CREATE TABLE da DDL canônica a cria de fato, junto dos
    // índices. Aqui só entra a coluna do produto, que é acréscimo a uma tabela
    // que já existe.
    //
    // Não há índice sobre `serialized`: é booleano de baixa cardinalidade, e o
    // filtro sempre vem acompanhado de company_id, que já tem índice.
    if (!stepApplied(43)) {
      markStep(43);
      ensureCoreSchema();
      addColumn('core_products', 'serialized', 'INTEGER NOT NULL DEFAULT 0');
    }

    // FINANCEIRO — FUNDAÇÃO. A tabela do razão abre aqui, uma vez.
    //
    // `ensureCoreSchema` cria as três tabelas novas (categorias, centros de
    // custo, contas). A reconstrução vem DEPOIS delas, porque as chaves
    // estrangeiras do lançamento apontam para as três — reconstruir antes
    // deixaria referência para tabela inexistente.
    // A RECONSTRUÇÃO NÃO MORA AQUI. Ela roda fora da transação geral, junto
    // do passo 8 — ver o bloco de reconstruções lá em cima e o porquê. Aqui
    // fica só a criação das três tabelas novas.
    if (!stepApplied(44)) {
      markStep(44);
      ensureCoreSchema();
    }

    // COMISSÕES. As cinco tabelas são novas, então `ensureCoreSchema` as cria
    // por inteiro, com índices e constraints. Nenhuma coluna é acrescentada a
    // tabela existente, e NENHUM backfill é feito: todo `seller_id` gravado
    // até hoje é o operador de caixa, não o vendedor. Apurar o passado pagaria
    // sistematicamente a pessoa errada, com dinheiro real.
    if (!stepApplied(45)) {
      markStep(45);
      ensureCoreSchema();
    }

    // OPERADORA DE CARTÃO: taxa e prazo. As duas tabelas são novas, então
    // `ensureCoreSchema` as cria por inteiro. Nenhuma venda antiga é
    // reprocessada — a venda no cartão de ontem continua registrada como
    // estava, e o comportamento novo vale da primeira venda com operadora
    // cadastrada em diante.
    if (!stepApplied(46)) {
      markStep(46);
      ensureCoreSchema();
    }

    /*
      v50 -> v51: o convite do portal, entregue no balcão.

      Três colunas em `core_customers`, todas nullable — `reconcileCoreSchema`
      pula em silêncio coluna NOT NULL sem DEFAULT, e ela nunca chegaria ao
      banco que já existe.

      O índice fica AQUI e não na DDL canônica: a coluna só passa a existir
      depois deste ALTER, e a lista canônica roda ANTES das migrações. Índice
      sobre coluna nova na DDL derruba a subida de todo banco existente com
      "no such column" — já aconteceu duas vezes neste projeto.

      A tabela `core_service_requests` NÃO precisa de passo: ela nasce inteira
      na DDL canônica, e `ensureCoreSchema` roda a cada boot com CREATE TABLE
      IF NOT EXISTS.
    */
    if (!stepApplied(51)) {
      markStep(51);
      addColumn('core_customers', 'portal_invite_hash', 'TEXT');
      addColumn('core_customers', 'portal_invite_expires_at', 'TEXT');
      addColumn('core_customers', 'portal_invite_used_at', 'TEXT');
      db.exec(
        `CREATE INDEX IF NOT EXISTS ix_customers_portal_invite
           ON core_customers (portal_invite_hash);`,
      );
    }

    /*
      v51 -> v52: a plaquinha ganha identidade única, porque agora ela vai
      casar com a UNIDADE de estoque.

      A moto que a PJ Motors vende e a moto que a Oficina monta são a MESMA
      moto física, e o que prova isso é o número de chassi. Só que
      core_equipment nunca teve unicidade nenhuma de identidade — tem índice de
      oficina e de dono, e nada mais. Enquanto o chassi era texto de conferência
      humana isso passava; a partir do momento em que ele vira a chave que liga
      unidade e plaquinha, dois equipamentos com o mesmo chassi na mesma empresa
      viram duas respostas para "de quem é esta moto".

      POR QUE OS ÍNDICES MORAM AQUI E NÃO NA DDL CANÔNICA DE schema.ts

      A lista canônica roda a CADA subida, e roda ANTES das migrações. Um
      CREATE UNIQUE INDEX sobre dado que JÁ EXISTE não é criação de estrutura
      vazia: ele VALIDA a tabela inteira na hora, e estoura se houver duplicata.
      Posto lá, o banco travaria na subida sem NUNCA chegar na migração que
      limpa as duplicatas — e o remédio ficaria atrás da porta que o próprio
      problema trancou. O índice depende da limpeza, então mora junto com ela,
      depois dela, na mesma transação.

      O DESEMPATE, e onde a memória fica

      Fica com o chassi o equipamento MAIS ANTIGO por created_at: quem chegou
      primeiro registrou a moto: a segunda linha é a redigitação. Os demais
      perdem o chassi do campo e ganham uma linha em core_equipment_events com o
      número removido. A memória vive no evento append-only, nunca no campo
      mutável — o campo é o que o sistema afirma HOJE, o evento é o que
      aconteceu, e apagar sem registrar deixaria a oficina sem como reconstruir
      de onde o número saiu.
    */
    if (!stepApplied(52)) {
      markStep(52);

      // Chassi vazio não é chassi. String vazia e ausência são coisas
      // diferentes, e aqui a diferença é fatal: o índice é parcial em
      // chassis IS NOT NULL, então '' ENTRA no índice e duas linhas em branco
      // colidem entre si. É a mesma limpeza que o passo 49 fez na placa da OS.
      // Não gera evento: string vazia não carrega número nenhum para lembrar.
      db.prepare(
        "UPDATE core_equipment SET chassis = NULL WHERE chassis IS NOT NULL AND TRIM(chassis) = ''",
      ).run();

      /*
        Quem perde o chassi é quem TEM um gêmeo mais antigo. A comparação é
        exata — sem TRIM, sem UPPER — de propósito: é exatamente o que o índice
        único vai comparar depois. Desempatar por um critério mais frouxo do que
        o do índice apagaria dado à toa; por um mais rígido, deixaria passar
        duplicata e o CREATE lá embaixo estouraria.

        O desempate secundário por id existe para o caso de created_at empatado
        — sem ele, duas linhas seriam ambas "a mais nova" e ambas perderiam o
        número, deixando o chassi órfão de dono.
      */
      const perdemOChassi = db
        .prepare(
          `SELECT e.id AS id, e.company_id AS company_id, e.chassis AS chassis
             FROM core_equipment e
            WHERE e.chassis IS NOT NULL
              AND EXISTS (
                SELECT 1
                  FROM core_equipment anterior
                 WHERE anterior.company_id = e.company_id
                   AND anterior.chassis = e.chassis
                   AND (anterior.created_at < e.created_at
                        OR (anterior.created_at = e.created_at AND anterior.id < e.id))
              )`,
        )
        .all() as Array<{ id: string; company_id: string; chassis: string }>;

      const registraRemocao = db.prepare(
        `INSERT INTO core_equipment_events
           (id, equipment_id, company_id, event_type, description, user_id, order_id, created_at)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)`,
      );
      // user_id e order_id nulos: quem fez isto foi a migração, não uma pessoa
      // e não uma ordem de serviço. Inventar um autor seria pior que admitir
      // que não há um.
      const apagaChassi = db.prepare(
        'UPDATE core_equipment SET chassis = NULL, updated_at = ? WHERE id = ?',
      );
      const agora = new Date().toISOString();

      for (const dupe of perdemOChassi) {
        // O evento ENTRA ANTES do UPDATE: se a ordem fosse a inversa e algo
        // falhasse no meio, o número já teria sumido do campo sem ter chegado
        // ao histórico. Aqui dentro os dois vivem na mesma transação, mas a
        // ordem certa não custa nada e não depende disso continuar verdade.
        registraRemocao.run(
          randomUUID(),
          dupe.id,
          dupe.company_id,
          'chassis_removed',
          `Chassi ${dupe.chassis} removido na migração v52: outro equipamento mais antigo desta `
            + 'empresa já registrava o mesmo número. O chassi passa a ser único por empresa.',
          agora,
        );
        apagaChassi.run(agora, dupe.id);
      }

      // A identidade da moto, agora com dono único dentro da empresa. Parcial
      // porque a esmagadora maioria dos equipamentos não tem chassi — celular
      // de oficina de assistência não tem —, e obrigar todos a ter seria
      // inventar dado.
      db.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS ux_equipment_chassis
           ON core_equipment (company_id, chassis) WHERE chassis IS NOT NULL;`,
      );

      // A leitura que a loja vai fazer: "quais plaquinhas nasceram de uma moto
      // MINHA, e qual o estado de venda delas". origin_company_id é a coluna
      // que existe desde sempre e que nenhuma tela jamais preencheu; a partir
      // desta rodada ela passa a ser escrita, e a consulta que cruza empresa
      // filtra por ela junto de sale_status. As duas juntas, na ordem em que a
      // consulta pergunta.
      db.exec(
        `CREATE INDEX IF NOT EXISTS ix_equipment_origin
           ON core_equipment (origin_company_id, sale_status);`,
      );
    }

    /*
      v52 -> v53: a política do balcão ganha onde morar.

      core_sale_policies nasce INTEIRA na DDL canônica de schema.ts, como
      core_inbound_configs e as outras três tabelas de configuração por
      empresa. Tabela nova sem coluna em tabela antiga não precisa de ALTER
      nenhum: ensureCoreSchema roda a cada subida com CREATE TABLE IF NOT
      EXISTS, e o banco que já existe recebe a tabela vazia ali mesmo.

      ENTÃO POR QUE ESTE PASSO EXISTE, se ele não altera nada?

      Porque CORE_TARGET_VERSION e o número do ÚLTIMO passo têm que ser o mesmo
      número — está escrito lá em cima, e o motivo é caro: haPassoPendente
      varre de 2 até o alvo, e um alvo maior que o último passo existente cria
      um passo fantasma que nunca é marcado. Com ele, TODO restart do servidor
      passa a copiar o banco inteiro para server/data/backups. Já aconteceu
      neste projeto, com alvo 39 e último passo 38: dez cópias, três no mesmo
      minuto.

      A chamada a ensureCoreSchema abaixo é cinto e suspensório: hoje ela é
      no-op (migrateCoreSchema já a chamou na primeira linha, e ela tem cache),
      e é de graça. Se um dia a ordem mudar, a tabela ainda assim existe antes
      de qualquer leitor tocá-la. É a mesma forma do passo 46.

      NÃO HÁ DADO PARA MIGRAR, e isso é a definição da tabela e não um acaso:
      nulo significa "o comportamento de hoje". Empresa sem linha aqui vende
      exatamente como vendia ontem — 10% de alçada, fiado vencendo hoje,
      pré-venda com os 7 dias. Preencher linha para as empresas existentes
      seria inventar decisão que o dono não tomou.
    */
    if (!stepApplied(53)) {
      markStep(53);
      ensureCoreSchema();
    }

    /*
      v53 -> v54: a liberação do gestor deixa de valer para sempre, e o
      documento passa a lembrar quanto foi liberado nele.

      TRÊS CONTORNOS REAIS FECHAM AQUI, e os três eram a mesma falha vista de
      ângulos diferentes: a alçada media, mas nada era GUARDADO.

      1. A liberação era conferida por EXISTÊNCIA — id + empresa + ação. Nunca
         era consumida, nunca era vinculada a nada. Um "sim" do gerente na
         terça servia para toda venda de quarta, de clientes diferentes, com
         valores diferentes: bastava o PDV repetir o id.
         `consumed_ref_type/_id/_at` são o consumo. Ficam nulos em toda
         liberação já gravada, e é a verdade: ninguém sabe onde elas foram
         usadas, e inventar um vínculo agora seria escrever ficção na auditoria.

      2. A liberação não tinha VALOR. Liberar 15% e vender com 60% passava.
         `granted_concession_cents` é o teto em dinheiro, e
         `granted_gross_cents` é o bruto contra o qual ele foi dado — sem o
         segundo, o primeiro não vira percentual em relatório nenhum.

      3. O ORÇAMENTO era a porta dos fundos da venda: quem escrevia o preço
         rebaixado num documento e o convertia segundos depois não passava por
         alçada nenhuma. `core_quotes.concession_cents` é o que permite conferir
         na CRIAÇÃO (onde o preço é digitado) e não cobrar de novo na CONVERSÃO
         (onde o cliente está no caixa).

      TODA COLUNA É NULLABLE, e não é preguiça: `reconcileCoreSchema` pula em
      silêncio coluna NOT NULL sem DEFAULT, e ela nunca chegaria ao banco que já
      existe. Aqui, além disso, nulo tem significado próprio — "não declarado",
      que é diferente de zero em cada uma das três.

      Nenhum ALTER em `core_quotes` corre risco de conflitar com a reconstrução
      da chave por tipo: aquela roda ANTES desta transação, e `addColumn` é
      idempotente.
    */
    if (!stepApplied(54)) {
      markStep(54);
      addColumn('core_authorizations', 'granted_concession_cents', 'INTEGER');
      addColumn('core_authorizations', 'granted_gross_cents', 'INTEGER');
      addColumn('core_authorizations', 'consumed_ref_type', 'TEXT');
      addColumn('core_authorizations', 'consumed_ref_id', 'TEXT');
      addColumn('core_authorizations', 'consumed_at', 'TEXT');
      addColumn('core_quotes', 'concession_cents', 'INTEGER');
      addColumn('core_quotes', 'concession_gross_cents', 'INTEGER');
      addColumn('core_quotes', 'authorization_id', 'TEXT');
    }

    /*
      v54 -> v55: a sangria ganha teto, e a alçada deixa de prometer o que não
      cumpre.

      A gaveta não tinha teto. As únicas recusas da sangria eram valor menor ou
      igual a zero e saldo insuficiente — qualquer operador com caixa aberto
      retirava até zerar, e a única testemunha era o movimento que ele mesmo
      lançou. `sangria_especial` estava DECLARADA em RESTRICTED_ACTIONS desde o
      começo e nunca foi exigida em lugar nenhum: era a lista dizendo que havia
      uma tranca ali.

      Nulo = sem teto, e é de propósito. Ligar a trava para as seis operações
      numa migração faria a primeira sangria do dia seguinte ao deploy parar no
      403, em seis lojas ao mesmo tempo, sem ninguém ter pedido. Quem decide o
      número é o dono, na tela — e até ele decidir, nada muda.
    */
    if (!stepApplied(55)) {
      markStep(55);
      addColumn('core_sale_policies', 'cash_withdrawal_limit_cents', 'INTEGER');
    }

    /*
      v55 -> v56: o DRE ganha o que ler — e o cancelamento ganha memória.

      Três coisas acontecem aqui, e as três existem porque a rodada do DRE
      descobriu que o relatório NÃO TERIA O QUE LER se ele nascesse sozinho.

      ------------------------------------------------------------------------
      1. `cancelled_at`: o critério que RESISTE.

      O critério óbvio para o que entra no relatório é `status <> 'cancelled'`,
      e ele não resiste a um cenário de dois cliques. `status` é DERIVADO:
      `aplicarStatus`, em FinanceService, o recalcula a partir do saldo depois
      de cada baixa e de cada estorno. Então:

        cancelar a venda   -> as linhas dela viram status = 'cancelled'
        dar baixa numa delas -> settled_cents sobe, aplicarStatus roda, e o
                                status volta para 'open' ou 'settled'

      Pronto: a receita de uma venda cancelada voltou ao DRE sem ninguém ter
      descancelado nada, e sem nenhum erro na tela. Carimbo de data não se
      recalcula — quem cancelou, cancelou. O relatório passa a perguntar
      `cancelled_at IS NULL`, e o serviço passa a RECUSAR baixa em lançamento
      cancelado, que é a outra metade do conserto.

      O backfill usa COALESCE(settled_at, created_at) porque a data exata do
      cancelamento antigo não existe em lugar nenhum: o que se sabe é que ele
      aconteceu, e é isso que importa para o filtro. Inventar precisão seria
      escrever ficção — o que se grava é a melhor data conhecida, e o critério
      do DRE só olha se a coluna está preenchida.

      ------------------------------------------------------------------------
      2. `competence_date` nula: o lançamento invisível.

      O DRE separa o mês pela competência. Lançamento com competência nula não
      cairia em mês nenhum — sumiria do relatório em silêncio, que é a pior
      forma de um número financeiro errar. Bancos que ganharam a coluna por
      `reconcileCoreSchema` (ALTER, não reconstrução) têm linhas assim.

      A regra do preenchimento é a mesma do `createEntry`: vale o vencimento e,
      na falta dele, o dia em que a linha nasceu.

      O serviço do DRE ainda assim usa COALESCE na leitura. Não é redundância
      boba: a migração conserta o que JÁ EXISTE, e o COALESCE garante que
      nenhum escritor futuro consiga fazer um lançamento desaparecer do
      relatório por esquecimento.

      ------------------------------------------------------------------------
      3. O BACKFILL DA CATEGORIA — e as duas armadilhas que ele desarma.

      PRIMEIRA: no banco real, quatro das seis operações têm ZERO categorias
      cadastradas, e são justamente elas que concentram os lançamentos
      legados. Um UPDATE que buscasse a categoria antes de semeá-la trocaria
      NULL por NULL, não mudaria uma linha, e o passo seria marcado como
      aplicado — a migração verde que não faz nada, exatamente o defeito da
      rodada 9. Por isso `seedSystemCategories` roda ANTES, por empresa.

      SEGUNDA: mapear por `origin_type` sozinho grava categoria errada.
      `origin_type = 'sale'` produz DUAS linhas na mesma origem — a parcela a
      receber ('in') e a taxa da maquininha ('out'). Um mapa por origem
      carimbaria "Venda de mercadoria" na taxa de cartão, isto é, categoria de
      RECEITA num lançamento de SAÍDA, e o DRE mostraria despesa classificada
      como receita. O mapa é por ORIGEM **E** DIREÇÃO.

      `origin_type = 'manual'` fica de fora de propósito: ali não há origem que
      diga para que o dinheiro foi. Essas linhas continuam sem categoria e
      aparecem, contadas e somadas, na ressalva do relatório — que é o
      comportamento honesto.

      E só preenche coluna NULA. Classificação feita por gente nunca é
      sobrescrita por palpite de máquina.
    */
    if (!stepApplied(56)) {
      markStep(56);

      addColumn('core_finance_entries', 'cancelled_at', 'TEXT');

      db.prepare(
        `UPDATE core_finance_entries
            SET cancelled_at = COALESCE(settled_at, created_at)
          WHERE status = 'cancelled' AND cancelled_at IS NULL`,
      ).run();

      db.prepare(
        `UPDATE core_finance_entries
            SET competence_date = COALESCE(due_date, ${diaDaLojaSql('created_at')})
          WHERE competence_date IS NULL`,
      ).run();

      const empresasComLancamento = db
        .prepare('SELECT DISTINCT company_id FROM core_finance_entries WHERE category_id IS NULL')
        .all() as unknown as { company_id: string }[];

      const classificar = db.prepare(
        `UPDATE core_finance_entries
            SET category_id = ?
          WHERE company_id = ? AND category_id IS NULL
            AND origin_type = ? AND direction = ?`,
      );

      for (const { company_id: empresa } of empresasComLancamento) {
        seedSystemCategories(empresa);
        for (const regra of BACKFILL_DE_CATEGORIA) {
          const categoria = db
            .prepare(
              'SELECT id FROM core_finance_categories WHERE company_id = ? AND system_code = ?',
            )
            .get(empresa, regra.code) as { id: string } | undefined;
          if (!categoria) continue;
          classificar.run(categoria.id, empresa, regra.originType, regra.direction);
        }
      }
    }

    /*
      v56 -> v57: a importação de planilha ganha suas duas tabelas.

      ESTE PASSO NÃO TEM TRABALHO PRÓPRIO, e isso é a resposta certa aqui — não
      um esquecimento. `core_import_batches` e `core_import_batch_items` são
      tabelas NOVAS, criadas pela lista canônica de `schema.ts`, que roda ANTES
      das migrações. Quando este passo é alcançado, elas já existem, com os
      índices junto.

      Os índices ficam LÁ, colados ao CREATE TABLE, e não aqui, exatamente
      porque as tabelas são novas: não há banco antigo em que as colunas possam
      faltar. A regra que manda índice para a migração vale para índice sobre
      COLUNA ACRESCENTADA por migração — num banco restaurado de backup
      anterior, o CREATE INDEX estouraria "no such column" e derrubaria a
      subida inteira. É o defeito dos passos 42 e 49, e ele não se aplica a
      tabela que nasce inteira.

      Se este passo não existisse, a versão do banco ficaria em 56 e nada
      quebraria — mas a próxima migração não teria como saber que este ERP já
      tem a importação, e o número da versão deixaria de contar a história.
      `ensureCoreSchema` aqui é cinto e suspensório, na forma do passo 53: hoje
      é no-op com cache, e de graça garante a ordem se ela um dia mudar.

      NÃO HÁ DADO PARA MIGRAR: nenhum lote existia antes de existir a tela que
      os cria. Inventar lote para as empresas atuais seria fabricar histórico.
    */
    if (!stepApplied(57)) {
      markStep(57);
      ensureCoreSchema();
    }

    /*
      v57 -> v58: a nota de entrada passa a GUARDAR o arquivo que a criou.

      O que existia era um funil de mão única. O XML subia, `parseNfeXml` o lia,
      viravam linhas em `core_inbound_notes` e `core_inbound_note_items`, e o
      texto era descartado no fim da requisição. Nenhuma coluna, nenhum
      diretório, nenhum log — o arquivo simplesmente deixava de existir.

      O preço disso só aparece meses depois, na mesa do contador: a escrituração
      da compra sai do XML do fornecedor, e o que o sistema sabia devolver era
      um resumo. No banco real deste ERP há UMA nota recebida, e o arquivo dela
      já se foi. Esta migração não a recupera, e nenhuma outra recuperará — o
      que ela faz é garantir que a segunda nota não tenha o mesmo destino.

      A COLUNA NASCE NULA E FICA NULA para o que já existe, de propósito.
      Preenchê-la com `''` ou com um XML remontado a partir das linhas do banco
      seria a pior saída possível: entregaria ao contador um arquivo com cara de
      original, sem assinatura do fornecedor, indistinguível do verdadeiro. Nulo
      diz "não foi guardado", e a tela de Entrada de Notas conta essa verdade
      usando a data da própria nota.

      Sem trabalho de dado, então — mas o passo existe e é preciso que exista:
      `addColumn` é o que leva a coluna ao banco que JÁ RODA na loja. A lista
      canônica de `schema.ts` só cria tabela que ainda não existe, e
      `core_inbound_notes` existe lá desde a rodada 13.
    */
    if (!stepApplied(58)) {
      markStep(58);
      addColumn('core_inbound_notes', 'xml_original', 'TEXT');
    }

    /*
      v58 -> v59: a tabela de preço passa a valer na venda.

      Cinco colunas, três tabelas, e nenhum dado a migrar — o banco real tem
      ZERO tabelas de preço cadastradas, o que é a prova mais direta de que o
      cadastro nunca teve leitor. O dono atende o revendedor digitando desconto
      à mão em cada venda.

      TODAS NULLABLE, e cada nulo diz uma coisa diferente e verdadeira:

        core_customers.price_table_id       nulo = compra pelo preço normal. É o
                                            que TODO cliente que já existe
                                            significa, e precisa continuar
                                            significando depois deste passo.
        core_sales.price_table_name         nulo = venda sem tabela, e também
        core_sales.price_table_percent_off  toda venda anterior a esta rodada.
                                            São FOTOGRAFIA: nome e percentual do
                                            instante do INSERT, nunca ponteiro.
                                            Com ponteiro, editar a tabela em
                                            junho faria a venda de março contar
                                            outra história.
        core_quotes.price_table_id          nulo = documento anterior a este
        core_quotes.price_table_percent_off passo. Aqui o ID vai junto porque o
                                            papel ainda VAI virar venda, e a
                                            conversão precisa saber de qual
                                            condição ele falava.

      Preencher retroativamente qualquer uma delas seria inventar histórico:
      ninguém sabe sob qual condição as vendas antigas saíram, e afirmar "zero
      de desconto de tabela" é uma afirmação sobre um fato que não foi medido.

      As colunas de `core_sales` e `core_quotes` não ganham índice. Ninguém
      consulta venda POR tabela — elas são lidas junto com o documento, pela
      chave primária dele. Índice sem consulta é custo de escrita em toda venda
      do balcão, e este é o caminho mais quente do sistema.
    */
    if (!stepApplied(59)) {
      markStep(59);
      /*
        A ORDEM IMPORTA: `core_price_tables` precisa EXISTIR antes do ALTER que
        a referencia — o SQLite recusa `REFERENCES` para tabela inexistente na
        hora do ALTER. `ensureCoreSchema()` já rodou na primeira linha de
        `migrateCoreSchema`, e a tabela está na lista canônica desde a rodada em
        que o cadastro foi feito, então ela está lá. O `addColumn` de
        `carrier_id` (passo 48) apoiou-se na mesma garantia, pelo mesmo motivo.
      */
      addColumn('core_customers', 'price_table_id', 'TEXT REFERENCES core_price_tables(id)');
      addColumn('core_sales', 'price_table_name', 'TEXT');
      addColumn('core_sales', 'price_table_percent_off', 'REAL');
      addColumn('core_quotes', 'price_table_id', 'TEXT REFERENCES core_price_tables(id)');
      addColumn('core_quotes', 'price_table_percent_off', 'REAL');
    }

    /*
      v59 -> v60: a IDENTIDADE VISUAL de cada loja (rodada 40).

      Cada operação ganhou página própria na loja online, com a cara da marca.
      A PALETA é código (aprovada pelo dono a partir dos logos); o que o gestor
      controla pelo painel é a IMAGEM: o logo que aparece no cabeçalho da
      página da marca e a capa que apresenta a loja. As duas moram como URL
      pública em `core_storefront_settings`, apontando para o arquivo em
      `data/uploads/lojas` — o mesmo desenho das fotos de produto: arquivo no
      disco, caminho no banco, nunca base64 em coluna.
    */
    if (!stepApplied(60)) {
      markStep(60);
      addColumn('core_storefront_settings', 'logo_url', 'TEXT');
      addColumn('core_storefront_settings', 'cover_url', 'TEXT');
    }

    /*
      v60 -> v61: a moto ganha ANO e o orçamento ganha APROVAÇÃO (rodada 43).

      `year`: o dono pediu ano de fabricação no cadastro da moto desde o
      início, e a coluna nunca existiu — nem no serviço, nem na tela.

      `approval_requested_at`: `approved_at` existia desde a DDL como coluna
      MORTA — zero leitores, zero escritores. Aprovação de orçamento precisa
      de dois tempos: a oficina PEDE (esta coluna) e o cliente APROVA no
      portal (`approved_at`, que finalmente ganha escritor). Sem o pedido
      registrado, a tela do cliente não teria como saber que há algo esperando
      resposta dele.
    */
    if (!stepApplied(61)) {
      markStep(61);
      addColumn('core_equipment', 'year', 'INTEGER');
      addColumn('core_service_orders', 'approval_requested_at', 'TEXT');
    }

    /*
      v61 -> v62: o RESQUÍCIO do significado antigo de `approved_at` é limpo.

      Descoberto na verificação em tela da rodada 43: a OS #1 do banco em uso
      apareceu com o selo "orçamento aprovado pelo cliente" sem cliente algum
      ter aprovado. O fluxo REMOVIDO em 12/08 (commit 09bbc4e) gravava
      `approved_at` quando a OS ia para 'em_execucao' — significava "aprovada
      para execução" pela oficina. A rodada 43 deu à coluna o significado novo
      (aprovação DO CLIENTE pelo portal), e todo valor gravado pelo
      significado antigo viraria uma fala do cliente que nunca existiu.

      Nenhum valor presente antes desta rodada foi escrito pelo portal, então
      zerar TUDO é exato, não aproximado.
    */
    if (!stepApplied(62)) {
      markStep(62);
      db.prepare('UPDATE core_service_orders SET approved_at = NULL').run();
    }

    /*
      v62 -> v63: o item da nota de entrada passa a REGISTRAR como casou.

      `matchItems` sempre soube (barcode > internal_code > name), mas o banco
      guardava só o inteiro `matched` — e a leitura fabricava 'barcode' para
      todo item vinculado. Item antigo fica NULL: não se inventa história
      retroativa; a tela mostra o método só de quem o tem gravado.
    */
    if (!stepApplied(63)) {
      markStep(63);
      addColumn('core_inbound_note_items', 'matched_by', 'TEXT');
    }

    /*
      v63 -> v64: a conta do portal registra QUANDO os termos foram aceitos.

      Consentimento sem registro não é consentimento (LGPD). Conta antiga
      fica NULL — o aceite não se inventa retroativamente; a exigência vale
      para cadastros novos.
    */
    if (!stepApplied(64)) {
      markStep(64);
      addColumn('core_customer_accounts', 'accepted_terms_at', 'TEXT');
    }

    /*
      v64 -> v65: o e-mail da conta passa a PROVAR dono (rodada 50).

      `email_verified_at` guarda QUANDO a prova aconteceu (código digitado ou
      link de redefinição usado). Conta antiga fica NULL — não se inventa
      prova retroativa; o que ela perde é só puxar pedidos por documento
      digitado até verificar. A tabela dos códigos
      (core_customer_email_verifications) nasce inteira na DDL canônica.

      Como no passo 53, este passo NÃO faz ALTER: a coluna é nullable e a
      tabela é nova, então `reconcileCoreSchema()` (rede de segurança ao fim
      da migração) as acrescenta a partir da DDL canônica — provado por
      `tabela-de-preco-vale-na-venda.test.ts`, que dropa a coluna num banco
      v64 e re-migra. O passo existe para o alvo bater com o último passo
      (senão `haPassoPendente` copiaria o banco a cada restart).
    */
    if (!stepApplied(65)) {
      markStep(65);
      ensureCoreSchema();
    }

    /*
      v65 -> v66: o quadro da oficina ganha prioridade, prazo e o relógio do
      SLA (rodada 51).

      `priority` e `due_date` são nullable/com default — `reconcileCoreSchema`
      as cobriria. O que exige passo À MÃO é o BACKFILL de
      `status_changed_at`: a OS que já existe entrou na coluna atual em algum
      momento que ninguém gravou, e o melhor retrato honesto é o `updated_at`
      — o relógio do SLA começa dali em vez de nascer nulo (nulo = "desde
      sempre", e o quadro inteiro acorda estourado no primeiro boot).

      O addColumn vem ANTES do UPDATE porque o reconcile roda só no FIM da
      migração — sem ele, o UPDATE estoura "no such column" num banco v65.
    */
    if (!stepApplied(66)) {
      markStep(66);
      addColumn('core_service_orders', 'priority', "TEXT NOT NULL DEFAULT 'media'");
      addColumn('core_service_orders', 'due_date', 'TEXT');
      addColumn('core_service_orders', 'status_changed_at', 'TEXT');
      getConnection()
        .prepare(
          'UPDATE core_service_orders SET status_changed_at = updated_at WHERE status_changed_at IS NULL',
        )
        .run();
      ensureCoreSchema();
    }

    /*
      v66 -> v67: a máquina ganha garantia e montador; a OS ganha foto e
      checklist de entrada (rodada 52).

      As três colunas do equipamento são nullable e as duas tabelas são novas
      — `reconcileCoreSchema` e `ensureCoreSchema` dariam conta sozinhos (o
      molde do passo 53/65). O que exige passo À MÃO é o BACKFILL de
      `entered_at`: a coluna existe desde o início e nunca foi lida nem
      escolhida — era sempre o instante do cadastro. Agora ela é a data em que
      a máquina entrou, e é a base da garantia quando não houve venda. Linha
      antiga com `entered_at` nulo herda o `created_at`, que é o retrato
      honesto do que se sabe: o dia em que ela apareceu no sistema.
    */
    if (!stepApplied(67)) {
      markStep(67);
      addColumn('core_equipment', 'warranty_months', 'INTEGER');
      addColumn('core_equipment', 'assembly_mechanic_id', 'TEXT REFERENCES core_users(id)');
      addColumn('core_equipment', 'assembled_at', 'TEXT');
      getConnection()
        .prepare('UPDATE core_equipment SET entered_at = created_at WHERE entered_at IS NULL')
        .run();
      ensureCoreSchema();
    }

    /*
      v67 -> v68: a plaquinha ganha POOL, e o pool nasce completo (rodada 53).

      Ate aqui o numero da plaquinha nascia junto do equipamento. O pool passa
      a ser o registro de TODOS os numeros do grupo — e um registro que comeca
      pela metade nao serve para nada: sem esta carga, a primeira plaquinha
      gerada depois da migracao repetiria um numero que ja esta colado numa
      moto no patio.

      Cada equipamento existente vira uma linha 'associada' carregando o
      proprio numero e o proprio token. `printed_at` fica nulo de proposito:
      essas plaquinhas foram impressas pelo caminho antigo, uma a uma, e o
      sistema nao tem como saber quando.

      A REGRA DE OURO tambem entra aqui, como dado. Na rodada 53 ela marcava a
      Oficina e a PJ Motors; desde o P0 das plaquinhas `ensureOfficialTagCompanies`
      marca SO a PJ Motors (plaquinha e exclusiva dela). A carga abaixo nao
      muda: ela registra o numero de TODA maquina existente, de qualquer
      empresa, porque a numeracao do grupo e uma so e o indice unico de
      `public_id` precisa conhecer todos os numeros ja colados.
    */
    if (!stepApplied(68)) {
      markStep(68);
      addColumn('core_companies', 'uses_equipment_tags', 'INTEGER NOT NULL DEFAULT 0');
      ensureCoreSchema();
      const db68 = getConnection();
      ensureOfficialTagCompanies();
      /*
        A carga do pool. `INSERT ... SELECT` numa transacao so: linha a linha
        num banco com milhares de maquinas custaria minutos de servidor parado
        na subida, e a migracao roda antes de a porta abrir.
      */
      const agora68 = new Date().toISOString();
      db68
        .prepare(
          `INSERT INTO core_equipment_tags
             (id, company_id, public_id, public_token, status, equipment_id,
              associated_at, created_at, updated_at)
           SELECT lower(hex(randomblob(16))), e.company_id, e.public_id, e.public_token,
                  'associada', e.id, e.created_at, e.created_at, ?
             FROM core_equipment e
            WHERE NOT EXISTS (
              SELECT 1 FROM core_equipment_tags t WHERE t.public_id = e.public_id
            )`,
        )
        .run(agora68);

      /*
        A SEQUENCIA DO GRUPO NAO PODE FICAR ATRAS DO QUE JA ESTA COLADO.

        A partir daqui o pool sorteia numero da mesma sequencia que o cadastro
        sempre usou — e o indice unico de `public_id` e do GRUPO. Se a
        sequencia estiver atras do maior numero em uso (numero que veio de
        outro caminho, banco restaurado pela metade, importacao), o primeiro
        lote depois da migracao pede um numero que ja esta impresso e colado
        numa moto no patio.

        `MAX` das duas tabelas, e nao so do equipamento: a carga acima acabou
        de povoar o pool, e uma instalacao futura pode ter plaquinha sem
        maquina.
      */
      const maiorNumero = db68
        .prepare(
          `SELECT MAX(n) AS maior FROM (
             SELECT MAX(public_id) AS n FROM core_equipment
             UNION ALL
             SELECT MAX(public_id) AS n FROM core_equipment_tags
           )`,
        )
        .get() as { maior: number | null } | undefined;
      const alvo68 = Number(maiorNumero?.maior ?? 0);
      if (alvo68 > 0) {
        db68
          .prepare(
            `INSERT INTO core_sequences (company_id, name, current)
             VALUES ('__grupo__', 'equipment_public_id', ?)
             ON CONFLICT (company_id, name) DO UPDATE
               SET current = MAX(current, excluded.current)`,
          )
          .run(alvo68);
      }
    }

    /*
      v68 -> v69: a bancada declara QUEM ASSINA o papel dela (rodada 54).

      A ordem de servico impressa leva marca, CNPJ e endereco de uma empresa
      — e nem sempre e a dona da bancada. A de mobilidade pertence a Oficina,
      a operacao interna do grupo, mas quem o cliente conhece, quem vendeu a
      moto e quem responde pela garantia e a PJ Motors. Papel entregue com o
      nome errado no cabecalho nao serve para reclamar depois.

      `ensureOfficialWorkshops` grava a marca das duas bancadas oficiais; o
      passo existe para a coluna nascer e para instalacao antiga receber a
      marca sem esperar a proxima subida do servidor.
    */
    if (!stepApplied(69)) {
      markStep(69);
      addColumn('core_workshops', 'brand_company_id', 'TEXT REFERENCES core_companies(id)');
      ensureCoreSchema();
      ensureOfficialWorkshops();
    }

    /*
      v69 -> v70: a peça ganha ENDEREÇO na gaveta (rodada 55).

      "Onde eu pego essa peça" é a pergunta de quem está com a moto aberta na
      bancada, e o cadastro não tinha onde responder. O sistema anterior tinha
      — `localizacao`, texto livre, "Prateleira A3 - Caixa 2" — e era o campo
      que o mecânico mais olhava.

      É endereço de CADASTRO, não dimensão do razão: `location_id` do movimento
      continua onde estava, e a porta de preenchê-lo por padrão continua
      fechada (ver InboundConfigService). Confundir os dois faria o saldo por
      local passar a mentir, porque só a entrada gravaria local e toda saída
      seguiria nula.
    */
    if (!stepApplied(70)) {
      markStep(70);
      addColumn('core_products', 'storage_location', 'TEXT');
      ensureCoreSchema();
    }

    /*
      v70 -> v71: cada loja declara QUE NEGOCIO ELA FAZ (rodada 56).

      Ate aqui a unica diferenca entre as cinco lojas do grupo, na vitrine, era
      a paleta de cores: mesma ordem de secoes, mesma grade, mesmo card. Uma
      importadora de variedades e uma loja de moda saiam identicas trocando o
      verde pelo azul.

      O passo CARIMBA so quem esta nulo. Se o dono trocar o tipo de uma loja
      pela tela, a proxima subida do servidor nao pode desfazer a escolha dele
      — e desfaria, se este UPDATE nao tivesse o `IS NULL`.

      Loja fora da lista fica nula de proposito: nulo e "ninguem declarou", e a
      tela cai num arranjo neutro em vez de vestir a loja nova de um negocio
      que nao e o dela.
    */
    if (!stepApplied(71)) {
      markStep(71);
      addColumn('core_companies', 'storefront_preset', 'TEXT');
      // Em quantas vezes a loja ANUNCIA que vende. Nulo = nao anuncia, e e o
      // padrao: selo de parcelamento sem cadastro seria texto inventado.
      addColumn('core_storefront_settings', 'installments_max', 'INTEGER');
      ensureCoreSchema();
      ensureOfficialStorefrontPresets();
    }

    /*
      v71 -> v72: A OFICINA ASSINA COMO OFICINA.

      A Ordem de Serviço da Oficina saía impressa com o nome PJ MOTORS. O dado
      era `core_workshops.brand_company_id` da bancada de mobilidade apontando
      para `pj-motors`, e quem o punha lá era `ensureOfficialWorkshops`, com o
      vínculo cravado em código e REIMPOSTO a cada subida do servidor.

      A causa estrutural foi resolvida lá (a semeadura parou de reescrever a
      marca de bancada que já existe). Falta desfazer o que ela já gravou — e
      isso é UMA vez, aqui, e não a cada boot: se o dono decidir depois que a
      mobilidade volta a assinar como PJ Motors, ele o faz pela tela e este
      passo não roda de novo.

      O UPDATE é ESTREITO de propósito: só a bancada daquele slug, e só se ela
      ainda estiver apontando para `pj-motors`. Bancada que alguém já ajustou
      não é tocada — o passo corrige um erro conhecido, não impõe uma política.
    */
    if (!stepApplied(72)) {
      markStep(72);
      db.prepare(
        `UPDATE core_workshops
            SET brand_company_id = NULL
          WHERE slug = 'oficina-mobilidade'
            AND brand_company_id = (SELECT id FROM core_companies WHERE slug = 'pj-motors')`,
      ).run();
    }

    /*
      v72 -> v73: a entrada de nota passa a saber CONVERTER unidade.

      A entrada somava `qCom` no saldo sem olhar a unidade uma vez: dez
      caixas de doze viravam dez parafusos, e o custo unitário entrava
      doze vezes maior. O saldo mentia para menos (o PDV recusava venda de
      mercadoria que estava na prateleira) e a margem mentia para mais.

      As três colunas são NULLABLE — `reconcileCoreSchema` acrescenta o que
      faltar por ALTER, sem reconstruir a tabela. Nota antiga fica com os
      três em NULL: não se inventa conversão retroativa, e nota já recebida
      não é reprocessada.
    */
    if (!stepApplied(73)) {
      markStep(73);
      addColumn('core_inbound_note_items', 'unit_trib', 'TEXT');
      addColumn('core_inbound_note_items', 'quantity_trib', 'REAL');
      addColumn('core_inbound_note_items', 'conversion_factor', 'REAL');
    }

    /*
      v73 -> v74: o rastro do item cancelado no carrinho (GAP-V52/V63).

      O rodapé do PDV mostrava "Itens cancelados: 0" hardcoded — remover uma
      linha antes do Finalizar era invisível ao servidor. A tabela
      core_sale_removed_items é NOVA, então o ensureCoreSchema da primeira
      linha desta função já a criou com o CREATE IF NOT EXISTS; o passo existe
      para o banco antigo ser marcado corretamente e para garantir o índice —
      o mesmo desenho do passo 7 (orçamento e pré-venda).
    */
    if (!stepApplied(74)) {
      markStep(74);
      getConnection().exec(
        `CREATE INDEX IF NOT EXISTS ix_sale_removed_items_sale
           ON core_sale_removed_items (sale_id);`,
      );
    }

    /*
      v74 -> v75: o pacote do contador aprende a SAIR da empresa (GAP-V30/V31).

      Três tabelas novas (destinatários, agenda e histórico de envios) já
      nasceram no ensureCoreSchema da primeira linha desta função — o passo
      garante os índices no banco antigo, no desenho do passo 74. As DUAS
      colunas de anexo da fila de e-mail são o que exige ALTER: a tabela
      existe desde a rodada 33, e nota nenhuma vira anexo sem ter onde morar.
      Ambas NULLABLE — todo e-mail anterior a esta rodada é, com razão, um
      e-mail sem anexo.
    */
    if (!stepApplied(75)) {
      markStep(75);
      addColumn('core_email_queue', 'anexo_nome', 'TEXT');
      addColumn('core_email_queue', 'anexo_blob', 'BLOB');
      getConnection().exec(
        `CREATE INDEX IF NOT EXISTS ix_contador_dest_company
           ON core_contador_destinatarios (company_id, active);
         CREATE INDEX IF NOT EXISTS ix_contador_envios_period
           ON core_contador_envios (company_id, period, created_at);`,
      );
    }

    /*
      v75 -> v76: o evento fiscal ganha a cópia de ARQUIVAMENTO (GAP-V32).

      `core_fiscal_events.xml` guarda o retorno da SEFAZ já sanitizado —
      assinatura vira "[removido]", o que serve ao log e condena o
      arquivamento probatório. A coluna nova guarda o procEventoNFe íntegro
      DAQUI EM DIANTE; o passado não tem conserto (o que não foi guardado não
      existe) e continua saindo no pacote com a ressalva do LEIA-ME.

      NULLABLE — `reconcileCoreSchema` cobriria pela DDL canônica, e o ALTER
      explícito aqui deixa a garantia escrita em vez de por acaso.
    */
    if (!stepApplied(76)) {
      markStep(76);
      addColumn('core_fiscal_events', 'xml_proc', 'TEXT');
    }

    /*
      v76 -> v77: a nota de entrada ganha ESPÉCIE e ESTORNO (GAP-V17/V20).

      `doc_type` separa a NF-e importada de XML da compra SEM nota fiscal
      digitada na tela — 'manual' NUNCA finge ser NF-e, e é por esta coluna
      que a tela rotula e que o financeiro nasce com origem própria.
      NOT NULL com DEFAULT 'nfe' porque toda linha existente veio de XML: o
      default é a verdade delas, e é também o que permite o ALTER (coluna
      NOT NULL sem DEFAULT não entra em tabela populada).

      As três de estorno registram QUEM desfez a entrada confirmada, QUANDO
      e POR QUÊ (status 'estornada'). Nullable de propósito: nota viva não
      tem estorno para declarar, e `reconcileCoreSchema` pularia NOT NULL
      sem default — o ALTER explícito deixa a garantia escrita.
    */
    if (!stepApplied(77)) {
      markStep(77);
      addColumn('core_inbound_notes', 'doc_type', "TEXT NOT NULL DEFAULT 'nfe'");
      addColumn('core_inbound_notes', 'reversed_at', 'TEXT');
      addColumn('core_inbound_notes', 'reversed_by', 'TEXT');
      addColumn('core_inbound_notes', 'reversal_reason', 'TEXT');
    }

    /*
      v77 -> v78: ONDE a senha do gestor foi digitada, e a REABERTURA do turno
      (GAP-V61/V64).

      As duas de `core_authorizations` fecham um descarte silencioso: a rota
      `POST /core/authorizations` já montava `ip` na chamada de
      `authorizeAction`, o serviço já tinha o parâmetro na assinatura — e o
      INSERT não tinha coluna. O endereço chegava e morria ali. `terminal_id`
      entra junto porque a pergunta da conferência é uma só ("a senha foi
      digitada no balcão, com o gerente presente?") e um endereço de rede sem
      o terminal não a responde numa loja com quatro caixas na mesma sala.

      As cinco de `core_cash_sessions` são a trilha da reabertura, e existem
      porque reabrir obriga a decidir o destino da conferência já gravada. O
      desenho inteiro está na DDL canônica: `closing_trail` ARQUIVA o
      fechamento desfeito (JSON, um objeto por fechamento) e as colunas vivas
      voltam a nulo — gaveta aberta não tem contagem, e deixar a contagem
      antiga na linha seria um estado que mente.

      `reopen_count` é a única NOT NULL, com DEFAULT 0: turno que nunca foi
      reaberto foi reaberto zero vezes, e o default é a verdade de toda linha
      existente. As outras quatro são nullable pelo mesmo motivo do passo
      acima — `reconcileCoreSchema` pula NOT NULL sem default, e um ALTER
      explícito deixa a garantia escrita em vez de depender da rede de
      segurança.
    */
    if (!stepApplied(78)) {
      markStep(78);
      addColumn('core_authorizations', 'terminal_id', 'TEXT');
      addColumn('core_authorizations', 'ip', 'TEXT');
      addColumn('core_cash_sessions', 'reopened_at', 'TEXT');
      addColumn('core_cash_sessions', 'reopened_by', 'TEXT');
      addColumn('core_cash_sessions', 'reopen_reason', 'TEXT');
      addColumn('core_cash_sessions', 'reopen_count', 'INTEGER NOT NULL DEFAULT 0');
      addColumn('core_cash_sessions', 'closing_trail', 'TEXT');
    }

    /*
      v78 -> v79: o crédito de loja ganha RAZÃO (GAP-V10/V47).

      A devolução já sabia devolver "em crédito" desde a rodada 21, e o crédito
      não existia em lugar nenhum: `refund_method='credito'` era gravado, o DRE
      nomeava o valor numa ressalva, e o saldo do cliente vivia no papel do
      balcão. Um passivo que cresce a cada devolução e que nenhuma consulta
      encontra.

      `core_customer_credits` é NOVA, então o `ensureCoreSchema()` da primeira
      linha desta função já a criou pela DDL canônica — o passo existe para o
      banco antigo ficar MARCADO corretamente e para garantir o índice, que é o
      desenho dos passos 74 e 75.

      Nenhum backfill, e é decisão: não há como saber, olhando uma devolução
      antiga, se a loja já honrou o crédito no papel. Inventar saldo retroativo
      concederia de novo o que talvez já tenha sido pago. A razão vale do
      conserto em diante, exatamente como a baixa-espelho do passo V29.
    */
    if (!stepApplied(79)) {
      markStep(79);
      getConnection().exec(
        `CREATE INDEX IF NOT EXISTS ix_customer_credits_customer
           ON core_customer_credits (company_id, customer_id);`,
      );
    }

    /*
      v79 -> v80: o CATÁLOGO ganha o que a tela de produto já prometia —
      serviço de balcão, faixa por quantidade, embalagem, campo próprio, dia da
      semana na promoção e IPI no grupo (GAP-V01 a V08).

      SEIS ALTER e três tabelas novas, num passo só, porque são a MESMA rodada:
      dividir em seis passos daria seis marcas para conferir e nenhuma
      informação a mais.

      TODA COLUNA NOVA OU É NULLABLE OU TEM DEFAULT, sem exceção, e não é
      preguiça: `reconcileCoreSchema` PULA em silêncio coluna NOT NULL sem
      DEFAULT, e ela nunca chegaria ao banco que já existe — o defeito já
      aconteceu aqui e está documentado nos passos 48 e 54.

      `stock_control` é a única NOT NULL, com DEFAULT 1, e o default é a VERDADE
      de toda linha existente: até esta rodada não havia produto que não
      controlasse estoque, porque não havia como dizê-lo. Nenhum backfill,
      portanto — nada a corrigir no passado.

      `weekdays`, `pack_factor`, `pack_unit`, `cst_ipi` e `ipi_rate_code` são
      nullable porque NULO TEM SIGNIFICADO PRÓPRIO em cada uma:
        - weekdays nulo = a promoção vale todos os dias (o que toda promoção já
          gravada quer dizer);
        - pack_factor nulo = ninguém declarou embalagem, e a entrada continua
          pedindo o fator como sempre pediu;
        - cst_ipi nulo = esta operação não destaca IPI, que é o padrão do
          varejo do Simples e o XML de hoje.
      Preencher qualquer uma delas com um valor "neutro" seria inventar uma
      decisão que ninguém tomou.

      As TRÊS TABELAS NOVAS (core_product_price_tiers, core_custom_fields,
      core_custom_field_values) nascem inteiras na DDL canônica de schema.ts, e
      o `ensureCoreSchema()` da primeira linha desta função já as criou — como
      em core_sale_policies (passo 53) e core_customer_credits (passo 79). O
      passo existe para o banco antigo ficar MARCADO e para os índices, que
      NUNCA vão na DDL canônica quando dependem de coluna nova: aquela lista
      roda ANTES das migrações, e um índice sobre coluna que ainda não existe
      derruba a subida inteira — já aconteceu duas vezes neste projeto.
    */
    if (!stepApplied(80)) {
      markStep(80);
      // GAP-V02: o serviço de balcão, que não sai de prateleira nenhuma.
      addColumn('core_products', 'stock_control', 'INTEGER NOT NULL DEFAULT 1');
      // GAP-V06: a caixa com 12, aprendida no cadastro em vez de redigitada.
      addColumn('core_products', 'pack_factor', 'REAL');
      addColumn('core_products', 'pack_unit', 'TEXT');
      // GAP-V03: "toda quarta em oferta".
      addColumn('core_promotions', 'weekdays', 'TEXT');
      // GAP-V08: o IPI sai do literal 0.00 e passa a vir do grupo.
      addColumn('core_tax_groups', 'cst_ipi', 'TEXT');
      addColumn('core_tax_groups', 'ipi_rate_code', 'TEXT');
      ensureCoreSchema();
      getConnection().exec(
        `CREATE INDEX IF NOT EXISTS ix_price_tiers_product
           ON core_product_price_tiers (company_id, product_id, active);`,
      );
      getConnection().exec(
        `CREATE INDEX IF NOT EXISTS ix_custom_fields_company
           ON core_custom_fields (company_id, entity, active);`,
      );
      /*
        O ÍNDICE DE SERVIÇO É PARCIAL, e de propósito: a pergunta que ele
        responde ("quais produtos NÃO controlam estoque") tem meia dúzia de
        respostas num catálogo inteiro, e é feita pelo inventário e pelos
        relatórios a cada abertura de contagem. Índice cheio sobre uma coluna
        que é 1 em quase toda linha não serviria para nada.
      */
      getConnection().exec(
        `CREATE INDEX IF NOT EXISTS ix_products_sem_estoque
           ON core_products (company_id) WHERE stock_control = 0;`,
      );
    }

    /*
      v80 -> v81: LOTE E VALIDADE ganham onde morar (GAP-V35).

      Não havia UMA coluna de lote ou de validade em `core_products`, em
      `core_stock` nem em `core_stock_movements`, e nenhuma tabela de lote no
      banco — num grupo cujo catálogo já tem `weighable`, `plu_code` e
      `tare_grams`, isto é, desenhado para varejo de alimento com balança, que
      é exatamente o segmento em que validade é obrigação e não conveniência.

      `core_product_batches` é NOVA e nasce inteira na DDL canônica de
      schema.ts: o `ensureCoreSchema()` da primeira linha desta função já a
      criou, como em core_sale_policies (passo 53), core_customer_credits
      (passo 79) e as três do passo 80. O passo existe para o banco antigo
      ficar MARCADO e para os índices que dependem de coluna nova.

      `tracks_batches` é a ÚNICA NOT NULL, com DEFAULT 0, e o default é a
      VERDADE de toda linha existente: nenhum produto controlava lote porque
      não havia como dizê-lo. Nenhum backfill — inventar lote para o saldo
      que já está na prateleira seria escrever ficção no razão, e o saldo sem
      lote declarado tem um lugar honesto no desenho (o balde "sem lote", que
      a tela de Validade nomeia como pendência).

      As TRÊS de `core_stock_movements` são nullable pelo mesmo motivo dos
      passos 48 e 54 — `reconcileCoreSchema` PULA em silêncio coluna NOT NULL
      sem default — e porque nulo tem significado próprio nas três: movimento
      de produto que não controla lote não tem lote a declarar, e nunca terá.

      O ÍNDICE de `batch_id` fica AQUI, e não na DDL canônica, pela lição que
      já custou duas subidas quebradas neste projeto: aquela lista roda ANTES
      das migrações e, num banco que já existe, o CREATE TABLE é no-op — a
      coluna ainda não existiria e o CREATE INDEX derrubaria a API inteira com
      "no such column: batch_id". Os índices da tabela NOVA, esses, podem ficar
      na DDL: lá a tabela e as colunas nascem juntas.
    */
    if (!stepApplied(81)) {
      markStep(81);
      // O opt-in por produto. Default 0: quem não marcar não sente nada.
      addColumn('core_products', 'tracks_batches', 'INTEGER NOT NULL DEFAULT 0');
      // A dimensão do razão — a mesma natureza de `location_id`.
      addColumn('core_stock_movements', 'batch_id', 'TEXT REFERENCES core_product_batches(id)');
      addColumn('core_stock_movements', 'batch_quantity_before', 'REAL');
      addColumn('core_stock_movements', 'batch_balance_after', 'REAL');
      ensureCoreSchema();
      /*
        O ÍNDICE É PARCIAL, e de propósito: a pergunta que ele responde é
        "quanto sobrou de CADA lote", e ela só existe para as linhas que TÊM
        lote. Num razão em que quase todo movimento é de produto sem controle,
        um índice cheio ocuparia o banco inteiro para responder sobre meia
        dúzia de linhas — é o mesmo raciocínio do índice parcial de
        `stock_control = 0` no passo acima.
      */
      getConnection().exec(
        `CREATE INDEX IF NOT EXISTS ix_stock_movements_batch
           ON core_stock_movements (company_id, batch_id)
         WHERE batch_id IS NOT NULL;`,
      );
      /*
        E NÃO HÁ SEGUNDO ÍNDICE para o balde "sem lote", ainda que ele seja a
        outra metade da mesma pergunta. Um índice parcial em
        `batch_id IS NULL` cobriria QUASE TODO o razão — cada movimento de cada
        produto que não controla lote —, custando o tamanho do banco inteiro
        para responder sobre meia dúzia de linhas. A consulta do balde sempre
        filtra por produto, e `ix_stock_movements_product` (company_id,
        product_id, created_at) já a atende.
      */
    }

    /*
      v81 -> v82: a CLASSIFICAÇÃO FISCAL ganha procedência e sugestão.

      O NCM, o CEST e a origem de cada item chegam ESCRITOS no XML de entrada, e
      o sistema os jogava fora: o parser lia NCM e CFOP, ignorava CEST e o
      `orig` do grupo de ICMS, e nada disso alcançava o produto casado. O
      contador redigitava, nota a nota, o que o fornecedor já tinha declarado no
      arquivo.

      Pior que o desperdício: dentro das MESMAS colunas `ncm`/`cest`/`origin` um
      valor lido de arquivo de terceiro era indistinguível de uma decisão do
      contador. As três colunas de PROCEDÊNCIA em `core_products` separam as
      duas coisas, e nenhuma tem DEFAULT de propósito — carimbar o catálogo que
      já existe como "confirmado" seria assinar, em nome de quem não assinou,
      uma classificação que ninguém revisou. Nulo é o estado honesto, e nenhum
      backfill acontece aqui.

      `core_product_fiscal_suggestions` é NOVA e nasce inteira na DDL canônica
      de schema.ts: o `ensureCoreSchema()` da primeira linha desta função já a
      criou, como em core_sale_policies (passo 53), core_customer_credits
      (passo 79), as três do passo 80 e core_product_batches (passo 81). O passo
      existe para o banco antigo ficar MARCADO e para as colunas via ALTER.

      As DUAS de `core_inbound_note_items` são nullable pelo mesmo motivo dos
      passos 48, 54 e 80 — `reconcileCoreSchema` PULA em silêncio coluna NOT
      NULL sem default — e porque nulo tem significado próprio nas duas: nota
      antiga não guardou CEST nem origem, e nunca vai guardar. Fingir '0' na
      origem seria inventar "nacional" para mercadoria que ninguém examinou.

      O ÍNDICE da tabela NOVA fica na DDL canônica, e não aqui: lá a tabela e as
      colunas nascem juntas, e é só sobre coluna que ainda NÃO existe no banco
      antigo que o CREATE INDEX derruba a subida.
    */
    if (!stepApplied(82)) {
      markStep(82);
      // Quem confirmou a classificação, quando, e de onde o valor veio.
      addColumn('core_products', 'fiscal_confirmed_at', 'TEXT');
      addColumn('core_products', 'fiscal_confirmed_by', 'TEXT');
      addColumn('core_products', 'fiscal_classification_source', 'TEXT');
      // O que o fornecedor declarou e o parser jogava fora.
      addColumn('core_inbound_note_items', 'cest', 'TEXT');
      addColumn('core_inbound_note_items', 'origin', 'TEXT');
      ensureCoreSchema();
    }

    /*
      v82 -> v83: O CUSTO DO QUE FOI VENDIDO passa a existir (GAP-V28).

      O DRE não tinha CMV, e a ausência era RECUSA escrita em
      `IncomeStatementService`: `core_sale_items` não tinha coluna de custo, e
      o custo do cadastro de HOJE não é o custo da venda de MARÇO. Calcular
      margem lendo `core_products` faria todo mês fechado mudar de resultado a
      cada nota de entrada que altera o custo — número plausível, falso, e com
      cara de certo, que é a pior espécie num relatório financeiro.

      O único conserto honesto é fotografar o custo NA HORA da venda. É o que
      esta coluna guarda, e é o mesmo padrão que a comissão já usa: o retrato
      do momento, não a releitura do cadastro.

      NULLABLE, SEM DEFAULT E SEM BACKFILL — as três coisas de propósito:

        - nullable porque `reconcileCoreSchema` PULA em silêncio coluna NOT
          NULL sem default, e ela nunca chegaria ao banco que já existe (a
          mesma lição dos passos 48, 54, 80 e 82);
        - sem DEFAULT 0 porque zero JÁ SIGNIFICA outra coisa nesta coluna
          ("vendido com o cadastro sem custo"), e carimbar o passado com zero
          faria o CMV do mês antigo parecer completo, com margem de 100%;
        - sem backfill porque não existe de onde: o custo de então não foi
          gravado, e reconstruí-lo com o custo de agora é exatamente o número
          inventado que a recusa original evitava.

      Nulo aqui é a VERDADE de toda venda anterior a esta rodada — e o DRE
      conta quantas linhas do período estão nesse estado, em vez de somar zero
      e chamar de CMV.

      Nenhum índice: a leitura do CMV já entra por `core_sales` do período e
      desce pelo `ix_sale_items_sale`, que existe desde a primeira versão da
      tabela. Índice sobre uma coluna que nunca aparece em WHERE seria peso
      sem pergunta.
    */
    if (!stepApplied(83)) {
      markStep(83);
      addColumn('core_sale_items', 'cost_cents', 'INTEGER');
      ensureCoreSchema();
    }

    /*
      v83 -> v84: O ANEXO SAI DA FILA E VAI PARA O COFRE (GAP-V30, conserto).

      O DEFEITO: o zip do contador — até 15 MB — era gravado DENTRO de
      `core_email_queue`, uma cópia POR DESTINATÁRIO. Três contadores na mesma
      competência = três cópias do MESMO arquivo, num banco operacional que tem
      6,2 MB inteiro, e a agenda repete o gesto todo mês para cada uma das seis
      empresas. Somava-se a isso não existir retenção nenhuma: não havia um só
      DELETE da fila no servidor, e o blob continuava lá depois de 'sent'.

      `core_email_attachments` é NOVA e nasce inteira na DDL canônica: o
      `ensureCoreSchema()` da primeira linha desta função já a criou, como em
      core_sale_policies (passo 53) e core_product_batches (passo 81). O passo
      existe para o banco antigo ficar MARCADO e para a COLUNA via ALTER.

      `anexo_id` é nullable — e não é preguiça: `reconcileCoreSchema` PULA em
      silêncio coluna NOT NULL sem default, e ela nunca chegaria ao banco que já
      existe (a lição dos passos 48, 54, 80, 82 e 83). Nulo também é a verdade
      de toda mensagem sem anexo, que é a esmagadora maioria da fila.

      SEM BACKFILL, e sem apagar `anexo_blob`. Mensagem enfileirada ANTES deste
      passo continua carregando os bytes na própria linha, e o flush lê os dois
      lugares: mover blob dentro da migração seria reescrever a fila de saída
      num restart, e a fila legada se esvazia sozinha conforme ela anda. A
      coluna velha fica onde está — dropar coluna no SQLite é reconstruir a
      tabela, e reconstrução de tabela nesta transação é justamente o que já
      deixou um banco meio migrado nesta casa (ver o passo 44).

      Nenhum índice: o cofre é lido por PRIMARY KEY (o sha do conteúdo) e
      varrido inteiro só na faxina, que roda sobre dezenas de linhas.
    */
    if (!stepApplied(84)) {
      markStep(84);
      addColumn('core_email_queue', 'anexo_id', 'TEXT REFERENCES core_email_attachments(id)');
      ensureCoreSchema();
    }

    /*
      v49 -> v50: a LINHA DO TEMPO da OS ainda falava a língua antiga.

      O passo 2 traduziu os estados antigos para o vocabulário atual — e
      traduziu só `core_service_orders.status`. A tabela de EVENTOS ficou como
      estava, e no banco da loja ela ainda guarda `recebido`, `em_execucao`,
      `finalizado` e `aguardando_aprovacao`.

      Isso não é cosmético. `EquipmentPublicView` monta a linha do tempo da
      plaquinha a partir desses eventos e DESCARTA em silêncio o estado que não
      tem rótulo público — a regra existe para o nome interno nunca vazar. Com
      metade dos eventos no vocabulário velho, o cliente que escaneia o QR vê um
      histórico com buracos: etapas que aconteceram e não aparecem.

      A tradução é a MESMA tabela do passo 2, aplicada agora também a
      `to_status` e a `from_status`. Depois dela existe um vocabulário só, e o
      mapa de rótulos públicos pode falar dele sem duplicar a tradução.
    */
    if (!stepApplied(50)) {
      markStep(50);
      const traduzTo = db.prepare(
        'UPDATE core_service_order_events SET to_status = ? WHERE to_status = ?',
      );
      const traduzFrom = db.prepare(
        'UPDATE core_service_order_events SET from_status = ? WHERE from_status = ?',
      );
      for (const [antigo, novo] of Object.entries(STATUS_MAP)) {
        traduzTo.run(novo, antigo);
        traduzFrom.run(novo, antigo);
      }
    }

    /*
      v48 -> v49: a ordem de serviço passa a ter placa e vínculo de verdade.

      Nenhuma coluna nova. `plate`, `customer_id` e `equipment_id` já existiam —
      o que faltava era ESCRITOR: a tela digitava a placa e o serviço a
      descartava, e o vínculo nunca era enviado.

      O que este passo faz é garantir e limpar:

      1. `plate` está na DDL canônica desde a primeira versão da tabela, mas
         nenhum passo de migração a adicionava — o passo 2 acrescenta sete
         colunas de oficina e esquece esta. O banco da loja só a tem porque a
         reconciliação a criou por acaso. Agora que ela entra no INSERT, a
         garantia passa a ser explícita.

      2. Existe OS gravada com `plate = ''`. String vazia e ausência são coisas
         diferentes: com ela, um filtro "tem placa" mente. Ausência é NULL.

      3. O ÍNDICE de `equipment_id` fica AQUI, e não na DDL canônica. A coluna
         é acrescentada pelo passo 2 (linha 574), e a lista canônica roda ANTES
         das migrações: num banco restaurado de backup anterior àquele passo, o
         CREATE INDEX estouraria "no such column" e derrubaria a subida inteira
         — sem nem chegar na migração que resolveria. É o mesmo defeito que já
         aconteceu duas vezes aqui, e o teste que existe cobre só `kind`, então
         não pegaria este.
    */
    if (!stepApplied(49)) {
      markStep(49);
      addColumn('core_service_orders', 'plate', 'TEXT');
      db.prepare(
        "UPDATE core_service_orders SET plate = NULL WHERE plate IS NOT NULL AND TRIM(plate) = ''",
      ).run();
      db.exec(
        `CREATE INDEX IF NOT EXISTS ix_service_orders_equipment
           ON core_service_orders (equipment_id, number DESC);`,
      );
    }

    /*
      v47 -> v48: o transporte da nota de entrada, que era descartado inteiro.

      `ensureCoreSchema()` já rodou na primeira linha de `migrateCoreSchema`,
      então `core_carriers` e `core_inbound_configs` existem antes dos ALTER
      abaixo — o que importa, porque `carrier_id` referencia a primeira e o
      SQLite recusa FK para tabela inexistente.

      Toda coluna é NULLABLE sem exceção, e não é preguiça: `reconcileCoreSchema`
      PULA em silêncio coluna NOT NULL sem DEFAULT, e ela nunca chegaria ao
      banco que já existe. Além disso, nota antiga não tem transporte para
      declarar — nulo aqui é a verdade, não ausência de dado.

      O índice de `carrier_id` fica AQUI, e não na DDL canônica: a coluna só
      passa a existir depois deste ALTER, e a lista canônica roda ANTES das
      migrações. Um índice sobre coluna nova na DDL derruba a subida de todo
      banco existente com "no such column" — já aconteceu duas vezes.
    */
    if (!stepApplied(48)) {
      markStep(48);
      addColumn('core_inbound_notes', 'carrier_id', 'TEXT REFERENCES core_carriers(id)');
      addColumn('core_inbound_notes', 'carrier_name_xml', 'TEXT');
      addColumn('core_inbound_notes', 'freight_mode', 'TEXT');
      addColumn('core_inbound_notes', 'freight_cents', 'INTEGER');
      addColumn('core_inbound_notes', 'vehicle_plate', 'TEXT');
      addColumn('core_inbound_notes', 'vehicle_uf', 'TEXT');
      addColumn('core_inbound_notes', 'volumes_qty', 'INTEGER');
      addColumn('core_inbound_notes', 'gross_weight_grams', 'INTEGER');
      addColumn('core_inbound_notes', 'net_weight_grams', 'INTEGER');
      getConnection().exec(
        'CREATE INDEX IF NOT EXISTS ix_inbound_notes_carrier ON core_inbound_notes (carrier_id);',
      );
    }

    /*
      CONSERTO DO BANCO MEIO MIGRADO.

      O passo 44 reconstruiu `core_finance_entries` para pôr a PARCELA na chave
      única. Num banco real ele foi MARCADO como aplicado e não fez o trabalho:
      a reconstrução falhou com "database is locked" durante um restart, o
      processo morreu, e o marcador ficou. Na subida seguinte o passo foi
      pulado e o `reconcileCoreSchema` acrescentou as colunas que faltavam via
      ALTER — deixando COLUNAS novas com CONSTRAINT antiga.

      O sintoma só apareceu na primeira venda parcelada: a segunda parcela
      colidia com a primeira e a venda inteira falhava com 500.

      O conserto roda FORA desta transação, junto do passo 8 — reconstrução de
      tabela não cabe aqui dentro, e foi justamente por estar aqui que ela
      nunca funcionou.
    */

    /*
      v84 -> v85: A CONSOLIDAÇÃO DA REMEDIAÇÃO DE PRODUÇÃO (os 210 gaps).

      As frentes da remediação não podiam criar passo numerado (os passos são
      contíguos, e duas frentes criando o 85 colidiriam). O que o boot não faz
      sozinho — índice sobre coluna nova de tabela existente e correção de dado
      segura — mora em `consolidacaoDaRemediacao.ts`, com a regra de cada item.
      Índice único com pré-condição não derruba a subida: vira pendência, e a
      pendência é tentada de novo a cada boot (ver o fim desta função).
    */
    if (!stepApplied(85)) {
      markStep(85);
      const r = aplicarConsolidacaoDaRemediacao(db, { addColumn, tableExists, columns });
      if (!opcoes.referencia) console.info(
        `[migração] consolidação da remediação: ${r.aplicados.length} itens aplicados, `
          + `${r.pulados.length} sem o que fazer, ${r.pendencias.length} pendência(s)`,
      );
    }

    /*
      v85 -> v86: O RBAC GRANULAR (F1) — o vínculo de hoje ganha escopo de caixa
      e de bancada, sem mudar o que ninguém vê.

      As tabelas novas (modelos de permissão, personalização e caixas do
      vínculo) vêm da DDL canônica. O passo é pelo DADO: acrescenta as cinco
      colunas de `core_user_companies` e grava em cada vínculo o
      `all_workshops` que preserva o acesso de hoje (só bancadas ATIVAS
      contam; o mecânico sem bancada ativa fica sem nenhuma — D3b). A regra
      inteira, e o porquê de cada caso, estão em `passo86Acesso.ts`.
      Autorizado pela missão do RBAC granular (exceção declarada à regra de
      não criar passo numerado).
    */
    if (!stepApplied(86)) {
      markStep(86);
      const r = aplicarPasso86(db, { addColumn });
      if (!opcoes.referencia && r.vinculos > 0) {
        console.info(
          `[migração] RBAC granular: ${r.vinculos} vínculo(s) em ${r.empresas} empresa(s) com o escopo de bancada de hoje gravado`,
        );
      }
    }

    /*
      DFE-AMBIENTE (GAP-PRD-168): a mesma conversão do passo 85, para o banco
      criado pela DDL canônica anterior (85 sem `core_dfe_documents.environment`
      e com a UNIQUE (company_id, nsu)). O passo já está marcado e não roda de
      novo, e o reconcile logo abaixo acrescentaria a coluna com o DEFAULT, sem o
      ambiente de cada linha. Idempotente: com a tabela certa, só lê o catálogo.
      Falhar aqui não derruba a subida — o reparo do esquema reconstrói depois.
    */
    try {
      const amb = garantirAmbienteDosDocumentosDfe(db);
      if (!opcoes.referencia && (amb.preenchidas > 0 || amb.reconstruida || amb.adiada)) {
        console.info(
          `[migração] ambiente dos documentos DF-e: ${amb.preenchidas} linha(s) preenchida(s)`
            + (amb.reconstruida ? ', tabela reconstruída por (empresa, ambiente, NSU)' : '')
            + (amb.adiada ? `; reconstrução adiada para o reparo do esquema: ${amb.adiada}` : ''),
        );
      }
    } catch (err) {
      console.warn(`[migração] ambiente dos documentos DF-e não conferido: ${(err as Error).message}`);
    }

    // Rede de segurança: se algum passo acima não teve o efeito esperado, a
    // diferença é corrigida aqui, antes de gravar a versão.
    reconcileCoreSchema();

    // Nunca PARA BAIXO (GAP-PRD-057). O rollback de aplicação sobe a build
    // anterior sobre o banco preservado; reescrever o número com o alvo dela
    // faria o status dizer "em dia" sobre um banco que é de uma build mais nova.
    setVersion(Math.max(from, CORE_TARGET_VERSION));
  });

  // A referência do esquema é um banco novo em memória: nada a resolver nem a reparar.
  if (opcoes.referencia) return { from, to: Math.max(from, CORE_TARGET_VERSION) };

  /*
    A PENDÊNCIA DA CONSOLIDAÇÃO SE RESOLVE SOZINHA. O índice único que o passo 85
    não pôde criar (placa repetida, duas gavetas sem caixa abertas) é tentado de
    novo a cada subida — barato, só roda se houver pendência. Fora da transação
    geral: uma falha aqui não desfaz a migração.
  */
  try {
    const p = withTransaction(() => resolverPendenciasDaConsolidacao(getConnection()));
    if (p.resolvidas.length > 0) {
      console.info(`[migração] pendência(s) da consolidação resolvida(s): ${p.resolvidas.join(', ')}`);
    }
  } catch (err) {
    console.warn(`[migração] conferência das pendências da consolidação falhou: ${(err as Error).message}`);
  }

  /*
    O ESQUEMA CONTRA UM BANCO NOVO — a fase do passo 85 que não cabe na
    transação (GAP-PRD-140).

    Passo marcado não prova passo feito: o banco da loja tinha os passos 9 e
    39 marcados sem os índices que eles criam, um índice de mesmo nome com
    outra definição, o DEFAULT antigo de `core_service_orders.status` e a
    UNIQUE antiga de `core_finance_categories` — nada disso é coluna, e o
    `reconcileCoreSchema` só enxerga coluna. Aqui o banco é comparado com um
    banco NOVO desta build (montado em memória pelo mesmo caminho do boot) e
    reparado: índice faltando ou diferente, a cada subida; tabela com DEFAULT
    ou regra divergente, reconstruída pela DDL canônica com as chaves
    estrangeiras desligadas, conferência antes e depois e cópia do banco
    antes. Fora da transação porque `PRAGMA foreign_keys` não muda dentro de
    uma. O que não dá para reparar sem decisão fica dito no log, na
    prontidão e na tela Sistema — e nunca derruba a subida.
  */
  try {
    const reparo = repararEsquema(
      getConnection(),
      opcoes.reparoDoEsquema ?? { modo: 'boot', ...(copiaDestaSubida ? { copiaJaFeita: copiaDestaSubida } : {}) },
    );
    if (reparo.reparados.length > 0) {
      console.info(`[migração] esquema reparado contra o banco novo: ${reparo.reparados.join('; ')}`);
    }
    if (reparo.depois && !reparo.depois.identico) {
      console.warn(
        `[migração] o esquema continua diferente do banco novo em ${reparo.depois.divergencias.length} ponto(s): `
          + resumoDasDivergencias(reparo.depois.divergencias)
          + '. Ver Configurações › Sistema, ou rode npm run db:conferir-esquema.',
      );
    }
  } catch (err) {
    console.warn(`[migração] conferência do esquema contra o banco novo falhou: ${(err as Error).message}`);
  }

  return { from, to: Math.max(from, CORE_TARGET_VERSION) };
}

/**
 * A REGRA DE OURO DO DONO, aplicada ao grupo (rodada 53; restrita no P0 das
 * plaquinhas).
 *
 * ## O defeito
 *
 * Esta função marcava `uses_equipment_tags = 1` na Oficina e na PJ Motors a
 * cada subida do servidor — a regra antiga, "plaquinha é da PJ Motors e da
 * Oficina". O dono restringiu: plaquinha com QR e número existe SÓ na PJ
 * Motors. Continuar marcando a Oficina reabria o pool para ela na manhã
 * seguinte a qualquer correção.
 *
 * ## O que ela faz agora — e o que deixa de fazer de propósito
 *
 * Marca SÓ a PJ Motors. Não DESMARCA ninguém: um banco que já tem a Oficina
 * marcada fica com o valor gravado (nada é sobrescrito nem apagado), e quem
 * o torna inerte é `empresaUsaPlaquinha`, que exige o slug da PJ Motors além
 * da marca. As plaquinhas que a Oficina já tinha continuam em
 * `core_equipment_tags`, intactas e inalcançáveis por rota.
 *
 * Mora junto de `ensureOfficialWorkshops` porque é a mesma natureza: o
 * desenho do GRUPO, que a migração aplica uma vez e o seed reaplica. A marca
 * é por SLUG — o único identificador que sobrevive a renomear a empresa e a
 * um novo seed. Idempotente: rodar de novo não muda nada.
 */
export function ensureOfficialTagCompanies(): void {
  ensureCoreSchema();
  getConnection()
    .prepare(
      `UPDATE core_companies SET uses_equipment_tags = 1
        WHERE slug = ? AND uses_equipment_tags <> 1`,
    )
    .run(EMPRESA_DAS_PLAQUINHAS);
}

/**
 * Carimba o TIPO DE NEGÓCIO das cinco lojas do grupo (rodada 56).
 *
 * Fica ao lado de `ensureOfficialWorkshops` e `ensureOfficialTagCompanies`
 * porque é a mesma espécie de fato: coisa que é verdade sobre ESTE grupo, e
 * que tanto a migração de um banco antigo quanto a semeadura de um banco novo
 * precisam garantir. Sem o segundo caminho, uma instalação limpa nasceria com
 * as cinco lojas sem tipo — e a vitrine cairia no arranjo neutro para todas,
 * que é exatamente o problema que a rodada veio resolver.
 *
 * SÓ CARIMBA QUEM ESTÁ NULO, e é chamada em DOIS lugares — a migração (uma
 * vez, num banco que vem de antes) e a semeadura (banco novo, onde não há
 * escolha a preservar).
 *
 * NÃO É CHAMADA NA SUBIDA DO SERVIDOR, ao contrário das duas irmãs acima, e a
 * diferença é o que o dado significa. A bancada oficial e a regra da plaquinha
 * são estruturais: o grupo não funciona sem elas, e garanti-las toda subida é
 * barato. O tipo de loja é ESCOLHA — e "não declarado" é uma escolha legítima.
 * Um UPDATE a cada subida a desfaria na manhã seguinte, e o dono veria a
 * vitrine voltar sozinha ao arranjo que ele tinha tirado.
 */
export function ensureOfficialStorefrontPresets(): void {
  ensureCoreSchema();
  const carimbo = getConnection().prepare(
    'UPDATE core_companies SET storefront_preset = ? WHERE slug = ? AND storefront_preset IS NULL',
  );
  for (const [slug, preset] of Object.entries(PRESET_OFICIAL)) {
    carimbo.run(preset, slug);
  }
}

/**
 * Garante que as oficinas oficiais existam.
 *
 * São duas, e nenhuma delas cria empresa nova:
 *   - Mobilidade Elétrica, dentro da operação Oficina
 *   - Celulares, dentro da operação Preço Justo
 */
export function ensureOfficialWorkshops(): void {
  ensureCoreSchema();
  const db = getConnection();
  const now = new Date().toISOString();

  /*
    `brandSlug` é QUEM ASSINA O PAPEL da bancada (rodada 54).

    Este bloco dizia: "a de mobilidade pertence à Oficina, mas quem o cliente
    conhece, quem vendeu a moto e quem responde pela garantia é a PJ MOTORS".
    O raciocínio é legítimo — e o dono decidiu o contrário, depois de ver a
    Ordem de Serviço da Oficina sair impressa com o nome PJ MOTORS.

    A capacidade continua existindo: uma bancada PODE assinar em nome de outra
    operação do grupo, e `WorkshopBrandService` é a autoridade disso, com tela.
    O que saiu daqui foi a IMPOSIÇÃO — semear um vínculo de identidade é
    decidir por quem opera, e ainda por cima a cada subida do servidor.

    Nulo em toda bancada: nasce assinando em nome próprio, e quem quiser outra
    coisa escolhe.
  */
  const targets = [
    {
      slug: 'oficina-mobilidade',
      companySlug: 'oficina',
      name: 'Oficina de Mobilidade Elétrica',
      kind: 'mobility',
      // A Oficina assina em NOME PRÓPRIO — decisão do dono, tomada depois de a
      // OS sair impressa com o nome PJ MOTORS. O vínculo continua existindo
      // como capacidade (`WorkshopBrandService`), mas semeá-lo era impô-lo.
      brandSlug: null as string | null,
    },
    {
      slug: 'oficina-celulares',
      companySlug: 'preco-justo',
      name: 'Oficina de Celulares',
      kind: 'phones',
      brandSlug: null,
    },
  ];

  for (const target of targets) {
    const company = db
      .prepare('SELECT id FROM core_companies WHERE slug = ?')
      .get(target.companySlug) as { id: string } | undefined;
    if (!company) continue;

    const marca = target.brandSlug
      ? (db.prepare('SELECT id FROM core_companies WHERE slug = ?').get(target.brandSlug) as
          | { id: string }
          | undefined)
      : undefined;

    const existing = db
      .prepare('SELECT id FROM core_workshops WHERE slug = ?')
      .get(target.slug) as { id: string } | undefined;
    if (existing) {
      /*
        A MARCA NÃO É REIMPOSTA — e é por isso que a OS voltava a sair errada.

        Esta linha carregava `brand_company_id` na atualização, com o valor
        cravado logo acima. Quem operava corrigia a identidade pela tela, o
        próximo deploy rodava a migração, e a Ordem de Serviço da Oficina
        voltava a imprimir PJ MOTORS — sem ninguém ter mexido em nada.

        Semear é escrever o que ainda não existe. O que já existe tem dono, e o
        dono é quem opera: `WorkshopBrandService` é a autoridade da marca.
      */
      db.prepare(
        `UPDATE core_workshops
            SET company_id = ?, name = ?, kind = ?
          WHERE id = ?`,
      ).run(company.id, target.name, target.kind, existing.id);
      continue;
    }
    db.prepare(
      `INSERT INTO core_workshops (id, company_id, slug, name, kind, brand_company_id, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
    ).run(randomUUID(), company.id, target.slug, target.name, target.kind, marca?.id ?? null, now);
  }
}
