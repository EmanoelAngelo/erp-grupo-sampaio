/**
 * O ARQUIVO DE VERDADE — cada caso aqui é um jeito conhecido de a leitura
 * entrar torta sem dar erro nenhum.
 *
 * A importação de planilha é a única porta deste ERP em que um defeito de
 * leitura vira SALDO ERRADO em silêncio. Uma coluna deslocada põe o preço no
 * campo da unidade e a quantidade no campo do preço; o lote entra, a tela diz
 * "197 produtos importados", e a divergência só aparece quando alguém conta a
 * prateleira — semanas depois, sem ninguém ligar uma coisa à outra.
 *
 * Por isso cada teste abaixo é um arquivo que existe de verdade: o que o Excel
 * brasileiro salva, o que um sistema estrangeiro exporta, e o que sai de um
 * "copiar e colar" da planilha. Nenhum é hipótese.
 */
import { describe, expect, it } from 'vitest';
import {
  decodificar,
  detectarSeparador,
  lerCsv,
  separarRegistros,
} from '../src/services/core/CsvParse.js';
import { parseQuantidade, parseReaisToCents } from '../src/services/core/Money.js';

/** Bytes de um texto UTF-8, do jeito que chegariam do navegador. */
function utf8(texto: string): Uint8Array {
  return new TextEncoder().encode(texto);
}

describe('a máquina de estados lê o que o split quebraria', () => {
  it('vírgula DENTRO de aspas é texto, não separador de coluna', () => {
    const r = separarRegistros('nome,preco\n"Camisa, azul",30\n', ',');
    expect(r[1].celulas).toEqual(['Camisa, azul', '30']);
  });

  it('a contraprova: com split cru a linha teria uma coluna a mais', () => {
    // Sem isto o teste acima passaria mesmo se a máquina de estados sumisse e
    // alguém a trocasse por split — é o defeito, escrito, para comparação.
    expect('"Camisa, azul",30'.split(',')).toHaveLength(3);
  });

  it('aspa dupla dentro de campo citado é uma aspa literal', () => {
    const r = separarRegistros('nome\n"Tela 15"" Full HD"\n', ';');
    expect(r[1].celulas[0]).toBe('Tela 15" Full HD');
  });

  it('quebra de linha DENTRO de aspas não termina o registro', () => {
    const r = separarRegistros('nome;obs\nCabo;"veio\nsem embalagem"\n', ';');
    expect(r).toHaveLength(2);
    expect(r[1].celulas[1]).toBe('veio\nsem embalagem');
  });

  it('a última linha sobrevive quando o arquivo não termina em quebra', () => {
    const r = separarRegistros('nome;preco\nCabo;10', ';');
    expect(r).toHaveLength(2);
    expect(r[1].celulas).toEqual(['Cabo', '10']);
  });
});

describe('a aspa solta no meio do campo não engole o arquivo', () => {
  /*
    ESTE É O CASO QUE MATA UM PARSER INGÊNUO.

    Polegada se escreve com aspa: `Monitor 24" LED`. Se a aspa abrisse modo
    citado em qualquer posição, TODO o resto do arquivo — separadores, quebras
    de linha, as outras 199 linhas — viraria uma célula só. E o sintoma não é
    "erro na linha 3": é "o arquivo tem 1 linha", a milhares de caracteres de
    onde está a causa.

    A regra que impede: a aspa só abre quando é o PRIMEIRO caractere do campo.
    É o que o Excel faz ao ler.
  */
  it('polegada no meio do nome não vira abertura de aspas', () => {
    const r = separarRegistros('nome;preco\nMonitor 24" LED;899\nCabo HDMI;25\n', ';');
    expect(r).toHaveLength(3);
    expect(r[1].celulas).toEqual(['Monitor 24" LED', '899']);
    expect(r[2].celulas).toEqual(['Cabo HDMI', '25']);
  });

  it('aspas que nunca fecham são RECUSA, e não uma célula gigante', () => {
    expect(() => separarRegistros('nome;preco\n"Cabo;10\nOutro;20\n', ';')).toThrowError(
      /aspas que nunca fecham/i,
    );
  });
});

