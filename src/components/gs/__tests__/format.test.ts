/**
 * A conversão de dinheiro digitado em centavos.
 *
 * Esta função é pequena e está no caminho de três coisas caras: o valor
 * contado no fechamento do caixa, o frete que a loja declara e o preço de
 * promoção. Um erro aqui não aparece como erro — aparece como dinheiro certo
 * no lugar errado.
 *
 * A DISTINÇÃO QUE MAIS IMPORTA: vazio devolve `null`, não `0`.
 *
 * "Não configurado" e "zero" são decisões diferentes. Em "frete grátis acima
 * de R$ X", nulo é "não há frete grátis" e zero é "grátis sempre" — a segunda
 * dá a loja inteira de graça. As telas confiam nesta função para separar os
 * dois casos, em vez de cada uma inventar a própria checagem.
 */
import { describe, expect, it } from 'vitest';
import { formatCents, parseReaisToCents } from '../format';

describe('vazio não é zero', () => {
  it('texto vazio ou só espaços devolve null', () => {
    for (const entrada of ['', '   ', '\t']) {
      expect(parseReaisToCents(entrada)).toBeNull();
    }
  });

  it('zero digitado devolve zero — é uma decisão, não uma ausência', () => {
    expect(parseReaisToCents('0')).toBe(0);
    expect(parseReaisToCents('0,00')).toBe(0);
  });
});

describe('o que o brasileiro digita', () => {
  it('vírgula é decimal', () => {
    expect(parseReaisToCents('19,90')).toBe(1990);
    expect(parseReaisToCents('250,50')).toBe(25050);
  });

  it('ponto é separador de milhar', () => {
    // "1.500,00" é mil e quinhentos, não um e meio.
    expect(parseReaisToCents('1.500,00')).toBe(150000);
    expect(parseReaisToCents('12.345,67')).toBe(1234567);
  });

  /*
    SEPARADOR SOBRANDO NÃO É RECUSADO — e o caso está fixado AQUI, nesta cópia.

    `parseReaisToCents` existe duas vezes no projeto: aqui, para a tela, e em
    `server/src/services/core/Money.ts`, para a importação de planilha. São dois
    pacotes, e o tsconfig do servidor não alcança fora do próprio src.

    Em `1.2.3,4,5` a regra escolhe a ÚLTIMA vírgula como decimal, junta o que
    está à esquerda tirando os separadores e lê 1234,50. Não é o comportamento
    que se desenharia de propósito, mas as duas cópias precisam concordar — e
    mudá-lo de um lado só é o defeito de verdade.

    O comentário dentro de `format.ts` dava exatamente esta cadeia como exemplo
    de entrada RECUSADA. Não é: a guarda que ele descreve corta o que sobra
    DEPOIS do decimal, e o corte é sempre na última ocorrência dele.
  */
  it('separador sobrando lê 1234,50 — igual à gêmea do servidor', () => {
    expect(parseReaisToCents('1.2.3,4,5')).toBe(123450);
  });

  it('aceita o R$ e os espaços que vêm colados', () => {
    expect(parseReaisToCents('R$ 19,90')).toBe(1990);
    expect(parseReaisToCents(' r$99,00 ')).toBe(9900);
  });

  it('arredonda o centavo, não trunca', () => {
    // 0,005 truncado some; arredondado vira 1 centavo. Truncar sistematicamente
    // vira diferença de caixa no fim do mês.
    expect(parseReaisToCents('0,005')).toBe(1);
  });
});

/**
 * ============================================================================
 * O PONTO DECIMAL — os casos que faltavam, e que custaram cem vezes
 * ============================================================================
 *
 * Nenhum dos casos deste bloco existia. Por isso a função podia ler "12.50"
 * como R$ 1.250,00 com a suíte inteira verde: todos os casos escritos usavam
 * vírgula, e o defeito morava exatamente no caractere que ninguém testou.
 *
 * Os números abaixo são os MEDIDOS na função antiga, não hipóteses:
 *   "12.50"    -> 125000  (deveria ser 1250)
 *   "1234.56"  -> 12345600 (deveria ser 123456)
 *   "1,234.56" -> 123     (deveria ser 123456)
 *
 * Para provar que o guarda vale: trocando a regra do grupo de três por
 * "ponto é sempre milhar" (que era o comportamento antigo), os três primeiros
 * casos daqui ficam vermelhos; trocando por "ponto é sempre decimal", quebra
 * o bloco `ponto é separador de milhar` logo acima.
 */
