/**
 * Leitura de planilha em texto separado — o arquivo que a loja nova traz.
 *
 * Este módulo é PURO: não abre banco, não conhece HTTP, não sabe o que é um
 * produto. Recebe bytes, devolve uma matriz de células e o número da linha de
 * onde cada uma saiu. É o mesmo desenho que permitiu ao `Ean13.ts` ser testado
 * de fora — e aqui vale mais ainda, porque o que este arquivo erra não aparece
 * na tela: aparece no estoque, semanas depois.
 *
 * ## Por que a leitura acontece AQUI, e não no navegador
 *
 * O navegador manda BYTES. Se mandasse a matriz já separada, o servidor não
 * teria como re-derivar coluna nenhuma — gravaria o que recebeu, e catálogo e
 * saldo passariam a ser o resultado de uma conta feita do lado de fora. É a
 * mesma decisão da alçada: quem decide COMO ler é a pessoa; quem LÊ é o
 * servidor.
 *
 * E há um motivo que sozinho já fecharia a questão: `file.text()` decodifica
 * SEMPRE como UTF-8. Um CSV salvo pelo Excel em português é Windows-1252, e
 * passar por `file.text()` transforma "Válvula" em texto podre ANTES de sair
 * do navegador. Byte perdido ali não volta.
 */
import { ApiError } from '../../utils/errors.js';

/** Os dois encodings que aparecem de verdade num CSV que veio de planilha. */
export type EncodingCsv = 'utf-8' | 'windows-1252';

/** Ponto e vírgula é o do Excel brasileiro; vírgula, o do export estrangeiro; TAB, o de colar da planilha. */
export type SeparadorCsv = ';' | ',' | '\t';

export const SEPARADORES: readonly SeparadorCsv[] = [';', ',', '\t'];

export interface RegistroCsv {
  /**
   * Linha física onde o registro COMEÇA, contando a partir de 1 e contando as
   * vazias. É o número que a pessoa vê na barra lateral do Excel, e é a única
   * coisa que torna uma mensagem de erro acionável: "linha 43" só ajuda se for
   * a linha 43 do arquivo dela, não a 43ª linha que sobrou depois de eu
   * descartar as brancas.
   */
  linha: number;
  celulas: string[];
}

export interface LeituraCsv {
  encoding: EncodingCsv;
  separador: SeparadorCsv;
  /** Primeiro registro não vazio. */
  cabecalho: RegistroCsv;
  /** Todo o resto, sem os registros vazios. */
  registros: RegistroCsv[];
}

const BOM = [0xef, 0xbb, 0xbf];

/**
 * Bytes para texto, com o encoding decidido ou detectado.
 *
 * O BOM sai SEMPRE, antes de qualquer coisa. Se ficasse, ele entraria na
 * primeira célula do cabeçalho e o mapa de colunas erraria exatamente a
 * primeira coluna — o tipo de defeito que se olha por horas porque a tela
 * mostra "codigo_barras" igualzinho ao esperado, com um caractere invisível
 * na frente.
 *
 * A detecção usa o modo estrito do decodificador: UTF-8 tem forma, e texto
 * Windows-1252 com acento NÃO é UTF-8 válido — o decodificador estoura, e o
 * estouro é a resposta. É heurística boa, mas continua sendo heurística: um
 * arquivo 1252 que só tem ASCII passa como UTF-8, e não faz diferença nenhuma
 * porque nesse caso os dois produzem o mesmo texto. Por isso o encoding
 * detectado vai para a tela e pode ser trocado.
 */
export function decodificar(
  bytes: Uint8Array,
  forcado?: EncodingCsv,
): { texto: string; encoding: EncodingCsv } {
  const temBom = bytes.length >= 3 && BOM.every((b, i) => bytes[i] === b);
  const corpo = temBom ? bytes.subarray(3) : bytes;

  if (forcado) {
    return { texto: new TextDecoder(forcado).decode(corpo), encoding: forcado };
  }
  // BOM de UTF-8 é declaração, não pista: quem o escreveu disse o encoding.
  if (temBom) {
    return { texto: new TextDecoder('utf-8').decode(corpo), encoding: 'utf-8' };
  }
  try {
    const texto = new TextDecoder('utf-8', { fatal: true }).decode(corpo);
    return { texto, encoding: 'utf-8' };
  } catch {
    return { texto: new TextDecoder('windows-1252').decode(corpo), encoding: 'windows-1252' };
  }
}

