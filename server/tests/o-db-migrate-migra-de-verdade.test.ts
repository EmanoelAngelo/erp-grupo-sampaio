/**
 * `npm run db:migrate` MIGRA, e `npm run db:status` DIZ O NÚMERO CERTO
 * (GAP-PRD-056 e GAP-PRD-057).
 *
 * O que a auditoria mediu numa instalação limpa, no Windows:
 *
 *   db:status  → version 1
 *   db:migrate → NENHUMA saída
 *   db:status  → version 1        (e o arquivo com 134 tabelas, sem core_meta)
 *
 * Duas falhas somadas. A guarda de linha de comando de `migrate.ts` montava a
 * URL à mão (`file://C:/...` contra o `file:///C:/...%20...` real) e nunca
 * casava, então o comando saía em silêncio. E mesmo quando casava, ele só
 * levava a camada de DOCUMENTOS (alvo 19): o NÚCLEO (alvo 84) só migrava
 * subindo o servidor. O `db:status` media os documentos — e CRIAVA as tabelas
 * deles para medir.
 *
 * Os comandos rodam aqui como o operador os roda — um processo novo, pelo
 * `tsx` do servidor, com `cwd` em `server/` — contra um banco numa pasta COM
 * ESPAÇO no nome, que é o caso da instalação da loja ("Grupo Sampaio").
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { CORE_TARGET_VERSION, migrateCoreSchema } from '../src/db/core-migrations.js';
import { getConnection } from '../src/db/sqlite.js';
import {
  lerVersoes,
  situacaoDoEsquema,
  versoesDoArquivo,
  versoesDoBancoEmUso,
} from '../src/db/versaoDoEsquema.js';
import { ehPontoDeEntrada } from '../src/utils/pontoDeEntrada.js';

const AQUI = dirname(fileURLToPath(import.meta.url));
const SERVIDOR = resolve(AQUI, '..');
const TSX = join(SERVIDOR, 'node_modules', 'tsx', 'dist', 'cli.mjs');

const raiz = process.env.GS_ERP_TEST_TMP_ROOT ?? tmpdir();
const pasta = mkdtempSync(join(raiz, 'gs migra com espaco '));
afterAll(() => rmSync(pasta, { recursive: true, force: true }));

/** Roda um comando do `package.json` do servidor como o npm rodaria. */
function rodar(arquivo: string, banco: string): { codigo: number | null; saida: string } {
  const r = spawnSync(process.execPath, [TSX, arquivo], {
    cwd: SERVIDOR,
    env: {
      PATH: process.env.PATH ?? '',
      SystemRoot: process.env.SystemRoot ?? '',
      DEVORA_IGNORE_DOTENV: 'true',
      DEVORA_DATABASE_PATH: banco,
      // Descartável declarado: o snapshot pré-migração pula, e nada vai para
      // a pasta de backup do repositório.
      TEST_DATABASE_PATH: banco,
      DEVORA_BACKUP_DIR: join(pasta, 'backups'),
      DEVORA_UPLOADS_DIR: join(pasta, 'uploads'),
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 180_000,
  });
  return { codigo: r.status, saida: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function versaoDoNucleo(banco: string): number | null {
  const db = new DatabaseSync(banco, { readOnly: true });
  try {
    const tem = db.prepare("SELECT name FROM sqlite_master WHERE name = 'core_meta'").get();
    if (!tem) return null;
    const row = db.prepare("SELECT value FROM core_meta WHERE key = 'core_schema_version'").get() as
      | { value?: string }
      | undefined;
    return row?.value ? Number(row.value) : null;
  } finally {
    db.close();
  }
}

describe('a guarda de linha de comando compara caminhos, não URLs montadas à mão', () => {
  it('casa com a URL real do módulo num caminho com espaço (Windows e fora dele)', () => {
    const arquivo = join(pasta, 'sub pasta', 'migrate.ts');
    const url = pathToFileURL(arquivo).href;
    expect(url).toContain('%20');
    expect(ehPontoDeEntrada(url, arquivo)).toBe(true);
  });

  it('não casa com outro arquivo, nem sem argv', () => {
    const url = pathToFileURL(join(pasta, 'migrate.ts')).href;
    expect(ehPontoDeEntrada(url, join(pasta, 'index.ts'))).toBe(false);
    expect(ehPontoDeEntrada(url, undefined)).toBe(false);
  });

  it('um caminho relativo vale contra a pasta atual, como o node o resolve', () => {
    const url = pathToFileURL(resolve('src', 'db', 'migrate.ts')).href;
    expect(ehPontoDeEntrada(url, join('src', 'db', 'migrate.ts'))).toBe(true);
  });
});

describe('npm run db:status / db:migrate — como o operador roda', () => {
  const banco = join(pasta, 'dados da loja', 'grupo-sampaio.db');

  it('status antes de existir banco: diz que não há banco, e NÃO o cria', () => {
    const r = rodar('src/db/status.ts', banco);
    expect(r.saida).toContain('SEM_BANCO');
    expect(existsSync(banco)).toBe(false);
    // Não está em dia: o código de saída diz isso a quem roda em script.
    expect(r.codigo).toBe(1);
  }, 180_000);

  it('migrate leva o NÚCLEO até o alvo desta build e diz a versão', () => {
    const r = rodar('src/db/migrate.ts', banco);
    expect(r.codigo, r.saida).toBe(0);
    expect(r.saida).toContain(`Núcleo: versão ${CORE_TARGET_VERSION}`);
    expect(versaoDoNucleo(banco)).toBe(CORE_TARGET_VERSION);
  }, 180_000);

  it('status depois: EM_DIA, com o número do núcleo — e os documentos rotulados à parte', () => {
    const r = rodar('src/db/status.ts', banco);
    expect(r.codigo, r.saida).toBe(0);
    const json = JSON.parse(r.saida.slice(r.saida.indexOf('{'))) as {
      situacao: string;
      nucleo: { versao: number; alvo: number; passosPendentes: number[] };
      documentos: { versao: number; alvo: number };
    };
    expect(json.situacao).toBe('EM_DIA');
    expect(json.nucleo).toEqual({ versao: CORE_TARGET_VERSION, alvo: CORE_TARGET_VERSION, passosPendentes: [] });
    expect(json.documentos.versao).toBe(json.documentos.alvo);
  }, 180_000);

  it('rodar o migrate de novo é inofensivo', () => {
    const r = rodar('src/db/migrate.ts', banco);
    expect(r.codigo, r.saida).toBe(0);
    expect(versaoDoNucleo(banco)).toBe(CORE_TARGET_VERSION);
  }, 180_000);
});

describe('a régua da versão', () => {
  it('cada situação', () => {
    const alvo = CORE_TARGET_VERSION;
    expect(situacaoDoEsquema(null, [], alvo)).toBe('NUNCA_MIGRADO');
    expect(situacaoDoEsquema(alvo, [], alvo)).toBe('EM_DIA');
    expect(situacaoDoEsquema(alvo - 1, [], alvo)).toBe('ATRASADO');
    // O número já mentiu neste projeto: "em dia" exige também as marcas.
    expect(situacaoDoEsquema(alvo, [7], alvo)).toBe('ATRASADO');
    expect(situacaoDoEsquema(alvo + 1, [], alvo)).toBe('ADIANTADO');
  });

  it('um arquivo com o núcleo abaixo do alvo é ATRASADO, lido sem escrever', () => {
    const arquivo = join(pasta, 'atrasado.db');
    const db = new DatabaseSync(arquivo);
    db.exec('CREATE TABLE core_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
    db.prepare("INSERT INTO core_meta VALUES ('core_schema_version', ?)").run(String(CORE_TARGET_VERSION - 10));
    db.close();
    const v = versoesDoArquivo(arquivo);
    expect(v.situacao).toBe('ATRASADO');
    expect(v.nucleo.versao).toBe(CORE_TARGET_VERSION - 10);
    expect(v.documentos.versao).toBeNull();
  });

  it('o banco em uso (o da suíte) depois da migração está EM_DIA', () => {
    migrateCoreSchema();
    const v = versoesDoBancoEmUso();
    expect(v.situacao).toBe('EM_DIA');
    expect(v.nucleo.versao).toBe(CORE_TARGET_VERSION);
  });
});

describe('a migração não abaixa o número de um banco mais novo que o código', () => {
  /*
    O ROLLBACK DE APLICAÇÃO (docs/GO_LIVE_ROLLBACK.md) sobe a build anterior
    sobre o banco preservado. `migrateCoreSchema` terminava sempre com
    `setVersion(CORE_TARGET_VERSION)`: a build velha REESCREVIA para baixo o
    número que a nova tinha gravado, e o status passava a dizer "em dia" sobre
    um banco que não é desta build.
  */
  it('núcleo acima do alvo continua acima, e o status diz ADIANTADO', () => {
    migrateCoreSchema();
    const conn = getConnection();
    conn
      .prepare("UPDATE core_meta SET value = ? WHERE key = 'core_schema_version'")
      .run(String(CORE_TARGET_VERSION + 3));
    migrateCoreSchema();
    const v = lerVersoes(conn);
    expect(v.nucleo.versao).toBe(CORE_TARGET_VERSION + 3);
    expect(v.situacao).toBe('ADIANTADO');
    conn
      .prepare("UPDATE core_meta SET value = ? WHERE key = 'core_schema_version'")
      .run(String(CORE_TARGET_VERSION));
  });
});
