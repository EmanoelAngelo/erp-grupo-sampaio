/**
 * Camada de coleções de documentos sobre o SQLite central.
 *
 * Mantém exatamente a mesma API pública do antigo store em JSON
 * (`insertRow`/`findRows`/`findOneRow`/`updateRows`/`deleteRows`/`loadDb`/
 * `persistDb`), de modo que os serviços existentes continuam funcionando sem
 * alteração — porém agora com persistência transacional real.
 *
 * Domínios core com invariantes fortes (estoque, vendas, caixa, financeiro)
 * NÃO usam esta camada: eles têm tabelas relacionais tipadas em `./schema.ts`.
 */
import type { DatabaseSync } from 'node:sqlite';
import { getConnection, withTransaction } from './sqlite.js';
import { assertDestructiveAllowed } from './safety.js';
import { CORE_TABLES_IN_DELETE_ORDER, ensureCoreSchema } from './schema.js';

/*
  SÓ ENTRA AQUI COLEÇÃO QUE ALGUÉM LÊ OU ESCREVE (GAP-PRD-141).

  Eram 132. Noventa não tinham uma única referência em `server/src` fora de
  `db/` — as de `crm_*`, `automation_*` e `corporate_bi_*` perderam a última
  quando /crm, /automations e /bi foram desmontados (GAP-PRD-075) —, e mesmo
  assim cada boot as criava, cada reset de teste as esvaziava e cada backup as
  carregava. Saíram para `TABELAS_APOSENTADAS` (`./tabelasAposentadas.ts`),
  junto com as 81 que a rodada 36 já tinha tirado daqui sem apagar do arquivo.
  Instalação nova não as cria; no banco que já existe, o caminho para tirá-las
  é `npm run db:podar-legado` (só vazias, com cópia antes).

  A trava é `as-tabelas-mortas-saem.test.ts`: coleção nesta lista sem leitor
  nem escritor derruba a suíte.
*/
export const TABLE_NAMES = [
  'api_sessions', 'api_idempotency_keys', 'api_request_logs',
  // Do Asaas legado fica só a fila da homologação sandbox. Os dois vínculos
  // (escrita sem leitor), o segundo livro de avisos e o resumo da homologação
  // saíram na junção do GAP-PRD-075; o passo 85 copia o que havia neles para
  // o núcleo (`core_payment_webhooks`, a própria tentativa, `core_audit_log`).
  'asaas_operational_attempts',
  // As seis `ecommerce_*` saíram com `services/ecommerce/` (GAP-PRD-075): só o
  // painel de `/integrations` e a prontidão de staging as liam.
  // `logistics_shipments` saiu (GAP-PRD-075): o envio é `core_shipments`
  // (GAP-PRD-120), e a coleção só era "usada" por comentários que a citavam.
  'logistics_carrier_credentials', 'logistics_quotes',
  'logistics_homologation_executions',
  // Do fiscal legado ficam só as duas que o núcleo lê: o A1 e o CSC. As doze
  // de `NfeService`/`NfceService`/`FiscalService` (documentos, filas,
  // homologações, emitente e perfil de produto paralelos) saíram com eles
  // (GAP-PRD-075): o documento fiscal é `core_fiscal_documents`.
  'fiscal_certificate_references',
  'nfce_settings',
  'payment_terminal_configurations', 'payment_terminal_transactions',
  'payment_terminal_homologations', 'payment_terminal_local_agents',
  'payment_terminal_history', 'payment_terminal_dead_letter',
  // `payment_terminal_reconciliation` saiu (GAP-PRD-075): ninguém a escrevia, e
  // a única rota que a lia respondia a lista vazia.
  // Voltaram (junção DEP × PAG): a PAG passou a gravar o comprovante de verdade
  // (GAP-PRD-162) e os pedidos de cancelamento e estorno (GAP-PRD-079) nestas três.
  'payment_terminal_receipts', 'payment_terminal_cancellations', 'payment_terminal_refunds',
  // O cofre e o estado da integração (Asaas) ficam; a trilha paralela
  // (`integration_audit_entries`) saiu para `core_audit_log` (GAP-PRD-075).
  'integration_secrets', 'integration_configurations',
] as const;

