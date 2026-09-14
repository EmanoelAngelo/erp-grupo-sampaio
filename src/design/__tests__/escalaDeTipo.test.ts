/**
 * A ESCALA DE TIPO PRECISA CHEGAR NA TELA — rodada 56.
 *
 * ============================================================================
 * O DEFEITO, MEDIDO NO NAVEGADOR
 * ============================================================================
 *
 * Conferindo a vitrine contra o banco real, o título da loja saiu com 15px
 * onde o token diz 28. Medindo os outros: `xs`, `sm`, `lg` e `2xl` computavam
 * TODOS 15px — a escala inteira, achatada num tamanho só.
 *
 * A causa está na regra que o Tailwind gerou:
 *
 *     .text-\[var\(--gs-text-2xl\)\] { color: var(--gs-text-2xl); }
 *
 * `text-[…]` é AMBÍGUO: serve para cor e para tamanho. Sem dica de tipo, o
 * Tailwind resolve como COR. Então o `font-size` nunca era aplicado (herdava
 * os 15px do body) e, de quebra, tentava pintar o texto de `28px`, valor que o
 * navegador descarta em silêncio.
 *
 * Resultado: o projeto declarava sete degraus de tipografia — 12, 13, 15, 18,
 * 22, 28, 36 — e renderizava um só. Nenhum título era maior que o corpo, em
 * tela nenhuma, desde que os tokens existem. É por isso que toda página tinha
 * a mesma textura cinza e nada guiava o olho.
 *
 * A dica de tipo (`length:`) é o conserto, e vale para as classes de TAMANHO.
 * As de COR — `--gs-text`, `--gs-text-soft`, `--gs-text-invert` — moram no
 * mesmo prefixo e continuam certas como estão: é o mesmo prefixo carregando
 * duas coisas diferentes, que foi o que criou a armadilha.
 *
 * ============================================================================
 * POR QUE UM TESTE DE VARREDURA, E NÃO UM DE TELA
 * ============================================================================
 *
 * Um teste de tela mediria uma página. Isto aqui vale para as oitenta que
 * usam os tokens, e falha no dia em que alguém escrever a próxima sem a dica
 * — que é exatamente como as 1.082 anteriores foram escritas.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A pasta de origem, a partir da raiz do projeto.
 *
 * `import.meta.url` em vez de `__dirname` porque o pacote é ESM, e o caminho é
 * montado do `url` do próprio arquivo para o teste não depender de onde o
 * vitest foi chamado.
 */
const AQUI = dirname(fileURLToPath(import.meta.url));

/** Os tokens de TAMANHO. Os de cor moram no mesmo prefixo e não entram aqui. */
const TOKENS_DE_TAMANHO = ['xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl'];

/**
 * Os tokens de COR que moram no MESMO prefixo — e e daí que vem a armadilha.
 *
 * O sufixo vazio e o proprio `--gs-text`, que e a cor de corpo.
 */
const TOKENS_DE_COR = ['', '-soft', '-invert'];

/**
 * O código, sem os comentários.
 *
 * A varredura procura texto, e o texto de um COMENTÁRIO que cita o defeito é
 * indistinguível do defeito. Os dois consertos desta rodada explicam a
 * armadilha por extenso no comentário — e a varredura acusava justamente a
 * explicação, obrigando quem documenta a escolher entre o teste verde e a
 * frase clara.
 *
 * Tirar os comentários antes de procurar resolve os dois lados: a explicação
 * continua legível e o guarda continua olhando só para o que vira CSS.
 */
function semComentarios(fonte: string): string {
  return fonte
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function arquivosDeTela(dir: string, achados: string[] = []): string[] {
  for (const nome of readdirSync(dir)) {
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) {
      if (nome === 'node_modules') continue;
      arquivosDeTela(caminho, achados);
      continue;
    }
    if (/\.(tsx|ts)$/.test(nome)) achados.push(caminho);
  }
  return achados;
}

describe('a escala de tipo chega na tela', () => {
  it('nenhuma classe de TAMANHO é escrita sem a dica de tipo', () => {
    const raiz = resolve(AQUI, '..', '..');
    const semDica: string[] = [];

    for (const arquivo of arquivosDeTela(raiz)) {
      const conteudo = semComentarios(readFileSync(arquivo, 'utf8'));
      for (const token of TOKENS_DE_TAMANHO) {
        // Sem a dica, a classe vira regra de COR e o tamanho nunca aplica.
        const errado = `text-[var(--gs-text-${token})]`;
        if (conteudo.includes(errado)) {
          semDica.push(`${arquivo.replace(raiz, 'src')} → ${errado}`);
        }
      }
    }

    expect(
      semDica,
      'Estas classes viram regra de COR e o tamanho nunca aplica. '
        + 'Use text-[length:var(--gs-text-…)].\n' + semDica.slice(0, 20).join('\n'),
    ).toEqual([]);
  });

  /**
   * A AMBIGUIDADE TEM DOIS LADOS, e a varredura acima só guardava um.
   *
   * `text-[…]` serve para cor e para tamanho. Faltar a dica num token de
   * TAMANHO faz o tamanho sumir — é o defeito que a rodada consertou. Mas
   * SOBRAR a dica num token de COR faz o contrário: o Tailwind gera
   * `font-size: #4a4356`, que o navegador descarta, e o texto perde a cor
   * herdando a de cima. Some sem erro, exatamente como o outro.
   *
   * Os dois casos vêm do mesmo prefixo carregando duas coisas, e por isso os
   * dois são guardados no mesmo lugar.
   */
  it('nenhum token de COR leva a dica de tamanho', () => {
    const raiz = resolve(AQUI, '..', '..');
    const trocados: string[] = [];

    for (const arquivo of arquivosDeTela(raiz)) {
      const conteudo = semComentarios(readFileSync(arquivo, 'utf8'));
      for (const token of TOKENS_DE_COR) {
        const errado = `text-[length:var(--gs-text${token})]`;
        if (conteudo.includes(errado)) {
          trocados.push(`${arquivo.replace(raiz, 'src')} → ${errado}`);
        }
      }
    }

    expect(
      trocados,
      'Estes são tokens de COR: com a dica `length:` o navegador descarta a '
        + 'regra e o texto perde a cor.\n' + trocados.join('\n'),
    ).toEqual([]);
  });

  it('os sete degraus da escala continuam declarados, e distintos', () => {
    const css = readFileSync(resolve(AQUI, '..', 'tokens.css'), 'utf8');
    const valores = TOKENS_DE_TAMANHO.map((t) => {
      const m = new RegExp(`--gs-text-${t}:\\s*([^;]+);`).exec(css);
      return m?.[1].trim();
    });

    // Sete degraus, sete valores diferentes. Dois iguais fariam um dos dois
    // não significar nada — e o conserto acima só serve se houver escala.
    expect(valores.every(Boolean), `faltou declarar: ${valores}`).toBe(true);
    expect(new Set(valores).size).toBe(TOKENS_DE_TAMANHO.length);
  });
});