describe('o carriage return do Windows não gruda na última célula', () => {
  it('CRLF fora de aspas é fim de linha e some', () => {
    const r = separarRegistros('nome;preco\r\nCabo;10\r\n', ';');
    expect(r[1].celulas).toEqual(['Cabo', '10']);
    // O defeito que isto tranca: '10\r' comparado com '10' é diferente, e
    // parseQuantidade('10\r') dependeria do trim de quem chama.
    expect(r[1].celulas[1]).not.toContain('\r');
  });

  it('mas o carriage return DENTRO de aspas é preservado', () => {
    // Um replace global mataria este — e replace global é o atalho óbvio.
    const r = separarRegistros('nome;obs\nCabo;"linha1\r\nlinha2"\n', ';');
    expect(r[1].celulas[1]).toBe('linha1\r\nlinha2');
  });
});

describe('encoding: o acento do Excel brasileiro', () => {
  it('Windows-1252 com acento é detectado e lido certo', () => {
    // 'Válvula' em Windows-1252: o A com acento é o byte 0xE1 sozinho, que
    // NÃO é UTF-8 válido — e é isso que o modo estrito usa para decidir.
    const bytes = new Uint8Array([0x56, 0xe1, 0x6c, 0x76, 0x75, 0x6c, 0x61]);
    const { texto, encoding } = decodificar(bytes);
    expect(encoding).toBe('windows-1252');
    expect(texto).toBe('Válvula');
  });

  it('a contraprova: lido como UTF-8 o mesmo byte vira caractere de erro', () => {
    // É o que `file.text()` faria no navegador, e é irreversível.
    const bytes = new Uint8Array([0x56, 0xe1, 0x6c, 0x76, 0x75, 0x6c, 0x61]);
    expect(new TextDecoder('utf-8').decode(bytes)).toContain('�');
  });

  it('UTF-8 com acento continua UTF-8', () => {
    const { texto, encoding } = decodificar(utf8('Válvula'));
    expect(encoding).toBe('utf-8');
    expect(texto).toBe('Válvula');
  });

  it('o BOM sai da PRIMEIRA célula do cabeçalho', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8('codigo;nome\nA;B\n')]);
    const leitura = lerCsv(bytes);
    // Sem isto o cabeçalho seria '﻿codigo' e o mapa de colunas erraria
    // exatamente a primeira coluna — invisível na tela.
    expect(leitura.cabecalho.celulas[0]).toBe('codigo');
  });

  it('o encoding escolhido pela pessoa vence a detecção', () => {
    const { encoding } = decodificar(utf8('nome'), 'windows-1252');
    expect(encoding).toBe('windows-1252');
  });
});

describe('o separador é detectado, não adivinhado', () => {
  it('ponto e vírgula, que é o que o Excel em português salva', () => {
    expect(detectarSeparador('nome;preco;un\nCabo;10;UN\n')).toBe(';');
  });

  it('vírgula, do export estrangeiro', () => {
    expect(detectarSeparador('name,price,un\nCable,10,UN\n')).toBe(',');
  });

  it('TAB, de colar direto da planilha', () => {
    expect(detectarSeparador('nome\tpreco\tun\nCabo\t10\tUN\n')).toBe('\t');
  });

  /*
    A REGRA INGÊNUA ELEGE O SEPARADOR AUSENTE.

    Neste arquivo há 4 vírgulas e 2 ponto-e-vírgulas. "O que aparece mais"
    escolheria a vírgula — e a vírgula não é separador nenhum aqui: ela está
    dentro dos nomes. O arquivo inteiro entraria deslocado.

    O que decide é o RETÂNGULO: com ';' toda linha tem 2 colunas; com ',' a
    contagem varia conforme o nome tenha ou não vírgula.
  */
  it('a vírgula dentro dos nomes não ganha do separador de verdade', () => {
    const arquivo = 'nome;preco\n"Camisa, azul";30\n"Calça, preta";50\n';
    expect(detectarSeparador(arquivo)).toBe(';');
  });

  it('separador que não ocorre não entra na disputa nem por empate', () => {
    // Com TAB este arquivo tem uma coluna só — e uma coluna não é planilha.
    expect(detectarSeparador('nome,preco\nCabo,10\n')).toBe(',');
  });
});

describe('o número da linha é o da planilha, não o da lista', () => {
  it('linha em branco no meio não desloca a numeração de quem sobrou', () => {
    const leitura = lerCsv(utf8('nome;preco\nCabo;10\n\nFonte;80\n'));
    expect(leitura.registros.map((r) => r.linha)).toEqual([2, 4]);
    // 'Fonte' é a linha 4 do arquivo. Dizer "linha 3" mandaria a pessoa olhar
    // para uma linha vazia — a mensagem só serve se apontar a linha certa.
    expect(leitura.registros[1].celulas[0]).toBe('Fonte');
  });

  it('registro que ocupa duas linhas físicas não confunde a contagem', () => {
    const leitura = lerCsv(utf8('nome;obs\nCabo;"a\nb"\nFonte;ok\n'));
    expect(leitura.registros.map((r) => r.linha)).toEqual([2, 4]);
  });
});

