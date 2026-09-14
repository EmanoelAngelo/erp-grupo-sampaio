/**
 * Escritor de ZIP, à mão, sem dependência nova.
 *
 * ## Por que escrever o formato em vez de instalar uma biblioteca
 *
 * O pacote do contador precisa sair como UM arquivo, e o projeto não tem
 * nenhuma biblioteca de arquivamento (`server/package.json`: argon2, cors,
 * express, fast-xml-parser, imapflow, jsonwebtoken, mailparser, node-forge,
 * qrcode-generator, uuid, zod — nada que empacote). Acrescentar dependência é
 * decisão, não detalhe: entra na cadeia de suprimento de um sistema que emite
 * documento fiscal.
 *
 * E não é preciso. O Node traz tudo:
 *   - `zlib.deflateRawSync` produz exatamente o fluxo do método 8 (deflate),
 *     que é o que o ZIP guarda — "raw" porque o ZIP não quer o envelope zlib;
 *   - `zlib.crc32` é NATIVO nesta versão do Node, então nem a tabela de CRC
 *     precisa ser escrita à mão (era a parte mais fácil de errar em silêncio).
 *
 * Sobra o formato: cabeçalho local por arquivo, diretório central no fim, e o
 * registro de fim (EOCD) apontando para ele.
 *
 * ## O preço de errar aqui
 *
 * Um offset errado no diretório central produz um arquivo que o 7-Zip ABRE —
 * ele é tolerante e varre o arquivo procurando cabeçalhos — e que o Explorer
 * do Windows RECUSA, porque ele confia no diretório central. O contador
 * clicaria duas vezes e veria "pasta compactada inválida", sem nenhuma pista
 * do motivo. Por isso cada campo abaixo está nomeado e comentado, e por isso o
 * teste abre o resultado com o descompactador do próprio sistema operacional
 * em vez de conferir bytes contra bytes.
 */
import { crc32, deflateRawSync } from 'node:zlib';

export interface ArquivoDoZip {
  /** Caminho dentro do zip. Use barra normal, inclusive no Windows. */
  nome: string;
  conteudo: string | Buffer;
}

/** Assinaturas do formato. Números mágicos com nome, para ninguém digitá-los solto. */
const ASSINATURA_LOCAL = 0x04034b50;
const ASSINATURA_CENTRAL = 0x02014b50;
const ASSINATURA_FIM = 0x06054b50;

/**
 * Bit 11 do campo de flags: "o nome do arquivo está em UTF-8".
 *
 * Sem ele o ZIP declara o nome em CP437, e "inutilizações.csv" chega ao
 * contador como "inutilizaÃ§Ãµes.csv". O acento é a regra nos nomes deste
 * pacote, não a exceção.
 */
const FLAG_NOME_UTF8 = 0x0800;

/** Método 8 = deflate. XML comprime perto de 90%, então vale sempre. */
const METODO_DEFLATE = 8;

/**
 * Data e hora no formato do MS-DOS, que é o que o ZIP guarda.
 *
 * Dois inteiros de 16 bits, com o ano contado a partir de 1980 e o segundo
 * dividido por dois — o formato é de 1980 e não tem bit sobrando. Fora da
 * faixa (antes de 1980) o campo vira zero, que todo descompactador aceita.
 */
function dataDosDe(quando: Date): { hora: number; data: number } {
  const ano = quando.getFullYear();
  if (ano < 1980) return { hora: 0, data: 0 };
  return {
    hora: (quando.getHours() << 11) | (quando.getMinutes() << 5) | (quando.getSeconds() >> 1),
    data: ((ano - 1980) << 9) | ((quando.getMonth() + 1) << 5) | quando.getDate(),
  };
}

/**
 * Monta o zip inteiro em memória.
 *
 * EM MEMÓRIA é uma escolha com limite declarado: o pacote de um mês são
 * dezenas de MB no pior caso, e o chamador impõe o teto. Streaming exigiria
 * conhecer o tamanho comprimido antes de escrever o cabeçalho — o formato tem
 * um jeito de adiar isso (descritor de dados), e ele é justamente a parte que
 * descompactadores antigos leem errado. Para o tamanho deste pacote, memória é
 * mais simples e mais segura.
 *
 * `quando` entra por parâmetro para o teste poder fixar a data: um zip que
 * muda de bytes a cada execução não pode ser comparado consigo mesmo.
 */