/**
 * A máquina de estados. Caractere a caractere, nunca `split`.
 *
 * `split(';')` é o jeito óbvio e está errado no primeiro arquivo de verdade:
 * "Camisa; azul" entre aspas é UMA célula, e o split a parte em duas,
 * deslocando todas as colunas seguintes da linha. O preço vai para a coluna da
 * unidade, a quantidade para a do preço, e o lote inteiro entra torto sem uma
 * única mensagem de erro.
 *
 * ## A aspa só ABRE no começo do campo
 *
 * Esta é a regra que separa um parser que funciona de um que engole o arquivo.
 * Uma aspa solta no meio de um campo não citado — 12" de polegada, que é como
 * se escreve polegada — não pode abrir modo citado: se abrisse, todo o resto
 * do arquivo viraria uma célula só, e o erro apareceria como "o arquivo tem 1
 * linha", a milhares de caracteres de onde está a causa.
 *
 * Fora do começo do campo, a aspa é caractere comum. É exatamente o que o
 * Excel faz ao LER, e o objetivo aqui é ler o que o Excel escreveria.
 *
 * ## O carriage return sai aqui dentro, não com um replace global
 *
 * Um replace global destruiria um carriage return legítimo dentro de um campo
 * entre aspas. Aqui ele só é descartado quando vem colado numa quebra de linha
 * E estamos fora de aspas — que é a única situação em que ele é fim de linha.
 */
export function separarRegistros(texto: string, separador: string): RegistroCsv[] {
  const registros: RegistroCsv[] = [];
  let celulas: string[] = [];
  let campo = '';
  /** Este campo foi aberto com aspas — impede que uma segunda aspa reabra. */
  let citado = false;
  let dentro = false;
  let linhaFisica = 1;
  let linhaDoRegistro = 1;

  const fecharCampo = () => {
    celulas.push(campo);
    campo = '';
    citado = false;
  };
  const fecharRegistro = () => {
    fecharCampo();
    registros.push({ linha: linhaDoRegistro, celulas });
    celulas = [];
  };

  for (let i = 0; i < texto.length; i += 1) {
    const c = texto[i];

    if (dentro) {
      if (c === '"') {
        // Aspa dupla dentro de campo citado é uma aspa literal (RFC 4180, que
        // é o que o Excel escreve). Uma só fecha o modo citado.
        if (texto[i + 1] === '"') {
          campo += '"';
          i += 1;
        } else {
          dentro = false;
        }
      } else {
        if (c === '\n') linhaFisica += 1;
        campo += c;
      }
      continue;
    }

    if (c === '"' && campo === '' && !citado) {
      dentro = true;
      citado = true;
    } else if (c === separador) {
      fecharCampo();
    } else if (c === '\r' && texto[i + 1] === '\n') {
      // CRLF: o carriage return é descartado e a quebra do próximo passo fecha
      // o registro.
    } else if (c === '\n') {
      linhaFisica += 1;
      fecharRegistro();
      linhaDoRegistro = linhaFisica;
    } else {
      campo += c;
    }
  }

  /*
    ASPAS QUE NUNCA FECHARAM SÃO RECUSA, NÃO CONSERTO SILENCIOSO.

    Chegar ao fim do arquivo dentro de aspas significa que o arquivo está
    malformado ou que o separador detectado está errado. Aceitar e devolver o
    resto como uma célula gigante daria um lote com uma linha e nenhuma pista
    do motivo. É melhor a pessoa saber que o arquivo tem aspa sobrando.
  */
  if (dentro) {
    throw new ApiError(
      'CORE_IMPORT_ASPAS_ABERTA',
      'O arquivo tem aspas que nunca fecham. Confira se alguma célula tem aspa sobrando.',
      400,
    );
  }

  // O último registro não termina em quebra de linha quando o arquivo não
  // termina em quebra de linha. Sem isto a última linha da planilha some.
  if (campo !== '' || celulas.length > 0) fecharRegistro();

  return registros;
}

