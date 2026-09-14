/**
 * OS DOCUMENTOS DE OPERAÇÃO APONTAM PARA O QUE EXISTE (GAP-PRD-064).
 *
 * A auditoria seguiu OPERATIONS.md e POST_DEPLOY_CHECKLIST.md e não achou as
 * telas (`/sistema/administracao/status|saude|prontidao|go-live`), nem os
 * comandos (`npm run restore:verify`, `npm run seed`). Documento que manda para
 * lugar nenhum é pior que documento nenhum: quem está no meio de um incidente
 * perde tempo procurando, e para de confiar no resto.
 *
 * Este teste lê os roteiros de operação e cobra, de cada referência:
 *
 *   - `/sistema/...`                      uma rota declarada em gsRoutes.tsx;
 *   - `npm run <x>` e `--prefix server`   um script do package.json certo;
 *   - `node server/dist/<pasta>/<x>.js`   o fonte `server/src/<pasta>/<x>.ts`.
 *
 * Um documento novo que cite tela ou comando entra na lista — e passa a ser
 * cobrado do mesmo jeito.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(AQUI, '..', '..');

const DOCUMENTOS = [
  'docs/OPERATIONS.md',
  'docs/POST_DEPLOY_CHECKLIST.md',
  'docs/GO_LIVE_ROLLBACK.md',
  'docs/MONITORING_FIRST_HOURS.md',
  'docs/GO_LIVE_CHECKLIST.md',
  'docs/DEPLOY.md',
];

const ler = (relativo: string) => readFileSync(join(RAIZ, relativo), 'utf8');

/** As rotas do navegador, como padrões (`:id` casa um segmento). */
function rotasDoNavegador(): RegExp[] {
  const fonte = ler('src/router/gsRoutes.tsx');
  const caminhos = [...fonte.matchAll(/['"](\/sistema\/[^'"\s]*)['"]/g)].map((m) => m[1]);
  return caminhos.map((c) => new RegExp(`^${c.replace(/:[A-Za-z]+/g, '[^/]+')}$`));
}

function scripts(pacote: string): Set<string> {
  const json = JSON.parse(ler(pacote)) as { scripts?: Record<string, string> };
  return new Set(Object.keys(json.scripts ?? {}));
}

export function referenciasQuebradas(texto: string): string[] {
  const rotas = rotasDoNavegador();
  const daRaiz = scripts('package.json');
  const doServidor = scripts('server/package.json');
  const quebradas: string[] = [];

  for (const m of texto.matchAll(/\/sistema\/[a-z0-9/:-]*[a-z0-9]/g)) {
    const caminho = m[0];
    if (!rotas.some((r) => r.test(caminho))) quebradas.push(`tela ${caminho}`);
  }
  for (const m of texto.matchAll(/npm run ([a-z][a-z0-9:-]*)( --prefix server)?/g)) {
    const [, nome, prefixo] = m;
    const existe = prefixo ? doServidor.has(nome) : daRaiz.has(nome);
    if (!existe) quebradas.push(`comando npm run ${nome}${prefixo ?? ''}`);
  }
  for (const m of texto.matchAll(/node server\/dist\/([a-z]+)\/([a-z0-9-]+)\.js/g)) {
    const [, pasta, nome] = m;
    if (!existsSync(join(RAIZ, 'server', 'src', pasta, `${nome}.ts`))) {
      quebradas.push(`compilado server/dist/${pasta}/${nome}.js`);
    }
  }
  return quebradas;
}

describe('os roteiros de operação só citam tela e comando que existem', () => {
  for (const doc of DOCUMENTOS) {
    it(doc, () => {
      expect(referenciasQuebradas(ler(doc))).toEqual([]);
    });
  }

  it('a régua pega o que a auditoria achou (senão ficaria verde lendo nada)', () => {
    const antigo = [
      '- `/sistema/administracao/status`',
      'npm run restore:verify',
      'npm run seed',
      'node server/dist/scripts/restore-verify.js',
    ].join('\n');
    expect(referenciasQuebradas(antigo)).toEqual([
      'tela /sistema/administracao/status',
      'comando npm run restore:verify',
      'comando npm run seed',
      'compilado server/dist/scripts/restore-verify.js',
    ]);
  });

  it('e aceita o que existe, com parâmetro de rota', () => {
    expect(
      referenciasQuebradas(
        '`/sistema/empresas/abc/implantacao` e `npm run db:seed --prefix server` e `node server/dist/db/status.js`',
      ),
    ).toEqual([]);
  });
});
