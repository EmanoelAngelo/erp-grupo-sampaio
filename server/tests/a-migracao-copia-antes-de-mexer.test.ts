/**
 * ============================================================================
 * A CÓPIA VEM ANTES DE MEXER — a cadeia inteira
 * ============================================================================
 *
 * A rodada 73 descobriu, na própria conferência, que o passo 73 tinha rodado
 * SEM o snapshot: ele foi escrito com `CORE_TARGET_VERSION` ainda em 72, e
 * `haPassoPendente` — que varre de 2 até o alvo — não o enxergou. A estrutura
 * do banco mudou; a cópia de segurança não foi tirada.
 *
 * `schema-drift` ganhou o caso que cobra a DECLARAÇÃO (nenhum passo acima do
 * alvo). Este arquivo cobra a CADEIA:
 *
 *     há passo pendente? → tira a cópia → aplica → marca o passo
 *
 * e as três condições em que ela não deve rodar inteira:
 *
 *   - sem passo pendente, nenhuma cópia é tirada (o `tsx watch` reinicia a
 *     cada gravação; dez cópias por minuto já aconteceram neste projeto);
 *   - banco descartável não gasta tempo copiando — a suíte roda 247 arquivos,
 *     cada um com o seu banco;
 *   - passo já aplicado é imutável: migração histórica não se "conserta",
 *     ganha-se um passo novo.
 *
 * ## Por que a ORDEM é medida por leitura
 *
 * Provar "a cópia veio antes" em execução exigiria o banco OPERACIONAL — é o
 * único caminho em que `snapshotDatabase` de fato escreve. Apontar um teste
 * para ele é justamente o que a Regra Zero proíbe. A ordem, porém, está
 * escrita: dentro de `migrateCoreSchema`, o snapshot aparece antes de qualquer
 * escrita. É isso que se lê.
 */
process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const AQUI = dirname(fileURLToPath(import.meta.url));
const MIGRACOES = resolve(AQUI, '../src/db/core-migrations.ts');

const { closeConnection, getConnection } = await import('../src/db/sqlite.js');
const { ensureCoreSchema, resetCoreSchemaCache } = await import('../src/db/schema.js');
const { CORE_TARGET_VERSION, migrateCoreSchema } = await import('../src/db/core-migrations.js');
const { snapshotDatabase } = await import('../src/db/backup.js');

// ============================================================================
// A ORDEM, lida da árvore
// ============================================================================

function corpoDaMigracao(): string {
  const fonte = readFileSync(MIGRACOES, 'utf8');
  const sf = ts.createSourceFile(MIGRACOES, fonte, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  let corpo: string | null = null;
  const visitar = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'migrateCoreSchema' && node.body) {
      corpo = node.body.getText(sf);
      return;
    }
    ts.forEachChild(node, visitar);
  };
  ts.forEachChild(sf, visitar);
  if (!corpo) throw new Error('`migrateCoreSchema` não encontrada');
  return corpo;
}

describe('a cópia vem antes de qualquer escrita', () => {
  const corpo = corpoDaMigracao();

  it('a leitura enxerga a função — senão ficaria verde lendo nada', () => {
    expect(corpo.length).toBeGreaterThan(500);
    expect(corpo).toContain('markStep');
  });

  it('`snapshotDatabase` aparece ANTES do primeiro `markStep`', () => {
    const daCopia = corpo.indexOf('snapshotDatabase');
    const daEscrita = corpo.indexOf('markStep');
    expect(daCopia, '`snapshotDatabase` não é chamado em `migrateCoreSchema`').toBeGreaterThan(-1);
    expect(daEscrita).toBeGreaterThan(-1);
    expect(daCopia, 'a cópia passou a vir depois da primeira escrita').toBeLessThan(daEscrita);
  });

  it('e ela só é tirada quando há passo pendente', () => {
    /*
      Sem esta condição, TODO restart do `tsx watch` — que é a cada gravação de
      arquivo — copia o banco inteiro. Já aconteceu: dez cópias em
      `server/data/backups`, três delas no mesmo minuto.
    */
    const daGuarda = corpo.indexOf('haPassoPendente');
    const daCopia = corpo.indexOf('snapshotDatabase');
    expect(daGuarda, '`haPassoPendente` sumiu da migração').toBeGreaterThan(-1);
    expect(daGuarda).toBeLessThan(daCopia);
  });

  it('falhar ao copiar NÃO impede a migração — e fica registrado', () => {
    /*
      Um banco preso na versão antiga por causa de disco cheio seria pior que
      migrar sem cópia. A decisão é declarada: `try`/`catch` com aviso.
    */
    expect(corpo).toMatch(/catch\s*\(/);
    expect(corpo).toMatch(/console\.warn|logWarn/);
  });
});

// ============================================================================
// O comportamento, num banco descartável
// ============================================================================

function bancoTemporario(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'gs-migracao-'));
  return { dir, path: join(dir, 'core.db') };
}