/** Registro que é uma célula vazia só — a linha em branco da planilha. */
function vazio(r: RegistroCsv): boolean {
  return r.celulas.length <= 1 && (r.celulas[0] ?? '').trim() === '';
}

/**
 * Qual dos três separadores este arquivo usa.
 *
 * A regra ingênua — "o que aparece mais vezes" — elege o separador AUSENTE com
 * facilidade: num arquivo separado por ponto e vírgula onde os nomes têm
 * vírgula, a vírgula ganha na contagem bruta e o arquivo inteiro entra torto.
 *
 * Então há duas guardas antes de qualquer pontuação:
 *   1. o candidato precisa produzir pelo menos DUAS colunas no cabeçalho — um
 *      separador que não ocorre produz uma coluna só;
 *   2. a pontuação é quantos registros têm o MESMO número de colunas do
 *      cabeçalho, e não quantas ocorrências existem. Planilha é retangular; o
 *      separador certo é o que revela o retângulo.
 *
 * Empate vai para o ponto e vírgula, que é o que o Excel em português salva —
 * e é por isso que ele é o primeiro da lista, já que a comparação só troca o
 * campeão quando a pontuação é ESTRITAMENTE maior.
 */
export function detectarSeparador(texto: string): SeparadorCsv {
  let melhor: { sep: SeparadorCsv; pontos: number } | null = null;

  for (const sep of SEPARADORES) {
    let registros: RegistroCsv[];
    try {
      registros = separarRegistros(texto, sep).filter((r) => !vazio(r));
    } catch {
      // Separador que faz o arquivo terminar com aspa aberta é o separador
      // errado, não um arquivo inválido. Fica fora da disputa e ela continua.
      continue;
    }
    if (registros.length === 0) continue;

    const colunas = registros[0].celulas.length;
    if (colunas < 2) continue;

    const pontos = registros.filter((r) => r.celulas.length === colunas).length;
    if (!melhor || pontos > melhor.pontos) melhor = { sep, pontos };
  }

  if (!melhor) {
    throw new ApiError(
      'CORE_IMPORT_SEPARADOR_INDEFINIDO',
      'Não consegui descobrir o separador do arquivo. Salve a planilha como CSV e tente de novo.',
      400,
    );
  }
  return melhor.sep;
}

export interface OpcoesLeitura {
  encoding?: EncodingCsv;
  separador?: SeparadorCsv;
}

/**
 * Bytes para cabeçalho e registros, com tudo o que foi decidido à vista.
 *
 * `opcoes` é o que a pessoa corrigiu na tela. Quando vem vazio, tudo é
 * detectado — e o que foi detectado volta no resultado justamente para poder
 * ser mostrado e contestado.
 */
export function lerCsv(bytes: Uint8Array, opcoes: OpcoesLeitura = {}): LeituraCsv {
  const { texto, encoding } = decodificar(bytes, opcoes.encoding);

  /*
    O ARQUIVO VAZIO É PERGUNTADO ANTES DO SEPARADOR, e a ordem é o conserto.

    Ao contrário: um arquivo sem nada dentro não tem candidato a separador
    nenhum, e a detecção falhava primeiro, com "não consegui descobrir o
    separador". A pessoa salvava de novo, trocava o formato, tentava com
    ponto e vírgula — procurando um problema de separador que não existe,
    quando o que houve foi exportar a planilha errada.

    A pergunta mais simples vem primeiro porque a resposta dela é a que manda
    a pessoa para o lugar certo.
  */
  if (texto.trim() === '') {
    throw new ApiError('CORE_IMPORT_ARQUIVO_VAZIO', 'O arquivo não tem nenhuma linha.', 400);
  }

  const separador = opcoes.separador ?? detectarSeparador(texto);

  const todos = separarRegistros(texto, separador).filter((r) => !vazio(r));

  if (todos.length === 0) {
    throw new ApiError('CORE_IMPORT_ARQUIVO_VAZIO', 'O arquivo não tem nenhuma linha.', 400);
  }
  if (todos.length === 1) {
    throw new ApiError(
      'CORE_IMPORT_SEM_LINHAS',
      'O arquivo só tem o cabeçalho — nenhum produto para importar.',
      400,
    );
  }

  return { encoding, separador, cabecalho: todos[0], registros: todos.slice(1) };
}