describe('arquivos que não têm o que importar são recusados por nome', () => {
  it('arquivo vazio', () => {
    expect(() => lerCsv(utf8(''))).toThrowError(/nenhuma linha/i);
  });

  it('só quebras de linha', () => {
    expect(() => lerCsv(utf8('\n\n\n'))).toThrowError(/nenhuma linha/i);
  });

  it('só o cabeçalho — o caso de quem salvou a planilha errada', () => {
    expect(() => lerCsv(utf8('nome;preco\n'))).toThrowError(/só tem o cabeçalho/i);
  });
});

describe('linha curta e linha longa chegam como estão, para quem lê decidir', () => {
  it('a leitura não inventa nem descarta célula', () => {
    const leitura = lerCsv(utf8('nome;preco;un\nCabo;10\nFonte;80;UN;sobra\n'));
    expect(leitura.registros[0].celulas).toHaveLength(2);
    expect(leitura.registros[1].celulas).toHaveLength(4);
    // O parser não é o lugar de decidir isso: ele reporta a forma, e a
    // importação decide o que é falta de coluna e o que é separador errado.
    expect(leitura.cabecalho.celulas).toHaveLength(3);
  });
});

describe('dinheiro e quantidade leem o separador da MESMA forma', () => {
  it.each([
    ['12,50', 1250],
    ['12.50', 1250],
    ['1.500', 150000],
    ['1.234,56', 123456],
    ['1,234.56', 123456],
    ['R$ 89', 8900],
    ['89', 8900],
  ])('preço %s vira %i centavos', (texto, esperado) => {
    expect(parseReaisToCents(texto)).toBe(esperado);
  });

  it.each(['', ',', 'abc', '-5'])('preço %s é recusado', (texto) => {
    expect(parseReaisToCents(texto)).toBeNull();
  });

  /*
    TEXTO COM SEPARADOR SOBRANDO NÃO É RECUSADO — e isto está escrito aqui
    porque eu esperava o contrário e o código me corrigiu.

    Em `1.2.3,4,5` a regra escolhe a ÚLTIMA vírgula como decimal, junta o que
    está à esquerda tirando os separadores e lê 1234,50. As duas cópias fazem
    isso, e é por isso que o caso está fixado num teste: não é o comportamento
    que eu teria desenhado, mas mudá-lo de um lado só é o defeito de verdade.

    (O comentário da cópia da tela dava exatamente esta cadeia como exemplo de
    entrada RECUSADA. Não é — a guarda que ele descreve não alcança este texto.
    Corrigido lá também, para o comentário não descrever o que o código não faz.)
  */
  it('separador sobrando não é recusado: as duas cópias leem 1234,50', () => {
    expect(parseReaisToCents('1.2.3,4,5')).toBe(123450);
  });

  it.each([
    ['2,5', 2.5],
    ['2.5', 2.5],
    ['1.500', 1500],
    ['10', 10],
    ['0', 0],
  ])('quantidade %s vira %s', (texto, esperado) => {
    expect(parseQuantidade(texto)).toBe(esperado);
  });

  it('a vírgula da quantidade seria NaN sem esta regra', () => {
    // O defeito que isto tranca: NaN chega em applyMovement, que recusa com
    // quantidade inválida — e derruba o lote inteiro por causa de uma célula.
    expect(Number('2,5')).toBeNaN();
    expect(parseQuantidade('2,5')).toBe(2.5);
  });

  /*
    O NEGATIVO PASSA NA QUANTIDADE E NÃO PASSA NO PREÇO — de propósito.

    `signedDelta` faz `Math.abs` da quantidade, então -5 chegando lá vira
    entrada de CINCO. A planilha que escreveu "-3" para dizer "faltam 3"
    criaria três unidades em silêncio. Reportar o sinal é o que permite à
    importação recusar com a mensagem certa; devolver null misturaria "-3"
    com "abc", que pedem mensagens diferentes.
  */
  it('quantidade negativa é reportada COM sinal, para poder ser recusada', () => {
    expect(parseQuantidade('-3')).toBe(-3);
    expect(parseQuantidade('-2,5')).toBe(-2.5);
  });

  it('quantidade ilegível continua sendo null, que é outra mensagem', () => {
    expect(parseQuantidade('abc')).toBeNull();
    expect(parseQuantidade('')).toBeNull();
  });
});
