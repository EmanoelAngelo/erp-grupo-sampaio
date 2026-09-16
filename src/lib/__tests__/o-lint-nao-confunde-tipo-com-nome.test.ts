import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * ============================================================================
 * O PORTÃO DE LINT NÃO PODE CHAMAR ANOTAÇÃO DE TIPO DE ERRO
 * ============================================================================
 *
 * ## O defeito que este arquivo guarda
 *
 * `npm run lint:frontend` estava vermelho na base da entrega, com UM erro:
 * `'KeyboardEventInit' is not defined  no-undef`, num arquivo de teste do PDV.
 * O nome é o TIPO de um parâmetro — some na compilação, nunca existe em
 * execução. O portão que existe para segurar defeito estava segurando código
 * correto, e assim atravessou um commit inteiro: portão que grita à toa é
 * portão que se aprende a ignorar.
 *
 * O porquê (e por que recorre) está escrito em `eslint.config.ts`, na linha da
 * regra. Aqui fica a PROVA, e ela é dos dois lados — porque desligar uma regra
 * sem mostrar quem assumiu o trabalho dela é como trocar a fechadura por um
 * bilhete.
 *
 * ## Por que o eslint roda como PROCESSO
 *
 * Pelo mesmo motivo de `server/tests/regra-rota-declara-alcance.test.ts`: o
 * que precisa ser provado é a configuração QUE O PORTÃO RESOLVE para um
 * arquivo de `src`, e não o comportamento de uma regra alimentada à mão. Uma
 * prova que instancia a regra passaria mesmo com o bloco da config apagado.
 *
 * ## O caso 2 é o que impede este arquivo de ser complacente
 *
 * Ele força a MESMA regra a valer sobre o MESMO texto e exige o erro de volta.
 * Sem ele, o caso 1 ficaria verde por qualquer motivo — inclusive pelo eslint
 * ter deixado de ler o arquivo. Com ele, o verde do caso 1 só pode significar
 * "a regra está desligada para este caminho", que é exatamente a afirmação.
 */

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(AQUI, '..', '..', '..');

/** Um tipo do DOM numa anotação, e nada mais: o formato exato do falso positivo. */
const TIPO_DO_DOM = 'export function tecla(extra: KeyboardEventInit = {}) {\n  return extra;\n}\n';

interface ResultadoDoLint {
  messages: { ruleId: string | null; message: string }[];
}

/*
  O binário do eslint pelo CAMINHO, chamado pelo node que já está rodando —
  e não por `npx`. No Windows o `npx.cmd` é um script de shell, e `spawnSync`
  sem shell o recusa com EINVAL; e `npx` ainda poderia ir buscar outra versão
  na rede. Este é o mesmo eslint que `npm run lint:frontend` dispara.
*/
const ESLINT = resolve(RAIZ, 'node_modules/eslint/bin/eslint.js');

function lintar(texto: string, ...extras: string[]): ResultadoDoLint[] {
  const r = spawnSync(
    process.execPath,
    [
      ESLINT,
      '--stdin',
      // O caminho decide qual bloco da config flat se aplica — é o que está sob prova.
      '--stdin-filename',
      'src/pages/gs/__tests__/prova-do-portao.test.tsx',
      '--format',
      'json',
      ...extras,
    ],
    { cwd: RAIZ, input: texto, encoding: 'utf8' },
  );
  // O eslint sai com 1 quando acha erro — o caso 2 espera exatamente isso.
  try {
    return JSON.parse(r.stdout) as ResultadoDoLint[];
  } catch {
    throw new Error(`eslint não devolveu JSON (código ${r.status}).\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  }
}

// Prazo de PROCESSO EXTERNO: estes casos abrem outro programa e não medem código daqui.
describe('o portão de lint da tela', { timeout: 120_000 }, () => {
  it('0. o eslint que o portão usa está onde este arquivo o procura', () => {
    expect(existsSync(ESLINT), `eslint não encontrado em ${ESLINT}`).toBe(true);
  });

  it('1. um tipo do DOM numa anotação passa — é anotação, não identificador inventado', () => {
    const [resultado] = lintar(TIPO_DO_DOM);
    expect(resultado.messages.map((m) => `${m.ruleId ?? 'sem-regra'}: ${m.message}`)).toEqual([]);
  });

  it('2. e passa porque a regra está desligada, não por acaso: ligada à força, o erro volta', () => {
    const [resultado] = lintar(TIPO_DO_DOM, '--rule', '{"no-undef":"error"}');
    const doNoUndef = resultado.messages.filter((m) => m.ruleId === 'no-undef');
    expect(doNoUndef).toHaveLength(1);
    expect(doNoUndef[0].message).toContain('KeyboardEventInit');
  });

  it('3. quem assumiu o trabalho da regra é o tsc — e ele enxerga os testes de src', () => {
    /*
      A garantia de `no-undef` não sumiu: mudou de dono. `tsc --noEmit` recusa
      nome indefinido com TS2304, e o projeto o roda sobre `tsconfig.app.json`.
      O que este caso cobra é a única condição que faria essa troca ser mentira
      — o compilador deixar de OLHAR para os arquivos em questão. Se alguém
      estreitar o `include` para fora de `src` (ou tirar os testes dele), o
      comentário da config vira promessa vazia e este caso fica vermelho.
    */
    const bruto = readFileSync(resolve(RAIZ, 'tsconfig.app.json'), 'utf8');
    // O arquivo tem vírgula sobrando em `paths`; a leitura aqui é textual de propósito.
    const include = /"include"\s*:\s*\[([^\]]*)\]/.exec(bruto)?.[1] ?? '';
    expect(include).toContain('"src"');

    const scripts = JSON.parse(readFileSync(resolve(RAIZ, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(scripts.scripts['type-check:frontend']).toContain('tsconfig.app.json');
    expect(scripts.scripts['type-check']).toContain('type-check:frontend');
  });
});
