/**
 * ============================================================================
 * OS COMANDOS DO OPERADOR PRECISAM EXISTIR
 * ============================================================================
 *
 * Descoberto na auditoria de publicação (30/08/2026): o commit 9a9aac2 apagou
 * a pasta `server/scripts/` inteira — decisão certa, eram scripts soltos da
 * era de desenvolvimento —, mas o `package.json` da raiz continuou apontando
 * para ela. Vinte aliases quebrados, e entre eles os quatro que importam no
 * dia do desastre:
 *
 *     npm run backup          → módulo inexistente
 *     npm run backup:verify   → módulo inexistente
 *     npm run db:restore      → módulo inexistente
 *     npm run secret:scan     → módulo inexistente
 *
 * O GO_LIVE_CHECKLIST manda rodar `backup:verify` no primeiro passo, e o
 * comando não executava. Backup sem caminho de restauração operável não está
 * validado para produção — e nenhum teste conferia que os comandos anunciados
 * apontam para código que existe.
 *
 * ## O que este arquivo trava
 *
 * 1. Todo script npm (raiz e server) que referencia um arquivo aponta para um
 *    arquivo que EXISTE — o alias quebrado nunca mais dorme no repositório.
 * 2. Os cinco comandos operacionais têm nome garantido: `backup`,
 *    `backup:verify`, `db:backups`, `db:restore`, `secret:scan`.
 */
process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = fileURLToPath(new URL('../../', import.meta.url));

function scriptsDe(pacote: string): Record<string, string> {
  const json = JSON.parse(readFileSync(resolve(RAIZ, pacote), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  return json.scripts ?? {};
}

/**
 * Tokens de um comando que têm cara de caminho de arquivo de código, cada um
 * com a base contra a qual resolve. Um comando `a && b` são dois comandos, e
 * `npm run ... --prefix server -- tests/x.test.ts` resolve o caminho a partir
 * de `server/`, não da raiz — foi exatamente essa diferença que escondeu os
 * aliases quebrados: ninguém conferia nenhuma das duas bases.
 */
function arquivosReferenciados(comando: string, basePadrao: string): Array<{
  arquivo: string;
  base: string;
}> {
  const referencias: Array<{ arquivo: string; base: string }> = [];
  for (const trecho of comando.split('&&')) {
    const base = /--prefix\s+server\b/.test(trecho) ? resolve(RAIZ, 'server') : basePadrao;
    for (const t of trecho.trim().split(/\s+/)) {
      if (t.includes('/') && /\.(ts|tsx|js|mjs|cjs)$/.test(t)) {
        referencias.push({ arquivo: t, base });
      }
    }
  }
  return referencias;
}

/**
 * O alvo existe — ou é SAÍDA DO BUILD cujo fonte existe.
 *
 * `node dist/index.js` e `node server/dist/scripts/x.js` apontam para o que o
 * `tsc` gera; `dist/` não é versionado. Exigir o arquivo compilado fazia este
 * teste passar só numa árvore já compilada e cair em clone novo e na CI, que
 * é justamente onde a instalação é conferida. O que se confere, então, é o
 * fonte que o build transforma nele: `dist/<x>.js` ← `src/<x>.ts`.
 */
function existeOuSaiDoBuild(alvo: string): boolean {
  if (existsSync(alvo)) return true;
  const normal = alvo.replace(/\\/g, '/');
  if (!/\/dist\//.test(normal) || !/\.js$/.test(normal)) return false;
  const fonte = normal.replace(/\/dist\//, '/src/').replace(/\.js$/, '.ts');
  return existsSync(fonte);
}

describe('os comandos do operador existem', () => {
  const casos: Array<{ pacote: string; base: string }> = [
    { pacote: 'package.json', base: RAIZ },
    { pacote: 'server/package.json', base: resolve(RAIZ, 'server') },
  ];

  for (const { pacote, base } of casos) {
    it(`todo script de ${pacote} aponta para arquivo que existe`, () => {
      const scripts = scriptsDe(pacote);
      const quebrados: string[] = [];
      for (const [nome, comando] of Object.entries(scripts)) {
        for (const ref of arquivosReferenciados(comando, base)) {
          if (!existeOuSaiDoBuild(resolve(ref.base, ref.arquivo))) {
            quebrados.push(`npm run ${nome} → ${ref.arquivo}`);
          }
        }
      }
      expect(quebrados, 'aliases apontando para arquivo inexistente:\n' + quebrados.join('\n'))
        .toEqual([]);
    });
  }

  it('os cinco comandos operacionais têm o nome anunciado nos documentos', () => {
    /*
      GO_LIVE_CHECKLIST e DEPLOY.md chamam estes nomes. Renomear o alias sem
      renomear o documento deixa o operador com um comando que não existe —
      exatamente o defeito que este arquivo enterra.
    */
    const scripts = scriptsDe('package.json');
    for (const nome of ['backup', 'backup:verify', 'db:backups', 'db:restore', 'secret:scan']) {
      expect(scripts[nome], `npm run ${nome} sumiu do package.json`).toBeTruthy();
    }
  });
});
