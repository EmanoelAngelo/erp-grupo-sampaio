/**
 * As duas cópias do EAN-13 não podem divergir.
 *
 * O desenho do código de barras existe duas vezes: aqui, para a tela
 * (`Barcode.tsx`), e no servidor, para a etiqueta impressa
 * (`server/src/services/core/Ean13.ts`). Não é escolha — são dois pacotes, e o
 * `server/tsconfig.json` não tem caminho para fora do próprio `src`.
 *
 * O perigo de duplicar tabela de codificação é ela divergir em silêncio: um
 * dígito trocado numa das cópias produz um código que IMPRIME BONITO e o
 * leitor recusa — ou, pior, lê como outro produto. Nada na tela denuncia.
 *
 * Este teste compara as quatro tabelas caractere a caractere. Se alguém mexer
 * numa cópia, a suíte para até a outra acompanhar.
 */
import { describe, expect, it } from 'vitest';
import FONTE_TELA from '../Barcode.tsx?raw';
import FONTE_SERVIDOR from '../../../../server/src/services/core/Ean13.ts?raw';

/** Conteúdo do array de uma constante, sem espaços — a comparação é do dado. */
function tabela(fonte: string, nome: string): string {
  const m = fonte.match(new RegExp(`const ${nome} = \\[([\\s\\S]*?)\\];`));
  if (!m) throw new Error(`não achei a tabela ${nome}`);
  return m[1].replace(/\s/g, '');
}

describe('tabelas de codificação', () => {
  it.each(['L', 'G', 'R', 'PARITY'])('%s é idêntica nas duas cópias', (nome) => {
    expect(tabela(FONTE_SERVIDOR, nome)).toBe(tabela(FONTE_TELA, nome));
  });

  it('as tabelas não estão vazias — regex que não casa nada passaria calada', () => {
    for (const nome of ['L', 'G', 'R', 'PARITY']) {
      expect(tabela(FONTE_TELA, nome).length).toBeGreaterThan(50);
    }
  });

  it('L, G e R têm dez padrões cada — um por dígito', () => {
    for (const nome of ['L', 'G', 'R']) {
      expect(tabela(FONTE_TELA, nome).split(',')).toHaveLength(10);
    }
  });
});

describe('a duplicação está declarada', () => {
  it('cada cópia aponta para a outra, para quem mexer saber', () => {
    expect(FONTE_SERVIDOR).toContain('Barcode.tsx');
    expect(FONTE_TELA).toContain('EAN-13');
  });
});