export type TableName = (typeof TABLE_NAMES)[number];

export type DbSchema = { version: number } & {
  [K in TableName]: Record<string, unknown>[];
};

const TABLE_SET = new Set<string>(TABLE_NAMES);

/*
  A EMPRESA DA LINHA É COLUNA (GAP-PRD-147).

  Toda coleção era `(seq, id, data)`: a empresa dona da linha morava dentro do
  JSON, e o isolamento entre as seis empresas dependia de cada serviço lembrar
  de pôr `companyId` no predicado — nas coleções que guardam chave de API,
  token, CSC, certificado e credencial de maquininha.

  Agora toda coleção tem `company_id`, gerada do próprio JSON (nada a manter
  em dia à mão), e `findRowsDaEmpresa` filtra por ela NO SQL: a linha de outra
  empresa nem chega ao JavaScript. Nas coleções abaixo, a escrita também é
  guardada: linha sem empresa é recusada, e atualização que MUDA a empresa de
  uma linha é recusada — segredo tem dono e não troca de dono.
*/
const COLUNA_DA_EMPRESA = "company_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.companyId')) VIRTUAL";

/** As coleções que guardam segredo ou credencial: escrita sob a guarda da empresa. */
export const COLECOES_POR_EMPRESA: ReadonlySet<string> = new Set<string>([
  'integration_secrets',
  'integration_configurations',
  'fiscal_certificate_references',
  'nfce_settings',
  'logistics_carrier_credentials',
  'payment_terminal_configurations',
  'payment_terminal_local_agents',
]);

function empresaDe(row: Record<string, unknown>): string | null {
  return typeof row.companyId === 'string' && row.companyId.trim() ? row.companyId : null;
}

function assertTable(table: string): asserts table is TableName {
  // Impede SQL injection via nome de tabela: só nomes do allowlist entram na query.
  if (!TABLE_SET.has(table)) {
    throw new Error(`Tabela desconhecida: ${table}`);
  }
}

let schemaReady = false;

/**
 * A DDL da camada de documentos sobre uma conexão dada. É o corpo de
 * `ensureSchema`, separado para que a referência do esquema (GAP-PRD-140)
 * monte o banco novo pelo MESMO caminho do boot, sem uma segunda cópia desta
 * DDL que divergiria da primeira.
 */
export function criarColecoesDeDocumentos(db: DatabaseSync): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS db_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);',
  );
  for (const table of TABLE_NAMES) {
    db.exec(
      `CREATE TABLE IF NOT EXISTS "${table}" (
         seq INTEGER PRIMARY KEY AUTOINCREMENT,
         id TEXT,
         data TEXT NOT NULL,
         ${COLUNA_DA_EMPRESA}
       );`,
    );
    db.exec(`CREATE INDEX IF NOT EXISTS "ix_${table}_id" ON "${table}" (id);`);
    // Tabela de antes do GAP-PRD-147: a coluna entra por ALTER. VIRTUAL não
    // reescreve linha nenhuma, e é anulável — o molde do reconcileCoreSchema.
    const colunas = db.prepare(`PRAGMA table_xinfo("${table}")`).all() as { name: string }[];
    if (!colunas.some((c) => c.name === 'company_id')) {
      db.exec(`ALTER TABLE "${table}" ADD COLUMN ${COLUNA_DA_EMPRESA};`);
    }
    // O índice sobre ela, nas coleções de segredo, é do passo de consolidação
    // (docs/audits/remediacao/migracoes/DEP.md), não do boot.
  }
}

