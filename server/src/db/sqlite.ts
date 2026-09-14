/**
 * Conexão SQLite central do Grupo Sampaio ERP.
 *
 * Usa `node:sqlite` (nativo no Node 22+), portanto não exige compilação de
 * módulo nativo. Substitui o antigo "banco" em arquivo JSON, que carregava
 * tudo em memória e reescrevia o arquivo inteiro a cada gravação — sem
 * transação, sem durabilidade e sujeito a lost update entre processos.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDotEnvLoaded } from '../config/env.js';

const DEFAULT_DATABASE_PATH = './server/data/grupo-sampaio.db';

/**
 * Raiz do repositório, derivada da localização deste módulo.
 *
 * Caminhos relativos NÃO podem ser resolvidos contra `process.cwd()`: rodar
 * `npm run dev --prefix server` deixa o cwd em `server/`, e aí
 * `./server/data/...` viraria `server/server/data/...` — ou seja, um banco
 * diferente dependendo do diretório de onde o processo foi iniciado. Para um
 * banco que é a autoridade central, isso é corrupção silenciosa.
 */
export function repoRoot(): string {
  // este arquivo: <repo>/server/src/db/sqlite.ts  (ou dist/db/sqlite.js)
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', '..');
}

let handle: DatabaseSync | null = null;
let handlePath: string | null = null;

/*
  A CONEXÃO EMPRESTADA (GAP-PRD-140).

  A conferência do esquema compara o banco com um banco NOVO, montado em
  memória pelo mesmo caminho do boot — DDL canônica e os passos de migração.
  Os passos falam com `getConnection()` e não recebem conexão; em vez de
  reescrever 2.900 linhas para receber uma, a referência empresta a conexão de
  memória por um instante: enquanto `fn` roda, toda chamada a
  `getConnection` devolve o banco de referência e o caminho do banco vira
  `:memory:` (o snapshot pré-migração se reconhece e pula). O banco da API
  não é fechado nem tocado, e a profundidade de transação dele é guardada e
  devolvida no fim.
*/
let emprestada: DatabaseSync | null = null;

/**
 * Caminho do arquivo SQLite. Aceita o valor legado terminado em `.json`
 * (convertendo para `.db`) para que instalações antigas não precisem
 * reconfigurar a variável de ambiente.
 */
export function resolveDatabasePath(): string {
  // Durante a montagem da referência do esquema, o "banco" é o de memória.
  if (emprestada) return ':memory:';
  ensureDotEnvLoaded();
  const configured = process.env.DEVORA_DATABASE_PATH || DEFAULT_DATABASE_PATH;
  if (configured === ':memory:') return ':memory:';
  // Instalações antigas apontavam para um arquivo .json; o mesmo caminho
  // passa a valer para o SQLite.
  const swapped = configured.replace(/\.json$/i, '.db');
  return isAbsolute(swapped) ? swapped : resolve(repoRoot(), swapped);
}

export function getConnection(): DatabaseSync {
  if (emprestada) return emprestada;
  const path = resolveDatabasePath();
  if (handle && handlePath === path) return handle;
  if (handle) {
    handle.close();
    handle = null;
  }
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  // WAL permite leitores concorrentes com um escritor — essencial para
  // múltiplos PDVs. `busy_timeout` evita SQLITE_BUSY imediato sob disputa.
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');

  /**
   * Durabilidade.
   *
   * FULL garante que venda e caixa sobrevivem a queda de energia — e já
   * sobreviveram a uma, de verdade, durante o desenvolvimento. É o padrão e
   * não se abre mão dele em operação.
   *
   * EM TESTE é o contrário: o banco é um arquivo temporário que será jogado
   * fora, e FULL faz cada commit esperar um fsync. Com os arquivos de teste
   * rodando em paralelo, dezenas de `beforeEach` disputando o disco produziam
   * esperas de vários segundos e estouravam o timeout de 10s do hook — o que
   * aparecia como "suíte instável" em arquivos que não tinham defeito nenhum.
   *
   * A troca vale SÓ quando o caminho do banco veio da configuração de teste.
   * Produção nunca passa por aqui.
   */
  const emTeste = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';
  db.exec(`PRAGMA synchronous = ${emTeste ? 'OFF' : 'FULL'};`);
  handle = db;
  handlePath = path;
  return db;
}

export function closeConnection(): void {
  if (handle) {
    handle.close();
    handle = null;
    handlePath = null;
  }
}

let transactionDepth = 0;

/**
 * Executa `fn` dentro de uma transação. Reentrante: chamadas aninhadas
 * participam da transação externa (via SAVEPOINT), de modo que um serviço
 * pode compor operações sem quebrar a atomicidade do chamador.
 */
export function withTransaction<T>(fn: () => T): T {
  const db = getConnection();
  if (transactionDepth > 0) {
    const name = `sp_${transactionDepth}`;
    db.exec(`SAVEPOINT ${name};`);
    transactionDepth += 1;
    try {
      const result = fn();
      transactionDepth -= 1;
      db.exec(`RELEASE ${name};`);
      return result;
    } catch (err) {
      transactionDepth -= 1;
      db.exec(`ROLLBACK TO ${name};`);
      db.exec(`RELEASE ${name};`);
      throw err;
    }
  }
  // IMMEDIATE adquire o write lock já na abertura, evitando que duas
  // transações leiam o mesmo estoque e só colidam no commit.
  db.exec('BEGIN IMMEDIATE;');
  transactionDepth = 1;
  try {
    const result = fn();
    transactionDepth = 0;
    db.exec('COMMIT;');
    return result;
  } catch (err) {
    transactionDepth = 0;
    try {
      db.exec('ROLLBACK;');
    } catch {
      // conexão já pode ter revertido sozinha
    }
    throw err;
  }
}

/** Roda `fn` com `db` no lugar da conexão da API. Não aninha. */
export function comConexaoEmprestada<T>(db: DatabaseSync, fn: () => T): T {
  if (emprestada) {
    throw new Error('Já há uma conexão emprestada: a referência do esquema não se monta dentro de outra.');
  }
  const profundidade = transactionDepth;
  emprestada = db;
  transactionDepth = 0;
  try {
    return fn();
  } finally {
    emprestada = null;
    transactionDepth = profundidade;
  }
}

export function conexaoEmprestadaAtiva(): boolean {
  return emprestada !== null;
}

export function inTransaction(): boolean {
  return transactionDepth > 0;
}
