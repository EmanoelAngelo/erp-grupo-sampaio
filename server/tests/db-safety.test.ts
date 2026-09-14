/**
 * Proteção do banco operacional.
 *
 * Este arquivo existe por causa de um incidente real: um script avulso de
 * depuração chamou `resetDbForTests()` e apagou a base operacional inteira —
 * produtos, empresas, usuários e vendas. Voltou só porque o arquivo estava
 * versionado.
 *
 * O que se cobra aqui é que a recusa aconteça ANTES de qualquer DELETE, e por
 * duas razões independentes: o banco não estar marcado como descartável, e o
 * caminho ser o do banco operacional. A segunda barreira vale mesmo que
 * alguém marque a base real como "de teste" por engano.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import {
  OPERATIONAL_DATABASE_PATH,
  assertDestructiveAllowed,
  isDisposableDatabase,
  isOperationalDatabase,
} from '../src/db/safety.js';
import { repoRoot } from '../src/db/sqlite.js';
import { resetDbForTests } from '../src/db/database.js';

const ORIGINAL = { ...process.env };

afterEach(() => {
  process.env.DEVORA_DATABASE_PATH = ORIGINAL.DEVORA_DATABASE_PATH;
  process.env.TEST_DATABASE_PATH = ORIGINAL.TEST_DATABASE_PATH;
});

describe('reconhecimento do banco operacional', () => {
  it('reconhece o caminho padrão, relativo ou absoluto', () => {
    expect(isOperationalDatabase('./server/data/grupo-sampaio.db')).toBe(true);
    expect(isOperationalDatabase(resolve(repoRoot(), 'server/data/grupo-sampaio.db'))).toBe(true);
  });

  it('reconhece mesmo com barras invertidas e maiúsculas do Windows', () => {
    const absoluto = resolve(repoRoot(), 'server/data/grupo-sampaio.db');
    expect(isOperationalDatabase(absoluto.replace(/\//g, '\\').toUpperCase())).toBe(true);
  });

  it('NÃO confunde outro arquivo com o operacional', () => {
    expect(isOperationalDatabase('/tmp/qualquer/test.db')).toBe(false);
    expect(isOperationalDatabase(':memory:')).toBe(false);
  });
});

describe('o que conta como banco descartável', () => {
  it('memória é sempre descartável', () => {
    expect(isDisposableDatabase(':memory:')).toBe(true);
  });

  it('sem TEST_DATABASE_PATH, nenhum arquivo é descartável', () => {
    delete process.env.TEST_DATABASE_PATH;
    expect(isDisposableDatabase('/tmp/algo/test.db')).toBe(false);
  });

  it('o nome do arquivo NÃO promove nada a descartável', () => {
    delete process.env.TEST_DATABASE_PATH;
    // "test" no nome é exatamente o tipo de heurística que faria um banco
    // chamado `producao-teste.db` ser apagado.
    expect(isDisposableDatabase('/dados/producao-teste.db')).toBe(false);
    expect(isDisposableDatabase('/dados/test.db')).toBe(false);
  });

  it('só o caminho ANUNCIADO vale, e precisa ser o mesmo', () => {
    process.env.TEST_DATABASE_PATH = '/tmp/a/test.db';
    expect(isDisposableDatabase('/tmp/a/test.db')).toBe(true);
    expect(isDisposableDatabase('/tmp/b/test.db')).toBe(false);
  });
});

describe('FALSIFICAÇÃO — a recusa acontece antes de qualquer DELETE', () => {
  it('script fora da suíte, apontando para o banco operacional, é RECUSADO', () => {
    // Reprodução exata do incidente: caminho operacional, sem marca de teste.
    process.env.DEVORA_DATABASE_PATH = OPERATIONAL_DATABASE_PATH;
    delete process.env.TEST_DATABASE_PATH;

    expect(() => assertDestructiveAllowed('resetDbForTests')).toThrow(
      /BANCO OPERACIONAL/,
    );
    expect(() => resetDbForTests()).toThrow(/BANCO OPERACIONAL/);
  });

  it('marcar a base REAL como "de teste" não abre a porta', () => {
    // A barreira positiva passaria; a negativa é que segura.
    process.env.DEVORA_DATABASE_PATH = OPERATIONAL_DATABASE_PATH;
    process.env.TEST_DATABASE_PATH = OPERATIONAL_DATABASE_PATH;

    expect(() => assertDestructiveAllowed('resetDbForTests')).toThrow(/BANCO OPERACIONAL/);
  });

  it('banco não operacional, mas sem marca, também é recusado', () => {
    process.env.DEVORA_DATABASE_PATH = '/tmp/um/banco/qualquer.db';
    delete process.env.TEST_DATABASE_PATH;

    expect(() => assertDestructiveAllowed('resetDbForTests')).toThrow(
      /não está marcado como descartável/,
    );
  });

  it('a mensagem diz QUAL banco seria destruído — sem isso ninguém entende a recusa', () => {
    process.env.DEVORA_DATABASE_PATH = OPERATIONAL_DATABASE_PATH;
    delete process.env.TEST_DATABASE_PATH;

    try {
      assertDestructiveAllowed('resetDbForTests');
      throw new Error('deveria ter recusado');
    } catch (err) {
      expect((err as Error).message).toContain('grupo-sampaio.db');
      expect((err as Error).message).toContain('TEST_DATABASE_PATH');
    }
  });

  it('com banco descartável de verdade, a operação SEGUE funcionando', () => {
    // Sem isto a trava seria inútil de outro jeito: quebrando a suíte inteira.
    process.env.DEVORA_DATABASE_PATH = ORIGINAL.DEVORA_DATABASE_PATH;
    process.env.TEST_DATABASE_PATH = ORIGINAL.TEST_DATABASE_PATH;
    expect(() => resetDbForTests()).not.toThrow();
  });
});