export function montarZip(arquivos: ArquivoDoZip[], quando = new Date()): Buffer {
  const { hora, data } = dataDosDe(quando);
  const locais: Buffer[] = [];
  const centrais: Buffer[] = [];
  let deslocamento = 0;

  for (const arquivo of arquivos) {
    const nome = Buffer.from(arquivo.nome, 'utf8');
    const bruto = Buffer.isBuffer(arquivo.conteudo)
      ? arquivo.conteudo
      : Buffer.from(arquivo.conteudo, 'utf8');
    const comprimido = deflateRawSync(bruto);
    const verificacao = crc32(bruto);

    // ---------------------------------------------------- cabeçalho local
    const local = Buffer.alloc(30);
    local.writeUInt32LE(ASSINATURA_LOCAL, 0);
    local.writeUInt16LE(20, 4); // versão mínima para extrair: 2.0
    local.writeUInt16LE(FLAG_NOME_UTF8, 6);
    local.writeUInt16LE(METODO_DEFLATE, 8);
    local.writeUInt16LE(hora, 10);
    local.writeUInt16LE(data, 12);
    local.writeUInt32LE(verificacao, 14);
    local.writeUInt32LE(comprimido.length, 18);
    local.writeUInt32LE(bruto.length, 22);
    local.writeUInt16LE(nome.length, 26);
    local.writeUInt16LE(0, 28); // sem campo extra

    locais.push(local, nome, comprimido);

    // ------------------------------------------- entrada no diretório central
    const central = Buffer.alloc(46);
    central.writeUInt32LE(ASSINATURA_CENTRAL, 0);
    central.writeUInt16LE(20, 4); // versão de quem criou
    central.writeUInt16LE(20, 6); // versão mínima para extrair
    central.writeUInt16LE(FLAG_NOME_UTF8, 8);
    central.writeUInt16LE(METODO_DEFLATE, 10);
    central.writeUInt16LE(hora, 12);
    central.writeUInt16LE(data, 14);
    central.writeUInt32LE(verificacao, 16);
    central.writeUInt32LE(comprimido.length, 20);
    central.writeUInt32LE(bruto.length, 24);
    central.writeUInt16LE(nome.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comentário
    central.writeUInt16LE(0, 34); // disco onde começa
    central.writeUInt16LE(0, 36); // atributos internos
    central.writeUInt32LE(0, 38); // atributos externos
    /*
      O OFFSET DO CABEÇALHO LOCAL — o campo que decide se o arquivo abre.

      É a posição, em bytes desde o começo do zip, onde este arquivo começa. O
      Explorer do Windows lê o diretório central e SALTA para cá; errar este
      número por um byte faz ele encontrar lixo no lugar da assinatura e
      declarar o pacote inválido. O 7-Zip, que varre o arquivo em vez de
      confiar no índice, abriria assim mesmo — e é por isso que testar só com
      ele esconde exatamente este defeito.
    */
    central.writeUInt32LE(deslocamento, 42);

    centrais.push(central, nome);
    deslocamento += local.length + nome.length + comprimido.length;
  }

  const corpo = Buffer.concat(locais);
  const diretorio = Buffer.concat(centrais);

  // ------------------------------------------------- registro de fim (EOCD)
  const fim = Buffer.alloc(22);
  fim.writeUInt32LE(ASSINATURA_FIM, 0);
  fim.writeUInt16LE(0, 4); // número deste disco
  fim.writeUInt16LE(0, 6); // disco onde o diretório começa
  fim.writeUInt16LE(arquivos.length, 8); // entradas neste disco
  fim.writeUInt16LE(arquivos.length, 10); // entradas no total
  fim.writeUInt32LE(diretorio.length, 12);
  fim.writeUInt32LE(corpo.length, 16); // onde o diretório central começa
  fim.writeUInt16LE(0, 20); // sem comentário

  return Buffer.concat([corpo, diretorio, fim]);
}
