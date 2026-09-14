/**
 * O ZIP PRECISA ABRIR NO EXPLORER DO WINDOWS — não no leitor mais tolerante.
 *
 * O pacote do contador é um arquivo que alguém vai clicar duas vezes numa
 * máquina com Windows. E é aí que mora a armadilha deste formato: o 7-Zip
 * VARRE o arquivo procurando assinaturas, então ele abre um zip cujo diretório
 * central aponta para o lugar errado. O Explorer confia no diretório central e
 * recusa — "pasta compactada inválida", sem nenhuma pista do motivo.
 *
 * Um teste que só conferisse bytes contra bytes, ou que descompactasse com a
 * mesma biblioteca que compactou, passaria com o offset errado. Por isso o
 * caso central deste arquivo entrega o zip ao DESCOMPACTADOR DO SISTEMA
 * OPERACIONAL e confere o que saiu do outro lado.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { inflateRawSync } from 'node:zlib';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { montarZip } from '../src/services/core/ZipWriter.js';

/** Data fixa: um zip que muda de bytes a cada execução não pode ser comparado. */
const QUANDO = new Date(2026, 6, 31, 23, 59, 58);

const pasta = mkdtempSync(join(tmpdir(), 'zip-contador-'));
afterAll(() => {
  rmSync(pasta, { recursive: true, force: true });
});

/** Lê os campos do registro de fim, que é o índice de tudo. */
function lerFim(zip: Buffer) {
  const inicio = zip.length - 22;
  expect(zip.readUInt32LE(inicio)).toBe(0x06054b50);
  return {
    entradas: zip.readUInt16LE(inicio + 10),
    tamanhoDoDiretorio: zip.readUInt32LE(inicio + 12),
    inicioDoDiretorio: zip.readUInt32LE(inicio + 16),
  };
}

describe('a estrutura do arquivo', () => {
  it('o diretório central aponta para o começo de cada arquivo', () => {
    const zip = montarZip(
      [
        { nome: 'LEIA-ME.txt', conteudo: 'primeiro' },
        { nome: 'recebidas/nota.xml', conteudo: '<nfe>segundo</nfe>' },
      ],
      QUANDO,
    );

    const fim = lerFim(zip);
    expect(fim.entradas).toBe(2);

    /*
      Percorre o diretório central e, para CADA entrada, salta para o offset
      declarado e exige achar a assinatura de cabeçalho local. É exatamente o
      que o Explorer faz — e o único jeito de este teste falhar quando o
      offset estiver errado por um byte.
    */
    let cursor = fim.inicioDoDiretorio;
    for (let i = 0; i < fim.entradas; i += 1) {
      expect(zip.readUInt32LE(cursor)).toBe(0x02014b50);
      const tamanhoDoNome = zip.readUInt16LE(cursor + 28);
      const offsetLocal = zip.readUInt32LE(cursor + 42);

      expect(zip.readUInt32LE(offsetLocal)).toBe(0x04034b50);

      cursor += 46 + tamanhoDoNome;
    }
    expect(cursor).toBe(fim.inicioDoDiretorio + fim.tamanhoDoDiretorio);
  });

  it('o nome é declarado em UTF-8, senão o acento chega quebrado', () => {
    const zip = montarZip([{ nome: 'numeracao/inutilizações.csv', conteudo: 'a;b' }], QUANDO);
    // Bit 11 do campo de flags, no cabeçalho local (posição 6).
    expect(zip.readUInt16LE(6) & 0x0800).toBe(0x0800);
  });

  it('o conteúdo comprimido volta idêntico ao original', () => {
    const original = '<nfeProc>' + 'x'.repeat(5000) + '</nfeProc>';
    const zip = montarZip([{ nome: 'a.xml', conteudo: original }], QUANDO);

    const tamanhoDoNome = zip.readUInt16LE(26);
    const comprimido = zip.readUInt32LE(18);
    const dados = zip.subarray(30 + tamanhoDoNome, 30 + tamanhoDoNome + comprimido);

    expect(inflateRawSync(dados).toString('utf8')).toBe(original);
    // E comprimiu de verdade: XML repetitivo não pode sair do mesmo tamanho.
    expect(comprimido).toBeLessThan(Buffer.byteLength(original) / 2);
  });

  it('zip sem nenhum arquivo continua sendo um zip válido', () => {
    const zip = montarZip([], QUANDO);
    expect(zip).toHaveLength(22);
    expect(lerFim(zip).entradas).toBe(0);
  });

  it('a mesma entrada com a mesma data produz os mesmos bytes', () => {
    // Determinismo é o que permitiria comparar dois pacotes do mesmo mês.
    const a = montarZip([{ nome: 'a.txt', conteudo: 'igual' }], QUANDO);
    const b = montarZip([{ nome: 'a.txt', conteudo: 'igual' }], QUANDO);
    expect(a.equals(b)).toBe(true);
  });
});

/*
  O TESTE QUE VALE MAIS QUE TODOS OS DE CIMA.

  Grava o zip em disco e manda o WINDOWS abri-lo, com `Expand-Archive`, que usa
  a mesma implementação do Explorer. Se o diretório central estiver errado, é
  aqui que aparece — e aparece do jeito que o contador veria.
*/
// Prazo de PROCESSO EXTERNO: estes casos abrem outro programa (eslint, PowerShell) e,
// com a suíte inteira dividindo a máquina, passam dos 30 s padrão sem estar errados.
describe('o Windows abre o arquivo', { timeout: 120_000 }, () => {
  it('Expand-Archive extrai as pastas, os nomes com acento e o conteúdo', () => {
    const zip = montarZip(
      [
        { nome: 'LEIA-ME.txt', conteudo: 'Este pacote é do mês 07/2026.' },
        { nome: 'recebidas/nota-fiscal.xml', conteudo: '<nfe><emit>Fornecedor</emit></nfe>' },
        { nome: 'numeracao/inutilizações.csv', conteudo: 'modelo;serie;de;ate\n55;1;10;12\n' },
        { nome: 'resultado/dre.csv', conteudo: 'linha;valor\nReceita;1234\n' },
      ],
      QUANDO,
    );

    const arquivo = join(pasta, 'pacote.zip');
    const destino = join(pasta, 'aberto');
    writeFileSync(arquivo, zip);

    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Expand-Archive -LiteralPath '${arquivo}' -DestinationPath '${destino}' -Force`,
      ],
      { stdio: 'pipe' },
    );

    // As quatro entradas chegaram, com as pastas montadas.
    expect(readdirSync(destino).sort()).toEqual([
      'LEIA-ME.txt',
      'numeracao',
      'recebidas',
      'resultado',
    ]);

    expect(readFileSync(join(destino, 'LEIA-ME.txt'), 'utf8')).toBe(
      'Este pacote é do mês 07/2026.',
    );
    expect(readFileSync(join(destino, 'recebidas', 'nota-fiscal.xml'), 'utf8')).toContain(
      '<emit>Fornecedor</emit>',
    );

    /*
      O NOME COM ACENTO — o motivo do bit de UTF-8.

      Sem ele o Windows lê o nome como CP437 e o arquivo chega como
      "inutilizaÃ§Ãµes.csv". Conferir pelo nome exato é o que prova a flag.
    */
    expect(readdirSync(join(destino, 'numeracao'))).toEqual(['inutilizações.csv']);
    expect(readFileSync(join(destino, 'numeracao', 'inutilizações.csv'), 'utf8')).toContain(
      '55;1;10;12',
    );
  });
});