/** Cria as tabelas de documentos e a tabela de metadados, se necessário. */
export function ensureSchema(): void {
  if (schemaReady) return;
  criarColecoesDeDocumentos(getConnection());
  schemaReady = true;
}

export function getSchemaVersion(): number {
  ensureSchema();
  const row = getConnection()
    .prepare('SELECT value FROM db_meta WHERE key = ?')
    .get('version') as { value?: string } | undefined;
  return row?.value ? Number(row.value) : 1;
}

export function setSchemaVersion(version: number): void {
  ensureSchema();
  getConnection()
    .prepare(
      'INSERT INTO db_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
    .run('version', String(version));
}

/** Caminho efetivo do banco (mantido por compatibilidade com `status.ts`). */
export { resolveDatabasePath as getDbPath } from './sqlite.js';

type DocRow = { seq: number; id: string | null; data: string };

function readAll<T extends Record<string, unknown>>(table: TableName): { seq: number; row: T }[] {
  ensureSchema();
  const rows = getConnection()
    .prepare(`SELECT seq, data FROM "${table}" ORDER BY seq`)
    .all() as unknown as DocRow[];
  return rows.map((r) => ({ seq: r.seq, row: JSON.parse(r.data) as T }));
}

export function insertRow<T extends Record<string, unknown>>(table: keyof DbSchema, row: T): T {
  const name = String(table);
  if (name === 'version') return row;
  assertTable(name);
  if (COLECOES_POR_EMPRESA.has(name) && !empresaDe(row)) {
    throw new Error(`A coleção ${name} guarda segredo: a linha precisa da empresa (companyId).`);
  }
  ensureSchema();
  const id = typeof row.id === 'string' ? row.id : null;
  getConnection()
    .prepare(`INSERT INTO "${name}" (id, data) VALUES (?, ?)`)
    .run(id, JSON.stringify(row));
  return row;
}

export function findRows<T extends Record<string, unknown>>(
  table: keyof DbSchema,
  predicate: (row: T) => boolean,
): T[] {
  const name = String(table);
  if (name === 'version') return [];
  assertTable(name);
  return readAll<T>(name)
    .map((entry) => entry.row)
    .filter(predicate);
}

export function findOneRow<T extends Record<string, unknown>>(
  table: keyof DbSchema,
  predicate: (row: T) => boolean,
): T | null {
  return findRows<T>(table, predicate)[0] ?? null;
}

/**
 * As linhas de UMA empresa, filtradas no SQL pela coluna `company_id`
 * (GAP-PRD-147): a linha de outra empresa não chega a ser lida. Empresa
 * vazia é recusada — "todas as empresas" nunca é o valor padrão.
 */
export function findRowsDaEmpresa<T extends Record<string, unknown>>(
  table: TableName,
  companyId: string,
  predicate: (row: T) => boolean = () => true,
): T[] {
  assertTable(table);
  if (typeof companyId !== 'string' || !companyId.trim()) {
    throw new Error(`Leitura de ${table} por empresa sem empresa.`);
  }
  ensureSchema();
  const rows = getConnection()
    .prepare(`SELECT data FROM "${table}" WHERE company_id = ? ORDER BY seq`)
    .all(companyId) as unknown as { data: string }[];
  return rows.map((r) => JSON.parse(r.data) as T).filter(predicate);
}

export function findOneRowDaEmpresa<T extends Record<string, unknown>>(
  table: TableName,
  companyId: string,
  predicate: (row: T) => boolean = () => true,
): T | null {
  return findRowsDaEmpresa<T>(table, companyId, predicate)[0] ?? null;
}

export function updateRows<T extends Record<string, unknown>>(
  table: keyof DbSchema,
  predicate: (row: T) => boolean,
  updater: (row: T) => T,
): number {
  const name = String(table);
  if (name === 'version') return 0;
  assertTable(name);
  return withTransaction(() => {
    const db = getConnection();
    const stmt = db.prepare(`UPDATE "${name}" SET id = ?, data = ? WHERE seq = ?`);
    let count = 0;
    for (const entry of readAll<T>(name)) {
      if (!predicate(entry.row)) continue;
      const next = updater(entry.row);
      if (COLECOES_POR_EMPRESA.has(name) && empresaDe(next) !== empresaDe(entry.row)) {
        // Dentro da transação: estourar aqui desfaz o que o laço já gravou.
        throw new Error(`A coleção ${name} guarda segredo: a empresa de uma linha não muda.`);
      }
      const id = typeof next.id === 'string' ? next.id : null;
      stmt.run(id, JSON.stringify(next), entry.seq);
      count += 1;
    }
    return count;
  });
}

export function deleteRows<T extends Record<string, unknown>>(
  table: keyof DbSchema,
  predicate: (row: T) => boolean,
): number {
  const name = String(table);
  if (name === 'version') return 0;
  assertTable(name);
  return withTransaction(() => {
    const db = getConnection();
    const stmt = db.prepare(`DELETE FROM "${name}" WHERE seq = ?`);
    let count = 0;
    for (const entry of readAll<T>(name)) {
      if (!predicate(entry.row)) continue;
      stmt.run(entry.seq);
      count += 1;
    }
    return count;
  });
}

/**
 * Materializa o banco inteiro. Usado apenas por migrations e relatórios de
 * readiness — não use em caminho de request, é uma leitura completa.
 */
export function loadDb(): DbSchema {
  ensureSchema();
  const result = { version: getSchemaVersion() } as DbSchema;
  for (const table of TABLE_NAMES) {
    result[table] = readAll(table).map((entry) => entry.row);
  }
  return result;
}

/**
 * Regrava o estado completo. Contraparte de `loadDb()` para as migrations
 * legadas, que mutam o objeto retornado e o persistem de volta.
 */
export function persistDb(db: DbSchema = loadDb()): void {
  ensureSchema();
  withTransaction(() => {
    const conn = getConnection();
    for (const table of TABLE_NAMES) {
      const rows = db[table];
      if (!Array.isArray(rows)) continue;
      conn.exec(`DELETE FROM "${table}";`);
      const stmt = conn.prepare(`INSERT INTO "${table}" (id, data) VALUES (?, ?)`);
      for (const row of rows) {
        const id = typeof row.id === 'string' ? row.id : null;
        stmt.run(id, JSON.stringify(row));
      }
    }
    setSchemaVersion(db.version ?? 1);
  });
}

/**
 * Script de limpeza, montado uma vez por processo.
 *
 * São ~264 tabelas, e a limpeza vai num `exec` só em vez de um por tabela.
 *
 * MEDIDO: isto NÃO foi o gargalo — 26,9 ms contra 27,0 ms do jeito anterior.
 * Fica porque é mais simples, não porque resolveu alguma coisa. O custo real
 * do reset estava no `PRAGMA synchronous = FULL`, que fazia cada commit
 * esperar um fsync; ver `sqlite.ts`.
 */
let resetScript: string | null = null;

function buildResetScript(): string {
  if (resetScript) return resetScript;
  const partes: string[] = [];
  for (const table of TABLE_NAMES) partes.push(`DELETE FROM "${table}";`);
  for (const table of CORE_TABLES_IN_DELETE_ORDER) partes.push(`DELETE FROM "${table}";`);
  partes.push('DELETE FROM sqlite_sequence;');
  resetScript = partes.join('\n');
  return resetScript;
}

/**
 * Esvazia TODAS as tabelas. Só roda contra banco descartável — ver
 * `db/safety.ts` para as duas barreiras e para o incidente que as originou.
 */
export function resetDbForTests(): void {
  assertDestructiveAllowed('resetDbForTests');
  ensureSchema();
  ensureCoreSchema();
  withTransaction(() => {
    getConnection().exec(buildResetScript());
  });
}