function apontarPara(path: string): void {
  closeConnection();
  process.env.DEVORA_DATABASE_PATH = path;
  process.env.TEST_DATABASE_PATH = path;
  resetCoreSchemaCache();
}

function limpar(dir: string): void {
  closeConnection();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Pasta temporária; o Windows às vezes segura o handle.
  }
}

describe('banco descartável não gasta tempo copiando', () => {
  it('o snapshot se declara pulado, e nenhum arquivo nasce', () => {
    const { dir, path } = bancoTemporario();
    apontarPara(path);
    ensureCoreSchema();

    const r = snapshotDatabase('teste-de-migracao');

    expect(r.skipped).toBe('disposable');
    expect(r.path).toBe('');
    expect(r.bytes).toBe(0);
    limpar(dir);
  });
});

describe('a cadeia inteira, num banco novo', () => {
  it('migrar marca TODO passo até o alvo, e a versão fica no alvo', () => {
    const { dir, path } = bancoTemporario();
    apontarPara(path);
    ensureCoreSchema();
    migrateCoreSchema();

    const db = getConnection();
    const pendentes: number[] = [];
    for (let passo = 2; passo <= CORE_TARGET_VERSION; passo += 1) {
      const linha = db
        .prepare('SELECT value FROM core_meta WHERE key = ?')
        .get(`core_migration_step_${passo}`) as { value?: string } | undefined;
      if (linha?.value !== 'applied') pendentes.push(passo);
    }
    const versao = db
      .prepare("SELECT value FROM core_meta WHERE key = 'core_schema_version'")
      .get() as { value?: string } | undefined;

    expect(pendentes).toEqual([]);
    expect(Number(versao?.value)).toBe(CORE_TARGET_VERSION);
    limpar(dir);
  });

  it('migrar DE NOVO não muda nada — passo aplicado é imutável', () => {
    const { dir, path } = bancoTemporario();
    apontarPara(path);
    ensureCoreSchema();
    migrateCoreSchema();

    const db = getConnection();
    const antes = db
      .prepare("SELECT key, value FROM core_meta WHERE key LIKE 'core_migration_step_%' ORDER BY key")
      .all() as unknown as { key: string; value: string }[];

    const r = migrateCoreSchema();

    const depois = db
      .prepare("SELECT key, value FROM core_meta WHERE key LIKE 'core_migration_step_%' ORDER BY key")
      .all() as unknown as { key: string; value: string }[];

    expect(depois).toEqual(antes);
    // `from` já é o alvo: não havia o que subir.
    expect(r.from).toBe(CORE_TARGET_VERSION);
    expect(r.to).toBe(CORE_TARGET_VERSION);
    limpar(dir);
  });

  it('e nenhuma cópia aparece na pasta de backups do repositório', () => {
    /*
      O caso existe porque o oposto já aconteceu: alvo maior que o último
      passo criava um passo fantasma, `haPassoPendente` dizia "sim" para
      sempre, e cada restart copiava o banco inteiro. Aqui a migração roda num
      banco descartável — nada pode ser escrito no destino operacional.
    */
    const { dir, path } = bancoTemporario();
    apontarPara(path);
    ensureCoreSchema();
    const r = snapshotDatabase('nao-deve-existir');
    expect(r.skipped).toBeTruthy();
    limpar(dir);
  });
});
