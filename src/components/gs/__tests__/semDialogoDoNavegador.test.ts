/**
 * NENHUMA TELA VOLTA AO DIÁLOGO DO NAVEGADOR, E TODO MODAL PRENDE O FOCO
 * (GAP-PRD-158, GAP-PRD-159) — a trava que impede a regressão.
 *
 * `window.prompt`/`window.confirm` bloqueiam a aba, têm cara diferente em cada
 * navegador, somem em quiosque e não validam nada; o motivo e a certeza vão pelas
 * perguntas da tela (`PerguntaDaTela`). Diálogo modal (`role="dialog"` com
 * `aria-modal="true"`) prende o foco e o devolve a quem abriu (`prenderFoco`,
 * `useArmadilhaDeFoco` ou `DialogoBase`).
 *
 * O parêntese separa a CHAMADA do comentário que conta por que ela saiu — o
 * mesmo critério de `pdvQuantidadeEObservacao`.
 *
 * `AINDA_NA_JUNCAO` é a lista, nomeada, do que espera a junção de uma frente. Ela
 * só pode ENCOLHER: arquivo que já está limpo e continua na lista também faz o
 * teste cair, para ninguém esquecer de tirá-lo. Antes da reauditoria final a
 * lista tem de estar vazia.
 */
import { describe, expect, it } from 'vitest';

const FONTES = import.meta.glob<string>(
  ['/src/**/*.tsx', '/src/**/*.ts', '!/src/**/__tests__/**', '!/src/**/*.d.ts'],
  { query: '?raw', import: 'default', eager: true },
);

/** Arquivo → o que falta nele e a junção de que depende. */
const AINDA_NA_JUNCAO: Record<string, string> = {};

const CHAMADA_NATIVA = /window\.(prompt|confirm|alert)\(/;
const MODAL = /role="dialog"[\s\S]{0,200}?aria-modal="true"|aria-modal="true"[\s\S]{0,200}?role="dialog"/;
const ARMADILHA = /prenderFoco|useArmadilhaDeFoco|DialogoBase/;

/**
 * O código sem os comentários: a história de por que a chamada saiu (que às vezes
 * a cita, com parêntese e tudo) não é a chamada. O `//` dentro de URL (`https://`)
 * fica — só se tira comentário de linha que não venha depois de `:`.
 */
function semComentarios(fonte: string): string {
  return fonte.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function problemasDe(fonte: string): string[] {
  const codigo = semComentarios(fonte);
  const p: string[] = [];
  if (CHAMADA_NATIVA.test(codigo)) p.push('diálogo nativo do navegador');
  if (MODAL.test(codigo) && !ARMADILHA.test(codigo)) p.push('modal sem armadilha de foco');
  return p;
}

describe('as telas não voltam ao diálogo do navegador, e todo modal prende o foco', () => {
  it('a varredura enxerga as telas — senão ficaria verde lendo nada', () => {
    expect(Object.keys(FONTES).length).toBeGreaterThan(100);
    expect(FONTES['/src/components/gs/armadilhaDeFoco.ts']).toContain('export function prenderFoco');
  });

  it('nenhum arquivo fora da lista tem diálogo nativo ou modal sem armadilha', () => {
    const achados = Object.entries(FONTES)
      .filter(([arquivo]) => !(arquivo in AINDA_NA_JUNCAO))
      .flatMap(([arquivo, fonte]) => problemasDe(fonte).map((p) => `${arquivo}: ${p}`));
    expect(achados).toEqual([]);
  });

  it('a lista do que espera junção só encolhe: arquivo já limpo sai dela', () => {
    const jaLimpos = Object.keys(AINDA_NA_JUNCAO).filter(
      (arquivo) => FONTES[arquivo] !== undefined && problemasDe(FONTES[arquivo]).length === 0,
    );
    const inexistentes = Object.keys(AINDA_NA_JUNCAO).filter((arquivo) => FONTES[arquivo] === undefined);
    expect({ jaLimpos, inexistentes }).toEqual({ jaLimpos: [], inexistentes: [] });
  });
});
