/**
 * As duas cópias de `parseReaisToCents` não podem divergir (GAP-PRD-143).
 *
 * O texto que a pessoa digita vira centavos em DOIS lugares: aqui, na tela
 * (`src/components/gs/format.ts`), e no servidor
 * (`server/src/services/core/Money.ts`). Não é escolha — são dois pacotes, e o
 * `server/tsconfig.json` não tem caminho para fora do próprio `src`.
 *
 * O comentário de `Money.ts` prometia este arquivo desde a primeira cópia, e
 * ele não existia: as duas funções respondiam igual por sorte. Uma divergência
 * futura faria a tela mandar um valor e o servidor ler outro — "1.500" virando
 * mil e quinhentos num lado e um e meio no outro, sem erro em lugar nenhum.
 *
 * A comparação é de COMPORTAMENTO, não de texto (o teste do EAN compara texto
 * porque lá o dado É a tabela). Três camadas:
 *
 *   1. a tabela de casos que o balcão produz, com o valor esperado escrito à
 *      mão — as duas têm de dar o MESMO e o CERTO;
 *   2. todas as sequências de até cinco caracteres sobre {1, 0, '.', ','},
 *      com e sem "R$ " e sinal — o que a tabela esqueceu, a varredura acha;
 *   3. a falsificação: uma cópia de propósito errada TEM de ser apanhada, senão
 *      a comparação virou enfeite.
 */
import { describe, expect, it } from 'vitest';
import { parseReaisToCents as daTela } from '../format';
import { parseReaisToCents as doServidor } from '../../../../server/src/services/core/Money';

type Leitor = (texto: string) => number | null;

/** Os textos em que os dois leitores discordam. Vazio = sincronizados. */
function divergencias(a: Leitor, b: Leitor, textos: readonly string[]): string[] {
  return textos.filter((t) => a(t) !== b(t));
}

/** Tudo de 1 a `max` caracteres sobre o alfabeto dado. */
function todasAsSequencias(alfabeto: readonly string[], max: number): string[] {
  const saida: string[] = [];
  let camada = [''];
  for (let n = 1; n <= max; n += 1) {
    camada = camada.flatMap((prefixo) => alfabeto.map((c) => prefixo + c));
    saida.push(...camada);
  }
  return saida;
}

/** O que o balcão escreve, e quanto isso vale. `null` = não é dinheiro. */
const CASOS: ReadonlyArray<[string, number | null]> = [
  ['', null],
  ['   ', null],
  ['0', 0],
  ['1', 100],
  ['10', 1000],
  ['1,5', 150],
  ['1,50', 150],
  ['0,01', 1],
  ['0,005', 1],
  ['1.500', 150_000],
  ['1.500,00', 150_000],
  ['1.234,56', 123_456],
  ['1,234.56', 123_456],
  ['12.50', 1250],
  ['12.5', 1250],
  ['R$ 3,30', 330],
  ['r$3,30', 330],
  ['R$ 1.234.567,89', 123_456_789],
  ['1 500,00', 150_000],
  ['00012,30', 1230],
  [',5', 50],
  ['5,', 500],
  ['R$', null],
  ['-5', null],
  [',', null],
  ['.', null],
  ['abc', null],
  ['1.2.3,4', 12_340],
  ['1.2.3,4,5', 123_450],
];

describe('parseReaisToCents — tela e servidor dizem o mesmo número', () => {
  it.each(CASOS)('"%s" vale %s centavos nas DUAS cópias', (texto, esperado) => {
    expect([daTela(texto), doServidor(texto)]).toEqual([esperado, esperado]);
  });

  it('nenhuma sequência curta de dígitos e separadores lê diferente', () => {
    const base = todasAsSequencias(['1', '0', '.', ','], 5);
    const textos = [
      ...base,
      ...base.map((t) => `R$ ${t}`),
      ...base.map((t) => `-${t}`),
      ...base.map((t) => ` ${t} `),
    ];
    // Sanidade do gerador: 4 + 16 + 64 + 256 + 1024 sequências, quatro formas.
    expect(textos).toHaveLength(1364 * 4);
    expect(divergencias(daTela, doServidor, textos)).toEqual([]);
  });

  it('FALSIFICAÇÃO: uma cópia que lê "1.500" como um e meio é apanhada', () => {
    // A regra do grupo de três esquecida — o erro mais provável de uma edição
    // numa das cópias só.
    const copiaErrada: Leitor = (texto) => {
      const limpo = texto.trim().replace(/\s/g, '').replace(/^R\$/i, '');
      if (!/^[0-9.,]+$/.test(limpo)) return null;
      const valor = Number(limpo.replace(/\./g, '#').replace(',', '.').replace(/#/g, '.'));
      return Number.isFinite(valor) ? Math.round(valor * 100) : null;
    };
    // A varredura acha sozinha (o alfabeto dela só tem 1, 0 e os separadores)…
    const textos = todasAsSequencias(['1', '0', '.', ','], 5);
    expect(divergencias(daTela, copiaErrada, textos)).toContain('1.000');
    // …e a tabela também.
    expect(divergencias(daTela, copiaErrada, ['1.500', '12,50'])).toEqual(['1.500']);
  });
});
