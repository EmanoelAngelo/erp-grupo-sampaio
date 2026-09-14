/**
 * A VARIÁVEL APOSENTADA DO ATALHO NO BOOT — `DEVORA_DEV_QUICK_LOGIN`.
 *
 * Este arquivo cobrava as travas do atalho de desenvolvimento que entrava sem
 * senha: recusa de subida em produção e homologação, e o atalho LIGADO em
 * desenvolvimento. O atalho saiu por inteiro — não há rota, cliente nem painel
 * —, e a variável ficou aposentada.
 *
 * O que ela faz agora, por ambiente declarado:
 *
 *   - produção ou homologação: RECUSA SUBIR. Ela não abre porta nenhuma, mas
 *     ligada num `.env` de produção ela prova que ninguém revisou aquele
 *     arquivo — e a mensagem diz qual linha apagar;
 *   - o resto: sobe IGNORANDO (o esquema não a conhece mais) e avisa no log
 *     que a variável é aposentada e não liga nada.
 *
 * A matriz completa (4 ambientes × 2 NODE_ENV × 3 variáveis, e as rotas de
 * cada origem) está em `acesso-sem-senha-em-ambiente-nenhum.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { loadEnv, resetEnvCacheForTests } = await import('../src/config/env.js');

const ORIGINAL = { ...process.env };

function ambiente(vars: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetEnvCacheForTests();
}

function avisos() {
  const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  return () => spy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
}

beforeEach(() => {
  process.env = { ...ORIGINAL };
  process.env.DEVORA_JWT_SECRET = 'um-segredo-de-producao-bem-longo-e-forte';
  process.env.DEVORA_ENCRYPTION_KEY = 'uma-chave-de-producao-bem-longa-e-forte';
  delete process.env.NODE_ENV;
  delete process.env.DEVORA_DEV_QUICK_LOGIN;
  resetEnvCacheForTests();
});

afterEach(() => {
  process.env = { ...ORIGINAL };
  resetEnvCacheForTests();
  vi.restoreAllMocks();
});

describe('produção e homologação recusam subir com ela ligada', () => {
  it('production: recusa, nomeia a variável e diz o que fazer', () => {
    ambiente({ DEVORA_API_ENV: 'production', DEVORA_DEV_QUICK_LOGIN: 'true' });
    expect(() => loadEnv()).toThrow(/DEVORA_DEV_QUICK_LOGIN/);
    expect(() => loadEnv()).toThrow(/sem senha/i);
    expect(() => loadEnv()).toThrow(/apague/i);
  });

  it('staging: recusa do mesmo jeito — homologação é o ensaio de produção', () => {
    ambiente({ DEVORA_API_ENV: 'staging', DEVORA_DEV_QUICK_LOGIN: 'true' });
    expect(() => loadEnv()).toThrow(/DEVORA_DEV_QUICK_LOGIN/);
  });

  /**
   * O cenário real de deploy: o valor vem do `.env` esquecido, não do shell.
   * O carregador do `.env` escreve em `process.env` antes da trava olhar.
   */
  it('a recusa vale quando a linha vem do arquivo .env', () => {
    const pasta = mkdtempSync(join(tmpdir(), 'gs-atalho-env-'));
    const sub = join(pasta, 'server');
    mkdirSync(sub);
    writeFileSync(join(pasta, '.env'), 'DEVORA_API_ENV=production\nDEVORA_DEV_QUICK_LOGIN=true\n');
    const antes = process.cwd();
    try {
      process.chdir(sub);
      ambiente({ DEVORA_IGNORE_DOTENV: 'false', DEVORA_API_ENV: undefined, DEVORA_DEV_QUICK_LOGIN: undefined });
      expect(() => loadEnv()).toThrow(/DEVORA_DEV_QUICK_LOGIN/);
    } finally {
      process.chdir(antes);
      rmSync(pasta, { recursive: true, force: true });
    }
  });
});

describe('fora de produção, sobe ignorando — e avisa', () => {
  for (const apiEnv of ['development', 'test']) {
    it(`${apiEnv}: sobe, o esquema não a conhece, e o log diz que é aposentada`, () => {
      const escrito = avisos();
      ambiente({ DEVORA_API_ENV: apiEnv, DEVORA_DEV_QUICK_LOGIN: 'true' });
      expect(() => loadEnv()).not.toThrow();
      expect((loadEnv() as unknown as Record<string, unknown>).DEVORA_DEV_QUICK_LOGIN).toBeUndefined();
      expect(escrito()).toContain('DEVORA_DEV_QUICK_LOGIN');
      expect(escrito()).toMatch(/aposentada/i);
    });
  }

  it('ausente: sobe calado — não há o que avisar', () => {
    const escrito = avisos();
    ambiente({ DEVORA_API_ENV: 'development' });
    expect(() => loadEnv()).not.toThrow();
    expect(escrito()).not.toMatch(/aposentada/i);
  });

  it('escrita `false` em produção: sobe (não liga nada) e avisa que a linha pode sair', () => {
    const escrito = avisos();
    ambiente({ DEVORA_API_ENV: 'production', DEVORA_DEV_QUICK_LOGIN: 'false' });
    expect(() => loadEnv()).not.toThrow();
    expect(escrito()).toContain('DEVORA_DEV_QUICK_LOGIN');
  });
});