describe('o ponto decimal, que é como o caixa e a planilha escrevem', () => {
  it('uma ou duas casas depois do ponto é DECIMAL', () => {
    // O caso do fechamento de caixa: doze e cinquenta, não mil duzentos e
    // cinquenta.
    expect(parseReaisToCents('12.50')).toBe(1250);
    expect(parseReaisToCents('12.5')).toBe(1250);
    expect(parseReaisToCents('0.99')).toBe(99);
    expect(parseReaisToCents('.50')).toBe(50);
  });

  it('o export de sistema estrangeiro, sem separador de milhar', () => {
    expect(parseReaisToCents('1234.56')).toBe(123456);
  });

  it('três dígitos depois do ponto continuam sendo MILHAR', () => {
    // É a única forma que o pt-BR produz, e é o que a tela relê.
    expect(parseReaisToCents('1.500')).toBe(150000);
    expect(parseReaisToCents('12')).toBe(1200);
    expect(parseReaisToCents('1.234.567')).toBe(123456700);
  });

  it('com ponto E vírgula, o último é o decimal — nos dois idiomas', () => {
    // pt-BR e en-US dizem o mesmo valor de formas espelhadas.
    expect(parseReaisToCents('1.234,56')).toBe(123456);
    expect(parseReaisToCents('1,234.56')).toBe(123456);
  });
});

/**
 * OS CHAMADORES QUE FAZEM `?? 0`.
 *
 * `PdvPage.tsx:632` e `AlteracaoRapidaPage.tsx:56` transformam `null` em zero.
 * É por isso que consertar o parser devolvendo `null` no caso ambíguo seria
 * PIOR que o defeito: uma leitura errada por cem viraria uma linha de venda a
 * R$ 0,00, e o zero é o valor que atravessa a tela sem parecer errado.
 *
 * Este bloco fixa o contrato do ponto de vista de quem chama: para todo texto
 * que uma pessoa realmente digitaria num campo de dinheiro, o resultado NÃO é
 * nulo — e portanto o `?? 0` nunca entra em ação por acidente.
 */
describe('quem faz `?? 0` continua certo', () => {
  const comoOChamadorLe = (texto: string): number => parseReaisToCents(texto) ?? 0;

  it('texto legível nunca cai no zero do `??`', () => {
    for (const [texto, esperado] of [
      ['12,50', 1250],
      ['12.50', 1250],
      ['1.500,00', 150000],
      ['1,234.56', 123456],
      ['58.00', 5800],
      ['0,01', 1],
    ] as const) {
      expect(comoOChamadorLe(texto), texto).toBe(esperado);
    }
  });

  it('só o campo vazio e o lixo caem no zero — e isso é o desenho', () => {
    // Apagar o preço da linha pinta a linha de amarelo; é o estado que a tela
    // quer mostrar, não um acidente do parser.
    expect(comoOChamadorLe('')).toBe(0);
    expect(comoOChamadorLe('abc')).toBe(0);
  });
});

describe('o que não é dinheiro', () => {
  it('texto inválido devolve null, não NaN nem zero', () => {
    for (const entrada of ['abc', '--', 'R$']) {
      expect(parseReaisToCents(entrada)).toBeNull();
    }
  });

  it('valor negativo é recusado', () => {
    // Frete negativo pagaria o cliente para comprar.
    expect(parseReaisToCents('-10,00')).toBeNull();
  });
});

describe('a volta', () => {
  // O `Intl` separa "R$" do número com espaço NÃO-QUEBRÁVEL (U+00A0), não com
  // espaço comum. Comparar com ' ' falha exibindo duas strings idênticas na
  // tela — e faz perder tempo procurando erro onde não tem.
  const ESPACO = ' ';

  it('centavos viram reais com dois dígitos', () => {
    expect(formatCents(1990)).toBe(`R$${ESPACO}19,90`);
    expect(formatCents(0)).toBe(`R$${ESPACO}0,00`);
    expect(formatCents(150000)).toBe(`R$${ESPACO}1.500,00`);
  });

  it('ida e volta preserva o valor', () => {
    for (const texto of ['19,90', '1.500,00', '0,01']) {
      expect(formatCents(parseReaisToCents(texto)!)).toBe(`R$${ESPACO}${texto}`);
    }
  });
});
