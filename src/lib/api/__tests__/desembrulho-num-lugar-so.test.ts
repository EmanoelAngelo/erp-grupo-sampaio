/**
 * O DESEMBRULHO MORA NUM LUGAR SÓ — e este arquivo é o que impede a volta.
 *
 * O defeito não estava em nenhum dos 58 `.then((r) => r.items)`: cada um,
 * sozinho, é razoável. Estava em serem 58 — cada um decidindo por conta
 * própria o que fazer quando a chave não vem, e todos decidindo a mesma coisa
 * errada: nada.
 *
 * Consertar os 58 não conserta o 59º. O que conserta é a regra ter UM dono e
 * este teste cobrar que ninguém mais decida sozinho.
 *
 * ## A varredura cobre `src/` INTEIRO, e não só `src/lib/api`
 *
 * A primeira versão deste arquivo varria só a pasta do cliente — e o 59º
 * desembrulho nasceu exatamente onde ela não olhava: as TELAS. A auditoria
 * achou cinco `.then((r) => r.campo)` crus em `GestaoPages.tsx` e
 * `OperacaoPages.tsx`, cada um com o mesmo defeito que motivou a regra: corpo
 * sem a chave vira `undefined`, a promessa RESOLVE, o `catch` da tela não
 * dispara, e o estouro acontece longe dali, num `.map` do render. Uma regra
 * que só vale dentro de uma pasta não é regra — é decoração.
 *
 * ## O que é recusado
 *
 *   .then((r) => r.items)          — desembrulho cru
 *   .then((r) => r.items ?? [])    — pior: fabrica lista vazia e esconde falha
 *   .then((resposta) => resposta.x) — o mesmo com outro nome de parâmetro
 *
 * ## O que passa
 *
 *   .then(envelope('items'))       — o desembrulho oficial
 *   .then((r) => r.items.length)   — leitura DERIVADA, não desembrulho: quem
 *                                     escreveu já resolveu o que fazer com o
 *                                     resultado, e o guarda não tem opinião.
 *   .then((r) => exigirCampos(r, 'session').session)
 *                                  — o guarda para corpo de VÁRIOS campos:
 *                                     a chave ausente vira erro, e o valor
 *                                     nulo legítimo continua passando.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const PASTA = 'src/lib/api';
const RAIZ = 'src';

/** Todo módulo de cliente da API — não os testes. */
function modulos(): string[] {
  return readdirSync(PASTA)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => join(PASTA, f));
}

/**
 * Todo arquivo de código do frontend — telas, hooks, componentes, roteador.
 *
 * Testes ficam de fora porque citam o padrão recusado de propósito (este
 * arquivo inclusive); `.d.ts` fica de fora porque é declaração, não código.
 */
function arquivosDoFrontend(pasta = RAIZ): string[] {
  const achados: string[] = [];
  for (const entrada of readdirSync(pasta, { withFileTypes: true })) {
    const caminho = join(pasta, entrada.name);
    if (entrada.isDirectory()) {
      if (entrada.name === '__tests__' || entrada.name === 'node_modules') continue;
      achados.push(...arquivosDoFrontend(caminho));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entrada.name)) continue;
    if (/\.test\.(ts|tsx)$/.test(entrada.name) || entrada.name.endsWith('.d.ts')) continue;
    achados.push(caminho);
  }
  return achados;
}

interface Cru {
  arquivo: string;
  linha: number;
  texto: string;
}

/**
 * Desembrulho cru: `.then((x) => x.chave)` e nada mais depois da chave.
 *
 * A âncora `\)` logo após o identificador é o que separa desembrulho de
 * leitura derivada: `r.items.length` e `r.items.map(...)` não casam, porque
 * quem escreveu já está fazendo alguma coisa com o valor.
 */
function crus(): Cru[] {
  const achados: Cru[] = [];
  for (const arquivo of arquivosDoFrontend()) {
    const linhas = readFileSync(arquivo, 'utf8').split(/\r?\n/);
    linhas.forEach((texto, i) => {
      if (/^\s*\*/.test(texto)) return; // comentário
      const m = texto.match(/\.then\(\(\s*(\w+)\s*\)\s*=>\s*\1\.[a-zA-Z0-9_]+\s*(\?\?[^)]*)?\)/);
      if (m) achados.push({ arquivo, linha: i + 1, texto: texto.trim() });
    });
  }
  return achados;
}

// ============================================================================

describe('nenhum desembrulho fora do lugar', () => {
  it('a varredura enxerga os arquivos — senão ficaria verde varrendo nada', () => {
    const lidos = arquivosDoFrontend();
    // Mais que os módulos do cliente: as telas têm de estar dentro do alcance,
    // senão o 59º desembrulho volta a nascer exatamente onde ninguém olha.
    expect(lidos.length).toBeGreaterThan(50);
    expect(lidos.some((f) => f.includes('core.ts'))).toBe(true);
    expect(lidos.some((f) => f.includes('GestaoPages.tsx'))).toBe(true);
    expect(lidos.some((f) => f.includes('OperacaoPages.tsx'))).toBe(true);
  });

  it('nenhum `.then((r) => r.chave)` sobrou no frontend inteiro', () => {
    const achados = crus();
    expect(
      achados.map((a) => `${a.arquivo}:${a.linha} — ${a.texto}`),
      'use `.then(envelope(\'chave\'))` (ou `exigirCampos` para corpo de vários campos): '
        + 'contrato quebrado tem de virar erro, não `undefined`',
    ).toEqual([]);
  });

  it('e o desembrulho oficial está em uso de verdade', () => {
    /*
      Sem este caso, apagar todos os `.then` deixaria o anterior verde — e a
      regra teria sido cumprida esvaziando o arquivo, não consertando-o.
    */
    const core = readFileSync(join(PASTA, 'core.ts'), 'utf8');
    const usos = (core.match(/\.then\(envelope\('/g) ?? []).length;
    expect(usos).toBeGreaterThan(50);
  });

  it('nenhum `?? []` disfarçado de fallback sobrou junto de um desembrulho', () => {
    for (const arquivo of arquivosDoFrontend()) {
      const texto = readFileSync(arquivo, 'utf8');
      expect(
        /\.then\([^)]*\?\?\s*\[\]/.test(texto),
        `${arquivo}: um \`?? []\` no desembrulho transforma falha em "não há registros"`,
      ).toBe(false);
    }
  });
});
