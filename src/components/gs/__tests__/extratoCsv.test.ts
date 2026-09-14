/**
 * O EXTRATO IMPORTADO É O EXTRATO — não ele multiplicado por cem.
 *
 * ============================================================================
 * O DEFEITO
 * ============================================================================
 *
 * A tela de conciliação lia o valor assim:
 *
 *     valorTexto.replace(/\./g, '').replace(',', '.')
 *
 * com um comentário logo acima prometendo aceitar `1.234,56` **e** `1234.56`.
 * A segunda metade da promessa era falsa: apagar todo ponto transforma
 * `1234.56` em `123456`, e a vírgula que viria depois não existe. A linha
 * entrava como **R$ 123.456,00**.
 *
 * Extrato exportado em formato americano — o que sai de internet banking em
 * inglês e de planilha configurada em `en-US` — importava a conta inteira
 * multiplicada por cem, sem uma única mensagem de erro. E a conciliação existe
 * justamente para comparar o extrato com o financeiro: o relatório passaria a
 * acusar divergência em cem por cento das linhas, e quem conferisse concluiria
 * que o financeiro está errado.
 *
 * O leitor certo já existia em `format.ts`, com teste próprio. O que faltava
 * era a tela usá-lo.
 */
import { describe, expect, it } from 'vitest';

import { parseExtratoCsv } from '../extratoCsv';

// ============================================================================

describe('os dois formatos que o comentário sempre prometeu', () => {
  it('à moda daqui: 1.234,56 é mil duzentos e trinta e quatro e cinquenta e seis', () => {
    const { linhas, erros } = parseExtratoCsv('31/08/2026;Recebimento;1.234,56');
    expect(erros).toBe(0);
    expect(linhas[0].amountCents).toBe(123_456);
  });

  it('à moda de lá: 1234.56 é o MESMO valor, e não cem vezes ele', () => {
    const { linhas, erros } = parseExtratoCsv('2026-08-31,Payment,1234.56');
    expect(erros).toBe(0);
    expect(linhas[0].amountCents).toBe(123_456);
  });

  it('e o jeito antigo devolvia cem vezes o valor — o defeito, por escrito', () => {
    /*
      A expressão que estava na tela, reproduzida aqui em vez de descrita.
      Enquanto esta linha valer 12.345.600, o teste acima é o que separa o
      extrato certo do extrato multiplicado por cem.
    */
    const comoEra = Math.round(Number('1234.56'.replace(/\./g, '').replace(',', '.')) * 100);
    expect(comoEra).toBe(12_345_600);
    expect(parseExtratoCsv('2026-08-31,Payment,1234.56').linhas[0].amountCents).not.toBe(comoEra);
  });

  it('o valor sem centavos não muda de tamanho', () => {
    expect(parseExtratoCsv('31/08/2026;Aluguel;1.500').linhas[0].amountCents).toBe(150_000);
    expect(parseExtratoCsv('31/08/2026;Aluguel;1500').linhas[0].amountCents).toBe(150_000);
  });

  it('um centavo é um centavo', () => {
    expect(parseExtratoCsv('31/08/2026;Ajuste;0,01').linhas[0].amountCents).toBe(1);
    expect(parseExtratoCsv('31/08/2026;Ajuste;0.01').linhas[0].amountCents).toBe(1);
  });
});

// ============================================================================

describe('débito é negativo, e o extrato é metade débito', () => {
  it('o sinal de menos atravessa o leitor', () => {
    expect(parseExtratoCsv('31/08/2026;Tarifa;-45,90').linhas[0].amountCents).toBe(-4_590);
  });

  it('e a notação contábil entre parênteses também', () => {
    expect(parseExtratoCsv('31/08/2026;Tarifa;(45,90)').linhas[0].amountCents).toBe(-4_590);
  });

  it('crédito com sinal explícito continua positivo', () => {
    expect(parseExtratoCsv('31/08/2026;Depósito;+1.000,00').linhas[0].amountCents).toBe(100_000);
  });
});

// ============================================================================

describe('a data do extrato é um dia, não um instante', () => {
  it('DD/MM/AAAA vira AAAA-MM-DD', () => {
    expect(parseExtratoCsv('31/08/2026;Recebimento;10,00').linhas[0].occurredAt).toBe('2026-08-31');
  });

  it('AAAA-MM-DD passa direto', () => {
    expect(parseExtratoCsv('2026-08-31,Payment,10.00').linhas[0].occurredAt).toBe('2026-08-31');
  });

  it('a linha do dia 31 não vira dia 30 — o extrato não tem hora para converter', () => {
    /*
      A versão anterior fazia `new Date(...).toISOString()`. O dia virava
      instante de meia-noite UTC, e o recorte "até 31/08" da conciliação
      passava a comparar carimbo com data. O extrato não tem hora: inventar uma
      é o que produz o dia errado.
    */
    const { linhas } = parseExtratoCsv('31/08/2026;Recebimento;10,00');
    expect(linhas[0].occurredAt).not.toContain('T');
  });
});

// ============================================================================

describe('o que o arquivo tem de errado é CONTADO, não engolido', () => {
  it('linha com campos de menos conta como erro', () => {
    const { linhas, erros } = parseExtratoCsv('31/08/2026;só isso');
    expect([linhas.length, erros]).toEqual([0, 1]);
  });

  it('valor ilegível conta como erro, e não como zero', () => {
    const { linhas, erros } = parseExtratoCsv('31/08/2026;Recebimento;abc');
    expect([linhas.length, erros]).toEqual([0, 1]);
  });

  it('data ilegível conta como erro, e não como hoje', () => {
    const { linhas, erros } = parseExtratoCsv('ontem;Recebimento;10,00');
    expect([linhas.length, erros]).toEqual([0, 1]);
  });

  it('linha em branco não é erro — arquivo tem linha em branco', () => {
    const { linhas, erros } = parseExtratoCsv('\n31/08/2026;Recebimento;10,00\n\n');
    expect([linhas.length, erros]).toEqual([1, 0]);
  });

  it('descrição vazia ganha um rótulo, e a linha sobrevive', () => {
    expect(parseExtratoCsv('31/08/2026;;10,00').linhas[0].description).toBe('Sem descrição');
  });
});

// ============================================================================

describe('o arquivo inteiro', () => {
  it('lê as boas, conta as ruins, e não para na primeira', () => {
    const arquivo = [
      '31/08/2026;Venda cartão;1.234,56',
      'linha torta',
      '01/09/2026;Tarifa;-45,90',
      '2026-09-02,Wire transfer,2500.00',
    ].join('\n');

    const { linhas, erros } = parseExtratoCsv(arquivo);

    expect(erros).toBe(1);
    expect(linhas.map((l) => l.amountCents)).toEqual([123_456, -4_590, 250_000]);
    expect(linhas.map((l) => l.occurredAt)).toEqual(['2026-08-31', '2026-09-01', '2026-09-02']);
  });
});
